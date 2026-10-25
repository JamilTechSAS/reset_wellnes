-- ---------------------------------------------------------------------------
-- Migration 20261024210000_post_purchase_email
-- The post-purchase email: one order-keyed outbox row, enqueued in the SAME
-- transaction that moves the order to PAID.
--
-- Why a new table instead of `email_deliveries`: that legacy outbox is keyed by
-- `ticket_id` (NOT NULL, FK to the discontinued ticket table), and one email per ticket. The
-- current product has no tickets, no tokens and no QR: an order's admissions live on
-- `order_items`/`participants`, and the buyer must receive exactly ONE message per order.
-- Reusing the ticket-keyed table would require rewriting its key derivation and constraints
-- around data that no longer exists.
--
-- Trigger point is the state transition itself, not the webhook handler:
--   * `orders.status` -> 'PAID' is written by `confirm_payment` inside the verified-payment
--     transaction (ePayco signature checked, provider record re-read, amount/currency/tx id
--     matched). The AFTER trigger therefore cannot fire for an unsigned delivery, a browser
--     redirect, a client-supplied status or a merely pending order.
--   * Because the row is inserted in that transaction, a rollback takes the email intent with
--     it: no email can be queued for a payment that did not commit.
--   * `unique (order_id, template)` + `on conflict do nothing` make redeliveries, replayed
--     webhooks and any second PAID transition idempotent: at most one logical email per order.
--
-- Delivery is NOT attempted here. The queue is drained after commit by the webhook's
-- post-commit step and by the scheduled maintenance run, exactly like the legacy outbox.
-- Historical orders are deliberately not backfilled: only a new PAID transition enqueues, so
-- no past buyer is emailed by this migration.
--
-- Safety: this migration does not touch `orders`, `payments`, inventory, participants, the
-- sales schedule or any existing row. It only adds a table, a trigger, two RPCs and one
-- read-model function.
-- ---------------------------------------------------------------------------

create table public.order_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  -- Only the post-purchase email exists today; the format check leaves room for future
  -- order-level templates without inventing a free-text column.
  template text not null default 'POST_PURCHASE'
    check (template ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  -- Deduplication key: one row per (order, template). The unique constraint is what actually
  -- prevents a second logical email.
  idempotency_key text not null unique
    check (
      length(idempotency_key) between 16 and 200
      and idempotency_key !~ '[\n\r\t]'
    ),
  -- Destination copied from the verified order at enqueue time (normalized lowercase).
  -- `get_post_purchase_email_context` re-checks it against `orders.buyer_email` before the
  -- message is built, so a row can never be sent to a different address than the buyer's.
  recipient_email text not null
    check (
      recipient_email = lower(recipient_email)
      and recipient_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      and length(recipient_email) <= 254
    ),
  status public.email_delivery_status not null default 'QUEUED',
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  provider text not null default 'resend'
    check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_message_id text,
  -- Last failure, bounded and free of secrets (no API keys, no provider response bodies).
  last_error text
    check (last_error is null or length(last_error) <= 500),
  next_attempt_at timestamptz,
  -- Lease held by the dispatcher that claimed the row. A stale claim (crash) is recoverable:
  -- the claim RPC reclaims it once `claim_expires_at` has passed, and the finish RPC requires
  -- the token, so a slow worker cannot overwrite the state of a newer claim.
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_email_deliveries_order_template_unique unique (order_id, template),
  -- The key is derived from the row's own identity, so `unique (idempotency_key)` and
  -- `unique (order_id, template)` enforce the same rule.
  constraint order_email_deliveries_key_derivation_check check (
    idempotency_key = 'order:' || order_id::text || ':' || template
  ),
  -- A successful send implies a sent_at, and only a SENT row carries one.
  constraint order_email_deliveries_sent_at_check check (
    sent_at is null or status = 'SENT'
  ),
  -- Scheduling a retry for a final row would be a bug; catch it here.
  constraint order_email_deliveries_retry_state_check check (
    next_attempt_at is null or status in ('QUEUED', 'FAILED')
  ),
  -- The lease exists exactly while the row is SENDING.
  constraint order_email_deliveries_lease_check check (
    (status = 'SENDING' and claim_token is not null and claim_expires_at is not null)
    or (status <> 'SENDING' and claim_token is null and claim_expires_at is null)
  )
);

