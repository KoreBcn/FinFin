'use strict';

const HOUSE_DEFAULT_VALUE = 6100000;
const HOUSE_ROWS_PER_PAGE = 10;

const HouseMath = (() => {
    function matchingRows(rows, concept, matches) {
        const normalized = concept.trim().toLowerCase();
        return rows.filter(row => row.PlannedReal === 'Real'
            && matches(String(row.Comments || '').trim().toLowerCase(), normalized))
            .map(row => {
                if (!Number.isFinite(row.Amount)) throw new Error('A matching transaction has an invalid amount.');
                return row;
            });
    }

    function bankInstallments(rows, concept) {
        return matchingRows(rows, concept, (text, match) => text === match)
            .map(row => {
                return {
                    date: row.Date,
                    sortKey: row.DateSortKey,
                    amount: -row.Amount,
                    source: row.Amount > 0 ? 'Bank refund' : 'Bank installment'
                };
            });
    }

    function bankInterest(rows, concept) {
        return matchingRows(rows, concept, (text, match) => text.includes(match))
            .map(row => ({
                date: row.Date, sortKey: row.DateSortKey,
                amount: row.Amount, source: 'Interest / adjustment'
            }));
    }

    function calculate(value, mortgage, installments) {
        const paid = installments.reduce((sum, item) => sum + item.amount, 0);
        const equity = paid + (value - mortgage);
        const debt = mortgage - paid;
        const fraction = equity / value;
        const visibleFraction = Math.max(0, Math.min(1, fraction));
        const totalArea = 72800;
        const rectangleArea = 61600;
        const equityArea = totalArea * visibleFraction;
        const fillTop = equityArea <= rectangleArea
            ? 300 - equityArea / 280
            : Math.sqrt(160 * (totalArea - equityArea) / 280);
        return { equity, debt, fraction, fillTop };
    }

    function monthlyHistory(entries, value, mortgage, throughDate, interestEntries = []) {
        const tagged = [
            ...entries.map(entry => ({ entry, kind: 'equity' })),
            ...interestEntries.map(entry => ({ entry, kind: 'interest' }))
        ];
        if (!tagged.length) return [];
        const sorted = tagged.map(({ entry, kind }) => {
            const key = entry.sortKey;
            const year = Math.floor(key / 10000);
            const month = Math.floor(key / 100) % 100;
            const day = key % 100;
            const parsed = new Date(0);
            parsed.setUTCFullYear(year, month - 1, day);
            if (!Number.isInteger(key) || year < 1 || year > 9999
                || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1
                || parsed.getUTCDate() !== day) {
                throw new Error(`An ${kind} entry has an invalid date.`);
            }
            if (!Number.isFinite(entry.amount)) throw new Error(`An ${kind} entry has an invalid amount.`);
            return { entry, kind, monthIndex: year * 12 + month - 1 };
        }).sort((a, b) => a.entry.sortKey - b.entry.sortKey);
        const end = Math.max(sorted[sorted.length - 1].monthIndex,
            throughDate.getFullYear() * 12 + throughDate.getMonth());
        const result = [];
        let next = 0;
        let paid = 0;
        let totalInterest = 0;
        for (let monthIndex = sorted[0].monthIndex; monthIndex <= end; monthIndex++) {
            const monthEntries = [];
            const monthInterestEntries = [];
            while (next < sorted.length && sorted[next].monthIndex === monthIndex) {
                const { entry, kind } = sorted[next++];
                if (kind === 'equity') {
                    paid += entry.amount;
                    monthEntries.push(entry);
                } else {
                    totalInterest += entry.amount;
                    monthInterestEntries.push(entry);
                }
            }
            const equity = paid + (value - mortgage);
            const debt = mortgage - paid;
            if (![equity, debt, totalInterest].every(Number.isFinite)) {
                throw new Error('The history amounts are too large to calculate.');
            }
            result.push({
                month: `${String(Math.floor(monthIndex / 12)).padStart(4, '0')}-${String(monthIndex % 12 + 1).padStart(2, '0')}`,
                equity, debt, interest: totalInterest === 0 ? 0 : -totalInterest,
                entries: monthEntries, interestEntries: monthInterestEntries
            });
        }
        return result;
    }

    return { bankInstallments, bankInterest, calculate, monthlyHistory };
})();

if (typeof module !== 'undefined') module.exports = HouseMath;

