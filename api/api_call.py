import os
import json
import logging
import argparse
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
DEFAULT_EB_BASE_URL = "https://api.enablebanking.com"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def categorize_transaction(debtor_name: str, creditor_name: str,
                            remittance_info: str,
                            credit_debit: str,
                            rules: list[dict],
                            account_label: str) -> tuple[str, str, bool]:
    """
    Returns (expense/sub-category, type/category, is_excluded) using the first
    matching rule from the category_rules table (ordered by position). A rule
    only applies to transactions from its from_account (or "all"); an empty
    from_account never matches.
    """
    search_text = " ".join([
        str(debtor_name or ""),
        str(creditor_name or ""),
        str(remittance_info or ""),
    ]).lower()
    account = str(account_label or "").strip().lower()

    for rule in rules:
        rule_account = str(rule.get("from_account") or "").strip().lower()
        if not rule_account or not account:
            continue
        if rule_account != "all" and rule_account != account:
            continue
        if any(
            keyword and keyword.lower() in search_text
            for keyword in rule.get("keywords") or []
        ):
            return (
                rule["subcategory"],
                rule["category"],
                bool(rule.get("is_excluded")),
            )

    # Default if no keyword matched — flag for manual review
    return "⚠️ Review", "⚠️ Review", False


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


def categorize_raw_transaction(row: dict, account_label: str, rules: list[dict]):
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

    expense, tx_type, is_excluded = categorize_transaction(
        debtor_name, creditor_name, remittance_info, credit_debit, rules,
        account_label,
    )

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
        'Excluded':     'true' if is_excluded else 'false',
    }


# === NONINTERACTIVE ACCOUNT CONFIGURATION ===
def load_account_uids_from_environment(prefix: str = "") -> list[str]:
    variable_name = (
        f"ENABLEBANKING_{prefix}ACCOUNT_UIDS"
        if prefix
        else "ENABLEBANKING_ACCOUNT_UIDS"
    )
    account_uids_value = os.getenv(variable_name, "").strip()
    if not account_uids_value:
        raise RuntimeError(f"Set {variable_name}.")

    try:
        account_uids = json.loads(account_uids_value)
    except json.JSONDecodeError:
        raise RuntimeError(
            f"{variable_name} must be a JSON array of account UIDs."
        ) from None

    if (
        not isinstance(account_uids, list)
        or not account_uids
        or any(not isinstance(uid, str) or not uid.strip() for uid in account_uids)
    ):
        raise RuntimeError(
            f"{variable_name} must be a non-empty JSON array of strings."
        )

    return [uid.strip() for uid in account_uids]


def load_import_profiles_from_environment() -> list[dict]:
    primary = {
        "name": "primary",
        "base_url": os.getenv(
            "ENABLEBANKING_BASE_URL", DEFAULT_EB_BASE_URL
        ).strip(),
        "app_id": os.getenv("ENABLEBANKING_APP_ID", "").strip(),
        "certificate": os.getenv("ENABLEBANKING_CERTIFICATE_PEM", "").strip(),
        "account_uids": load_account_uids_from_environment(),
        "account_label": None,
        "reference_prefix": "",
    }
    profiles = [primary]

    anna_prefix = "ENABLEBANKING_ANNA_"
    anna_values = {
        "app_id": os.getenv(f"{anna_prefix}APP_ID", "").strip(),
        "certificate": os.getenv(
            f"{anna_prefix}CERTIFICATE_PEM", ""
        ).strip(),
        "account_uids_value": os.getenv(
            f"{anna_prefix}ACCOUNT_UIDS", ""
        ).strip(),
    }
    anna_configured = any(anna_values.values())
    if anna_configured:
        missing = [
            f"{anna_prefix}{name}"
            for name, value in (
                ("APP_ID", anna_values["app_id"]),
                ("CERTIFICATE_PEM", anna_values["certificate"]),
                ("ACCOUNT_UIDS", anna_values["account_uids_value"]),
            )
            if not value
        ]
        if missing:
            raise RuntimeError(
                "Incomplete Anna Enable Banking profile: " + ", ".join(missing)
            )
        profiles.append(
            {
                "name": "anna",
                "base_url": primary["base_url"],
                "app_id": anna_values["app_id"],
                "certificate": anna_values["certificate"],
                "account_uids": load_account_uids_from_environment("ANNA_"),
                "account_label": "anna",
                "reference_prefix": "anna:",
            }
        )

    return profiles


def _safe_bank_error(error: Exception) -> str:
    status_code = getattr(getattr(error, "response", None), "status_code", None)
    if isinstance(status_code, int):
        return f"HTTP {status_code}"
    return type(error).__name__


def format_account_fetch_failure(
    profile_name: str, account_index: int, operation: str, error: Exception
) -> str:
    return (
        f"{profile_name} account {account_index}: {operation} failed "
        f"({_safe_bank_error(error)})"
    )


def parse_date_override(value: str):
    if not value:
        return None
    parsed = datetime.strptime(value, "%Y-%m-%d").date()
    if parsed > datetime.now(timezone.utc).date():
        raise ValueError("Import start date cannot be in the future.")
    return parsed


