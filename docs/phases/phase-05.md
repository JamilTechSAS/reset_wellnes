# Phase 5 — Complete operational backend

**Status: COMPLETE.** Phases 1–4 built the payment path (price → order → Wompi → confirm →
tickets → email outbox). Phase 5 closes the operational loop so the future Spanish frontend
can be a thin client over stable, server-authoritative APIs: automatic payment
reconciliation, participant assignment, real operator authentication, the check-in API, public
event/ticket APIs, PostgreSQL rate limiting, the Google Sheets projection and the scheduler.

No frontend was built, and nothing in the public contracts changed shape: the checkout
contract remained exactly as the frontend will consume it.

---

## 1. What Phase 5 added

| #   | Item                          | Where it lives                                                                    | Notes                                                                                                               |
| --- | ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Automatic reconciliation      | migration 012, `_shared/api/reconciliation-handler.ts`, maintenance               | Reuses the SAME `confirm_payment` as the webhook; bounded schedule + attempt budget; terminal results stop sweeping |
| 2   | Payment-hint recovery         | migration 012, `_shared/api/payment-hint-handler.ts`, `POST …/payment-hint`       | The `?id=` from Wompi's redirect is a hint only; the transaction is re-read and validated server-side               |
| 3   | Safety/idempotency/tracking   | `payments.reconciliation_*`, transitions/claims unchanged from Phase 4            | Last attempt, attempt count, next eligible time, result + failure classification                                    |
| 4   | Scheduler                     | migration 015 (`pg_cron` → `pg_net` → `/orders-maintenance`), Vault secrets       | Verified against Supabase docs; documented HTTP fallback; no secret in migrations                                   |
| 5   | Participant assignment        | migration 013, `_shared/api/participants-handler.ts`                              | Reference+email ownership, `FOR UPDATE SKIP LOCKED` unit claim, append-only consent evidence                        |
| 6   | Operator authentication       | migration 013, `_shared/api/operator-auth.ts`, `public.operators`                 | Real Supabase Auth JWT + active operator row; no custom passwords, no shared operator secret                        |
| 7   | Check-in API                  | migration 013, `_shared/api/checkin-handler.ts`, Edge Function `checkin`          | `POST /check-in` returns 200-with-`status` for every outcome; atomic first-valid-wins                               |
| 8   | Public event APIs             | migration 014, `_shared/api/public-handler.ts`, Edge Functions `events`/`tickets` | `GET /events/{code}`, `…/availability`, `GET /tickets/{token}`; SQL whitelist projections, coarse availability      |
| 9   | Rate limiting                 | migration 014, `_shared/api/rate-limit-guard.ts`, `_shared/domain/rate-limits.ts` | PostgreSQL fixed windows (no Redis); 10 scopes; fails open (documented)                                             |
| 10  | Google Sheets projection      | migration 015, `_shared/api/sheets-sync.ts`, `_shared/integrations/google/`       | Per-ticket outbox, claim/finish with optimistic guard; can never affect payment/ticket/check-in                     |
| 11  | Security review + fixes       | `_shared/http/client-ip.ts` + regression tests                                    | See §8: one real finding fixed (XFF spoofing), one coverage gap closed                                              |
| 12  | Real concurrency verification | §7                                                                                | A–E on PostgreSQL 17.11, fresh database, all 17 migrations                                                          |
| 13  | Tests                         | §6                                                                                | 427 tests in 42 files, `npm run check` green                                                                        |

## 2. Database changes (migrations 012–015)

