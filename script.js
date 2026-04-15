const appState = {
  currency: 'DKK',
  exchangeRate: 7.45,
  fileName: null,
  records: [],
  selectedType: null,
  monthlyScope: null,
  selectedExpense: null,
  yearFilter: null,
  plannedRealizedFilter: 'all',
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    return [];
  }

  const headers = splitCsvLine(lines.shift()).map((header) => header.trim());
  return lines.map((line) => {
    const values = splitCsvLine(line);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = values[index] ? values[index].trim() : '';
    });

    return row;
  });
}

function buildRecords(rows) {
  return rows
    .map((row) => {
      const amountValue = Number((row.Amount || '0').replace(',', '.')) || 0;
      return {
        expense: row.Expense || '',
        plannedRea: (row['Planned/Rea'] || '').trim(),
        type: row.Type || 'Uncategorized',
        date: row.Date || '',
        month: Number(row.Month) || 0,
        year: Number(row.Year) || 0,
        amount: amountValue,
        comments: row.Comments || '',
        category: row.Type || 'Uncategorized',
      };
    })
    .filter((record) => record.amount !== 0);
}

function getConversionRate() {
  return appState.currency === 'EUR' ? appState.exchangeRate || 1 : 1;
}

function formatCurrency(value) {
  const absoluteValue = Math.abs(value);
  const options = {
    style: 'currency',
    currency: appState.currency,
    maximumFractionDigits: 0,
  };
  const locale = appState.currency === 'EUR' ? 'de-DE' : 'da-DK';
  const formatted = new Intl.NumberFormat(locale, options).format(absoluteValue);
  return value < 0 ? `-${formatted}` : formatted;
}

function matchesPlannedRealizedFilter(record) {
  if (appState.plannedRealizedFilter === 'all') {
    return true;
  }

  const normalized = (record.plannedRea || '').trim().toLowerCase();
  if (appState.plannedRealizedFilter === 'planned') {
    return normalized === 'planned';
  }

  return normalized === 'rea' || normalized === 'realized';
}

function getFilteredRecords() {
  return appState.records.filter((record) => {
    const yearMatch = !appState.yearFilter || record.year === appState.yearFilter;
    return yearMatch && matchesPlannedRealizedFilter(record);
  });
}

function getUniqueYears() {
  const years = Array.from(new Set(appState.records.map((record) => record.year))).filter(Boolean);
  return years.sort((a, b) => b - a);
}

function updateYearOptions() {
  const select = document.getElementById('yearSelect');
  const years = getUniqueYears();
  select.innerHTML = '<option value="">All years</option>';

  years.forEach((year) => {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = year;
    select.appendChild(option);
  });

  select.value = appState.yearFilter || '';
}

function calculateData() {
  const rate = getConversionRate();
  const filteredRecords = getFilteredRecords();
  const records = filteredRecords.map((record) => ({
    ...record,
    convertedAmount: record.amount / rate,
  }));

  const incomePlanned = records
    .filter((record) => record.amount > 0 && record.plannedRea.toLowerCase() === 'planned')
    .reduce((sum, record) => sum + record.convertedAmount, 0);
  const incomeRealized = records
    .filter((record) => record.amount > 0 && record.plannedRea.toLowerCase() === 'rea')
    .reduce((sum, record) => sum + record.convertedAmount, 0);
  const expensePlanned = records
    .filter((record) => record.amount < 0 && record.plannedRea.toLowerCase() === 'planned')
    .reduce((sum, record) => sum + Math.abs(record.convertedAmount), 0);
  const expenseRealized = records
    .filter((record) => record.amount < 0 && record.plannedRea.toLowerCase() === 'rea')
    .reduce((sum, record) => sum + Math.abs(record.convertedAmount), 0);

  const savingsPlanned = incomePlanned - expensePlanned;
  const savingsRealized = incomeRealized - expenseRealized;

  const categoryMap = new Map();
  records.forEach((record) => {
    const categoryName = record.category || 'Uncategorized';
    if (!categoryMap.has(categoryName)) {
      categoryMap.set(categoryName, { name: categoryName, items: [] });
    }
    categoryMap.get(categoryName).items.push(record);
  });

  
  const categories = Array.from(categoryMap.values());

  const categorySummaries = categories.map((category) => {
    const realized = category.items
      .filter((record) => record.plannedRea.toLowerCase() === 'rea')
      .reduce((sum, record) => sum + Math.abs(record.convertedAmount), 0);
    const planned = category.items
      .filter((record) => record.plannedRea.toLowerCase() === 'planned')
      .reduce((sum, record) => sum + Math.abs(record.convertedAmount), 0);

    return {
      name: category.name,
      realized,
      planned,
      items: category.items,
    };
  });

  const recordsForMonthly = appState.monthlyScope
    ? records.filter((record) => record.category === appState.monthlyScope)
    : records;

  const monthlyData = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    planned: 0,
    realized: 0,
  }));

  recordsForMonthly.forEach((record) => {
    const monthIndex = record.month - 1;
    if (monthIndex >= 0 && monthIndex < 12) {
      const amount = Math.abs(record.convertedAmount);
      if (record.plannedRea.toLowerCase() === 'planned') {
        monthlyData[monthIndex].planned += amount;
      } else if (record.plannedRea.toLowerCase() === 'rea') {
        monthlyData[monthIndex].realized += amount;
      }
    }
  });

  return {
    incomePlanned,
    incomeRealized,
    expensePlanned,
    expenseRealized,
    savingsPlanned,
    savingsRealized,
    categories: categorySummaries,
    monthlyData,
  };
}

