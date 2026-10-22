-- ---------------------------------------------------------------------------
-- Migration 20261003202241_init
-- Phase 1 baseline infrastructure.
--
-- Conventions established here (details in docs/data-model.md):
--   * `public`          - domain tables and views only. Everything in `public` is
--                         reachable through the PostgREST API, so it must be safe.
--   * `app_private`      - helper functions that must never be callable through the API.
--   * `extensions`       - installed Postgres extensions (Supabase convention).
--   * Money             - integer centavos (smallest currency unit), never floating point.
--   * Every table        - uuid primary keys (`gen_random_uuid()`, Postgres 17 core),
--                         `created_at timestamptz not null default now()`, and
--                         `updated_at timestamptz not null default now()` maintained by
--                         the trigger function below.
--   * Every table        - row level security enabled, with no permissive policies
--                         (Phase 2). Only the backend's secret key can read or write;
--                         an accidentally exposed publishable key reads nothing.
-- ---------------------------------------------------------------------------

create schema if not exists extensions;

-- No extension is installed yet, on purpose. Postgres 17 provides `gen_random_uuid()`
-- natively, and every hash/signature this system needs (Wompi integrity signature, event
-- checksum, ticket tokens) is computed in the Edge Function layer, not in SQL. Extensions
-- are added by the migration that actually needs them (`create extension ... with schema
-- extensions`), which keeps the dependency surface auditable.

create schema if not exists app_private;

comment on schema app_private is
  'Internal helper functions. Never exposed through the PostgREST API and never called from frontend code.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function app_private.set_updated_at() is
  'BEFORE UPDATE trigger function that stamps updated_at. Attach to every table that has an updated_at column.';

-- Keep the helper schema unreachable for the public API roles when they exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema app_private from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema app_private from authenticated';
  end if;
end
$$;
