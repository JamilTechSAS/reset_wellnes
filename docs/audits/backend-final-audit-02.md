# Backend final audit — independent verification (02)

Auditor: independent review. Date: 2026-10-05. Repository: `Tatiana` (event ticketing
backend). Method: reconstruct the system from code, SQL and the running local Supabase
stack — do **not** trust prior phase reports. Every claim below cites a command or an
artifact that was actually executed during this audit.

## Legend

| Status            | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| GREEN             | Implemented and covered by tests that were re-run in this audit               |
| YELLOW            | Implemented but a material condition, gap or ambiguity remains                |
| RED               | Implemented but broken / unsafe in a way that blocks use                      |
| NOT IMPLEMENTED   | No implementation exists                                                      |
| NOT VERIFIED LIVE | Implemented and locally tested, but never exercised against the real provider |

---

# Executive Verdict

**APPROVED WITH CONDITIONS.**

The backend is internally coherent, its security-critical invariants hold under real
concurrency, and no defect was found in the code or schema that would corrupt a payment,
lose a ticket, expose personal data or allow double entry. Independently reproduced on the
local Supabase stack (PostgREST 16.4 + PostgreSQL 17.11): all 22 migrations apply from zero;
`anon`/`authenticated` are denied everything (`401 42501`) while `service_role` succeeds; the
full order → payment → ticket → QR → email-outbox → check-in journey works; every attempted
payment tamper (wrong amount, currency, reference, second approval) is refused with a typed
error; a replayed confirmation is idempotent; and three real two-session races (double
check-in, last-unit oversell, concurrent double approval) each produced exactly one winner.

The conditions are **not** backend code defects. They are things that cannot be verified or
supplied from inside this repository:

1. **No business data exists.** `supabase/seed.sql` is empty by design; the event, ticket
   type, sales stages, prices and discount codes are client-owned rows and are absent.
   Until they are loaded, the backend cannot price or sell anything.
2. **No live provider verification.** Wompi Sandbox, Resend and Google Sheets have never
   been called (no credentials anywhere in the repo or environment). This is the single
   largest residual risk for real money and is a hard pre-sale gate.
3. **No hosted deployment.** No Supabase project exists; the hosted Data API boundary,
   secret storage, custom domain, cron and production credential binding are unproven.

The backend is ready to support frontend integration. It is **not** ready to take real COP
until §24 is complete. The verdict is deliberately not "APPROVED": approving a payment
system that has never spoken to the payment provider would be dishonest.

---

# 1. Scope

In scope: everything under `supabase/` (22 migrations, 7 Edge Functions, `_shared` core),
`tests/`, `docs/`, `package.json`, `supabase/config.toml`, `.env.example`.

Out of scope and **not** started: frontend work. Note that a Spanish landing page already
exists in this repository (`src/`, `tests/frontend/`, `docs/phases/phase-06a.md`) from an
earlier phase; it was not modified and its quality was not assessed (finding AUD2-02).

Not available to this audit: real Wompi / Resend / Google credentials, a hosted Supabase
project, and a deployed frontend. Those are reported as NOT VERIFIED LIVE, never as verified.

---

# 2. Architecture Reconstruction

Reconstructed from source, not from the reports:

```
Browser (Spanish frontend, not audited)
  │  HTTPS + CORS (explicit origins; `*` refused outside dev)
  ▼
Supabase Edge Functions (Deno 2, TypeScript strict) — 7 functions
  health            GET  /health
  events            GET  /events/{code}, /events/{code}/availability
  orders            POST /orders, POST /orders/quote,
                    GET  /orders/{ref}, POST /orders/{ref}/retry,
                    POST /orders/{ref}/payment-hint,
                    POST /orders/{ref}/participants,
                    PUT  /orders/{ref}/participants/{id}
  tickets           GET  /tickets/{token}
  checkin           POST /check-in, GET /check-in/{token}   (Supabase Auth + operators row)
  webhooks-wompi    POST /webhooks/wompi                    (event checksum)
  orders-maintenance POST /orders-maintenance               (Bearer MAINTENANCE_API_TOKEN)
  │  each index.ts is a thin adapter → portable core in _shared/api/*
  │  core: _shared/{domain,config,integrations,db,http,logging}
  ▼
Supabase PostgreSQL 17 (source of truth)   ── RLS on all 19 tables, 0 policies
  public.*      19 tables, 1 view (operational_export), 27 functions
  app_private.* 25 helper functions (unreachable from the Data API)
  pg_cron job  event-ticketing-maintenance  */5 * * * *  → app_private.invoke_scheduled_maintenance()
  │
  ├── Wompi Colombia      checkout signature (server-side); GET /v1/transactions/{id} (private key);
  │                       transaction.updated webhooks (events secret)
  ├── Resend              confirmation email (outbox in DB, provider idempotency key)
  └── Google Sheets       read-only projection (outbox in DB; SHEETS_ENABLED gates it)
```

Verified structural facts (live stack, after `db reset`):

| Fact                   | Value                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| Tables (public)        | 19                                                                                         |
| Views (public)         | 1 (`operational_export`, `security_invoker=true`)                                          |
| Indexes (public)       | 71 (38 unique)                                                                             |
| Constraints (public)   | 160 = check 95, FK 30, PK 19, unique 16                                                    |
| Enums (public)         | 9                                                                                          |
| Functions              | 27 public + 25 `app_private`                                                               |
| Triggers (public)      | 22                                                                                         |
| RLS enabled / policies | 19 / 0                                                                                     |
| Extensions             | pg_cron, pg_net, pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp          |
| Scheduler              | `event-ticketing-maintenance` `*/5 * * * *` → `app_private.invoke_scheduled_maintenance()` |
| Data client            | 27 `client.rpc(...)` + 5 `.from(...)` reads; secret key only                               |

---

# 3. Requirements Traceability

32 intended capabilities. "Impl" is the in-repo status; "Live" marks whether the item could
be exercised against the real external provider during this audit.

