# API

**Status: the operational backend is complete (Phases 1–5) and this contract is frozen**
(pre-frontend closure, 2026-10-04; see
[audits/pre-frontend-closure-01.md](audits/pre-frontend-closure-01.md)). Every endpoint below is
implemented and test-covered; the Spanish frontend is a thin client over these contracts. The
only part not yet exercised against live providers is the Wompi sandbox / Resend / Google run,
which needs credentials (§5 explains the Data API boundary; the freeze checklist is §6).

Base URL: `https://<project-ref>.supabase.co/functions/v1/<function>` (locally
`http://127.0.0.1:54321/functions/v1/<function>`).

## 1. Conventions

- JSON over HTTPS. Request bodies must be JSON objects; unknown keys are ignored (never trusted).
- Identifiers, field names and error codes are **English**; user-facing messages are **Spanish**.
- Money is always `amountInCents` (integer centavos). Clients never send prices.
- Timestamps are ISO-8601 UTC.
- Success: `{ "ok": true, "data": … }`. Failure:
  `{ "ok": false, "error": { "code": "...", "message": "...", "details": … } }`.
- `details` is only used for field-level validation issues; it never contains personal data or
  infrastructure hints.

### Error codes

| Code               | HTTP | Meaning                                                                   |
| ------------------ | ---- | ------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 400  | Malformed or invalid input (`details.issues[]` per field)                 |
| `UNAUTHORIZED`     | 401  | Missing/invalid credentials (operator token, webhook signature)           |
| `FORBIDDEN`        | 403  | Authenticated but not allowed                                             |
| `NOT_FOUND`        | 404  | Unknown order reference, ticket token, etc.                               |
| `CONFLICT`         | 409  | State does not allow the operation (sold out, already paid, already used) |
| `RATE_LIMITED`     | 429  | Too many requests                                                         |
| `UPSTREAM_ERROR`   | 502  | Wompi (or another provider) failed to answer correctly                    |
| `INTERNAL_ERROR`   | 500  | Unexpected; the real cause is only in logs                                |

### Authentication

| Audience             | Mechanism                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wompi webhook        | Event checksum (`X-Event-Checksum` / `signature.checksum`), private-key transaction lookup (Phase 4, implemented); `verify_jwt = false`                                                                                                                          |
| Public buyer API     | No user account. `GET`/retry require the order reference **and** the buyer email (`X-Buyer-Email`); abuse control = strict validation, per-IP/per-reference rate limits, order-scoped opaque identifiers                                                         |
| Maintenance jobs     | `Authorization: Bearer <MAINTENANCE_API_TOKEN>` (shared secret, ≥32 chars, constant-time comparison); `verify_jwt = false`                                                                                                                                       |
| Operator check-in UI | Supabase Auth: `Authorization: Bearer <access token>` verified by Supabase Auth, plus an active row in `public.operators` (role `OPERATOR`/`ADMIN`). 401 = not authenticated; 403 = authenticated but not an active operator. There is no shared operator secret |
| Admin/maintenance    | Not exposed publicly. Privileged work runs with the service key inside functions only                                                                                                                                                                            |

`verify_jwt = false` is set in `supabase/config.toml` per function; every public endpoint
authenticates its own callers as listed above.

## 2. Endpoints

### `GET /health` — implemented

Public. Returns `{ service, version, environment, wompiEnvironment, time, checks }`. Outside
production it also lists missing **variable names** when the environment is incomplete. Never
returns configuration values.

### `GET /events/{code}` — implemented (Phase 5)

Public event information for the landing page (function `events`). Only `PUBLISHED` and
`CLOSED` events are visible; anything else — unpublished, malformed code, unknown — answers the
same `404 NOT_FOUND`. The projection is a SQL whitelist: no internal ids, no capacity counters,
no participant data.

