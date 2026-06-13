import os
import csv
import json
import sys
import logging
import pip_system_certs.wrapt_requests
from uuid import uuid4
from datetime import datetime, timedelta, timezone
from enablebanking_sdk.service import EnableBankingService, EnableBankingIntegration
from enablebanking_sdk.constants import PSUType

# === CONFIGURATION ===
EB_BASE_URL = os.getenv("ENABLEBANKING_BASE_URL", "https://api.enablebanking.com")
EB_APP_ID = os.getenv("ENABLEBANKING_APP_ID", "5d858d0d-9348-4305-8f9f-0a588f81ead1")
EB_REDIRECT_URL = os.getenv("ENABLEBANKING_REDIRECT_URL", "https://google.com/")
# Read private key contents from .pem file
EB_CERTIFICATE_PATH = os.getenv("ENABLEBANKING_CERTIFICATE", "C:\\Users\\CMIQ\\repositories\\home_fin\\api\\5d858d0d-9348-4305-8f9f-0a588f81ead1.pem")

# === TRANSACTION DATE RANGE ===
DATE_FROM = datetime(2024, 1, 1, tzinfo=timezone.utc)
DATE_TO = datetime.now(tz=timezone.utc)

# === FILES ===
_TODAY = datetime.now()
_EXECUTION_DATE = _TODAY.strftime('%Y%m%d')

DATA_DIR        = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
RAW_DIR         = os.path.join(DATA_DIR, 'raw')
CATEGORIZED_DIR = os.path.join(DATA_DIR, 'categorized')
SESSION_FILE    = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'session.json')

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# === READ CERTIFICATE ===
try:
    with open(EB_CERTIFICATE_PATH, "r") as f:
        EB_CERTIFICATE = f.read().strip()
except FileNotFoundError:
    raise FileNotFoundError(f"PEM file not found at: {EB_CERTIFICATE_PATH}")


