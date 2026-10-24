-- Migration 20261024120000_remove_tickets_participant_sheets
-- -----------------------------------------------------------------------------
-- Phase 3: tickets are discontinued. Purchases no longer create ticket rows,
-- tokens or QR codes. The flow is: order + buyer (participants) stored -> ePayco
-- verified -> order PAID -> buyer data synced to Google Sheets (ONE ROW PER
-- PARTICIPANT, PAID orders only) -> branded thank-you page. Welcome email is
-- deferred until its HTML design is provided.
--
-- Preserved exactly: ePayco verification, the PAID transition, inventory
-- accounting (reserved -> sold from order_items) and webhook/replay idempotency.
--
-- Legacy ticket tables (tickets, attendance, consents, email_deliveries) and the
-- legacy per-ticket outbox (sheets_projections) are LEFT IN PLACE for a
-- separately reviewed cleanup. This migration only stops feeding them and routes
-- the Sheets projection through a new participant-keyed outbox.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- 1. confirm_payment: identical to 20261023140000 EXCEPT the ticket-issuance
--    loop is removed. Inventory move, PAID transition, provider fail-close and
--    replay idempotency are unchanged. At PAID, one Sheets projection per
--    participant of the order is enqueued (idempotent).
-- =============================================================================
create or replace function public.confirm_payment(
  p_order_reference text,
  p_wompi_reference text,
  p_wompi_transaction_id text,
  p_wompi_status text,
  p_amount_cents bigint,
  p_currency text,
  p_payment_method_type text default null,
  p_status_message text default null,
  p_provider_payload jsonb default null,
  p_provider text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $confirm$
declare
  v_order public.orders;
  v_payment public.payments;
  v_attempt integer;
  v_max_attempt integer;
  v_normalized public.payment_status;
  v_incoming_raw text;
  v_previous public.payment_status;
  v_now timestamptz := now();
  v_expected integer := 0;
  v_raw_changed boolean := false;
  v_new_payment boolean := false;
  v_status_changed boolean := false;
  v_approved boolean := false;
  v_provider text;
  v_tx_id text;
begin
  v_incoming_raw := btrim(coalesce(p_wompi_status, ''));
  -- H15: the provider is mandatory and explicit. A missing or unknown value used to become
  -- 'epayco', which recorded every Wompi confirmation as ePayco.
  if lower(btrim(coalesce(p_provider, ''))) not in ('wompi', 'epayco') then
    raise exception 'Payment provider must be wompi or epayco'
      using errcode = 'PT400', detail = 'INVALID_PROVIDER';
  end if;
  v_provider := lower(btrim(p_provider));
  v_tx_id := nullif(btrim(coalesce(p_wompi_transaction_id, '')), '');

  v_normalized := case upper(v_incoming_raw)
    when 'PENDING'   then 'pending'::public.payment_status
    when 'APPROVED'  then 'approved'::public.payment_status
    when 'DECLINED'  then 'declined'::public.payment_status
    when 'VOIDED'    then 'voided'::public.payment_status
    when 'ERROR'     then 'error'::public.payment_status
    -- ePayco response codes (1=Aceptada, 2=Rechazada, 3=Pendiente, 4=Fallida)
    when '1'         then 'approved'::public.payment_status
    when '2'         then 'declined'::public.payment_status
    when '3'         then 'pending'::public.payment_status
    when '4'         then 'error'::public.payment_status
    -- 6=Reversada: the voided path (approved -> refunded, never un-approved).
    when '6'         then 'voided'::public.payment_status
    -- 7=Retenida, 8=Iniciada: not settled; keep reconciling.
    when '7'         then 'pending'::public.payment_status
    when '8'         then 'pending'::public.payment_status
    -- 9=Expirada/Caducada, 10=Abandonada, 11=Cancelada: the buyer never paid. Declined, not
    -- voided: an expiry arriving after an approval must not turn it into a refund.
    when '9'         then 'declined'::public.payment_status
    when '10'        then 'declined'::public.payment_status
    when '11'        then 'declined'::public.payment_status
    -- ePayco text statuses
    when 'ACEPTADA'  then 'approved'::public.payment_status
    when 'RECHAZADA' then 'declined'::public.payment_status
    when 'PENDIENTE' then 'pending'::public.payment_status
    when 'FALLIDA'   then 'error'::public.payment_status
    when 'REVERSADA'  then 'voided'::public.payment_status
    when 'RETENIDA'   then 'pending'::public.payment_status
    when 'RETENIDO'   then 'pending'::public.payment_status
    when 'INICIADA'   then 'pending'::public.payment_status
    when 'EXPIRADA'   then 'declined'::public.payment_status
    when 'CADUCADA'   then 'declined'::public.payment_status
    when 'ABANDONADA' then 'declined'::public.payment_status
    when 'CANCELADA'  then 'declined'::public.payment_status
    else 'unknown'::public.payment_status
  end;

  if p_order_reference is null or length(btrim(p_order_reference)) = 0 then
    raise exception 'Order reference is required'
      using errcode = 'PT400', detail = 'MISSING_ORDER_REFERENCE';
  end if;
  if p_wompi_reference is null or length(btrim(p_wompi_reference)) = 0 then
    raise exception 'Payment reference is required'
      using errcode = 'PT400', detail = 'MISSING_REFERENCE';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'Payment amount is missing or negative'
      using errcode = 'PT400', detail = 'INVALID_AMOUNT';
  end if;
  if upper(coalesce(p_currency, '')) <> 'COP' then
    raise exception 'Payment currency is not COP'
      using errcode = 'PT409', detail = 'CURRENCY_MISMATCH';
  end if;
  if p_provider_payload is not null and jsonb_typeof(p_provider_payload) <> 'object' then
    raise exception 'Provider payload must be a JSON object'
      using errcode = 'PT400', detail = 'INVALID_PROVIDER_PAYLOAD';
  end if;

  select * into v_order
  from public.orders
  where reference = btrim(p_order_reference)
  for update;

  if v_order.id is null then
    raise exception 'Order reference is unknown'
      using errcode = 'PT404', detail = 'ORDER_NOT_FOUND';
  end if;

  if p_wompi_reference <> v_order.reference
     and p_wompi_reference !~ ('^' || v_order.reference || '-[0-9]+$') then
    raise exception 'Payment reference does not belong to this order'
      using errcode = 'PT409', detail = 'REFERENCE_MISMATCH';
  end if;
  if v_order.currency <> 'COP' then
    raise exception 'Order currency is not COP'
      using errcode = 'PT409', detail = 'CURRENCY_MISMATCH';
  end if;
  if p_amount_cents <> v_order.total_cents then
    raise exception 'Payment amount does not match the order total'
      using errcode = 'PT409', detail = 'AMOUNT_MISMATCH';
  end if;

  if v_tx_id is not null then
    select * into v_payment
    from public.payments
    where wompi_transaction_id = v_tx_id
       or provider_transaction_id = v_tx_id
    for update;
    if v_payment.id is not null and v_payment.wompi_reference <> p_wompi_reference then
      raise exception 'Payment transaction is already recorded under a different reference'
        using errcode = 'PT409', detail = 'REFERENCE_MISMATCH';
    end if;
  end if;

  if v_payment.id is null then
    select * into v_payment
    from public.payments
    where wompi_reference = p_wompi_reference
       or provider_reference = p_wompi_reference
    for update;

    if v_payment.id is not null and v_payment.order_id <> v_order.id then
      raise exception 'Payment reference belongs to a different order'
        using errcode = 'PT409', detail = 'REFERENCE_MISMATCH';
    end if;
    if v_payment.id is not null
       and v_tx_id is not null
       and coalesce(v_payment.provider_transaction_id, v_payment.wompi_transaction_id) is not null
       and coalesce(v_payment.provider_transaction_id, v_payment.wompi_transaction_id) <> v_tx_id then
      raise exception 'Payment reference is already attached to a different transaction'
        using errcode = 'PT409', detail = 'REFERENCE_MISMATCH';
    end if;
  end if;

  if v_payment.id is null then
    if p_wompi_reference = v_order.reference then
      v_attempt := 1;
    else
      v_attempt := nullif(
        regexp_replace(p_wompi_reference, '^' || v_order.reference || '-', ''), ''
      )::integer;
    end if;

    select coalesce(max(attempt), 0) + 1 into v_max_attempt
    from public.payments where order_id = v_order.id;

    if v_attempt is null or v_attempt < 1 then
      raise exception 'Payment attempt cannot be derived from the reference'
        using errcode = 'PT409', detail = 'REFERENCE_MISMATCH';
    end if;

    insert into public.payments (
      order_id, attempt, payment_provider, wompi_reference, provider_reference,
      wompi_transaction_id, provider_transaction_id, status,
      raw_wompi_status, raw_provider_status, amount_cents, currency,
      payment_method_type, status_message, provider_payload
    ) values (
      v_order.id, v_attempt, v_provider, p_wompi_reference, p_wompi_reference,
      v_tx_id, v_tx_id, v_normalized,
      nullif(v_incoming_raw, ''), nullif(v_incoming_raw, ''),
      p_amount_cents, v_order.currency,
      nullif(btrim(coalesce(p_payment_method_type, '')), ''),
      nullif(btrim(coalesce(p_status_message, '')), ''),
      p_provider_payload
    )
    returning * into v_payment;
    v_new_payment := true;
    v_status_changed := true;
  else
    v_previous := v_payment.status;
    v_raw_changed := coalesce(v_payment.raw_provider_status, v_payment.raw_wompi_status)
                     is distinct from nullif(v_incoming_raw, '');

    if v_previous in ('approved'::public.payment_status,
                      'refunded'::public.payment_status) then
      if v_normalized = 'voided'::public.payment_status
         and v_payment.approved_at is not null then
        v_payment.status := 'refunded'::public.payment_status;
      end if;
    elsif v_normalized <> 'unknown'::public.payment_status
          and app_private.payment_transition_rank(v_normalized)
              > app_private.payment_transition_rank(v_previous) then
      v_payment.status := v_normalized;
    end if;

    v_status_changed := v_payment.status <> v_previous;
    v_payment.raw_wompi_status := nullif(v_incoming_raw, '');
    v_payment.raw_provider_status := nullif(v_incoming_raw, '');
    v_payment.payment_provider := v_provider;
    v_payment.payment_method_type := coalesce(
      nullif(btrim(coalesce(p_payment_method_type, '')), ''), v_payment.payment_method_type
    );
    v_payment.status_message := coalesce(
      nullif(btrim(coalesce(p_status_message, '')), ''), v_payment.status_message
    );
    v_payment.wompi_transaction_id := coalesce(v_tx_id, v_payment.wompi_transaction_id);
    v_payment.provider_transaction_id := coalesce(v_tx_id, v_payment.provider_transaction_id);
    if p_provider_payload is not null then
      v_payment.provider_payload := p_provider_payload;
    end if;
  end if;

  if v_payment.status in ('approved'::public.payment_status,
                          'refunded'::public.payment_status)
     and v_payment.approved_at is null then
    v_payment.approved_at := v_now;
  end if;

  if v_payment.status <> 'pending'::public.payment_status then
    v_payment.finalized_at := coalesce(v_payment.finalized_at, v_now);
  end if;

  update public.payments
     set status = v_payment.status,
         payment_provider = v_payment.payment_provider,
         raw_wompi_status = v_payment.raw_wompi_status,
         raw_provider_status = v_payment.raw_provider_status,
         wompi_transaction_id = v_payment.wompi_transaction_id,
         provider_transaction_id = v_payment.provider_transaction_id,
         provider_reference = coalesce(v_payment.provider_reference, v_payment.wompi_reference),
         payment_method_type = v_payment.payment_method_type,
         status_message = v_payment.status_message,
         provider_payload = v_payment.provider_payload,
         approved_at = v_payment.approved_at,
         finalized_at = v_payment.finalized_at
   where id = v_payment.id
  returning * into v_payment;

  v_approved := v_payment.status = 'approved'::public.payment_status;

  -- An ePayco reversal of a payment that was already approved: recorded as refunded above,
  -- but the PAID order and inventory are deliberately left untouched; reported for manual
  -- review instead of as a plain update.
  if v_provider = 'epayco'
     and upper(v_incoming_raw) in ('6', 'REVERSADA')
     and v_previous = 'approved'::public.payment_status
     and v_payment.status = 'refunded'::public.payment_status
     and v_status_changed then
    update public.payments
       set status_message = 'Reversed by ePayco after approval; order ' || v_order.reference
                            || ' was left unchanged; manual review required'
     where id = v_payment.id
    returning * into v_payment;

    return jsonb_build_object(
      'result', 'RECONCILIATION_REQUIRED',
      'orderId', v_order.id,
      'orderReference', v_order.reference,
      'orderStatus', v_order.status,
      'paymentId', v_payment.id,
      'paymentStatus', v_payment.status,
      'paymentProvider', v_payment.payment_provider,
      'providerReference', v_payment.provider_reference,
      'providerTransactionId', v_payment.provider_transaction_id,
      'rawProviderStatus', v_payment.raw_provider_status,
      'rawWompiStatus', v_payment.raw_wompi_status,
      'paymentAttempt', v_payment.attempt,
      'wompiReference', v_payment.wompi_reference,
      'wompiTransactionId', v_payment.wompi_transaction_id,
      'amountInCents', v_payment.amount_cents,
      'currency', v_payment.currency,
      'ticketsIssued', 0,
      'ticketsExpected', 0,
      'reconciliationRequired', true,
      'reason', 'PAYMENT_REVERSED_AFTER_APPROVAL'
    );
  end if;

  if not v_approved then
    if v_payment.status in ('declined'::public.payment_status,
                            'voided'::public.payment_status,
                            'refunded'::public.payment_status,
                            'error'::public.payment_status)
       and v_order.status = 'PENDING' then
      update public.orders
         set status = 'FAILED', failed_at = coalesce(failed_at, v_now)
       where id = v_order.id
      returning * into v_order;
    end if;

    return jsonb_build_object(
      'result', case
        when v_new_payment or v_status_changed or v_raw_changed then 'APPLIED'
        else 'DUPLICATE' end,
      'orderId', v_order.id,
      'orderReference', v_order.reference,
      'orderStatus', v_order.status,
      'paymentId', v_payment.id,
      'paymentStatus', v_payment.status,
      'paymentProvider', v_payment.payment_provider,
      'providerReference', v_payment.provider_reference,
      'providerTransactionId', v_payment.provider_transaction_id,
      'rawProviderStatus', v_payment.raw_provider_status,
      'rawWompiStatus', v_payment.raw_wompi_status,
      'paymentAttempt', v_payment.attempt,
      'wompiReference', v_payment.wompi_reference,
      'wompiTransactionId', v_payment.wompi_transaction_id,
      'amountInCents', v_payment.amount_cents,
      'currency', v_payment.currency,
      'ticketsIssued', 0,
      'ticketsExpected', 0,
      'reconciliationRequired', false,
      'reason', case
        when v_normalized = 'unknown'::public.payment_status
          then 'UNKNOWN_PROVIDER_STATUS'
        when v_payment.status = 'pending'::public.payment_status then 'PAYMENT_PENDING'
        when v_payment.status = 'unknown'::public.payment_status then 'UNKNOWN_PROVIDER_STATUS'
        else 'PAYMENT_' || upper(v_payment.status::text)
      end
    );
  end if;

  if v_order.status not in ('PENDING', 'FAILED', 'PAID') then
    update public.payments
       set status_message = 'Approved after the order became ' || v_order.status
                            || '; manual reconciliation required'
     where id = v_payment.id
    returning * into v_payment;

    return jsonb_build_object(
      'result', 'RECONCILIATION_REQUIRED',
      'orderId', v_order.id,
      'orderReference', v_order.reference,
      'orderStatus', v_order.status,
      'paymentId', v_payment.id,
      'paymentStatus', v_payment.status,
      'paymentProvider', v_payment.payment_provider,
      'providerReference', v_payment.provider_reference,
      'providerTransactionId', v_payment.provider_transaction_id,
      'rawProviderStatus', v_payment.raw_provider_status,
      'rawWompiStatus', v_payment.raw_wompi_status,
      'paymentAttempt', v_payment.attempt,
      'wompiReference', v_payment.wompi_reference,
      'wompiTransactionId', v_payment.wompi_transaction_id,
      'amountInCents', v_payment.amount_cents,
      'currency', v_payment.currency,
      'ticketsIssued', 0,
      'ticketsExpected', 0,
      'reconciliationRequired', true,
      'reason', 'ORDER_NOT_PAYABLE_' || v_order.status::text
    );
  end if;

  -- Inventory: reserved -> sold from order_items (NOT from tickets). Guarded by the PENDING/
  -- FAILED status and the PAID flip in the same block, so a replay (order already PAID) skips
  -- it. Unchanged from the ticket era.
  if v_order.status in ('PENDING', 'FAILED') then
    update public.pricing_tiers t
       set quantity_reserved = greatest(t.quantity_reserved - r.quantity, 0),
           quantity_sold = t.quantity_sold + r.quantity
      from (
        select oi.pricing_tier_id as tier_id, sum(oi.quantity)::integer as quantity
          from public.order_items oi
         where oi.order_id = v_order.id
         group by oi.pricing_tier_id
      ) r
     where t.id = r.tier_id;

    update public.orders
       set status = 'PAID', paid_at = coalesce(orders.paid_at, v_now)
     where id = v_order.id
    returning * into v_order;
  end if;

  -- Tickets are discontinued: no ticket rows, tokens or QR are generated. `ticketsExpected`
  -- is kept in the result (unit count) only for backward-compatible callers; it never drives
  -- ticket creation. The buyer's data reaches Google Sheets through the participant outbox.
  select coalesce(sum(oi.quantity), 0)::integer into v_expected
    from public.order_items oi
   where oi.order_id = v_order.id;

  if v_order.status = 'PAID' then
    perform app_private.enqueue_participant_projection(p.id, p.event_id)
      from public.participants p
     where p.order_id = v_order.id;
  end if;

  return jsonb_build_object(
    'result', case
      when v_new_payment or v_status_changed or v_raw_changed
        then 'APPLIED'
      else 'DUPLICATE' end,
    'orderId', v_order.id,
    'orderReference', v_order.reference,
    'orderStatus', v_order.status,
    'paymentId', v_payment.id,
    'paymentStatus', v_payment.status,
    'paymentProvider', v_payment.payment_provider,
    'providerReference', v_payment.provider_reference,
    'providerTransactionId', v_payment.provider_transaction_id,
    'rawProviderStatus', v_payment.raw_provider_status,
    'rawWompiStatus', v_payment.raw_wompi_status,
    'paymentAttempt', v_payment.attempt,
    'wompiReference', v_payment.wompi_reference,
    'wompiTransactionId', v_payment.wompi_transaction_id,
    'amountInCents', v_payment.amount_cents,
    'currency', v_payment.currency,
    'ticketsIssued', 0,
    'ticketsExpected', v_expected,
    'reconciliationRequired', false,
    'reason', 'PAYMENT_APPROVED'
  );
end;
$confirm$;

-- =============================================================================
-- 2. Participant-keyed Sheets outbox (one row per participant). Mirrors the
--    legacy per-ticket outbox mechanics (QUEUED/SYNCING/SYNCED/FAILED, backoff,
--    SKIP LOCKED claim, optimistic finish) but keyed on participant_id.
-- =============================================================================
create table public.sheets_participant_projections (
  participant_id uuid primary key references public.participants (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete restrict,
  status public.sheets_projection_status not null default 'QUEUED',
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  last_error text
    check (last_error is null or length(last_error) <= 500),
  last_synced_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sheets_participant_projections is
  'Outbox of pending Google Sheets projections: one row per participant, enqueued when the order is PAID and on later participant edits. Read-only projection; a Google outage cannot affect payments.';

create index sheets_participant_projections_due_idx
  on public.sheets_participant_projections (next_attempt_at)
  where status in ('QUEUED', 'FAILED');

create trigger sheets_participant_projections_set_updated_at
  before update on public.sheets_participant_projections
  for each row execute function app_private.set_updated_at();

alter table public.sheets_participant_projections enable row level security;

create or replace function app_private.enqueue_participant_projection(
  p_participant_id uuid,
  p_event_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $enqueue$
begin
  -- One row per participant: every change collapses into the same logical event. A row the
  -- worker is writing (SYNCING) is reset to QUEUED so the newer state is projected next run.
  insert into public.sheets_participant_projections as sp (participant_id, event_id, status)
  values (p_participant_id, p_event_id, 'QUEUED')
  on conflict (participant_id) do update
    set event_id = excluded.event_id,
        status = 'QUEUED',
        attempt_count = 0,
        last_error = null,
        next_attempt_at = now(),
        updated_at = now();
end;
$enqueue$;

comment on function app_private.enqueue_participant_projection(uuid, uuid) is
  'Enqueues (or re-queues) the Sheets projection of one participant. Idempotent.';

-- Re-queue a participant on later edits, but ONLY once its order is PAID (buyer data is
-- synced only for paid orders). Pre-payment participant inserts/edits do not enqueue; the
-- PAID transition in confirm_payment performs the initial enqueue.
create or replace function app_private.sheets_enqueue_participant_paid()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $trgpart$
begin
  if exists (
    select 1 from public.orders o
     where o.id = new.order_id and o.status = 'PAID'
  ) then
    perform app_private.enqueue_participant_projection(new.id, new.event_id);
  end if;
  return null;
end;
$trgpart$;

create trigger participants_enqueue_participant_projection
  after insert or update on public.participants
  for each row execute function app_private.sheets_enqueue_participant_paid();

create or replace function public.claim_participant_sheet_projections(
  p_limit integer default 50,
  p_now timestamptz default now(),
  p_stale_after_seconds integer default 900,
  p_max_attempts integer default 6
)
returns setof public.sheets_participant_projections
language plpgsql
security invoker
set search_path = ''
as $claim$
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
    select sp.participant_id
      from public.sheets_participant_projections sp
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
  update public.sheets_participant_projections sp
     set status = 'SYNCING',
         attempt_count = sp.attempt_count + 1,
         next_attempt_at = null
    from candidate c
   where sp.participant_id = c.participant_id
  returning sp.*;
end;
$claim$;

comment on function public.claim_participant_sheet_projections(integer, timestamptz, integer, integer) is
  'Claims up to p_limit due participant projection rows (SKIP LOCKED, stale SYNCING reclaimable) and increments their attempt counter.';

create or replace function public.finish_participant_sheet_projections(
  p_participant_ids uuid[],
  p_status public.sheets_projection_status,
  p_error text default null,
  p_next_attempt_at timestamptz default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $finish$
declare
  v_updated integer := 0;
begin
  if p_status not in ('SYNCED'::public.sheets_projection_status,
                      'FAILED'::public.sheets_projection_status) then
    raise exception 'A finished projection must be SYNCED or FAILED'
      using errcode = 'PT400', detail = 'INVALID_PROJECTION_STATUS';
  end if;

  update public.sheets_participant_projections
     set status = p_status,
         last_error = case when p_status = 'FAILED'
                           then nullif(left(btrim(coalesce(p_error, '')), 500), '')
                           else null end,
         last_synced_at = case when p_status = 'SYNCED' then p_now else last_synced_at end,
         next_attempt_at = case when p_status = 'FAILED' then p_next_attempt_at else null end
   where participant_id = any(p_participant_ids)
     and status = 'SYNCING';
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'recordCount', coalesce(array_length(p_participant_ids, 1), 0),
    'updatedCount', v_updated,
    'status', p_status
  );
end;
$finish$;

comment on function public.finish_participant_sheet_projections(uuid[], public.sheets_projection_status, text, timestamptz, timestamptz) is
  'Records the outcome of a sync for the claimed participants. Only rows still SYNCING are updated.';

create or replace function public.participant_sheet_projection_stats()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $stats$
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
    from public.sheets_participant_projections sp;

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
$stats$;

comment on function public.participant_sheet_projection_stats() is
  'Counts per participant projection status plus the last successful sync instant.';

-- =============================================================================
-- 3. operational_export: re-grained to ONE ROW PER PARTICIPANT, PAID orders
--    only. Column shape is preserved so the Sheets formatter is unchanged;
--    ticket-only columns (entry code, ticket status, attendance) are NULL.
-- =============================================================================
drop view if exists public.operational_export;

create view public.operational_export
with (security_invoker = true)
as
select
  e.code as "Evento",
  null::text as "Código de entrada",
  p.first_name as "Nombre",
  p.last_name as "Apellido",
  p.national_id as "Cédula",
  p.email as "Correo",
  p.phone as "Teléfono",
  p.city as "Ciudad",
  p.instagram as "Instagram",
  tt.name as "Tipo de entrada",
  pt.name as "Etapa de venta",
  case when oi.quantity > 0
       then (oi.line_total_cents / oi.quantity)::bigint
       else oi.line_total_cents end as "Precio centavos",
  o.currency as "Moneda",
  o.reference as "Referencia de la orden",
  o.status as "Estado de la orden",
  pay.status as "Estado del pago",
  pay.raw_wompi_status as "Estado Wompi",
  null::text as "Estado de la entrada",
  null::boolean as "Ingreso",
  null::timestamptz as "Fecha de ingreso",
  dp.granted as "Autorización de datos",
  dp.policy_version as "Autorización de datos versión",
  dp.captured_at as "Autorización de datos fecha",
  fe.granted as "Autorización próximos eventos",
  p.created_at as "Creada"
from public.participants p
join public.orders o
  on o.id = p.order_id
join public.events e
  on e.id = p.event_id
-- order_item gives the sales stage / ticket type the buyer purchased for this participant.
left join public.order_items oi
  on oi.id = p.order_item_id
left join public.ticket_types tt
  on tt.id = oi.ticket_type_id
left join public.pricing_tiers pt
  on pt.id = oi.pricing_tier_id
-- Latest meaningful payment attempt: approved when it exists, else most recent.
left join lateral (
  select p2.status, p2.raw_wompi_status
    from public.payments p2
   where p2.order_id = o.id
   order by (p2.status = 'approved') desc, p2.attempt desc
   limit 1
) pay on true
left join lateral (
  select c.granted, c.policy_version, c.captured_at
    from public.consents c
   where c.participant_id = p.id
     and c.kind = 'DATA_PROCESSING'
   order by c.captured_at desc, c.id desc
   limit 1
) dp on true
left join lateral (
  select c.granted
    from public.consents c
   where c.participant_id = p.id
     and c.kind = 'FUTURE_EVENTS'
   order by c.captured_at desc, c.id desc
   limit 1
) fe on true
-- Only PAID orders are projected to the sheet.
where o.status = 'PAID'
order by p.created_at, p.id;

comment on view public.operational_export is
  'Operational read model for the Google Sheets sync: one row per participant of a PAID order, with buyer, order, payment and consent data. Tickets are discontinued, so entry code / ticket status / attendance columns are always null. Contains personal data; readable only by the service role.';

-- Re-apply the access model the dropped view had: revoke from API roles, grant to service_role.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table public.operational_export from %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.operational_export to service_role';
  end if;
end;
$$;

-- =============================================================================
-- 4. Grants on the new participant projection functions (mirror the legacy
--    sheet-projection grants: service_role only).
-- =============================================================================
-- app_private helpers are backend-only: strip PUBLIC's default EXECUTE (browser-facing roles
-- must hold no EXECUTE on any backend function), mirroring migration 20261004130000.
revoke all on function app_private.enqueue_participant_projection(uuid, uuid) from public;
revoke all on function app_private.sheets_enqueue_participant_paid() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.claim_participant_sheet_projections(integer, timestamptz, integer, integer) from public';
    execute 'revoke all on function public.finish_participant_sheet_projections(uuid[], public.sheets_projection_status, text, timestamptz, timestamptz) from public';
    execute 'revoke all on function public.participant_sheet_projection_stats() from public';
    execute 'grant execute on function public.claim_participant_sheet_projections(integer, timestamptz, integer, integer) to service_role';
    execute 'grant execute on function public.finish_participant_sheet_projections(uuid[], public.sheets_projection_status, text, timestamptz, timestamptz) to service_role';
    execute 'grant execute on function public.participant_sheet_projection_stats() to service_role';
    -- The backend role calls the app_private enqueue helper inside confirm_payment (security
    -- invoker) and the participant trigger, mirroring migration 20261004140000's grant on the
    -- legacy enqueue_sheet_projection. Browser roles keep no EXECUTE (revoked from public above).
    execute 'grant execute on function app_private.enqueue_participant_projection(uuid, uuid) to service_role';
    execute 'grant execute on function app_private.sheets_enqueue_participant_paid() to service_role';
  end if;
end;
$$;

-- =============================================================================
-- 5. Stop feeding the legacy per-ticket outbox. The legacy tables and the
--    sheets_projections outbox are kept for a separately reviewed cleanup, but
--    their enqueue triggers are removed so no new ticket-keyed rows appear.
--    Purchases create no tickets, so these triggers would be no-ops anyway;
--    dropping them makes the new participant pipeline the only source of truth.
-- =============================================================================
drop trigger if exists tickets_enqueue_sheet_projection on public.tickets;
drop trigger if exists participants_enqueue_sheet_projection on public.participants;
drop trigger if exists attendance_enqueue_sheet_projection on public.attendance;
drop trigger if exists consents_enqueue_sheet_projection on public.consents;
