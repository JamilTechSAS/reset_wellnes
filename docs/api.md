# API

**Status: the operational backend is implemented and test-covered.** The Spanish frontend is a
thin client over these contracts. Payments run through **ePayco Smart Checkout V2** (the only
provider the purchase flow opens); tickets and QR codes are discontinued, so a PAID order and its
participant roster are the confirmation. The part not exercised against live providers is the
ePayco sandbox / Resend / Google run, which needs credentials (§5 explains the Data API boundary;
the freeze checklist is §6).

Base URL: `https://<project-ref>.supabase.co/functions/v1/<function>` (locally
`http://127.0.0.1:54321/functions/v1/<function>`).

## 1. Conventions

- JSON over HTTPS. Request bodies must be JSON objects; unknown keys are ignored (never trusted).
- Identifiers, field names and error codes are **English**; user-facing messages are **Spanish**.
- Money is always `amountInCents` (integer centavos). Clients never send prices.
- Timestamps are ISO-8601 UTC.
- Success: `{ "ok": true, "data": … }`. Failure:
  `{ "ok": false, "error": { "code": "...", "message": "...", "details": … } }`.
- `details` is only used for field-level validation issues or a `reason` taken from a closed
  allowlist (checkout-session and purchase-rule refusals); it never contains personal data,
  SQLSTATE text, provider payloads or infrastructure hints.

### Error codes

| Code               | HTTP | Meaning                                                                   |
| ------------------ | ---- | ------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 400  | Malformed or invalid input (`details.issues[]` per field)                 |
| `UNAUTHORIZED`     | 401  | Missing/invalid credentials (operator token, webhook signature)           |
| `FORBIDDEN`        | 403  | Authenticated but not allowed                                             |
| `NOT_FOUND`        | 404  | Unknown order reference, participant, or legacy ticket token              |
| `CONFLICT`         | 409  | State does not allow the operation (sold out, already paid, already used) |
| `RATE_LIMITED`     | 429  | Too many requests                                                         |
| `UPSTREAM_ERROR`   | 502  | ePayco (or another provider) failed to answer correctly                   |
| `INTERNAL_ERROR`   | 500  | Unexpected; the real cause is only in logs                                |

### Authentication

| Audience             | Mechanism                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ePayco webhook       | Provider-authenticated notification (`webhooks-epayco`), validated server-side before any order changes; `verify_jwt = false`. The Wompi checksum mechanism below is legacy                                                                                      |
| Public buyer API     | No user account. `GET`/retry require the order reference **and** the buyer email (`X-Buyer-Email`); abuse control = strict validation, per-IP/per-reference rate limits, order-scoped opaque identifiers                                                         |
| Maintenance jobs     | `Authorization: Bearer <MAINTENANCE_API_TOKEN>` (shared secret, ≥32 chars, constant-time comparison); `verify_jwt = false`                                                                                                                                       |
| Operator check-in UI | Supabase Auth: `Authorization: Bearer <access token>` verified by Supabase Auth, plus an active row in `public.operators` (role `OPERATOR`/`ADMIN`). 401 = not authenticated; 403 = authenticated but not an active operator. There is no shared operator secret |
| Admin/maintenance    | Not exposed publicly. Privileged work runs with the service key inside functions only                                                                                                                                                                            |

`verify_jwt = false` is set in `supabase/config.toml` per function; every public endpoint
authenticates its own callers as listed above.

## 2. Endpoints

