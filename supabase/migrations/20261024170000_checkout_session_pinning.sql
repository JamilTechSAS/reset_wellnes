-- ---------------------------------------------------------------------------
-- Migration 20261024170000_checkout_session_pinning
-- ePayco QA follow-up: one live Smart Checkout session per payment attempt.
--
-- The gap it closes (staging, 2026-10-24, order EVT-2026-000009): `POST /orders` replayed
-- with the same idempotency key returns the existing order, and the handler then minted a
-- NEW ePayco session for the SAME `payments.wompi_reference`. ePayco assigned a second
-- transaction id (390996469) while the payment row still recorded the first (390996271),
-- `confirm_payment` refused the approval with PT409 REFERENCE_MISMATCH, and the buyer's money
-- existed only at the provider. Reopening a session the buyer had left produced the same
-- shape.
--
-- This migration makes the database the arbiter of checkout sessions:
--
--   * `checkout_sessions` is an append-only ledger of the sessions issued per attempt, with a
--     partial unique index that allows AT MOST ONE live session per `payment_id`. Superseding
--     is explicit: a row is closed with a timestamp and a reason ('EXPIRED' when its window
--     elapsed, 'NEW_ATTEMPT' when a later attempt of the same order is created).
--   * `payments.checkout_lease_until` / `checkout_lease_generation` serialize session creation
--     across concurrent requests: a request claims a short lease, creates the session at the
--     provider, and only the lease holder may record it. A loser cannot overwrite the winner.
--   * `begin_checkout_session` is the decision point. It RESUME the live session when there is
--     one, asks for a new one only when the attempt is still payable and a lease is free, and
--     answers RETRY_REQUIRED once the attempt can no longer be paid (order not PENDING, its
--     reservation elapsed, or the provider already recorded a transaction for it) — because a
--     second transaction under one reference is exactly what must not happen. A real retry is
--     `POST /orders/{reference}/retry`, which creates attempt N with its own reference.
--   * `complete_checkout_session` stores the provider session id under the lease, and
--     `abandon_checkout_session` releases the lease when the provider call failed, so a buyer
--     can retry immediately.
--
-- Nothing here writes to `orders`, inventory, participants or payment status; a confirmation
-- still goes through `confirm_payment` and the webhook, unchanged.
-- ---------------------------------------------------------------------------

-- Every object below is created with an idempotent guard, so a partial application can be
-- re-run instead of forcing a manual repair. The guards are deliberately narrow: the shape
-- of anything that already exists is VALIDATED (and the rerun aborts) rather than silently
-- accepted, because adopting an incompatible table or index would break the pinning invariant
-- this migration exists to provide.
alter table public.payments
  add column if not exists checkout_lease_until timestamptz;

alter table public.payments
  add column if not exists checkout_lease_generation integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'payments_checkout_lease_generation_check'
       and conrelid = 'public.payments'::regclass
  ) then
    alter table public.payments
      add constraint payments_checkout_lease_generation_check
      check (checkout_lease_generation >= 0);
  end if;
end
$$;

do $$
declare
  v_incompatible text;
begin
  select string_agg(expected.name, ', ')
    into v_incompatible
    from (values
      ('checkout_lease_until', 'timestamp with time zone', 'YES'),
      ('checkout_lease_generation', 'integer', 'NO')
    ) as expected(name, data_type, is_nullable)
   where not exists (
     select 1
       from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'payments'
        and c.column_name = expected.name
        and c.data_type = expected.data_type
        and c.is_nullable = expected.is_nullable
   );
  if v_incompatible is not null then
    raise exception 'payments checkout-lease columns do not match the expected shape: %',
                    v_incompatible
      using errcode = 'PT400', detail = 'INCOMPATIBLE_CHECKOUT_LEASE_COLUMN';
  end if;
end
$$;

comment on column public.payments.checkout_lease_until is
  'Short lease held by the request that is creating this attempt''s checkout session; NULL when nobody is creating one.';
comment on column public.payments.checkout_lease_generation is
  'Monotonic counter bumped by every lease claim, so a late completion from an abandoned request cannot overwrite a newer session.';

create table if not exists public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete restrict,
  -- Denormalized for operator queries: the reference ePayco received as the invoice.
  payment_reference text not null
    check (payment_reference ~ '^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]+)?$'),
  -- ePayco Smart Checkout session id. Opaque provider value, never derived from the request.
  session_id text not null
    check (length(btrim(session_id)) between 4 and 200 and session_id ~ '^[!-~]+$'),
  issued_at timestamptz not null default now(),
  -- The session is usable while the order reservation is: after that the order cannot be paid.
  expires_at timestamptz not null,
  superseded_at timestamptz,
  superseded_reason text
    check (superseded_reason in ('EXPIRED', 'NEW_ATTEMPT')),
  constraint checkout_sessions_window check (expires_at > issued_at),
  -- A closed row must say why it was closed, and an open row must not.
  constraint checkout_sessions_supersede_pair check (
    (superseded_at is null) = (superseded_reason is null)
  ),
  constraint checkout_sessions_payment_session_key unique (payment_id, session_id)
);

