-- ---------------------------------------------------------------------------
-- Migration 20261003202242_domain_status_enums
--
-- Status values shared by the database and the backend. They mirror the TypeScript
-- state machines one-to-one:
--
--   order_status          <-> supabase/functions/_shared/domain/order-state.ts
--   payment_status        <-> supabase/functions/_shared/domain/payment-status.ts
--   ticket_status         <-> supabase/functions/_shared/domain/tickets.ts
--   email_delivery_status <-> supabase/functions/_shared/domain/email-delivery.ts
--
-- `tests/schema/enum-parity.test.ts` parses this file and fails the build if the two
-- representations ever drift. Adding a new status therefore requires touching both, and
-- `alter type ... add value` must be used in a NEW migration (never by editing this one
-- after it has been applied to any environment).
--
-- Phase 2 uses these types for the domain tables; no table is created here.
-- ---------------------------------------------------------------------------

-- Purchase lifecycle. See docs/data-model.md for the transition table.
create type public.order_status as enum ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED');

comment on type public.order_status is
  'Order lifecycle: PENDING -> PAID | FAILED | CANCELLED | EXPIRED. FAILED and EXPIRED may return to PENDING for a new purchase attempt.';

-- Normalized payment state. The raw Wompi status is always stored alongside it in
-- `payments.raw_wompi_status`, because Wompi may add statuses we do not know yet.
create type public.payment_status as enum ('pending', 'approved', 'declined', 'voided', 'error', 'unknown');

comment on type public.payment_status is
  'Normalized payment status mapped from Wompi transaction statuses (PENDING, APPROVED, DECLINED, VOIDED, ERROR). Unknown inputs map to `unknown` and are never treated as successful.';

-- Ticket lifecycle. `ACTIVE` is the only status that admits entry.
create type public.ticket_status as enum ('ACTIVE', 'CANCELLED', 'REFUNDED');

comment on type public.ticket_status is
  'Ticket lifecycle. Only ACTIVE tickets can be checked in; attendance is recorded separately in `attendance`.';

-- Email delivery bookkeeping (Resend). Unique idempotency key prevents repeated sends.
create type public.email_delivery_status as enum ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

comment on type public.email_delivery_status is
  'Email delivery attempts. SENT and CANCELLED are final; QUEUED and FAILED are retryable with bounded backoff.';