```json
{
  "ok": true,
  "data": {
    "found": true,
    "event": {
      "code": "TAT-2026",
      "name": "…",
      "description": "…",
      "status": "PUBLISHED",
      "startsAt": "2026-11-21T15:00:00.000Z",
      "endsAt": null,
      "timezone": "America/Bogota",
      "currency": "COP",
      "venue": { "name": "…", "address": "…", "city": "Medellín" }
    },
    "sales": {
      "currency": "COP",
      "salesOpen": true,
      "availability": "LOW",
      "ticketTypes": [
        {
          "code": "GENERAL",
          "name": "Entrada general",
          "description": null,
          "minPerOrder": 1,
          "maxPerOrder": 4,
          "salesOpen": true,
          "availability": "LOW",
          "currentTier": { "name": "Preventa 1", "sequence": 1, "priceInCents": 9500000 }
        }
      ]
    }
  }
}
```

### `GET /events/{code}/availability` — implemented (Phase 5)

The checkout's lightweight quote of the sales state: the same `sales` block as above
(`{ "found": true, "code": "TAT-2026", "sales": { … } }`).

**Availability is deliberately coarse** — `AVAILABLE`, `LOW` (≤10 units left), `SOLD_OUT`,
`NOT_STARTED`, `CLOSED` — and informational only. It can never promise a unit: the
authoritative check happens inside `POST /orders`'s transaction. Exact inventory counters are
never exposed.

### `POST /orders/quote` — implemented (Phase 3)

Authoritative price for a proposed purchase, computed from the database. Side-effect free: it
reserves nothing and **never fails because a discount code is invalid** — it reports the reason so
the checkout can explain it before the buyer submits.

```json
// request
{ "eventCode": "TAT-2026", "ticketTypeCode": "GENERAL", "quantity": 2, "discountCode": "AMIGOS" }
// response
{ "ok": true, "data": {
  "event": { "code": "TAT-2026", "name": "…" },
  "ticketType": { "code": "GENERAL", "name": "Entrada general" },
  "quantity": 2,
  "pricingTier": { "name": "Preventa 1", "sequence": 1, "unitPriceInCents": 9500000 },
  "subtotalInCents": 19000000,
  "quantityDiscount": { "applies": false, "percentBps": 0, "amountInCents": 0 },
  "quantityDiscountInCents": 0,
  "discountCode": { "supplied": true, "applies": true, "reason": "OK", "code": "AMIGOS",
                    "kind": "PERCENT", "percentBps": 2500, "amountInCents": 4750000,
                    "remainingRedemptions": 9 },
  "discountCodeInCents": 4750000,
  "discountCombination": "BEST_SINGLE",
  "totalDiscountInCents": 4750000,
  "totalInCents": 14250000,
  "currency": "COP",
  "availability": "LOW", "availableQuantity": 3,
  "expiresAt": "2026-10-03T16:05:00.000Z" } }
```

`discountCode.reason` is the stable contract: `NOT_SUPPLIED`, `NOT_FOUND`, `INACTIVE`,
`NOT_STARTED`, `EXPIRED`, `EXHAUSTED`, `WRONG_TICKET_TYPE`, `MIN_QUANTITY`, `OK`. The applied
split (`quantityDiscountInCents` / `discountCodeInCents`) reflects the configured
`discount_combination` policy: under `BEST_SINGLE` the loser is `0`.

Validation: event/ticket type exist and are on sale; `quantity` within `[min_per_order,
max_per_order]`; the discount code belongs to the event, is active, unexpired and under its usage
limit. Totals are recomputed server-side from database state and **never** taken from input —
there is no amount parameter anywhere in the request.

### `POST /orders` — implemented (Phase 3)

Creates the order atomically (inventory reserved, discounts claimed, participant and consents
written, payment attempt created) and returns everything the checkout needs. **The amount is
decided here, not by the client.**

Headers: `Idempotency-Key: <16–128 printable ASCII>` (optional but recommended — a retry with the
same key returns the same order instead of reserving inventory twice).

