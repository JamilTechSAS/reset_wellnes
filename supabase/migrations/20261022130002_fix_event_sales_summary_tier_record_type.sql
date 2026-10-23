DO $migration$
DECLARE
    v_definition text;
    v_old text := 'v_tier record;';
    v_new text := 'v_tier public.pricing_tiers;';
    v_expected text := 'case when v_tier_id is null then null else jsonb_build_object(';
BEGIN
    SELECT pg_get_functiondef(
        'app_private.event_sales_summary(public.events,timestamptz)'::regprocedure
    )
    INTO v_definition;

    IF position(v_old IN v_definition) = 0 THEN
        RAISE EXCEPTION 'No se encontró la declaración esperada de v_tier';
    END IF;

    IF position(v_expected IN v_definition) = 0 THEN
        RAISE EXCEPTION 'No se encontró la corrección anterior de v_tier_id';
    END IF;

    v_definition := replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
END;
$migration$;