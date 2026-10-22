-- ---------------------------------------------------------------------------
-- Migration 20261003210012_reconciliation
-- Phase 5 / part 1: automatic payment reconciliation.
--
-- Why this exists
-- ---------------
-- Wompi's webhook is at-least-once, not always: a delivery can be lost entirely (our
-- endpoint down for more than the 24 h retry window, network issues, a misconfigured
-- URL). A payment may therefore be APPROVED at Wompi while the local attempt is still
-- `pending`. Phase 4 left this as the main correctness gap.
--
-- What Wompi actually supports (verified against docs.wompi.co on 2026-10-03):
--   * `GET /v1/transactions/{transaction_id}` with the PRIVATE key — the only lookup.
--     There is NO query by reference. A transaction id is learned from a webhook or
--     from the redirect URL that Wompi builds for the checkout
--     (`https://<redirect-url>?id=01-...`), which is why the API exposes a buyer-owned
--     "payment hint" path in addition to this automatic sweep.
--
-- Design consequences
-- -------------------
--   * Only attempts WITH a transaction id can be swept automatically; attempts that
--     never saw a transaction id are recovered through the payment-hint endpoint (the
--     buyer returns from the checkout) or an operator-assisted reconcile call.
--   * The sweep never confirms anything itself: it reuses the SAME `public.confirm_payment`
--     transaction as the webhook path. This migration only adds scheduling/bookkeeping.
--   * Bounded by construction: attempts per payment are capped (parameter), the schedule
--     backs off, and terminal outcomes clear the next attempt so nothing is queried
--     forever. Orders that already have an approved payment (PAID) are excluded: approving
--     a second attempt would violate `payments_one_approved_per_order_idx`, and the webhook
--     path already records those events.
--   * Safe for expired/cancelled orders: an approval for an order that is no longer
--     payable still goes through `confirm_payment`, which records
--     RECONCILIATION_REQUIRED instead of reviving the order or inventing a refund.
--
-- Bookkeeping columns (requirement: last attempt, attempt count, next eligible attempt,
-- last result, failure classification):
--   reconciliation_attempts     how many sweep queries have been issued
--   last_reconciled_at          when the last sweep query happened
--   next_reconciliation_at      when the next one is due (NULL = no more, by design)
--   last_reconciliation_result  outcome vocabulary (see domain/reconciliation.ts)
--   last_reconciliation_failure failure classification for operator triage
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Reconciliation bookkeeping on payments
-- ---------------------------------------------------------------------------
alter table public.payments
  add column reconciliation_attempts integer not null default 0
    check (reconciliation_attempts >= 0),
  add column last_reconciled_at timestamptz,
  add column next_reconciliation_at timestamptz,
  add column last_reconciliation_result text
    check (
      last_reconciliation_result is null
      or last_reconciliation_result in (
        'APPROVED_APPLIED',
        'APPROVED_DUPLICATE',
        'RECONCILIATION_REQUIRED',
        'STILL_PENDING',
        'DECLINED',
        'VOIDED',
        'ERROR',
        'UNKNOWN_STATUS',
        'MISMATCH',
        'NOT_FOUND_AT_PROVIDER',
        'UPSTREAM_ERROR'
      )
    ),
  add column last_reconciliation_failure text
    check (
      last_reconciliation_failure is null
      or last_reconciliation_failure in (
        'UPSTREAM_ERROR',
        'VALIDATION_MISMATCH',
        'PROVIDER_NOT_FOUND',
        'CONFIRMATION_FAILED'
      )
    );

comment on column public.payments.reconciliation_attempts is
  'How many reconciliation sweeps have queried Wompi for this attempt. Capped by the caller (configurable); once exhausted the payment stops being swept and stays visible for operator review.';
comment on column public.payments.next_reconciliation_at is
  'When this attempt is next eligible for a sweep. NULL means no more sweeps are scheduled: either the outcome is terminal or the attempt never had a transaction id.';
comment on column public.payments.last_reconciliation_result is
  'Outcome of the last sweep: APPROVED_APPLIED, APPROVED_DUPLICATE, RECONCILIATION_REQUIRED, STILL_PENDING, DECLINED, VOIDED, ERROR, UNKNOWN_STATUS, MISMATCH, NOT_FOUND_AT_PROVIDER or UPSTREAM_ERROR.';