> **Provider status.** ePayco Smart Checkout V2 is the only checkout the buyer frontend opens;
> `POST /webhooks-epayco` is the active confirmation endpoint. The `/webhooks/wompi` section and
> the ticket-era endpoints below are kept as historical reference only: Wompi is not used for
> this event, and no purchase issues a ticket or a QR code.

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
      "serverTime": "2026-10-25T15:00:00.000Z",
      "ticketTypes": [
        {
          "code": "GENERAL",
          "name": "Entrada general",
          "description": null,
          "minPerOrder": 1,
          "maxPerOrder": 4,
          "salesOpen": true,
          "availability": "LOW",
          "currentTier": {
            "name": "Preventa",
            "sequence": 1,
            "priceInCents": 15990000,
            "maxPerOrder": 1
          },
          "salesWindow": {
            "startsAt": "2026-10-25T15:00:00.000Z",
            "endsAt": "2026-10-29T05:00:00.000Z"
          }
        }
      ]
    }
  }
}
```

`serverTime` is the database clock when the projection was built, and `salesWindow` is the
half-open window of the stage that is open (`startsAt <= now < endsAt`). The storefront uses
both to time its own boundary timers; neither is an authorization — every quote and every order
re-reads the stage with `now()` inside its transaction.

`currentTier.maxPerOrder` is the stage's per-order cap (Preventa: `1`; General: `null`, i.e. no
cap beyond the shared inventory). It is disclosed so the storefront caps its selector from the
same value the API enforces.

When no stage is open — before the campaign, in the one-minute gap between stages, or after it
ends — the response is still `200` with `salesOpen: false`, `availability: "NOT_STARTED"`,
`currentTier: null` and `salesWindow: null`.

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
  "pricingTier": { "name": "Preventa 1", "sequence": 1, "unitPriceInCents": 9500000,
                    "maxPerOrder": null },
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

**Stage and inventory are one read each, inside the database (migration `20261024230000`).** The
stage is the lowest `sequence` whose half-open window contains `now()`; there is no other way to
select one, so a client cannot ask for a closed stage. Inventory is a single pool of 100
admissions for the whole event — Preventa, General and the package all draw from it and no stage
has its own quota. A quote reports `availability` (`AVAILABLE` / `LOW` / `SOLD_OUT`) and
`availableQuantity`, but the reservation happens only in `POST /orders`, under a row lock on the
event, and refuses with `CONFLICT / SOLD_OUT` when the pool cannot cover the request.

**Purchase limits belong to the sales stage.** `pricingTier.maxPerOrder` is the cap the stage
enforces on one order and is returned so the storefront can cap its selector from the same value
the API uses. The seeded Preventa stage carries `1`: a single admission per payment, so
`quantity > 1` is refused with `CONFLICT` / `QUANTITY_LIMIT` by both `/orders/quote` and
`/orders` — the UI cannot be bypassed. General has no stage cap (`maxPerOrder: null`), so two or
three individual admissions stay valid while inventory permits; the ticket type's
`max_per_order` still applies on top. `SHARE_EXPERIENCE` is one package of exactly three
admissions for a fixed COP 509,700 total (COP 169,900 each): any other quantity is refused with
`BUNDLE_QUANTITY_INVALID`, and the package is refused with `BUNDLE_NOT_AVAILABLE` while its
General stage is not the active one. The retired `DOUBLE_EXPERIENCE` (two admissions, COP
340,000) is no longer accepted in a request: historical orders keep reading it from their own
stored row.

That last refusal is identical on both paths — `/orders/quote` and `/orders` — because creation
checks the stage before delegating (migration `20261024200000`). A client that bypasses the UI
therefore learns the product is not on sale yet, not that the current stage sells one ticket.
An idempotency replay is exempt: a key that already names an order keeps receiving that order,
even if the sales window has since moved (the QA window is restored rather than advanced), and
only a new purchase is judged by the stage.

On the wire both refusals are an HTTP `409 CONFLICT` with the generic Spanish message plus a
safe `details.reason` from a closed allowlist — `QUANTITY_LIMIT` or `BUNDLE_NOT_AVAILABLE` — so
the storefront can explain the rule instead of showing one generic conflict:

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "La operación no se puede completar con el estado actual.",
    "details": { "reason": "BUNDLE_NOT_AVAILABLE" }
  }
}
```

Nothing else is echoed: `SOLD_OUT`, `IDEMPOTENCY_KEY_CONFLICT`, constraint text, SQLSTATE
messages and provider payloads stay behind the generic message (they are only logged server-side
as `context.detail`). A `CONFLICT` outside the allowlists has no `details` at all.

