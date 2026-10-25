-- ---------------------------------------------------------------------------
-- Migration 20261024200000_bundle_availability_reason
-- One refusal code for one rule: a named bundle that its stage cannot sell.
--
-- 20261024190000 made the STAGE own the per-order cap, and the bundle quote
-- (`quote_bundle_order_price`) answers `PT409 / BUNDLE_NOT_AVAILABLE` when the bundle's stage
-- is not the active one. `create_bundle_order` did not: it forwards to `create_order` first and
-- only compared stages afterwards, so while Preventa is active the single-ticket cap fired
-- first and the same refusal arrived as `PT409 / QUANTITY_LIMIT`.
--
-- That is a wrong answer for the buyer ("the sale allows one ticket" vs. "this package is not
-- on sale yet") and it split one rule across two codes. The guard below runs BEFORE the
-- delegation, so nothing is written when it refuses: no order, no order item, no payment
-- attempt, no participant, no inventory reservation.
--
-- Replay is preserved on purpose. `create_order` answers an idempotency replay before it reads
-- the event or the stage, so a key that already names an order must keep receiving that order
-- even if the stage has moved since (the QA window IS restored). The guard is therefore skipped
-- when the key already exists; `create_order` owns the replay and its conflict rules. Anything
-- else — a new purchase — is judged by the stage first.
--
-- Unchanged: quantity must equal the admissions the bundle includes (BUNDLE_QUANTITY_INVALID),
-- promo codes stay refused, the bundle price overlay, participant handling, provider
-- attribution, the payment amount rewrite, idempotency-key semantics and the ACLs. When no
-- stage can serve the bundle's admissions the stage is null on purpose and `create_order` raises
-- SOLD_OUT, which is the truthful answer (inventory, not schedule).
-- ---------------------------------------------------------------------------

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
  v_active_id uuid;
  v_is_replay boolean := false;
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

  -- Would create_order answer a replay? Mirror its key predicate exactly (its first step), so a
  -- retry keeps its order and only a new purchase is judged by the stage.
  IF p_idempotency_key IS NOT NULL
     AND length(p_idempotency_key) >= 16
     AND p_idempotency_key ~ '^[!-~]+$' THEN
    SELECT true INTO v_is_replay
      FROM public.orders o
     WHERE o.idempotency_key = p_idempotency_key;
    v_is_replay := coalesce(v_is_replay, false);
  END IF;

  IF NOT v_is_replay THEN
    -- Same two checks the bundle quote applies, so quote and creation cannot disagree.
    v_active_id := app_private.active_pricing_tier_id(
      v_bundle.ticket_type_id, now(), v_bundle.included_admissions
    );
    -- A null active stage means "no stage can serve this quantity": let create_order raise
    -- SOLD_OUT instead of claiming the package is merely out of season.
    IF v_active_id IS NOT NULL AND v_active_id IS DISTINCT FROM v_bundle.pricing_tier_id THEN
      RAISE EXCEPTION 'Named bundle is not available in the active sales stage'
        USING errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
    END IF;

    SELECT t.* INTO v_tier FROM public.pricing_tiers t WHERE t.id = v_bundle.pricing_tier_id;
    IF v_tier.max_per_order IS NOT NULL
       AND v_bundle.included_admissions > v_tier.max_per_order THEN
      RAISE EXCEPTION 'Named bundle cannot be bought in the active sales stage'
        USING errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
    END IF;
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
  'Atomically creates a pending order for a named bundle at its stored catalogue price while reserving the bundle admissions from its configured sales stage and recording the payment provider. Refuses with BUNDLE_NOT_AVAILABLE when the bundle''s stage is not the active one, matching the quote, and lets an idempotency replay through unchanged.';

-- `create or replace` keeps the existing ACL; it is restated so a fresh environment ends in the
-- same posture as the one built by 20261024150000.
REVOKE ALL ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text, text) TO service_role';
  END IF;
END
$$;
