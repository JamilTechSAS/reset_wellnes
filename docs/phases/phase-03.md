# Phase 3 report — pricing, inventory reservation and order creation

Date: 2026-10-03 · Scope: **Phase 3 only** (backend/database; no frontend, no invented business
values, no changes to the Phase 1/2 foundation beyond what this phase required).

## 1. Objective and outcome

**Objective:** implement the real business path — ticket request → authoritative price →
discounts → inventory reservation → transactional order creation → unique payment reference →
Wompi payment preparation — so a future frontend can create an order and open the checkout with
a deterministic, server-computed configuration.

**Outcome: complete.** Two migrations add the pricing policy, an idempotency column, four helper
functions and the two public entry points (`quote_order_price`, `create_order`). A portable
TypeScript layer validates input, maps database errors to the API model and builds the Wompi
checkout payload. `npm run check` is green with **212 tests** (159 from Phase 1/2, unchanged and
still passing, plus 53 new). Every claim below was executed in this environment.

The single most important design decision: **the authoritative price is computed in SQL, inside
the order transaction**, because PostgREST (what the Supabase client speaks) cannot run
multi-statement transactions and a price computed outside the transaction can go stale. The
TypeScript pricing module is the tested _specification_ of the same rules, and a parity suite
runs identical scenarios through both.

## 2. Wompi documentation re-verified (2026-10-03)

Re-read from the official docs before implementing (not from memory):

| Topic                 | Source                                             | What was confirmed                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Widget / Web Checkout | `docs.wompi.co/docs/colombia/widget-checkout-web/` | Required params `public-key`, `currency`, `amount-in-cents`, `reference`, `signature:integrity`; `$95.000 COP → 9500000`; a reference that was used can never be reused; `expiration-time` is optional and **changes the signature inputs**; the signature must be computed server-side |
| Integrity signature   | same page                                          | `SHA256(reference + amount_in_cents + currency [+ expiration-time] + integrity_secret)`, order matters, official vector still `37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5`                                                                                        |
| Events / checksum     | `docs.wompi.co/docs/colombia/eventos/`             | Checksum = `SHA256(concat(properties values) + timestamp + events_secret)`; `properties` varies per event; value mirrored in `X-Event-Checksum`; retries 30 min / 3 h / 24 h on non-200                                                                                                 |
| Transaction lookup    | Widget page (step 4) + `transacciones/`            | Only the private key can query a transaction; frontend queries are no longer supported; the redirect URL is informational only                                                                                                                                                          |

Phase 1's assumptions held. No new capability was needed for this phase, and no live Wompi call
was made (still no credentials — that is Phase 5).

## 3. Pricing engine implemented

**Where the price is decided:** `public.quote_order_price` (quote) and `public.create_order`
(order). Both take the event code, ticket type code, quantity and the configured reservation
window. **Neither takes an amount**: a client-supplied price has nowhere to enter the system.
A test asserts the quote function's argument list contains no `amount`/`price`/`total`/`cents`.

**Stage selection** (`app_private.active_pricing_tier_id` for quotes, an inlined conditional
`UPDATE` in `create_order`): the lowest `sequence` that is `is_active`, inside its
`sales_starts_at`/`sales_ends_at` window, and able to hold the whole requested quantity. An
exhausted stage is _skipped_ (the next stage is a legitimate fallback for the buyer); only when
no stage can serve the quantity does the order fail with `SOLD_OUT`. A future stage is skipped
because its window has not started.

**Discount arithmetic:**

| Step              | Rule                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Subtotal          | `pricing_tiers.price_cents × quantity`, taken from the row the reservation locked                                              |
| Quantity discount | highest configured breakpoint `min_quantity <= quantity`, applied as `floor(subtotal × percent_bps / 10000)`                   |
| Discount code     | validated, then `floor(subtotal × percent_bps / 10000)` (PERCENT) or the stored `amount_cents` (FIXED), capped at the subtotal |
| Combination       | from `pricing_policy.discount_combination` (see §5)                                                                            |
| Total             | `subtotal − totalDiscount`, never negative                                                                                     |

Flooring is deliberate: the buyer is never charged more than the percentage they were promised,
and no fraction of a centavo is ever invented. The breakdown returned to the caller includes the
stage name and sequence, unit price, subtotal, both discount candidates, the applied split, the
policy used and the resulting total — enough for the future frontend to render the calculation.

**Stale-price protection:** `create_order` re-resolves the stage and recomputes the price inside
its own transaction. If the stage that a quote used is gone, the order silently moves to the next
eligible stage at the _new_ price, or fails with `SOLD_OUT` — it never charges the stale amount.

## 4. Inventory strategy

