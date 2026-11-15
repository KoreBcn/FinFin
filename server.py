import csv
import json
import os
import re
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen
from flask import Flask, jsonify, request, send_from_directory

DB_PATH    = os.path.join(os.path.dirname(__file__), 'db', 'db.csv')
WEBAPP_DIR = os.path.join(os.path.dirname(__file__), 'docs')
TWELVE_DATA_KEY_PATH = os.path.join(os.path.dirname(__file__), 'twelve_data_api_key.csv')
HOUSE_CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'house-config.json')

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


def is_local_request():
    host = urlsplit(request.host_url).hostname
    return (request.remote_addr in ('127.0.0.1', '::1')
            and host in ('localhost', '127.0.0.1', '::1')
            and request.headers.get('Origin', '') == request.host_url.rstrip('/'))


# ── static ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(WEBAPP_DIR, 'index.html')


# ── API ───────────────────────────────────────────────────────────────────────

@app.route('/api/investments/market-data', methods=['POST'])
def investment_market_data():
    if not is_local_request():
        return jsonify({'error': 'Market data is available only from the local application.'}), 403

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Expected a JSON market data request.'}), 400
    path = data.get('path')
    params = data.get('params')
    if path not in ('quote', 'exchange_rate', 'time_series') or not isinstance(params, dict):
        return jsonify({'error': 'Invalid market data request.'}), 400
    allowed = {'symbol', 'mic_code'}
    if path == 'time_series':
        allowed |= {'interval', 'outputsize'}
    symbol = params.get('symbol')
    mic = params.get('mic_code')
    if (set(params) - allowed or not isinstance(symbol, str)
            or not re.fullmatch(r'[A-Za-z0-9./-]{1,40}', symbol)
            or (mic is not None and (not isinstance(mic, str) or not re.fullmatch(r'[A-Za-z0-9]{4}', mic)))
            or (path == 'time_series' and (params.get('interval') != '1day' or params.get('outputsize') != '140'))):
        return jsonify({'error': 'Invalid market data parameters.'}), 400

    try:
        with open(TWELVE_DATA_KEY_PATH, newline='', encoding='utf-8-sig') as key_file:
            rows = list(csv.reader(key_file))
        if len(rows) != 1 or len(rows[0]) != 1 or not rows[0][0].strip():
            return jsonify({'error': 'The Twelve Data key CSV must contain one non-empty field.'}), 503
        key = rows[0][0].strip()
    except (OSError, UnicodeError, csv.Error):
        return jsonify({'error': 'Unable to read the Twelve Data key CSV on the local server.'}), 503

    url = f'https://api.twelvedata.com/{path}?{urlencode({**params, "apikey": key})}'
    try:
        with urlopen(url, timeout=15) as response:
            result = json.load(response)
    except HTTPError as error:
        return jsonify({'error': f'Twelve Data returned HTTP {error.code}.'}), 502
    except (URLError, TimeoutError, OSError, UnicodeError, ValueError):
        return jsonify({'error': 'Unable to retrieve valid data from Twelve Data.'}), 502
    if not isinstance(result, dict):
        return jsonify({'error': 'Twelve Data returned an invalid response.'}), 502
    if key in json.dumps(result, ensure_ascii=False):
        return jsonify({'error': 'Twelve Data returned an unsafe response.'}), 502
    if result.get('status') == 'error' or result.get('code'):
        code = result.get('code')
        detail = f' (code {code})' if isinstance(code, int) else ''
        return jsonify({'error': f'Twelve Data rejected the request{detail}; check the symbol, plan, and API limits.'}), 502
    if path == 'time_series':
        values = result.get('values')
        if not isinstance(values, list) or not all(isinstance(item, dict) for item in values):
            return jsonify({'error': 'Twelve Data returned invalid price history.'}), 502
        return jsonify({'values': [{'datetime': item.get('datetime'), 'close': item.get('close')} for item in values]})
    fields = ('rate',) if path == 'exchange_rate' else ('close', 'currency', 'datetime', 'last_quote_at', 'percent_change')
    return jsonify({field: result.get(field) for field in fields})


@app.route('/api/investments/house-config', methods=['POST'])
def investment_house_config():
    if not is_local_request():
        return jsonify({'error': 'House configuration is available only from the local application.'}), 403
    try:
        with open(HOUSE_CONFIG_PATH, encoding='utf-8-sig') as config_file:
            config = json.load(config_file)
    except (OSError, UnicodeError, ValueError):
        return jsonify({'error': 'Unable to read the local House configuration.'}), 503
    if not isinstance(config, dict):
        return jsonify({'error': 'The local House configuration must contain installment and interest concepts.'}), 503
    fields = ('installment_concept', 'interest_concept')
    if any(not isinstance(config.get(field), str) or not config[field].strip() for field in fields):
        return jsonify({'error': 'The local House configuration must contain installment and interest concepts.'}), 503
    concepts = {field: config[field].strip() for field in fields}
    if concepts['interest_concept'].casefold() in concepts['installment_concept'].casefold():
        return jsonify({'error': 'The installment and interest concepts must not overlap.'}), 503
    response = jsonify(concepts)
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/transactions', methods=['GET'])
def get_transactions():
    return jsonify(read_db())


@app.route('/api/transactions', methods=['POST'])
def add_transaction():
    data = sanitise(request.get_json(force=True))
    rows = read_db()
    after_id = request.args.get('after')
    if after_id:
        insert_at = next((i + 1 for i, row in enumerate(rows) if row.get('id') == after_id), None)
        if insert_at is None:
            return jsonify({'error': 'Transaction to duplicate not found'}), 404
        rows.insert(insert_at, data)
    else:
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
