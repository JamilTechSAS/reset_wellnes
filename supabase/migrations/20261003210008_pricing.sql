-- ---------------------------------------------------------------------------
-- Migration 20261003210008_pricing
-- Phase 3 / part 1 of 2: the authoritative pricing rules, in SQL.
--
-- Why pricing lives in SQL
-- ------------------------
-- The authoritative price must be computed inside the same transaction that creates the
-- order, otherwise a price computed outside it can go stale between "quote" and "create".
-- PostgREST (what the Supabase client speaks) cannot run multi-statement transactions, so
-- both the quote and the order transaction are database functions. The backend's TypeScript
-- layer validates input, orchestrates the call and re-checks the returned arithmetic; it
-- deliberately does NOT implement a second pricing engine.
--
-- Nothing here invents a business value: prices, quantities, sales windows and discount
-- values all come from rows the client controls. The one policy that had to be represented
-- (whether a quantity discount and a discount code may stack) is a table with the
-- conservative default, so changing it is an UPDATE and not a code change.
--
-- Money is bigint centavos (`*_cents`) everywhere, per the Phase 2 schema.
--
-- Every function below is SECURITY INVOKER with `set search_path = ''` and fully-qualified
-- identifiers: it cannot be tricked into reading another schema's objects. EXECUTE is
-- revoked from PUBLIC and granted to `service_role` only, so the browser-facing roles can
-- never reach the pricing path.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- pricing_policy: the single row holding the discount-combination decision
-- ---------------------------------------------------------------------------
-- Applying a quantity discount and a discount code to the SAME order is a business decision
-- (docs/data-model.md section 8.5). Rather than silently choosing, the policy is data.
-- BEST_SINGLE is the only safe default while the client has not decided: never stack, and
-- let the buyer keep the larger of the two discounts.
create table public.pricing_policy (
  id boolean primary key default true,
  discount_combination text not null default 'BEST_SINGLE'
    check (discount_combination in ('BEST_SINGLE', 'STACK')),
  updated_at timestamptz not null default now(),
  -- Singleton: the primary key can only ever be `true`, so a second policy row is impossible.
  constraint pricing_policy_singleton_check check (id)
);

comment on table public.pricing_policy is
  'Single-row configuration for the discount-combination policy. BEST_SINGLE = at most one discount source applies (the larger one); STACK = quantity discount plus code discount, capped at the subtotal. The client decides which; the default is the conservative one.';

insert into public.pricing_policy (id, discount_combination) values (true, 'BEST_SINGLE');

create trigger pricing_policy_set_updated_at
  before update on public.pricing_policy
  for each row execute function app_private.set_updated_at();

alter table public.pricing_policy enable row level security;

-- ---------------------------------------------------------------------------
-- Idempotency for order creation
-- ---------------------------------------------------------------------------
-- A retried request (double click, mobile retry, timeout) must not create a second order or
-- reserve inventory twice. The client sends an idempotency key; the unique constraint is what
-- makes the guarantee real, not application code.
--
-- Minimum length 16: the key is also a lookup token, so a short guessable value would let a
-- third party probe for someone else's order (order creation additionally requires the buyer
-- email to match before an existing order is returned).
alter table public.orders
  add column idempotency_key text
    check (
      idempotency_key is null
      or (length(idempotency_key) between 16 and 128 and idempotency_key ~ '^[!-~]+$')
    );

comment on column public.orders.idempotency_key is
  'Client-supplied retry key (>= 16 printable chars, e.g. a UUID). Unique when present: a retry of the same request resolves to the same order instead of reserving inventory twice.';

