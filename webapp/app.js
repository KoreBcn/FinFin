// =====================================================
//  FinanceHome — app.js
// =====================================================

const EUR_RATE = 7.46;

// ── State ──────────────────────────────────────────
let rawData      = [];
let filteredData = [];

let globalFilters   = { plannedReal: 'Real', year: 'all', currency: 'DKK' };
let insightsFilters = { year: 'all', currency: 'DKK' };

// Dashboard cross-chart filters
let chartFilters = { monthKey: null, typeKey: null, typeLevel: null, kind: null };
let drillDown    = { expenses: null, savings: null };

// Insights cross-chart filters
let yoyFilter    = { typeKey: null, typeLevel: null, kind: null };
let yoyDrill     = { expenses: null, savings: null };

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
const DRAWER_PER   = 15;
let drawerSort     = { key: 'Date', dir: 'asc' };

let activeTab = 'dashboard';

// Highlights tab currency
let highlightsCurrency = 'DKK';
let highlightsYear     = 'all';

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
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick="switchTab('${tab}')"]`).classList.add('active');
    document.getElementById('tabDashboard').style.display    = tab === 'dashboard'    ? 'flex' : 'none';
    document.getElementById('tabInsights').style.display     = tab === 'insights'     ? 'flex' : 'none';
    document.getElementById('tabTransactions').style.display = tab === 'transactions' ? 'flex' : 'none';
    document.getElementById('tabHighlights').style.display   = tab === 'highlights'   ? 'flex' : 'none';
    if (tab === 'insights')     renderInsightsTab();
    if (tab === 'transactions') renderTransactionsTab();
    if (tab === 'highlights')   renderHighlightsTab();
}


// =====================================================
//  MODAL
// =====================================================
function openUploadModal()  { document.getElementById('uploadModal').classList.add('open'); }
function closeUploadModal() { document.getElementById('uploadModal').classList.remove('open'); }
function handleModalClick(e) {
    if (e.target === document.getElementById('uploadModal')) closeUploadModal();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeUploadModal(); });


// =====================================================
//  CSV UPLOAD
// =====================================================
document.getElementById('fileInput').addEventListener('change', function(e) {
    if (e.target.files[0]) parseCSV(e.target.files[0]);
});

const uploadArea = document.getElementById('uploadArea');
uploadArea.addEventListener('dragover',  e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', ()  => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.csv')) parseCSV(f);
    else showToast('❌ Please upload a valid CSV file.', 'error');
});

function parseCSV(file) {
    const MONTH_MAP = {
        january:1,february:2,march:3,april:4,may:5,june:6,
        july:7,august:8,september:9,october:10,november:11,december:12
    };
    function parseMonth(raw) {
        const n = parseInt(raw);
        if (!isNaN(n) && n >= 1 && n <= 12) return n;
        return MONTH_MAP[(raw || '').toLowerCase().trim()] || 0;
    }
    function parseAmount(raw) {
        // Strip thousands separators (commas) and parse; handles "+25,000.00" → 25000
        return parseFloat((raw || '').replace(/,/g, ''));
    }
    Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete(results) {
            const parsed = [];
            results.data.forEach(row => {
                const norm = {};
                Object.keys(row).forEach(k => norm[k.trim()] = (row[k] || '').trim());
                const amtRaw = norm['Amount'];
                if (!amtRaw) return;
                const amount = parseAmount(amtRaw);
                if (isNaN(amount) || amount === 0) return;
                const pr = norm['Planned/Rea'] || '';
                const expenseField = norm['Expense'] || '';
                const typeField    = norm['Type']    || '';

                // Determine excluded flag (persists after re-upload)
                let excluded;
                const excludedRaw = norm['Excluded'];
                if (excludedRaw !== undefined && excludedRaw !== '') {
                    excluded = excludedRaw === 'true' || excludedRaw === '1';
                } else {
                    // Default: exclude non-salary income and generic transfers
                    const isSalary = expenseField.toLowerCase() === 'salary' ||
                                     expenseField.toLowerCase().includes('carlos salary') ||
                                     typeField.toLowerCase().includes('income');
                    const comments = (norm['Comments'] || '').toLowerCase();
                    const isMortgageTransfer = comments.includes('4698831987') ||
                                               comments.includes('4698831995');
                    const isTransfer = !isMortgageTransfer && !isSalary && (
                                           comments.includes('transfer') ||
                                           comments.startsWith('transf.'));
                    excluded = (amount > 0 && !isSalary) || isTransfer;
                }

                const dateRaw = norm['Date'] || '';
                parsed.push({
                    Expense:      expenseField,
                    PlannedReal:  pr.toLowerCase().startsWith('plan') ? 'Planned' : 'Real',
                    Type:         typeField,
                    Date:         dateRaw,
                    DateSortKey:  parseDateSortKey(dateRaw),
                    Month:        parseMonth(norm['Month']),
                    Year:         parseInt(norm['Year'])  || 0,
                    Amount:       amount,
                    Comments:     norm['Comments'] || '',
                    Account:      norm['Account']  || '',
                    kind:         amount < 0 ? 'expense' : 'saving',
                    excluded,
                });
            });
            if (!parsed.length) { showToast('❌ No valid rows found.', 'error'); return; }
            rawData = parsed;
            closeUploadModal();
            bootstrapApp();
            showToast(`✅ Loaded ${parsed.length} transactions from ${file.name}`, 'success');
        },
        error() { showToast('❌ Failed to parse CSV.', 'error'); }
    });
}


// =====================================================
//  BOOTSTRAP
// =====================================================
function bootstrapApp() {
    populateYearFilter();
    populateInsightsYearFilter();
    document.getElementById('emptyState').style.display      = 'none';
    document.getElementById('tabDashboard').style.display    = 'flex';
    document.getElementById('tabInsights').style.display     = 'none';
    document.getElementById('tabTransactions').style.display = 'none';
    document.getElementById('tabHighlights').style.display   = 'none';
    document.getElementById('tabSwitcher').style.display     = 'flex';
    // Default to Real
    document.querySelectorAll('#plannedRealToggle .toggle-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('#plannedRealToggle .toggle-btn[data-value="Real"]').classList.add('active');
    applyGlobalFilters();
}

function populateYearFilter() {
    const years = [...new Set(rawData.map(d => d.Year))].sort();
    document.getElementById('yearFilter').innerHTML =
        '<option value="all">All Years</option>' +
        years.map(y => `<option value="${y}">${y}</option>`).join('');
}

function populateInsightsYearFilter() {
    const years = [...new Set(rawData.map(d => d.Year))].sort();
    document.getElementById('insightsYearFilter').innerHTML =
        '<option value="all">All Years</option>' +
        years.map(y => `<option value="${y}">${y}</option>`).join('');
}


// =====================================================
//  DASHBOARD GLOBAL FILTERS
// =====================================================
document.getElementById('plannedRealToggle').addEventListener('click', e => {
    if (!e.target.classList.contains('toggle-btn')) return;
    document.querySelectorAll('#plannedRealToggle .toggle-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    globalFilters.plannedReal = e.target.dataset.value;
    applyGlobalFilters();
});

document.getElementById('yearFilter').addEventListener('change', e => {
    globalFilters.year = e.target.value;
    applyGlobalFilters();
});

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
        const okPR   = globalFilters.plannedReal === 'all' || row.PlannedReal === globalFilters.plannedReal;
        const okYear = globalFilters.year === 'all' || row.Year === parseInt(globalFilters.year);
        return okPR && okYear;
    });
    chartFilters = { monthKey: null, typeKey: null, typeLevel: null, kind: null };
    drillDown    = { expenses: null, savings: null };
    renderDashboard();
}

function resetFilters() {
    globalFilters = { plannedReal: 'Real', year: 'all', currency: globalFilters.currency };
    chartFilters  = { monthKey: null, typeKey: null, typeLevel: null, kind: null };
    drillDown     = { expenses: null, savings: null };
    document.querySelectorAll('#plannedRealToggle .toggle-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('#plannedRealToggle .toggle-btn[data-value="Real"]').classList.add('active');
    document.getElementById('yearFilter').value = 'all';
    applyGlobalFilters();
}

function renderDashboard() {
    updateStats();
    renderExpensesChart();
    renderSavingsChart();
    renderMonthlyChart();
}


// =====================================================
//  INSIGHTS FILTERS
// =====================================================
document.getElementById('insightsYearFilter').addEventListener('change', e => {
    insightsFilters.year = e.target.value;
    yoyFilter = { typeKey: null, typeLevel: null, kind: null };
    yoyDrill  = { expenses: null, savings: null };
    renderInsightsTab();
});

document.getElementById('insightsCurrencyToggle').addEventListener('click', e => {
    if (!e.target.classList.contains('toggle-btn')) return;
    document.querySelectorAll('#insightsCurrencyToggle .toggle-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    insightsFilters.currency = e.target.dataset.value;
    renderInsightsTab();
});

function resetInsightsFilters() {
    insightsFilters = { year: 'all', currency: insightsFilters.currency };
    yoyFilter = { typeKey: null, typeLevel: null, kind: null };
    yoyDrill  = { expenses: null, savings: null };
    document.getElementById('insightsYearFilter').value = 'all';
    renderInsightsTab();
}

// Insights: Real only + year filter (also excludes flagged rows)
function getInsightsBase() {
    return rawData.filter(row => {
        if (row.excluded) return false;
        const okReal = row.PlannedReal === 'Real';
        const okYear = insightsFilters.year === 'all' || row.Year === parseInt(insightsFilters.year);
        return okReal && okYear;
    });
}

// Apply yoy type cross-filter (skipType=true means ignore it — used by the chart being clicked)
function getYoyData(skipType = false) {
    return getInsightsBase().filter(row => {
        if (!skipType && yoyFilter.typeKey && yoyFilter.kind) {
            if (row.kind === yoyFilter.kind) {
                const val = yoyFilter.typeLevel === 'Expense' ? row.Expense : row.Type;
                if (val !== yoyFilter.typeKey) return false;
            }
        }
        return true;
    });
}

function toggleYoyTypeFilter(label, kind, level) {
    if (yoyFilter.typeKey === label && yoyFilter.kind === kind) {
        yoyFilter = { typeKey: null, typeLevel: null, kind: null };
    } else {
        yoyFilter = { typeKey: label, typeLevel: level, kind };
    }
    renderInsightsTab();
}


// =====================================================
//  INSIGHTS TAB RENDER
// =====================================================
function renderInsightsTab() {
    renderYoyExpensesChart();
    renderYoySavingsChart();
    renderSavingsProjection();
}


// =====================================================
//  YoY EXPENSES
// =====================================================
function renderYoyExpensesChart() {
    const canvas = document.getElementById('yoyExpensesChart');
    if (charts.yoyExpenses) { charts.yoyExpenses.destroy(); charts.yoyExpenses = null; }

    const base  = getYoyData(true).filter(d => d.kind === 'expense');
    if (!base.length) return;

    const years = [...new Set(base.map(d => d.Year))].sort();
    let labels, isDrilled, title;

    if (yoyDrill.expenses) {
        const rows = base.filter(d => d.Type === yoyDrill.expenses);
        labels    = [...new Set(rows.map(d => d.Expense))].sort();
        title     = `💸 Expenses › ${yoyDrill.expenses}`;
        isDrilled = true;
        document.getElementById('breadcrumbYoyExpenses').style.display   = 'block';
        document.getElementById('breadcrumbYoyExpensesType').textContent = yoyDrill.expenses;
    } else {
        labels    = [...new Set(base.map(d => d.Type))].sort();
        title     = '💸 Year-over-Year Expenses by Type';
        isDrilled = false;
        document.getElementById('breadcrumbYoyExpenses').style.display = 'none';
    }

    const totals = buildYoyTotals(base, labels, years, isDrilled, yoyDrill.expenses, 'expense');

    // Sort by grand total descending
    labels.sort((a, b) =>
        years.reduce((s, y) => s + (totals[b][y] || 0), 0) -
        years.reduce((s, y) => s + (totals[a][y] || 0), 0)
    );

    document.getElementById('yoyExpensesBox').querySelector('h3').textContent = title;
    document.getElementById('yoyExpensesBox').classList.toggle(
        'filtered', !!yoyFilter.typeKey && yoyFilter.kind === 'expense'
    );

    charts.yoyExpenses = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: years.map((yr, i) => {
                const c = yearColor(i);
                return {
                    label: String(yr),
                    data:  labels.map(l => iDisp(totals[l]?.[yr] || 0, insightsFilters.currency)),
                    backgroundColor: c.bg, borderColor: c.border, borderWidth: 2, borderRadius: 4
                };
            })
        },
        options: makeInsightsBarOptions(idx => {
            const clicked = labels[idx];
            if (!isDrilled) {
                yoyDrill.expenses = clicked;
                toggleYoyTypeFilter(clicked, 'expense', 'Type');
                openDrawerWith(
                    base.filter(d => d.Type === clicked),
                    `💸 ${clicked}`, `Type: ${clicked}`
                );
            } else {
                toggleYoyTypeFilter(clicked, 'expense', 'Expense');
                openDrawerWith(
                    base.filter(d => d.Type === yoyDrill.expenses && d.Expense === clicked),
                    `💸 ${clicked}`, `Expense: ${clicked}`
                );
            }
        }, insightsFilters.currency)
    });
}


// =====================================================
//  YoY SAVINGS
// =====================================================
function renderYoySavingsChart() {
    const canvas = document.getElementById('yoySavingsChart');
    if (charts.yoySavings) { charts.yoySavings.destroy(); charts.yoySavings = null; }

    const base  = getYoyData(true).filter(d => d.kind === 'saving');
    if (!base.length) return;

    const years = [...new Set(base.map(d => d.Year))].sort();
    let labels, isDrilled, title;

    if (yoyDrill.savings) {
        const rows = base.filter(d => d.Type === yoyDrill.savings);
        labels    = [...new Set(rows.map(d => d.Expense))].sort();
        title     = `💰 Income › ${yoyDrill.savings}`;
        isDrilled = true;
        document.getElementById('breadcrumbYoySavings').style.display   = 'block';
        document.getElementById('breadcrumbYoySavingsType').textContent = yoyDrill.savings;
    } else {
        labels    = [...new Set(base.map(d => d.Type))].sort();
        title     = '💰 Year-over-Year Income by Type';
        isDrilled = false;
        document.getElementById('breadcrumbYoySavings').style.display = 'none';
    }

    const totals = buildYoyTotals(base, labels, years, isDrilled, yoyDrill.savings, 'saving');

    labels.sort((a, b) =>
        years.reduce((s, y) => s + (totals[b][y] || 0), 0) -
        years.reduce((s, y) => s + (totals[a][y] || 0), 0)
    );

    document.getElementById('yoySavingsBox').querySelector('h3').textContent = title;
    document.getElementById('yoySavingsBox').classList.toggle(
        'filtered', !!yoyFilter.typeKey && yoyFilter.kind === 'saving'
    );

    charts.yoySavings = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: years.map((yr, i) => {
                const c = yearColor(i);
                return {
                    label: String(yr),
                    data:  labels.map(l => iDisp(totals[l]?.[yr] || 0, insightsFilters.currency)),
                    backgroundColor: c.bg, borderColor: c.border, borderWidth: 2, borderRadius: 4
                };
            })
        },
        options: makeInsightsBarOptions(idx => {
            const clicked = labels[idx];
            if (!isDrilled) {
                yoyDrill.savings = clicked;
                toggleYoyTypeFilter(clicked, 'saving', 'Type');
                openDrawerWith(
                    base.filter(d => d.Type === clicked),
                    `💰 ${clicked}`, `Type: ${clicked}`
                );
            } else {
                toggleYoyTypeFilter(clicked, 'saving', 'Expense');
                openDrawerWith(
                    base.filter(d => d.Type === yoyDrill.savings && d.Expense === clicked),
                    `💰 ${clicked}`, `Expense: ${clicked}`
                );
            }
        }, insightsFilters.currency)
    });
}

function resetYoyDrill(which) {
    yoyDrill[which]     = null;
    yoyFilter.typeKey   = null;
    yoyFilter.kind      = null;
    yoyFilter.typeLevel = null;
    closeDrawer();
    renderInsightsTab();
}


// =====================================================
//  SAVINGS PROJECTION
// =====================================================
function renderSavingsProjection() {
    const canvas = document.getElementById('savingsProjectionChart');
    if (charts.savingsProjection) { charts.savingsProjection.destroy(); charts.savingsProjection = null; }
    if (!canvas) return;

    const base = getInsightsBase(); // Real, year-filtered, not excluded
    if (!base.length) return;

    // Build monthly net per year
    const MNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const years  = [...new Set(base.map(d => d.Year))].sort();
    const months = [1,2,3,4,5,6,7,8,9,10,11,12];

    // net[year][month] = income - expenses
    const net = {};
    years.forEach(y => { net[y] = {}; months.forEach(m => { net[y][m] = 0; }); });
    base.forEach(d => {
        const contrib = d.kind === 'saving' ? d.Amount : -Math.abs(d.Amount);
        net[d.Year][d.Month] = (net[d.Year][d.Month] || 0) + contrib;
    });

    // Build cumulative per year
    // Determine the last month that has any data across all years
    const hasData = {};
    base.forEach(d => { hasData[`${d.Year}-${d.Month}`] = true; });

    // For each year build cumulative array (12 points), null after last data month
    const datasets = years.map((yr, i) => {
        let cumulative = 0;
        const data = months.map(m => {
            if (hasData[`${yr}-${m}`] !== undefined) {
                cumulative += net[yr][m];
                return iDisp(cumulative, insightsFilters.currency);
            }
            // No transactions in this month — carry forward only if an earlier month had data
            const hasAny = months.slice(0, m - 1).some(pm => hasData[`${yr}-${pm}`]);
            if (hasAny) {
                // Carry forward
                return iDisp(cumulative, insightsFilters.currency);
            }
            return null;
        });

        // Find last non-null index for projection
        let lastIdx = -1;
        data.forEach((v, idx) => { if (v !== null) lastIdx = idx; });

        const c = yearColor(i);

        // Actual line — stops at lastIdx
        const actualData = data.map((v, idx) => idx <= lastIdx ? v : null);

        // Projection line — from lastIdx onwards as linear extrapolation
        // slope = average monthly net over known months
        const knownMonths = lastIdx + 1;
        const endVal = lastIdx >= 0 ? actualData[lastIdx] : 0;
        const slope  = knownMonths > 1 ? endVal / knownMonths : 0;

        const projData = months.map((_, idx) => {
            if (idx < lastIdx) return null;
            if (idx === lastIdx) return endVal; // anchor point
            return iDisp(endVal + slope * (idx - lastIdx), insightsFilters.currency);
        });

        return [
            {
                label: String(yr),
                data: actualData,
                borderColor: c.border,
                backgroundColor: c.bg.replace('0.78', '0.12'),
                borderWidth: 2.5,
                pointRadius: 3,
                tension: 0.35,
                fill: true,
                spanGaps: false,
                yAxisID: 'y',
            },
            {
                label: `${yr} projected`,
                data: projData,
                borderColor: c.border,
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                borderDash: [6, 4],
                pointRadius: 0,
                tension: 0.35,
                fill: false,
                spanGaps: false,
                yAxisID: 'y',
            }
        ];
    }).flat();

    const sym = insightsFilters.currency === 'EUR' ? '€' : 'kr';

    charts.savingsProjection = new Chart(canvas, {
        type: 'line',
        data: {
            labels: MNAMES,
            datasets,
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        font: { size: 11 },
                        padding: 10,
                        filter: item => !item.text.includes('projected'),
                    }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            if (ctx.parsed.y === null) return null;
                            const isProj = ctx.dataset.label.includes('projected');
                            const pfx = isProj ? '~ ' : '';
                            return ` ${ctx.dataset.label.replace(' projected', '')}${isProj ? ' (proj.)' : ''}: ${pfx}${iFormatMoney(ctx.parsed.y, insightsFilters.currency)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    ticks: { callback: v => `${(v/1000).toFixed(0)}k ${sym}` },
                    grid:  { color: '#f1f5f9' },
                    title: { display: true, text: `Cumulative Net Savings (${sym})`, font: { size: 11 } }
                },
                x: { grid: { display: false } }
            }
        }
    });
}


