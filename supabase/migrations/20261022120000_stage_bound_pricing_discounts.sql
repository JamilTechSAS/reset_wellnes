-- Restrict sales-stage fallback and bind discounts to an explicit sales tier.
-- A later stage only opens after each prior active stage is exhausted or its sales window closes.
-- The selected tier is stored transaction-locally during order creation so both quantity
-- discounts and coupons are evaluated against the exact tier reserved by that order.

ALTER TABLE public.pricing_tiers
  ADD CONSTRAINT pricing_tiers_id_ticket_type_unique UNIQUE (id, ticket_type_id);

ALTER TABLE public.quantity_discounts
  ADD COLUMN pricing_tier_id uuid,
  ADD COLUMN max_quantity integer,
  ADD CONSTRAINT quantity_discounts_max_quantity_check
    CHECK (max_quantity IS NULL OR max_quantity >= min_quantity),
  ADD CONSTRAINT quantity_discounts_stage_ticket_type_fk
    FOREIGN KEY (pricing_tier_id, ticket_type_id)
    REFERENCES public.pricing_tiers (id, ticket_type_id)
    ON DELETE CASCADE;

COMMENT ON COLUMN public.quantity_discounts.pricing_tier_id IS
  'Optional tier scope. When set, this quantity discount only applies to that exact sales stage.';
COMMENT ON COLUMN public.quantity_discounts.max_quantity IS
  'Optional inclusive upper quantity for this discount. NULL means no upper limit.';

ALTER TABLE public.discount_codes
  ADD COLUMN pricing_tier_id uuid,
  ADD COLUMN max_quantity integer;

UPDATE public.discount_codes
   SET max_quantity = GREATEST(min_quantity, 1)
 WHERE max_quantity IS NULL;

ALTER TABLE public.discount_codes
  ALTER COLUMN max_quantity SET DEFAULT 1,
  ALTER COLUMN max_quantity SET NOT NULL,
  ADD CONSTRAINT discount_codes_max_quantity_check
    CHECK (max_quantity >= min_quantity),
  ADD CONSTRAINT discount_codes_stage_requires_ticket_type
    CHECK (pricing_tier_id IS NULL OR ticket_type_id IS NOT NULL),
  ADD CONSTRAINT discount_codes_stage_ticket_type_fk
    FOREIGN KEY (pricing_tier_id, ticket_type_id)
    REFERENCES public.pricing_tiers (id, ticket_type_id)
    ON DELETE CASCADE;

COMMENT ON COLUMN public.discount_codes.pricing_tier_id IS
  'Required for a coupon to be usable: it must target the exact pricing tier selected by the backend.';
COMMENT ON COLUMN public.discount_codes.max_quantity IS
  'Largest purchase quantity allowed for the coupon. Defaults to one ticket.';

