-- Production catalogue for Re set Sunset — Vol. 1.
--
-- Run once against production (pzogdjjdkgolybfcegcs) after the migration sequence is applied:
--
--   npx supabase db query --linked --project-ref pzogdjjdkgolybfcegcs \
--     -f supabase/ops/production/seed_reset_sunset_event.sql
--
-- All timestamps are UTC; every sale window is America/Bogota (UTC-5).
--
-- This script is idempotent and counter-preserving:
--   * every write is an upsert on a natural key (`events.code`, `ticket_types.event_id+code`,
--     `pricing_tiers.ticket_type_id+sequence`, `ticket_bundles.event_id+code`);
--   * it never writes `quantity_sold` / `quantity_reserved`, so re-running it cannot fabricate or
--     reset inventory, and a re-run after sales start is harmless;
--   * `DOUBLE_EXPERIENCE` is written with `is_active = false` on every run, so the retired package
--     can never be reactivated by re-running this script.
--
-- Prices are stored in `price_cents`, which the schema defines as hundredths of a peso:
-- COP 159.900 -> 15990000, COP 199.900 -> 19990000, COP 539.700 -> 53970000.

DO $$
DECLARE
  v_event_id uuid;
  v_ticket_type_id uuid;
  v_preventa_tier_id uuid;
  v_general_tier_id uuid;
  v_missing text;
BEGIN
  -- ---------------------------------------------------------------------------
  -- Preconditions: refuse to seed a database that does not have the schema this
  -- catalogue depends on (the 20261024 migration sequence).
  -- ---------------------------------------------------------------------------
  select string_agg(name, ', ')
    into v_missing
  from (values ('ticket_bundles'), ('order_email_deliveries'), ('checkout_sessions')) as required(name)
  where to_regclass('public.' || required.name) is null;

  if v_missing is not null then
    raise exception 'production seed requires missing table(s): %', v_missing;
  end if;

  -- A different event must never be silently renamed into this one.
  if exists (
    select 1
    from public.events
    where status = 'PUBLISHED'
      and code <> 'RESET-SUNSET-2026'
  ) then
    raise exception 'another PUBLISHED event already exists; refusing to seed a second one';
  end if;

  -- ---------------------------------------------------------------------------
  -- Event: one shared pool of 100 admissions for the whole event.
  -- ---------------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------------
  -- Ticket type: GENERAL. Both stages are tiers of this one product.
  -- ---------------------------------------------------------------------------
  INSERT INTO public.ticket_types (event_id, code, name, min_per_order, max_per_order)
  VALUES (v_event_id, 'GENERAL', 'Entrada general', 1, NULL)
  ON CONFLICT (event_id, code) DO UPDATE SET
    name = EXCLUDED.name,
    min_per_order = EXCLUDED.min_per_order,
    max_per_order = EXCLUDED.max_per_order,
    is_active = true
  RETURNING id INTO v_ticket_type_id;

  -- ---------------------------------------------------------------------------
  -- Preventa: COP 159.900, 2026-10-25 10:00 -> 2026-10-28 23:59 Bogotá,
  -- maximum one admission per order. `quantity_limit` stays NULL: inventory is
  -- the event-wide 100-admission capacity, not a per-stage quota.
  -- ---------------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------------
  -- General: COP 199.900, 2026-10-29 00:01 -> 2026-11-13 23:59 Bogotá, no
  -- per-order cap and no quantity discount. The one-minute gap after Preventa
  -- closes is deliberate: no stage is open between 23:59:59 and 00:01.
  -- ---------------------------------------------------------------------------
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

  -- ---------------------------------------------------------------------------
  -- Bundles.
  -- ---------------------------------------------------------------------------
  -- Retired for new purchases, kept readable for the historical orders that reference it.
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

  -- Comparte tu experiencia: exactly three admissions for COP 539.700 (COP 179.900 each),
  -- sold only inside the General stage.
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

  raise notice 'seeded event % (capacity %)', v_event_id, 100;
END
$$;

-- Verification: the rows this script is responsible for, read back from the database.
select
  e.code as event_code,
  e.venue_name,
  e.city,
  e.timezone,
  e.capacity,
  tt.code as ticket_type,
  t.sequence,
  t.name as tier,
  t.price_cents,
  t.max_per_order,
  t.sales_starts_at,
  t.sales_ends_at,
  t.quantity_sold,
  t.quantity_reserved,
  t.quantity_limit
from public.events e
join public.ticket_types tt on tt.event_id = e.id
join public.pricing_tiers t on t.ticket_type_id = tt.id
where e.code = 'RESET-SUNSET-2026'
order by t.sequence;

select
  b.code as bundle_code,
  b.name,
  b.included_admissions,
  b.price_cents,
  b.is_active
from public.ticket_bundles b
join public.events e on e.id = b.event_id
where e.code = 'RESET-SUNSET-2026'
order by b.code;
