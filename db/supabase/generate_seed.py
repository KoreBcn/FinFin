import csv
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
import uuid


ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "db" / "db.csv"
OUTPUT_PATH = Path(__file__).resolve().parent / "seed.sql"
ID_NAMESPACE = uuid.UUID("64d6032c-a51d-4c28-9a7f-dbb51777edc4")
REQUIRED_FIELDS = {
    "id",
    "Expense",
    "Planned/Rea",
    "Type",
    "Date",
    "Amount",
    "Comments",
    "Account",
    "Excluded",
}


def parse_date(value: str, line_number: int) -> str:
    for date_format in ("%d/%m/%y", "%d/%m/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value, date_format).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"CSV line {line_number}: unsupported date {value!r}")


def parse_amount(value: str, line_number: int) -> str:
    try:
        amount = Decimal(value.replace(",", "").strip())
    except InvalidOperation as error:
        raise ValueError(f"CSV line {line_number}: invalid amount {value!r}") from error
    if not amount.is_finite():
        raise ValueError(f"CSV line {line_number}: amount must be finite")
    return format(amount, "f")


def sql_text(value: str | None) -> str:
    if value is None or value == "":
        return "null"
    return "'" + value.replace("'", "''") + "'"


def transaction_id(value: str, line_number: int, seen: set[str]) -> tuple[str, bool]:
    try:
        parsed_id = uuid.UUID(value)
        if str(parsed_id) == value.lower() and str(parsed_id) not in seen:
            return str(parsed_id), False
    except ValueError:
        pass

    salt = 0
    while True:
        seed = f"db.csv:{line_number}:{value}:{salt}"
        replacement = str(uuid.uuid5(ID_NAMESPACE, seed))
        if replacement not in seen:
            return replacement, True
        salt += 1


def main() -> None:
    with CSV_PATH.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        missing_fields = REQUIRED_FIELDS.difference(reader.fieldnames or [])
        if missing_fields:
            raise ValueError(f"CSV is missing required columns: {', '.join(sorted(missing_fields))}")

        rows = []
        seen_ids = set()
        rewritten_ids = 0
        for line_number, row in enumerate(reader, start=2):
            tx_id, was_rewritten = transaction_id(row["id"].strip(), line_number, seen_ids)
            seen_ids.add(tx_id)
            rewritten_ids += was_rewritten

            excluded = row["Excluded"].strip().lower()
            if excluded not in {"true", "false"}:
                raise ValueError(f"CSV line {line_number}: invalid Excluded value {row['Excluded']!r}")

            rows.append(
                (
                    sql_text(tx_id),
                    sql_text(row["Expense"]),
                    sql_text(row["Planned/Rea"]),
                    sql_text(row["Type"]),
                    sql_text(parse_date(row["Date"].strip(), line_number)),
                    parse_amount(row["Amount"], line_number),
                    sql_text(row["Comments"]),
                    sql_text(row["Account"]),
                    excluded,
                )
            )

    columns = (
        "id, expense, transaction_status, category, transaction_date, "
        "amount, comments, account, is_excluded"
    )
    statements = [
        "-- Generated from ../db.csv by generate_seed.py; do not edit by hand.",
        "begin;",
    ]
    batch_size = 250
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        statements.append(f"insert into public.transactions ({columns}) values")
        statements.append(
            ",\n".join("    (" + ", ".join(values) + ")" for values in batch)
        )
        statements.append(
            "on conflict (id) do update set "
            "expense = excluded.expense, "
            "transaction_status = excluded.transaction_status, "
            "category = excluded.category, "
            "transaction_date = excluded.transaction_date, "
            "amount = excluded.amount, "
            "comments = excluded.comments, "
            "account = excluded.account, "
            "is_excluded = excluded.is_excluded;"
        )
    statements.append("commit;")
    OUTPUT_PATH.write_text("\n".join(statements) + "\n", encoding="utf-8")
    print(f"Wrote {len(rows)} transactions to {OUTPUT_PATH}")
    print(f"Replaced {rewritten_ids} invalid or duplicate source IDs with stable UUIDs")


if __name__ == "__main__":
    main()
