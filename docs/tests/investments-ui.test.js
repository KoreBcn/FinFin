const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.dataset = {};
        this.attributes = {};
        this.classes = new Set();
        this.classList = { add: name => this.classes.add(name) };
        this.style = { setProperty(name, value) { this[name] = value; } };
        this.listeners = {};
        this.text = '';
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    reset() {}
    checkValidity() { return true; }
}

function find(element, predicate) {
    if (predicate(element)) return element;
    for (const child of element.children) {
        const result = find(child, predicate);
        if (result) return result;
    }
}

function refreshButton(row) {
    return find(row, element => element.className === 'investment-refresh');
}

test('renders compact positions, signed metrics and accessible details', () => {
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element('div'));
            return elements.get(id);
        },
        createElement: tag => new Element(tag)
    };
    const context = vm.createContext({ document, activeAuthUserId: null });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'investments.js'), 'utf8'), context);
    vm.runInContext(`
        investmentPositions = [{
            key: 'one', name: 'Example', ticker: 'CPH:NOVO-B', platform: 'Broker',
            type: 'Shares', quantity: 2.1234, bought: -200, sold: 0, fees: -5,
            dividends: 0, other: []
        }];
        investmentQuotes.set('one', {
            price: 120, currency: 'DKK', rate: 1, today: -2,
            changes: { 7: 2, 30: -3, 90: 0 }
        });
        renderInvestments();
    `, context);

    const row = elements.get('investmentTableBody').children[0];
    const cell = label => find(row, element => element.dataset.label === label);
    assert.equal(cell('Qty').textContent, '2.12');
    assert.match(cell('Name / ticker').textContent, /CPH:NOVO-B/);
    assert.equal(cell('Today %').classes.has('investment-negative'), true);
    assert.equal(cell('Net P/L DKK').classes.has('investment-positive'), true);
    assert.equal(cell('Return %').classes.has('investment-positive'), true);
    assert.equal(row.children.at(-2), cell('Return %'));
    assert.equal(row.children.at(-1).children[0], refreshButton(row));
    assert.equal(find(cell('Name / ticker'), element => element.className === 'investment-refresh'), undefined);
    assert.equal(refreshButton(row).attributes['aria-label'], 'Refresh price for Example');
    assert.equal(cell('Bought DKK'), undefined);
    const info = find(row, element => element.className?.split(' ').includes('investment-info-popup'));
    assert.match(info.textContent, /Platform: Broker/);
    assert.match(info.textContent, /Bought DKK: -200.00/);
    for (const [index, color] of [[1, 'investment-negative'], [2, 'investment-positive'],
        [3, 'investment-negative'], [4, 'investment-positive']]) {
        assert.equal(info.children[index].children[0].tag, 'strong');
        assert.equal(info.children[index].children[1].classes.has(color), true);
    }
    assert.equal(cell('Type').children[0].className, 'investment-type');
    const tooltip = find(row, element => element.attributes.role === 'tooltip');
    assert.match(tooltip.textContent, /7 days2.00%30 days-3.00%90 days0.00%/);
    assert.equal(tooltip.children[0].children[1].classes.has('investment-positive'), true);
    assert.equal(tooltip.children[1].children[1].classes.has('investment-negative'), true);
    assert.equal(tooltip.children[2].children[1].classes.size, 0);
});

