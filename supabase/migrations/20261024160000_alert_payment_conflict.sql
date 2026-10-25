-- ---------------------------------------------------------------------------
-- Migration 20261024160000_alert_payment_conflict
-- H8 follow-up: an authenticated approval that `confirm_payment` refuses is not silent.
--
-- The 2026-10-24 staging audit found two captures that never reached an order:
--
--   * EVT-2026-000007 — ePayco's approval arrived while the validation API was down; the
--     webhook answered 503 before claiming the event, ePayco stopped retrying, and the
--     confirmation left no ledger row at all.
--   * EVT-2026-000009 — a second ePayco transaction (`390996469`) was created under the same
--     merchant reference as an already recorded decline (`390996271`). `confirm_payment`
--     refused the approval with PT409 REFERENCE_MISMATCH → CONFLICT, the webhook answered 200
--     so ePayco would not loop, and NO alert was recorded: `operational_alerts` stayed empty.
--
-- This adds the one alert kind that path needs. `PAYMENT_CONFLICT` is CRITICAL because money
-- moved at the provider and no order, admission or inventory change exists to explain it:
-- a human has to reconcile the transaction against the order. It is deliberately separate
-- from `LATE_APPROVAL` (an approval that `confirm_payment` DID apply to a non-payable order)
-- and from `PROVIDER_RECORD_MISMATCH` (a delivery that contradicts the provider's own record),
-- so the digest says which situation it is and the dedupe keys never collide.
--
-- Nothing else changes: `record_operational_alert` already stores any kind the constraint
-- allows, and the digest labels come from the function's own vocabulary.
-- ---------------------------------------------------------------------------

alter table public.operational_alerts
  drop constraint if exists operational_alerts_kind_check;

alter table public.operational_alerts
  add constraint operational_alerts_kind_check
  check (kind in (
    'PAYMENT_REVERSED_AFTER_APPROVAL',
    'LATE_APPROVAL',
    'PAYMENT_CONFLICT',
    'PROVIDER_RECORD_MISMATCH',
    'RECONCILIATION_MISMATCH',
    'PROVIDER_NOT_FOUND',
    'REPEATED_PROVIDER_FAILURE',
    'UNRESOLVED_PAYMENT'
  ));

comment on constraint operational_alerts_kind_check on public.operational_alerts is
  'Closed alert vocabulary. PAYMENT_CONFLICT (critical) marks an authenticated approval that could not be applied to its order, e.g. a second transaction under one merchant reference.';