// =====================================================
//  INSIGHTS BAR OPTIONS
// =====================================================
function makeInsightsBarOptions(onBarClick, currency) {
    const sym = currency === 'EUR' ? '€' : 'kr';
    return {
        responsive: true,
        maintainAspectRatio: false,
        onClick(evt, elements) {
            if (elements.length > 0 && onBarClick)
                onBarClick(elements[0].index, elements[0].datasetIndex);
        },
        onHover(e) { e.native.target.style.cursor = 'pointer'; },
        plugins: {
            legend: { position: 'top', labels: { font: { size: 11 }, padding: 10 } },
            tooltip: {
                callbacks: {
                    label: ctx => ` ${ctx.dataset.label}: ${iFormatMoney(ctx.parsed.y, currency)}`
                }
            }
        },
        scales: {
            y: {
                beginAtZero: true,
                ticks: { callback: v => `${(v/1000).toFixed(0)}k ${sym}` },
                grid:  { color: '#f1f5f9' }
            },
            x: { grid: { display: false } }
        }
    };
}


// =====================================================
//  YoY HELPER
// =====================================================
function buildYoyTotals(base, labels, years, isDrilled, drillType, kind) {
    const totals = {};
    labels.forEach(l => {
        totals[l] = {};
        years.forEach(y => { totals[l][y] = 0; });
    });
    base.forEach(d => {
        const lbl = isDrilled
            ? (d.Type === drillType ? d.Expense : null)
            : d.Type;
        if (lbl && totals[lbl] !== undefined) {
            const val = kind === 'expense' ? Math.abs(d.Amount) : d.Amount;
            totals[lbl][d.Year] = (totals[lbl][d.Year] || 0) + val;
        }
    });
    return totals;
}


