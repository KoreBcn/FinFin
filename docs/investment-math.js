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
                || (item.current_value_dkk != null && !Number.isFinite(Number(item.current_value_dkk)))
                || (item.market_price != null && (!Number.isFinite(Number(item.market_price)) || Number(item.market_price) <= 0))
                || ((item.market_price == null) !== (item.market_currency == null))
                || (item.market_currency != null && !/^[A-Z]{3}$/.test(item.market_currency))
                || (item.market_price_at != null && (item.market_price == null || !Number.isFinite(Date.parse(item.market_price_at))))) {
                throw new Error('A portfolio item contains invalid data.');
            }
            positions.set(item.id, {
                id: item.id, key: JSON.stringify([item.platform, item.ticker]),
                ticker: item.ticker, platform: item.platform, name: item.name, type: item.type,
                isInScope: item.is_in_scope,
                currentValue: item.current_value_dkk == null ? null : Number(item.current_value_dkk),
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
            }
        });
        return [...positions.values()].map(p => ({
            ...p, quantityUnknown: p.quantityUnknown || p.tradeCount === 0, other: [...p.other]
        }));
    }

    function changeSince(values, latest, days, now = new Date()) {
        const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days)).toISOString().slice(0, 10);
        const prior = values.find(item => item.datetime <= target && Number(item.close) > 0);
        return prior ? (latest / Number(prior.close) - 1) * 100 : null;
    }

    return { fromStored, number, changeSince };
})();

if (typeof module !== 'undefined') module.exports = InvestmentMath;
