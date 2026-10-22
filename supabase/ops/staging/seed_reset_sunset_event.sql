-- Confirmed business catalog for Re set Sunset — Vol. 1.
-- All timestamps are UTC; the event and sale windows use America/Bogota (UTC-5).

DO $$
DECLARE
  v_event_id uuid;
  v_ticket_type_id uuid;
  v_preventa_tier_id uuid;
BEGIN
  INSERT INTO public.events (
    code, name, venue_name, venue_address, city, starts_at, ends_at, timezone,
    currency, status, capacity
  ) VALUES (
    'RESET-SUNSET-2026',
    'Re set Sunset — Vol. 1',
    'Terraza del hotel GHL',
    NULL,
    'Montería',
    timestamptz '2026-11-15 18:00:00+00',
    timestamptz '2026-11-16 00:00:00+00',
    'America/Bogota',
    'COP',
    'PUBLISHED',
    100
  )
  ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    venue_name = EXCLUDED.venue_name,
    venue_address = EXCLUDED.venue_address,
    city = EXCLUDED.city,
    starts_at = EXCLUDED.starts_at,
    ends_at = EXCLUDED.ends_at,
    timezone = EXCLUDED.timezone,
    currency = EXCLUDED.currency,
    status = EXCLUDED.status,
    capacity = EXCLUDED.capacity
  RETURNING id INTO v_event_id;

  INSERT INTO public.ticket_types (event_id, code, name, min_per_order, max_per_order)
  VALUES (v_event_id, 'GENERAL', 'Entrada general', 1, NULL)
  ON CONFLICT (event_id, code) DO UPDATE SET
    name = EXCLUDED.name,
    min_per_order = EXCLUDED.min_per_order,
    max_per_order = EXCLUDED.max_per_order,
    is_active = true
  RETURNING id INTO v_ticket_type_id;

  -- 30 tickets in preventa; later General sales have an independent 70-ticket limit.
  -- The General stage cannot be selected until preventa is exhausted or its window ends.
  INSERT INTO public.pricing_tiers (
    ticket_type_id, name, sequence, price_cents, quantity_limit,
    sales_starts_at, sales_ends_at, is_active
  ) VALUES (
    v_ticket_type_id, 'Preventa', 1, 16000000, 30,
    timestamptz '2026-10-24 15:00:00+00',
    timestamptz '2026-11-14 05:00:00+00',
    true
  )
  ON CONFLICT (ticket_type_id, sequence) DO UPDATE SET
    name = EXCLUDED.name,
    price_cents = EXCLUDED.price_cents,
    quantity_limit = EXCLUDED.quantity_limit,
    sales_starts_at = EXCLUDED.sales_starts_at,
    sales_ends_at = EXCLUDED.sales_ends_at,
    is_active = true
  RETURNING id INTO v_preventa_tier_id;

  INSERT INTO public.pricing_tiers (
    ticket_type_id, name, sequence, price_cents, quantity_limit,
    sales_starts_at, sales_ends_at, is_active
  ) VALUES (
    v_ticket_type_id, 'General', 2, 20000000, 70,
    timestamptz '2026-10-24 15:00:00+00',
    timestamptz '2026-11-14 05:00:00+00',
    true
  )
  ON CONFLICT (ticket_type_id, sequence) DO UPDATE SET
    name = EXCLUDED.name,
    price_cents = EXCLUDED.price_cents,
    quantity_limit = EXCLUDED.quantity_limit,
    sales_starts_at = EXCLUDED.sales_starts_at,
    sales_ends_at = EXCLUDED.sales_ends_at,
    is_active = true;

END
$$;
