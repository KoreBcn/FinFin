import json
import os
import tempfile
import unittest
from datetime import date

from api.supabase_import import (
    SupabaseImportClient,
    SupabaseImportError,
    build_supabase_transaction,
    get_fetch_start_date,
    load_supabase_config,
)


class _FakeResponse:
    def __init__(self, value=None):
        self.ok = True
        self.status_code = 200
        self.text = ""
        self.content = b"1" if value is not None else b""
        self._value = value

    def json(self):
        return self._value


class _FakeSession:
    def __init__(self):
        self.calls = []
        self.headers = {}

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return _FakeResponse(1 if "/rpc/" in url else None)


class SupabaseImportTests(unittest.TestCase):
    def test_builds_target_row_with_source_reference_and_uuid(self):
        row = build_supabase_transaction(
            {
                "id": "30f2c030-7348-4ed1-82d2-8c1054a2ac5d",
                "Expense": "Food",
                "Planned/Rea": "REA",
                "Type": "Groceries",
                "Date": "12/11/26",
                "Amount": "-1,234.50",
                "Comments": "Grocery shop",
                "Account": "joint",
                "Excluded": "false",
            },
            "bank-entry-123",
        )

        self.assertEqual(row["id"], "30f2c030-7348-4ed1-82d2-8c1054a2ac5d")
        self.assertEqual(row["source_system"], "enablebanking")
        self.assertEqual(row["source_entry_reference"], "bank-entry-123")
        self.assertEqual(row["transaction_date"], "2026-11-12")
        self.assertEqual(row["amount"], "-1234.50")
        self.assertFalse(row["is_excluded"])

    def test_rejects_missing_entry_reference(self):
        with self.assertRaisesRegex(ValueError, "missing entry_reference"):
            build_supabase_transaction(
                {"Date": "12/11/26", "Amount": "-10.00"},
                "",
            )

    def test_invalid_transaction_values_are_not_in_error_messages(self):
        with self.assertRaises(ValueError) as date_error:
            build_supabase_transaction(
                {"Date": "private-date", "Amount": "-10.00"},
                "bank-entry-123",
            )
        self.assertNotIn("private-date", str(date_error.exception))

        with self.assertRaises(ValueError) as amount_error:
            build_supabase_transaction(
                {"Date": "12/11/26", "Amount": "private-amount"},
                "bank-entry-123",
            )
        self.assertNotIn("private-amount", str(amount_error.exception))

    def test_fetch_start_uses_overlap_without_crossing_initial_floor(self):
        floor = date(2026, 11, 1)

        self.assertEqual(
            get_fetch_start_date(floor, date(2026, 11, 12)),
            date(2026, 11, 10),
        )
        self.assertEqual(
            get_fetch_start_date(floor, date(2026, 10, 31)),
            floor,
        )

    def test_reads_supabase_config_json(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = os.path.join(temp_dir, "supabase-config.json")
            with open(config_path, "w", encoding="utf-8") as config_file:
                json.dump(
                    {
                        "url": "https://example.supabase.co",
                        "service_role_key": "test-key",
                    },
                    config_file,
                )

            config = load_supabase_config(config_path)

        self.assertEqual(config["url"], "https://example.supabase.co")
        self.assertEqual(config["service_role_key"], "test-key")

    def test_import_stages_rows_and_calls_insert_only_rpc(self):
        client = SupabaseImportClient.__new__(SupabaseImportClient)
        client.base_url = "https://example.supabase.co"
        client.session = _FakeSession()

        inserted = client.import_transactions(
            [
                {
                    "id": "30f2c030-7348-4ed1-82d2-8c1054a2ac5d",
                    "source_system": "enablebanking",
                    "source_entry_reference": "bank-entry-123",
                }
            ],
            date(2026, 11, 12),
        )

        self.assertEqual(inserted, 1)
        self.assertTrue(client.session.calls[0][1].endswith("/transaction_import_stage"))
        self.assertTrue(
            client.session.calls[1][1].endswith(
                "/rpc/import_enablebanking_transactions"
            )
        )
        self.assertNotIn("/transactions", client.session.calls[0][1])

    def test_supabase_error_does_not_expose_response_body(self):
        class _ErrorResponse:
            ok = False
            status_code = 400
            content = b"private transaction data"
            text = "private transaction data"

        class _ErrorSession:
            headers = {}

            def request(self, method, url, **kwargs):
                return _ErrorResponse()

        client = SupabaseImportClient.__new__(SupabaseImportClient)
        client.base_url = "https://example.supabase.co"
        client.session = _ErrorSession()

        with self.assertRaises(SupabaseImportError) as error:
            client._request("GET", "transactions")

        self.assertNotIn("private transaction data", str(error.exception))


if __name__ == "__main__":
    unittest.main()