// =====================================================
//  INSIGHTS CURRENCY HELPERS
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


// =====================================================
//  DASHBOARD CURRENCY HELPERS
// =====================================================
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
    const data    = getChartData();
    const realExp = sumRows(data, 'expense', 'Real',    true);
    const planExp = sumRows(data, 'expense', 'Planned', true);
    const realSav = sumRows(data, 'saving',  'Real',    false);
    const planSav = sumRows(data, 'saving',  'Planned', false);

    document.getElementById('kpiExpensesReal').textContent    = formatMoney(toDisplay(realExp));
    document.getElementById('kpiExpensesPlanned').textContent = formatMoney(toDisplay(planExp));
    setKpiBadge('kpiExpensesBadge', realExp, planExp, 'expense');
    document.getElementById('kpiSavingsReal').textContent     = formatMoney(toDisplay(realSav));
    document.getElementById('kpiSavingsPlanned').textContent  = formatMoney(toDisplay(planSav));
    setKpiBadge('kpiSavingsBadge', realSav, planSav, 'saving');
    const realNet = realSav - realExp;
    const planNet = planSav - planExp;
    document.getElementById('kpiNetReal').textContent         = formatMoney(toDisplay(realNet));
    document.getElementById('kpiNetPlanned').textContent      = formatMoney(toDisplay(planNet));
    setKpiBadge('kpiNetBadge', realNet, planNet, 'net');
    document.getElementById('transactionCount').textContent   = data.length;
}

