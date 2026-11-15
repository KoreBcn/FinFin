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
        ? ['symbol', 'mic_code', 'interval', 'outputsize'] : ['symbol', 'mic_code'];
    if (Object.keys(params).some(key => !allowed.includes(key))
        || typeof params.symbol !== 'string' || !/^[A-Za-z0-9./-]{1,40}$/.test(params.symbol)
        || (params.mic_code !== undefined && (typeof params.mic_code !== 'string'
            || !/^[A-Za-z0-9]{4}$/.test(params.mic_code)))
        || (request.path === 'time_series' && (params.interval !== '1day' || params.outputsize !== '140'))) return false;
    return true;
}

function error(message: string, status: number): Response {
    return Response.json({ error: message }, { status });
}

export async function marketData(request: Request, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<Response> {
    if (request.method !== 'POST') return error('Only POST requests are supported.', 405);
    let payload: unknown;
    try {
        payload = await request.json();
    } catch {
        return error('Expected a JSON market data request.', 400);
    }
    if (!isMarketRequest(payload)) return error('Invalid market data request.', 400);
    const key = apiKey?.trim();
    if (!key) return error('Twelve Data is not configured in Supabase.', 503);

    const url = new URL(`https://api.twelvedata.com/${payload.path}`);
    for (const [name, value] of Object.entries(payload.params)) url.searchParams.set(name, value);
    url.searchParams.set('apikey', key);
    let response: Response;
    let result: unknown;
    try {
        response = await fetcher(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) return error(`Twelve Data returned HTTP ${response.status}.`, 502);
        result = await response.json();
    } catch {
        return error('Unable to retrieve valid data from Twelve Data.', 502);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return error('Twelve Data returned an invalid response.', 502);
    }
    if (JSON.stringify(result).includes(key)) return error('Twelve Data returned an unsafe response.', 502);
    const data = result as Record<string, unknown>;
    if (data.status === 'error' || data.code) {
        const detail = Number.isInteger(data.code) ? ` (code ${data.code})` : '';
        return error(`Twelve Data rejected the request${detail}; check the symbol, plan, and API limits.`, 502);
    }
    if (payload.path === 'time_series') {
        if (!Array.isArray(data.values) || !data.values.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
            return error('Twelve Data returned invalid price history.', 502);
        }
        return Response.json({ values: data.values.map(item => ({ datetime: item.datetime, close: item.close })) });
    }
    const fields = payload.path === 'exchange_rate'
        ? ['rate'] : ['close', 'currency', 'datetime', 'last_quote_at', 'percent_change'];
    return Response.json(Object.fromEntries(fields.map(field => [field, data[field] ?? null])));
}
