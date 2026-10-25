# Wompi integration (retired)

> **Status: retired.** Wompi is not a checkout provider for this event; `PAYMENT_PROVIDER`
> accepts only `epayco`, and the backend no longer builds a Wompi checkout. This document is
> kept as the reference for the **dormant** `webhooks-wompi` function and for historical
> `payments` rows. Everything below describes how Wompi works, not how this site sells.

All facts below were read from the **official documentation** on **2026-10-03** and are the
basis for the code in `supabase/functions/_shared/integrations/wompi/`. Nothing here is taken
from third-party tutorials.

Sources (docs.wompi.co, Colombia):

| Topic                                      | URL                                          |
| ------------------------------------------ | -------------------------------------------- |
| Environments and keys                      | `/docs/colombia/ambientes-y-llaves/`         |
| Widget / Web Checkout, integrity signature | `/docs/colombia/widget-checkout-web/`        |
| Transactions API, statuses, error codes    | `/docs/colombia/transacciones/`              |
| Events (webhooks) and checksum             | `/docs/colombia/eventos/`                    |
| Sandbox test data                          | `/docs/colombia/datos-de-prueba-en-sandbox/` |

---

## 1. Environments and credentials

|                  | Sandbox                       | Production                       |
| ---------------- | ----------------------------- | -------------------------------- |
| API base URL     | `https://sandbox.wompi.co/v1` | `https://production.wompi.co/v1` |
| Public key       | `pub_test_…`                  | `pub_prod_…`                     |
| Private key      | `prv_test_…`                  | `prv_prod_…`                     |
| Integrity secret | `test_integrity_…`            | `prod_integrity_…`               |
| Events secret    | `test_events_…`               | `prod_events_…`                  |

The two environments are completely separate: transactions created in Sandbox do not exist in
Production and vice versa. Credentials are **per environment**, and an event URL must be
configured for each environment so sandbox and production data can never be mixed.

Implementations in this repository:

- `_shared/config/env.ts` derives the Wompi environment from `APP_ENV` (only
  `APP_ENV=production` selects production) and **rejects credentials whose prefix does not
  match** that environment, at startup.
- `WOMPI_BASE_URL` may only be overridden when `APP_ENV=development` (used to point tests at a
  local fake); a deployed environment always talks to the real host.
- The **private key** is used only server-side (`GET /v1/transactions/{id}`).
- The **integrity secret** never leaves the backend: the frontend receives the computed hash,
  never the secret.

## 2. Payment flow chosen: Widget / Web Checkout

Wompi offers Widget/Web Checkout (redirect or embedded button) and a direct API
(`POST /v1/transactions`). We use **Widget / Web Checkout** because no card data ever touches
our code or infrastructure, which keeps the PCI surface at zero.

Required parameters (documented):

| Parameter             | Notes                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `public-key`          | `pub_test_…` / `pub_prod_…`                                                                        |
| `currency`            | `COP` only                                                                                         |
| `amount-in-cents`     | Amount in cents; `$95.000 COP` → `9500000`                                                         |
| `reference`           | Unique per payment; alphanumeric plus `-` and `_`; max 255 chars; once used it can never be reused |
| `signature:integrity` | SHA-256 hash described below                                                                       |

Optional parameters we will use later: `redirect-url`, `expiration-time`, `customer-data:*`
(email, name, phone, legal id) and `tax-in-cents:*`. `expiration-time` is a double-edged
feature: it activates a countdown in the checkout, and it **changes the integrity signature**,
so it must be generated once and used verbatim in both places.

### Integrity signature

```
SIGNATURE = SHA256( reference + amount_in_cents + currency + [expiration-time] + integrity_secret )
```

Documented example (published by Wompi, reproduced so the test suite can assert it):

```
input:  sk8-438k4-xmxm392-sn2m 2490000 COP prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6
output: 37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5
```

Notes captured from the documentation:

- The value order matters and is exactly as written above; with `expiration-time` the date goes
  **before** the secret.
- Wompi's own example produces a **lowercase** hex digest; the event checksum example is shown in
  uppercase. Comparisons must therefore be case-insensitive.
- Wompi recommends computing this on the server — we do (the secret must never reach a browser).
- Implementation: `_shared/integrations/wompi/signature.ts`, tested against the vector above and
  against an independent SHA-256 implementation.

## 3. Events (webhooks)

Envelope (any event):

