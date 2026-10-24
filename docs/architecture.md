# Architecture

Status: ePayco-only, no-ticket purchase flow. The PostgreSQL schema, the order path, the
payment-confirmation pipeline, participant assignment, check-in, the operational export and the
public event endpoints are implemented and tested, and the frontend is a thin client over them
that never reaches the database directly.

**Read the Wompi and ticket sections below as legacy.** The active flow opens an ePayco Smart
Checkout session and confirms it through `POST /webhooks-epayco`; a PAID order is the
confirmation, and its participants are the admissions. Tickets, QR codes and ticket emails are no
longer produced, and the legacy tables/endpoints remain only for historical data. The current
buyer journey is documented in [frontend.md](frontend.md); endpoint contracts are in
[api.md](api.md). See [phases/phase-01.md](phases/phase-01.md) through
[phases/phase-05.md](phases/phase-05.md) for the historical verification logs.

## 1. System overview

```
                    (later)              ┌──────────────────────────┐
Buyer ──────────► Vercel frontend ──────►│ Supabase Edge Functions  │
                  (Spanish site)         │  (Deno, TypeScript)      │
                                         │                          │
ePayco ─webhook──► /webhooks-epayco ────►│  ├── portable core       │
                                         │  │   (_shared)           │
Operator ────────► private check-in ────►│  └── adapters (per fn)   │
(operator)                               └───────────┬──────────────┘
                                                     │ secret key
                                                     ▼
                                         ┌──────────────────────────┐
                                         │ Supabase PostgreSQL      │
                                         │  (source of truth)       │
                                         └───────────┬──────────────┘
                                                     │ read-only export
                                                     ▼
                                         ┌──────────────────────────┐
                                         │ Google Sheets (client    │
                                         │ operational view only)   │
                                         └──────────────────────────┘
```

Authoritative state lives in PostgreSQL. ePayco decides whether money moved. Google Sheets and
the browser are read-only consumers of derived data.

## 2. Layering

The backend is layered so that vendor details cannot leak into business rules:

| Layer               | Location                             | Depends on                   | Contains                                                                                                             |
| ------------------- | ------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Domain              | `_shared/domain/`                    | nothing                      | money, references, order/payment states, tickets, check-in, consents, operators, rate limits, reconciliation, sheets |
| Configuration       | `_shared/config/`                    | domain-independent           | validated environment model, credential/environment binding                                                          |
| Vendor integrations | `_shared/integrations/`              | domain                       | ePayco checkout/webhook gateways, Resend email client, Google Sheets client (OAuth + values API)                     |
| Persistence         | `_shared/db/`                        | Supabase client              | service-role client factory, generated types                                                                         |
| Transport           | `_shared/http/`, `_shared/logging/`  | domain                       | response envelope, CORS, JSON logs with redaction, body/client-IP helpers                                            |
| API                 | `_shared/api/`                       | domain, db, config           | request schemas, handlers, orchestration (no HTTP specifics)                                                         |
| Adapters            | `supabase/functions/<name>/index.ts` | all of the above + Deno APIs | HTTP parsing, wiring, nothing business-critical                                                                      |
| Database            | `supabase/migrations/`               | —                            | schema, constraints, enums, atomic operations, pricing + order transaction                                           |

Two rules make this work in practice:

1. **The core is runtime-agnostic.** It never reads `Deno.env` or `process.env` and never
   imports Deno-only APIs, so the same code runs in Deno (production) and Node (tests).
   Environment access happens exactly once, in the adapter, and is passed in as a plain
   object.
2. **Vendor logic is isolated.** ePayco specifics live in `_shared/integrations/epayco/`:
   session creation, signature checks, status mapping. The domain only knows internal order
   statuses (`PENDING`, `PAID`, `FAILED`, `EXPIRED`), never ePayco's response codes.

## 3. Database responsibilities (Phases 2–3)

PostgreSQL is the source of truth for every business fact. The database does not just store
rows; it enforces the invariants the backend relies on, so a bug in an Edge Function cannot
produce an impossible state:

