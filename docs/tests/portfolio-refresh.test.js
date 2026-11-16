const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refreshPortfolio } = require('../../scripts/refresh-portfolio.js');

const config = { url: 'https://project.example', anonKey: 'anon', email: 'account@example.test', password: 'password' };
const item = (id, ticker, extra = {}) => ({
    id, ticker, platform: 'Broker', name: ticker, type: 'Shares', is_in_scope: true,
    current_value_dkk: 75, valuation_version: 0, market_price: null, market_currency: null, market_price_at: null, ...extra
});
const transaction = (id, quantity = '2') => ({
    id: `${id}-tx`, portfolio_item_id: id, action: 'Buy', quantity, fees: '', total_cost: '-100'
});

function fixture(items, transactions) {
    let time = 0;
    const calls = [];
    const saves = [];
    const delays = [];
    const state = { failFx: false, limited: false, limitedFx: false, stale: false, changedReads: 0 };
    const fetcher = async (url, options) => {
        calls.push({ url, options });
        if (url.pathname === '/auth/v1/token') return Response.json({ access_token: 'session' });
        assert.equal(options.headers.Authorization, 'Bearer session');
        if (url.pathname === '/rest/v1/portfolio_items' && options.method === 'PATCH') {
            const id = url.searchParams.get('id').slice(3);
            saves.push({ id, fields: JSON.parse(options.body), params: url.searchParams });
            return Response.json(state.stale ? [] : [{ id }]);
        }
        if (url.pathname === '/rest/v1/portfolio_items') {
            if (state.changedReads > 0) {
                state.changedReads--;
                return Response.json(items.map(entry => ({ ...entry, valuation_version: entry.valuation_version + 1 })));
            }
            return Response.json(items);
        }
        if (url.pathname === '/rest/v1/portfolio_transactions') return Response.json(transactions);
        assert.equal(url.pathname, '/functions/v1/market-data');
        const request = JSON.parse(options.body);
        if (state.limited) return Response.json({ error: 'Yahoo Finance returned HTTP 429 (rate limited).' }, { status: 502 });
        if (request.path === 'exchange_rate') {
            if (state.limitedFx) return Response.json({ error: 'Yahoo Finance returned HTTP 429 (rate limited).' }, { status: 502 });
            if (state.failFx) return Response.json({ error: 'Unavailable' }, { status: 502 });
            return Response.json({ rate: 7 });
        }
        return Response.json({ close: 10, currency: request.params.symbol === 'DANISH' ? 'DKK' : 'USD', last_quote_at: 1700000000 });
    };
    const options = { fetcher, now: () => time, sleep: async delay => { delays.push(delay); time += delay; } };
    return { state, calls, saves, delays, options };
}

test('refreshes eligible positions with shared math, cached quotes and FX, and paced requests', async () => {
    const items = [item('one', 'DANISH'), item('two', 'US'), item('three', 'US'),
        item('manual', 'MANUAL', { type: 'Crowdlending' }), item('closed', 'OLD', { is_in_scope: false })];
    const db = fixture(items, [transaction('one', '2,5'), transaction('two', '3'), transaction('three', '1')]);
    const result = await refreshPortfolio(config, db.options);
    assert.deepEqual(result, { refreshed: 3, eligible: 3, failures: [] });
    assert.deepEqual(db.delays, [8000, 8000]);
    assert.deepEqual(db.saves.map(save => [save.id, save.fields.current_value_dkk]), [
        ['one', 25], ['two', 210], ['three', 70]
    ]);
    assert.equal(db.saves[0].fields.market_price_at, '2023-11-14T22:13:20.000Z');
    assert.equal(db.saves[0].params.get('valuation_version'), 'eq.0');
    assert.equal(db.saves[0].params.get('is_in_scope'), 'eq.true');
    assert.deepEqual(db.calls.filter(call => call.url.pathname === '/functions/v1/market-data')
        .map(call => JSON.parse(call.options.body)), [
        { path: 'quote', params: { symbol: 'DANISH' } },
        { path: 'quote', params: { symbol: 'US' } },
        { path: 'exchange_rate', params: { symbol: 'USD/DKK' } }
    ]);
});

test('saves only the quote when quantity is unknown or conversion fails', async () => {
    const db = fixture([item('unknown', 'US'), item('fx', 'US')], [transaction('unknown', 'bad'), transaction('fx')]);
    db.state.failFx = true;
    const result = await refreshPortfolio(config, db.options);
    assert.equal(result.refreshed, 2);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].id, 'fx');
    assert.equal('current_value_dkk' in db.saves[0].fields, false);
    assert.equal('current_value_dkk' in db.saves[1].fields, false);
});

test('does not save a stale valuation and stops when the provider rate limits', async () => {
    const stale = fixture([item('one', 'DANISH')], [transaction('one')]);
    stale.state.stale = true;
    const rejected = await refreshPortfolio(config, stale.options);
    assert.equal(rejected.refreshed, 0);
    assert.match(rejected.failures[0].message, /changed during refresh/);

    const limited = fixture([item('one', 'US'), item('two', 'DANISH')], [transaction('one'), transaction('two')]);
    limited.state.limited = true;
    const stopped = await refreshPortfolio(config, limited.options);
    assert.equal(stopped.refreshed, 0);
    assert.match(stopped.failures[0].message, /rate limited/);
    assert.equal(limited.calls.filter(call => call.url.pathname === '/functions/v1/market-data').length, 1);
    assert.equal(limited.saves.length, 0);

    const limitedFx = fixture([item('one', 'US'), item('two', 'DANISH')], [transaction('one'), transaction('two')]);
    limitedFx.state.limitedFx = true;
    const stoppedFx = await refreshPortfolio(config, limitedFx.options);
    assert.equal(stoppedFx.refreshed, 1);
    assert.match(stoppedFx.failures[0].message, /rate limited/);
    assert.equal(limitedFx.saves.length, 1);
    assert.equal('current_value_dkk' in limitedFx.saves[0].fields, false);
    assert.equal(limitedFx.calls.filter(call => call.url.pathname === '/functions/v1/market-data').length, 2);
});

test('retries when transactions may have changed during the initial read', async () => {
    const db = fixture([item('one', 'DANISH')], [transaction('one')]);
    db.state.changedReads = 1;
    const result = await refreshPortfolio(config, db.options);
    assert.equal(result.refreshed, 1);
    assert.equal(db.calls.filter(call => call.url.pathname === '/rest/v1/portfolio_transactions').length, 2);
});

test('rejects missing credentials and non-HTTPS project URLs before making requests', async () => {
    const db = fixture([], []);
    await assert.rejects(refreshPortfolio({ ...config, password: '' }, db.options), /Missing Supabase/);
    await assert.rejects(refreshPortfolio({ ...config, url: 'http://project.example' }, db.options), /HTTPS/);
    assert.equal(db.calls.length, 0);
});
