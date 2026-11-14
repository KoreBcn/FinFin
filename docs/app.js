// =====================================================
//  FinanceHome — app.js
// =====================================================

const EUR_RATE = 7.46;

// ── State ──────────────────────────────────────────
let rawData      = [];
let filteredData = [];

let globalFilters   = { years: [], currency: 'DKK', categories: [] }; // empty array = "all"

// Dashboard cross-chart filters
let chartFilters = { monthKey: null, typeKey: null, typeLevel: null, kind: null };
let drillDown    = { expenses: null, savings: null };

// Pie chart toggle state
let pieKind = 'expense';

// Monthly heatmap toggle state
let monthlyHeatmapKind  = 'expense';
let monthlyDrillType    = null;    // null = top-level; string = drilled-into Type
let _monthlyCategories  = [];   // indexed lookup for onclick handlers

// Legend visibility persists across re-renders
let legendVisible = {
    expenses: { Planned: false, Real: true },
    savings:  { Planned: false, Real: true },
    monthly:  {
        'Expenses Planned': false, 'Expenses Real': true,
        'Savings Planned':  false, 'Savings Real':  true
    }
};

let charts = {};

// Drawer
let drawerData     = [];
let drawerFiltered = [];
let drawerPage     = 1;
let drawerDirtyRows = new Set();
let drawerSaving    = false;
const DRAWER_PER   = 15;
let drawerSort     = { key: 'Date', dir: 'asc' };
let txSort         = { key: 'DateSortKey', dir: 'desc' };
let txPage         = 1;
const TX_PER_PAGE  = 50;

let activeTab = 'dashboard';
let supabaseClient = null;
let activeAuthUserId = null;

// Highlights tab currency
let highlightsCurrency = 'DKK';
let highlightsCategoryKind = 'expense';

// Year colour palette for YoY charts
const YEAR_PALETTE = [
    { border: '#2563eb', bg: 'rgba(37,99,235,0.78)'  },
    { border: '#f59e0b', bg: 'rgba(245,158,11,0.78)' },
    { border: '#10b981', bg: 'rgba(16,185,129,0.78)' },
    { border: '#8b5cf6', bg: 'rgba(139,92,246,0.78)' },
    { border: '#ec4899', bg: 'rgba(236,72,153,0.78)' },
    { border: '#14b8a6', bg: 'rgba(20,184,166,0.78)' },
];
function yearColor(i) { return YEAR_PALETTE[i % YEAR_PALETTE.length]; }

function chartGridColor() {
    return document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'rgba(148,163,184,0.2)'
        : '#e2e8f0';
}

function chartTextColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
}

function applyChartTheme() {
    const textColor = chartTextColor();
    const gridColor = chartGridColor();
    Chart.defaults.color = textColor;
    Chart.defaults.borderColor = gridColor;

    Object.values(charts).forEach(chart => {
        chart.options.color = textColor;
        Object.values(chart.options.scales || {}).forEach(scale => {
            if (scale.ticks) scale.ticks.color = textColor;
            if (scale.grid) scale.grid.color = gridColor;
            if (scale.title) scale.title.color = textColor;
        });
        const legendLabels = chart.options.plugins?.legend?.labels;
        if (legendLabels) legendLabels.color = textColor;
        chart.update('none');
    });
}


// =====================================================
//  DATE HELPERS (top-level, shared across features)
// =====================================================
function parseDateSortKey(raw) {
    if (!raw) return 0;
    const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
    if (dmy) {
        const d = dmy[1], m = dmy[2];
        let y = parseInt(dmy[3]);
        if (y < 100) y += 2000;
        return y * 10000 + parseInt(m) * 100 + parseInt(d);
    }
    const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) return parseInt(ymd[1]) * 10000 + parseInt(ymd[2]) * 100 + parseInt(ymd[3]);
    return 0;
}
function parseDateFromString(raw) {
    if (!raw) return null;
    const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
    if (dmy) {
        let y = parseInt(dmy[3]);
        if (y < 100) y += 2000;
        return new Date(y, parseInt(dmy[2]) - 1, parseInt(dmy[1]));
    }
    const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) return new Date(parseInt(ymd[1]), parseInt(ymd[2]) - 1, parseInt(ymd[3]));
    return null;
}


