-- ---------------------------------------------------------------------------
-- Migration 20261003210004_payments
-- Phase 2 / part 4 of 7: payment attempts and the webhook event ledger.
--
-- Decisions documented here:
--   * Money is bigint centavos (`amount_cents`), 1:1 with Wompi's `amount_in_cents`.
--     No numeric, no float.
--   * One order -> many attempts (a declined reference can never be reused by Wompi).
--     `unique (order_id, attempt)` plus a unique `wompi_reference` per attempt.
--   * Exactly one attempt may be `approved` per order, enforced by a partial unique index
--     so even a programming error cannot produce two approvals.
--   * `status` is the internal normalized status (`payment_status` from Phase 1) and
--     `raw_wompi_status` keeps exactly what Wompi sent; both are always persisted.
--   * `provider_payload` is the raw Wompi body (nullable). It may contain the customer's
--     email; it is never returned by any endpoint, never logged, and it is subject to the
--     retention policy in docs/data-model.md section 5.
--   * payment_events is the webhook ledger and the idempotency gate: a duplicated delivery
--     collides on `dedupe_key` and can never be processed twice. `result` is nullable on
--     purpose — a row with NULL result and NULL processed_at is an event that was received
--     but never finished processing, which is exactly the forensic case operators need.
-- ---------------------------------------------------------------------------

create type public.payment_event_result as enum ('APPLIED', 'DUPLICATE', 'REJECTED', 'IGNORED');

comment on type public.payment_event_result is
  'Outcome of one webhook event: APPLIED (state changed), DUPLICATE (already reflected), REJECTED (bad checksum/unresolvable), IGNORED (not relevant to this system).';

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  -- 1-based attempt number; attempt 1 uses the order reference verbatim, later attempts
  -- append `-<attempt>` (docs/wompi-integration.md section 6).
  attempt integer not null
    check (attempt >= 1),
  wompi_reference text not null unique
    check (
      wompi_reference ~ '^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]+)?$'
      and length(wompi_reference) <= 255
    ),
  -- Wompi assigns the transaction id; NULL until the transaction exists on their side.
  wompi_transaction_id text unique
    check (
      wompi_transaction_id is null
      or (length(btrim(wompi_transaction_id)) between 1 and 128 and wompi_transaction_id !~ '[\n\r\t]')
    ),
  status public.payment_status not null default 'pending',
  -- Exactly what Wompi sent (PENDING / APPROVED / DECLINED / VOIDED / ERROR / anything new).
  raw_wompi_status text,
  amount_cents bigint not null
    check (amount_cents >= 0),
  currency text not null default 'COP'
    check (currency = 'COP'),
  payment_method_type text,
  -- Provider message for the operator (never the raw response body).
  status_message text,
  -- The signature we sent when creating the transaction, kept for reconciliation.
  integrity_signature text,
  provider_payload jsonb
    check (provider_payload is null or jsonb_typeof(provider_payload) = 'object'),
  -- Set when the attempt was approved. It survives a later VOIDED (refund): the approval
  -- is a historical fact, so this is NOT tied to `status = 'approved'`.
  approved_at timestamptz,
  -- Set when the attempt reaches a final state (approved/declined/voided/error/unknown).
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_order_attempt_unique unique (order_id, attempt),
  -- An attempt that was never approved cannot carry an approval timestamp. approved and
  -- voided are the only statuses reachable after an approval (Wompi never un-approves).
  constraint payments_approved_at_check check (
    approved_at is null or status in ('approved', 'voided')
  ),
  -- A pending attempt is not finalized; unknown is a fetched-but-unresolved state.
  constraint payments_finalized_at_check check (
    finalized_at is null or status <> 'pending'
  )
);

comment on table public.payments is
  'One row per payment attempt against an order. Reconciles with Wompi through reference + transaction id; provider_payload contains personal data and is never exposed through public surfaces.';

create unique index payments_one_approved_per_order_idx
  on public.payments (order_id)
  where status = 'approved';

comment on index public.payments_one_approved_per_order_idx is
  'At most one approved payment per order (partial unique index). The last line of defence against double approvals.';

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function app_private.set_updated_at();

-- ---------------------------------------------------------------------------
-- payment_events (webhook log + idempotency gate)
-- ---------------------------------------------------------------------------
create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  -- Identity of the delivered event (currently SHA-256 over the signed properties + the
  -- event timestamp, see docs/wompi-integration.md). Print-proof ASCII, hash-like length;
  -- the exact algorithm is a backend concern, the uniqueness is a database guarantee.
  dedupe_key text not null unique
    check (dedupe_key ~ '^[!-~]{16,200}$'),
  wompi_event_name text not null
    check (length(btrim(wompi_event_name)) between 1 and 120 and wompi_event_name !~ '[\n\r\t]'),
  wompi_transaction_id text,
  -- Nullable: an event may arrive before (or without) its payment row being resolvable.
  payment_id uuid references public.payments (id) on delete set null,
  checksum_valid boolean not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  -- NULL = received but processing never completed. Never defaulted: "we do not know" is
  -- a meaningful state for incident review.
  result public.payment_event_result,
  error_code text,
  http_status integer
    check (http_status is null or http_status between 100 and 599),
  created_at timestamptz not null default now()
);

comment on table public.payment_events is
  'Append-mostly webhook ledger: one row per delivered event identity. The unique dedupe_key is what makes replayed deliveries impossible to process twice, even under simultaneous requests.';

create index payment_events_payment_id_idx on public.payment_events (payment_id);
create index payment_events_transaction_id_idx on public.payment_events (wompi_transaction_id);