let investmentSubtab = 'portfolio';
let houseConcept = null;
let houseConfigLoading = false;
let houseConfigError = '';
let houseGeneration = 0;
let houseStoredInstallments = [];
let houseEntriesLoaded = false;
let houseEntriesLoading = false;
let houseEntriesError = '';
let houseSaving = false;
let housePage = 1;
let houseHistoryVisible = true;
let houseHistoryDatasetVisibility = [true, true, false];

function switchInvestmentSubtab(tab) {
    investmentSubtab = tab;
    for (const [name, suffix] of [['portfolio', 'Portfolio'], ['analytics', 'Analytics'], ['house', 'House']]) {
        const selected = name === tab;
        const button = document.getElementById(`investment${suffix}Tab`);
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', String(selected));
        document.getElementById(`investment${suffix}`).hidden = !selected;
    }
    if (tab === 'house') openHouse();
    else openInvestments();
}

function clearHouse() {
    houseGeneration++;
    houseConcept = null;
    houseConfigLoading = false;
    houseConfigError = '';
    houseStoredInstallments = [];
    houseEntriesLoaded = false;
    houseEntriesLoading = false;
    houseEntriesError = '';
    houseSaving = false;
    housePage = 1;
    houseHistoryVisible = true;
    updateHouseView();
    const dialog = document.getElementById('houseInstallmentDialog');
    if (dialog.open) dialog.close();
    document.getElementById('houseValue').value = investmentFormat(HOUSE_DEFAULT_VALUE, 0);
    document.getElementById('houseInstallmentForm').reset();
    document.getElementById('houseInstallmentsBody').replaceChildren();
    document.getElementById('housePageStatus').textContent = '';
    document.getElementById('housePreviousPage').disabled = true;
    document.getElementById('houseNextPage').disabled = true;
    document.getElementById('houseAddInstallment').disabled = true;
    document.getElementById('houseLoadStatus').textContent = '';
    document.getElementById('houseRetryConfig').hidden = true;
    document.getElementById('houseFormStatus').textContent = '';
    document.getElementById('houseActionStatus').textContent = '';
    document.getElementById('houseValueStatus').textContent = '';
    document.getElementById('houseDebt').textContent = '—';
    document.getElementById('houseEquity').textContent = '—';
    document.getElementById('houseMortgage').textContent = '—';
    document.getElementById('houseInterestTotal').textContent = '—';
    document.getElementById('houseInterestTotal').className = '';
    document.getElementById('houseDebtPercent').textContent = '';
    document.getElementById('houseEquityPercent').textContent = '';
    document.getElementById('houseEquityFill').setAttribute('height', '0');
    document.getElementById('houseDiagram').setAttribute('aria-label', 'House debt and equity unavailable');
    clearHouseHistory('');
    houseHistoryDatasetVisibility = [true, true, false];
    switchInvestmentSubtab('portfolio');
}

function clearHouseHistory(message) {
    if (charts.houseHistory) {
        houseHistoryDatasetVisibility = charts.houseHistory.data.datasets.map(
            (_, index) => charts.houseHistory.isDatasetVisible(index)
        );
        charts.houseHistory.destroy();
        delete charts.houseHistory;
    }
    document.getElementById('houseHistoryChartWrap').hidden = true;
    document.getElementById('houseHistoryChart').setAttribute('aria-label', 'Monthly equity, debt and cumulative interest in DKK');
    document.getElementById('houseHistoryStatus').textContent = message;
}

function updateHouseView() {
    document.getElementById('houseGraphButton').setAttribute('aria-pressed', String(houseHistoryVisible));
    document.getElementById('houseInstallmentsButton').setAttribute('aria-pressed', String(!houseHistoryVisible));
    document.getElementById('houseHistory').hidden = !houseHistoryVisible;
    document.getElementById('houseTableView').hidden = houseHistoryVisible;
    document.getElementById('houseAddInstallment').hidden = houseHistoryVisible;
}

