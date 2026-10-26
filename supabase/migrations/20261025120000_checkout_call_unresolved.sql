-- ---------------------------------------------------------------------------
-- One provider call per invoice (follow-up to 20261024170000).
--
-- 20261024170000 pins one LIVE session per attempt, but `begin_checkout_session` also granted
-- CREATE whenever the only evidence was a MISSING session row. That is not the same as "ePayco
-- was never called", and two paths slipped through it:
--
--   * a `payment/session/create` that outlives its 30 s lease leaves no row behind (the write
--     is refused with LEASE_LOST), so the next request was authorized to call ePayco again
--     with the SAME invoice;
--   * a timeout, an aborted fetch or a 5xx after ePayco accepted the request freed the lease
--     through `abandon`, and the buyer's retry sent the same invoice again.
--
-- ePayco registers an invoice on the transaction it creates, so the second call is the
-- "La transacción que intentas pagar ya cuenta con un registro previo" refusal the buyer saw,
-- and the first session becomes an orphan the database never records.
--
-- `payments.checkout_call_unresolved` records that a provider call WAS authorized and its
-- outcome is unknown. While it is set `begin_checkout_session` refuses CREATE, so one invoice
-- reaches ePayco at most once. It is cleared when:
--   * a session is recorded (`complete_checkout_session`),
--   * the order reservation lapses (`complete_checkout_session` → RESERVATION_EXPIRED),
--   * `abandon_checkout_session` is told the provider definitively created nothing
--     (`NOT_CREATED`: a 400/401/403/404/422/429 rejection, which never reaches transaction
--     creation).
-- Anything else — timeout, 408, 409, 5xx, an unreadable 2xx body — leaves it set, because the
-- provider may already hold a transaction for this reference.
--
-- The buyer is not stranded by design: a new attempt (`POST /orders/{reference}/retry`, after
-- the reservation expires) inserts a NEW payment row with a NEW reference, and therefore a NEW
-- invoice and a fresh authorization.
-- ---------------------------------------------------------------------------

alter table public.payments
  add column if not exists checkout_call_unresolved boolean not null default false;

comment on column public.payments.checkout_call_unresolved is
  'A provider session-create was authorized for this attempt and its outcome is unknown (timeout, 5xx, unreadable response, or a call that outlived its lease). begin_checkout_session refuses a second call while it is set, so one invoice never reaches ePayco twice.';

-- ---------------------------------------------------------------------------
-- begin_checkout_session — REUSE | CREATE | LEASED | RETRY_REQUIRED
--
-- Unchanged from 20261024170000 except for the unresolved-call gate and the marker the CREATE
-- path now sets.
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

  -- A call is in flight: answer LEASED, not a new authorization.
  if v_payment.checkout_lease_until is not null and v_payment.checkout_lease_until > p_now then
    return v_base || jsonb_build_object('state', 'LEASED');
  end if;

  -- The lease elapsed (or was released) with no session recorded, but an earlier call WAS
  -- authorized for this invoice. ePayco may have registered it, so a second call is refused
  -- instead of provoking the duplicate-invoice rejection. Only a new attempt — new reference,
  -- new invoice — can be paid.
  if v_payment.checkout_call_unresolved then
    return v_base || jsonb_build_object(
      'state', 'RETRY_REQUIRED',
      'reason', 'SESSION_CALL_UNRESOLVED'
    );
  end if;

  update public.payments
     set checkout_lease_until = p_now + make_interval(secs => p_lease_seconds),
         checkout_lease_generation = checkout_lease_generation + 1,
         checkout_call_unresolved = true
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
--
-- A matching generation is now the ownership proof, so a provider call that took longer than
-- its lease can still record its session: with `checkout_call_unresolved` set no other request
-- can claim a newer generation, and dropping the session would destroy the only one this
-- invoice will ever get. Ownership is still required (`checkout_lease_until is null` means the
-- lease was already resolved, so the row is not ours to write).
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

  -- Lost the race: another request claimed a newer lease (or this one was already resolved),
  -- so its session is the one the buyer must receive.
  if p_generation is null
     or p_generation <> v_payment.checkout_lease_generation
     or v_payment.checkout_lease_until is null then
    return jsonb_build_object('created', false, 'reason', 'LEASE_LOST');
  end if;

  select o.* into v_order from public.orders o where o.id = v_payment.order_id;

  -- The provider call took the lease's few seconds; if the reservation lapsed meanwhile the
  -- session would be dead on arrival. Resolve the attempt and let the buyer start a new one.
  if v_order.reservation_expires_at is not null and v_order.reservation_expires_at <= p_now then
    update public.payments
       set checkout_lease_until = null,
           checkout_call_unresolved = false
     where id = v_payment.id;
    return jsonb_build_object('created', false, 'reason', 'RESERVATION_EXPIRED');
  end if;

  v_expires_at := coalesce(v_order.reservation_expires_at, p_now + interval '15 minutes');

  insert into public.checkout_sessions (
    payment_id, payment_reference, session_id, issued_at, expires_at
  ) values (
    v_payment.id, v_payment.wompi_reference, v_session_id, p_now, v_expires_at
  )
  returning * into v_session;

  -- The session is pinned: the invoice is now represented by a row we can resume, so no
  -- further provider call is needed (or allowed) for this attempt.
  update public.payments
     set checkout_lease_until = null,
         checkout_call_unresolved = false
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
--
-- `p_provider_outcome` says whether the failure PROVES nothing was created at ePayco:
--   NOT_CREATED — the provider rejected the request (4xx validation/auth); the marker is
--                 cleared and the buyer may ask for a new session for the same invoice.
--   UNKNOWN     — the default and the safe answer for a timeout, 408, 409, 5xx or unreadable
--                 body; the marker stays set so this invoice is never sent to ePayco twice.
-- ---------------------------------------------------------------------------
drop function if exists public.abandon_checkout_session(text, integer);

