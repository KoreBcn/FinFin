import argparse
import csv
import json
import re
import uuid
from collections import Counter
from datetime import datetime
from decimal import Decimal
from pathlib import Path


NAMESPACE = uuid.UUID("65403a57-118e-40e3-9eb3-52b440039997")
FIELDS = [
    "Date", "Action", "Platform", "Type", "Ticker", "Name", "Quantity",
    "Price (per unit)", "Ex Rate", "Commision", "Fees", "Currency",
    "Total Cost", "Local Value", "Local Curr",
]


def number(value: str) -> Decimal:
    value = value.strip()
    if not value:
        raise ValueError("Missing number")
    normalized = value.replace(".", "").replace(",", ".") if "," in value else value
    if not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", normalized):
        raise ValueError("Invalid number")
    return Decimal(normalized)


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_seed(csv_path: Path) -> tuple[str, int, int]:
    with csv_path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != FIELDS:
            raise ValueError("CSV headers do not match the expected investment transaction format.")
        rows = []
        groups = {}
        occurrences = Counter()
        for line, raw in enumerate(reader, 2):
            if None in raw or any(value is None for value in raw.values()):
                raise ValueError(f"CSV line {line}: incorrect number of fields.")
            row = {field: raw[field].strip() for field in FIELDS}
            if not row["Ticker"] or not row["Platform"] or not row["Name"] or not row["Type"]:
                raise ValueError(f"CSV line {line}: ticker, platform, name and type are required.")
            try:
                date = datetime.strptime(row["Date"], "%d/%m/%y").date()
                for field in ("Fees", "Total Cost"):
                    if row[field]:
                        number(row[field])
                if row["Action"].lower() in {"buy", "sell", "dividend", "dividend tax"} and not row["Total Cost"]:
                    raise ValueError("Missing Total Cost")
            except ValueError as error:
                raise ValueError(f"CSV line {line}: {error}") from error
            key = (row["Ticker"], row["Platform"])
            group = groups.setdefault(key, {"row": row, "date": date, "quantity": Decimal(0), "unknown": False})
            if date > group["date"]:
                group["row"], group["date"] = row, date
            if row["Action"].lower() in {"buy", "sell"}:
                try:
                    quantity = number(row["Quantity"])
                    if quantity < 0:
                        raise ValueError("Negative quantity")
                    group["quantity"] += quantity if row["Action"].lower() == "buy" else -quantity
                except ValueError:
                    group["unknown"] = True
            fingerprint = json.dumps([row[field] for field in FIELDS], ensure_ascii=False, separators=(",", ":"))
            occurrences[fingerprint] += 1
            row_id = uuid.uuid5(NAMESPACE, f"{fingerprint}:{occurrences[fingerprint]}")
            rows.append((row_id, row, date))

    if not rows:
        raise ValueError("The investment CSV contains no transactions.")

    statements = ["-- Generated locally; contains private financial data.", "BEGIN;"]
    for (ticker, platform), group in groups.items():
        row = group["row"]
        is_closed = not (row["Type"].lower() == "crowdlending" or (
            not group["unknown"] and group["quantity"] > 0
        ))
        values = [ticker, platform, row["Name"], row["Type"]]
        statements.append(
            "INSERT INTO public.portfolio_items (ticker, platform, name, type, is_closed) VALUES ("
            + ", ".join(map(sql_text, values)) + f", {str(is_closed).lower()}) "
            + "ON CONFLICT (ticker, platform) DO NOTHING;"
        )
    columns = (
        "id, portfolio_item_id, transaction_date, action, platform, type, ticker, name, quantity, "
        "price_per_unit, exchange_rate, commission, fees, currency, total_cost, local_value, local_currency"
    )
    for row_id, row, date in rows:
        item = ("(SELECT id FROM public.portfolio_items WHERE ticker = "
                + sql_text(row["Ticker"]) + " AND platform = " + sql_text(row["Platform"]) + ")")
        values = [sql_text(str(row_id)), item, sql_text(date.isoformat())]
        values.extend(sql_text(row[field]) for field in FIELDS[1:])
        statements.append(f"INSERT INTO public.portfolio_transactions ({columns}) VALUES ("
                          + ", ".join(values) + ") ON CONFLICT (id) DO NOTHING;")
    statements.append("COMMIT;")
    return "\n".join(statements) + "\n", len(rows), len(groups)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a private, repeatable portfolio SQL seed.")
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("output_path", type=Path)
    args = parser.parse_args()
    seed, row_count, item_count = build_seed(args.csv_path)
    if args.output_path.exists():
        raise FileExistsError("Output already exists; choose a new path.")
    args.output_path.write_text(seed, encoding="utf-8")
    print(f"Generated {row_count} transactions and {item_count} portfolio items.")


if __name__ == "__main__":
    main()
