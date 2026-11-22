const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

function localTimestamp(value) {
    const date = new Date(value);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setup() {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {
                style: {}, attributes: {}, textContent: '',
                classList: {
                    add: name => classes.add(name),
                    remove: name => classes.delete(name),
                    toggle: (name, value) => value ? classes.add(name) : classes.delete(name),
                    contains: name => classes.has(name)
                },
                setAttribute(name, value) { this.attributes[name] = value; },
                addEventListener() {}
            });
        }
        return elements.get(id);
    }
    const document = {
        getElementById: element,
        querySelectorAll: selector => selector === '.tab-btn' ? [element('navHome'), element('navInvestments')] : [],
        querySelector: selector => selector.includes("'home'") ? element('navHome') : element('navInvestments'),
        addEventListener() {},
        documentElement: { setAttribute() {} },
        body: element('body')
    };
    const context = vm.createContext({ document, investmentSubtab: 'portfolio' });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'date-utils.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), context);
    vm.runInContext(`
        renderTransactionsTab = () => { transactionsRendered++; };
        renderHighlightsTab = () => { highlightsRendered++; };
        renderInvestments = () => {};
        openInvestments = () => {};
        openHouse = () => {};
        clearInvestments = () => {};
        clearHouse = () => {};
        let transactionsRendered = 0, highlightsRendered = 0;
    `, context);
    return { context, elements };
}

test('switches Home subtabs and preserves the selected subtab after visiting Investments', () => {
    const { context, elements } = setup();
    vm.runInContext("switchTab('home'); switchHomeSubtab('transactions')", context);
    assert.equal(elements.get('tabHome').style.display, 'flex');
    assert.equal(elements.get('tabTransactions').style.display, 'flex');
    assert.equal(elements.get('tabDashboard').style.display, 'none');
    assert.equal(elements.get('homeTransactionsTab').attributes['aria-selected'], 'true');
    vm.runInContext("switchTab('investments'); switchTab('home')", context);
    assert.equal(elements.get('tabTransactions').style.display, 'flex');
    assert.equal(elements.get('tabInvestments').style.display, 'none');
    assert.equal(vm.runInContext('transactionsRendered', context), 2);
    vm.runInContext("switchHomeSubtab('highlights')", context);
    assert.equal(elements.get('tabHighlights').style.display, 'flex');
    assert.equal(elements.get('homeTransactionsTab').attributes['aria-selected'], 'false');
    assert.equal(vm.runInContext('highlightsRendered', context), 1);
});

test('opens Monthly view when the selected account has a visible pending review', () => {
    const { context, elements } = setup();
    vm.runInContext(`
        populateYearFilter = () => {};
        populateCategoryFilter = () => {};
        applyGlobalFilters = () => {};
        renderDrawerTable = () => {};
        const now = new Date();
        const previousMonth = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        rawData = [{ Year: previousMonth.getFullYear(), Month: previousMonth.getMonth() + 1,
            Account: 'anna', Expense: 'Groceries', Type: '⚠️ Review' }];
        bootstrapApp();
    `, context);
    assert.equal(elements.get('tabMonthly').style.display, 'flex');
    assert.equal(elements.get('homeMonthlyTab').attributes['aria-selected'], 'true');
    assert.equal(elements.get('monthlyReviewCount').textContent, '1');
    vm.runInContext("switchHomeSubtab('dashboard'); switchTab('investments'); switchTab('home')", context);
    assert.equal(elements.get('tabDashboard').style.display, 'flex');
});

