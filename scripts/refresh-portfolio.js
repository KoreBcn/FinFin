'use strict';

const { fromStored } = require('../docs/investment-math.js');

const itemColumns = 'id,ticker,platform,name,type,is_closed,is_in_scope,current_value_dkk,valuation_version,market_price,market_currency,market_price_at';
const transactionColumns = 'id,portfolio_item_id,action,quantity,fees,total_cost';

async function refreshPortfolio(config, {
    fetcher = fetch,
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
    const { url, anonKey, email, password } = config;
    if (![url, anonKey, email, password].every(value => typeof value === 'string' && value.trim())) {
        throw new Error('Missing Supabase URL, anon key, refresh account email or password.');
    }
    let base;
    try { base = new URL(url); } catch { throw new Error('Invalid Supabase URL.'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
        throw new Error('Supabase URL must be an HTTPS project origin.');
    }

    async function request(path, options = {}) {
        let response;
        try {
            response = await fetcher(new URL(path, base), { ...options, signal: AbortSignal.timeout(20000) });
        } catch {
            throw new Error('Supabase request failed or timed out.');
        }
        let data;
        try { data = await response.json(); } catch { throw new Error(`Supabase returned invalid JSON (HTTP ${response.status}).`); }
        if (!response.ok) {
            const rateLimited = response.status === 429 || (typeof data?.error === 'string' && /\b429\b/.test(data.error));
            const providerError = path === '/functions/v1/market-data' && typeof data?.error === 'string'
                && /^(Yahoo Finance|Unable to retrieve valid data from Yahoo Finance)/.test(data.error)
                ? data.error : `Supabase request failed (HTTP ${response.status}).`;
            const error = new Error(rateLimited ? 'Market data provider rate limited the refresh.' : providerError);
            error.rateLimited = rateLimited;
            throw error;
        }
        return data;
    }

    const auth = await request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    if (typeof auth?.access_token !== 'string' || !auth.access_token) throw new Error('Supabase sign-in returned no access token.');
    const headers = { apikey: anonKey, Authorization: `Bearer ${auth.access_token}` };

    async function readRows(table, columns) {
        const rows = [];
        for (let offset = 0; ; offset += 1000) {
            const query = new URLSearchParams({ select: columns, order: 'id', limit: '1000', offset: String(offset) });
            const page = await request(`/rest/v1/${table}?${query}`, { headers });
            if (!Array.isArray(page)) throw new Error(`Invalid ${table} response.`);
            rows.push(...page);
            if (page.length < 1000) return rows;
        }
    }

    let items;
    let transactions;
    for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readRows('portfolio_items', itemColumns);
        transactions = await readRows('portfolio_transactions', transactionColumns);
        items = await readRows('portfolio_items', itemColumns);
        if (items.some(item => !Number.isSafeInteger(item.valuation_version) || item.valuation_version < 0)) {
            throw new Error('Portfolio has an invalid valuation version.');
        }
        const versions = new Map(before.map(item => [item.id, item.valuation_version]));
        if (before.length === items.length && items.every(item => versions.has(item.id)
            && versions.get(item.id) === item.valuation_version)) break;
        if (attempt === 2) throw new Error('Portfolio changed while loading; retry the workflow.');
    }
    const positions = fromStored(items, transactions).filter(position =>
        position.isClosed === false && position.type.toLowerCase() !== 'crowdlending');
    const versions = new Map(items.map(item => [item.id, item.valuation_version]));
    const quotes = new Map();
    const rates = new Map();
    let nextRequestAt = 0;
    let refreshed = 0;
    const failures = [];

    async function market(path, symbol) {
        const delay = Math.max(0, nextRequestAt - now());
        if (delay) await sleep(delay);
        nextRequestAt = now() + 8000;
        const data = await request('/functions/v1/market-data', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, params: { symbol } })
        });
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid market data response.');
        return data;
    }

    for (const position of positions) {
        try {
            let quote = quotes.get(position.ticker);
            if (!quote) {
                const data = await market('quote', position.ticker);
                const price = Number(data.close);
                if (!Number.isFinite(price) || price <= 0 || typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency)) {
                    throw new Error('Quote is missing a valid price or currency.');
                }
                if (data.last_quote_at != null && (!Number.isFinite(data.last_quote_at) || data.last_quote_at <= 0)) {
                    throw new Error('Quote has an invalid timestamp.');
                }
                quote = { price, currency: data.currency, at: data.last_quote_at == null ? null : new Date(data.last_quote_at * 1000).toISOString() };
                quotes.set(position.ticker, quote);
            }
            const fields = { market_price: quote.price, market_currency: quote.currency, market_price_at: quote.at };
            let conversionError;
            if (!position.quantityUnknown) {
                let rate = 1;
                if (quote.currency !== 'DKK') {
                    try {
                        rate = rates.get(quote.currency);
                        if (rate === undefined) {
                            const fx = await market('exchange_rate', `${quote.currency}/DKK`);
                            rate = Number(fx.rate);
                            if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid exchange rate.');
                            rates.set(quote.currency, rate);
                        }
                    } catch (error) {
                        conversionError = error;
                    }
                }
                if (!conversionError) {
                    fields.current_value_dkk = position.quantity * quote.price * rate;
                    if (!Number.isFinite(fields.current_value_dkk)) throw new Error('Calculated value is invalid.');
                }
            }
            const query = new URLSearchParams({
                id: `eq.${position.id}`, valuation_version: `eq.${versions.get(position.id)}`,
                is_closed: 'eq.false', ticker: `eq.${position.ticker}`, type: `eq.${position.type}`, select: 'id'
            });
            try {
                const saved = await request(`/rest/v1/portfolio_items?${query}`, {
                    method: 'PATCH',
                    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
                    body: JSON.stringify(fields)
                });
                if (!Array.isArray(saved) || saved.length !== 1 || saved[0].id !== position.id) {
                    throw new Error('Portfolio item changed during refresh; no value was saved.');
                }
            } catch (error) {
                if (conversionError?.rateLimited) {
                    error.message += ' The market data provider also rate limited the refresh.';
                    error.rateLimited = true;
                }
                throw error;
            }
            refreshed++;
            if (conversionError) throw conversionError;
        } catch (error) {
            failures.push({ id: position.id, message: error.message });
            if (error.rateLimited) break;
        }
    }
    return { refreshed, eligible: positions.length, failures };
}

if (require.main === module) {
    refreshPortfolio({
        url: process.env.SUPABASE_URL,
        anonKey: process.env.SUPABASE_ANON_KEY,
        email: process.env.SUPABASE_REFRESH_EMAIL,
        password: process.env.SUPABASE_REFRESH_PASSWORD
    }).then(result => {
        console.log(`Refreshed ${result.refreshed} of ${result.eligible} eligible portfolio items.`);
        for (const failure of result.failures) console.error(`Item ${failure.id}: ${failure.message}`);
        if (result.failures.length) process.exitCode = 1;
    }).catch(error => {
        console.error(`Portfolio refresh failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { refreshPortfolio };
