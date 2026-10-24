-- ---------------------------------------------------------------------------
-- Migration 20261024150000_create_order_payment_provider
-- ePayco QA follow-up: the order's payment row must record WHICH provider will be charged.
--
-- Symptom found in the staging sandbox run: orders created by `public.create_order` (and by
-- `public.create_bundle_order`) inserted the `payments` row without a provider, so it took the
-- column default `'wompi'`. The ePayco checkout then succeeded while the attempt was stored as a
-- Wompi one: the buyer saw `provider: "wompi"`, and the reconciliation sweep — which picks the
-- provider client from the row — never queried ePayco for it. A lost confirmation therefore
-- left a paid order PENDING forever.
--
-- H15 (20261023140000) already made the provider explicit on confirm/webhook/reconciliation and
-- refused to guess it. This migration closes the same gap at CREATION time:
--   1. `create_order` takes `p_payment_provider` as its last, defaulted parameter and refuses a
--      missing or unknown value with PT400 INVALID_PROVIDER — no silent fallback.
--   2. The attempt-1 row stores that provider.
--   3. `create_bundle_order` forwards the same parameter to `create_order`.
-- Both functions are recreated with the extra trailing parameter (the previous signatures are
-- dropped in the same transaction, so a 12-arg call can no longer resolve to the old, guessing
-- definition). Application code passes the provider BEFORE this migration runs.
--
-- No row is rewritten and no data is deleted: existing rows keep whatever attribution they have.
-- ---------------------------------------------------------------------------

drop function if exists public.create_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text);
drop function if exists public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text);

