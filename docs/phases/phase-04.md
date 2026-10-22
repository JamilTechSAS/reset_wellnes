# Phase 4 report — payment confirmation pipeline

Date: 2026-10-03 · Scope: **Phase 4 only** (backend/database; no frontend, no invented business
values, no changes to the Phase 1–3 foundation beyond what this phase required).

## 1. Objective and outcome

**Objective:** a verified Wompi payment must end in a single, consistent, reconcilable order
state with exactly-once ticket issuance and idempotent confirmation delivery. The browser,
the redirect URL and the webhook body are never trusted for amount, status or success.

**Outcome: complete.** Two migrations implement the confirmation pipeline in SQL; a portable
TypeScript layer orchestrates it; three new Edge Functions expose it
(`webhooks-wompi`, `orders-maintenance` and the extended `orders`). `npm run check` is green
with **288 tests** (212 from Phases 1–3 still passing, plus 76 new/updated); every claim below
was executed in this environment against PGlite on every run and against **real PostgreSQL 17**
for the concurrency races.

The central design decision: **the webhook body is only a pointer.** It says which transaction
to read; the authoritative status comes from `GET /v1/transactions/{id}` with the private key,
is validated against our own order row (reference, amount, currency), and is applied by one SQL
function that locks the order, transitions the payment forward-only, moves the inventory from
reserved to sold, issues exactly one ticket per purchased unit and resolves duplicates by
construction. Everything a duplicate delivery could change is keyed to something unique, so a
replay is a no-op rather than a risk.

## 2. Wompi documentation re-verified (2026-10-03)

Re-read from the official docs before implementing (not from memory). The current event
documentation differs from the Phase 1 notes in ways that would have broken a naive parser:

| Topic                | What was confirmed now                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event envelope       | The current docs put `timestamp` and `environment` at the **top level**; older examples nest them. The parser accepts both and **rejects a payload where both disagree** (`AMBIGUOUS_TIMESTAMP`) instead of picking one silently                                      |
| Event checksum       | `SHA256(concat(signature.properties values) + signature.timestamp + events_secret)`; `properties` varies per event and must be read from the payload. `signature.checksum` **may be absent** — the value is mirrored in `X-Event-Checksum`, either source is accepted |
| Retry behaviour      | A non-200 response is retried after 30 minutes, 3 hours and 24 hours (three attempts). Duplicates are therefore expected, not exceptional                                                                                                                             |
| Transaction lookup   | `GET /v1/transactions/{id}`; **private key only** (`prv_test_*` / `prv_prod_*`), `404` with a public key. The redirect URL is informational                                                                                                                           |
| Transaction statuses | `PENDING`, `APPROVED`, `DECLINED`, `VOIDED`, `ERROR`. Any other string is stored raw as `unknown`, is non-terminal and can never mark an order paid                                                                                                                   |
| References           | A used reference can never be reused → every retry needs a fresh reference while staying traceable (`EVT-2026-000002-2`)                                                                                                                                              |
| Integrity signature  | `SHA256(reference + amount_in_cents + currency [+ expiration-time] + integrity_secret)`; unchanged from Phase 3                                                                                                                                                       |
| Sandbox test data    | Cards `4242…` (approved) / `4111…` (declined); Nequi/Daviplata phones `3991111111` / `3992222222`; PSE codes `1` / `2`; known Daviplata OTPs `574829`, `932015`, `999999`. These are the inputs a live sandbox run will use                                           |

No live call was made — there are still no credentials (see §13).

## 3. Webhook endpoint — `POST /webhooks/wompi`

Implemented in `supabase/functions/_shared/api/webhook-handler.ts` with a thin adapter in
`supabase/functions/webhooks-wompi/index.ts`. The sequence, in order:

1. **Parse** the body (bounded at 64 KiB; an unbounded body is a cheap DoS vector). Malformed
   input is rejected before it reaches the database.
2. **Authenticate** the delivery: verify the event checksum (events secret, constant-time
   comparison), the environment, and the signed-property resolvability. A delivery that does
   not verify changes nothing and is **recorded** as `REJECTED` with `checksum_valid = false`
   when it is fingerprintable — a spoofing attempt is an auditable security signal.
