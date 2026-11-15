'use strict';

const InvestmentMath = (() => {
    function number(value, field, line) {
        const raw = String(value || '').trim();
        if (!raw) return 0;
        const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
        if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) throw new Error(`Invalid ${field} on portfolio transaction ${line}.`);
        const result = Number(normalized);
        if (!Number.isFinite(result)) throw new Error(`Invalid ${field} on portfolio transaction ${line}.`);
        return result;
    }

    function fromStored(items, transactions) {
        const positions = new Map();
        items.forEach(item => {
            if (typeof item.id !== 'string' || typeof item.ticker !== 'string' || !item.ticker.trim()
                || typeof item.platform !== 'string' || !item.platform.trim()
                || typeof item.name !== 'string' || !item.name.trim()
                || typeof item.type !== 'string' || !item.type.trim()
                || typeof item.is_in_scope !== 'boolean'
                || (item.current_value_dkk != null && !Number.isFinite(Number(item.current_value_dkk)))) {
                throw new Error('A portfolio item contains invalid data.');
            }
            if (!item.is_in_scope) return;
            positions.set(item.id, {
                id: item.id, key: JSON.stringify([item.platform, item.ticker]),
                ticker: item.ticker, platform: item.platform, name: item.name, type: item.type,
                marketSymbol: item.market_symbol || '', currentValue: item.current_value_dkk == null ? null : Number(item.current_value_dkk),
                quantity: 0, quantityUnknown: false, tradeCount: 0,
                bought: 0, sold: 0, fees: 0, dividends: 0, other: new Set()
            });
        });
        transactions.forEach((row, index) => {
            const p = positions.get(row.portfolio_item_id);
            if (!p) return;
            if (typeof row.action !== 'string' || typeof row.quantity !== 'string'
                || typeof row.fees !== 'string' || typeof row.total_cost !== 'string') {
                throw new Error('A portfolio transaction contains invalid data.');
            }
            const action = row.action.toLowerCase();
            if (['buy', 'sell', 'dividend', 'dividend tax'].includes(action) && !row.total_cost.trim()) {
                throw new Error(`Missing Total Cost on portfolio transaction ${index + 1}.`);
            }
            const amount = number(row.total_cost, 'Total Cost', index + 1);
            p.fees += number(row.fees, 'Fees', index + 1);
            if (action === 'buy' || action === 'sell') {
                p.tradeCount++;
                try {
                    if (!row.quantity.trim()) throw new Error('Missing quantity');
                    const quantity = number(row.quantity, 'Quantity', index + 1);
                    if (quantity < 0) throw new Error('Negative quantity');
                    p.quantity += action === 'buy' ? quantity : -quantity;
                } catch (_error) {
                    p.quantityUnknown = true;
                    p.other.add('invalid or missing trade quantity');
                }
                if (action === 'buy') p.bought -= Math.abs(amount);
                else p.sold += Math.abs(amount);
            } else if (action === 'dividend' || action === 'dividend tax') {
                p.dividends += amount;
            } else {
                p.other.add(row.action || '(empty action)');
            }
        });
        return [...positions.values()].map(p => ({
            ...p, quantityUnknown: p.quantityUnknown || p.tradeCount === 0, other: [...p.other]
        }));
    }

    function defaultSymbol(position) {
        const symbols = {
            'CPH:NOVO-B': 'NOVO.B|XCSE',
            'NASDAQ:MELI': 'MELI|XNGS',
            'AMS:IEMM': 'IEMM|XAMS',
            'ETH': 'ETH/USD'
        };
        return symbols[position.ticker.trim().toUpperCase()] || '';
    }

    function symbolParams(value) {
        const parts = value.trim().split('|');
        if (!parts[0] || parts.length > 2 || !/^[A-Za-z0-9.\/-]+$/.test(parts[0]) ||
            (parts.length === 2 && !/^[A-Za-z0-9]{4}$/.test(parts[1]))) {
            throw new Error('Use SYMBOL or SYMBOL|MIC (for example AAPL|XNAS).');
        }
        return { symbol: parts[0].toUpperCase(), ...(parts[1] ? { mic_code: parts[1].toUpperCase() } : {}) };
    }

    function changeSince(values, latest, days, now = new Date()) {
        const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)).toISOString().slice(0, 10);
        const prior = values.find(item => item.datetime <= target && Number(item.close) > 0);
        return prior ? (latest / Number(prior.close) - 1) * 100 : null;
    }

    return { fromStored, number, defaultSymbol, symbolParams, changeSince };
})();

