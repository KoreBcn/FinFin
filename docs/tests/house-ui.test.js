const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(configRequest = async () => ({
    data: { installment_concept: 'reference', interest_concept: 'interest' }, error: null
}), initialRows = [], { withMortgage = true } = {}) {
    class Element {
        constructor() {
            this.children = [];
            this.value = '';
            this.validity = { valid: true };
            this.listeners = {};
            this.classList = { toggle() {} };
            this.style = { setProperty(name, value) { this[name] = value; } };
        }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        setAttribute(name, value) { this[name] = value; }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; }
        select() {}
        showModal() { this.open = true; }
        close() { this.open = false; }
        reset() {}
        checkValidity() { return true; }
    }
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id);
        },
        createElement() { return new Element(); }
    };
    elements.set('houseValue', new Element());
    elements.get('houseValue').value = '6,100,000';
    elements.set('houseInstallmentDate', new Element());
    elements.set('houseInstallmentAmount', new Element());
    elements.set('houseGraphButton', new Element());
    elements.get('houseGraphButton').setAttribute('aria-pressed', 'true');
    elements.set('houseInstallmentsButton', new Element());
    elements.get('houseInstallmentsButton').setAttribute('aria-pressed', 'false');
    elements.set('houseHistory', new Element());
    elements.get('houseHistory').hidden = false;
    elements.set('houseTableView', new Element());
    elements.get('houseTableView').hidden = true;
    elements.set('houseAddInstallment', new Element());
    elements.get('houseAddInstallment').hidden = true;
    const rows = initialRows.map(row => ({
        ...row, entry_type: row.entry_type || (row.id === 'initial' ? 'initial_payment' : 'regular')
    }));
    if (withMortgage) {
        rows.push({ id: 'mortgage', entry_date: '1900-01-01', amount: rows.some(row => row.id === 'initial') ? -5300000 : -6100000, concept: 'Mortgage', entry_type: 'mortgage_component' });
    }
    const database = { rows, nextId: 1, loadError: null, saveError: null, deleteError: null };
    const supabaseClient = {
        from(table) {
            if (table === 'house_config') {
                return {
                    select(columns) {
                        assert.equal(columns, 'installment_concept, interest_concept');
                        return this;
                    },
                    eq(field, value) {
                        assert.equal(field, 'id');
                        assert.equal(value, true);
                        return this;
                    },
                    maybeSingle: configRequest
                };
            }
            assert.equal(table, 'house_installments');
            let operation = 'read';
            let payload;
            let id;
            return {
                select(columns) {
                    if (operation !== 'delete') assert.equal(columns, 'id, entry_date, amount, concept, entry_type');
                    return this;
                },
                order() { return this; },
                range(from, to) {
                    if (database.loadError) return Promise.resolve({ error: { message: database.loadError } });
                    return Promise.resolve({ data: database.rows.slice(from, to + 1), error: null });
                },
                insert(value) { operation = 'insert'; payload = value; return this; },
                delete() { operation = 'delete'; return this; },
                eq(field, value) { assert.equal(field, 'id'); id = value; return this; },
                single() {
                    if (operation === 'insert') {
                        if (database.saveError) return Promise.resolve({ error: { message: database.saveError } });
                        const row = { entry_type: 'regular', ...payload, id: `saved-${database.nextId++}` };
                        database.rows.push(row);
                        return Promise.resolve({ data: row, error: null });
                    }
                    if (database.deleteError) return Promise.resolve({ error: { message: database.deleteError } });
                    const row = database.rows.find(item => item.id === id);
                    if (!row) return Promise.resolve({ error: { message: 'Not found' } });
                    database.rows = database.rows.filter(item => item.id !== id);
                    return Promise.resolve({ data: { id }, error: null });
                }
            };
        }
    };
    class Chart {
        constructor(canvas, config) {
            this.data = config.data;
            this.options = config.options;
            this.visibility = this.data.datasets.map(dataset => !dataset.hidden);
        }
        isDatasetVisible(index) { return this.visibility[index]; }
        setDatasetVisibility(index, visible) { this.visibility[index] = visible; }
        update() {}
        destroy() { this.destroyed = true; }
    }
    let resizeObserver;
    class ResizeObserver {
        constructor(callback) { this.callback = callback; resizeObserver = this; }
        observe(element) { this.target = element; }
    }
    const context = vm.createContext({
        document, supabaseClient, activeAuthUserId: 'test', Chart, ResizeObserver, charts: {}, openInvestments() {}, renderPortfolioTransactions() {}, portfolioTransactionsVisible: false,
        chartGridColor: () => '#e2e8f0',
        rawData: [{ Comments: 'reference', PlannedReal: 'Real', Amount: -50000, Date: '2026-01-01', DateSortKey: 20260101 }],
        investmentFormat: (value, decimals = 2) => value.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'date-utils.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'house.js'), 'utf8'), context);
    return { context, elements, database, resizeObserver };
}

test('tracks the house illustration width for the compact chart layout', () => {
    const { elements, resizeObserver } = setup(async () => {});
    assert.equal(resizeObserver.target, elements.get('houseDiagram'));
    resizeObserver.callback([{ contentRect: { width: 258 } }]);
    assert.equal(elements.get('houseHistoryChartWrap').style['--house-diagram-width'], '258px');
    resizeObserver.callback([{ contentRect: { width: 0 } }]);
    assert.equal(elements.get('houseHistoryChartWrap').style['--house-diagram-width'], '258px');
});

test('switches to analytics and loads portfolio data without opening House', () => {
    const { context, elements } = setup();
    vm.runInContext("let portfolioOpens = 0; openInvestments = () => { portfolioOpens++; }; switchInvestmentSubtab('analytics')", context);
    assert.equal(elements.get('investmentAnalytics').hidden, false);
    assert.equal(elements.get('investmentPortfolio').hidden, true);
    assert.equal(elements.get('investmentHouse').hidden, true);
    assert.equal(elements.get('investmentAnalyticsTab')['aria-selected'], 'true');
    assert.equal(vm.runInContext('portfolioOpens', context), 1);
});

test('shows the shared portfolio panel for the Transactions subtab', () => {
    const { context, elements } = setup();
    vm.runInContext("let renders = 0; renderPortfolioTransactions = () => { renders++; }; switchInvestmentSubtab('transactions')", context);
    assert.equal(elements.get('investmentPortfolio').hidden, false);
    assert.equal(elements.get('investmentAnalytics').hidden, true);
    assert.equal(elements.get('investmentTransactionsTab')['aria-selected'], 'true');
    assert.equal(vm.runInContext('portfolioTransactionsVisible && renders', context), 1);
});

test('saves and deletes signed installments, retaining them after House reset', async () => {
    const { context, elements, database } = setup(undefined, [{ id: 'initial', entry_date: '2026-01-01', amount: 800000, concept: 'Initial payment' }]);
    await vm.runInContext('openHouse()', context);
    assert.equal(elements.get('houseEquity').textContent, '850,000');
    assert.equal(elements.get('houseInstallmentsBody').children[1].children[2].textContent, '800,000.00');
    assert.equal(elements.get('houseInstallmentsBody').children[1].children[1].textContent, 'Initial payment');
    assert.equal(elements.get('houseInstallmentsBody').children[1].children[0].textContent, '2026-01-01');
    assert.equal(elements.get('houseInstallmentsBody').children[1].children[2].className, 'house-amount-positive');
    assert.equal(elements.get('houseDebtPercent').textContent, '86.07%');
    assert.equal(elements.get('houseEquityPercent').textContent, '13.93%');
    elements.get('houseInstallmentsButton').listeners.click();
    const dialog = elements.get('houseInstallmentDialog');
    elements.get('houseAddInstallment').listeners.click();
    assert.equal(dialog.open, true);
    elements.get('houseCancelDialog').listeners.click();
    assert.equal(dialog.open, false);
    elements.get('houseAddInstallment').listeners.click();
    dialog.listeners.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(dialog.open, false);
    elements.get('houseAddInstallment').listeners.click();
    elements.get('houseInstallmentDate').value = '2026-03-01';
    elements.get('houseInstallmentAmount').value = '-100000';
    const form = elements.get('houseInstallmentForm');
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(dialog.open, false);
    assert.equal(elements.get('houseEquity').textContent, '750,000');
    assert.equal(elements.get('houseDebt').textContent, '5,350,000');
    assert.equal(database.rows[2].amount, -100000);
    assert.equal(database.rows[2].concept, 'Interest / Adjustment');
    assert.equal(elements.get('houseInstallmentsBody').children[0].children[1].textContent, 'Interest / Adjustment');
    assert.equal(elements.get('houseInstallmentsBody').children[0].children[2].className, 'house-amount-negative');
    elements.get('houseAddInstallment').listeners.click();
    elements.get('houseInstallmentDate').value = '2026-03-02';
    elements.get('houseInstallmentAmount').value = '100';
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(database.rows[3].concept, 'Bank installment');
    assert.equal(elements.get('houseInstallmentsBody').children[0].children[1].textContent, 'Bank installment');
    await vm.runInContext('deleteHouseInstallment("saved-2")', context);
    elements.get('houseValue').value = '7100000';
    vm.runInContext('renderHouse()', context);
    assert.equal(elements.get('houseDebt').textContent, '5,350,000');
    assert.equal(elements.get('houseEquity').textContent, '1,750,000');
    elements.get('houseValue').value = '500000';
    vm.runInContext('renderHouse()', context);
    assert.equal(elements.get('houseEquity').textContent, '-4,850,000');
    assert.match(elements.get('houseValueStatus').textContent, /capped/);
    vm.runInContext('clearHouse()', context);
    assert.equal(elements.get('houseValue').value, '6,100,000');
    assert.equal(vm.runInContext('houseStoredInstallments.length', context), 0);
    await vm.runInContext('openHouse()', context);
    assert.equal(elements.get('houseEquity').textContent, '750,000');
    elements.get('houseInstallmentsButton').listeners.click();
    await vm.runInContext('deleteHouseInstallment("saved-1")', context);
    assert.equal(elements.get('houseEquity').textContent, '850,000');
    assert.equal(database.rows.length, 2);
});

test('rejects invalid installment dates and saves a valid leap day unchanged', async () => {
    const { context, elements, database } = setup();
    await vm.runInContext('openHouse()', context);
    const form = elements.get('houseInstallmentForm');
    elements.get('houseInstallmentAmount').value = '100';
    elements.get('houseInstallmentDate').value = '2023-02-29';
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.match(elements.get('houseFormStatus').textContent, /YYYY-MM-DD/);
    assert.equal(database.rows.length, 1);
    elements.get('houseInstallmentDate').value = '2024-02-29';
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(database.rows[1].entry_date, '2024-02-29');
    assert.ok(elements.get('houseInstallmentsBody').children.some(row => row.children[0].textContent === '2024-02-29'));
});

test('updates monthly history for saves, value changes and resets', async () => {
    const { context, elements } = setup(undefined, [{ id: 'initial', entry_date: '2026-01-01', amount: 800000, concept: 'Initial payment' }]);
    await vm.runInContext('openHouse()', context);
    const graph = elements.get('houseGraphButton');
    const installments = elements.get('houseInstallmentsButton');
    assert.equal(graph['aria-pressed'], 'true');
    assert.equal(installments['aria-pressed'], 'false');
    assert.equal(elements.get('houseHistory').hidden, false);
    assert.equal(elements.get('houseTableView').hidden, true);
    assert.equal(elements.get('houseAddInstallment').hidden, true);
    assert.equal(elements.get('houseLoadStatus').textContent, '');
    let chart = vm.runInContext('charts.houseHistory', context);
    graph.listeners.click();
    assert.equal(vm.runInContext('charts.houseHistory', context), chart);
    assert.equal(chart.data.datasets[2].label, 'Interest');
    assert.equal(chart.data.datasets[2].borderColor, '#ef4444');
    assert.equal(chart.data.datasets[2].yAxisID, 'y');
    assert.deepEqual(Array.from(Object.keys(chart.options.scales)), ['x', 'y']);
    assert.equal(chart.isDatasetVisible(2), false);
    chart.setDatasetVisibility(2, true);
    assert.equal(chart.options.scales.y.ticks.callback(5500000), '5.5M');
    assert.equal(chart.options.scales.y.ticks.callback(-500000), '-0.5M');
    assert.equal(chart.options.scales.y.ticks.callback(0), '0M');
    assert.equal(chart.options.scales.y.ticks.precision, 0);
    const january = chart.data.labels.indexOf('2026-01');
    assert.equal(chart.data.datasets[0].data[january], 850000);
    assert.equal(chart.data.datasets[1].data[january], 5250000);
    assert.equal(chart.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: january, datasetIndex: 0 }]).length, 2);
    assert.match(elements.get('houseHistoryChart')['aria-label'], /2026-01: equity 850,000.00, debt 5,250,000.00/);
    assert.equal(elements.has('houseHistoryDetails'), false);
    assert.equal(elements.has('houseHistoryBody'), false);

    installments.listeners.click();
    assert.equal(chart.destroyed, true);
    assert.equal(graph['aria-pressed'], 'false');
    assert.equal(installments['aria-pressed'], 'true');
    installments.listeners.click();
    assert.equal(elements.get('houseTableView').hidden, false);
    assert.equal(elements.get('houseAddInstallment').hidden, false);
    elements.get('houseInstallmentDate').value = '2026-03-01';
    elements.get('houseInstallmentAmount').value = '-100000';
    const form = elements.get('houseInstallmentForm');
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    graph.listeners.click();
    chart = vm.runInContext('charts.houseHistory', context);
    assert.equal(chart.isDatasetVisible(2), true);
    const march = chart.data.labels.indexOf('2026-03');
    assert.equal(chart.data.datasets[0].data[march], 750000);
    assert.equal(chart.data.datasets[1].data[march], 5350000);
    assert.equal(chart.data.datasets[2].data[march], 100000);
    assert.equal(chart.options.plugins.tooltip.callbacks.afterBody([
        { dataIndex: march, datasetIndex: 0 }, { dataIndex: march, datasetIndex: 2 }
    ]).length, 1);
    elements.get('houseValue').value = '7100000';
    vm.runInContext('renderHouse()', context);
    assert.equal(chart.isDatasetVisible(2), true);
    assert.equal(chart.data.datasets[0].data[march], 1750000);
    assert.equal(chart.data.datasets[1].data[march], 5350000);
    installments.listeners.click();
    await vm.runInContext('deleteHouseInstallment("saved-1")', context);
    graph.listeners.click();
    chart = vm.runInContext('charts.houseHistory', context);
    assert.equal(chart.data.datasets[0].data.at(-1), 1850000);
    vm.runInContext('clearHouse()', context);
    assert.equal(chart.destroyed, true);
    assert.equal(graph['aria-pressed'], 'true');
    assert.equal(installments['aria-pressed'], 'false');
    assert.equal(elements.get('houseHistory').hidden, false);
    assert.equal(elements.get('houseTableView').hidden, true);
    assert.equal(elements.get('houseAddInstallment').hidden, true);
    assert.equal(elements.get('houseHistoryChartWrap').hidden, true);
    assert.equal(elements.get('houseHistoryChart')['aria-label'], 'Monthly equity, debt and cumulative interest in DKK');
    await vm.runInContext('openHouse()', context);
    assert.equal(vm.runInContext('charts.houseHistory.isDatasetVisible(2)', context), false);
});

