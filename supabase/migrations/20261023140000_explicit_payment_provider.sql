-- ---------------------------------------------------------------------------
-- Migration 20261023140000_explicit_payment_provider
-- H15: payment-provider attribution.
--
-- confirm_payment, claim_webhook_event and record_webhook_rejection defaulted `p_provider` to
-- 'epayco' and silently turned any unknown value into 'epayco'. The Wompi webhook and the Wompi
-- reconciliation sweep never passed a provider, so every Wompi confirmation and ledger row was
-- recorded as ePayco, and the provider-aware sweep (20261023120000) would then have sent those
-- Wompi transactions to ePayco.
--
-- 1. The three functions keep their signatures (grants preserved), but the default becomes
--    NULL and a missing or unknown provider is refused (PT400 INVALID_PROVIDER) instead of
--    guessed. Every application caller now passes the provider explicitly.
-- 2. Rows already misattributed are repaired ONLY where our own code left unambiguous Wompi
--    evidence (see section 2); everything else is left untouched and reported.
--
-- Deploy order: application code that passes the provider BEFORE this migration; an older
-- deployed caller without the provider would be refused (and, for the sweep, retried).
-- ---------------------------------------------------------------------------

-- 1. Explicit provider ------------------------------------------------------

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
    -- 7=Retenida, 8=Iniciada: not settled; never issue tickets, keep reconciling.
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

  -- An ePayco reversal of a payment that was already approved: the payment is recorded as
  -- refunded (above), but the PAID order, its tickets and the inventory are deliberately left
  -- untouched (no refund, ticket void or stock change is invented here). The change is
  -- written on the payment and reported for manual review instead of as a plain update.
  -- Keyed on the ePayco reversal code itself, not only on p_provider: that parameter defaults
  -- to 'epayco' and the Wompi callers do not pass it, so a Wompi VOIDED keeps its old result.
  if v_provider = 'epayco'
     and upper(v_incoming_raw) in ('6', 'REVERSADA')
     and v_previous = 'approved'::public.payment_status
     and v_payment.status = 'refunded'::public.payment_status
     and v_status_changed then
    update public.payments
       set status_message = 'Reversed by ePayco after approval; order ' || v_order.reference
                            || ' and its tickets were left unchanged; manual review required'
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

create or replace function public.claim_webhook_event(
  p_dedupe_key text,
  p_event_name text,
  p_wompi_transaction_id text default null,
  p_checksum_valid boolean default false,
  p_provider text default null
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

  -- H15: the provider is mandatory and explicit. A missing or unknown value used to become
  -- 'epayco', which recorded every Wompi confirmation as ePayco.
  if lower(btrim(coalesce(p_provider, ''))) not in ('wompi', 'epayco') then
    raise exception 'Payment provider must be wompi or epayco'
      using errcode = 'PT400', detail = 'INVALID_PROVIDER';
  end if;
  v_provider := lower(btrim(p_provider));

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

create or replace function public.record_webhook_rejection(
  p_dedupe_key text,
  p_event_name text,
  p_http_status integer,
  p_error_code text,
  p_provider text default null
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
  -- H15: the provider is mandatory and explicit. A missing or unknown value used to become
  -- 'epayco', which recorded every Wompi confirmation as ePayco.
  if lower(btrim(coalesce(p_provider, ''))) not in ('wompi', 'epayco') then
    raise exception 'Payment provider must be wompi or epayco'
      using errcode = 'PT400', detail = 'INVALID_PROVIDER';
  end if;
  v_provider := lower(btrim(p_provider));

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

-- 2. Repair of misattributed rows ------------------------------------------
--
-- A payment is re-attributed to Wompi only when ALL of the following hold, each of which only
-- the Wompi code path produces:
--   * provider_payload has the exact shape of `buildProviderPayload` (api/payment-payload.ts):
--     an object with id, reference, status and amount_in_cents, and only keys from that builder;
--     ePayco payloads are the provider's own x_* fields (or the validation API response);
--   * the raw status is a Wompi status word (ePayco sends numeric codes or Spanish words);
--   * the transaction id has Wompi's `<merchant>-<epoch>-<seq>` form.
-- Rows that fail any test (for example Wompi rows confirmed through the payment hint, whose
-- payload is the raw API response) are deliberately not guessed at.
update public.payments p
   set payment_provider = 'wompi'
 where p.payment_provider = 'epayco'
   and jsonb_typeof(p.provider_payload) = 'object'
   and p.provider_payload ?& array['id', 'reference', 'status', 'amount_in_cents']
   and not exists (
     select 1
       from jsonb_object_keys(p.provider_payload) as k(key)
      where k.key not in ('id', 'reference', 'status', 'amount_in_cents', 'currency',
                          'payment_method_type', 'status_message', 'created_at',
                          'finalized_at')
   )
   and upper(coalesce(p.raw_provider_status, p.raw_wompi_status, ''))
       in ('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR')
   and coalesce(p.provider_transaction_id, p.wompi_transaction_id, '')
       ~ '^[0-9]+-[0-9]+-[0-9]+$';

-- Ledger rows: the ePayco handler only ever writes the event name 'epayco.confirmation'; Wompi
-- events carry Wompi's own event names ('transaction.updated', ...).
update public.payment_events e
   set payment_provider = 'wompi'
 where e.payment_provider = 'epayco'
   and coalesce(e.provider_event_name, e.wompi_event_name, '') ~ '^transaction\.';
