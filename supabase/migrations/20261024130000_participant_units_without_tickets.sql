-- Migration 20261024130000_participant_units_without_tickets
-- -----------------------------------------------------------------------------
-- Removes the last ticket dependency from the purchase flow.
--
-- 20261024120000 discontinued ticket issuance: confirm_payment no longer creates
-- ticket rows, so `attach_participant` — which claimed an unassigned row from
-- public.tickets — could never succeed again (every call raised PT409
-- TICKET_NOT_ASSIGNABLE). A two-admission purchase could therefore only ever
-- carry the buyer's own participant row, and the companion ("Comparte esta
-- experiencia" / "Doble experiencia") could never reach the paid order or the
-- Google Sheets projection.
--
-- The unit of admission belongs to the order, not to a ticket:
--   * capacity     = sum(order_items.quantity) for the order (the same source
--                    confirm_payment uses for inventory and `ticketsExpected`),
--   * assigned     = number of participant rows already on the order
--                    (create_order writes the buyer's own row, so it consumes
--                    one unit),
--   * target line  = the first order_item, in purchase order, whose participant
--                    count is still below its quantity. That keeps the line's
--                    ticket type / stage attribution correct for the Sheets
--                    export, including a named bundle whose single line has
--                    quantity = included_admissions.
--
-- Concurrency: `FOR UPDATE` on the order row serializes attachments of the same
-- order, so two simultaneous calls cannot both take the last unit. (The ticket
-- era used `FOR UPDATE SKIP LOCKED` per ticket row; without tickets the order is
-- the natural lock and the unit count is derived inside that lock.) A locked
-- order row is already taken by confirm_payment, so this adds no new privilege.
--
-- Unchanged on purpose: the reference + buyer email ownership gate (a wrong
-- email, an unknown reference and a participant of another order stay
-- indistinguishable), the PAID-only rule, append-only consent evidence, the
-- PAID enqueue of participant projections, ePayco verification, inventory
-- accounting and replay idempotency. No ticket row, token or QR is read or
-- written here.
--
-- `p_ticket_token` is gone: a client could previously pin an assignment to a
-- ticket token, and tokens no longer exist. The 6-argument function is dropped
-- before the new one is created so PostgREST never sees two overloads.
-- -----------------------------------------------------------------------------

drop function if exists public.attach_participant(text, text, jsonb, text, text, timestamptz);

create or replace function public.attach_participant(
  p_order_reference text,
  p_buyer_email text,
  p_participant jsonb,
  p_policy_version text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $attach$
declare
  v_order public.orders;
  v_item public.order_items;
  v_payload jsonb;
  v_participant_id uuid;
  v_appended integer := 0;
  v_capacity integer := 0;
  v_assigned integer := 0;
  v_unit integer;
  v_remaining integer := 0;
begin
  -- Ownership is part of the lookup. The row lock serializes concurrent
  -- assignments of the same order, which is what makes the capacity check below
  -- authoritative.
  select * into v_order
    from public.orders
   where reference = btrim(coalesce(p_order_reference, ''))
     and buyer_email = lower(btrim(coalesce(p_buyer_email, '')))
   for update;
  if v_order.id is null then
    return jsonb_build_object('found', false);
  end if;

  if v_order.status <> 'PAID' then
    raise exception 'Participants can only be attached to a paid order'
      using errcode = 'PT409', detail = 'ORDER_NOT_PAID';
  end if;

  -- Admissions bought, exactly as the inventory move and `ticketsExpected`
  -- compute them: the order lines are the source of truth.
  select coalesce(sum(oi.quantity), 0)::integer into v_capacity
    from public.order_items oi
   where oi.order_id = v_order.id;

  select count(*)::integer into v_assigned
    from public.participants p
   where p.order_id = v_order.id;

  if v_capacity <= v_assigned then
    raise exception 'The order has no unassigned admission for this request'
      using errcode = 'PT409', detail = 'NO_ASSIGNABLE_UNIT';
  end if;

  -- First line with a free unit, in purchase order. A line is full when it
  -- already has as many participants as units sold.
  select oi.* into v_item
    from public.order_items oi
   where oi.order_id = v_order.id
     and oi.quantity > (
       select count(*)
         from public.participants p
        where p.order_item_id = oi.id
     )
   order by oi.created_at, oi.id
   limit 1;

  if v_item.id is null then
    -- Capacity exists on the order but no line can take it (legacy data with
    -- unattributed participant rows). Never guess a line: fail visibly.
    raise exception 'The order has no assignable order line for this request'
      using errcode = 'PT409', detail = 'NO_ASSIGNABLE_UNIT';
  end if;

  v_payload := app_private.normalize_participant_payload(p_participant);

  -- 1-based ordinal of the admission inside the order. Stable because the buyer
  -- row is created with the order and participants are never deleted, and
  -- computed under the order lock so two calls cannot share a number.
  v_unit := v_assigned + 1;

  insert into public.participants (
    event_id, order_id, order_item_id,
    first_name, last_name, national_id, email, phone, city, instagram
  ) values (
    v_order.event_id, v_order.id, v_item.id,
    v_payload ->> 'firstName', v_payload ->> 'lastName', v_payload ->> 'nationalId',
    v_payload ->> 'email', v_payload ->> 'phone', v_payload ->> 'city',
    nullif(v_payload ->> 'instagram', '')
  )
  returning id into v_participant_id;

  v_appended := app_private.append_participant_consents(
    v_order.event_id, v_participant_id, v_payload -> 'consents', p_policy_version, p_now
  );

  v_remaining := greatest(v_capacity - v_assigned - 1, 0);

  return jsonb_build_object(
    'found', true,
    'orderReference', v_order.reference,
    'unit', v_unit,
    'participant', jsonb_build_object(
      'participantId', v_participant_id,
      'firstName', v_payload ->> 'firstName',
      'lastName', v_payload ->> 'lastName'
    ),
    'consents', jsonb_build_object(
      'dataProcessing', (v_payload -> 'consents' ->> 'dataProcessing')::boolean,
      'futureEvents', (v_payload -> 'consents' ->> 'futureEvents')::boolean,
      'policyVersion', coalesce(nullif(btrim(coalesce(p_policy_version, '')), ''), 'v1'),
      'capturedAt', app_private.iso_utc(p_now)
    ),
    'consentsAppended', v_appended,
    'remainingUnassigned', v_remaining
  );
end;
$attach$;

comment on function public.attach_participant(text, text, jsonb, text, timestamptz) is
  'Creates one participant for a paid order and assigns it to the next admission of the order (derived from order_items.quantity, never from tickets). Reference+email ownership is required; the order row lock serializes concurrent calls and enforces capacity; consent evidence is appended, never overwritten.';

-- Function replacement drops its ACL: re-apply the backend-only access model
-- (migration 20261004130000 revoked PUBLIC EXECUTE; service_role is the caller).
revoke all on function public.attach_participant(text, text, jsonb, text, timestamptz) from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all on function public.attach_participant(text, text, jsonb, text, timestamptz) from %I',
        role_name
      );
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.attach_participant(text, text, jsonb, text, timestamptz) to service_role';
  end if;
end
$$;