| Migration                                           | Contents                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261003210012_reconciliation.sql`                 | Bookkeeping columns + CHECK vocabularies; due-sweep partial index; BEFORE INSERT schedule trigger; `claim_payment_reconciliations` (SKIP LOCKED, consumes an attempt); `finish_payment_reconciliation`; `resolve_payment_for_buyer`; `app_private.iso_utc` |
| `20261003210013_operators_participants_checkin.sql` | `operators` table (+ conditional `auth.users` FK); `attendance.checked_in_by_user_id`; SQL participant normalizer and consent appender; `attach_participant`; `update_participant`; `record_check_in`; `get_public_ticket`; `get_operator_ticket`          |
| `20261003210014_public_events_rate_limits.sql`      | `get_public_event` / `get_public_availability` with the coarse availability label; `rate_limit_counters`; `consume_rate_limit`; `cleanup_rate_limit_counters`                                                                                              |
| `20261003210015_sheets_and_scheduler.sql`           | `sheets_projection_status` enum; `sheets_projections` outbox + enqueue triggers; `claim_sheet_projections`; `finish_sheet_projections`; `sheet_projection_stats`; conditional `pg_cron`/`pg_net` schedule calling Vault-backed maintenance                 |

All new objects follow the Phase 2–4 rules: RLS enabled with **zero policies**, `anon`/
`authenticated` hold no privileges, functions are `SECURITY INVOKER` with
`set search_path = ''`, `EXECUTE` revoked from `PUBLIC` and granted to `service_role` only
(verified on real PostgreSQL, §8). Money stays integer centavos; every new function raises the
`PT400/PT404/PT409` contract instead of raw constraint errors.

## 3. Key flows

### 3.1 Payment reconciliation

- Claim only attempts with a `wompi_transaction_id`, a due schedule, attempts below the
  budget, and an order in `PENDING|FAILED|EXPIRED|CANCELLED` (a `PAID` order is excluded:
  a second approval would violate `payments_one_approved_per_order_idx`).
- Re-read the transaction with the private key, validate reference/amount/currency, then call
  the **same** `confirm_payment` as the webhook. Convergence is guaranteed by construction.
- Outcomes: `APPROVED_APPLIED`, `APPROVED_DUPLICATE`, `RECONCILIATION_REQUIRED`,
  `STILL_PENDING`, `DECLINED`, `VOIDED`, `ERROR`, `UNKNOWN_STATUS`, `MISMATCH`,
  `NOT_FOUND_AT_PROVIDER`, `UPSTREAM_ERROR`. Terminal results clear the schedule; transient
  failures retry in 2 minutes within the budget (default 8 attempts, backoff 2 m → 24 h).
- Wompi has **no lookup by reference** (verified 2026-10-03): the buyer's `?id=` redirect is
  the recovery path for attempts that never recorded a transaction id, exposed as
  `POST /orders/{reference}/payment-hint` (reference + buyer email required, mismatch refused).

### 3.2 Participant assignment

- `POST /orders/{reference}/participants` attaches a person to the next (or a named)
  unassigned active ticket; `PUT …/participants/{id}` edits a participant of the same order.
- Ownership: reference + buyer email, re-checked inside the transaction; wrong email, unknown
  reference and a foreign participant id all return the same `NOT_FOUND`.
- Concurrent calls take **different units** (`FOR UPDATE SKIP LOCKED`); a ticket can never be
  assigned twice. Consent evidence is append-only: a change appends a new row with value,
  timestamp and policy version; history is never overwritten.
- Responses never echo cédula, email or phone back over the wire.

### 3.3 Operator authentication

- Authentication is Supabase Auth (`auth.getUser` on the bearer token — injected as
  `getUserByToken`, never decoded locally). Authorization is a row in `public.operators`
  (`role OPERATOR|ADMIN`, `is_active`). A valid user who is not an active operator gets
  `FORBIDDEN`; a missing/invalid token gets `UNAUTHORIZED`. Unknown roles fail closed.
- The verified identity (label + user id) is what attendance records; no client-supplied
  operator label is ever trusted.
- Operator accounts are created with the Supabase CLI (docs/environments.md); there is no
  password in the schema and no shared operator secret anywhere in code or config.

### 3.4 Check-in API

- `POST /check-in { ticketToken }` → **HTTP 200 with `status`**: `VALID`, `ALREADY_USED`,
  `NOT_PAID`, `CANCELLED`, `NOT_FOUND`, `INVALID`. A used scan is normal door operation, not
  a server error; HTTP errors are reserved for auth (401/403), rate limit (429), malformed
  body (400) and upstream (502).
- `record_check_in` locks the ticket row, then decides in the order cancelled → not paid →
  already used → valid, inserting attendance in the same transaction with
  `on conflict (ticket_id) do nothing`. The first valid scan wins under real concurrency (§7 A).
- `GET /check-in/{token}` returns the operator admission view (name, cédula, city, ticket,
  order/payment/attendance state). It never returns email, phone, order internals or consents.
- Responses are minimal: a `VALID` decision includes the participant's name; everything else
  returns only the code and timestamp. Nothing sensitive is logged.

### 3.5 Public APIs

- `GET /events/{code}` (published/closed only) and `GET /events/{code}/availability`: identity,
  dates, venue and a **coarse** sales block (`AVAILABLE|LOW|SOLD_OUT|NOT_STARTED|CLOSED` plus
  the current stage price). Exact inventory is never exposed and is only authoritative inside
  the order transaction.
- `GET /tickets/{token}` returns the minimum a holder needs: event, code, status and
  first-name + last-initial. 100-bit opaque tokens; malformed and unknown tokens answer the
  same `NOT_FOUND` (no enumeration), and no cédula/email/phone/order/consent data can pass
  because each projection is a hand-written SQL whitelist.

### 3.6 Rate limiting (PostgreSQL, no Redis)

Ten scopes in `_shared/domain/rate-limits.ts` (IP, per order reference or per operator),
implemented with one atomic `insert … on conflict … returning counter` per check and md5-hashed
keys (no raw IPs/tokens stored). `checkin:attempt` is consumed **only** for requests without a
valid token, so credential stuffing is bounded without throttling a real operator sharing the
venue NAT. The guard fails open on a limiter failure (an abuse control must never take down the
door or checkout) — documented, and compensated by validation and tokens. `RATE_LIMIT_ENABLED=false`
is the emergency switch.

### 3.7 Google Sheets projection

- Supabase remains the source of truth; the sheet is read-oriented and can never write back.
- One outbox row per ticket (`sheets_projections`, PK `ticket_id`); triggers on
  tickets/participants/attendance/consents re-queue automatically on any relevant change, and
  concurrent changes collapse into one logical projection.
- The worker claims with `SKIP LOCKED`, writes the **complete grid** (self-healing after a
  failure), and marks rows `SYNCED` only if they are still `SYNCING` — a change that arrived
  mid-write stays queued. Failures get bounded backoff and a 6-attempt ceiling; new data
  resets the counter.
- A Google outage cannot affect payments, ticket issuance or check-in: enqueueing is a local
  insert and the HTTP call happens only in the maintenance worker. `SHEETS_ENABLED=false`
  skips it entirely.

### 3.8 Scheduler

Verified against Supabase docs (2026-10-03): hosted Supabase supports `pg_cron` + `pg_net` +
Vault. Migration 015 creates the extensions conditionally and schedules
`event-ticketing-maintenance` every 5 minutes; the job calls `app_private.invoke_scheduled_maintenance()`,
which reads `project_url` and `maintenance_api_token` from Vault and POSTs
`/orders-maintenance`. Missing secrets log a warning instead of hammering anything. On a
database without the extensions the migration prints the documented HTTP fallback.

## 4. Configuration and secrets

- `env.ts` gained `RATE_LIMIT_ENABLED` (default true) and a discriminated `googleSheets`
  config, validated only when `SHEETS_ENABLED=true` (service account email shape, PKCS#8 PEM
  marker, spreadsheet id, tab names). The private key is masked in the log-safe projection.
- `CHECKIN_API_TOKEN` was **removed** from code, tests, config and docs: replaced by Supabase
  Auth. `MAINTENANCE_API_TOKEN` remains (≥32 chars outside development).
- `.env.example` documents the operator-auth section (no variable), the Sheets block and the
  rate-limit switch. `supabase/config.toml` sets `verify_jwt = false` for the new public
  functions (`events`, `tickets`, `checkin`) with the reason in comments — each function
  authenticates its own callers.
- The Google service account has edit access to exactly one spreadsheet and no database
  access; the key lives only in Edge Function secrets and is never logged or returned.

## 5. Tests

**Final count: 427 tests in 42 files, all passing.** `npm run check` = typecheck && lint &&
format:check && functions:check && test → exit 0.

New suites added in Phase 5:

| Suite                                | Covers                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `domain/reconciliation.test.ts`      | Result/failure vocabulary, terminal classification, backoff schedule + clamping, outcome mapping                                 |
| `domain/rate-limits.test.ts`         | Scope/key vocabulary, documented bounds, prefix namespacing, max key length                                                      |
| `domain/sheets.test.ts`              | Grid layout, Spanish labels, money/timezone formatting, retry policy                                                             |
| `domain/operators.test.ts`           | Roles, admission allow-list, attendance label bounds                                                                             |
| `http/body.test.ts`                  | Oversized (declared and actual) and malformed JSON → VALIDATION_ERROR                                                            |
| `http/client-ip.test.ts`             | **XFF spoofing regression** (see §8), IPv6/ip:port, malformed and oversized values                                               |
| `api/reconciliation-handler.test.ts` | Claim → lookup → validate → confirm, terminal vs retry, per-row isolation, provider 404 → review                                 |
| `api/payment-hint-handler.test.ts`   | Reference+email gate, strict id shape, mismatch refusal, unknown transaction outcome, impossible states                          |
| `api/public-handler.test.ts`         | Code normalization, uniform NOT_FOUND, no capacity/PII leakage, token normalization                                              |
| `api/participants-handler.test.ts`   | Reference/email validation, unknown → same NOT_FOUND, no PII echo, malformed ids                                                 |
| `api/checkin-handler.test.ts`        | Token extraction bounds, operator identity in the record, minimal responses, admission lookup                                    |
| `api/operator-auth.test.ts`          | Bearer parsing, 401 vs 403, inactive operator, unknown role fails closed, verified identity                                      |
| `api/rate-limit-guard.test.ts`       | Rule consumption, RATE_LIMITED, disabled switch, unkeyable request, fail-open                                                    |
| `api/sheets-sync.test.ts`            | Full-grid write, optimistic finish, FAILED backoff, attempt ceiling, never throws                                                |
| `api/maintenance-handler.test.ts`    | All jobs run; non-critical failures contained; critical failure = 500; **maintenance auth guard**                                |
| `schema/phase5.test.ts`              | Reconciliation claim/finish, rate-limit SQL, attach/update, check-in precedence, public vs operator projections, outbox triggers |

Updated suites: `schema/helpers` (19 tables), `migrations` (17 migrations, new enum parity),
`constraints`, `rls`, `config/env`, `api/orders-handler`, `api/webhook-handler`, tooling parity.

## 6. Commands and exit codes

| Command                                                                     | Result                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npm run check`                                                             | **exit 0** — typecheck, lint, format, `deno check`, 427 tests |
| `npm run functions:check`                                                   | exit 0 — Deno type-check of all 8 Edge Functions              |
| `bash tmp/phase5-concurrency.sh` (temporary, removed after the run)         | **exit 0**, `ALL PHASE 5 CONCURRENCY CHECKS PASSED`           |
| Migration loop (`docker exec … psql -f -` over `supabase/migrations/*.sql`) | exit 0 — 17/17 applied to a fresh database                    |
| `npx supabase gen types typescript --db-url …`                              | exit 0 — `database.types.ts` regenerated from real PostgreSQL |