-- Stage selection: do not skip an earlier active tier while it has even one unsold unit.
CREATE OR REPLACE FUNCTION app_private.active_pricing_tier_id(
  p_ticket_type_id uuid,
  p_at timestamptz,
  p_quantity integer
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT t.id
    FROM public.pricing_tiers t
   WHERE t.ticket_type_id = p_ticket_type_id
     AND t.is_active
     AND (t.sales_starts_at IS NULL OR t.sales_starts_at <= p_at)
     AND (t.sales_ends_at IS NULL OR t.sales_ends_at > p_at)
     AND (
       t.quantity_limit IS NULL
       OR t.quantity_reserved + t.quantity_sold + p_quantity <= t.quantity_limit
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.pricing_tiers prior
        WHERE prior.ticket_type_id = t.ticket_type_id
          AND prior.sequence < t.sequence
          AND prior.is_active
          AND (prior.sales_starts_at IS NULL OR prior.sales_starts_at <= p_at)
          AND (prior.sales_ends_at IS NULL OR prior.sales_ends_at > p_at)
          AND (
            prior.quantity_limit IS NULL
            OR prior.quantity_reserved + prior.quantity_sold < prior.quantity_limit
          )
     )
   ORDER BY t.sequence
   LIMIT 1;
$$;

COMMENT ON FUNCTION app_private.active_pricing_tier_id(uuid, timestamptz, integer) IS
  'Selects the earliest eligible tier but never skips a prior in-window tier that still has inventory, even when the requested quantity will not fit.';

CREATE OR REPLACE FUNCTION app_private.selected_pricing_tier_id(
  p_ticket_type_id uuid,
  p_quantity integer,
  p_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_selected uuid;
BEGIN
  BEGIN
    v_selected := NULLIF(pg_catalog.current_setting('app.selected_pricing_tier_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_selected := NULL;
  END;

  IF v_selected IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.pricing_tiers t
     WHERE t.id = v_selected
       AND t.ticket_type_id = p_ticket_type_id
  ) THEN
    RETURN v_selected;
  END IF;

  RETURN app_private.active_pricing_tier_id(p_ticket_type_id, p_at, p_quantity);
END;
$$;

COMMENT ON FUNCTION app_private.selected_pricing_tier_id(uuid, integer, timestamptz) IS
  'Returns the tier reserved in the current order transaction, or derives the active tier for a side-effect-free quote.';

CREATE OR REPLACE FUNCTION app_private.reserve_pricing_tier(
  p_ticket_type_id uuid,
  p_quantity integer,
  p_at timestamptz
)
RETURNS public.pricing_tiers
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $reserve$
DECLARE
  v_tier public.pricing_tiers;
BEGIN
  UPDATE public.pricing_tiers t
     SET quantity_reserved = t.quantity_reserved + p_quantity
   WHERE t.ticket_type_id = p_ticket_type_id
     AND t.is_active
     AND (t.sales_starts_at IS NULL OR t.sales_starts_at <= p_at)
     AND (t.sales_ends_at IS NULL OR t.sales_ends_at > p_at)
     AND (
       t.quantity_limit IS NULL
       OR t.quantity_reserved + t.quantity_sold + p_quantity <= t.quantity_limit
     )
     AND t.sequence = (
       SELECT MIN(candidate.sequence)
         FROM public.pricing_tiers candidate
        WHERE candidate.ticket_type_id = t.ticket_type_id
          AND candidate.is_active
          AND (candidate.sales_starts_at IS NULL OR candidate.sales_starts_at <= p_at)
          AND (candidate.sales_ends_at IS NULL OR candidate.sales_ends_at > p_at)
          AND (
            candidate.quantity_limit IS NULL
            OR candidate.quantity_reserved + candidate.quantity_sold + p_quantity
               <= candidate.quantity_limit
          )
          AND NOT EXISTS (
            SELECT 1
              FROM public.pricing_tiers prior
             WHERE prior.ticket_type_id = candidate.ticket_type_id
               AND prior.sequence < candidate.sequence
               AND prior.is_active
               AND (prior.sales_starts_at IS NULL OR prior.sales_starts_at <= p_at)
               AND (prior.sales_ends_at IS NULL OR prior.sales_ends_at > p_at)
               AND (
                 prior.quantity_limit IS NULL
                 OR prior.quantity_reserved + prior.quantity_sold < prior.quantity_limit
               )
          )
     )
  RETURNING t.* INTO v_tier;

  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'No sales stage can serve this quantity'
      USING errcode = 'PT409', detail = 'SOLD_OUT';
  END IF;

  PERFORM pg_catalog.set_config('app.selected_pricing_tier_id', v_tier.id::text, true);
  RETURN v_tier;
END;
$reserve$;

COMMENT ON FUNCTION app_private.reserve_pricing_tier(uuid, integer, timestamptz) IS
  'Atomically reserves the earliest available tier without skipping a prior in-window tier that still has stock; records the selected tier for this transaction.';

CREATE OR REPLACE FUNCTION app_private.quantity_discount_bps(
  p_ticket_type_id uuid,
  p_quantity integer
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tier_id uuid;
BEGIN
  v_tier_id := app_private.selected_pricing_tier_id(
    p_ticket_type_id, p_quantity, pg_catalog.transaction_timestamp()
  );

  RETURN (
    SELECT COALESCE(MAX(d.percent_bps), 0)
      FROM public.quantity_discounts d
     WHERE d.ticket_type_id = p_ticket_type_id
       AND d.is_active
       AND d.min_quantity <= p_quantity
       AND (d.max_quantity IS NULL OR p_quantity <= d.max_quantity)
       AND (d.pricing_tier_id IS NULL OR d.pricing_tier_id = v_tier_id)
  );
END;
$$;

COMMENT ON FUNCTION app_private.quantity_discount_bps(uuid, integer) IS
  'Highest applicable active quantity-discount rate for the selected tier and quantity (0 when none applies).';

CREATE OR REPLACE FUNCTION app_private.evaluate_discount_code(
  p_event_id uuid,
  p_ticket_type_id uuid,
  p_code text,
  p_quantity integer,
  p_subtotal_cents bigint,
  p_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_row public.discount_codes;
  v_reason text;
  v_amount bigint := 0;
  v_remaining integer;
  v_tier_id uuid;
BEGIN
  v_tier_id := app_private.selected_pricing_tier_id(p_ticket_type_id, p_quantity, p_at);

  IF v_code = '' THEN
    RETURN jsonb_build_object(
      'supplied', false,
      'applies', false,
      'reason', 'NOT_SUPPLIED',
      'code', null,
      'discountCodeId', null,
      'kind', null,
      'percentBps', null,
      'amountInCents', 0,
      'remainingRedemptions', null
    );
  END IF;

  SELECT * INTO v_row
    FROM public.discount_codes c
   WHERE c.event_id = p_event_id
     AND c.code = v_code;

  IF NOT FOUND THEN
    v_reason := 'NOT_FOUND';
  ELSIF NOT v_row.is_active THEN
    v_reason := 'INACTIVE';
  ELSIF v_row.valid_from IS NOT NULL AND v_row.valid_from > p_at THEN
    v_reason := 'NOT_STARTED';
  ELSIF v_row.valid_until IS NOT NULL AND v_row.valid_until <= p_at THEN
    v_reason := 'EXPIRED';
  ELSIF v_row.max_redemptions IS NOT NULL AND v_row.redeemed_count >= v_row.max_redemptions THEN
    v_reason := 'EXHAUSTED';
  ELSIF v_row.ticket_type_id IS NOT NULL AND v_row.ticket_type_id <> p_ticket_type_id THEN
    v_reason := 'WRONG_TICKET_TYPE';
  ELSIF v_row.pricing_tier_id IS NULL OR v_row.pricing_tier_id <> v_tier_id THEN
    v_reason := 'WRONG_SALES_STAGE';
  ELSIF p_quantity < v_row.min_quantity THEN
    v_reason := 'MIN_QUANTITY';
  ELSIF p_quantity > v_row.max_quantity THEN
    v_reason := 'WRONG_QUANTITY';
  ELSE
    v_reason := 'OK';
  END IF;

  IF v_reason = 'OK' THEN
    v_amount := app_private.discount_code_amount_cents(
      v_row.kind, v_row.percent_bps, v_row.amount_cents, p_subtotal_cents
    );
  END IF;

  IF v_row.max_redemptions IS NULL THEN
    v_remaining := NULL;
  ELSE
    v_remaining := greatest(v_row.max_redemptions - v_row.redeemed_count, 0);
  END IF;

  RETURN jsonb_build_object(
    'supplied', true,
    'applies', v_reason = 'OK',
    'reason', v_reason,
    'code', CASE WHEN v_reason = 'NOT_FOUND' THEN NULL ELSE v_row.code END,
    'discountCodeId', CASE WHEN v_reason = 'NOT_FOUND' THEN NULL ELSE v_row.id END,
    'kind', CASE WHEN v_reason = 'NOT_FOUND' THEN NULL ELSE v_row.kind END,
    'percentBps', CASE WHEN v_reason = 'NOT_FOUND' THEN NULL ELSE v_row.percent_bps END,
    'amountInCents', v_amount,
    'remainingRedemptions', CASE WHEN v_reason = 'NOT_FOUND' THEN NULL ELSE v_remaining END
  );
END;
$$;

COMMENT ON FUNCTION app_private.evaluate_discount_code(uuid, uuid, text, integer, bigint, timestamptz) IS
  'Evaluates active window, usage count, ticket type, exact pricing tier, and min/max quantity. Reasons include WRONG_SALES_STAGE and WRONG_QUANTITY.';

REVOKE ALL ON FUNCTION app_private.selected_pricing_tier_id(uuid, integer, timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app_private.selected_pricing_tier_id(uuid, integer, timestamptz) TO service_role';
  END IF;
END
$$;