if (typeof module !== 'undefined') module.exports = InvestmentMath;

let investmentPositions = [];
let investmentQuotes = new Map();
let investmentSettings = {};
let investmentGeneration = 0;
let investmentBusy = false;
let investmentRefreshingKey = null;
let investmentNextRequestAt = 0;
let investmentSettingsOwner = null;
let investmentLoaded = false;
let investmentLoading = false;

function investmentStorageKey() { return `financehome.investments.${activeAuthUserId}`; }

function loadInvestmentSettings() {
    if (investmentSettingsOwner === activeAuthUserId) return;
    investmentSettingsOwner = activeAuthUserId;
    try {
        investmentSettings = JSON.parse(localStorage.getItem(investmentStorageKey()) || '{}');
    } catch (error) {
        investmentSettings = {};
        document.getElementById('investmentStatus').textContent = `Could not read saved investment settings: ${error.message}`;
    }
}

function saveInvestmentSettings() {
    try { localStorage.setItem(investmentStorageKey(), JSON.stringify(investmentSettings)); }
    catch (error) { document.getElementById('investmentStatus').textContent = `Could not save settings in this browser: ${error.message}`; }
}

function clearInvestments() {
    investmentGeneration++;
    investmentPositions = [];
    investmentQuotes.clear();
    investmentSettings = {};
    investmentSettingsOwner = null;
    investmentBusy = false;
    investmentRefreshingKey = null;
    investmentLoaded = false;
    investmentLoading = false;
    const dialog = document.getElementById('investmentDialog');
    if (dialog.open) dialog.close();
    document.getElementById('investmentForm').reset();
    document.getElementById('investmentRetry').hidden = true;
    document.getElementById('investmentStatus').textContent = '';
    renderInvestments();
}

function investmentFormat(value, decimals = 2) {
    return Number.isFinite(value) ? value.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : '—';
}

function investmentSign(element, value) {
    if (Number.isFinite(value) && value !== 0) {
        element.classList.add(value < 0 ? 'investment-negative' : 'investment-positive');
    }
}

function investmentPercent(value) {
    return Number.isFinite(value) ? `${investmentFormat(value)}%` : '—';
}

function investmentValue(position) {
    if (position.type.toLowerCase() !== 'crowdlending' && position.quantityUnknown) return null;
    if (position.currentValue != null) return position.currentValue;
    const manual = position.type.toLowerCase() === 'crowdlending' ? investmentSettings[position.key]?.value : undefined;
    if (manual !== undefined && manual !== '') return Number(manual);
    const quote = investmentQuotes.get(position.key);
    return quote && !position.quantityUnknown && Number.isFinite(quote.rate) ? position.quantity * quote.price * quote.rate : null;
}