test('reports when the chart library is unavailable', async () => {
    const { context, elements } = setup(undefined);
    vm.runInContext('Chart = undefined', context);
    await vm.runInContext('openHouse()', context);
    assert.match(elements.get('houseHistoryStatus').textContent, /Chart unavailable/);
    assert.equal(elements.get('houseHistoryChartWrap').hidden, true);
    elements.get('houseInstallmentsButton').listeners.click();
    assert.equal(elements.get('houseTableView').hidden, false);
});

test('reports invalid history dates without hiding current totals', async () => {
    const { context, elements } = setup(undefined);
    vm.runInContext('rawData[0].DateSortKey = 0', context);
    await vm.runInContext('openHouse()', context);
    assert.match(elements.get('houseHistoryStatus').textContent, /invalid date/);
    assert.equal(elements.get('houseEquity').textContent, '50,000');
    assert.equal(elements.get('houseHistoryChartWrap').hidden, true);
});

test('handles no installments without a hardcoded initial payment', async () => {
    const { context, elements } = setup(undefined, [], { withMortgage: false });
    vm.runInContext('rawData = []', context);
    await vm.runInContext('openHouse()', context);
    assert.equal(elements.get('houseInstallmentsBody').children.length, 0);
    assert.equal(elements.get('housePageStatus').textContent, 'Page 1 of 1');
    assert.equal(elements.get('houseEquity').textContent, '—');
    assert.equal(elements.get('houseDebt').textContent, '—');
    assert.match(elements.get('houseLoadStatus').textContent, /mortgage components/);
});

