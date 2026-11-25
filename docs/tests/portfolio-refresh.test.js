const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refreshPortfolio } = require('../../scripts/refresh-portfolio.js');

const config = { url: 'https://project.example', anonKey: 'anon', email: 'account@example.test', password: 'password' };
const item = (id, ticker, extra = {}) => ({
    id, ticker, platform: 'Broker', name: ticker, type: 'Shares', is_closed: false, is_in_scope: true,
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
    const historyPosts = [];
    const state = { failFx: false, limited: false, limitedFx: false, stale: false, changedReads: 0, closedHistory: [] };
    const fetcher = async (url, options) => {
        calls.push({ url, options });
        if (url.pathname === '/auth/v1/token') return Response.json({ access_token: 'session' });
        assert.equal(options.headers.Authorization, 'Bearer session');
        if (url.pathname === '/rest/v1/rpc/is_shared_meal_plan_member') return Response.json(true);
        if (url.pathname === '/rest/v1/portfolio_pnl_history') {
            if (options.method === 'POST') {
                const rows = JSON.parse(options.body);
                historyPosts.push({ rows, prefer: options.headers.Prefer });
                return Response.json(rows.map((_, index) => ({ id: index })));
            }
            return Response.json(state.closedHistory.map((id, index) => ({ id: index, portfolio_item_id: id })));
        }
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
        if (request.path === 'time_series') {
            if (state.failHistory) return Response.json({ error: 'No history' }, { status: 502 });
            const values = Array.from({ length: 140 }, (_, index) => ({
                datetime: new Date(Date.now() - index * 86400000).toISOString().slice(0, 10), close: '8'
            }));
            return Response.json({ values });
        }
        return Response.json({ close: 10, currency: request.params.symbol === 'DANISH' ? 'DKK' : 'USD', last_quote_at: 1700000000, percent_change: '1.5' });
    };
    const options = { fetcher, today: () => '2026-11-25', now: () => time, sleep: async delay => { delays.push(delay); time += delay; } };
    return { state, calls, saves, delays, historyPosts, options };
}

test('refreshes eligible positions with shared math, cached quotes and FX, and paced requests', async () => {
    const items = [item('one', 'DANISH'), item('two', 'US'), item('three', 'US'),
        item('manual', 'MANUAL', { type: 'Crowdlending' }), item('closed', 'OLD', { is_closed: true, is_in_scope: true })];
    const db = fixture(items, [transaction('one', '2,5'), transaction('two', '3'), transaction('three', '1')]);
    const result = await refreshPortfolio(config, db.options);
    assert.deepEqual(result, { refreshed: 3, eligible: 3, failures: [] });
    assert.deepEqual(db.delays, [8000, 8000, 8000, 8000]);
    assert.deepEqual(db.saves.map(save => [save.id, save.fields.current_value_dkk]), [
        ['one', 25], ['two', 210], ['three', 70]
    ]);
    assert.equal(db.saves[0].fields.market_change_today, 1.5);
    for (const days of [7, 30, 90]) assert.equal(db.saves[0].fields[`market_change_${days}d`], 25);
    assert.equal(db.saves[0].fields.market_price_at, '2023-11-14T22:13:20.000Z');
    assert.equal(db.saves[0].params.get('valuation_version'), 'eq.0');
    assert.equal(db.saves[0].params.get('is_closed'), 'eq.false');
    assert.deepEqual(db.calls.filter(call => call.url.pathname === '/functions/v1/market-data')
        .map(call => JSON.parse(call.options.body)), [
        { path: 'quote', params: { symbol: 'DANISH' } },
        { path: 'time_series', params: { symbol: 'DANISH', interval: '1day', outputsize: '140' } },
        { path: 'quote', params: { symbol: 'US' } },
        { path: 'time_series', params: { symbol: 'US', interval: '1day', outputsize: '140' } },
        { path: 'exchange_rate', params: { symbol: 'USD/DKK' } }
    ]);
});

test('saves the price and today change but keeps stored longer changes when history fails', async () => {
    const db = fixture([item('one', 'DANISH')], [transaction('one')]);
    db.state.failHistory = true;
    const result = await refreshPortfolio(config, db.options);
    assert.equal(result.refreshed, 1);
    assert.match(result.failures[0].message, /^History: /);
    assert.equal(db.saves[0].fields.market_change_today, 1.5);
    assert.equal('market_change_7d' in db.saves[0].fields, false);
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
    assert.equal(limitedFx.calls.filter(call => call.url.pathname === '/functions/v1/market-data').length, 3);
});

test('snapshots P/L for refreshed and crowdlending items and backfills each closed item once', async () => {
    const items = [item('one', 'DANISH'), item('manual', 'MANUAL', { type: 'Crowdlending', current_value_dkk: 150 }),
        item('closed', 'OLD', { is_closed: true, is_in_scope: true }), item('done', 'DONE', { is_closed: true })];
    const transactions = [transaction('one', '2'), transaction('manual', '1'),
        { ...transaction('closed'), transaction_date: '2024-03-01' }, { ...transaction('closed'), id: 'closed-sell', transaction_date: '2024-05-02', action: 'Sell', total_cost: '130' },
        { ...transaction('done'), transaction_date: '2023-01-01' }];
    const db = fixture(items, transactions);
    db.state.closedHistory = ['done'];
    const result = await refreshPortfolio(config, db.options);
    assert.deepEqual(result.failures, []);
    assert.equal(db.historyPosts.length, 2);
    const [open, closed] = db.historyPosts;
    assert.match(open.prefer, /merge-duplicates/);
    assert.deepEqual(open.rows.map(row => [row.portfolio_item_id, row.snapshot_date, row.quantity, row.market_price, row.value_dkk, row.pnl_dkk]), [
        ['one', '2026-11-25', 2, 10, 20, -80], ['manual', '2026-11-25', null, null, 150, 50]
    ]);
    assert.match(closed.prefer, /ignore-duplicates/);
    assert.deepEqual(closed.rows.map(row => [row.portfolio_item_id, row.snapshot_date, row.is_closed, row.pnl_dkk]), [
        ['closed', '2024-05-02', true, 30]
    ]);
});

test('does not snapshot items whose value could not be refreshed', async () => {
    const db = fixture([item('one', 'US')], [transaction('one')]);
    db.state.failFx = true;
    await refreshPortfolio(config, db.options);
    assert.equal(db.historyPosts.length, 0);
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

test('identifies sign-in failures without exposing response details', async () => {
    const fetcher = async () => Response.json({
        error_code: 'invalid_credentials', message: 'private response'
    }, { status: 400 });
    await assert.rejects(refreshPortfolio(config, { fetcher }), error => {
        assert.match(error.message, /Supabase sign-in failed: invalid email or password \(HTTP 400\)/);
        assert.doesNotMatch(error.message, /private response/);
        return true;
    });
});

test('identifies portfolio read failures without exposing response details', async () => {
    const fetcher = async url => url.pathname === '/auth/v1/token'
        ? Response.json({ access_token: 'session' })
        : url.pathname === '/rest/v1/rpc/is_shared_meal_plan_member'
            ? Response.json(true)
            : Response.json({ message: 'private response' }, { status: 400 });
    await assert.rejects(refreshPortfolio(config, { fetcher }), error => {
        assert.match(error.message, /Supabase portfolio items request failed \(HTTP 400\)/);
        assert.doesNotMatch(error.message, /private response/);
        return true;
    });
});

test('rejects a refresh account outside the household before loading positions', async () => {
    const calls = [];
    const fetcher = async url => {
        calls.push(url.pathname);
        return Response.json(url.pathname === '/auth/v1/token' ? { access_token: 'session' } : false);
    };
    await assert.rejects(refreshPortfolio(config, { fetcher }), /not a Meal Plan household member/);
    assert.deepEqual(calls, ['/auth/v1/token', '/rest/v1/rpc/is_shared_meal_plan_member']);
});

test('does not report sign-in rate limiting as a market data failure', async () => {
    const fetcher = async () => Response.json({ error: 'rate limited' }, { status: 429 });
    await assert.rejects(refreshPortfolio(config, { fetcher }), /Supabase sign-in failed \(HTTP 429\)/);
});