The Phase 2 counters are used as designed: `quantity_reserved` (held by `PENDING` orders) and
`quantity_sold` (paid), against `quantity_limit` (NULL = unlimited).

Reservation is a single conditional `UPDATE`:

```sql
update public.pricing_tiers t
   set quantity_reserved = t.quantity_reserved + p_quantity
 where … is_active, inside window,
       (quantity_limit is null
        or quantity_reserved + quantity_sold + p_quantity <= quantity_limit)
   and t.sequence = (select min(sequence) from … eligible …)
 returning t.*;   -- the locked row, including the price used for the order
```

No application lock, no read-then-write: the predicate is evaluated by PostgreSQL under the row
lock, and the Phase 2 CHECK constraint (`reserved + sold <= limit`) is the second line of
defence. The `returning` clause is what ties the price to the reservation — the amount charged
provably belongs to the stage that was actually reserved.

## 5. Discount strategy

**Validation** (`app_private.evaluate_discount_code`) enumerates every refusal reason so no caller
has to guess: `NOT_SUPPLIED`, `NOT_FOUND`, `INACTIVE`, `NOT_STARTED`, `EXPIRED`, `EXHAUSTED`,
`WRONG_TICKET_TYPE`, `MIN_QUANTITY`, `OK`. It is one function, used by both the quote and the
order, so the two can never disagree.

**Behaviour difference between quote and order (deliberate):**

- A quote is informational: an unusable code is _reported_ with its reason and the price is
  returned without it, so the checkout can explain the problem before the buyer submits.
- An order is a commitment: if the buyer **supplied** a code and it cannot be applied, the order
  fails with `PT409 DISCOUNT_<REASON>`. Proceeding would charge more than the price the buyer was
  shown, which is worse than an honest error.

**Combination policy is data, not code.** Whether a quantity discount and a code may apply to the
same order is a business decision the client has not made (docs/data-model.md §8.5), so it lives
in the single-row `pricing_policy` table:

| `discount_combination`  | Behaviour                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `BEST_SINGLE` (default) | Only the larger discount applies; the loser is stored as `0` and is **not** redeemed |
| `STACK`                 | Both apply, capped at the subtotal so the total can never go negative                |

Only the discount that actually reduced the price is claimed in `discount_codes.redeemed_count`
and recorded in `discount_redemptions`, so usage accounting stays truthful under either policy.

**Redemption is atomic** (`app_private.claim_discount_redemption`): a conditional
`UPDATE … WHERE redeemed_count < max_redemptions RETURNING id`, followed by the append-only
ledger insert. A code limited to one use cannot be claimed twice — verified with two real parallel
sessions (§10).

## 6. Order creation flow

`public.create_order` performs, in one transaction:

1. **Input validation** — quantity, reservation window, buyer email/name/phone, participant
   payload (`app_private.normalize_order_input`: names, document, email, phone, city, Instagram,
   `extraFields`), and the mandatory data-processing consent.
2. **Idempotent replay** — if the key exists and belongs to the same buyer, return the original
   order (same reference, same amount, same payment attempt) with `replayed = true`. A key
   belonging to a **different** buyer is refused with `IDEMPOTENCY_KEY_CONFLICT` rather than
   leaking someone else's order.
3. **Event and ticket type resolution** — `PUBLISHED` only, `is_active` only, and the per-order
   `min_per_order`/`max_per_order` limits.
4. **Reservation** — the conditional `UPDATE` above; the price comes back with the row.
5. **Pricing** — quantity discount, code evaluation, policy combination, applied split.
6. **Order + item** — reference from `app_private.next_order_reference()` (the Phase 2 sequence,
   so concurrency cannot collide), money columns holding the **applied** amounts (which is what
   the `orders_total_check` constraint requires), and snapshot names for the item.
7. **Redemption claim** — after the order row exists, because the ledger row references it.
8. **Participant + consents** — both consents written as append-only rows with the policy version.
9. **Payment attempt** — `PENDING`, attempt 1, Wompi reference equal to the order reference.
   The order is **never** marked paid here: only a verified Wompi event may do that (Phase 4).

Any failure rolls back everything: no partial order, no leaked inventory, no burned redemption.
That is asserted directly in the tests by comparing order counts and reserved counters before and
after a forced failure.

**Idempotency key handling:** the client sends an `Idempotency-Key` header (16–128 printable
ASCII characters). Uniqueness is a partial unique index on `orders.idempotency_key`, so the
guarantee is the database's, not the application's. A minimum length is enforced because the key
is also a lookup token; the buyer-email check is what stops it from being an order-disclosure
oracle.