## 7. Real PostgreSQL concurrency verification (A–E)

Against **PostgreSQL 17.11** (temporary `pg-tatiana` container, fresh database, auth schema
created first so migration 013's conditional FK exists; all 17 migrations applied from
scratch). Two genuinely parallel `psql` sessions per race; session 1 holds its row locks with
`pg_sleep(1.5)` so the overlap is real, not incidental. The unrelated `jamilchat-*` containers
were never touched; the container and database were removed after the run.

**A — two simultaneous check-ins of the same ticket: exactly one `VALID` (first wins).**

```text
session 1: {"outcome": "VALID",        "reason": "OK",               "checkedInAt": "…"}
session 2: {"outcome": "ALREADY_USED", "reason": "ATTENDANCE_EXISTS", "checkedInAt": "…"}
asserted: 1 attendance row, checked_in_by = 'Operator One'
```

**B — two simultaneous participant attachments on a 2-unit order: no duplicate, distinct units.**

```text
session 1: {"found": true, "ticket": {"token": "…01", "unit": 1, …}, "remainingUnassigned": 1}
session 2: {"found": true, "ticket": {"token": "…02", "unit": 2, …}, "remainingUnassigned": 0}
asserted: 2 assigned tickets, 2 distinct participant ids, 0 unassigned
```

