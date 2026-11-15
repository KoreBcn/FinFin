import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketData } from '../../supabase/functions/market-data/market-data.ts';

const request = body => new Request('https://example.test/market-data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('validates requests and never forwards an overriding key', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return Response.json({}); };
    for (const body of [
        { path: '../quote', params: { symbol: 'AAPL' } },
        { path: 'quote', params: { symbol: 'AAPL', apikey: 'override' } },
        { path: 'quote', params: { symbol: 'AAPL&apikey=bad' } },
        { path: 'time_series', params: { symbol: 'AAPL', interval: '1min', outputsize: '140' } }
    ]) {
        assert.equal((await marketData(request(body), 'secret-test-key', fetcher)).status, 400);
    }
    assert.equal((await marketData(request({ path: 'quote', params: { symbol: 'AAPL' } }), '', fetcher)).status, 503);
    assert.equal((await marketData(new Request('https://example.test/market-data'), 'secret-test-key', fetcher)).status, 405);
    assert.equal(calls, 0);
});

test('sends the configured key upstream but returns only allowed quote fields', async () => {
    let sent;
    const response = await marketData(request({ path: 'quote', params: { symbol: 'AAPL', mic_code: 'XNAS' } }),
        'secret-test-key', async url => {
            sent = new URL(url);
            return Response.json({ close: '100', currency: 'USD', private: 'not returned' });
        });
    assert.equal(sent.hostname, 'api.twelvedata.com');
    assert.equal(sent.searchParams.get('apikey'), 'secret-test-key');
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).close, '100');
    assert.doesNotMatch(text, /secret-test-key|not returned/);
});

test('sanitizes provider errors and rejects key-bearing responses', async () => {
    const input = request({ path: 'quote', params: { symbol: 'AAPL' } });
    const response = await marketData(input, 'secret-test-key',
        async () => Response.json({ status: 'error', code: 429, message: 'secret-test-key' }));
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /secret-test-key/);
    const invalid = await marketData(request({ path: 'time_series', params: { symbol: 'AAPL', interval: '1day', outputsize: '140' } }),
        'secret-test-key', async () => Response.json({ values: [null] }));
    assert.equal(invalid.status, 502);
});

test('returns only supported historical fields and reports provider failures', async () => {
    const input = { path: 'time_series', params: { symbol: 'AAPL', interval: '1day', outputsize: '140' } };
    const history = await marketData(request(input), 'secret-test-key',
        async () => Response.json({ values: [{ datetime: '2026-01-01', close: '12', extra: 'private' }] }));
    assert.deepEqual(await history.json(), { values: [{ datetime: '2026-01-01', close: '12' }] });
    const failed = await marketData(request(input), 'secret-test-key', async () => new Response('', { status: 429 }));
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /429/);
});