function setupPortfolio(clock = null) {
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element('div'));
            return elements.get(id);
        },
        createElement: tag => new Element(tag)
    };
    const database = {
        items: [{ id: 'item-1', ticker: 'CPH:NOVO-B', platform: 'Broker', name: 'Example',
            type: 'Shares', market_symbol: null, is_in_scope: true, current_value_dkk: 180, valuation_version: 0 }],
        transactions: [{ id: 'tx-1', portfolio_item_id: 'item-1', action: 'Buy',
            quantity: '2', fees: '', total_cost: '-100' }],
        failLoad: false, failSave: false, marketError: null, historyError: null, marketRequests: []
    };
    ['investmentTicker', 'investmentName', 'investmentType', 'investmentPlatform']
        .forEach(id => document.getElementById(id));
    ['Item', 'Date', 'Action', 'Quantity', 'Price', 'Rate', 'Commission', 'Fees',
        'Currency', 'Total', 'LocalValue', 'LocalCurrency']
        .forEach(field => document.getElementById(`portfolioTransaction${field}`));
    const supabaseClient = {
        async rpc(name, { p_transaction: transaction }) {
            assert.equal(name, 'add_portfolio_transaction');
            if (database.waitTransaction) await database.waitTransaction;
            if (database.failTransaction) return { error: { message: 'transaction failed' } };
            const item = database.items.find(entry => entry.id === transaction.portfolio_item_id);
            database.transactions.push({ id: `tx-${database.transactions.length + 1}`, ...transaction,
                ticker: item.ticker, name: item.name, platform: item.platform, type: item.type });
            if (['buy', 'sell'].includes(transaction.action.toLowerCase()) && item.type.toLowerCase() !== 'crowdlending') {
                item.current_value_dkk = null;
            }
            item.valuation_version = (item.valuation_version || 0) + 1;
            if (database.failLoadAfterTransaction) database.failLoad = true;
            return { error: null };
        },
        functions: {
            async invoke(name, options) {
                assert.equal(name, 'market-data');
                assert.ok(options.signal instanceof AbortSignal);
                database.marketRequests.push(options.body);
                const message = database.marketError || (options.body.path === 'time_series' ? database.historyError : null);
                if (message) {
                    return { data: null, error: {
                        message: 'Edge Function returned an error',
                        context: { json: async () => ({ error: message }) }
                    } };
                }
                return {
                    data: options.body.path === 'quote'
                        ? { close: '100', currency: 'DKK', datetime: '2026-01-01' }
                        : { values: [] },
                    error: null
                };
            }
        },
        from(table) {
            let operation = 'read', payload, id, valuationVersion;
            return {
                select() { return this; },
                order() { return this; },
                range() {
                    if (database.failLoad) return Promise.resolve({ error: { message: 'load failed' } });
                    if (database.onRead) database.onRead(table);
                    return Promise.resolve({ data: (table === 'portfolio_items' ? database.items : database.transactions).map(row =>
                        table === 'portfolio_items' ? { valuation_version: 0, ...row } : { ...row }), error: null });
                },
                insert(value) { operation = 'insert'; payload = value; return this; },
                update(value) { operation = 'update'; payload = value; return this; },
                eq(column, value) { if (column === 'id') id = value; else if (column === 'valuation_version') valuationVersion = value; return this; },
                single() {
                    if (database.failSave) return Promise.resolve({ error: { message: 'save failed' } });
                    if (operation === 'insert') {
                        const item = { id: 'item-2', is_in_scope: true, current_value_dkk: null, valuation_version: 0, ...payload };
                        database.items.push(item);
                        return Promise.resolve({ data: item, error: null });
                    }
                    const item = database.items.find(entry => entry.id === id);
                    if (valuationVersion !== undefined && (item.valuation_version || 0) !== valuationVersion) {
                        return Promise.resolve({ error: { code: 'PGRST116', message: 'No rows' } });
                    }
                    Object.assign(item, payload);
                    return Promise.resolve({ data: { id }, error: null });
                }
            };
        }
    };
    class TestDate extends Date {
        static now() { return clock ? clock.now : Date.now(); }
    }
    const timer = (callback, delay) => {
        if (clock && delay > 0 && delay !== 20000) {
            clock.delays.push(delay);
            clock.now += delay;
        }
        return setTimeout(callback, delay === 20000 ? 1000 : 0);
    };
    const context = vm.createContext({
        document, activeAuthUserId: 'user', supabaseClient,
        localStorage: { getItem() { return null; }, setItem() {} },
        AbortController, Date: TestDate, setTimeout: timer, clearTimeout
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'investments.js'), 'utf8'), context);
    return { context, elements, database };
}

