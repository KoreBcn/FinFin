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
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'date-utils.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'investment-math.js'), 'utf8'), context);
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
    assert.equal(row.children.at(-1).children[1], refreshButton(row));
    assert.equal(row.children.at(-1).children[0].attributes['aria-label'], 'Edit Example');
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
            type: 'Shares', market_symbol: null, is_closed: false, is_in_scope: true, current_value_dkk: 180, valuation_version: 0 }],
        transactions: [{ id: 'tx-1', portfolio_item_id: 'item-1', action: 'Buy',
            quantity: '2', fees: '', total_cost: '-100' }],
        failLoad: false, failSave: false, marketError: null, historyError: null, marketRequests: []
    };
    ['investmentTicker', 'investmentName', 'investmentType', 'investmentPlatform', 'investmentInScope']
        .forEach(id => document.getElementById(id));
    ['Item', 'Date', 'Action', 'Quantity', 'Price', 'Rate', 'Commission', 'Fees',
        'Currency', 'Total', 'LocalValue', 'LocalCurrency']
        .forEach(field => document.getElementById(`portfolioTransaction${field}`));
    const supabaseClient = {
        async rpc(name, args) {
            if (database.waitTransaction) await database.waitTransaction;
            if (database.transactionError) return { error: database.transactionError };
            if (database.failTransaction) return { error: { message: 'transaction failed' } };
            const transaction = args.p_transaction;
            const old = database.transactions.find(row => row.id === args.p_id);
            if (name !== 'add_portfolio_transaction' && (!old || (old.revision || 0) !== args.p_expected_revision)) {
                return { error: { message: 'Transaction changed or was deleted; reload the portfolio' } };
            }
            const touch = (row, other = null) => {
                const item = database.items.find(entry => entry.id === row.portfolio_item_id);
                if ((['buy', 'sell'].includes(row.action.toLowerCase())
                    || (other && other.portfolio_item_id === row.portfolio_item_id && ['buy', 'sell'].includes(other.action.toLowerCase())))
                    && item.type.toLowerCase() !== 'crowdlending') item.current_value_dkk = null;
                item.valuation_version = (item.valuation_version || 0) + 1;
            };
            if (name === 'delete_portfolio_transaction') {
                touch(old);
                database.transactions.splice(database.transactions.indexOf(old), 1);
                return { error: null };
            }
            if (name === 'duplicate_portfolio_transaction') {
                const copy = { ...old, id: `tx-${database.transactions.length + 1}`, revision: 0 };
                database.transactions.push(copy);
                touch(copy);
                return { error: null };
            }
            const item = database.items.find(entry => entry.id === transaction.portfolio_item_id);
            if (name === 'save_portfolio_transaction') {
                const updated = { ...old, ...transaction, revision: (old.revision || 0) + 1 };
                if (old.portfolio_item_id !== item.id) Object.assign(updated, { ticker: item.ticker, name: item.name, platform: item.platform, type: item.type });
                touch(old, updated);
                if (old.portfolio_item_id !== item.id) touch(updated);
                Object.assign(old, updated);
            } else {
                assert.equal(name, 'add_portfolio_transaction');
                const inserted = { id: `tx-${database.transactions.length + 1}`, revision: 0, ...transaction,
                    ticker: item.ticker, name: item.name, platform: item.platform, type: item.type };
                database.transactions.push(inserted);
                touch(inserted);
            }
            if (database.failLoadAfterTransaction) database.failLoad = true;
            return { error: null };
        },
        functions: {
            async invoke(name, options) {
                assert.equal(name, 'market-data');
                assert.ok(options.signal instanceof AbortSignal);
                database.marketRequests.push(options.body);
                const message = database.marketError || (options.body.path === 'time_series' ? database.historyError : null)
                    || (options.body.path === 'exchange_rate' ? database.exchangeError : null);
                if (message) {
                    return { data: null, error: {
                        message: 'Edge Function returned an error',
                        context: { json: async () => ({ error: message }) }
                    } };
                }
                return {
                    data: options.body.path === 'quote'
                        ? { close: '100', currency: database.quoteCurrency || 'DKK', last_quote_at: 1767268800 }
                        : options.body.path === 'exchange_rate' ? { rate: '7.5' } : { values: [] },
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
                    if (table === 'portfolio_pnl_history') {
                        if (database.historyLoadError) return Promise.resolve({ error: { message: 'history failed' } });
                        return Promise.resolve({ data: database.history || [], error: null });
                    }
                    return Promise.resolve({ data: (table === 'portfolio_items' ? database.items : database.transactions).map(row =>
                        table === 'portfolio_items' ? { valuation_version: 0, ...row } : { revision: 0, ...row }), error: null });
                },
                insert(value) { operation = 'insert'; payload = value; return this; },
                update(value) { operation = 'update'; payload = value; return this; },
                eq(column, value) { if (column === 'id') id = value; else if (column === 'valuation_version') valuationVersion = value; return this; },
                single() {
                    if (database.failSave) return Promise.resolve({ error: { message: 'save failed' } });
                    if (operation === 'insert') {
                        const item = { id: 'item-2', is_closed: false, is_in_scope: true, current_value_dkk: null, valuation_version: 0, ...payload };
                        database.items.push(item);
                        return Promise.resolve({ data: item, error: null });
                    }
                    const item = database.items.find(entry => entry.id === id);
                    if (valuationVersion !== undefined && (item.valuation_version || 0) !== valuationVersion) {
                        return Promise.resolve({ error: { code: 'PGRST116', message: 'No rows' } });
                    }
                    Object.assign(item, payload);
                    return Promise.resolve({ data: { valuation_version: 0, ...item }, error: null });
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
        AbortController, Date: TestDate, setTimeout: timer, clearTimeout, confirm: () => database.confirmDelete !== false
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'date-utils.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'investment-math.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'investments.js'), 'utf8'), context);
    return { context, elements, database };
}

