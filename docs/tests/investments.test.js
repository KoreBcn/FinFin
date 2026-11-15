const { test } = require('node:test');
const assert = require('node:assert/strict');

global.document = { getElementById: () => ({ addEventListener() {} }) };
const investments = require('../investments.js');

const item = (id, inScope = true) => ({
    id, ticker: id, platform: 'Broker', name: 'Acme', type: 'Shares',
    is_in_scope: inScope, current_value_dkk: null
});
const transaction = (id, action, quantity, total_cost, fees = '') => ({
    portfolio_item_id: id, action, quantity, total_cost, fees
});

test('aggregates stored trades and flags other actions', () => {
    const [position] = investments.fromStored([item('ABC')], [
        transaction('ABC', 'Buy', '2,5', '-1.000,25', '-5,0'),
        transaction('ABC', 'Sell', '0,5', '300,0', '-1,0'),
        transaction('ABC', 'Dividend', '', '20,0'),
        transaction('ABC', 'Recieve', '1,0', '0')
    ]);
    assert.equal(position.quantity, 2);
    assert.equal(position.bought, -1000.25);
    assert.equal(position.sold, 300);
    assert.equal(position.fees, -6);
    assert.equal(position.dividends, 20);
    assert.deepEqual(position.other, ['Recieve']);
    assert.equal(investments.defaultSymbol(position), '');
});

test('keeps in-scope items with missing trades and excludes out-of-scope items', () => {
    const positions = investments.fromStored([item('manual'), item('invalid'), item('hidden', false)], [
        transaction('invalid', 'Buy', 'not a number', '-100'),
        transaction('hidden', 'Buy', '2', '-200')
    ]);
    assert.deepEqual(positions.map(p => p.ticker), ['manual', 'invalid']);
    assert.equal(positions[0].quantityUnknown, true);
    assert.equal(positions[1].quantityUnknown, true);
    assert.match(positions[1].other[0], /invalid or missing/);
});

test('rejects invalid stored cash amounts', () => {
    assert.throws(() => investments.fromStored([item('ABC')], [transaction('ABC', 'Buy', '1', 'invalid')]), /Total Cost/);
    assert.throws(() => investments.fromStored([item('ABC')], [transaction('ABC', 'Buy', '1', '')]), /Missing Total Cost/);
});

test('validates symbols and calculates history against a past close', () => {
    assert.equal(investments.defaultSymbol({ ticker: 'CPH:NOVO-B' }), 'NOVO.B|XCSE');
    assert.equal(investments.defaultSymbol({ ticker: 'NASDAQ:MELI' }), 'MELI|XNGS');
    assert.equal(investments.defaultSymbol({ ticker: 'AMS:IEMM' }), 'IEMM|XAMS');
    assert.equal(investments.defaultSymbol({ ticker: 'ETH' }), 'ETH/USD');
    assert.equal(investments.defaultSymbol({ ticker: 'KCS' }), '');
    assert.deepEqual(investments.symbolParams('abc|xcse'), { symbol: 'ABC', mic_code: 'XCSE' });
    assert.throws(() => investments.symbolParams('ABC|bad exchange'), /SYMBOL/);
    assert.equal(investments.changeSince([{ datetime: '2026-01-03', close: '100' }], 110, 7, new Date('2026-01-10T12:00:00Z')).toFixed(2), '10.00');
    assert.equal(investments.changeSince([{ datetime: '2026-01-04', close: '100' }], 110, 7, new Date('2026-01-10T12:00:00Z')), null);
});
