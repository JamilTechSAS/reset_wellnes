-- ---------------------------------------------------------------------------
-- Migration 20261004130000_revoke_function_execute_from_api_roles
-- Pre-frontend audit hardening: `anon`/`authenticated` must not be able to
-- EXECUTE the backend's SQL functions through the Data API (PostgREST).
--
-- Why this is needed (verified on PostgreSQL 17 with Supabase's default
-- privileges reproduced): Supabase grants EXECUTE on new `public` functions to
-- `anon` and `authenticated` (docs: "Securing your API" -> "Default
-- privileges"), so the per-function `revoke ... from public` used by the
-- migrations does NOT remove them: PUBLIC is a pseudo-role, and a direct grant
-- to `anon`/`authenticated` survives it. Tables were handled correctly in
-- migration 20261003210007 (which revokes each role explicitly and removes
-- their table default privileges); functions and future sequences were not.
--
-- Consequence before this migration: `POST /rest/v1/rpc/<function>` with the
-- publishable key reaches the function body (confirmed: the function's own
-- validation errors are returned). Every function is SECURITY INVOKER and
-- table privileges are already revoked, so execution then fails with 42501
-- "permission denied for table ..." and nothing is read or written. The
-- posture held by a single layer and contradicted the documented invariant
-- "EXECUTE revoked, service_role only" — it would not survive the first
-- deliberate grant (for example a read-only PostgREST surface for the
-- frontend), a SECURITY DEFINER helper, or a platform default change.
--
-- What this migration does:
--   1. revokes every privilege on every existing `public` and `app_private`
--      function from `anon`, `authenticated` and PUBLIC;
--   2. removes the platform's automatic future grants, so new functions in
--      `public` are no longer granted directly to `anon`/`authenticated` and
--      new sequences start unusable by the browser-facing roles.
--
-- Companion migration 20261004140000 grants `service_role` back the access it
-- lost with PUBLIC (the helpers called from inside other functions) and fixes
-- the missing USAGE on `app_private` that broke those calls at runtime.
--
-- Verified limitation, deliberately stated: step 2 does NOT make future
-- functions non-executable. PostgreSQL applies PUBLIC's built-in EXECUTE to
-- every new function, and `alter default privileges ... revoke execute ...
-- from public` does not suppress it (checked on PostgreSQL 17.11: the created
-- function's ACL is still `{=X/postgres,...}`, through both the plain and the
-- `for role postgres` form). There is no platform-level switch for this, so
-- the rule for future migrations is per object:
--
--     revoke all on function public.new_thing(...) from public, anon, authenticated;
--     grant execute on function public.new_thing(...) to service_role;
--
-- `tests/schema/rls.test.ts` ("no EXECUTE on any backend function") scans every
-- function after applying all migrations, so a future migration that forgets
-- the revoke fails `npm run check` instead of shipping.
--
-- The backend role keeps its explicit per-function grants (unchanged), so no
-- runtime path is affected. Trigger functions are unaffected by EXECUTE
-- revokes (verified: the trigger suites still pass). Re-running is idempotent.
-- ---------------------------------------------------------------------------

-- 1. Existing functions: no browser-facing role may execute them.
do $$
declare
  fn record;
  role_name text;
begin
  for fn in
    select quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')' as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app_private')
       and p.prokind = 'f'
  loop
    foreach role_name in array array['anon', 'authenticated']
    loop
      if exists (select 1 from pg_roles where rolname = role_name) then
        execute format('revoke all on function %s from %I', fn.signature, role_name);
      end if;
    end loop;
    execute format('revoke all on function %s from public', fn.signature);
  end loop;
end
$$;

-- 2. Future objects: remove the platform's automatic grants. `public` defaults are keyed by
--    the role that creates the object, so the plain form covers this migration runner and the
--    explicit `for role postgres` form covers the role Supabase configures (the CLI applies
--    migrations as `postgres`).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke execute on functions from anon';
    execute 'alter default privileges in schema public revoke all on sequences from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'alter default privileges in schema public revoke execute on functions from authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from authenticated';
  end if;
  execute 'alter default privileges in schema app_private revoke execute on functions from public';

  if exists (select 1 from pg_roles where rolname = 'postgres')
     and pg_has_role(current_user, 'postgres', 'MEMBER') then
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute 'alter default privileges for role postgres in schema public revoke execute on functions from anon';
      execute 'alter default privileges for role postgres in schema public revoke all on sequences from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'alter default privileges for role postgres in schema public revoke execute on functions from authenticated';
      execute 'alter default privileges for role postgres in schema public revoke all on sequences from authenticated';
    end if;
  end if;
end
$$;

-- Companion: migration 20261004140000 restores `service_role`'s access to the internal
-- helpers it reaches from inside the backend's own functions (revoking PUBLIC removed it).
-- Keeping the restriction and the compensating grants separate makes both auditable on
-- their own.