test('loads stored positions, adds an item with unknown quantity, and persists successful values', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentTableBody').children.length, 1);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180.00 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '80.00 DKK');
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, 200);
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '100.00 DKK');
    assert.equal(database.marketRequests[0].path, 'quote');
    elements.get('investmentTicker').value = 'NEW';
    elements.get('investmentName').value = 'New';
    elements.get('investmentType').value = 'Shares';
    elements.get('investmentPlatform').value = 'Broker';
    await elements.get('investmentForm').listeners.submit({ preventDefault() {}, currentTarget: elements.get('investmentForm') });
    const newRow = elements.get('investmentTableBody').children[1];
    assert.equal(find(newRow, e => e.dataset.label === 'Qty').textContent, '—');
    assert.equal(find(newRow, e => e.dataset.label === 'Current value DKK').textContent, '—');
    vm.runInContext('clearInvestments()', context);
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '200.00 DKK');
    assert.equal(elements.get('investmentTableBody').children.length, 2);
});

test('totals valued positions and explains excluded positions', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push(
        { id: 'item-2', ticker: 'SECOND', platform: 'Broker', name: 'Second',
            type: 'Shares', market_symbol: 'SECOND', is_in_scope: true, current_value_dkk: 100 },
        { id: 'unknown', ticker: 'UNKNOWN', platform: 'Broker', name: 'Unknown',
            type: 'Shares', market_symbol: 'UNKNOWN', is_in_scope: true, current_value_dkk: 500 },
        { id: 'excluded', ticker: 'EXCLUDED', platform: 'Broker', name: 'Excluded',
            type: 'Shares', market_symbol: 'EXCLUDED', is_in_scope: false, current_value_dkk: 1000 }
    );
    database.transactions.push(
        { id: 'buy', portfolio_item_id: 'item-2', action: 'Buy', quantity: '2', fees: '-5', total_cost: '-140' },
        { id: 'sell', portfolio_item_id: 'item-2', action: 'Sell', quantity: '1', fees: '', total_cost: '20' },
        { id: 'dividend', portfolio_item_id: 'item-2', action: 'Dividend', quantity: '', fees: '', total_cost: '3' }
    );
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '280.00 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '58.00 DKK');
    assert.match(elements.get('investmentPortfolioPnl').className, /investment-positive/);
    assert.equal(elements.get('investmentCoverage').textContent, '2 of 3 positions valued; totals exclude the remainder.');
});

test('scales allocation colors across valued positions and leaves unknown values uncolored', async () => {
    const { context, elements, database } = setupPortfolio();
    for (const [id, value] of [['low', 100], ['middle', 140], ['unknown', null]]) {
        database.items.push({ id, ticker: id, platform: 'Broker', name: id, type: 'Shares',
            market_symbol: null, is_in_scope: true, current_value_dkk: value });
        database.transactions.push({ id: `tx-${id}`, portfolio_item_id: id, action: 'Buy',
            quantity: '1', fees: '', total_cost: '-10' });
    }
    await vm.runInContext('openInvestments()', context);
    const cells = elements.get('investmentTableBody').children.map(row => find(row, e => e.dataset.label === 'Portfolio %'));
    assert.deepEqual(cells.map(cell => cell.style['--investment-heat']), ['0', '120', '60', undefined]);
    assert.deepEqual(cells.map(cell => cell.textContent), ['42.86%', '23.81%', '33.33%', '—']);
    database.items[0].current_value_dkk = 100;
    database.items[2].current_value_dkk = 100;
    vm.runInContext('investmentLoaded = false', context);
    await vm.runInContext('openInvestments()', context);
    const equalCells = elements.get('investmentTableBody').children.slice(0, 3)
        .map(row => find(row, e => e.dataset.label === 'Portfolio %'));
    assert.deepEqual(equalCells.map(cell => cell.style['--investment-heat']), ['60', '60', '60']);
});

