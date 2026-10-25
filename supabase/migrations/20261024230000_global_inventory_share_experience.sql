-- ---------------------------------------------------------------------------
-- Migration 20261024230000_global_inventory_share_experience
--
-- ONE inventory for the whole event, exact sale windows, and the three-admission
-- "Comparte tu experiencia" package.
--
-- Product rules (America/Bogota, 2026 — fixed UTC-5, no DST):
--   * 100 admissions for the entire event, shared by Preventa, General and the package.
--     The old 30/70 split (`pricing_tiers.quantity_limit`) is gone: a stage may sell any
--     number of admissions while its window is open and the EVENT has stock left.
--   * Preventa  COP 159.900 · 2026-10-25 10:00  →  2026-10-28 23:59  · 1 admission per order
--   * (no sales)                   2026-10-29 00:00  →  2026-10-29 00:00:59.999
--   * General   COP 200.000 · 2026-10-29 00:01  →  2026-11-13 23:59  · multi-admission
--   * Package "Comparte tu experiencia" · 3 admissions · COP 169.900 each · COP 509.700
--     total · sold only during the General window · code `SHARE_EXPERIENCE`.
--     `DOUBLE_EXPERIENCE` stays as a readable historical row (is_active = false) so past
--     orders keep their bundle, price and reporting, and is refused for new purchases.
--
-- Authority and time:
--   * Windows live in `pricing_tiers.sales_starts_at / sales_ends_at` and are compared with
--     the SERVER clock (`now()`), never with a client timestamp. The intervals are half-open:
--     `sales_starts_at <= at < sales_ends_at`. Preventa therefore stops being selectable
--     at exactly 2026-10-29T05:00:00Z (29 Oct 00:00 Bogotá) and General opens at
--     2026-10-29T05:01:00Z — the one minute in between has no eligible stage at all.
--   * `create_order` re-reads the stage and the price inside its own transaction, so a
--     stale catalog, a cached page or a hand-crafted request cannot buy a closed stage.
--
-- Inventory model (no new table, no duplicated ledger):
--   * `pricing_tiers.quantity_sold / quantity_reserved` remain the per-stage attribution of
--     the SAME shared pool; the pool itself is derived: capacity - Σsold - Σreserved, where
--     the sums cover every tier of the event.
--   * `app_private.event_inventory_snapshot(event)` is the single read of that derivation.
--   * `app_private.reserve_pricing_tier` takes a row lock on the EVENT before it re-reads the
--     snapshot and moves a counter, so two concurrent checkouts serialize on the same row and
--     cannot both spend the last admission. Packages reserve 3.
--   * `app_private.enforce_event_capacity()` is a backstop trigger: any statement — including a
--     payment confirmation arriving after a reservation was released — that would push
--     sold + reserved above the capacity aborts instead of overselling.
--
-- Nothing here rewrites orders, payments, participants, projections or the email outbox:
-- historical money and statuses keep their recorded values, and only catalog data plus the
-- functions that read it change.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Catalog: capacity, exact windows, prices, limits, package.
-- ---------------------------------------------------------------------------
do $catalog$
declare
  v_event_id uuid;
  v_ticket_type_id uuid;
  v_preventa_id uuid;
  v_general_id uuid;
