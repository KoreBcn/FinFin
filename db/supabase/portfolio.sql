BEGIN;

DO $$
BEGIN
    IF to_regprocedure('public.is_shared_meal_plan_member()') IS NULL THEN
        RAISE EXCEPTION 'Set up Meal Plan household membership before installing HomeFin portfolio';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.portfolio_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker text NOT NULL CHECK (length(trim(ticker)) > 0),
    platform text NOT NULL CHECK (length(trim(platform)) > 0),
    name text NOT NULL CHECK (length(trim(name)) > 0),
    type text NOT NULL CHECK (length(trim(type)) > 0),
    market_symbol text,
    is_closed boolean NOT NULL DEFAULT false,
    is_in_scope boolean NOT NULL DEFAULT true,
    current_value_dkk numeric,
    inserted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ticker, platform)
);

-- One-off migration: the old is_in_scope (true = open) becomes the inverted is_closed;
-- the new is_in_scope decides whether an item counts toward total P/L.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'portfolio_items' AND column_name = 'is_in_scope')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'portfolio_items' AND column_name = 'is_closed') THEN
        ALTER TABLE public.portfolio_items RENAME COLUMN is_in_scope TO is_closed;
        UPDATE public.portfolio_items SET is_closed = NOT is_closed;
        ALTER TABLE public.portfolio_items ALTER COLUMN is_closed SET DEFAULT false;
        ALTER TABLE public.portfolio_items ADD COLUMN is_in_scope boolean NOT NULL DEFAULT true;
        UPDATE public.portfolio_items SET is_in_scope = false
            WHERE lower(trim(platform)) IN ('ops capital', 'kucoin', 'ethereum');
    END IF;
END $$;

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
    ADD COLUMN IF NOT EXISTS valuation_version bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS market_price numeric,
    ADD COLUMN IF NOT EXISTS market_currency text,
    ADD COLUMN IF NOT EXISTS market_price_at timestamptz,
    ADD COLUMN IF NOT EXISTS market_change_today numeric,
    ADD COLUMN IF NOT EXISTS market_change_7d numeric,
    ADD COLUMN IF NOT EXISTS market_change_30d numeric,
    ADD COLUMN IF NOT EXISTS market_change_90d numeric;
ALTER TABLE public.portfolio_transactions
    ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;

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
DROP POLICY IF EXISTS homefin_household_restriction ON public.portfolio_items;
CREATE POLICY homefin_household_restriction ON public.portfolio_items
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (coalesce(public.is_shared_meal_plan_member(), false))
    WITH CHECK (coalesce(public.is_shared_meal_plan_member(), false));
DROP POLICY IF EXISTS homefin_household_restriction ON public.portfolio_transactions;
CREATE POLICY homefin_household_restriction ON public.portfolio_transactions
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (coalesce(public.is_shared_meal_plan_member(), false))
    WITH CHECK (coalesce(public.is_shared_meal_plan_member(), false));

