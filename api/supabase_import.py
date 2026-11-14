import json
import logging
import os
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from uuid import uuid4

import requests


SOURCE_SYSTEM = "enablebanking"
STAGE_BATCH_SIZE = 500
logger = logging.getLogger(__name__)
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "supabase-config.json")


class SupabaseImportError(RuntimeError):
    pass


def load_supabase_config(config_path: str = CONFIG_PATH) -> dict:
    try:
        with open(config_path, encoding="utf-8") as config_file:
            config = json.load(config_file)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as error:
        raise SupabaseImportError(
            f"Could not read Supabase config file at {config_path}: {error}"
        ) from error

    if not isinstance(config, dict):
        raise SupabaseImportError("Supabase config must contain a JSON object.")

    return config


def get_fetch_start_date(initial_start_date: date, last_successful_date: date) -> date:
    """Re-fetch a short overlap, but never reach before the configured start date."""
    return max(initial_start_date, last_successful_date - timedelta(days=2))


def build_supabase_transaction(
    row: dict, source_entry_reference: str
) -> dict:
    source_entry_reference = str(source_entry_reference or "").strip()
    if not source_entry_reference:
        raise ValueError("Bank transaction is missing entry_reference")

    try:
        transaction_date = datetime.strptime(row["Date"], "%d/%m/%y").date()
    except (KeyError, TypeError, ValueError):
        raise ValueError("Invalid categorized transaction date.") from None

    try:
        amount = Decimal(str(row["Amount"]).replace(",", "").strip())
    except (KeyError, InvalidOperation, ValueError):
        raise ValueError("Invalid categorized transaction amount.") from None

    if not amount.is_finite():
        raise ValueError("Invalid categorized transaction amount.")

    return {
        "id": row.get("id") or str(uuid4()),
        "source_system": SOURCE_SYSTEM,
        "source_entry_reference": source_entry_reference,
        "expense": row.get("Expense") or "",
        "category": row.get("Type") or "",
        "transaction_status": row.get("Planned/Rea") or "REA",
        "transaction_date": transaction_date.isoformat(),
        "amount": str(amount),
        "comments": row.get("Comments") or None,
        "account": row.get("Account") or "",
        "is_excluded": str(row.get("Excluded", "false")).strip().lower() == "true",
    }


class SupabaseImportClient:
    def __init__(self):
        config = load_supabase_config()
        url = os.getenv("SUPABASE_URL") or config.get("url", "")
        service_role_key = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or config.get("service_role_key", "")
        )
        if not isinstance(url, str) or not isinstance(service_role_key, str):
            raise SupabaseImportError(
                "Supabase config values 'url' and 'service_role_key' must be strings."
            )

        self.base_url = url.strip().rstrip("/")
        self.service_role_key = service_role_key.strip()
        if not self.base_url or not self.service_role_key:
            raise SupabaseImportError(
                "Set url and service_role_key in api/supabase-config.json or "
                "provide SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
            )

        self.session = requests.Session()
        self.session.headers.update(
            {
                "apikey": self.service_role_key,
                "Authorization": f"Bearer {self.service_role_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )

    def _request(self, method: str, path: str, **kwargs):
        response = self.session.request(
            method,
            f"{self.base_url}/rest/v1/{path}",
            timeout=60,
            **kwargs,
        )
        if not response.ok:
            raise SupabaseImportError(
                f"Supabase {method} {path} failed ({response.status_code})."
            )
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise SupabaseImportError(
                f"Supabase {method} {path} returned invalid JSON."
            ) from error

    def get_import_state(self) -> tuple[date, date]:
        rows = self._request(
            "GET",
            "transaction_import_state",
            params={
                "select": "initial_start_date,last_successful_date",
                "source_system": f"eq.{SOURCE_SYSTEM}",
            },
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise SupabaseImportError(
                "Import state is missing. Apply db/supabase/transaction_import.sql "
                "in the Supabase SQL Editor."
            )

        try:
            return (
                date.fromisoformat(rows[0]["initial_start_date"]),
                date.fromisoformat(rows[0]["last_successful_date"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise SupabaseImportError("Supabase import state contains invalid dates.") from error

    def import_transactions(self, transactions: list[dict], through_date: date) -> int:
        run_id = str(uuid4())
        staged_rows = [{**row, "run_id": run_id} for row in transactions]
        completed = False

        try:
            for offset in range(0, len(staged_rows), STAGE_BATCH_SIZE):
                self._request(
                    "POST",
                    "transaction_import_stage",
                    params={
                        "on_conflict": "run_id,source_system,source_entry_reference"
                    },
                    headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
                    json=staged_rows[offset : offset + STAGE_BATCH_SIZE],
                )

            inserted = self._request(
                "POST",
                "rpc/import_enablebanking_transactions",
                json={
                    "p_run_id": run_id,
                    "p_through_date": through_date.isoformat(),
                },
            )
            if not isinstance(inserted, int):
                raise SupabaseImportError(
                    "Supabase import function returned an unexpected result."
                )
            completed = True
            return inserted
        except (requests.RequestException, SupabaseImportError):
            if not completed:
                try:
                    self._request(
                        "DELETE",
                        "transaction_import_stage",
                        params={"run_id": f"eq.{run_id}"},
                        headers={"Prefer": "return=minimal"},
                    )
                except (requests.RequestException, SupabaseImportError):
                    logger.exception("Could not clean up failed staging run %s", run_id)
            raise