comment on column public.payments.last_reconciliation_failure is
  'Failure classification for operator triage (UPSTREAM_ERROR, VALIDATION_MISMATCH, PROVIDER_NOT_FOUND, CONFIRMATION_FAILED) or NULL after a successful sweep.';

-- Due-sweep lookup: pending attempts with a known transaction id and a due schedule.
create index payments_reconciliation_due_idx
  on public.payments (next_reconciliation_at)
  where status in ('pending', 'unknown') and wompi_transaction_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Initial schedule, applied by trigger so create_order and retry_payment need no change
-- ---------------------------------------------------------------------------
-- The first sweep happens shortly after an attempt is created, then the delay grows. A
-- BEFORE INSERT trigger keeps every creation path (order creation, retry, and any future
-- path) consistent without rewriting the large Phase 3/4 functions.
create or replace function app_private.reconciliation_delay_seconds(p_completed_attempts integer)
returns integer
language sql
immutable
security invoker
set search_path = ''
as $$
  -- Documented, bounded schedule. Indexed by the number of sweeps already completed:
  --   1 -> 2 min, 2 -> 5 min, 3 -> 15 min, 4 -> 1 h, 5 -> 3 h, 6 -> 6 h, 7 -> 12 h,
  --   8+ -> 24 h (the attempt cap ends the sweep long before this matters).
  select (array[120, 300, 900, 3600, 10800, 21600, 43200, 86400])[
    least(greatest(coalesce(p_completed_attempts, 1), 1), 8)
  ];
$$;

comment on function app_private.reconciliation_delay_seconds(integer) is
  'Backoff schedule for the reconciliation sweep: 2 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, then 24 h. The attempt cap (configurable) is the real bound.';

create or replace function app_private.schedule_payment_reconciliation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Only a not-yet-final attempt is worth sweeping. An approved/declined/voided attempt
  -- inserted already final (e.g. by confirm_payment recovering a lost attempt row) must
  -- not be scheduled: there is nothing left to converge.
  if new.next_reconciliation_at is null
     and new.status in ('pending'::public.payment_status, 'unknown'::public.payment_status) then
    new.next_reconciliation_at := now()
      + make_interval(secs => app_private.reconciliation_delay_seconds(1));
  end if;
  return new;
end;
$$;

comment on function app_private.schedule_payment_reconciliation() is
  'BEFORE INSERT trigger: a new pending payment attempt becomes eligible for the first reconciliation sweep after the documented initial delay.';

create trigger payments_schedule_reconciliation
  before insert on public.payments
  for each row execute function app_private.schedule_payment_reconciliation();

-- ---------------------------------------------------------------------------
-- 3. ISO helper used by the Phase 5 projections
-- ---------------------------------------------------------------------------
-- One formatter instead of repeating `to_char(...)` in every new function. Existing
-- functions keep their inline expressions (no rewrite without need).
create or replace function app_private.iso_utc(p_at timestamptz)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case when p_at is null then null
              else to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         end;
$$;

comment on function app_private.iso_utc(timestamptz) is
  'Formats a timestamptz as the ISO-8601 UTC string used by every API projection (NULL stays NULL).';