3. **Fingerprint** the event (`buildEventDedupeKey`) into a stable dedupe key.
4. **Claim** the event (`claim_webhook_event`): an insert into `payment_events` under the
   unique `dedupe_key`. A duplicate or a concurrent loser is answered **200 immediately** with
   the recorded outcome; the endpoint never reprocesses and never throws on a replay.
5. **Look up the transaction** at Wompi with the private key (`GET /v1/transactions/{id}`).
   The status in the body is not used for the decision.
6. **Validate** the transaction against the payment row: transaction id, reference, amount,
   currency — exact match, in TypeScript and again in SQL.
7. **Confirm** (`confirm_payment`): one database transaction (see §5–§7).
8. **Queue** the confirmation emails inside the same transaction (`queue_ticket_emails`), so a
   rollback queues nothing.
9. **Finalize** the ledger row with the outcome, then drain the outbox for the deliveries just
   queued (outside the transaction — the send may never happen inside it).

Response contract (matched to the documented retry schedule):

| Status | Meaning                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `200`  | Durably handled: applied, duplicate, ignored, or reconciliation required. Wompi must not retry.                        |
| `400`  | Not authentic / malformed: bad checksum, missing signature, ambiguous timestamp, unsupported property value            |
| `401`  | A delivery that fails authentication against our environment (checksum/environment). Recorded.                         |
| `503`  | Transient failure (Wompi unreachable, database error). The event row stays unprocessed so the retry can finish the job |

The webhook never returns payment details, never echoes the body and never logs personal data.
Every outcome is written to `payment_events` with `result`, `processed_at`, `http_status` and an
`error_code`, and `payment_events_unprocessed_idx` supports the operator query "received but
never finished".

## 4. Transaction lookup and validation

`_shared/integrations/wompi/client.ts` is the only code that talks to Wompi:

- `Authorization: Bearer <private key>`, bounded timeouts, retries only for idempotent GETs and
  only on network errors / `429` / `5xx`.
- **Fails closed**: an unexpected payload raises an upstream error instead of being interpreted
  as a successful payment. The response is parsed into an explicit shape.
