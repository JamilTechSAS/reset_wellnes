-- ---------------------------------------------------------------------------
-- Migration 20261021120000_epayco_payment_provider
-- Phase 6C: ePayco payment provider support and backward-compatible schema extension.
--
-- Adds provider-neutral and ePayco-specific payment fields to `payments` and
-- `payment_events`, while preserving 100% backward compatibility with existing Wompi
-- records, indexes, constraints, and audit trails.
-- ---------------------------------------------------------------------------

-- 1. Extend public.payments with provider-neutral columns
alter table public.payments
  add column if not exists payment_provider text not null default 'wompi'
    check (payment_provider in ('wompi', 'epayco')),
  add column if not exists provider_reference text,
  add column if not exists provider_transaction_id text,
  add column if not exists raw_provider_status text;

update public.payments
   set provider_reference = wompi_reference,
       provider_transaction_id = wompi_transaction_id,
       raw_provider_status = raw_wompi_status
 where provider_reference is null;

create index if not exists payments_provider_reference_idx
  on public.payments (provider_reference);

create index if not exists payments_provider_transaction_id_idx
  on public.payments (provider_transaction_id);

create index if not exists payments_provider_idx
  on public.payments (payment_provider);

comment on column public.payments.payment_provider is
  'Active payment gateway provider (wompi or epayco).';

comment on column public.payments.provider_reference is
  'Gateway-agnostic payment attempt reference (matches order reference or order reference with attempt suffix).';

comment on column public.payments.provider_transaction_id is
  'Transaction or validation identifier assigned by the provider (e.g. Wompi transaction id or ePayco ref_payco).';

-- 2. Extend public.payment_events with provider-neutral columns
alter table public.payment_events
  add column if not exists payment_provider text not null default 'wompi'
    check (payment_provider in ('wompi', 'epayco')),
  add column if not exists provider_event_name text,
  add column if not exists provider_transaction_id text;

update public.payment_events
   set provider_event_name = wompi_event_name,
       provider_transaction_id = wompi_transaction_id
 where provider_event_name is null;

create index if not exists payment_events_provider_transaction_id_idx
  on public.payment_events (provider_transaction_id);

comment on column public.payment_events.payment_provider is
  'Provider originating the webhook event (wompi or epayco).';

-- 3. Column synchronization triggers (ensures legacy and generic columns stay in sync)
create or replace function app_private.sync_payment_provider_columns()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $sync$
begin
  if new.provider_reference is null and new.wompi_reference is not null then
    new.provider_reference := new.wompi_reference;
  end if;
  if new.wompi_reference is null and new.provider_reference is not null then
    new.wompi_reference := new.provider_reference;
  end if;

  if new.provider_transaction_id is null and new.wompi_transaction_id is not null then
    new.provider_transaction_id := new.wompi_transaction_id;
  end if;
  if new.wompi_transaction_id is null and new.provider_transaction_id is not null then
    new.wompi_transaction_id := new.provider_transaction_id;
  end if;

  if new.raw_provider_status is null and new.raw_wompi_status is not null then
    new.raw_provider_status := new.raw_wompi_status;
  end if;
  if new.raw_wompi_status is null and new.raw_provider_status is not null then
    new.raw_wompi_status := new.raw_provider_status;
  end if;

  return new;
end;
$sync$;

drop trigger if exists payments_sync_provider_columns on public.payments;
create trigger payments_sync_provider_columns
  before insert or update on public.payments
  for each row execute function app_private.sync_payment_provider_columns();

create or replace function app_private.sync_payment_event_columns()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $sync_event$
begin
  if new.provider_event_name is null and new.wompi_event_name is not null then
    new.provider_event_name := new.wompi_event_name;
  end if;
  if new.wompi_event_name is null and new.provider_event_name is not null then
    new.wompi_event_name := new.provider_event_name;
  end if;

  if new.provider_transaction_id is null and new.wompi_transaction_id is not null then
    new.provider_transaction_id := new.wompi_transaction_id;
  end if;
  if new.wompi_transaction_id is null and new.provider_transaction_id is not null then
    new.wompi_transaction_id := new.provider_transaction_id;
  end if;

  return new;
end;
$sync_event$;