test('loads stored positions, adds an item with unknown quantity, and persists successful values', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentTableBody').children.length, 1);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '80 DKK');
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, 200);
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '100 DKK');
    assert.equal(database.marketRequests[0].path, 'quote');
    elements.get('investmentTicker').value = 'NEW';
    elements.get('investmentName').value = 'New';
    elements.get('investmentType').value = 'Shares';
    elements.get('investmentPlatform').value = 'Broker';
    elements.get('investmentInScope').checked = false;
    await elements.get('investmentForm').listeners.submit({ preventDefault() {}, currentTarget: elements.get('investmentForm') });
    assert.equal(database.items[1].is_in_scope, false);
    const newRow = elements.get('investmentTableBody').children[1];
    assert.equal(find(newRow, e => e.dataset.label === 'Qty').textContent, '—');
    assert.equal(find(newRow, e => e.dataset.label === 'Current value DKK').textContent, '—');
    vm.runInContext('clearInvestments()', context);
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '200 DKK');
    assert.equal(elements.get('investmentTableBody').children.length, 2);
});

test('totals valued positions and explains excluded positions', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push(
        { id: 'item-2', ticker: 'SECOND', platform: 'Broker', name: 'Second',
            type: 'Shares', market_symbol: 'SECOND', is_closed: false, is_in_scope: true, current_value_dkk: 100 },
        { id: 'unknown', ticker: 'UNKNOWN', platform: 'Broker', name: 'Unknown',
            type: 'Shares', market_symbol: 'UNKNOWN', is_closed: false, is_in_scope: true, current_value_dkk: 500 },
        { id: 'excluded', ticker: 'EXCLUDED', platform: 'Broker', name: 'Excluded',
            type: 'Shares', market_symbol: 'EXCLUDED', is_closed: true, is_in_scope: true, current_value_dkk: 1000 }
    );
    database.transactions.push(
        { id: 'buy', portfolio_item_id: 'item-2', action: 'Buy', quantity: '2', fees: '-5', total_cost: '-140' },
        { id: 'sell', portfolio_item_id: 'item-2', action: 'Sell', quantity: '1', fees: '', total_cost: '20' },
        { id: 'dividend', portfolio_item_id: 'item-2', action: 'Dividend', quantity: '', fees: '', total_cost: '3' }
    );
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '280 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '58 DKK');
    assert.match(elements.get('investmentPortfolioPnl').className, /investment-positive/);
    assert.equal(elements.get('investmentCoverage').textContent, '2 of 3 open positions valued; totals exclude the remainder.');
});

test('rounds portfolio KPIs to whole kroner without changing position precision', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].current_value_dkk = 99.5;
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '100 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '-1 DKK');
    const row = elements.get('investmentTableBody').children[0];
    assert.equal(find(row, e => e.dataset.label === 'Current value DKK').textContent, '99.50');
    assert.equal(find(row, e => e.dataset.label === 'Net P/L DKK').textContent, '-0.50');
});

test('aggregates open and closed positions by platform including excluded KPI platforms', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push(
        { id: 'closed', ticker: 'CLOSED', platform: 'broker', name: 'Closed', type: 'Shares',
            is_closed: true, is_in_scope: true, current_value_dkk: 999 },
        { id: 'missing', ticker: 'MISSING', platform: 'Broker', name: 'Missing', type: 'Shares',
            is_closed: false, is_in_scope: true, current_value_dkk: null },
        { id: 'kucoin', ticker: 'COIN', platform: 'KuCoin', name: 'Coin', type: 'Crypto',
            is_closed: false, is_in_scope: false, current_value_dkk: 80 }
    );
    database.transactions.push(
        { id: 'closed-buy', portfolio_item_id: 'closed', action: 'Buy', quantity: '1', fees: '', total_cost: '-100' },
        { id: 'closed-sell', portfolio_item_id: 'closed', action: 'Sell', quantity: '1', fees: '', total_cost: '200' },
        { id: 'coin-buy', portfolio_item_id: 'kucoin', action: 'Buy', quantity: '1', fees: '', total_cost: '-50' }
    );
    await vm.runInContext('openInvestments()', context);
    const rows = elements.get('analyticsTableBody').children;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].children.map(cell => cell.textContent), ['Broker', '180.00 *', '69.23% *', '180.00 *']);
    assert.deepEqual(rows[1].children.map(cell => cell.textContent), ['KuCoin', '80.00', '30.77%', '30.00']);
    assert.match(elements.get('analyticsCoverage').textContent, /1 position has an unavailable value or P\/L/);
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '180 DKK');
    assert.equal(elements.get('analyticsRankingControls').hidden, true);
    elements.get('investmentClosedToggle').listeners.click();
    assert.deepEqual(elements.get('analyticsTableBody').children[0].children.map(cell => cell.textContent),
        ['Broker', '180.00 *', '69.23% *', '180.00 *']);
});