// =====================================================
//  TAB SWITCHING
// =====================================================
function switchTab(tab) {
    activeTab = tab;
    closeTabMenu();
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick="switchTab('${tab}')"]`).classList.add('active');
    document.getElementById('tabDashboard').style.display    = tab === 'dashboard'    ? 'flex' : 'none';
    document.getElementById('tabTransactions').style.display = tab === 'transactions' ? 'flex' : 'none';
    document.getElementById('tabHighlights').style.display   = tab === 'highlights'   ? 'flex' : 'none';
    if (tab === 'transactions') renderTransactionsTab();
    if (tab === 'highlights')   renderHighlightsTab();
}

function toggleTabMenu() {
    const menu = document.getElementById('tabSwitcher');
    const toggle = document.getElementById('tabMenuToggle');
    const isOpen = menu.classList.toggle('mobile-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
}

function closeTabMenu() {
    const menu = document.getElementById('tabSwitcher');
    const toggle = document.getElementById('tabMenuToggle');
    if (!menu || !toggle) return;
    menu.classList.remove('mobile-open');
    toggle.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', event => {
    const nav = document.querySelector('header nav');
    if (nav && !nav.contains(event.target)) closeTabMenu();
});


// =====================================================
//  API HELPERS
// =====================================================
function rowToSupabaseData(row) {
    const dateMatch = (row.Date || '').match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
    if (!dateMatch) throw new Error(`Invalid transaction date: ${row.Date || '(empty)'}`);
    let year = parseInt(dateMatch[3], 10);
    if (year < 100) year += 2000;
    const month = parseInt(dateMatch[2], 10);
    const day = parseInt(dateMatch[1], 10);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        throw new Error(`Invalid transaction date: ${row.Date}`);
    }

    const amount = Number(row.Amount);
    if (!Number.isFinite(amount)) throw new Error(`Invalid transaction amount: ${row.Amount}`);

    const data = {
        id: row.id || crypto.randomUUID(),
        expense: row.Expense,
        transaction_status: row.PlannedReal === 'Planned' ? 'Planned' : 'REA',
        category: row.Type,
        transaction_date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        amount,
        comments: row.Comments || null,
        account: row.Account || '',
        is_excluded: Boolean(row.excluded),
        source_system: row.sourceSystem || null,
        source_entry_reference: row.sourceEntryReference || null,
    };
    if (row.insertedAt) data.inserted_at = row.insertedAt;
    return data;
}

function supabaseDataToRow(d) {
    const dateMatch = (d.transaction_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) throw new Error(`Invalid date returned by Supabase: ${d.transaction_date}`);
    const year = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const day = parseInt(dateMatch[3], 10);
    const amount = Number(d.amount);
    const typeField = d.category || '';
    let account = d.account || '';
    const typeLower = typeField.toLowerCase();
    if (typeLower === 'anna')   account = 'anna';
    else if (typeLower === 'carlos') account = 'carlos';
    return {
        id:          d.id || '',
        Expense:     d.expense || '',
        PlannedReal: (d.transaction_status || '').toLowerCase().startsWith('plan') ? 'Planned' : 'Real',
        Type:        typeField,
        Date:        `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year).slice(-2)}`,
        DateSortKey: parseDateSortKey(d.transaction_date),
        Month:       month,
        Year:        year,
        Amount:      amount,
        Comments:    d.comments || '',
        Account:     account,
        sourceSystem: d.source_system || '',
        sourceEntryReference: d.source_entry_reference || '',
        insertedAt:  d.inserted_at || null,
        kind:        (amount < 0 || !typeField.startsWith('💰')) ? 'expense' : 'saving',
        excluded:    Boolean(d.is_excluded),
    };
}

async function loadData() {
    try {
        const data = [];
        const pageSize = 1000;
        for (let offset = 0; ; offset += pageSize) {
            const { data: page, error } = await supabaseClient
                .from('transactions')
                .select('id, expense, transaction_status, category, transaction_date, amount, comments, account, is_excluded, source_system, source_entry_reference, inserted_at')
                .order('transaction_date', { ascending: false })
                .range(offset, offset + pageSize - 1);
            if (error) throw new Error(error.message);
            data.push(...page);
            if (page.length < pageSize) break;
        }
        rawData = data.filter(d => Number(d.amount) !== 0).map(supabaseDataToRow);
        bootstrapApp();
        showToast(`✅ Loaded ${rawData.length} transactions`, 'success');
    } catch (e) {
        showToast('❌ Failed to load data from Supabase: ' + e.message, 'error');
    }
}

async function apiSaveRow(row) {
    const { data, error } = await supabaseClient
        .from('transactions')
        .upsert(rowToSupabaseData(row))
        .select()
        .single();
    if (error) throw new Error(error.message);
    return data;
}

async function apiDeleteRow(id) {
    const { error } = await supabaseClient.from('transactions').delete().eq('id', id);
    if (error) throw new Error(error.message);
}

function setAuthMessage(message) {
    document.getElementById('authMessage').textContent = message;
}

async function applyAuthSession(session) {
    const user = session?.user || null;
    const userId = user?.id || null;
    if (userId === activeAuthUserId) return;

    activeAuthUserId = userId;
    if (!user) {
        document.body.classList.remove('is-authenticated');
        document.getElementById('signedInEmail').textContent = '';
        rawData = [];
        return;
    }

    document.getElementById('signedInEmail').textContent = user.email || '';
    document.body.classList.add('is-authenticated');
    await loadData();
}

async function initializeSupabaseAuth() {
    const config = window.SUPABASE_CONFIG;
    const loginButton = document.getElementById('loginButton');
    const loginForm = document.getElementById('loginForm');

    loginForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!supabaseClient) return;
        loginButton.disabled = true;
        loginButton.textContent = 'Signing in…';
        setAuthMessage('');
        try {
            const { data, error } = await supabaseClient.auth.signInWithPassword({
                email: document.getElementById('loginEmail').value.trim(),
                password: document.getElementById('loginPassword').value,
            });
            if (error) throw error;
            await applyAuthSession(data.session);
        } catch (error) {
            setAuthMessage(error.message || 'Unable to sign in.');
        } finally {
            loginButton.disabled = false;
            loginButton.textContent = 'Sign in';
        }
    });

    document.getElementById('signOutButton').addEventListener('click', async () => {
        try {
            const { error } = await supabaseClient.auth.signOut();
            if (error) throw error;
        } catch (error) {
            showToast('❌ Sign out failed: ' + error.message, 'error');
        }
    });

    if (!config?.url?.trim() || !config?.anonKey?.trim()) {
        setAuthMessage('Set the Supabase project URL and public anon key in supabase-config.js.');
        loginButton.disabled = true;
        return;
    }
    if (!window.supabase?.createClient) {
        setAuthMessage('Could not load the Supabase client. Check the network and reload.');
        loginButton.disabled = true;
        return;
    }

    supabaseClient = window.supabase.createClient(config.url.trim(), config.anonKey.trim());
    supabaseClient.auth.onAuthStateChange((_event, session) => {
        queueMicrotask(() => {
            applyAuthSession(session).catch(error => {
                showToast('❌ Authentication error: ' + error.message, 'error');
            });
        });
    });

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    await applyAuthSession(data.session);
}


// =====================================================
//  ADD / EDIT TRANSACTION MODAL
// =====================================================
let _txEditId = null;   // null = adding, string = editing

function openTxModal(row) {
    _txEditId = row ? row.id : null;
    document.getElementById('txModalTitle').textContent   = row ? 'Edit Transaction' : 'Add Transaction';
    document.getElementById('txSubmitBtn').textContent    = row ? 'Save Changes' : 'Add Transaction';
    document.getElementById('txExpense').value            = row ? row.Expense      : '';
    document.getElementById('txType').value               = row ? row.Type         : '';
    document.getElementById('txDate').value               = row ? row.Date          : '';
    document.getElementById('txAmount').value             = row ? row.Amount        : '';
    const accountSelect = document.getElementById('txAccount');
    accountSelect.innerHTML = accountOptionsHtml(row ? row.Account : '');
    document.getElementById('txComments').value           = row ? row.Comments      : '';
    document.getElementById('txExcluded').value           = row ? (row.excluded ? 'true' : 'false') : 'false';
    document.getElementById('txModal').classList.add('open');
}
function closeTxModal() { document.getElementById('txModal').classList.remove('open'); }
function handleTxModalClick(e) {
    if (e.target === document.getElementById('txModal')) closeTxModal();
}
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeTabMenu();
        closeTxModal();
        closeExpensesTrendModal();
        closeIncomeTrendModal();
        closeHighlightsQuickFacts();
        // Close any open multi-select panels
        document.querySelectorAll('.ms-panel').forEach(p => p.style.display = 'none');
    }
});

function handleTrendModalClick(e) {
    if (e.target === document.getElementById('trendModal')) closeExpensesTrendModal();
}

async function submitTxForm(e) {
    e.preventDefault();
    const dateRaw = document.getElementById('txDate').value.trim();
    const amount  = parseFloat(document.getElementById('txAmount').value);
    const account = document.getElementById('txAccount').value;
    if (!account) {
        showToast('❌ Select an account before saving', 'error');
        return;
    }
    const row = {
        id:           _txEditId || '',
        Expense:      document.getElementById('txExpense').value.trim(),
        PlannedReal:  'Real',
        Type:         document.getElementById('txType').value.trim(),
        Date:         dateRaw,
        Amount:       amount,
        Comments:     document.getElementById('txComments').value.trim(),
        Account:      account,
        excluded:     document.getElementById('txExcluded').value === 'true',
    };
    try {
        const saved = await apiSaveRow(row);
        const newRow = supabaseDataToRow(saved);
        if (_txEditId) {
            const idx = rawData.findIndex(r => r.id === _txEditId);
            if (idx !== -1) rawData[idx] = newRow;
        } else {
            rawData.push(newRow);
            txPage = 1;
        }
        closeTxModal();
        applyGlobalFilters();
        populateYearFilter();
        populateCategoryFilter();
        renderDashboard();
        if (activeTab === 'transactions') renderTransactionsTab();
        if (activeTab === 'highlights') renderHighlightsTab();
        renderDrawerTable();
        showToast(_txEditId ? '✅ Transaction saved' : '✅ Transaction added', 'success');
    } catch (err) {
        showToast('❌ Error: ' + err.message, 'error');
    }
}


// =====================================================
//  BOOTSTRAP
// =====================================================
function bootstrapApp() {
    const currentYear = new Date().getFullYear();
    const availableYears = [...new Set(rawData.map(row => Number(row.Year)))];
    globalFilters.years = availableYears.includes(currentYear) ? [currentYear] : [];

    populateYearFilter();
    populateCategoryFilter();
    document.getElementById('emptyState').style.display      = 'none';
    document.getElementById('tabDashboard').style.display    = 'flex';
    document.getElementById('tabTransactions').style.display = 'none';
    document.getElementById('tabHighlights').style.display   = 'none';
    document.getElementById('tabSwitcher').style.display     = 'flex';
    applyGlobalFilters();
}

function populateYearFilter() {
    const years = [...new Set(rawData.map(d => Number(d.Year)))].sort((a, b) => a - b);
    ['yearMs', 'hlYearMs'].forEach(id => {
        const panel = document.getElementById(id + 'Panel');
        if (!panel) return;
        panel.innerHTML = years.map(year => `<label class="ms-item">
            <input type="checkbox" value="${year}" ${globalFilters.years.includes(year) ? 'checked' : ''} onchange="onYearCheckbox(this)">
            <span>${year}</span></label>`).join('');
        updateMsTriggerLabel(id, globalFilters.years.map(String), 'All Years');
    });
}

function populateCategoryFilter() {
    const cats = [...new Set(rawData.map(d => d.Type).filter(cat => cat && !isReviewCategory(cat)))].sort();
    const panel = document.getElementById('catMsPanel');
    if (!panel) return;
    panel.innerHTML = cats.map(c => `<label class="ms-item">
        <input type="checkbox" value="${c.replace(/"/g,'&quot;')}" ${globalFilters.categories.includes(c) ? 'checked' : ''} onchange="onCatCheckbox(this)">
        <span>${c}</span></label>`).join('');
    updateMsTriggerLabel('catMs', globalFilters.categories, 'All Categories');
}

function isReviewCategory(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/^⚠️\s*/, '');
    return normalized === 'review' || normalized === 'to review';
}

// ── Multi-select helpers ──────────────────────────
function updateMsTriggerLabel(id, selectedVals, allLabel) {
    const trigger = document.getElementById(id + 'Trigger');
    if (!trigger) return;
    if (!selectedVals.length)         trigger.textContent = allLabel + ' ▾';
    else if (selectedVals.length === 1) trigger.textContent = selectedVals[0] + ' ▾';
    else                              trigger.textContent = selectedVals.length + ' selected ▾';
}

function toggleMs(id) {
    document.querySelectorAll('.ms-panel').forEach(p => {
        if (p.id !== id + 'Panel') p.style.display = 'none';
    });
    const panel = document.getElementById(id + 'Panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', e => {
    if (!e.target.closest('.ms-wrap')) {
        document.querySelectorAll('.ms-panel').forEach(p => p.style.display = 'none');
    }
});

function onYearCheckbox(cb) {
    const yr = parseInt(cb.value);
    if (cb.checked) { if (!globalFilters.years.includes(yr)) globalFilters.years.push(yr); }
    else            { globalFilters.years = globalFilters.years.filter(y => y !== yr); }
    updateMsTriggerLabel('yearMs', globalFilters.years.map(String), 'All Years');
    updateMsTriggerLabel('hlYearMs', globalFilters.years.map(String), 'All Years');
    applyGlobalFilters();
    if (activeTab === 'highlights') renderHighlightsTab();
}

function onCatCheckbox(cb) {
    const cat = cb.value;
    if (cb.checked) { if (!globalFilters.categories.includes(cat)) globalFilters.categories.push(cat); }
    else            { globalFilters.categories = globalFilters.categories.filter(c => c !== cat); }
    updateMsTriggerLabel('catMs', globalFilters.categories, 'All Categories');
    applyGlobalFilters();
}


// =====================================================
//  DASHBOARD GLOBAL FILTERS
// =====================================================
document.getElementById('currencyToggle').addEventListener('click', e => {
    if (!e.target.classList.contains('toggle-btn')) return;
    document.querySelectorAll('#currencyToggle .toggle-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    globalFilters.currency = e.target.dataset.value;
    renderDashboard();
});

function applyGlobalFilters() {
    filteredData = rawData.filter(row => {
        if (row.excluded) return false;
        const okYear     = !globalFilters.years.length      || globalFilters.years.includes(row.Year);
        const okCategory = !globalFilters.categories.length || globalFilters.categories.includes(row.Type);
        return okYear && okCategory;
    });
    chartFilters  = { monthKey: null, typeKey: null, typeLevel: null, kind: null };
    drillDown     = { expenses: null, savings: null };
    monthlyDrillType = null;
    renderDashboard();
}

function renderDashboard() {
    updateStats();
    renderPieChart();
    renderMonthlyChart();
    // Keep open trend modals in sync with current filters
    if (document.getElementById('trendModal')?.classList.contains('open'))    renderExpensesTrendChart();
    if (document.getElementById('incTrendModal')?.classList.contains('open')) renderIncomeTrendChart();
}


// =====================================================
//  CURRENCY HELPERS
// =====================================================
function iDisp(v, currency) { return currency === 'EUR' ? v / EUR_RATE : v; }
function iFormatMoney(v, currency) {
    return currency === 'EUR'
        ? new Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR', maximumFractionDigits:0 }).format(v)
        : new Intl.NumberFormat('da-DK', { style:'currency', currency:'DKK', maximumFractionDigits:0 }).format(v);
}
function iFormatShort(v, currency) {
    const val = currency === 'EUR' ? v / EUR_RATE : v;
    return Math.abs(val) >= 1000 ? `${(val/1000).toFixed(1)}k` : Math.round(val).toString();
}
function toDisplay(v) { return globalFilters.currency === 'EUR' ? v / EUR_RATE : v; }
function currSymbol() { return globalFilters.currency === 'EUR' ? '€' : 'kr'; }
function formatMoney(v) {
    return globalFilters.currency === 'EUR'
        ? new Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR', maximumFractionDigits:0 }).format(v)
        : new Intl.NumberFormat('da-DK', { style:'currency', currency:'DKK', maximumFractionDigits:0 }).format(v);
}


// =====================================================
//  KPI
// =====================================================
function updateStats() {
    // Respect active chart filters (type / category selection) so KPIs reflect selection
    const data = (chartFilters.typeKey || chartFilters.monthKey)
        ? getChartData(false, false)
        : filteredData;

    const totalExp = data.filter(d => d.kind === 'expense')
        .reduce((s, d) => s - d.Amount, 0);
    const totalInc = data.filter(d => d.kind === 'saving')
        .reduce((s, d) => s + d.Amount, 0);
    const totalSav = totalInc - totalExp;

    const expMonths = new Set(data.filter(d => d.kind === 'expense').map(d => `${d.Year}-${d.Month}`)).size || 1;
    const incMonths = new Set(data.filter(d => d.kind === 'saving').map(d => `${d.Year}-${d.Month}`)).size || 1;
    const allMonths = new Set(data.map(d => `${d.Year}-${d.Month}`)).size || 1;

    document.getElementById('kpiExpTotal').textContent   = formatMoney(toDisplay(totalExp));
    document.getElementById('kpiExpMonthly').textContent = formatMoney(toDisplay(totalExp / expMonths));
    document.getElementById('kpiIncTotal').textContent   = formatMoney(toDisplay(totalInc));
    document.getElementById('kpiIncMonthly').textContent = formatMoney(toDisplay(totalInc / incMonths));
    document.getElementById('kpiSavTotal').textContent   = formatMoney(toDisplay(totalSav));
    document.getElementById('kpiSavMonthly').textContent = formatMoney(toDisplay(totalSav / allMonths));
}

function sumRows(data, kind, pr, useAbs) {
    return data.filter(d => d.kind === kind && d.PlannedReal === pr)
        .reduce((s,d) => s + (useAbs ? Math.abs(d.Amount) : d.Amount), 0);
}

// =====================================================
//  EXPENSES TREND MODAL
// =====================================================
function openExpensesTrendModal() {
    document.getElementById('trendModal').classList.add('open');
    renderExpensesTrendChart();
}

function closeExpensesTrendModal() {
    document.getElementById('trendModal').classList.remove('open');
    if (charts.expTrend) { charts.expTrend.destroy(); charts.expTrend = null; }
}

function renderExpensesTrendChart() {
    const canvas = document.getElementById('expTrendChart');
    if (!canvas) return;
    if (charts.expTrend) { charts.expTrend.destroy(); charts.expTrend = null; }

    // Respect active chart cross-filters (pie / heatmap selection)
    const base = getChartData(false, false).filter(d => d.kind === 'expense' && d.PlannedReal === 'Real');
    if (!base.length) { if (charts.expTrend) { charts.expTrend.destroy(); charts.expTrend = null; } return; }

    const MNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Build a continuous sorted list of year-month keys that have data
    const ymKeys = [...new Set(base.map(d => `${d.Year}-${String(d.Month).padStart(2,'0')}`))].sort();
    const labels = ymKeys.map(ym => {
        const [y, m] = ym.split('-');
        return `${MNAMES[parseInt(m) - 1]} '${y.slice(2)}`;
    });
    const values = ymKeys.map(ym => {
        const [y, m] = ym.split('-');
        const yr = parseInt(y), mo = parseInt(m);
        return iDisp(base.filter(d => d.Year === yr && d.Month === mo)
            .reduce((s, d) => s - d.Amount, 0), globalFilters.currency);
    });

    charts.expTrend = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Expenses',
                data: values,
                borderColor: '#ef4444',
                backgroundColor: 'rgba(239,68,68,0.1)',
                pointBackgroundColor: '#ef4444',
                pointRadius: 4,
                borderWidth: 2,
                tension: 0.35,
                fill: true,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` Expenses: ${formatMoney(ctx.parsed.y)}` } }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: v => `${(v / 1000).toFixed(0)}k ${currSymbol()}` },
                    grid: { color: chartGridColor() }
                },
                x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } }
            }
        }
    });
}