test('opens Dashboard when reviews are outside the selected account or visible months, or excluded', () => {
    const { context, elements } = setup();
    vm.runInContext(`
        populateYearFilter = () => {};
        populateCategoryFilter = () => {};
        applyGlobalFilters = () => {};
        const now = new Date();
        const oldMonth = new Date(now.getFullYear(), now.getMonth() - 3, 1);
        const futureMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        rawData = [
            { Year: now.getFullYear(), Month: now.getMonth() + 1, Account: 'carlos', Expense: 'Review' },
            { Year: oldMonth.getFullYear(), Month: oldMonth.getMonth() + 1, Account: 'anna', Expense: 'Review' },
            { Year: futureMonth.getFullYear(), Month: futureMonth.getMonth() + 1, Account: 'anna', Expense: 'Review' },
            { Year: now.getFullYear(), Month: now.getMonth() + 1, Account: 'anna', Type: 'Review', excluded: true }
        ];
        bootstrapApp();
    `, context);
    assert.equal(elements.get('tabDashboard').style.display, 'flex');
    assert.equal(elements.get('homeDashboardTab').attributes['aria-selected'], 'true');
    vm.runInContext(`
        renderDrawerTable = () => {};
        monthlyViewScope = 'carlos';
        bootstrapApp();
    `, context);
    assert.equal(elements.get('tabMonthly').style.display, 'flex');
    assert.equal(elements.get('monthlyReviewCount').textContent, '1');
});

test('Monthly view limits rows to the current three calendar months and selected scope', () => {
    const { context } = setup();
    vm.runInContext(`
        rawData = [
            {Year: 2026, Month: 11, Account: 'anna'},
            {Year: 2026, Month: 10, Account: 'anna'},
            {Year: 2026, Month: 9, Account: 'anna'},
            {Year: 2026, Month: 8, Account: 'anna'},
            {Year: 2026, Month: 12, Account: 'anna'},
            {Year: 2026, Month: 11, Account: 'joint'},
            {Year: 2026, Month: 11, Account: 'carlos'}
        ];
        monthlyViewScope = 'anna';
    `, context);

    assert.equal(
        vm.runInContext(
            'getMonthlyViewScopeRows(new Date(2026, 10, 22)).length',
            context
        ),
        3
    );
    vm.runInContext("monthlyViewScope = 'carlos'", context);
    assert.equal(
        vm.runInContext(
            'getMonthlyViewScopeRows(new Date(2026, 10, 22)).length',
            context
        ),
        1
    );
    vm.runInContext("monthlyViewScope = 'joint'", context);
    assert.equal(
        vm.runInContext(
            'getMonthlyViewScopeRows(new Date(2026, 10, 22)).length',
            context
        ),
        1
    );
});

test('Monthly review KPI excludes analytics-disabled rows while the full table keeps them', () => {
    const { context } = setup();
    context.renderDrawerTable = () => {};
    vm.runInContext(`
        rawData = [
            {Expense: '⚠️ Review', Type: 'Food', Year: 2026, Month: 11, Account: 'anna'},
            {Expense: 'Food', Type: '⚠️ Review', Year: 2026, Month: 11, Account: 'joint'},
            {Expense: 'Food', Type: 'Groceries', Year: 2026, Month: 11, Account: 'anna'},
            {Expense: '⚠️ Review', Type: '⚠️ Review', Year: 2026, Month: 11, Account: 'anna', excluded: true}
        ];
        monthlyViewScope = 'anna';
    `, context);

    vm.runInContext(
        'monthlyViewReviewOnly = true; renderMonthlyView(new Date(2026, 10, 22))',
        context
    );
    assert.equal(vm.runInContext('monthlyViewData.length', context), 1);
    assert.equal(vm.runInContext("monthlyReviewKpiAttribute = document.getElementById('monthlyReviewKpi').attributes['aria-pressed']", context), 'true');
    vm.runInContext(
        'monthlyViewReviewOnly = false; renderMonthlyView(new Date(2026, 10, 22))',
        context
    );
    assert.equal(vm.runInContext('monthlyViewData.length', context), 3);
    assert.equal(vm.runInContext('monthlyViewData.some(row => row.excluded)', context), true);
    assert.equal(vm.runInContext("document.getElementById('monthlyReviewCount').textContent", context), '1');
});