# === CATEGORY RULES ===
# Format: (keywords, sub_category/Expense, category/Type)
# Ordered most-specific first; first match wins.
CATEGORY_RULES = [

    # ── Income ──────────────────────────────────────────────────────────────
    # Salary — only match the exact payroll description
    (["transfer of salary"],
     "Salary", "💰 Income"),

    # Child benefit
    (["børne", "ungeydelse", "børne- og ungeydelse", "family allowance"],
     "Børne og Unge Ydelse", "💰 Income"),

    # Tax return
    (["overskydende skat", "skat return", "skattestyrelsen refus",
      "tax return", "restskat"],
     "Skat Return", "💰 Income"),

    # ── Home ────────────────────────────────────────────────────────────────
    # Mortgage
    (["boliglån", "boliglaan", "realkredit", "mortgage", "banklån",
      "banklaen", "lån betaling", "monthly payment",
      "4698831987", "4698831995"],
     "Mortgage", "🏠 Home"),

    # Rent
    (["husleje", "leje", "fremlejer", "rent", "mollerupvej"],
     "Rent", "🏠 Home"),

    # Electricity
    (["andel energi", "energi", "el ", "electricity", "dong", "ørsted",
      "radius", "nrgi"],
     "Electricity", "🏠 Home"),

    # Hot Water / Gas
    (["fjernvarme", "varme", "gas", "lpg", "gasservice", "elvvs"],
     "Hot Water / Gas", "🏠 Home"),

    # House insurance
    (["husforsikring", "house insurance", "bygningsforsikring",
      "tryg", "gf-forsikring", "alm. brand", "codan", "topdanmark"],
     "House Insurance", "🏠 Home"),

    # Content insurance (indbo)
    (["indboforsikring", "indbo", "content insurance"],
     "Content Insurance", "🏠 Home"),

    # Cleaning
    (["happyhelper", "cleaning", "rengøring", "rengoring",
      "vaskeri", "vasketøj", "jannatul"],
     "Cleaning", "🏠 Home"),

    # Maintenance / repairs
    (["silvan", "bauhaus", "jem og fix", "xl-byg", "hornbach",
      "maintenance", "repair", "vedligehold", "tømrer", "maler",
      "electrician", "plumber", "vvs", "skousen", "texas as",
      "nordic lights", "sp nordic"],
     "Maintenance", "🏠 Home"),

    # Furniture & Misc home
    (["ikea", "jysk", "ilva", "bolia", "living", "furniture",
      "indretning", "coolrunner"],
     "Furniture & Misc", "🏠 Home"),

    # Water
    (["vand ", "vand,", "water", "hofor"],
     "Water", "🏠 Home"),

    # ── Groceries ───────────────────────────────────────────────────────────
    (["netto", "lidl", "aldi", "fakta", "bilka", "føtex", "fotex", "f@tex",
      "superbrugsen", "meny", "rema 1000", "rema,", "irma", "coop",
      "salling", "kvickly", "mad ", "grocery", "groceries",
      "min køb", "dagli", "supermarket", "lagkagehuset", "bageri",
      "carlsro", "spar r"],
     "Food", "🛒 Groceries"),

    # ── Traveling ───────────────────────────────────────────────────────────
    # Flights
    (["norwegian", "sas ", "ryanair", "easyjet", "lufthansa", "klm",
      "british airways", "airbaltic", "wizz", "flight", "fly ticket",
      "lufthavn", "airport", "barcelona tickets"],
     "Flight Tickets", "✈️ Traveling"),

    # Accommodation
    (["hotel", "airbnb", "booking.com", "hostel", "overnatning"],
     "Accommodation", "✈️ Traveling"),

    # Travel transport
    (["rejsekort", "dsb", "flixbus", "intercity", "tog ", "bane",
      "apcoa", "brobizz"],
     "Transport", "✈️ Traveling"),

    # Bars & Restaurants (travel context caught later by generic rule)

    # ── Kids ────────────────────────────────────────────────────────────────
    # Kindergarten / daycare
    (["kindergarten", "daginstitution", "vuggestue", "børnehave",
      "sfo", "fritidsordning", "dagpleje", "institution",
      "rødovre kommune"],
     "Kindergarden", "👶 Kids"),

    # Kids clothes / gear
    (["flea kids", "babysam", "kids", "børnetøj", "babyudstyr",
      "vertbaudet", "name it", "lego"],
     "Clothes", "👶 Kids"),

    # Kids activities
    (["dinos", "legoland", "tivoli", "zoo ", "museum", "place2book",
      "børneaktivitet", "svømning", "fodbold", "aktivitet"],
     "Activities", "👶 Kids"),

    # ── Car ─────────────────────────────────────────────────────────────────
    # Gasoline
    (["shell", "circle k", "q8", "ok benzin", "benzin", "fuel",
      "esso", "st1"],
     "Gasoline", "🚗 Car"),

    # Car insurance
    (["bilforsikring", "car insurance", "motoransvar", "kaskoforsikring"],
     "Insurance", "🚗 Car"),

    # Car service / repairs
    (["autohjælp", "bilreparation", "bilservice", "mekanikerservice",
      "autoværksted", "dæk", "dækkiosk", "pirelli", "michelin",
      "thansen", "car service", "dah.dk", "dansk autohjælp"],
     "Car Service", "🚗 Car"),

    # Motor / road tax
    (["skattestyrelsen motor", "ejerafgift", "motorregister",
      "road tax", "køretøjsafgift"],
     "Ejer afgifter", "🚗 Car"),

    # ── Anna personal ────────────────────────────────────────────────────────
    (["a-kasse anna", "aka anna", "foa", "hk"],
     "Akasse", "👩 Anna"),

    (["tandlæge anna", "dentist anna"],
     "Dentist", "👩 Anna"),

    (["psykolog anna", "psychologist anna", "terapi anna"],
     "Psychologist", "👩 Anna"),

    (["optik anna", "briller anna", "kontaktlinser anna",
      "glasses anna", "synsoptik"],
     "Glasses & Contacts", "👩 Anna"),

    # ── Carlos personal ──────────────────────────────────────────────────────
    (["a-kasse carlos", "aka carlos"],
     "Akasse", "👨 Carlos"),

    (["tandlæge carlos", "dentist carlos"],
     "Dentist", "👨 Carlos"),

    (["psykolog carlos", "psychologist carlos", "terapi carlos"],
     "Psychologist", "👨 Carlos"),

    (["musikforeningen", "musik forening", "music forening",
      "vesterbro musik"],
     "Music Forening", "👨 Carlos"),

    # ── Health ───────────────────────────────────────────────────────────────
    # Danmark / sygeforsikring
    (["sygeforsikring", "danmark forsikring", "sundhedsforsikring",
      "health insurance"],
     "Danmark Forsikring", "💊 Health"),

    # Pharmacy
    (["apotek", "pharmacy", "medicin"],
     "Pharmacy", "💊 Health"),

    # Dentist (generic — not caught by personal rules above)
    (["tandlæge", "dentist", "orthodontist"],
     "Dentist", "💊 Health"),

    # Massage / physio / psychologist (generic)
    (["massage", "fysioterapi", "kiropraktor", "psykolog",
      "psychologist", "terapi"],
     "Massages", "💊 Health"),

    # Doctor / hospital
    (["læge", "hospital", "klinik", "sundhed"],
     "Pharmacy", "💊 Health"),

    # ── Entertainment ────────────────────────────────────────────────────────
    # Subscriptions (streaming, apps)
    (["netflix", "spotify", "hbo", "viaplay", "disney+", "youtube",
      "apple.com/bill", "subscription", "abonnement"],
     "Subscriptions", "🎉 Entertainment"),

    # Activities / events (generic)
    (["biograf", "nordisk film", "concert", "festival", "teater",
      "event", "aktivitet", "aben ", "kulturhus"],
     "Activities", "🎉 Entertainment"),

    # Bars & restaurants (generic — covers travel & entertainment)
    (["restaurant", "cafe", "bastard", "saigon", "wolt", "just eat",
      "takeaway", "pizza", "burger", "sushi", "mcdonalds", "starbucks",
      "food and co", "kartal", "pho ", "lagkage", "brunch",
      "bar ", "kro ", "brasserie", "bistro", "armandos"],
     "Bars & Restaurants", "🎉 Entertainment"),

    # ── Shopping ─────────────────────────────────────────────────────────────
    # Clothes (generic)
    (["zara", "h&m", "hm dk", "mango", "zalando", "vero moda",
      "only ", "jack & jones", "selected", "cos ", "arket",
      "weekday", "monki", "pyjamas"],
     "Clothes", "🛍️ Shopping"),

    # Gear / electronics
    (["elgiganten", "power dk", "apple store", "computersalg",
      "gear", "gadget", "elektronik"],
     "Gear", "🛍️ Shopping"),

    # General shopping (catch-all stores)
    (["normal ", "tiger ", "søstrene grene", "flying tiger",
      "sport ", "intersport", "stadium", "decathlon"],
     "Misc", "🛍️ Shopping"),

    # ── Presents ─────────────────────────────────────────────────────────────
    (["present", "gave", "gift", "blomster", "flower"],
     "Presents", "🎁 Presents"),

    # ── Shared personal items (phone / bike / rejsekort) ────────────────────
    (["telefon", "phone", "tdc", "telenor", "3 mobil", "yousee",
      "onphone", "callme"],
     "Phone", "👩 Anna"),      # Will also catch Carlos — re-classify in app if needed

    (["rejsekort", "metro", "bus ", "movia", "transport",
      "mobilepay rejsekort"],
     "Rejsekort", "👩 Anna"),  # Generic travel card — re-classify as needed

    (["cykel", "bike", "fri bikeshop", "bikeshop", "cykelsmed"],
     "Bike repair", "👩 Anna"),
]


