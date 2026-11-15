import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketData } from '../../supabase/functions/market-data/market-data.ts';

const request = body => new Request('https://example.test/market-data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const chart = (symbol, overrides = {}) => ({
    chart: { error: null, result: [{
        meta: { symbol, currency: 'DKK', regularMarketPrice: 110, chartPreviousClose: 100,
            regularMarketTime: 1767268800, exchangeTimezoneName: 'Europe/Copenhagen', ...overrides },
        timestamp: [1767268800, 1767355200, 1767441600],
        indicators: { quote: [{ close: [100, null, 110] }] }
    }] }
});

test('validates requests and rejects overriding provider parameters', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return Response.json({}); };
    for (const body of [
        { path: '../quote', params: { symbol: 'AAPL' } },
        { path: 'quote', params: { symbol: 'AAPL', apikey: 'override' } },
        { path: 'quote', params: { symbol: 'AAPL&apikey=bad' } },
        { path: 'quote', params: { symbol: '..' } },
        { path: 'time_series', params: { symbol: 'AAPL', interval: '1min', outputsize: '140' } },
        { path: 'quote', params: { symbol: 'OTHER', mic_code: 'XCSE' } },
        { path: 'exchange_rate', params: { symbol: 'ETH/USD' } }
    ]) {
        assert.equal((await marketData(request(body), fetcher)).status, 400);
    }
    assert.equal((await marketData(new Request('https://example.test/market-data'), fetcher)).status, 405);
    assert.equal(calls, 0);
});

test('passes each ticker unchanged and returns quote fields from the one-day chart', async () => {
    for (const symbol of ['MELI|XNGS', 'ETH/USD', '^GSPC', 'NOVO-B.CO', 'mELI']) {
        const response = await marketData(request({ path: 'quote', params: { symbol } }), async url => {
            assert.equal(url.hostname, 'query1.finance.yahoo.com');
            assert.equal(decodeURIComponent(url.pathname.split('/').at(-1)), symbol);
            assert.equal(url.searchParams.get('interval'), '1m');
            assert.equal(url.searchParams.get('range'), '1d');
            return Response.json(chart(symbol));
        });
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.close, 110);
        assert.equal(data.currency, 'DKK');
        assert.ok(Math.abs(data.percent_change - 10) < 1e-10);
        assert.equal(data.last_quote_at, 1767268800);
    }
});

test('converts exchange pairs to Yahoo tickers and validates the returned currency', async () => {
    const input = { path: 'exchange_rate', params: { symbol: 'USD/DKK' } };
    const ok = await marketData(request(input), async url => {
        assert.equal(decodeURIComponent(url.pathname.split('/').at(-1)), 'USDDKK=X');
        return Response.json(chart('USDDKK=X'));
    });
    assert.deepEqual(await ok.json(), { rate: 110 });
    const invalid = await marketData(request(input), async () => Response.json(chart('USDDKK=X', { currency: 'USD' })));
    assert.equal(invalid.status, 502);
});

test('uses query2 once after a 429 with the same request and no credentials', async () => {
    const calls = [];
    const response = await marketData(request({ path: 'quote', params: { symbol: 'NOVO-B.CO' } }),
        async (url, options) => {
            calls.push({ url: new URL(url), options });
            return calls.length === 1 ? new Response('', { status: 429 }) : Response.json(chart('NOVO-B.CO'));
        });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).close, 110);
    assert.deepEqual(calls.map(call => call.url.hostname), ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']);
    assert.equal(calls[0].url.pathname + calls[0].url.search, calls[1].url.pathname + calls[1].url.search);
    for (const { url, options } of calls) {
        assert.deepEqual([...url.searchParams.keys()], ['interval', 'range']);
        assert.equal(new Headers(options.headers).get('user-agent'), 'Mozilla/5.0');
        assert.equal(new Headers(options.headers).has('cookie'), false);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
    }
    assert.equal(calls[0].options.signal, calls[1].options.signal);
});

test('does not retry non-429 failures and reports repeated rate limiting', async () => {
    for (const [status, expectedCalls] of [[404, 1], [429, 2]]) {
        let calls = 0;
        const response = await marketData(request({ path: 'quote', params: { symbol: 'AAPL' } }),
            async () => { calls++; return new Response('', { status }); });
        assert.equal(calls, expectedCalls);
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, new RegExp(String(status)));
    }
});

test('returns sorted exchange-local daily history and skips missing closes', async () => {
    const input = { path: 'time_series', params: { symbol: 'AAPL', interval: '1day', outputsize: '140' } };
    const response = await marketData(request(input), async url => {
        assert.equal(url.searchParams.get('interval'), '1d');
        assert.equal(url.searchParams.get('range'), '6mo');
        return Response.json(chart('AAPL'));
    });
    assert.deepEqual(await response.json(), { values: [
        { datetime: '2026-01-03', close: 110 }, { datetime: '2026-01-01', close: 100 }
    ] });
    const localDate = chart('AAPL', { exchangeTimezoneName: 'Asia/Tokyo' });
    localDate.chart.result[0].timestamp = [Date.parse('2026-01-01T23:30:00Z') / 1000];
    localDate.chart.result[0].indicators.quote[0].close = [50];
    const local = await marketData(request(input), async () => Response.json(localDate));
    assert.equal((await local.json()).values[0].datetime, '2026-01-02');
});

test('reports provider errors and rejects malformed or mismatched data', async () => {
    const input = { path: 'quote', params: { symbol: 'AAPL' } };
    const failed = await marketData(request(input), async () => new Response('', { status: 429 }));
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /429.*Try again later/);
    for (const body of [
        { chart: { result: null, error: { description: 'unknown symbol' } } },
        chart('WRONG'),
        chart('AAPL', { regularMarketPrice: null })
    ]) {
        assert.equal((await marketData(request(input), async () => Response.json(body))).status, 502);
    }
    const history = { path: 'time_series', params: { symbol: 'AAPL', interval: '1day', outputsize: '140' } };
    const badHistory = chart('AAPL');
    badHistory.chart.result[0].indicators.quote[0].close = [null];
    assert.equal((await marketData(request(history), async () => Response.json(badHistory))).status, 502);
});
