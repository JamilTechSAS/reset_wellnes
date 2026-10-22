-- ---------------------------------------------------------------------------
-- Migration 20261003210011_payment_confirmation
-- Phase 4 / part 2 of 2: the confirmation pipeline itself.
--
-- Companion to 20261003210010, which only adds `refunded` to `payment_status`
-- (PostgreSQL cannot consume an enum value in the same transaction that adds it, and
-- the migration runner wraps each file in one transaction).
--
--   tickets         order_item_seq — one row per purchased UNIT (see below)
--   confirmation    confirm_payment (payment + order + inventory + tickets, atomic)
--   outbox          queue_ticket_emails / claim_email_deliveries / finish_email_delivery
--   lifecycle       expire_pending_orders / retry_payment
--   read model      get_order_status
--
-- Every function is SECURITY INVOKER with `set search_path = ''`; EXECUTE is revoked
-- from PUBLIC and granted to `service_role` only — including `get_order_status`,
-- because an order reference is an identifier, not a credential.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Ticket per purchased unit: `order_item_seq`
-- ---------------------------------------------------------------------------
-- Phase 3 records ONE participant per purchase while an order line can carry several
-- units (quantity > 1). Ticket issuance must still be exactly one ticket per unit —
-- "quantity = 3 means tickets 1, 2 and 3" — so a ticket needs an identity that does not
-- depend on a participant existing yet.
--
-- `order_item_seq` is that identity: the 1-based unit number inside the order line.
-- `unique (order_item_id, order_item_seq)` is what makes issuance exactly-once at the
-- database level: a replayed webhook inserts `on conflict do nothing` and cannot create
-- a second ticket for a unit, no matter how many times or how concurrently it runs.
--
-- A ticket without a participant is legal (the schema already allowed it: Phase 2
-- "a ticket may be issued before the buyer assigns a person to it"). The confirmation
-- attaches the participants that exist, in order, to the first units; the remaining
-- units stay unassigned and can be attached before check-in. That gap is intentional
-- and documented in docs/data-model.md.
--
-- The default of 1 exists so the column can be added to a table that already has rows.
-- No environment has ticket rows yet (the project has never been deployed), and a
-- future migration can drop the default once the seed data is regenerated.
alter table public.tickets
  add column order_item_seq integer not null default 1
  check (order_item_seq >= 1);

create unique index tickets_order_item_seq_idx
  on public.tickets (order_item_id, order_item_seq);

comment on column public.tickets.order_item_seq is
  '1-based unit number of this ticket inside its order line. `unique (order_item_id, order_item_seq)` is the database guarantee that a replayed webhook cannot issue a second ticket for the same purchased unit.';

comment on index public.tickets_order_item_seq_idx is
  'Exactly-once ticket issuance: one ticket per (order line, unit number), enforced by the database rather than by counting in application code.';

-- ---------------------------------------------------------------------------
-- 2. Forward-only ranking for payment status
-- ---------------------------------------------------------------------------
-- The Phase 1 rule ("terminal statuses never regress") is enforced in the database as
-- well, because the webhook path is the one place where an out-of-order delivery could
-- otherwise move an approved payment backwards.
--
--   pending(0) < approved(1) < refunded(2) < voided(3) < declined(4) < error(5)
--
-- `unknown` is ranked 0 (it never advances anything) and is handled explicitly by the
-- caller: recorded in `raw_wompi_status`, never allowed to overwrite `status`.
create or replace function app_private.payment_transition_rank(p_status public.payment_status)
returns integer
language sql
immutable
set search_path = ''
as $rank$
  select case p_status
    when 'pending'  then 0
    when 'unknown'  then 0
    when 'approved' then 1
    when 'refunded' then 2
    when 'voided'   then 3
    when 'declined' then 4
    when 'error'    then 5
  end;
$rank$;

comment on function app_private.payment_transition_rank(public.payment_status) is
  'Total order over payment_status used to make payment transitions forward-only. Higher rank wins; a lower-ranked status can never overwrite a higher one.';

-- ---------------------------------------------------------------------------
-- 2b. `approved_at` may now coexist with `refunded`
-- ---------------------------------------------------------------------------
-- Phase 3 constrained `approved_at` to the statuses ('approved', 'voided'): an attempt
-- that was never approved cannot carry an approval timestamp, and voiding was the only
-- way an approved attempt could end. Phase 4 adds `refunded` — an approved attempt that
-- Wompi later voided — so the constraint is widened to keep the same rule with the new
-- status. The approval stays a historical fact; no refund is invented from it.
alter table public.payments
  drop constraint payments_approved_at_check;

alter table public.payments
  add constraint payments_approved_at_check
  check (approved_at is null or status in ('approved', 'voided', 'refunded'));

-- Supports the "which events were received but never finished?" reconciliation query.
create index payment_events_unprocessed_idx
  on public.payment_events (received_at)
  where processed_at is null;

-- Ticket issuance counts the units already issued for an order line; without this index
-- that count would scan the whole tickets table on every webhook.
create index tickets_order_item_idx on public.tickets (order_item_id);

