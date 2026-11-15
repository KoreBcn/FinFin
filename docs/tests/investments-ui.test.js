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
        this.listeners = {};
        this.text = '';
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    reset() {}
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
    assert.match(cell('Name / ticker').textContent, /NOVO-B:XCSE · NOVO\.B\|XCSE/);
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
            type: 'Shares', market_symbol: null, is_in_scope: true, current_value_dkk: 180 }],
        transactions: [{ id: 'tx-1', portfolio_item_id: 'item-1', action: 'Buy',
            quantity: '2', fees: '', total_cost: '-100' }],
        failLoad: false, failSave: false, marketError: null, historyError: null, marketRequests: []
    };
    ['investmentTicker', 'investmentName', 'investmentType', 'investmentPlatform', 'investmentMarketSymbol']
        .forEach(id => document.getElementById(id));
    const supabaseClient = {
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
            let operation = 'read', payload, id;
            return {
                select() { return this; },
                order() { return this; },
                range() {
                    if (database.failLoad) return Promise.resolve({ error: { message: 'load failed' } });
                    return Promise.resolve({ data: table === 'portfolio_items' ? database.items : database.transactions, error: null });
                },
                insert(value) { operation = 'insert'; payload = value; return this; },
                update(value) { operation = 'update'; payload = value; return this; },
                eq(_column, value) { id = value; return this; },
                single() {
                    if (database.failSave) return Promise.resolve({ error: { message: 'save failed' } });
                    if (operation === 'insert') {
                        const item = { id: 'item-2', is_in_scope: true, current_value_dkk: null, ...payload };
                        database.items.push(item);
                        return Promise.resolve({ data: item, error: null });
                    }
                    Object.assign(database.items.find(item => item.id === id), payload);
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
    elements.get('investmentMarketSymbol').value = 'NEW|XNAS';
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

test('disables refresh for crowdlending and items without market symbols', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].type = 'Crowdlending';
    database.items.push({ id: 'item-2', ticker: 'UNKNOWN', platform: 'Broker', name: 'Unknown',
        type: 'Shares', market_symbol: null, is_in_scope: true, current_value_dkk: null });
    await vm.runInContext('openInvestments()', context);
    const buttons = elements.get('investmentTableBody').children.map(refreshButton);
    assert.equal(buttons[0].disabled, true);
    assert.match(buttons[0].title, /manually/);
    assert.equal(buttons[1].disabled, true);
    assert.match(buttons[1].title, /No verified market symbol/);
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
    database.marketError = 'Twelve Data is not configured in Supabase.';
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.match(elements.get('investmentTableBody').textContent, /not configured in Supabase/);
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