comment on table public.order_email_deliveries is
  'Outbox of the post-purchase email: one row per (order, POST_PURCHASE), written by an AFTER trigger on the PAID transition inside the verified-payment transaction. Unique key + row lock make duplicate sends impossible; sending happens after commit.';

create index order_email_deliveries_due_idx
  on public.order_email_deliveries (next_attempt_at)
  where status in ('QUEUED', 'FAILED');

create index order_email_deliveries_lease_idx
  on public.order_email_deliveries (claim_expires_at)
  where status = 'SENDING';

create trigger order_email_deliveries_set_updated_at
  before update on public.order_email_deliveries
  for each row execute function app_private.set_updated_at();

alter table public.order_email_deliveries enable row level security;

-- ---------------------------------------------------------------------------
-- 1. Enqueue on the PAID transition.
--
-- SECURITY INVOKER + an explicit grant (below): `confirm_payment` already runs as the
-- backend role, which holds INSERT on this table. Nothing here widens what that role could
-- do with orders: the trigger only inserts an outbox row.
-- ---------------------------------------------------------------------------
create or replace function app_private.enqueue_post_purchase_email()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $enqueue$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PAID' then
      return null;
    end if;
  elsif old.status = new.status or new.status <> 'PAID' then
    -- Only a transition INTO PAID enqueues. A second update of an already-paid order (an
    -- admin touch, a replay) must not create another job.
    return null;
  end if;

  insert into public.order_email_deliveries (order_id, template, recipient_email, idempotency_key)
  values (
    new.id,
    'POST_PURCHASE',
    lower(btrim(new.buyer_email)),
    'order:' || new.id::text || ':POST_PURCHASE'
  )
  on conflict (order_id, template) do nothing;

  return null;
end;
$enqueue$;

comment on function app_private.enqueue_post_purchase_email() is
  'Queues the single post-purchase email of an order when it transitions to PAID. Idempotent: a repeated PAID transition inserts nothing.';

create trigger orders_enqueue_post_purchase_email
  after insert or update of status on public.orders
  for each row execute function app_private.enqueue_post_purchase_email();

-- ---------------------------------------------------------------------------
-- 2. Claim a batch: lease + attempt counter, stale claims recoverable, only PAID orders.
--    Mirrors `claim_participant_sheet_projections` (SKIP LOCKED, bounded batch, stale lease).
-- ---------------------------------------------------------------------------
create or replace function public.claim_order_email_deliveries(
  p_limit integer default 25,
  p_now timestamptz default now(),
  p_lease_seconds integer default 300,
  p_max_attempts integer default 5
)
returns setof public.order_email_deliveries
language plpgsql
security invoker
set search_path = ''
as $claim$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Email claim limit must be between 1 and 200'
      using errcode = 'PT400', detail = 'INVALID_LIMIT';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Email max attempts must be between 1 and 20'
      using errcode = 'PT400', detail = 'INVALID_MAX_ATTEMPTS';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'Email lease must be between 30 and 3600 seconds'
      using errcode = 'PT400', detail = 'INVALID_LEASE';
  end if;

  return query
  with candidate as (
    select d.id
      from public.order_email_deliveries d
      join public.orders o on o.id = d.order_id
     where o.status = 'PAID'
       and d.attempt_count < p_max_attempts
       and (
         (d.status in ('QUEUED', 'FAILED')
          and coalesce(d.next_attempt_at, d.queued_at) <= p_now)
         or (d.status = 'SENDING' and d.claim_expires_at <= p_now)
       )
     order by coalesce(d.next_attempt_at, d.queued_at)
     limit p_limit
     for update of d skip locked
  )
  update public.order_email_deliveries d
     set status = 'SENDING',
         attempt_count = d.attempt_count + 1,
         next_attempt_at = null,
         claim_token = gen_random_uuid(),
         claimed_at = p_now,
         claim_expires_at = p_now + make_interval(secs => p_lease_seconds)
    from candidate c
   where d.id = c.id
  returning d.*;
