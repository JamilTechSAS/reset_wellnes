-- ---------------------------------------------------------------------------
-- Migration 20261003210005_attendance_consents
-- Phase 2 / part 5 of 7: the door and the legal evidence.
--
-- Decisions documented here:
--   * attendance.ticket_id is UNIQUE. This is the atomicity guarantee for check-in: the
--     first valid scan inserts the row, every later (or simultaneous) scan hits the
--     constraint and reports ALREADY_USED. No application lock is required.
--   * Attendance rows are inserted once and never updated by the design; that is why the
--     table has no updated_at column. `checked_in_by` is mandatory so every admission has
--     an accountable operator behind it.
--   * consents is append-only: a withdrawal is a new row with granted = false, never an
--     update. The latest row per (participant_id, kind) is the effective decision, and the
--     earlier evidence stays intact (Ley 1581 de 2012).
--   * `app_private.reject_update()` turns that convention into a database guarantee for the
--     two evidence ledgers (consents, discount_redemptions). Deletes are still possible:
--     cascade erasure of a participant must remain implementable.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- attendance (check-in)
-- ---------------------------------------------------------------------------
create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null unique references public.tickets (id) on delete restrict,
  event_id uuid not null references public.events (id) on delete restrict,
  checked_in_at timestamptz not null default now(),
  -- Operator identifier (name/handle of the person at the door) or device label.
  checked_in_by text not null
    check (length(btrim(checked_in_by)) between 1 and 120 and checked_in_by !~ '[\n\r\t]'),
  -- QR_SCAN and MANUAL are the only paths to admission; manual entries must explain
  -- themselves in `notes` (company rule, not a database constraint).
  method text not null default 'QR_SCAN'
    check (method in ('QR_SCAN', 'MANUAL')),
  notes text,
  created_at timestamptz not null default now()
);

comment on table public.attendance is
  'One row per admitted ticket. unique (ticket_id) is the double-check-in protection; the row is the only proof of use.';

create index attendance_event_id_idx on public.attendance (event_id);

-- ---------------------------------------------------------------------------
-- consents
-- ---------------------------------------------------------------------------
-- Kept identical to the Phase 1 domain enum (`consents.ts`): the brief's
-- PERSONAL_DATA_PROCESSING / FUTURE_EVENT_COMMUNICATIONS names were resolved in favor of
-- the established DATA_PROCESSING / FUTURE_EVENTS. The mapping is documented in
-- docs/data-model.md.
create type public.consent_kind as enum ('DATA_PROCESSING', 'FUTURE_EVENTS');

comment on type public.consent_kind is
  'Consent types: DATA_PROCESSING (mandatory to purchase, Ley 1581 de 2012) and FUTURE_EVENTS (optional marketing consent).';

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete restrict,
  participant_id uuid not null references public.participants (id) on delete cascade,
  kind public.consent_kind not null,
  granted boolean not null,
  -- Version of the wording shown to the buyer; each record points at the text that was
  -- accepted. Bump it whenever the wording changes (docs/data-model.md section 6.9).
  policy_version text not null
    check (length(btrim(policy_version)) between 1 and 64 and policy_version !~ '[\n\r\t]'),
  -- Optional SHA-256 of the exact text shown, when the client wants byte-level evidence.
  policy_text_hash text
    check (policy_text_hash is null or policy_text_hash ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null default now(),
  -- Recorded for the legal evidence trail; never logged, never exported.
  ip_address inet,
  created_at timestamptz not null default now()
);

comment on table public.consents is
  'Append-only consent history: value, kind, timestamp, policy version and optional text hash. Withdrawal is a new granted = false row; the latest row per (participant, kind) is effective.';

-- Effective-decision lookup: latest row per participant and kind.
create index consents_participant_kind_idx
  on public.consents (participant_id, kind, captured_at desc);
create index consents_event_id_idx on public.consents (event_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement for evidence ledgers
-- ---------------------------------------------------------------------------
create or replace function app_private.reject_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'append-only table %: update is not allowed, insert a new row instead',
    tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

comment on function app_private.reject_update() is
  'BEFORE UPDATE trigger that makes append-only tables truly append-only. Withdrawals/amendments are recorded as new rows.';

create trigger consents_reject_update
  before update on public.consents
  for each row execute function app_private.reject_update();

-- The discount usage ledger (created in the orders migration) is append-only for the same
-- reason: a redemption is an accounting fact, not an editable value.
create trigger discount_redemptions_reject_update
  before update on public.discount_redemptions
  for each row execute function app_private.reject_update();