test('Monthly view bulk-saves all dirty rows with one action', async () => {
    const { context, elements } = setup();
    context.savedRows = [];
    vm.runInContext(`
        rowToSupabaseData = row => ({ id: row.id });
        apiSaveRow = async row => savedRows.push(row);
        showToast = () => {};
        renderMonthlyView = () => {};
        firstMonthlyRow = {id: 'one'};
        secondMonthlyRow = {id: 'two'};
        monthlyViewDirtyRows.add(firstMonthlyRow);
        monthlyViewDirtyRows.add(secondMonthlyRow);
    `, context);

    await vm.runInContext("saveDrawerChanges('monthly')", context);

    assert.equal(context.savedRows.length, 2);
    assert.equal(vm.runInContext('monthlyViewDirtyRows.size', context), 0);
    assert.equal(elements.get('monthlySaveButton').disabled, true);
    assert.equal(vm.runInContext('monthlyViewSaving', context), false);
});

test('shows the signed-in email in the account controls and clears it on sign-out', async () => {
    const { context, elements } = setup();
    vm.runInContext('loadData = async () => {}; refreshTransactionInsertDate = async () => {}', context);
    await vm.runInContext("applyAuthSession({user: {id: 'user', email: 'person@example.com'}})", context);
    assert.equal(elements.get('signedInEmail').textContent, 'person@example.com');
    assert.equal(elements.get('signedInEmail').title, 'person@example.com');
    await vm.runInContext('applyAuthSession(null)', context);
    assert.equal(elements.get('signedInEmail').textContent, '');
    assert.equal(elements.get('signedInEmail').title, '');
});

test('queries the latest non-null transaction insert without filtering its source', async () => {
    const { context, elements } = setup();
    const calls = [];
    context.client = {
        from(table) {
            calls.push(['from', table]);
            return {
                select(column) { calls.push(['select', column]); return this; },
                not(...args) { calls.push(['not', ...args]); return this; },
                order(column, options) { calls.push(['order', column, options.ascending]); return this; },
                limit(value) { calls.push(['limit', value]); return this; },
                async maybeSingle() { return { data: { inserted_at: '2026-03-01T10:15:00Z' }, error: null }; }
            };
        }
    };
    vm.runInContext("activeAuthUserId = 'user'; supabaseClient = client", context);
    await vm.runInContext('refreshTransactionInsertDate()', context);
    const expected = localTimestamp('2026-03-01T10:15:00Z');
    assert.equal(elements.get('transactionInsertDate').textContent, `Last updated: ${expected}`);
    assert.deepEqual(calls, [
        ['from', 'transactions'], ['select', 'inserted_at'], ['not', 'inserted_at', 'is', null],
        ['order', 'inserted_at', false], ['limit', 1]
    ]);
});

test('reports missing dates and errors and ignores an old response after sign-out', async () => {
    const { context, elements } = setup();
    let response = { data: null, error: null };
    context.client = {
        from() {
            return {
                select() { return this; }, not() { return this; }, order() { return this; }, limit() { return this; },
                maybeSingle() { return response; }
            };
        }
    };
    vm.runInContext("activeAuthUserId = 'user'; supabaseClient = client", context);
    await vm.runInContext('refreshTransactionInsertDate()', context);
    assert.equal(elements.get('transactionInsertDate').textContent, 'Last updated: —');
    response = { error: { message: 'query failed' } };
    await vm.runInContext('refreshTransactionInsertDate()', context);
    assert.match(elements.get('transactionInsertDate').textContent, /unavailable: query failed/);
    let resolve;
    response = new Promise(done => { resolve = done; });
    const pending = vm.runInContext('refreshTransactionInsertDate()', context);
    await vm.runInContext('applyAuthSession(null)', context);
    resolve({ data: { inserted_at: '2026-03-01T10:15:00Z' }, error: null });
    await pending;
    assert.equal(elements.get('transactionInsertDate').textContent, 'Last updated: —');
});