begin
  select e.id into v_event_id from public.events e where e.code = 'RESET-SUNSET-2026';
  if v_event_id is null then
    raise notice 'global inventory: RESET-SUNSET-2026 is not seeded here; catalog unchanged.';
    return;
  end if;

  -- One capacity for the whole event. `capacity` is the only inventory ceiling from now on.
  update public.events e set capacity = 100 where e.id = v_event_id and e.capacity is distinct from 100;

  select tt.id into v_ticket_type_id
    from public.ticket_types tt
   where tt.event_id = v_event_id and tt.code = 'GENERAL';
  if v_ticket_type_id is null then
    raise notice 'global inventory: GENERAL ticket type missing; catalog unchanged.';
    return;
  end if;

  -- Preventa: exact window, price and the one-admission-per-order rule. `quantity_limit` is
  -- cleared on purpose: the event capacity is the only inventory limit.
  update public.pricing_tiers t
     set price_cents = 15990000,
         sales_starts_at = timestamptz '2026-10-25 15:00:00+00',
         sales_ends_at = timestamptz '2026-10-29 05:00:00+00',
         quantity_limit = null,
         max_per_order = 1,
         is_active = true
   where t.ticket_type_id = v_ticket_type_id
     and t.sequence = 1
  returning t.id into v_preventa_id;

  if v_preventa_id is null then
    insert into public.pricing_tiers (
      ticket_type_id, name, sequence, price_cents, quantity_limit, max_per_order,
      sales_starts_at, sales_ends_at, is_active
    ) values (
      v_ticket_type_id, 'Preventa', 1, 15990000, null, 1,
      timestamptz '2026-10-25 15:00:00+00', timestamptz '2026-10-29 05:00:00+00', true
    )
    returning id into v_preventa_id;
  end if;

  -- General: opens one minute after Preventa closes and runs to the end of 13 November.
  update public.pricing_tiers t
     set name = 'General',
         price_cents = 20000000,
         sales_starts_at = timestamptz '2026-10-29 05:01:00+00',
         sales_ends_at = timestamptz '2026-11-14 05:00:00+00',
         quantity_limit = null,
         max_per_order = null,
         is_active = true
   where t.ticket_type_id = v_ticket_type_id
     and t.sequence = 2
  returning t.id into v_general_id;

  if v_general_id is null then
    insert into public.pricing_tiers (
      ticket_type_id, name, sequence, price_cents, quantity_limit, max_per_order,
      sales_starts_at, sales_ends_at, is_active
    ) values (
      v_ticket_type_id, 'General', 2, 20000000, null, null,
      timestamptz '2026-10-29 05:01:00+00', timestamptz '2026-11-14 05:00:00+00', true
    )
    returning id into v_general_id;
  end if;

  -- The old two-admission product is retired for NEW purchases but stays readable: historical
  -- orders keep `order_items.bundle_id`, the frozen name and their recorded amount.
  update public.ticket_bundles b
     set is_active = false
   where b.event_id = v_event_id
     and b.code = 'DOUBLE_EXPERIENCE'
     and b.is_active;

  -- "Comparte tu experiencia": three General admissions for a fixed COP 509.700 total.
  -- `price_cents` is hundredths of a peso (COP 169.900 = 16990000 per admission).
  insert into public.ticket_bundles (
    event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents, is_active
  ) values (
    v_event_id, v_ticket_type_id, v_general_id, 'SHARE_EXPERIENCE',
    'Comparte tu experiencia', 3, 50970000, true
  )
  on conflict (event_id, code) do update set
    ticket_type_id = excluded.ticket_type_id,
    pricing_tier_id = excluded.pricing_tier_id,
    name = excluded.name,
    included_admissions = excluded.included_admissions,
    price_cents = excluded.price_cents,
    is_active = true;

  raise notice 'global inventory: capacity 100, Preventa/General windows and SHARE_EXPERIENCE configured.';
end
$catalog$;