comment on table public.checkout_sessions is
  'Append-only ledger of ePayco checkout sessions per payment attempt. The partial unique index on payment_id (superseded_at is null) is what makes "one live session per attempt" a database guarantee, not a handler convention.';

create unique index if not exists checkout_sessions_live_idx
  on public.checkout_sessions (payment_id)
  where superseded_at is null;

create index if not exists checkout_sessions_payment_id_idx
  on public.checkout_sessions (payment_id, issued_at desc);

-- Validate what the guards above accepted. `create ... if not exists` would otherwise let a
-- pre-existing table, index or foreign key with different semantics pass silently.
do $$
begin
  if not exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relnamespace = 'public'::regnamespace
       and c.relname = 'checkout_sessions_live_idx'
       and i.indisunique
       and pg_get_expr(i.indpred, i.indrelid) ilike '%superseded_at IS NULL%'
  ) then
    raise exception 'checkout_sessions_live_idx is not the expected partial unique index'
      using errcode = 'PT400', detail = 'INCOMPATIBLE_CHECKOUT_SESSIONS_INDEX';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'checkout_sessions_payment_id_fkey'
       and conrelid = 'public.checkout_sessions'::regclass
       and confrelid = 'public.payments'::regclass
  ) then
    raise exception 'checkout_sessions has no foreign key to payments'
      using errcode = 'PT400', detail = 'INCOMPATIBLE_CHECKOUT_SESSIONS_TABLE';
  end if;

  if (select count(*) from pg_constraint
       where conrelid = 'public.checkout_sessions'::regclass
         and conname in ('checkout_sessions_window', 'checkout_sessions_supersede_pair')) <> 2 then
    raise exception 'checkout_sessions is missing its window or supersede-pair constraint'
      using errcode = 'PT400', detail = 'INCOMPATIBLE_CHECKOUT_SESSIONS_TABLE';
  end if;
end
$$;

do $$
declare
  v_incompatible text;
begin
  select string_agg(expected.name, ', ')
    into v_incompatible
    from (values
      ('id', 'uuid', 'NO'),
      ('payment_id', 'uuid', 'NO'),
      ('payment_reference', 'text', 'NO'),
      ('session_id', 'text', 'NO'),
      ('issued_at', 'timestamp with time zone', 'NO'),
      ('expires_at', 'timestamp with time zone', 'NO'),
      ('superseded_at', 'timestamp with time zone', 'YES'),
      ('superseded_reason', 'text', 'YES')
    ) as expected(name, data_type, is_nullable)
   where not exists (
     select 1
       from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'checkout_sessions'
        and c.column_name = expected.name
        and c.data_type = expected.data_type
        and c.is_nullable = expected.is_nullable
   );
  if v_incompatible is not null then
    raise exception 'checkout_sessions does not match the expected shape: %', v_incompatible
      using errcode = 'PT400', detail = 'INCOMPATIBLE_CHECKOUT_SESSIONS_TABLE';
  end if;
end
$$;

alter table public.checkout_sessions enable row level security;
revoke all on table public.checkout_sessions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.checkout_sessions from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.checkout_sessions from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.checkout_sessions to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- A new attempt supersedes the live session of the previous one.
-- `retry_payment` inserts attempt N; that insert is the audit point, so the trigger runs
-- there (and for any attempt row created by a confirmation), never from application code.
-- ---------------------------------------------------------------------------
create or replace function app_private.supersede_sibling_checkout_sessions()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $supersede$
begin
  update public.checkout_sessions s
     set superseded_at = now(),
         superseded_reason = 'NEW_ATTEMPT'
   where s.superseded_at is null
     and s.payment_id in (
       select p.id from public.payments p
        where p.order_id = new.order_id
          and p.id <> new.id
     );
  return null;
end;
$supersede$;

drop trigger if exists payments_supersede_checkout_sessions on public.payments;

create trigger payments_supersede_checkout_sessions
  after insert on public.payments
  for each row execute function app_private.supersede_sibling_checkout_sessions();

comment on function app_private.supersede_sibling_checkout_sessions() is
  'AFTER INSERT trigger on payments: closes the live checkout session of the previous attempt with reason NEW_ATTEMPT, so superseding is recorded rather than implied.';

-- Trigger functions need no EXECUTE grant; the default PUBLIC grant is removed for the same
-- reason every other app_private helper has it removed.
revoke all on function app_private.supersede_sibling_checkout_sessions() from public;

