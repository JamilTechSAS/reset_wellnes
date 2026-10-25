-- ---------------------------------------------------------------------------
-- Migration 20261024190000_tier_purchase_limits
-- Per-sales-stage purchase limits, enforced in the database (quote AND creation).
--
-- Product rules from the client:
--   * Preventa: one admission per payment/order.
--   * General: multiple admissions per order (the ticket type's own min/max still apply).
--   * "Comparte esta experiencia" (DOUBLE_EXPERIENCE): exactly one bundle per order; the
--     bundle is two General admissions for a fixed COP 340,000 total. Its existing
--     `p_quantity = included_admissions` guard already makes a second pair in the same
--     payment impossible; this migration adds the tier-level check so a bundle can never
--     quote or order when its own stage forbids that many admissions.
--
-- The limit is DATA on the stage (`pricing_tiers.max_per_order`), not a hardcoded stage name
-- in the functions: prices and windows change every campaign, and a new first stage can take
-- the same single-ticket rule without a code change. The migration seeds the current
-- Preventa stage, which is the only stage that ships with the rule today.
--
-- Nothing here reads or rewrites order history, payments, participants or projections, and no
-- inventory counter moves: the guard runs before the reservation.
-- ---------------------------------------------------------------------------

alter table public.pricing_tiers
  add column if not exists max_per_order integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pricing_tiers_max_per_order_check'
       and conrelid = 'public.pricing_tiers'::regclass
  ) then
    alter table public.pricing_tiers
      add constraint pricing_tiers_max_per_order_check
      check (max_per_order is null or max_per_order >= 1);
  end if;
end
$$;

comment on column public.pricing_tiers.max_per_order is
  'Largest quantity one order may buy while this stage is the active stage. NULL means no stage-level cap (the ticket type max_per_order applies). Preventa is seeded with 1: one admission per payment.';

-- Idempotent: only fills a NULL, so an operator editing the value keeps their decision and a
-- re-run of this migration cannot overwrite it.
update public.pricing_tiers
   set max_per_order = 1
 where max_per_order is null
   and lower(btrim(name)) = 'preventa';

-- ---------------------------------------------------------------------------
-- app_private.reserve_pricing_tier — same selection, one guard before any UPDATE.
-- Raising here aborts create_order/create_bundle_order inside their transaction, so the
-- order, its participant, its payment attempt and its inventory reservation never exist.
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
  v_tier public.pricing_tiers;
  v_active_id uuid;
begin
  v_active_id := app_private.active_pricing_tier_id(p_ticket_type_id, p_at, p_quantity);
  if v_active_id is not null then
    select * into v_tier from public.pricing_tiers where id = v_active_id;
    if v_tier.max_per_order is not null and p_quantity > v_tier.max_per_order then
      raise exception 'Sales stage % allows at most % ticket(s) per order',
                      v_tier.name, v_tier.max_per_order
        using errcode = 'PT409', detail = 'QUANTITY_LIMIT';
    end if;
  end if;

  update public.pricing_tiers t
     set quantity_reserved = t.quantity_reserved + p_quantity
   where t.ticket_type_id = p_ticket_type_id
     and t.is_active
     and (t.sales_starts_at is null or t.sales_starts_at <= p_at)
     and (t.sales_ends_at is null or t.sales_ends_at > p_at)
     and (
       t.quantity_limit is null
       or t.quantity_reserved + t.quantity_sold + p_quantity <= t.quantity_limit
     )
     and t.sequence = (
       select min(candidate.sequence)
         from public.pricing_tiers candidate
        where candidate.ticket_type_id = t.ticket_type_id
          and candidate.is_active
          and (candidate.sales_starts_at is null or candidate.sales_starts_at <= p_at)
          and (candidate.sales_ends_at is null or candidate.sales_ends_at > p_at)
          and (
            candidate.quantity_limit is null
            or candidate.quantity_reserved + candidate.quantity_sold + p_quantity
               <= candidate.quantity_limit
          )
          and not exists (
            select 1
              from public.pricing_tiers prior
             where prior.ticket_type_id = candidate.ticket_type_id
               and prior.sequence < candidate.sequence
               and prior.is_active
               and (prior.sales_starts_at is null or prior.sales_starts_at <= p_at)
               and (prior.sales_ends_at is null or prior.sales_ends_at > p_at)
               and (
                 prior.quantity_limit is null
                 or prior.quantity_reserved + prior.quantity_sold < prior.quantity_limit
               )
          )
     )
  returning t.* into v_tier;

  if v_tier.id is null then
    raise exception 'No sales stage can serve this quantity'
      using errcode = 'PT409', detail = 'SOLD_OUT';
  end if;

  perform pg_catalog.set_config('app.selected_pricing_tier_id', v_tier.id::text, true);
  return v_tier;