function renderInvestments() {
    if (activeAuthUserId) loadInvestmentSettings();
    const body = document.getElementById('investmentTableBody');
    body.replaceChildren();
    const values = investmentPositions.map(investmentValue);
    const total = values.reduce((sum, value) => sum + (value === null ? 0 : value), 0);
    const known = values.filter(value => value !== null).length;
    document.getElementById('investmentSummary').textContent = investmentPositions.length
        ? `Known portfolio value: ${investmentFormat(known ? total : null)} DKK (${known} of ${investmentPositions.length} positions valued)`
        : '';
    investmentPositions.forEach((p, index) => {
        const tr = document.createElement('tr');
        const quote = investmentQuotes.get(p.key);
        const settings = investmentSettings[p.key] || {};
        const crowdlending = p.type.toLowerCase() === 'crowdlending';
        const symbol = p.marketSymbol || InvestmentMath.defaultSymbol(p);
        const value = values[index];
        const pnl = value === null ? null : value + p.bought + p.sold + p.fees + p.dividends;
        const portfolioPercent = value !== null && total > 0 ? value / total * 100 : null;
        const returnPercent = pnl !== null && p.bought < 0 ? pnl / -p.bought * 100 : null;
        const cells = [
            { key: 'name', label: 'Name / ticker', text: p.name || p.ticker },
            { key: 'type', label: 'Type', text: p.type },
            { key: 'qty', label: 'Qty', text: crowdlending || p.quantityUnknown ? '—' : investmentFormat(p.quantity) },
            { key: 'price', label: 'Price', text: Number.isFinite(quote?.price) ? `${investmentFormat(quote.price)} ${quote.currency}` : '—' },
            { key: 'value', label: 'Current value DKK', text: investmentFormat(value) },
            { key: 'portfolio', label: 'Portfolio %', text: investmentPercent(portfolioPercent), sign: portfolioPercent },
            { key: 'today', label: 'Today %', text: investmentPercent(quote?.today), sign: quote?.today },
            { key: 'pnl', label: 'Net P/L DKK', text: investmentFormat(pnl), sign: pnl },
            { key: 'return', label: 'Return %', text: investmentPercent(returnPercent), sign: returnPercent }
        ];
        cells.forEach(cell => {
            const td = document.createElement('td');
            td.dataset.label = cell.label;
            td.textContent = cell.text;
            investmentSign(td, cell.sign);
            if (cell.key === 'name') {
                td.textContent = '';
                const heading = document.createElement('div');
                heading.className = 'investment-name-heading';
                const name = document.createElement('span');
                name.textContent = cell.text;
                const refresh = document.createElement('button');
                refresh.type = 'button';
                refresh.className = 'investment-refresh';
                refresh.textContent = '↻';
                refresh.setAttribute('aria-label', `Refresh price for ${p.name || p.ticker}`);
                refresh.title = crowdlending ? 'Crowdlending values are entered manually'
                    : !symbol ? 'No verified market symbol'
                        : investmentBusy ? 'Another price refresh is in progress' : `Refresh price for ${p.name || p.ticker}`;
                refresh.disabled = investmentBusy || crowdlending || !symbol;
                if (investmentRefreshingKey === p.key) {
                    refresh.classList.add('is-refreshing');
                    refresh.setAttribute('aria-busy', 'true');
                    refresh.title = 'Refreshing price';
                }
                refresh.addEventListener('click', () => refreshInvestment(p));
                const info = document.createElement('details');
                info.className = 'investment-info';
                const summary = document.createElement('summary');
                summary.setAttribute('aria-label', `Details for ${p.name || p.ticker}`);
                summary.textContent = 'i';
                const popup = document.createElement('div');
                popup.className = 'investment-popup investment-info-popup';
                [
                    ['Platform', p.platform],
                    ['Bought DKK', investmentFormat(p.bought)],
                    ['Sold DKK', investmentFormat(p.sold)],
                    ['Fees DKK', investmentFormat(p.fees)],
                    ['Dividends DKK', investmentFormat(p.dividends)]
                ].forEach(([label, amount]) => {
                    const line = document.createElement('div');
                    line.textContent = `${label}: ${amount}`;
                    popup.append(line);
                });
                info.append(summary, popup);
                heading.append(name, refresh, info);
                td.append(heading);
                const details = document.createElement('small');
                const tickerLabel = p.ticker.trim().toUpperCase() === 'CPH:NOVO-B' ? 'NOVO-B:XCSE' : p.ticker;
                details.textContent = tickerLabel + (!crowdlending ? ` · ${symbol || 'No verified market symbol'}` : '') + (p.other.length ? ` · Review actions: ${p.other.join(', ')}` : '');
                td.append(details);
            }
            if (cell.key === 'price' && quote) {
                const details = document.createElement('small');
                details.textContent = [quote.datetime, quote.error].filter(Boolean).join(' · ');
                if (quote.error) details.setAttribute('role', 'status');
                td.append(details);
            }
            if (cell.key === 'value' && crowdlending) {
                td.textContent = '';
                const manual = document.createElement('input');
                manual.type = 'number';
                manual.min = '0';
                manual.step = 'any';
                manual.placeholder = 'Enter DKK';
                manual.setAttribute('aria-label', `Current DKK value for ${p.name}`);
                manual.value = p.currentValue ?? settings.value ?? '';
                manual.addEventListener('change', async () => {
                    if (manual.value && (!Number.isFinite(Number(manual.value)) || Number(manual.value) < 0)) {
                        document.getElementById('investmentStatus').textContent = 'Crowdlending values must be non-negative numbers.';
                        return;
                    }
                    const generation = investmentGeneration;
                    manual.disabled = true;
                    try {
                        await saveInvestmentValue(p, manual.value === '' ? null : Number(manual.value), generation);
                        if (generation !== investmentGeneration) return;
                        if (investmentSettings[p.key]) {
                            delete investmentSettings[p.key];
                            saveInvestmentSettings();
                        }
                        renderInvestments();
                    } catch (error) {
                        if (generation === investmentGeneration) {
                            document.getElementById('investmentStatus').textContent = `Unable to save value: ${error.message}`;
                            renderInvestments();
                        }
                    }
                });
                td.append(manual);
            }
            if (cell.key === 'today') {
                td.textContent = '';
                const container = document.createElement('div');
                container.className = 'investment-performance';
                const trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'investment-performance-trigger';
                trigger.textContent = cell.text;
                trigger.setAttribute('aria-label', `Today ${cell.text}; show longer-term performance for ${p.name || p.ticker}`);
                trigger.setAttribute('aria-describedby', `investment-performance-${index}`);
                const popup = document.createElement('div');
                popup.className = 'investment-popup investment-performance-popup';
                popup.id = `investment-performance-${index}`;
                popup.setAttribute('role', 'tooltip');
                [7, 30, 90].forEach(days => {
                    const line = document.createElement('div');
                    const label = document.createElement('span');
                    label.textContent = `${days} days`;
                    const amount = document.createElement('span');
                    const change = quote?.changes?.[days];
                    amount.textContent = investmentPercent(change);
                    investmentSign(amount, change);
                    line.append(label, amount);
                    popup.append(line);
                });
                container.append(trigger, popup);
                td.append(container);
            }
            tr.append(td);
        });
        body.append(tr);
    });
}

