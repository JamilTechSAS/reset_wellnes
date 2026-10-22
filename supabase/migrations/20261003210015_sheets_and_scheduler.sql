-- ---------------------------------------------------------------------------
-- Migration 20261003210015_sheets_and_scheduler
-- Phase 5 / part 4: the operational Google Sheets projection (outbox-style) and the
-- scheduled maintenance invocation.
--
-- SHEETS PROJECTION
--   * Supabase is the source of truth; the sheet is a read-oriented projection. Nothing
--     in this schema gives Google a write path back: the only Google-facing code reads
--     `operational_export` and calls the Sheets API. Sheet edits are overwritten by the
--     next successful sync.
--   * `sheets_projections` is a per-ticket outbox row (PRIMARY KEY ticket_id), so any
--     number of changes to the same ticket collapses into ONE logical projection event.
--     Triggers on tickets/participants/attendance/consents enqueue automatically: no
--     caller can forget, and adding a new write path cannot skip the projection.
--   * A Sheets or Google outage CANNOT affect payments, ticket issuance or check-in:
--     enqueueing is a plain insert in the local transaction; the actual HTTP call happens
--     only in the maintenance worker, after all payment work is committed, and errors are
--     recorded on the queue row with backoff. Rows survive until a sync succeeds.
--   * `attempt_count` is reset only when NEW work arrives; the worker's retry ceiling
--     stops a permanently failing sheet from being hammered.
--
-- SCHEDULER
--   * Verified against Supabase docs on 2026-10-03: the hosted platform supports
--     `pg_cron` + `pg_net`, and the documented pattern is a cron job that calls an Edge
--     Function over HTTP with secrets read from Supabase Vault.
--   * The migration only schedules the job when both extensions exist; otherwise it says
--     so and the documented fallback is any HTTP caller that holds
--     MAINTENANCE_API_TOKEN (docs/environments.md).
--   * The token itself is NOT in this file: operators must store it in Vault once
--     (`vault.create_secret`), so no secret ever lives in the repository or in migration
--     history. If the secrets are missing the job logs a warning instead of hammering the
--     endpoint.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Projection queue
-- ---------------------------------------------------------------------------
create type public.sheets_projection_status as enum ('QUEUED', 'SYNCING', 'SYNCED', 'FAILED');

comment on type public.sheets_projection_status is
  'Lifecycle of one ticket''s Google Sheets projection: QUEUED (dirty), SYNCING (claimed by a worker), SYNCED (last successful write included this state), FAILED (last attempt failed; retried with backoff).';

