'use strict';

let investmentPositions = [];
let investmentItems = [];
let investmentTransactions = [];
let investmentQuotes = new Map();
let investmentSettings = {};
let investmentGeneration = 0;
let investmentBusy = false;
let investmentItemSaving = false;
let investmentEditingItem = null;
let investmentRefreshingKey = null;
let investmentNextRequestAt = 0;
let investmentSettingsOwner = null;
let investmentLoaded = false;
let investmentLoading = false;
let investmentSort = { key: '', ascending: true };
let investmentShowClosed = false;
let analyticsView = 'platform';
let analyticsRanking = 'top';
let portfolioTransactionsVisible = false;
let portfolioTransactionPage = 1;
let portfolioTransactionSaving = false;
let portfolioTransactionEditing = null;
const portfolioTransactionPageSize = 12;
const investmentSortKeys = ['name', 'type', 'qty', 'price', 'value', 'portfolio', 'today', 'pnl', 'return'];
const portfolioTransactionFields = {
    portfolio_item_id: 'portfolioTransactionItem', transaction_date: 'portfolioTransactionDate',
    action: 'portfolioTransactionAction', quantity: 'portfolioTransactionQuantity',
    price_per_unit: 'portfolioTransactionPrice', exchange_rate: 'portfolioTransactionRate',
    commission: 'portfolioTransactionCommission', fees: 'portfolioTransactionFees',
    currency: 'portfolioTransactionCurrency', total_cost: 'portfolioTransactionTotal',
    local_value: 'portfolioTransactionLocalValue', local_currency: 'portfolioTransactionLocalCurrency'
};

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
    investmentItems = [];
    investmentTransactions = [];
    investmentQuotes.clear();
    investmentSettings = {};
    investmentSettingsOwner = null;
    investmentBusy = false;
    investmentItemSaving = false;
    investmentEditingItem = null;
    investmentRefreshingKey = null;
    investmentLoaded = false;
    investmentLoading = false;
    investmentSort = { key: '', ascending: true };
    investmentShowClosed = false;
    analyticsView = 'platform';
    analyticsRanking = 'top';
    portfolioTransactionsVisible = false;
    portfolioTransactionPage = 1;
    portfolioTransactionSaving = false;
    portfolioTransactionEditing = null;
    const dialog = document.getElementById('investmentDialog');
    if (dialog.open) dialog.close();
    document.getElementById('investmentForm').reset();
    document.getElementById('investmentSubmit').disabled = false;
    document.getElementById('investmentCancel').disabled = false;
    const transactionDialog = document.getElementById('portfolioTransactionDialog');
    if (transactionDialog.open) transactionDialog.close();
    document.getElementById('portfolioTransactionForm').reset();
    document.getElementById('portfolioSearch').value = '';
    document.getElementById('portfolioTransactionFormStatus').textContent = '';
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

function investmentBadge(text) {
    const badge = document.createElement('span');
    badge.className = 'investment-type';
    const hue = [...text.trim().toLowerCase()].reduce((hash, char) => (hash * 31 + char.codePointAt(0)) % 360, 0);
    badge.style.setProperty('--investment-type-hue', String(hue));
    badge.textContent = text;
    return badge;
}

function investmentPercent(value) {
    return Number.isFinite(value) ? `${investmentFormat(value)}%` : '—';
}

function investmentInputNumber(value) {
    const text = value.trim();
    if (!text) return null;
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?(?:e[+-]?\d+)?$|^\.\d+(?:e[+-]?\d+)?$/i.test(text)) return NaN;
    return Number(text.replace(/,/g, ''));
}

function investmentInputFormat(value) {
    return value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 20 });
}

function investmentValue(position) {
    if (position.type.toLowerCase() !== 'crowdlending' && position.quantityUnknown) return null;
    if (position.currentValue != null) return position.currentValue;
    const manual = position.type.toLowerCase() === 'crowdlending' ? investmentSettings[position.key]?.value : undefined;
    if (manual !== undefined && manual !== '') return Number(manual);
    const quote = investmentQuotes.get(position.key);
    return quote && !position.quantityUnknown && Number.isFinite(quote.rate) ? position.quantity * quote.price * quote.rate : null;
}

function sortInvestments(key) {
    investmentSort = {
        key,
        ascending: investmentSort.key === key ? !investmentSort.ascending : true
    };
    renderInvestments();
}

function portfolioSearchTerm() {
    return (document.getElementById('portfolioSearch').value || '').trim().toLowerCase();
}

function matchesPortfolioSearch(item, search) {
    return (item.ticker || '').toLowerCase().includes(search) || (item.name || '').toLowerCase().includes(search);
}

