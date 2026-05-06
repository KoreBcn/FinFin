import csv
import os
import uuid
from flask import Flask, jsonify, request, send_from_directory

DB_PATH    = os.path.join(os.path.dirname(__file__), 'db', 'db.csv')
WEBAPP_DIR = os.path.join(os.path.dirname(__file__), 'webapp')

FIELDS = [
    'id', 'Expense', 'Planned/Rea', 'Type',
    'Date', 'Month', 'Year', 'Amount',
    'Comments', 'Account', 'Excluded',
]

MONTH_NAMES = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]

app = Flask(__name__, static_folder=WEBAPP_DIR, static_url_path='')


# ── helpers ──────────────────────────────────────────────────────────────────

def read_db():
    if not os.path.exists(DB_PATH):
        return []
    with open(DB_PATH, newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    changed = False
    for row in rows:
        if not row.get('id'):
            row['id'] = str(uuid.uuid4())
            changed = True
    if changed:
        write_db(rows)
    return rows


def write_db(rows):
    with open(DB_PATH, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)


def sanitise(row: dict) -> dict:
    """Keep only known fields; ensure id is present."""
    clean = {k: str(row.get(k, '') or '') for k in FIELDS}
    if not clean['id']:
        clean['id'] = str(uuid.uuid4())
    return clean


# ── static ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(WEBAPP_DIR, 'index.html')


# ── API ───────────────────────────────────────────────────────────────────────

@app.route('/api/transactions', methods=['GET'])
def get_transactions():
    return jsonify(read_db())


@app.route('/api/transactions', methods=['POST'])
def add_transaction():
    data = sanitise(request.get_json(force=True))
    rows = read_db()
    rows.append(data)
    write_db(rows)
    return jsonify(data), 201


@app.route('/api/transactions/<tx_id>', methods=['PUT'])
def update_transaction(tx_id):
    data = sanitise(request.get_json(force=True))
    data['id'] = tx_id
    rows = read_db()
    for i, row in enumerate(rows):
        if row.get('id') == tx_id:
            rows[i] = data
            write_db(rows)
            return jsonify(data)
    return jsonify({'error': 'Not found'}), 404


@app.route('/api/transactions/<tx_id>', methods=['DELETE'])
def delete_transaction(tx_id):
    rows = read_db()
    new_rows = [r for r in rows if r.get('id') != tx_id]
    if len(new_rows) == len(rows):
        return jsonify({'error': 'Not found'}), 404
    write_db(new_rows)
    return '', 204


if __name__ == '__main__':
    app.run(debug=True, port=5000)