-- ---------------------------------------------------------------------------
-- 4. claim_payment_reconciliations — the bounded, concurrency-safe sweep claim
-- ---------------------------------------------------------------------------
-- Candidates are locked with `for update skip locked` in the same statement that updates
-- them, so two concurrent runs split the work instead of querying Wompi twice for the same
-- attempt. Claiming consumes an attempt immediately: if the run dies after claiming, the
-- next schedule still fires, which is the bounded and safe behaviour.
create or replace function public.claim_payment_reconciliations(
  p_limit integer default 10,
  p_max_attempts integer default 8,
  p_now timestamptz default now()
)
returns setof jsonb
language plpgsql
security invoker
set search_path = ''
as $claimrecon$
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Reconciliation batch limit must be between 1 and 50'
      using errcode = 'PT400', detail = 'INVALID_LIMIT';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Reconciliation max attempts must be between 1 and 20'
      using errcode = 'PT400', detail = 'INVALID_MAX_ATTEMPTS';
  end if;

  return query
  with candidate as (
    select p.id
      from public.payments p
      join public.orders o on o.id = p.order_id
     where p.status in ('pending'::public.payment_status, 'unknown'::public.payment_status)
       -- Only attempts whose transaction id is known can be queried at Wompi.
       and p.wompi_transaction_id is not null
       and p.next_reconciliation_at is not null
       and p.next_reconciliation_at <= p_now
       and p.reconciliation_attempts < p_max_attempts
       -- PAID is excluded on purpose: a second approval would violate the
       -- one-approved-payment-per-order index, and the webhook path records those
       -- deliveries already. Everything else (including EXPIRED/CANCELLED) is safe:
       -- confirm_payment turns a late approval into RECONCILIATION_REQUIRED.
       and o.status in ('PENDING', 'FAILED', 'EXPIRED', 'CANCELLED')
     order by p.next_reconciliation_at
     limit p_limit
     for update of p skip locked
  ),
  claimed as (
    update public.payments p
       set reconciliation_attempts = p.reconciliation_attempts + 1,
           last_reconciled_at = p_now,
           next_reconciliation_at = p_now + make_interval(
             secs => app_private.reconciliation_delay_seconds(p.reconciliation_attempts + 1)
           )
      from candidate c
     where p.id = c.id
    returning p.*
  )
  select jsonb_build_object(
           'paymentId', c.id,
           'orderId', c.order_id,
           'paymentAttempt', c.attempt,
           'wompiReference', c.wompi_reference,
           'wompiTransactionId', c.wompi_transaction_id,
           'paymentStatus', c.status,
           'amountCents', c.amount_cents,
           'currency', c.currency,
           'reconciliationAttempts', c.reconciliation_attempts,
           'orderReference', o.reference,
           'orderStatus', o.status,
           'orderTotalInCents', o.total_cents,
           'orderCurrency', o.currency
         )
    from claimed c
    join public.orders o on o.id = c.order_id;
end;
$claimrecon$;

comment on function public.claim_payment_reconciliations(integer, integer, timestamptz) is
  'Claims up to p_limit pending payment attempts that are due for a Wompi sweep (known transaction id, attempt count below p_max_attempts, non-paid order) and advances their schedule. FOR UPDATE SKIP LOCKED makes concurrent runs split the work; the attempt budget bounds the total number of queries.';

-- ---------------------------------------------------------------------------
-- 5. finish_payment_reconciliation — records the outcome and stops or reschedules
-- ---------------------------------------------------------------------------
create or replace function public.finish_payment_reconciliation(
  p_payment_id uuid,
  p_result text,
  p_failure text default null,
  p_next_attempt_at timestamptz default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $finishrecon$
declare
  v_payment public.payments;
  v_terminal boolean;
begin
  if p_result is null or p_result not in (
    'APPROVED_APPLIED', 'APPROVED_DUPLICATE', 'RECONCILIATION_REQUIRED', 'STILL_PENDING',
    'DECLINED', 'VOIDED', 'ERROR', 'UNKNOWN_STATUS', 'MISMATCH',
    'NOT_FOUND_AT_PROVIDER', 'UPSTREAM_ERROR'
  ) then
    raise exception 'Reconciliation result is not a recognized outcome'
      using errcode = 'PT400', detail = 'INVALID_RECONCILIATION_RESULT';
  end if;
  if p_failure is not null and p_failure not in (
    'UPSTREAM_ERROR', 'VALIDATION_MISMATCH', 'PROVIDER_NOT_FOUND', 'CONFIRMATION_FAILED'
  ) then
    raise exception 'Reconciliation failure is not a recognized classification'
      using errcode = 'PT400', detail = 'INVALID_RECONCILIATION_FAILURE';
  end if;

  -- Terminal outcomes need no further queries. STILL_PENDING, UNKNOWN_STATUS and
  -- UPSTREAM_ERROR keep the schedule the claim already advanced (an explicit earlier
  -- retry may be supplied for transient upstream failures).
  v_terminal := p_result not in ('STILL_PENDING', 'UNKNOWN_STATUS', 'UPSTREAM_ERROR');

  update public.payments
     set last_reconciliation_result = p_result,
         last_reconciliation_failure = p_failure,
         next_reconciliation_at = case
           when v_terminal then null
           else coalesce(p_next_attempt_at, next_reconciliation_at)
         end
   where id = p_payment_id
  returning * into v_payment;

  if v_payment.id is null then
    raise exception 'Payment not found'
      using errcode = 'PT404', detail = 'PAYMENT_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'paymentId', v_payment.id,
    'result', v_payment.last_reconciliation_result,
    'failure', v_payment.last_reconciliation_failure,
    'reconciliationAttempts', v_payment.reconciliation_attempts,
    'nextReconciliationAt', app_private.iso_utc(v_payment.next_reconciliation_at)
  );