```json
{
  "event": "transaction.updated",
  "data": { "transaction": { "…": "…" } },
  "sent_at": "2018-07-20T16:45:05.000Z",
  "signature": {
    "properties": ["transaction.id", "transaction.status", "transaction.amount_in_cents"],
    "checksum": "…",
    "timestamp": 1530291411
  }
}
```

Checksum:

```
CHECKSUM = SHA256( concat(data[p] for p in signature.properties) + signature.timestamp + events_secret )
```

Critical details that our implementation respects (`_shared/integrations/wompi/events.ts`):

1. **`properties` varies per event and over time.** It must be read from the payload and never
   hardcoded; the code resolves the dotted paths in the order received.
2. **`sent_at` is not part of the hash** (it is the first-notification timestamp); only
   `signature.timestamp` (UNIX seconds) is.
3. The same checksum is mirrored in the **`X-Event-Checksum` header** _and_ in
   `signature.checksum`; either source may be used. The current documentation only shows the
   **header** (the field can be absent from the payload), so the header is the primary source
   and a missing field is not a rejection. The `signature` object itself must still be present,
   because `properties` and `timestamp` cannot be reconstructed.
4. The **events secret** (not the private key) is used for this hash.
5. If a listed property cannot be resolved to a scalar, or resolves to a non-integer number, the
   event is **rejected** rather than guessed — a rejected event cannot mark anything as paid.
6. Delivery is **at-least-once**: a non-200 response is retried after 30 minutes, 3 hours and
   24 hours. Duplicates are expected and must be harmless.
7. The current documentation puts `timestamp` and `environment` at the **top level** of the
   envelope; older examples nest them inside `signature`. The parser accepts either location
   and **rejects a payload where both disagree** (`AMBIGUOUS_TIMESTAMP`) instead of choosing
   one silently. A delivery from the wrong environment is rejected (`ENVIRONMENT_MISMATCH`).

Our HTTP contract for the endpoint (**implemented in Phase 4**,
`_shared/api/webhook-handler.ts`): always answer **200** once the event has been authenticated
_and_ durably recorded, even when it is a duplicate, ignored or requires manual reconciliation;
answer `401`/`400` only for a delivery that is not authentic, and `503` only when a retry is
genuinely useful (Wompi unreachable, database outage). Every refusal that can be fingerprinted
is itself recorded in `payment_events` with `checksum_valid = false`, so spoofing attempts are
auditable.

## 4. Transaction statuses

| Wompi status  | Meaning                         | Internal status | Terminal           |
| ------------- | ------------------------------- | --------------- | ------------------ |
| `PENDING`     | Created, still being processed  | `pending`       | no                 |
| `APPROVED`    | Approved, payment completed     | `approved`      | yes                |
| `DECLINED`    | Declined (funds, data…)         | `declined`      | yes                |
| `VOIDED`      | Voided (card transactions only) | `voided`        | yes                |
| `ERROR`       | Error during processing         | `error`         | yes                |
| anything else | Unknown to us                   | `unknown`       | no (never success) |

Both representations are stored: `raw_wompi_status` (exactly what Wompi sent) and the
normalized internal value. `unknown` is non-terminal and never successful, so a future Wompi
status cannot accidentally confirm an order.

Wompi has **no `REFUNDED` status**: an approved transaction that is later voided arrives as
`VOIDED`, which the backend records as the internal `refunded` (the money came back) while
keeping `approved_at` as the historical fact.

## 5. Server-side transaction verification

```
GET https://production.wompi.co/v1/transactions/{transaction_id}
Authorization: Bearer prv_prod_…
```

The documentation is explicit: **transactions can only be queried with the private key from a
backend**; queries from the frontend are no longer supported and public-key requests now return
`404`. That is the technical reason the browser can never be the source of truth for a payment.

Our client (`_shared/integrations/wompi/client.ts`):

- `Authorization: Bearer <private key>`, `Accept: application/json`, per-request timeout.
- Retries only idempotent GETs, and only on network errors, `429` and `5xx`.
- Parses the response with a schema and **fails closed**: an unexpected payload raises an
  upstream error instead of being interpreted as a successful payment.
- Captures `error.type` (for example `DUPLICATE_REFERENCE` on a reused reference, or invalid
  amount / invalid key errors) without copying response bodies — they can contain customer email
  addresses — and never logs or returns the private key.

The same lookup powers **recovery** (Phase 5):