```json
// request
{ "eventCode": "TAT-2026", "ticketTypeCode": "GENERAL", "quantity": 2,
  "discountCode": "AMIGOS",
  "buyer": { "email": "comprador@example.com", "fullName": "Comprador Uno", "phone": "3001234567" },
  "participant": { "firstName": "Ana", "lastName": "Pérez", "nationalId": "1.020.456.789",
                   "email": "ana@example.com", "phone": "+57 300 123 4567", "city": "Bogotá",
                   "instagram": "@ana.perez",
                   "consents": { "dataProcessing": true, "futureEvents": false } } }
// response (201)
{ "ok": true, "data": {
  "reference": "EVT-2026-000001", "status": "PENDING", "replayed": false,
  "quantity": 2, "pricingTierName": "Preventa 1", "unitPriceInCents": 9500000,
  "subtotalInCents": 19000000, "quantityDiscountInCents": 0, "discountCodeInCents": 4750000,
  "totalDiscountInCents": 4750000, "totalInCents": 14250000, "currency": "COP",
  "reservationExpiresAt": "2026-10-03T16:05:00.000Z", "paymentAttempt": 1,
  "checkout": { "publicKey": "pub_test_…", "currency": "COP", "amountInCents": 14250000,
                "reference": "EVT-2026-000001", "integritySignature": "…",
                "expirationTime": null, "redirectUrl": "https://evento.example/gracias",
                "customerData": { "email": "comprador@example.com", "fullName": null,
                                  "phoneNumber": null, "phoneNumberPrefix": null } } } }
```

Errors: `VALIDATION_ERROR` (input, `details.issues[]` for participant fields), `NOT_FOUND`
(unknown event or ticket type), `CONFLICT` (`SOLD_OUT`, `DISCOUNT_EXHAUSTED`, `QUANTITY_LIMIT`,
`IDEMPOTENCY_KEY_CONFLICT`), `RATE_LIMITED`.

The checkout payload is the only place the signature is produced; the integrity secret stays
server-side. `expirationTime` is included in the signature whenever the checkout uses it (it is
disabled by default). A supplied code that cannot be applied fails the order instead of silently
charging the full price.

### `GET /orders/{reference}` — implemented (Phase 4)

Buyer-facing status, safe fields only. The order reference is sequential and therefore
enumerable, so the endpoint requires the buyer email in the `X-Buyer-Email` header. A wrong
email and an unknown reference return the **same** `404 ORDER_NOT_FOUND`, so the endpoint
cannot be used to discover which orders exist. Ticket tokens are returned only for a `PAID`
order and are never a capability for anything else.

```json
// GET /orders/EVT-2026-000001   (X-Buyer-Email: comprador@example.com)
{
  "ok": true,
  "data": {
    "reference": "EVT-2026-000001",
    "status": "PAID",
    "quantity": 3,
    "totalInCents": 28500003,
    "currency": "COP",
    "createdAt": "…",
    "paidAt": "…",
    "reservationExpiresAt": "…",
    "payment": {
      "attempt": 1,
      "status": "approved",
      "methodType": "CARD",
      "statusMessage": "ok",
      "approvedAt": "…"
    },
    "paymentAttempts": [
      {
        "attempt": 1,
        "status": "approved",
        "wompiReference": "EVT-2026-000001",
        "amountInCents": 28500003,
        "createdAt": "…",
        "finalizedAt": "…"
      }
    ],
    "tickets": [
      {
        "token": "TKT_…",
        "unit": 1,
        "status": "ACTIVE",
        "assigned": true,
        "pricePaidCents": 9500001,
        "participantName": "Ana Pérez"
      }
    ],
    "confirmation": { "queued": 3, "sent": 0, "failed": 0, "ready": true }
  }
}
```

The projection is a SQL whitelist: it never returns cédula, email, phone, IP, user agent,
Wompi transaction id, integrity signature or `provider_payload`. Validation: the reference
must match `EVT-<year>-<sequence>`; the email must be non-empty. Rate-limited per order
reference (§3).

### `POST /orders/{reference}/retry` — implemented (Phase 4)

Creates a new payment attempt with a **fresh Wompi reference** for a `FAILED` or `EXPIRED`
order (a used reference can never be reused). Requires the same reference + buyer email
possession check. The order, its frozen price and its history are preserved; an `EXPIRED`
order re-reserves at the original stage and price (`SOLD_OUT` if no longer possible).

```json
// POST /orders/EVT-2026-000002/retry  (X-Buyer-Email header or { "email": "…" })
{ "ok": true, "data": {
  "reference": "EVT-2026-000002", "status": "PENDING", "paymentAttempt": 2,
  "totalInCents": 19000002, "currency": "COP", "reservationExpiresAt": "…",
  "checkout": { "publicKey": "pub_test_…", "currency": "COP", "amountInCents": 19000002,
                "reference": "EVT-2026-000002-2", "integritySignature": "…",
                "expirationTime": null, "redirectUrl": "…", "customerData": { … } } } }
```