test('ranks the top and worst ten known positions and excludes unvalued positions', async () => {
    const { context, elements, database } = setupPortfolio();
    for (let i = 0; i < 12; i++) {
        database.items.push({ id: `rank-${i}`, ticker: `R${i}`, platform: 'Broker', name: `Rank ${i}`,
            type: 'Shares', is_closed: false, is_in_scope: true, current_value_dkk: 100 });
        database.transactions.push({ id: `rank-tx-${i}`, portfolio_item_id: `rank-${i}`, action: 'Buy',
            quantity: '1', fees: '', total_cost: `-${100 + i}` });
    }
    database.items.push({ id: 'unknown', ticker: 'UNKNOWN', platform: 'Broker', name: 'Unknown',
        type: 'Shares', is_closed: false, is_in_scope: true, current_value_dkk: null });
    await vm.runInContext('openInvestments()', context);
    elements.get('analyticsPerformersButton').listeners.click();
    assert.equal(elements.get('analyticsRankingControls').hidden, false);
    assert.equal(elements.get('analyticsPerformersButton').attributes['aria-pressed'], 'true');
    let rows = elements.get('analyticsTableBody').children;
    assert.equal(rows.length, 10);
    assert.match(rows[0].textContent, /Example/);
    assert.doesNotMatch(elements.get('analyticsTableBody').textContent, /Unknown/);
    assert.match(elements.get('analyticsCoverage').textContent, /excluded from performer rankings/);
    elements.get('analyticsWorstButton').listeners.click();
    rows = elements.get('analyticsTableBody').children;
    assert.equal(rows.length, 10);
    assert.match(rows[0].textContent, /Rank 11/);
    assert.equal(rows[0].children[3].textContent, '-11.00');
    assert.equal(rows[0].children[3].classes.has('investment-negative'), true);
    assert.equal(elements.get('analyticsWorstButton').attributes['aria-pressed'], 'true');
    elements.get('analyticsPlatformButton').listeners.click();
    assert.equal(elements.get('analyticsRankingControls').hidden, true);
});

test('plots total P/L history for items counted in total P/L on the trend view', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push({ id: 'out', ticker: 'OUT', platform: 'Broker', name: 'Out', type: 'Shares',
        is_closed: true, is_in_scope: false, current_value_dkk: 0 });
    database.items.push({ id: 'fund', ticker: 'FUND', platform: 'Broker', name: 'Fund', type: 'etf',
        is_closed: true, is_in_scope: true, current_value_dkk: 0 });
    database.history = [
        { id: 4, portfolio_item_id: 'fund', snapshot_date: '2024-01-15', pnl_dkk: 5 },
        { id: 1, portfolio_item_id: 'out', snapshot_date: '2024-01-01', pnl_dkk: 500 },
        { id: 2, portfolio_item_id: 'item-1', snapshot_date: '2024-02-01', pnl_dkk: 10 },
        { id: 3, portfolio_item_id: 'item-1', snapshot_date: '2024-03-01', pnl_dkk: 30 }
    ];
    vm.runInContext('globalThis.charts = []; Chart = class { constructor(canvas, config) { this.config = config; this.data = config.data; this.hidden = new Set(); charts.push(this); } isDatasetVisible(i) { return !this.hidden.has(i); } setDatasetVisibility(i, visible) { if (visible) this.hidden.delete(i); else this.hidden.add(i); } update() {} destroy() { this.destroyed = true; } }', context);
    await vm.runInContext('openInvestments()', context);
    elements.get('analyticsTrendButton').listeners.click();
    assert.equal(elements.get('analyticsRange90').attributes['aria-pressed'], 'true');
    assert.match(elements.get('analyticsCoverage').textContent, /No P\/L snapshots in this period/);
    elements.get('analyticsRangeall').listeners.click();
    assert.equal(elements.get('analyticsTable').hidden, true);
    assert.equal(elements.get('analyticsTrendBox').hidden, false);
    assert.equal(elements.get('analyticsTrendButton').attributes['aria-pressed'], 'true');
    assert.equal(elements.get('analyticsPlatformButton').attributes['aria-pressed'], 'false');
    const charts = vm.runInContext('charts', context);
    const datasets = charts[0].config.data.datasets;
    assert.deepEqual(Array.from(datasets, set => set.label), ['ETF', 'Shares']);
    assert.deepEqual(Array.from(datasets[0].data, point => point.y), [5, 5, 5]);
    assert.deepEqual(Array.from(datasets[1].data, point => point.y), [5, 15, 35]);
    assert.equal(datasets[0].fill, 'origin');
    assert.equal(datasets[1].fill, 0);
    charts[0].config.options.plugins.legend.onClick(null, { datasetIndex: 0 }, { chart: charts[0] });
    assert.deepEqual(Array.from(datasets[1].data, point => point.y), [0, 10, 30]);
    assert.equal(datasets[1].fill, 'origin');
    elements.get('analyticsPlatformButton').listeners.click();
    assert.equal(charts[0].destroyed, true);
    assert.equal(elements.get('analyticsTable').hidden, false);
    elements.get('analyticsTrendButton').listeners.click();
    elements.get('analyticsRange30').listeners.click();
    assert.equal(elements.get('analyticsRange30').attributes['aria-pressed'], 'true');
    assert.equal(elements.get('analyticsRangeall').attributes['aria-pressed'], 'false');
    assert.match(elements.get('analyticsCoverage').textContent, /No P\/L snapshots in this period/);
    elements.get('analyticsRangeall').listeners.click();
    assert.equal(elements.get('analyticsCoverage').textContent, '');
});

test('explains an empty or unavailable P/L history on the trend view', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    elements.get('analyticsTrendButton').listeners.click();
    assert.match(elements.get('analyticsCoverage').textContent, /No P\/L history yet/);
    database.historyLoadError = true;
    vm.runInContext('clearInvestments()', context);
    await vm.runInContext('openInvestments()', context);
    elements.get('analyticsTrendButton').listeners.click();
    assert.equal(elements.get('investmentTableBody').children.length, 1);
    assert.match(elements.get('analyticsCoverage').textContent, /Unable to load P\/L history/);
});

test('shows portfolio load failures and allows retry from analytics', async () => {
    const { context, elements, database } = setupPortfolio();
    database.failLoad = true;
    await vm.runInContext('openInvestments()', context);
    assert.match(elements.get('analyticsStatus').textContent, /Unable to load portfolio/);
    assert.equal(elements.get('analyticsRetry').hidden, false);
    database.failLoad = false;
    await elements.get('analyticsRetry').listeners.click();
    assert.equal(elements.get('analyticsStatus').textContent, '');
    assert.equal(elements.get('analyticsRetry').hidden, true);
    assert.equal(elements.get('analyticsTableBody').children.length, 1);
});