test('aggregates mortgage components without treating them as equity payments or interest', async () => {
    const rows = [
        { id: 'initial', entry_date: '2026-01-01', amount: 800000, concept: 'Initial payment', entry_type: 'initial_payment' },
        { id: 'loan', entry_date: '2026-01-30', amount: -5249999.50, concept: 'Loan', entry_type: 'mortgage_component' },
        { id: 'fees', entry_date: '2026-01-30', amount: -50000.50, concept: 'Fees', entry_type: 'mortgage_component' },
        { id: 'interest', entry_date: '2026-02-01', amount: -30, concept: 'Interest', entry_type: 'regular' }
    ];
    const { context, elements } = setup(undefined, rows, { withMortgage: false });
    await vm.runInContext('openHouse()', context);
    assert.equal(elements.get('houseMortgage').textContent, '6,100,000.00');
    assert.equal(elements.get('houseEquity').textContent, '849,970');
    assert.equal(elements.get('houseDebt').textContent, '5,250,030');
    assert.equal(elements.get('houseInterestTotal').textContent, '-30.00 DKK');
    assert.equal(elements.get('houseInstallmentsBody').children.length, 5);
    const chart = vm.runInContext('charts.houseHistory', context);
    const january = chart.data.labels.indexOf('2026-01');
    assert.equal(chart.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: january, datasetIndex: 0 }]).length, 2);
    elements.get('houseInstallmentsButton').listeners.click();
    await vm.runInContext('deleteHouseInstallment("fees")', context);
    assert.equal(elements.get('houseMortgage').textContent, '6,049,999.50');
    assert.equal(elements.get('houseInterestTotal').textContent, '-30.00 DKK');
});