// =====================================================
//  INCOME TREND MODAL
// =====================================================
function openIncomeTrendModal() {
    document.getElementById('incTrendModal').classList.add('open');
    renderIncomeTrendChart();
}

function closeIncomeTrendModal() {
    const modal = document.getElementById('incTrendModal');
    if (modal) modal.classList.remove('open');
    if (charts.incTrend) { charts.incTrend.destroy(); charts.incTrend = null; }
}

function handleIncTrendModalClick(e) {
    if (e.target === document.getElementById('incTrendModal')) closeIncomeTrendModal();
}

function openHighlightsQuickFacts() {
    document.getElementById('highlightsQuickFactsModal').classList.add('open');
}
function closeHighlightsQuickFacts() {
    document.getElementById('highlightsQuickFactsModal').classList.remove('open');
}
function handleHighlightsQuickFactsModalClick(e) {
    if (e.target === document.getElementById('highlightsQuickFactsModal')) {
        closeHighlightsQuickFacts();
    }
}

function renderIncomeTrendChart() {
    const canvas = document.getElementById('incTrendChart');
    if (!canvas) return;
    if (charts.incTrend) { charts.incTrend.destroy(); charts.incTrend = null; }

    // Respect active chart cross-filters (pie / heatmap selection)
    const base = getChartData(false, false).filter(d => d.kind === 'saving' && d.PlannedReal === 'Real');
    if (!base.length) { if (charts.incTrend) { charts.incTrend.destroy(); charts.incTrend = null; } return; }

    const MNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const ymKeys = [...new Set(base.map(d => `${d.Year}-${String(d.Month).padStart(2,'0')}`))].sort();
    const labels = ymKeys.map(ym => {
        const [y, m] = ym.split('-');
        return `${MNAMES[parseInt(m) - 1]} '${y.slice(2)}`;
    });
    const values = ymKeys.map(ym => {
        const [y, m] = ym.split('-');
        const yr = parseInt(y), mo = parseInt(m);
        return iDisp(base.filter(d => d.Year === yr && d.Month === mo)
            .reduce((s, d) => s + d.Amount, 0), globalFilters.currency);
    });

    charts.incTrend = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Income',
                data: values,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16,185,129,0.1)',
                pointBackgroundColor: '#10b981',
                pointRadius: 4,
                borderWidth: 2,
                tension: 0.35,
                fill: true,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` Income: ${formatMoney(ctx.parsed.y)}` } }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: v => `${(v / 1000).toFixed(0)}k ${currSymbol()}` },
                    grid: { color: chartGridColor() }
                },
                x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } }
            }
        }
    });
}



function setKpiBadge(id, real, planned, kind) {
    const el = document.getElementById(id);
    if (!planned) { el.textContent = ''; return; }
    const diff = ((real - planned) / Math.abs(planned)) * 100;
    const T = 2;
    let label, cls;
    if (Math.abs(diff) <= T) { label = '✓ On Target'; cls = 'badge-on-target'; }
    else if (kind === 'expense') {
        label = diff > 0 ? `▲ ${diff.toFixed(1)}% Over` : `▼ ${Math.abs(diff).toFixed(1)}% Under`;
        cls   = diff > 0 ? 'badge-over' : 'badge-under';
    } else {
        label = diff > 0 ? `▲ ${diff.toFixed(1)}% Ahead` : `▼ ${Math.abs(diff).toFixed(1)}% Behind`;
        cls   = diff > 0 ? 'badge-on-target' : 'badge-over';
    }
    el.textContent = label;
    el.className   = `kpi-badge ${cls}`;
}


// =====================================================
//  DASHBOARD CROSS-FILTER
// =====================================================
function getChartData(skipMonth = false, skipType = false) {
    return filteredData.filter(row => {
        if (!skipMonth && chartFilters.monthKey) {
            const key = `${row.Year}-${String(row.Month).padStart(2,'0')}`;
            if (key !== chartFilters.monthKey) return false;
        }
        if (!skipType && chartFilters.typeKey && chartFilters.kind) {
            if (row.kind === chartFilters.kind) {
                const val = chartFilters.typeLevel === 'Expense' ? row.Expense : row.Type;
                if (val !== chartFilters.typeKey) return false;
            }
        }
        return true;
    });
}

function toggleMonthFilter(monthKey) {
    chartFilters.monthKey = chartFilters.monthKey === monthKey ? null : monthKey;
    renderDashboard();
}

function toggleTypeFilter(label, kind, level) {
    if (chartFilters.typeKey === label && chartFilters.kind === kind) {
        chartFilters.typeKey = null; chartFilters.kind = null; chartFilters.typeLevel = null;
    } else {
        chartFilters.typeKey = label; chartFilters.kind = kind; chartFilters.typeLevel = level;
    }
    renderDashboard();
}


// Distinct colour palette for pie slices (12 colours, cycles for more)
const PIE_PALETTE = [
    '#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899',
    '#14b8a6','#f97316','#84cc16','#06b6d4','#a855f7','#eab308',
];

// =====================================================
//  DASHBOARD PIE CHART
// =====================================================
function toggleChartsKind(kind) {
    pieKind            = kind;
    monthlyHeatmapKind = kind;
    monthlyDrillType   = null;
    drillDown          = { expenses: null, savings: null };
    chartFilters.typeKey = null; chartFilters.kind = null; chartFilters.typeLevel = null;
    document.querySelectorAll('.charts-kind-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.kind === kind)
    );

    // Auto-drill into subcategories when switching to Income if there is only one Type
    if (kind === 'saving') {
        const incomeBase  = getChartData(false, true).filter(d => d.kind === 'saving');
        const incomeTypes = [...new Set(incomeBase.map(d => d.Type))];
        if (incomeTypes.length === 1) {
            drillDown.savings  = incomeTypes[0];
            monthlyDrillType   = incomeTypes[0];
        }
    }

    renderPieChart();
    renderMonthlyChart();
}

// Keep individual functions as thin wrappers for back-compat
function togglePieKind(kind)            { toggleChartsKind(kind); }
function toggleMonthlyHeatmapKind(kind) { toggleChartsKind(kind); }

function resetPieDrill() {
    const which = pieKind === 'expense' ? 'expenses' : 'savings';
    resetDrillDown(which);
}

