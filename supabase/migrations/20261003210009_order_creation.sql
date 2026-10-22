-- ---------------------------------------------------------------------------
-- Migration 20261003210009_order_creation
-- Phase 3 / part 2 of 2: the order transaction.
--
-- `public.create_order` is the ONLY way an order comes into existence. Everything that
-- must be consistent happens inside that one transaction:
--
--   1. replay check  -> same idempotency key + same buyer returns the existing order
--   2. resolve event, ticket type and per-order limits
--   3. reserve inventory atomically (conditional UPDATE, no application locks)
--   4. price from the order, 5. claim the discount redemption atomically
--   6. write order, order item, participant, consents and the payment attempt
--   7. return the checkout payload (reference, amount, currency, reservation expiry)
--
-- Any failure raises, which rolls the whole transaction back: no partial order, no leaked
-- inventory, no burned discount redemption.
--
-- Prices are NEVER taken from parameters: there is no amount parameter at all. The only
-- numbers the caller supplies are the quantity and the reservation window (the latter from
-- server configuration, never from the request body).
--
-- Wompi references: attempt 1 uses the order reference verbatim; later attempts append
-- `-<attempt>` (Phase 1 rule: a used reference can never be reused). Uniqueness is enforced
-- by the `payments` unique constraints.
--
-- Helper functions are split out for readability; each is small and independently tested
-- through the API layer. Error codes are the machine-readable contract consumed by the
-- backend (PT400/PT404/PT409 + a `detail` string), never surfaced raw to a browser.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Input normalization and validation
-- ---------------------------------------------------------------------------
-- Normalizes the buyer/participant payload once, so every later step works with canonical
-- values (lowercase email, digits-only document/phone, trimmed names) and the database
-- CHECK constraints can never fire on something that was merely untidy.
create or replace function app_private.normalize_order_input(p_participant jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $norm$
declare
  v_first_name text := btrim(coalesce(p_participant ->> 'firstName', ''));
  v_last_name text := btrim(coalesce(p_participant ->> 'lastName', ''));
  v_national_id text := regexp_replace(coalesce(p_participant ->> 'nationalId', ''), '[^0-9]', '', 'g');
  v_email text := lower(btrim(coalesce(p_participant ->> 'email', '')));
  v_phone text := regexp_replace(coalesce(p_participant ->> 'phone', ''), '[^0-9]', '', 'g');
  v_city text := btrim(coalesce(p_participant ->> 'city', ''));
  -- The leading `@` is stripped here for the same reason the Phase 1 domain normalizer does
  -- it: people paste handles with the at-sign, and the column CHECK forbids it.
  v_instagram text := nullif(
    lower(btrim(ltrim(btrim(coalesce(p_participant ->> 'instagram', '')), '@'))),
    ''
  );
  v_extra_fields jsonb := coalesce(p_participant -> 'extraFields', '{}'::jsonb);
begin
  if v_first_name = '' or length(v_first_name) > 80 then
    raise exception 'Participant first name is required (max 80 characters)'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_NAME';
  end if;
  if v_last_name = '' or length(v_last_name) > 80 then
    raise exception 'Participant last name is required (max 80 characters)'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_NAME';
  end if;
  if v_national_id !~ '^[0-9]{6,12}$' then
    raise exception 'Participant national id must contain between 6 and 12 digits'
      using errcode = 'PT400', detail = 'INVALID_NATIONAL_ID';
  end if;
  if v_email = '' or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Participant email is required and must be valid'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_EMAIL';
  end if;
  if v_phone !~ '^[0-9]{7,15}$' then
    raise exception 'Participant phone must contain between 7 and 15 digits'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_PHONE';
  end if;
  if length(v_city) < 2 or length(v_city) > 80 then
    raise exception 'Participant city is required (2 to 80 characters)'
      using errcode = 'PT400', detail = 'INVALID_CITY';
  end if;
  if v_instagram is not null and v_instagram !~ '^[a-z0-9._]{1,30}$' then
    raise exception 'Instagram handle is not valid'
      using errcode = 'PT400', detail = 'INVALID_INSTAGRAM';
  end if;
  if jsonb_typeof(v_extra_fields) <> 'object' then
    raise exception 'extraFields must be a JSON object'
      using errcode = 'PT400', detail = 'INVALID_EXTRA_FIELDS';
  end if;

  return jsonb_build_object(
    'firstName', v_first_name,
    'lastName', v_last_name,
    'nationalId', v_national_id,
    'email', v_email,
    'phone', v_phone,
    'city', v_city,
    'instagram', v_instagram,
    'extraFields', v_extra_fields
  );
end;
$norm$;

comment on function app_private.normalize_order_input(jsonb) is
  'Normalizes and validates a participant payload (names, document, email, phone, city, Instagram, extra fields). Raises PT400 with a machine-readable detail on any problem.';

-- ---------------------------------------------------------------------------
-- Inventory reservation
-- ---------------------------------------------------------------------------
-- Reserves `p_quantity` units of the chosen stage and returns the tier row, so the caller
-- gets the price from the SAME statement that locked and advanced the counters.
--
-- Why this is race-free: the WHERE clause is evaluated by PostgreSQL against the row as it
-- exists under the row lock. Two concurrent transactions cannot both see the same
-- `quantity_reserved` value and both pass the predicate; the second one re-evaluates after
-- the first commits and finds the quantity already taken. The Phase 2 CHECK constraint
-- (`quantity_reserved + quantity_sold <= quantity_limit`) is the second line of defence:
-- even a programming error cannot oversell.
--
-- The stage is chosen deterministically: the lowest `sequence` among stages that are active,
-- inside their sales window and able to serve the full quantity. An exhausted stage is
-- skipped (the next stage is a valid fallback) rather than raising, and only when no stage
-- can serve the quantity do we raise SOLD_OUT.
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
begin
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
     -- Deterministic stage choice: the lowest eligible sequence.
     and t.sequence = (
       select min(inner_t.sequence)
         from public.pricing_tiers inner_t
        where inner_t.ticket_type_id = t.ticket_type_id
          and inner_t.is_active
          and (inner_t.sales_starts_at is null or inner_t.sales_starts_at <= p_at)
          and (inner_t.sales_ends_at is null or inner_t.sales_ends_at > p_at)
          and (
            inner_t.quantity_limit is null
            or inner_t.quantity_reserved + inner_t.quantity_sold + p_quantity
               <= inner_t.quantity_limit
          )
     )
  returning t.* into v_tier;

  if v_tier.id is null then
    raise exception 'No sales stage can serve this quantity'
      using errcode = 'PT409', detail = 'SOLD_OUT';
  end if;

  return v_tier;
end;
$reserve$;

comment on function app_private.reserve_pricing_tier(uuid, integer, timestamptz) is
  'Atomically reserves inventory on the lowest eligible sales stage and returns that tier row (including its price). Raises PT409/SOLD_OUT when no stage can serve the quantity. Callers must be inside the order transaction.';

-- ---------------------------------------------------------------------------
-- Discount redemption claim
-- ---------------------------------------------------------------------------
-- Advances the usage counter of a discount code only when it is still claimable, and records
-- the append-only ledger row. Two simultaneous orders using a code with max_redemptions = 1
-- cannot both succeed: the predicate is checked under the row lock, and the second caller
-- finds `redeemed_count >= max_redemptions` and matches no row.
--
-- Returns the code id when the claim succeeded, NULL when it did not (the caller decides
-- whether that is fatal — it is, because the price already included the discount).
create or replace function app_private.claim_discount_redemption(
  p_discount_code_id uuid,
  p_order_id uuid,
  p_amount_cents bigint,
  p_at timestamptz
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $claim$
declare
  v_claimed uuid;
begin
  update public.discount_codes c
     set redeemed_count = c.redeemed_count + 1
   where c.id = p_discount_code_id
     and c.is_active
     and (c.valid_from is null or c.valid_from <= p_at)
     and (c.valid_until is null or c.valid_until > p_at)
     and (c.max_redemptions is null or c.redeemed_count < c.max_redemptions)
  returning c.id into v_claimed;

  if v_claimed is null then
    return null;
  end if;

  -- Append-only ledger: the counter is the fast path, this row is the auditable record.
  insert into public.discount_redemptions (discount_code_id, order_id, amount_cents)
  values (v_claimed, p_order_id, p_amount_cents);

  return v_claimed;
end;
$claim$;

comment on function app_private.claim_discount_redemption(uuid, uuid, bigint, timestamptz) is
  'Atomically advances a discount code counter and writes the append-only redemption row. Returns NULL when the code is no longer claimable (exhausted/deactivated/out of window).';

-- ---------------------------------------------------------------------------
-- public.create_order: the single entry point for order creation
-- ---------------------------------------------------------------------------
-- Returns a JSON object with the authoritative order facts. The backend adds the Wompi
-- checkout values (public key, integrity signature) because those depend on server secrets
-- that must never be reachable from SQL logs.
--
-- `replayed = true` means an idempotent retry: the same order, the same reference and the
-- same amount are returned, and nothing was reserved twice.
create or replace function public.create_order(
  p_event_code text,
  p_ticket_type_code text,
  p_quantity integer,
  p_reservation_minutes integer,
  p_buyer_email text,
  p_buyer_name text,
  p_buyer_phone text,
  p_participant jsonb,
  -- Optional parameters come last and are defaulted, so PostgREST (and the generated
  -- TypeScript types) treat them as genuinely optional instead of required-with-null.
  p_discount_code text default null,
  p_idempotency_key text default null,
  p_ip_address text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $order$
declare
  v_now timestamptz := now();
  v_event public.events;
  v_ticket_type public.ticket_types;
  v_tier public.pricing_tiers;
  v_policy text;
  v_participant jsonb;
  v_replay jsonb;
  v_existing public.orders;
  v_existing_item public.order_items;
  v_existing_participant public.participants;
  v_existing_payment public.payments;
  v_existing_tier_name text;
  v_quantity_bps integer := 0;
  v_quantity_discount_raw bigint := 0;
  v_quantity_discount bigint := 0;
  v_code_amount_raw bigint := 0;
  v_code_amount bigint := 0;
  v_subtotal bigint;
  v_code jsonb;
  v_code_id uuid;
  v_discount_total bigint := 0;
  v_total bigint;
  v_order_id uuid;
  v_reference text;
  v_item_id uuid;
  v_participant_id uuid;
  v_payment_id uuid;
  v_claimed_code_id uuid;
  v_reservation_expires_at timestamptz;
  v_email text;
  v_ip inet;
begin
  -- -------------------------------------------------------------------------
  -- 0. Scalar input validation (participant payload is validated separately).
  -- -------------------------------------------------------------------------
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Quantity must be a positive integer'
      using errcode = 'PT400', detail = 'INVALID_QUANTITY';
  end if;
  if p_reservation_minutes is null or p_reservation_minutes < 1
     or p_reservation_minutes > 1440 then
    raise exception 'Reservation window is out of range'
      using errcode = 'PT400', detail = 'INVALID_RESERVATION_WINDOW';
  end if;

  v_email := lower(btrim(coalesce(p_buyer_email, '')));
  if v_email = '' or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Buyer email is required and must be valid'
      using errcode = 'PT400', detail = 'INVALID_BUYER_EMAIL';
  end if;
  if p_buyer_name is null or btrim(p_buyer_name) = '' or length(btrim(p_buyer_name)) > 160 then
    raise exception 'Buyer name is required (max 160 characters)'
      using errcode = 'PT400', detail = 'INVALID_BUYER_NAME';
  end if;
  if p_buyer_phone is null or btrim(p_buyer_phone) !~ '^[0-9]{7,15}$' then
    raise exception 'Buyer phone must contain between 7 and 15 digits'
      using errcode = 'PT400', detail = 'INVALID_BUYER_PHONE';
  end if;

  v_participant := app_private.normalize_order_input(p_participant);

  -- Consent to personal data processing is the legal basis for storing the data at all;
  -- the future-events consent is optional and recorded either way (append-only).
  if coalesce((coalesce(p_participant -> 'consents', '{}'::jsonb) ->> 'dataProcessing')::boolean,
              false) is not true then
    raise exception 'Consent to personal data processing is required to buy a ticket'
      using errcode = 'PT400', detail = 'CONSENT_REQUIRED';
  end if;

  -- IP is optional personal data: keep it only when it parses, never fail the order for it.
  begin
    v_ip := nullif(btrim(coalesce(p_ip_address, '')), '')::inet;
  exception when others then
    v_ip := null;
  end;

  -- -------------------------------------------------------------------------
  -- 1. Idempotent replay: the same key with the same buyer returns the same order.
  --    The unique index is the real guard; this lookup makes a retry answer instead
  --    of failing, and returns the same reference/amount so a retry_placeholder
  -- -------------------------------------------------------------------------
  if p_idempotency_key is not null and length(p_idempotency_key) > 0 then
    if length(p_idempotency_key) < 16 or p_idempotency_key !~ '^[!-~]+$' then
      raise exception 'Idempotency key must be at least 16 printable characters'
        using errcode = 'PT400', detail = 'INVALID_IDEMPOTENCY_KEY';
    end if;

    select * into v_existing
      from public.orders o
     where o.idempotency_key = p_idempotency_key;

    if found then
      -- A key that belongs to a DIFFERENT buyer must never reveal that order.
      if v_existing.buyer_email <> v_email then
        raise exception 'Idempotency key is already used'
          using errcode = 'PT409', detail = 'IDEMPOTENCY_KEY_CONFLICT';
      end if;

      select * into v_existing_item
        from public.order_items i
       where i.order_id = v_existing.id
       order by i.created_at, i.id
       limit 1;
      select * into v_existing_participant
        from public.participants p
       where p.order_id = v_existing.id
       order by p.created_at, p.id
       limit 1;
      select * into v_existing_payment
        from public.payments pay
       where pay.order_id = v_existing.id
       order by pay.attempt
       limit 1;
      select t.name into v_existing_tier_name
        from public.pricing_tiers t
       where t.id = v_existing_item.pricing_tier_id;

      return jsonb_build_object(
        'replayed', true,
        'orderId', v_existing.id,
        'reference', v_existing.reference,
        'status', v_existing.status,
        'quantity', v_existing_item.quantity,
        'unitPriceInCents', v_existing_item.unit_price_cents,
        'pricingTierName', v_existing_tier_name,
        'subtotalInCents', v_existing.subtotal_cents,
        'quantityDiscountInCents', v_existing.quantity_discount_cents,
        'discountCodeInCents', v_existing.discount_code_cents,
        'totalInCents', v_existing.total_cents,
        'currency', v_existing.currency,
        'reservationExpiresAt', v_existing.reservation_expires_at,
        'paymentAttempt', v_existing_payment.attempt,
        'wompiReference', v_existing_payment.wompi_reference,
        'participantId', v_existing_participant.id
      );
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Resolve the event and the ticket type.
  -- -------------------------------------------------------------------------
  select * into v_event
    from public.events e
   where e.code = upper(btrim(coalesce(p_event_code, '')));
  if not found then
    raise exception 'Event not found' using errcode = 'PT404', detail = 'EVENT_NOT_FOUND';
  end if;
  if v_event.status <> 'PUBLISHED' then
    raise exception 'Event is not on sale'
      using errcode = 'PT409', detail = 'EVENT_NOT_ON_SALE';
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
     or (v_ticket_type.max_per_order is not null
         and p_quantity > v_ticket_type.max_per_order) then
    raise exception 'Quantity is outside the configured per-order limits'
      using errcode = 'PT409', detail = 'QUANTITY_LIMIT';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Reserve inventory and get the price from the reserved stage.
  -- -------------------------------------------------------------------------
  v_tier := app_private.reserve_pricing_tier(v_ticket_type.id, p_quantity, v_now);
  v_subtotal := v_tier.price_cents * p_quantity;

  -- -------------------------------------------------------------------------
  -- 4. Discounts, computed from the database only.
  -- -------------------------------------------------------------------------
  v_quantity_bps := app_private.quantity_discount_bps(v_ticket_type.id, p_quantity);
  v_quantity_discount_raw := (v_subtotal * v_quantity_bps) / 10000;

  v_code := app_private.evaluate_discount_code(
    v_event.id, v_ticket_type.id, p_discount_code, p_quantity, v_subtotal, v_now
  );
  -- A code the buyer explicitly supplied must actually apply. Proceeding without it would
  -- charge MORE than the price the buyer was shown, so an unusable code is a hard failure
  -- here (the quote endpoint stays non-fatal and reports the reason, so the UI can explain
  -- it before the buyer submits). Detail codes: DISCOUNT_<REASON> from evaluate_discount_code.
  if (v_code ->> 'supplied')::boolean and not (v_code ->> 'applies')::boolean then
    raise exception 'Discount code cannot be applied'
      using errcode = 'PT409', detail = 'DISCOUNT_' || (v_code ->> 'reason');
  end if;

  if (v_code ->> 'applies')::boolean then
    v_code_id := (v_code ->> 'discountCodeId')::uuid;
    v_code_amount_raw := (v_code ->> 'amountInCents')::bigint;
  end if;

  -- The orders CHECK constraint is `subtotal - quantity_discount - discount_code = total`,
  -- so the two columns must hold the amounts ACTUALLY APPLIED, not the raw candidates.
  -- Under BEST_SINGLE the loser is stored as 0 (nothing was taken off by it) and the
  -- redemption is claimed only for the winner, so usage accounting stays truthful.
  select p.discount_combination into v_policy from public.pricing_policy p;
  if v_policy = 'STACK' then
    v_quantity_discount := v_quantity_discount_raw;
    v_code_amount := least(v_code_amount_raw, v_subtotal - v_quantity_discount_raw);
    if v_code_amount < v_code_amount_raw then
      -- The subtotal cap swallowed part of the code discount; nothing left to claim.
      v_code_id := null;
    end if;
  elsif v_quantity_discount_raw >= v_code_amount_raw then
    v_quantity_discount := v_quantity_discount_raw;
    v_code_amount := 0;
    v_code_id := null;
  else
    v_quantity_discount := 0;
    v_code_amount := v_code_amount_raw;
  end if;

  v_discount_total := v_quantity_discount + v_code_amount;
  v_total := v_subtotal - v_discount_total;

  if v_code_amount = 0 then
    v_code_id := null;
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Write the order (the reference comes from the Phase 2 sequence, so it is
  --    unique even under concurrency and never reused).
  -- -------------------------------------------------------------------------
  v_reference := app_private.next_order_reference(
    extract(year from v_now at time zone 'America/Bogota')::integer
  );
  v_reservation_expires_at := v_now + make_interval(mins => p_reservation_minutes);

  insert into public.orders (
    reference, event_id, status, buyer_email, buyer_name, buyer_phone,
    subtotal_cents, quantity_discount_cents, discount_code_cents, total_cents,
    currency, discount_code_id, reservation_expires_at, source, ip_address, user_agent,
    idempotency_key
  ) values (
    v_reference, v_event.id, 'PENDING', v_email, btrim(p_buyer_name), btrim(p_buyer_phone),
    v_subtotal, v_quantity_discount, v_code_amount, v_total,
    v_event.currency, v_code_id, v_reservation_expires_at, 'WEB', v_ip, nullif(btrim(coalesce(p_user_agent, '')), ''),
    nullif(p_idempotency_key, '')
  )
  returning id into v_order_id;

  insert into public.order_items (
    order_id, ticket_type_id, pricing_tier_id, quantity, unit_price_cents,
    quantity_discount_cents, line_total_cents, ticket_type_name, pricing_tier_name
  ) values (
    v_order_id, v_ticket_type.id, v_tier.id, p_quantity, v_tier.price_cents,
    v_quantity_discount, v_subtotal - v_quantity_discount,
    v_ticket_type.name, v_tier.name
  )
  returning id into v_item_id;

  -- -------------------------------------------------------------------------
  -- 6. Claim the discount redemption after the order exists (the ledger row needs
  --    the order id). A failure here rolls back the order and the reservation.
  -- -------------------------------------------------------------------------
  if v_code_id is not null then
    v_claimed_code_id := app_private.claim_discount_redemption(
      v_code_id, v_order_id, v_code_amount, v_now
    );
    if v_claimed_code_id is null then
      raise exception 'Discount code is no longer available'
        using errcode = 'PT409', detail = 'DISCOUNT_UNAVAILABLE';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Participant and consents (append-only: a withdrawal is a new row).
  -- -------------------------------------------------------------------------
  insert into public.participants (
    event_id, order_id, order_item_id, first_name, last_name, national_id,
    email, phone, city, instagram, extra_fields
  ) values (
    v_event.id, v_order_id, v_item_id,
    v_participant ->> 'firstName', v_participant ->> 'lastName', v_participant ->> 'nationalId',
    v_participant ->> 'email', v_participant ->> 'phone', v_participant ->> 'city',
    v_participant ->> 'instagram', v_participant -> 'extraFields'
  )
  returning id into v_participant_id;

  insert into public.consents (event_id, participant_id, kind, granted, policy_version, ip_address)
  values
    (v_event.id, v_participant_id, 'DATA_PROCESSING', true,
     coalesce(nullif(btrim(p_participant ->> 'consentPolicyVersion'), ''), 'v1'), v_ip),
    (v_event.id, v_participant_id, 'FUTURE_EVENTS',
     coalesce((coalesce(p_participant -> 'consents', '{}'::jsonb) ->> 'futureEvents')::boolean, false),
     coalesce(nullif(btrim(p_participant ->> 'consentPolicyVersion'), ''), 'v1'), v_ip);

  -- -------------------------------------------------------------------------
  -- 8. Payment attempt. Created PENDING: the order is only paid after a verified
  --    Wompi event (Phase 4). Attempt 1 uses the order reference verbatim.
  -- -------------------------------------------------------------------------
  insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents, currency)
  values (v_order_id, 1, v_reference, 'pending', v_total, v_event.currency)
  returning id into v_payment_id;

  return jsonb_build_object(
    'replayed', false,
    'orderId', v_order_id,
    'reference', v_reference,
    'status', 'PENDING',
    'quantity', p_quantity,
    'unitPriceInCents', v_tier.price_cents,
    'pricingTierName', v_tier.name,
    'subtotalInCents', v_subtotal,
    'quantityDiscountInCents', v_quantity_discount,
    'discountCodeInCents', v_code_amount,
    'totalDiscountInCents', v_discount_total,
    'discountCombination', v_policy,
    'totalInCents', v_total,
    'currency', v_event.currency,
    'reservationExpiresAt', to_char(v_reservation_expires_at at time zone 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'paymentAttempt', 1,
    'wompiReference', v_reference,
    'participantId', v_participant_id
  );
end;
$order$;

comment on function public.create_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text) is
  'The only way an order comes into existence: idempotent replay, atomic inventory reservation, database pricing, atomic discount redemption, and creation of the order, its item, participant, consents and pending payment attempt. Returns the authoritative checkout payload.';

-- Only the backend identity may create orders or price them.
revoke all on function public.create_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text) from public;
revoke all on function app_private.normalize_order_input(jsonb) from public;
revoke all on function app_private.reserve_pricing_tier(uuid, integer, timestamptz) from public;
revoke all on function app_private.claim_discount_redemption(uuid, uuid, bigint, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.create_order(text, text, integer, integer, text, text, text, jsonb, text, text, text, text) to service_role';
    execute 'grant execute on function app_private.normalize_order_input(jsonb) to service_role';
    execute 'grant execute on function app_private.reserve_pricing_tier(uuid, integer, timestamptz) to service_role';
    execute 'grant execute on function app_private.claim_discount_redemption(uuid, uuid, bigint, timestamptz) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.pricing_policy from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.pricing_policy from authenticated';
  end if;
end
$$;