def categorize_transaction(debtor_name: str, creditor_name: str,
                            remittance_info: str,
                            credit_debit: str) -> tuple[str, str]:
    """
    Returns (expense/sub-category, type/category)
    """
    search_text = " ".join([
        str(debtor_name or ""),
        str(creditor_name or ""),
        str(remittance_info or ""),
    ]).lower()

    for keywords, expense, tx_type in CATEGORY_RULES:
        if any(keyword.lower() in search_text for keyword in keywords):
            return expense, tx_type

    # Default if no keyword matched — flag for manual review
    return "⚠️ Review", "⚠️ Review"


def format_amount(amount: float, credit_debit: str) -> str:
    """Format amount with +/- sign and thousand separators"""
    if not amount:
        return ""
    try:
        amount = float(amount)
        if credit_debit == "CRDT":
            return f"+{amount:,.2f}"
        else:
            return f"-{amount:,.2f}"
    except (ValueError, TypeError):
        return str(amount)


def extract_remittance_info(tx) -> str:
    """Join all remittance information lines into a single string"""
    remittance = getattr(tx, 'remittance_information', None)
    if isinstance(remittance, list):
        seen = set()
        unique = []
        for item in remittance:
            if item not in seen:
                seen.add(item)
                unique.append(item)
        return " | ".join(unique)
    return str(remittance) if remittance else ''


