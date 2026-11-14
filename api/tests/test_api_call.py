import os
import unittest
from unittest.mock import patch

from api.api_call import load_account_uids_from_environment


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


if __name__ == "__main__":
    unittest.main()