- **Automatic reconciliation** (maintenance): claim due `pending`/`unknown` attempts that have a
  transaction id, re-read the transaction, validate reference/amount/currency, then run the SAME
  `confirm_payment` as the webhook. Bounded by the schedule and the attempt budget; terminal
  outcomes stop sweeping. PAID orders are excluded (a second approval would violate the
  one-approved-payment index).
- **Buyer payment hint** (`POST /orders/{reference}/payment-hint`): the redirect carries
  `?id=<transaction_id>`; the buyer posts it and the backend re-reads/validates it. The hint is
  never proof, and an attempt already attached to a different transaction is refused
  (`MISMATCH`).

Because Wompi cannot be queried by reference, these two paths are the only way to recover a
payment whose webhook never arrived.

## 6. References

- Unique per purchase; once used, never reusable → an order has one traceable reference
  (`EVT-2026-000001`) and every **payment attempt** gets its own
  (`EVT-2026-000001`, `EVT-2026-000001-2`, …), so a retry after a declined attempt is possible
  while traceability is preserved.
- Charset: alphanumeric plus `-` and `_`; max 255 characters. Validated before anything is sent
  (`_shared/domain/reference.ts`).
- Uniqueness is guaranteed by a database sequence and a unique constraint, never by randomness.

## 7. Duplicate webhooks and idempotency

Wompi retries on non-200 responses, and a transaction can legitimately change state more than
once (`PENDING` → `APPROVED`, or → `DECLINED`, later possibly `VOIDED`). Design consequences:

1. The `payment_events` table stores an event dedupe key (unique) so the same delivery has
   exactly one effect, and gives operators a full audit trail of what arrived, when, and what we
   did. A concurrent duplicate loses the insert and is answered `200` with the winner's recorded
   outcome.
2. Payment state advances **forward only** (`advancePaymentStatus` and the SQL
   `payment_transition_rank`): terminal states never regress, so replays and out-of-order
   deliveries are harmless. An approved attempt a later `VOIDED` means `refunded`; a later
   `DECLINED`/`ERROR` only updates the raw Wompi string.
3. Ticket issuance is keyed per order item/unit (`unique (order_item_id, order_item_seq)`);
   emails are keyed per `(ticket, template)` (`email_deliveries.idempotency_key`, unique). A
   repeated event therefore cannot create a second payment, ticket, QR or email.
4. Ticket tokens are random and stored once; re-delivering an event never regenerates a QR for an
   already-issued ticket.

## 8. Sandbox testing

Documented test values (Sandbox only):

| Payment method                     | Approved              | Declined              |
| ---------------------------------- | --------------------- | --------------------- |
| Card                               | `4242 4242 4242 4242` | `4111 1111 1111 1111` |
| Nequi / Daviplata token            | phone `3991111111`    | phone `3992222222`    |
| PSE (`financial_institution_code`) | `1`                   | `2`                   |

Any other card produces a final `ERROR` state. Expiry/CVC date are irrelevant in Sandbox.
These let Phase 6 exercise `APPROVED`, `DECLINED` and `ERROR` end to end without real money,
including the lost-webhook cases (kill the webhook, then recover via the sweep or the hint).

## 9. What is implemented now vs later

| Item                                                       | Status                                                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrity signature (with the official vector)             | **implemented + tested**                                                                                                                           |
| Event envelope parsing and checksum verification           | **implemented + tested**                                                                                                                           |
| Status mapping (raw + normalized) + forward-only advance   | **implemented + tested**                                                                                                                           |
| Reference formats and validation                           | **implemented + tested**                                                                                                                           |
| Private-key transaction client (fake-fetch tested)         | **implemented + tested**; live call pending credentials                                                                                            |
| Order creation / price calculation                         | **implemented + tested** (Phase 3: `create_order`, `quote_order_price`)                                                                            |
| Checkout preparation (safe payload + integrity signature)  | **implemented + tested** (Phase 3: `_shared/integrations/wompi/checkout.ts`)                                                                       |
| Webhook endpoint + payment processing + ticket issuance    | **implemented + tested** (Phase 4; see [phases/phase-04.md](phases/phase-04.md))                                                                   |
| Email outbox + idempotent confirmation delivery            | **implemented + tested** with an injected Resend client; live send pending credentials                                                             |
| Payment retry with a fresh reference + order expiry        | **implemented + tested** (Phase 4)                                                                                                                 |
| Automatic reconciliation job (re-check `PENDING` payments) | **implemented + tested** (Phase 5: claim → lookup → validate → same `confirm_payment`; bounded schedule/attempts; SQL verified on real PostgreSQL) |
| Buyer payment hint for lost webhooks                       | **implemented + tested** (Phase 5: `POST /orders/{reference}/payment-hint`, reference+email gated, mismatch refused)                               |