function sumRows(data, kind, pr, useAbs) {
    return data.filter(d => d.kind === kind && d.PlannedReal === pr)
        .reduce((s,d) => s + (useAbs ? Math.abs(d.Amount) : d.Amount), 0);
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


// =====================================================
//  DASHBOARD CHARTS
// =====================================================
function renderExpensesChart() {
    const canvas = document.getElementById('expensesChart');
    if (charts.expenses) { charts.expenses.destroy(); charts.expenses = null; }
    const base = getChartData(false, true).filter(d => d.kind === 'expense');
    if (!base.length) return;

    let labels, plannedVals, realVals, isDrilled, title;
    if (drillDown.expenses) {
        const rows = base.filter(d => d.Type === drillDown.expenses);
        ({ labels, plannedVals, realVals } = buildGrouped(rows, 'Expense'));
        title = `💸 Expenses › ${drillDown.expenses}`; isDrilled = true;
        document.getElementById('breadcrumbExpenses').style.display   = 'block';
        document.getElementById('breadcrumbExpensesType').textContent = drillDown.expenses;
    } else {
        ({ labels, plannedVals, realVals } = buildGrouped(base, 'Type'));
        title = '💸 Expenses by Type'; isDrilled = false;
        document.getElementById('breadcrumbExpenses').style.display = 'none';
    }
    sortByTotal(labels, plannedVals, realVals);
    document.getElementById('expensesChartTitle').textContent = title;
    document.getElementById('expensesChartBox').classList.toggle(
        'filtered', !!chartFilters.typeKey && chartFilters.kind === 'expense');
    const vis = legendVisible.expenses;

    charts.expenses = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label:'Planned', data: plannedVals.map(v => toDisplay(v)),
                  backgroundColor:'rgba(239,68,68,0.35)', borderColor:'#ef4444',
                  borderWidth:2, borderRadius:4, hidden:!vis.Planned },
                { label:'Real',    data: realVals.map(v => toDisplay(v)),
                  backgroundColor:'rgba(239,68,68,0.82)', borderColor:'#ef4444',
                  borderWidth:2, borderRadius:4, hidden:!vis.Real }
            ]
        },
        options: makeBarOptions(idx => {
            const clicked = labels[idx];
            if (!isDrilled) {
                drillDown.expenses = clicked;
                toggleTypeFilter(clicked, 'expense', 'Type');
                openDrawerForType(clicked, 'expense', 'Type', base);
            } else {
                toggleTypeFilter(clicked, 'expense', 'Expense');
                openDrawerForType(clicked, 'expense', 'Expense',
                    base.filter(d => d.Type === drillDown.expenses));
            }
        }, (lbl, hidden) => { legendVisible.expenses[lbl] = !hidden; }, true)
    });
}