function renderHouseHistory(entries, interestEntries, value, mortgage) {
    let history;
    try {
        history = HouseMath.monthlyHistory(entries, value, mortgage, new Date(), interestEntries);
    } catch (error) {
        clearHouseHistory(`Unable to plot history: ${error.message}`);
        return;
    }
    if (!history.length) {
        clearHouseHistory('No equity or interest entries to plot.');
        return;
    }
    const entryDescription = entry => `${entry.date || '—'} · ${entry.source}: ${investmentFormat(entry.amount)} DKK`;
    if (typeof Chart === 'undefined') {
        clearHouseHistory('Chart unavailable. Reload the page to try again.');
        return;
    }
    document.getElementById('houseHistoryChart').setAttribute('aria-label', 'Monthly equity, debt and cumulative interest in DKK. '
        + history.map(month => `${month.month}: equity ${investmentFormat(month.equity)}, debt ${investmentFormat(month.debt)}, interest ${investmentFormat(month.interest)}`).join('; '));
    const labels = history.map(month => month.month);
    const datasets = [
        { label: 'Equity', data: history.map(month => month.equity), borderColor: '#10b981', backgroundColor: '#10b981', tension: 0, pointRadius: 3, borderWidth: 2, hidden: !houseHistoryDatasetVisibility[0] },
        { label: 'Debt', data: history.map(month => month.debt), borderColor: '#3b6ea5', backgroundColor: '#3b6ea5', tension: 0, pointRadius: 3, borderWidth: 2, hidden: !houseHistoryDatasetVisibility[1] },
        { label: 'Interest', data: history.map(month => month.interest), borderColor: '#ef4444', backgroundColor: '#ef4444', tension: 0, pointRadius: 3, borderWidth: 2, hidden: !houseHistoryDatasetVisibility[2], yAxisID: 'y' }
    ];
    const afterBody = items => {
        const month = history[items[0].dataIndex];
        const selected = [];
        if (items.some(item => item.datasetIndex === 0 || item.datasetIndex === 1)) selected.push(...month.entries);
        if (items.some(item => item.datasetIndex === 2)) selected.push(...month.interestEntries);
        return [...new Set(selected)].sort((a, b) => a.sortKey - b.sortKey).map(entryDescription);
    };
    document.getElementById('houseHistoryChartWrap').hidden = false;
    document.getElementById('houseHistoryStatus').textContent = '';
    if (charts.houseHistory) {
        charts.houseHistory.data.labels = labels;
        datasets.forEach((dataset, index) => { charts.houseHistory.data.datasets[index].data = dataset.data; });
        charts.houseHistory.options.plugins.tooltip.callbacks.afterBody = afterBody;
        charts.houseHistory.update();
    } else {
        charts.houseHistory = new Chart(document.getElementById('houseHistoryChart'), {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, padding: 10 } },
                    tooltip: { callbacks: { label: context => `${context.dataset.label}: ${investmentFormat(context.parsed.y)} DKK`, afterBody } }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 8 } },
                    y: { grid: { color: chartGridColor() }, ticks: { precision: 0, maxTicksLimit: 6, callback: value => `${(value / 1000000).toLocaleString('en-GB', { maximumFractionDigits: 6 })}M` } }
                }
            }
        });
    }
}

function houseValueNumber(text) {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return NaN;
    const value = Number(text.replace(/,/g, ''));
    return Number.isSafeInteger(value) && value > 0 ? value : NaN;
}

async function openHouse() {
    if (!activeAuthUserId) {
        renderHouse();
        return;
    }
    await Promise.all([loadHouseConfig(), loadHouseInstallments()]);
}

async function loadHouseConfig() {
    if (houseConcept !== null || houseConfigLoading) return;
    const generation = houseGeneration;
    houseConfigLoading = true;
    houseConfigError = '';
    renderHouse();
    try {
        const { data, error } = await supabaseClient.from('house_config')
            .select('installment_concept, interest_concept').eq('id', true).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error('Set up the House configuration in Supabase.');
        if (typeof data.installment_concept !== 'string' || !data.installment_concept.trim()
            || typeof data.interest_concept !== 'string' || !data.interest_concept.trim()) {
            throw new Error('The House configuration must include installment and interest concepts.');
        }
        const installment = data.installment_concept.trim();
        const interest = data.interest_concept.trim();
        if (installment.toLowerCase().includes(interest.toLowerCase())) {
            throw new Error('The installment and interest concepts must not overlap.');
        }
        if (generation !== houseGeneration) return;
        houseConcept = { installment, interest };
    } catch (error) {
        if (generation !== houseGeneration) return;
        houseConfigError = `Unable to load House configuration: ${error.message}`;
    } finally {
        if (generation === houseGeneration) {
            houseConfigLoading = false;
            renderHouse();
        }
    }
}

