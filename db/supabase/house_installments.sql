BEGIN;

CREATE TABLE IF NOT EXISTS public.house_installments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_date date NOT NULL,
    amount numeric(14, 2) NOT NULL CHECK (amount <> 0),
    concept text NOT NULL,
    entry_type text NOT NULL DEFAULT 'regular'
        CHECK (entry_type IN ('regular', 'mortgage_component', 'initial_payment')),
    inserted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.house_installments ADD COLUMN IF NOT EXISTS concept text;
UPDATE public.house_installments
SET concept = CASE WHEN amount > 0 THEN 'Bank installment' ELSE 'Interest / Adjustment' END
WHERE concept IS NULL;
ALTER TABLE public.house_installments ALTER COLUMN concept SET NOT NULL;
ALTER TABLE public.house_installments
    ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'regular'
    CHECK (entry_type IN ('regular', 'mortgage_component', 'initial_payment'));

CREATE INDEX IF NOT EXISTS house_installments_entry_date_idx
    ON public.house_installments (entry_date, id);

ALTER TABLE public.house_installments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.house_installments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.house_installments TO authenticated;

DROP POLICY IF EXISTS house_installments_authenticated_access ON public.house_installments;
CREATE POLICY house_installments_authenticated_access
    ON public.house_installments
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.house_config (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    installment_concept text NOT NULL CHECK (length(btrim(installment_concept)) > 0),
    interest_concept text NOT NULL CHECK (length(btrim(interest_concept)) > 0),
    CHECK (position(lower(btrim(interest_concept)) in lower(btrim(installment_concept))) = 0)
);

ALTER TABLE public.house_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.house_config FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.house_config TO authenticated;

DROP POLICY IF EXISTS house_config_authenticated_read ON public.house_config;
CREATE POLICY house_config_authenticated_read
    ON public.house_config
    FOR SELECT
    TO authenticated
    USING (true);

COMMIT;