create table public.sheets_projections (
  ticket_id uuid primary key references public.tickets (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete restrict,
  status public.sheets_projection_status not null default 'QUEUED',
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  -- Bounded, non-personal error text from the Google client (never a response body).
  last_error text
    check (last_error is null or length(last_error) <= 500),
  last_synced_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sheets_projections is
  'Outbox of pending Google Sheets projections: one row per ticket (unique), enqueued by triggers on every projection-relevant change. Read-only projection: the sheet can never write back. Failure here cannot block payments, ticket issuance or check-in.';

create index sheets_projections_due_idx
  on public.sheets_projections (next_attempt_at)
  where status in ('QUEUED', 'FAILED');

create trigger sheets_projections_set_updated_at
  before update on public.sheets_projections
  for each row execute function app_private.set_updated_at();

alter table public.sheets_projections enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Enqueue helpers and triggers
-- ---------------------------------------------------------------------------
create or replace function app_private.enqueue_sheet_projection(
  p_ticket_id uuid,
  p_event_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $enqueue$
begin
  -- One row per ticket: every additional change collapses into the same logical event.
  -- A row a worker is currently writing (SYNCING) is put back to QUEUED on purpose: the
  -- writer's optimistic finish only updates rows still in SYNCING, so the newer state is
  -- projected on the next run instead of being masked.
  insert into public.sheets_projections as sp (ticket_id, event_id, status)
  values (p_ticket_id, p_event_id, 'QUEUED')
  on conflict (ticket_id) do update
    set event_id = excluded.event_id,
        status = 'QUEUED',
        attempt_count = 0,
        last_error = null,
        next_attempt_at = now(),
        updated_at = now();
end;
$enqueue$;

comment on function app_private.enqueue_sheet_projection(uuid, uuid) is
  'Enqueues (or re-queues) the projection of one ticket. Idempotent: concurrent enqueues for the same ticket leave exactly one queue row.';

create or replace function app_private.sheets_enqueue_ticket()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $trgticket$
begin
  perform app_private.enqueue_sheet_projection(new.id, new.event_id);
  return null;
end;
$trgticket$;

create trigger tickets_enqueue_sheet_projection
  after insert or update on public.tickets
  for each row execute function app_private.sheets_enqueue_ticket();

create or replace function app_private.sheets_enqueue_participant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $trgparticipant$
declare
  v_ticket record;
begin
  -- A participant may exist before any ticket points at it (the checkout creates one
  -- participant immediately). When the ticket assignment happens, the tickets trigger
  -- enqueues; here only already-attached tickets are re-queued.
  for v_ticket in
    select t.id, t.event_id from public.tickets t where t.participant_id = new.id
  loop
    perform app_private.enqueue_sheet_projection(v_ticket.id, v_ticket.event_id);
  end loop;
  return null;
end;
$trgparticipant$;

create trigger participants_enqueue_sheet_projection
  after insert or update on public.participants
  for each row execute function app_private.sheets_enqueue_participant();

create or replace function app_private.sheets_enqueue_attendance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $trgattendance$
begin
  perform app_private.enqueue_sheet_projection(new.ticket_id, new.event_id);
  return null;
end;
$trgattendance$;

create trigger attendance_enqueue_sheet_projection
  after insert on public.attendance
  for each row execute function app_private.sheets_enqueue_attendance();

create or replace function app_private.sheets_enqueue_consent()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $trgconsent$
declare
  v_ticket record;
begin
  for v_ticket in
    select t.id, t.event_id
      from public.tickets t
     where t.participant_id = new.participant_id
  loop
    perform app_private.enqueue_sheet_projection(v_ticket.id, v_ticket.event_id);
  end loop;
  return null;
end;
$trgconsent$;

create trigger consents_enqueue_sheet_projection
  after insert on public.consents
  for each row execute function app_private.sheets_enqueue_consent();

-- ---------------------------------------------------------------------------
-- 3. Claim / finish / stats
-- ---------------------------------------------------------------------------
create or replace function public.claim_sheet_projections(
  p_limit integer default 50,
  p_now timestamptz default now(),
  p_stale_after_seconds integer default 900,
  p_max_attempts integer default 6
)
returns setof public.sheets_projections
language plpgsql
security invoker
set search_path = ''
as $claimsheets$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Sheets claim limit must be between 1 and 200'
      using errcode = 'PT400', detail = 'INVALID_LIMIT';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Sheets max attempts must be between 1 and 20'
      using errcode = 'PT400', detail = 'INVALID_MAX_ATTEMPTS';
  end if;

  return query
  with candidate as (
    select sp.ticket_id
      from public.sheets_projections sp
     where sp.attempt_count < p_max_attempts
       and (
         (sp.status in ('QUEUED', 'FAILED')
          and coalesce(sp.next_attempt_at, sp.created_at) <= p_now)
         or (sp.status = 'SYNCING'
             and sp.updated_at
                 <= p_now - make_interval(secs => greatest(p_stale_after_seconds, 60)))
       )
     order by coalesce(sp.next_attempt_at, sp.created_at)
     limit p_limit
     for update skip locked
  )
  update public.sheets_projections sp
     set status = 'SYNCING',
         attempt_count = sp.attempt_count + 1,
         next_attempt_at = null
    from candidate c
   where sp.ticket_id = c.ticket_id
  returning sp.*;
end;
$claimsheets$;

comment on function public.claim_sheet_projections(integer, timestamptz, integer, integer) is
  'Claims up to p_limit due projection rows (SKIP LOCKED, stale SYNCING rows reclaimable) and increments their attempt counter. Concurrent workers split the work; a permanently failing projection stops after p_max_attempts until new data arrives.';

create or replace function public.finish_sheet_projections(
  p_ticket_ids uuid[],
  p_status public.sheets_projection_status,
  p_error text default null,
  p_next_attempt_at timestamptz default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $finishsheets$
declare
  v_updated integer := 0;
begin
  if p_status not in ('SYNCED'::public.sheets_projection_status,
                      'FAILED'::public.sheets_projection_status) then
    raise exception 'A finished projection must be SYNCED or FAILED'
      using errcode = 'PT400', detail = 'INVALID_PROJECTION_STATUS';
  end if;

  -- Optimistic guard: rows re-queued while the worker was writing (status changed back to
  -- QUEUED) are NOT marked done, so the newer state is projected on the next run.
  update public.sheets_projections
     set status = p_status,
         last_error = case when p_status = 'FAILED'
                           then nullif(left(btrim(coalesce(p_error, '')), 500), '')
                           else null end,
         last_synced_at = case when p_status = 'SYNCED' then p_now else last_synced_at end,
         next_attempt_at = case when p_status = 'FAILED' then p_next_attempt_at else null end
   where ticket_id = any(p_ticket_ids)
     and status = 'SYNCING';
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'ticketCount', coalesce(array_length(p_ticket_ids, 1), 0),
    'updatedCount', v_updated,
    'status', p_status
  );
end;
$finishsheets$;

comment on function public.finish_sheet_projections(uuid[], public.sheets_projection_status, text, timestamptz, timestamptz) is
  'Records the outcome of a sync for the claimed tickets. Only rows still SYNCING are updated, so a change that arrived mid-write stays queued for the next run.';

create or replace function public.sheet_projection_stats()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $sheetstats$
declare
  v_row record;
begin
  select count(*) filter (where sp.status = 'QUEUED')::integer as queued,
         count(*) filter (where sp.status = 'SYNCING')::integer as syncing,
         count(*) filter (where sp.status = 'SYNCED')::integer as synced,
         count(*) filter (where sp.status = 'FAILED')::integer as failed,
         count(*)::integer as total,
         max(sp.last_synced_at) as last_synced_at,
         min(sp.created_at) filter (where sp.status in ('QUEUED', 'FAILED', 'SYNCING')) as oldest_pending_at
    into v_row
    from public.sheets_projections sp;

  return jsonb_build_object(
    'queued', coalesce(v_row.queued, 0),
    'syncing', coalesce(v_row.syncing, 0),
    'synced', coalesce(v_row.synced, 0),
    'failed', coalesce(v_row.failed, 0),
    'total', coalesce(v_row.total, 0),
    'lastSyncedAt', app_private.iso_utc(v_row.last_synced_at),
    'oldestPendingAt', app_private.iso_utc(v_row.oldest_pending_at)
  );
end;
$sheetstats$;

comment on function public.sheet_projection_stats() is
  'Counts per projection status plus the last successful sync instant, used by the worker to decide on a periodic full refresh and by the status sheet.';

-- ---------------------------------------------------------------------------
-- 4. Scheduler: invoke the maintenance Edge Function through pg_net
-- ---------------------------------------------------------------------------
-- The function is SECURITY INVOKER and owned by the role that runs the migration
-- (postgres). It reads two Vault secrets by NAME and never stores a credential:
--   project_url            -> https://<project-ref>.supabase.co
--   maintenance_api_token  -> the same MAINTENANCE_API_TOKEN the endpoint expects
--
-- Operators create them once (docs/environments.md):
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<maintenance token>',    'maintenance_api_token');
create or replace function app_private.invoke_scheduled_maintenance()
returns bigint
language plpgsql
security invoker
set search_path = ''
as $sched$
declare
  v_project_url text;
  v_token text;
  v_request_id bigint;
begin
  select s.decrypted_secret into v_project_url
    from vault.decrypted_secrets s
   where s.name = 'project_url';
  select s.decrypted_secret into v_token
    from vault.decrypted_secrets s
   where s.name = 'maintenance_api_token';

  if v_project_url is null or v_token is null then
    raise warning
      'Scheduled maintenance skipped: Vault secrets project_url / maintenance_api_token are not both set';
    return null;
  end if;

  select net.http_post(
           url := rtrim(v_project_url, '/') || '/functions/v1/orders-maintenance',
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'Authorization', 'Bearer ' || v_token
           ),
           body := jsonb_build_object('trigger', 'scheduler'),
           timeout_milliseconds := 10000
         )
    into v_request_id;

  return v_request_id;
end;
$sched$;

comment on function app_private.invoke_scheduled_maintenance() is
  'Cron entry point: POSTs the maintenance endpoint with the token read from Vault. Missing secrets log a warning instead of failing the schedule; the token is never stored in SQL or in the repository.';

-- Extensions are attempted but never required: a project without them keeps the
-- documented HTTP fallback. Every failure is swallowed with a notice, because a migration
-- must stay applicable on a plain PostgreSQL (tests, CI container).
do $extensions$
begin
  begin
    execute 'create extension if not exists pg_cron';
  exception when others then
    raise notice 'pg_cron is not available in this database: %', sqlerrm;
  end;
  begin
    execute 'create extension if not exists pg_net';
  exception when others then
    raise notice 'pg_net is not available in this database: %', sqlerrm;
  end;
end;
$extensions$;

-- Schedule every 5 minutes when both extensions exist. The job name is stable, and an
-- existing job is replaced so a re-applied migration converges instead of duplicating.
do $schedule$
declare
  v_job record;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    begin
      for v_job in select j.jobid from cron.job j where j.jobname = 'event-ticketing-maintenance'
      loop
        perform cron.unschedule(v_job.jobid);
      end loop;
    exception when others then
      raise notice 'could not query cron.job: %', sqlerrm;
    end;

    begin
      perform cron.schedule(
        'event-ticketing-maintenance',
        '*/5 * * * *',
        'select app_private.invoke_scheduled_maintenance();'
      );
      raise notice 'Scheduled event-ticketing-maintenance every 5 minutes (pg_cron)';
    exception when others then
      raise notice 'pg_cron is present but the maintenance job could not be scheduled: %', sqlerrm;
    end;
  else
    raise notice
      'pg_cron/pg_net unavailable: schedule a POST to /orders-maintenance with MAINTENANCE_API_TOKEN (docs/environments.md)';
  end if;
end;
$schedule$;

-- ---------------------------------------------------------------------------
-- 5. Grants: service_role only, scheduler function deliberately ungranted
-- ---------------------------------------------------------------------------
revoke all on function app_private.enqueue_sheet_projection(uuid, uuid) from public;
revoke all on function app_private.sheets_enqueue_ticket() from public;
revoke all on function app_private.sheets_enqueue_participant() from public;
revoke all on function app_private.sheets_enqueue_attendance() from public;
revoke all on function app_private.sheets_enqueue_consent() from public;
revoke all on function app_private.invoke_scheduled_maintenance() from public;
revoke all on function public.claim_sheet_projections(integer, timestamptz, integer, integer) from public;
revoke all on function public.finish_sheet_projections(uuid[], public.sheets_projection_status, text, timestamptz, timestamptz) from public;
revoke all on function public.sheet_projection_stats() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_sheet_projections(integer, timestamptz, integer, integer) to service_role';
    execute 'grant execute on function public.finish_sheet_projections(uuid[], public.sheets_projection_status, text, timestamptz, timestamptz) to service_role';
    execute 'grant execute on function public.sheet_projection_stats() to service_role';
  end if;
end
$$;
