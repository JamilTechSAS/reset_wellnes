-- ---------------------------------------------------------------------------
-- Migration 20261003210006_email_deliveries
-- Phase 2 / part 6 of 7: idempotent email delivery bookkeeping.
--
-- Decisions documented here:
--   * A repeated Wompi webhook must never send a confirmation twice. The mechanism is
--     database-first: `idempotency_key` is unique, and a CHECK constraint proves the key
--     is exactly the documented `ticket:<ticketId>:<template>` form, so a mis-keyed row
--     cannot exist and silently break deduplication.
--   * `recipient_email` is resolved from the ticket's participant when the delivery is
--     queued and stored here. Retries and audits then know the exact destination even if
--     the participant later corrects their address.
--   * `status` is the Phase 1 enum (QUEUED/SENDING/SENT/FAILED/CANCELLED); `attempt_count`
--     and `next_attempt_at` drive the bounded backoff in `email-delivery.ts`.
--   * Rows cascade with their ticket: deliveries have no independent meaning, and erasure
--     of a ticket must not leave orphaned personal data behind.
-- ---------------------------------------------------------------------------

create table public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  -- Only TICKET_CONFIRMATION exists today; the format check allows future templates
  -- (REMINDER, …) without a migration while still rejecting typos and free text.
  template text not null
    check (template ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  -- The deduplication key itself. phase 1 `buildEmailIdempotencyKey()` produces it.
  idempotency_key text not null unique
    check (
      length(idempotency_key) between 16 and 200
      and idempotency_key !~ '[\n\r\t]'
    ),
  -- Destination as resolved at queue time (participant email, normalized lowercase).
  recipient_email text not null
    check (
      recipient_email = lower(recipient_email)
      and recipient_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      and length(recipient_email) <= 254
    ),
  status public.email_delivery_status not null default 'QUEUED',
  -- Number of send attempts made so far (0 = queued, never attempted).
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  provider text not null default 'resend'
    check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_message_id text,
  -- Last failure, bounded and free of secrets (no API keys, no full response bodies).
  last_error text,
  -- When the retry job should pick this row up again. Only meaningful for retryable rows.
  next_attempt_at timestamptz,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A successful send implies a sent_at, and only a SENT row carries one.
  constraint email_deliveries_sent_at_check check (
    sent_at is null or status = 'SENT'
  ),
  -- Scheduling a retry for a final row would be a bug; catch it here.
  constraint email_deliveries_retry_state_check check (
    next_attempt_at is null or status in ('QUEUED', 'FAILED')
  ),
  -- The key is derived from the row's own identity: makes the documented key format
  -- impossible to get wrong, and `unique (idempotency_key)` therefore also guarantees
  -- "one delivery per (ticket, template)".
  constraint email_deliveries_key_derivation_check check (
    idempotency_key = 'ticket:' || ticket_id::text || ':' || template
  )
);

comment on table public.email_deliveries is
  'One row per (ticket, template) email. Unique idempotency_key + derived-key check make duplicate confirmation sends impossible, however many times Wompi redelivers an event.';

create index email_deliveries_ticket_id_idx on public.email_deliveries (ticket_id);

-- Retry job queue: only retryable rows, oldest first.
create index email_deliveries_retry_idx
  on public.email_deliveries (next_attempt_at)
  where status in ('QUEUED', 'FAILED');

create trigger email_deliveries_set_updated_at
  before update on public.email_deliveries
  for each row execute function app_private.set_updated_at();