| Invariant                                      | Enforced by                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Money and quantities are sane                  | integer centavos, `check (… >= 0)`, `check (quantity > 0)`                                                    |
| The price is never client-supplied             | no amount parameter exists in the quote/order functions                                                       |
| A stale quote can never set the price          | the price comes from the reserved row inside the order transaction                                            |
| Order arithmetic is consistent                 | check `subtotal - quantity_discount - discount_code = total`                                                  |
| Prices are frozen at purchase                  | snapshot columns on `order_items`; catalog FKs never rewrite history                                          |
| No stage is oversold                           | conditional atomic `update` + inventory check constraint                                                      |
| A retried request never reserves twice         | partial unique index on `orders.idempotency_key`                                                              |
| A single-use discount code is claimed once     | conditional `update` on `redeemed_count` + append-only ledger                                                 |
| At most one approved payment per order         | partial unique index `payments (order_id) where status = 'approved'`                                          |
| A Wompi-era payment reference cannot be reused | legacy unique constraints on `payments.wompi_reference` and `wompi_transaction_id` (kept for historical rows) |
| The same webhook event is processed once       | unique `payment_events.dedupe_key`                                                                            |
| Payment state never regresses                  | `app_private.payment_transition_rank` inside `confirm_payment`                                                |
| Exactly one ticket per purchased unit          | unique `tickets (order_item_id, order_item_seq)`                                                              |
| No duplicate confirmation email                | unique `email_deliveries.idempotency_key` + `FOR UPDATE SKIP LOCKED` claim + provider idempotency key         |
| No double check-in                             | unique `attendance (ticket_id)`                                                                               |
| No duplicate confirmation email                | unique + derived `email_deliveries.idempotency_key`                                                           |
| Consent history cannot be rewritten            | append-only trigger (UPDATE rejected)                                                                         |
| Browser roles read and write nothing           | RLS enabled on all tables, no policies, privileges revoked                                                    |

Structural layout (details in [data-model.md](data-model.md)):

- **Catalog**: `events` → `ticket_types` → `pricing_tiers` (+ `quantity_discounts`),
  `discount_codes`; `pricing_policy` holds the single discount-combination decision.