end;
$claim$;

comment on function public.claim_order_email_deliveries(integer, timestamptz, integer, integer) is
  'Leases up to p_limit due post-purchase emails of PAID orders (SKIP LOCKED), incrementing the attempt counter and stamping a claim token that only this worker may finish. A SENDING row whose lease expired is reclaimable.';

-- ---------------------------------------------------------------------------
-- 3. Finish one delivery with its own claim token.
-- ---------------------------------------------------------------------------
create or replace function public.finish_order_email_delivery(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_status public.email_delivery_status,
  p_provider_message_id text default null,
  p_error text default null,
  p_next_attempt_at timestamptz default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $finish$
declare
  v_updated integer := 0;
begin
  if p_status not in ('SENT'::public.email_delivery_status,
                      'FAILED'::public.email_delivery_status,
                      'CANCELLED'::public.email_delivery_status) then
    raise exception 'A finished email must be SENT, FAILED or CANCELLED'
      using errcode = 'PT400', detail = 'INVALID_EMAIL_STATUS';
  end if;
  if p_status = 'FAILED' and p_next_attempt_at is null then
    raise exception 'A retryable failure must carry its next attempt instant'
      using errcode = 'PT400', detail = 'INVALID_RETRY_SCHEDULE';
  end if;

  update public.order_email_deliveries
     set status = p_status,
         provider_message_id = case when p_status = 'SENT'
                                    then nullif(left(btrim(coalesce(p_provider_message_id, '')), 200), '')
                                    else provider_message_id end,
         last_error = case when p_status = 'SENT'
                           then null
                           else nullif(left(btrim(coalesce(p_error, '')), 500), '') end,
         sent_at = case when p_status = 'SENT' then p_now else null end,
         next_attempt_at = case when p_status = 'FAILED' then p_next_attempt_at else null end,
         claim_token = null,
         claimed_at = null,
         claim_expires_at = null
   where id = p_delivery_id
     and claim_token = p_claim_token
     and status = 'SENDING';
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'updatedCount', v_updated,
    'status', p_status
  );
end;
$finish$;

comment on function public.finish_order_email_delivery(uuid, uuid, public.email_delivery_status, text, text, timestamptz, timestamptz) is
  'Records the outcome of a claimed post-purchase email. Only the row still held by that claim token is updated, so a worker whose lease was taken over cannot overwrite a newer attempt.';

