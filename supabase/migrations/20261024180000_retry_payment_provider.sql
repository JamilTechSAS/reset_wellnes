-- ---------------------------------------------------------------------------
-- Migration 20261024180000_retry_payment_provider
-- ePayco QA follow-up: a retried attempt must keep the order's provider.
--
-- 20261024150000 made the provider mandatory wherever an order is BORN (`create_order`,
-- `create_bundle_order` forwards to it) and `confirm_payment` re-attributes the row from the
-- verified provider. One creation path was left out: `retry_payment` still inserted attempt N
-- without `payment_provider`, so it took the column default `'wompi'`.
--
-- Consequences for an ePayco order (staging, 2026-10-24 QA run):
--   * `begin_checkout_session` (20261024170000) refuses an attempt whose row says `wompi`
--     with PT409 PROVIDER_SESSION_UNSUPPORTED, so `POST /orders/{reference}/retry` produced an
--     attempt that could never open a checkout;
--   * the reconciliation sweep picks its provider client from the row
--     (`claim_payment_reconciliations`), so that attempt would have been polled against Wompi.
--
-- The fix is inheritance, not a new parameter: an order is quoted, priced and confirmed for one
-- provider, and the provider is decided by its first attempt. Attempt N copies the provider of
-- the latest attempt of the same order, and fails closed (PT400 INVALID_PROVIDER) when there is
-- none to copy instead of falling back to the column default. The retry signature, reference
-- numbering, reservations and price freezing are unchanged; no existing row is rewritten.
-- ---------------------------------------------------------------------------

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
  v_provider text;
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

  -- Resolved before the attempt is written and BEFORE inventory is re-reserved: an order with
  -- no attributable provider must not gain a reservation it cannot pay for.
  select p.payment_provider into v_provider
    from public.payments p
   where p.order_id = v_order.id
   order by p.attempt desc
   limit 1;

  if v_provider is null or v_provider not in ('wompi', 'epayco') then
    raise exception 'Payment provider must be wompi or epayco'
      using errcode = 'PT400', detail = 'INVALID_PROVIDER';
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

  insert into public.payments (
    order_id, attempt, wompi_reference, status, amount_cents, currency, payment_provider
  )
  values (
    v_order.id, v_attempt, v_reference, 'pending', v_order.total_cents, v_order.currency,
    v_provider
  );

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
    'paymentProvider', v_provider,
    'reservationExpiresAt', to_char(v_order.reservation_expires_at at time zone 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$retry$;

comment on function public.retry_payment(text, text, integer, timestamptz) is
  'Creates a new payment attempt for a FAILED or EXPIRED order, inheriting the provider and the frozen price of the previous attempt and reusing the same order reference; the attempt gets its own reference suffix and re-reserves inventory at the original stage.';

-- Signature unchanged, so `create or replace` keeps the grants; they are restated anyway so the
-- privileges of this function are readable in one place.
revoke all on function public.retry_payment(text, text, integer, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.retry_payment(text, text, integer, timestamptz) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.retry_payment(text, text, integer, timestamptz) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.retry_payment(text, text, integer, timestamptz) to service_role';
  end if;
end
$$;