-- ---------------------------------------------------------------------------
-- 3. Webhook event ledger: claim / finalize / reject
-- ---------------------------------------------------------------------------
-- The unique `dedupe_key` is the idempotency gate. `claim` inserts and reports whether
-- the caller won; a concurrent second caller loses the unique violation and gets
-- `claimed = false` plus the existing row's state. It NEVER throws on a duplicate: the
-- webhook endpoint must answer 200 to a redelivery.
create or replace function public.claim_webhook_event(
  p_dedupe_key text,
  p_event_name text,
  p_wompi_transaction_id text default null,
  p_checksum_valid boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $claim$
declare
  v_event public.payment_events;
begin
  if p_dedupe_key is null or p_dedupe_key !~ '^[!-~]{16,200}$' then
    raise exception 'Webhook dedupe key is missing or malformed'
      using errcode = 'PT400', detail = 'INVALID_DEDUPE_KEY';
  end if;
  if p_event_name is null
     or length(btrim(p_event_name)) not between 1 and 120
     or p_event_name ~ '[\n\r\t]' then
    raise exception 'Webhook event name is missing or malformed'
      using errcode = 'PT400', detail = 'INVALID_EVENT_NAME';
  end if;

  insert into public.payment_events (
    dedupe_key, wompi_event_name, wompi_transaction_id, checksum_valid
  ) values (
    p_dedupe_key, btrim(p_event_name), nullif(btrim(coalesce(p_wompi_transaction_id, '')), ''),
    p_checksum_valid
  )
  on conflict (dedupe_key) do nothing
  returning * into v_event;

  if v_event.id is not null then
    return jsonb_build_object(
      'claimed', true,
      'eventId', v_event.id,
      'result', null,
      'processedAt', null,
      'httpStatus', null
    );
  end if;

  -- Lost the race (or a true redelivery): report the winner's state instead of failing.
  select * into v_event from public.payment_events where dedupe_key = p_dedupe_key;

  return jsonb_build_object(
    'claimed', false,
    'eventId', v_event.id,
    'result', v_event.result,
    'processedAt', to_char(v_event.processed_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'httpStatus', v_event.http_status
  );
end;
$claim$;

comment on function public.claim_webhook_event(text, text, text, boolean) is
  'Atomic webhook deduplication: inserts the event identity and reports whether this caller owns it. A duplicate (or a concurrent loser) is reported, never raised, so the endpoint can answer 200 without reprocessing.';

-- Records the outcome of one delivery. Only the caller that owns the event may finalize
-- it; a concurrent loser that tries anyway is refused rather than allowed to overwrite
-- the winner's decision.
create or replace function public.finalize_webhook_event(
  p_event_id uuid,
  p_result public.payment_event_result,
  p_http_status integer,
  p_payment_id uuid default null,
  p_error_code text default null,
  p_wompi_transaction_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $finalize$
declare
  v_event public.payment_events;
begin
  update public.payment_events
     set processed_at = now(),
         result = p_result,
         http_status = p_http_status,
         payment_id = coalesce(p_payment_id, payment_id),
         error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
         wompi_transaction_id = coalesce(
           nullif(btrim(coalesce(p_wompi_transaction_id, '')), ''), wompi_transaction_id
         )
   where id = p_event_id
     and processed_at is null
  returning * into v_event;

  if v_event.id is null then
    select * into v_event from public.payment_events where id = p_event_id;
    return jsonb_build_object(
      'finalized', false,
      'eventId', p_event_id,
      'result', v_event.result,
      'processedAt', to_char(v_event.processed_at at time zone 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;

  return jsonb_build_object(
    'finalized', true,
    'eventId', v_event.id,
    'result', v_event.result,
    'processedAt', to_char(v_event.processed_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$finalize$;

comment on function public.finalize_webhook_event(uuid, public.payment_event_result, integer, uuid, text, text) is
  'Marks a claimed webhook event as processed exactly once. A second finalize is reported (finalized = false) instead of overwriting the recorded outcome.';

-- Unauthentic deliveries are recorded too: they are a security signal, and the ledger
-- must show that something tried to impersonate Wompi. `checksum_valid` is false.
create or replace function public.record_webhook_rejection(
  p_dedupe_key text,
  p_event_name text,
  p_http_status integer,
  p_error_code text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $reject$
declare
  v_event_id uuid;
  v_existing uuid;
begin
  if p_dedupe_key is null or p_dedupe_key !~ '^[!-~]{16,200}$' then
    raise exception 'Webhook dedupe key is missing or malformed'
      using errcode = 'PT400', detail = 'INVALID_DEDUPE_KEY';
  end if;

  select id into v_existing from public.payment_events where dedupe_key = p_dedupe_key;
  if v_existing is not null then
    return jsonb_build_object('eventId', v_existing, 'recorded', false);
  end if;

  insert into public.payment_events (
    dedupe_key, wompi_event_name, checksum_valid, processed_at, result, http_status, error_code
  ) values (
    p_dedupe_key,
    btrim(coalesce(nullif(p_event_name, ''), 'unknown')),
    false,
    now(),
    'REJECTED',
    p_http_status,
    nullif(btrim(coalesce(p_error_code, '')), '')
  )
  returning id into v_event_id;

  return jsonb_build_object('eventId', v_event_id, 'recorded', true);
end;
$reject$;

comment on function public.record_webhook_rejection(text, text, integer, text) is
  'Append-only record of a webhook delivery we refused (bad checksum, malformed payload). Never marks anything as paid; exists so spoofing attempts are auditable.';

-- ---------------------------------------------------------------------------
-- 4. confirm_payment — the heart of Phase 4
-- ---------------------------------------------------------------------------
-- One transaction: payment row (find or create), forward-only status transition, order
-- transition, inventory reserved -> sold, and ticket issuance. Amount and currency are
-- validated here as well as in TypeScript; the database check is the last line of
-- defence and the only one a caller bug cannot bypass.
--
-- ORDER STATE ON APPROVAL
-- -----------------------
--   PENDING  -> PAID   normal path.
--   FAILED   -> PAID   the reservation is still held (a failed attempt does not release
--                      it, so the buyer can retry), and a verified approval means the
--                      money did arrive. Recording it as PAID is the honest outcome.
--   already PAID       idempotent: no new tickets, no new email, result DUPLICATE.
--   CANCELLED / EXPIRED -> RECONCILIATION_REQUIRED. The inventory is gone and the order
--                      is terminal, so the order is NOT revived and NO refund is
--                      invented: the payment is recorded as approved, the message
--                      explains the situation, and a human decides. The API turns this
--                      into result APPLIED + reconciliationRequired = true.
--
-- TICKET ISSUANCE
-- ---------------
--   for each order line: for unit in 1..quantity
--     insert ticket (order_item_id, order_item_seq = unit) on conflict do nothing
--   and attach the line's participants, in creation order, to units 1..n.
--   `unique (order_item_id, order_item_seq)` is the guarantee; the participant lookup
--   excludes participants that already own a ticket, so a replay maps unit 1 to another
--   participant only if there is one — never to the same one twice.
create or replace function public.confirm_payment(
  p_order_reference text,
  p_wompi_reference text,
  p_wompi_transaction_id text,
  p_wompi_status text,
  p_amount_cents bigint,
  p_currency text,
  p_payment_method_type text default null,
  p_status_message text default null,
  p_provider_payload jsonb default null
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
  v_issued integer := 0;
  v_expected integer := 0;
  v_unit integer;
  v_raw_changed boolean := false;
  v_unit_price bigint := 0;
  v_unit_remainder bigint := 0;
  v_affected integer := 0;
  v_line record;
  v_new_payment boolean := false;
  v_status_changed boolean := false;
  v_approved boolean := false;
begin
  v_incoming_raw := btrim(coalesce(p_wompi_status, ''));
  v_normalized := case upper(v_incoming_raw)
    when 'PENDING'  then 'pending'::public.payment_status
    when 'APPROVED' then 'approved'::public.payment_status
    when 'DECLINED' then 'declined'::public.payment_status
    when 'VOIDED'   then 'voided'::public.payment_status
    when 'ERROR'    then 'error'::public.payment_status
    else 'unknown'::public.payment_status
  end;

  -- -------------------------------------------------------------------------
  -- Input validation. These are programming errors in the caller, not client
  -- input: the backend has already validated the transaction against Wompi.
  -- -------------------------------------------------------------------------
  if p_order_reference is null or length(btrim(p_order_reference)) = 0 then
    raise exception 'Order reference is required'
      using errcode = 'PT400', detail = 'MISSING_ORDER_REFERENCE';
  end if;
  if p_wompi_reference is null or length(btrim(p_wompi_reference)) = 0 then
    raise exception 'Wompi reference is required'
      using errcode = 'PT400', detail = 'MISSING_REFERENCE';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'Wompi amount is missing or negative'
      using errcode = 'PT400', detail = 'INVALID_AMOUNT';
  end if;
  if upper(coalesce(p_currency, '')) <> 'COP' then
    raise exception 'Wompi currency is not COP'
      using errcode = 'PT409', detail = 'CURRENCY_MISMATCH';
  end if;
  if p_provider_payload is not null and jsonb_typeof(p_provider_payload) <> 'object' then
    raise exception 'Provider payload must be a JSON object'
      using errcode = 'PT400', detail = 'INVALID_PROVIDER_PAYLOAD';
  end if;

  -- Lock the order: the whole confirmation is serialized per order, which is what makes
  -- "one approval / one ticket set / one transition" true even when three identical
  -- events arrive at the same instant.
  select * into v_order
  from public.orders
  where reference = btrim(p_order_reference)
  for update;

  if v_order.id is null then
    raise exception 'Order reference is unknown'
      using errcode = 'PT404', detail = 'ORDER_NOT_FOUND';
  end if;

  -- The reference must belong to this order: either the order reference itself
  -- (attempt 1) or `<order reference>-<n>` (a later attempt).
  if p_wompi_reference <> v_order.reference
     and p_wompi_reference !~ ('^' || v_order.reference || '-[0-9]+$') then
    raise exception 'Wompi reference does not belong to this order'
      using errcode = 'PT409', detail = 'REFERENCE_MISMATCH';
  end if;
  if v_order.currency <> 'COP' then
    raise exception 'Order currency is not COP'
      using errcode = 'PT409', detail = 'CURRENCY_MISMATCH';
  end if;
  if p_amount_cents <> v_order.total_cents then
    raise exception 'Wompi amount does not match the order total'
      using errcode = 'PT409', detail = 'AMOUNT_MISMATCH';
  end if;

  -- The transaction id may already be attached to a payment row: reuse that row (the
  -- normal replay path) and refuse a reference that disagrees with it.
  if p_wompi_transaction_id is not null then
    select * into v_payment
    from public.payments
    where wompi_transaction_id = btrim(p_wompi_transaction_id)
    for update;
    if v_payment.id is not null and v_payment.wompi_reference <> p_wompi_reference then
      raise exception 'Wompi transaction is already recorded under a different reference'
        using errcode = 'PT409', detail = 'REFERENCE_MISMATCH';
    end if;
  end if;

  if v_payment.id is null then
    select * into v_payment
    from public.payments
    where wompi_reference = p_wompi_reference
    for update;

    if v_payment.id is not null and v_payment.order_id <> v_order.id then
      raise exception 'Wompi reference belongs to a different order'
        using errcode = 'PT409', detail = 'REFERENCE_MISMATCH';
    end if;
    if v_payment.id is not null
       and p_wompi_transaction_id is not null
       and v_payment.wompi_transaction_id is not null
       and v_payment.wompi_transaction_id <> btrim(p_wompi_transaction_id) then
      raise exception 'Wompi reference is already attached to a different transaction'
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
      order_id, attempt, wompi_reference, wompi_transaction_id, status,
      raw_wompi_status, amount_cents, currency, payment_method_type, status_message,
      provider_payload
    ) values (
      v_order.id, v_attempt, p_wompi_reference,
      nullif(btrim(coalesce(p_wompi_transaction_id, '')), ''), v_normalized,
      nullif(v_incoming_raw, ''), p_amount_cents, v_order.currency,
      nullif(btrim(coalesce(p_payment_method_type, '')), ''),
      nullif(btrim(coalesce(p_status_message, '')), ''),
      p_provider_payload
    )
    returning * into v_payment;
    v_new_payment := true;
    v_status_changed := true;
  else
    v_previous := v_payment.status;
    v_raw_changed := v_payment.raw_wompi_status is distinct from nullif(v_incoming_raw, '');

    -- Forward-only, with `approved` terminal for this attempt:
    --   * `unknown` is recorded but never advances the normalized status;
    --   * an approved (or already refunded) attempt only ever becomes `refunded`,
    --     which is what a later VOIDED means from the buyer's point of view;
    --   * otherwise the rank decides, so an out-of-order delivery can never regress.
    -- A later DECLINED or ERROR on an approved attempt is stored in `raw_wompi_status`
    -- only: Wompi never un-approves, and the approval timestamp is a historical fact.
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
    v_payment.payment_method_type := coalesce(
      nullif(btrim(coalesce(p_payment_method_type, '')), ''), v_payment.payment_method_type
    );
    v_payment.status_message := coalesce(
      nullif(btrim(coalesce(p_status_message, '')), ''), v_payment.status_message
    );
    v_payment.wompi_transaction_id := coalesce(
      nullif(btrim(coalesce(p_wompi_transaction_id, '')), ''), v_payment.wompi_transaction_id
    );
    if p_provider_payload is not null then
      v_payment.provider_payload := p_provider_payload;
    end if;
  end if;

  -- An approval is a historical fact with its own timestamp, recorded once.
  if v_payment.status in ('approved'::public.payment_status,
                          'refunded'::public.payment_status)
     and v_payment.approved_at is null then
    v_payment.approved_at := v_now;
  end if;

  -- A pending attempt is not finalized; anything else is.
  if v_payment.status <> 'pending'::public.payment_status then
    v_payment.finalized_at := coalesce(v_payment.finalized_at, v_now);
  end if;

  update public.payments
     set status = v_payment.status,
         raw_wompi_status = v_payment.raw_wompi_status,
         wompi_transaction_id = v_payment.wompi_transaction_id,
         payment_method_type = v_payment.payment_method_type,
         status_message = v_payment.status_message,
         provider_payload = v_payment.provider_payload,
         approved_at = v_payment.approved_at,
         finalized_at = v_payment.finalized_at
   where id = v_payment.id
  returning * into v_payment;

  v_approved := v_payment.status = 'approved'::public.payment_status;

  -- -------------------------------------------------------------------------
  -- Not approved: the order may fail, but it is never paid and no ticket exists.
  -- -------------------------------------------------------------------------
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

  -- -------------------------------------------------------------------------
  -- Approved, but the order can no longer be fulfilled: reconciliation path.
  -- -------------------------------------------------------------------------
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

  -- -------------------------------------------------------------------------
  -- Inventory: the units stop being reserved and become sold (once).
  -- -------------------------------------------------------------------------
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

  -- -------------------------------------------------------------------------
  -- Ticket issuance: exactly one ticket per purchased unit.
  -- -------------------------------------------------------------------------
  for v_line in
    select oi.id,
           oi.ticket_type_id,
           oi.quantity,
           greatest(oi.line_total_cents, 0) as line_total_cents
      from public.order_items oi
     where oi.order_id = v_order.id
     order by oi.created_at, oi.id
  loop
    v_expected := v_expected + v_line.quantity;
    v_unit_price := floor(v_line.line_total_cents / v_line.quantity);
    -- The last unit of the line absorbs the integer remainder, so the sum of
    -- `price_paid_cents` over the line equals the line total exactly.
    v_unit_remainder := v_line.line_total_cents - v_unit_price * v_line.quantity;

    for v_unit in 1..v_line.quantity loop
      insert into public.tickets (
        event_id, order_id, order_item_id, order_item_seq, participant_id,
        ticket_type_id, token, status, price_paid_cents, issued_at
      )
      select
        v_order.event_id, v_order.id, v_line.id, v_unit,
        -- The next still-unassigned participant of that line, in creation order. The
        -- filter already removes participants that own a ticket, so taking the first
        -- remaining one maps unit N to attendee N without any offset arithmetic.
        -- NULL when the buyer has not supplied that many participants yet.
        (select p.id
           from public.participants p
          where p.order_item_id = v_line.id
            and not exists (select 1 from public.tickets t where t.participant_id = p.id)
          order by p.created_at, p.id
          limit 1),
        v_line.ticket_type_id,
        -- Opaque public token, same shape as the Phase 1 generator (`TKT_` + 20
        -- Crockford base32 characters) and accepted by the same CHECK constraint.
        -- Built from Postgres core only, so it works on Supabase AND on PGlite without
        -- pgcrypto: a v4 UUID's random bits are squeezed into 15 bytes (120 bits) and
        -- base64-encoded to exactly 20 characters, then each character is translated
        -- into the Crockford alphabet (0-9, A-Z minus I, L, O, U). ~100 bits of CSPRNG
        -- entropy per ticket, no ambiguous glyphs, no sequential token to guess.
        'TKT_' || translate(
          upper(encode(substring(uuid_send(gen_random_uuid()) from 1 for 15), 'base64')),
          '+/=ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
        ),
        'ACTIVE',
        case when v_unit = v_line.quantity
             then v_unit_price + v_unit_remainder
             else v_unit_price end,
        v_now
      on conflict (order_item_id, order_item_seq) do nothing;

      get diagnostics v_affected = row_count;
      v_issued := v_issued + v_affected;
    end loop;
  end loop;

  return jsonb_build_object(
    'result', case
      when v_new_payment or v_status_changed or v_raw_changed or v_issued > 0
        then 'APPLIED'
      else 'DUPLICATE' end,
    'orderId', v_order.id,
    'orderReference', v_order.reference,
    'orderStatus', v_order.status,
    'paymentId', v_payment.id,
    'paymentStatus', v_payment.status,
    'rawWompiStatus', v_payment.raw_wompi_status,
    'paymentAttempt', v_payment.attempt,
    'wompiReference', v_payment.wompi_reference,
    'wompiTransactionId', v_payment.wompi_transaction_id,
    'amountInCents', v_payment.amount_cents,
    'currency', v_payment.currency,
    'ticketsIssued', v_issued,
    'ticketsExpected', v_expected,
    'reconciliationRequired', false,
    'reason', 'PAYMENT_APPROVED'
  );
end;
$confirm$;

comment on function public.confirm_payment(text, text, text, text, bigint, text, text, text, jsonb) is
  'Applies a verified Wompi transaction to its order in one transaction: validates reference/amount/currency, advances the payment forward-only, moves the order to PAID, converts reserved inventory into sold, and issues exactly one ticket per purchased unit. Duplicates and non-payable orders are reported, never forced.';

-- ---------------------------------------------------------------------------
-- 5. queue_ticket_emails — the outbox
-- ---------------------------------------------------------------------------
-- Runs inside the confirmation transaction (a rollback therefore leaves no queued
-- email) and is idempotent: the derived key `ticket:<id>:<template>` is unique, so a
-- second call inserts nothing.
--
-- Recipient: the ticket's participant when one is attached, otherwise the buyer. Both
-- are the same person in the normal case; the fallback exists because units beyond the
-- supplied participants have no attendee yet, and the buyer still needs the admission.
create or replace function public.queue_ticket_emails(
  p_order_id uuid,
  p_template text default 'TICKET_CONFIRMATION'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $queue$
declare
  v_inserted integer := 0;
  v_total integer := 0;
begin
  if p_template is null or p_template !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    raise exception 'Email template is malformed'
      using errcode = 'PT400', detail = 'INVALID_TEMPLATE';
  end if;

  with recipient as (
    select t.id as ticket_id,
           lower(coalesce(p.email, o.buyer_email)) as recipient_email
      from public.tickets t
      join public.orders o on o.id = t.order_id
      left join public.participants p on p.id = t.participant_id
     where t.order_id = p_order_id
  ),
  inserted as (
    insert into public.email_deliveries (
      ticket_id, template, idempotency_key, recipient_email, status
    )
    select r.ticket_id, p_template,
           'ticket:' || r.ticket_id::text || ':' || p_template,
           r.recipient_email, 'QUEUED'
      from recipient r
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select count(*) into v_inserted from inserted;

  select count(*) into v_total
    from public.email_deliveries d
   where d.template = p_template
     and d.ticket_id in (select id from public.tickets where order_id = p_order_id);

  return jsonb_build_object(
    'queued', v_inserted,
    'alreadyQueued', v_total - v_inserted,
    'total', v_total,
    'template', p_template
  );
end;
$queue$;

comment on function public.queue_ticket_emails(uuid, text) is
  'Inserts one outbox row per ticket (idempotency_key = ticket:<id>:<template>) inside the confirmation transaction. Duplicate calls insert nothing, so a repeated webhook can never queue a second confirmation email.';

-- ---------------------------------------------------------------------------
-- 6. Email outbox: claim and finish
-- ---------------------------------------------------------------------------
-- Claim uses `for update skip locked`, so two concurrent dispatchers never pick the same
-- row and a slow send cannot block the rest of the queue. A row stuck in SENDING for
-- longer than `p_stale_after_seconds` is considered abandoned (the worker died) and may
-- be reclaimed. The attempt ceiling is a parameter so the retry policy stays
-- configurable; the domain constant (5) is the documented value.
--
-- `next_attempt_at` is cleared on claim because the CHECK constraint only allows a
-- scheduled retry on QUEUED/FAILED rows.
create or replace function public.claim_email_deliveries(
  p_limit integer default 10,
  p_now timestamptz default now(),
  p_stale_after_seconds integer default 900,
  p_max_attempts integer default 5
)
returns setof public.email_deliveries
language plpgsql
security invoker
set search_path = ''
as $claimmail$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Claim limit must be between 1 and 100'
      using errcode = 'PT400', detail = 'INVALID_LIMIT';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Max attempts must be between 1 and 20'
      using errcode = 'PT400', detail = 'INVALID_MAX_ATTEMPTS';
  end if;

  return query
  with candidate as (
    select d.id
      from public.email_deliveries d
     where d.attempt_count < p_max_attempts
       and (
         (d.status in ('QUEUED', 'FAILED')
          and coalesce(d.next_attempt_at, d.queued_at) <= p_now)
         or (d.status = 'SENDING'
             and d.updated_at
                 <= p_now - make_interval(secs => greatest(p_stale_after_seconds, 60)))
       )
     order by coalesce(d.next_attempt_at, d.queued_at)
     limit p_limit
     for update skip locked
  )
  update public.email_deliveries d
     set status = 'SENDING',
         attempt_count = d.attempt_count + 1,
         next_attempt_at = null
    from candidate c
   where d.id = c.id
  returning d.*;
end;
$claimmail$;

comment on function public.claim_email_deliveries(integer, timestamptz, integer, integer) is
  'Claims up to p_limit retryable email rows for sending, marking them SENDING and incrementing the attempt counter. SKIP LOCKED makes concurrent dispatchers safe; stale SENDING rows are reclaimed after p_stale_after_seconds.';

create or replace function public.finish_email_delivery(
  p_delivery_id uuid,
  p_status public.email_delivery_status,
  p_provider_message_id text default null,
  p_error text default null,
  p_next_attempt_at timestamptz default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $finishmail$
declare
  v_row public.email_deliveries;
begin
  if p_status not in ('SENT'::public.email_delivery_status,
                      'FAILED'::public.email_delivery_status,
                      'CANCELLED'::public.email_delivery_status) then
    raise exception 'A finished delivery must be SENT, FAILED or CANCELLED'
      using errcode = 'PT400', detail = 'INVALID_DELIVERY_STATUS';
  end if;

  update public.email_deliveries
     set status = p_status,
         provider_message_id = nullif(btrim(coalesce(p_provider_message_id, '')), ''),
         last_error = nullif(btrim(coalesce(p_error, '')), ''),
         next_attempt_at = case when p_status = 'SENT' then null else p_next_attempt_at end,
         sent_at = case when p_status = 'SENT' then coalesce(sent_at, p_now) else sent_at end
   where id = p_delivery_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Email delivery row not found'
      using errcode = 'PT404', detail = 'DELIVERY_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'deliveryId', v_row.id,
    'status', v_row.status,
    'attemptCount', v_row.attempt_count,
    'providerMessageId', v_row.provider_message_id,
    'nextAttemptAt', to_char(v_row.next_attempt_at at time zone 'UTC',
                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$finishmail$;

comment on function public.finish_email_delivery(uuid, public.email_delivery_status, text, text, timestamptz, timestamptz) is
  'Records the outcome of one email send attempt: SENT with the provider message id, or FAILED with a bounded error and the next retry instant.';

-- ---------------------------------------------------------------------------
-- 7. expire_pending_orders — reservation expiry service
-- ---------------------------------------------------------------------------
-- Releases the inventory held by orders whose reservation window has passed and marks
-- them EXPIRED. Safe against duplicate execution by construction: the candidate rows are
-- locked with `for update skip locked` in the SAME statement that later updates them, so
-- two concurrent runs split the work instead of double-releasing, and a second run finds
-- no candidates.
--
-- FAILED orders are included on purpose. A failed attempt does not release the
-- reservation (a retry must be able to reuse it), so without this an abandoned failed
-- order would hold inventory forever.
--
-- No ticket is issued and no email is queued here: an expired order never paid. Pending
-- payment attempts are left untouched: Wompi may still report an outcome later, and that
-- outcome must be recorded (and reconciled) rather than hidden.
create or replace function public.expire_pending_orders(
  p_limit integer default 100,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $expire$
declare
  v_ids uuid[];
  v_count integer := 0;
  v_released integer := 0;
  v_references jsonb := '[]'::jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'Expiry batch limit must be between 1 and 1000'
      using errcode = 'PT400', detail = 'INVALID_LIMIT';
  end if;

  select array_agg(c.id) into v_ids
    from (
      select o.id
        from public.orders o
       where o.status in ('PENDING', 'FAILED')
         and o.reservation_expires_at is not null
         and o.reservation_expires_at <= p_now
       order by o.reservation_expires_at
       limit p_limit
       for update skip locked
    ) c;

  if v_ids is null then
    return jsonb_build_object(
      'expiredCount', 0,
      'releasedQuantity', 0,
      'references', v_references,
      'ranAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;

  -- Give the reserved units back before marking the orders terminal, so a failure leaves
  -- the whole operation rolled back instead of losing inventory.
  update public.pricing_tiers t
     set quantity_reserved = greatest(t.quantity_reserved - r.quantity, 0)
    from (
      select oi.pricing_tier_id as tier_id, sum(oi.quantity)::integer as quantity
        from public.order_items oi
       where oi.order_id = any(v_ids)
       group by oi.pricing_tier_id
    ) r
   where t.id = r.tier_id;
  get diagnostics v_released = row_count;

  with updated as (
    update public.orders
       set status = 'EXPIRED'
     where id = any(v_ids)
       and status in ('PENDING', 'FAILED')
    returning reference
  )
  select count(*), coalesce(jsonb_agg(to_jsonb(reference) order by reference), '[]'::jsonb)
    into v_count, v_references
    from updated;

  return jsonb_build_object(
    'expiredCount', v_count,
    'releasedTiers', v_released,
    'references', v_references,
    'ranAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$expire$;

comment on function public.expire_pending_orders(integer, timestamptz) is
  'Moves PENDING/FAILED orders past their reservation deadline to EXPIRED and gives their reserved inventory back to the pricing tier. Concurrent-safe (FOR UPDATE SKIP LOCKED); never touches paid orders and never issues tickets.';

-- ---------------------------------------------------------------------------
-- 8. retry_payment — a new attempt with a fresh reference
-- ---------------------------------------------------------------------------
-- Wompi never allows a reference to be reused (docs, Widget & Checkout Web step 2), so a
-- retry after a declined or expired attempt creates a NEW payment row with a NEW
-- reference (`EVT-YYYY-NNNNNN-<attempt>`). Every previous attempt is kept: the payment
-- history is the reconciliation record with Wompi and is never deleted.
--
-- The order itself is reused, so the buyer keeps the same order reference and the same
-- frozen price. An EXPIRED order re-reserves its inventory at the SAME stage and price
-- (the buyer is not silently re-priced); if the stage can no longer take the units the
-- retry fails with the same SOLD_OUT contract as ordering.
create or replace function public.retry_payment(
  p_order_reference text,
  p_buyer_email text,
  p_reservation_minutes integer,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $retry$
declare
  v_order public.orders;
  v_attempt integer;
  v_reference text;
  v_approved uuid;
  v_item record;
  v_reserved uuid;
  v_now timestamptz := coalesce(p_now, now());
begin
  if p_reservation_minutes is null
     or p_reservation_minutes < 1 or p_reservation_minutes > 1440 then
    raise exception 'Reservation window must be between 1 and 1440 minutes'
      using errcode = 'PT400', detail = 'INVALID_RESERVATION_WINDOW';
  end if;

  -- Same possession check as `get_order_status`: the reference alone is enumerable, and an
  -- unknown reference is indistinguishable from a reference that belongs to someone else.
  select * into v_order
  from public.orders
  where reference = btrim(coalesce(p_order_reference, ''))
    and buyer_email = lower(btrim(coalesce(p_buyer_email, '')))
  for update;
  if v_order.id is null then
    raise exception 'Order reference is unknown'
      using errcode = 'PT404', detail = 'ORDER_NOT_FOUND';
  end if;

  select id into v_approved
    from public.payments
   where order_id = v_order.id and status = 'approved';
  if v_approved is not null then
    raise exception 'Order already has an approved payment'
      using errcode = 'PT409', detail = 'ORDER_ALREADY_PAID';
  end if;

  if v_order.status not in ('FAILED', 'EXPIRED') then
    raise exception 'Order is not in a retryable state'
      using errcode = 'PT409', detail = 'ORDER_NOT_RETRYABLE';
  end if;

  select coalesce(max(attempt), 0) + 1 into v_attempt
    from public.payments where order_id = v_order.id;

  if v_attempt > 10 then
    raise exception 'Too many payment attempts for this order'
      using errcode = 'PT409', detail = 'TOO_MANY_ATTEMPTS';
  end if;

  -- Re-reserve when the reservation was released. The original stage and price are kept.
  if v_order.status = 'EXPIRED' then
    for v_item in
      select oi.pricing_tier_id, oi.quantity
        from public.order_items oi
       where oi.order_id = v_order.id
       order by oi.created_at, oi.id
    loop
      v_reserved := null;
      update public.pricing_tiers t
         set quantity_reserved = t.quantity_reserved + v_item.quantity
       where t.id = v_item.pricing_tier_id
         and (t.quantity_limit is null
              or t.quantity_reserved + t.quantity_sold + v_item.quantity <= t.quantity_limit)
      returning t.id into v_reserved;

      if v_reserved is null then
        raise exception 'No sales stage can serve this quantity'
          using errcode = 'PT409', detail = 'SOLD_OUT';
      end if;
    end loop;
  end if;

  -- Attempt 1 is the order reference itself; later attempts append `-<attempt>`.
  v_reference := v_order.reference || '-' || v_attempt::text;

  insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents, currency)
  values (v_order.id, v_attempt, v_reference, 'pending', v_order.total_cents, v_order.currency);

  update public.orders
     set status = 'PENDING',
         failed_at = null,
         reservation_expires_at = v_now + make_interval(mins => p_reservation_minutes)
   where id = v_order.id
  returning * into v_order;

  return jsonb_build_object(
    'orderId', v_order.id,
    'reference', v_order.reference,
    'status', v_order.status,
    'paymentAttempt', v_attempt,
    'wompiReference', v_reference,
    'totalInCents', v_order.total_cents,
    'currency', v_order.currency,
    'reservationExpiresAt', to_char(v_order.reservation_expires_at at time zone 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$retry$;

comment on function public.retry_payment(text, text, integer, timestamptz) is
  'Creates a new payment attempt with a fresh Wompi reference for a FAILED or EXPIRED order, gated on reference + buyer email and re-reserving inventory at the original stage and price when needed. Previous attempts are preserved; an order with an approved payment can never be retried.';

-- ---------------------------------------------------------------------------
-- 9. get_order_status — buyer-facing projection
-- ---------------------------------------------------------------------------
-- A whitelist, not a filtered table dump: a column added to `orders` or `participants`
-- later cannot leak here by accident.
--
-- Never returned: national id, email, phone, ip address, user agent, Wompi transaction
-- id, integrity signature, provider payload, internal ids other than the order
-- reference. Ticket tokens are only returned for a PAID order.
create or replace function public.get_order_status(
  p_order_reference text,
  p_buyer_email text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $status$
declare
  v_order public.orders;
  v_tickets jsonb := '[]'::jsonb;
  v_attempts jsonb := '[]'::jsonb;
  v_payment public.payments;
  v_quantity integer := 0;
  v_queued integer := 0;
  v_sent integer := 0;
  v_failed integer := 0;
begin
  -- The reference alone is NOT a credential: it is sequential and enumerable. The buyer
  -- email is the second factor, and a mismatch returns exactly the same `found: false` as
  -- an unknown reference, so the function cannot be used to discover which orders exist.
  -- Both values are compared the way the row stores them (case-insensitive email).
  select * into v_order
  from public.orders
  where reference = btrim(coalesce(p_order_reference, ''))
    and buyer_email = lower(btrim(coalesce(p_buyer_email, '')));
  if v_order.id is null then
    return jsonb_build_object('found', false);
  end if;

  select coalesce(sum(oi.quantity), 0)::integer into v_quantity
    from public.order_items oi where oi.order_id = v_order.id;

  select * into v_payment
    from public.payments
   where order_id = v_order.id
   order by attempt desc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'attempt', p.attempt,
           'status', p.status,
           'wompiReference', p.wompi_reference,
           'amountInCents', p.amount_cents,
           'statusMessage', p.status_message,
           'createdAt', to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'finalizedAt', to_char(p.finalized_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) order by p.attempt), '[]'::jsonb)
    into v_attempts
    from public.payments p
   where p.order_id = v_order.id;

  if v_order.status = 'PAID' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'token', t.token,
             'unit', t.order_item_seq,
             'status', t.status,
             'pricePaidCents', t.price_paid_cents,
             'issuedAt', to_char(t.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'assigned', t.participant_id is not null,
             'participant', case when p.id is null then null else jsonb_build_object(
               'firstName', p.first_name,
               'lastName', p.last_name,
               'city', p.city,
               'instagram', p.instagram
             ) end
           ) order by t.order_item_id, t.order_item_seq), '[]'::jsonb)
      into v_tickets
      from public.tickets t
      left join public.participants p on p.id = t.participant_id
     where t.order_id = v_order.id;
  end if;

  select count(*) filter (where d.status in ('QUEUED', 'SENDING')),
         count(*) filter (where d.status = 'SENT'),
         count(*) filter (where d.status = 'FAILED')
    into v_queued, v_sent, v_failed
    from public.email_deliveries d
   where d.ticket_id in (select id from public.tickets where order_id = v_order.id);

  return jsonb_build_object(
    'found', true,
    'reference', v_order.reference,
    'status', v_order.status,
    'quantity', v_quantity,
    'currency', v_order.currency,
    'subtotalInCents', v_order.subtotal_cents,
    'quantityDiscountInCents', v_order.quantity_discount_cents,
    'discountCodeInCents', v_order.discount_code_cents,
    'totalInCents', v_order.total_cents,
    'createdAt', to_char(v_order.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'paidAt', to_char(v_order.paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'reservationExpiresAt', to_char(v_order.reservation_expires_at at time zone 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'attempt', v_payment.attempt,
      'status', v_payment.status,
      'methodType', v_payment.payment_method_type,
      'statusMessage', v_payment.status_message,
      'approvedAt', to_char(v_payment.approved_at at time zone 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) end,
    'paymentAttempts', v_attempts,
    'tickets', v_tickets,
    'confirmation', jsonb_build_object(
      'queued', v_queued,
      'sent', v_sent,
      'failed', v_failed,
      'ready', (v_order.status = 'PAID' and v_queued + v_sent > 0)
    )
  );
end;
$status$;

comment on function public.get_order_status(text, text) is
  'Buyer-facing order projection with an explicit whitelist of fields, gated on reference + buyer email. Returns ticket tokens only for a PAID order; never returns document numbers, emails, phones, IPs, provider payloads or Wompi transaction ids.';

-- ---------------------------------------------------------------------------
-- 10. Grants: service_role only
-- ---------------------------------------------------------------------------
revoke all on function app_private.payment_transition_rank(public.payment_status) from public;
revoke all on function public.claim_webhook_event(text, text, text, boolean) from public;
revoke all on function public.finalize_webhook_event(uuid, public.payment_event_result, integer, uuid, text, text) from public;
revoke all on function public.record_webhook_rejection(text, text, integer, text) from public;
revoke all on function public.confirm_payment(text, text, text, text, bigint, text, text, text, jsonb) from public;
revoke all on function public.queue_ticket_emails(uuid, text) from public;
revoke all on function public.claim_email_deliveries(integer, timestamptz, integer, integer) from public;
revoke all on function public.finish_email_delivery(uuid, public.email_delivery_status, text, text, timestamptz, timestamptz) from public;
revoke all on function public.expire_pending_orders(integer, timestamptz) from public;
revoke all on function public.retry_payment(text, text, integer, timestamptz) from public;
revoke all on function public.get_order_status(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function app_private.payment_transition_rank(public.payment_status) to service_role';
    execute 'grant execute on function public.claim_webhook_event(text, text, text, boolean) to service_role';
    execute 'grant execute on function public.finalize_webhook_event(uuid, public.payment_event_result, integer, uuid, text, text) to service_role';
    execute 'grant execute on function public.record_webhook_rejection(text, text, integer, text) to service_role';
    execute 'grant execute on function public.confirm_payment(text, text, text, text, bigint, text, text, text, jsonb) to service_role';
    execute 'grant execute on function public.queue_ticket_emails(uuid, text) to service_role';
    execute 'grant execute on function public.claim_email_deliveries(integer, timestamptz, integer, integer) to service_role';
    execute 'grant execute on function public.finish_email_delivery(uuid, public.email_delivery_status, text, text, timestamptz, timestamptz) to service_role';
    execute 'grant execute on function public.expire_pending_orders(integer, timestamptz) to service_role';
    execute 'grant execute on function public.retry_payment(text, text, integer, timestamptz) to service_role';
    execute 'grant execute on function public.get_order_status(text, text) to service_role';
  end if;
end
$$;
