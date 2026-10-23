-- ---------------------------------------------------------------------------
-- Migration 20261023150000_operational_alerts
-- H8: operational alerts for payments that need a human.
--
-- The payment paths already DETECT these situations (RECONCILIATION_REQUIRED, MISMATCH,
-- NOT_FOUND_AT_PROVIDER, an exhausted reconciliation budget, a reversal after approval), but
-- they only reached logs. This adds a small alert ledger:
--
--   * public.operational_alerts — one row per (kind, subject): webhook redeliveries and
--     repeated sweeps increment `occurrences` instead of creating new alerts;
--   * record_operational_alert       — idempotent upsert used by the Edge Functions;
--   * raise_unresolved_payment_alerts — finds attempts whose reconciliation budget is spent;
--   * claim_alert_notifications / finish_alert_notifications — the maintenance digest claims
--     unsent alerts with SKIP LOCKED, bounded attempts and backoff, so a failing mail provider
--     cannot flood or loop.
--
-- Nothing here stores payloads, buyer names, emails or documents: only a closed alert kind,
-- the order reference, the payment id, the provider and a short code-like detail.
-- Same posture as every other table: RLS on, no policies, service_role only.
-- ---------------------------------------------------------------------------

create table public.operational_alerts (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique
    check (dedupe_key ~ '^[!-~]{8,200}$'),
  kind text not null
    check (kind in (
      'PAYMENT_REVERSED_AFTER_APPROVAL',
      'LATE_APPROVAL',
      'PROVIDER_RECORD_MISMATCH',
      'RECONCILIATION_MISMATCH',
      'PROVIDER_NOT_FOUND',
      'REPEATED_PROVIDER_FAILURE',
      'UNRESOLVED_PAYMENT'
    )),
  severity text not null
    check (severity in ('critical', 'warning')),
  order_reference text
    check (order_reference is null or order_reference ~ '^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]{1,3})?$'),
  payment_id uuid references public.payments (id) on delete set null,
  provider text
    check (provider is null or provider in ('wompi', 'epayco')),
  detail text
    check (detail is null or (length(detail) <= 200 and detail ~ '^[A-Za-z0-9_:,. -]*$')),
  occurrences integer not null default 1
    check (occurrences >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  notified_at timestamptz,
  notify_attempts integer not null default 0
    check (notify_attempts >= 0),
  next_notify_at timestamptz not null default now()
);

comment on table public.operational_alerts is
  'Deduplicated operational alerts for payments needing manual review (H8). Contains no payloads or personal data: alert kind, order reference, payment id, provider and a short code-like detail.';

create index operational_alerts_unsent_idx
  on public.operational_alerts (next_notify_at)
  where notified_at is null;

alter table public.operational_alerts enable row level security;
revoke all on table public.operational_alerts from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.operational_alerts from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.operational_alerts from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.operational_alerts to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- record_operational_alert — idempotent per dedupe key
-- ---------------------------------------------------------------------------
create or replace function public.record_operational_alert(
  p_dedupe_key text,
  p_kind text,
  p_severity text,
  p_order_reference text default null,
  p_payment_id uuid default null,
  p_provider text default null,
  p_detail text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $alert$
declare
  v_alert public.operational_alerts;
  v_created boolean;
begin
  insert into public.operational_alerts (
    dedupe_key, kind, severity, order_reference, payment_id, provider, detail,
    first_seen_at, last_seen_at, next_notify_at
  )
  values (
    p_dedupe_key, p_kind, p_severity, nullif(btrim(coalesce(p_order_reference, '')), ''),
    p_payment_id, nullif(lower(btrim(coalesce(p_provider, ''))), ''),
    nullif(btrim(coalesce(p_detail, '')), ''), p_now, p_now, p_now
  )
  on conflict (dedupe_key) do update
     set occurrences = public.operational_alerts.occurrences + 1,
         last_seen_at = excluded.last_seen_at
  returning * into v_alert;

  v_created := v_alert.occurrences = 1;

  return jsonb_build_object(
    'alertId', v_alert.id,
    'created', v_created,
    'occurrences', v_alert.occurrences
  );
end;
$alert$;

comment on function public.record_operational_alert(text, text, text, text, uuid, text, text, timestamptz) is
  'Records an operational alert once per dedupe key; a repeat only increments occurrences and last_seen_at, so redeliveries and repeated sweeps never create duplicate alerts.';

-- ---------------------------------------------------------------------------
-- raise_unresolved_payment_alerts — reconciliation budget spent, still unresolved
-- ---------------------------------------------------------------------------
create or replace function public.raise_unresolved_payment_alerts(
  p_max_attempts integer default 8,
  p_now timestamptz default now()
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $unresolved$
declare
  v_inserted integer := 0;
begin
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Reconciliation max attempts must be between 1 and 20'
      using errcode = 'PT400', detail = 'INVALID_MAX_ATTEMPTS';
  end if;

  insert into public.operational_alerts (
    dedupe_key, kind, severity, order_reference, payment_id, provider, detail,
    first_seen_at, last_seen_at, next_notify_at
  )
  select 'unresolved:' || p.id::text,
         'UNRESOLVED_PAYMENT',
         'warning',
         o.reference,
         p.id,
         p.payment_provider,
         'status ' || p.status::text || ', attempts ' || p.reconciliation_attempts::text,
         p_now, p_now, p_now
    from public.payments p
    join public.orders o on o.id = p.order_id
   where p.status in ('pending'::public.payment_status, 'unknown'::public.payment_status)
     and coalesce(p.provider_transaction_id, p.wompi_transaction_id) is not null
     and p.reconciliation_attempts >= p_max_attempts
     and o.status in ('PENDING', 'FAILED', 'EXPIRED', 'CANCELLED')
  on conflict (dedupe_key) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$unresolved$;

comment on function public.raise_unresolved_payment_alerts(integer, timestamptz) is
  'Raises one UNRESOLVED_PAYMENT alert per payment attempt that is still pending/unknown after its reconciliation budget is spent. Idempotent: an attempt is alerted once.';

-- ---------------------------------------------------------------------------
-- claim_alert_notifications / finish_alert_notifications — bounded digest delivery
-- ---------------------------------------------------------------------------
create or replace function public.claim_alert_notifications(
  p_limit integer default 20,
  p_max_attempts integer default 5,
  p_now timestamptz default now()
)
returns setof jsonb
language plpgsql
security invoker
set search_path = ''
as $claimalerts$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Alert batch limit must be between 1 and 100'
      using errcode = 'PT400', detail = 'INVALID_LIMIT';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Alert max attempts must be between 1 and 20'
      using errcode = 'PT400', detail = 'INVALID_MAX_ATTEMPTS';
  end if;

  return query
  with candidate as (
    select a.id
      from public.operational_alerts a
     where a.notified_at is null
       and a.next_notify_at <= p_now
       and a.notify_attempts < p_max_attempts
     order by a.severity = 'critical' desc, a.first_seen_at
     limit p_limit
     for update skip locked
  ),
  claimed as (
    update public.operational_alerts a
       set notify_attempts = a.notify_attempts + 1,
           -- Backoff before the next try if this delivery does not succeed: 5, 10, 20... min.
           next_notify_at = p_now + make_interval(mins => 5 * power(2, a.notify_attempts)::integer)
      from candidate c
     where a.id = c.id
    returning a.*
  )
  select jsonb_build_object(
           'alertId', c.id,
           'kind', c.kind,
           'severity', c.severity,
           'orderReference', c.order_reference,
           'paymentId', c.payment_id,
           'provider', c.provider,
           'detail', c.detail,
           'occurrences', c.occurrences,
           'firstSeenAt', c.first_seen_at,
           'lastSeenAt', c.last_seen_at
         )
    from claimed c
   order by c.severity = 'critical' desc, c.first_seen_at;
end;
$claimalerts$;

comment on function public.claim_alert_notifications(integer, integer, timestamptz) is
  'Claims up to p_limit unsent alerts for one notification digest. SKIP LOCKED splits concurrent runs; each claim consumes an attempt and schedules a backoff, so a failing mail provider is retried a bounded number of times.';

create or replace function public.finish_alert_notifications(
  p_alert_ids uuid[],
  p_now timestamptz default now()
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $finishalerts$
declare
  v_updated integer := 0;
begin
  update public.operational_alerts
     set notified_at = p_now
   where id = any(coalesce(p_alert_ids, array[]::uuid[]))
     and notified_at is null;
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$finishalerts$;

comment on function public.finish_alert_notifications(uuid[], timestamptz) is
  'Marks claimed alerts as notified after the digest was sent. Alerts already notified are left untouched.';

-- ---------------------------------------------------------------------------
-- Grants: service_role only
-- ---------------------------------------------------------------------------
revoke all on function public.record_operational_alert(text, text, text, text, uuid, text, text, timestamptz) from public;
revoke all on function public.raise_unresolved_payment_alerts(integer, timestamptz) from public;
revoke all on function public.claim_alert_notifications(integer, integer, timestamptz) from public;
revoke all on function public.finish_alert_notifications(uuid[], timestamptz) from public;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.record_operational_alert(text, text, text, text, uuid, text, text, timestamptz) from %I', v_role);
      execute format('revoke all on function public.raise_unresolved_payment_alerts(integer, timestamptz) from %I', v_role);
      execute format('revoke all on function public.claim_alert_notifications(integer, integer, timestamptz) from %I', v_role);
      execute format('revoke all on function public.finish_alert_notifications(uuid[], timestamptz) from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.record_operational_alert(text, text, text, text, uuid, text, text, timestamptz) to service_role';
    execute 'grant execute on function public.raise_unresolved_payment_alerts(integer, timestamptz) to service_role';
    execute 'grant execute on function public.claim_alert_notifications(integer, integer, timestamptz) to service_role';
    execute 'grant execute on function public.finish_alert_notifications(uuid[], timestamptz) to service_role';
  end if;
end
$$;