Named product: **Comparte tu experiencia** is selected only by sending
`"bundleCode": "SHARE_EXPERIENCE"` with quantity `3`. The database prices that product at
`50970000` centavos ($509,700 COP), reserves **three** admissions from the shared event pool
during the General stage, rejects promo codes with the bundle, and refuses it with `SOLD_OUT`
when fewer than three admissions remain. Without `bundleCode`, a quantity of three represents
three individual General admissions at $600,000 COP; it never receives the package price
automatically.

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
  "checkout": { "provider": "epayco", "sessionId": "…", "publicKey": "…", "test": true,
                "reference": "EVT-2026-000001", "amountInCents": 14250000, "currency": "COP",
                "redirectUrl": "https://evento.example/gracias",
                "confirmationUrl": "https://<project>.supabase.co/functions/v1/webhooks-epayco",
                "customerData": { "email": "comprador@example.com", "fullName": null,
                                  "phoneNumber": null, "phoneNumberPrefix": null } } } }
```

Both `redirectUrl` and the ePayco session's `response` are the configured return URL **with
`?ref=<order reference>` appended**, so the post-payment page can name the purchase without
depending on browser storage (`/gracias` otherwise arrives bare, since ePayco only adds its own
`ref_payco`). The parameter is a convenience, never proof: `GET /orders/{reference}` still
requires the buyer email, and the amount and state always come from the database.

Errors: `VALIDATION_ERROR` (input, `details.issues[]` for participant fields), `NOT_FOUND`
(unknown event or ticket type), `CONFLICT` (`SOLD_OUT`, `DISCOUNT_EXHAUSTED`, `QUANTITY_LIMIT`,
`IDEMPOTENCY_KEY_CONFLICT`, plus the checkout-session reasons below), `RATE_LIMITED`.
`QUANTITY_LIMIT` and `BUNDLE_NOT_AVAILABLE` also travel in `details.reason` (see
`POST /orders/quote`); every other conflict stays generic.

**One live ePayco session per attempt (migration `20261024170000`).** ePayco mints a new
transaction id every time a Smart Checkout session is opened, and `payments` keeps exactly one
transaction id per reference — so a second session for the same invoice is what produced an
approval the database could not apply. The handler now asks the database first:

- a replay with the same `Idempotency-Key` **returns the session that already exists** and does
  not call ePayco at all (`replayed: true`, same `checkout.sessionId`);
- a fresh order claims a short lease and creates exactly one session;
- a second request for the same attempt while that lease is held answers `CONFLICT`
  (server detail `CHECKOUT_LEASE_ACTIVE`) instead of racing;
- an attempt that can no longer be paid — the order is not `PENDING`, its reservation elapsed,
  the provider already recorded a transaction for it, or a `payment/session/create` for this
  invoice was authorized and its outcome is unknown — answers `CONFLICT` with the machine
  detail `ORDER_NOT_PENDING`, `RESERVATION_EXPIRED`, `TRANSACTION_RECORDED` or
  `SESSION_CALL_UNRESOLVED`. The buyer's next step is `POST /orders/{reference}/retry`, which
  creates attempt _N_ with its own reference and therefore its own session.

**One provider call per invoice (migration `20261025120000`).** A session create that outlives
its 30 s lease, or that fails with a timeout/5xx after ePayco may have accepted it, leaves
`payments.checkout_call_unresolved` set. ePayco registers the invoice on the transaction it
creates, so a second call would return "ya cuenta con un registro previo"; the attempt is
refused with `SESSION_CALL_UNRESOLVED` instead. The marker clears only when a session is
recorded or when the provider rejected the request outright (4xx validation/auth), and a new
attempt is always a new invoice.

`checkout.sessionId` is either the stored session or the one this request just created, and a
session the database refused to record is never handed to the browser.

These refusals also carry the code-like reason in `details.reason`, so the storefront can tell
"wait a moment" (`CHECKOUT_LEASE_ACTIVE`, `CHECKOUT_SESSION_NOT_RECORDED`) from "choose your
tickets again" (`ORDER_NOT_PENDING`, `RESERVATION_EXPIRED`, `TRANSACTION_RECORDED`,
`SESSION_CALL_UNRESOLVED`) instead of showing a sold-out notice. The `message` stays generic in
Spanish and no SQLSTATE, provider text or buyer data is disclosed; a `CONFLICT` outside that
allowlist has no `details`, and the storefront falls back to its sold-out copy. Anything else
stays in the server log (`context.detail`).

The checkout payload is secret-free: the ePayco session id plus the public flags and the amount
the database wrote. No private key ever reaches the browser. A supplied code that cannot be
applied fails the order instead of silently charging the full price.

The order also records the provider on its attempt-1 payment row. `create_order` takes
`p_payment_provider` and refuses a missing value (`VALIDATION_ERROR`), so a payment can never be
stored under the wrong provider's default and then be reconciled against it.

When the ePayco session is created, `confirmation` is sent together with an explicit
`method: "POST"`. Smart Checkout treats the pair as the webhook registration: without the verb it
does not reliably deliver the signed confirmation, and a paid order stays PENDING because the
backend never sees it. The webhook URL is always `<API_BASE_URL>/webhooks-epayco` — never the
frontend origin.

#### Which evidence confirms a payment

The delivery is the authority ePayco documents. Its `x_signature` is
`SHA256(p_cust_id_cliente ^ p_key ^ x_ref_payco ^ x_transaction_id ^ x_amount ^ x_currency_code)`,
computed with our merchant keys, so a verified delivery is authentically ours.

1. Signature mismatch → `401 SIGNATURE_MISMATCH`, nothing is claimed.
2. A sandbox delivery received while the backend runs live → rejected for review.
3. The backend then re-reads the transaction from ePayco's validation API. If the record
   **contradicts** the signed fields (amount, currency, reference, transaction id, merchant,
   test flag) the delivery is rejected for review and never applied.
4. If the lookup answers **404** — a signed delivery naming a transaction ePayco says does not
   exist — the webhook answers `503` and ePayco retries; nothing is claimed.
5. If the lookup is **unavailable** (transport error, non-JSON, HTTP 5xx/429, or ePayco's
   generic `{"status":false,"message":"Error de datos o conexión."}`), the confirmation is
   applied from the signed delivery instead of being blocked. The validation API is an
   unauthenticated GET protected only by TLS; the delivery is the authenticated channel, and
   `confirm_payment` still re-checks amount, currency and reference against the order before
   anything becomes `PAID`. A delivery whose amount cannot be read as exact centavos, or that
   has no reference/invoice, is never confirmed this way (`503`, retried).

The staging run on 2026-10-24 hit case 5: the validation endpoint answered the generic error
for the merchant's approved transaction, for its historical reference and for a session id
alike, so no lookup could ever succeed and every paid sandbox order stayed PENDING.

### `GET /orders/{reference}` — implemented (Phase 4)

Buyer-facing status, safe fields only. The order reference is sequential and therefore
enumerable, so the endpoint requires the buyer email in the `X-Buyer-Email` header. A wrong
email and an unknown reference return the **same** `404 ORDER_NOT_FOUND`, so the endpoint
cannot be used to discover which orders exist.

Tickets are discontinued: the response carries the order's **admissions** and a names-only
**participant roster** instead of ticket tokens and per-ticket email counts. The roster is
returned only for a `PAID` order; while the order is pending the fields exist but are empty
(`participants: []`). A two-admission purchase starts with one assignment (the buyer) and
`admissions.remainingUnassigned: 1`, which drops to `0` once the companion is attached with
`POST /orders/{reference}/participants`.

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
    "admissions": { "quantity": 3, "assigned": 2, "remainingUnassigned": 1 },
    "participants": [
      { "unit": 1, "firstName": "Ana", "lastName": "Pérez" },
      { "unit": 2, "firstName": "Beto", "lastName": "Gómez" }
    ]
  }
}
```