function renderPieChart() {
    const canvas = document.getElementById('pieChart');
    if (charts.pie) { charts.pie.destroy(); charts.pie = null; }
    const isExp    = pieKind === 'expense';
    const base     = getChartData(false, true).filter(d => d.kind === pieKind);
    const drillKey = isExp ? 'expenses' : 'savings';
    const drilled  = drillDown[drillKey];

    let groupRows, groupField, title, isDrilled;
    if (drilled) {
        groupRows  = base.filter(d => d.Type === drilled);
        groupField = 'Expense';
        title      = isExp ? `💸 Expenses › ${drilled}` : `💰 Income › ${drilled}`;
        isDrilled  = true;
        document.getElementById('breadcrumbPie').style.display   = 'flex';
        document.getElementById('breadcrumbPieType').textContent = drilled;
    } else {
        groupRows  = base;
        groupField = 'Type';
        title      = isExp ? '💸 Expenses by Type' : '💰 Income by Type';
        isDrilled  = false;
        document.getElementById('breadcrumbPie').style.display = 'none';
    }
    document.getElementById('pieChartTitle').textContent = title;
    document.getElementById('pieChartBox').classList.toggle(
        'filtered', !!chartFilters.typeKey && chartFilters.kind === pieKind);

    // Aggregate by group field
    const map = {};
    groupRows.forEach(d => {
        const k = d[groupField];
        map[k] = (map[k] || 0) + (d.kind === 'expense' ? -d.Amount : d.Amount);
    });
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    const labels  = entries.map(e => e[0]);
    const values  = entries.map(e => toDisplay(e[1]));

    if (!labels.length) return;

    const bgColors     = labels.map((_, i) => PIE_PALETTE[i % PIE_PALETTE.length] + 'cc');
    const borderColors = labels.map((_, i) => PIE_PALETTE[i % PIE_PALETTE.length]);

    const pieSliceLabelPlugin = {
        id: 'pieSliceLabel',
        afterDraw(chart) {
            const { ctx, data } = chart;
            const ds    = data.datasets[0];
            const total = ds.data.reduce((a, b) => a + b, 0);
            const meta  = chart.getDatasetMeta(0);
            ctx.save();
            meta.data.forEach((arc, i) => {
                const val = ds.data[i];
                if (!val) return;
                const pct      = (val / total) * 100;
                const midAngle = (arc.startAngle + arc.endAngle) / 2;
                const cx = arc.x, cy = arc.y;
                const outerR = arc.outerRadius, innerR = arc.innerRadius;

                // ── % text inside the slice ──────────────────
                if (pct >= 3.5) {
                    const r  = (outerR + innerR) / 2;
                    const ix = cx + Math.cos(midAngle) * r;
                    const iy = cy + Math.sin(midAngle) * r;
                    ctx.font         = 'bold 11px system-ui,sans-serif';
                    ctx.fillStyle    = '#ffffff';
                    ctx.textAlign    = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(`${pct.toFixed(1)}%`, ix, iy);
                }

                // ── label outside with leader line ───────────
                if (pct > 7) {
                    const lx1 = cx + Math.cos(midAngle) * (outerR + 6);
                    const ly1 = cy + Math.sin(midAngle) * (outerR + 6);
                    const lx2 = cx + Math.cos(midAngle) * (outerR + 20);
                    const ly2 = cy + Math.sin(midAngle) * (outerR + 20);
                    const isRight = Math.cos(midAngle) >= 0;
                    const textX = lx2 + (isRight ? 5 : -5);

                    ctx.strokeStyle = ds.borderColor[i];
                    ctx.lineWidth   = 1.2;
                    ctx.beginPath();
                    ctx.moveTo(lx1, ly1);
                    ctx.lineTo(lx2, ly2);
                    ctx.stroke();

                    ctx.font         = '11px system-ui,sans-serif';
                    ctx.fillStyle    = chartTextColor();
                    ctx.textAlign    = isRight ? 'left' : 'right';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(data.labels[i], textX, ly2);
                }
            });
            ctx.restore();
        }
    };

    charts.pie = new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: bgColors,
                borderColor: borderColors,
                borderWidth: 2,
                hoverOffset: 10,
            }]
        },
        plugins: [pieSliceLabelPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '38%',
            layout: { padding: { left: 90, right: 90, top: 30, bottom: 30 } },
            onClick(evt, elements) {
                if (!elements.length) return;
                const clicked = labels[elements[0].index];
                if (!isDrilled) {
                    drillDown[drillKey] = clicked;
                    toggleTypeFilter(clicked, pieKind, 'Type');
                    openDrawerForType(clicked, pieKind, 'Type', base);
                } else {
                    toggleTypeFilter(clicked, pieKind, 'Expense');
                    openDrawerForType(clicked, pieKind, 'Expense',
                        base.filter(d => d.Type === drilled));
                }
            },
            onHover(e) { e.native.target.style.cursor = 'pointer'; },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label(ctx) {
                            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                            const pct   = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : '0';
                            return ` ${ctx.label}: ${formatMoney(ctx.parsed)} (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
}

function resetDrillDown(which) {
    drillDown[which]       = null;
    chartFilters.typeKey   = null;
    chartFilters.kind      = null;
    chartFilters.typeLevel = null;
    closeDrawer();
    renderDashboard();
}

function drillMonthlyHeatmap(catIdx) {
    const cat = _monthlyCategories[catIdx];
    monthlyDrillType       = cat;
    // Update chart type filter so KPIs reflect this category selection
    chartFilters.typeKey   = cat;
    chartFilters.kind      = monthlyHeatmapKind;
    chartFilters.typeLevel = 'Type';
    renderDashboard();
}

function resetMonthlyDrill() {
    monthlyDrillType       = null;
    chartFilters.typeKey   = null;
    chartFilters.kind      = null;
    chartFilters.typeLevel = null;
    renderDashboard();
}

function renderMonthlyChart() {
    const container = document.getElementById('monthlyHeatmapContainer');
    const base = getChartData(true, false).filter(d => d.kind === monthlyHeatmapKind);

    // Update breadcrumb visibility
    const bc = document.getElementById('monthlyHeatmapBreadcrumb');
    if (monthlyDrillType) {
        bc.style.display = 'flex';
        document.getElementById('monthlyDrillLabel').textContent = monthlyDrillType;
    } else {
        bc.style.display = 'none';
    }

    if (!base.length) {
        container.innerHTML = '<p style="color:var(--text-light);padding:1rem">No data</p>';
        _monthlyCategories = [];
        return;
    }

    const MNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const months  = [1,2,3,4,5,6,7,8,9,10,11,12];
    const isExp   = monthlyHeatmapKind === 'expense';

    // Drilled: show Expense sub-categories for the selected Type
    // Top-level: show Types
    const drillBase = monthlyDrillType
        ? base.filter(d => d.Type === monthlyDrillType)
        : base;
    const groupField = monthlyDrillType ? 'Expense' : 'Type';

    const catSet = [...new Set(drillBase.map(d => d[groupField]))];

    // Build map: category -> month -> total
    const map = {};
    catSet.forEach(c => { map[c] = {}; });
    drillBase.forEach(d => {
        const key = d[groupField];
        map[key][d.Month] = (map[key][d.Month] || 0) + (d.kind === 'expense' ? -d.Amount : d.Amount);
    });

    // Sort by grand total descending
    catSet.sort((a, b) => {
        const tA = months.reduce((s, m) => s + (map[a][m] || 0), 0);
        const tB = months.reduce((s, m) => s + (map[b][m] || 0), 0);
        return tB - tA;
    });

    _monthlyCategories = catSet;

    const rowHeader = monthlyDrillType ? 'Sub-Category' : 'Category';
    let html = `<table class="heatmap-table monthly-heatmap">
        <thead><tr>
            <th class="row-header">${rowHeader}</th>
            ${months.map(m => `<th>${MNAMES[m-1]}</th>`).join('')}
        </tr></thead><tbody>`;

    // Global min/max across all rows so colour scale is consistent
    const allNonZero = catSet.flatMap(c => months.map(m => map[c][m] || 0)).filter(v => v > 0);
    const globalMax  = Math.max(...allNonZero, 1);
    const globalMin  = allNonZero.length ? Math.min(...allNonZero) : 0;

    catSet.forEach((cat, catIdx) => {
        // Row label: top-level → click to drill; drilled → click opens drawer
        const rowClick = monthlyDrillType
            ? `openMonthlyRowDrawer(${catIdx})`
            : `drillMonthlyHeatmap(${catIdx})`;
        const rowTitle = monthlyDrillType ? '' : ` title="Click to drill into ${cat}"`;
        const rowIcon  = monthlyDrillType ? '' : ' <span style="font-size:0.7rem;opacity:0.6">▶</span>';

        html += `<tr><td class="row-label" onclick="${rowClick}" style="cursor:pointer"${rowTitle}>${cat}${rowIcon}</td>`;

        months.forEach(m => {
            const val = map[cat][m];
            if (!val) {
                html += `<td class="empty-cell">—</td>`;
            } else {
                const t   = (val - globalMin) / (globalMax - globalMin || 1);
                const a   = 0.18 + t * 0.82;
                const bg  = isExp
                    ? `rgba(239,68,68,${a.toFixed(2)})`
                    : `rgba(16,185,129,${a.toFixed(2)})`;
                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                const fg  = isDark || t > 0.55 ? '#ffffff' : '#1e293b';
                const disp = iFormatShort(val, globalFilters.currency);
                const tip  = `${cat} — ${MNAMES[m-1]}: ${formatMoney(toDisplay(val))}`;
                html += `<td style="background:${bg};color:${fg};cursor:pointer" title="${tip}"
                    onclick="openDrawerFromMonthlyHeatmap(${catIdx},${m})">${disp}</td>`;
            }
        });
        html += `</tr>`;
    });

    // Totals row
    const monthTotals = months.map(m =>
        catSet.reduce((s, c) => s + (map[c][m] || 0), 0)
    );
    html += `<tr class="heatmap-totals-row"><td class="row-label row-totals-label">Total</td>`;
    months.forEach((m, mi) => {
        const val = monthTotals[mi];
        html += val
            ? `<td class="heatmap-totals-cell">${iFormatShort(val, globalFilters.currency)}</td>`
            : `<td class="heatmap-totals-cell">—</td>`;
    });
    html += `</tr>`;

    html += `</tbody></table>`;
    container.innerHTML = html;
}

function openDrawerFromMonthlyHeatmap(catIdx, month) {
    const MNAMES   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const category = _monthlyCategories[catIdx];
    const base     = getChartData(true, false).filter(d => d.kind === monthlyHeatmapKind);
    const field    = monthlyDrillType ? 'Expense' : 'Type';
    const rows     = base.filter(d => d[field] === category && d.Month === month
        && (!monthlyDrillType || d.Type === monthlyDrillType));
    const icon     = monthlyHeatmapKind === 'expense' ? '💸' : '💰';
    openDrawerWith(rows, `${icon} ${category} — ${MNAMES[month-1]}`, `${rows.length} transactions`);
}

function openMonthlyRowDrawer(catIdx) {
    const category = _monthlyCategories[catIdx];
    const field    = monthlyDrillType ? 'Expense' : 'Type';
    const base     = getChartData(true, false).filter(d =>
        d.kind === monthlyHeatmapKind && d[field] === category
        && (!monthlyDrillType || d.Type === monthlyDrillType)
    );
    const icon = monthlyHeatmapKind === 'expense' ? '💸' : '💰';
    openDrawerWith(base, `${icon} ${category}`, `${base.length} transactions`);
}


// =====================================================
//  SHARED DASHBOARD BAR OPTIONS
// =====================================================
function makeBarOptions(onBarClick, onLegendClick, horizontal = false) {
    return {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        onClick(evt, elements) {
            if (elements.length > 0 && onBarClick)
                onBarClick(elements[0].index, elements[0].datasetIndex);
        },
        onHover(e) { e.native.target.style.cursor = 'pointer'; },
        plugins: {
            legend: {
                position: 'top',
                labels: { font: { size: 11 }, padding: 12 },
                onClick(e, legendItem, legend) {
                    const ci   = legend.chart;
                    const meta = ci.getDatasetMeta(legendItem.datasetIndex);
                    meta.hidden = meta.hidden === null
                        ? !ci.data.datasets[legendItem.datasetIndex].hidden : null;
                    ci.update();
                    if (onLegendClick) onLegendClick(legendItem.text, meta.hidden === true);
                }
            },
            tooltip: {
                callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatMoney(horizontal ? ctx.parsed.x : ctx.parsed.y)}` }
            }
        },
        scales: horizontal ? {
            x: {
                beginAtZero: true,
                ticks: { callback: v => `${(v/1000).toFixed(0)}k ${currSymbol()}` },
                grid:  { color: chartGridColor() }
            },
            y: { grid: { display: false } }
        } : {
            y: {
                beginAtZero: true,
                ticks: { callback: v => `${(v/1000).toFixed(0)}k ${currSymbol()}` },
                grid:  { color: chartGridColor() }
            },
            x: { grid: { display: false } }
        }
    };
}


// =====================================================
//  DRAWER
// =====================================================
function openDrawerWith(rows, title, subtitle) {
    drawerData     = rows;
    drawerFiltered = [...rows];
    drawerPage     = 1;
    drawerSort     = { key: 'Date', dir: 'asc' };
    document.getElementById('drawerTitle').textContent    = title;
    document.getElementById('drawerSubtitle').textContent = subtitle;
    document.getElementById('drawerSearch').value         = '';
    renderDrawerTable();
    document.getElementById('drawerOverlay').classList.add('open');
    document.getElementById('transactionDrawer').classList.add('open');
}

