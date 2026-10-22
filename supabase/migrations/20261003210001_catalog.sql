-- ---------------------------------------------------------------------------
-- Migration 20261003210001_catalog
-- Phase 2 / part 1 of 7: the event catalog.
--
-- Everything about "what is for sale" lives here: the event, its ticket types, the sales
-- stages (pricing tiers) with their inventory counters, optional quantity-based discounts
-- and the discount codes.
--
-- No business VALUE is created by this migration: no price, no quantity, no date, no
-- discount. Operators load those rows later (Phase 3). The schema only guarantees that
-- whatever values exist are internally consistent.
--
-- New enums introduced here:
--   event_status  - event lifecycle (DRAFT -> PUBLISHED -> CLOSED)
--   discount_kind - the discount model (PERCENT | FIXED), because pricing branches on it
-- ---------------------------------------------------------------------------

create type public.event_status as enum ('DRAFT', 'PUBLISHED', 'CLOSED');

comment on type public.event_status is
  'Event lifecycle. Only PUBLISHED events are on sale; CLOSED stops new orders without touching existing tickets.';

create type public.discount_kind as enum ('PERCENT', 'FIXED');

comment on type public.discount_kind is
  'Discount model. PERCENT uses percent_bps (basis points, integer), FIXED uses amount_cents.';

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  -- Short stable code used in order references and URLs, e.g. TAT-2026.
  code text not null unique
    check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  name text not null
    check (length(btrim(name)) between 1 and 200 and name !~ '[\n\r\t]'),
  description text,
  venue_name text,
  venue_address text,
  city text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  timezone text not null default 'America/Bogota'
    check (length(btrim(timezone)) between 1 and 64),
  -- Wompi (Colombia) only supports COP. A second currency would need a migration and a
  -- currency-aware pricing path, so the constraint is explicit rather than implied.
  currency text not null default 'COP'
    check (currency = 'COP'),
  status public.event_status not null default 'DRAFT',
  -- NULL means "no global cap configured". The client confirms the real number (≈120 for
  -- the current event); nothing is invented here.
  capacity integer
    check (capacity is null or capacity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_window_check check (ends_at is null or ends_at > starts_at)
);

comment on table public.events is
  'An event that sells tickets. Reusable: nothing about a specific event is hardcoded in code.';

create trigger events_set_updated_at
  before update on public.events
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- ticket_types
-- ---------------------------------------------------------------------------
create table public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  code text not null
    check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name text not null
    check (length(btrim(name)) between 1 and 120 and name !~ '[\n\r\t]'),
  description text,
  is_active boolean not null default true,
  min_per_order integer not null default 1
    check (min_per_order >= 1),
  -- NULL means "no per-order limit". Not defaulted, so no cap is silently invented.
  max_per_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ticket_types_event_code_unique unique (event_id, code),
  constraint ticket_types_order_limits_check
    check (max_per_order is null or max_per_order >= min_per_order)
);

comment on table public.ticket_types is
  'Kind of admission for an event (currently a single "Entrada general"). Per-order limits are configured here, not in code.';

create index ticket_types_event_id_idx on public.ticket_types (event_id);

create trigger ticket_types_set_updated_at
  before update on public.ticket_types
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- pricing_tiers (sales stages / presales)
-- ---------------------------------------------------------------------------
create table public.pricing_tiers (
  id uuid primary key default gen_random_uuid(),
  ticket_type_id uuid not null references public.ticket_types (id) on delete cascade,
  name text not null
    check (length(btrim(name)) between 1 and 120 and name !~ '[\n\r\t]'),
  -- Lowest sequence that is active, inside its sales window and still has availability is
  -- the stage an order is priced at (Phase 3). The database stores the ordering, not the rule's output.
  sequence integer not null
    check (sequence >= 1),
  price_cents bigint not null
    check (price_cents >= 0),
  -- NULL means unlimited quantity for this stage.
  quantity_limit integer
    check (quantity_limit is null or quantity_limit > 0),
  -- Inventory is tracked with two counters inside the ordering transaction:
  --   quantity_reserved - held by PENDING orders (released when they expire/cancel)
  --   quantity_sold     - tickets actually paid for
  -- The atomic update is:
  --   update pricing_tiers
  --      set quantity_reserved = quantity_reserved + n
  --    where id = :tier
  --      and (quantity_limit is null
  --           or quantity_reserved + quantity_sold + n <= quantity_limit)
  --   returning id;   -- no row => sold out
  -- The CHECK constraint below is the second line of defence: even a programming error
  -- cannot oversell the stage.
  quantity_reserved integer not null default 0
    check (quantity_reserved >= 0),
  quantity_sold integer not null default 0
    check (quantity_sold >= 0),
  sales_starts_at timestamptz,
  sales_ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_tiers_sequence_unique unique (ticket_type_id, sequence),
  constraint pricing_tiers_inventory_check
    check (quantity_limit is null or quantity_reserved + quantity_sold <= quantity_limit),
  constraint pricing_tiers_window_check
    check (sales_ends_at is null or sales_starts_at is null or sales_ends_at > sales_starts_at)
);