end;
$finishrecon$;

comment on function public.finish_payment_reconciliation(uuid, text, text, timestamptz, timestamptz) is
  'Records the outcome of one sweep and clears the next attempt for terminal outcomes. Validates the result/failure vocabulary so a typo cannot silently mask a payment.';

-- ---------------------------------------------------------------------------
-- 6. resolve_payment_for_buyer — the reference+email gate used by the payment hint
-- ---------------------------------------------------------------------------
-- The payment hint endpoint lets the buyer hand back the transaction id Wompi put in the
-- redirect URL (`?id=01-...`). The id is a HINT, never proof: the backend re-reads the
-- transaction with the private key and validates reference/amount/currency before anything
-- can be confirmed. This function is only the ownership check: the same email-possession
-- rule as `get_order_status`, returning the payment context the handler needs.
create or replace function public.resolve_payment_for_buyer(
  p_order_reference text,
  p_buyer_email text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $resolve$
declare
  v_order public.orders;
  v_payment public.payments;
begin
  select * into v_order
    from public.orders
   where reference = btrim(coalesce(p_order_reference, ''))
     and buyer_email = lower(btrim(coalesce(p_buyer_email, '')));
  if v_order.id is null then
    return jsonb_build_object('found', false);
  end if;

  select * into v_payment
    from public.payments
   where order_id = v_order.id
   order by attempt desc
   limit 1;

  if v_payment.id is null then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'paymentId', v_payment.id,
    'paymentAttempt', v_payment.attempt,
    'paymentStatus', v_payment.status,
    'wompiReference', v_payment.wompi_reference,
    'wompiTransactionId', v_payment.wompi_transaction_id,
    'amountCents', v_payment.amount_cents,
    'currency', v_payment.currency,
    'orderId', v_order.id,
    'orderReference', v_order.reference,
    'orderStatus', v_order.status,
    'orderTotalInCents', v_order.total_cents,
    'orderCurrency', v_order.currency
  );
end;
$resolve$;

comment on function public.resolve_payment_for_buyer(text, text) is
  'Reference+email possession check returning the latest payment attempt context for the payment-hint endpoint. Same anti-enumeration rule as get_order_status: a wrong email and an unknown reference both return found:false.';

-- ---------------------------------------------------------------------------
-- 7. Grants: service_role only
-- ---------------------------------------------------------------------------
revoke all on function app_private.reconciliation_delay_seconds(integer) from public;
revoke all on function app_private.schedule_payment_reconciliation() from public;
revoke all on function app_private.iso_utc(timestamptz) from public;
revoke all on function public.claim_payment_reconciliations(integer, integer, timestamptz) from public;
revoke all on function public.finish_payment_reconciliation(uuid, text, text, timestamptz, timestamptz) from public;
revoke all on function public.resolve_payment_for_buyer(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function app_private.reconciliation_delay_seconds(integer) to service_role';
    execute 'grant execute on function app_private.iso_utc(timestamptz) to service_role';
    execute 'grant execute on function public.claim_payment_reconciliations(integer, integer, timestamptz) to service_role';
    execute 'grant execute on function public.finish_payment_reconciliation(uuid, text, text, timestamptz, timestamptz) to service_role';
    execute 'grant execute on function public.resolve_payment_for_buyer(text, text) to service_role';
  end if;
end
$$;