function storedHouseInstallment(row) {
    const amount = Number(row.amount);
    if (typeof row.id !== 'string' || typeof row.entry_date !== 'string'
        || !isValidIsoDate(row.entry_date)
        || typeof row.concept !== 'string'
        || !['regular', 'mortgage_component', 'initial_payment'].includes(row.entry_type)
        || !Number.isFinite(amount) || amount === 0) {
        throw new Error('A saved installment has invalid data.');
    }
    const [year, month, day] = row.entry_date.split('-');
    return {
        id: row.id, source: row.concept, amount, entryType: row.entry_type,
        date: row.entry_date, sortKey: Number(`${year}${month}${day}`)
    };
}

async function loadHouseInstallments() {
    if (houseEntriesLoaded || houseEntriesLoading) return;
    const generation = houseGeneration;
    houseEntriesLoading = true;
    houseEntriesError = '';
    renderHouse();
    try {
        const rows = [];
        const pageSize = 1000;
        for (let offset = 0; ; offset += pageSize) {
            const { data, error } = await supabaseClient.from('house_installments')
                .select('id, entry_date, amount, concept, entry_type')
                .order('entry_date').order('id')
                .range(offset, offset + pageSize - 1);
            if (generation !== houseGeneration) return;
            if (error) throw new Error(error.message);
            if (!Array.isArray(data)) throw new Error('Invalid installment response.');
            rows.push(...data.map(storedHouseInstallment));
            if (data.length < pageSize) break;
        }
        if (generation !== houseGeneration) return;
        houseStoredInstallments = rows;
        houseEntriesLoaded = true;
    } catch (error) {
        if (generation !== houseGeneration) return;
        houseEntriesError = `Unable to load saved installments: ${error.message}`;
    } finally {
        if (generation === houseGeneration) {
            houseEntriesLoading = false;
            renderHouse();
        }
    }
}

async function deleteHouseInstallment(id) {
    if (houseSaving || !houseEntriesLoaded) return;
    const generation = houseGeneration;
    houseSaving = true;
    document.getElementById('houseActionStatus').textContent = '';
    renderHouse();
    try {
        const { error } = await supabaseClient.from('house_installments')
            .delete().eq('id', id).select('id').single();
        if (error) throw new Error(error.message);
        if (generation !== houseGeneration) return;
        houseStoredInstallments = houseStoredInstallments.filter(item => item.id !== id);
    } catch (error) {
        if (generation !== houseGeneration) return;
        document.getElementById('houseActionStatus').textContent = `Unable to delete installment: ${error.message}`;
    } finally {
        if (generation === houseGeneration) {
            houseSaving = false;
            renderHouse();
        }
    }
}

