BEGIN;

CREATE TABLE IF NOT EXISTS public.portfolio_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker text NOT NULL CHECK (length(trim(ticker)) > 0),
    platform text NOT NULL CHECK (length(trim(platform)) > 0),
    name text NOT NULL CHECK (length(trim(name)) > 0),
    type text NOT NULL CHECK (length(trim(type)) > 0),
    market_symbol text,
    is_in_scope boolean NOT NULL DEFAULT true,
    current_value_dkk numeric,
    inserted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ticker, platform)
);

CREATE TABLE IF NOT EXISTS public.portfolio_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    portfolio_item_id uuid NOT NULL REFERENCES public.portfolio_items(id),
    transaction_date date NOT NULL,
    action text NOT NULL,
    platform text NOT NULL,
    type text NOT NULL,
    ticker text NOT NULL,
    name text NOT NULL,
    quantity text NOT NULL,
    price_per_unit text NOT NULL,
    exchange_rate text NOT NULL,
    commission text NOT NULL,
    fees text NOT NULL,
    currency text NOT NULL,
    total_cost text NOT NULL,
    local_value text NOT NULL,
    local_currency text NOT NULL,
    inserted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portfolio_transactions_item_idx
    ON public.portfolio_transactions (portfolio_item_id, id);

ALTER TABLE public.portfolio_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portfolio_items, public.portfolio_transactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.portfolio_items TO authenticated;
GRANT SELECT ON public.portfolio_transactions TO authenticated;

DROP POLICY IF EXISTS portfolio_items_authenticated_access ON public.portfolio_items;
CREATE POLICY portfolio_items_authenticated_access ON public.portfolio_items
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS portfolio_transactions_authenticated_read ON public.portfolio_transactions;
CREATE POLICY portfolio_transactions_authenticated_read ON public.portfolio_transactions
    FOR SELECT TO authenticated USING (true);

COMMIT;