create or replace function public.abandon_checkout_session(
  p_payment_reference text,
  p_generation integer,
  p_provider_outcome text default 'UNKNOWN'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $abandon_session$
declare
  v_reference text := btrim(coalesce(p_payment_reference, ''));
  v_outcome text := upper(btrim(coalesce(p_provider_outcome, 'UNKNOWN')));
  v_payment public.payments;
begin
  if v_reference = '' then
    raise exception 'Payment reference is required'
      using errcode = 'PT400', detail = 'MISSING_PAYMENT_REFERENCE';
  end if;
  if v_outcome not in ('NOT_CREATED', 'UNKNOWN') then
    raise exception 'Provider outcome is unknown'
      using errcode = 'PT400', detail = 'INVALID_PROVIDER_OUTCOME';
  end if;

  select p.* into v_payment
    from public.payments p
   where p.wompi_reference = v_reference
   for update;

  if v_payment.id is null then
    raise exception 'Payment attempt is unknown'
      using errcode = 'PT404', detail = 'PAYMENT_ATTEMPT_NOT_FOUND';
  end if;

  -- A stale request must not void a newer authorization.
  if p_generation is null or p_generation <> v_payment.checkout_lease_generation then
    return jsonb_build_object('released', false);
  end if;

  update public.payments
     set checkout_lease_until = null,
         checkout_call_unresolved = case
           when v_outcome = 'NOT_CREATED' then false
           else checkout_call_unresolved
         end
   where id = v_payment.id;

  return jsonb_build_object('released', true);
end;
$abandon_session$;

comment on function public.begin_checkout_session(text, integer, timestamptz) is
  'Decides whether an ePayco checkout attempt can RESUME its live session, needs a new one (CREATE, under a lease), is being prepared elsewhere (LEASED), or can only be paid through a new attempt (RETRY_REQUIRED: order not PENDING, reservation elapsed, a transaction already recorded, or an unresolved provider call for this invoice).';
comment on function public.complete_checkout_session(text, integer, text, timestamptz) is
  'Records the provider session under its generation. A stale generation, or a lease that was already resolved, answers created=false instead of overwriting the winner; a call that outlived its lease can still record while no other request holds a newer generation.';
comment on function public.abandon_checkout_session(text, integer, text) is
  'Releases the checkout lease after a failed provider call. p_provider_outcome = NOT_CREATED clears the unresolved-call marker (the invoice may be sent again); UNKNOWN keeps it, so no second session-create is authorized for the same invoice.';

revoke all on function public.begin_checkout_session(text, integer, timestamptz) from public;
revoke all on function public.complete_checkout_session(text, integer, text, timestamptz) from public;
revoke all on function public.abandon_checkout_session(text, integer, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.begin_checkout_session(text, integer, timestamptz) from anon';
    execute 'revoke all on function public.complete_checkout_session(text, integer, text, timestamptz) from anon';
    execute 'revoke all on function public.abandon_checkout_session(text, integer, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.begin_checkout_session(text, integer, timestamptz) from authenticated';
    execute 'revoke all on function public.complete_checkout_session(text, integer, text, timestamptz) from authenticated';
    execute 'revoke all on function public.abandon_checkout_session(text, integer, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.begin_checkout_session(text, integer, timestamptz) to service_role';
    execute 'grant execute on function public.complete_checkout_session(text, integer, text, timestamptz) to service_role';
    execute 'grant execute on function public.abandon_checkout_session(text, integer, text) to service_role';
  end if;
end
$$;