test('sorts each portfolio column using its underlying values and keeps missing values last', async () => {
    const { context, elements } = setupPortfolio();
    vm.runInContext(`
        investmentPositions = [
            {key:'a', ticker:'A', name:'Zebra', type:'Shares', quantity:10, quantityUnknown:false, currentValue:1000, bought:-500, sold:0, fees:0, dividends:0, other:[]},
            {key:'b', ticker:'B', name:'Alpha', type:'ETF', quantity:2, quantityUnknown:false, currentValue:100, bought:-200, sold:0, fees:0, dividends:0, other:[]},
            {key:'c', ticker:'C', name:'Beta', type:'Crypto', quantity:5, quantityUnknown:false, currentValue:500, bought:-1000, sold:0, fees:0, dividends:0, other:[]},
            {key:'d', ticker:'D', name:'Delta', type:'Fund', quantity:0, quantityUnknown:true, currentValue:null, bought:0, sold:0, fees:0, dividends:0, other:[]}
        ];
        investmentQuotes.set('a', {price:9, currency:'DKK', today:5});
        investmentQuotes.set('b', {price:100, currency:'USD', today:-4});
        investmentQuotes.set('c', {price:20, currency:'EUR', today:1});
        renderInvestments();
    `, context);
    const order = () => elements.get('investmentTableBody').children.map(row =>
        find(row, e => e.dataset.label === 'Name / ticker').children[0].children[0].textContent);
    for (const [key, expected] of [
        ['name', ['Alpha', 'Beta', 'Delta', 'Zebra']],
        ['type', ['Beta', 'Alpha', 'Delta', 'Zebra']],
        ['qty', ['Alpha', 'Beta', 'Zebra', 'Delta']],
        ['price', ['Zebra', 'Beta', 'Alpha', 'Delta']],
        ['value', ['Alpha', 'Beta', 'Zebra', 'Delta']],
        ['portfolio', ['Alpha', 'Beta', 'Zebra', 'Delta']],
        ['today', ['Alpha', 'Beta', 'Zebra', 'Delta']],
        ['pnl', ['Beta', 'Alpha', 'Zebra', 'Delta']],
        ['return', ['Alpha', 'Beta', 'Zebra', 'Delta']]
    ]) {
        vm.runInContext(`sortInvestments('${key}')`, context);
        assert.deepEqual(order(), expected, key);
        assert.equal(elements.get(`investment-sort-${key}`).attributes['aria-sort'], 'ascending');
    }
    vm.runInContext(`sortInvestments('value'); sortInvestments('value')`, context);
    assert.deepEqual(order(), ['Zebra', 'Beta', 'Alpha', 'Delta']);
    assert.equal(elements.get('investment-sort-value').attributes['aria-sort'], 'descending');
    assert.equal(elements.get('investment-sort-return').attributes['aria-sort'], undefined);
    vm.runInContext('investmentPositions[1].currentValue = 2000; renderInvestments()', context);
    assert.deepEqual(order(), ['Alpha', 'Zebra', 'Beta', 'Delta']);
});

test('mobile sorting controls select, reverse, and reset the order', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push({ id: 'item-2', ticker: 'AAPL', platform: 'Broker', name: 'Alpha',
        type: 'Shares', is_in_scope: true, current_value_dkk: null });
    await vm.runInContext('openInvestments()', context);
    const field = elements.get('investmentSortField');
    const direction = elements.get('investmentSortDirection');
    const order = () => elements.get('investmentTableBody').children.map(row =>
        find(row, e => e.dataset.label === 'Name / ticker').children[0].children[0].textContent);
    field.value = 'name';
    field.listeners.change({ currentTarget: field });
    assert.deepEqual(order(), ['Alpha', 'Example']);
    assert.equal(direction.disabled, false);
    direction.listeners.click();
    assert.deepEqual(order(), ['Example', 'Alpha']);
    assert.match(direction.textContent, /Descending/);
    field.value = '';
    field.listeners.change({ currentTarget: field });
    assert.deepEqual(order(), ['Example', 'Alpha']);
    assert.equal(direction.disabled, true);
});

test('distinguishes no valuations from zero values and negative PnL', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].current_value_dkk = null;
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '—');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '—');
    assert.match(elements.get('investmentCoverage').textContent, /0 of 1 positions valued/);

    vm.runInContext('investmentPositions[0].currentValue = 0; renderInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '0.00 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '-100.00 DKK');
    assert.match(elements.get('investmentPortfolioPnl').className, /investment-negative/);
    assert.equal(elements.get('investmentCoverage').textContent, '');
    vm.runInContext('clearInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '—');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '—');
    assert.equal(elements.get('investmentCoverage').textContent, '');
});

