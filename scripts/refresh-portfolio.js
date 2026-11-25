'use strict';

const { fromStored, changeSince } = require('../docs/investment-math.js');

const itemColumns = 'id,ticker,platform,name,type,is_closed,is_in_scope,current_value_dkk,valuation_version,market_price,market_currency,market_price_at';
const transactionColumns = 'id,portfolio_item_id,transaction_date,action,quantity,fees,total_cost';

function copenhagenDate(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(date);
}

async function refreshPortfolio(config, {
    fetcher = fetch,
    now = Date.now,
    today = copenhagenDate,
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
        const operation = path.startsWith('/auth/v1/token?') ? 'Supabase sign-in'
            : path.startsWith('/rest/v1/portfolio_items?') ? 'Supabase portfolio items request'
                : path.startsWith('/rest/v1/portfolio_transactions?') ? 'Supabase portfolio transactions request'
                    : path.startsWith('/rest/v1/portfolio_pnl_history') ? 'Supabase P/L history request'
                    : path === '/rest/v1/rpc/is_shared_meal_plan_member' ? 'Supabase household membership check'
                        : 'Supabase request';
        let response;
        try {
            response = await fetcher(new URL(path, base), { ...options, signal: AbortSignal.timeout(20000) });
        } catch {
            throw new Error(`${operation} failed or timed out.`);
        }
        let data;
        try { data = await response.json(); } catch { throw new Error(`${operation} returned invalid JSON (HTTP ${response.status}).`); }
        if (!response.ok) {
            const rateLimited = path === '/functions/v1/market-data'
                && (response.status === 429 || (typeof data?.error === 'string' && /\b429\b/.test(data.error)));
            const invalidCredentials = operation === 'Supabase sign-in'
                && (data?.error_code === 'invalid_credentials' || data?.code === 'invalid_credentials');
            const providerError = path === '/functions/v1/market-data' && typeof data?.error === 'string'
                && /^(Yahoo Finance|Unable to retrieve valid data from Yahoo Finance)/.test(data.error)
                ? data.error : invalidCredentials
                    ? `Supabase sign-in failed: invalid email or password (HTTP ${response.status}).`
                    : `${operation} failed (HTTP ${response.status}).`;
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

    const isMember = await request('/rest/v1/rpc/is_shared_meal_plan_member', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}'
    });
    if (typeof isMember !== 'boolean') throw new Error('Supabase household membership check returned an invalid response.');
    if (!isMember) throw new Error('Refresh account is not a Meal Plan household member.');

    async function readRows(table, columns, filters = {}) {
        const rows = [];
        for (let offset = 0; ; offset += 1000) {
            const query = new URLSearchParams({ select: columns, order: 'id', limit: '1000', offset: String(offset), ...filters });
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
    const allPositions = fromStored(items, transactions);
    const versions = new Map(items.map(item => [item.id, item.valuation_version]));
    const saved = new Map();
    const quotes = new Map();
    const rates = new Map();
    let nextRequestAt = 0;
    let refreshed = 0;
    const failures = [];

    async function market(path, symbol, extra = {}) {
        const delay = Math.max(0, nextRequestAt - now());
        if (delay) await sleep(delay);
        nextRequestAt = now() + 8000;
        const data = await request('/functions/v1/market-data', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, params: { symbol, ...extra } })
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
                const today = data.percent_change == null ? null : Number(data.percent_change);
                quote.fields = { market_change_today: Number.isFinite(today) ? today : null };
                try {
                    const history = await market('time_series', position.ticker, { interval: '1day', outputsize: '140' });
                    if (!Array.isArray(history.values)) throw new Error('Historical prices are unavailable.');
                    for (const days of [7, 30, 90]) {
                        quote.fields[`market_change_${days}d`] = changeSince(history.values, price, days);
                    }
                } catch (error) {
                    error.message = `History: ${error.message}`;
                    quote.historyError = error;
                }
                quotes.set(position.ticker, quote);
            }
            const fields = { market_price: quote.price, market_currency: quote.currency, market_price_at: quote.at, ...quote.fields };
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
            if (fields.current_value_dkk !== undefined) {
                saved.set(position.id, { price: quote.price, currency: quote.currency, quantity: position.quantity, value: fields.current_value_dkk });
            }
            if (conversionError) throw conversionError;
            if (quote.historyError) throw quote.historyError;
        } catch (error) {
            failures.push({ id: position.id, message: error.message });
            if (error.rateLimited) break;
        }
    }
    try {
        await saveHistory();
    } catch (error) {
        failures.push({ id: 'pnl-history', message: error.message });
    }
    return { refreshed, eligible: positions.length, failures };

    async function saveHistory() {
        const snapshotDate = today();
        const cashFlow = p => p.bought + p.sold + p.fees + p.dividends;
        const lastTradeDate = new Map();
        for (const row of transactions) {
            if (typeof row.transaction_date === 'string' && row.transaction_date > (lastTradeDate.get(row.portfolio_item_id) || '')) {
                lastTradeDate.set(row.portfolio_item_id, row.transaction_date);
            }
        }
        const snapshots = [];
        for (const p of allPositions.filter(entry => !entry.isClosed)) {
            const result = saved.get(p.id);
            const crowdlending = p.type.toLowerCase() === 'crowdlending';
            if (!result && !(crowdlending && p.currentValue != null)) continue;
            const value = result ? result.value : p.currentValue;
            const pnl = value + cashFlow(p);
            if (!Number.isFinite(pnl)) continue;
            snapshots.push({
                portfolio_item_id: p.id, snapshot_date: snapshotDate, is_closed: false,
                quantity: result && !p.quantityUnknown ? p.quantity : null,
                market_price: result ? result.price : null, market_currency: result ? result.currency : null,
                value_dkk: value, pnl_dkk: pnl, source: 'refresh'
            });
        }
        if (snapshots.length) {
            await request('/rest/v1/portfolio_pnl_history?on_conflict=portfolio_item_id,snapshot_date&select=id', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
                body: JSON.stringify(snapshots)
            });
        }
        const known = new Set((await readRows('portfolio_pnl_history', 'id,portfolio_item_id', { is_closed: 'eq.true' }))
            .map(row => row.portfolio_item_id));
        const closed = allPositions.filter(p => p.isClosed && !known.has(p.id)).map(p => ({
            portfolio_item_id: p.id, snapshot_date: lastTradeDate.get(p.id) || snapshotDate, is_closed: true,
            quantity: 0, market_price: null, market_currency: null, value_dkk: 0, pnl_dkk: cashFlow(p), source: 'closed'
        })).filter(row => Number.isFinite(row.pnl_dkk));
        if (closed.length) {
            await request('/rest/v1/portfolio_pnl_history?on_conflict=portfolio_item_id,snapshot_date&select=id', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
                body: JSON.stringify(closed)
            });
        }
    }
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
