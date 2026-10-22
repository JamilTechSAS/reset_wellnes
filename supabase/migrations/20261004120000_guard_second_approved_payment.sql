-- ---------------------------------------------------------------------------
-- Migration 20261004120000_guard_second_approved_payment
-- Pre-audit hardening: a typed guard for the one-approved-payment-per-order rule.
--
-- `payments_one_approved_per_order_idx` (migration 20261003210004) is the actual
-- guarantee: at most one `approved` payment per order. It stays the last line of
-- defence. What it cannot do is FAIL CLEANLY: a second approval aborts the whole
-- `confirm_payment` transaction with SQLSTATE 23505, which the API layer maps to
-- INTERNAL_ERROR. On the webhook path that becomes a 503 ("please retry"), and the
-- retry fails the same way forever while the ledger row is never finalized — the
-- payment at Wompi was approved and no operator-visible outcome is recorded.
--
-- Reachable case (verified on PostgreSQL 17 and PGlite):
--   1. attempt 1 is APPROVED at Wompi but its webhook never arrives;
--   2. the reservation window passes, the order expires, the buyer retries;
--   3. attempt 2 is paid and approved (order PAID, tickets issued);
--   4. attempt 1's webhook is delivered late (Wompi retries for 24 h) and tries to
--      approve a second attempt for the same order.
--
-- The trigger converts that specific transition into the same stable error contract
-- every other business refusal uses: SQLSTATE PT409 + detail DOUBLE_PAYMENT_CONFLICT.
-- The API layer then answers 409 CONFLICT, the webhook records the delivery as
-- REJECTED with `reviewRequired` and answers 200, and an operator sees a durable,
-- explainable event instead of a retry loop. No state changes: the order is already
-- PAID, the extra payment stays pending and visible for manual reconciliation.
--
-- Deliberately a guard, not a replacement: a replay on the SAME approved row
-- (`old.status = 'approved'`) is untouched, and a first approval on an order with no
-- approved payment is untouched, so no legitimate path is affected.
--
-- Concurrency (verified on PostgreSQL 17, two overlapping sessions): the existence
-- check alone was not enough. Two approvals of the same order that both read before
-- either committed let the loser abort on the raw index violation (`23505`, the
-- original defect). The guard now takes a transaction-scoped advisory lock keyed by
-- the order for the duration of a real approval transition, so the second transaction
-- re-checks after the first commits and fails with the typed `PT409`.
-- ---------------------------------------------------------------------------

create or replace function app_private.guard_single_approved_payment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $guard$
begin
  -- Only a transition INTO `approved` is suspicious. `tg_op = 'INSERT'` covers the
  -- recovery path that creates the attempt row inside `confirm_payment`; on UPDATE,
  -- an already-approved row re-written as approved is a harmless replay.
  if new.status = 'approved'::public.payment_status
     and (tg_op = 'INSERT' or old.status is distinct from 'approved'::public.payment_status) then
    -- Serialize approvals of the SAME order. Without this, two concurrent approvals can
    -- both run the existence check before either commits, and the loser gets the raw
    -- `23505` of `payments_one_approved_per_order_idx` — the very failure this migration
    -- exists to remove (reproduced on PostgreSQL 17 with two overlapping sessions).
    -- Transaction-scoped, keyed only by the order, taken by no other code path, and only
    -- on a real approval transition, so replays and other orders never wait for it.
    perform pg_advisory_xact_lock(
      hashtextextended('payment_approval:' || new.order_id::text, 0)
    );
    if exists (
      select 1
        from public.payments p
       where p.order_id = new.order_id
         and p.id <> new.id
         and p.status = 'approved'::public.payment_status
    ) then
      raise exception 'Order already has an approved payment'
        using errcode = 'PT409', detail = 'DOUBLE_PAYMENT_CONFLICT';
    end if;
  end if;
  return new;
end;
$guard$;

comment on function app_private.guard_single_approved_payment() is
  'BEFORE INSERT OR UPDATE trigger on payments: turns a second approval for one order into PT409 DOUBLE_PAYMENT_CONFLICT instead of a raw unique-violation (23505), so the webhook path records a durable REJECTED event for an operator instead of a 503 retry loop.';

create trigger payments_guard_single_approved_payment
  before insert or update on public.payments
  for each row execute function app_private.guard_single_approved_payment();

-- Trigger functions need no EXECUTE grant, but the default PUBLIC grant is removed for
-- the same reason every other app_private helper has it removed: nothing outside the
-- backend should be able to call it.
revoke all on function app_private.guard_single_approved_payment() from public;