def clean_description(remittance_info: str, debtor_name: str,
                       creditor_name: str) -> str:
    """Extract a clean short description"""
    if remittance_info:
        first_line = remittance_info.split(" | ")[0].strip()
        if first_line and first_line.lower() not in ["none", ""]:
            return first_line
    if debtor_name:
        return debtor_name
    if creditor_name:
        return creditor_name
    return "Unknown"


# === ANNA RAW FORMAT HELPERS ===

def detect_file_format(filepath: str) -> str:
    """Return 'anna' for Danish bank semicolon format, 'standard' otherwise."""
    with open(filepath, newline='', encoding='utf-8') as f:
        first_line = f.readline()
    if 'Dato' in first_line and ';' in first_line:
        return 'anna'
    return 'standard'


def parse_anna_amount(belob_str: str) -> tuple[float, str]:
    """Parse Danish-format amount (e.g. '-1.551,00') → (abs_amount, credit_debit)."""
    # Danish: '.' = thousands separator, ',' = decimal separator
    normalized = belob_str.strip().strip('"').replace('.', '').replace(',', '.')
    try:
        amount = float(normalized)
    except ValueError:
        amount = 0.0
    credit_debit = 'CRDT' if amount >= 0 else 'DBIT'
    return abs(amount), credit_debit


def extract_account_from_filename(filename: str) -> str:
    """Derive account label from filename pattern YYYYMMDD_accountname_raw.csv."""
    parts = filename.lower().split('_')
    # Expected: ['YYYYMMDD', 'accountname', 'raw.csv']
    if len(parts) >= 2:
        account = parts[1]
        if account in ('anna', 'carlos', 'joint'):
            return account
    return 'unknown'


def normalize_anna_row(row: dict) -> dict:
    """Convert a Danish-bank CSV row to the standard schema dict."""
    tekst = row.get('Tekst', '').strip()
    dato = row.get('Dato', '').strip()
    abs_amount, credit_debit = parse_anna_amount(row.get('Belob', row.get('Beløb', '0')))

    # Convert DD.MM.YYYY → YYYY-MM-DD
    try:
        dt = datetime.strptime(dato, '%d.%m.%Y')
        booking_date = dt.strftime('%Y-%m-%d')
    except ValueError:
        booking_date = dato

    return {
        'booking_date':           booking_date,
        'amount':                 str(abs_amount),
        'credit_debit_indicator': credit_debit,
        'debtor_name':            '',
        'creditor_name':          tekst,
        'remittance_information': tekst,
    }


# === CATEGORIZED CSV SCHEMA ===
CATEGORIZED_COLUMNS = [
    'id',           # Unique row identifier (UUID)
    'Expense',      # Sub-category
    'Planned/Rea',  # Always "REA"
    'Type',         # Category
    'Date',         # Booking date DD/MM/YY
    'Month',        # Month name e.g. January
    'Year',         # Year e.g. 2026
    'Amount',       # Formatted amount with +/-
    'Comments',     # Clean description
    'Account',      # personal / joint / carlos
    'Excluded',     # Always false by default
]