create or replace function public.create_order(
  p_event_code text,
  p_ticket_type_code text,
  p_quantity integer,
  p_reservation_minutes integer,
  p_buyer_email text,
  p_buyer_name text,
  p_buyer_phone text,
  p_participant jsonb,
  -- Optional parameters come last and are defaulted, so PostgREST (and the generated
  -- TypeScript types) treat them as genuinely optional instead of required-with-null.
  p_discount_code text default null,
  p_idempotency_key text default null,
  p_ip_address text default null,
  p_user_agent text default null,
  -- H15 follow-up: the provider is MANDATORY. `payments.payment_provider` used to fall back to
  -- the column default ('wompi'), so every ePayco order was stored as a Wompi attempt and the
  -- reconciliation sweep would never query it at the right provider.
  p_payment_provider text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $order$
declare
  v_provider text;
  v_now timestamptz := now();
  v_event public.events;
  v_ticket_type public.ticket_types;
  v_tier public.pricing_tiers;
  v_policy text;
  v_participant jsonb;
  v_replay jsonb;
  v_existing public.orders;
  v_existing_item public.order_items;
  v_existing_participant public.participants;
  v_existing_payment public.payments;
  v_existing_tier_name text;
  v_quantity_bps integer := 0;
  v_quantity_discount_raw bigint := 0;
  v_quantity_discount bigint := 0;
  v_code_amount_raw bigint := 0;
  v_code_amount bigint := 0;
  v_subtotal bigint;
  v_code jsonb;
  v_code_id uuid;
  v_discount_total bigint := 0;
  v_total bigint;
  v_order_id uuid;
  v_reference text;
  v_item_id uuid;
  v_participant_id uuid;
  v_payment_id uuid;
  v_claimed_code_id uuid;
  v_reservation_expires_at timestamptz;
  v_email text;
  v_ip inet;
begin
  v_provider := lower(btrim(coalesce(p_payment_provider, '')));
  if v_provider not in ('wompi', 'epayco') then
    raise exception 'Payment provider must be wompi or epayco'
      using errcode = 'PT400', detail = 'INVALID_PROVIDER';
  end if;
  -- -------------------------------------------------------------------------
  -- 0. Scalar input validation (participant payload is validated separately).
  -- -------------------------------------------------------------------------
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Quantity must be a positive integer'
      using errcode = 'PT400', detail = 'INVALID_QUANTITY';
  end if;
  if p_reservation_minutes is null or p_reservation_minutes < 1
     or p_reservation_minutes > 1440 then
    raise exception 'Reservation window is out of range'
      using errcode = 'PT400', detail = 'INVALID_RESERVATION_WINDOW';
  end if;

  v_email := lower(btrim(coalesce(p_buyer_email, '')));
  if v_email = '' or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Buyer email is required and must be valid'
      using errcode = 'PT400', detail = 'INVALID_BUYER_EMAIL';
  end if;
  if p_buyer_name is null or btrim(p_buyer_name) = '' or length(btrim(p_buyer_name)) > 160 then
    raise exception 'Buyer name is required (max 160 characters)'
      using errcode = 'PT400', detail = 'INVALID_BUYER_NAME';
  end if;
  if p_buyer_phone is null or btrim(p_buyer_phone) !~ '^[0-9]{7,15}$' then
    raise exception 'Buyer phone must contain between 7 and 15 digits'
      using errcode = 'PT400', detail = 'INVALID_BUYER_PHONE';
  end if;

  v_participant := app_private.normalize_order_input(p_participant);

  -- Consent to personal data processing is the legal basis for storing the data at all;
  -- the future-events consent is optional and recorded either way (append-only).
  if coalesce((coalesce(p_participant -> 'consents', '{}'::jsonb) ->> 'dataProcessing')::boolean,
              false) is not true then
    raise exception 'Consent to personal data processing is required to buy a ticket'
      using errcode = 'PT400', detail = 'CONSENT_REQUIRED';
  end if;

  -- IP is optional personal data: keep it only when it parses, never fail the order for it.
  begin
    v_ip := nullif(btrim(coalesce(p_ip_address, '')), '')::inet;
  exception when others then
    v_ip := null;
  end;

  -- -------------------------------------------------------------------------
  -- 1. Idempotent replay: the same key with the same buyer returns the same order.
  --    The unique index is the real guard; this lookup makes a retry answer instead
  --    of failing, and returns the same reference/amount so a retry_placeholder
  -- -------------------------------------------------------------------------
  if p_idempotency_key is not null and length(p_idempotency_key) > 0 then
    if length(p_idempotency_key) < 16 or p_idempotency_key !~ '^[!-~]+$' then
      raise exception 'Idempotency key must be at least 16 printable characters'
        using errcode = 'PT400', detail = 'INVALID_IDEMPOTENCY_KEY';
    end if;

    select * into v_existing
      from public.orders o
     where o.idempotency_key = p_idempotency_key;

    if found then
      -- A key that belongs to a DIFFERENT buyer must never reveal that order.
      if v_existing.buyer_email <> v_email then
        raise exception 'Idempotency key is already used'
          using errcode = 'PT409', detail = 'IDEMPOTENCY_KEY_CONFLICT';
      end if;

      select * into v_existing_item
        from public.order_items i
       where i.order_id = v_existing.id
       order by i.created_at, i.id
       limit 1;
      select * into v_existing_participant
        from public.participants p
       where p.order_id = v_existing.id
       order by p.created_at, p.id
       limit 1;
      select * into v_existing_payment
        from public.payments pay
       where pay.order_id = v_existing.id
       order by pay.attempt
       limit 1;
      select t.name into v_existing_tier_name
        from public.pricing_tiers t
       where t.id = v_existing_item.pricing_tier_id;

      -- The combination policy is a single-row table, not an order column: read it so the
      -- replayed payload carries the same shape (and the same rule in force) as a fresh one.
      -- With both discount columns non-zero the rule can only have been STACK, which this
      -- read reproduces; the value is informational and never used to price anything.
      select p.discount_combination into v_policy from public.pricing_policy p;

      return jsonb_build_object(
        'replayed', true,
        'orderId', v_existing.id,
        'reference', v_existing.reference,
        'status', v_existing.status,
        'quantity', v_existing_item.quantity,
        'unitPriceInCents', v_existing_item.unit_price_cents,
        'pricingTierName', v_existing_tier_name,
        'subtotalInCents', v_existing.subtotal_cents,
        'quantityDiscountInCents', v_existing.quantity_discount_cents,
        'discountCodeInCents', v_existing.discount_code_cents,
        -- The two columns hold the amounts ACTUALLY applied, and the orders CHECK
        -- constraint is `subtotal - quantity - code = total`, so their sum is exactly the
        -- `totalDiscountInCents` a fresh creation returns.
        'totalDiscountInCents',
          v_existing.quantity_discount_cents + v_existing.discount_code_cents,
        'discountCombination', v_policy,
        'totalInCents', v_existing.total_cents,
        'currency', v_existing.currency,
        'reservationExpiresAt', v_existing.reservation_expires_at,
        'paymentAttempt', v_existing_payment.attempt,
        'wompiReference', v_existing_payment.wompi_reference,
        'participantId', v_existing_participant.id
      );
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Resolve the event and the ticket type.
  -- -------------------------------------------------------------------------
  select * into v_event
    from public.events e
   where e.code = upper(btrim(coalesce(p_event_code, '')));
  if not found then
    raise exception 'Event not found' using errcode = 'PT404', detail = 'EVENT_NOT_FOUND';
  end if;
  if v_event.status <> 'PUBLISHED' then
    raise exception 'Event is not on sale'
      using errcode = 'PT409', detail = 'EVENT_NOT_ON_SALE';
  end if;

  select * into v_ticket_type
    from public.ticket_types tt
   where tt.event_id = v_event.id
     and tt.code = upper(btrim(coalesce(p_ticket_type_code, '')));
  if not found then
    raise exception 'Ticket type not found'
      using errcode = 'PT404', detail = 'TICKET_TYPE_NOT_FOUND';
  end if;
  if not v_ticket_type.is_active then
    raise exception 'Ticket type is not on sale'
      using errcode = 'PT409', detail = 'TICKET_TYPE_INACTIVE';
  end if;
  if p_quantity < v_ticket_type.min_per_order
     or (v_ticket_type.max_per_order is not null
         and p_quantity > v_ticket_type.max_per_order) then
    raise exception 'Quantity is outside the configured per-order limits'
      using errcode = 'PT409', detail = 'QUANTITY_LIMIT';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Reserve inventory and get the price from the reserved stage.
  -- -------------------------------------------------------------------------
  v_tier := app_private.reserve_pricing_tier(v_ticket_type.id, p_quantity, v_now);
  v_subtotal := v_tier.price_cents * p_quantity;

  -- -------------------------------------------------------------------------
  -- 4. Discounts, computed from the database only.
  -- -------------------------------------------------------------------------
  v_quantity_bps := app_private.quantity_discount_bps(v_ticket_type.id, p_quantity);
  v_quantity_discount_raw := (v_subtotal * v_quantity_bps) / 10000;

  v_code := app_private.evaluate_discount_code(
    v_event.id, v_ticket_type.id, p_discount_code, p_quantity, v_subtotal, v_now
  );
  -- A code the buyer explicitly supplied must actually apply. Proceeding without it would
  -- charge MORE than the price the buyer was shown, so an unusable code is a hard failure
  -- here (the quote endpoint stays non-fatal and reports the reason, so the UI can explain
  -- it before the buyer submits). Detail codes: DISCOUNT_<REASON> from evaluate_discount_code.
  if (v_code ->> 'supplied')::boolean and not (v_code ->> 'applies')::boolean then
    raise exception 'Discount code cannot be applied'
      using errcode = 'PT409', detail = 'DISCOUNT_' || (v_code ->> 'reason');
  end if;

  if (v_code ->> 'applies')::boolean then
    v_code_id := (v_code ->> 'discountCodeId')::uuid;
    v_code_amount_raw := (v_code ->> 'amountInCents')::bigint;
  end if;

  -- The orders CHECK constraint is `subtotal - quantity_discount - discount_code = total`,
  -- so the two columns must hold the amounts ACTUALLY APPLIED, not the raw candidates.
  -- Under BEST_SINGLE the loser is stored as 0 (nothing was taken off by it) and the
  -- redemption is claimed only for the winner, so usage accounting stays truthful.
  select p.discount_combination into v_policy from public.pricing_policy p;
  if v_policy = 'STACK' then
    v_quantity_discount := v_quantity_discount_raw;
    v_code_amount := least(v_code_amount_raw, v_subtotal - v_quantity_discount_raw);
    if v_code_amount < v_code_amount_raw then
      -- The subtotal cap swallowed part of the code discount; nothing left to claim.
      v_code_id := null;
    end if;
  elsif v_quantity_discount_raw >= v_code_amount_raw then
    v_quantity_discount := v_quantity_discount_raw;
    v_code_amount := 0;
    v_code_id := null;
  else
    v_quantity_discount := 0;
    v_code_amount := v_code_amount_raw;
  end if;

  v_discount_total := v_quantity_discount + v_code_amount;
  v_total := v_subtotal - v_discount_total;

  if v_code_amount = 0 then
    v_code_id := null;
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Write the order (the reference comes from the Phase 2 sequence, so it is
  --    unique even under concurrency and never reused).
  -- -------------------------------------------------------------------------
  v_reference := app_private.next_order_reference(
    extract(year from v_now at time zone 'America/Bogota')::integer
  );
  v_reservation_expires_at := v_now + make_interval(mins => p_reservation_minutes);

  insert into public.orders (
    reference, event_id, status, buyer_email, buyer_name, buyer_phone,
    subtotal_cents, quantity_discount_cents, discount_code_cents, total_cents,
    currency, discount_code_id, reservation_expires_at, source, ip_address, user_agent,
    idempotency_key
  ) values (
    v_reference, v_event.id, 'PENDING', v_email, btrim(p_buyer_name), btrim(p_buyer_phone),
    v_subtotal, v_quantity_discount, v_code_amount, v_total,
    v_event.currency, v_code_id, v_reservation_expires_at, 'WEB', v_ip, nullif(btrim(coalesce(p_user_agent, '')), ''),
    nullif(p_idempotency_key, '')
  )
  returning id into v_order_id;

  insert into public.order_items (
    order_id, ticket_type_id, pricing_tier_id, quantity, unit_price_cents,
    quantity_discount_cents, line_total_cents, ticket_type_name, pricing_tier_name
  ) values (
    v_order_id, v_ticket_type.id, v_tier.id, p_quantity, v_tier.price_cents,
    v_quantity_discount, v_subtotal - v_quantity_discount,
    v_ticket_type.name, v_tier.name
  )
  returning id into v_item_id;

  -- -------------------------------------------------------------------------
  -- 6. Claim the discount redemption after the order exists (the ledger row needs
  --    the order id). A failure here rolls back the order and the reservation.
  -- -------------------------------------------------------------------------
  if v_code_id is not null then
    v_claimed_code_id := app_private.claim_discount_redemption(
      v_code_id, v_order_id, v_code_amount, v_now
    );
    if v_claimed_code_id is null then
      raise exception 'Discount code is no longer available'
        using errcode = 'PT409', detail = 'DISCOUNT_UNAVAILABLE';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Participant and consents (append-only: a withdrawal is a new row).
  -- -------------------------------------------------------------------------
  insert into public.participants (
    event_id, order_id, order_item_id, first_name, last_name, national_id,
    email, phone, city, instagram, extra_fields
  ) values (
    v_event.id, v_order_id, v_item_id,
    v_participant ->> 'firstName', v_participant ->> 'lastName', v_participant ->> 'nationalId',
    v_participant ->> 'email', v_participant ->> 'phone', v_participant ->> 'city',
    v_participant ->> 'instagram', v_participant -> 'extraFields'
  )
  returning id into v_participant_id;

  insert into public.consents (event_id, participant_id, kind, granted, policy_version, ip_address)
  values
    (v_event.id, v_participant_id, 'DATA_PROCESSING', true,
     coalesce(nullif(btrim(p_participant ->> 'consentPolicyVersion'), ''), 'v1'), v_ip),
    (v_event.id, v_participant_id, 'FUTURE_EVENTS',
     coalesce((coalesce(p_participant -> 'consents', '{}'::jsonb) ->> 'futureEvents')::boolean, false),
     coalesce(nullif(btrim(p_participant ->> 'consentPolicyVersion'), ''), 'v1'), v_ip);

  -- -------------------------------------------------------------------------
  -- 8. Payment attempt. Created PENDING: the order is only paid after a verified
  --    Wompi event (Phase 4). Attempt 1 uses the order reference verbatim.
  -- -------------------------------------------------------------------------
  insert into public.payments (
    order_id, attempt, wompi_reference, status, amount_cents, currency, payment_provider
  )
  values (v_order_id, 1, v_reference, 'pending', v_total, v_event.currency, v_provider)
  returning id into v_payment_id;

  return jsonb_build_object(
    'replayed', false,
    'orderId', v_order_id,
    'reference', v_reference,
    'status', 'PENDING',
    'quantity', p_quantity,
    'unitPriceInCents', v_tier.price_cents,
    'pricingTierName', v_tier.name,
    'subtotalInCents', v_subtotal,
    'quantityDiscountInCents', v_quantity_discount,
    'discountCodeInCents', v_code_amount,
    'totalDiscountInCents', v_discount_total,
    'discountCombination', v_policy,
    'totalInCents', v_total,
    'currency', v_event.currency,
    'reservationExpiresAt', to_char(v_reservation_expires_at at time zone 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'paymentAttempt', 1,
    'wompiReference', v_reference,
    'participantId', v_participant_id
  );
end;
$order$;

-- Grants are restated for the new signature (a `create or replace` keeps them, the new parameter
-- set does not inherit anything by itself).
revoke all on function public.create_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.create_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text) to service_role';
  end if;
end
$$;

CREATE OR REPLACE FUNCTION public.create_bundle_order(
  p_event_code text,
  p_ticket_type_code text,
  p_quantity integer,
  p_reservation_minutes integer,
  p_buyer_email text,
  p_buyer_name text,
  p_buyer_phone text,
  p_participant jsonb,
  p_bundle_code text,
  p_discount_code text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_payment_provider text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $bundle_order$
DECLARE
  v_bundle public.ticket_bundles;
  v_result jsonb;
  v_order_id uuid;
  v_order public.orders;
  v_item public.order_items;
  v_tier public.pricing_tiers;
BEGIN
  SELECT b.*
    INTO v_bundle
    FROM public.ticket_bundles b
    JOIN public.events e ON e.id = b.event_id
    JOIN public.ticket_types tt ON tt.id = b.ticket_type_id
   WHERE e.code = upper(btrim(coalesce(p_event_code, '')))
     AND tt.code = upper(btrim(coalesce(p_ticket_type_code, '')))
     AND b.code = upper(btrim(coalesce(p_bundle_code, '')))
     AND b.is_active;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Named bundle not found'
      USING errcode = 'PT404', detail = 'BUNDLE_NOT_FOUND';
  END IF;

  IF p_quantity IS DISTINCT FROM v_bundle.included_admissions THEN
    RAISE EXCEPTION 'Quantity must equal the admissions included in this bundle'
      USING errcode = 'PT409', detail = 'BUNDLE_QUANTITY_INVALID';
  END IF;

  IF nullif(btrim(coalesce(p_discount_code, '')), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Promo codes cannot be combined with a named bundle'
      USING errcode = 'PT409', detail = 'BUNDLE_DISCOUNT_UNSUPPORTED';
  END IF;

  v_result := public.create_order(
    p_event_code,
    p_ticket_type_code,
    p_quantity,
    p_reservation_minutes,
    p_buyer_email,
    p_buyer_name,
    p_buyer_phone,
    p_participant,
    NULL,
    p_idempotency_key,
    p_ip_address,
    p_user_agent,
    p_payment_provider
  );
  v_order_id := (v_result ->> 'orderId')::uuid;

  SELECT oi.*
    INTO v_item
    FROM public.order_items oi
   WHERE oi.order_id = v_order_id
   ORDER BY oi.created_at, oi.id
   LIMIT 1
   FOR UPDATE;

  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Bundle order has no order item'
      USING errcode = 'PT409', detail = 'BUNDLE_ORDER_INVALID';
  END IF;

  -- An idempotency replay is only valid for the same product as the original order.
  IF coalesce((v_result ->> 'replayed')::boolean, false) THEN
    IF v_item.bundle_id IS DISTINCT FROM v_bundle.id THEN
      RAISE EXCEPTION 'Idempotency key belongs to another product'
        USING errcode = 'PT409', detail = 'IDEMPOTENCY_KEY_CONFLICT';
    END IF;
    SELECT o.* INTO v_order FROM public.orders o WHERE o.id = v_order_id;
    SELECT t.* INTO v_tier FROM public.pricing_tiers t WHERE t.id = v_item.pricing_tier_id;
    RETURN v_result || jsonb_build_object(
      'unitPriceInCents', v_item.unit_price_cents,
      'pricingTierName', v_tier.name,
      'subtotalInCents', v_order.subtotal_cents,
      'quantityDiscountInCents', v_order.quantity_discount_cents,
      'discountCodeInCents', v_order.discount_code_cents,
      'totalDiscountInCents', v_order.quantity_discount_cents + v_order.discount_code_cents,
      'totalInCents', v_order.total_cents
    );
  END IF;

  IF v_item.pricing_tier_id IS DISTINCT FROM v_bundle.pricing_tier_id THEN
    RAISE EXCEPTION 'Named bundle is not available in the active sales stage'
      USING errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
  END IF;

  IF v_item.quantity <> v_bundle.included_admissions THEN
    RAISE EXCEPTION 'Order quantity does not match the named bundle'
      USING errcode = 'PT409', detail = 'BUNDLE_QUANTITY_INVALID';
  END IF;

  SELECT t.* INTO v_tier FROM public.pricing_tiers t WHERE t.id = v_item.pricing_tier_id;

  UPDATE public.order_items
     SET bundle_id = v_bundle.id,
         ticket_type_name = v_bundle.name,
         unit_price_cents = v_bundle.price_cents / v_bundle.included_admissions,
         quantity_discount_cents = 0,
         line_total_cents = v_bundle.price_cents
   WHERE id = v_item.id;

  UPDATE public.orders
     SET subtotal_cents = v_bundle.price_cents,
         quantity_discount_cents = 0,
         discount_code_cents = 0,
         discount_code_id = NULL,
         total_cents = v_bundle.price_cents
   WHERE id = v_order_id
  RETURNING * INTO v_order;

  UPDATE public.payments
     SET amount_cents = v_bundle.price_cents
   WHERE order_id = v_order_id AND attempt = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bundle order has no pending payment attempt'
      USING errcode = 'PT409', detail = 'BUNDLE_ORDER_INVALID';
  END IF;

  RETURN v_result || jsonb_build_object(
    'unitPriceInCents', v_bundle.price_cents / v_bundle.included_admissions,
    'pricingTierName', v_tier.name,
    'subtotalInCents', v_bundle.price_cents,
    'quantityDiscountInCents', 0,
    'discountCodeInCents', 0,
    'totalDiscountInCents', 0,
    'totalInCents', v_bundle.price_cents
  );
END;
$bundle_order$;

comment on function public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) is
  'Atomically creates a pending order for a named bundle at its stored catalogue price while reserving the bundle admissions from its configured sales stage and recording the payment provider.';

revoke all on function public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) to service_role';
  end if;
end
$$;