**C — two simultaneous reconciliation claims: one claim, one confirmation.**

```text
session 1 claim: 1   session 2 claim: 0   (row locked + schedule advanced)
single confirm_payment: {"result": "APPLIED", …}
asserted: order PAID, exactly 1 approved payment, exactly 1 ticket, no second claim afterwards
```

**D — concurrent Sheets enqueue + claim: one logical projection.**

```text
two concurrent participant updates → 1 projection row
session 1 state: SYNCING/1   (owns the claim)      session 2 state: QUEUED/0 (locked row)
finish_sheet_projections(SYNCED): updatedCount 1
```

**E — concurrent maintenance expiry: no duplicate inventory release.**

```text
session 1 expiredCount: 1    session 2 expiredCount: 0
asserted: order EXPIRED, pricing tier quantity_reserved = 0 (released exactly once),
          no tickets issued, no payment confirmed
```

`ALL PHASE 5 CONCURRENCY CHECKS PASSED`.

## 8. Security review (findings, fixes, verified controls)

Method: threat-model the new surface (operator auth, check-in, public read endpoints,
participant endpoints, payment hint, reconciliation, rate limits, Sheets, scheduler), then
verify each claim against the code, the SQL, and **real PostgreSQL privileges**.

**Finding 1 (Medium) — client IP spoofing bypassed IP rate limits. FIXED.**

