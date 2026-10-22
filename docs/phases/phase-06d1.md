# Phase 6D.1 — Minimal backend production compatibility fixes

**Status: PASS.** Two corrections, both smaller than the diagnosis they came from: the backend now
takes its server-side Supabase key from the platform's key bag instead of requiring a variable a
hosted project cannot define, and an idempotent `POST /orders` replay returns the same payload as a
fresh creation instead of `500`. All seven Edge Functions are redeployed, the new migration is
applied to the hosted project and the local stack, and `npm run check` is green (678 tests).

Nothing else changed: no business rule, no RLS, no pricing, no payment, ticket, rate-limit,
check-in, outbox or Sheets behaviour, and **no business data was inserted anywhere** (§8).

Date: 2026-10-07. Hosted project: `pzogdjjdkgolybfcegcs`.

## 1. Issue 1 — the server-side Supabase key source

**Before.** `loadConfig` required `SUPABASE_SECRET_KEY` by name (`supabase/functions/_shared/config/env.ts`).
Supabase reserves the `SUPABASE_` prefix for platform-provided variables, so a hosted deployment
**cannot** define a custom variable with that name, and `/health` refused to start with
`SUPABASE_SECRET_KEY is required (…)`.

**After.** `resolveSupabaseSecretKey(env, issues)` resolves the key from the first non-empty source:

| #   | Source                      | When it applies                                                                                           |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | `SUPABASE_SECRET_KEY`       | explicit override: local development, self-hosting, tests                                                 |
| 2   | `SUPABASE_SECRET_KEYS`      | the platform's JSON bag; its `default` entry (a bag with exactly one entry is accepted whatever its name) |
| 3   | `SUPABASE_SERVICE_ROLE_KEY` | the platform's legacy key, on hosts that still inject it                                                  |

Both documented bag shapes are accepted: a JSON object (`{"default":"sb_secret_…"}`) and an array of
`{ name, api_key }` entries. Everything a publishable/anon key already protected still holds — the
chosen key goes through the same `detectSupabaseKeyKind` check, a publishable key is rejected
whatever its source, a malformed or ambiguous bag is reported **by variable name only**, and the key
reaches nothing but the database client (`createServiceRoleClient`, unchanged).

**Files changed:** `supabase/functions/_shared/config/env.ts` (resolver + two helpers),
`.env.example` (documents both platform variables; the template test asserts the loader and the
template stay in step), `tests/config/env.test.ts` (+9 tests).

**Functions affected:** all seven import this module — `checkin`, `events`, `health`, `orders`,
`orders-maintenance`, `tickets`, `webhooks-wompi` — so all seven were redeployed (§6).

**Verified three ways:**

