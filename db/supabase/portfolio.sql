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

ALTER TABLE public.portfolio_items
    ADD COLUMN IF NOT EXISTS valuation_version bigint NOT NULL DEFAULT 0;

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

CREATE OR REPLACE FUNCTION public.invalidate_portfolio_valuation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.portfolio_items
    SET current_value_dkk = CASE
            WHEN lower(trim(NEW.action)) IN ('buy', 'sell') AND lower(type) <> 'crowdlending'
            THEN NULL ELSE current_value_dkk END,
        valuation_version = valuation_version + 1
    WHERE id = NEW.portfolio_item_id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_portfolio_valuation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS portfolio_transaction_invalidate_valuation ON public.portfolio_transactions;
CREATE TRIGGER portfolio_transaction_invalidate_valuation
    AFTER INSERT ON public.portfolio_transactions
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_portfolio_valuation();

CREATE OR REPLACE FUNCTION public.add_portfolio_transaction(p_transaction jsonb)
RETURNS public.portfolio_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    item public.portfolio_items%ROWTYPE;
    saved public.portfolio_transactions%ROWTYPE;
    action_value text := trim(p_transaction->>'action');
    field_name text;
    field_value text;
    normalized text;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;
    IF action_value IS NULL OR action_value = '' OR p_transaction->>'transaction_date' IS NULL THEN
        RAISE EXCEPTION 'Date and action are required';
    END IF;
    SELECT * INTO STRICT item FROM public.portfolio_items
        WHERE id = (p_transaction->>'portfolio_item_id')::uuid FOR UPDATE;

    FOREACH field_name IN ARRAY ARRAY['quantity', 'price_per_unit', 'exchange_rate', 'commission', 'fees', 'total_cost', 'local_value']
    LOOP
        field_value := trim(coalesce(p_transaction->>field_name, ''));
        normalized := CASE WHEN strpos(field_value, ',') > 0
            THEN replace(replace(field_value, '.', ''), ',', '.') ELSE field_value END;
        IF field_value <> '' AND normalized !~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN
            RAISE EXCEPTION 'Invalid %', field_name;
        END IF;
        IF field_name = 'quantity' AND lower(action_value) IN ('buy', 'sell') THEN
            IF field_value = '' THEN RAISE EXCEPTION 'Quantity is required for buys and sells'; END IF;
            IF normalized::numeric < 0 THEN RAISE EXCEPTION 'Quantity must be non-negative'; END IF;
        END IF;
        IF field_name = 'total_cost' AND lower(action_value) IN ('buy', 'sell', 'dividend', 'dividend tax') AND field_value = '' THEN
            RAISE EXCEPTION 'Total cost is required for this action';
        END IF;
    END LOOP;

    INSERT INTO public.portfolio_transactions (
        portfolio_item_id, transaction_date, action, platform, type, ticker, name,
        quantity, price_per_unit, exchange_rate, commission, fees, currency,
        total_cost, local_value, local_currency
    ) VALUES (
        item.id, (p_transaction->>'transaction_date')::date, action_value,
        item.platform, item.type, item.ticker, item.name,
        coalesce(trim(p_transaction->>'quantity'), ''), coalesce(trim(p_transaction->>'price_per_unit'), ''),
        coalesce(trim(p_transaction->>'exchange_rate'), ''), coalesce(trim(p_transaction->>'commission'), ''),
        coalesce(trim(p_transaction->>'fees'), ''), coalesce(trim(p_transaction->>'currency'), ''),
        coalesce(trim(p_transaction->>'total_cost'), ''), coalesce(trim(p_transaction->>'local_value'), ''),
        coalesce(trim(p_transaction->>'local_currency'), '')
    ) RETURNING * INTO saved;
    RETURN saved;
END;
$$;

REVOKE ALL ON FUNCTION public.add_portfolio_transaction(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_portfolio_transaction(jsonb) TO authenticated;

COMMIT;