function renderSummary(data) {
  document.getElementById('incomePlannedValue').textContent = formatCurrency(data.incomePlanned);
  document.getElementById('incomeRealizedValue').textContent = formatCurrency(data.incomeRealized);
  document.getElementById('expensePlannedValue').textContent = formatCurrency(data.expensePlanned);
  document.getElementById('expenseRealizedValue').textContent = formatCurrency(data.expenseRealized);
  document.getElementById('savingsPlannedValue').textContent = formatCurrency(data.savingsPlanned);
  document.getElementById('savingsRealizedValue').textContent = formatCurrency(data.savingsRealized);
}

function renderIncomeChart(data) {
  const incomeCategories = data.categories
    .filter((category) => category.items.some((item) => item.amount > 0))
    .filter((category) => {
      const normalized = category.name.trim().toLowerCase();
      return !normalized.includes('home') && !normalized.includes('anna');
    })
    .sort((a, b) => (b.planned + b.realized) - (a.planned + a.realized));
  const container = document.getElementById('incomeChart');
  container.innerHTML = '';

  if (incomeCategories.length === 0) {
    container.innerHTML = '<div class="empty-chart">No income categories available for the current filters.</div>';
    return;
  }

  const maxValue = Math.max(...incomeCategories.flatMap((category) => [category.planned, category.realized]), 1);
  const chartGrid = document.createElement('div');
  chartGrid.className = 'bar-chart-grid income-chart-grid';

  incomeCategories.forEach((category) => {
    const isSelected = category.name === appState.selectedType;
    const plannedValue = Math.max(0, category.planned);
    const realizedValue = Math.max(0, category.realized);
    const plannedHeight = plannedValue > 0 ? Math.max(10, Math.round((plannedValue / maxValue) * 100)) : 0;
    const realizedHeight = realizedValue > 0 ? Math.max(10, Math.round((realizedValue / maxValue) * 100)) : 0;

    const column = document.createElement('div');
    column.className = `bar-column${isSelected ? ' selected' : ''}`;
    column.setAttribute('role', 'button');
    column.setAttribute('tabindex', '0');
    column.innerHTML = `
      <div class="bar-value">${formatCurrency(plannedValue + realizedValue)}</div>
      <div class="bar-stack">
        <div class="bar-group">
          <span class="bar-pill bar-planned" style="height: ${plannedHeight}%" title="Planned: ${formatCurrency(plannedValue)}"></span>
          <span class="bar-caption">P</span>
        </div>
        <div class="bar-group">
          <span class="bar-pill bar-realized" style="height: ${realizedHeight}%" title="Realized: ${formatCurrency(realizedValue)}"></span>
          <span class="bar-caption">R</span>
        </div>
      </div>
      <div class="bar-label">${escapeHtml(category.name)}</div>
    `;

    const activateCategory = () => {
      appState.selectedType = category.name;
      appState.monthlyScope = category.name;
      appState.selectedExpense = null;
      renderIncomeChart(data);
      renderCategoryChart(data);
      renderMonthlyChart(data);
      renderDrilldown(category);
    };

    column.addEventListener('click', activateCategory);
    column.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateCategory();
      }
    });

    chartGrid.appendChild(column);
  });

  container.appendChild(chartGrid);
}

