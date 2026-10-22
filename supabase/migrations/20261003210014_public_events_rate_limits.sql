-- ---------------------------------------------------------------------------
-- Migration 20261003210014_public_events_rate_limits
-- Phase 5 / part 3: the public event contract and server-side abuse control.
--
-- PUBLIC EVENT (the landing page contract)
--   * `get_public_event` / `get_public_availability` are SQL whitelists: the projection is
--     built field by field, so adding a column to `events`/`pricing_tiers` can never leak
--     it through the public endpoint.
--   * Availability is deliberately COARSE. The authoritative number is the order-creation
--     transaction; a public "remaining" would be stale the moment it is rendered, and an
--     exact counter would expose internal inventory. The API therefore reports a bucket
--     (AVAILABLE / LOW / SOLD_OUT / NOT_STARTED / CLOSED) and the current stage price.
--   * The LOW threshold (10 units) is a presentation constant, documented in
--     docs/api.md, not a business rule.
--   * FAQ/content blocks are not represented in the database, so none are invented here;
--     the frontend uses name/description and the sales block.
--
-- RATE LIMITING (PostgreSQL-backed)
--   * No Redis exists in this architecture, and the volume is a one-page event (~120
--     buyers). A fixed-window counter in Postgres is atomic, small and operationally
--     boring: one `insert ... on conflict ... returning counter` per check.
--   * Keys are hashed with md5 before storage (no raw IP addresses or tokens in a table
--     that exists only for abuse control); windows are bounded and old rows are deleted by
--     the maintenance run.
--   * Limits are configured in TypeScript (`_shared/domain/rate-limits.ts`) and documented
--     in docs/api.md. They are deliberately generous: the goal is stopping scripted abuse
--     and token guessing, not throttling 120 attendees.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Availability vocabulary and the coarse label
-- ---------------------------------------------------------------------------
create or replace function app_private.availability_label(p_remaining integer)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_remaining is null then 'AVAILABLE'   -- unlimited stage
    when p_remaining <= 0 then 'SOLD_OUT'
    when p_remaining <= 10 then 'LOW'           -- documented presentation threshold
    else 'AVAILABLE'
  end;
$$;

comment on function app_private.availability_label(integer) is
  'Coarse public availability bucket. NULL means an unlimited stage; 0 is SOLD_OUT; 1-10 is LOW (presentation threshold, docs/api.md); anything else is AVAILABLE.';