Errors: `NOT_FOUND` (unknown reference or wrong email), `CONFLICT` (`ORDER_ALREADY_PAID`,
`ORDER_NOT_RETRYABLE`, `TOO_MANY_ATTEMPTS`, `SOLD_OUT`), `VALIDATION_ERROR`. The checkout
payload is built from the row the database just wrote, so amount and signature cannot
disagree with what is stored.

### `POST /orders/{reference}/payment-hint` — implemented (Phase 5)

Recovery path for a lost webhook. Wompi's checkout redirect carries `?id=<transaction_id>`; the
frontend posts that id here so the backend can re-read the transaction with the private key and
run the SAME confirmation as the webhook. **The hint is never trusted**: reference, amount,
currency and transaction id are validated against the buyer's own payment before anything is
confirmed, and an attempt already attached to a different transaction is refused (`MISMATCH`).

Headers: `X-Buyer-Email: <email>` (or `{ "email": "…" }` in the body).

```json
// POST /orders/EVT-2026-000001/payment-hint
{ "transactionId": "01-1602113476-10986" }
// response
{ "ok": true, "data": {
  "orderReference": "EVT-2026-000001", "orderStatus": "PAID",
  "paymentStatus": "approved", "outcome": "APPROVED_APPLIED" } }
```

`outcome` uses the reconciliation vocabulary (`APPROVED_APPLIED`, `APPROVED_DUPLICATE`,
`STILL_PENDING`, `DECLINED`, `VOIDED`, `ERROR`, `UNKNOWN_STATUS`, `MISMATCH`,
`RECONCILIATION_REQUIRED`) plus `TRANSACTION_NOT_FOUND` when Wompi does not know the id.
Errors: `NOT_FOUND` (unknown reference or wrong email — identical responses),
`VALIDATION_ERROR` (id shape), `UPSTREAM_ERROR` (Wompi unavailable; retry).

### `POST /orders/{reference}/participants` — implemented (Phase 5)

Attaches a person to a **remaining unit** of a paid order and records consent evidence with
value, timestamp and policy version. Server-side validation (`parseParticipantInput`) strips
unknown fields, so a client cannot set price, status or ids. Consent to personal data
processing is mandatory.

Headers: `X-Buyer-Email: <email>` (or `{ "email": "…" }` in the body).

```json
// POST /orders/EVT-2026-000001/participants
{ "participant": { "firstName": "Ana", "lastName": "Pérez", "nationalId": "1.020.456.789",
                   "email": "ana@example.com", "phone": "+57 300 123 4567", "city": "Bogotá",
                   "instagram": "@ana.perez",
                   "consents": { "dataProcessing": true, "futureEvents": false } },
  "ticketToken": "TKT_…",          // optional: claim a specific unit
  "consentPolicyVersion": "2026-v1" } // optional
// response (201)
{ "ok": true, "data": {
  "orderReference": "EVT-2026-000001",
  "ticket": { "token": "TKT_…", "unit": 2, "status": "ACTIVE" },
  "participant": { "participantId": "…", "firstName": "Ana", "lastName": "Pérez" },
  "consents": { "dataProcessing": true, "futureEvents": false,
                 "policyVersion": "2026-v1", "capturedAt": "…" },
  "remainingUnassigned": 1 } }
```

The response never echoes cédula, email or phone back over the wire. Without `ticketToken`,
concurrent calls claim **different units** (database `FOR UPDATE SKIP LOCKED`); a ticket is
never assigned twice. Errors: `NOT_FOUND` (unknown reference, wrong email or a participant of
another order — all identical), `CONFLICT` (`ORDER_NOT_PAID`, `TICKET_NOT_ASSIGNABLE`),
`VALIDATION_ERROR`.

### `PUT /orders/{reference}/participants/{participantId}` — implemented (Phase 5)

Edits a participant that belongs to the buyer's order and **appends** consent evidence for any
changed value (history is never overwritten). Same header/body rules as attach.

