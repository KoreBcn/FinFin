BEGIN;

DO $$
DECLARE
    table_name text;
BEGIN
    IF to_regprocedure('public.is_shared_meal_plan_member()') IS NULL THEN
        RAISE EXCEPTION 'Set up Meal Plan household membership before restricting HomeFin access';
    END IF;

    FOREACH table_name IN ARRAY ARRAY[
        'transactions', 'category_rules', 'house_installments', 'house_config',
        'portfolio_items', 'portfolio_transactions'
    ]
    LOOP
        IF to_regclass(format('public.%I', table_name)) IS NULL THEN
            RAISE EXCEPTION 'Missing HomeFin table public.%', table_name;
        END IF;
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('DROP POLICY IF EXISTS homefin_household_restriction ON public.%I', table_name);
        EXECUTE format(
            'CREATE POLICY homefin_household_restriction ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING (coalesce(public.is_shared_meal_plan_member(), false)) WITH CHECK (coalesce(public.is_shared_meal_plan_member(), false))',
            table_name
        );
    END LOOP;
END $$;

COMMIT;
