DO $migration$
DECLARE
    v_definition text;
    v_old text := 'case when v_tier is null then null else jsonb_build_object(';
    v_new text := 'case when v_tier_id is null then null else jsonb_build_object(';
BEGIN
    SELECT pg_get_functiondef(
        'app_private.event_sales_summary(public.events,timestamptz)'::regprocedure
    )
    INTO v_definition;

    IF position(v_old IN v_definition) = 0 THEN
        RAISE EXCEPTION 'No se encontró el fragmento esperado; no se aplicaron cambios';
    END IF;

    v_definition := replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
END;
$migration$;