function renderCategoryChart(data) {
  const allCategories = data.categories
    .filter((category) => category.items.some((item) => item.amount < 0))
    .sort((a, b) => (b.planned + b.realized) - (a.planned + a.realized));
  const container = document.getElementById('categoryChart');
  container.innerHTML = '';

  if (allCategories.length === 0) {
    container.innerHTML = '<div class="empty-chart">No expense categories available yet. Upload a CSV to view results.</div>';
    return;
  }

  const maxValue = Math.max(...allCategories.flatMap((category) => [category.planned, category.realized]), 1);
  const chartGrid = document.createElement('div');
  chartGrid.className = 'bar-chart-grid';

  allCategories.forEach((category) => {
    const isSelected = category.name === appState.selectedType;
    const plannedValue = Math.max(0, category.planned);
    const realizedValue = Math.max(0, category.realized);
    const plannedHeight = plannedValue > 0 ? Math.max(10, Math.round((plannedValue / maxValue) * 100)) : 0;
    const realizedHeight = realizedValue > 0 ? Math.max(10, Math.round((realizedValue / maxValue) * 100)) : 0;

    const column = document.createElement('div');
    column.className = `bar-column${isSelected ? ' selected' : ''}`;
    column.setAttribute('role', 'button');
    column.setAttribute('tabindex', '0');
    column.innerHTML = `
      <div class="bar-value">${formatCurrency(plannedValue + realizedValue)}</div>
      <div class="bar-stack">
        <div class="bar-group">
          <span class="bar-pill bar-planned" style="height: ${plannedHeight}%" title="Planned: ${formatCurrency(plannedValue)}"></span>
          <span class="bar-caption">P</span>
        </div>
        <div class="bar-group">
          <span class="bar-pill bar-realized" style="height: ${realizedHeight}%" title="Realized: ${formatCurrency(realizedValue)}"></span>
          <span class="bar-caption">R</span>
        </div>
      </div>
      <div class="bar-label">${escapeHtml(category.name)}</div>
    `;

    const activateCategory = () => {
      appState.selectedType = category.name;
      appState.monthlyScope = category.name;
      appState.selectedExpense = null;
      renderIncomeChart(data);
      renderCategoryChart(data);
      renderMonthlyChart(data);
      renderDrilldown(category);
    };

    column.addEventListener('click', activateCategory);
    column.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateCategory();
      }
    });

    chartGrid.appendChild(column);
  });

  container.appendChild(chartGrid);
}

function renderMonthlyChart(data) {
  const container = document.getElementById('monthlyChart');
  container.innerHTML = '';

  const monthlyData = data.monthlyData || [];
  if (!monthlyData.length || monthlyData.every((entry) => entry.planned === 0 && entry.realized === 0)) {
    container.innerHTML = '<div class="empty-chart">No monthly development data available for the current filters.</div>';
    return;
  }

  const maxValue = Math.max(1, ...monthlyData.flatMap((entry) => [entry.planned, entry.realized]));
  const chartGrid = document.createElement('div');
  chartGrid.className = 'month-chart-grid';

  monthlyData.forEach((monthData, index) => {
    const plannedHeight = monthData.planned > 0 ? Math.max(8, Math.round((monthData.planned / maxValue) * 100)) : 0;
    const realizedHeight = monthData.realized > 0 ? Math.max(8, Math.round((monthData.realized / maxValue) * 100)) : 0;

    const column = document.createElement('div');
    column.className = 'month-column';
    column.innerHTML = `
      <div class="month-bar-stack">
        <span class="month-bar month-planned" style="height: ${plannedHeight}%" title="Planned ${MONTH_LABELS[index]}: ${formatCurrency(monthData.planned)}"></span>
        <span class="month-bar month-realized" style="height: ${realizedHeight}%" title="Realized ${MONTH_LABELS[index]}: ${formatCurrency(monthData.realized)}"></span>
      </div>
      <div class="month-label">${MONTH_LABELS[index]}</div>
    `;

    chartGrid.appendChild(column);
  });

  container.appendChild(chartGrid);
}