1. A real Deno Edge runtime initialising with **no** `SUPABASE_SECRET_KEY` at all and only the bag:
   `SUPABASE_SECRET_KEY present: false` / `SUPABASE_SECRET_KEYS present: true` →
   `configuration: ok`, `supabase.keyKind: legacy_service_role_jwt` (the local stack's key shape).
2. The **hosted** `/health` before the deploy listed seven missing variables starting with
   `SUPABASE_SECRET_KEY`; after the deploy it lists six and that one is gone — the platform bag was
   found and accepted in production.
3. Unit tests for both bag shapes, the precedence order, the legacy fallback, the publishable-key
   refusal, the malformed-bag message (asserting the value is never echoed) and the ambiguous bag.

## 2. Issue 2 — idempotency replay returned 500

**Root cause.** `public.create_order` returned two different payload shapes. Fresh creation
included `totalDiscountInCents` and `discountCombination`; the `replayed = true` branch omitted
both, because neither value exists as an `orders` column (`total_discount_cents` is not stored; the
combination rule lives in the single-row `pricing_policy`). `handleCreateOrder` passes
`totalDiscountInCents` into `verifyNumbers(...)` on **every** response, so a repeated `POST /orders`
carrying the same `Idempotency-Key` reached `copCents(undefined)`, threw, and answered
`500 INTERNAL_ERROR` — even though the order existed and its inventory stayed reserved. The frontend
reuses its idempotency key when it retries an order creation, which is exactly that scenario.

**Migration:** `supabase/migrations/20261007233000_fix_order_idempotency_replay.sql`
(a `create or replace function`, function-only; no old migration was edited).

The replay branch now returns, from the row it already has:

```sql
' totalDiscountInCents', v_existing.quantity_discount_cents + v_existing.discount_code_cents,
'discountCombination', v_policy,   -- read from the single-row public.pricing_policy
```

The sum is exactly the fresh payload's `totalDiscountInCents`: the two columns hold the amounts
**actually applied** (the orders CHECK constraint is `subtotal - quantity - code = total`), so
nothing is recomputed and no rule is re-run. The combination value is informational (the API
response does not expose it today); it is read from the policy in force, which is the only
authoritative source, and the migration says so. The body below the two additions is the previous
body verbatim — a `diff` of the two function bodies shows only those lines and their comments.

**Nothing was weakened:** no second order, no second payment attempt, no re-pricing, no error
swallowing. The unique index `orders_idempotency_key_idx`, the different-buyer conflict
(`IDEMPOTENCY_KEY_CONFLICT`) and the reservation counters are untouched.

**Exact behaviour, measured against the running backend over HTTP:**

| Request                       | Before                   | After                                                                  |
| ----------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `POST /orders` key A (fresh)  | `201`, `replayed:false`  | `201`, `replayed:false`, `totalDiscountInCents: 0` present             |
| `POST /orders` key A (replay) | **`500 INTERNAL_ERROR`** | **`201`, `replayed:true`, same reference, same amount, field present** |
| `POST /orders` key B          | `201`, new order         | `201`, `replayed:false`, a genuinely new order                         |

Database state after the replay: **1 order** for key A, **1 payment attempt** (attempt 1, pending),
no duplicate — and the schema test asserts the same at SQL level.

## 3. Tests

| Check                     | Result                                         |
| ------------------------- | ---------------------------------------------- |
| `npm run typecheck`       | 0 errors                                       |
| `npm run lint`            | 0 problems                                     |
| `npm run format:check`    | clean                                          |
| `npm run functions:check` | 0                                              |
| `npm run test`            | **678 tests in 53 files passing** (was 665/53) |
| — backend                 | 452 tests / 43 files (was 439)                 |
| — frontend                | 226 tests / 10 files (unchanged)               |

New backend coverage: 9 configuration tests (§1) and 4 order-creation tests —
payload-key parity between fresh and replayed responses, replay of an order that used a discount
code (amounts already applied, exactly one redemption), a different key creating a genuinely new
order, and the unique-index guard that makes two simultaneous requests with one key produce exactly
one order. `tests/schema/pricing-parity.test.ts` also had one pre-existing assertion scoped to the
code under test (a global `discount_redemptions` count that silently depended on which other tests
redeem a code); the intent — no burned redemption — is unchanged and now isolation-safe.

## 4. Database

| Item                      | Result                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration applied locally | `supabase migration up --local` → applied `20261007233000…`                                                                                   |
| Migrations local ↔ remote | in sync (`20261007233000` on both, previously 22/22)                                                                                          |
| `db lint --local`         | 6 findings, **all pre-existing** (`v_replay`, `v_payment_id`, `v_unit`, `v_max_attempt`, `p_now`), none introduced by the new file, no errors |
| `db diff --local`         | `No schema changes found`                                                                                                                     |

## 5. Deployment

All seven functions were deployed (`npm run functions:deploy` → `checkin, events, health, orders,
orders-maintenance, tickets, webhooks-wompi`), which is the complete affected set because every one
of them imports the configuration module. The migration was pushed to the hosted project with
`supabase db push --linked` (dry run first: exactly one migration, the new one).

`GET /health` on the hosted project is still `500` — but on **6** missing variables instead of
seven, and the one that disappeared is `SUPABASE_SECRET_KEY`. That is the intended end state of this
phase: configuration initialisation now gets past the key, and stops at the external credentials
this phase was explicitly forbidden to add.

## 6. CORS

No CORS code was changed. Hosted `OPTIONS` requests still fail during configuration validation
(before CORS headers are computed), so their behaviour cannot be verified until the remaining
variables exist; nothing points at a CORS defect beyond that. This is unchanged from Phase 6D's
finding.

## 7. Remaining external configuration

Only these still stand between the deployed backend and a working hosted buyer flow:

| Variable                                                                                 | Needed for                                                                              |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`, `WOMPI_INTEGRITY_SECRET`, `WOMPI_EVENTS_SECRET` | quote/order creation and payment confirmation (sandbox values from the Wompi dashboard) |
| `PUBLIC_WEB_BASE_URL`                                                                    | redirect URL and email links                                                            |
| `API_BASE_URL`                                                                           | QR/confirmation links                                                                   |
| `CORS_ALLOWED_ORIGINS`, `MAINTENANCE_API_TOKEN`, `APP_ENV=sandbox`                       | required once the deployment is not `development`                                       |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`                                         | confirmation email                                                                      |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SPREADSHEET_ID`            | the read-only Sheets projection                                                         |
| Published domain                                                                         | `PUBLIC_WEB_BASE_URL` value                                                             |

Notably absent from that list: the Supabase secret key. The platform provides it.

## 8. Backend data

**No event, ticket-type, pricing-tier, inventory, capacity, discount or stage row was inserted —
locally or on the hosted project.** The only database changes are the schema-level function
replacement in the new migration. The client data gaps from Phase 6D (capacity, per-tier inventory,
sales windows, street address) are unchanged.

## 9. Still not ready

The hosted buyer flow must not be described as ready: the deployment answers `500` on every endpoint
until the variables in §7 are set, and the event/product rows still do not exist. The replay fix and
the key compatibility are verified at the level described above — code plus a locally exercised
journey — not by a hosted purchase.