comment on table public.pricing_tiers is
  'Sales stages (presales) for one ticket type: price, quantity available, sales window and the two inventory counters.';

-- Supports "current stage for this ticket type" lookups.
create index pricing_tiers_active_lookup_idx
  on public.pricing_tiers (ticket_type_id, sequence)
  where is_active;

create trigger pricing_tiers_set_updated_at
  before update on public.pricing_tiers
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- quantity_discounts (optional, structure only)
-- ---------------------------------------------------------------------------
-- The brief requires support for quantity-based discounts. Whether the client uses them,
-- and with which breakpoints, is a business decision: this table is empty until they say so.
create table public.quantity_discounts (
  id uuid primary key default gen_random_uuid(),
  ticket_type_id uuid not null references public.ticket_types (id) on delete cascade,
  min_quantity integer not null
    check (min_quantity >= 2),
  percent_bps integer not null
    check (percent_bps between 1 and 10000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quantity_discounts_unique unique (ticket_type_id, min_quantity)
);

comment on table public.quantity_discounts is
  'Quantity-based discount structure: buying at least min_quantity units gives percent_bps off. Values are client decisions; the table ships empty.';

create index quantity_discounts_ticket_type_id_idx on public.quantity_discounts (ticket_type_id);

create trigger quantity_discounts_set_updated_at
  before update on public.quantity_discounts
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- discount_codes
-- ---------------------------------------------------------------------------
create table public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  -- Optional: a code may apply to the whole event or to one ticket type only.
  ticket_type_id uuid references public.ticket_types (id) on delete cascade,
  -- Codes are stored already normalized (uppercase). The unique constraint is therefore
  -- case-insensitive in practice: no "amigos" vs "AMIGOS" duplicates.
  code text not null
    check (code = upper(code) and code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  kind public.discount_kind not null,
  -- Basis points keep percentages exact: 2500 = 25 %. Never a float.
  percent_bps integer
    check (percent_bps is null or percent_bps between 1 and 10000),
  amount_cents bigint
    check (amount_cents is null or amount_cents > 0),
  currency text not null default 'COP'
    check (currency = 'COP'),
  min_quantity integer not null default 1
    check (min_quantity >= 1),
  -- NULL means unlimited redemptions. redeemed_count is advanced atomically:
  --   update discount_codes set redeemed_count = redeemed_count + 1
  --    where id = :code and (max_redemptions is null or redeemed_count < max_redemptions)
  --   returning id;   -- no row => exhausted
  max_redemptions integer
    check (max_redemptions is null or max_redemptions > 0),
  redeemed_count integer not null default 0
    check (redeemed_count >= 0),
  valid_from timestamptz,
  valid_until timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discount_codes_event_code_unique unique (event_id, code),
  -- Exactly one value column, according to kind. This is what stops a "percentage plus
  -- fixed amount" discount from ever existing.
  constraint discount_codes_shape_check check (
    (kind = 'PERCENT' and percent_bps is not null and amount_cents is null)
    or (kind = 'FIXED' and amount_cents is not null and percent_bps is null)
  ),
  constraint discount_codes_window_check
    check (valid_until is null or valid_from is null or valid_until > valid_from),
  constraint discount_codes_redemption_limit_check
    check (max_redemptions is null or redeemed_count <= max_redemptions)
);

comment on table public.discount_codes is
  'Discount codes: percentage or fixed amount, per event or per ticket type, with validity window and usage limits. Combining rules are a business decision and are not encoded here.';

create index discount_codes_event_id_idx on public.discount_codes (event_id);
create index discount_codes_ticket_type_id_idx on public.discount_codes (ticket_type_id);

create trigger discount_codes_set_updated_at
  before update on public.discount_codes
  for each row execute function app_private.set_updated_at();