function setDrilldownOpen(isOpen) {
  const panel = document.querySelector('.drilldown-panel');
  if (!panel) {
    return;
  }
  panel.classList.toggle('open', isOpen);
  panel.setAttribute('aria-hidden', String(!isOpen));
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderDrilldown(category) {
  const container = document.getElementById('drilldownContent');
  if (!category || category.items.length === 0) {
    container.innerHTML = '<div class="empty-state">Select a category with data to inspect how each line item performed.</div>';
    setDrilldownOpen(false);
    return;
  }

  const difference = category.planned - category.realized;
  const header = document.createElement('div');
  header.className = 'drilldown-summary';
  header.innerHTML = `<p><strong>${escapeHtml(category.name)}</strong> — Realized: ${formatCurrency(category.realized)}, Planned: ${formatCurrency(category.planned)}, Difference: ${difference >= 0 ? '+' : '-'}${formatCurrency(Math.abs(difference))}</p>`;

  const expenseMap = new Map();
  category.items.forEach((item) => {
    const expenseName = item.expense || 'Unspecified';
    if (!expenseMap.has(expenseName)) {
      expenseMap.set(expenseName, { name: expenseName, planned: 0, realized: 0, items: [] });
    }
    const entry = expenseMap.get(expenseName);
    entry.items.push(item);
    const amount = Math.abs(item.convertedAmount);
    if (item.plannedRea.toLowerCase() === 'planned') {
      entry.planned += amount;
    } else if (item.plannedRea.toLowerCase() === 'rea') {
      entry.realized += amount;
    }
  });

  const expenseGroups = Array.from(expenseMap.values())
    .sort((a, b) => (b.planned + b.realized) - (a.planned + a.realized));

  const selectedExpense = appState.selectedExpense;
  const filteredItems = selectedExpense
    ? category.items.filter((item) => (item.expense || 'Unspecified') === selectedExpense)
    : category.items;

  const expenseChartContainer = document.createElement('div');
  expenseChartContainer.className = 'bar-chart expense-chart';
  const expenseChartGrid = document.createElement('div');
  expenseChartGrid.className = 'bar-chart-grid';

  const expenseMax = Math.max(1, ...expenseGroups.flatMap((group) => [group.planned, group.realized] || [0]));

  expenseGroups.forEach((group) => {
    const isSelected = group.name === selectedExpense;
    const plannedHeight = group.planned > 0 ? Math.max(10, Math.round((group.planned / expenseMax) * 100)) : 0;
    const realizedHeight = group.realized > 0 ? Math.max(10, Math.round((group.realized / expenseMax) * 100)) : 0;

    const column = document.createElement('div');
    column.className = `bar-column${isSelected ? ' selected' : ''}`;
    column.setAttribute('role', 'button');
    column.setAttribute('tabindex', '0');
    column.innerHTML = `
      <div class="bar-value">${formatCurrency(group.planned + group.realized)}</div>
      <div class="bar-stack">
        <div class="bar-group">
          <span class="bar-pill bar-planned" style="height: ${plannedHeight}%" title="Planned: ${formatCurrency(group.planned)}"></span>
          <span class="bar-caption">P</span>
        </div>
        <div class="bar-group">
          <span class="bar-pill bar-realized" style="height: ${realizedHeight}%" title="Realized: ${formatCurrency(group.realized)}"></span>
          <span class="bar-caption">R</span>
        </div>
      </div>
      <div class="bar-label">${escapeHtml(group.name)}</div>
    `;

    const activateExpense = () => {
      appState.selectedExpense = isSelected ? null : group.name;
      renderDrilldown(category);
    };

    column.addEventListener('click', activateExpense);
    column.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateExpense();
      }
    });

    expenseChartGrid.appendChild(column);
  });

  expenseChartContainer.appendChild(expenseChartGrid);

  const detailCard = document.createElement('div');
  detailCard.className = 'drilldown-panel-card detail-panel';
  let detailBody = '';

  if (filteredItems.length === 0) {
    detailBody = '<div class="empty-state">No records match this expense filter.</div>';
  } else {
    const rows = filteredItems
      .sort((a, b) => (a.year - b.year) || (a.month - b.month) || a.date.localeCompare(b.date))
      .map((item) => `
        <tr>
          <td>${escapeHtml(item.date)}</td>
          <td>${escapeHtml(item.expense)}</td>
          <td>${escapeHtml(item.plannedRea)}</td>
          <td>${formatCurrency(item.convertedAmount)}</td>
          <td>${escapeHtml(item.comments)}</td>
        </tr>
      `)
      .join('');

    detailBody = `
      <table class="details-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Expense Item</th>
            <th>Type</th>
            <th>Amount</th>
            <th>Comments</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  detailCard.innerHTML = `
    <div class="drilldown-chart-title">Detail view${selectedExpense ? ` — ${escapeHtml(selectedExpense)}` : ''}</div>
    ${detailBody}
  `;

  container.innerHTML = '';
  container.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'drilldown-grid';

  const chartCard = document.createElement('div');
  chartCard.className = 'drilldown-panel-card';
  chartCard.innerHTML = '<div class="drilldown-chart-title">Split by expense</div>';
  chartCard.appendChild(expenseChartContainer);

  grid.appendChild(chartCard);
  grid.appendChild(detailCard);
  container.appendChild(grid);

  setDrilldownOpen(true);
}

function updateFileName(name) {
  document.getElementById('fileNameDisplay').textContent = name ? `Loaded: ${name}` : 'No file loaded';
}

function renderEmptyState() {
  document.getElementById('incomePlannedValue').textContent = '0 kr';
  document.getElementById('incomeRealizedValue').textContent = '0 kr';
  document.getElementById('expensePlannedValue').textContent = '0 kr';
  document.getElementById('expenseRealizedValue').textContent = '0 kr';
  document.getElementById('savingsPlannedValue').textContent = '0 kr';
  document.getElementById('savingsRealizedValue').textContent = '0 kr';
  document.getElementById('incomeChart').innerHTML = '<div class="empty-chart">Upload your CSV to see income categories.</div>';
  document.getElementById('categoryChart').innerHTML = '<div class="empty-chart">Upload your CSV to see expense categories.</div>';
  document.getElementById('monthlyChart').innerHTML = '<div class="empty-chart">Upload your CSV to see monthly development.</div>';
  document.getElementById('drilldownContent').innerHTML = '<div class="empty-state">Upload your CSV and select a category to inspect the details.</div>';
  setDrilldownOpen(false);
}

function renderDashboard() {
  if (appState.records.length === 0) {
    renderEmptyState();
    return;
  }

  updateYearOptions();
  const data = calculateData();

  renderSummary(data);
  renderIncomeChart(data);
  renderCategoryChart(data);
  renderMonthlyChart(data);

  if (appState.selectedType) {
    const selected = data.categories.find((category) => category.name === appState.selectedType);
    if (selected) {
      renderDrilldown(selected);
    } else {
      setDrilldownOpen(false);
    }
  } else {
    setDrilldownOpen(false);
  }
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) {
    return;
  }

  appState.fileName = file.name;
  updateFileName(file.name);

  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    const rows = parseCsv(text);
    appState.records = buildRecords(rows);
    appState.selectedType = null;
    appState.monthlyScope = null;
    appState.selectedExpense = null;
    appState.yearFilter = getUniqueYears()[0] || null;
    renderDashboard();
  };
  reader.readAsText(file, 'UTF-8');
}

function bindEvents() {
  document.getElementById('fileInput').addEventListener('change', handleFileUpload);
  document.getElementById('currencySelect').addEventListener('change', (event) => {
    appState.currency = event.target.value;
    renderDashboard();
  });
  document.getElementById('exchangeRateInput').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    if (value > 0) {
      appState.exchangeRate = value;
      renderDashboard();
    }
  });
  document.getElementById('yearSelect').addEventListener('change', (event) => {
    appState.yearFilter = event.target.value ? Number(event.target.value) : null;
    renderDashboard();
  });
  document.getElementById('plannedRealizedSelect').addEventListener('change', (event) => {
    appState.plannedRealizedFilter = event.target.value;
    renderDashboard();
  });
  const closeButton = document.getElementById('closeDrilldown');
  if (closeButton) {
    closeButton.addEventListener('click', () => setDrilldownOpen(false));
  }
  const toggleButton = document.getElementById('drilldownToggle');
  if (toggleButton) {
    toggleButton.addEventListener('click', () => {
      const panel = document.querySelector('.drilldown-panel');
      setDrilldownOpen(!panel.classList.contains('open'));
    });
  }
}

function initializeDashboard() {
  updateFileName(null);
  renderEmptyState();
  bindEvents();
}

initializeDashboard();