function renderSavingsChart() {
    const canvas = document.getElementById('savingsChart');
    if (charts.savings) { charts.savings.destroy(); charts.savings = null; }
    const base = getChartData(false, true).filter(d => d.kind === 'saving');
    if (!base.length) return;

    let labels, plannedVals, realVals, isDrilled, title;
    if (drillDown.savings) {
        const rows = base.filter(d => d.Type === drillDown.savings);
        ({ labels, plannedVals, realVals } = buildGrouped(rows, 'Expense'));
        title = `💰 Income › ${drillDown.savings}`; isDrilled = true;
        document.getElementById('breadcrumbSavings').style.display   = 'block';
        document.getElementById('breadcrumbSavingsType').textContent = drillDown.savings;
    } else {
        ({ labels, plannedVals, realVals } = buildGrouped(base, 'Type'));
        title = '💰 Income by Type'; isDrilled = false;
        document.getElementById('breadcrumbSavings').style.display = 'none';
    }
    sortByTotal(labels, plannedVals, realVals);
    document.getElementById('savingsChartTitle').textContent = title;
    document.getElementById('savingsChartBox').classList.toggle(
        'filtered', !!chartFilters.typeKey && chartFilters.kind === 'saving');
    const vis = legendVisible.savings;

    charts.savings = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label:'Planned', data: plannedVals.map(v => toDisplay(v)),
                  backgroundColor:'rgba(16,185,129,0.35)', borderColor:'#10b981',
                  borderWidth:2, borderRadius:4, hidden:!vis.Planned },
                { label:'Real',    data: realVals.map(v => toDisplay(v)),
                  backgroundColor:'rgba(16,185,129,0.82)', borderColor:'#10b981',
                  borderWidth:2, borderRadius:4, hidden:!vis.Real }
            ]
        },
        options: makeBarOptions(idx => {
            const clicked = labels[idx];
            if (!isDrilled) {
                drillDown.savings = clicked;
                toggleTypeFilter(clicked, 'saving', 'Type');
                openDrawerForType(clicked, 'saving', 'Type', base);
            } else {
                toggleTypeFilter(clicked, 'saving', 'Expense');
                openDrawerForType(clicked, 'saving', 'Expense',
                    base.filter(d => d.Type === drillDown.savings));
            }
        }, (lbl, hidden) => { legendVisible.savings[lbl] = !hidden; }, true)
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

function toggleMonthlyHeatmapKind(kind) {
    monthlyHeatmapKind = kind;
    monthlyDrillType   = null;
    document.querySelectorAll('.monthly-toggle-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.kind === kind)
    );
    renderMonthlyChart();
}

function drillMonthlyHeatmap(catIdx) {
    monthlyDrillType = _monthlyCategories[catIdx];
    renderMonthlyChart();
}

