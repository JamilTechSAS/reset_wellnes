-- ---------------------------------------------------------------------------
-- Migration 20261004140000_backend_role_private_schema_access
-- Pre-frontend audit fix, CRITICAL: the backend role could not execute most of
-- the API's SQL functions on a real Supabase-shaped database.
--
-- Every public function is SECURITY INVOKER, so privileges are checked as the
-- calling role — and the Edge Functions call them as `service_role` (the secret
-- key). Fifteen of the twenty-seven public functions call helpers that live in
-- `app_private` (get_public_event, get_public_availability, quote_order_price,
-- create_order, confirm_payment, retry_payment paths, attach_participant,
-- update_participant, record_check_in, get_public_ticket, get_operator_ticket,
-- consume_rate_limit, cleanup_rate_limit_counters, claim_payment_reconciliations,
-- finish_payment_reconciliation, sheet_projection_stats — enumerated from
-- `pg_proc.prosrc` on PostgreSQL 17).
--
-- `app_private` is created by migration 20261003202241 and its USAGE is revoked
-- from `anon`/`authenticated` there; it was never granted to `service_role`, and
-- a freshly created schema gives PUBLIC nothing. Consequence, reproduced on
-- PostgreSQL 17.11 with the platform roles present:
--
--     set role service_role;
--     select public.get_public_event('TAT-2026');
--     ERROR:  permission denied for schema app_private
--     CONTEXT: PL/pgSQL function public.get_public_event(text) line 14 at RETURN
--
-- That is the first request of the product's public flow, so the deployment
-- would have failed immediately. The gap was invisible to the PGlite suites and
-- to `has_function_privilege` checks: those run as the function owner, which
-- holds USAGE and EXECUTE implicitly. It is only visible when the function is
-- actually invoked as `service_role`.
--
-- This migration grants the backend role exactly what it needs and nothing more:
--   1. USAGE on `app_private`, so helper calls inside the functions resolve;
--   2. EXECUTE on the three helpers that are only reached from inside other
--      functions (a SECURITY INVOKER call is checked against `current_user`):
--        public.attach_participant / public.update_participant
--          -> app_private.normalize_participant_payload
--          -> app_private.append_participant_consents
--        app_private.sheets_enqueue_* (AFTER triggers, which run as the caller)
--          -> app_private.enqueue_sheet_projection
--      Trigger functions themselves need no EXECUTE to fire, and the scheduler
--      entry point runs as its pg_cron job owner, so no other grant is added.
--
-- Browser-facing roles get nothing: `anon`/`authenticated` keep no USAGE and no
-- EXECUTE (migration 20261004130000 revokes both). Re-running is idempotent.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema app_private to service_role';
    execute 'grant execute on function app_private.normalize_participant_payload(jsonb) to service_role';
    execute 'grant execute on function app_private.append_participant_consents(uuid, uuid, jsonb, text, timestamptz) to service_role';
    execute 'grant execute on function app_private.enqueue_sheet_projection(uuid, uuid) to service_role';
  end if;
end
$$;