test('includes hidden positions in total P/L at zero current value without showing them', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push(
        { id: 'closed', ticker: 'CLOSED', platform: 'Broker', name: 'Closed', type: 'Shares',
            is_closed: true, is_in_scope: true, current_value_dkk: 999 },
        { id: 'uncertain', ticker: 'UNCERTAIN', platform: 'Broker', name: 'Uncertain', type: 'Shares',
            is_closed: true, is_in_scope: true, current_value_dkk: null }
    );
    database.transactions.push(
        { id: 'closed-buy', portfolio_item_id: 'closed', action: 'Buy', quantity: '2', fees: '-10', total_cost: '-200' },
        { id: 'closed-sell', portfolio_item_id: 'closed', action: 'Sell', quantity: '2', fees: '', total_cost: '300' },
        { id: 'closed-dividend', portfolio_item_id: 'closed', action: 'Dividend', quantity: '', fees: '', total_cost: '20' },
        { id: 'uncertain-buy', portfolio_item_id: 'uncertain', action: 'Buy', quantity: 'invalid', fees: '', total_cost: '-50' }
    );
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentTableBody').children.length, 1);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '140 DKK');
    const toggle = elements.get('investmentClosedToggle');
    toggle.listeners.click();
    assert.equal(toggle.attributes['aria-label'], 'Hide closed positions');
    assert.equal(toggle.title, 'Hide closed positions');
    assert.equal(toggle.attributes['aria-expanded'], 'true');
    const rows = elements.get('investmentTableBody').children;
    assert.equal(rows.length, 3);
    const closed = rows[1];
    const cell = label => find(closed, e => e.dataset.label === label);
    assert.match(cell('Name / ticker').textContent, /CLOSED · Closed/);
    assert.equal(cell('Current value DKK').textContent, '0.00');
    assert.equal(cell('Net P/L DKK').textContent, '110.00');
    assert.equal(cell('Portfolio %').textContent, '—');
    assert.equal(refreshButton(closed).disabled, true);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '140 DKK');
    toggle.listeners.click();
    assert.equal(toggle.attributes['aria-label'], 'Show closed positions');
    assert.equal(toggle.title, 'Show closed positions');
    assert.equal(elements.get('investmentTableBody').children.length, 1);
    database.items[0].is_closed = true;
    vm.runInContext('clearInvestments()', context);
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentTableBody').children.length, 0);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '—');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '-40 DKK');
});

test('excludes out-of-scope positions from total P/L without changing individual positions or portfolio size', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].is_in_scope = false;
    database.items.push(
        { id: 'ops-closed', ticker: 'OPS', platform: 'OPS Capital', name: 'Closed OPS', type: 'Shares',
            is_closed: true, is_in_scope: false, current_value_dkk: 999 },
        { id: 'other', ticker: 'OTHER', platform: 'OPS Capital Partners', name: 'Other', type: 'Shares',
            is_closed: false, is_in_scope: true, current_value_dkk: 100 },
        { id: 'other-closed', ticker: 'CLOSED', platform: 'Broker', name: 'Closed Other', type: 'Shares',
            is_closed: true, is_in_scope: true, current_value_dkk: null }
    );
    database.transactions.push(
        { id: 'ops-sell', portfolio_item_id: 'ops-closed', action: 'Sell', quantity: '1', fees: '', total_cost: '200' },
        { id: 'other-buy', portfolio_item_id: 'other', action: 'Buy', quantity: '1', fees: '', total_cost: '-30' },
        { id: 'closed-buy', portfolio_item_id: 'other-closed', action: 'Buy', quantity: '1', fees: '', total_cost: '-50' },
        { id: 'closed-sell', portfolio_item_id: 'other-closed', action: 'Sell', quantity: '1', fees: '', total_cost: '70' }
    );
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '280 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '90 DKK');
    const row = elements.get('investmentTableBody').children[0];
    assert.equal(find(row, e => e.dataset.label === 'Net P/L DKK').textContent, '80.00');
    assert.equal(find(row, e => e.dataset.label === 'Portfolio %').textContent, '64.29%');
    elements.get('investmentClosedToggle').listeners.click();
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '90 DKK');
    assert.equal(find(elements.get('investmentTableBody').children[2], e => e.dataset.label === 'Net P/L DKK').textContent, '200.00');
});

test('shows no total P/L when every contributing position is out of scope', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].is_in_scope = false;
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '—');
});

test('excludes open and closed out-of-scope positions from total P/L only', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].is_in_scope = false;
    database.items.push(
        { id: 'closed', ticker: 'CLOSED', platform: 'KuCoin', name: 'Closed', type: 'Crypto',
            is_closed: true, is_in_scope: false, current_value_dkk: 999 },
        { id: 'other', ticker: 'OTHER', platform: 'KuCoin Pro', name: 'Other', type: 'Crypto',
            is_closed: false, is_in_scope: true, current_value_dkk: 100 }
    );
    database.transactions.push(
        { id: 'closed-sell', portfolio_item_id: 'closed', action: 'Sell', quantity: '1', fees: '', total_cost: '200' },
        { id: 'other-buy', portfolio_item_id: 'other', action: 'Buy', quantity: '1', fees: '', total_cost: '-30' }
    );
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '280 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '70 DKK');
    const row = elements.get('investmentTableBody').children[0];
    assert.equal(find(row, e => e.dataset.label === 'Net P/L DKK').textContent, '80.00');
    assert.equal(find(row, e => e.dataset.label === 'Portfolio %').textContent, '64.29%');
    elements.get('investmentClosedToggle').listeners.click();
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '70 DKK');
    assert.equal(find(elements.get('investmentTableBody').children[2], e => e.dataset.label === 'Net P/L DKK').textContent, '200.00');
});