- Supabase does not replace a client-supplied `x-forwarded-for`; it **appends** the real
  address after it (`<spoofed>,<real>`, Supabase discussion #34647), and the non-forgeable
  value is `cf-connecting-ip`. The old `resolveClientIp` read the **first** XFF entry, so a
  caller could choose its own rate-limit bucket (`orders:create`, `events:read`,
  `tickets:lookup`, `checkin:attempt`) and poison `orders.ip_address` by rotating a header.
- **Fix**: `resolveClientIp` now prefers `cf-connecting-ip`, then the **last valid**
  `x-forwarded-for` entry (the one the trusted proxy appended), then `x-real-ip`; values that
  are empty, oversized or not shaped like an IP are ignored entirely (unkeyable → the
  documented fail-open path).
- **Regression tests**: `tests/http/client-ip.test.ts` (8 tests) pin the spoofed-first,
  spoofed-only, appended-real, IPv6, `ip:port`, oversized and no-header behaviors.

**Finding 2 (Low) — security-critical guard had no regression coverage. FIXED (tests only).**

- `isMaintenanceAuthorized` protects a mutating, email-sending endpoint but had no direct
  tests. Added three: exact-token acceptance (wrong length/suffix/case refused), missing or
  empty **configuration** refuses (never opens the door), missing/empty presented token
  refuses.

**Verified controls (real PostgreSQL, fresh database):**

```text
anon/authenticated: operators=false, sheets_projections=false, rate_limit_counters=false
anon: attach_participant=false, record_check_in=false, get_public_ticket=false,
      get_public_event=false, claim_payment_reconciliations=false
service_role: operators=true, claim=t, record_check_in=t
RLS tables: 19/19    policies: 0    public tables without RLS: none
```

- Check-in requires a verified Supabase JWT **and** an active operator row; identity comes
  from the token, never the body; 401 vs 403 keep deactivation diagnosable.
- Public projections are SQL whitelists built field-by-field; no cédula/email/phone/order
  internals/consents can leak, and malformed vs unknown answers are identical (no enumeration).
- Participant endpoints re-check reference + buyer email inside the transaction; foreign
  participant ids are indistinguishable from unknown ones.
- The payment hint never trusts the hint: the transaction is re-read with the private key and
  validated (reference, amount, currency, id), and a recorded id cannot be swapped (`MISMATCH`).
- The maintenance token is compared in constant time and must be ≥32 characters outside
  development; configuration errors name variables only.
- Secrets: the Google private key is masked in the log-safe config projection and by the
  logger's key patterns (`private[_-]?key`, `token`, `secret`, …); the Sheets client never
  includes key material or response bodies in errors.
- Sheets writes use `valueInputOption: "RAW"`, so a participant value beginning with `=` can
  never be interpreted as a formula in the client's sheet.
- Check-in responses omit cédula/email; a `VALID` decision includes only the participant name.

**Accepted residual risks (documented, not hidden):**

- The rate-limit guard fails open on a limiter failure; validation and opaque tokens remain.
- IP keying depends on platform-set headers; per-reference/per-operator limits complement it.
- A leaked maintenance token can trigger maintenance runs; rotate it (docs/security.md §7).
- The Google sheet contains the operational personal data the client needs (cédula, email,
  phone); access is Google-controlled and the sheet is read-only from our side.
- `POST /orders-maintenance` has no per-IP throttle for failed attempts; the token is
  high-entropy and unauthenticated requests do no database work (only a constant-time compare).
- PostgREST behavior with a publishable key remains unverified because the local Supabase
  stack cannot start on this machine (reserved TCP ports); RLS/privileges are verified at the
  SQL level instead.

## 9. Live Wompi / Resend / Google verification status

**Not performed — no credentials exist in this environment.** There is no `.env.local` and no
Wompi/Resend/Google account configured, so nothing was fabricated:

| Integration | What is verified                                                                                                                                                          | What is not                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Wompi       | Signature crypto against the official vector; webhook verification; transaction validation; reconciliation/hint pipelines against injected clients; real SQL claim/finish | Live sandbox transaction, live webhook delivery |
| Resend      | Outbox SQL, idempotency keys, dispatcher claim/backoff, error classification                                                                                              | Any live email send                             |
| Google      | Service-account JWT signing with a locally generated key, client flow with injected fetch, outbox SQL, full-grid builder                                                  | Any live sheets write                           |

The live checks are the first task of Phase 6 (or of any run where credentials are provided).

## 10. Files changed (Phase 5)

New SQL: `20261003210012_reconciliation.sql`, `…013_operators_participants_checkin.sql`,
`…014_public_events_rate_limits.sql`, `…015_sheets_and_scheduler.sql`.

New Edge Functions: `events/`, `tickets/`, `checkin/` (each with `deno.json`); `orders/`
extended with `/quote`, `/retry`, `/payment-hint`, `/participants` routes; `orders-maintenance/`
extended with Wompi, Sheets and rate-limit wiring.

New shared modules: `api/{reconciliation-handler,payment-hint-handler,public-handler,sheets-sync,
participants-handler,checkin-handler,operator-auth,rate-limit-guard,payment-payload}.ts`,
`db/{participants,checkin,operators,public,rate-limits,sheets}.ts`,
`domain/{reconciliation,rate-limits,sheets,operators}.ts`,
`integrations/google/sheets-client.ts`, `http/{body,client-ip}.ts` (client-ip hardened in §8).

Edited: `config/env.ts`, `.env.example`, `supabase/config.toml`, `http/json.ts` (CORS),
`api/maintenance-handler.ts`, `api/orders-handler.ts`, `db/payments.ts`,
`supabase/functions/_shared/db/database.types.ts` (regenerated), plus 16 new test files and 8
updated suites. No frontend files were created or modified.

## 11. Remaining limitations and open decisions

- **Live provider verification pending credentials** (Wompi sandbox, Resend, Google Sheets).
- **PostgREST not exercised** (local stack cannot start: reserved Windows ports). The Data API
  is not used by the backend; it matters only as a defense-in-depth check.
- **Scheduler runs only on the hosted platform** (extensions unavailable locally); the HTTP
  fallback with the maintenance token is documented and testable anywhere.
- **Business decisions still open** (deliberately not invented in code): prices/stages/win
  windows, discount policy details, reservation window, duplicate-cédula policy, consent
  wording/version text, optional `expiration-time`, enabled payment methods, retention policy,
  buyer copy on emails, and whether operators beyond the door need accounts.
- **Accepted security residuals** from §8.
- The temporary verification artifacts (`pg-tatiana` container, `tatiana_phase5_conc` database,
  `tmp/phase5-concurrency.sh`) were removed at the end of the phase.

## 12. What Phase 6 will be

Phase 6 is the **Spanish frontend as a thin client over these APIs**, plus the live
integration verification that needs credentials:

1. Public site: landing/event page → quote → checkout (Wompi Widget) → confirmation page with
   the QR; ticket lookup page (`GET /tickets/{token}`).
2. Private operator scanner (Supabase Auth login → `POST /check-in`), built against the
   200-with-`status` contract.
3. Live sandbox runs: real Wompi payment (approved + declined + lost webhook → reconciliation),
   real Resend delivery, real Sheets sync.
4. Deployment runbook: hosted migrations, secrets, Vault, cron verification, CORS, and the
   launch checklist.

No backend contract change is expected: the frontend consumes `ok`/`error.code`, the checkout
payload and the check-in `status` vocabulary exactly as documented in
[docs/api.md](../api.md).
