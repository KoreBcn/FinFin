type MarketRequest = {
    path: 'quote' | 'exchange_rate' | 'time_series';
    params: Record<string, string>;
};

function isMarketRequest(value: unknown): value is MarketRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const request = value as Record<string, unknown>;
    if (typeof request.path !== 'string' || !['quote', 'exchange_rate', 'time_series'].includes(request.path)
        || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) return false;
    const params = request.params as Record<string, unknown>;
    const allowed = request.path === 'time_series'
        ? ['symbol', 'interval', 'outputsize'] : ['symbol'];
    return !Object.keys(params).some(key => !allowed.includes(key))
        && typeof params.symbol === 'string' && /^[A-Za-z0-9.^=|:/-]{1,40}$/.test(params.symbol)
        && params.symbol !== '.' && params.symbol !== '..'
        && (request.path !== 'time_series' || (params.interval === '1day' && params.outputsize === '140'));
}

function yahooSymbol(request: MarketRequest): string | null {
    const symbol = request.params.symbol;
    if (request.path === 'exchange_rate') {
        return /^[A-Z]{3}\/DKK$/.test(symbol) ? `${symbol.slice(0, 3)}DKK=X` : null;
    }
    return symbol;
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function error(message: string, status: number): Response {
    return Response.json({ error: message }, { status });
}

export async function marketData(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
    if (request.method !== 'POST') return error('Only POST requests are supported.', 405);
    let payload: unknown;
    try {
        payload = await request.json();
    } catch {
        return error('Expected a JSON market data request.', 400);
    }
    if (!isMarketRequest(payload)) return error('Invalid market data request.', 400);
    const symbol = yahooSymbol(payload);
    if (!symbol) return error('Unsupported currency pair.', 400);

    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set('interval', payload.path === 'time_series' ? '1d' : '1m');
    url.searchParams.set('range', payload.path === 'time_series' ? '6mo' : '1d');
    let result: unknown;
    try {
        const response = await fetcher(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (response.status === 429) return error('Yahoo Finance returned HTTP 429 (rate limited). Try again later.', 502);
        if (!response.ok) return error(`Yahoo Finance returned HTTP ${response.status}.`, 502);
        result = await response.json();
    } catch {
        return error('Unable to retrieve valid data from Yahoo Finance.', 502);
    }
    const chart = record(record(result)?.chart);
    if (chart?.error) return error('Yahoo Finance rejected the market data request.', 502);
    const item = Array.isArray(chart?.result) ? record(chart.result[0]) : null;
    const meta = record(item?.meta);
    if (!item || !meta || typeof meta.symbol !== 'string' || meta.symbol.toUpperCase() !== symbol.toUpperCase()) {
        return error('Yahoo Finance returned an invalid symbol or response.', 502);
    }

    if (payload.path !== 'time_series') {
        const price = meta.regularMarketPrice;
        if (!positiveNumber(price) || typeof meta.currency !== 'string' || !/^[A-Z]{3}$/.test(meta.currency)
            || (payload.path === 'exchange_rate' && meta.currency !== 'DKK')) {
            return error('Yahoo Finance returned an invalid price or currency.', 502);
        }
        if (payload.path === 'exchange_rate') return Response.json({ rate: price });
        const previous = meta.chartPreviousClose;
        return Response.json({
            close: price, currency: meta.currency,
            last_quote_at: positiveNumber(meta.regularMarketTime) ? meta.regularMarketTime : null,
            percent_change: positiveNumber(previous) ? (price / previous - 1) * 100 : null
        });
    }

    const indicators = record(item.indicators);
    const quote = Array.isArray(indicators?.quote) ? record(indicators.quote[0]) : null;
    if (!Array.isArray(item.timestamp) || !Array.isArray(quote?.close)
        || item.timestamp.length !== quote.close.length || typeof meta.exchangeTimezoneName !== 'string') {
        return error('Yahoo Finance returned invalid price history.', 502);
    }
    const closes: unknown[] = quote.close;
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: meta.exchangeTimezoneName, year: 'numeric', month: '2-digit', day: '2-digit'
        });
        const values = item.timestamp.flatMap((timestamp: unknown, index: number) => {
            const close = closes[index];
            if (!positiveNumber(timestamp) || !positiveNumber(close)) return [];
            const parts = formatter.formatToParts(new Date(timestamp * 1000));
            const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
            return [{ datetime: date, close }];
        }).sort((a, b) => b.datetime.localeCompare(a.datetime));
        if (!values.length) return error('Yahoo Finance returned empty price history.', 502);
        return Response.json({ values });
    } catch {
        return error('Yahoo Finance returned invalid price history dates.', 502);
    }
}