async function openInvestments() {
    if (!activeAuthUserId || investmentLoaded || investmentLoading) return;
    const generation = investmentGeneration;
    investmentLoading = true;
    document.getElementById('investmentRetry').hidden = true;
    document.getElementById('investmentStatus').textContent = 'Loading portfolio from Supabase…';
    try {
        async function readRows(table, columns) {
            const rows = [];
            const pageSize = 1000;
            for (let offset = 0; ; offset += pageSize) {
                const { data, error } = await supabaseClient.from(table).select(columns).order('id').range(offset, offset + pageSize - 1);
                if (error) throw new Error(error.message);
                if (!Array.isArray(data)) throw new Error(`Invalid ${table} response.`);
                rows.push(...data);
                if (data.length < pageSize) return rows;
            }
        }
        const items = await readRows('portfolio_items', 'id, ticker, platform, name, type, market_symbol, is_in_scope, current_value_dkk');
        const transactions = await readRows('portfolio_transactions', 'id, portfolio_item_id, action, quantity, fees, total_cost');
        if (generation !== investmentGeneration || !activeAuthUserId) return;
        investmentPositions = InvestmentMath.fromStored(items, transactions);
        investmentQuotes.clear();
        investmentLoaded = true;
        document.getElementById('investmentStatus').textContent = '';
        renderInvestments();
    } catch (error) {
        if (generation === investmentGeneration) {
            document.getElementById('investmentStatus').textContent = `Unable to load portfolio: ${error.message}`;
            document.getElementById('investmentRetry').hidden = false;
        }
    } finally {
        if (generation === investmentGeneration) investmentLoading = false;
    }
}

document.getElementById('investmentRetry').addEventListener('click', openInvestments);

async function saveInvestmentValue(position, value, generation) {
    const { error } = await supabaseClient.from('portfolio_items').update({ current_value_dkk: value }).eq('id', position.id).select('id').single();
    if (error) throw new Error(error.message);
    if (generation === investmentGeneration) position.currentValue = value;
}