def fetch_all_transactions(profile_name: str | None = None, fetch_from_override=None):
    profiles = load_import_profiles_from_environment()
    if profile_name:
        profiles = [profile for profile in profiles if profile["name"] == profile_name]
        if not profiles:
            raise RuntimeError(f"Unknown import profile: {profile_name}")
    for profile in profiles:
        missing_configuration = [
            name
            for name, value in (
                ("base URL", profile["base_url"]),
                ("app ID", profile["app_id"]),
                ("certificate", profile["certificate"]),
            )
            if not value
        ]
        if missing_configuration:
            raise RuntimeError(
                f"Missing {profile['name']} Enable Banking configuration: "
                + ", ".join(missing_configuration)
            )

    try:
        importer = SupabaseImportClient()
        initial_start_date, last_successful_date = importer.get_import_state()
        category_rules = importer.get_category_rules()
    except SupabaseImportError as error:
        logger.error("Supabase import configuration failed: %s", error)
        raise

    fetch_from = fetch_from_override or get_fetch_start_date(
        initial_start_date, last_successful_date
    )
    if fetch_from_override and fetch_from_override < initial_start_date:
        logger.warning(
            "Ad-hoc fetch starts before the configured watermark floor (%s).",
            initial_start_date.isoformat(),
        )
    fetch_from_datetime = datetime(
        fetch_from.year, fetch_from.month, fetch_from.day, tzinfo=timezone.utc
    )
    fetch_to = datetime.now(timezone.utc)
    logger.info(
        f"Fetching bank transactions from {fetch_from.isoformat()} "
        f"through {fetch_to.date().isoformat()}."
    )

    imported_rows_by_reference = {}
    all_accounts_fetched = True
    account_failures = []

    for profile in profiles:
        try:
            eb_service = EnableBankingService(
                integration=EnableBankingIntegration(
                    base_url=profile["base_url"],
                    app_id=profile["app_id"],
                    certificate=profile["certificate"],
                )
            )
        except Exception as error:
            raise RuntimeError(
                f"{profile['name']} Enable Banking SDK initialization failed "
                f"({_safe_bank_error(error)})."
            ) from None

        logger.info(
            "Using %s account(s) from the %s Enable Banking profile.",
            len(profile["account_uids"]),
            profile["name"],
        )

        for account_index, account_uid in enumerate(
            profile["account_uids"], start=1
        ):
            account_label = profile["account_label"]
            if account_label is None:
                try:
                    account_details = eb_service.get_account_details(
                        account_uid=account_uid
                    )
                    account_name = str(
                        getattr(account_details, "name", "") or ""
                    ).lower()
                except Exception as error:
                    logger.warning(
                        "Could not retrieve metadata for %s account %s (%s).",
                        profile["name"],
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
                    entry_reference = str(
                        getattr(tx, "entry_reference", "") or ""
                    ).strip()
                    if not entry_reference:
                        raise ValueError(
                            "Bank transaction is missing entry_reference."
                        )
                    source_reference = (
                        f"{profile['reference_prefix']}{entry_reference}"
                    )
                    raw_row = {
                        "booking_date": booking_date,
                        "amount": getattr(transaction_amount, "amount", ""),
                        "credit_debit_indicator": getattr(
                            tx, "credit_debit_indicator", ""
                        ),
                        "entry_reference": entry_reference,
                        "debtor_name": (
                            getattr(debtor, "name", "") if debtor else ""
                        ),
                        "creditor_name": (
                            getattr(creditor, "name", "") if creditor else ""
                        ),
                        "remittance_information": extract_remittance_info(tx),
                    }

                    parsed_date, categorized_row = categorize_raw_transaction(
                        raw_row, account_label, category_rules
                    )
                    if parsed_date is None:
                        raise ValueError(
                            "Bank transaction has an invalid booking date."
                        )
                    if parsed_date.date() < fetch_from:
                        continue

                    transaction = build_supabase_transaction(
                        categorized_row, source_reference
                    )
                    existing = imported_rows_by_reference.get(source_reference)
                    if existing:
                        comparable_existing = {
                            key: value
                            for key, value in existing.items()
                            if key != "id"
                        }
                        comparable_transaction = {
                            key: value
                            for key, value in transaction.items()
                            if key != "id"
                        }
                        if comparable_existing != comparable_transaction:
                            raise ValueError(
                                "A bank reference was returned with "
                                "inconsistent data."
                            )
                    else:
                        imported_rows_by_reference[
                            source_reference
                        ] = transaction

                logger.info(
                    "Fetched transactions for %s account %s: %s.",
                    profile["name"],
                    account_index,
                    len(transactions),
                )
            except Exception as error:
                all_accounts_fetched = False
                failure = format_account_fetch_failure(
                    profile["name"],
                    account_index,
                    "transaction fetch",
                    error,
                )
                account_failures.append(failure)
                logger.error("%s.", failure)

    if not all_accounts_fetched:
        raise RuntimeError(
            "At least one account fetch failed; Supabase import and watermark "
            "update were not run. "
            + "; ".join(account_failures)
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
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--profile",
        choices=("primary", "anna"),
        help="Run only one Enable Banking credential profile.",
    )
    parser.add_argument(
        "--from",
        dest="fetch_from",
        help="Override the fetch start date as YYYY-MM-DD.",
    )
    args = parser.parse_args()
    fetch_all_transactions(args.profile, parse_date_override(args.fetch_from))
