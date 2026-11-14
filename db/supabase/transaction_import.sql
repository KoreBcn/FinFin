ALTER TABLE public.transactions
    ADD COLUMN IF NOT EXISTS source_system text,
    ADD COLUMN IF NOT EXISTS source_entry_reference text,
    ADD COLUMN IF NOT EXISTS inserted_at timestamptz;

ALTER TABLE public.transactions
    ALTER COLUMN inserted_at SET DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS transactions_source_identity_idx
    ON public.transactions (source_system, source_entry_reference);

CREATE TABLE IF NOT EXISTS public.transaction_import_stage (
    run_id uuid NOT NULL,
    source_system text NOT NULL,
    source_entry_reference text NOT NULL,
    id uuid NOT NULL,
    expense text NOT NULL,
    category text NOT NULL,
    transaction_status text NOT NULL,
    transaction_date date NOT NULL,
    amount numeric(14, 4) NOT NULL,
    comments text,
    account text NOT NULL,
    is_excluded boolean NOT NULL DEFAULT false,
    PRIMARY KEY (run_id, source_system, source_entry_reference)
);

ALTER TABLE public.transaction_import_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transaction_import_stage FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.transaction_import_stage TO service_role;

CREATE TABLE IF NOT EXISTS public.transaction_import_state (
    source_system text PRIMARY KEY,
    initial_start_date date NOT NULL,
    last_successful_date date NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.transaction_import_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transaction_import_state FROM anon, authenticated;
GRANT SELECT ON public.transaction_import_state TO service_role;

INSERT INTO public.transaction_import_state (
    source_system,
    initial_start_date,
    last_successful_date
)
VALUES (
    'enablebanking',
    date_trunc('month', current_date)::date,
    date_trunc('month', current_date)::date - 1
)
ON CONFLICT (source_system) DO NOTHING;

CREATE OR REPLACE FUNCTION public.import_enablebanking_transactions(
    p_run_id uuid,
    p_through_date date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    inserted_count integer;
BEGIN
    PERFORM 1
    FROM public.transaction_import_state
    WHERE source_system = 'enablebanking'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Enable Banking import state is not initialized';
    END IF;

    INSERT INTO public.transactions (
        id,
        expense,
        category,
        transaction_status,
        transaction_date,
        amount,
        comments,
        account,
        is_excluded,
        source_system,
        source_entry_reference
    )
    SELECT
        stage.id,
        stage.expense,
        stage.category,
        stage.transaction_status,
        stage.transaction_date,
        stage.amount,
        stage.comments,
        stage.account,
        stage.is_excluded,
        stage.source_system,
        stage.source_entry_reference
    FROM public.transaction_import_stage AS stage
    WHERE stage.run_id = p_run_id
      AND stage.source_system = 'enablebanking'
      AND NOT EXISTS (
          SELECT 1
          FROM public.transactions AS target
          WHERE target.source_system = stage.source_system
            AND target.source_entry_reference = stage.source_entry_reference
      )
    ON CONFLICT (source_system, source_entry_reference) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;

    UPDATE public.transaction_import_state
    SET last_successful_date = GREATEST(last_successful_date, p_through_date),
        updated_at = now()
    WHERE source_system = 'enablebanking';

    DELETE FROM public.transaction_import_stage
    WHERE run_id = p_run_id;

    RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.import_enablebanking_transactions(uuid, date)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_enablebanking_transactions(uuid, date)
    TO service_role;