test('reports invalid saved concepts instead of inventing a label', async () => {
    const { context, elements } = setup(undefined, [{ id: 'invalid', entry_date: '2026-01-01', amount: 100, concept: null }]);
    await vm.runInContext('openHouse()', context);
    assert.match(elements.get('houseLoadStatus').textContent, /invalid data/);
    assert.equal(elements.get('houseEquity').textContent, '—');
});

test('formats whole house values while retaining validation and precision of calculations', async () => {
    const { context, elements } = setup(undefined, [{ id: 'initial', entry_date: '2026-01-01', amount: 800000, concept: 'Initial payment' }]);
    await vm.runInContext('openHouse()', context);
    const input = elements.get('houseValue');
    assert.equal(elements.get('houseMortgage').textContent, '6,100,000.00');
    input.listeners.focus();
    assert.equal(input.value, '6100000');
    input.value = '7100000';
    input.listeners.input();
    assert.equal(elements.get('houseEquity').textContent, '1,850,000');
    input.listeners.blur();
    assert.equal(input.value, '7,100,000');
    input.listeners.input();
    assert.equal(elements.get('houseEquity').textContent, '1,850,000');
    for (const invalid of ['0', '7.5', '7,10,000', '9007199254740992']) {
        input.value = invalid;
        input.listeners.input();
        assert.match(elements.get('houseValueStatus').textContent, /whole house value/);
        assert.equal(elements.get('houseEquity').textContent, '—');
    }
    input.value = '6100000';
    vm.runInContext('houseStoredInstallments.push({ amount: 0.75, source: "Manual", date: "", sortKey: 0 }); renderHouse()', context);
    assert.equal(elements.get('houseEquity').textContent, '850,001');
    assert.equal(elements.get('houseDebtPercent').textContent, '86.07%');
});