`admissions` is derived from the order lines (`quantity`), the participant rows
(`assigned`) and their difference (`remainingUnassigned`) — never from ticket rows. The
roster is names only, numbered in attachment order (`unit: 1` is the holder), and is the
refresh-proof answer to "is the companion already registered?"

The projection is a SQL whitelist: it never returns cédula, email, phone, city, participant
id, IP, user agent, Wompi transaction id, integrity signature or `provider_payload`.
Validation: the reference must match `EVT-<year>-<sequence>`; the email must be non-empty.
Rate-limited per order reference (§3).

**Compatibility note (ticket removal).** The ticket-era fields `tickets` and
`confirmation` are no longer returned. They only ever described ticket issuance and the
per-ticket email outbox, both of which are gone, so keeping empty copies would have implied
a capability that does not exist. The only in-repo consumer (the buyer frontend) already
ignores them.

### `POST /orders/{reference}/retry` — implemented (Phase 4)

Creates a new payment attempt with a **fresh payment reference** for a `FAILED` or `EXPIRED`
order (a used reference can never be reused). Requires the same reference + buyer email
possession check. The order, its frozen price and its history are preserved; an `EXPIRED`
order re-reserves at the original stage and price (`SOLD_OUT` if no longer possible).

The new attempt gets its own ePayco session, pinned to `EVT-…-N`. Creating attempt _N_ also
closes the previous attempt's live session in `checkout_sessions` with the recorded reason
`NEW_ATTEMPT`, so "which session belongs to which attempt" stays auditable instead of inferred.