test('treats an out-of-scope Ethereum position like any other out-of-scope item', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].is_in_scope = false;
    database.items.push({ id: 'other', ticker: 'OTHER', platform: 'Ethereum Pro', name: 'Other', type: 'Crypto',
        is_closed: false, is_in_scope: true, current_value_dkk: 100 });
    database.transactions.push({ id: 'other-buy', portfolio_item_id: 'other', action: 'Buy', quantity: '1', fees: '', total_cost: '-30' });
    await vm.runInContext('openInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '280 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '70 DKK');
});

test('displays closed crowdlending values as zero without allowing manual changes', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].is_closed = true;
    database.items[0].type = 'Crowdlending';
    await vm.runInContext('openInvestments()', context);
    elements.get('investmentClosedToggle').listeners.click();
    const row = elements.get('investmentTableBody').children[0];
    const value = find(row, e => e.dataset.label === 'Current value DKK');
    assert.equal(value.textContent, '0.00');
    assert.equal(find(value, e => e.tag === 'input'), undefined);
    assert.equal(refreshButton(row).disabled, true);
});

test('edits item fields, preserves safe values, and invalidates a changed ticker or type', async () => {
    const { context, elements, database } = setupPortfolio();
    Object.assign(database.items[0], { market_price: 90, market_currency: 'DKK', market_price_at: '2026-01-01T12:00:00Z' });
    await vm.runInContext('openInvestments()', context);
    const edit = () => find(elements.get('investmentTableBody').children[0], e => e.className === 'investment-edit');
    edit().listeners.click();
    assert.equal(elements.get('investmentDialogTitle').textContent, 'Edit portfolio item');
    assert.equal(elements.get('investmentTicker').value, 'CPH:NOVO-B');
    elements.get('investmentName').value = 'New name';
    elements.get('investmentPlatform').value = 'New broker';
    const form = elements.get('investmentForm');
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(database.items[0].name, 'New name');
    assert.equal(database.items[0].platform, 'New broker');
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.equal(database.items[0].market_price, 90);
    assert.equal(database.items[0].valuation_version, 1);
    assert.match(elements.get('investmentTableBody').children[0].textContent, /New name/);

    edit().listeners.click();
    elements.get('investmentTicker').value = 'NOVO-B.CO';
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(database.items[0].ticker, 'NOVO-B.CO');
    assert.equal(database.items[0].current_value_dkk, null);
    assert.equal(database.items[0].market_price, null);
    assert.equal(database.items[0].market_currency, null);
    assert.equal(database.items[0].market_price_at, null);
    assert.equal(database.items[0].valuation_version, 2);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '—');
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.marketRequests[0].params.symbol, 'NOVO-B.CO');
    assert.equal(database.items[0].current_value_dkk, 200);

    edit().listeners.click();
    elements.get('investmentType').value = 'Crowdlending';
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(database.items[0].type, 'Crowdlending');
    assert.equal(database.items[0].current_value_dkk, null);
    assert.equal(database.items[0].market_price, null);
    assert.equal(refreshButton(elements.get('investmentTableBody').children[0]).disabled, true);
});

test('rejects stale item edits and requires reloading before retrying', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    find(elements.get('investmentTableBody').children[0], e => e.className === 'investment-edit').listeners.click();
    elements.get('investmentTicker').value = 'CHANGED';
    database.items[0].valuation_version = 1;
    const form = elements.get('investmentForm');
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(database.items[0].ticker, 'CPH:NOVO-B');
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.match(elements.get('investmentFormStatus').textContent, /reload the portfolio/);
    assert.equal(elements.get('investmentRetry').hidden, false);
    assert.equal(elements.get('investmentTableBody').children.length, 0);
});

test('preserves crowdlending values when its ticker and platform change', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items[0].type = 'Crowdlending';
    await vm.runInContext('openInvestments()', context);
    vm.runInContext('investmentSettings[JSON.stringify(["Broker", "CPH:NOVO-B"])] = { value: 55 }', context);
    find(elements.get('investmentTableBody').children[0], e => e.className === 'investment-edit').listeners.click();
    elements.get('investmentTicker').value = 'CROWD';
    elements.get('investmentPlatform').value = 'New broker';
    const form = elements.get('investmentForm');
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180 DKK');
    assert.equal(vm.runInContext('investmentSettings[JSON.stringify(["New broker", "CROWD"])].value', context), 55);
    assert.equal(vm.runInContext('investmentSettings[JSON.stringify(["Broker", "CPH:NOVO-B"])]', context), undefined);
});

test('scales allocation colors across valued positions and leaves unknown values uncolored', async () => {
    const { context, elements, database } = setupPortfolio();
    for (const [id, value] of [['low', 100], ['middle', 140], ['unknown', null]]) {
        database.items.push({ id, ticker: id, platform: 'Broker', name: id, type: 'Shares',
            market_symbol: null, is_closed: false, is_in_scope: true, current_value_dkk: value });
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
        ].map(position => ({...position, platform:'Broker'}));
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
        type: 'Shares', is_closed: false, is_in_scope: true, current_value_dkk: null });
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
    assert.match(elements.get('investmentCoverage').textContent, /0 of 1 open positions valued/);

    vm.runInContext('investmentPositions[0].currentValue = 0; renderInvestments()', context);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '0 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '-100 DKK');
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
        type: 'Shares', market_symbol: 'SECOND', is_closed: false, is_in_scope: true, current_value_dkk: 80 });
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
        type: 'Shares', market_symbol: null, is_closed: false, is_in_scope: true, current_value_dkk: null });
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