test('paginates combined entries without changing equity', async () => {
    const rows = [
        { id: 'initial', entry_date: '2026-01-01', amount: 800000, concept: 'Initial payment' },
        ...Array.from({ length: 22 }, (_, i) => ({
            id: `row-${i}`, entry_date: `2026-02-${String(i + 1).padStart(2, '0')}`, amount: 1000, concept: 'Payment'
        }))
    ];
    const { context, elements } = setup(undefined, rows);
    await vm.runInContext('openHouse()', context);
    elements.get('houseInstallmentsButton').listeners.click();
    assert.equal(elements.get('houseInstallmentsBody').children.length, 12);
    assert.equal(elements.get('houseInstallmentsBody').children[0].children[0].textContent, '2026-02-22');
    assert.equal(elements.get('housePageStatus').textContent, 'Page 1 of 3');
    const equity = elements.get('houseEquity').textContent;
    elements.get('houseNextPage').listeners.click();
    assert.equal(elements.get('houseInstallmentsBody').children.length, 12);
    assert.equal(elements.get('houseEquity').textContent, equity);
    elements.get('houseNextPage').listeners.click();
    assert.equal(elements.get('houseInstallmentsBody').children.length, 1);
    assert.equal(elements.get('houseInstallmentsBody').children[0].children[0].textContent, '1900-01-01');
    assert.equal(elements.get('housePageStatus').textContent, 'Page 3 of 3');
    await vm.runInContext('deleteHouseInstallment("row-21")', context);
    assert.equal(elements.get('housePageStatus').textContent, 'Page 2 of 2');
});