```json
// POST /orders/EVT-2026-000002/retry  (X-Buyer-Email header or { "email": "…" })
{ "ok": true, "data": {
  "reference": "EVT-2026-000002", "status": "PENDING", "paymentAttempt": 2,
  "totalInCents": 19000002, "currency": "COP", "reservationExpiresAt": "…",
  "checkout": { "provider": "epayco", "sessionId": "…", "publicKey": "…",
                "test": true, "reference": "EVT-2026-000002-2",
                "amountInCents": 19000002, "currency": "COP",
                "redirectUrl": "…", "confirmationUrl": "…", "customerData": { … } } } }
```

Errors: `NOT_FOUND` (unknown reference or wrong email), `CONFLICT` (`ORDER_ALREADY_PAID`,
`ORDER_NOT_RETRYABLE`, `TOO_MANY_ATTEMPTS`, `SOLD_OUT`), `VALIDATION_ERROR`. The checkout
payload is built from the row the database just wrote, so amount and reference cannot disagree
with what is stored.

### `POST /orders/{reference}/payment-hint` — implemented (Phase 5)

Recovery path for a lost webhook. The ePayco return carries `?ref_payco=<transaction_id>` (the
legacy Wompi `?id=` shape is still parsed); the frontend posts that id here so the backend can
re-read the transaction from ePayco and run the SAME confirmation as the webhook. **The hint is
never trusted**: reference, amount, currency and transaction id are validated against the buyer's
own payment before anything is confirmed, and an attempt already attached to a different
transaction is refused (`MISMATCH`).

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
`RECONCILIATION_REQUIRED`) plus `TRANSACTION_NOT_FOUND` when the provider does not know the id.
Errors: `NOT_FOUND` (unknown reference or wrong email — identical responses),
`VALIDATION_ERROR` (id shape), `UPSTREAM_ERROR` (ePayco unavailable; retry).

### `POST /orders/{reference}/participants` — implemented (Phase 5)

Attaches a person to a **remaining admission** of a paid order and records consent evidence
with value, timestamp and policy version. Server-side validation (`parseParticipantInput`)
strips unknown fields, so a client cannot set price, status, ids or the admission. Consent to
personal data processing is mandatory.

Tickets are discontinued: the order is the source of truth. Capacity is
`sum(order_items.quantity)` and the buyer's own participant (written by `POST /orders`) already
occupies one admission, so the companion of a two-admission purchase (`quantity: 2` or the
`DOUBLE_EXPERIENCE` bundle) is attached with a single call here.

Headers: `X-Buyer-Email: <email>` (or `{ "email": "…" }` in the body).

```json
// POST /orders/EVT-2026-000001/participants
{ "participant": { "firstName": "Ana", "lastName": "Pérez", "nationalId": "1.020.456.789",
                   "email": "ana@example.com", "phone": "+57 300 123 4567", "city": "Bogotá",
                   "instagram": "@ana.perez",
                   "consents": { "dataProcessing": true, "futureEvents": false } },
  "consentPolicyVersion": "2026-v1" } // optional
// response (201)
{ "ok": true, "data": {
  "orderReference": "EVT-2026-000001",
  "unit": 2,
  "participant": { "participantId": "…", "firstName": "Ana", "lastName": "Pérez" },
  "consents": { "dataProcessing": true, "futureEvents": false,
                 "policyVersion": "2026-v1", "capturedAt": "…" },
  "remainingUnassigned": 0 } }
```

