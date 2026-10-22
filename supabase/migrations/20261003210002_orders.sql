-- ---------------------------------------------------------------------------
-- Migration 20261003210002_orders
-- Phase 2 / part 2 of 7: orders, order items and the order reference sequence.
--
-- Decisions documented here:
--   * Money: bigint centavos (`*_cents`), never numeric/float. COP has two minor units,
--     so 1 peso = 100 centavos, matching Wompi's `amount_in_cents` one-to-one.
--   * The buyer is NOT a participant. Buyer contact fields live on the order; each
--     purchased unit gets its own participant (participants migration). One buyer may buy
--     several tickets.
--   * Prices are frozen into order_items at creation time (unit price, line total and
--     snapshot names), so later catalog edits never rewrite history.
--   * Order references come from a database sequence, so concurrent orders can never
--     collide and no randomness is involved.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Order reference sequence
-- ---------------------------------------------------------------------------
-- Single global sequence: the formatted reference is `EVT-<year>-<sequence>`, so the year
-- is part of the string while the sequence keeps advancing. Gaps are acceptable and
-- expected (a rolled-back transaction consumes a number); uniqueness is not.
create sequence public.order_reference_seq as bigint start with 1 increment by 1 no cycle;

comment on sequence public.order_reference_seq is
  'Monotonic source for order references (EVT-<year>-<6+ digit sequence>). Never reset, never reused.';

-- Server-side reference builder: one authoritative implementation of the format.
create or replace function app_private.next_order_reference(reference_year integer)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'EVT-'
    || lpad(reference_year::text, 4, '0')
    || '-'
    || lpad(nextval('public.order_reference_seq')::text, 6, '0');
$$;

comment on function app_private.next_order_reference(integer) is
  'Builds the next order reference. Call inside the order-creating transaction; the sequence guarantees uniqueness under concurrency.';

revoke all on function app_private.next_order_reference(integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function app_private.next_order_reference(integer) to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique
    check (reference ~ '^EVT-[0-9]{4}-[0-9]{6,}$'),
  event_id uuid not null references public.events (id) on delete restrict,
  status public.order_status not null default 'PENDING',
  -- Buyer contact. Stored normalized (lowercase) because the unique/duplicate checks and
  -- the email sends both compare on this value.
  buyer_email text not null
    check (
      buyer_email = lower(buyer_email)
      and buyer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      and length(buyer_email) <= 254
    ),
  buyer_name text
    check (buyer_name is null or (length(btrim(buyer_name)) between 1 and 160 and buyer_name !~ '[\n\r\t]')),
  buyer_phone text
    check (buyer_phone is null or buyer_phone ~ '^[0-9]{7,15}$'),
  -- Money breakdown: total = subtotal - quantity_discount - discount_code.
  -- Keeping the two discount sources separate keeps the audit trail readable
  -- (which discount actually brought the price down).
  subtotal_cents bigint not null
    check (subtotal_cents >= 0),
  quantity_discount_cents bigint not null default 0
    check (quantity_discount_cents >= 0),
  discount_code_cents bigint not null default 0
    check (discount_code_cents >= 0),
  total_cents bigint not null
    check (total_cents >= 0),
  currency text not null default 'COP'
    check (currency = 'COP'),
  discount_code_id uuid references public.discount_codes (id) on delete set null,
  -- Reservation: a PENDING order holds inventory until this instant, after which the
  -- expiry job moves it to EXPIRED and releases the counters.
  reservation_expires_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  source text not null default 'WEB'
    check (source in ('WEB', 'MANUAL')),
  -- Wompi recommends storing the originating IP for fraud analysis; it is also useful for
  -- abuse investigation. It is personal data, so it is never logged or exported.
  ip_address inet,
  user_agent text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_total_check check (
    subtotal_cents - quantity_discount_cents - discount_code_cents = total_cents
  ),
  -- A payment timestamp on an order that is not PAID is a data-integrity bug, not a state.
  constraint orders_paid_at_check check (paid_at is null or status = 'PAID')
);

comment on table public.orders is
  'A purchase intent: buyer contact, money breakdown, reservation and lifecycle status. Inventory is reserved while PENDING and released on EXPIRED/CANCELLED.';

create index orders_event_id_idx on public.orders (event_id);
create index orders_event_status_idx on public.orders (event_id, status);
-- Supports the reservation-expiry job (PENDING orders past their deadline).
create index orders_expiry_idx on public.orders (reservation_expires_at)
  where status = 'PENDING';
create index orders_discount_code_id_idx on public.orders (discount_code_id);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- order_items
-- ---------------------------------------------------------------------------
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types (id) on delete restrict,
  pricing_tier_id uuid not null references public.pricing_tiers (id) on delete restrict,
  quantity integer not null
    check (quantity > 0),
  -- Price actually charged per unit, frozen at order creation.
  unit_price_cents bigint not null
    check (unit_price_cents >= 0),
  quantity_discount_cents bigint not null default 0
    check (quantity_discount_cents >= 0),
  line_total_cents bigint not null
    check (line_total_cents >= 0),
  -- Snapshots: an operator can reconstruct what was sold even if the catalog changes later.
  ticket_type_name text not null,
  pricing_tier_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_items_line_total_check check (
    unit_price_cents * quantity - quantity_discount_cents = line_total_cents
  ),
  -- One line per (order, ticket type, stage): two lines for the same stage would make the
  -- money breakdown ambiguous and break the inventory accounting.
  constraint order_items_unique_stage_per_order unique (order_id, ticket_type_id, pricing_tier_id)
);

comment on table public.order_items is
  'Order lines: quantity, frozen unit price, quantity-discount share and line total. One line per sales stage.';

create index order_items_ticket_type_id_idx on public.order_items (ticket_type_id);
create index order_items_pricing_tier_id_idx on public.order_items (pricing_tier_id);

create trigger order_items_set_updated_at
  before update on public.order_items
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- discount_redemptions
-- ---------------------------------------------------------------------------
-- Created here (not in the catalog migration) because a redemption always belongs to an order.
create table public.discount_redemptions (
  id uuid primary key default gen_random_uuid(),
  discount_code_id uuid not null references public.discount_codes (id) on delete restrict,
  order_id uuid not null references public.orders (id) on delete cascade,
  -- Amount actually discounted on this order, in centavos.
  amount_cents bigint not null
    check (amount_cents >= 0),
  created_at timestamptz not null default now(),
  constraint discount_redemptions_unique_per_order unique (discount_code_id, order_id)
);

comment on table public.discount_redemptions is
  'Append-only record of every discount code use, so usage accounting is auditable independently of the counter on discount_codes.';

create index discount_redemptions_order_id_idx on public.discount_redemptions (order_id);
