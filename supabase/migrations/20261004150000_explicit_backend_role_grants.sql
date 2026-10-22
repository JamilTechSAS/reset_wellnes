-- ---------------------------------------------------------------------------
-- Migration 20261004150000_explicit_backend_role_grants
-- Pre-frontend closure fix, CRITICAL: the backend must not depend on the
-- platform's automatic grants for `service_role`.
--
-- Every SQL function is SECURITY INVOKER, so it needs the *caller*
-- (`service_role`, the secret key used by the Edge Functions) to hold the table
-- privileges the function touches. Until now the project relied on Supabase's
-- default privileges to give `service_role` those privileges and only revoked
-- the ones `anon`/`authenticated` must never have.
--
-- Reproduced on the real Supabase stack (PostgreSQL 17.11, PostgREST 16.4) with
-- `auto_expose_new_tables = false` — the "explicit grants only" mode that
-- Supabase documents as the direction of the platform default
-- ("Supabase is changing the platform default to revoke these automatic grants",
-- docs: Securing your API -> Default privileges):
--
--     service_role: SELECT on public.orders   -> 403  42501 permission denied
--     rpc/get_public_event                    -> 403  42501 permission denied for table events
--     information_schema.role_table_grants    -> 61 rows for service_role (vs 140 with defaults)
--
-- Without this migration, adopting the strict platform default (or the
-- documented "Revoke default privileges" procedure) takes the whole backend
-- down: every gateway call is a 403. It is the same class of defect as the
-- audit's AUD-06 (implicit privilege assumptions that only fail at runtime).
--
-- What this migration does, for `service_role` only:
--   1. grants the domain DML privileges the invoker functions actually use
--      (select/insert/update/delete) on every table in `public`, and
--      usage/select on every sequence;
--   2. re-establishes those grants as defaults for future objects, so a later
--      migration cannot silently reintroduce the same dependency.
--
-- `anon` and `authenticated` receive nothing: their privileges stay revoked
-- (migrations 20261003210007, 20261004130000) and the strict defaults keep them
-- that way. `service_role` is the single trusted server role (BYPASSRLS) and
-- remains unreachable from a browser, so broad DML for it is the intended model
-- — the fine-grained control lives in the functions, not in per-table grants.
-- Re-running is idempotent.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on all tables in schema public to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
    execute 'alter default privileges in schema public grant select, insert, update, delete on tables to service_role';
    execute 'alter default privileges in schema public grant usage, select on sequences to service_role';
  end if;
end
$$;