test('refreshes only the selected item and paces requests across items', async () => {
    const clock = { now: 10000, delays: [] };
    const { context, elements, database } = setupPortfolio(clock);
    database.items.push({ id: 'item-2', ticker: 'SECOND', platform: 'Broker', name: 'Second',
        type: 'Shares', market_symbol: 'SECOND', is_in_scope: true, current_value_dkk: 80 });
    database.transactions.push({ id: 'tx-2', portfolio_item_id: 'item-2', action: 'Buy',
        quantity: '3', fees: '', total_cost: '-90' });
    await vm.runInContext('openInvestments()', context);
    await refreshButton(elements.get('investmentTableBody').children[1]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.equal(database.items[1].current_value_dkk, 300);
    assert.deepEqual(database.marketRequests.map(request => request.params.symbol), ['SECOND', 'SECOND']);
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.deepEqual(clock.delays, [8000, 8000, 8000]);
    assert.equal(elements.get('investmentStatus').textContent, '');
});

test('disables refresh for crowdlending but allows any stored ticker', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].type = 'Crowdlending';
    database.items.push({ id: 'item-2', ticker: 'UNKNOWN', platform: 'Broker', name: 'Unknown',
        type: 'Shares', market_symbol: null, is_in_scope: true, current_value_dkk: null });
    await vm.runInContext('openInvestments()', context);
    const buttons = elements.get('investmentTableBody').children.map(refreshButton);
    assert.equal(buttons[0].disabled, true);
    assert.match(buttons[0].title, /manually/);
    assert.equal(buttons[1].disabled, false);
});

test('requests the stored ticker unchanged, ignoring any saved market symbol', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].ticker = 'MELI|XNGS';
    database.items[0].market_symbol = 'OTHER';
    await vm.runInContext('openInvestments()', context);
    const row = elements.get('investmentTableBody').children[0];
    assert.equal(refreshButton(row).disabled, false);
    await refreshButton(row).listeners.click();
    assert.equal(database.marketRequests[0].params.symbol, 'MELI|XNGS');
    assert.equal(database.marketRequests[1].params.symbol, 'MELI|XNGS');
});

test('reports load and valuation-save failures without losing the saved value', async () => {
    const { context, elements, database } = setupPortfolio();
    database.failLoad = true;
    await vm.runInContext('openInvestments()', context);
    assert.match(elements.get('investmentStatus').textContent, /load failed/);
    assert.equal(elements.get('investmentRetry').hidden, false);
    database.failLoad = false;
    await elements.get('investmentRetry').listeners.click();
    database.failSave = true;
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.match(elements.get('investmentTableBody').textContent, /save failed/);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180.00 DKK');
});

test('shows Edge Function errors and retains the saved valuation', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    database.marketError = 'Yahoo Finance returned HTTP 429.';
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.match(elements.get('investmentTableBody').textContent, /Yahoo Finance returned HTTP 429/);
});

test('keeps the refreshed value when only price history fails', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    database.historyError = 'History unavailable.';
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, 200);
    assert.match(elements.get('investmentTableBody').textContent, /History: History unavailable/);
});

test('hides a stale saved value when a trade quantity becomes invalid', async () => {
    const { context, elements, database } = setupPortfolio();
    database.transactions[0].quantity = 'invalid';
    await vm.runInContext('openInvestments()', context);
    const row = elements.get('investmentTableBody').children[0];
    assert.equal(find(row, e => e.dataset.label === 'Qty').textContent, '—');
    assert.equal(find(row, e => e.dataset.label === 'Current value DKK').textContent, '—');
    assert.match(row.textContent, /Review actions: invalid or missing trade quantity/);
});

test('saves a crowdlending value in Supabase', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].type = 'Crowdlending';
    await vm.runInContext('openInvestments()', context);
    const row = elements.get('investmentTableBody').children[0];
    const input = find(row, e => e.tag === 'input');
    input.value = '250';
    await input.listeners.change();
    assert.equal(database.items[0].current_value_dkk, 250);
    vm.runInContext('clearInvestments()', context);
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '250.00 DKK');
});