function renderInvestmentAnalytics() {
    const performers = analyticsView === 'performers';
    document.getElementById('analyticsPlatformButton').setAttribute('aria-pressed', String(!performers));
    document.getElementById('analyticsPerformersButton').setAttribute('aria-pressed', String(performers));
    document.getElementById('analyticsTopButton').setAttribute('aria-pressed', String(analyticsRanking === 'top'));
    document.getElementById('analyticsWorstButton').setAttribute('aria-pressed', String(analyticsRanking === 'worst'));
    document.getElementById('analyticsRankingControls').hidden = !performers;
    document.getElementById('analyticsTitle').textContent = performers
        ? `${analyticsRanking === 'top' ? 'Top' : 'Worst'} performers` : 'Performance by platform';
    document.getElementById('analyticsNameHeading').textContent = performers ? 'Position' : 'Platform';
    document.getElementById('analyticsStatus').textContent = document.getElementById('investmentStatus').textContent;
    document.getElementById('analyticsRetry').hidden = document.getElementById('investmentRetry').hidden !== false;
    const body = document.getElementById('analyticsTableBody');
    const coverage = document.getElementById('analyticsCoverage');
    body.replaceChildren();
    coverage.textContent = '';
    if (!investmentLoaded) return;

    const positions = investmentPositions.map(position => {
        const value = position.isClosed ? 0 : investmentValue(position);
        const pnl = Number.isFinite(value) ? value + position.bought + position.sold + position.fees + position.dividends : null;
        return { position, value: Number.isFinite(value) ? value : null, pnl: Number.isFinite(pnl) ? pnl : null };
    });
    const total = positions.reduce((sum, row) => sum + (row.value === null ? 0 : row.value), 0);
    const missing = positions.filter(row => row.value === null || row.pnl === null).length;
    if (missing) coverage.textContent = `${missing} position${missing === 1 ? ' has' : 's have'} an unavailable value or P/L; platform totals marked * are partial and these positions are excluded from performer rankings.`;
    if (!positions.length) coverage.textContent = 'No portfolio positions available.';
    let rows;
    if (performers) {
        rows = positions.filter(row => row.pnl !== null).map(row => ({
            label: `${row.position.name} · ${row.position.ticker} · ${row.position.platform}`,
            value: row.value, pnl: row.pnl
        })).sort((a, b) => (analyticsRanking === 'top' ? b.pnl - a.pnl : a.pnl - b.pnl)
            || a.label.localeCompare(b.label)).slice(0, 10);
        if (positions.length && !rows.length) coverage.textContent += ' No positions can be ranked.';
    } else {
        const groups = new Map();
        positions.forEach(row => {
            const label = row.position.platform.trim();
            const key = label.toLowerCase();
            if (!groups.has(key)) groups.set(key, { label, value: 0, pnl: 0, knownValues: 0, knownPnls: 0, valuePartial: false, pnlPartial: false });
            const group = groups.get(key);
            if (row.value === null) group.valuePartial = true;
            else {
                group.value += row.value;
                group.knownValues++;
            }
            if (row.pnl === null) group.pnlPartial = true;
            else {
                group.pnl += row.pnl;
                group.knownPnls++;
            }
        });
        rows = [...groups.values()].map(group => ({
            ...group, value: group.knownValues ? group.value : null, pnl: group.knownPnls ? group.pnl : null
        })).sort((a, b) => (a.pnl === null) - (b.pnl === null)
            || (b.pnl ?? 0) - (a.pnl ?? 0) || a.label.localeCompare(b.label));
    }
    rows.forEach(row => {
        const tr = document.createElement('tr');
        const percent = row.value !== null && Number.isFinite(total) && total > 0 ? row.value / total * 100 : null;
        const partialValue = row.valuePartial && row.value !== null ? ' *' : '';
        const partialPnl = row.pnlPartial && row.pnl !== null ? ' *' : '';
        for (const [label, text, sign] of [
            [performers ? 'Position' : 'Platform', row.label, null],
            ['Value DKK', investmentFormat(row.value) + partialValue, null],
            ['Portfolio %', investmentPercent(percent) + partialValue, null],
            ['Net P/L DKK', investmentFormat(row.pnl) + partialPnl, row.pnl]
        ]) {
            const cell = document.createElement('td');
            cell.dataset.label = label;
            cell.textContent = text;
            investmentSign(cell, sign);
            tr.append(cell);
        }
        body.append(tr);
    });
}

for (const [id, view] of [['analyticsPlatformButton', 'platform'], ['analyticsPerformersButton', 'performers']]) {
    document.getElementById(id).addEventListener('click', () => {
        analyticsView = view;
        renderInvestmentAnalytics();
    });
}
for (const [id, ranking] of [['analyticsTopButton', 'top'], ['analyticsWorstButton', 'worst']]) {
    document.getElementById(id).addEventListener('click', () => {
        analyticsRanking = ranking;
        renderInvestmentAnalytics();
    });
}
document.getElementById('analyticsRetry').addEventListener('click', openInvestments);