| #   | Requirement                   | Endpoint / function                                                        | Tables / SQL                                          | Tests                                                    | Impl                | Live                                       |
| --- | ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- | ------------------- | ------------------------------------------ |
| 1   | Event retrieval               | `GET /events/{code}` → `get_public_event`                                  | events                                                | api/public-handler, schema/phase5                        | GREEN               | n/a (local SQL+HTTP probed)                |
| 2   | Availability                  | `GET /events/{code}/availability` → `get_public_availability`              | pricing_tiers, `app_private.availability_label`       | api/public-handler, schema/phase5                        | GREEN               | n/a                                        |
| 3   | Pricing                       | `POST /orders/quote` → `quote_order_price`                                 | pricing_tiers                                         | domain/pricing, schema/pricing-parity                    | GREEN (live-probed) | n/a                                        |
| 4   | Pricing stages                | `app_private.active_pricing_tier_id` / `reserve_pricing_tier`              | pricing_tiers                                         | schema/pricing-parity                                    | GREEN               | n/a                                        |
| 5   | Quantity discounts            | pricing engine                                                             | quantity_discounts (ships empty)                      | domain/pricing, schema/pricing-parity                    | GREEN               | n/a (unconfigured)                         |
| 6   | Discount codes                | pricing engine + `claim_discount_redemption`                               | discount_codes, discount_redemptions                  | schema/pricing-parity, schema/constraints                | GREEN               | n/a (unconfigured)                         |
| 7   | Inventory reservation         | `create_order` → `reserve_pricing_tier`                                    | pricing_tiers                                         | schema/pricing-parity, constraints, live race            | GREEN (live)        | n/a                                        |
| 8   | Order creation                | `POST /orders` → `create_order`                                            | orders, order_items, participants, consents, payments | api/orders-handler, schema/pricing-parity                | GREEN (live)        | n/a                                        |
| 9   | Idempotency                   | `orders.idempotency_key` partial unique index                              | orders                                                | schema/pricing-parity, constraints                       | GREEN (live)        | n/a                                        |
| 10  | Wompi checkout preparation    | `buildWompiCheckout`                                                       | —                                                     | integrations/wompi/integrity-signature                   | GREEN               | **NOT VERIFIED LIVE**                      |
| 11  | Webhook verification          | `POST /webhooks/wompi` → `verifyWompiEvent`                                | payment_events                                        | api/webhook-handler, integrations/wompi/events           | GREEN               | **NOT VERIFIED LIVE**                      |
| 12  | Transaction lookup            | `WompiClient.getTransaction` (private key)                                 | —                                                     | integrations/wompi/client                                | GREEN               | **NOT VERIFIED LIVE**                      |
| 13  | Payment confirmation          | `confirm_payment`                                                          | payments, orders, tickets, pricing_tiers              | schema/payment-confirmation, api/webhook                 | GREEN (live)        | n/a                                        |
| 14  | Payment retry                 | `POST /orders/{ref}/retry` → `retry_payment`                               | payments (new attempt/reference)                      | schema/payment-confirmation                              | GREEN               | n/a                                        |
| 15  | Payment reconciliation        | maintenance sweep + `POST /orders/{ref}/payment-hint`                      | claim/finish_payment_reconciliation, payments         | api/reconciliation-handler, payment-hint                 | GREEN               | **NOT VERIFIED LIVE**                      |
| 16  | Expiration                    | `expire_pending_orders` (maintenance)                                      | orders, pricing_tiers                                 | schema/payment-confirmation                              | GREEN               | n/a                                        |
| 17  | Ticket issuance               | inside `confirm_payment`                                                   | tickets `unique (order_item_id, order_item_seq)`      | schema/payment-confirmation (live replay)                | GREEN (live)        | n/a                                        |
| 18  | QR token                      | token generated in SQL / `generateTicketToken`                             | tickets.token CHECK                                   | domain/ticket-token, schema/payment-confirmation         | GREEN (live)        | n/a                                        |
| 19  | Participant assignment        | `POST/PUT …/participants` → `attach_participant`/`update_participant`      | participants, tickets, consents                       | api/participants-handler, schema/phase5                  | GREEN               | n/a                                        |
| 20  | Consent recording             | order creation + participant endpoints                                     | consents (append-only trigger)                        | domain/consents, schema/phase5                           | GREEN               | n/a                                        |
| 21  | Ticket lookup                 | `GET /tickets/{token}` → `get_public_ticket`                               | tickets                                               | api/public-handler, schema/phase5                        | GREEN (live SQL)    | n/a                                        |
| 22  | Operator authentication       | `_shared/api/operator-auth.ts` (Auth `getUser` + operators row)            | operators                                             | api/operator-auth, domain/operators                      | GREEN               | n/a                                        |
| 23  | Check-in                      | `POST /check-in` → `record_check_in`                                       | tickets, attendance                                   | api/checkin-handler, schema/phase5                       | GREEN (live)        | n/a                                        |
| 24  | Duplicate check-in protection | `unique (attendance.ticket_id)` + row lock                                 | attendance                                            | schema/phase5, live race                                 | GREEN (live)        | n/a                                        |
| 25  | Email outbox                  | `queue_ticket_emails` / `claim_email_deliveries` / `finish_email_delivery` | email_deliveries                                      | domain/email-delivery, schema/payment-confirmation       | GREEN (live queue)  | **send NOT VERIFIED LIVE**                 |
| 26  | Email retry                   | `dispatchEmails` in maintenance                                            | email_deliveries                                      | api/maintenance-handler, domain/email-delivery           | GREEN               | **NOT VERIFIED LIVE**                      |
| 27  | Google Sheets projection      | `runSheetsSync` + `claim/finish_sheet_projections`                         | sheets_projections, operational_export                | api/sheets-sync, domain/sheets, schema/phase5            | GREEN               | **NOT VERIFIED LIVE**                      |
| 28  | Sheets failure isolation      | enqueue inside tx; HTTP only in maintenance; `SHEETS_ENABLED`              | sheets_projections                                    | api/sheets-sync, api/maintenance-handler                 | GREEN               | n/a (unconfigured)                         |
| 29  | Rate limiting                 | `guardRateLimit` → `consume_rate_limit` (10 scopes)                        | rate_limit_counters                                   | domain/rate-limits, api/rate-limit-guard, http/client-ip | GREEN (live SQL)    | n/a                                        |
| 30  | Maintenance / scheduler       | `POST /orders-maintenance` + pg_cron job                                   | cron.job, app_private.invoke_scheduled_maintenance    | api/maintenance-handler                                  | GREEN (job present) | **NOT VERIFIED LIVE (pg_net/Vault unset)** |
| 31  | Security controls             | RLS + grants + Data API boundary + checksum + Auth                         | all                                                   | schema/rls, schema/backend-role-access, live probes      | GREEN (live)        | n/a                                        |
| 32  | Logging / observability       | `_shared/logging/*` (JSON, redaction)                                      | —                                                     | logging/redaction                                        | GREEN               | n/a                                        |