test('persists and restores a refreshed price, currency and quote time', async () => {
    const { context, elements, database } = setupPortfolio();
    database.quoteCurrency = 'USD';
    await vm.runInContext('openInvestments()', context);
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].market_price, 100);
    assert.equal(database.items[0].market_currency, 'USD');
    assert.equal(database.items[0].market_price_at, '2026-01-01T12:00:00.000Z');
    assert.equal(database.items[0].current_value_dkk, 1500);
    const refreshedPrice = find(elements.get('investmentTableBody').children[0], e => e.dataset.label === 'Price');
    assert.match(refreshedPrice.textContent, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    vm.runInContext('clearInvestments()', context);
    await vm.runInContext('openInvestments()', context);
    const price = find(elements.get('investmentTableBody').children[0], e => e.dataset.label === 'Price');
    assert.match(price.textContent, /100\.00 USD/);
    assert.match(price.textContent, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '1,500 DKK');
});

test('preserves the saved price but invalidates the valuation after a trade', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    fillPortfolioTransaction(elements);
    await submitPortfolioTransaction(elements);
    assert.equal(database.items[0].market_price, 100);
    assert.equal(database.items[0].current_value_dkk, null);
    const row = elements.get('investmentTableBody').children[0];
    assert.match(find(row, e => e.dataset.label === 'Price').textContent, /100\.00 DKK/);
    assert.equal(find(row, e => e.dataset.label === 'Current value DKK').textContent, '—');
});

test('saves the price when quantity is unknown or currency conversion fails', async () => {
    const { context, elements, database } = setupPortfolio();
    database.quoteCurrency = 'USD';
    database.transactions[0].quantity = 'invalid';
    await vm.runInContext('openInvestments()', context);
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].market_price, 100);
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.equal(database.marketRequests.some(request => request.path === 'exchange_rate'), false);
    vm.runInContext('clearInvestments()', context);
    database.transactions[0].quantity = '2';
    database.exchangeError = 'FX unavailable';
    await vm.runInContext('openInvestments()', context);
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].market_price, 100);
    assert.equal(database.items[0].current_value_dkk, 180);
    assert.match(elements.get('investmentTableBody').textContent, /Price saved, but currency conversion failed: FX unavailable/);
});

test('retains the saved price when a refresh cannot be saved', async () => {
    const { context, elements, database } = setupPortfolio();
    Object.assign(database.items[0], { market_price: 42, market_currency: 'USD', market_price_at: null });
    await vm.runInContext('openInvestments()', context);
    database.failSave = true;
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].market_price, 42);
    assert.match(find(elements.get('investmentTableBody').children[0], e => e.dataset.label === 'Price').textContent, /42\.00 USD.*save failed/);
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
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180 DKK');
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