```json
// response
{ "ok": true, "data": {
  "participantId": "…", "firstName": "Ana", "lastName": "Pérez",
  "consents": { … }, "consentsAppended": 1 } }
```

Errors: `NOT_FOUND` (a participant id from another order is indistinguishable from an unknown
one), `VALIDATION_ERROR`.

### `POST /webhooks/wompi` — implemented (Phase 4)

Public (no JWT), authenticated by the event checksum; the body is only a pointer to the
transaction.

1. Verify authenticity (SHA-256 over `properties` + `timestamp` + events secret, header or
   payload, constant-time).
2. Claim the event with its dedupe key in `payment_events` (idempotency). A **finalized**
   duplicate is answered `200` with the recorded outcome and never reprocessed; an event that
   was claimed but never finalized (the previous delivery answered `503`, or the worker died)
   **is processed again**, so Wompi's retry can actually finish the job. Reprocessing is safe:
   `confirm_payment` and the email outbox are idempotent, and only the first finalized run owns
   the recorded outcome.
3. Look the transaction up server-side with the private key (`GET /v1/transactions/{id}`).
4. Validate transaction id ⇄ reference ⇄ order, amount and currency exactly.
5. `confirm_payment`: lock the order, advance the payment forward-only, move the order to
   `PAID`, convert reserved inventory to sold, issue exactly one ticket per purchased unit,
   queue the confirmation email in the outbox — all in one transaction.
6. Record the outcome on the ledger and answer `200`.

```text
200  durably handled (applied, duplicate, ignored, reconciliation required) — do not retry
400/401  not authentic / malformed — recorded as REJECTED, nothing changes
503  transient failure — the event row stays unprocessed, Wompi should retry
```

Accepts `transaction.updated`; other documented event types are authenticated, recorded and
answered `200` (`IGNORED`). A payment approved for an order that is no longer payable
(`CANCELLED`/`EXPIRED`) is recorded as `approved` with `reconciliationRequired` and a human
decides — the order is not revived and no refund is invented. The endpoint never returns
payment details in the body.

### `POST /orders-maintenance` — implemented (Phase 4), extended (Phase 5)

Not part of the payment path. Runs, in order: reservation expiry (`expire_pending_orders`),
confirmation-email dispatch (outbox), the **payment reconciliation sweep**, rate-limit counter
cleanup, and the **Google Sheets projection** (when configured). Authenticated by
`Authorization: Bearer <MAINTENANCE_API_TOKEN>` compared in constant time; intended for the
`scheduler (pg_cron → pg_net → this endpoint, migration 015) or an operator, never for the
browser. Every job is idempotent and concurrent-safe (`SKIP LOCKED`claims), so overlapping
runs are harmless. Expiry/email failures fail the run (500); the Phase 5 jobs are isolated and
reported in`jobErrors` without stopping the rest. If it never runs, no payment is lost and no
ticket is wrong: inventory stays reserved longer, emails and the sheet wait, and unreconciled
payments remain visible.

### `GET /tickets/{token}` — implemented (Phase 5)

Public-safe ticket lookup for the holder (function `tickets`). The opaque token IS the
capability (100 bits of CSPRNG entropy); malformed and unknown tokens answer the same
`404 NOT_FOUND`, so the endpoint cannot be used to enumerate. The response is the minimum a
participant-facing page needs and is a SQL whitelist — never cédula, email, phone, order
internals or consent history.

```json
// GET /tickets/TKT_…
{
  "ok": true,
  "data": {
    "found": true,
    "ticket": { "code": "TKT_…", "status": "ACTIVE", "displayName": "Ana P." },
    "event": {
      "code": "TAT-2026",
      "name": "…",
      "startsAt": "…",
      "endsAt": null,
      "timezone": "America/Bogota",
      "city": "Bogotá",
      "venueName": "…",
      "venueAddress": "…"
    }
  }
}
```

### `POST /check-in` and `GET /check-in/{token}` — implemented (Phase 5)

The private check-in API, used from a phone at the door (function `checkin`). Both routes
require a Supabase Auth access token **and** an active operator row;
`GET /check-in/{token}` returns the admission view (participant name, cédula, city, ticket,
order/payment/attendance state) for verifying a person.

```json
// POST /check-in   (Authorization: Bearer <Supabase access token>)
{ "ticketToken": "TKT_…" }
// response — every outcome is HTTP 200 with a status
{ "ok": true, "data": {
  "status": "VALID",
  "ticketCode": "TKT_…",
  "participant": { "name": "Ana Pérez" },
  "checkedInAt": "2026-11-21T15:02:11.000Z" } }