function renderInvestments() {
    if (activeAuthUserId) loadInvestmentSettings();
    renderInvestmentAnalytics();
    renderPortfolioTransactions();
    const body = document.getElementById('investmentTableBody');
    body.replaceChildren();
    const visiblePositions = investmentPositions.filter(p => !p.isClosed);
    const values = visiblePositions.map(investmentValue);
    const pnls = visiblePositions.map((p, index) => values[index] === null
        ? null : values[index] + p.bought + p.sold + p.fees + p.dividends);
    const total = values.reduce((sum, value) => sum + (value === null ? 0 : value), 0);
    const hiddenPositions = investmentPositions.filter(p => p.isClosed);
    const includedInTotalPnl = p => p.isInScope;
    const pnlHiddenPositions = hiddenPositions.filter(includedInTotalPnl);
    const totalPnl = pnls.reduce((sum, pnl, index) => sum + (pnl === null || !includedInTotalPnl(visiblePositions[index]) ? 0 : pnl), 0)
        + pnlHiddenPositions.reduce((sum, p) => sum + p.bought + p.sold + p.fees + p.dividends, 0);
    const known = values.filter(value => value !== null).length;
    const pnlKnown = pnls.filter((pnl, index) => pnl !== null && includedInTotalPnl(visiblePositions[index])).length
        + pnlHiddenPositions.length;
    const heatValues = values.filter(Number.isFinite);
    const heatMin = heatValues.reduce((min, value) => Math.min(min, value), Infinity);
    const heatMax = heatValues.reduce((max, value) => Math.max(max, value), -Infinity);
    document.getElementById('investmentPortfolioSize').textContent = known ? `${investmentFormat(total, 0)} DKK` : '—';
    const pnlKpi = document.getElementById('investmentPortfolioPnl');
    pnlKpi.textContent = pnlKnown ? `${investmentFormat(totalPnl, 0)} DKK` : '—';
    pnlKpi.className = `kpi-real${pnlKnown && totalPnl !== 0 ? (totalPnl < 0 ? ' investment-negative' : ' investment-positive') : ''}`;
    document.getElementById('investmentCoverage').textContent = visiblePositions.length && known < visiblePositions.length
        ? `${known} of ${visiblePositions.length} open positions valued; totals exclude the remainder.`
        : '';
    const closedToggle = document.getElementById('investmentClosedToggle');
    const closedToggleLabel = investmentShowClosed ? 'Hide closed positions' : 'Show closed positions';
    closedToggle.setAttribute('aria-label', closedToggleLabel);
    closedToggle.title = closedToggleLabel;
    closedToggle.setAttribute('aria-expanded', String(investmentShowClosed));
    closedToggle.disabled = !investmentLoaded;
    const rows = visiblePositions.map((p, index) => {
        const quote = investmentQuotes.get(p.key);
        const crowdlending = p.type.toLowerCase() === 'crowdlending';
        const value = values[index];
        const pnl = pnls[index];
        const portfolioPercent = value !== null && total > 0 ? value / total * 100 : null;
        const returnPercent = pnl !== null && p.bought < 0 ? pnl / -p.bought * 100 : null;
        return { p, index, quote, crowdlending, value, pnl, portfolioPercent, returnPercent };
    });
    if (investmentShowClosed) hiddenPositions.forEach((p, index) => {
        const pnl = p.bought + p.sold + p.fees + p.dividends;
        rows.push({
            p, index: visiblePositions.length + index, quote: undefined,
            crowdlending: p.type.toLowerCase() === 'crowdlending',
            value: 0, pnl, portfolioPercent: null,
            returnPercent: p.bought < 0 ? pnl / -p.bought * 100 : null
        });
    });
    if (investmentSort.key) {
        function sortValue(row) {
            switch (investmentSort.key) {
                case 'name': return row.p.name || row.p.ticker;
                case 'type': return row.p.type;
                case 'qty': return row.crowdlending || row.p.quantityUnknown ? null : row.p.quantity;
                case 'price': return row.quote?.price;
                case 'value': return row.value;
                case 'portfolio': return row.portfolioPercent;
                case 'today': return row.quote?.today;
                case 'pnl': return row.pnl;
                case 'return': return row.returnPercent;
            }
        }
        rows.sort((a, b) => {
            const left = sortValue(a);
            const right = sortValue(b);
            const leftMissing = left == null || (typeof left === 'number' && !Number.isFinite(left));
            const rightMissing = right == null || (typeof right === 'number' && !Number.isFinite(right));
            if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
            if (leftMissing) return a.index - b.index;
            const comparison = typeof left === 'string'
                ? left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
                : left - right;
            return (investmentSort.ascending ? comparison : -comparison) || a.index - b.index;
        });
    }
    investmentSortKeys.forEach(key => {
        const header = document.getElementById(`investment-sort-${key}`);
        if (key === investmentSort.key) header.setAttribute('aria-sort', investmentSort.ascending ? 'ascending' : 'descending');
        else header.removeAttribute('aria-sort');
    });
    document.getElementById('investmentSortField').value = investmentSort.key;
    const direction = document.getElementById('investmentSortDirection');
    direction.disabled = !investmentSort.key;
    direction.textContent = investmentSort.ascending ? 'Ascending ↑' : 'Descending ↓';
    const search = portfolioSearchTerm();
    rows.filter(row => matchesPortfolioSearch(row.p, search)).forEach(({ p, index, quote, crowdlending, value, pnl, portfolioPercent, returnPercent }) => {
        const tr = document.createElement('tr');
        const settings = investmentSettings[p.key] || {};
        const cells = [
            { key: 'name', label: 'Name / ticker', text: p.name || p.ticker },
            { key: 'type', label: 'Type', text: p.type },
            { key: 'qty', label: 'Qty', text: crowdlending || p.quantityUnknown ? '—' : investmentFormat(p.quantity) },
            { key: 'price', label: 'Price', text: Number.isFinite(quote?.price) ? `${investmentFormat(quote.price)} ${quote.currency}` : '—' },
            { key: 'value', label: 'Current value DKK', text: investmentFormat(value) },
            { key: 'portfolio', label: 'Portfolio %', text: investmentPercent(portfolioPercent) },
            { key: 'today', label: 'Today %', text: investmentPercent(quote?.today), sign: quote?.today },
            { key: 'pnl', label: 'Net P/L DKK', text: investmentFormat(pnl), sign: pnl },
            { key: 'return', label: 'Return %', text: investmentPercent(returnPercent), sign: returnPercent },
            { key: 'actions', label: '', text: '' }
        ];
        cells.forEach(cell => {
            const td = document.createElement('td');
            td.dataset.label = cell.label;
            td.textContent = cell.text;
            investmentSign(td, cell.sign);
            if (cell.key === 'return') td.classList.add('investment-return');
            if (cell.key === 'portfolio' && Number.isFinite(portfolioPercent)) {
                const ratio = heatMax === heatMin ? 0.5 : (value - heatMin) / (heatMax - heatMin);
                td.classList.add('investment-portfolio-heat');
                td.style.setProperty('--investment-heat', String(Math.round(120 * (1 - ratio))));
            }
            if (cell.key === 'type') {
                td.textContent = '';
                td.append(investmentBadge(p.type));
            }
            if (cell.key === 'name') {
                td.textContent = '';
                const heading = document.createElement('div');
                heading.className = 'investment-name-heading';
                const name = document.createElement('span');
                name.textContent = cell.text;
                const info = document.createElement('details');
                info.className = 'investment-info';
                const summary = document.createElement('summary');
                summary.setAttribute('aria-label', `Details for ${p.name || p.ticker}`);
                summary.textContent = 'i';
                const popup = document.createElement('div');
                popup.className = 'investment-popup investment-info-popup';
                [
                    ['Platform', p.platform, ''],
                    ['Bought DKK', investmentFormat(p.bought), 'investment-negative'],
                    ['Sold DKK', investmentFormat(p.sold), 'investment-positive'],
                    ['Fees DKK', investmentFormat(p.fees), 'investment-negative'],
                    ['Dividends DKK', investmentFormat(p.dividends), 'investment-positive']
                ].forEach(([label, amount, color]) => {
                    const line = document.createElement('div');
                    const title = document.createElement('strong');
                    title.textContent = `${label}: `;
                    const value = document.createElement('span');
                    value.textContent = amount;
                    if (color) value.classList.add(color);
                    line.append(title, value);
                    popup.append(line);
                });
                info.append(summary, popup);
                heading.append(name, info);
                td.append(heading);
                const details = document.createElement('small');
                details.textContent = p.ticker + (p.isClosed ? ' · Closed' : '')
                    + (p.other.length ? ` · Review actions: ${p.other.join(', ')}` : '');
                td.append(details);
            }
            if (cell.key === 'actions') {
                td.classList.add('investment-actions');
                const edit = document.createElement('button');
                edit.type = 'button';
                edit.className = 'investment-edit';
                edit.textContent = '✎';
                edit.setAttribute('aria-label', `Edit ${p.name || p.ticker}`);
                edit.title = `Edit ${p.name || p.ticker}`;
                edit.disabled = !investmentLoaded || investmentBusy || investmentItemSaving || portfolioTransactionSaving;
                edit.addEventListener('click', () => openInvestmentDialog(p));
                const refresh = document.createElement('button');
                refresh.type = 'button';
                refresh.className = 'investment-refresh';
                refresh.textContent = '↻';
                refresh.setAttribute('aria-label', `Refresh price for ${p.name || p.ticker}`);
                refresh.title = p.isClosed ? 'Closed positions are not refreshed'
                    : crowdlending ? 'Crowdlending values are entered manually'
                    : investmentBusy ? 'Another price refresh is in progress' : `Refresh price for ${p.name || p.ticker}`;
                refresh.disabled = investmentBusy || investmentItemSaving || portfolioTransactionSaving || !investmentLoaded || crowdlending || p.isClosed;
                if (investmentRefreshingKey === p.key) {
                    refresh.classList.add('is-refreshing');
                    refresh.setAttribute('aria-busy', 'true');
                    refresh.title = 'Refreshing price';
                }
                refresh.addEventListener('click', () => refreshInvestment(p));
                td.append(edit, refresh);
            }
            if (cell.key === 'price' && quote) {
                const details = document.createElement('small');
                details.textContent = [quote.datetime, quote.error].filter(Boolean).join(' · ');
                if (quote.error) details.setAttribute('role', 'status');
                td.append(details);
            }
            if (cell.key === 'value' && crowdlending && !p.isClosed) {
                td.textContent = '';
                const manual = document.createElement('input');
                manual.type = 'text';
                manual.inputMode = 'decimal';
                manual.placeholder = 'Enter DKK';
                manual.setAttribute('aria-label', `Current DKK value for ${p.name}`);
                const initial = p.currentValue ?? settings.value ?? '';
                const display = initial !== '' && Number.isFinite(Number(initial))
                    ? investmentInputFormat(Number(initial)) : String(initial);
                manual.value = display;
                manual.addEventListener('focus', () => {
                    if (manual.value === display) manual.value = String(initial);
                });
                manual.addEventListener('blur', () => {
                    const value = investmentInputNumber(manual.value);
                    if (value !== null && Number.isFinite(value)) manual.value = investmentInputFormat(value);
                });
                manual.addEventListener('change', async () => {
                    const value = investmentInputNumber(manual.value);
                    if (value !== null && (!Number.isFinite(value) || value < 0)) {
                        document.getElementById('investmentStatus').textContent = 'Crowdlending values must be non-negative numbers.';
                        return;
                    }
                    const generation = investmentGeneration;
                    manual.disabled = true;
                    try {
                        await saveInvestmentValue(p, value, generation);
                        if (generation !== investmentGeneration) return;
                        if (investmentSettings[p.key]) {
                            delete investmentSettings[p.key];
                            saveInvestmentSettings();
                        }
                        document.getElementById('investmentStatus').textContent = '';
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

function renderPortfolioTransactions() {
    document.getElementById('portfolioOverview').hidden = portfolioTransactionsVisible;
    document.getElementById('portfolioKpis').hidden = portfolioTransactionsVisible;
    document.getElementById('portfolioTransactions').hidden = !portfolioTransactionsVisible;
    document.getElementById('investmentClosedToggle').hidden = portfolioTransactionsVisible;
    const itemAdd = document.getElementById('investmentAdd');
    itemAdd.hidden = portfolioTransactionsVisible;
    itemAdd.disabled = !investmentLoaded || investmentBusy || investmentItemSaving || portfolioTransactionSaving;
    const add = document.getElementById('portfolioTransactionAdd');
    add.hidden = !portfolioTransactionsVisible;
    add.disabled = !investmentLoaded || investmentBusy || investmentItemSaving || portfolioTransactionSaving || !investmentItems.length;
    document.getElementById('portfolioTransactionSubmit').disabled = !investmentLoaded || investmentBusy || investmentItemSaving || portfolioTransactionSaving;
    document.getElementById('portfolioTransactionCancel').disabled = portfolioTransactionSaving;

    const search = portfolioSearchTerm();
    const rows = investmentTransactions.filter(row => matchesPortfolioSearch(row, search))
        .sort((a, b) => String(b.transaction_date || '').localeCompare(String(a.transaction_date || ''))
            || String(b.id).localeCompare(String(a.id)));
    const pages = Math.max(1, Math.ceil(rows.length / portfolioTransactionPageSize));
    portfolioTransactionPage = Math.min(portfolioTransactionPage, pages);
    document.getElementById('portfolioTransactionPage').textContent = `Page ${portfolioTransactionPage} of ${pages}`;
    document.getElementById('portfolioTransactionPrevious').disabled = portfolioTransactionPage <= 1;
    document.getElementById('portfolioTransactionNext').disabled = portfolioTransactionPage >= pages;
    document.getElementById('portfolioTransactionStatus').textContent = investmentLoaded
        ? `${rows.length} transaction${rows.length === 1 ? '' : 's'}${search ? ' matching ticker or name' : ''}.`
        : investmentTransactions.length ? 'Showing last-loaded transactions; reload to continue.' : '';
    const body = document.getElementById('portfolioTransactionBody');
    body.replaceChildren();
    const fields = [
        ['transaction_date', 'Date'], ['action', 'Action'], ['ticker', 'Ticker'], ['quantity', 'Quantity'],
        ['price_per_unit', 'Price / unit'], ['exchange_rate', 'Exchange rate'], ['commission', 'Commission'],
        ['fees', 'Fees DKK'], ['total_cost', 'Total cost DKK'], ['local_value', 'Local value']
    ];
    rows.slice((portfolioTransactionPage - 1) * portfolioTransactionPageSize, portfolioTransactionPage * portfolioTransactionPageSize).forEach(row => {
        const tr = document.createElement('tr');
        const actions = document.createElement('td');
        actions.className = 'tx-actions-cell';
        actions.dataset.label = 'Actions';
        for (const [label, icon, style, handler] of [
            ['Edit transaction', '✎', 'tx-save-btn', () => openPortfolioTransaction(row)],
            ['Duplicate transaction', '📋', 'tx-duplicate-btn', () => mutatePortfolioTransaction('duplicate_portfolio_transaction', { p_id: row.id, p_expected_revision: row.revision })],
            ['Delete transaction', '🗑', 'tx-delete-btn', () => {
                if (confirm('Delete this transaction?')) return mutatePortfolioTransaction('delete_portfolio_transaction', { p_id: row.id, p_expected_revision: row.revision });
            }]
        ]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `tx-action-btn ${style}`;
            button.textContent = icon;
            button.title = label;
            button.setAttribute('aria-label', `${label} ${row.ticker || ''} ${row.transaction_date || ''}`.trim());
            button.disabled = !investmentLoaded || investmentBusy || investmentItemSaving || portfolioTransactionSaving;
            button.addEventListener('click', handler);
            actions.append(button);
        }
        tr.append(actions);
        fields.forEach(([field, label]) => {
            const td = document.createElement('td');
            td.dataset.label = label;
            td.textContent = row[field] || '—';
            if (field === 'ticker') {
                td.textContent = '';
                td.className = 'portfolio-transaction-ticker';
                const heading = document.createElement('div');
                heading.className = 'investment-name-heading';
                const ticker = document.createElement('span');
                ticker.textContent = row.ticker || '—';
                const info = document.createElement('details');
                info.className = 'investment-info';
                const summary = document.createElement('summary');
                summary.setAttribute('aria-label', `Transaction details for ${row.ticker || 'unknown ticker'}`);
                summary.textContent = 'i';
                const popup = document.createElement('div');
                popup.className = 'investment-popup investment-info-popup';
                for (const [detail, detailLabel] of [['name', 'Name'], ['platform', 'Platform'], ['type', 'Type'],
                    ['currency', 'Currency'], ['local_currency', 'Local currency']]) {
                    const line = document.createElement('div');
                    const title = document.createElement('strong');
                    title.textContent = `${detailLabel}: `;
                    const value = row[detail] || '—';
                    if ((detail === 'platform' || detail === 'type') && row[detail]) line.append(title, investmentBadge(value));
                    else {
                        const text = document.createElement('span');
                        text.textContent = value;
                        line.append(title, text);
                    }
                    popup.append(line);
                }
                info.append(summary, popup);
                heading.append(ticker, info);
                td.append(heading);
            }
            if (field === 'action') {
                const action = (row.action || '').trim().toLowerCase();
                if (action === 'buy') investmentSign(td, -1);
                if (action === 'sell' || action === 'dividend') investmentSign(td, 1);
            }
            if (['commission', 'fees', 'total_cost'].includes(field) && row[field]?.trim()) {
                try { investmentSign(td, InvestmentMath.number(row[field], field.replace(/_/g, ' '), row.id)); }
                catch (error) { td.title = error.message; }
            }
            tr.append(td);
        });
        body.append(tr);
    });
}

document.getElementById('investmentClosedToggle').addEventListener('click', () => {
    if (!investmentLoaded) return;
    investmentShowClosed = !investmentShowClosed;
    renderInvestments();
});
document.getElementById('portfolioSearch').addEventListener('input', () => {
    portfolioTransactionPage = 1;
    renderInvestments();
});
document.getElementById('portfolioTransactionPrevious').addEventListener('click', () => {
    if (portfolioTransactionPage > 1) portfolioTransactionPage--;
    renderPortfolioTransactions();
});
document.getElementById('portfolioTransactionNext').addEventListener('click', () => {
    portfolioTransactionPage++;
    renderPortfolioTransactions();
});
function openPortfolioTransaction(row = null) {
    if (!investmentLoaded || investmentBusy || investmentItemSaving || portfolioTransactionSaving || !investmentItems.length) return;
    const form = document.getElementById('portfolioTransactionForm');
    form.reset();
    const select = document.getElementById('portfolioTransactionItem');
    select.replaceChildren();
    investmentItems.forEach(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.ticker} · ${item.platform} · ${item.name}${item.is_closed ? ' (closed)' : ''}`;
        select.append(option);
    });
    portfolioTransactionEditing = row ? { id: row.id, revision: row.revision } : null;
    if (row) {
        Object.entries(portfolioTransactionFields).forEach(([field, id]) => {
            document.getElementById(id).value = row[field] || '';
        });
    }
    document.getElementById('portfolioTransactionDialogTitle').textContent = row ? 'Edit portfolio transaction' : 'Add portfolio transaction';
    document.getElementById('portfolioTransactionSubmit').textContent = row ? 'Save changes' : 'Add transaction';
    document.getElementById('portfolioTransactionFormStatus').textContent = '';
    const dialog = document.getElementById('portfolioTransactionDialog');
    if (!dialog.open) dialog.showModal();
}
document.getElementById('portfolioTransactionAdd').addEventListener('click', () => openPortfolioTransaction());
document.getElementById('portfolioTransactionCancel').addEventListener('click', () => {
    if (!portfolioTransactionSaving) document.getElementById('portfolioTransactionDialog').close();
});
document.getElementById('portfolioTransactionDialog').addEventListener('cancel', event => {
    if (portfolioTransactionSaving) event.preventDefault();
});
document.getElementById('portfolioTransactionForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (portfolioTransactionSaving || investmentItemSaving || investmentBusy || !investmentLoaded || !activeAuthUserId) return;
    const form = event.currentTarget;
    const status = document.getElementById('portfolioTransactionFormStatus');
    const transaction = Object.fromEntries(Object.entries(portfolioTransactionFields).map(([field, id]) => [field, (document.getElementById(id).value || '').trim()]));
    try {
        if (!form.checkValidity() || !investmentItems.some(item => item.id === transaction.portfolio_item_id) || !isValidIsoDate(transaction.transaction_date) || !transaction.action) {
            throw new Error('Choose an item and enter a valid date in YYYY-MM-DD format and an action.');
        }
        const action = transaction.action.toLowerCase();
        if (['buy', 'sell'].includes(action) && !transaction.quantity) throw new Error('Quantity is required for buys and sells.');
        if (['buy', 'sell', 'dividend', 'dividend tax'].includes(action) && !transaction.total_cost) throw new Error('Total cost is required for this action.');
        for (const field of ['quantity', 'price_per_unit', 'exchange_rate', 'commission', 'fees', 'total_cost', 'local_value']) {
            const value = InvestmentMath.number(transaction[field], field.replace(/_/g, ' '), 'entry');
            if (field === 'quantity' && ['buy', 'sell'].includes(action) && value < 0) throw new Error('Quantity must be non-negative.');
        }
    } catch (error) {
        status.textContent = error.message;
        return;
    }

    const args = { p_transaction: transaction };
    const functionName = portfolioTransactionEditing ? 'save_portfolio_transaction' : 'add_portfolio_transaction';
    if (portfolioTransactionEditing) {
        args.p_id = portfolioTransactionEditing.id;
        args.p_expected_revision = portfolioTransactionEditing.revision;
    }
    await mutatePortfolioTransaction(functionName, args, true);
});

async function mutatePortfolioTransaction(functionName, args, fromDialog = false) {
    if (portfolioTransactionSaving || investmentItemSaving || investmentBusy || !investmentLoaded || !activeAuthUserId) return;
    const generation = investmentGeneration;
    const status = document.getElementById(fromDialog ? 'portfolioTransactionFormStatus' : 'investmentStatus');
    portfolioTransactionSaving = true;
    status.textContent = '';
    renderInvestments();
    try {
        const { error } = await supabaseClient.rpc(functionName, args);
        if (error) {
            const guidance = error.code === 'PGRST202'
                ? '. Run the complete db/supabase/portfolio.sql in the Supabase SQL Editor'
                : '';
            throw new Error(`${error.message.replace(/[.\s]+$/, '')}${guidance}`);
        }
        if (generation !== investmentGeneration) return;
        if (fromDialog) {
            document.getElementById('portfolioTransactionForm').reset();
            document.getElementById('portfolioTransactionDialog').close();
            portfolioTransactionEditing = null;
        }
        portfolioTransactionPage = 1;
        investmentLoaded = false;
        investmentPositions = [];
        investmentItems = [];
        investmentQuotes.clear();
        renderInvestments();
        await openInvestments();
    } catch (error) {
        if (generation !== investmentGeneration) return;
        investmentLoaded = false;
        investmentPositions = [];
        investmentItems = [];
        investmentQuotes.clear();
        const message = `Unable to change transaction: ${error.message}. ${fromDialog ? 'Close this dialog and reload' : 'Reload'} the portfolio before retrying; the change may have completed.`;
        status.textContent = message;
        if (fromDialog) document.getElementById('investmentStatus').textContent = 'Reload the portfolio before continuing; the transaction change may have completed.';
        document.getElementById('investmentRetry').hidden = false;
    } finally {
        if (generation === investmentGeneration) {
            portfolioTransactionSaving = false;
            renderInvestments();
        }
    }
}

async function openInvestments() {
    if (!activeAuthUserId || investmentLoaded || investmentLoading) return;
    const generation = investmentGeneration;
    investmentLoading = true;
    document.getElementById('investmentRetry').hidden = true;
    document.getElementById('investmentStatus').textContent = 'Loading portfolio from Supabase…';
    renderInvestmentAnalytics();
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
        const itemColumns = 'id, ticker, platform, name, type, is_closed, is_in_scope, current_value_dkk, valuation_version, market_price, market_currency, market_price_at';
        const transactionColumns = 'id, revision, portfolio_item_id, transaction_date, action, platform, type, ticker, name, quantity, price_per_unit, exchange_rate, commission, fees, currency, total_cost, local_value, local_currency';
        let items, transactions;
        for (let attempt = 0; attempt < 3; attempt++) {
            const before = await readRows('portfolio_items', itemColumns);
            transactions = await readRows('portfolio_transactions', transactionColumns);
            items = await readRows('portfolio_items', itemColumns);
            const versions = new Map(before.map(item => [item.id, item.valuation_version]));
            if (before.length === items.length && items.every(item => versions.has(item.id)
                && versions.get(item.id) === item.valuation_version)) break;
            if (attempt === 2) throw new Error('Portfolio changed while loading; please retry.');
        }
        if (generation !== investmentGeneration || !activeAuthUserId) return;
        investmentPositions = InvestmentMath.fromStored(items, transactions);
        investmentItems = items;
        investmentTransactions = transactions;
        investmentQuotes.clear();
        items.forEach(item => {
            if (item.market_price != null && item.type.toLowerCase() !== 'crowdlending') {
                const key = JSON.stringify([item.platform, item.ticker]);
                investmentQuotes.set(key, {
                    price: Number(item.market_price), currency: item.market_currency,
                    datetime: item.market_price_at ? formatLocalDateTime(new Date(item.market_price_at), true) : '',
                    rate: null
                });
            }
        });
        investmentLoaded = true;
        document.getElementById('investmentStatus').textContent = '';
        renderInvestments();
    } catch (error) {
        if (generation === investmentGeneration) {
            document.getElementById('investmentStatus').textContent = `Unable to load portfolio: ${error.message}`;
            document.getElementById('investmentRetry').hidden = false;
            renderInvestmentAnalytics();
        }
    } finally {
        if (generation === investmentGeneration) investmentLoading = false;
    }
}

document.getElementById('investmentRetry').addEventListener('click', openInvestments);
document.getElementById('investmentSortField').addEventListener('change', event => {
    investmentSort = { key: event.currentTarget.value, ascending: true };
    renderInvestments();
});
document.getElementById('investmentSortDirection').addEventListener('click', () => {
    if (investmentSort.key) sortInvestments(investmentSort.key);
});

async function saveInvestmentValue(position, value, generation, quote = null) {
    const item = investmentItems.find(entry => entry.id === position.id);
    const fields = {};
    if (value !== undefined) fields.current_value_dkk = value;
    if (quote) Object.assign(fields, { market_price: quote.price, market_currency: quote.currency, market_price_at: quote.at });
    let update = supabaseClient.from('portfolio_items').update(fields).eq('id', position.id);
    if (position.type.toLowerCase() !== 'crowdlending') update = update.eq('valuation_version', item.valuation_version);
    const { error } = await update.select('id').single();
    if (error) {
        if (error.code === 'PGRST116' && generation === investmentGeneration) {
            position.currentValue = null;
            item.current_value_dkk = null;
            investmentLoaded = false;
            document.getElementById('investmentRetry').hidden = false;
            throw new Error('The portfolio changed; reload it before refreshing prices');
        }
        throw new Error(error.message);
    }
    if (generation === investmentGeneration) {
        if (value !== undefined) position.currentValue = value;
        Object.assign(item, fields);
    }
}

function openInvestmentDialog(position = null) {
    if (!activeAuthUserId || !investmentLoaded || investmentBusy || investmentItemSaving || portfolioTransactionSaving) return;
    const form = document.getElementById('investmentForm');
    form.reset();
    investmentEditingItem = position ? investmentItems.find(item => item.id === position.id) : null;
    if (position && !investmentEditingItem) {
        document.getElementById('investmentStatus').textContent = 'Unable to edit this item; reload the portfolio.';
        return;
    }
    if (investmentEditingItem) {
        document.getElementById('investmentTicker').value = investmentEditingItem.ticker;
        document.getElementById('investmentName').value = investmentEditingItem.name;
        document.getElementById('investmentType').value = investmentEditingItem.type;
        document.getElementById('investmentPlatform').value = investmentEditingItem.platform;
    }
    document.getElementById('investmentInScope').checked = investmentEditingItem ? investmentEditingItem.is_in_scope !== false : true;
    document.getElementById('investmentDialogTitle').textContent = position ? 'Edit portfolio item' : 'Add portfolio item';
    document.getElementById('investmentSubmit').textContent = position ? 'Save changes' : 'Add item';
    document.getElementById('investmentFormStatus').textContent = '';
    const dialog = document.getElementById('investmentDialog');
    if (!dialog.open) dialog.showModal();
}
document.getElementById('investmentAdd').addEventListener('click', () => openInvestmentDialog());
document.getElementById('investmentCancel').addEventListener('click', () => {
    if (!investmentItemSaving) document.getElementById('investmentDialog').close();
});
document.getElementById('investmentDialog').addEventListener('cancel', event => {
    if (investmentItemSaving) event.preventDefault();
});
document.getElementById('investmentForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (investmentItemSaving || investmentBusy || portfolioTransactionSaving) return;
    const generation = investmentGeneration;
    const form = event.currentTarget;
    const status = document.getElementById('investmentFormStatus');
    const submit = document.getElementById('investmentSubmit');
    const existing = investmentEditingItem;
    let requestSent = false;
    try {
        if (!activeAuthUserId || !investmentLoaded) throw new Error('Load the portfolio before saving an item.');
        const item = {
            ticker: document.getElementById('investmentTicker').value.trim(),
            name: document.getElementById('investmentName').value.trim(),
            type: document.getElementById('investmentType').value.trim(),
            platform: document.getElementById('investmentPlatform').value.trim(),
            is_in_scope: document.getElementById('investmentInScope').checked
        };
        if ([item.ticker, item.name, item.type, item.platform].some(value => !value)) throw new Error('All item fields are required.');
        const typeChanged = existing && existing.type.toLowerCase() !== item.type.toLowerCase();
        const tickerChanged = existing && existing.ticker !== item.ticker;
        if (existing && !Number.isSafeInteger(existing.valuation_version)) throw new Error('Invalid item version; reload the portfolio.');
        investmentItemSaving = true;
        submit.disabled = true;
        document.getElementById('investmentCancel').disabled = true;
        status.textContent = '';
        renderInvestments();
        let query;
        if (existing) {
            const update = { ...item, valuation_version: existing.valuation_version + 1 };
            if (typeChanged || (tickerChanged && item.type.toLowerCase() !== 'crowdlending')) update.current_value_dkk = null;
            if (typeChanged || tickerChanged) Object.assign(update, { market_price: null, market_currency: null, market_price_at: null });
            query = supabaseClient.from('portfolio_items').update(update).eq('id', existing.id)
                .eq('valuation_version', existing.valuation_version);
        } else {
            query = supabaseClient.from('portfolio_items').insert(item);
        }
        requestSent = true;
        const { data, error } = await query.select('id, ticker, platform, name, type, is_closed, is_in_scope, current_value_dkk, valuation_version, market_price, market_currency, market_price_at').single();
        if (error) throw new Error(error.message);
        if (generation !== investmentGeneration) return;
        if (existing) {
            const oldKey = JSON.stringify([existing.platform, existing.ticker]);
            const newKey = JSON.stringify([data.platform, data.ticker]);
            if (typeChanged) {
                delete investmentSettings[oldKey];
                delete investmentSettings[newKey];
                saveInvestmentSettings();
            } else if (oldKey !== newKey && investmentSettings[oldKey]) {
                investmentSettings[newKey] = investmentSettings[oldKey];
                delete investmentSettings[oldKey];
                saveInvestmentSettings();
            }
            const quote = investmentQuotes.get(oldKey);
            if (oldKey !== newKey || typeChanged || tickerChanged) investmentQuotes.delete(oldKey);
            if (quote && !typeChanged && !tickerChanged) investmentQuotes.set(newKey, quote);
            investmentItems = investmentItems.map(entry => entry.id === data.id ? data : entry);
            investmentPositions = InvestmentMath.fromStored(investmentItems, investmentTransactions);
        } else {
            investmentItems.push(data);
            investmentPositions.push(...InvestmentMath.fromStored([data], []));
        }
        form.reset();
        document.getElementById('investmentDialog').close();
        investmentEditingItem = null;
        renderInvestments();
    } catch (error) {
        if (generation === investmentGeneration) {
            if (requestSent) {
                investmentLoaded = false;
                investmentPositions = [];
                investmentItems = [];
                investmentTransactions = [];
                investmentQuotes.clear();
                document.getElementById('investmentRetry').hidden = false;
                document.getElementById('investmentStatus').textContent = 'Reload the portfolio before continuing; the item save may have completed.';
            }
            status.textContent = `Unable to save item: ${error.message}${requestSent ? '. Close this dialog and reload the portfolio before retrying; the save may have completed.' : ''}`;
        }
    } finally {
        if (generation === investmentGeneration) {
            investmentItemSaving = false;
            submit.disabled = false;
            document.getElementById('investmentCancel').disabled = false;
            renderInvestments();
        }
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
    if (investmentBusy || investmentItemSaving || portfolioTransactionSaving || !investmentLoaded || p.isClosed || p.type.toLowerCase() === 'crowdlending') return;
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
        const params = { symbol: p.ticker };
        const data = await request('quote', params);
        const price = Number(data.close);
        const currency = data.currency;
        if (!Number.isFinite(price) || price <= 0 || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Quote is missing a valid price or currency.');
        if (data.last_quote_at != null && (!Number.isFinite(data.last_quote_at) || data.last_quote_at <= 0)) throw new Error('Quote has an invalid timestamp.');
        const at = data.last_quote_at == null ? null : new Date(data.last_quote_at * 1000).toISOString();
        const quote = { price, currency, at, datetime: at ? formatLocalDateTime(new Date(at), true) : '', today: data.percent_change == null ? null : Number(data.percent_change), rate: null };
        let rate = 1;
        let conversionError = null;
        if (!p.quantityUnknown && currency !== 'DKK') {
            try {
                const fx = await request('exchange_rate', { symbol: `${currency}/DKK` });
                rate = Number(fx.rate);
                if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid ${currency}/DKK exchange rate.`);
            } catch (error) {
                if (generation !== investmentGeneration) return;
                conversionError = error;
            }
        }
        if (!p.quantityUnknown && !conversionError) {
            quote.rate = rate;
            const value = p.quantity * price * quote.rate;
            if (!Number.isFinite(value)) throw new Error('Calculated value is invalid.');
            await saveInvestmentValue(p, value, generation, quote);
        } else {
            await saveInvestmentValue(p, undefined, generation, quote);
        }
        if (generation !== investmentGeneration) return;
        investmentQuotes.set(p.key, quote);
        if (conversionError) throw new Error(`Price saved, but currency conversion failed: ${conversionError.message}`);
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
