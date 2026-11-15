import { exportJWK, generateKeyPair, SignJWT } from 'npm:jose@6';

Deno.test('requires a user JWT and handles browser preflight', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'ES256', use: 'sig' };
    const values: Record<string, string> = {
        SUPABASE_URL: 'https://project.example.test',
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_test' }),
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_test' }),
        SUPABASE_JWKS: JSON.stringify({ keys: [jwk] }),
        TWELVE_DATA_API_KEY: 'synthetic-twelve-data-key'
    };
    const previous = Object.fromEntries(Object.keys(values).map(name => [name, Deno.env.get(name)]));
    for (const [name, value] of Object.entries(values)) Deno.env.set(name, value);
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = () => {
        providerCalls++;
        return Promise.resolve(Response.json({ close: '100', currency: 'DKK' }));
    };
    try {
        const { default: handler } = await import('./index.ts');
        const origin = 'https://example.test';
        const makeRequest = (authorization?: string) => new Request('https://project.example.test/functions/v1/market-data', {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
            body: JSON.stringify({ path: 'quote', params: { symbol: 'AAPL' } })
        });
        const preflight = await handler.fetch(new Request('https://project.example.test/functions/v1/market-data', {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, apikey, content-type' }
        }));
        if (!preflight.ok || preflight.headers.get('access-control-allow-origin') !== '*') {
            throw new Error(`CORS preflight: ${preflight.status}, origin ${preflight.headers.get('access-control-allow-origin')}.`);
        }
        const missing = await handler.fetch(makeRequest());
        if (missing.status !== 401 || missing.headers.get('access-control-allow-origin') !== '*') {
            throw new Error(`Missing token returned ${missing.status} without the expected CORS headers.`);
        }
        const anon = await new SignJWT({ role: 'anon' }).setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
            .setIssuer(`${values.SUPABASE_URL}/auth/v1`).setAudience('anon').setExpirationTime('5m').sign(privateKey);
        const anonymous = await handler.fetch(makeRequest(`Bearer ${anon}`));
        if (anonymous.status !== 401) throw new Error(`Anonymous token returned ${anonymous.status}.`);
        const token = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
            .setIssuer(`${values.SUPABASE_URL}/auth/v1`).setSubject('00000000-0000-4000-8000-000000000001')
            .setAudience('authenticated').setExpirationTime('5m').sign(privateKey);
        const authenticated = await handler.fetch(makeRequest(`Bearer ${token}`));
        if (authenticated.status !== 200 || providerCalls !== 1
            || authenticated.headers.get('access-control-allow-origin') !== '*') {
            throw new Error(`Authenticated request returned ${authenticated.status}; provider calls: ${providerCalls}.`);
        }
        const body = await authenticated.text();
        if (body.includes(values.TWELVE_DATA_API_KEY)) throw new Error('Response disclosed the key.');
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) Deno.env.delete(name);
            else Deno.env.set(name, value);
        }
    }
});