**Reservation window:** `ORDER_RESERVATION_MINUTES`, configuration with a documented technical
default of **15 minutes**. The client has not confirmed the real value
(docs/data-model.md §8.6), so it is configurable rather than baked in. The expiry _job_ that
releases reservations is Phase 6; the schema, the `EXPIRED` state and the partial expiry index
already exist.

## 7. Wompi payment preparation

`POST /orders` returns the checkout payload the future frontend needs:

```json
{
  "reference": "EVT-2026-000001",
  "status": "PENDING",
  "totalInCents": 21375000,
  "currency": "COP",
  "reservationExpiresAt": "2026-10-03T23:02:29.318Z",
  "paymentAttempt": 1,
  "checkout": {
    "publicKey": "pub_test_…",
    "currency": "COP",
    "amountInCents": 21375000,
    "reference": "EVT-2026-000001",
    "integritySignature": "…64 hex chars…",
    "expirationTime": null,
    "redirectUrl": "http://localhost:3000/gracias",
    "customerData": {
      "email": "buyer@example.com",
      "fullName": null,
      "phoneNumber": null,
      "phoneNumberPrefix": null
    }
  }
}
```

- The amount and reference come from the order the database just wrote — there is no code path
  where a client-supplied amount could be signed.
- `expiration-time` is deliberately **not** used yet: it changes the signature inputs and the
  checkout UX, and the client has not decided (docs/wompi-integration.md §10). The formatter and
  the signature path already support it, and a test proves the expiration appears in both the
  hash and the payload when enabled.
- A test asserts the serialized response contains no integrity secret, no private key, no events
  secret and no Supabase secret key, and that the payload's key set is exactly the eight
  documented fields.

## 8. API endpoints created

| Endpoint              | Function                        | Notes                                                                                 |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /pricing/quote` | `orders` (path `/orders/quote`) | Side-effect-free price, reserves nothing, reports discount reasons instead of failing |
| `POST /orders`        | `orders`                        | Creates the order atomically, returns the Wompi checkout payload (`201`)              |

Both are `verify_jwt = false` (buyers have no account) and are protected by strict input
validation, server-side pricing and (Phase 12) rate limits. Error model is the Phase 1 taxonomy:
`VALIDATION_ERROR` 400, `NOT_FOUND` 404, `CONFLICT` 409, `UPSTREAM_ERROR` 502,
`INTERNAL_ERROR` 500 — with `PT400/PT404/PT409` + machine-readable detail mapped onto them.
Anything else (a CHECK violation, a type error) collapses to `INTERNAL_ERROR`; a test proves the
serialized body contains no constraint name, no SQLSTATE and no SQL text.

## 9. Tests executed — exact results

`npm run check` (typecheck, ESLint, Prettier, `deno check`, Vitest):

```
Test Files  23 passed (23)
     Tests  212 passed (212)
```

New in Phase 3 (53 tests):

| Suite                                 | Tests | Covers                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/domain/pricing.test.ts`        | 15    | basis-point flooring, BEST_SINGLE vs STACK, subtotal cap, consistency rejection, vocabulary                                                                                                                                                                                                                                                     |
| `tests/schema/pricing-parity.test.ts` | 19    | stage selection (active / not started / exhausted / sold out), SQL↔TS parity under both policies, code reasons, FIXED codes, per-order limits, unknown event/type, "no price parameter", full order flow, participant normalization, consent rows, PENDING payment, idempotent replay, key-owner conflict, rollback proof, reference uniqueness |
| `tests/api/orders-handler.test.ts`    | 19    | SQLSTATE→API mapping, no SQL leakage in the HTTP body, quote/order handlers, checkout payload safety, expiration in signature + payload, idempotency-key parsing                                                                                                                                                                                |

Previously existing tests (159) all still pass; the only edits were the Phase 2 table inventory
(new `pricing_policy`) and the `updated_at` count (11 → 12).

## 10. Concurrency tests and results

Two genuinely parallel sessions against **real PostgreSQL 17.11** (Docker container, separate
database; the unrelated `jamilchat-*` containers were not touched):

**Race 1 — last unit.** Stage `quantity_limit = 1`. Session A creates an order and holds its
transaction open 3 s; session B creates an order for the same stage 0.8 s later.

```
winner exit: 0        → claimed
loser  exit: 1        → ERROR: No sales stage can serve this quantity  DETAIL: SOLD_OUT
quantity_reserved = 1, quantity_limit = 1
orders_created = 1
```

**Race 2 — single-use discount code.** `max_redemptions = 1`, two simultaneous orders using it.