document.getElementById('investmentAdd').addEventListener('click', () => {
    document.getElementById('investmentFormStatus').textContent = '';
    document.getElementById('investmentDialog').showModal();
});
document.getElementById('investmentCancel').addEventListener('click', () => document.getElementById('investmentDialog').close());
document.getElementById('investmentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const generation = investmentGeneration;
    const form = event.currentTarget;
    const symbol = document.getElementById('investmentMarketSymbol').value.trim();
    const status = document.getElementById('investmentFormStatus');
    const submit = document.getElementById('investmentSubmit');
    try {
        if (!activeAuthUserId || !investmentLoaded) throw new Error('Load the portfolio before adding an item.');
        if (symbol) InvestmentMath.symbolParams(symbol);
        const item = {
            ticker: document.getElementById('investmentTicker').value.trim(),
            name: document.getElementById('investmentName').value.trim(),
            type: document.getElementById('investmentType').value.trim(),
            platform: document.getElementById('investmentPlatform').value.trim(),
            market_symbol: symbol || null
        };
        if ([item.ticker, item.name, item.type, item.platform].some(value => !value)) throw new Error('All item fields are required.');
        submit.disabled = true;
        const { data, error } = await supabaseClient.from('portfolio_items').insert(item)
            .select('id, ticker, platform, name, type, market_symbol, is_in_scope, current_value_dkk').single();
        if (error) throw new Error(error.message);
        if (generation !== investmentGeneration) return;
        investmentPositions.push(...InvestmentMath.fromStored([data], []));
        form.reset();
        document.getElementById('investmentDialog').close();
        renderInvestments();
    } catch (error) {
        if (generation === investmentGeneration) status.textContent = `Unable to add item: ${error.message}`;
    } finally {
        submit.disabled = false;
    }
});

async function investmentRequest(path, params) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const { data, error } = await supabaseClient.functions.invoke('market-data', {
            body: { path, params }, signal: controller.signal
        });
        if (error) {
            let message = error.message || 'Market data request failed.';
            if (typeof error.context?.json === 'function') {
                try {
                    const body = await error.context.json();
                    if (typeof body?.error === 'string') message = body.error;
                    else if (typeof body?.message === 'string') message = body.message;
                } catch {
                    message += ' Unable to read the error response.';
                }
            }
            throw new Error(message);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid market data response.');
        return data;
    } finally { clearTimeout(timeout); }
}

async function refreshInvestment(p) {
    const symbol = p.marketSymbol || InvestmentMath.defaultSymbol(p);
    if (investmentBusy || p.type.toLowerCase() === 'crowdlending' || !symbol) return;
    investmentBusy = true;
    investmentRefreshingKey = p.key;
    const generation = investmentGeneration;
    async function request(path, params) {
        const delay = Math.max(0, investmentNextRequestAt - Date.now());
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (generation !== investmentGeneration) throw new Error('Refresh cancelled.');
        investmentNextRequestAt = Date.now() + 8000;
        const result = await investmentRequest(path, params);
        if (generation !== investmentGeneration) throw new Error('Refresh cancelled.');
        return result;
    }
    renderInvestments();
    try {
        const params = InvestmentMath.symbolParams(symbol);
        const data = await request('quote', params);
        const price = Number(data.close);
        const currency = data.currency || (params.symbol.endsWith('/USD') ? 'USD' : '');
        if (!Number.isFinite(price) || price <= 0 || !currency) throw new Error('Quote is missing a valid price or currency.');
        const quote = { price, currency, datetime: data.last_quote_at ? new Date(data.last_quote_at * 1000).toLocaleString() : data.datetime, today: data.percent_change == null ? null : Number(data.percent_change), rate: null };
        investmentQuotes.set(p.key, quote);
        renderInvestments();
        let rate = 1;
        if (currency !== 'DKK') {
            const fx = await request('exchange_rate', { symbol: `${currency}/DKK` });
            rate = Number(fx.rate);
            if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid ${currency}/DKK exchange rate.`);
        }
        quote.rate = rate;
        if (!p.quantityUnknown) {
            const value = p.quantity * price * quote.rate;
            if (!Number.isFinite(value)) throw new Error('Calculated value is invalid.');
            await saveInvestmentValue(p, value, generation);
            if (generation !== investmentGeneration) return;
        }
        try {
            const history = await request('time_series', { ...params, interval: '1day', outputsize: '140' });
            if (!Array.isArray(history.values)) throw new Error('Historical prices are unavailable.');
            quote.changes = Object.fromEntries([7, 30, 90].map(days => [days, InvestmentMath.changeSince(history.values, price, days)]));
        } catch (error) {
            if (generation !== investmentGeneration) return;
            quote.error = `History: ${error.message}`;
        }
    } catch (error) {
        if (generation !== investmentGeneration) return;
        const previous = investmentQuotes.get(p.key);
        investmentQuotes.set(p.key, { ...(previous || {}), error: error.message, rate: null });
    } finally {
        if (generation === investmentGeneration) {
            investmentBusy = false;
            investmentRefreshingKey = null;
            renderInvestments();
        }
    }
}