function openDrawerForType(label, kind, level, sourceRows) {
    const rows = sourceRows.filter(d =>
        level === 'Expense' ? d.Expense === label : d.Type === label
    );
    openDrawerWith(rows,
        kind === 'expense' ? `💸 ${label}` : `💰 ${label}`,
        `${level}: ${label} · ${rows.length} transactions`
    );
}

function closeDrawer() {
    document.getElementById('drawerOverlay').classList.remove('open');
    document.getElementById('transactionDrawer').classList.remove('open');
}

function updateDrawerSaveButton() {
    const button = document.getElementById('drawerSaveButton');
    if (!button) return;
    const count = drawerDirtyRows.size;
    button.disabled = drawerSaving || count === 0;
    const label = drawerSaving
        ? 'Saving changes…'
        : count ? `Save changes (${count})` : 'Save changes';
    button.setAttribute('aria-label', label);
    button.title = label;
}

function markDrawerRowDirty(row) {
    drawerDirtyRows.add(row);
    updateDrawerSaveButton();
}

function dateInputValue(date) {
    const parsed = parseDateFromString(date);
    if (!parsed || isNaN(parsed)) return '';
    const pad = value => String(value).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function updateDrawerRowDate(row, value) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
        return false;
    }

    const pad = number => String(number).padStart(2, '0');
    row.Date = `${pad(day)}/${pad(month)}/${String(year).slice(-2)}`;
    row.DateSortKey = parseDateSortKey(row.Date);
    row.Month = month;
    row.Year = year;
    return true;
}

async function saveDrawerChanges() {
    if (drawerSaving || !drawerDirtyRows.size) return;
    drawerSaving = true;
    updateDrawerSaveButton();

    let saved = 0;
    const failed = [];
    for (const row of [...drawerDirtyRows]) {
        const snapshot = JSON.stringify(rowToSupabaseData(row));
        try {
            await apiSaveRow(row);
            saved++;
            if (JSON.stringify(rowToSupabaseData(row)) === snapshot) drawerDirtyRows.delete(row);
        } catch (err) {
            failed.push(err.message);
        }
    }

    drawerSaving = false;
    updateDrawerSaveButton();
    if (failed.length) {
        const message = `❌ Saved ${saved}; ${failed.length} failed: ${failed[0]}`;
        showToast(message, 'error');
    } else {
        showToast(`✅ Saved ${saved} transaction${saved === 1 ? '' : 's'}`, 'success');
    }
}

function renderDrawerTable() {
    const search = document.getElementById('drawerSearch').value.toLowerCase();

    drawerFiltered = drawerData.filter(row => {
        const okSr = !search ||
            row.Type.toLowerCase().includes(search)    ||
            row.Expense.toLowerCase().includes(search) ||
            row.Date.includes(search)                  ||
            row.Comments.toLowerCase().includes(search);
        return okSr;
    });

    drawerFiltered.sort((a, b) => {
        let A = drawerSort.key === 'Date' ? a.DateSortKey : a[drawerSort.key];
        let B = drawerSort.key === 'Date' ? b.DateSortKey : b[drawerSort.key];
        if (drawerSort.key === 'Amount') { A = Math.abs(a.Amount); B = Math.abs(b.Amount); }
        if (A < B) return drawerSort.dir === 'asc' ? -1 : 1;
        if (A > B) return drawerSort.dir === 'asc' ?  1 : -1;
        return 0;
    });

    const start = (drawerPage - 1) * DRAWER_PER;
    const page  = drawerFiltered.slice(start, start + DRAWER_PER);
    const tbody = document.getElementById('drawerTableBody');

    const fmtFn = v => formatMoney(toDisplay(v));

    // Ensure datalists are populated for autocomplete
    updateTxDataLists();

    tbody.innerHTML = '';

    if (!page.length) {
        const empty = document.createElement('tr');
        empty.innerHTML = `<td colspan="7" style="text-align:center;padding:1.5rem;color:var(--text-light)">No transactions found.</td>`;
        tbody.appendChild(empty);
    } else {
        page.forEach(row => {
            const tr = document.createElement('tr');
            if (row.excluded) tr.classList.add('tx-row-dimmed');

            // ── Date ──────────────────────────────────
            const tdDate = document.createElement('td');
            const inpDate = document.createElement('input');
            inpDate.className = 'tx-date-input drawer-date-input';
            inpDate.type = 'date';
            inpDate.value = dateInputValue(row.Date);
            inpDate.setAttribute('aria-label', 'Transaction date');
            inpDate.addEventListener('change', () => {
                if (!updateDrawerRowDate(row, inpDate.value)) return;
                markDrawerRowDirty(row);
                applyGlobalFilters();
                renderDashboard();
                if (activeTab === 'highlights') renderHighlightsTab();
            });
            tdDate.appendChild(inpDate);
            tr.appendChild(tdDate);

            // ── Amount ────────────────────────────────
            const tdAmt = document.createElement('td');
            tdAmt.className = `${row.Amount >= 0 ? 'amount-saving' : 'amount-expense'} tx-amount`;
            tdAmt.textContent = (row.Amount >= 0 ? '+' : '−') +
                new Intl.NumberFormat('da-DK', { maximumFractionDigits: 2 }).format(Math.abs(row.Amount));
            tr.appendChild(tdAmt);

            // ── Sub-category (Expense) — editable ────
            const tdExp  = document.createElement('td');
            const inpExp = document.createElement('input');
            inpExp.className   = 'drawer-cat-input';
            inpExp.setAttribute('list', 'expenseOptions');
            inpExp.value       = row.Expense;
            inpExp.placeholder = 'Sub-category…';
            inpExp.addEventListener('change', () => {
                row.Expense = inpExp.value.trim();
                markDrawerRowDirty(row);
                updateTxDataLists();
                applyGlobalFilters();
                renderDashboard();
                if (activeTab === 'highlights') renderHighlightsTab();
            });
            tdExp.appendChild(inpExp);
            tr.appendChild(tdExp);

            // ── Category (Type) — editable ────────────
            const tdType  = document.createElement('td');
            const inpType = document.createElement('input');
            inpType.className   = 'drawer-cat-input';
            inpType.setAttribute('list', 'typeOptions');
            inpType.value       = row.Type;
            inpType.placeholder = 'Category…';
            inpType.addEventListener('change', () => {
                row.Type = inpType.value.trim();
                row.kind = (row.Amount < 0 || !row.Type.startsWith('💰')) ? 'expense' : 'saving';
                markDrawerRowDirty(row);
                updateTxDataLists();
                applyGlobalFilters();
                renderDashboard();
                if (activeTab === 'highlights') renderHighlightsTab();
            });
            tdType.appendChild(inpType);
            tr.appendChild(tdType);

            // ── Description (editable comment) ────────
            const tdDesc   = document.createElement('td');
            const inpDesc  = document.createElement('input');
            inpDesc.className   = 'drawer-cat-input';
            inpDesc.value       = row.Comments || '';
            inpDesc.placeholder = 'Add comment…';
            inpDesc.title       = row.Comments || '';
            inpDesc.addEventListener('change', () => {
                row.Comments     = inpDesc.value;
                inpDesc.title    = inpDesc.value;
                markDrawerRowDirty(row);
            });
            tdDesc.appendChild(inpDesc);
            tr.appendChild(tdDesc);

            // ── Account ───────────────────────────────
            const tdAcct = document.createElement('td');
            const acct = String(row.Account || '').toLowerCase();
            const acctSel = document.createElement('select');
            acctSel.className = `tx-acct-select tx-acct-${acct}`;
            acctSel.innerHTML = accountOptionsHtml(acct);
            acctSel.addEventListener('change', () => {
                row.Account = acctSel.value;
                acctSel.className = `tx-acct-select tx-acct-${acctSel.value}`;
                markDrawerRowDirty(row);
            });
            tdAcct.appendChild(acctSel);
            tr.appendChild(tdAcct);

            // ── Analytics toggle ──────────────────────
            const tdExcl = document.createElement('td');
            const btn    = document.createElement('button');
            const setBtn = () => {
                btn.className = `tx-excl-btn ${row.excluded ? 'tx-excluded' : 'tx-included'}`;
                btn.textContent = row.excluded ? '🚫 Off' : '✅ On';
                btn.title = row.excluded
                    ? 'Excluded from analytics — click to include'
                    : 'Included in analytics — click to exclude';
                tr.classList.toggle('tx-row-dimmed', !!row.excluded);
            };
            setBtn();
            btn.addEventListener('click', () => {
                row.excluded = !row.excluded;
                setBtn();
                markDrawerRowDirty(row);
                applyGlobalFilters();
                renderDashboard();
                if (activeTab === 'highlights') renderHighlightsTab();
            });
            tdExcl.appendChild(btn);
            tr.appendChild(tdExcl);

            tbody.appendChild(tr);
        });
    }

    const totExp = drawerFiltered.filter(d => d.kind === 'expense').reduce((s, d) => s - d.Amount, 0);
    const totSav = drawerFiltered.filter(d => d.kind === 'saving').reduce((s, d) => s + d.Amount, 0);

    document.getElementById('drawerSummary').innerHTML = `
        <div class="drawer-summary-item">Records: <strong>${drawerFiltered.length}</strong></div>
        ${totExp ? `<div class="drawer-summary-item">Expenses: <strong class="amount-expense">${fmtFn(totExp)}</strong></div>` : ''}
        ${totSav ? `<div class="drawer-summary-item">Savings: <strong class="amount-saving">${fmtFn(totSav)}</strong></div>` : ''}`;

    renderDrawerPagination();
    updateDrawerSaveButton();
}

function renderDrawerPagination() {
    const total = Math.ceil(drawerFiltered.length / DRAWER_PER);
    const el    = document.getElementById('drawerPagination');
    if (total <= 1) { el.innerHTML = ''; return; }
    let html = `<button class="page-btn" onclick="changeDrawerPage(${drawerPage-1})"
        ${drawerPage===1?'disabled':''}>← Prev</button>`;
    for (let i=1; i<=total; i++) {
        if (i===1||i===total||(i>=drawerPage-2&&i<=drawerPage+2))
            html += `<button class="page-btn ${i===drawerPage?'active':''}"
                onclick="changeDrawerPage(${i})">${i}</button>`;
        else if (i===drawerPage-3||i===drawerPage+3)
            html += `<span style="padding:.35rem .5rem;color:var(--text-light)">…</span>`;
    }
    html += `<button class="page-btn" onclick="changeDrawerPage(${drawerPage+1})"
        ${drawerPage===total?'disabled':''}>Next →</button>`;
    el.innerHTML = html;
}

function changeDrawerPage(p) {
    const total = Math.ceil(drawerFiltered.length / DRAWER_PER);
    if (p<1||p>total) return;
    drawerPage = p;
    renderDrawerTable();
}

function sortDrawer(key) {
    drawerSort.dir = drawerSort.key===key ? (drawerSort.dir==='asc'?'desc':'asc') : 'asc';
    drawerSort.key = key;
    drawerPage     = 1;
    renderDrawerTable();
}


