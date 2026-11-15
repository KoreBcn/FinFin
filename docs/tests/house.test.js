const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bankInstallments, bankInterest, calculate, monthlyHistory } = require('../house.js');

test('matches actual bank payments and treats incoming transfers as refunds', () => {
    const rows = [
        { Comments: '  transfer reference  ', PlannedReal: 'Real', Amount: -100, Date: '01/01/26', DateSortKey: 20260101 },
        { Comments: 'TRANSFER REFERENCE', PlannedReal: 'Real', Amount: 20, Date: '02/01/26', DateSortKey: 20260102 },
        { Comments: 'transfer reference', PlannedReal: 'Planned', Amount: -50 },
        { Comments: 'other transfer reference', PlannedReal: 'Real', Amount: -50 }
    ];
    const payments = bankInstallments(rows, 'transfer reference');
    assert.deepEqual(payments.map(item => item.amount), [100, -20]);
    assert.deepEqual(payments.map(item => item.source), ['Bank installment', 'Bank refund']);
    assert.throws(() => bankInstallments([{ Comments: 'transfer reference', PlannedReal: 'Real', Amount: NaN }], 'transfer reference'), /invalid amount/);
});

test('matches actual interest transactions by text and preserves their signs', () => {
    const rows = [
        { Comments: 'Bank INTEREST reference fee', PlannedReal: 'Real', Amount: -100, Date: '01/01/26', DateSortKey: 20260101 },
        { Comments: 'interest reference refund', PlannedReal: 'Real', Amount: 20, Date: '02/01/26', DateSortKey: 20260102 },
        { Comments: 'interest reference', PlannedReal: 'Planned', Amount: -50 },
        { Comments: 'other', PlannedReal: 'Real', Amount: -50 }
    ];
    const interest = bankInterest(rows, 'interest reference');
    assert.deepEqual(interest.map(item => item.amount), [-100, 20]);
    assert.deepEqual(interest.map(item => item.source), ['Interest / adjustment', 'Interest / adjustment']);
    assert.throws(() => bankInterest([{ Comments: 'interest reference', PlannedReal: 'Real', Amount: NaN }], 'interest reference'), /invalid amount/);
});

test('calculates equity and debt while capping only the house graphic', () => {
    const amounts = [{ amount: 800000 }, { amount: 50000 }];
    const result = calculate(6100000, 6100000, amounts);
    assert.equal(result.equity, 850000);
    assert.equal(result.debt, 5250000);
    assert.equal(result.fraction, 850000 / 6100000);
    assert.ok(Math.abs((300 - result.fillTop) * 280 / 72800 - result.fraction) < 1e-12);
    const appreciated = calculate(7100000, 6100000, amounts);
    assert.equal(appreciated.equity, 1850000);
    assert.equal(appreciated.debt, 5250000);
    const depreciated = calculate(5000000, 6100000, amounts);
    assert.equal(depreciated.equity, -250000);
    assert.equal(depreciated.debt, 5250000);
    assert.equal(depreciated.fillTop, 300);
    const roof = calculate(100, 6100000, [{ amount: 6099990 }]);
    assert.ok(Math.abs(1 - (280 * roof.fillTop ** 2 / 160) / 72800 - 0.9) < 1e-12);
    const overpaid = calculate(100, 6100000, [{ amount: 6100020 }]);
    assert.equal(overpaid.equity, 120);
    assert.equal(overpaid.debt, -20);
    assert.equal(overpaid.fraction, 1.2);
    assert.equal(overpaid.fillTop, 0);
});

test('builds a continuous monthly history using every signed equity entry', () => {
    const history = monthlyHistory([
        { sortKey: 20260304, amount: -20, date: '04/03/26', source: 'Refund' },
        { sortKey: 20260120, amount: 100, date: '20/01/26', source: 'Payment' },
        { sortKey: 20260110, amount: 200, date: '10/01/26', source: 'Initial payment' }
    ], 1200, 1000, new Date(2026, 3, 10));
    assert.deepEqual(history.map(row => row.month), ['2026-01', '2026-02', '2026-03', '2026-04']);
    assert.deepEqual(history.map(row => row.equity), [500, 500, 480, 480]);
    assert.deepEqual(history.map(row => row.debt), [700, 700, 720, 720]);
    assert.deepEqual(history[0].entries.map(row => row.source), ['Initial payment', 'Payment']);
    const future = monthlyHistory([{ sortKey: 20270201, amount: 10 }], 1200, 1000, new Date(2026, 3, 10));
    assert.deepEqual(future.map(row => row.month), ['2027-02']);
    assert.deepEqual(monthlyHistory([], 1200, 1000, new Date(2026, 3, 10)), []);
    assert.throws(() => monthlyHistory([{ sortKey: 20260230, amount: 1 }], 1200, 1000, new Date()), /invalid date/);
});

test('accumulates signed interest across the full timeline, including refunds', () => {
    const history = monthlyHistory(
        [{ sortKey: 20260110, amount: 300 }],
        1200, 1000, new Date(2026, 2, 1),
        [
            { sortKey: 20251210, amount: -20 },
            { sortKey: 20260210, amount: -10 },
            { sortKey: 20260212, amount: 5 },
            { sortKey: 20260401, amount: 2 }
        ]
    );
    assert.deepEqual(history.map(row => row.month), ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04']);
    assert.deepEqual(history.map(row => row.equity), [200, 500, 500, 500, 500]);
    assert.deepEqual(history.map(row => row.interest), [20, 20, 25, 25, 23]);
    const netRefund = monthlyHistory([], 1200, 1000, new Date(2026, 0, 10), [
        { sortKey: 20260101, amount: -10 }, { sortKey: 20260102, amount: 20 }
    ]);
    assert.equal(netRefund[0].interest, -10);
    assert.throws(
        () => monthlyHistory([], 1200, 1000, new Date(), [{ sortKey: 20260230, amount: -1 }]),
        /interest entry has an invalid date/
    );
});
