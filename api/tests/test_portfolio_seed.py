import csv
import importlib.util
import tempfile
import unittest
from pathlib import Path


path = Path(__file__).resolve().parents[2] / "db" / "supabase" / "generate_portfolio_seed.py"
spec = importlib.util.spec_from_file_location("generate_portfolio_seed", path)
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


def write_csv(path, rows):
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=seed.FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def row(**overrides):
    value = dict.fromkeys(seed.FIELDS, "")
    value.update({
        "Date": "01/01/26", "Action": "Buy", "Platform": "Broker",
        "Type": "Shares", "Ticker": "ABC", "Name": "Acme",
        "Quantity": "1,5", "Total Cost": "-100",
    })
    value.update(overrides)
    return value


class PortfolioSeedTests(unittest.TestCase):
    def test_seed_preserves_duplicate_and_invalid_quantities_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transactions.csv"
            write_csv(path, [
                row(), row(),
                row(Platform="Other", Quantity="not available"),
                row(Ticker="CLOSED", Action="Sell", Quantity="1"),
                row(Ticker="LENDER", Type="Crowdlending", Quantity=""),
            ])
            sql, rows, items = seed.build_seed(path)
            self.assertEqual((rows, items), (5, 4))
            self.assertEqual(seed.build_seed(path)[0], sql)
            self.assertEqual(sql.count("INSERT INTO public.portfolio_transactions"), 5)
            self.assertIn("'not available'", sql)
            self.assertIn("'ABC', 'Broker', 'Acme', 'Shares', true", sql)
            self.assertIn("'ABC', 'Other', 'Acme', 'Shares', false", sql)
            self.assertIn("'CLOSED', 'Broker', 'Acme', 'Shares', false", sql)
            self.assertIn("'LENDER', 'Broker', 'Acme', 'Crowdlending', true", sql)
            transaction_ids = [line.split("VALUES ('", 1)[1][:36] for line in sql.splitlines()
                               if line.startswith("INSERT INTO public.portfolio_transactions")]
            self.assertEqual(len(set(transaction_ids)), 5)

    def test_seed_rejects_empty_and_malformed_cash(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transactions.csv"
            write_csv(path, [])
            with self.assertRaisesRegex(ValueError, "no transactions"):
                seed.build_seed(path)
            write_csv(path, [row(**{"Total Cost": "invalid"})])
            with self.assertRaisesRegex(ValueError, "CSV line 2"):
                seed.build_seed(path)