def categorize_raw_folder(filter_months: bool = True, only_file: str | None = None):
    """
    Read every CSV in api/data/raw/, categorize each row, and write one
    api/data/categorized/YYYYMM_categorized.csv per month.
    When filter_months is True (default), only rows from the last 3 calendar
    months (including the current month) are kept. Set filter_months=False to
    process all rows regardless of date.
    When only_file is set (e.g. '20260601_anna_raw.csv'), only that file is
    processed; all other files in raw/ are skipped.
    Processes files produced by the API call AND any manually dropped files.
    """
    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(CATEGORIZED_DIR, exist_ok=True)

    # Cutoff: first day of the month that is 3 months ago
    _now = datetime.now()
    _first_this_month = _now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    # Step back 2 months to include current + previous 2 (= 3 total)
    _m = _first_this_month.month - 2
    _y = _first_this_month.year
    if _m <= 0:
        _m += 12
        _y -= 1
    CUTOFF_DATE = _first_this_month.replace(year=_y, month=_m)

    raw_files = sorted(
        f for f in os.listdir(RAW_DIR) if f.lower().endswith('.csv')
    )
    if only_file:
        raw_files = [f for f in raw_files if f == only_file]
        if not raw_files:
            logger.error(f"File '{only_file}' not found in {RAW_DIR}/")
            return
    if not raw_files:
        logger.info("No raw CSV files found in api/data/raw/ — nothing to categorize.")
        return

    if filter_months:
        logger.info(f"Categorizing transactions from {CUTOFF_DATE.strftime('%d/%m/%Y')} onwards.")
    else:
        logger.info("Categorizing all transactions (no date filter).")

    # cat_rows_by_month: {"YYYYMM": [row_dict, ...]}
    cat_rows_by_month = {}
    skipped = 0

    for filename in raw_files:
        filepath = os.path.join(RAW_DIR, filename)
        logger.info(f"Categorizing raw file: {filename}")
        file_format = detect_file_format(filepath)
        file_account = extract_account_from_filename(filename)
        with open(filepath, newline='', encoding='utf-8') as f:
            if file_format == 'anna':
                reader = csv.DictReader(f, delimiter=';')
                normalized_rows = [normalize_anna_row(row) for row in reader]
            else:
                reader = csv.DictReader(f)
                normalized_rows = list(reader)

        for row in normalized_rows:
            debtor_name     = row.get('debtor_name', '')
            creditor_name   = row.get('creditor_name', '')
            remittance_info = row.get('remittance_information', '')
            credit_debit    = row.get('credit_debit_indicator', '')
            booking_date    = row.get('booking_date', '')
            amount_raw      = row.get('amount', '')

            # Parse date
            parsed_date = None
            try:
                parsed_date = datetime.strptime(str(booking_date), '%Y-%m-%d')
                formatted_date = parsed_date.strftime('%d/%m/%y')
                month          = parsed_date.strftime('%B')
                year           = parsed_date.strftime('%Y')
            except (ValueError, TypeError):
                formatted_date = str(booking_date)
                month = ''
                year  = ''

            # Discard rows outside the last 3 months (when filter enabled)
            if filter_months and (parsed_date is None or parsed_date < CUTOFF_DATE):
                skipped += 1
                continue

            expense, tx_type = categorize_transaction(
                debtor_name, creditor_name, remittance_info, credit_debit
            )

            account_label = file_account

            # Account-based type override: anna → 👩 Anna, carlos → 👨 Carlos
            # Exception: income and review-flagged transactions keep their original type
            if tx_type not in ('💰 Income', '⚠️ Review'):
                if account_label == 'anna':
                    tx_type = '👩 Anna'
                elif account_label == 'carlos':
                    tx_type = '👨 Carlos'

            # Rename generic 'Salary' expense label per account
            if expense == 'Salary':
                if account_label == 'anna':
                    expense = 'Anna Salary'
                elif account_label == 'carlos':
                    expense = 'Carlos Salary'

            month_key = parsed_date.strftime('%Y%m') if parsed_date else 'unknown'
            cat_row = {
                'id':           str(uuid4()),
                'Expense':      expense,
                'Planned/Rea':  'REA',
                'Type':         tx_type,
                'Date':         formatted_date,
                'Month':        month,
                'Year':         year,
                'Amount':       format_amount(amount_raw, credit_debit),
                'Comments':     clean_description(
                                    remittance_info, debtor_name, creditor_name
                                ),
                'Account':      account_label,
                'Excluded':     'false',
            }
            cat_rows_by_month.setdefault(month_key, []).append(cat_row)

    total_rows = 0
    for month_key, rows in sorted(cat_rows_by_month.items()):
        cat_path = os.path.join(CATEGORIZED_DIR, f"{month_key}_categorized.csv")
        with open(cat_path, mode='w', newline='', encoding='utf-8') as cat_file:
            writer = csv.DictWriter(cat_file, fieldnames=CATEGORIZED_COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        logger.info(f"  {month_key}: {len(rows)} rows → {cat_path}")
        total_rows += len(rows)

    filter_note = f"{skipped} rows discarded as older than 3 months" if filter_months else "no date filter applied"
    logger.info(f"Categorization complete: {total_rows} rows across "
                f"{len(cat_rows_by_month)} month file(s) in {CATEGORIZED_DIR}/ "
                f"({filter_note})")


# === SESSION HELPERS ===
def save_session(session_id: str, accounts: list):
    with open(SESSION_FILE, 'w') as f:
        json.dump({
            "session_id": session_id,
            "accounts": accounts,
            "saved_at": datetime.now().isoformat()
        }, f, indent=2)
    logger.info(f"Session saved to {SESSION_FILE}")


def load_session() -> tuple[str, list] | tuple[None, None]:
    if os.path.exists(SESSION_FILE):
        with open(SESSION_FILE, 'r') as f:
            data = json.load(f)
            logger.info(f"Loaded existing session: {data['session_id']}")
            logger.info(f"Saved at: {data.get('saved_at', 'unknown')}")
            return data.get("session_id"), data.get("accounts", [])
    return None, None


def delete_session():
    if os.path.exists(SESSION_FILE):
        os.remove(SESSION_FILE)
        logger.info("Session file deleted")


def fetch_all_transactions():
    # 1. Initialize the service
    try:
        eb_service = EnableBankingService(
            integration=EnableBankingIntegration(
                base_url=EB_BASE_URL,
                app_id=EB_APP_ID,
                certificate=EB_CERTIFICATE,
            )
        )
    except Exception as e:
        logger.error(f"Error initializing SDK: {e}")
        return

    # 2. Try to load existing session
    session_id, account_uids = load_session()

    if not session_id:
        logger.info("No saved session found - starting new authorization")

        # 3. Find Danske Bank
        try:
            aspsps = eb_service.get_aspsps(country="DK", psu_type=PSUType.PERSONAL)
            aspsp = next((a for a in aspsps if a.name == "Danske Bank"), None)
            if not aspsp:
                logger.error("Danske Bank not found. Available banks:")
                for a in aspsps:
                    print(f"  - {a.name}")
                return
            logger.info(f"Found ASPSP: {aspsp.name}")
        except Exception as e:
            logger.error(f"Error fetching ASPSPs: {e}")
            return

        # 4. Start user session authorization
        try:
            start_session_response = eb_service.start_user_session(
                aspsp=aspsp,
                state=uuid4().hex,
                redirect_url=EB_REDIRECT_URL,
                psu_type=PSUType.PERSONAL,
                language="en",
            )
            print("\n" + "="*60)
            print("STEP 1: Open this URL in your browser:")
            print(start_session_response.url)
            print("="*60 + "\n")
        except Exception as e:
            logger.error(f"Error starting session: {e}")
            if hasattr(e, 'response') and e.response is not None:
                logger.error(f"API response body: {e.response.text}")
            return

        # 5. Get authorization code from user
        print("STEP 2: After logging in, your browser will redirect to Google.")
        print("        Copy the value after 'code=' and before '&state' in the URL\n")
        code = input("STEP 3: Paste the code here and press Enter:\n").strip()

        # 6. Finalize the session authorization
        try:
            authorize_session_response = eb_service.authorize_user_session(code)
            session_id = authorize_session_response.session_id
            logger.info(f"Session authorized! Session ID: {session_id}")

            # Extract account UIDs
            account_uids = []
            for acc in authorize_session_response.accounts:
                if hasattr(acc, 'uid'):
                    account_uids.append(acc.uid)
                elif hasattr(acc, 'account_id'):
                    account_uids.append(acc.account_id)
                elif hasattr(acc, 'id'):
                    account_uids.append(acc.id)
                else:
                    account_uids.append(str(acc))

            save_session(session_id, account_uids)

        except Exception as e:
            logger.error(f"Error authorizing session: {e}")
            if hasattr(e, 'response') and e.response is not None:
                logger.error(f"API response body: {e.response.text}")
            return
    else:
        logger.info(f"Using existing session: {session_id}")
        logger.info(f"Found {len(account_uids)} saved account(s)")

    # 7. Define raw CSV columns
    raw_columns = [
        'account_name', 'account_uid', 'booking_date', 'value_date',
        'amount', 'currency', 'credit_debit_indicator', 'status',
        'entry_reference', 'debtor_name', 'creditor_name',
        'remittance_information', 'balance_after_transaction',
    ]

    try:
        # Ensure output directories exist
        os.makedirs(RAW_DIR, exist_ok=True)
        os.makedirs(CATEGORIZED_DIR, exist_ok=True)

        raw_files_written = []

        for account_uid in account_uids:
            # Get account details
                try:
                    account_details = eb_service.get_account_details(
                        account_uid=account_uid
                    )
                    account_name = getattr(account_details, 'name', account_uid)
                    logger.info(
                        f"Processing account: {account_name} ({account_uid})"
                    )
                except Exception as e:
                    logger.warning(
                        f"Could not fetch details for {account_uid}: {e}"
                    )
                    account_name = account_uid

                # Determine per-account raw filename
                # Joint account contains both names — check this first
                _name_lower = account_name.lower()
                if 'carlos' in _name_lower and 'anna' in _name_lower:
                    account_slug = 'joint'
                elif 'carlos' in _name_lower:
                    account_slug = 'carlos'
                else:
                    account_slug = 'joint'
                raw_output_file = os.path.join(
                    RAW_DIR, f"{_EXECUTION_DATE}_{account_slug}_raw.csv"
                )

                # Fetch transactions
                try:
                    transactions = eb_service.get_account_transactions(
                        account_uid=account_uid,
                        date_from=DATE_FROM,
                        date_to=DATE_TO,
                    )
                    logger.info(f"  → {len(transactions)} transaction(s) found")

                    with open(raw_output_file, mode='w', newline='',
                              encoding='utf-8') as raw_file:
                        raw_writer = csv.DictWriter(raw_file, fieldnames=raw_columns)
                        raw_writer.writeheader()

                        for tx in transactions:
                            # Extract common fields
                            debtor = getattr(tx, 'debtor', None)
                            debtor_name = getattr(debtor, 'name', '') if debtor else ''

                            creditor = getattr(tx, 'creditor', None)
                            creditor_name = getattr(creditor, 'name', '') if creditor else ''

                            balance = getattr(tx, 'balance_after_transaction', None)
                            balance_amount = getattr(balance, 'amount', '') if balance else ''

                            amount = getattr(
                                getattr(tx, 'transaction_amount', None), 'amount', ''
                            )
                            currency = getattr(
                                getattr(tx, 'transaction_amount', None), 'currency', ''
                            )
                            credit_debit = getattr(tx, 'credit_debit_indicator', '')
                            remittance_info = extract_remittance_info(tx)
                            booking_date = getattr(tx, 'booking_date', '')

                            # Parse date for Month and Year columns
                            parsed_date = None
                            try:
                                parsed_date = datetime.strptime(
                                    str(booking_date), '%Y-%m-%d'
                                )
                                formatted_date = parsed_date.strftime('%d/%m/%y')  # e.g. "06/02/26"
                                month = parsed_date.strftime('%B')  # e.g. "February"
                                year = parsed_date.strftime('%Y')   # e.g. "2026"
                            except (ValueError, TypeError):
                                formatted_date = str(booking_date)
                                month = ''
                                year = ''

                            # Write raw data
                            raw_writer.writerow({
                                'account_name': account_name,
                                'account_uid': account_uid,
                                'booking_date': booking_date,
                                'value_date': getattr(tx, 'value_date', ''),
                                'amount': amount,
                                'currency': currency,
                                'credit_debit_indicator': credit_debit,
                                'status': getattr(tx, 'status', ''),
                                'entry_reference': getattr(tx, 'entry_reference', ''),
                                'debtor_name': debtor_name,
                                'creditor_name': creditor_name,
                                'remittance_information': remittance_info,
                                'balance_after_transaction': balance_amount,
                            })

                    raw_files_written.append(raw_output_file)
                    logger.info(f"  Raw saved to: {raw_output_file}")

                except Exception as e:
                    logger.error(
                        f"Error fetching transactions for {account_name}: {e}"
                    )
                    if "401" in str(e) or "403" in str(e):
                        logger.warning("Session expired - deleting saved session")
                        delete_session()

        logger.info(f"Raw files written: {raw_files_written}")

        # Categorize all raw files (API-fetched + manually dropped)
        categorize_raw_folder()

    except IOError as e:
        logger.error(f"Error writing to CSV: {e}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == 'categorize':
        # Run categorization only (for manually dropped raw files)
        # Pass --all to disable the 3-month date filter
        # Pass --file <filename> to process a single file
        no_filter = '--all' in sys.argv
        only_file = None
        if '--file' in sys.argv:
            idx = sys.argv.index('--file')
            if idx + 1 < len(sys.argv):
                only_file = sys.argv[idx + 1]
        categorize_raw_folder(filter_months=not no_filter, only_file=only_file)
    else:
        # Full flow: fetch from bank API then categorize
        fetch_all_transactions()