test('formats editable crowdlending values and validates grouped input without losing precision', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].type = 'Crowdlending';
    database.items[0].current_value_dkk = 1234567.12345;
    await vm.runInContext('openInvestments()', context);
    const input = () => find(elements.get('investmentTableBody').children[0], e => e.tag === 'input');
    assert.equal(input().value, '1,234,567.12345');
    input().listeners.focus();
    assert.equal(input().value, '1234567.12345');
    input().listeners.blur();
    assert.equal(input().value, '1,234,567.12345');

    input().value = '2,345.6789';
    await input().listeners.change();
    assert.equal(database.items[0].current_value_dkk, 2345.6789);
    assert.equal(input().value, '2,345.6789');
    input().value = '1,2';
    await input().listeners.change();
    assert.equal(database.items[0].current_value_dkk, 2345.6789);
    assert.match(elements.get('investmentStatus').textContent, /non-negative numbers/);
    input().value = '';
    await input().listeners.change();
    assert.equal(database.items[0].current_value_dkk, null);
    assert.equal(elements.get('investmentStatus').textContent, '');
});

function fillPortfolioTransaction(elements, values = {}) {
    const defaults = {
        Item: 'item-1', Date: '2026-03-01', Action: 'Buy', Quantity: '1',
        Price: '', Rate: '', Commission: '', Fees: '-2', Currency: 'DKK',
        Total: '-100', LocalValue: '', LocalCurrency: ''
    };
    for (const [field, value] of Object.entries({ ...defaults, ...values })) {
        elements.get(`portfolioTransaction${field}`).value = value;
    }
}

function submitPortfolioTransaction(elements) {
    const form = elements.get('portfolioTransactionForm');
    return form.listeners.submit({ preventDefault() {}, currentTarget: form });
}

test('switches views and searches and pages all transactions, including out-of-scope items', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push({ id: 'outside', ticker: 'OTHER', platform: 'Broker', name: 'Outside', type: 'Shares',
        is_in_scope: false, current_value_dkk: null });
    for (let i = 0; i < 12; i++) {
        database.transactions.push({ id: `other-${i}`, portfolio_item_id: 'outside', ticker: 'OTHER',
            transaction_date: `2026-01-${String(i + 1).padStart(2, '0')}`, action: 'Buy', quantity: '1', fees: '', total_cost: '-5' });
    }
    await vm.runInContext('openInvestments()', context);
    elements.get('portfolioViewToggle').listeners.click();
    assert.equal(elements.get('portfolioOverview').hidden, true);
    assert.equal(elements.get('portfolioTransactions').hidden, false);
    assert.equal(elements.get('portfolioTransactionBody').children.length, 10);
    assert.equal(elements.get('portfolioTransactionPage').textContent, 'Page 1 of 2');
    elements.get('portfolioTransactionNext').listeners.click();
    assert.equal(elements.get('portfolioTransactionBody').children.length, 3);
    elements.get('portfolioTransactionSearch').value = 'oth';
    elements.get('portfolioTransactionSearch').listeners.input();
    assert.equal(elements.get('portfolioTransactionPage').textContent, 'Page 1 of 2');
    assert.match(elements.get('portfolioTransactionStatus').textContent, /12 transactions matching ticker/);
    elements.get('portfolioTransactionAdd').listeners.click();
    assert.match(elements.get('portfolioTransactionItem').textContent, /OTHER.*out of scope/);
    elements.get('portfolioViewToggle').listeners.click();
    assert.equal(elements.get('portfolioOverview').hidden, false);
});

