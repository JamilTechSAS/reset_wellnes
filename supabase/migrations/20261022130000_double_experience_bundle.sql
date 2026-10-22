-- Named bundle product: Doble experiencia costs $340,000 COP for exactly two General admissions.
-- This is a product price, not a quantity discount; buying two individual General tickets remains $400,000.

CREATE TABLE public.ticket_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
  ticket_type_id uuid NOT NULL REFERENCES public.ticket_types (id) ON DELETE CASCADE,
  pricing_tier_id uuid NOT NULL,
  code text NOT NULL CHECK (code = upper(code) AND code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  included_admissions integer NOT NULL CHECK (included_admissions >= 2),
  price_cents bigint NOT NULL CHECK (
    price_cents > 0 AND price_cents % NULLIF(included_admissions, 0) = 0
  ),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_bundles_event_code_unique UNIQUE (event_id, code),
  CONSTRAINT ticket_bundles_stage_ticket_type_fk
    FOREIGN KEY (pricing_tier_id, ticket_type_id)
    REFERENCES public.pricing_tiers (id, ticket_type_id)
    ON DELETE CASCADE
);

COMMENT ON TABLE public.ticket_bundles IS
  'Named products that consume multiple admissions at a catalogued package price. Bundle pricing is independent from quantity discounts and promo codes.';
COMMENT ON COLUMN public.ticket_bundles.included_admissions IS
  'Number of ordinary event admissions consumed when this named bundle is purchased.';
COMMENT ON COLUMN public.ticket_bundles.price_cents IS
  'Full product price in COP centavos; this is not a discount amount.';

CREATE INDEX ticket_bundles_event_active_idx
  ON public.ticket_bundles (event_id, is_active);
CREATE INDEX ticket_bundles_tier_idx
  ON public.ticket_bundles (pricing_tier_id);

CREATE TRIGGER ticket_bundles_set_updated_at
  BEFORE UPDATE ON public.ticket_bundles
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();

ALTER TABLE public.ticket_bundles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticket_bundles FROM PUBLIC;

ALTER TABLE public.order_items
  ADD COLUMN bundle_id uuid REFERENCES public.ticket_bundles (id) ON DELETE RESTRICT;
CREATE INDEX order_items_bundle_id_idx ON public.order_items (bundle_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.ticket_bundles FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.ticket_bundles FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.ticket_bundles TO service_role';
  END IF;
END
$$;

-- Quote the named bundle using the authoritative stage/availability rules, then overlay only
-- the bundle product price. The base quote still prevents General from skipping a live Preventa.
CREATE OR REPLACE FUNCTION public.quote_bundle_order_price(
  p_event_code text,
  p_ticket_type_code text,
  p_quantity integer,
  p_reservation_minutes integer,
  p_bundle_code text,
  p_discount_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $bundle_quote$
DECLARE
  v_bundle public.ticket_bundles;
  v_quote jsonb;
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

  v_quote := public.quote_order_price(
    p_event_code,
    p_ticket_type_code,
    p_quantity,
    p_reservation_minutes,
    p_discount_code
  );

  SELECT t.*
    INTO v_tier
    FROM public.pricing_tiers t
   WHERE t.ticket_type_id = v_bundle.ticket_type_id
     AND t.sequence = (v_quote #>> '{pricingTier,sequence}')::integer;

  IF v_tier.id IS DISTINCT FROM v_bundle.pricing_tier_id THEN
    RAISE EXCEPTION 'Named bundle is not available in the active sales stage'
      USING errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
  END IF;

  RETURN v_quote || jsonb_build_object(
    'ticketType', jsonb_build_object('code', v_bundle.code, 'name', v_bundle.name),
    'bundleCode', v_bundle.code,
    'quantity', v_bundle.included_admissions,
    'pricingTier', jsonb_build_object(
      'name', v_tier.name,
      'sequence', v_tier.sequence,
      'unitPriceInCents', v_bundle.price_cents / v_bundle.included_admissions
    ),
    'subtotalInCents', v_bundle.price_cents,
    'quantityDiscount', jsonb_build_object(
      'applies', false, 'percentBps', 0, 'amountInCents', 0
    ),
    'quantityDiscountInCents', 0,
    'discountCodeInCents', 0,
    'totalDiscountInCents', 0,
    'totalInCents', v_bundle.price_cents
  );
END;
$bundle_quote$;

COMMENT ON FUNCTION public.quote_bundle_order_price(text, text, integer, integer, text, text) IS
  'Authoritative quote for a named bundle. Bundles use their own stored product price, reserve their included admissions, and never act as a generic quantity discount.';

-- Create the normal, fully audited order first inside this transaction so existing validation,
-- idempotency, participant/consent capture, inventory reservation and payment creation are reused.
-- Then change that pending order to the catalogue price of the explicitly requested bundle.
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
  p_user_agent text DEFAULT NULL
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
    p_user_agent
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
    SELECT t.* INTO v_tier FROM public.pricing_tiers t WHERE t.id = v_item.pricing_tier_id;
    RETURN v_result || jsonb_build_object(
      'unitPriceInCents', v_bundle.price_cents / v_bundle.included_admissions,
      'pricingTierName', v_tier.name,
      'subtotalInCents', v_bundle.price_cents,
      'quantityDiscountInCents', 0,
      'discountCodeInCents', 0,
      'totalDiscountInCents', 0,
      'totalInCents', v_bundle.price_cents
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

COMMENT ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text) IS
  'Atomically creates a pending order for a named bundle at its stored catalogue price while reserving the bundle admissions from its configured sales stage.';

REVOKE ALL ON FUNCTION public.quote_bundle_order_price(text, text, integer, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.quote_bundle_order_price(text, text, integer, integer, text, text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.quote_bundle_order_price(text, text, integer, integer, text, text) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.quote_bundle_order_price(text, text, integer, integer, text, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.create_bundle_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text, text) TO service_role';
  END IF;
END
$$;