- **Sales**: `orders` → `order_items` (+ `discount_redemptions`).
- **People and admissions**: `participants` (one row per admission on an order; new orders write
  the buyer's row and `attach_participant` appends companion rows). Legacy `tickets` / `attendance`
  remain for historical data and are not written by the purchase flow.
- **Payments**: `payments` (attempts) + `payment_events` (webhook ledger and idempotency).
- **Messaging**: `email_deliveries` (idempotent sends; no ticket templates are queued).
- **Read model**: `operational_export` is one row per **participant** of a `PAID` order, and
  `sheets_participant_projections` is the outbox that decides which participants still need a
  Sheets sync.

Helper functions live in `app_private` (`set_updated_at`, `next_order_reference`, `reject_update`,
`active_pricing_tier_id`, `quantity_discount_bps`, `discount_code_amount_cents`,
`evaluate_discount_code`, `normalize_order_input`, `reserve_pricing_tier`,
`claim_discount_redemption`, `payment_transition_rank`) and are unreachable through the PostgREST
API. The public entry points (`quote_order_price`, `create_order`, `confirm_payment`,
`claim_webhook_event`, `finalize_webhook_event`, `record_webhook_rejection`,
`queue_ticket_emails`, `claim_email_deliveries`, `finish_email_delivery`,
`expire_pending_orders`, `retry_payment`, `get_order_status`) are executable by the service role
only. Database types are generated from the live schema (`database.types.ts`), never
hand-written. Migration strategy: append-only files, expand-contract changes, verified by PGlite
on every `npm test` and by a real PostgreSQL instance per phase release.

## 4. Critical flows

**Current purchase flow (ePayco, no tickets).** `POST /orders` prices from the database and opens
an ePayco Smart Checkout session; the browser returns from ePayco and the app polls
`GET /orders/{reference}`; `POST /webhooks-epayco` verifies the transaction with ePayco, calls
`confirm_payment` and, when the order is `PAID`, enqueues participant projections for Google
Sheets. The buyer's participant row already exists; companions are added with
`POST /orders/{reference}/participants` while the order is `PAID`. No ticket, token or QR is
issued. The detailed contract is in [api.md](api.md) and the buyer journey in
[frontend.md](frontend.md). The Wompi sequences below are retained as historical design notes.

### 4.1 Legacy: buying a ticket (Wompi path)

```
POST /orders/quote                → price from DB, reserves nothing (Phase 3, implemented)
POST /orders                      → ONE database transaction (Phase 3, implemented):
                                    replay check → event/type → reserve inventory →
                                    price → claim discount → order + item + participant
                                    + consents + payment attempt (PENDING)
                                  → returns the Wompi checkout payload
frontend Widget/Web Checkout      → Wompi charges with that reference, amount, signature
POST /webhooks/wompi  (Wompi)     → authenticity verified (event checksum)          [implemented]
                                  → transaction re-read server-side with the private key
                                  → reference/amount/currency/order validated
                                  → payment + order updated, tickets issued, email queued
GET /orders/{reference}           → buyer-facing status (safe fields only)          [implemented]
POST /orders/{reference}/retry    → fresh attempt + fresh reference                 [implemented]
POST /orders-maintenance          → reservation expiry + outbox retry               [implemented]
```

The frontend never sends a price it computed itself, and never declares a payment successful:
the signature binds the exact amount to the reference, and the webhook path re-verifies
the Wompi API before any ticket is created.

**Why the transaction is a SQL function.** PostgREST — what the Supabase client speaks — cannot
run multi-statement transactions. Order creation must be atomic (reserve inventory, claim a
discount, write five tables), so it lives in `public.create_order` and the backend calls it over
RPC with the secret key. The TypeScript pricing module is the tested _specification_ of the same
rules and re-checks the returned arithmetic; `tests/schema/pricing-parity.test.ts` fails the build
if the two ever drift.

### 4.2 Legacy: Wompi payment confirmation (idempotent by construction)

```
webhook received                            POST /webhooks/wompi
   ├── parse envelope (bounded)            → reject malformed / oversized
   ├── verify checksum (SHA-256)           → 401 + recorded as REJECTED (checksum_valid=false)
   ├── claim event (unique dedupe key)     → duplicate answered 200 from the ledger, no work
   ├── look up transaction at Wompi        → authoritative status (private key, fail-closed)
   ├── validate against the order          → reference, amount, currency, transaction id
   ├── confirm_payment (one transaction)   → lock order, forward-only payment transition,
   │                                         PENDING/FAILED → PAID, reserved → sold,
   │                                         one ticket per unit, CANCELLED/EXPIRED → reconciliation
   ├── queue_ticket_emails (same tx)       → unique (ticket, template) outbox rows
   └── finalize ledger → dispatch outbox   → after commit; provider idempotency key
```

Wompi retries a webhook up to 3 times (30 min, 3 h, 24 h) when we do not answer HTTP 200, so
duplicates are expected, not exceptional. Every step above is keyed so that a repeated event
produces exactly the same state, with no duplicate payment, ticket, QR or email. A delivery is
answered `200` once it is durably handled (even a duplicate or an ignored event); `503` is
reserved for genuinely transient failures so Wompi's retry can finish the job.

### 4.3 Order creation is atomic and idempotent (Phase 3)

```
POST /orders
   ├── Idempotency-Key seen before for THIS buyer?  → return the same order (replayed)
   ├── validate input (buyer, participant, consents, quantity)
   ├── reserve inventory: conditional UPDATE ... RETURNING  → price comes back with the row
   ├── price: quantity discount + code verdict + policy combination
   ├── claim the discount redemption (conditional UPDATE + append-only ledger)
   ├── write order + item + participant + consents + payment attempt (PENDING)
   └── COMMIT  → any failure rolls back everything (no partial order, no leaked stock)
```

Concurrency is PostgreSQL's job: the reservation predicate is evaluated under the row lock, and
the Phase 2 CHECK constraint is the second line of defence. A single-use discount code can be
claimed exactly once even under simultaneous requests. Both were verified with two real parallel
sessions (phase-03 report).

### 4.4 Payment retry and reservation expiry (Phase 4, implemented)

```
POST /orders/{reference}/retry  (reference + buyer email)
   ├── FAILED or EXPIRED only        → ORDER_ALREADY_PAID / ORDER_NOT_RETRYABLE otherwise
   ├── attempt ≤ 10                  → TOO_MANY_ATTEMPTS beyond that
   ├── EXPIRED: re-reserve same tier → SOLD_OUT if the stage can no longer serve it
   └── new payment row, fresh ref    → EVT-YYYY-NNNNNN-<attempt>; price and order reused

POST /orders-maintenance  (bearer token, scheduler or operator)
   ├── expire_pending_orders         → PENDING/FAILED past deadline → EXPIRED, inventory released
   └── dispatch email outbox         → bounded retries with backoff, SKIP LOCKED claim
```

Both jobs are idempotent and concurrent-safe, and neither can mark an order paid. If
maintenance never runs, the effect is bounded: inventory stays reserved longer and emails wait
in the outbox — no payment is lost and no ticket is wrong.

### 4.5 Check-in (Phase 5, implemented)

```
scan QR → normalize token → authenticate operator (Supabase Auth + operators row)
        → record_check_in: lock ticket → decide (cancelled → not paid → used → valid)
        → if VALID: insert attendance (unique ticket_id) in the same transaction → first scan wins
        → HTTP 200 with status: VALID | ALREADY_USED | NOT_PAID | CANCELLED | NOT_FOUND | INVALID
```

The decision table lives in `domain/checkin.ts` and its SQL twin in `record_check_in`; both are
tested with the same precedence. Atomicity is a database concern: `attendance.ticket_id` is
unique and the insert happens in one transaction with the ticket row locked, so two simultaneous
scans cannot both succeed — verified with two parallel PostgreSQL 17 sessions
(phase-05 report, check A). HTTP errors are reserved for transport-level failures
(401/403 auth, 429 rate limit, 400 malformed, 502 upstream); a used or unpaid scan is normal door
operation, not a server error.

### 4.6 Reconciliation and the payment hint (Phase 5, implemented)

```
lost webhook ─┬─ automatic sweep (maintenance): claim due attempts → GET /transactions/{id}
              │    → validate reference/amount/currency → SAME confirm_payment as the webhook
              └─ buyer hint (redirect ?id=…): reference+email → same lookup → same confirm_payment
```

Wompi has no lookup by reference, so only attempts that already have a transaction id can be
swept automatically; the hint covers the rest. Both paths converge through `confirm_payment`,
so a recovered payment is indistinguishable from a webhook-delivered one. Attempts are bounded
(schedule + attempt cap) and terminal outcomes stop sweeping.

### 4.7 Sheets projection and the scheduler (Phase 5, implemented)

Every relevant write enqueues a per-ticket row in `sheets_projections` inside its own
transaction; the maintenance run claims with `SKIP LOCKED` and writes the complete grid.
The scheduler is `pg_cron → pg_net → POST /orders-maintenance` with Vault-held secrets
(migration 015), with a documented HTTP fallback. See
[operations-google-sheets.md](operations-google-sheets.md).

## 5. State machines

**Order** (`domain/order-state.ts`, mirrors the `order_status` enum):

```
PENDING ──► PAID (terminal: payment validated, tickets issued)
   │     └─► FAILED ──► PENDING (new payment attempt) | CANCELLED
   │     └─► EXPIRED ─► PENDING (inventory reclaimed) | CANCELLED
   └─────► CANCELLED (terminal)
```

`EXPIRED` is the only addition to the initial PENDING/PAID/FAILED/CANCELLED set, because
limited inventory per sales stage must be reclaimable. `REFUNDED` is deliberately **not**
implemented yet — no half-built refund flow exists in the codebase.

**Payment** (`domain/payment-status.ts`): Wompi's `PENDING | APPROVED | DECLINED | VOIDED |
ERROR` are mapped to internal `pending | approved | declined | voided | error`, plus `unknown`
for anything new. Phase 4 adds `refunded` — an approved attempt Wompi later voided (the money
came back). The raw Wompi string is always stored next to the normalized value. Transitions are
forward-only and enforced in the database
(`pending/unknown(0) < approved(1) < refunded(2) < voided(3) < declined(4) < error(5)`): a late
or replayed `PENDING` event cannot un-approve a payment, a later `DECLINED`/`ERROR` on an
approved attempt only updates the raw string, and `unknown` is never treated as success.

**Ticket** (`domain/tickets.ts`): `ACTIVE | CANCELLED | REFUNDED`; only `ACTIVE` admits entry.
Attendance is a separate one-row-per-ticket fact, which keeps "was it valid?" and "did they
enter?" independent questions.

Every enum above is created in SQL by a migration, and parity between the SQL labels and the
TypeScript constants is asserted by `tests/schema/migrations.test.ts` — a state that exists in
one place but not the other fails the build.

## 6. Money

- Unit of account: **centavos** (1/100 COP), identical to Wompi's `amount_in_cents`
  (documented: `$95.000 COP` → `9500000`).
- Type `CopCents` is branded: raw numbers cannot be passed where money is expected, so
  "pesos vs centavos" mix-ups fail at compile time.
- Arithmetic is integer-only, with overflow checks; formatting/parsing lives in
  `domain/money.ts` (Colombian convention: `$95.000`).
- Prices are **never** in code: the event, its sales stages, prices and discounts are database
  rows (Phase 3). No price, quantity or discount rule was invented in Phase 1.

## 7. References and traceability

- Order reference: `EVT-<year>-<sequence>` (e.g. `EVT-2026-000001`), sequence from a database
  sequence so concurrent orders cannot collide.
- Payment attempt reference: attempt 1 uses the order reference verbatim; later attempts append
  `-<attempt>`. Wompi documents that a used reference can never be reused, so a retry after a
  declined transaction must use a fresh one while staying traceable.
- Chain: internal order ↔ Wompi reference ↔ Wompi transaction id ↔ participant ↔ ticket(s),
  carried through logs as `orderId`, `paymentId`, `wompiReference`, `ticketId`.

## 8. Environments

`development` (local stack), `sandbox` (deployed, Wompi test credentials), `production`
(deployed, real money). `APP_ENV` decides which Wompi credential prefixes are legal, so a
sandbox deployment cannot silently run on production keys (see
[environments.md](environments.md)).

## 9. Testing strategy

| Level                      | Runner                                 | Covers                                                                                                         |
| -------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Domain / integration units | Vitest (Node)                          | money, references, states, check-in, consents, Wompi crypto + client                                           |
| Schema                     | Vitest + PGlite (real Postgres, WASM)  | migrations apply, table/enum inventory, constraints, indexes, RLS posture, `updated_at` triggers               |
| Schema races               | real PostgreSQL, two parallel sessions | same-second confirmations, outbox claim, retry, status reads, double check-in, oversell (documented per phase) |
| Tooling guardrails         | Vitest                                 | dependency-version parity, `.env.example` coverage, secret hygiene                                             |
| Edge Function typing       | Deno                                   | `deno check` per function with its own `deno.json`                                                             |

External services are never contacted in tests: the Wompi and Resend clients take an injected
`fetch`, signatures are checked against the official documented vector, and the webhook fixtures
are signed with an independent SHA-256 implementation. See [testing.md](testing.md).

## 10. Deliberate non-goals (for now)

Landing page, WhatsApp, mobile app, marketplace, CMS, admin dashboard, multiple public events,
participant accounts. Admin operations are not exposed publicly; the private check-in API uses
real Supabase Auth + the `public.operators` table (no shared operator secret).

## 11. Known limitations of the current verification

- The local Supabase stack (`supabase start` / `npm run db:reset`, Studio, PostgREST exposure)
  cannot start on this Windows machine: reserved TCP port ranges (54232–54331 and others) make
  Docker refuse the 54321/54322 mappings. Migrations are therefore verified twice in a
  different way: PGlite (Postgres 18 in WASM) on every test run, and a real PostgreSQL 17
  container with Supabase-equivalent roles for the Phase 2 and Phase 4 checks (including the
  confirmation-pipeline concurrency races). PostgREST's exact behaviour with a publishable key
  and the local stack's role configuration still need `npm run db:reset` on a machine where the
  stack can start (or after the port restriction is lifted).
- No live Wompi, Resend or Google call has been made: no credentials exist yet. Crypto and
  HTTP behaviour are verified against the official documented vectors and injected-fetch
  fixtures; live sandbox verification is Phase 6.
- Database types were generated by pointing the Supabase CLI at the verification database
  (`--db-url`, see the Phase 2 report). They describe exactly the migrated schema, but
  regeneration on a normal machine should use `npm run types:generate` against the local stack
  so the workflow matches the docs.