function resetMonthlyDrill() {
    monthlyDrillType = null;
    renderMonthlyChart();
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
        map[key][d.Month] = (map[key][d.Month] || 0) + Math.abs(d.Amount);
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

    catSet.forEach((cat, catIdx) => {
        const rowVals = months.map(m => map[cat][m] || 0);
        const rowMax  = Math.max(...rowVals, 1);
        const rowPos  = rowVals.filter(v => v > 0);
        const rowMin  = rowPos.length ? Math.min(...rowPos) : 0;

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
                const t   = (val - rowMin) / (rowMax - rowMin || 1);
                const a   = 0.18 + t * 0.82;
                const bg  = isExp
                    ? `rgba(239,68,68,${a.toFixed(2)})`
                    : `rgba(16,185,129,${a.toFixed(2)})`;
                const fg  = t > 0.55 ? '#ffffff' : '#1e293b';
                const disp = iFormatShort(val, globalFilters.currency);
                const tip  = `${cat} — ${MNAMES[m-1]}: ${formatMoney(toDisplay(val))}`;
                html += `<td style="background:${bg};color:${fg};cursor:pointer" title="${tip}"
                    onclick="openDrawerFromMonthlyHeatmap(${catIdx},${m})">${disp}</td>`;
            }
        });
        html += `</tr>`;
    });

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
                grid:  { color: '#f1f5f9' }
            },
            y: { grid: { display: false } }
        } : {
            y: {
                beginAtZero: true,
                ticks: { callback: v => `${(v/1000).toFixed(0)}k ${currSymbol()}` },
                grid:  { color: '#f1f5f9' }
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
    document.getElementById('drawerPlannedReal').value    = 'all';
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

function renderDrawerTable() {
    const search = document.getElementById('drawerSearch').value.toLowerCase();
    const pr     = document.getElementById('drawerPlannedReal').value;

    drawerFiltered = drawerData.filter(row => {
        const okPR = pr === 'all' || row.PlannedReal === pr;
        const okSr = !search ||
            row.Type.toLowerCase().includes(search)    ||
            row.Expense.toLowerCase().includes(search) ||
            row.Date.includes(search)                  ||
            row.Comments.toLowerCase().includes(search);
        return okPR && okSr;
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

    const fmtFn = activeTab === 'insights'
        ? v => iFormatMoney(iDisp(v, insightsFilters.currency), insightsFilters.currency)
        : v => formatMoney(toDisplay(v));

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
            tdDate.className = 'tx-date';
            tdDate.textContent = row.Date;
            tr.appendChild(tdDate);

            // ── Amount ────────────────────────────────
            const tdAmt = document.createElement('td');
            tdAmt.className = `${row.kind === 'expense' ? 'amount-expense' : 'amount-saving'} tx-amount`;
            tdAmt.textContent = (row.kind === 'expense' ? '−' : '+') +
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
                updateTxDataLists();
                applyGlobalFilters();
                renderDashboard();
                if (activeTab === 'insights') renderInsightsTab();
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
                row.kind = row.Amount < 0 ? 'expense' : 'saving';
                updateTxDataLists();
                applyGlobalFilters();
                renderDashboard();
                if (activeTab === 'insights') renderInsightsTab();
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
            });
            tdDesc.appendChild(inpDesc);
            tr.appendChild(tdDesc);

            // ── Account ───────────────────────────────
            const tdAcct = document.createElement('td');
            const acctBadge = document.createElement('span');
            const acct = (row.Account || 'personal').toLowerCase();
            acctBadge.className = `tx-acct-badge tx-acct-${acct}`;
            acctBadge.textContent = acct === 'joint' ? 'Joint' : 'Personal';
            tdAcct.appendChild(acctBadge);
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
                applyGlobalFilters();
                renderDashboard();
                if (activeTab === 'insights') renderInsightsTab();
            });
            tdExcl.appendChild(btn);
            tr.appendChild(tdExcl);

            tbody.appendChild(tr);
        });
    }

    const totExp = drawerFiltered.filter(d => d.kind === 'expense').reduce((s, d) => s + Math.abs(d.Amount), 0);
    const totSav = drawerFiltered.filter(d => d.kind === 'saving').reduce((s, d) => s + d.Amount, 0);

    document.getElementById('drawerSummary').innerHTML = `
        <div class="drawer-summary-item">Records: <strong>${drawerFiltered.length}</strong></div>
        ${totExp ? `<div class="drawer-summary-item">Expenses: <strong class="amount-expense">${fmtFn(totExp)}</strong></div>` : ''}
        ${totSav ? `<div class="drawer-summary-item">Savings: <strong class="amount-saving">${fmtFn(totSav)}</strong></div>` : ''}`;

    renderDrawerPagination();
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