-- ---------------------------------------------------------------------------
-- 4. Read model for one delivery.
--
-- Returns NULL unless the order is PAID and the stored recipient still equals the buyer
-- email on that order. That is the "send to the verified buyer" rule expressed in SQL: a
-- worker cannot build the message for an unpaid order or for a different address, even if
-- the row were tampered with.
--
-- Contains only what the email prints: the buyer's own name, the last 4 digits of their
-- document, order/event/venue data and admission counts. Other attendees' data is never
-- returned — only how many participants are registered.
-- ---------------------------------------------------------------------------
create or replace function public.get_post_purchase_email_context(p_delivery_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $context$
declare
  v_delivery public.order_email_deliveries;
  v_order public.orders;
  v_event public.events;
  v_buyer public.participants;
  v_item public.order_items;
  v_bundle public.ticket_bundles;
  v_registered integer := 0;
  v_quantity integer := 0;
begin
  select * into v_delivery
    from public.order_email_deliveries d
   where d.id = p_delivery_id;
  if v_delivery.id is null then
    return null;
  end if;

  select * into v_order from public.orders o where o.id = v_delivery.order_id;
  if v_order.id is null
     or v_order.status <> 'PAID'
     or lower(btrim(v_order.buyer_email)) <> v_delivery.recipient_email then
    return null;
  end if;

  select * into v_event from public.events e where e.id = v_order.event_id;

  select coalesce(sum(oi.quantity), 0)::integer into v_quantity
    from public.order_items oi
   where oi.order_id = v_order.id;

  select count(*)::integer into v_registered
    from public.participants p
   where p.order_id = v_order.id;

  -- The buyer's own row is the first participant written by create_order (unit 1).
  select * into v_buyer
    from public.participants p
   where p.order_id = v_order.id
   order by p.created_at, p.id
   limit 1;

  select * into v_item
    from public.order_items oi
   where oi.order_id = v_order.id
   order by oi.created_at, oi.id
   limit 1;

  if v_item.bundle_id is not null then
    select * into v_bundle from public.ticket_bundles b where b.id = v_item.bundle_id;
  end if;

  return jsonb_build_object(
    'deliveryId', v_delivery.id,
    'template', v_delivery.template,
    'attemptCount', v_delivery.attempt_count,
    'recipientEmail', v_delivery.recipient_email,
    'orderReference', v_order.reference,
    'currency', v_order.currency,
    'totalInCents', v_order.total_cents,
    'quantity', v_quantity,
    'registeredParticipants', v_registered,
    'unitPriceInCents', v_item.unit_price_cents,
    'packageName', v_item.ticket_type_name,
    'pricingTierName', v_item.pricing_tier_name,
    'bundleCode', v_bundle.code,
    'eventCode', v_event.code,
    'eventName', v_event.name,
    'eventStartsAt', app_private.iso_utc(v_event.starts_at),
    'eventTimezone', v_event.timezone,
    'venueName', v_event.venue_name,
    'venueAddress', v_event.venue_address,
    'city', v_event.city,
    'buyerFirstName', v_buyer.first_name,
    'buyerLastName', v_buyer.last_name,
    -- Display-only half-mask (•••• 1234). The full document never leaves the database.
    'buyerDocumentLast4', case when v_buyer.national_id is null then null
                               else right(v_buyer.national_id, 4) end
  );
end;
$context$;

comment on function public.get_post_purchase_email_context(uuid) is
  'Read model for one post-purchase email: order, event, buyer name and last 4 document digits, admission counts. NULL unless the order is PAID and the stored recipient is still the order''s buyer email. Never returns other attendees'' data or the full document.';

-- ---------------------------------------------------------------------------
-- 5. Access model: backend only.
-- ---------------------------------------------------------------------------
do $$
declare
  role_name text;
begin
  foreach role_name in array array['public', 'anon', 'authenticated'] loop
    if role_name = 'public' then
      execute 'revoke all on table public.order_email_deliveries from public';
      execute 'revoke all on function app_private.enqueue_post_purchase_email() from public';
      execute 'revoke all on function public.claim_order_email_deliveries(integer, timestamptz, integer, integer) from public';
      execute 'revoke all on function public.finish_order_email_delivery(uuid, uuid, public.email_delivery_status, text, text, timestamptz, timestamptz) from public';
      execute 'revoke all on function public.get_post_purchase_email_context(uuid) from public';
    elsif exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table public.order_email_deliveries from %I', role_name);
      execute format('revoke all on function app_private.enqueue_post_purchase_email() from %I', role_name);
      execute format('revoke all on function public.claim_order_email_deliveries(integer, timestamptz, integer, integer) from %I', role_name);
      execute format('revoke all on function public.finish_order_email_delivery(uuid, uuid, public.email_delivery_status, text, text, timestamptz, timestamptz) from %I', role_name);
      execute format('revoke all on function public.get_post_purchase_email_context(uuid) from %I', role_name);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.order_email_deliveries to service_role';
    execute 'grant execute on function app_private.enqueue_post_purchase_email() to service_role';
    execute 'grant execute on function public.claim_order_email_deliveries(integer, timestamptz, integer, integer) to service_role';
    execute 'grant execute on function public.finish_order_email_delivery(uuid, uuid, public.email_delivery_status, text, text, timestamptz, timestamptz) to service_role';
    execute 'grant execute on function public.get_post_purchase_email_context(uuid) to service_role';
  end if;
end
$$;