// =====================================================
//  CHART DATA HELPERS
// =====================================================
function buildGrouped(rows, groupKey) {
    const map = {};
    rows.forEach(r => {
        const k = r[groupKey];
        if (!map[k]) map[k] = { p:0, r:0 };
        if (r.PlannedReal==='Planned') map[k].p += Math.abs(r.Amount);
        else                           map[k].r += Math.abs(r.Amount);
    });
    const labels      = Object.keys(map);
    const plannedVals = labels.map(l => map[l].p);
    const realVals    = labels.map(l => map[l].r);
    return { labels, plannedVals, realVals };
}

function sortByTotal(labels, plannedVals, realVals) {
    const idx = labels.map((_,i)=>i)
        .sort((a,b)=>(plannedVals[b]+realVals[b])-(plannedVals[a]+realVals[a]));
    const lc=[...labels],pc=[...plannedVals],rc=[...realVals];
    idx.forEach((si,di)=>{ labels[di]=lc[si]; plannedVals[di]=pc[si]; realVals[di]=rc[si]; });
}


// =====================================================
//  TRANSACTIONS TAB
// =====================================================
function escHtml(s) {
    return String(s ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function txSortBy(key) {
    if (txSort.key === key) {
        txSort.dir = txSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        txSort.key = key;
        txSort.dir = key === 'DateSortKey' || key === 'Amount' ? 'desc' : 'asc';
    }
    txPage = 1;
    renderTransactionsTab();
}

function filterTransactions() {
    txPage = 1;
    renderTransactionsTab();
}

const FRONTEND_ACCOUNT_OPTIONS = {
    joint: 'Joint',
    anna: 'Anna',
    carlos: 'Carlos',
};

function accountOptionsHtml(currentValue) {
    const selected = String(currentValue || '').trim().toLowerCase();
    const options = [];

    if (!selected) {
        options.push('<option value="" disabled selected>Select account</option>');
    } else if (!Object.prototype.hasOwnProperty.call(FRONTEND_ACCOUNT_OPTIONS, selected)) {
        const label = selected === 'personal'
            ? 'Personal (existing)'
            : `${selected.charAt(0).toUpperCase()}${selected.slice(1)} (existing)`;
        options.push(`<option value="${escHtml(selected)}" disabled selected>${escHtml(label)}</option>`);
    }

    Object.entries(FRONTEND_ACCOUNT_OPTIONS).forEach(([value, label]) => {
        options.push(`<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`);
    });
    return options.join('');
}

function updateTxDataLists() {
    const exEl = document.getElementById('expenseOptions');
    const tyEl = document.getElementById('typeOptions');
    if (!exEl || !tyEl) return;
    const expenses = [...new Set(rawData.map(r => r.Expense).filter(value => value && !isReviewCategory(value)))].sort();
    const types    = [...new Set(rawData.map(r => r.Type).filter(value => value && !isReviewCategory(value)))].sort();
    exEl.innerHTML = expenses.map(e => `<option value="${escHtml(e)}">`).join('');
    tyEl.innerHTML = types.map(t => `<option value="${escHtml(t)}">`).join('');
}

function renderTransactionsTab() {
    const tbody = document.getElementById('txTableBody');
    if (!tbody) return;

    const search   = (document.getElementById('txSearch')?.value || '').toLowerCase();
    const acctFil  = document.getElementById('txAccountFilter')?.value  || 'all';
    const exclFil  = document.getElementById('txExcludeFilter')?.value  || 'all';

    const shown = rawData
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => {
            if (acctFil !== 'all' && r.Account !== acctFil) return false;
            if (exclFil === 'included'  &&  r.excluded) return false;
            if (exclFil === 'excluded'  && !r.excluded) return false;
            if (search) {
                const hay = [r.Date, r.Comments, r.Account, r.Expense, r.Type, String(r.Amount)]
                    .join(' ').toLowerCase();
                if (!hay.includes(search)) return false;
            }
            return true;
        })
        .sort((a, b) => {
            let av = a.r[txSort.key], bv = b.r[txSort.key];
            if (txSort.key === 'Amount') { av = Math.abs(a.r.Amount); bv = Math.abs(b.r.Amount); }
            if (typeof av === 'string') return txSort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
            return txSort.dir === 'asc' ? av - bv : bv - av;
        });
    const totalPages = Math.ceil(shown.length / TX_PER_PAGE);
    txPage = Math.min(Math.max(txPage, 1), Math.max(totalPages, 1));
    const pageRows = shown.slice((txPage - 1) * TX_PER_PAGE, txPage * TX_PER_PAGE);

    updateTxDataLists();

    // Update sort arrows
    document.querySelectorAll('.tx-sort-arrow').forEach(el => {
        const col = el.dataset.col;
        el.textContent = col === txSort.key ? (txSort.dir === 'asc' ? '↑' : '↓') : '↕';
    });

    tbody.innerHTML = '';
    pageRows.forEach(({ r, i }) => {
        const amtCls = r.Amount >= 0 ? 'amount-saving' : 'amount-expense';
        const amtFmt = (r.kind === 'expense' ? '−' : '+') +
            new Intl.NumberFormat('da-DK', { maximumFractionDigits: 2 }).format(Math.abs(r.Amount));
        const acctVal  = String(r.Account || '').toLowerCase();
        const exclCls  = r.excluded ? 'tx-excl-btn tx-excluded' : 'tx-excl-btn tx-included';
        const exclTxt  = r.excluded ? '🚫 Excluded' : '✅ Included';

        const tr = document.createElement('tr');
        if (r.excluded) tr.classList.add('tx-row-dimmed');

        const acctOptsHtml = accountOptionsHtml(acctVal);

        tr.innerHTML = `
            <td><input class="tx-date-input" value="${escHtml(r.Date)}" data-idx="${i}" placeholder="DD/MM/YY"></td>
            <td><select class="tx-acct-select tx-acct-${acctVal}" data-idx="${i}">
                ${acctOptsHtml}
            </select></td>
            <td><input class="tx-comment-input" value="${escHtml(r.Comments)}" data-idx="${i}" placeholder="Add comment…" title="${escHtml(r.Comments)}"></td>
            <td class="${amtCls} tx-amount"><input class="tx-amount-input ${amtCls}" type="number" step="0.01" value="${r.Amount}" data-idx="${i}"></td>
            <td><input class="tx-cat-input" list="expenseOptions"
                    value="${escHtml(r.Expense)}" data-field="Expense" data-idx="${i}"></td>
            <td><input class="tx-cat-input" list="typeOptions"
                    value="${escHtml(r.Type)}" data-field="Type" data-idx="${i}"></td>
            <td><button class="${exclCls}" data-idx="${i}">${exclTxt}</button></td>
            <td class="tx-actions-cell">
                <button class="tx-action-btn tx-save-btn" data-idx="${i}" title="Save changes to CSV" aria-label="Save transaction">\ud83d\udcbe</button>
                <button class="tx-action-btn tx-duplicate-btn" data-idx="${i}" title="Duplicate transaction below" aria-label="Duplicate transaction">\ud83d\udccb</button>
                <button class="btn-tx-delete tx-action-btn tx-delete-btn" data-idx="${i}" title="Delete transaction" aria-label="Delete transaction">\ud83d\uddd1</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    renderTransactionsPagination(shown.length, totalPages);

    // Category edit
    tbody.querySelectorAll('.tx-cat-input').forEach(inp => {
        inp.addEventListener('change', e => {
            const idx   = parseInt(e.target.dataset.idx, 10);
            const field = e.target.dataset.field;
            if (!isNaN(idx) && rawData[idx]) {
                rawData[idx][field] = e.target.value.trim();
                updateTxDataLists();
                // Refresh analytics data silently
                applyGlobalFilters();
            }
        });
    });

    // Amount edit
    tbody.querySelectorAll('.tx-amount-input').forEach(inp => {
        inp.addEventListener('change', e => {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (!isNaN(idx) && rawData[idx]) {
                const val = parseFloat(e.target.value);
                if (isNaN(val)) return;
                rawData[idx].Amount = val;
                rawData[idx].kind = val < 0 ? 'expense' : 'saving';
                const newCls = val < 0 ? 'amount-expense' : 'amount-saving';
                const oldCls = val < 0 ? 'amount-saving' : 'amount-expense';
                e.target.classList.replace(oldCls, newCls);
                const td = e.target.closest('td');
                if (td) { td.classList.replace(oldCls, newCls); }
                applyGlobalFilters();
            }
        });
    });

    // Comment edit
    tbody.querySelectorAll('.tx-comment-input').forEach(inp => {
        inp.addEventListener('change', e => {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (!isNaN(idx) && rawData[idx]) {
                rawData[idx].Comments = e.target.value;
                e.target.title = e.target.value;
            }
        });
    });

    // Exclude toggle
    tbody.querySelectorAll('.tx-excl-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (!isNaN(idx) && rawData[idx]) {
                rawData[idx].excluded = !rawData[idx].excluded;
                applyGlobalFilters();
                renderTransactionsTab();
            }
        });
    });

    // Save row
    tbody.querySelectorAll('.tx-save-btn').forEach(btn => {
        btn.addEventListener('click', async e => {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (isNaN(idx) || !rawData[idx]) return;
            try {
                await apiSaveRow(rawData[idx]);
                showToast('✅ Saved', 'success');
            } catch (err) {
                showToast('❌ Save failed: ' + err.message, 'error');
            }
        });
    });

    // Delete row
    tbody.querySelectorAll('.btn-tx-delete').forEach(btn => {
        btn.addEventListener('click', async e => {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (isNaN(idx) || !rawData[idx]) return;
            if (!confirm('Delete this transaction?')) return;
            const row = rawData[idx];
            try {
                await apiDeleteRow(row.id);
                rawData.splice(idx, 1);
                drawerData = drawerData.filter(r => r !== row);
                applyGlobalFilters();
                renderTransactionsTab();
                showToast('✅ Transaction deleted', 'success');
            } catch (err) {
                showToast('❌ Delete failed: ' + err.message, 'error');
            }
        });
    });

    tbody.querySelectorAll('.tx-duplicate-btn').forEach(btn => {
        btn.addEventListener('click', async e => {
            const idx = parseInt(e.currentTarget.dataset.idx, 10);
            if (isNaN(idx) || !rawData[idx]) return;

            const source = rawData[idx];
            const duplicate = {
                ...source,
                id: '',
                sourceSystem: '',
                sourceEntryReference: '',
                insertedAt: null,
            };
            try {
                const saved = await apiSaveRow(duplicate, source.id);
                const newRow = supabaseDataToRow(saved);
                const sourceIndex = rawData.indexOf(source);
                rawData.splice(sourceIndex + 1, 0, newRow);
                const drawerSourceIndex = drawerData.indexOf(source);
                if (drawerSourceIndex !== -1) drawerData.splice(drawerSourceIndex + 1, 0, newRow);
                applyGlobalFilters();
                renderDashboard();
                if (activeTab === 'highlights') renderHighlightsTab();
                if (activeTab === 'transactions') renderTransactionsTab();
                renderDrawerTable();
                showToast('✅ Transaction duplicated', 'success');
            } catch (err) {
                showToast('❌ Duplicate failed: ' + err.message, 'error');
            }
        });
    });

    // Date edit
    tbody.querySelectorAll('.tx-date-input').forEach(inp => {
        inp.addEventListener('change', e => {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (!isNaN(idx) && rawData[idx]) {
                const val = e.target.value.trim();
                rawData[idx].Date        = val;
                rawData[idx].DateSortKey = parseDateSortKey(val);
                const d = parseDateFromString(val);
                if (d && !isNaN(d)) {
                    rawData[idx].Month = d.getMonth() + 1;
                    rawData[idx].Year  = d.getFullYear();
                }
                applyGlobalFilters();
            }
        });
    });

    // Account edit
    tbody.querySelectorAll('.tx-acct-select').forEach(sel => {
        sel.addEventListener('change', e => {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (!isNaN(idx) && rawData[idx]) {
                rawData[idx].Account = e.target.value;
                e.target.className = `tx-acct-select tx-acct-${e.target.value}`;
            }
        });
    });
}

function renderTransactionsPagination(totalCount, totalPages) {
    const pagination = document.getElementById('txPagination');
    if (!pagination) return;

    const pageCount = Math.max(totalPages, 1);
    const firstItem = totalCount ? (txPage - 1) * TX_PER_PAGE + 1 : 0;
    const lastItem = Math.min(txPage * TX_PER_PAGE, totalCount);
    const pages = [...new Set([
        1, pageCount, txPage - 2, txPage - 1, txPage, txPage + 1, txPage + 2,
    ].filter(page => page >= 1 && page <= pageCount))].sort((a, b) => a - b);
    const pageButtons = [];

    pages.forEach((page, index) => {
        if (index && page - pages[index - 1] > 1) {
            pageButtons.push('<span class="tx-pagination-ellipsis">…</span>');
        }
        pageButtons.push(`<button type="button" class="page-btn ${page === txPage ? 'active' : ''}"
            onclick="changeTransactionsPage(${page})" ${page === txPage ? 'aria-current="page"' : ''}>${page}</button>`);
    });

    pagination.innerHTML = `
        <span class="tx-pagination-summary">Showing ${firstItem}–${lastItem} of ${totalCount}</span>
        ${pageCount > 1 ? `<div class="tx-pagination-controls">
            <button type="button" class="page-btn" onclick="changeTransactionsPage(${txPage - 1})"
                ${txPage === 1 ? 'disabled' : ''}>← Prev</button>
            ${pageButtons.join('')}
            <button type="button" class="page-btn" onclick="changeTransactionsPage(${txPage + 1})"
                ${txPage === pageCount ? 'disabled' : ''}>Next →</button>
        </div>` : ''}`;
}

function changeTransactionsPage(page) {
    if (!Number.isInteger(page) || page < 1) return;
    txPage = page;
    renderTransactionsTab();
}

function addTransaction() {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${pad(today.getDate())}/${pad(today.getMonth() + 1)}/${String(today.getFullYear()).slice(-2)}`;
    const newRow = {
        Expense:     'Misc',
        PlannedReal: 'Real',
        Type:        '🛍️ Shopping',
        Date:        dateStr,
        DateSortKey: parseDateSortKey(dateStr),
        Month:       today.getMonth() + 1,
        Year:        today.getFullYear(),
        Amount:      0,
        Comments:    '',
        Account:     '',
        kind:        'expense',
        excluded:    false,
    };
    rawData.unshift(newRow);
    txPage = 1;
    updateTxDataLists();
    applyGlobalFilters();
    renderTransactionsTab();
}

// =====================================================
//  TOAST
// =====================================================
function showToast(msg, type='info') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className   = `toast ${type} show`;
    setTimeout(() => el.classList.remove('show'), 4000);
}


// =====================================================
//  HIGHLIGHTS TAB
// =====================================================
function setHighlightsCurrency(cur) {
    highlightsCurrency = cur;
    renderHighlightsTab();
}
function setHighlightsCategoryKind(kind) {
    highlightsCategoryKind = kind;
    renderHighlightsTab();
}

function getHighlightsAnalyticsRows() {
    const now = new Date();
    const currentMonthIndex = now.getFullYear() * 12 + now.getMonth();

    return rawData.filter(row => {
        if (row.excluded || row.PlannedReal !== 'Real') return false;
        const year = Number(row.Year);
        const month = Number(row.Month);
        return Number.isInteger(year)
            && Number.isInteger(month)
            && month >= 1
            && month <= 12
            && year * 12 + month - 1 <= currentMonthIndex;
    });
}

function renderHighlightsTab() {
    const content = document.getElementById('highlightsContent');
    if (!content) return;
    const highlightYearFilterOpen = document.getElementById('hlYearMsPanel')?.style.display === 'block';
    if (charts.highlightsSavings) {
        charts.highlightsSavings.destroy();
        charts.highlightsSavings = null;
    }
    if (charts.highlightsCategories) {
        charts.highlightsCategories.destroy();
        charts.highlightsCategories = null;
    }

    const cur = highlightsCurrency;
    const fmt = v => iFormatMoney(iDisp(v, cur), cur);

    const analyticsReal = getHighlightsAnalyticsRows();
    const allYears = [...new Set(analyticsReal.map(d => d.Year))]
        .sort((a, b) => Number(a) - Number(b));
    const selectedYears = globalFilters.years.map(Number).sort((a, b) => a - b);
    const realAll = analyticsReal.filter(d => {
        return !selectedYears.length || selectedYears.includes(Number(d.Year));
    });
    const realExp = realAll.filter(d => d.kind === 'expense');
    const realInc = realAll.filter(d => d.kind === 'saving');
    const filterHtml = `
    <section class="filters-bar">
        <div class="filter-group">
            <label>Year</label>
            <div class="ms-wrap" id="hlYearMsWrap">
                <button class="ms-trigger" id="hlYearMsTrigger" type="button" onclick="toggleMs('hlYearMs')">All Years ▾</button>
                <div class="ms-panel" id="hlYearMsPanel"></div>
            </div>
        </div>
        <div class="filter-group">
            <label>Currency</label>
            <div class="toggle-group">
                <button class="toggle-btn ${cur === 'DKK' ? 'active' : ''}" onclick="setHighlightsCurrency('DKK')">DKK</button>
                <button class="toggle-btn ${cur === 'EUR' ? 'active' : ''}" onclick="setHighlightsCurrency('EUR')">EUR</button>
            </div>
        </div>
        <div class="filter-group hl-quick-facts-filter">
            <button type="button" class="hl-quick-facts-button" onclick="openHighlightsQuickFacts()">💡 Quick Facts</button>
        </div>
    </section>`;

    if (!realAll.length) {
        const quickFactsBody = document.getElementById('highlightsQuickFactsBody');
        if (quickFactsBody) quickFactsBody.innerHTML = '<p class="hl-note">No real data for the selected years.</p>';
        content.innerHTML = filterHtml + `
            <div class="hl-empty">
                <div style="font-size:3rem;margin-bottom:1rem">💡</div>
                <h3>No real data available yet</h3>
                <p>Upload transactions marked as <em>Real</em> to see your financial highlights.</p>
            </div>`;
        populateYearFilter();
        if (highlightYearFilterOpen) {
            document.getElementById('hlYearMsPanel').style.display = 'block';
        }
        return;
    }

    // === Core metrics ===
    const totalExpenses = realExp.reduce((s, d) => s - d.Amount, 0);
    const totalIncome   = realInc.reduce((s, d) => s + d.Amount, 0);
    const netSavings    = totalIncome - totalExpenses;
    const savingsRate   = totalIncome > 0 ? (netSavings / totalIncome * 100) : 0;

    const activeMonths  = new Set(realExp.map(d => `${d.Year}-${String(d.Month).padStart(2,'0')}`));
    const monthCount    = activeMonths.size || 1;
    const avgMonthly    = totalExpenses / monthCount;

    const uncatCount = getHighlightsReviewRows().length;

    // Biggest single expense
    const biggestTx = [...realExp].sort((a, b) => a.Amount - b.Amount)[0];

    // Best / worst months
    const monthMap = {};
    realExp.forEach(d => {
        const key = `${d.Year}-${String(d.Month).padStart(2,'0')}`;
        monthMap[key] = (monthMap[key] || 0) + (-d.Amount);
    });
    const monthEntries = Object.entries(monthMap);
    const bestMonth    = monthEntries.length ? [...monthEntries].sort((a, b) => a[1] - b[1])[0] : null;
    const worstMonth   = monthEntries.length ? [...monthEntries].sort((a, b) => b[1] - a[1])[0] : null;

    // Food & dining
    const foodAmt = realExp.filter(d => d.Type === '🛒 Groceries' || d.Expense === 'Bars & Restaurants')
        .reduce((s, d) => s - d.Amount, 0);
    const foodPct = totalExpenses > 0 ? (foodAmt / totalExpenses * 100) : 0;

    // Subscriptions
    const subAmt      = realExp.filter(d => d.Expense === 'Subscriptions').reduce((s, d) => s - d.Amount, 0);
    const subPerMonth = subAmt / monthCount;

    // Helpers
    const MNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fmtMonth = key => {
        if (!key) return '—';
        const [y, m] = key.split('-');
        return `${MNAMES[parseInt(m, 10) - 1]} ${y}`;
    };

    // Savings rate colour
    const srColor = savingsRate >= 20 ? '#10b981' : savingsRate >= 10 ? '#f59e0b' : '#ef4444';
    const srLabel = savingsRate >= 20 ? '🟢 Excellent' : savingsRate >= 10 ? '🟡 Moderate' : '🔴 Needs attention';

    // === Build HTML ===

    // Filter bar
    // KPI row
    const kpiHtml = `
    <section class="hl-kpi-row">
        <div class="hl-kpi-card">
            <div class="hl-kpi-icon">💰</div>
            <div class="hl-kpi-label">Savings Rate</div>
            <div class="hl-kpi-value" style="color:${srColor}">${savingsRate.toFixed(1)}%</div>
            <div class="hl-kpi-sub">${srLabel}</div>
        </div>
        <div class="hl-kpi-card">
            <div class="hl-kpi-icon">📅</div>
            <div class="hl-kpi-label">Avg Monthly Spend</div>
            <div class="hl-kpi-value">${fmt(avgMonthly)}</div>
            <div class="hl-kpi-sub">Over ${monthCount} month${monthCount !== 1 ? 's' : ''}</div>
        </div>
        <button type="button" class="hl-kpi-card hl-kpi-action ${uncatCount > 0 ? 'hl-kpi-warning' : ''}"
            onclick="openHighlightsReviewDrawer()" ${uncatCount === 0 ? 'disabled' : ''}>
            <div class="hl-kpi-icon">${uncatCount > 0 ? '⚠️' : '✅'}</div>
            <div class="hl-kpi-label">⚠️ Review</div>
            <div class="hl-kpi-value" style="color:${uncatCount > 0 ? '#f59e0b' : '#10b981'}">${uncatCount}</div>
            <div class="hl-kpi-sub">${uncatCount > 0 ? '⚠️ Review items' : 'All categorized!'}</div>
        </button>
    </section>`;

    // Top categories
    const topCatsHtml = `
    <div class="hl-panel">
        <div class="hl-panel-header">
            <h3>🔥 Top 10 ${highlightsCategoryKind === 'expense' ? 'Expense Categories' : 'Income Sources'}</h3>
            <div class="toggle-group" role="group" aria-label="Category chart data">
                <button class="toggle-btn ${highlightsCategoryKind === 'expense' ? 'active' : ''}"
                    aria-pressed="${highlightsCategoryKind === 'expense'}"
                    onclick="setHighlightsCategoryKind('expense')">Expenses</button>
                <button class="toggle-btn ${highlightsCategoryKind === 'saving' ? 'active' : ''}"
                    aria-pressed="${highlightsCategoryKind === 'saving'}"
                    onclick="setHighlightsCategoryKind('saving')">Income</button>
            </div>
        </div>
        <div class="hl-category-chart-wrap"><canvas id="hlTopCategoriesChart"></canvas></div>
    </div>`;

    const savingsTrendHtml = `
    <div class="hl-panel">
        <div class="hl-panel-header">
            <h3>📈 12-Month Rolling Savings Ratio</h3>
            <span class="chart-hint">Monthly costs and income with rolling ratio</span>
        </div>
        <div class="hl-savings-chart-wrap"><canvas id="hlSavingsTrendChart"></canvas></div>
        <p class="hl-note">The line uses the previous 12 calendar months, including the displayed month. Months without transactions are treated as zero.</p>
    </div>`;

    // Fun facts
    const netColor = netSavings >= 0 ? '#10b981' : '#ef4444';
    const facts = [
        biggestTx
            ? `💸 Biggest single transaction: <strong>${fmt(Math.abs(biggestTx.Amount))}</strong> — ${biggestTx.Expense} on ${biggestTx.Date}`
            : null,
        worstMonth
            ? `🌋 Most expensive month: <strong>${fmtMonth(worstMonth[0])}</strong> at ${fmt(worstMonth[1])}`
            : null,
        bestMonth
            ? `🧊 Cheapest month: <strong>${fmtMonth(bestMonth[0])}</strong> at ${fmt(bestMonth[1])}`
            : null,
        subAmt > 0
            ? `📱 Subscriptions drain <strong>${fmt(subPerMonth)}/month</strong> (${fmt(subAmt)} total)`
            : null,
        foodAmt > 0
            ? `🍔 Food & dining: <strong>${fmt(foodAmt)}</strong> — ${foodPct.toFixed(0)}% of all spending`
            : null,
        `📊 Money in vs out: <strong>${fmt(totalIncome)}</strong> earned, <strong>${fmt(totalExpenses)}</strong> spent → net <strong style="color:${netColor}">${fmt(Math.abs(netSavings))}</strong> ${netSavings >= 0 ? 'saved ✅' : 'deficit ❌'}`,
    ].filter(Boolean);

    const quickFactsBody = document.getElementById('highlightsQuickFactsBody');
    if (quickFactsBody) {
        quickFactsBody.innerHTML = facts.map(f => `<div class="hl-fact">${f}</div>`).join('');
    }

    content.innerHTML = filterHtml + kpiHtml +
        `<div class="hl-two-col">${topCatsHtml}${savingsTrendHtml}</div>`;
    populateYearFilter();
    if (highlightYearFilterOpen) {
        document.getElementById('hlYearMsPanel').style.display = 'block';
    }
    renderHighlightsCategoriesChart(realAll, allYears, cur, selectedYears);
    renderHighlightsSavingsChart(analyticsReal, selectedYears, cur);
}

function getHighlightsReviewRows() {
    return getHighlightsAnalyticsRows().filter(d =>
        d.Expense === '⚠️ Review'
        && (!globalFilters.years.length || globalFilters.years.includes(Number(d.Year)))
    );
}

function openHighlightsReviewDrawer() {
    const rows = getHighlightsReviewRows();
    const yearLabel = globalFilters.years.length ? globalFilters.years.join(', ') : 'All years';
    openDrawerWith(
        rows,
        '⚠️ Transactions to Review',
        `${yearLabel} · ${rows.length} transaction${rows.length === 1 ? '' : 's'}`
    );
}

function renderHighlightsCategoriesChart(rows, allYears, currency, selectedYears) {
    const canvas = document.getElementById('hlTopCategoriesChart');
    if (!canvas) return;

    const categoryKind = highlightsCategoryKind;
    const categoryField = categoryKind === 'expense' ? 'Type' : 'Expense';
    const categoryRows = rows.filter(row => row.kind === categoryKind);
    if (!categoryRows.length) {
        canvas.parentElement.innerHTML = `<p class="hl-note">No ${categoryKind === 'expense' ? 'expense' : 'income'} data for this selection.</p>`;
        return;
    }

    const totalsByCategory = new Map();
    for (const row of categoryRows) {
        const category = row[categoryField] || 'Uncategorized';
        const year = Number(row.Year);
        const yearTotals = totalsByCategory.get(category) || new Map();
        const amount = categoryKind === 'expense' ? -row.Amount : row.Amount;
        yearTotals.set(year, (yearTotals.get(year) || 0) + amount);
        totalsByCategory.set(category, yearTotals);
    }

    const topCategories = [...totalsByCategory.entries()]
        .sort((a, b) =>
            [...b[1].values()].reduce((sum, value) => sum + value, 0)
            - [...a[1].values()].reduce((sum, value) => sum + value, 0)
        )
        .slice(0, 10)
        .map(([category]) => category);
    const years = selectedYears.length ? selectedYears : allYears.map(Number);

    charts.highlightsCategories = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: topCategories,
            datasets: years.map(year => {
                const yearIndex = allYears.findIndex(y => Number(y) === year);
                const color = yearColor(yearIndex >= 0 ? yearIndex : 0);
                return {
                    label: String(year),
                    data: topCategories.map(category =>
                        totalsByCategory.get(category)?.get(year) || 0
                    ),
                    backgroundColor: color.bg,
                    borderColor: color.border,
                    borderWidth: 1,
                    borderRadius: 3,
                };
            }),
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: context =>
                            ` ${context.dataset.label}: ${iFormatMoney(context.parsed.x, currency)}`,
                    },
                },
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: chartGridColor() },
                    ticks: { callback: value => iFormatMoney(value, currency) },
                },
                y: {
                    grid: { display: false },
                },
            },
        },
    });
}