-- ---------------------------------------------------------------------------
-- 2. The shared pool: one derivation, used by every read and by the reservation.
-- ---------------------------------------------------------------------------
create or replace function app_private.event_inventory_snapshot(p_event_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $snapshot$
  select jsonb_build_object(
    'capacity', e.capacity,
    'reserved', coalesce(sum(t.quantity_reserved), 0)::integer,
    'sold', coalesce(sum(t.quantity_sold), 0)::integer,
    'remaining', case
      when e.capacity is null then null
      else greatest(e.capacity - coalesce(sum(t.quantity_reserved), 0)::integer
                                - coalesce(sum(t.quantity_sold), 0)::integer, 0)
    end
  )
    from public.events e
    left join public.ticket_types tt on tt.event_id = e.id
    left join public.pricing_tiers t on t.ticket_type_id = tt.id
   where e.id = p_event_id
   group by e.id, e.capacity;
$snapshot$;

comment on function app_private.event_inventory_snapshot(uuid) is
  'The event-wide inventory pool: capacity, the admissions reserved and sold across every stage, and what remains. NULL remaining means the event has no capacity ceiling.';

revoke all on function app_private.event_inventory_snapshot(uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function app_private.event_inventory_snapshot(uuid) to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Stage selection is now purely time-based.
--
-- `p_quantity` is kept in the signature (callers and the generated types depend on it) but is
-- deliberately NOT used: inventory is checked against the event pool by the caller, AFTER the
-- stage's own per-order cap. That ordering is what lets a two-ticket Preventa request be told
-- "one per order" instead of the misleading "sold out" when a single admission is left.
-- ---------------------------------------------------------------------------
create or replace function app_private.active_pricing_tier_id(
  p_ticket_type_id uuid,
  p_at timestamptz,
  p_quantity integer
)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id
    from public.pricing_tiers t
   where t.ticket_type_id = p_ticket_type_id
     and t.is_active
     and (t.sales_starts_at is null or t.sales_starts_at <= p_at)
     and (t.sales_ends_at is null or t.sales_ends_at > p_at)
   order by t.sequence
   limit 1;
$$;

comment on function app_private.active_pricing_tier_id(uuid, timestamptz, integer) is
  'The stage whose half-open sales window contains p_at, lowest sequence first. Capacity is enforced separately against the event pool, so this answers only "is this stage on sale right now?".';

-- ---------------------------------------------------------------------------
-- 4. Reservation: serialized on the event row, one shared pool.
-- ---------------------------------------------------------------------------
create or replace function app_private.reserve_pricing_tier(
  p_ticket_type_id uuid,
  p_quantity integer,
  p_at timestamptz
)
returns public.pricing_tiers
language plpgsql
volatile
security invoker
set search_path = ''
as $reserve$
declare
  v_event_id uuid;
  v_snapshot jsonb;
  v_remaining integer;
  v_tier public.pricing_tiers;
  v_active_id uuid;
begin
  select tt.event_id into v_event_id
    from public.ticket_types tt
   where tt.id = p_ticket_type_id;
  if v_event_id is null then
    raise exception 'Ticket type not found'
      using errcode = 'PT404', detail = 'TICKET_TYPE_NOT_FOUND';
  end if;

  -- The event row is the serialization point for the whole pool: every reservation for this
  -- event passes through this lock, so two concurrent checkouts cannot spend the same seat.
  perform 1 from public.events e where e.id = v_event_id for update;

  v_active_id := app_private.active_pricing_tier_id(p_ticket_type_id, p_at, p_quantity);
  if v_active_id is null then
    raise exception 'No sales stage is open for this purchase'
      using errcode = 'PT409', detail = 'SOLD_OUT';
  end if;

  select * into v_tier from public.pricing_tiers t where t.id = v_active_id;

  -- Per-order rule of the stage (Preventa: one admission per payment). Checked before inventory
  -- so the buyer is told the real reason.
  if v_tier.max_per_order is not null and p_quantity > v_tier.max_per_order then
    raise exception 'Sales stage % allows at most % ticket(s) per order',
                    v_tier.name, v_tier.max_per_order
      using errcode = 'PT409', detail = 'QUANTITY_LIMIT';
  end if;

  v_snapshot := app_private.event_inventory_snapshot(v_event_id);
  v_remaining := (v_snapshot ->> 'remaining')::integer;
  if v_remaining is not null and v_remaining < p_quantity then
    raise exception 'Not enough admissions remain for this purchase'
      using errcode = 'PT409', detail = 'SOLD_OUT';
  end if;

  update public.pricing_tiers t
     set quantity_reserved = t.quantity_reserved + p_quantity
   where t.id = v_tier.id
  returning t.* into v_tier;

  perform pg_catalog.set_config('app.selected_pricing_tier_id', v_tier.id::text, true);
  return v_tier;
end;
$reserve$;

comment on function app_private.reserve_pricing_tier(uuid, integer, timestamptz) is
  'Reserves admissions from the event-wide pool under a row lock on the event, after the stage per-order cap. Packages reserve their included admissions (three).';

-- ---------------------------------------------------------------------------
-- 5. Backstop: the pool can never be oversold, whichever statement moves a counter.
-- ---------------------------------------------------------------------------
create or replace function app_private.enforce_event_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $capacity$
declare
  v_event_id uuid;
  v_capacity integer;
  v_reserved integer;
  v_sold integer;
begin
  select tt.event_id into v_event_id
    from public.ticket_types tt
   where tt.id = new.ticket_type_id;

  select e.capacity into v_capacity from public.events e where e.id = v_event_id;
  if v_capacity is null then
    return new;
  end if;

  select coalesce(sum(t.quantity_reserved), 0)::integer, coalesce(sum(t.quantity_sold), 0)::integer
    into v_reserved, v_sold
    from public.pricing_tiers t
    join public.ticket_types tt on tt.id = t.ticket_type_id
   where tt.event_id = v_event_id;

  if v_reserved + v_sold > v_capacity then
    raise exception 'Event capacity would be exceeded (% of % admissions)', v_reserved + v_sold, v_capacity
      using errcode = 'PT409', detail = 'CAPACITY_EXCEEDED';
  end if;

  return new;
end;
$capacity$;

comment on function app_private.enforce_event_capacity() is
  'Backstop for the shared pool: aborts any statement that would leave the event with more admissions reserved or sold than its capacity (for example a payment confirmation arriving after its reservation was released).';

revoke all on function app_private.enforce_event_capacity() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_private.enforce_event_capacity() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function app_private.enforce_event_capacity() from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function app_private.enforce_event_capacity() to service_role';
  end if;
end
$$;

drop trigger if exists pricing_tiers_enforce_event_capacity on public.pricing_tiers;

create trigger pricing_tiers_enforce_event_capacity
  after update of quantity_reserved, quantity_sold on public.pricing_tiers
  for each row
  execute function app_private.enforce_event_capacity();

-- ---------------------------------------------------------------------------
-- 6. public.quote_order_price — same contract, global inventory and a real SOLD_OUT.
-- ---------------------------------------------------------------------------
create or replace function public.quote_order_price(
  p_event_code text,
  p_ticket_type_code text,
  p_quantity integer,
  p_reservation_minutes integer,
  p_discount_code text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_event public.events;
  v_ticket_type public.ticket_types;
  v_tier public.pricing_tiers;
  v_tier_id uuid;
  v_policy text;
  v_quantity_bps integer := 0;
  v_quantity_discount bigint := 0;
  v_subtotal bigint;
  v_code jsonb;
  v_code_amount bigint := 0;
  v_discount_total bigint := 0;
  v_total bigint;
  v_remaining integer;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Quantity must be a positive integer'
      using errcode = 'PT400', detail = 'INVALID_QUANTITY';
  end if;
  if p_reservation_minutes is null or p_reservation_minutes < 1 or p_reservation_minutes > 1440 then
    raise exception 'Reservation window is out of range'
      using errcode = 'PT400', detail = 'INVALID_RESERVATION_WINDOW';
  end if;

  select * into v_event
    from public.events e
   where e.code = upper(btrim(coalesce(p_event_code, '')));
  if not found then
    raise exception 'Event not found' using errcode = 'PT404', detail = 'EVENT_NOT_FOUND';
  end if;
  if v_event.status <> 'PUBLISHED' then
    raise exception 'Event is not on sale' using errcode = 'PT409', detail = 'EVENT_NOT_ON_SALE';
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
     or (v_ticket_type.max_per_order is not null and p_quantity > v_ticket_type.max_per_order) then
    raise exception 'Quantity is outside the configured per-order limits'
      using errcode = 'PT409', detail = 'QUANTITY_LIMIT';
  end if;

  v_tier_id := app_private.active_pricing_tier_id(v_ticket_type.id, v_now, p_quantity);
  if v_tier_id is null then
    raise exception 'No sales stage is open for this purchase'
      using errcode = 'PT409', detail = 'SOLD_OUT';
  end if;
  select * into v_tier from public.pricing_tiers t where t.id = v_tier_id;

  -- Preventa: one admission per payment. Enforced here so a client that skips the storefront
  -- gets the same refusal the UI shows.
  if v_tier.max_per_order is not null and p_quantity > v_tier.max_per_order then
    raise exception 'Sales stage % allows at most % ticket(s) per order',
                    v_tier.name, v_tier.max_per_order
      using errcode = 'PT409', detail = 'QUANTITY_LIMIT';
  end if;

  v_remaining := (app_private.event_inventory_snapshot(v_event.id) ->> 'remaining')::integer;
  if v_remaining is not null and v_remaining < p_quantity then
    raise exception 'Not enough admissions remain for this purchase'
      using errcode = 'PT409', detail = 'SOLD_OUT';
  end if;

  v_subtotal := v_tier.price_cents * p_quantity;
  v_quantity_bps := app_private.quantity_discount_bps(v_ticket_type.id, p_quantity);
  v_quantity_discount := (v_subtotal * v_quantity_bps) / 10000;

  v_code := app_private.evaluate_discount_code(
    v_event.id, v_ticket_type.id, p_discount_code, p_quantity, v_subtotal, v_now
  );
  v_code_amount := (v_code ->> 'amountInCents')::bigint;

  select p.discount_combination into v_policy from public.pricing_policy p;

  if v_policy = 'STACK' then
    v_discount_total := least(v_subtotal, v_quantity_discount + v_code_amount);
  else
    v_discount_total := greatest(v_quantity_discount, v_code_amount);
  end if;
  v_total := v_subtotal - v_discount_total;

  return jsonb_build_object(
    'event', jsonb_build_object('code', v_event.code, 'name', v_event.name),
    'ticketType', jsonb_build_object('code', v_ticket_type.code, 'name', v_ticket_type.name),
    'quantity', p_quantity,
    'pricingTier', jsonb_build_object(
      'name', v_tier.name,
      'sequence', v_tier.sequence,
      'unitPriceInCents', v_tier.price_cents,
      -- Disclosed so the storefront can cap its selector from the same value the API
      -- enforces instead of duplicating the rule.
      'maxPerOrder', v_tier.max_per_order
    ),
    'subtotalInCents', v_subtotal,
    'quantityDiscount', jsonb_build_object(
      'applies', v_quantity_bps > 0,
      'percentBps', v_quantity_bps,
      'amountInCents', v_quantity_discount
    ),
    'quantityDiscountInCents', case
      when v_policy = 'STACK' then v_quantity_discount
      when v_quantity_discount >= v_code_amount then v_discount_total
      else 0
    end,
    'discountCode', v_code,
    'discountCodeInCents', case
      when v_policy = 'STACK' then least(v_code_amount, v_subtotal - v_quantity_discount)
      when v_code_amount > v_quantity_discount then v_discount_total
      else 0
    end,
    'discountCombination', v_policy,
    'totalDiscountInCents', v_discount_total,
    'totalInCents', v_total,
    'currency', v_event.currency,
    'availableQuantity', v_remaining,
    'availability', app_private.availability_label(v_remaining),
    'quotedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(
      (v_now + make_interval(mins => p_reservation_minutes)) at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );
end;
$$;

revoke all on function public.quote_order_price(text, text, integer, integer, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.quote_order_price(text, text, integer, integer, text) to service_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. public.quote_bundle_order_price — the package, priced from its catalogue row.
-- ---------------------------------------------------------------------------
create or replace function public.quote_bundle_order_price(
  p_event_code text,
  p_ticket_type_code text,
  p_quantity integer,
  p_reservation_minutes integer,
  p_bundle_code text,
  p_discount_code text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $bundle_quote$
declare
  v_bundle public.ticket_bundles;
  v_quote jsonb;
  v_tier public.pricing_tiers;
  v_active_id uuid;
  v_remaining integer;
begin
  select b.*
    into v_bundle
    from public.ticket_bundles b
    join public.events e on e.id = b.event_id
    join public.ticket_types tt on tt.id = b.ticket_type_id
   where e.code = upper(btrim(coalesce(p_event_code, '')))
     and tt.code = upper(btrim(coalesce(p_ticket_type_code, '')))
     and b.code = upper(btrim(coalesce(p_bundle_code, '')))
     and b.is_active;

  if not found then
    raise exception 'Named bundle not found'
      using errcode = 'PT404', detail = 'BUNDLE_NOT_FOUND';
  end if;

  -- One package per order: the only legal quantity is the admissions it includes, so a request
  -- for two packages in one payment is refused here, before any pricing or inventory.
  if p_quantity is distinct from v_bundle.included_admissions then
    raise exception 'Quantity must equal the admissions included in this bundle'
      using errcode = 'PT409', detail = 'BUNDLE_QUANTITY_INVALID';
  end if;

  if nullif(btrim(coalesce(p_discount_code, '')), '') is not null then
    raise exception 'Promo codes cannot be combined with a named bundle'
      using errcode = 'PT409', detail = 'BUNDLE_DISCOUNT_UNSUPPORTED';
  end if;

  -- No stage open at all: the package is out of season, not out of stock.
  v_active_id := app_private.active_pricing_tier_id(
    v_bundle.ticket_type_id, now(), v_bundle.included_admissions
  );
  if v_active_id is null then
    raise exception 'No sales stage is open for this purchase'
      using errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
  end if;

  if v_active_id is distinct from v_bundle.pricing_tier_id then
    raise exception 'Named bundle is not available in the active sales stage'
      using errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
  end if;

  select t.* into v_tier from public.pricing_tiers t where t.id = v_bundle.pricing_tier_id;
  if v_tier.max_per_order is not null
     and v_bundle.included_admissions > v_tier.max_per_order then
    raise exception 'Named bundle cannot be bought in the active sales stage'
      using errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
  end if;

  -- The package needs three admissions from the same pool as everything else.
  v_remaining := (
    app_private.event_inventory_snapshot(
      (select tt.event_id from public.ticket_types tt where tt.id = v_bundle.ticket_type_id)
    ) ->> 'remaining'
  )::integer;
  if v_remaining is not null and v_remaining < v_bundle.included_admissions then
    raise exception 'Not enough admissions remain for this purchase'
      using errcode = 'PT409', detail = 'SOLD_OUT';
  end if;

  v_quote := public.quote_order_price(
    p_event_code,
    p_ticket_type_code,
    p_quantity,
    p_reservation_minutes,
    p_discount_code
  );

  -- The generic quote resolved the same stage we just selected; if a race moved the stage
  -- between both reads, refuse rather than price the bundle against another stage.
  if (v_quote #>> '{pricingTier,sequence}')::integer is distinct from v_tier.sequence then
    raise exception 'Named bundle is not available in the active sales stage'
      using errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
  end if;

  return v_quote || jsonb_build_object(
    'ticketType', jsonb_build_object('code', v_quote #>> '{ticketType,code}', 'name', v_bundle.name),
    'bundleCode', v_bundle.code,
    'quantity', v_bundle.included_admissions,
    'pricingTier', jsonb_build_object(
      'name', v_tier.name,
      'sequence', v_tier.sequence,
      'unitPriceInCents', v_bundle.price_cents / v_bundle.included_admissions,
      'maxPerOrder', v_tier.max_per_order
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
end;
$bundle_quote$;

-- ---------------------------------------------------------------------------
-- 8. app_private.event_sales_summary — shared availability, the stage's own details and the
--    server clock the storefront uses to time its own boundary timers.
-- ---------------------------------------------------------------------------
create or replace function app_private.event_sales_summary(
  p_event public.events,
  p_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $sales$
declare
  v_types jsonb := '[]'::jsonb;
  v_any_open boolean := false;
  v_best text := 'CLOSED';
  v_type record;
  v_tier_id uuid;
  -- A typed row, never a bare `record`: a `record` cannot be set to NULL in PL/pgSQL, and the
  -- between-stages case (no window open) MUST produce a null tier instead of an error.
  v_tier public.pricing_tiers;
  v_has_tier boolean := false;
  v_remaining integer;
  v_label text;
  v_open boolean;
begin
  for v_type in
    select tt.*
      from public.ticket_types tt
     where tt.event_id = p_event.id
       and tt.is_active
     order by tt.code
  loop
    if p_event.status <> 'PUBLISHED' then
      v_tier_id := null;
    else
      v_tier_id := app_private.active_pricing_tier_id(v_type.id, p_at, v_type.min_per_order);
    end if;

    if v_tier_id is not null then
      select * into v_tier from public.pricing_tiers where id = v_tier_id;
      v_has_tier := true;
      v_remaining := (app_private.event_inventory_snapshot(p_event.id) ->> 'remaining')::integer;
      v_label := app_private.availability_label(v_remaining);
      v_open := true;
    else
      v_has_tier := false;
      v_remaining := null;
      v_open := false;
      -- A stage exists but no window is open right now: the event is between stages, which the
      -- storefront renders as "not on sale yet", not as sold out.
      v_label := case when p_event.status = 'PUBLISHED' then 'NOT_STARTED' else 'CLOSED' end;
    end if;

    v_any_open := v_any_open or v_open;
    if (v_label = 'AVAILABLE') or (v_label = 'LOW' and v_best not in ('AVAILABLE'))
       or (v_label = 'SOLD_OUT' and v_best not in ('AVAILABLE', 'LOW'))
       or (v_label = 'NOT_STARTED' and v_best = 'CLOSED') then
      v_best := v_label;
    end if;

    v_types := v_types || jsonb_build_array(jsonb_build_object(
      'code', v_type.code,
      'name', v_type.name,
      'description', v_type.description,
      'minPerOrder', v_type.min_per_order,
      'maxPerOrder', v_type.max_per_order,
      'salesOpen', v_open,
      'availability', v_label,
      'currentTier', case when not v_has_tier then null else jsonb_build_object(
        'name', v_tier.name,
        'sequence', v_tier.sequence,
        'priceInCents', v_tier.price_cents,
        'maxPerOrder', v_tier.max_per_order
      ) end,
      'salesWindow', case when not v_has_tier then null else jsonb_build_object(
        'startsAt', app_private.iso_utc(v_tier.sales_starts_at),
        'endsAt', app_private.iso_utc(v_tier.sales_ends_at)
      ) end
    ));
  end loop;

  return jsonb_build_object(
    'currency', p_event.currency,
    'salesOpen', v_any_open,
    'availability', v_best,
    'serverTime', app_private.iso_utc(p_at),
    'ticketTypes', v_types
  );
end;
$sales$;

comment on function app_private.event_sales_summary(public.events, timestamptz) is
  'Public sales projection for one event: the stage whose window is open, its price, the per-order cap, the shared coarse availability bucket, that stage window and the server clock. Never returns exact inventory counters.';

-- ---------------------------------------------------------------------------
-- 9. Reconciliation: prove the counters and the order ledger agree before the shared pool
--    starts trusting them. Aborts the whole migration when the counters UNDERCOUNT what the
--    ledger says was sold or is still reserved (that is the only direction that could
--    oversell); overcounting is reported because it can only make the store more cautious.
-- ---------------------------------------------------------------------------
do $reconcile$
declare
  v_event_id uuid;
  v_capacity integer;
  v_counter_sold integer;
  v_counter_reserved integer;
  v_ledger_paid integer;
  v_ledger_pending integer;
begin
  select e.id, e.capacity into v_event_id, v_capacity
    from public.events e
   where e.code = 'RESET-SUNSET-2026';
  if v_event_id is null then
    raise notice 'inventory reconciliation: event not seeded; nothing to reconcile.';
    return;
  end if;

  select coalesce(sum(t.quantity_sold), 0)::integer,
         coalesce(sum(t.quantity_reserved), 0)::integer
    into v_counter_sold, v_counter_reserved
    from public.pricing_tiers t
    join public.ticket_types tt on tt.id = t.ticket_type_id
   where tt.event_id = v_event_id;

  select coalesce(sum(oi.quantity), 0)::integer into v_ledger_paid
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.event_id = v_event_id
     and o.status = 'PAID';

  select coalesce(sum(oi.quantity), 0)::integer into v_ledger_pending
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.event_id = v_event_id
     and o.status = 'PENDING';

  raise notice
    'inventory reconciliation: capacity=%, counters sold=% reserved=%, ledger paid=% pending=%',
    v_capacity, v_counter_sold, v_counter_reserved, v_ledger_paid, v_ledger_pending;

  if v_counter_sold < v_ledger_paid then
    raise exception
      'inventory reconciliation failed: counters report % sold but the ledger has % paid admissions',
      v_counter_sold, v_ledger_paid;
  end if;

  if v_counter_reserved < v_ledger_pending then
    raise exception
      'inventory reconciliation failed: counters report % reserved but the ledger has % pending admissions',
      v_counter_reserved, v_ledger_pending;
  end if;

  if v_capacity is not null and v_counter_sold + v_counter_reserved > v_capacity then
    raise exception
      'inventory reconciliation failed: % admissions are reserved or sold against a capacity of %',
      v_counter_sold + v_counter_reserved, v_capacity;
  end if;

  raise notice 'inventory reconciliation: pool is consistent (sold + reserved <= capacity).';
end
$reconcile$;