```

| `status`       | Meaning                                             | Extra fields          |
| -------------- | --------------------------------------------------- | --------------------- |
| `VALID`        | Admitted now (first valid scan wins)                | code, name, timestamp |
| `ALREADY_USED` | Already admitted; shows when                        | code, timestamp       |
| `NOT_PAID`     | Ticket exists but the order/payment is not approved | code                  |
| `CANCELLED`    | Ticket was cancelled                                | code                  |
| `NOT_FOUND`    | Unknown token                                       | —                     |
| `INVALID`      | Malformed token; no database lookup                 | —                     |

HTTP errors are reserved for transport-level failures: `UNAUTHORIZED` (401, no/invalid token),
`FORBIDDEN` (403, authenticated but not an active operator), `RATE_LIMITED` (429),
`VALIDATION_ERROR` (400, malformed body), `UPSTREAM_ERROR` (502). Attendance is written in the
same transaction that decides, with a ticket row lock and `unique (ticket_id)`, so two
simultaneous scans can never both be valid (verified on real PostgreSQL,
[phases/phase-05.md](phases/phase-05.md#7-real-postgresql-concurrency-verification-ae)).

### `POST /discounts/validate` — folded into `POST /orders/quote` (Phase 3)

The quote endpoint already reports the full discount verdict (`discountCode.reason`) without
reserving anything, so no separate endpoint is needed: the checkout calls the quote while the
buyer types. It is always re-validated inside `POST /orders`. Rate-limited per IP to prevent
code enumeration.

## 3. Abuse control

PostgreSQL-backed fixed windows (no Redis), implemented in Phase 5. Keys are namespaced
(`ip:`, `ref:`, `op:`) and **md5-hashed before storage** — no raw IP, token or reference is kept
in the counters table, which exists only for abuse control and is cleaned by maintenance.
Exceeding a limit answers `429 RATE_LIMITED` with the documented Spanish message.

| Scope                 | Key                                         | Limit   | Covers                                |
| --------------------- | ------------------------------------------- | ------- | ------------------------------------- |
| `events:read`         | IP                                          | 240/min | `GET /events/{code}`, `/availability` |
| `orders:quote`        | IP                                          | 120/min | `POST /orders/quote`                  |
| `orders:create`       | IP                                          | 20/h    | `POST /orders`                        |
| `orders:retry`        | order reference                             | 20/h    | `POST …/retry`                        |
| `orders:status`       | order reference                             | 300/5 m | `GET /orders/{reference}`             |
| `orders:participants` | order reference                             | 60/h    | attach / update participants          |
| `orders:hint`         | order reference                             | 30/h    | `POST …/payment-hint`                 |
| `tickets:lookup`      | IP                                          | 120/min | `GET /tickets/{token}`                |
| `checkin:attempt`     | IP, only requests **without a valid token** | 120/min | `POST /check-in`                      |
| `checkin:operator`    | operator user id                            | 600/min | both check-in routes                  |

Notes for the frontend and operators:

- The limits are deliberately generous: they stop scripted abuse, not attendees. A whole venue
  behind one NAT must never be throttled by one guest, which is why order-scoped endpoints key on
  the order reference instead of the IP and why `checkin:attempt` is consumed only for requests
  without a valid operator token.
- The guard **fails open** on a limiter failure (an abuse control must never take down checkout
  or the door); validation, opaque tokens and the reference+email possession rule still apply.
- The client IP comes from platform-set headers (`cf-connecting-ip`, or the last valid
  `x-forwarded-for` entry) — a caller cannot choose its bucket by sending a header.
- `RATE_LIMIT_ENABLED=false` is a documented emergency switch that removes application-level
  limits entirely (docs/environments.md).

## 4. Versioning

The public API is versioned by the contract itself, not by URL: additive changes (new optional
fields) may ship at any time, while a breaking change requires a new function name
(`orders-v2`) and a coordinated frontend deploy. Response envelopes stay stable so the frontend
can rely on `ok`/`error.code` forever.

## 5. Data API boundary

The Supabase Data API (PostgREST) stays **enabled**, but only because the Edge Functions are
themselves PostgREST clients: every gateway call is a `POST /rest/v1/rpc/<function>` or a table
read executed with the **secret key** (`sb_secret_*`, or the legacy `service_role` JWT) — the
backend's own identity. **The frontend must never call `/rest/v1` or `/graphql/v1`.**

The exposed surface is deliberately minimal (verified on the local Supabase stack; exact
evidence in the closure report, §2–4):

- `schemas = ["public"]` only (`graphql_public` removed from `supabase/config.toml`; the GraphQL
  route answers HTTP `404`, PostgREST code `PGRST202`, on the local stack) and
  `auto_expose_new_tables = false` — the strict
  "explicit grants only" defaults Supabase documents as the platform direction.
- `anon` and `authenticated` hold **zero** table/view/function privileges. Their very first
  request answers `401` (or `403` with a valid GoTrue session), PostgREST code `42501`:
  `permission denied for table …` / `permission denied for function …`. No public read model is
  reachable through the Data API.
- `service_role` holds exactly the DML privileges the backend needs, granted explicitly by
  migration `20261004150000` (and re-established as defaults for future objects). No other role
  is granted anything.
- Production equivalent: Dashboard → Settings → API → "Exposed schemas" lists `public` only, and
  "Automatically expose new tables" stays off.

## 6. Contract freeze

The request/response shapes documented here are frozen as of 2026-10-04: the Spanish frontend may
be built against them as-is. Additive changes (new optional fields) may still ship; a breaking
change requires a new function name (§4). Unless a real defect is found, these shapes must not
change.

| Endpoint                              | Auth                                | Safety / idempotency                                                | Rate-limit scope      |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- | --------------------- |
| `GET /health`                         | none (public)                       | read-only                                                           | —                     |
| `GET /events/{code}`                  | none (public)                       | read-only, whitelisted projection                                   | `events:read`         |
| `GET /events/{code}/availability`     | none (public)                       | read-only                                                           | `events:read`         |
| `POST /orders/quote`                  | none (public)                       | pure computation; stores nothing                                    | `orders:quote`        |
| `POST /orders`                        | none (public)                       | price/inventory re-validated inside the SQL transaction             | `orders:create`       |
| `GET /orders/{ref}`                   | reference + `X-Buyer-Email`         | read-only; wrong email is indistinguishable from unknown reference  | `orders:status`       |
| `POST /orders/{ref}/retry`            | reference + buyer email             | **new** Wompi reference per attempt; a consumed one is never reused | `orders:retry`        |
| `POST /orders/{ref}/participants`     | reference + buyer email             | validated inside the transaction; guarded by the reservation window | `orders:participants` |
| `PUT /orders/{ref}/participants/{id}` | reference + buyer email             | foreign participant id is answered as `NOT_FOUND`                   | `orders:participants` |
| `POST /orders/{ref}/payment-hint`     | reference + buyer email             | safe to repeat; same confirmation pipeline as the webhook           | `orders:hint`         |
| `GET /tickets/{token}`                | opaque token (capability)           | read-only; whitelisted projection                                   | `tickets:lookup`      |
| `POST /check-in`                      | Supabase Auth + active operator     | first scan wins; outcome is in the 200 body                         | `checkin:operator`    |
| `GET /check-in/{token}`               | Supabase Auth + active operator     | read-only admission view                                            | `checkin:operator`    |
| `POST /webhooks/wompi`                | event checksum + private-key lookup | dedupe key per event; replays answer from the ledger                | — (provider)          |
| `POST /orders-maintenance`            | `Bearer <MAINTENANCE_API_TOKEN>`    | every job idempotent + `SKIP LOCKED`                                | — (scheduler)         |

`checkin:attempt` (IP, token-less requests only) additionally covers `POST /check-in` — see §3.