function renderHouse() {
    const body = document.getElementById('houseInstallmentsBody');
    const status = document.getElementById('houseLoadStatus');
    body.replaceChildren();
    let bank = [];
    let interest = [];
    let ready = houseConcept !== null && houseEntriesLoaded;
    if (houseConcept !== null) {
        try {
            bank = HouseMath.bankInstallments(rawData, houseConcept.installment);
            interest = HouseMath.bankInterest(rawData, houseConcept.interest);
            status.textContent = '';
        } catch (error) {
            ready = false;
            status.textContent = error.message;
        }
    } else status.textContent = houseConfigError || 'Loading the transaction references…';
    if (houseEntriesError) status.textContent = houseEntriesError;
    else if (!houseEntriesLoaded && !houseConfigError) status.textContent = 'Loading saved installments…';
    const mortgageEntries = houseStoredInstallments.filter(item => item.entryType === 'mortgage_component' || item.entryType === 'initial_payment');
    const mortgage = mortgageEntries.reduce((sum, item) => sum + Math.abs(item.amount), 0);
    if (ready && (!mortgageEntries.length || !Number.isFinite(mortgage))) {
        ready = false;
        status.textContent = 'Add valid mortgage components before calculating House totals.';
    }
    document.getElementById('houseMortgage').textContent = ready ? investmentFormat(mortgage, 2) : '—';
    const interestEntries = [...interest, ...houseStoredInstallments.filter(item => item.entryType === 'regular' && item.amount < 0)];
    const interestTotal = interestEntries.reduce((sum, item) => sum + item.amount, 0);
    if (!Number.isFinite(interestTotal)) {
        ready = false;
        status.textContent = 'The interest total is too large to calculate.';
    }
    const interestKpi = document.getElementById('houseInterestTotal');
    interestKpi.textContent = ready ? `${investmentFormat(interestTotal)} DKK` : '—';
    interestKpi.className = ready && interestTotal < 0 ? 'house-interest-negative' : '';
    document.getElementById('houseRetryConfig').hidden = !(houseConfigError || houseEntriesError);
    document.getElementById('houseAddInstallment').disabled = !ready || houseSaving;
    document.getElementById('houseSubmitInstallment').disabled = !ready || houseSaving;
    document.getElementById('houseCloseDialog').disabled = houseSaving;
    document.getElementById('houseCancelDialog').disabled = houseSaving;

    const installments = [...bank, ...interest, ...houseStoredInstallments]
        .sort((a, b) => b.sortKey - a.sortKey);
    const equityEntries = [...bank, ...houseStoredInstallments.filter(item => item.entryType !== 'mortgage_component')];
    const pages = Math.max(1, Math.ceil(installments.length / HOUSE_ROWS_PER_PAGE));
    housePage = Math.min(housePage, pages);
    document.getElementById('housePageStatus').textContent = `Page ${housePage} of ${pages}`;
    document.getElementById('housePreviousPage').disabled = housePage <= 1;
    document.getElementById('houseNextPage').disabled = housePage >= pages;
    installments.slice((housePage - 1) * HOUSE_ROWS_PER_PAGE, housePage * HOUSE_ROWS_PER_PAGE).forEach(item => {
        const tr = document.createElement('tr');
        const date = document.createElement('td');
        date.textContent = item.date || '—';
        const source = document.createElement('td');
        source.textContent = item.source;
        const amount = document.createElement('td');
        amount.textContent = investmentFormat(item.amount);
        amount.className = item.amount < 0 ? 'house-amount-negative' : 'house-amount-positive';
        const actions = document.createElement('td');
        if (item.id !== undefined) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'house-remove';
            remove.textContent = '×';
            remove.setAttribute('aria-label', `Remove saved installment from ${item.date}`);
            remove.disabled = houseSaving;
            remove.addEventListener('click', () => deleteHouseInstallment(item.id));
            actions.append(remove);
        }
        tr.append(date, source, amount, actions);
        body.append(tr);
    });

    const input = document.getElementById('houseValue');
    const value = houseValueNumber(input.value);
    const validValue = Number.isFinite(value);
    const message = document.getElementById('houseValueStatus');
    const diagram = document.getElementById('houseDiagram');
    const fill = document.getElementById('houseEquityFill');
    const debtLabel = document.getElementById('houseDebtPercent');
    const equityLabel = document.getElementById('houseEquityPercent');
    if (!ready || !validValue) {
        clearHouseHistory('History is unavailable until House data and value are valid.');
        document.getElementById('houseDebt').textContent = '—';
        document.getElementById('houseEquity').textContent = '—';
        debtLabel.textContent = '';
        equityLabel.textContent = '';
        fill.setAttribute('height', '0');
        diagram.setAttribute('aria-label', 'House debt and equity unavailable');
        message.textContent = validValue ? '' : 'Enter a valid whole house value greater than zero.';
        return;
    }
    const result = HouseMath.calculate(value, mortgage, equityEntries);
    const equityPercent = result.fraction * 100;
    const debtPercent = 100 - equityPercent;
    if (![result.equity, result.debt, equityPercent, debtPercent, result.fillTop].every(Number.isFinite)) {
        clearHouseHistory('History is unavailable because the totals are too large to calculate.');
        document.getElementById('houseDebt').textContent = '—';
        document.getElementById('houseEquity').textContent = '—';
        debtLabel.textContent = '';
        equityLabel.textContent = '';
        fill.setAttribute('height', '0');
        diagram.setAttribute('aria-label', 'House debt and equity unavailable');
        message.textContent = 'The house value and installments are too large to calculate.';
        return;
    }
    document.getElementById('houseDebt').textContent = investmentFormat(result.debt, 0);
    document.getElementById('houseEquity').textContent = investmentFormat(result.equity, 0);
    if (houseHistoryVisible) renderHouseHistory(equityEntries, interestEntries, value, mortgage);
    debtLabel.textContent = `${investmentFormat(debtPercent)}%`;
    equityLabel.textContent = `${investmentFormat(equityPercent)}%`;
    debtLabel.setAttribute('y', String(Math.max(80, result.fillTop / 2)));
    equityLabel.setAttribute('y', String(Math.min(288, (result.fillTop + 300) / 2)));
    fill.setAttribute('y', String(result.fillTop));
    fill.setAttribute('height', String(300 - result.fillTop));
    diagram.setAttribute('aria-label', `House debt ${investmentFormat(debtPercent)}%, equity ${investmentFormat(equityPercent)}%`);
    message.textContent = result.fraction > 1 || result.fraction < 0
        ? 'Equity is outside the house value; the graphic is capped, but the amounts and percentages are not.'
        : '';
}

