import os
import json
import logging
import pip_system_certs.wrapt_requests
from uuid import uuid4
from datetime import datetime, timezone
from enablebanking_sdk.service import EnableBankingService, EnableBankingIntegration

if __package__:
    from .supabase_import import (
        SupabaseImportClient,
        SupabaseImportError,
        build_supabase_transaction,
        get_fetch_start_date,
    )
else:
    from supabase_import import (
        SupabaseImportClient,
        SupabaseImportError,
        build_supabase_transaction,
        get_fetch_start_date,
    )

# === CONFIGURATION ===
EB_BASE_URL = os.getenv("ENABLEBANKING_BASE_URL", "https://api.enablebanking.com").strip()
EB_APP_ID = os.getenv("ENABLEBANKING_APP_ID", "").strip()
EB_CERTIFICATE = os.getenv("ENABLEBANKING_CERTIFICATE_PEM", "").strip()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
      "radius", "nrgi","Evdk ApS"],
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
      "nordic lights", "sp nordic","jem & fix", "silvan", "bauhaus", "HARALD NYBORG", "RØVERKØB A/S"],
     "Maintenance", "🏠 Home"),

    # Furniture & Misc home
    (["ikea", "jysk", "ilva", "bolia", "living", "furniture",
      "indretning", "coolrunner"],
     "Furniture & Misc", "🏠 Home"),

    # Water
    (["vand ", "vand,", "water", "hofor"],
     "Water", "🏠 Home"),

    #Internet
    (["EWII"],
    "Internet", "🏠 Home"),

    # ── Groceries ───────────────────────────────────────────────────────────
    (["netto", "lidl", "aldi", "fakta", "bilka", "føtex", "fotex", "f@tex",
      "superbrugsen", "meny", "rema 1000", "rema1000", "rema,", "irma", "coop",
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
    # Leasing
    (["Volkswagen Semler Finans"],
     "Leasing", "🚗 Car"),
    
    
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
    (["netflix", "spotify", "hbo", "viaplay", "disney+", "disney plus", "disney +", "youtube",
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


def categorize_raw_transaction(row: dict, account_label: str):
    debtor_name = row.get('debtor_name', '')
    creditor_name = row.get('creditor_name', '')
    remittance_info = row.get('remittance_information', '')
    credit_debit = row.get('credit_debit_indicator', '')
    booking_date = row.get('booking_date', '')
    amount_raw = row.get('amount', '')

    parsed_date = None
    try:
        parsed_date = datetime.strptime(str(booking_date), '%Y-%m-%d')
        formatted_date = parsed_date.strftime('%d/%m/%y')
        month = parsed_date.strftime('%B')
        year = parsed_date.strftime('%Y')
    except (ValueError, TypeError):
        formatted_date = str(booking_date)
        month = ''
        year = ''

    expense, tx_type = categorize_transaction(
        debtor_name, creditor_name, remittance_info, credit_debit
    )

    if tx_type not in ('💰 Income', '⚠️ Review'):
        if account_label == 'anna':
            tx_type = '👩 Anna'
        elif account_label == 'carlos':
            tx_type = '👨 Carlos'

    if expense == 'Salary':
        if account_label == 'anna':
            expense = 'Anna Salary'
        elif account_label == 'carlos':
            expense = 'Carlos Salary'

    return parsed_date, {
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


# === NONINTERACTIVE ACCOUNT CONFIGURATION ===
def load_account_uids_from_environment() -> list[str]:
    account_uids_value = os.getenv("ENABLEBANKING_ACCOUNT_UIDS", "").strip()
    if not account_uids_value:
        raise RuntimeError("Set ENABLEBANKING_ACCOUNT_UIDS.")

    try:
        account_uids = json.loads(account_uids_value)
    except json.JSONDecodeError:
        raise RuntimeError(
            "ENABLEBANKING_ACCOUNT_UIDS must be a JSON array of account UIDs."
        ) from None

    if (
        not isinstance(account_uids, list)
        or not account_uids
        or any(not isinstance(uid, str) or not uid.strip() for uid in account_uids)
    ):
        raise RuntimeError(
            "ENABLEBANKING_ACCOUNT_UIDS must be a non-empty JSON array of strings."
        )

    return [uid.strip() for uid in account_uids]


def _safe_bank_error(error: Exception) -> str:
    status_code = getattr(getattr(error, "response", None), "status_code", None)
    if isinstance(status_code, int):
        return f"HTTP {status_code}"
    return type(error).__name__


def fetch_all_transactions():
    missing_configuration = [
        name
        for name, value in (
            ("ENABLEBANKING_BASE_URL", EB_BASE_URL),
            ("ENABLEBANKING_APP_ID", EB_APP_ID),
            ("ENABLEBANKING_CERTIFICATE_PEM", EB_CERTIFICATE),
        )
        if not value
    ]
    if missing_configuration:
        raise RuntimeError(
            "Missing required configuration: " + ", ".join(missing_configuration)
        )

    account_uids = load_account_uids_from_environment()

    try:
        importer = SupabaseImportClient()
        initial_start_date, last_successful_date = importer.get_import_state()
    except SupabaseImportError as error:
        logger.error("Supabase import configuration failed: %s", error)
        raise

    fetch_from = get_fetch_start_date(initial_start_date, last_successful_date)
    fetch_from_datetime = datetime(
        fetch_from.year, fetch_from.month, fetch_from.day, tzinfo=timezone.utc
    )
    fetch_to = datetime.now(timezone.utc)
    logger.info(
        f"Fetching bank transactions from {fetch_from.isoformat()} "
        f"through {fetch_to.date().isoformat()}."
    )

    try:
        eb_service = EnableBankingService(
            integration=EnableBankingIntegration(
                base_url=EB_BASE_URL,
                app_id=EB_APP_ID,
                certificate=EB_CERTIFICATE,
            )
        )
    except Exception as error:
        raise RuntimeError(
            "Enable Banking SDK initialization failed "
            f"({_safe_bank_error(error)})."
        ) from None

    logger.info(
        "Using %s configured Enable Banking account(s).",
        len(account_uids),
    )
    imported_rows_by_reference = {}
    all_accounts_fetched = True

    for account_index, account_uid in enumerate(account_uids, start=1):
        try:
            account_details = eb_service.get_account_details(account_uid=account_uid)
            account_name = str(getattr(account_details, "name", "") or "").lower()
        except Exception as error:
            logger.warning(
                "Could not retrieve metadata for configured account %s (%s).",
                account_index,
                _safe_bank_error(error),
            )
            account_name = ""

        if "carlos" in account_name and "anna" in account_name:
            account_label = "joint"
        elif "carlos" in account_name:
            account_label = "carlos"
        else:
            account_label = "joint"

        try:
            transactions = eb_service.get_account_transactions(
                account_uid=account_uid,
                date_from=fetch_from_datetime,
                date_to=fetch_to,
            )

            for tx in transactions:
                debtor = getattr(tx, "debtor", None)
                creditor = getattr(tx, "creditor", None)
                transaction_amount = getattr(tx, "transaction_amount", None)
                booking_date = getattr(tx, "booking_date", "")
                entry_reference = str(getattr(tx, "entry_reference", "") or "").strip()
                raw_row = {
                    "booking_date": booking_date,
                    "amount": getattr(transaction_amount, "amount", ""),
                    "credit_debit_indicator": getattr(
                        tx, "credit_debit_indicator", ""
                    ),
                    "entry_reference": entry_reference,
                    "debtor_name": getattr(debtor, "name", "") if debtor else "",
                    "creditor_name": getattr(creditor, "name", "") if creditor else "",
                    "remittance_information": extract_remittance_info(tx),
                }

                parsed_date, categorized_row = categorize_raw_transaction(
                    raw_row, account_label
                )
                if parsed_date is None:
                    raise ValueError("Bank transaction has an invalid booking date.")
                if parsed_date.date() < fetch_from:
                    continue

                transaction = build_supabase_transaction(
                    categorized_row, entry_reference
                )
                existing = imported_rows_by_reference.get(entry_reference)
                if existing:
                    comparable_existing = {
                        key: value for key, value in existing.items() if key != "id"
                    }
                    comparable_transaction = {
                        key: value for key, value in transaction.items() if key != "id"
                    }
                    if comparable_existing != comparable_transaction:
                        raise ValueError(
                            "A bank reference was returned with inconsistent data."
                        )
                else:
                    imported_rows_by_reference[entry_reference] = transaction

            logger.info(
                "Fetched transactions for configured account %s: %s.",
                account_index,
                len(transactions),
            )
        except Exception as error:
            all_accounts_fetched = False
            logger.error(
                "Fetching transactions for configured account %s failed (%s).",
                account_index,
                _safe_bank_error(error),
            )

    if not all_accounts_fetched:
        raise RuntimeError(
            "At least one account fetch failed; Supabase import and watermark "
            "update were not run."
        )

    inserted_count = importer.import_transactions(
        list(imported_rows_by_reference.values()), fetch_to.date()
    )
    logger.info(
        "Supabase import complete: %s inserted, %s already present.",
        inserted_count,
        len(imported_rows_by_reference) - inserted_count,
    )


if __name__ == "__main__":
    fetch_all_transactions()