create unique index orders_idempotency_key_idx
  on public.orders (idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- app_private helpers: stage selection and discount arithmetic
-- ---------------------------------------------------------------------------

-- The sales stage a quote would use: lowest `sequence` that is active, inside its window and
-- able to hold the whole requested quantity. Returns NULL when nothing can serve it.
-- Order creation does NOT call this: it re-validates with a conditional UPDATE, because
-- between quoting and creating the stage may have been exhausted (a stale quote must never
-- decide the price).
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
     and (
       t.quantity_limit is null
       or t.quantity_reserved + t.quantity_sold + p_quantity <= t.quantity_limit
     )
   order by t.sequence
   limit 1;
$$;

comment on function app_private.active_pricing_tier_id(uuid, timestamptz, integer) is
  'Deterministic sales stage for a quote: lowest active sequence, inside its window, able to hold the requested quantity. NULL when nothing can serve it.';

-- Best applicable quantity-discount rate in basis points. No configured rows => 0, which is
-- the "quantity discounts are not used" case (the table ships empty on purpose).
create or replace function app_private.quantity_discount_bps(
  p_ticket_type_id uuid,
  p_quantity integer
)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(max(d.percent_bps), 0)
    from public.quantity_discounts d
   where d.ticket_type_id = p_ticket_type_id
     and d.is_active
     and d.min_quantity <= p_quantity;
$$;

comment on function app_private.quantity_discount_bps(uuid, integer) is
  'Highest applicable quantity-discount rate in basis points for the requested quantity (0 when none is configured).';

-- Discount-code amount in centavos for a subtotal. PERCENT floors, so the buyer is never
-- charged more than the percentage they were promised; the result is capped at the subtotal
-- so a total can never go negative.
create or replace function app_private.discount_code_amount_cents(
  p_kind public.discount_kind,
  p_percent_bps integer,
  p_amount_cents bigint,
  p_subtotal_cents bigint
)
returns bigint
language sql
immutable
security invoker
set search_path = ''
as $$
  select least(
    p_subtotal_cents,
    case
      when p_kind = 'PERCENT'
        then (p_subtotal_cents * coalesce(p_percent_bps, 0)) / 10000
      else coalesce(p_amount_cents, 0)
    end
  );
$$;

comment on function app_private.discount_code_amount_cents(public.discount_kind, integer, bigint, bigint) is
  'Discount in centavos for a code: PERCENT uses floor(subtotal * bps / 10000), FIXED uses the stored amount; never exceeds the subtotal.';

-- Evaluates a supplied code and returns a complete, machine-readable verdict, so no caller
-- ever has to guess why a code was refused. Reasons:
--   NOT_SUPPLIED, NOT_FOUND, INACTIVE, NOT_STARTED, EXPIRED, EXHAUSTED, WRONG_TICKET_TYPE,
--   MIN_QUANTITY, OK
create or replace function app_private.evaluate_discount_code(
  p_event_id uuid,
  p_ticket_type_id uuid,
  p_code text,
  p_quantity integer,
  p_subtotal_cents bigint,
  p_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_row public.discount_codes;
  v_reason text;
  v_amount bigint := 0;
  v_remaining integer;
begin
  if v_code = '' then
    return jsonb_build_object(
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
  end if;

  select * into v_row
    from public.discount_codes c
   where c.event_id = p_event_id
     and c.code = v_code;

  if not found then
    v_reason := 'NOT_FOUND';
  elsif not v_row.is_active then
    v_reason := 'INACTIVE';
  elsif v_row.valid_from is not null and v_row.valid_from > p_at then
    v_reason := 'NOT_STARTED';
  elsif v_row.valid_until is not null and v_row.valid_until <= p_at then
    v_reason := 'EXPIRED';
  elsif v_row.max_redemptions is not null and v_row.redeemed_count >= v_row.max_redemptions then
    v_reason := 'EXHAUSTED';
  elsif v_row.ticket_type_id is not null and v_row.ticket_type_id <> p_ticket_type_id then
    v_reason := 'WRONG_TICKET_TYPE';
  elsif p_quantity < v_row.min_quantity then
    v_reason := 'MIN_QUANTITY';
  else
    v_reason := 'OK';
  end if;

  if v_reason = 'OK' then
    v_amount := app_private.discount_code_amount_cents(
      v_row.kind, v_row.percent_bps, v_row.amount_cents, p_subtotal_cents
    );
  end if;

  if v_row.max_redemptions is null then
    v_remaining := null;
  else
    v_remaining := greatest(v_row.max_redemptions - v_row.redeemed_count, 0);
  end if;

  return jsonb_build_object(
    'supplied', true,
    'applies', v_reason = 'OK',
    'reason', v_reason,
    'code', case when v_reason = 'NOT_FOUND' then null else v_row.code end,
    'discountCodeId', case when v_reason = 'NOT_FOUND' then null else v_row.id end,
    'kind', case when v_reason = 'NOT_FOUND' then null else v_row.kind end,
    'percentBps', case when v_reason = 'NOT_FOUND' then null else v_row.percent_bps end,
    'amountInCents', v_amount,
    'remainingRedemptions', case when v_reason = 'NOT_FOUND' then null else v_remaining end
  );
end;
$$;

comment on function app_private.evaluate_discount_code(uuid, uuid, text, integer, bigint, timestamptz) is
  'Evaluates a discount code and returns {supplied, applies, reason, code, kind, percentBps, amountInCents, remainingRedemptions}. Reasons: NOT_SUPPLIED, NOT_FOUND, INACTIVE, NOT_STARTED, EXPIRED, EXHAUSTED, WRONG_TICKET_TYPE, MIN_QUANTITY, OK.';

-- ---------------------------------------------------------------------------
-- public.quote_order_price: authoritative price, no side effects
-- ---------------------------------------------------------------------------
-- Used by POST /pricing/quote. It reserves nothing, so a quote can legitimately go stale —
-- which is exactly why create_order recomputes everything inside its own transaction.
--
-- Error contract (mapped by the backend to the API error model):
--   PT400 INVALID_QUANTITY | INVALID_RESERVATION_WINDOW
--   PT404 EVENT_NOT_FOUND  | TICKET_TYPE_NOT_FOUND
--   PT409 EVENT_NOT_ON_SALE | TICKET_TYPE_INACTIVE | QUANTITY_LIMIT | SOLD_OUT
create or replace function public.quote_order_price(
  p_event_code text,
  p_ticket_type_code text,
  p_quantity integer,
  p_reservation_minutes integer,
  -- Optional parameters come last and are defaulted, so PostgREST (and the generated
  -- TypeScript types) treat them as genuinely optional instead of required-with-null.
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

  v_subtotal := v_tier.price_cents * p_quantity;
  v_quantity_bps := app_private.quantity_discount_bps(v_ticket_type.id, p_quantity);
  v_quantity_discount := (v_subtotal * v_quantity_bps) / 10000;

  v_code := app_private.evaluate_discount_code(
    v_event.id, v_ticket_type.id, p_discount_code, p_quantity, v_subtotal, v_now
  );
  v_code_amount := (v_code ->> 'amountInCents')::bigint;

  select p.discount_combination into v_policy from public.pricing_policy p;

  -- BEST_SINGLE: the buyer keeps the larger discount, the two never stack.
  -- STACK: both apply, capped at the subtotal.
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
      'unitPriceInCents', v_tier.price_cents
    ),
    'subtotalInCents', v_subtotal,
    'quantityDiscount', jsonb_build_object(
      'applies', v_quantity_bps > 0,
      'percentBps', v_quantity_bps,
      'amountInCents', v_quantity_discount
    ),
    -- The applied split: under BEST_SINGLE the loser is 0 (nothing was taken off by it),
    -- which is also what `orders` stores so the CHECK constraint holds.
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

comment on function public.quote_order_price(text, text, integer, integer, text) is
  'Authoritative, side-effect-free price quote with a full breakdown. No price parameter exists: the client cannot supply an amount. Reservation minutes come from configuration, never from the request.';

-- Only the backend's identity may price or order. PUBLIC includes every other role.
revoke all on function public.quote_order_price(text, text, integer, integer, text) from public;
revoke all on function app_private.active_pricing_tier_id(uuid, timestamptz, integer) from public;
revoke all on function app_private.quantity_discount_bps(uuid, integer) from public;
revoke all on function app_private.discount_code_amount_cents(public.discount_kind, integer, bigint, bigint) from public;
revoke all on function app_private.evaluate_discount_code(uuid, uuid, text, integer, bigint, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.quote_order_price(text, text, integer, integer, text) to service_role';
    execute 'grant execute on function app_private.active_pricing_tier_id(uuid, timestamptz, integer) to service_role';
    execute 'grant execute on function app_private.quantity_discount_bps(uuid, integer) to service_role';
    execute 'grant execute on function app_private.discount_code_amount_cents(public.discount_kind, integer, bigint, bigint) to service_role';
    execute 'grant execute on function app_private.evaluate_discount_code(uuid, uuid, text, integer, bigint, timestamptz) to service_role';
  end if;
end
$$;