-- ---------------------------------------------------------------------------
-- 2. Event sales summary (shared by the two public projections)
-- ---------------------------------------------------------------------------
create or replace function app_private.event_sales_summary(
  p_event public.events,
  p_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $sales$
declare
  v_types jsonb := '[]'::jsonb;
  v_any_open boolean := false;
  v_best text := 'CLOSED';
  v_type record;
  v_tier_id uuid;
  v_tier record;
  v_remaining integer;
  v_label text;
  v_open boolean;
begin
  for v_type in
    select tt.*
      from public.ticket_types tt
     where tt.event_id = p_event.id
       and tt.is_active
     order by tt.code
  loop
    if p_event.status <> 'PUBLISHED' then
      v_tier_id := null;
    else
      -- The smallest legal purchase is what a landing page quotes.
      v_tier_id := app_private.active_pricing_tier_id(v_type.id, p_at, v_type.min_per_order);
    end if;

    if v_tier_id is not null then
      select * into v_tier from public.pricing_tiers where id = v_tier_id;
      v_remaining := case when v_tier.quantity_limit is null then null
                          else v_tier.quantity_limit - v_tier.quantity_reserved - v_tier.quantity_sold
                     end;
      v_label := app_private.availability_label(v_remaining);
      v_open := true;
    else
      v_tier := null;
      v_remaining := null;
      v_open := false;
      -- Distinguish "sold out / cannot serve the minimum order" from "sales not started
      -- yet / closed": only an in-window stage that is full is SOLD_OUT.
      if p_event.status = 'PUBLISHED' and exists (
        select 1
          from public.pricing_tiers t
         where t.ticket_type_id = v_type.id
           and t.is_active
           and (t.sales_starts_at is null or t.sales_starts_at <= p_at)
           and (t.sales_ends_at is null or t.sales_ends_at > p_at)
      ) then
        v_label := 'SOLD_OUT';
      elsif p_event.status = 'PUBLISHED' then
        v_label := 'NOT_STARTED';
      else
        v_label := 'CLOSED';
      end if;
    end if;

    v_any_open := v_any_open or v_open;
    if (v_label = 'AVAILABLE') or (v_label = 'LOW' and v_best not in ('AVAILABLE'))
       or (v_label = 'SOLD_OUT' and v_best not in ('AVAILABLE', 'LOW'))
       or (v_label = 'NOT_STARTED' and v_best = 'CLOSED') then
      v_best := v_label;
    end if;

    v_types := v_types || jsonb_build_array(jsonb_build_object(
      'code', v_type.code,
      'name', v_type.name,
      'description', v_type.description,
      'minPerOrder', v_type.min_per_order,
      'maxPerOrder', v_type.max_per_order,
      'salesOpen', v_open,
      'availability', v_label,
      'currentTier', case when v_tier is null then null else jsonb_build_object(
        'name', v_tier.name,
        'sequence', v_tier.sequence,
        'priceInCents', v_tier.price_cents
      ) end
    ));
  end loop;

  return jsonb_build_object(
    'currency', p_event.currency,
    'salesOpen', v_any_open,
    'availability', v_best,
    'ticketTypes', v_types
  );
end;
$sales$;

comment on function app_private.event_sales_summary(public.events, timestamptz) is
  'Public sales projection for one event: per active ticket type, the current stage and its price plus a coarse availability bucket; never exact inventory counters.';

-- ---------------------------------------------------------------------------
-- 3. get_public_event / get_public_availability
-- ---------------------------------------------------------------------------
create or replace function public.get_public_event(p_code text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $pubevent$
declare
  v_event public.events;
begin
  select * into v_event
    from public.events
   where code = upper(btrim(coalesce(p_code, '')))
     -- DRAFT is not public. CLOSED stays visible (the page shows the event is over).
     and status in ('PUBLISHED', 'CLOSED');
  if v_event.id is null then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'event', jsonb_build_object(
      'code', v_event.code,
      'name', v_event.name,
      'description', v_event.description,
      'status', v_event.status,
      'startsAt', app_private.iso_utc(v_event.starts_at),
      'endsAt', app_private.iso_utc(v_event.ends_at),
      'timezone', v_event.timezone,
      'currency', v_event.currency,
      'venue', jsonb_build_object(
        'name', v_event.venue_name,
        'address', v_event.venue_address,
        'city', v_event.city
      )
    ),
    'sales', app_private.event_sales_summary(v_event, now())
  );
end;
$pubevent$;

comment on function public.get_public_event(text) is
  'Public event projection for the landing page: identity, dates, venue and the coarse sales block. Never returns participants, payments, discount usage, capacity counters or internal inventory.';

create or replace function public.get_public_availability(p_code text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $pubavail$
declare
  v_event public.events;
begin
  select * into v_event
    from public.events
   where code = upper(btrim(coalesce(p_code, '')))
     and status in ('PUBLISHED', 'CLOSED');
  if v_event.id is null then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'code', v_event.code,
    'sales', app_private.event_sales_summary(v_event, now())
  );
end;
$pubavail$;

comment on function public.get_public_availability(text) is
  'Lightweight public availability/pricing projection for the checkout: same coarse sales block as get_public_event. Informational only; the authoritative availability is decided inside the order transaction.';

-- ---------------------------------------------------------------------------
-- 4. Rate limit table
-- ---------------------------------------------------------------------------
-- One row per (scope, key, window). `key_hash` is md5 of a namespaced key produced by the
-- caller (for example `ip:190.0.0.1`, `ref:EVT-2026-000001`); the raw value is never
-- stored. Rows are tiny and deleted by the maintenance run; nothing here is evidence.
create table public.rate_limit_counters (
  scope text not null
    check (length(btrim(scope)) between 1 and 64),
  key_hash text not null
    check (key_hash ~ '^[0-9a-f]{32}$'),
  window_start timestamptz not null,
  counter integer not null default 1
    check (counter >= 1),
  primary key (scope, key_hash, window_start)
);

comment on table public.rate_limit_counters is
  'Fixed-window rate-limit counters (Postgres-backed, no Redis). Keys are md5 hashes of namespaced identifiers; windows are bounded and old rows are removed by maintenance. Exists only for abuse control.';

create index rate_limit_counters_window_idx on public.rate_limit_counters (window_start);

alter table public.rate_limit_counters enable row level security;

-- ---------------------------------------------------------------------------
-- 5. consume_rate_limit / cleanup_rate_limit_counters
-- ---------------------------------------------------------------------------
create or replace function public.consume_rate_limit(
  p_scope text,
  p_key text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $consume$
declare
  v_window_start timestamptz;
  v_counter integer;
begin
  if p_scope is null or length(btrim(p_scope)) = 0 or length(btrim(p_scope)) > 64 then
    raise exception 'Rate limit scope is required'
      using errcode = 'PT400', detail = 'INVALID_RATE_LIMIT_SCOPE';
  end if;
  if p_key is null or length(p_key) = 0 or length(p_key) > 300 then
    raise exception 'Rate limit key is required'
      using errcode = 'PT400', detail = 'INVALID_RATE_LIMIT_KEY';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'Rate limit must be between 1 and 100000'
      using errcode = 'PT400', detail = 'INVALID_RATE_LIMIT';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Rate limit window must be between 1 and 86400 seconds'
      using errcode = 'PT400', detail = 'INVALID_RATE_LIMIT_WINDOW';
  end if;

  -- Fixed window anchored to a constant epoch: cheap, stable, and good enough for abuse
  -- control (a fixed window can allow a burst at a boundary; the limits are generous
  -- enough that this is irrelevant).
  v_window_start := date_bin(
    make_interval(secs => p_window_seconds),
    p_now,
    '2000-01-01 00:00:00+00'::timestamptz
  );

  insert into public.rate_limit_counters (scope, key_hash, window_start, counter)
  values (btrim(p_scope), md5(p_key), v_window_start, 1)
  on conflict (scope, key_hash, window_start)
    do update set counter = public.rate_limit_counters.counter + 1
  returning counter into v_counter;

  return jsonb_build_object(
    'allowed', v_counter <= p_limit,
    'limit', p_limit,
    'remaining', greatest(p_limit - v_counter, 0),
    'windowSeconds', p_window_seconds,
    'resetAt', app_private.iso_utc(v_window_start + make_interval(secs => p_window_seconds))
  );
end;
$consume$;

comment on function public.consume_rate_limit(text, text, integer, integer, timestamptz) is
  'Atomically consumes one fixed-window rate-limit slot and reports allowed/remaining/resetAt. The insert-or-increment is a single statement, so concurrent requests cannot lose a count.';

create or replace function public.cleanup_rate_limit_counters(
  p_older_than_seconds integer default 7200,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $cleanuprl$
declare
  v_deleted integer := 0;
begin
  if p_older_than_seconds is null or p_older_than_seconds < 300 then
    raise exception 'Rate limit cleanup horizon must be at least 300 seconds'
      using errcode = 'PT400', detail = 'INVALID_RETENTION';
  end if;

  delete from public.rate_limit_counters
   where window_start < p_now - make_interval(secs => p_older_than_seconds);
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('deleted', v_deleted, 'ranAt', app_private.iso_utc(p_now));
end;
$cleanuprl$;

comment on function public.cleanup_rate_limit_counters(integer, timestamptz) is
  'Deletes rate-limit windows older than the horizon (default 2 h). Called by the maintenance run; a failure to clean up can never affect traffic correctness.';

-- ---------------------------------------------------------------------------
-- 6. Grants: service_role only
-- ---------------------------------------------------------------------------
revoke all on function app_private.availability_label(integer) from public;
revoke all on function app_private.event_sales_summary(public.events, timestamptz) from public;
revoke all on function public.get_public_event(text) from public;
revoke all on function public.get_public_availability(text) from public;
revoke all on function public.consume_rate_limit(text, text, integer, integer, timestamptz) from public;
revoke all on function public.cleanup_rate_limit_counters(integer, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function app_private.availability_label(integer) to service_role';
    execute 'grant execute on function app_private.event_sales_summary(public.events, timestamptz) to service_role';
    execute 'grant execute on function public.get_public_event(text) to service_role';
    execute 'grant execute on function public.get_public_availability(text) to service_role';
    execute 'grant execute on function public.consume_rate_limit(text, text, integer, integer, timestamptz) to service_role';
    execute 'grant execute on function public.cleanup_rate_limit_counters(integer, timestamptz) to service_role';
  end if;
end
$$;
