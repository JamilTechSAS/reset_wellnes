-- ---------------------------------------------------------------------------
-- Migration 20261003210013_operators_participants_checkin
-- Phase 5 / part 2: operator identity, participant assignment and real check-in.
--
-- Three closely related pieces:
--
-- 1. OPERATORS (authorization data, not credentials).
--    Authentication is Supabase Auth: operators are real `auth.users` with an email and a
--    password (or magic link) managed by the project owner. This table only carries the
--    AUTHORIZATION data — display name, role, active flag — keyed by the Auth user id.
--    No password ever touches this schema, and no shared secret is involved. Financial
--    and administrative capabilities stay a separate role value so they can be split
--    later without a migration.
--
--    The foreign key to `auth.users` is added conditionally: the auth schema exists on
--    Supabase but not in the PGlite test runtime, and a migration that cannot apply in
--    tests would hide drift. On a real project the constraint exists (verified by the
--    Phase 5 real-PostgreSQL script, which creates the auth schema first).
--
-- 2. PARTICIPANT ASSIGNMENT. Phase 3 writes ONE participant inside the order transaction
--    (the simple flow). An order for N units has N−1 units that need a person before the
--    door. `attach_participant` claims the next (or a named) unassigned ticket under the
--    order and writes the participant plus the append-only consent evidence;
--    `update_participant` edits the participant's own row and appends a NEW consent row
--    for each kind when the value changes (never an UPDATE of history).
--
--    Ownership rule, enforced here and not only in TypeScript: the caller must present the
--    order reference AND the buyer email. A participant id belonging to another order is
--    reported exactly like an unknown one (`found:false`), so the endpoint cannot be used
--    to probe other orders.
--
-- 3. CHECK-IN. `record_check_in` is the single transaction that resolves the opaque token,
--    verifies ticket + order + payment, records attendance atomically
--    (`insert ... on conflict (ticket_id) do nothing`, with the ticket row locked first so
--    simultaneous scans serialize), and returns the operator-facing outcome. The decision
--    precedences mirror the tested domain module `_shared/domain/checkin.ts`:
--    cancelled -> NOT_PAID -> ALREADY_USED -> VALID, unknown token -> NOT_FOUND.
--
--    `attendance.checked_in_by_user_id` links the admission to the authenticated operator
--    (the text column `checked_in_by` keeps the human-readable label). Attendance stays
--    append-only: no UPDATE path exists for it anywhere.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Operators
-- ---------------------------------------------------------------------------
create table public.operators (
  -- Same value as `auth.users.id` on Supabase. No auth FK here (see the header); a
  -- conditional constraint is added at the bottom of this migration when auth exists.
  user_id uuid primary key,
  display_name text not null
    check (length(btrim(display_name)) between 1 and 120 and display_name !~ '[\n\r\t]'),
  role text not null default 'OPERATOR'
    check (role in ('OPERATOR', 'ADMIN')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.operators is
  'Authorization data for the private operator API (check-in). Authentication itself is Supabase Auth; this table maps an auth user id to a role. No password or shared secret is stored here.';

create trigger operators_set_updated_at
  before update on public.operators
  for each row execute function app_private.set_updated_at();

alter table public.operators enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Attendance: link the admission to the authenticated operator
-- ---------------------------------------------------------------------------
alter table public.attendance
  add column checked_in_by_user_id uuid;

comment on column public.attendance.checked_in_by_user_id is
  'Auth user id of the operator who admitted the ticket (Supabase Auth). NULL for manual/legacy rows; the human-readable label stays in checked_in_by.';

-- ---------------------------------------------------------------------------
-- 3. Participant payload validation/normalization (SQL side)
-- ---------------------------------------------------------------------------
-- TypeScript already normalizes with `_shared/domain/participant.ts`; this helper is the
-- second line of defence INSIDE the transaction, so a bug or a future caller cannot write
-- a malformed participant. It raises PT400 (never a raw constraint violation) and returns
-- the normalized payload the caller then stores.
create or replace function app_private.normalize_participant_payload(p_participant jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $normpart$
declare
  v_first text;
  v_last text;
  v_national_id text;
  v_email text;
  v_phone text;
  v_city text;
  v_instagram text;
  v_dp boolean;
  v_fe boolean;
begin
  if p_participant is null or jsonb_typeof(p_participant) <> 'object' then
    raise exception 'Participant payload must be a JSON object'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT';
  end if;

  v_first := btrim(coalesce(p_participant ->> 'firstName', ''));
  v_last := btrim(coalesce(p_participant ->> 'lastName', ''));
  v_national_id := regexp_replace(coalesce(p_participant ->> 'nationalId', ''), '[ .-]', '', 'g');
  v_email := lower(btrim(coalesce(p_participant ->> 'email', '')));
  v_phone := regexp_replace(coalesce(p_participant ->> 'phone', ''), '[^0-9]', '', 'g');
  v_city := regexp_replace(btrim(coalesce(p_participant ->> 'city', '')), '\s+', ' ', 'g');
  -- Mirrors the TypeScript normalizer: a pasted leading `@` is never part of the handle.
  v_instagram := nullif(
    ltrim(lower(btrim(coalesce(p_participant ->> 'instagram', ''))), '@'),
    ''
  );

  if length(v_first) = 0 or length(v_first) > 80 or v_first ~ '[\n\r\t]' then
    raise exception 'Participant first name is missing or invalid'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_FIRST_NAME';
  end if;
  if length(v_last) = 0 or length(v_last) > 80 or v_last ~ '[\n\r\t]' then
    raise exception 'Participant last name is missing or invalid'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_LAST_NAME';
  end if;
  if v_national_id !~ '^[0-9]{6,12}$' then
    raise exception 'Participant national id must be 6 to 12 digits'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_NATIONAL_ID';
  end if;
  if length(v_email) = 0 or length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Participant email is missing or invalid'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_EMAIL';
  end if;
  if v_phone !~ '^[0-9]{7,15}$' then
    raise exception 'Participant phone is missing or invalid'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_PHONE';
  end if;
  if length(v_city) < 2 or length(v_city) > 80 then
    raise exception 'Participant city is missing or invalid'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_CITY';
  end if;
  if v_instagram is not null and v_instagram !~ '^[a-z0-9._]{1,30}$' then
    raise exception 'Participant Instagram handle is invalid'
      using errcode = 'PT400', detail = 'INVALID_PARTICIPANT_INSTAGRAM';
  end if;

  if p_participant -> 'consents' is null
     or jsonb_typeof(p_participant -> 'consents') <> 'object' then
    raise exception 'Participant consents are required'
      using errcode = 'PT400', detail = 'MISSING_CONSENTS';
  end if;
  if (p_participant -> 'consents' ->> 'dataProcessing') not in ('true', 'false') then
    raise exception 'Consent to personal data processing must be true or false'
      using errcode = 'PT400', detail = 'MISSING_CONSENTS';
  end if;
  v_dp := (p_participant -> 'consents' ->> 'dataProcessing')::boolean;
  if not v_dp then
    raise exception 'Consent to personal data processing is required'
      using errcode = 'PT400', detail = 'CONSENT_REQUIRED';
  end if;
  if (p_participant -> 'consents' ->> 'futureEvents') not in ('true', 'false') then
    raise exception 'Future-events consent must be true or false'
      using errcode = 'PT400', detail = 'MISSING_CONSENTS';
  end if;
  v_fe := (p_participant -> 'consents' ->> 'futureEvents')::boolean;

  return jsonb_build_object(
    'firstName', v_first,
    'lastName', v_last,
    'nationalId', v_national_id,
    'email', v_email,
    'phone', v_phone,
    'city', v_city,
    'instagram', v_instagram,
    'consents', jsonb_build_object('dataProcessing', v_dp, 'futureEvents', v_fe)
  );
end;
$normpart$;

comment on function app_private.normalize_participant_payload(jsonb) is
  'Validates and normalizes a participant payload inside the database transaction: digits-only national id/phone, lowercase email, collapsed city, handle without @. Raises PT400 with a stable detail code; returns the normalized payload.';

-- Appends one consent row per kind when the effective value changed (or no row exists yet).
create or replace function app_private.append_participant_consents(
  p_event_id uuid,
  p_participant_id uuid,
  p_consents jsonb,
  p_policy_version text,
  p_now timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $appendconsents$
declare
  v_version text := coalesce(nullif(btrim(coalesce(p_policy_version, '')), ''), 'v1');
  v_kind public.consent_kind;
  v_new boolean;
  v_appended integer := 0;
begin
  for v_kind, v_new in
    select k.kind, coalesce((p_consents ->> k.key)::boolean, false)
      from (values ('DATA_PROCESSING'::public.consent_kind, 'dataProcessing'),
                   ('FUTURE_EVENTS'::public.consent_kind, 'futureEvents')) as k(kind, key)
  loop
    -- History is append-only: a change (or a first record) inserts a new row; an identical
    -- re-statement inserts nothing, so the evidence trail stays meaningful.
    if not exists (
      select 1 from public.consents c
       where c.participant_id = p_participant_id
         and c.kind = v_kind
         and c.granted = v_new
    ) then
      insert into public.consents (event_id, participant_id, kind, granted, policy_version, captured_at)
      values (p_event_id, p_participant_id, v_kind, v_new, v_version, p_now);
      v_appended := v_appended + 1;
    end if;
  end loop;
  return v_appended;
end;
$appendconsents$;

comment on function app_private.append_participant_consents(uuid, uuid, jsonb, text, timestamptz) is
  'Appends a consent row per kind when the effective value differs from the latest record (first record included). Never updates or deletes history; returns how many rows were appended.';

-- ---------------------------------------------------------------------------
-- 4. attach_participant — create a participant and assign it to an order unit
-- ---------------------------------------------------------------------------
-- Post-payment only: tickets exist after confirmation, so assignment happens against
-- real tickets. The order reference + buyer email gate is the same possession rule as the
-- buyer status endpoint.
create or replace function public.attach_participant(
  p_order_reference text,
  p_buyer_email text,
  p_participant jsonb,
  p_ticket_token text default null,
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
  v_payload jsonb;
  v_ticket public.tickets;
  v_participant_id uuid;
  v_appended integer := 0;
  v_remaining integer := 0;
begin
  select * into v_order
    from public.orders
   where reference = btrim(coalesce(p_order_reference, ''))
     and buyer_email = lower(btrim(coalesce(p_buyer_email, '')));
  if v_order.id is null then
    return jsonb_build_object('found', false);
  end if;

  if v_order.status <> 'PAID' then
    raise exception 'Participants can only be attached to a paid order'
      using errcode = 'PT409', detail = 'ORDER_NOT_PAID';
  end if;

  v_payload := app_private.normalize_participant_payload(p_participant);

  if p_ticket_token is not null and length(btrim(p_ticket_token)) > 0 then
    -- A specific unit was requested. It must belong to this order, be unassigned and be
    -- active; anything else is the same stable conflict code.
    select * into v_ticket
      from public.tickets t
     where t.token = upper(btrim(p_ticket_token))
       and t.order_id = v_order.id
       and t.participant_id is null
       and t.status = 'ACTIVE'
     for update;
  else
    -- Next unassigned unit, in ticket order. SKIP LOCKED makes two simultaneous
    -- assignments to the same order take DIFFERENT units instead of colliding.
    select * into v_ticket
      from public.tickets t
     where t.order_id = v_order.id
       and t.participant_id is null
       and t.status = 'ACTIVE'
     order by t.order_item_id, t.order_item_seq
     for update skip locked
     limit 1;
  end if;

  if v_ticket.id is null then
    raise exception 'The order has no unassigned active ticket for this request'
      using errcode = 'PT409', detail = 'TICKET_NOT_ASSIGNABLE';
  end if;

  insert into public.participants (
    event_id, order_id, order_item_id,
    first_name, last_name, national_id, email, phone, city, instagram
  ) values (
    v_ticket.event_id, v_order.id, v_ticket.order_item_id,
    v_payload ->> 'firstName', v_payload ->> 'lastName', v_payload ->> 'nationalId',
    v_payload ->> 'email', v_payload ->> 'phone', v_payload ->> 'city',
    nullif(v_payload ->> 'instagram', '')
  )
  returning id into v_participant_id;

  v_appended := app_private.append_participant_consents(
    v_ticket.event_id, v_participant_id, v_payload -> 'consents', p_policy_version, p_now
  );

  -- The ticket row is locked, so this update cannot lose a race; the extra predicate keeps
  -- the guarantee explicit in the statement itself.
  update public.tickets
     set participant_id = v_participant_id
   where id = v_ticket.id
     and participant_id is null
  returning * into v_ticket;

  if v_ticket.id is null then
    raise exception 'The ticket was assigned by another request'
      using errcode = 'PT409', detail = 'TICKET_NOT_ASSIGNABLE';
  end if;

  -- Counts what a subsequent attach call could actually claim: unassigned AND active
  -- (a cancelled unit is not assignable and must not keep the count above zero).
  select count(*)::integer into v_remaining
    from public.tickets t
   where t.order_id = v_order.id
     and t.participant_id is null
     and t.status = 'ACTIVE';

  return jsonb_build_object(
    'found', true,
    'orderReference', v_order.reference,
    'ticket', jsonb_build_object(
      'token', v_ticket.token,
      'unit', v_ticket.order_item_seq,
      'status', v_ticket.status
    ),
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

comment on function public.attach_participant(text, text, jsonb, text, text, timestamptz) is
  'Creates one participant for a paid order and assigns it to the next (or a named) unassigned active ticket. Reference+email ownership is required; concurrent calls take different units via FOR UPDATE SKIP LOCKED; consent evidence is appended, never overwritten.';

-- ---------------------------------------------------------------------------
-- 5. update_participant — edit a participant that belongs to the order
-- ---------------------------------------------------------------------------
create or replace function public.update_participant(
  p_order_reference text,
  p_buyer_email text,
  p_participant_id uuid,
  p_participant jsonb,
  p_policy_version text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $updatepart$
declare
  v_order public.orders;
  v_participant public.participants;
  v_payload jsonb;
  v_appended integer := 0;
begin
  select * into v_order
    from public.orders
   where reference = btrim(coalesce(p_order_reference, ''))
     and buyer_email = lower(btrim(coalesce(p_buyer_email, '')));
  if v_order.id is null then
    return jsonb_build_object('found', false);
  end if;

  -- Ownership is part of the lookup: a participant from another order is reported exactly
  -- like an unknown id.
  select * into v_participant
    from public.participants p
   where p.id = p_participant_id
     and p.order_id = v_order.id
   for update;
  if v_participant.id is null then
    return jsonb_build_object('found', false);
  end if;

  v_payload := app_private.normalize_participant_payload(p_participant);

  update public.participants
     set first_name = v_payload ->> 'firstName',
         last_name = v_payload ->> 'lastName',
         national_id = v_payload ->> 'nationalId',
         email = v_payload ->> 'email',
         phone = v_payload ->> 'phone',
         city = v_payload ->> 'city',
         instagram = nullif(v_payload ->> 'instagram', '')
   where id = v_participant.id
  returning * into v_participant;

  v_appended := app_private.append_participant_consents(
    v_participant.event_id, v_participant.id, v_payload -> 'consents', p_policy_version, p_now
  );

  return jsonb_build_object(
    'found', true,
    'participantId', v_participant.id,
    'firstName', v_participant.first_name,
    'lastName', v_participant.last_name,
    'consents', jsonb_build_object(
      'dataProcessing', (v_payload -> 'consents' ->> 'dataProcessing')::boolean,
      'futureEvents', (v_payload -> 'consents' ->> 'futureEvents')::boolean,
      'policyVersion', coalesce(nullif(btrim(coalesce(p_policy_version, '')), ''), 'v1'),
      'capturedAt', app_private.iso_utc(p_now)
    ),
    'consentsAppended', v_appended
  );
end;
$updatepart$;

comment on function public.update_participant(text, text, uuid, jsonb, text, timestamptz) is
  'Updates a participant that belongs to the buyer''s order and appends consent evidence for any changed value. Never mutates consent history; a participant id from another order returns found:false.';

-- ---------------------------------------------------------------------------
-- 6. record_check_in — the atomic check-in operation
-- ---------------------------------------------------------------------------
create or replace function public.record_check_in(
  p_ticket_token text,
  p_operator_label text,
  p_operator_user_id uuid default null,
  p_method text default 'QR_SCAN',
  p_notes text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $checkin$
declare
  v_token text;
  v_ticket public.tickets;
  v_order public.orders;
  v_attendance public.attendance;
  v_payment_approved boolean := false;
  v_checked_in_at timestamptz;
  v_display_name text;
begin
  v_token := upper(btrim(coalesce(p_ticket_token, '')));
  if p_operator_label is null or length(btrim(p_operator_label)) = 0 then
    raise exception 'Operator label is required for a check-in'
      using errcode = 'PT400', detail = 'MISSING_OPERATOR';
  end if;
  if p_method is null or p_method not in ('QR_SCAN', 'MANUAL') then
    raise exception 'Check-in method must be QR_SCAN or MANUAL'
      using errcode = 'PT400', detail = 'INVALID_METHOD';
  end if;

  -- Lock the ticket for the whole decision. This serializes simultaneous scans of the
  -- same ticket, so the ALREADY_USED answer below is read after the winner committed —
  -- and the unique constraint on attendance.ticket_id remains the second line of defence.
  select * into v_ticket
    from public.tickets t
   where t.token = v_token
   for update;

  if v_ticket.id is null then
    return jsonb_build_object('outcome', 'NOT_FOUND');
  end if;

  select * into v_order from public.orders where id = v_ticket.order_id;
  select exists(
    select 1 from public.payments p
     where p.order_id = v_ticket.order_id
       and p.status = 'approved'::public.payment_status
  ) into v_payment_approved;
  select * into v_attendance from public.attendance a where a.ticket_id = v_ticket.id;

  -- Precedence mirrors domain/checkin.ts: cancelled, then unpaid, then used, else valid.
  if v_ticket.status <> 'ACTIVE'::public.ticket_status then
    return jsonb_build_object(
      'outcome', 'CANCELLED',
      'reason', 'TICKET_' || v_ticket.status::text,
      'ticketCode', v_ticket.token
    );
  end if;

  if v_order.status <> 'PAID' or not v_payment_approved then
    return jsonb_build_object(
      'outcome', 'NOT_PAID',
      'reason', case when v_order.status <> 'PAID'
                     then 'ORDER_' || v_order.status::text
                     else 'PAYMENT_NOT_APPROVED' end,
      'ticketCode', v_ticket.token
    );
  end if;

  if v_attendance.id is not null then
    return jsonb_build_object(
      'outcome', 'ALREADY_USED',
      'reason', 'ATTENDANCE_EXISTS',
      'ticketCode', v_ticket.token,
      'checkedInAt', app_private.iso_utc(v_attendance.checked_in_at)
    );
  end if;

  insert into public.attendance (
    ticket_id, event_id, checked_in_at, checked_in_by, checked_in_by_user_id, method, notes
  ) values (
    v_ticket.id, v_ticket.event_id, p_now, btrim(p_operator_label),
    p_operator_user_id, p_method, nullif(btrim(coalesce(p_notes, '')), '')
  )
  on conflict (ticket_id) do nothing
  returning checked_in_at into v_checked_in_at;

  if v_checked_in_at is null then
    -- Defensive: the ticket row lock should already prevent this; if it ever happens the
    -- answer is the same ALREADY_USED the operator would get a moment later.
    select a.checked_in_at into v_checked_in_at
      from public.attendance a where a.ticket_id = v_ticket.id;
    return jsonb_build_object(
      'outcome', 'ALREADY_USED',
      'reason', 'ATTENDANCE_EXISTS',
      'ticketCode', v_ticket.token,
      'checkedInAt', app_private.iso_utc(v_checked_in_at)
    );
  end if;

  select nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    into v_display_name
    from public.participants p
   where p.id = v_ticket.participant_id;

  return jsonb_build_object(
    'outcome', 'VALID',
    'reason', 'OK',
    'ticketCode', v_ticket.token,
    'checkedInAt', app_private.iso_utc(v_checked_in_at),
    'participantName', v_display_name
  );
end;
$checkin$;

comment on function public.record_check_in(text, text, uuid, text, text, timestamptz) is
  'The atomic check-in: resolves the token, verifies ticket/order/payment state, and records attendance exactly once (ticket row lock + unique attendance.ticket_id). Outcomes: VALID, ALREADY_USED, NOT_PAID, CANCELLED, NOT_FOUND. The first valid scan wins.';

-- ---------------------------------------------------------------------------
-- 7. Public-safe and operator ticket lookups
-- ---------------------------------------------------------------------------
-- Public-safe: event, ticket code, participant display name and ticket status. The token
-- itself is the capability the holder already has. Cédula, email, phone, order internals
-- and consent history are NOT reachable through this projection.
create or replace function public.get_public_ticket(p_ticket_token text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $pubticket$
declare
  v_token text;
  v_ticket public.tickets;
  v_participant public.participants;
  v_event public.events;
begin
  v_token := upper(btrim(coalesce(p_ticket_token, '')));
  if v_token !~ '^TKT_[0-9A-HJKMNP-TV-Z]{20}$' then
    return jsonb_build_object('found', false);
  end if;

  select * into v_ticket from public.tickets where token = v_token;
  if v_ticket.id is null then
    return jsonb_build_object('found', false);
  end if;

  select * into v_event from public.events where id = v_ticket.event_id;
  select * into v_participant from public.participants where id = v_ticket.participant_id;

  return jsonb_build_object(
    'found', true,
    'ticket', jsonb_build_object(
      'code', v_ticket.token,
      'status', v_ticket.status,
      'displayName', case when v_participant.id is null then null
                          else v_participant.first_name || ' ' || left(v_participant.last_name, 1) || '.'
                     end
    ),
    'event', jsonb_build_object(
      'code', v_event.code,
      'name', v_event.name,
      'startsAt', app_private.iso_utc(v_event.starts_at),
      'endsAt', app_private.iso_utc(v_event.ends_at),
      'timezone', v_event.timezone,
      'city', v_event.city,
      'venueName', v_event.venue_name,
      'venueAddress', v_event.venue_address
    )
  );
end;
$pubticket$;

comment on function public.get_public_ticket(text) is
  'Public-safe ticket view for the holder: event, ticket code, display name (first name + last initial) and ticket status. Never returns cédula, email, phone, order internals or consent history.';

-- Operator view: what the door needs to verify identity and admission, plus attendance
-- state. Still no email/phone/order internals/consent history — those are not needed to
-- admit a person.
create or replace function public.get_operator_ticket(p_ticket_token text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $opticket$
declare
  v_token text;
  v_ticket public.tickets;
  v_participant public.participants;
  v_event public.events;
  v_order public.orders;
  v_attendance public.attendance;
  v_payment_status public.payment_status;
  v_ticket_type_name text;
begin
  v_token := upper(btrim(coalesce(p_ticket_token, '')));
  if v_token !~ '^TKT_[0-9A-HJKMNP-TV-Z]{20}$' then
    return jsonb_build_object('found', false);
  end if;

  select * into v_ticket from public.tickets where token = v_token;
  if v_ticket.id is null then
    return jsonb_build_object('found', false);
  end if;

  select * into v_event from public.events where id = v_ticket.event_id;
  select * into v_participant from public.participants where id = v_ticket.participant_id;
  select * into v_order from public.orders where id = v_ticket.order_id;
  select * into v_attendance from public.attendance where ticket_id = v_ticket.id;
  select tt.name into v_ticket_type_name from public.ticket_types tt where tt.id = v_ticket.ticket_type_id;

  -- The most meaningful attempt: approved when it exists, otherwise the latest one.
  select p.status into v_payment_status
    from public.payments p
   where p.order_id = v_ticket.order_id
   order by (p.status = 'approved') desc, p.attempt desc
   limit 1;

  return jsonb_build_object(
    'found', true,
    'ticket', jsonb_build_object(
      'code', v_ticket.token,
      'status', v_ticket.status,
      'ticketType', v_ticket_type_name,
      'pricePaidCents', v_ticket.price_paid_cents,
      'unit', v_ticket.order_item_seq
    ),
    'event', jsonb_build_object(
      'code', v_event.code,
      'name', v_event.name,
      'startsAt', app_private.iso_utc(v_event.starts_at),
      'timezone', v_event.timezone,
      'city', v_event.city,
      'venueName', v_event.venue_name
    ),
    'participant', case when v_participant.id is null then null else jsonb_build_object(
      'firstName', v_participant.first_name,
      'lastName', v_participant.last_name,
      'nationalId', v_participant.national_id,
      'city', v_participant.city
    ) end,
    'admission', jsonb_build_object(
      'orderStatus', v_order.status,
      'paymentStatus', coalesce(v_payment_status::text, 'none'),
      'checkedIn', v_attendance.id is not null,
      'checkedInAt', app_private.iso_utc(v_attendance.checked_in_at),
      'checkedInBy', v_attendance.checked_in_by
    )
  );
end;
$opticket$;

comment on function public.get_operator_ticket(text) is
  'Operator admission view: ticket + event + participant name/cédula/city + order/payment/attendance state. Requires operator authentication at the API layer; never exposes email, phone, order internals, consent history or the Wompi payloads.';

-- ---------------------------------------------------------------------------
-- 8. Conditional auth.users foreign key (Supabase only)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'auth' and table_name = 'users'
  ) then
    execute 'alter table public.operators
               add constraint operators_user_id_fkey
               foreign key (user_id) references auth.users (id) on delete cascade';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants: service_role only
-- ---------------------------------------------------------------------------
revoke all on function public.attach_participant(text, text, jsonb, text, text, timestamptz) from public;
revoke all on function public.update_participant(text, text, uuid, jsonb, text, timestamptz) from public;
revoke all on function public.record_check_in(text, text, uuid, text, text, timestamptz) from public;
revoke all on function public.get_public_ticket(text) from public;
revoke all on function public.get_operator_ticket(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.attach_participant(text, text, jsonb, text, text, timestamptz) to service_role';
    execute 'grant execute on function public.update_participant(text, text, uuid, jsonb, text, timestamptz) to service_role';
    execute 'grant execute on function public.record_check_in(text, text, uuid, text, text, timestamptz) to service_role';
    execute 'grant execute on function public.get_public_ticket(text) to service_role';
    execute 'grant execute on function public.get_operator_ticket(text) to service_role';
  end if;
end
$$;