-- One row per item and day: open positions are snapshotted by the refresh workflow;
-- closed positions get a single realized P/L row dated at their last transaction.
CREATE TABLE IF NOT EXISTS public.portfolio_pnl_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    portfolio_item_id uuid NOT NULL REFERENCES public.portfolio_items(id) ON DELETE CASCADE,
    snapshot_date date NOT NULL,
    is_closed boolean NOT NULL DEFAULT false,
    quantity numeric,
    market_price numeric,
    market_currency text,
    value_dkk numeric,
    pnl_dkk numeric NOT NULL,
    source text NOT NULL DEFAULT 'refresh',
    inserted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (portfolio_item_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS portfolio_pnl_history_closed_idx
    ON public.portfolio_pnl_history (portfolio_item_id) WHERE is_closed;
ALTER TABLE public.portfolio_pnl_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portfolio_pnl_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.portfolio_pnl_history TO authenticated;
DROP POLICY IF EXISTS portfolio_pnl_history_authenticated_access ON public.portfolio_pnl_history;
CREATE POLICY portfolio_pnl_history_authenticated_access ON public.portfolio_pnl_history
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS homefin_household_restriction ON public.portfolio_pnl_history;
CREATE POLICY homefin_household_restriction ON public.portfolio_pnl_history
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (coalesce(public.is_shared_meal_plan_member(), false))
    WITH CHECK (coalesce(public.is_shared_meal_plan_member(), false));

CREATE TABLE IF NOT EXISTS public.portfolio_refresh_metadata (
    id smallint PRIMARY KEY CHECK (id = 1),
    refreshed_at timestamptz NOT NULL
);
ALTER TABLE public.portfolio_refresh_metadata ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portfolio_refresh_metadata FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.portfolio_refresh_metadata TO authenticated;
DROP POLICY IF EXISTS portfolio_refresh_metadata_authenticated_access ON public.portfolio_refresh_metadata;
CREATE POLICY portfolio_refresh_metadata_authenticated_access ON public.portfolio_refresh_metadata
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS homefin_household_restriction ON public.portfolio_refresh_metadata;
CREATE POLICY homefin_household_restriction ON public.portfolio_refresh_metadata
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (coalesce(public.is_shared_meal_plan_member(), false))
    WITH CHECK (coalesce(public.is_shared_meal_plan_member(), false));

CREATE OR REPLACE FUNCTION public.invalidate_portfolio_valuation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    old_item uuid;
    new_item uuid;
    old_trade boolean := false;
    new_trade boolean := false;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        old_item := OLD.portfolio_item_id;
        old_trade := lower(trim(OLD.action)) IN ('buy', 'sell');
    END IF;
    IF TG_OP <> 'DELETE' THEN
        new_item := NEW.portfolio_item_id;
        new_trade := lower(trim(NEW.action)) IN ('buy', 'sell');
    END IF;
    PERFORM id FROM public.portfolio_items
    WHERE id IN (old_item, new_item) ORDER BY id FOR UPDATE;
    UPDATE public.portfolio_items
    SET current_value_dkk = CASE
            WHEN lower(type) <> 'crowdlending'
                AND ((id = old_item AND old_trade) OR (id = new_item AND new_trade))
            THEN NULL ELSE current_value_dkk END,
        valuation_version = valuation_version + 1
    WHERE id IN (old_item, new_item);
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_portfolio_valuation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS portfolio_transaction_invalidate_valuation ON public.portfolio_transactions;
CREATE TRIGGER portfolio_transaction_invalidate_valuation
    AFTER INSERT OR UPDATE OR DELETE ON public.portfolio_transactions
    FOR EACH ROW EXECUTE FUNCTION public.invalidate_portfolio_valuation();

CREATE OR REPLACE FUNCTION public.increment_portfolio_transaction_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.revision := OLD.revision + 1;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_portfolio_transaction_revision() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS portfolio_transaction_revision ON public.portfolio_transactions;
CREATE TRIGGER portfolio_transaction_revision BEFORE UPDATE ON public.portfolio_transactions
    FOR EACH ROW EXECUTE FUNCTION public.increment_portfolio_transaction_revision();

CREATE OR REPLACE FUNCTION public.save_portfolio_transaction(
    p_transaction jsonb, p_id uuid DEFAULT NULL, p_expected_revision bigint DEFAULT NULL
)
RETURNS public.portfolio_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    item public.portfolio_items%ROWTYPE;
    existing public.portfolio_transactions%ROWTYPE;
    saved public.portfolio_transactions%ROWTYPE;
    action_value text := trim(p_transaction->>'action');
    field_name text;
    field_value text;
    normalized text;
BEGIN
    IF NOT coalesce(public.is_shared_meal_plan_member(), false) THEN
        RAISE EXCEPTION 'HomeFin household membership required';
    END IF;
    IF action_value IS NULL OR action_value = '' OR p_transaction->>'transaction_date' IS NULL THEN
        RAISE EXCEPTION 'Date and action are required';
    END IF;
    IF p_id IS NOT NULL THEN
        SELECT * INTO existing FROM public.portfolio_transactions WHERE id = p_id FOR UPDATE;
        IF NOT FOUND OR p_expected_revision IS NULL OR existing.revision <> p_expected_revision THEN
            RAISE EXCEPTION 'Transaction changed or was deleted; reload the portfolio';
        END IF;
    END IF;
    PERFORM id FROM public.portfolio_items
        WHERE id IN (existing.portfolio_item_id, (p_transaction->>'portfolio_item_id')::uuid)
        ORDER BY id FOR UPDATE;
    SELECT * INTO STRICT item FROM public.portfolio_items
        WHERE id = (p_transaction->>'portfolio_item_id')::uuid;

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

    IF p_id IS NULL THEN
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
    ELSE
        UPDATE public.portfolio_transactions SET
            portfolio_item_id = item.id, transaction_date = (p_transaction->>'transaction_date')::date,
            action = action_value,
            platform = CASE WHEN existing.portfolio_item_id = item.id THEN existing.platform ELSE item.platform END,
            type = CASE WHEN existing.portfolio_item_id = item.id THEN existing.type ELSE item.type END,
            ticker = CASE WHEN existing.portfolio_item_id = item.id THEN existing.ticker ELSE item.ticker END,
            name = CASE WHEN existing.portfolio_item_id = item.id THEN existing.name ELSE item.name END,
            quantity = coalesce(trim(p_transaction->>'quantity'), ''),
            price_per_unit = coalesce(trim(p_transaction->>'price_per_unit'), ''),
            exchange_rate = coalesce(trim(p_transaction->>'exchange_rate'), ''),
            commission = coalesce(trim(p_transaction->>'commission'), ''),
            fees = coalesce(trim(p_transaction->>'fees'), ''),
            currency = coalesce(trim(p_transaction->>'currency'), ''),
            total_cost = coalesce(trim(p_transaction->>'total_cost'), ''),
            local_value = coalesce(trim(p_transaction->>'local_value'), ''),
            local_currency = coalesce(trim(p_transaction->>'local_currency'), '')
        WHERE id = p_id RETURNING * INTO saved;
    END IF;
    RETURN saved;
END;
$$;

REVOKE ALL ON FUNCTION public.save_portfolio_transaction(jsonb, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_portfolio_transaction(jsonb, uuid, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.add_portfolio_transaction(p_transaction jsonb)
RETURNS public.portfolio_transactions
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT public.save_portfolio_transaction(p_transaction) $$;

REVOKE ALL ON FUNCTION public.add_portfolio_transaction(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_portfolio_transaction(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.duplicate_portfolio_transaction(p_id uuid, p_expected_revision bigint)
RETURNS public.portfolio_transactions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    source public.portfolio_transactions%ROWTYPE;
    saved public.portfolio_transactions%ROWTYPE;
BEGIN
    IF NOT coalesce(public.is_shared_meal_plan_member(), false) THEN
        RAISE EXCEPTION 'HomeFin household membership required';
    END IF;
    SELECT * INTO source FROM public.portfolio_transactions WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR p_expected_revision IS NULL OR source.revision <> p_expected_revision THEN
        RAISE EXCEPTION 'Transaction changed or was deleted; reload the portfolio';
    END IF;
    INSERT INTO public.portfolio_transactions (
        portfolio_item_id, transaction_date, action, platform, type, ticker, name,
        quantity, price_per_unit, exchange_rate, commission, fees, currency,
        total_cost, local_value, local_currency
    ) VALUES (
        source.portfolio_item_id, source.transaction_date, source.action, source.platform,
        source.type, source.ticker, source.name, source.quantity, source.price_per_unit,
        source.exchange_rate, source.commission, source.fees, source.currency,
        source.total_cost, source.local_value, source.local_currency
    ) RETURNING * INTO saved;
    RETURN saved;
END;
$$;
REVOKE ALL ON FUNCTION public.duplicate_portfolio_transaction(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.duplicate_portfolio_transaction(uuid, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_portfolio_transaction(p_id uuid, p_expected_revision bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF NOT coalesce(public.is_shared_meal_plan_member(), false) THEN
        RAISE EXCEPTION 'HomeFin household membership required';
    END IF;
    DELETE FROM public.portfolio_transactions WHERE id = p_id AND revision = p_expected_revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transaction changed or was deleted; reload the portfolio'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_portfolio_transaction(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_portfolio_transaction(uuid, bigint) TO authenticated;

COMMIT;