test('combines bank interest and saved negative adjustments in the KPI on every page', async () => {
    const rows = [
        { id: 'initial', entry_date: '2026-01-01', amount: 800000, concept: 'Initial payment' },
        { id: 'negative', entry_date: '2026-02-01', amount: -30, concept: 'Custom adjustment' },
        { id: 'positive', entry_date: '2026-02-02', amount: 500, concept: 'Payment' },
        ...Array.from({ length: 10 }, (_, i) => ({
            id: `row-${i}`, entry_date: `2026-02-${String(i + 3).padStart(2, '0')}`, amount: 100, concept: 'Payment'
        }))
    ];
    const { context, elements } = setup(undefined, rows);
    vm.runInContext(`rawData.push(
        { Comments: 'reference', PlannedReal: 'Real', Amount: 5000, Date: '2026-01-02', DateSortKey: 20260102 },
        { Comments: 'bank interest fee', PlannedReal: 'Real', Amount: -100, Date: '2026-01-03', DateSortKey: 20260103 },
        { Comments: 'interest refund', PlannedReal: 'Real', Amount: 20, Date: '2026-01-04', DateSortKey: 20260104 },
        { Comments: 'interest planned', PlannedReal: 'Planned', Amount: -200, Date: '2026-01-05', DateSortKey: 20260105 }
    )`, context);
    await vm.runInContext('openHouse()', context);
    assert.equal(elements.get('houseInterestTotal').textContent, '-110.00 DKK');
    assert.equal(elements.get('houseEquity').textContent, '846,470');
    assert.equal(elements.get('houseDebt').textContent, '5,253,530');
    assert.equal(elements.get('houseInstallmentsBody').children[11].children[1].textContent, 'Custom adjustment');
    const chart = vm.runInContext('charts.houseHistory', context);
    const january = chart.data.labels.indexOf('2026-01');
    assert.equal(chart.data.datasets[0].data[january], 845000);
    assert.equal(chart.data.datasets[2].data[january], 80);
    assert.equal(chart.data.datasets[2].data.at(-1), 110);
    assert.equal(chart.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: january, datasetIndex: 0 }]).length, 3);
    assert.equal(chart.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: january, datasetIndex: 2 }]).length, 2);
    elements.get('houseInstallmentsButton').listeners.click();
    elements.get('houseNextPage').listeners.click();
    assert.equal(elements.get('houseInterestTotal').textContent, '-110.00 DKK');
    assert.equal(elements.get('houseInstallmentsBody').children[1].children[1].textContent, 'Interest / adjustment');
    assert.equal(elements.get('houseInstallmentsBody').children[1].children[2].textContent, '-100.00');
    await vm.runInContext('deleteHouseInstallment("negative")', context);
    assert.equal(elements.get('houseInterestTotal').textContent, '-80.00 DKK');
    assert.equal(elements.get('houseEquity').textContent, '846,500');
    elements.get('houseValue').value = '0';
    vm.runInContext('renderHouse()', context);
    assert.equal(elements.get('houseInterestTotal').textContent, '-80.00 DKK');
});