The response never echoes cédula, email or phone back over the wire, and no ticket token or
QR is issued. `unit` is the 1-based admission ordinal inside the order. Concurrent calls on
the same order are serialized with `FOR UPDATE` on the order row, so the last admission is
never assigned twice. Errors: `NOT_FOUND` (unknown reference, wrong email or a participant of
another order — all identical), `CONFLICT` (`ORDER_NOT_PAID`, `NO_ASSIGNABLE_UNIT`),
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

### `POST /webhooks/wompi` — legacy, not used for this event

Wompi is retired as a purchase provider. This section documents the historical confirmation
path. The active endpoint is `POST /webhooks-epayco` (provider validation + invoice mapping).

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
   `PAID`, convert reserved inventory to sold and enqueue the participant projection for the
   Google Sheet — all in one transaction. No ticket, token or email row is created.
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
confirmation-email dispatch (legacy outbox), the **payment reconciliation sweep**, the
**post-purchase email retry** (`postPurchaseEmails` counters: `claimed`, `sent`, `failed`,
`abandoned`, `skipped`; rows stay `QUEUED` while `EMAIL_ENABLED=false`), rate-limit counter
cleanup, and the **Google Sheets projection** (when configured). Authenticated by
`Authorization: Bearer <MAINTENANCE_API_TOKEN>` compared in constant time; intended for the
`scheduler (pg_cron → pg_net → this endpoint, migration 015) or an operator, never for the
browser. Every job is idempotent and concurrent-safe (`SKIP LOCKED`claims), so overlapping
runs are harmless. Expiry/email failures fail the run (500); the Phase 5 jobs are isolated and
reported in`jobErrors` without stopping the rest. If it never runs, no payment is lost and no
ticket is wrong: inventory stays reserved longer, emails and the sheet wait, and unreconciled
payments remain visible.

### `GET /tickets/{token}` — legacy, not used by the purchase flow

Tickets are no longer issued, so this endpoint only answers for historical rows. Public-safe
ticket lookup for the holder (function `tickets`). The opaque token IS the
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

| Endpoint                              | Auth                                | Safety / idempotency                                                                                   | Rate-limit scope      |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------- |
| `GET /health`                         | none (public)                       | read-only                                                                                              | —                     |
| `GET /events/{code}`                  | none (public)                       | read-only, whitelisted projection                                                                      | `events:read`         |
| `GET /events/{code}/availability`     | none (public)                       | read-only                                                                                              | `events:read`         |
| `POST /orders/quote`                  | none (public)                       | pure computation; stores nothing                                                                       | `orders:quote`        |
| `POST /orders`                        | none (public)                       | price/inventory re-validated inside the SQL transaction                                                | `orders:create`       |
| `GET /orders/{ref}`                   | reference + `X-Buyer-Email`         | read-only; wrong email is indistinguishable from unknown reference                                     | `orders:status`       |
| `POST /orders/{ref}/retry`            | reference + buyer email             | **new** payment reference per attempt (legacy `wompiReference` column); a consumed one is never reused | `orders:retry`        |
| `POST /orders/{ref}/participants`     | reference + buyer email             | validated inside the transaction; guarded by the reservation window                                    | `orders:participants` |
| `PUT /orders/{ref}/participants/{id}` | reference + buyer email             | foreign participant id is answered as `NOT_FOUND`                                                      | `orders:participants` |
| `POST /orders/{ref}/payment-hint`     | reference + buyer email             | safe to repeat; same confirmation pipeline as the webhook                                              | `orders:hint`         |
| `GET /tickets/{token}`                | opaque token (capability)           | read-only; whitelisted projection                                                                      | `tickets:lookup`      |
| `POST /check-in`                      | Supabase Auth + active operator     | first scan wins; outcome is in the 200 body                                                            | `checkin:operator`    |
| `GET /check-in/{token}`               | Supabase Auth + active operator     | read-only admission view                                                                               | `checkin:operator`    |
| `POST /webhooks/wompi`                | event checksum + private-key lookup | dedupe key per event; replays answer from the ledger                                                   | — (provider)          |
| `POST /orders-maintenance`            | `Bearer <MAINTENANCE_API_TOKEN>`    | every job idempotent + `SKIP LOCKED`                                                                   | — (scheduler)         |

`checkin:attempt` (IP, token-less requests only) additionally covers `POST /check-in` — see §3.
