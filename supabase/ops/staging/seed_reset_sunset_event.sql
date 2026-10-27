-- Confirmed business catalog for Re set Sunset — Vol. 1.
-- All timestamps are UTC; the event and sale windows use America/Bogota (UTC-5).

DO $$
DECLARE
  v_event_id uuid;
  v_ticket_type_id uuid;
  v_preventa_tier_id uuid;
  v_general_tier_id uuid;
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

  -- One shared pool of 100 admissions for the whole event: `events.capacity` is the only
  -- inventory ceiling, so `quantity_limit` stays NULL for every stage (no 30/70 split).
  -- Preventa: 2026-10-25 10:00 → 2026-10-28 23:59 Bogotá (UTC-5), one admission per order.
  -- 2026-10-29 00:00 → 00:00:59.999 has no stage open at all; General opens at 00:01.
  -- COP 159.900 (price_cents is hundredths of a peso). Migration 20261024220000 reprices an
  -- already-seeded environment; this seed is the same value so a fresh database cannot come up
  -- with the old COP 160.000 by re-running it.
  INSERT INTO public.pricing_tiers (
    ticket_type_id, name, sequence, price_cents, quantity_limit, max_per_order,
    sales_starts_at, sales_ends_at, is_active
  ) VALUES (
    v_ticket_type_id, 'Preventa', 1, 15990000, NULL, 1,
    timestamptz '2026-10-25 15:00:00+00',
    timestamptz '2026-10-29 05:00:00+00',
    true
  )
  ON CONFLICT (ticket_type_id, sequence) DO UPDATE SET
    name = EXCLUDED.name,
    price_cents = EXCLUDED.price_cents,
    quantity_limit = EXCLUDED.quantity_limit,
    max_per_order = EXCLUDED.max_per_order,
    sales_starts_at = EXCLUDED.sales_starts_at,
    sales_ends_at = EXCLUDED.sales_ends_at,
    is_active = true
  RETURNING id INTO v_preventa_tier_id;

  INSERT INTO public.pricing_tiers (
    ticket_type_id, name, sequence, price_cents, quantity_limit, max_per_order,
    sales_starts_at, sales_ends_at, is_active
  ) VALUES (
    v_ticket_type_id, 'General', 2, 19990000, NULL, NULL,
    timestamptz '2026-10-29 05:01:00+00',
    timestamptz '2026-11-14 05:00:00+00',
    true
  )
  ON CONFLICT (ticket_type_id, sequence) DO UPDATE SET
    name = EXCLUDED.name,
    price_cents = EXCLUDED.price_cents,
    quantity_limit = EXCLUDED.quantity_limit,
    max_per_order = EXCLUDED.max_per_order,
    sales_starts_at = EXCLUDED.sales_starts_at,
    sales_ends_at = EXCLUDED.sales_ends_at,
    is_active = true
  RETURNING id INTO v_general_tier_id;

  -- Retired for new purchases, kept readable for the orders that already reference it.
  INSERT INTO public.ticket_bundles (
    event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents, is_active
  ) VALUES (
    v_event_id, v_ticket_type_id, v_general_tier_id, 'DOUBLE_EXPERIENCE',
    'Doble experiencia', 2, 34000000, false
  )
  ON CONFLICT (event_id, code) DO UPDATE SET
    ticket_type_id = EXCLUDED.ticket_type_id,
    pricing_tier_id = EXCLUDED.pricing_tier_id,
    name = EXCLUDED.name,
    included_admissions = EXCLUDED.included_admissions,
    price_cents = EXCLUDED.price_cents,
    is_active = false;

  INSERT INTO public.ticket_bundles (
    event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents, is_active
  ) VALUES (
    v_event_id, v_ticket_type_id, v_general_tier_id, 'SHARE_EXPERIENCE',
    'Comparte tu experiencia', 3, 53970000, true
  )
  ON CONFLICT (event_id, code) DO UPDATE SET
    ticket_type_id = EXCLUDED.ticket_type_id,
    pricing_tier_id = EXCLUDED.pricing_tier_id,
    name = EXCLUDED.name,
    included_admissions = EXCLUDED.included_admissions,
    price_cents = EXCLUDED.price_cents,
    is_active = true;

END
$$;
