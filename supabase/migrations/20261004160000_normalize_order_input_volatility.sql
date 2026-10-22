-- ---------------------------------------------------------------------------
-- Migration 20261004160000_normalize_order_input_volatility
-- Pre-frontend closure fix (quality, not security): `supabase db lint` — run for
-- the first time on the local Supabase stack during this closure — reports
-- app_private.normalize_order_input as marked IMMUTABLE while its body calls a
-- STABLE built-in (`jsonb_build_object`; PostgreSQL catalogs mark the jsonb
-- builders STABLE because they invoke type output functions).
--
-- The honest, provable marker is STABLE: the function is a pure transformation
-- of its input and never touches the database, but it cannot claim more than the
-- functions it calls. No behaviour change: its only caller (public.create_order)
-- passes a variable, never a constant, so the planner has never folded the call,
-- and no index expression or CHECK relies on the IMMUTABLE claim.
--
-- Kept as a new migration because history is append-only
-- (docs/data-model.md §10); re-running is idempotent.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'normalize_order_input'
  ) then
    execute 'alter function app_private.normalize_order_input(jsonb) stable';
  end if;
end
$$;