-- ---------------------------------------------------------------------------
-- begin_checkout_session — REUSE | CREATE | LEASED | RETRY_REQUIRED
--
-- Locking: the payment row is locked FOR UPDATE, so two simultaneous calls for the same
-- attempt serialize; the second sees the first's session (REUSE) or its lease (LEASED).
-- ---------------------------------------------------------------------------
create or replace function public.begin_checkout_session(
  p_payment_reference text,
  p_lease_seconds integer default 30,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $begin_session$
declare
  v_reference text := btrim(coalesce(p_payment_reference, ''));
  v_payment public.payments;
  v_order public.orders;
  v_session public.checkout_sessions;
  v_base jsonb;
begin
  if v_reference = '' then
    raise exception 'Payment reference is required'
      using errcode = 'PT400', detail = 'MISSING_PAYMENT_REFERENCE';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 5 or p_lease_seconds > 300 then
    raise exception 'Checkout lease is out of range'
      using errcode = 'PT400', detail = 'INVALID_LEASE_WINDOW';
  end if;

  select p.* into v_payment
    from public.payments p
   where p.wompi_reference = v_reference
   for update;

  if v_payment.id is null then
    raise exception 'Payment attempt is unknown'
      using errcode = 'PT404', detail = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;
  if v_payment.payment_provider <> 'epayco' then
    raise exception 'Checkout sessions are only issued for ePayco attempts'
      using errcode = 'PT409', detail = 'PROVIDER_SESSION_UNSUPPORTED';
  end if;

  select o.* into v_order from public.orders o where o.id = v_payment.order_id;
  v_base := jsonb_build_object(
    'paymentId', v_payment.id,
    'paymentReference', v_payment.wompi_reference,
    'paymentAttempt', v_payment.attempt
  );

  if v_order.status <> 'PENDING' then
    return v_base || jsonb_build_object('state', 'RETRY_REQUIRED', 'reason', 'ORDER_NOT_PENDING');
  end if;
  if v_order.reservation_expires_at is null or v_order.reservation_expires_at <= p_now then
    return v_base || jsonb_build_object('state', 'RETRY_REQUIRED', 'reason', 'RESERVATION_EXPIRED');
  end if;

  select s.* into v_session
    from public.checkout_sessions s
   where s.payment_id = v_payment.id
     and s.superseded_at is null
   for update;

  if v_session.id is not null then
    if v_session.expires_at > p_now then
      return v_base || jsonb_build_object(
        'state', 'REUSE',
        'sessionId', v_session.session_id,
        'sessionExpiresAt', to_char(v_session.expires_at at time zone 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      );
    end if;
    -- The window elapsed: close it explicitly before a replacement can be issued.
    update public.checkout_sessions
       set superseded_at = p_now, superseded_reason = 'EXPIRED'
     where id = v_session.id;
  end if;

  -- The provider already recorded a transaction for this attempt. Minting another session
  -- would put a second transaction under the same reference — the exact defect this
  -- migration exists to prevent. A real retry creates attempt N with a new reference.
  if v_payment.wompi_transaction_id is not null then
    return v_base || jsonb_build_object('state', 'RETRY_REQUIRED', 'reason', 'TRANSACTION_RECORDED');
  end if;

  if v_payment.checkout_lease_until is not null and v_payment.checkout_lease_until > p_now then
    return v_base || jsonb_build_object('state', 'LEASED');
  end if;

  update public.payments
     set checkout_lease_until = p_now + make_interval(secs => p_lease_seconds),
         checkout_lease_generation = checkout_lease_generation + 1
   where id = v_payment.id
   returning * into v_payment;

  return v_base || jsonb_build_object(
    'state', 'CREATE',
    'generation', v_payment.checkout_lease_generation,
    'leaseUntil', to_char(v_payment.checkout_lease_until at time zone 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$begin_session$;

-- ---------------------------------------------------------------------------
-- complete_checkout_session — record the provider session under its lease
-- Returns {created: true, ...} or {created: false, reason: 'LEASE_LOST' | 'RESERVATION_EXPIRED'}.
-- ---------------------------------------------------------------------------
create or replace function public.complete_checkout_session(
  p_payment_reference text,
  p_generation integer,
  p_session_id text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $complete_session$
declare
  v_reference text := btrim(coalesce(p_payment_reference, ''));
  v_session_id text := btrim(coalesce(p_session_id, ''));
  v_payment public.payments;
  v_order public.orders;
  v_session public.checkout_sessions;
  v_expires_at timestamptz;
begin
  if v_reference = '' then
    raise exception 'Payment reference is required'
      using errcode = 'PT400', detail = 'MISSING_PAYMENT_REFERENCE';
  end if;
  if length(v_session_id) < 4 or length(v_session_id) > 200 or v_session_id !~ '^[!-~]+$' then
    raise exception 'Checkout session id is malformed'
      using errcode = 'PT400', detail = 'INVALID_SESSION_ID';
  end if;

  select p.* into v_payment
    from public.payments p
   where p.wompi_reference = v_reference
   for update;

  if v_payment.id is null then
    raise exception 'Payment attempt is unknown'
      using errcode = 'PT404', detail = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;

  -- Lost the race: another request claimed a newer lease (or completed this one), so its
  -- session is the one the buyer must receive.
  if p_generation is null
     or p_generation <> v_payment.checkout_lease_generation
     or v_payment.checkout_lease_until is null
     or v_payment.checkout_lease_until < p_now then
    return jsonb_build_object('created', false, 'reason', 'LEASE_LOST');
  end if;

  select o.* into v_order from public.orders o where o.id = v_payment.order_id;

  -- The provider call took the lease's few seconds; if the reservation lapsed meanwhile the
  -- session would be dead on arrival. Free the lease and let the buyer start a new attempt.
  if v_order.reservation_expires_at is not null and v_order.reservation_expires_at <= p_now then
    update public.payments set checkout_lease_until = null where id = v_payment.id;
    return jsonb_build_object('created', false, 'reason', 'RESERVATION_EXPIRED');
  end if;

  v_expires_at := coalesce(v_order.reservation_expires_at, p_now + interval '15 minutes');

  insert into public.checkout_sessions (
    payment_id, payment_reference, session_id, issued_at, expires_at
  ) values (
    v_payment.id, v_payment.wompi_reference, v_session_id, p_now, v_expires_at
  )
  returning * into v_session;

  update public.payments
     set checkout_lease_until = null
   where id = v_payment.id;

  return jsonb_build_object(
    'created', true,
    'sessionId', v_session.session_id,
    'expiresAt', to_char(v_session.expires_at at time zone 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$complete_session$;

-- ---------------------------------------------------------------------------
-- abandon_checkout_session — the provider call failed, so free the lease immediately
-- instead of making the buyer wait for it to expire.
-- ---------------------------------------------------------------------------
create or replace function public.abandon_checkout_session(
  p_payment_reference text,
  p_generation integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $abandon_session$
declare
  v_reference text := btrim(coalesce(p_payment_reference, ''));
  v_payment public.payments;
begin
  if v_reference = '' then
    raise exception 'Payment reference is required'
      using errcode = 'PT400', detail = 'MISSING_PAYMENT_REFERENCE';
  end if;

  select p.* into v_payment
    from public.payments p
   where p.wompi_reference = v_reference
   for update;

  if v_payment.id is null then
    raise exception 'Payment attempt is unknown'
      using errcode = 'PT404', detail = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;

  if p_generation is null or p_generation <> v_payment.checkout_lease_generation then
    return jsonb_build_object('released', false);
  end if;

  update public.payments
     set checkout_lease_until = null
   where id = v_payment.id
     and checkout_lease_until is not null;

  return jsonb_build_object('released', found);
end;
$abandon_session$;

comment on function public.begin_checkout_session(text, integer, timestamptz) is
  'Decides whether an ePayco checkout attempt can RESUME its live session, needs a new one (CREATE, under a lease), is being prepared elsewhere (LEASED), or can only be paid through a new attempt (RETRY_REQUIRED).';
comment on function public.complete_checkout_session(text, integer, text, timestamptz) is
  'Records the provider session under its lease. A stale generation or an expired lease answers created=false instead of overwriting the winner.';
comment on function public.abandon_checkout_session(text, integer) is
  'Releases the checkout lease after a failed provider call, so the buyer can retry immediately.';

revoke all on function public.begin_checkout_session(text, integer, timestamptz) from public;
revoke all on function public.complete_checkout_session(text, integer, text, timestamptz) from public;
revoke all on function public.abandon_checkout_session(text, integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.begin_checkout_session(text, integer, timestamptz) from anon';
    execute 'revoke all on function public.complete_checkout_session(text, integer, text, timestamptz) from anon';
    execute 'revoke all on function public.abandon_checkout_session(text, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.begin_checkout_session(text, integer, timestamptz) from authenticated';
    execute 'revoke all on function public.complete_checkout_session(text, integer, text, timestamptz) from authenticated';
    execute 'revoke all on function public.abandon_checkout_session(text, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.begin_checkout_session(text, integer, timestamptz) to service_role';
    execute 'grant execute on function public.complete_checkout_session(text, integer, text, timestamptz) to service_role';
    execute 'grant execute on function public.abandon_checkout_session(text, integer) to service_role';
  end if;
end
$$;