end;
$reserve$;

comment on function app_private.reserve_pricing_tier(uuid, integer, timestamptz) is
  'Atomically reserves the earliest available tier without skipping a prior in-window tier that still has stock, refusing a quantity above the stage''s max_per_order before any counter moves.';

-- ---------------------------------------------------------------------------
-- public.quote_order_price — identical contract plus the stage limit and the disclosed cap.
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
    raise exception 'No sales stage can serve this quantity'
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

  if v_tier.quantity_limit is null then
    v_remaining := null;
  else
    v_remaining := greatest(
      v_tier.quantity_limit - v_tier.quantity_reserved - v_tier.quantity_sold, 0
    );
  end if;

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
    'availability', case
      when v_remaining is null then 'AVAILABLE'
      when v_remaining = 0 then 'SOLD_OUT'
      when v_remaining <= 5 then 'LOW'
      else 'AVAILABLE'
    end,
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
-- public.quote_bundle_order_price — same price overlay, plus the disclosed cap and a guard so
-- the bundle is refused when its own stage cannot serve its two admissions.
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

  -- One bundle per order: the only legal quantity is the admissions it includes, so a
  -- request for two pairs (quantity 4) is refused here, before any pricing or inventory.
  if p_quantity is distinct from v_bundle.included_admissions then
    raise exception 'Quantity must equal the admissions included in this bundle'
      using errcode = 'PT409', detail = 'BUNDLE_QUANTITY_INVALID';
  end if;

  if nullif(btrim(coalesce(p_discount_code, '')), '') is not null then
    raise exception 'Promo codes cannot be combined with a named bundle'
      using errcode = 'PT409', detail = 'BUNDLE_DISCOUNT_UNSUPPORTED';
  end if;

  -- Stage check BEFORE the generic quote: while Preventa is active the bundle's General stage
  -- is not the active one, and the buyer must be told the product is not available yet rather
  -- than receive the Preventa single-ticket refusal.
  --
  -- When NO stage can serve the bundle's admissions the stage is null on purpose: the generic
  -- quote below then raises SOLD_OUT, which is the truthful answer (inventory, not schedule).
  v_active_id := app_private.active_pricing_tier_id(
    v_bundle.ticket_type_id, now(), v_bundle.included_admissions
  );
  if v_active_id is not null and v_active_id is distinct from v_bundle.pricing_tier_id then
    raise exception 'Named bundle is not available in the active sales stage'
      using errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
  end if;

  select t.* into v_tier from public.pricing_tiers t where t.id = v_bundle.pricing_tier_id;
  if v_tier.max_per_order is not null
     and v_bundle.included_admissions > v_tier.max_per_order then
    raise exception 'Named bundle cannot be bought in the active sales stage'
      using errcode = 'PT409', detail = 'BUNDLE_NOT_AVAILABLE';
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
-- app_private.event_sales_summary — disclose the active stage's cap so the storefront can
-- cap its selector before the first quote.
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
  v_tier record;
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
      v_remaining := case when v_tier.quantity_limit is null then null
                          else v_tier.quantity_limit - v_tier.quantity_reserved - v_tier.quantity_sold
                     end;
      v_label := app_private.availability_label(v_remaining);
      v_open := true;
    else
      v_tier := null;
      v_remaining := null;
      v_open := false;
      if p_event.status = 'PUBLISHED' and exists (
        select 1
          from public.pricing_tiers t
         where t.ticket_type_id = v_type.id
           and t.is_active
           and (t.sales_starts_at is null or t.sales_starts_at <= p_at)
           and (t.sales_ends_at is null or t.sales_ends_at > p_at)
      ) then
        v_label := 'SOLD_OUT';
      elsif p_event.status = 'PUBLISHED' then
        v_label := 'NOT_STARTED';
      else
        v_label := 'CLOSED';
      end if;
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
      'currentTier', case when v_tier is null then null else jsonb_build_object(
        'name', v_tier.name,
        'sequence', v_tier.sequence,
        'priceInCents', v_tier.price_cents,
        'maxPerOrder', v_tier.max_per_order
      ) end
    ));
  end loop;

  return jsonb_build_object(
    'currency', p_event.currency,
    'salesOpen', v_any_open,
    'availability', v_best,
    'ticketTypes', v_types
  );
end;
$sales$;

comment on function app_private.event_sales_summary(public.events, timestamptz) is
  'Public sales projection for one event: per active ticket type, the current stage, its price and its per-order cap, plus a coarse availability bucket; never exact inventory counters.';