test('validates and saves a buy, reloads the overview, and retains crowdlending valuations', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push({ id: 'crowd', ticker: 'CROWD', platform: 'Broker', name: 'Crowd', type: 'Crowdlending',
        is_in_scope: true, current_value_dkk: 500, valuation_version: 0 });
    await vm.runInContext('openInvestments()', context);
    fillPortfolioTransaction(elements, { Quantity: '-1' });
    await submitPortfolioTransaction(elements);
    assert.match(elements.get('portfolioTransactionFormStatus').textContent, /non-negative/);
    assert.equal(database.transactions.length, 1);
    fillPortfolioTransaction(elements, { Total: '' });
    await submitPortfolioTransaction(elements);
    assert.match(elements.get('portfolioTransactionFormStatus').textContent, /Total cost is required/);
    fillPortfolioTransaction(elements, { Quantity: 'oops' });
    await submitPortfolioTransaction(elements);
    assert.match(elements.get('portfolioTransactionFormStatus').textContent, /Invalid quantity/);
    fillPortfolioTransaction(elements, { Quantity: '1,5' });
    await submitPortfolioTransaction(elements);
    assert.equal(database.items[0].current_value_dkk, null);
    assert.equal(database.items[0].valuation_version, 1);
    assert.equal(database.transactions[1].ticker, 'CPH:NOVO-B');
    assert.equal(find(elements.get('investmentTableBody').children[0], e => e.dataset.label === 'Qty').textContent, '3.50');
    assert.equal(elements.get('investmentPortfolioSize').textContent, '500.00 DKK');
    fillPortfolioTransaction(elements, { Item: 'crowd', Action: 'Sell' });
    await submitPortfolioTransaction(elements);
    assert.equal(database.items[1].current_value_dkk, 500);
});

test('blocks a stale price save after another client adds a trade', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    database.items[0].valuation_version = 1;
    database.items[0].current_value_dkk = null;
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, null);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '—');
    assert.match(elements.get('investmentTableBody').textContent, /portfolio changed/);
    assert.equal(elements.get('investmentRetry').hidden, false);
});

test('retries loading when a trade is inserted between item and transaction reads', async () => {
    const { context, elements, database } = setupPortfolio();
    let injected = false;
    database.onRead = table => {
        if (table !== 'portfolio_transactions' || injected) return;
        injected = true;
        database.items[0].current_value_dkk = null;
        database.items[0].valuation_version = 1;
        database.transactions.push({ id: 'new-trade', portfolio_item_id: 'item-1', action: 'Buy',
            quantity: '1', fees: '', total_cost: '-50' });
    };
    await vm.runInContext('openInvestments()', context);
    const row = elements.get('investmentTableBody').children[0];
    assert.equal(find(row, e => e.dataset.label === 'Qty').textContent, '3.00');
    assert.equal(find(row, e => e.dataset.label === 'Current value DKK').textContent, '—');
    await refreshButton(row).listeners.click();
    assert.equal(database.items[0].current_value_dkk, 300);
});

test('requires a reload after an uncertain transaction save', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    fillPortfolioTransaction(elements);
    database.failTransaction = true;
    await submitPortfolioTransaction(elements);
    assert.match(elements.get('portfolioTransactionFormStatus').textContent, /save may have completed/);
    assert.equal(elements.get('investmentRetry').hidden, false);
    assert.equal(elements.get('investmentTableBody').children.length, 0);
    database.failTransaction = false;
    await elements.get('investmentRetry').listeners.click();
    assert.equal(elements.get('investmentTableBody').children.length, 1);
});

test('does not show stale valuations if reloading after a successful transaction fails', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    fillPortfolioTransaction(elements);
    database.failLoadAfterTransaction = true;
    await submitPortfolioTransaction(elements);
    assert.equal(database.items[0].current_value_dkk, null);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '—');
    assert.match(elements.get('investmentStatus').textContent, /load failed/);
    assert.equal(elements.get('investmentRetry').hidden, false);
});

test('ignores a transaction response after sign-out', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    elements.get('portfolioTransactionAdd').listeners.click();
    fillPortfolioTransaction(elements);
    let resolve;
    database.waitTransaction = new Promise(done => { resolve = done; });
    const pending = submitPortfolioTransaction(elements);
    vm.runInContext('activeAuthUserId = null; clearInvestments()', context);
    resolve();
    await pending;
    assert.equal(elements.get('investmentTableBody').children.length, 0);
    assert.equal(elements.get('portfolioTransactionBody').children.length, 0);
    assert.equal(elements.get('portfolioTransactionDialog').open, false);
});