```
winner exit: 0        → claimed
loser  exit: 1        → ERROR: Discount code cannot be applied  DETAIL: DISCOUNT_EXHAUSTED
redeemed_count = 1, max_redemptions = 1
redemption_rows = 1
```

**Rollback proof.** After a forced failure (exhausted code, invalid participant, unknown code)
the order count, the reserved counters and the redemption ledger were all unchanged.

PGlite (single-session) covers the same logic structurally on every `npm test`; the two-session
races are what PGlite cannot reproduce, which is why they were run against real PostgreSQL.

## 11. Files changed

**New migrations**

- `supabase/migrations/20261003210008_pricing.sql` — `pricing_policy` table, `orders.idempotency_key`
  - partial unique index, `app_private.active_pricing_tier_id`, `app_private.quantity_discount_bps`,
    `app_private.discount_code_amount_cents`, `app_private.evaluate_discount_code`,
    `public.quote_order_price`, grants.
- `supabase/migrations/20261003210009_order_creation.sql` — `app_private.normalize_order_input`,
  `app_private.reserve_pricing_tier`, `app_private.claim_discount_redemption`,
  `public.create_order`, grants.

**New backend code**

- `supabase/functions/_shared/domain/pricing.ts` — discount policy, basis points, consistency check.
- `supabase/functions/_shared/db/orders.ts` — typed RPC gateway + SQL error mapping.
- `supabase/functions/_shared/api/order-requests.ts` — request schemas (client cannot send prices).
- `supabase/functions/_shared/api/orders-handler.ts` — quote/order orchestration.
- `supabase/functions/_shared/integrations/wompi/checkout.ts` — checkout payload + signature.
- `supabase/functions/orders/index.ts` + `deno.json` — Edge Function adapter.

**Modified**

- `supabase/functions/_shared/config/env.ts` — `orderReservationMinutes`, `wompiRedirectUrl`.
- `supabase/functions/_shared/db/database.types.ts` — regenerated from the migrated database.
- `.env.example` — `ORDER_RESERVATION_MINUTES`, `WOMPI_REDIRECT_URL`.
- `supabase/config.toml` — `[functions.orders] verify_jwt = false`.
- `tests/schema/helpers.ts`, `tests/schema/migrations.test.ts` — new table and trigger count.

**New tests**

- `tests/domain/pricing.test.ts`, `tests/schema/pricing-parity.test.ts`, `tests/api/orders-handler.test.ts`.

## 12. Open business decisions (still not invented)

1. **Prices, stage quantities and sales windows** — loaded as rows by the client.
2. **Discount codes**: which exist, values, validity, usage limits.
3. **Quantity discounts**: whether used, and the breakpoints.
4. **Discount combination policy** — the schema default is `BEST_SINGLE`; changing it is one
   `UPDATE`.
5. **Reservation window** — 15 minutes is a technical default, not a client decision.
6. **Duplicate cédula policy** — still unconstrained by design (Phase 2 §8.1).
7. **Consent wording and version** — the mechanism exists (`policy_version`, optional text hash);
   the text is the client's lawyer's.
8. **`expiration-time` in the checkout** — supported but disabled pending the client's choice.
9. **Payment methods enabled in the checkout** (PSE/Nequi introduce delayed approval).
10. **Retention policy** for `provider_payload` and participant data.

## 13. What remains for Phase 4

1. **Webhook endpoint** (`POST /webhooks/wompi`): checksum verification → `payment_events`
   dedupe insert → private-key transaction lookup → reference/amount/currency validation →
   forward-only payment transition → `PENDING` → `PAID` → ticket issuance with generated tokens →
   email queueing. The primitives all exist and are tested; only the endpoint and the handlers
   are missing.
2. **`GET /orders/{reference}`** — buyer-facing status with whitelisted fields, rate-limited,
   ticket tokens returned only after `PAID`.
3. **Ticket issuance** — one ticket per purchased unit, tokens from the Phase 1 generator,
   `participants` already attached at order creation.
4. **Order expiry job** — release `quantity_reserved` for `PENDING` orders past
   `reservation_expires_at` and move them to `EXPIRED`.
5. **Retry path** — a new payment attempt (`attempt = 2`) with a fresh Wompi reference for a
   `FAILED` order, reusing the same order and reservation.
6. **Rate limiting** (Phase 12) before the endpoint is public.
7. **Live Wompi sandbox verification** (Phase 5) — still blocked on credentials.

**Not claimed:** no live Wompi call was made, no payment was ever marked approved, and no
production-readiness claim is made. The Supabase local stack still cannot start on this machine
(reserved Windows TCP ranges), so PostgREST runtime behaviour and `db reset` remain unverified;
the database work was verified on real PostgreSQL 17 with Supabase-equivalent roles instead.
