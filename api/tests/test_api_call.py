import os
import unittest
from unittest.mock import patch

from api.api_call import (
    categorize_raw_transaction,
    format_account_fetch_failure,
    load_account_uids_from_environment,
    load_import_profiles_from_environment,
    parse_date_override,
)


class BankAccountConfigurationTests(unittest.TestCase):
    def test_reads_account_uids_from_json_environment_value(self):
        with patch.dict(
            os.environ,
            {"ENABLEBANKING_ACCOUNT_UIDS": '["account-1", "account-2"]'},
        ):
            account_uids = load_account_uids_from_environment()

        self.assertEqual(account_uids, ["account-1", "account-2"])

    def test_rejects_non_json_account_uids(self):
        with patch.dict(os.environ, {"ENABLEBANKING_ACCOUNT_UIDS": "account-1"}):
            with self.assertRaisesRegex(RuntimeError, "JSON array"):
                load_account_uids_from_environment()

    def test_loads_optional_anna_profile_with_separate_credentials(self):
        with patch.dict(
            os.environ,
            {
                "ENABLEBANKING_APP_ID": "primary-app",
                "ENABLEBANKING_CERTIFICATE_PEM": "primary-certificate",
                "ENABLEBANKING_ACCOUNT_UIDS": '["primary-account"]',
                "ENABLEBANKING_ANNA_APP_ID": "anna-app",
                "ENABLEBANKING_ANNA_CERTIFICATE_PEM": "anna-certificate",
                "ENABLEBANKING_ANNA_ACCOUNT_UIDS": '["anna-account"]',
            },
            clear=True,
        ):
            profiles = load_import_profiles_from_environment()

        self.assertEqual(len(profiles), 2)
        self.assertEqual(profiles[1]["account_label"], "anna")
        self.assertEqual(profiles[1]["reference_prefix"], "anna:")
        self.assertEqual(profiles[1]["app_id"], "anna-app")
        self.assertEqual(profiles[1]["account_uids"], ["anna-account"])

    def test_rejects_incomplete_anna_profile(self):
        with patch.dict(
            os.environ,
            {
                "ENABLEBANKING_APP_ID": "primary-app",
                "ENABLEBANKING_CERTIFICATE_PEM": "primary-certificate",
                "ENABLEBANKING_ACCOUNT_UIDS": '["primary-account"]',
                "ENABLEBANKING_ANNA_APP_ID": "anna-app",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(
                RuntimeError, "Incomplete Anna Enable Banking profile"
            ):
                load_import_profiles_from_environment()

    def test_anna_profile_rows_are_categorized_for_anna_and_keep_review(self):
        known = categorize_raw_transaction(
            {
                "booking_date": "2026-11-22",
                "amount": "25.00",
                "credit_debit_indicator": "DBIT",
                "debtor_name": "",
                "creditor_name": "Netto",
                "remittance_information": "Netto groceries",
            },
            "anna",
        )
        unknown = categorize_raw_transaction(
            {
                "booking_date": "2026-11-22",
                "amount": "25.00",
                "credit_debit_indicator": "DBIT",
                "debtor_name": "",
                "creditor_name": "Unknown Merchant",
                "remittance_information": "No category match",
            },
            "anna",
        )

        self.assertEqual(known[1]["Account"], "anna")
        self.assertEqual(known[1]["Type"], "👩 Anna")
        self.assertEqual(unknown[1]["Account"], "anna")
        self.assertEqual(unknown[1]["Expense"], "⚠️ Review")
        self.assertEqual(unknown[1]["Type"], "⚠️ Review")

    def test_parses_valid_adhoc_start_date(self):
        parsed = parse_date_override("2026-05-22")

        self.assertEqual(parsed.isoformat(), "2026-05-22")

    def test_rejects_invalid_adhoc_start_date(self):
        with self.assertRaisesRegex(ValueError, "does not match format"):
            parse_date_override("22-05-2026")

    def test_formats_bank_failure_without_private_account_identifiers(self):
        error = RuntimeError("private account response")

        message = format_account_fetch_failure(
            "primary", 1, "transaction fetch", error
        )

        self.assertEqual(
            message,
            "primary account 1: transaction fetch failed (RuntimeError)",
        )
        self.assertNotIn("private", message)


if __name__ == "__main__":
    unittest.main()