if (typeof document !== 'undefined') {
    document.getElementById('houseMortgage').textContent = '—';
    const houseDiagram = document.getElementById('houseDiagram');
    const houseChartWrap = document.getElementById('houseHistoryChartWrap');
    new ResizeObserver(entries => {
        const width = entries[0].contentRect.width;
        if (width > 0) houseChartWrap.style.setProperty('--house-diagram-width', `${width}px`);
    }).observe(houseDiagram);
    for (const [id, visible] of [['houseGraphButton', true], ['houseInstallmentsButton', false]]) {
        document.getElementById(id).addEventListener('click', () => {
            if (houseHistoryVisible === visible) return;
            houseHistoryVisible = visible;
            updateHouseView();
            if (!houseHistoryVisible) clearHouseHistory('');
            renderHouse();
        });
    }
    document.getElementById('houseRetryConfig').addEventListener('click', openHouse);
    const houseValueInput = document.getElementById('houseValue');
    houseValueInput.addEventListener('focus', () => {
        if (Number.isFinite(houseValueNumber(houseValueInput.value))) {
            houseValueInput.value = houseValueInput.value.replace(/,/g, '');
            houseValueInput.select();
        }
    });
    houseValueInput.addEventListener('input', renderHouse);
    houseValueInput.addEventListener('blur', () => {
        const value = houseValueNumber(houseValueInput.value);
        if (Number.isFinite(value)) houseValueInput.value = investmentFormat(value, 0);
    });
    document.getElementById('housePreviousPage').addEventListener('click', () => {
        if (housePage > 1) { housePage--; renderHouse(); }
    });
    document.getElementById('houseNextPage').addEventListener('click', () => {
        housePage++; renderHouse();
    });
    const houseDialog = document.getElementById('houseInstallmentDialog');
    document.getElementById('houseAddInstallment').addEventListener('click', () => {
        if (!document.getElementById('houseAddInstallment').disabled && !houseDialog.open) houseDialog.showModal();
    });
    for (const id of ['houseCloseDialog', 'houseCancelDialog']) {
        document.getElementById(id).addEventListener('click', () => {
            if (!houseSaving && houseDialog.open) houseDialog.close();
        });
    }
    houseDialog.addEventListener('cancel', event => {
        if (houseSaving) event.preventDefault();
    });
    houseDialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            if (!houseSaving) houseDialog.close();
        }
    });
    document.getElementById('houseInstallmentForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (houseSaving || document.getElementById('houseAddInstallment').disabled) return;
        const form = event.currentTarget;
        const date = document.getElementById('houseInstallmentDate').value;
        const amountInput = document.getElementById('houseInstallmentAmount');
        const amount = amountInput.value === '' ? NaN : Number(amountInput.value);
        if (!form.checkValidity() || !isValidIsoDate(date) || !Number.isFinite(amount) || amount === 0) {
            document.getElementById('houseFormStatus').textContent = 'Enter a valid date in YYYY-MM-DD format and a non-zero installment amount.';
            return;
        }
        const generation = houseGeneration;
        houseSaving = true;
        document.getElementById('houseFormStatus').textContent = '';
        renderHouse();
        try {
            const { data, error } = await supabaseClient.from('house_installments')
                .insert({ entry_date: date, amount, concept: amount > 0 ? 'Bank installment' : 'Interest / Adjustment' })
                .select('id, entry_date, amount, concept, entry_type').single();
            if (error) throw new Error(error.message);
            const entry = storedHouseInstallment(data);
            if (generation !== houseGeneration) return;
            houseStoredInstallments.push(entry);
            form.reset();
            if (houseDialog.open) houseDialog.close();
        } catch (error) {
            if (generation !== houseGeneration) return;
            document.getElementById('houseFormStatus').textContent = `Unable to save installment: ${error.message}. Close this dialog and retry loading before trying again; the save may have completed.`;
            houseEntriesLoaded = false;
            houseEntriesError = 'Reload saved installments before trying again; the save may have completed.';
        } finally {
            if (generation === houseGeneration) {
                houseSaving = false;
                renderHouse();
            }
        }
    });
}