test('keeps the newest timestamp query when responses arrive out of order', async () => {
    const { context, elements } = setup();
    const pending = [];
    context.client = {
        from() {
            return {
                select() { return this; }, not() { return this; }, order() { return this; }, limit() { return this; },
                maybeSingle() { return new Promise(resolve => pending.push(resolve)); }
            };
        }
    };
    vm.runInContext("activeAuthUserId = 'user'; supabaseClient = client", context);
    const first = vm.runInContext('refreshTransactionInsertDate()', context);
    const second = vm.runInContext('refreshTransactionInsertDate()', context);
    pending[1]({ data: { inserted_at: '2026-03-02T10:15:00Z' }, error: null });
    await second;
    pending[0]({ data: { inserted_at: '2026-03-01T10:15:00Z' }, error: null });
    await first;
    const expected = localTimestamp('2026-03-02T10:15:00Z');
    assert.equal(elements.get('transactionInsertDate').textContent, `Last updated: ${expected}`);
});

test('refreshes the insert date after transaction writes and deletes', async () => {
    const { context, elements } = setup();
    let timestamp = '2026-03-02T10:15:00Z';
    context.client = {
        from() {
            return {
                upsert() { return this; }, select() { return this; }, single: async () => ({ data: {}, error: null }),
                delete() { return this; }, eq: async () => ({ error: null }),
                not() { return this; }, order() { return this; }, limit() { return this; },
                async maybeSingle() { return { data: { inserted_at: timestamp }, error: null }; }
            };
        }
    };
    vm.runInContext("activeAuthUserId = 'user'; supabaseClient = client; rowToSupabaseData = () => ({})", context);
    await vm.runInContext('apiSaveRow({})', context);
    await new Promise(resolve => setImmediate(resolve));
    const format = localTimestamp;
    assert.equal(elements.get('transactionInsertDate').textContent, `Last updated: ${format(timestamp)}`);
    timestamp = '2026-03-01T10:15:00Z';
    await vm.runInContext("apiDeleteRow('id')", context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.get('transactionInsertDate').textContent, `Last updated: ${format(timestamp)}`);
});

test('round-trips full transaction dates and rejects invalid calendar dates without mutating edits', () => {
    const { context } = setup();
    context.record = { id: 'existing', transaction_date: '2024-02-29', amount: -10, category: 'Food' };
    vm.runInContext('row = supabaseDataToRow(record)', context);
    assert.equal(vm.runInContext('row.Date', context), '2024-02-29');
    assert.equal(vm.runInContext('rowToSupabaseData(row).transaction_date', context), '2024-02-29');
    assert.equal(vm.runInContext("updateDrawerRowDate(row, '2026-02-29')", context), false);
    assert.equal(vm.runInContext('row.Date', context), '2024-02-29');
    assert.equal(vm.runInContext("updateDrawerRowDate(row, '2025-12-31')", context), true);
    assert.equal(vm.runInContext('row.DateSortKey', context), 20251231);
    assert.equal(vm.runInContext('row.Month', context), 12);
    assert.equal(vm.runInContext('row.Year', context), 2025);
    assert.equal(vm.runInContext('rowToSupabaseData(row).transaction_date', context), '2025-12-31');
    for (const date of ['2023-02-29', '1900-02-29', '2026-04-31', '0000-01-01', '29/02/2024']) {
        context.date = date;
        assert.equal(vm.runInContext('isValidIsoDate(date)', context), false);
        assert.throws(() => vm.runInContext('rowToSupabaseData({Date: date})', context), /Invalid transaction date/);
    }
    assert.equal(vm.runInContext("isValidIsoDate('2000-02-29')", context), true);
    assert.equal(vm.runInContext("isValidIsoDate('0099-01-01')", context), true);
});

test('formats timestamps in local time across a UTC day boundary', () => {
    const script = `${fs.readFileSync(path.join(__dirname, '..', 'date-utils.js'), 'utf8')}
        console.log(formatLocalDateTime(new Date('2026-01-01T02:03:04Z'), true));`;
    const result = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '2025-12-31 18:03:04');
});