test('does not show review warnings for other transaction actions', async () => {
    const { context, elements, database } = setupPortfolio();
    database.transactions.push(
        { id: 'split', portfolio_item_id: 'item-1', action: 'SPLIT INDLÆG VP', quantity: '3', fees: '', total_cost: '0' },
        { id: 'receive', portfolio_item_id: 'item-1', action: 'Recieve', quantity: '1', fees: '', total_cost: '0' }
    );
    await vm.runInContext('openInvestments()', context);
    const row = elements.get('investmentTableBody').children[0];
    assert.doesNotMatch(row.textContent, /Review actions/);
    assert.equal(find(row, e => e.dataset.label === 'Qty').textContent, '2.00');
    assert.equal(elements.get('investmentPortfolioSize').textContent, '180 DKK');
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
    assert.equal(elements.get('investmentPortfolioSize').textContent, '250 DKK');
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

// The Portfolio and Transactions subtabs (house.js) set this flag and re-render.
function showPortfolioView(context, transactions) {
    vm.runInContext(`portfolioTransactionsVisible = ${transactions}; renderPortfolioTransactions()`, context);
}

test('switches views and searches and pages all transactions, including closed items', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push({ id: 'outside', ticker: 'OTHER', platform: 'Broker', name: 'Outside', type: 'Shares',
        is_closed: true, is_in_scope: true, current_value_dkk: null });
    for (let i = 0; i < 14; i++) {
        database.transactions.push({ id: `other-${i}`, portfolio_item_id: 'outside', ticker: 'OTHER',
            name: 'Outside Company', transaction_date: `2026-01-${String(i + 1).padStart(2, '0')}`, action: 'Buy', quantity: '1', fees: '', total_cost: '-5' });
    }
    await vm.runInContext('openInvestments()', context);
    showPortfolioView(context, true);
    assert.equal(elements.get('portfolioOverview').hidden, true);
    assert.equal(elements.get('portfolioKpis').hidden, true);
    assert.equal(elements.get('portfolioTransactions').hidden, false);
    assert.equal(elements.get('investmentClosedToggle').hidden, true);
    assert.equal(elements.get('portfolioTransactionBody').children.length, 12);
    assert.equal(elements.get('portfolioTransactionPage').textContent, 'Page 1 of 2');
    elements.get('portfolioTransactionNext').listeners.click();
    assert.equal(elements.get('portfolioTransactionBody').children.length, 3);
    elements.get('portfolioSearch').value = 'oth';
    elements.get('portfolioSearch').listeners.input();
    assert.equal(elements.get('portfolioTransactionPage').textContent, 'Page 1 of 2');
    assert.match(elements.get('portfolioTransactionStatus').textContent, /14 transactions matching ticker or name/);
    elements.get('portfolioSearch').value = ' CoMPany ';
    elements.get('portfolioSearch').listeners.input();
    assert.equal(elements.get('portfolioTransactionBody').children.length, 12);
    assert.match(elements.get('portfolioTransactionStatus').textContent, /14 transactions matching ticker or name/);
    elements.get('portfolioSearch').value = 'no match';
    elements.get('portfolioSearch').listeners.input();
    assert.equal(elements.get('portfolioTransactionBody').children.length, 0);
    elements.get('portfolioTransactionAdd').listeners.click();
    assert.match(elements.get('portfolioTransactionItem').textContent, /OTHER.*closed/);
    showPortfolioView(context, false);
    assert.equal(elements.get('portfolioOverview').hidden, false);
    assert.equal(elements.get('portfolioKpis').hidden, false);
    assert.equal(elements.get('investmentClosedToggle').hidden, false);
});

test('shares the portfolio search between views without changing totals or closed-position visibility', async () => {
    const { context, elements, database } = setupPortfolio();
    Object.assign(database.transactions[0], { ticker: 'CPH:NOVO-B', name: 'Example' });
    database.items.push(
        { id: 'open', ticker: 'ABC', platform: 'Broker', name: 'Another Company', type: 'Shares',
            is_closed: false, is_in_scope: true, current_value_dkk: 200 },
        { id: 'closed', ticker: 'CLOSED', platform: 'Broker', name: 'Closed Company', type: 'Shares',
            is_closed: true, is_in_scope: true, current_value_dkk: null }
    );
    database.transactions.push(
        { id: 'open-tx', portfolio_item_id: 'open', ticker: 'ABC', name: 'Another Company',
            action: 'Buy', quantity: '1', fees: '', total_cost: '-100' },
        { id: 'closed-tx', portfolio_item_id: 'closed', ticker: 'CLOSED', name: 'Closed Company',
            action: 'Buy', quantity: '1', fees: '', total_cost: '-50' }
    );
    await vm.runInContext('openInvestments()', context);
    const search = elements.get('portfolioSearch');
    const overview = elements.get('investmentTableBody');
    search.value = ' COMPANY ';
    search.listeners.input();
    assert.equal(overview.children.length, 1);
    assert.match(overview.textContent, /ABC/);
    assert.equal(elements.get('investmentPortfolioSize').textContent, '380 DKK');
    assert.equal(elements.get('investmentPortfolioPnl').textContent, '130 DKK');
    elements.get('investmentClosedToggle').listeners.click();
    assert.equal(overview.children.length, 2);
    showPortfolioView(context, true);
    assert.equal(elements.get('portfolioTransactionBody').children.length, 2);
    search.value = 'novo';
    search.listeners.input();
    assert.equal(elements.get('portfolioTransactionBody').children.length, 1);
    showPortfolioView(context, false);
    assert.equal(overview.children.length, 1);
    assert.match(overview.textContent, /CPH:NOVO-B/);
    search.value = '';
    search.listeners.input();
    assert.equal(overview.children.length, 3);
    search.value = 'company';
    vm.runInContext('clearInvestments()', context);
    assert.equal(search.value, '');
});

test('shows ticker details with overview badges and colors actions and signed amounts', async () => {
    const { context, elements, database } = setupPortfolio();
    Object.assign(database.transactions[0], { transaction_date: '2026-03-01', ticker: 'CPH:NOVO-B',
        name: 'Example', type: 'Shares', platform: 'Broker', currency: 'USD', local_currency: 'DKK',
        commission: '-1,5', fees: '2', total_cost: '-100' });
    database.transactions.push({ id: 'dividend', portfolio_item_id: 'item-1', transaction_date: '2026-02-01',
        action: 'Dividend', quantity: '', fees: '0', total_cost: '4', type: 'Shares', platform: 'Broker', ticker: 'CPH:NOVO-B' });
    database.transactions.push({ id: 'sell', portfolio_item_id: 'item-1', transaction_date: '2026-01-01',
        action: 'Sell', quantity: '1', fees: '', total_cost: '5', type: 'Shares', platform: 'Broker', ticker: 'CPH:NOVO-B' });
    await vm.runInContext('openInvestments()', context);
    const rows = elements.get('portfolioTransactionBody').children;
    const overviewBadge = find(elements.get('investmentTableBody').children[0], e => e.className === 'investment-type');
    const cell = (row, label) => find(row, e => e.dataset.label === label);
    assert.equal(rows[0].children[0].dataset.label, 'Date');
    assert.equal(rows[0].children.at(-1).dataset.label, 'Actions');
    assert.equal(rows[0].children.at(-1).children.length, 3);
    const ticker = cell(rows[0], 'Ticker');
    const popup = find(ticker, e => e.className === 'investment-popup investment-info-popup');
    assert.match(popup.textContent, /Name: ExamplePlatform: BrokerType: SharesCurrency: USDLocal currency: DKK/);
    assert.equal(popup.children[1].children[1].className, 'investment-type');
    assert.equal(popup.children[2].children[1].style['--investment-type-hue'], overviewBadge.style['--investment-type-hue']);
    assert.equal(find(ticker, e => e.tag === 'summary').attributes['aria-label'], 'Transaction details for CPH:NOVO-B');
    assert.equal(cell(rows[0], 'Action').classes.has('investment-negative'), true);
    assert.equal(cell(rows[0], 'Commission').classes.has('investment-negative'), true);
    assert.equal(cell(rows[0], 'Fees DKK').classes.has('investment-positive'), true);
    assert.equal(cell(rows[0], 'Total cost DKK').classes.has('investment-negative'), true);
    assert.equal(cell(rows[1], 'Action').classes.has('investment-positive'), true);
    assert.equal(cell(rows[1], 'Fees DKK').classes.size, 0);
    assert.equal(cell(rows[1], 'Total cost DKK').classes.has('investment-positive'), true);
    assert.equal(cell(rows[2], 'Action').classes.has('investment-positive'), true);
});

test('edits, duplicates and deletes transactions and reloads affected valuations', async () => {
    const { context, elements, database } = setupPortfolio();
    Object.assign(database.transactions[0], { transaction_date: '2026-03-01', ticker: 'OLD-TICKER',
        name: 'Old name', type: 'Shares', platform: 'Broker' });
    database.items.push({ id: 'item-2', ticker: 'NEW', name: 'New', type: 'Shares',
        platform: 'Broker', is_closed: false, is_in_scope: true, current_value_dkk: 300, valuation_version: 0 });
    await vm.runInContext('openInvestments()', context);
    const button = title => find(elements.get('portfolioTransactionBody').children[0], e => e.title === title);
    button('Edit transaction').listeners.click();
    assert.equal(elements.get('portfolioTransactionDialogTitle').textContent, 'Edit portfolio transaction');
    assert.equal(elements.get('portfolioTransactionQuantity').value, '2');
    elements.get('portfolioTransactionItem').value = 'item-2';
    await submitPortfolioTransaction(elements);
    assert.equal(database.transactions[0].portfolio_item_id, 'item-2');
    assert.equal(database.transactions[0].ticker, 'NEW');
    assert.equal(database.transactions[0].revision, 1);
    assert.equal(database.items[0].current_value_dkk, null);
    assert.equal(database.items[1].current_value_dkk, null);
    await button('Duplicate transaction').listeners.click();
    assert.equal(database.transactions.length, 2);
    assert.equal(database.transactions[1].portfolio_item_id, 'item-2');
    database.confirmDelete = false;
    await button('Delete transaction').listeners.click();
    assert.equal(database.transactions.length, 2);
    database.confirmDelete = true;
    await button('Delete transaction').listeners.click();
    assert.equal(database.transactions.length, 1);
});

test('rejects stale transaction changes and requires a reload', async () => {
    const { context, elements, database } = setupPortfolio();
    Object.assign(database.transactions[0], { transaction_date: '2026-03-01', ticker: 'TICKER',
        type: 'Shares', platform: 'Broker' });
    await vm.runInContext('openInvestments()', context);
    database.transactions[0].revision = 1;
    const duplicate = find(elements.get('portfolioTransactionBody').children[0], e => e.title === 'Duplicate transaction');
    await duplicate.listeners.click();
    assert.equal(database.transactions.length, 1);
    assert.match(elements.get('investmentStatus').textContent, /changed or was deleted/);
    assert.equal(elements.get('investmentRetry').hidden, false);
    assert.equal(elements.get('portfolioTransactionBody').children.length, 1);
    assert.equal(find(elements.get('portfolioTransactionBody').children[0], e => e.title === 'Duplicate transaction').disabled, true);
});

test('explains how to restore a missing transaction function without clearing the table', async () => {
    const { context, elements, database } = setupPortfolio();
    await vm.runInContext('openInvestments()', context);
    database.transactionError = { code: 'PGRST202', message: 'Could not find the transaction function in the schema cache' };
    const duplicate = find(elements.get('portfolioTransactionBody').children[0], e => e.title === 'Duplicate transaction');
    await duplicate.listeners.click();
    assert.match(elements.get('investmentStatus').textContent, /complete db\/supabase\/portfolio\.sql/);
    assert.equal(elements.get('portfolioTransactionBody').children.length, 1);
    assert.equal(elements.get('investmentRetry').hidden, false);
});

test('validates and saves a buy, reloads the overview, and retains crowdlending valuations', async () => {
    const { context, elements, database } = setupPortfolio();
    database.items.push({ id: 'crowd', ticker: 'CROWD', platform: 'Broker', name: 'Crowd', type: 'Crowdlending',
        is_closed: false, is_in_scope: true, current_value_dkk: 500, valuation_version: 0 });
    await vm.runInContext('openInvestments()', context);
    fillPortfolioTransaction(elements, { Date: '2026-02-29' });
    await submitPortfolioTransaction(elements);
    assert.match(elements.get('portfolioTransactionFormStatus').textContent, /YYYY-MM-DD/);
    assert.equal(database.transactions.length, 1);
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
    assert.equal(database.transactions[1].transaction_date, '2026-03-01');
    assert.equal(find(elements.get('investmentTableBody').children[0], e => e.dataset.label === 'Qty').textContent, '3.50');
    assert.equal(elements.get('investmentPortfolioSize').textContent, '500 DKK');
    fillPortfolioTransaction(elements, { Item: 'crowd', Action: 'Sell' });
    await submitPortfolioTransaction(elements);
    assert.equal(database.items[1].current_value_dkk, 500);
});

test('blocks a stale price save after another client adds a trade', async () => {
    const { context, elements, database } = setupPortfolio();
    Object.assign(database.items[0], { market_price: 42, market_currency: 'USD', market_price_at: null });
    await vm.runInContext('openInvestments()', context);
    database.items[0].valuation_version = 1;
    database.items[0].current_value_dkk = null;
    await refreshButton(elements.get('investmentTableBody').children[0]).listeners.click();
    assert.equal(database.items[0].current_value_dkk, null);
    assert.equal(database.items[0].market_price, 42);
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
    assert.match(elements.get('portfolioTransactionFormStatus').textContent, /change may have completed/);
    assert.equal(elements.get('investmentRetry').hidden, false);
    assert.equal(elements.get('investmentTableBody').children.length, 0);
    assert.equal(elements.get('portfolioTransactionBody').children.length, 1);
    assert.match(elements.get('portfolioTransactionStatus').textContent, /last-loaded transactions/);
    assert.equal(find(elements.get('portfolioTransactionBody').children[0], e => e.title === 'Edit transaction').disabled, true);
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
    assert.equal(elements.get('portfolioTransactionBody').children.length, 1);
    assert.match(elements.get('portfolioTransactionStatus').textContent, /last-loaded transactions/);
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