function updateTxDataLists() {
    const exEl = document.getElementById('expenseOptions');
    const tyEl = document.getElementById('typeOptions');
    if (!exEl || !tyEl) return;
    const expenses = [...new Set(rawData.map(r => r.Expense).filter(Boolean))].sort();
    const types    = [...new Set(rawData.map(r => r.Type).filter(Boolean))].sort();
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
        .sort((a, b) => b.r.Date.localeCompare(a.r.Date)); // newest first

    updateTxDataLists();

    const countEl = document.getElementById('txRowCount');
    if (countEl) countEl.textContent = `${shown.length} of ${rawData.length} rows`;

    tbody.innerHTML = '';
    shown.forEach(({ r, i }) => {
        const amtCls = r.kind === 'expense' ? 'amount-expense' : 'amount-saving';
        const amtFmt = (r.kind === 'expense' ? '−' : '+') +
            new Intl.NumberFormat('da-DK', { maximumFractionDigits: 2 }).format(Math.abs(r.Amount));
        const acctVal  = (r.Account || 'personal').toLowerCase();
        const exclCls  = r.excluded ? 'tx-excl-btn tx-excluded' : 'tx-excl-btn tx-included';
        const exclTxt  = r.excluded ? '🚫 Excluded' : '✅ Included';

        const tr = document.createElement('tr');
        if (r.excluded) tr.classList.add('tx-row-dimmed');

        tr.innerHTML = `
            <td><input class="tx-date-input" value="${escHtml(r.Date)}" data-idx="${i}" placeholder="DD/MM/YY"></td>
            <td><select class="tx-acct-select tx-acct-${acctVal}" data-idx="${i}">
                <option value="personal" ${acctVal === 'personal' ? 'selected' : ''}>Personal</option>
                <option value="joint" ${acctVal === 'joint' ? 'selected' : ''}>Joint</option>
            </select></td>
            <td><input class="tx-comment-input" value="${escHtml(r.Comments)}" data-idx="${i}" placeholder="Add comment…" title="${escHtml(r.Comments)}"></td>
            <td class="${amtCls} tx-amount"><input class="tx-amount-input ${amtCls}" type="number" step="0.01" value="${r.Amount}" data-idx="${i}"></td>
            <td><input class="tx-cat-input" list="expenseOptions"
                    value="${escHtml(r.Expense)}" data-field="Expense" data-idx="${i}"></td>
            <td><input class="tx-cat-input" list="typeOptions"
                    value="${escHtml(r.Type)}" data-field="Type" data-idx="${i}"></td>
            <td><button class="${exclCls}" data-idx="${i}">${exclTxt}</button></td>
            <td><button class="btn-tx-delete" data-idx="${i}" title="Delete transaction">✕</button></td>
        `;
        tbody.appendChild(tr);
    });

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

    // Delete row
    tbody.querySelectorAll('.btn-tx-delete').forEach(btn => {
        btn.addEventListener('click', e => {
            const idx = parseInt(e.target.dataset.idx, 10);
            if (!isNaN(idx) && rawData[idx]) {
                rawData.splice(idx, 1);
                applyGlobalFilters();
                renderTransactionsTab();
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

function addTransaction() {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const newRow = {
        Expense:     'Misc',
        PlannedReal: 'Rea',
        Type:        '🛍️ Shopping',
        Date:        dateStr,
        Month:       today.getMonth() + 1,
        Year:        today.getFullYear(),
        Amount:      0,
        Comments:    '',
        Account:     'personal',
        kind:        'expense',
        excluded:    false,
    };
    rawData.unshift(newRow);
    updateTxDataLists();
    applyGlobalFilters();
    renderTransactionsTab();
}

function downloadCSV() {
    if (!rawData.length) { showToast('❌ No data to download.', 'error'); return; }
    const MONTH_NAMES = ['','January','February','March','April','May','June',
                         'July','August','September','October','November','December'];
    const cols = ['Expense','Planned/Rea','Type','Date','Month','Year','Amount','Comments','Account','Excluded'];
    const esc = v => {
        const s = v !== undefined && v !== null ? String(v) : '';
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
            ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    rawData.forEach(r => {
        lines.push([
            esc(r.Expense),
            esc(r.PlannedReal === 'Planned' ? 'Planned' : 'REA'),
            esc(r.Type),
            esc(r.Date),
            esc(MONTH_NAMES[r.Month] || r.Month),
            esc(r.Year),
            esc(r.Amount),   // plain number — no thousands separator
            esc(r.Comments),
            esc(r.Account),
            esc(r.excluded ? 'true' : 'false'),
        ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'transactions_categorized.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('✅ CSV downloaded!', 'success');
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
function setHighlightsYear(yr) {
    highlightsYear = yr;
    renderHighlightsTab();
}

function renderHighlightsTab() {
    const content = document.getElementById('highlightsContent');
    if (!content) return;

    const cur = highlightsCurrency;
    const fmt = v => iFormatMoney(iDisp(v, cur), cur);

    const allYears = [...new Set(rawData.filter(d => !d.excluded && d.PlannedReal === 'Real').map(d => d.Year))].sort();
    const realAll = rawData.filter(d => {
        if (d.excluded || d.PlannedReal !== 'Real') return false;
        return highlightsYear === 'all' || d.Year === parseInt(highlightsYear);
    });
    const realExp = realAll.filter(d => d.kind === 'expense');
    const realInc = realAll.filter(d => d.kind === 'saving');

    if (!realAll.length) {
        content.innerHTML = `
            <div class="hl-empty">
                <div style="font-size:3rem;margin-bottom:1rem">💡</div>
                <h3>No real data available yet</h3>
                <p>Upload transactions marked as <em>Real</em> to see your financial highlights.</p>
            </div>`;
        return;
    }

    // === Core metrics ===
    const totalExpenses = realExp.reduce((s, d) => s + Math.abs(d.Amount), 0);
    const totalIncome   = realInc.reduce((s, d) => s + d.Amount, 0);
    const netSavings    = totalIncome - totalExpenses;
    const savingsRate   = totalIncome > 0 ? (netSavings / totalIncome * 100) : 0;

    const activeMonths  = new Set(realExp.map(d => `${d.Year}-${String(d.Month).padStart(2,'0')}`));
    const monthCount    = activeMonths.size || 1;
    const avgMonthly    = totalExpenses / monthCount;

    const plannedTotal  = rawData.filter(d => {
        if (d.excluded || d.PlannedReal !== 'Planned' || d.kind !== 'expense') return false;
        return highlightsYear === 'all' || d.Year === parseInt(highlightsYear);
    }).reduce((s, d) => s + Math.abs(d.Amount), 0);
    const budgetPct     = plannedTotal > 0 ? (totalExpenses / plannedTotal * 100) : null;

    const uncatCount    = rawData.filter(d => {
        if (d.excluded || d.Type !== '⚠️ Review') return false;
        return highlightsYear === 'all' || d.Year === parseInt(highlightsYear);
    }).length;

    // Top expense categories
    const byType = {};
    realExp.forEach(d => { byType[d.Type] = (byType[d.Type] || 0) + Math.abs(d.Amount); });
    const topCats = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxCat  = topCats[0]?.[1] || 1;

    // Biggest single expense
    const biggestTx = [...realExp].sort((a, b) => Math.abs(b.Amount) - Math.abs(a.Amount))[0];

    // Best / worst months
    const monthMap = {};
    realExp.forEach(d => {
        const key = `${d.Year}-${String(d.Month).padStart(2,'0')}`;
        monthMap[key] = (monthMap[key] || 0) + Math.abs(d.Amount);
    });
    const monthEntries = Object.entries(monthMap);
    const bestMonth    = monthEntries.length ? [...monthEntries].sort((a, b) => a[1] - b[1])[0] : null;
    const worstMonth   = monthEntries.length ? [...monthEntries].sort((a, b) => b[1] - a[1])[0] : null;

    // Person spending
    const carlosAmt   = realExp.filter(d => d.Type.includes('Carlos')).reduce((s, d) => s + Math.abs(d.Amount), 0);
    const annaAmt     = realExp.filter(d => d.Type.includes('Anna')).reduce((s, d) => s + Math.abs(d.Amount), 0);
    const personTotal = carlosAmt + annaAmt || 1;

    // Food & dining
    const foodAmt = realExp.filter(d => d.Type === '🛒 Groceries' || d.Expense === 'Bars & Restaurants')
        .reduce((s, d) => s + Math.abs(d.Amount), 0);
    const foodPct = totalExpenses > 0 ? (foodAmt / totalExpenses * 100) : 0;

    // Subscriptions
    const subAmt      = realExp.filter(d => d.Expense === 'Subscriptions').reduce((s, d) => s + Math.abs(d.Amount), 0);
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

    // Budget badge
    let budgetBadge = '';
    if (budgetPct !== null) {
        const over = budgetPct > 100;
        budgetBadge = `<span class="kpi-badge ${over ? 'badge-over' : 'badge-under'}">
            ${over ? `▲ ${(budgetPct - 100).toFixed(1)}% Over` : `▼ ${(100 - budgetPct).toFixed(1)}% Under`}
        </span>`;
    }

    // === Build HTML ===

    // Filter bar
    const yearOptions = '<option value="all">All Years</option>' +
        allYears.map(y => `<option value="${y}" ${String(y) === String(highlightsYear) ? 'selected' : ''}>${y}</option>`).join('');
    const filterHtml = `
    <section class="filters-bar">
        <div class="filter-group">
            <label>Year</label>
            <select onchange="setHighlightsYear(this.value)">${yearOptions}</select>
        </div>
        <div class="filter-group">
            <label>Currency</label>
            <div class="toggle-group">
                <button class="toggle-btn ${cur === 'DKK' ? 'active' : ''}" onclick="setHighlightsCurrency('DKK')">DKK</button>
                <button class="toggle-btn ${cur === 'EUR' ? 'active' : ''}" onclick="setHighlightsCurrency('EUR')">EUR</button>
            </div>
        </div>
        <div class="filter-group" style="margin-left:auto">
            <span class="filter-note">💡 ${realAll.length} real transactions · ${monthCount} month${monthCount !== 1 ? 's' : ''} of data</span>
        </div>
    </section>`;

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
        <div class="hl-kpi-card">
            <div class="hl-kpi-icon">🎯</div>
            <div class="hl-kpi-label">Budget Adherence</div>
            <div class="hl-kpi-value">${budgetPct !== null ? budgetPct.toFixed(1) + '%' : '—'}</div>
            <div class="hl-kpi-sub">${budgetBadge || (budgetPct === null ? 'No budget set' : '')}</div>
        </div>
        <div class="hl-kpi-card ${uncatCount > 0 ? 'hl-kpi-warning' : ''}">
            <div class="hl-kpi-icon">${uncatCount > 0 ? '⚠️' : '✅'}</div>
            <div class="hl-kpi-label">Needs Review</div>
            <div class="hl-kpi-value" style="color:${uncatCount > 0 ? '#f59e0b' : '#10b981'}">${uncatCount}</div>
            <div class="hl-kpi-sub">${uncatCount > 0 ? 'Uncategorized items' : 'All categorized!'}</div>
        </div>
    </section>`;

    // Top categories
    const topCatsHtml = `
    <div class="hl-panel">
        <div class="hl-panel-header">
            <h3>🔥 Top Expense Categories</h3>
            <span class="chart-hint">Real expenses only</span>
        </div>
        ${topCats.map(([type, amt]) => {
            const pct   = (amt / maxCat * 100).toFixed(1);
            const share = (amt / totalExpenses * 100).toFixed(0);
            return `
            <div class="hl-bar-row">
                <div class="hl-bar-label" title="${type}">${type}</div>
                <div class="hl-bar-track"><div class="hl-bar-fill" style="width:${pct}%"></div></div>
                <div class="hl-bar-value">${fmt(amt)}</div>
                <div class="hl-bar-pct">${share}%</div>
            </div>`;
        }).join('')}
    </div>`;

    // Person split
    const personHtml = `
    <div class="hl-panel">
        <div class="hl-panel-header">
            <h3>👥 Spending by Person</h3>
            <span class="chart-hint">Tagged transactions only</span>
        </div>
        ${carlosAmt > 0 || annaAmt > 0 ? `
        <div class="hl-bar-row">
            <div class="hl-bar-label">👨 Carlos</div>
            <div class="hl-bar-track"><div class="hl-bar-fill hl-bar-carlos" style="width:${(carlosAmt/personTotal*100).toFixed(1)}%"></div></div>
            <div class="hl-bar-value">${fmt(carlosAmt)}</div>
            <div class="hl-bar-pct">${(carlosAmt/personTotal*100).toFixed(0)}%</div>
        </div>
        <div class="hl-bar-row">
            <div class="hl-bar-label">👩 Anna</div>
            <div class="hl-bar-track"><div class="hl-bar-fill hl-bar-anna" style="width:${(annaAmt/personTotal*100).toFixed(1)}%"></div></div>
            <div class="hl-bar-value">${fmt(annaAmt)}</div>
            <div class="hl-bar-pct">${(annaAmt/personTotal*100).toFixed(0)}%</div>
        </div>
        <p class="hl-note">Only transactions tagged to a specific person are counted here.</p>
        ` : `<p class="hl-note">No person-tagged transactions found in the current data.</p>`}
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

    const factsHtml = `
    <div class="hl-panel hl-facts-panel">
        <div class="hl-panel-header"><h3>💡 Quick Facts</h3></div>
        <div class="hl-facts-grid">
            ${facts.map(f => `<div class="hl-fact">${f}</div>`).join('')}
        </div>
    </div>`;

    content.innerHTML = filterHtml + kpiHtml +
        `<div class="hl-two-col">${topCatsHtml}${personHtml}</div>` +
        factsHtml;
}