function renderHighlightsSavingsChart(rows, selectedYears, currency) {
    const canvas = document.getElementById('hlSavingsTrendChart');
    if (!canvas) return;

    const monthlyTotals = new Map();
    for (const row of rows) {
        const year = Number(row.Year);
        const month = Number(row.Month);
        if (
            !Number.isInteger(year)
            || !Number.isInteger(month)
            || month < 1
            || month > 12
        ) {
            continue;
        }
        const monthIndex = year * 12 + month - 1;
        const totals = monthlyTotals.get(monthIndex) || { income: 0, costs: 0 };
        if (row.kind === 'saving') totals.income += row.Amount;
        else totals.costs -= row.Amount;
        monthlyTotals.set(monthIndex, totals);
    }

    if (!monthlyTotals.size) return;

    let firstDataMonth = Infinity;
    for (const monthIndex of monthlyTotals.keys()) {
        firstDataMonth = Math.min(firstDataMonth, monthIndex);
    }

    const now = new Date();
    const currentMonth = now.getFullYear() * 12 + now.getMonth();
    const selectedYearSet = selectedYears.length ? new Set(selectedYears) : null;
    const firstMonth = selectedYears.length
        ? Math.min(...selectedYears) * 12
        : firstDataMonth;
    const lastMonth = selectedYears.length
        ? Math.min(Math.max(...selectedYears) * 12 + 11, currentMonth)
        : currentMonth;

    const labels = [];
    const costs = [];
    const income = [];
    const savingsRatios = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    for (let monthIndex = firstMonth; monthIndex <= lastMonth; monthIndex++) {
        const year = Math.floor(monthIndex / 12);
        if (selectedYearSet && !selectedYearSet.has(year)) continue;
        const month = monthIndex % 12;
        const totals = monthlyTotals.get(monthIndex) || { income: 0, costs: 0 };
        labels.push(selectedYears.length === 1 ? monthNames[month] : `${monthNames[month]} ${year}`);
        costs.push(iDisp(totals.costs, currency));
        income.push(iDisp(totals.income, currency));

        let rollingIncome = 0;
        let rollingCosts = 0;
        for (let offset = 0; offset < 12; offset++) {
            const rollingTotals = monthlyTotals.get(monthIndex - offset);
            if (!rollingTotals) continue;
            rollingIncome += rollingTotals.income;
            rollingCosts += rollingTotals.costs;
        }

        const hasFullWindow = monthIndex - 11 >= firstDataMonth;
        savingsRatios.push(
            hasFullWindow && rollingIncome > 0
                ? (rollingIncome - rollingCosts) / rollingIncome * 100
                : null
        );
    }

    const symbol = currency === 'EUR' ? '€' : 'kr';
    charts.highlightsSavings = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: `Costs (${symbol})`,
                    data: costs,
                    backgroundColor: 'rgba(239, 68, 68, 0.68)',
                    borderColor: '#ef4444',
                    borderWidth: 1,
                    borderRadius: 3,
                    yAxisID: 'yAmount',
                },
                {
                    label: `Income (${symbol})`,
                    data: income,
                    backgroundColor: 'rgba(16, 185, 129, 0.68)',
                    borderColor: '#10b981',
                    borderWidth: 1,
                    borderRadius: 3,
                    yAxisID: 'yAmount',
                },
                {
                    type: 'line',
                    label: '12-month savings ratio',
                    data: savingsRatios,
                    borderColor: '#2563eb',
                    backgroundColor: '#2563eb',
                    borderWidth: 3,
                    pointRadius: 2,
                    pointHoverRadius: 4,
                    tension: 0.25,
                    spanGaps: false,
                    yAxisID: 'yRatio',
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: context => {
                            const value = context.parsed.y;
                            if (value === null || value === undefined) return null;
                            return context.dataset.yAxisID === 'yRatio'
                                ? ` ${context.dataset.label}: ${value.toFixed(1)}%`
                                : ` ${context.dataset.label}: ${iFormatMoney(value, currency)}`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { autoSkip: true, maxTicksLimit: 18, maxRotation: 45 },
                },
                yAmount: {
                    position: 'left',
                    grid: { color: chartGridColor() },
                    ticks: { callback: value => iFormatMoney(value, currency) },
                },
                yRatio: {
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: { callback: value => `${Number(value).toFixed(0)}%` },
                },
            },
        },
    });
}


// Initialize the fixed dark theme and authentication on load.
(function () {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.addEventListener('DOMContentLoaded', () => {
        applyChartTheme();
        initializeSupabaseAuth().catch(error => {
            setAuthMessage('Could not initialize Supabase: ' + error.message);
        });
    });
})();