Live sandbox calls remain pending credentials (Phase 6).

### 9.1 Checkout preparation (Phase 3)

`POST /orders` returns a checkout payload built by `buildWompiCheckout`. It contains exactly:
`publicKey`, `currency`, `amountInCents`, `reference`, `integritySignature`, `expirationTime`,
`redirectUrl`, `customerData`. A test asserts the serialized payload contains no integrity
secret, no private key, no events secret and no Supabase secret key.

The amount and reference are **not** parameters of the request: they come from the order the
database just wrote, so there is no path where a client-supplied amount could be signed.
`expiration-time` is formatted once and used verbatim in both the signature and the payload —
the two can never disagree. It is disabled by default (see §10) but fully supported.

### 9.2 Confirmation pipeline (Phase 4)

`POST /webhooks/wompi` implements the contract in §3: checksum verification → event claim in
`payment_events` → `GET /v1/transactions/{id}` with the private key → validation against the
order (reference, amount, currency) → `confirm_payment` (payment, order, inventory and tickets
in one transaction) → `queue_ticket_emails` inside the same transaction → ledger finalization
→ outbox dispatch after commit. A duplicate delivery is answered `200` from the ledger without
reprocessing. The full behaviour, including the reconciliation path for an approval that
arrives after the order became terminal, is documented in
[phases/phase-04.md](phases/phase-04.md).

`GET /orders/{reference}` (reference + buyer email) returns the buyer-facing projection and the
ticket tokens once paid; `POST /orders/{reference}/retry` creates a new attempt with a fresh
reference for a failed or expired order, reusing the order and its frozen price.

### 9.3 Reconciliation and the payment hint (Phase 5)

Wompi's webhook is at-least-once but not guaranteed: a delivery can be lost entirely. Since
Wompi cannot be queried by reference, recovery has two paths, both converging on the same
`confirm_payment` transaction as the webhook:

1. **Automatic sweep** (`orders-maintenance`, every 5 minutes via pg_cron): claim attempts with a
   known transaction id that are due and below the attempt budget; re-read the transaction;
   validate reference/amount/currency; confirm. Outcomes are recorded on the payment
   (`last_reconciliation_result` / `last_reconciliation_failure`); terminal results clear the
   schedule, transient failures retry in 2 minutes.
2. **Buyer hint** (`POST /orders/{reference}/payment-hint`): the checkout redirect carries
   `?id=<transaction_id>`; the buyer returns that id and the backend re-reads it with the private
   key. A recorded transaction id can never be swapped (`MISMATCH`), an id Wompi does not know is
   reported as `TRANSACTION_NOT_FOUND`, and a failed lookup is an upstream error the frontend may
   retry.

An approval for an order that is no longer payable goes through `confirm_payment` and becomes
`RECONCILIATION_REQUIRED`: recorded as a fact, never reviving the order, issuing no ticket and
inventing no refund — an operator reviews it.

## 10. Open questions for the client / Wompi account

1. Which payment methods should be enabled in the checkout? `PSE`, `NEQUI` and Bancolombia
   transfer introduce **delayed approval**: the transaction stays `PENDING` and can be approved
   hours later, which affects reservation expiry and the wording of the confirmation email.
2. Which account will be used, and is Web Checkout already enabled on it?
3. Should `expiration-time` be used (it changes the signature inputs and the checkout UX)?
4. Is a `redirect-url` page planned in the frontend for the "we are confirming your payment"
   state? (Informative only — it must never be treated as proof of payment.)
5. Refund policy: refunds are **not initiated** by the backend; if they are needed, the process
   must be designed with the client (and probably with Wompi support). Since Phase 4 an
   approved-then-voided attempt is recorded as `refunded` with its approval timestamp, so the
   database already carries the resulting state.
6. **Should `expiration-time` be used in the checkout?** Supported by the implementation and the
   signature, currently off. Enabling it shows the buyer a countdown and binds the payment to the
   reservation window, but it changes the signature inputs and the UX.