test('reports load and save failures instead of showing incomplete totals', async () => {
    const { context, elements, database } = setup(undefined);
    database.loadError = 'load failed';
    await vm.runInContext('openHouse()', context);
    assert.match(elements.get('houseLoadStatus').textContent, /load failed/);
    assert.equal(elements.get('houseEquity').textContent, '—');
    assert.equal(elements.get('houseInterestTotal').textContent, '—');
    assert.equal(elements.get('houseRetryConfig').hidden, false);
    database.loadError = null;
    await vm.runInContext('openHouse()', context);
    elements.get('houseInstallmentsButton').listeners.click();
    elements.get('houseAddInstallment').listeners.click();
    database.saveError = 'save failed';
    elements.get('houseInstallmentDate').value = '2026-03-01';
    elements.get('houseInstallmentAmount').value = '100';
    const form = elements.get('houseInstallmentForm');
    await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(elements.get('houseInstallmentDialog').open, true);
    assert.match(elements.get('houseFormStatus').textContent, /save failed/);
    assert.match(elements.get('houseLoadStatus').textContent, /may have completed/);
    assert.equal(elements.get('houseEquity').textContent, '—');
});

test('reports configuration errors and retries without showing incomplete totals', async () => {
    let response = { data: null, error: { message: 'configuration unavailable' } };
    const { context, elements } = setup(async () => response);
    await vm.runInContext('openHouse()', context);
    assert.match(elements.get('houseLoadStatus').textContent, /configuration unavailable/);
    assert.equal(elements.get('houseEquity').textContent, '—');
    assert.equal(elements.get('houseRetryConfig').hidden, false);

    response = { data: null, error: null };
    await vm.runInContext('openHouse()', context);
    assert.match(elements.get('houseLoadStatus').textContent, /Set up the House configuration/);

    response = { data: { installment_concept: 'reference', interest_concept: 'REFERENCE' }, error: null };
    await vm.runInContext('openHouse()', context);
    assert.match(elements.get('houseLoadStatus').textContent, /must not overlap/);

    response = { data: { installment_concept: ' reference ', interest_concept: ' interest ' }, error: null };
    await vm.runInContext('openHouse()', context);
    assert.equal(elements.get('houseLoadStatus').textContent, '');
    assert.equal(elements.get('houseEquity').textContent, '50,000');
    assert.equal(elements.get('houseRetryConfig').hidden, true);
});

test('ignores a delayed configuration response after reset', async () => {
    let resolveConfig;
    const { context } = setup(() => new Promise(resolve => { resolveConfig = resolve; }));
    const pending = vm.runInContext('openHouse()', context);
    vm.runInContext('clearHouse()', context);
    resolveConfig({ data: { installment_concept: 'reference', interest_concept: 'interest' }, error: null });
    await pending;
    assert.equal(vm.runInContext('houseConcept', context), null);
});