No item is RED or NOT IMPLEMENTED. Seven items are marked NOT VERIFIED LIVE — all of them
depend on an external provider or a hosted project that does not exist.

---

# 4. End-to-End Business Flow

Executed against the live stack as PostgreSQL `service_role` (the backend's own identity),
with synthetic catalog data created and then removed. Ordered transcript (abridged):

| Step | Action                                         | Observed result                                                                    |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1    | `quote_order_price('AUD-2026','GENERAL',2,15)` | unitPrice 9500000, total 19000000, `BEST_SINGLE`, availability `LOW`               |
| 2    | `create_order(… qty 2, idempotency key …)`     | `PENDING`, reference `EVT-2026-000001`, attempt 1, reserves 2                      |
| 3    | replay same idempotency key                    | `replayed = true`, reserved stays 2 (no double reservation)                        |
| 4    | ledger `claim_webhook_event` + `finalize`      | claimed `true`, finalized `true`                                                   |
| 5    | `confirm_payment(… APPROVED, 19000000, COP)`   | `APPLIED`, `orderStatus PAID`, `ticketsIssued 2`, reserved→sold                    |
| 6    | inspect tickets                                | 2 tickets, all tokens match `^TKT_[0-9A-HJKMNP-TV-Z]{20}$`, price sum = line total |
| 7    | `get_order_status(ref, buyer email)`           | `found true`; wrong email → `false`; unknown ref → `false` (identical)             |
| 8    | `get_public_ticket` / `get_operator_ticket`    | public: code+status+`Ana P.`; operator: adds cédula/city, **no email/phone**       |
| 9    | `record_check_in(token, …)` ×2                 | `VALID` then `ALREADY_USED`; 1 attendance row; operator id recorded                |
| 10   | `queue_ticket_emails(order)` ×2                | queued 2 then 0; total 2 rows                                                      |
| 11   | `confirm_payment` replayed twice more          | `DUPLICATE`, `ticketsIssued 0`, tickets total stays 2                              |

Every transition the acceptance scenario requires was reproduced locally. Only the two steps
that touch a third party (11: the real Wompi webhook delivery, 15: the real email send) were
not exercised live.

---

# 5. Functional Findings

- Order arithmetic is consistent and enforced by CHECK constraints (`subtotal − quantity −
code = total`; `unit_price × qty − discount = line_total`); a live confirmation split 2
  units across 19000000 centavos with no rounding loss.
- `get_order_status` returns identical `found:false` for a wrong email and an unknown
  reference (verified live) — no enumeration oracle.
- Confirmation is idempotent: re-running `confirm_payment` after `PAID` yields `DUPLICATE`
  with zero new tickets and zero new emails (verified live).
- The `orders` adapter answers HTTP 405 to a `GET`/`POST` with a malformed order path
  (finding AUD2-06) — cosmetic, no security impact.
- **Open business data gap (AUD2-07):** no event/price/tier/discount rows exist. By design,
  but it means the "correct amount" half of the acceptance question cannot be evaluated with
  real values yet.

---

# 6. Payment Security

Server-side authority is structural, not incidental: the price is computed in SQL inside the
order transaction; the integrity signature is produced only server-side; the webhook body is
treated as a pointer and the authoritative status is re-read with the private key.

Reproduced tampering attacks (live stack, `service_role`):

| Attack                                       | Result                                          | Severity if it had passed |
| -------------------------------------------- | ----------------------------------------------- | ------------------------- |
| Confirm with `amount + 1`                    | `PT409 AMOUNT_MISMATCH`                         | CRITICAL — blocked        |
| Confirm with `currency = USD`                | `PT409 CURRENCY_MISMATCH`                       | CRITICAL — blocked        |
| Confirm with a reference of another order    | `PT409 REFERENCE_MISMATCH`                      | CRITICAL — blocked        |
| Insert a second `approved` payment for order | `PT409 DOUBLE_PAYMENT_CONFLICT` (guard trigger) | CRITICAL — blocked        |
| Replay the same confirmation 3×              | `APPLIED` then `DUPLICATE`; 2 tickets total     | HIGH — blocked            |
| Reuse a Wompi reference across orders        | unique constraint + `REFERENCE_MISMATCH`        | HIGH — blocked            |
| Unknown provider status                      | normalized to `unknown`, never advances         | HIGH — blocked            |

Two-session race, concurrent double approval: one `APPLIED`, the other
`DOUBLE_PAYMENT_CONFLICT`, exactly one approved payment and one ticket — the advisory-lock
guard (migration `20261004120000`) works as documented.

Reference/attempt model is sound: attempt 1 = order reference; retries append `-<n>`; a used
reference is never reused. Reconciliation and the buyer payment-hint converge on the **same**
`confirm_payment` function (verified by reading the handler + SQL), so a recovered payment is
indistinguishable from a webhook-delivered one.

Payments remain **NOT VERIFIED LIVE** against Wompi (no credentials) — see §20.

---

# 7. Database Security

Verified on the live stack after `db reset`:

| Check                                              | Result                              |
| -------------------------------------------------- | ----------------------------------- |
| RLS enabled on every table                         | 19/19                               |
| Policies                                           | 0 (browser roles denied by absence) |
| Table grants — anon / authenticated / service_role | 0 / 0 / 140                         |
| Function EXECUTE — anon / authenticated / service  | 0 / 0 / 27 (all public)             |
| `app_private` USAGE — anon / authenticated / svc   | false / false / true                |
| `operational_export`                               | `security_invoker = true`           |
| Public functions SECURITY DEFINER                  | **0** (all 27 are SECURITY INVOKER) |
| Public functions with a non-empty `search_path`    | **0** (all `set search_path = ''`)  |
| HTTP: anon table read / RPC                        | `401` `42501` (table + function)    |
| HTTP: publishable key table read                   | `401`                               |
| HTTP: service_role table read / RPC                | `200` / `200`                       |
| HTTP: `/graphql/v1`                                | `404` (not exposed)                 |
| HTTP: `app_private` function via RPC               | `404` (schema not exposed)          |

Residual behaviour recorded (finding AUD2-05): a **new** `public` function still gets
`proacl = NULL`, i.e. PostgreSQL's built-in `EXECUTE` to `PUBLIC` survives a default-privilege
revoke (re-confirmed live: `select proacl is null` → `t`). The defence is the per-function
`revoke all … from public, anon, authenticated` mandated by the migrations and enforced by the
function scan in `tests/schema/rls.test.ts`; a future migration that forgets it will fail the
build. This is a process control, and it is in place.

`service_role` is self-sufficient under the strict Supabase defaults: migration
`20261004150000` grants DML on all tables/sequences and re-establishes default privileges, so
the backend does not depend on the platform's automatic grants. Live privilege matrix matches
the closure report exactly (140 tables / 27 functions / app_private usable).

---

# 8. API Security

| Endpoint                                   | Auth                                 | Enumeration / IDOR defence                               | Rate scope                                        |
| ------------------------------------------ | ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------- |
| `GET /health`                              | none                                 | no data                                                  | —                                                 |
| `GET /events/{code}` `/availability`       | none                                 | uniform 404; whitelisted projection; coarse availability | `events:read`                                     |
| `POST /orders/quote`                       | none                                 | pure; `details` only for validation                      | `orders:quote`                                    |
| `POST /orders`                             | none                                 | no amount field exists; validation only for shape        | `orders:create`                                   |
| `GET /orders/{ref}`                        | reference + `X-Buyer-Email`          | wrong email ≡ unknown ref (verified live)                | `orders:status`                                   |
| `POST /orders/{ref}/retry`                 | reference + buyer email              | fresh reference per attempt                              | `orders:retry`                                    |
| `POST /orders/{ref}/participants`          | reference + buyer email              | foreign participant ≡ unknown (tests)                    | `orders:participants`                             |
| `PUT /orders/{ref}/participants/{id}`      | reference + buyer email              | same                                                     | `orders:participants`                             |
| `POST /orders/{ref}/payment-hint`          | reference + buyer email              | tx id re-validated against the buyer's own payment       | `orders:hint`                                     |
| `GET /tickets/{token}`                     | opaque 100-bit token (capability)    | malformed ≡ unknown ≡ same 404                           | `tickets:lookup`                                  |
| `POST /check-in` / `GET /check-in/{token}` | Supabase Auth + active operator      | 401 vs 403 distinguished                                 | `checkin:operator` (+ `checkin:attempt` pre-auth) |
| `POST /webhooks/wompi`                     | event checksum + private-key lookup  | dedupe ledger; forged deliveries recorded `REJECTED`     | —                                                 |
| `POST /orders-maintenance`                 | `Bearer MAINTENANCE_API_TOKEN` (≥32) | constant-time compare; refuses when unset                | —                                                 |

Mass assignment: `order-requests.ts` uses zod object schemas (unknown keys stripped) and the
SQL normalizer re-validates inside the transaction; no client-supplied price/status/id has a
code path to storage. Output projections are SQL whitelists (`get_order_status`,
`get_public_ticket`, `get_operator_ticket`, `get_public_event`), so a new column cannot leak
by accident.

Minor API-contract nuance (AUD2-06): a malformed order path returns `405` rather than `404`.

---

# 9. Privacy / PII

PII inventory: cédula (`participants.national_id`), email, phone, city, Instagram, consent
history, plus `orders.ip_address`/`user_agent` and `payments.provider_payload`.

Where each can appear, and whether that is correct:

| Location                          | Content                                                            | Assessment                                   |
| --------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| `get_public_ticket`               | code, status, `Ana P.` (abbreviated) — **no** cédula/email/phone   | minimal ✔                                    |
| `GET /orders/{ref}` projection    | no cédula/email/phone/IP/UA/tx id/signature/provider_payload       | minimal ✔                                    |
| `get_operator_ticket`             | name, **cédula**, city + order/payment/attendance — no email/phone | justified for identity check ✔               |
| Operators `GET /check-in/{token}` | same operator projection                                           | ✔                                            |
| Logs (`_shared/logging`)          | emails/phones masked, cédula never logged, depth/size bounded      | ✔ (unit-tested)                              |
| QR                                | opaque `TKT_…` token only                                          | ✔                                            |
| Google Sheets (client-owned)      | cédula/email/phone by explicit client requirement                  | justified, access-controlled by the client ✔ |
| `provider_payload`                | may contain customer email; never exposed via any endpoint         | retention policy pending (AUD2-09)           |

No unnecessary exposure found. `provider_payload` and `orders.ip_address` are the only
personal data without a defined retention plan.

---

# 10. Authentication / Authorization

Operator auth = two independent checks (`_shared/api/operator-auth.ts`): a Supabase Auth
access token verified by `auth.getUser` (never decoded locally), then an active
`public.operators` row with a role that `canAdmitTickets`. Verified by
`tests/api/operator-auth.test.ts`:

| Case                         | Expected           | Covered |
| ---------------------------- | ------------------ | ------- |
| missing token                | 401                | ✔       |
| malformed `Bearer`           | 401                | ✔       |
| expired / unverifiable token | 401                | ✔       |
| valid user, no operators row | 403                | ✔       |
| inactive operator            | 403                | ✔       |
| unknown role                 | 403 (fails closed) | ✔       |
| valid OPERATOR / ADMIN       | admitted           | ✔       |

The verified identity (user id + display name) is what `record_check_in` writes as
`checked_in_by` / `checked_in_by_user_id` — a client cannot spoof the operator label
(verified live: the attendance row carried the id passed by the server). `verify_jwt=false`
is safe here because the function performs the identical verification itself; there is no
path that skips it.

---

# 11. QR / Check-in Security

- Token format `TKT_` + 20 Crockford base32 chars from a CSPRNG; generated in SQL from a v4
  UUID's random bytes. Live generation produced valid tokens; every generated token matched
  the CHECK `^TKT_[0-9A-HJKMNP-TV-Z]{20}$` in the flow test.
- Entropy observation (AUD2-10): the SQL transform `upper(base64) → translate` is not a
  perfect bijection, so the effective alphabet is a ~29–38 symbol subset; conservative
  entropy is ≥ ~90 bits (still far beyond brute force) and the output always satisfies the
  CHECK. Not a defect.
- Check-in decision precedence (cancel → unpaid → used → valid) was exercised live:
  `VALID` then `ALREADY_USED`, exactly one attendance row, operator recorded.
- Two-session race on the same token: one `VALID`, one `ALREADY_USED`, 1 attendance row.
- No sensitive data embedded in the QR (token only). A malformed token short-circuits before
  any DB lookup (`INVALID`).
- Unpaid-ticket path returns `NOT_PAID` (SQL branch verified by reading `record_check_in`;
  the test suite covers all five outcomes).

---

# 12. Rate Limiting / Abuse

Ten scopes in `_shared/domain/rate-limits.ts`, matching `docs/api.md §3` exactly. Verified
live: `consume_rate_limit(scope,key,3,60)` allowed requests 1–3 and refused the 4th.

- Keys are namespaced (`ip:`/`ref:`/`op:`) and md5-hashed before storage; no raw IP/reference
  is stored. `rateLimitKey` returns `undefined` for empty/oversized identifiers → the request
  is allowed (documented).
- Client IP resolution (`resolveClientIp`, regression-tested) prefers `cf-connecting-ip`,
  then the **last** valid `x-forwarded-for` entry, normalizes `ip:port` and IPv6, and ignores
  malformed values — a caller cannot choose its bucket.
- `checkin:attempt` is consumed only for token-less requests, so a venue behind one NAT is not
  throttled.
- The guard **fails open** on a limiter failure (finding AUD2-08): an abuse control must never
  take down checkout or the door. Documented trade-off; validation, opaque tokens and the
  reference+email possession rule still apply.
- `RATE_LIMIT_ENABLED=false` is a documented emergency off-switch.

---

# 13. Email / Outbox

Design: one outbox row per `(ticket, template)` with `idempotency_key` **derived by CHECK**
(`'ticket:' || ticket_id || ':' || template`), claimed with `FOR UPDATE SKIP LOCKED`, and the
same key passed to Resend as `Idempotency-Key`.

Verified live: after one paid order, `queue_ticket_emails` queued 2 rows; a second call queued
0; a replayed `confirm_payment` queued 0 more. Duplicate webhook ⇒ no duplicate logical email;
concurrent dispatch ⇒ no shared row (SKIP LOCKED); permanent failures are bounded by the
attempt ceiling.

The send itself (Resend HTTP) is **NOT VERIFIED LIVE** — no API key. The outbox remaining
`QUEUED` is a valid, visible state; nothing is lost while emails wait.

---

# 14. Google Sheets

Sheets is strictly downstream: enqueueing a projection is a plain insert inside the writer's
transaction; the HTTP call happens only in the maintenance job, wrapped so a Google failure is
logged into `jobErrors` and cannot touch payment, ticketing or check-in. `SHEETS_ENABLED`
defaults to **false** (skips the sync, every other job runs). Writes use
`valueInputOption: "RAW"`, so a value beginning `=` is stored as text (formula-injection
defence, unit-tested). The client's spreadsheet holds cédula/email/phone by explicit business
requirement.

No live write occurred (no service account) — **NOT VERIFIED LIVE**. Failure isolation is
verified at the code and test level (api/sheets-sync, api/maintenance-handler).

---

# 15. Scheduler / Reconciliation

- The cron job exists in the live database: `event-ticketing-maintenance`, `*/5 * * * *`,
  `select app_private.invoke_scheduled_maintenance();` (pg_cron → pg_net → the maintenance
  endpoint; secrets read from Vault). `vault.secrets` is empty in local dev, so the scheduled
  HTTP call is **NOT VERIFIED LIVE**.
- Every maintenance job is idempotent and concurrent-safe (`SKIP LOCKED` + atomic claims).
  Expiry and email failure ⇒ 500 (surfaced); reconciliation, rate-limit cleanup and sheets are
  isolated into `jobErrors` and cannot stop the others.
- Reconciliation and the buyer hint feed the **same** `confirm_payment`; a duplicate scheduler
  run cannot produce a second state transition (idempotent by construction, proven at the
  confirm level by the replay test). Live reconciliation needs Wompi — **NOT VERIFIED LIVE**.

---

# 16. Migration Integrity

| Check                                      | Command                        | Exit | Result                                                                   |
| ------------------------------------------ | ------------------------------ | ---- | ------------------------------------------------------------------------ |
| Apply all migrations from zero             | `npx supabase db reset`        | 0    | 22 files applied in order, seed loaded                                   |
| Schema lint                                | `npx supabase db lint --local` | 0    | 6 cosmetic plpgsql warnings only (unused var / shadowing / unused param) |
| Schema drift                               | `npx supabase db diff --local` | 0    | "No schema changes found"                                                |
| Regenerate types                           | `supabase gen types --local`   | 0    | 680 lines, **byte-identical** to committed `database.types.ts`           |
| Inventory (tables/views/index/constraints) | live queries                   | 0    | matches §2                                                               |

The six lint warnings are accepted and cosmetic (`create_order` unused `v_replay`/never-read
`v_payment_id`; `confirm_payment` shadowed+unused `v_unit`/never-read `v_max_attempt`;
`finish_payment_reconciliation` unused `p_now`). No functional impact; a "lint exits 0 with
warnings" state should be noted so a future stricter lint does not surprise the team.

---

# 17. Test Quality

Re-run independently: **`npm run check` → exit 0**, all sub-commands 0 (typecheck, eslint,
prettier, `deno check` per function, vitest).

**Count discrepancy (AUD2-01):** the suite is **471 tests in 47 files**, not the
**439 in 43** claimed in `docs/testing.md`, `docs/audits/pre-frontend-closure-01.md` and
`pre-frontend-audit-01.md`. The difference is the four `tests/frontend/*` files added in
Phase 6A after the backend closure (backend-only subset still totals 439). The claim is stale,
not wrong about the backend.

Assessment of quality (read, not merely counted):

- **Strong:** Wompi crypto is asserted against Wompi's published vector and an independent
  SHA-256; the webhook handler tests cover rejection recording, duplicate-claim 200, amount/
  reference/currency mismatch, unknown reference, the reconciliation path and the 200/503
  contract; `schema/rls.test.ts` recreates Supabase's default grants before asserting zero
  access (so it can actually fail); `schema/backend-role-access.test.ts` runs the API **as
  `service_role`**, which is the check that catches privilege bugs a `has_function_privilege`
  probe misses; `pricing-parity.test.ts` binds the SQL and TypeScript pricing engines together.
- **Genuinely discriminating:** `backend-role-access.test.ts` fails 3/3 if migration
  `20261004150000` is removed (structural strict baseline).
- **Limitations (known, tracked in `docs/testing.md` §5):** PGlite is single-session, so
  concurrency is not in the automated gate (mitigated by the real-PostgreSQL races, three of
  which this audit re-ran); there is no automated HTTP-level test of the Edge Functions; and
  the email send path has no dedicated suite.
- **No test was weakened, skipped or deleted** during this audit. No change to `tests/` was
  required, because no backend defect was found.

CI/robustness note: the schema suites are slow (~22–26 s each) because each spawns an isolate;
the runner itself hints `isolate: false` would cut ~3.6 s. Cosmetic.

---

# 18. Performance / Capacity

Target is ~120 attendees, single event. Nothing in the design is unbounded in a way that
matters at this scale:

- Order/payment/check-in writes are single-row transactions against indexed keys; the
  heaviest webhook path does one private-key HTTP GET plus one SQL transaction.
- Check-in is `select … for update` on a unique token + one insert; ~120 scans is trivial
  against the 600/min per-operator limit.
- The email outbox and Sheets projections are drained in bounded batches
  (`EMAIL_DISPATCH_BATCH_SIZE`, `claim_sheet_projections(limit)`), never "all rows".
- `max_rows = 1000` on the Data API bounds accidental large reads.
- Rate limits are generous but finite, protecting against bursts.

No load test was run — appropriately, this is not a high-scale system, and the audit does not
claim capacity beyond "obviously sufficient for ~120 people". The one thing to watch is the
PostgREST/Kong single-node default in a burst, which the platform handles.

---

# 19. Deployment Readiness

Intended topology: Vercel frontend → Supabase Edge Functions → Supabase PostgreSQL; Wompi,
Resend, Google Sheets as third parties. Reviewed against `docs/environments.md §8`:

| Area                   | State                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Env separation         | `APP_ENV` (development/sandbox/production) binds credentials by prefix; mismatch rejected at startup; `WOMPI_BASE_URL` override dev-only |
| Secrets                | `.env.example` has 28 placeholders; no `.env.local`; secret sweep clean; `.gitignore` covers `.env*`                                     |
| Migrations             | 22 files, verified from zero, lint/diff/types clean                                                                                      |
| Function policies      | `verify_jwt=false` per function with rationale; `schemas=["public"]`; `auto_expose_new_tables=false`                                     |
| CORS                   | explicit origins; `*` and localhost rejected outside development                                                                         |
| HTTPS                  | enforced on configured URLs outside development                                                                                          |
| Scheduler              | pg_cron job present; Vault secrets + pg_net **not** configured locally                                                                   |
| Deploy steps remaining | see §24                                                                                                                                  |

Signing keys, custom domain, TLS and hosted-project settings are unverified (no project).

---

# 20. External Provider Verification

Explicit separation, as required. Nothing in the "real provider" rows was executed.

### Verified locally (Node, no network)

Domain logic: money, references, order/payment state machines, pricing, tickets, check-in
precedence, consents, operators, rate limits, email idempotency, Sheets grid/labels. ✔

### Verified with real PostgreSQL / real Supabase stack

`db reset` from zero (22 migrations); full privilege/RLS matrix; Data API boundary over HTTP
(anon 401/42501, publishable 401, service_role 200, GraphQL 404, private schema 404); the full
buyer journey through `service_role`; all payment tamper rejections; confirmation replay
idempotency; three two-session concurrency races; ticket-token format; check-in VALID→
ALREADY_USED; rate-limit window. ✔

### Verified with mocks / fixtures

Wompi HTTP client and transaction lookup (injected `fetch`); Resend client; Google Sheets
client (injected `fetch`); webhook fixtures signed with an independent SHA-256. ✔

### Verified with a real external provider

| Provider         | State                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Wompi Sandbox    | **NOT VERIFIED LIVE** — no `prv_test_*`/`pub_test_*`/secrets anywhere    |
| Wompi Production | **NOT VERIFIED LIVE**                                                    |
| Resend           | **NOT VERIFIED LIVE** — no `re_*` key                                    |
| Google Sheets    | **NOT VERIFIED LIVE** — no service account                               |
| Hosted Supabase  | **NOT VERIFIED LIVE** — no project; hosted Data API/secret/cron unproven |
| Hosted frontend  | **NOT VERIFIED LIVE** (and out of scope)                                 |

### Not verified

Live webhook delivery and Wompi's retry schedule; live declined/pending paths; pg_net/Vault
scheduled invocation; production credential binding to real keys.

---

# 21. Business Requirements Coverage

| Business requirement               | State                                                               |
| ---------------------------------- | ------------------------------------------------------------------- |
| ~120 attendees, one general ticket | Backend-ready; catalog row (event, ticket type) **must be created** |
| Multiple presale stages            | Backend-ready (`pricing_tiers`); stage rows **must be created**     |
| Discount code                      | Backend-ready (`discount_codes`); rows **must be created**          |
| Quantity discounts                 | Backend-ready (`quantity_discounts`); empty (opt-in)                |
| Participant data                   | GREEN                                                               |
| Consent (personal data + future)   | GREEN (append-only history)                                         |
| Email confirmation                 | Backend-ready; live send pending credentials                        |
| Ticket + QR                        | GREEN                                                               |
| QR check-in + duplicate detection  | GREEN (race-verified)                                               |
| Google Sheets visibility           | Backend-ready; live write pending credentials                       |
| Future-event communication consent | GREEN                                                               |
| Fast purchase flow                 | GREEN (thin contract; not livemeasured)                             |

Every capability is implemented; the gap is **configuration data and provider credentials**,
not code.

---

# 22. Open Business Decisions

Only decisions that still need the client (technical choices already made are omitted):

1. Final event details (name, date, venue, city, sales window) and the ticket type name.
2. Number of presale stages, each price (COP) and quantity, and the stage boundaries.
3. Whether quantity discounts apply, with breakpoints and percentages.
4. Discount code(s): value, validity window, usage limits, per-order limits.
5. Discount stacking: keep `BEST_SINGLE` or switch to `STACK`.
6. Reservation window (`ORDER_RESERVATION_MINUTES`, currently a 15-minute technical default).
7. Duplicate cédula policy (unique per event? warn only?) — the constraint is deliberately absent.
8. Final consent wording + `policy_version` (backend writes `v1` if the client sends none).
9. Data-retention period, and a shorter one for `payments.provider_payload`.
10. Enabled payment methods (PSE/Nequi/Bancolombia introduce delayed approval).
11. Refund policy (backend records `refunded`; it never initiates a refund).
12. Whether to use Wompi `expiration-time` in the checkout (changes the signature inputs).
13. Final email content and `EMAIL_FROM`/`REPLY_TO` verified domain.
14. Manual check-in fallback policy (admitting a pending payment) and its recording.
15. Whether buyers may edit participant data after payment.

---

# 23. Findings by Severity

No CRITICAL or HIGH findings. The backend code and schema are sound under independent attack.

### AUD2-01 — Documentation: stale test count — **MEDIUM** (documentation)

- **Evidence:** `docs/testing.md:33` and `docs/audits/pre-frontend-closure-01.md:439` say
  "439 tests in 43 files"; `npm run check` this audit → `471 tests in 47 files`.
- **Reproduction:** `npm run check` → "Test Files 47 passed / Tests 471 passed / CHECK_EXIT:0".
- **Impact:** overstates accuracy of the backend-closure evidence and hides that the suite
  changed after the closure (four `tests/frontend/*` files, 32 tests).
- **Status:** OPEN (docs).
- **Fix:** update the counts and state clearly that 439 is the backend-only subset.
- **Regression test:** none applicable (documentation).

### AUD2-02 — Documentation/scope: README says "No frontend was built" — **MEDIUM** (documentation)

- **Evidence:** `README.md:13` "No frontend was built"; but `src/` (13 components),
  `tests/frontend/*` (4 files) and `docs/phases/phase-06a.md` exist (frontend COMPLETE).
- **Reproduction:** `ls src tests/frontend`; `head docs/phases/phase-06a.md`.
- **Impact:** a reader cannot tell the project state; risks scope confusion in later phases.
- **Status:** OPEN.
- **Fix:** correct the README status line to reflect Phase 6A.

### AUD2-03 — Documentation: `architecture.md` header frozen at Phase 4 — **LOW**

- **Evidence:** `docs/architecture.md` header says "Status: Phase 4 … check-in, the operational
  export and the public event endpoints are still explicitly labelled as planned", yet all are
  implemented (Phase 5).
- **Status:** OPEN. **Fix:** update the header.

### AUD2-04 — Documentation: GraphQL status code — **LOW**

- **Evidence:** `docs/api.md:512` says the GraphQL route answers `PGRST106`, HTTP `406`; the
  live stack returns HTTP `404`.
- **Reproduction:** `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/graphql/v1` →
  `404`. Both mean "not exposed"; only the number differs.
- **Status:** OPEN. **Fix:** state "not exposed" without pinning the exact code.

### AUD2-05 — New `public` functions inherit `PUBLIC` EXECUTE — **INFORMATIONAL**

- **Evidence:** live probe — a freshly created `public` function has `proacl IS NULL`;
  `alter default privileges … revoke … from public` does not remove it (re-confirmed on PG17).
- **Impact:** a future migration that adds a function without the per-function revoke would
  make it callable by `PUBLIC`. Mitigated by the mandated `revoke` in the migrations, the
  function scan in `tests/schema/rls.test.ts`, and the review checklist in `docs/security.md`.
- **Status:** ACCEPTED (mitigated). No action.

### AUD2-06 — Malformed order path returns 405, not 404 — **LOW**

- **Evidence:** `orders/index.ts` falls through to the 405 branch when the path matches no
  route regex.
- **Impact:** cosmetic contract nuance; no enumeration or security effect.
- **Status:** OPEN (optional). **Fix (optional):** return 404 for unmatched order paths.

### AUD2-07 — Business data absent — **INFORMATIONAL (pre-launch condition)**

- **Evidence:** `supabase/seed.sql` is intentionally empty; live `select count(*) from
public.events` → 0.
- **Impact:** the backend cannot price or sell until the client supplies the event, tiers,
  prices and codes.
- **Status:** OPEN (blocking for a real sale; by design).

### AUD2-08 — Rate-limit guard fails open — **INFORMATIONAL**

- **Evidence:** `rate-limit-guard.ts` catches limiter errors and allows the request.
- **Impact:** a limiter outage removes an abuse control (never takes down checkout/door).
  Compensated by validation, opaque tokens, possession checks.
- **Status:** ACCEPTED (documented).

### AUD2-09 — `provider_payload` retention undecided — **INFORMATIONAL**

- **Evidence:** `payments.provider_payload` may contain the customer email; never exposed.
- **Impact:** personal data retained without a defined period.
- **Status:** OPEN (client decision, §22.9).

### AUD2-10 — SQL ticket-token entropy is slightly below the nominal 100 bits — **INFORMATIONAL**

- **Evidence:** the SQL generator maps `upper(base64)` through `translate`, which is not a
  bijection (e.g. `A→3`, `+→0`), so the effective alphabet is a 29–38 symbol subset;
  conservative entropy ≥ ~90 bits. Every generated token still matched the CHECK in the live
  run.
- **Impact:** none practical — ~90 bits is far beyond brute force for a 120-person event.
- **Status:** ACCEPTED. **Fix (optional):** if a mathematically exact 100 bits is desired, draw
  the 20 Crockford characters directly from random bytes rather than from base64.

---

# 24. Required Actions Before Launch

Ordered; items 1–6 are blocking.

1. **Load business data** — event (`PUBLISHED`), ticket type, pricing tier(s) with price,
   quantity and sales window, plus discount codes/quantity discounts if used (§22). Until this
   exists, `create_order` cannot price anything. **BLOCKING.**
2. **Run Wompi Sandbox Tests 1–5** (approved; declined; pending→approved delayed; lost webhook
   recovered via sweep **and** via the payment hint; forged/tampered checksum rejected) against
   the real sandbox, then record the outcome. **BLOCKING for real money.**
3. **Live Resend send** to a real inbox from the verified domain; confirm the outbox row
   transitions `QUEUED → SENT` and the `Idempotency-Key` prevents a duplicate. **BLOCKING for
   confirmation email.**
4. **Deploy to hosted Supabase** and re-run the Data API probe matrix there (anon/authenticated/
   service_role) plus `/health`; set secrets; confirm `schemas=["public"]`, auto-expose off and
   `verify_jwt` per function match production. **BLOCKING.**
5. **Provision and rotate all production secrets** (`APP_ENV=production`, prod Wompi keys,
   `MAINTENANCE_API_TOKEN`, `SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, `GOOGLE_*`); verify the
   credential-prefix rejection fires on a deliberate mismatch. **BLOCKING.**
6. **Create operator accounts** (Supabase Auth user + active `public.operators` row) and test
   the 401/403 paths against the hosted deployment. **BLOCKING for check-in.**
7. **Google Sheets**: share the spreadsheet with the service account, set `SHEETS_ENABLED=true`,
   run one sync, then run a failure drill (revoke access) and confirm orders/tickets/check-in
   are unaffected. **PENDING.**
8. **Configure the scheduler** in the hosted project (Vault secrets + pg_cron, or the documented
   HTTP fallback) and confirm a maintenance run completes. **PENDING.**
9. **Confirm legal texts and policy** (consent wording + `policy_version`, retention, refunds).
   **PENDING (client).**
10. **Fix the documentation drift** (AUD2-01..04). **PENDING.**
11. **Frontend integration** — a separate phase; not started here. **PENDING.**

---

# 25. Final Verdict

**APPROVED WITH CONDITIONS.** The backend is trustworthy code and a sound database, and it is
safe to build the frontend against the frozen contract. It must not process real COP, send real
confirmation email, project to the client's sheet, or admit anyone at the door until the
blocking conditions in §24 are satisfied — all of which require credentials, a hosted project,
or client-supplied business data that do not exist in this environment. No CRITICAL or HIGH
code defect remains: every attempt to tamper with a payment, replay a webhook, race a second
approval, oversell the last unit, double-check-in, or read data as `anon` was refused or
resolved to exactly one correct outcome on a real PostgreSQL/Supabase stack.

## The acceptance question, answered clause by clause

> "If the Spanish frontend were connected today and a real customer paid with real COP, would
> this backend reliably…"

| Clause                                             | Answer                        | Basis                                                                                                                               |
| -------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| calculate the correct amount                       | **Yes** (given business data) | price is SQL-computed inside the order tx; no amount is client-supplied; live quote recomputed server-side                          |
| reserve one available ticket                       | **Yes**                       | conditional atomic UPDATE; live race produced exactly one order for the last unit                                                   |
| process the payment securely                       | **Yes**                       | widget checkout, server-side signature, private-key lookup, no card data touches the backend                                        |
| confirm only from trusted server-side evidence     | **Yes**                       | webhook body is a pointer; status re-read with the private key; checksum verified; wrong amount/currency/reference all refused live |
| issue exactly the correct number of tickets        | **Yes**                       | live: qty 2 → 2 tickets; replay → `DUPLICATE` with 0 new tickets                                                                    |
| generate valid QR codes                            | **Yes**                       | live: every token matched `^TKT_[0-9A-HJKMNP-TV-Z]{20}$`; ~90+ bits of CSPRNG entropy                                               |
| send the confirmation                              | **Conditionally**             | outbox logic verified live; the actual Resend send is NOT VERIFIED LIVE                                                             |
| protect participant data                           | **Yes**                       | projections whitelisted; cédula absent from public views and the QR; logs redact PII; anon/authenticated denied at the DB           |
| prevent duplicate entry                            | **Yes**                       | live batch and race: `VALID` then `ALREADY_USED`, one attendance row                                                                |
| survive webhook retries                            | **Yes**                       | dedupe ledger + forward-only status + exactly-once tickets + derived email key; confirmed by replay                                 |
| recover from a lost webhook                        | **Conditionally**             | sweep + payment-hint reuse the same `confirm_payment` (code-verified); live recovery depends on Wompi, NOT VERIFIED LIVE            |
| survive concurrent requests                        | **Yes**                       | three two-session races each yielded one correct winner                                                                             |
| keep Google Sheets failures from affecting the txn | **Yes**                       | Sheets is a downstream outbox drained only in maintenance; `SHEETS_ENABLED` can be off; no live-write dependency                    |

The only "conditionally" answers are the ones that require a real provider credential. The
backend's own behaviour is correct in every path the audit could execute.

— End of report.