drop trigger if exists payment_events_sync_provider_columns on public.payment_events;
create trigger payment_events_sync_provider_columns
  before insert or update on public.payment_events
  for each row execute function app_private.sync_payment_event_columns();

-- 4. Update claim_webhook_event (drop obsolete 4-arg signature to avoid ambiguity)
drop function if exists public.claim_webhook_event(text, text, text, boolean);

create or replace function public.claim_webhook_event(
  p_dedupe_key text,
  p_event_name text,
  p_wompi_transaction_id text default null,
  p_checksum_valid boolean default false,
  p_provider text default 'epayco'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $claim$
declare
  v_event public.payment_events;
  v_provider text;
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

  v_provider := case when lower(coalesce(p_provider, '')) in ('wompi', 'epayco')
                     then lower(p_provider)
                     else 'epayco' end;

  insert into public.payment_events (
    dedupe_key, wompi_event_name, provider_event_name,
    wompi_transaction_id, provider_transaction_id,
    payment_provider, checksum_valid
  ) values (
    p_dedupe_key, btrim(p_event_name), btrim(p_event_name),
    nullif(btrim(coalesce(p_wompi_transaction_id, '')), ''),
    nullif(btrim(coalesce(p_wompi_transaction_id, '')), ''),
    v_provider,
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

-- 5. Update finalize_webhook_event
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
  v_tx_id text;
begin
  v_tx_id := nullif(btrim(coalesce(p_wompi_transaction_id, '')), '');

  update public.payment_events
     set processed_at = now(),
         result = p_result,
         http_status = p_http_status,
         payment_id = coalesce(p_payment_id, payment_id),
         error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
         wompi_transaction_id = coalesce(v_tx_id, wompi_transaction_id),
         provider_transaction_id = coalesce(v_tx_id, provider_transaction_id)
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

-- 6. Update record_webhook_rejection (drop obsolete 4-arg signature to avoid ambiguity)
drop function if exists public.record_webhook_rejection(text, text, integer, text);

create or replace function public.record_webhook_rejection(
  p_dedupe_key text,
  p_event_name text,
  p_http_status integer,
  p_error_code text,
  p_provider text default 'epayco'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $reject$
declare
  v_event_id uuid;
  v_existing uuid;
  v_name text;
  v_provider text;
begin
  if p_dedupe_key is null or p_dedupe_key !~ '^[!-~]{16,200}$' then
    raise exception 'Webhook dedupe key is missing or malformed'
      using errcode = 'PT400', detail = 'INVALID_DEDUPE_KEY';
  end if;

  select id into v_existing from public.payment_events where dedupe_key = p_dedupe_key;
  if v_existing is not null then
    return jsonb_build_object('eventId', v_existing, 'recorded', false);
  end if;

  v_name := btrim(coalesce(nullif(p_event_name, ''), 'unknown'));
  v_provider := case when lower(coalesce(p_provider, '')) in ('wompi', 'epayco')
                     then lower(p_provider)
                     else 'epayco' end;

  insert into public.payment_events (
    dedupe_key, wompi_event_name, provider_event_name,
    payment_provider, checksum_valid, processed_at, result, http_status, error_code
  ) values (
    p_dedupe_key,
    v_name,
    v_name,
    v_provider,
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

-- 7. Drop obsolete 9-argument confirm_payment overload to replace with 10-argument version
drop function if exists public.confirm_payment(text, text, text, text, bigint, text, text, text, jsonb);

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
  p_provider text default 'epayco'
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
  v_provider text;
  v_tx_id text;
begin
  v_incoming_raw := btrim(coalesce(p_wompi_status, ''));
  v_provider := case when lower(coalesce(p_provider, '')) in ('wompi', 'epayco')
                     then lower(p_provider)
                     else 'epayco' end;
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
    -- ePayco text statuses
    when 'ACEPTADA'  then 'approved'::public.payment_status
    when 'RECHAZADA' then 'declined'::public.payment_status
    when 'PENDIENTE' then 'pending'::public.payment_status
    when 'FALLIDA'   then 'error'::public.payment_status
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
    v_unit_remainder := v_line.line_total_cents - v_unit_price * v_line.quantity;

    for v_unit in 1..v_line.quantity loop
      insert into public.tickets (
        event_id, order_id, order_item_id, order_item_seq, participant_id,
        ticket_type_id, token, status, price_paid_cents, issued_at
      )
      select
        v_order.event_id, v_order.id, v_line.id, v_unit,
        (select p.id
           from public.participants p
          where p.order_item_id = v_line.id
            and not exists (select 1 from public.tickets t where t.participant_id = p.id)
          order by p.created_at, p.id
          limit 1),
        v_line.ticket_type_id,
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
    'ticketsIssued', v_issued,
    'ticketsExpected', v_expected,
    'reconciliationRequired', false,
    'reason', 'PAYMENT_APPROVED'
  );
end;
$confirm$;

-- 8. Update resolve_payment_for_buyer
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
    'paymentProvider', coalesce(v_payment.payment_provider, 'epayco'),
    'providerReference', coalesce(v_payment.provider_reference, v_payment.wompi_reference),
    'providerTransactionId', coalesce(v_payment.provider_transaction_id, v_payment.wompi_transaction_id),
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

-- 9. Update get_order_status
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
           'provider', coalesce(p.payment_provider, 'epayco'),
           'reference', coalesce(p.provider_reference, p.wompi_reference),
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
      'provider', coalesce(v_payment.payment_provider, 'epayco'),
      'reference', coalesce(v_payment.provider_reference, v_payment.wompi_reference),
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

-- 10. Explicit role grants: revoke from API roles, grant to service_role only
revoke all on function app_private.sync_payment_provider_columns() from public;
revoke all on function app_private.sync_payment_event_columns() from public;
revoke all on function public.claim_webhook_event(text, text, text, boolean, text) from public;
revoke all on function public.finalize_webhook_event(uuid, public.payment_event_result, integer, uuid, text, text) from public;
revoke all on function public.record_webhook_rejection(text, text, integer, text, text) from public;
revoke all on function public.confirm_payment(text, text, text, text, bigint, text, text, text, jsonb, text) from public;
revoke all on function public.resolve_payment_for_buyer(text, text) from public;
revoke all on function public.get_order_status(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_private.sync_payment_provider_columns() from anon';
    execute 'revoke all on function app_private.sync_payment_event_columns() from anon';
    execute 'revoke all on function public.claim_webhook_event(text, text, text, boolean, text) from anon';
    execute 'revoke all on function public.finalize_webhook_event(uuid, public.payment_event_result, integer, uuid, text, text) from anon';
    execute 'revoke all on function public.record_webhook_rejection(text, text, integer, text, text) from anon';
    execute 'revoke all on function public.confirm_payment(text, text, text, text, bigint, text, text, text, jsonb, text) from anon';
    execute 'revoke all on function public.resolve_payment_for_buyer(text, text) from anon';
    execute 'revoke all on function public.get_order_status(text, text) from anon';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function app_private.sync_payment_provider_columns() from authenticated';
    execute 'revoke all on function app_private.sync_payment_event_columns() from authenticated';
    execute 'revoke all on function public.claim_webhook_event(text, text, text, boolean, text) from authenticated';
    execute 'revoke all on function public.finalize_webhook_event(uuid, public.payment_event_result, integer, uuid, text, text) from authenticated';
    execute 'revoke all on function public.record_webhook_rejection(text, text, integer, text, text) from authenticated';
    execute 'revoke all on function public.confirm_payment(text, text, text, text, bigint, text, text, text, jsonb, text) from authenticated';
    execute 'revoke all on function public.resolve_payment_for_buyer(text, text) from authenticated';
    execute 'revoke all on function public.get_order_status(text, text) from authenticated';
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.claim_webhook_event(text, text, text, boolean, text) to service_role';
    execute 'grant execute on function public.finalize_webhook_event(uuid, public.payment_event_result, integer, uuid, text, text) to service_role';
    execute 'grant execute on function public.record_webhook_rejection(text, text, integer, text, text) to service_role';
    execute 'grant execute on function public.confirm_payment(text, text, text, text, bigint, text, text, text, jsonb, text) to service_role';
    execute 'grant execute on function public.resolve_payment_for_buyer(text, text) to service_role';
    execute 'grant execute on function public.get_order_status(text, text) to service_role';
  end if;
end
$$;