- Errors carry status and `error.type` (for example `DUPLICATE_REFERENCE`), never response
  bodies (they can contain the customer's email) and never the key.

`validateTransactionAgainstPayment` (domain) and the SQL function independently check:

- the transaction id the event points at is the one we read;
- the Wompi reference belongs to the order (the order reference itself, or `<ref>-<attempt>`);
- `amount_in_cents` equals `orders.total_cents` exactly;
- currency is `COP` (in both directions);
- a transaction id already attached to a different reference/order is a mismatch, not a guess.

Any problem results in `REJECTED` on the ledger with the problem list and
`reviewRequired = true` — no state change, no ticket, no email.

## 5. Payment transitions: forward-only, with `refunded`

The database now enforces what the Phase 1 state machine promised, because the webhook path is
exactly where an out-of-order delivery could otherwise move an approved payment backwards:

```
rank:  pending/unknown(0) < approved(1) < refunded(2) < voided(3) < declined(4) < error(5)
```

- `unknown` is stored raw and **never advances** the normalized status, so a new Wompi status
  can never confirm an order.
- An **approved** attempt never regresses. If Wompi later voids it and an approval timestamp
  exists, the attempt becomes **`refunded`** (the money came back; not revenue, not "never
  paid"); a later `DECLINED` or `ERROR` is recorded in `raw_wompi_status` only.
- A raw-status-only change (same normalized status, new raw string) is reported as `APPLIED`,
  not `DUPLICATE`, so operators can see the record moved.
- `payments_approved_at_check` was widened from `('approved','voided')` to
  `('approved','voided','refunded')`: an approval stays a historical fact and can never appear
  on an attempt that was never approved.
- With `approved` and `refunded` both terminal for the attempt, the Phase 2 partial unique
  index "at most one approved payment per order" keeps its meaning.

The TypeScript `advancePaymentStatus` was aligned with the SQL rule and both are asserted
side by side in the tests (including "voided then refunded stays voided").

## 6. Order transitions on a verified approval

`confirm_payment` locks the order (`for update`) before anything else, which serializes the
whole confirmation per order — that is what makes "one approval / one ticket set / one
transition" true even when three identical events arrive simultaneously.

| Order state when approval arrives | Behaviour                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PENDING`                         | Normal path: inventory `reserved → sold`, order `PAID`, tickets issued, email queued                                                                                                               |
| `FAILED`                          | A failed attempt does not release the reservation (the buyer must be able to retry), so a verified approval still means the money arrived: inventory `reserved → sold`, order `PAID`               |
| `PAID`                            | Idempotent: `result = DUPLICATE`, `ticketsIssued = 0`, no second email. The payment row is found by transaction id/reference, not recreated                                                        |
| `CANCELLED` / `EXPIRED`           | `result = RECONCILIATION_REQUIRED`, `reconciliationRequired = true`. The order is **not** revived, no refund is invented, no ticket exists; the payment is recorded `approved` and a human decides |

A non-approved outcome (`DECLINED`, `VOIDED`, `ERROR`) on a `PENDING` order moves it to
`FAILED` but never touches inventory or tickets. `pending` leaves everything as it is.

## 7. Ticket issuance strategy

One ticket per **purchased unit**, regardless of whether a participant exists yet:

- `tickets.order_item_seq` is the 1-based unit number inside the order line, and
  `unique (order_item_id, order_item_seq)` is the exactly-once guarantee. Issuance is
  `insert ... on conflict (order_item_id, order_item_seq) do nothing`, so a replay — or three
  simultaneous deliveries — cannot create a second ticket for a unit.
- Participants already attached to the line are assigned, in creation order, to the first
  units; a participant that already owns a ticket is excluded, so unit N maps to attendee N
  and never to the same person twice. Remaining units stay unassigned (`assigned: false`) and
  can be attached before check-in.
- `price_paid_cents` is split per unit; the **last unit absorbs the integer remainder** so the
  sum over the line equals `line_total_cents` exactly (verified in the schema suite).
- Tokens are generated with Postgres core only (`TKT_` + 20 Crockford base32 chars from 120
  random UUID bits): the same shape as the Phase 1 generator, accepted by the same CHECK
  constraint, ~100 bits of CSPRNG entropy, no ambiguity and no sequential token. PGlite has no
  `pgcrypto`, and the token is therefore identical in tests and production.
- `tickets_order_item_idx` keeps the "units already issued per line" count cheap.

## 8. Email confirmation and the outbox

`email_deliveries` is used as the transactional outbox:

1. `queue_ticket_emails(order_id)` runs **inside** the confirmation transaction and inserts one
   row per ticket with the derived key `ticket:<ticket_id>:TICKET_CONFIRMATION` (unique). A
   second call inserts nothing (`queued: 0, alreadyQueued: 3` in the real run, §12 A2).
2. After commit, the dispatcher claims rows with `for update skip locked` (marking `SENDING`,
   incrementing `attempt_count`), so two concurrent dispatchers can never send the same
   message. A row stuck in `SENDING` past its staleness window can be reclaimed.
3. The send itself uses Resend with an `Idempotency-Key` header equal to the same derived key
   (the provider deduplicates for 24 hours). That covers the narrow window where Resend
   accepted the message and our row update was lost.
4. `finish_email_delivery` records `SENT` + provider message id, or `FAILED` with the bounded
   error and the next attempt instant. Retryable failures back off; permanent provider errors
   and the attempt ceiling (5) end as `CANCELLED`, so a bad address does not burn reputation
   forever.

The recipient is the ticket's participant when one is attached, otherwise the buyer (both are
the same person in the normal case). With `EMAIL_ENABLED=false` the rows stay `QUEUED` — a
valid, visible state, and the reason a missing Resend key can never block a payment.

## 9. Payment retry

`POST /orders/{reference}/retry` (reference + buyer email required) creates a **new payment
attempt with a fresh Wompi reference** (`EVT-YYYY-NNNNNN-<attempt>`), because a used reference
can never be reused. `retry_payment`:

- is gated on reference **and** buyer email, and refuses an order that already has an approved
  payment (`ORDER_ALREADY_PAID`), a non-retryable state (`ORDER_NOT_RETRYABLE`), or more than
  10 attempts (`TOO_MANY_ATTEMPTS`);
- keeps every previous attempt (the payment history is the reconciliation record);
- for an `EXPIRED` order, re-reserves inventory **at the same stage and price** — the buyer is
  never silently re-priced — and fails with `SOLD_OUT` if the stage can no longer serve it;
- returns the same order reference and total, plus the new checkout payload built from the row
  the database just wrote.

## 10. Order expiration

`expire_pending_orders(limit, now)` moves `PENDING`/`FAILED` orders past
`reservation_expires_at` to `EXPIRED` and gives the reserved units back to the tier.

- `FAILED` is included on purpose: a failed attempt keeps its reservation so a retry can reuse
  it, so without this an abandoned order would hold inventory forever.
- Concurrent-safe by construction: candidates are locked `for update skip locked` in the same
  statement that updates them, so two runs split the work instead of double-releasing.
- It never touches paid orders, never issues a ticket and never queues an email. Pending
  payment attempts are left untouched — Wompi may still report an outcome later, and that
  outcome must be recorded and reconciled rather than hidden.

`POST /orders-maintenance` (bearer `MAINTENANCE_API_TOKEN`, constant-time comparison) runs
expiry and then the outbox dispatcher. The endpoint is deliberately **not** on the payment
path: if it never runs, no payment is lost and no ticket is wrong — inventory stays reserved
longer and emails wait in the outbox. No scheduler is added in this phase (a Supabase
scheduled function, a cron job or a manual call all work); the webhook path also drains the
outbox on every delivery, so a redelivery is a free retry opportunity.

## 11. Security review

Scenario-based review of the confirmation path (each one has a test or a real-database check):

| #   | Scenario                                                   | Result                                                                                                                                                         |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Malformed / oversized / non-POST request                   | Rejected before the database; 400/405, body never logged                                                                                                       |
| 2   | Forged checksum                                            | 401, nothing changes, delivery recorded `REJECTED` with `checksum_valid = false`                                                                               |
| 3   | Missing signature / unsigned properties unresolvable       | 401/400, rejected                                                                                                                                              |
| 4   | Top-level and nested timestamp disagree                    | `AMBIGUOUS_TIMESTAMP` — rejected instead of guessing                                                                                                           |
| 5   | Event from the other environment (sandbox event to prod)   | `ENVIRONMENT_MISMATCH` — rejected                                                                                                                              |
| 6   | Replayed event (same dedupe key)                           | Claim conflict → 200 `DUPLICATE` with the recorded outcome; no work                                                                                            |
| 7   | Attacker replays a **valid** earlier "approved" delivery   | Idempotent by construction: no second payment, ticket or email                                                                                                 |
| 8   | Unknown Wompi reference                                    | 200 `IGNORED`, ledger `UNKNOWN_REFERENCE` — our rows are written before a checkout exists, so an unknown reference is not ours                                 |
| 9   | Reference from another order, or amount/currency mismatch  | Rejected before confirmation; `RECONCILIATION_REQUIRED` + operator review; no tickets                                                                          |
| 10  | Transaction id attached to a different reference           | `REFERENCE_MISMATCH`, rejected                                                                                                                                 |
| 11  | Client claims success via the redirect URL                 | Nothing on the redirect path can mark an order paid; only the verified pipeline can                                                                            |
| 12  | New/unknown Wompi status                                   | Stored raw, normalized `unknown`, never advances; reason `UNKNOWN_PROVIDER_STATUS`                                                                             |
| 13  | Approved after the order was cancelled/expired             | `RECONCILIATION_REQUIRED`; no revival, no invented refund                                                                                                      |
| 14  | Approved, then voided                                      | Payment becomes `refunded` with the approval timestamp preserved                                                                                               |
| 15  | Approved, then declined/error (out-of-order)               | Raw status updated, normalized status never regresses                                                                                                          |
| 16  | Concurrent identical confirmations                         | Exactly one `APPLIED` with tickets; the other `DUPLICATE` (§12 A)                                                                                              |
| 17  | Duplicate ticket issuance                                  | Impossible: `unique (order_item_id, order_item_seq)`                                                                                                           |
| 18  | Duplicate email delivery                                   | Impossible: unique outbox key + `skip locked` claim + provider idempotency key                                                                                 |
| 19  | Order-reference enumeration (`EVT-2026-000001`, `…000002`) | `GET`/retry require the buyer email; a wrong email and an unknown reference return the **same** `found: false` / `ORDER_NOT_FOUND`                             |
| 20  | PII exposure through the read endpoint                     | SQL whitelist projection: no cédula, email, phone, IP, user agent, Wompi transaction id, integrity signature or provider payload; tokens only for a paid order |
| 21  | Raw Wompi body retention                                   | Only a small explicit projection is persisted in `provider_payload`, never the whole response                                                                  |
| 22  | Unprocessed events after an outage                         | Ledger rows stay `processed_at IS NULL`; indexed for the reconciliation query                                                                                  |

Also reviewed and confirmed unchanged: RLS on all **16** public tables with zero policies,
`anon`/`authenticated` holding no table privilege, and every new function `SECURITY INVOKER`
with `set search_path = ''`, `EXECUTE` revoked from `PUBLIC` and granted to `service_role` only
(including `get_order_status` — an order reference is an identifier, not a credential).

## 12. Concurrency tests and results

Against **real PostgreSQL 17** (temporary `pg-tatiana` container, separate database, all 13
migrations applied from scratch; the unrelated `jamilchat-*` containers were not touched).
Two genuinely parallel sessions per race, held open with `pg_sleep` so the overlap is real.
The ad-hoc script and container were removed after the run; the exact outputs are reproduced
below.

**A — two identical APPROVED confirmations of the same order (3 units).**

```text
session 1: {"reason": "PAYMENT_APPROVED", "result": "APPLIED",   "orderStatus": "PAID",
            "paymentStatus": "approved", "ticketsIssued": 3, "ticketsExpected": 3,
            "wompiReference": "EVT-2026-000001", "wompiTransactionId": "tx-conc-a"}
session 2: {"reason": "PAYMENT_APPROVED", "result": "DUPLICATE", "orderStatus": "PAID",
            "paymentStatus": "approved", "ticketsIssued": 0, "ticketsExpected": 3}

asserted: exactly 1 APPLIED and 1 DUPLICATE; 1 payment row; order PAID;
          3 tickets, all tokens matching ^TKT_[0-9A-HJKMNP-TV-Z]{20}$;
          pricing tier quantity_sold = 3, quantity_reserved = 0
```

**A2 — email outbox under concurrency.**

```text
queue_ticket_emails  #1: {"total": 3, "queued": 3, "alreadyQueued": 0}
queue_ticket_emails  #2: {"total": 3, "queued": 0, "alreadyQueued": 3}
claim_email_deliveries(10)  #1: 3   #2: 0
asserted: 3 outbox rows, 3 distinct idempotency keys,
          all rows SENDING with attempt_count = 1 (claimed exactly once)
```

**B — two concurrent check-ins of the same ticket** (the check-in RPC is Phase 5; the race was
run against the `attendance(ticket_id)` unique constraint directly):

```text
session 1: INSERT 0 1  → COMMIT
session 2: ERROR: duplicate key value violates unique constraint "attendance_ticket_id_key"
asserted: exactly 1 attendance row
```

**C — two concurrent retries of the same declined order:**

```text
session 1: {"status": "PENDING", "reference": "EVT-2026-000002",
            "paymentAttempt": 2, "wompiReference": "EVT-2026-000002-2",
            "totalInCents": 19000002}
session 2: ERROR: ... DETAIL: ORDER_NOT_RETRYABLE
asserted: exactly 2 payment rows (1 declined + 1 retry), exactly one -2 reference,
          order PENDING after the retry
```

**D — four concurrent status reads must agree byte for byte:**

```text
distinct md5 payloads: 1
wrong email: {"found": false}
```

**E — privileges after the Phase 4 migrations:**

```text
svc_confirm=t  anon_confirm=f  svc_status=t  anon_status=f  anon_tickets=f  anon_orders=f
policies: 0    RLS tables: 16
```

`ALL CONCURRENCY CHECKS PASSED`.

## 13. Live Wompi Sandbox status

**Pending — no credentials exist.** No live Wompi call has been made in any phase, so nothing
below claims a live payment:

- implemented and tested against documented vectors/fixtures: event checksum, envelope
  parsing, transaction lookup client (injected `fetch`), status mapping, confirmation
  validation and the entire database side;
- **not yet executed**: a real sandbox transaction through Widget/Web Checkout, a real event
  delivery, a real `GET /v1/transactions/{id}` response, a declined-card path end to end.

When credentials exist, the live checklist is: create a sandbox order for one unit; pay with
`4242 4242 4242 4242`; confirm the webhook applied once and tickets were issued; repeat the
delivery and confirm `DUPLICATE` with no second email; pay with `4111…` and confirm `FAILED` +
retry with a fresh reference; optionally Nequi/PSE for delayed approval.

## 14. Test results — exact

`npm run check` (typecheck, ESLint, Prettier, `deno check` per function, Vitest):

```text
Test Files  26 passed (26)
     Tests  288 passed (288)
```

New in Phase 4 (74 tests in three new suites; existing suites were extended where Phase 4
changed their subject):

| Suite                                       | Tests | Covers                                                                                                                                                                                           |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/domain/payment-confirmation.test.ts` | 25    | dedupe keys, validation, ranked forward-only advance (`approved`/`refunded` terminal, void→refund), result/reason vocabulary, provider payload bounds                                            |
| `tests/api/webhook-handler.test.ts`         | 23    | rejected deliveries recorded, duplicate claim, wrong reference/amount/currency, unknown reference, reconciliation path, queued emails, 200/503 contract, no secret leakage                       |
| `tests/schema/payment-confirmation.test.ts` | 26    | real SQL functions end to end: claim/finalize/reject, confirm idempotency, ticket uniqueness + token shape, price remainder, outbox queue/claim/finish, expiry, retry, status projection, grants |

Updated: `tests/domain/payment-status.test.ts` (refunded rank and terminal rules),
`tests/config/env.test.ts` (email/maintenance variables), `tests/schema/migrations.test.ts`
(migration inventory now 13).

## 15. Files changed

**New migrations**

- `supabase/migrations/20261003210010_payment_status_refunded.sql` — adds `refunded` to
  `payment_status` alone, because the migration runner wraps a file in one transaction and an
  enum value cannot be consumed in the transaction that adds it.
- `supabase/migrations/20261003210011_payment_confirmation.sql` — `tickets.order_item_seq`
  - unique index, `payment_transition_rank`, widened `payments_approved_at_check`, indexes,
    `claim_webhook_event` / `finalize_webhook_event` / `record_webhook_rejection`,
    `confirm_payment`, `queue_ticket_emails`, `claim_email_deliveries`,
    `finish_email_delivery`, `expire_pending_orders`, `retry_payment`, `get_order_status`,
    grants.

**New backend code**

- `supabase/functions/_shared/domain/payment-confirmation.ts` — event keys, transaction
  validation, result/reason vocabulary.
- `supabase/functions/_shared/domain/email-content.ts` — Spanish ticket confirmation
  (HTML + text) from the outbox context.
- `supabase/functions/_shared/integrations/resend/client.ts` — typed Resend client with
  idempotency key support and bounded retry classification.
- `supabase/functions/_shared/db/payments.ts` — typed gateways for every Phase 4 RPC.
- `supabase/functions/_shared/api/webhook-handler.ts`,
  `supabase/functions/_shared/api/email-dispatch.ts`,
  `supabase/functions/_shared/api/order-status-handler.ts`,
  `supabase/functions/_shared/api/maintenance-handler.ts` — orchestration.
- `supabase/functions/webhooks-wompi/` (`index.ts`, `deno.json`),
  `supabase/functions/orders-maintenance/` (`index.ts`, `deno.json`) — adapters.

**Modified**

- `supabase/functions/orders/index.ts` — `GET /orders/{reference}` and
  `POST /orders/{reference}/retry` routes (buyer email via `X-Buyer-Email`).
- `supabase/functions/_shared/config/env.ts`, `.env.example` — `EMAIL_ENABLED`,
  `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `TICKET_BASE_URL`,
  `EMAIL_DISPATCH_BATCH_SIZE`, `MAINTENANCE_API_TOKEN`.
- `supabase/config.toml` — `verify_jwt = false` for `webhooks-wompi` and
  `orders-maintenance`.
- `supabase/functions/_shared/domain/payment-status.ts` — `refunded` rank and terminal rules.
- `supabase/functions/_shared/integrations/wompi/{events,types,signature,client,checkout}.ts`
  — current envelope parsing, header fallback, constant-time comparison.
- `supabase/functions/_shared/db/database.types.ts` — regenerated from the migrated database.
- `tests/domain/payment-status.test.ts`, `tests/config/env.test.ts`,
  `tests/schema/migrations.test.ts` — extended.

**New tests**

- `tests/domain/payment-confirmation.test.ts`,
  `tests/api/webhook-handler.test.ts`,
  `tests/schema/payment-confirmation.test.ts`.

## 16. Open issues and open business decisions

Still not invented (they remain the client's calls; every one is documented where it is used):

1. **Prices, stage quantities and sales windows** — rows, not code.
2. **Discount codes / quantity discounts / combination policy** — schema and engine ready,
   `BEST_SINGLE` default.
3. **Reservation window** — `ORDER_RESERVATION_MINUTES`, technical default 15 minutes.
4. **Duplicate cédula policy** — indexes exist, constraint deliberately absent.
5. **Consent wording and version** — mechanism ready, text is legal's.
6. **`expiration-time` in the checkout** — supported, disabled by default.
7. **Enabled payment methods** — PSE/Nequi introduce delayed approval; the outbox and expiry
   already tolerate it, but the UX wording is open.
8. **Retention policy** for `provider_payload` and participant data — documented, not scheduled.
9. **Refund process** — the `refunded` status exists for approved-then-voided attempts;
   there is no automatic refund flow and none is invented.
10. **Buyer copy on ticket emails** — today one confirmation per ticket to its holder (buyer
    fallback for unassigned units); a single buyer summary email is not implemented.

Technical gaps tracked, not hidden:

- No automatic **reconciliation job** that re-queries `pending` payments against the Wompi API
  on a schedule. The ledger (`payment_events_unprocessed_idx`) and Wompi's own retries cover
  the common cases; a scheduled re-check is the remaining piece for a payment whose webhook
  never arrives.
- No live Wompi/Resend verification (no credentials).
- PostgREST runtime still cannot be exercised on this machine (reserved Windows TCP ranges).
- Rate limiting is still Phase 12; until then the public read/retry endpoints rely on the
  reference + email possession check and the email is not itself rate-limited.

## 17. What remains for Phase 5

1. **Live sandbox verification** with real credentials (transaction, webhook delivery,
   approved + declined + retry; email send through Resend).
2. **Participant attachment endpoint** (`POST /orders/{reference}/participants`) for the N−1
   unassigned units of a multi-ticket order.
3. **Public event endpoints** (`GET /events/{code}`, availability) for the future frontend.
4. **Check-in endpoint** and operator authentication.
5. **Scheduler** for `orders-maintenance` (Supabase scheduled function or cron) so expiry and
   outbox retries run without a manual call.
6. **Google Sheets export** (read-only projection) and the remaining operational tooling.
7. **Rate limiting** and the production hardening checklist.

## 18. What this phase explicitly does NOT claim

- No live Wompi payment, no live webhook from Wompi, no live email was sent; all provider
  behaviour is verified against documented vectors and fixtures.
- No production readiness: no scheduler, no rate limits, no operator auth, no Sheets export.
- No refund automation; `refunded` records a state Wompi reported, it does not initiate one.
- PostgREST/Studio behaviour on Supabase is still unverified because the local stack cannot
  start here; the database work was verified on PGlite on every test run and on a real
  PostgreSQL 17 container for the races above.
- Phase 5's live-sandbox checklist (§13) is a plan, not a result.
