# Security

Security here means, in priority order: (1) nobody gets an admission they did not pay for,
(2) nobody's personal data leaks, (3) nothing can be silently changed after the fact.

**Provider and ticket status.** ePayco is the only checkout the buyer flow opens, and its
confirmation webhook is `POST /webhooks-epayco`. Tickets and QR codes are discontinued: an
admission is a participant row on a PAID order. The Wompi controls, ticket tokens and email
outbox described below are legacy layers kept for historical data and earlier deployments; they
are not part of the current purchase path.

## 1. Assets

| Asset                                                                   | Why it matters                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Wompi private key / integrity secret / events secret                    | Forging payments, changing amounts, or reading transaction data |
| Supabase secret key                                                     | Full database authority                                         |
| Resend API key                                                          | Sending mail as the event                                       |
| Participant personal data (name, cédula, email, phone, city, Instagram) | Legal (Ley 1581 de 2012) + reputational                         |
| Ticket tokens                                                           | Each one is an entry to the event                               |
| Attendance records                                                      | Event integrity (capacity, claims)                              |
| Operator accounts (`public.operators` + Supabase Auth)                  | Checking people in, and seeing who is coming                    |
| Google service account private key                                      | Writing the client's operational spreadsheet                    |

## 2. Threat model

| #   | Threat                                                            | Control                                                                                                                                                                                                                                                                       | Status                                                                                                                             |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Buyer changes the price in the browser                            | Price is computed server-side from the database; the Wompi signature binds reference + amount + currency; the webhook re-reads the transaction with the private key and validates reference, amount and currency against the order                                            | Price logic Phase 3; webhook validation **implemented + tested** (Phase 4)                                                         |
| 2   | Buyer declares a successful payment by visiting the return URL    | The return URL is never a signal: only a verified Wompi event (or server-side lookup) marks an order paid. Documented verbatim in Wompi's docs                                                                                                                                | **Implemented + tested** (Phase 4; live sandbox pending credentials)                                                               |
| 3   | Forged webhook                                                    | SHA-256 checksum over `signature.properties` + `timestamp` + events secret, compared in constant time; malformed, ambiguous or unresolvable payloads are rejected; refusals are recorded as `REJECTED` with `checksum_valid = false`                                          | **Implemented + tested** (Phase 4)                                                                                                 |
| 4   | Replayed webhook                                                  | Unique dedupe key per event (`payment_events`); forward-only payment ranking; unique constraints on payment/ticket/email; a concurrent duplicate is answered 200 from the ledger                                                                                              | **Implemented + tested** (Phase 4)                                                                                                 |
| 5   | Amount mismatch (paying COP 1.000 for a COP 95.000 ticket)        | The webhook body is only a pointer: the transaction is re-read with the private key, then reference/amount/currency are compared against the stored order — in TypeScript and again inside `confirm_payment`                                                                  | **Implemented + tested** (Phase 4)                                                                                                 |
| 6   | Guessing ticket tokens                                            | 100 bits of CSPRNG entropy, Crockford base32, opaque (no participant data), constant lookup by unique index                                                                                                                                                                   | **Implemented** (generation/normalization)                                                                                         |
| 7   | Double check-in / simultaneous scans                              | One `attendance` row per ticket (`unique (ticket_id)`), inserted in a single transaction with the ticket row locked; first scan wins                                                                                                                                          | **Implemented + tested** (Phase 5); race verified on real PostgreSQL 17 (phase-05 §7 A)                                            |
| 8   | Data exposure through public endpoints                            | Public responses are whitelisted field-by-field in SQL (order status, event, public ticket, operator ticket); ticket tokens are only returned after payment; cédula is never returned and never in the QR                                                                     | **Implemented + tested** (Phases 4–5) for every public/operator projection                                                         |
| 9   | Data exposure through logs                                        | Structured logger redacts sensitive keys at any depth (secrets, tokens, signatures, email, phone, cédula, card data), masks emails/phones, bounds depth/size                                                                                                                  | **Implemented + tested**                                                                                                           |
| 10  | Secret leakage through git                                        | `.gitignore` covers `.env*`; an automated test scans the repository for credential-shaped strings                                                                                                                                                                             | **Implemented + tested**                                                                                                           |
| 11  | Secret leakage through error messages                             | Config errors name variables only; Wompi errors carry status + `error.type`, never response bodies (which can contain customer emails)                                                                                                                                        | **Implemented + tested**                                                                                                           |
| 12  | Mixing sandbox and production credentials                         | Credential prefix must match the environment derived from `APP_ENV`; production base URL cannot be overridden                                                                                                                                                                 | **Implemented + tested**                                                                                                           |
| 13  | Database exposed through the API (PostgREST)                      | RLS enabled on every table with no policies; `anon`/`authenticated` lose every table/sequence privilege and future-table default grants; the backend uses the secret key; a publishable key reads nothing                                                                     | **Implemented + verified on the real stack** (`rls.test.ts` + closure probes: `anon` 401, `authenticated` 403, `service_role` 200) |
| 14  | Enumeration / abuse of public endpoints                           | Ten PostgreSQL fixed-window scopes (IP / order reference / operator); identical responses for unknown references; codes re-validated inside order creation                                                                                                                    | **Implemented + tested** (Phase 5)                                                                                                 |
| 15  | Insider edits in Google Sheets                                    | Sheets is read-only output; the export identity has no write path to the database                                                                                                                                                                                             | [operations-google-sheets.md](operations-google-sheets.md)                                                                         |
| 16  | Operator device stolen with the check-in UI open                  | Real Supabase Auth session + `operators.is_active`; deactivating the account revokes access immediately; check-in responses omit cédula/email                                                                                                                                 | **Implemented + tested** (Phase 5)                                                                                                 |
| 17  | Order-reference enumeration (`EVT-2026-000001` is sequential)     | `GET /orders/{reference}` and the retry endpoint require the buyer email (`X-Buyer-Email`); a wrong email and an unknown reference return the **same** `NOT_FOUND`, and the check runs again inside the database transaction                                                  | **Implemented + tested** (Phase 4, including concurrent reads)                                                                     |
| 18  | Duplicate confirmation email                                      | Three layers: unique outbox row per `(ticket, template)`, `FOR UPDATE SKIP LOCKED` claim so two dispatchers cannot share a row, and the same key as the Resend `Idempotency-Key` header                                                                                       | **Implemented + tested** (Phase 4)                                                                                                 |
| 19  | New/unknown Wompi status confirming an order                      | Stored raw, normalized to `unknown`, never advances the payment state (`UNKNOWN_PROVIDER_STATUS`)                                                                                                                                                                             | **Implemented + tested** (Phase 4)                                                                                                 |
| 20  | Payment approved after the order became terminal                  | `RECONCILIATION_REQUIRED`: the payment is recorded `approved`, the order is not revived, no ticket is issued and no refund is invented; an operator reviews it                                                                                                                | **Implemented + tested** (Phase 4)                                                                                                 |
| 21  | Lost Wompi webhook (approved payment, notification never arrived) | Reconciliation sweep re-reads the transaction with the private key and feeds the SAME `confirm_payment` as the webhook; bounded by schedule/attempts; terminal results stop sweeping                                                                                          | **Implemented + tested** (Phase 5)                                                                                                 |
| 22  | Spoofed client IP choosing its own rate-limit bucket              | `resolveClientIp` prefers `cf-connecting-ip`, then the LAST valid `x-forwarded-for` entry; `ip:port` forms are normalized to the bare address (an ephemeral port must not create a fresh bucket per connection); malformed/out-of-range values are ignored; regression-tested | **Fixed + regression-tested** (Phase 5; hardened in the pre-frontend audit)                                                        |
| 23  | Probing other orders through participant endpoints                | Reference + buyer email re-checked inside the transaction; a foreign participant id is indistinguishable from an unknown one (`NOT_FOUND`)                                                                                                                                    | **Implemented + tested** (Phase 5)                                                                                                 |
| 24  | Google outage affecting payments or the door                      | Local outbox + worker isolation: enqueueing is a plain insert, the HTTP call happens only in maintenance, failures never touch payment/ticket/check-in, and `SHEETS_ENABLED=false` disables it entirely                                                                       | **Implemented + tested** (Phase 5)                                                                                                 |
| 25  | Mass assignment through participant payloads                      | Strict parser strips unknown keys; the SQL normalizer re-validates inside the transaction; no client-supplied price/status/id is ever stored                                                                                                                                  | **Implemented + tested** (Phase 5)                                                                                                 |
| 26  | Formula injection into the client's spreadsheet                   | Sheets writes use `valueInputOption: "RAW"`; a value starting with `=` is stored as text, never evaluated                                                                                                                                                                     | **Implemented + tested** (Phase 5)                                                                                                 |

## 3. Personal data handling

- **Collect**: only the fields the client asked for. `participants.extra_fields` exists for future
  needs, but nothing is collected "just in case".
- **Consent**: two explicit consents, each stored with value, timestamp, policy version and
  (optionally) the hash of the text shown. Consent to personal data processing is mandatory;
  the future-events consent is optional and recorded even when declined.
- **In logs**: never log full personal data. Emails are masked (`m***@dominio.com`), phones are
  masked (`573***7777`), cédulas are never logged. Debug level is refused in production.
- **In the QR**: only the opaque token. A leaked screenshot reveals nothing about the holder.
- **In Sheets**: the client explicitly needs cédula/email/phone for operations. The export is
  therefore access-controlled by Google (shared only with the client's account) and read-only
  from our side. Retention/cleanup follows the policy in
  [data-model.md](data-model.md#5-data-retention-to-confirm-with-the-client).
- **Retention**: draft policy only; needs client confirmation before implementation.

## 4. Database-level guarantees (Phase 2)

The schema is the last line of defence, not just storage:

- **One approved payment per order** — partial unique index; two approvals are impossible even
  with a programming error. Migration `20261004120000` adds a BEFORE INSERT/UPDATE trigger that
  reports the illegal second approval as `PT409 DOUBLE_PAYMENT_CONFLICT` (a durable, typed
  refusal instead of a raw `23505` that the webhook path can only retry forever).
- **Event idempotency** — `payment_events.dedupe_key` is unique, so a replayed webhook can never
  be processed twice, even under simultaneous deliveries; the losing request reads the winner's
  outcome instead of failing.
- **Forward-only payments** — `payment_transition_rank` is applied inside `confirm_payment`:
  `approved`/`refunded` never regress, `unknown` never advances, and a later void of an approved
  attempt becomes `refunded` with the approval timestamp preserved.
- **Exactly-once tickets** — `tickets (order_item_id, order_item_seq)` is unique, so a unit can
  be issued exactly one ticket no matter how many times or how concurrently a webhook is
  delivered.
- **Double check-in** — `attendance.ticket_id` is unique; the first valid scan wins at the
  database level, with no application lock.
- **Duplicate confirmation emails** — `email_deliveries.idempotency_key` is unique and derived
  by a CHECK constraint from `(ticket_id, template)`, so a mis-keyed row cannot exist; the
  dispatcher claims with `SKIP LOCKED` and passes the same key to Resend.
- **Consent evidence** — the table is append-only (UPDATE rejected by a trigger); a withdrawal
  is a new row and the earlier record survives.
- **Retention hooks** — `payments.provider_payload` (may contain the customer's email) is never
  exposed through any endpoint or log line, and is the first candidate for short retention
  (policy pending with the client).

## 5. What is explicitly NOT claimed

- The webhook, reconciliation, check-in and Sheets pipelines are implemented and tested against
  documented fixtures and injected clients, but **no live Wompi delivery, live email send or live
  Sheets write has been verified** (no credentials). A forged or replayed delivery cannot change
  state; the live verification is Phase 6.
- There is **no** user authentication for buyers (no accounts): identification is by opaque order
  reference + buyer email + rate limiting. That is a deliberate product decision, and it is why
  the order lookup endpoint must stay minimal and rate-limited.
- No WAF, no third-party bot protection, no CDN-level rate limiting. Supabase's platform limits
  apply; application-level budgets are now implemented but are not a substitute for them.
- The rate-limit guard fails open on a limiter failure, and IP keying depends on platform-set
  headers. Both are documented trade-offs; per-reference/per-operator limits complement them.
- `POST /orders-maintenance` is protected by a ≥32-character shared secret compared in constant
  time, but failed attempts are not separately throttled (unauthenticated calls do no database
  work). Rotate the token like any secret.

## 6. Phase 5 security review

Method: threat-model the new surface (operator auth, check-in, public read APIs, participant
endpoints, payment hint, reconciliation, rate limits, Sheets, scheduler), then verify each claim
against the code, the SQL and **real PostgreSQL privileges** (fresh database, all 17 migrations).

### Findings and fixes

1. **Client IP spoofing bypassed IP rate limits (Medium, fixed).** Supabase appends the real
   address after a client-supplied `x-forwarded-for` (`<spoofed>,<real>`; see Supabase discussion
   #34647), and `cf-connecting-ip` carries the non-forgeable value. The old resolver read the
   FIRST entry, letting a caller choose its bucket (`orders:create`, `events:read`,
   `tickets:lookup`, `checkin:attempt`) and poison `orders.ip_address`. The resolver now prefers
   `cf-connecting-ip`, then the LAST valid `x-forwarded-for` entry, then `x-real-ip`, and ignores
   values that are empty, oversized or not IP-shaped. Regression suite:
   `tests/http/client-ip.test.ts` (spoofed-first, spoofed-only, appended-real, IPv6, `ip:port`,
   oversized, no-header).
2. **The maintenance authorization guard had no direct tests (Low, fixed).** Added regressions
   for exact-token acceptance, missing/empty configuration (refuses), and missing/empty presented
   token (refuses).

### Verified on real PostgreSQL

PostgreSQL 17.11 with the platform roles and Supabase's default privileges reproduced, all
migrations applied from zero. Privilege-level evidence:

```text
RLS tables: 19/19    policies: 0    public tables without RLS: none
anon/authenticated: table privileges=0   EXECUTE on functions=0
function/sequence/table default grants: no anon, no authenticated
service_role: USAGE on public=true, on app_private=true; EXECUTE on 43 of 52 functions
              (the 9 without are trigger functions and the pg_cron entry point)
guard trigger: payments_guard_single_approved_payment present
re-generated database.types.ts: identical to the committed file
```

Invocation-level evidence (the check that matters — `set role service_role`, then call the
functions the Edge Functions call): 15 of 27 public functions depend on `app_private` helpers,
and running the whole buyer journey as `service_role` succeeds: catalog reads, quote, rate
limit, `create_order`, `confirm_payment` (APPLIED, one ticket, order PAID), email queue +
delivery, ticket reads, check-in (second scan ALREADY_USED), sheets claim/finish, webhook
claim/finalize, reconciliation claim/finish, expiry, retry with a new attempt/reference.
Concurrency (two parallel sessions): one confirmation applies and one is DUPLICATE with one
ticket set; one check-in wins; a one-slot event creates exactly one order and the other buyer
gets a typed `SOLD_OUT`; one webhook claim per dedupe key; a second concurrent approval gets
the typed `PT409 DOUBLE_PAYMENT_CONFLICT`.

Both levels are needed. Privilege checks passed on the first run while the invocation failed
with `permission denied for schema app_private` — see the audit finding below.

### Accepted residual risks

- Rate-limit fail-open and platform-dependent IP headers (compensated by validation and tokens).
- Maintenance-token guessing is unthrottled but requires a ≥32-character secret and causes no
  database work when wrong.
- The client's sheet holds the operational personal data the brief requires (cédula, email,
  phone); access is controlled by the client's Google account, and our side is write-only to the
  spreadsheet, never reading it back.
- The hosted project still needs its first deploy-time probe: the local stack was verified in the
  closure phase (real PostgREST 16.4 + GoTrue: `anon` 401, `authenticated` 403, `service_role`
  200 over tables, views and RPC), but the hosted Data API has not been exercised yet. Re-run the
  closure probe matrix there before the first sale.

## 7. Pre-frontend adversarial audit (2026-10-04)

Independent full-repository audit before frontend development. Everything was re-derived from
code, SQL and real PostgreSQL, not from phase reports; full evidence and the verdict live in
[audits/pre-frontend-audit-01.md](audits/pre-frontend-audit-01.md). Defects fixed during the
audit, each with a regression test:

1. **A transient webhook failure could never be retried (High, fixed).** The `503` path left the
   ledger row unprocessed, but the redelivery was answered `200` by the dedupe gate without
   reprocessing — silently swallowing Wompi's retry and leaving the payment pending with no
   transaction id for reconciliation to find. An unprocessed duplicate is now processed again;
   `finalize_webhook_event` (update ... where `processed_at is null`) keeps exactly one owner.
2. **Participant validation answered `500` and dropped `details.issues[]` (Medium, fixed).**
   `ParticipantValidationError` did not extend `AppError`, so the HTTP layer collapsed it to
   `INTERNAL_ERROR`. It is now a `VALIDATION_ERROR` carrying its `issues`, matching docs/api.md.
3. **A second approval aborted with a raw unique violation (Medium, fixed).** The
   one-approved-payment index is the guarantee, but the failure was an opaque `23505` → `503`
   retry loop with no recorded outcome. Migration `20261004120000` turns the illegal transition
   into `PT409 DOUBLE_PAYMENT_CONFLICT` (recorded as `REJECTED + reviewRequired`).
4. **`ip:port` was kept as the whole rate-limit bucket key (Low, fixed).** Ports are now
   stripped, out-of-range octets are rejected, and bracketed IPv6 hosts are normalized.
5. **The backend role could not execute most of the API's SQL functions (Critical, fixed).**
   Every function is `SECURITY INVOKER`, so privileges are checked as the caller; 15 of the 27
   public functions call helpers in `app_private`, whose USAGE was never granted to
   `service_role`. Reproduced on PostgreSQL 17: `select public.get_public_event('TAT-2026')` as
   `service_role` answered `permission denied for schema app_private` — the first request of the
   public flow. Invisible to PGlite suites and to `has_function_privilege` probes, which run as
   the function owner. Migration `20261004140000` grants USAGE on `app_private` plus EXECUTE on
   the three helpers reached from inside other functions; `tests/schema/backend-role-access.test.ts`
   now runs the API as `service_role` and fails without it.
6. **`anon`/`authenticated` could still execute every backend function (Medium, fixed).** The
   migrations revoked EXECUTE from PUBLIC, but Supabase grants new `public` functions directly
   to `anon`/`authenticated` ("Securing your API" → "Default privileges"), so a direct grant
   survived; the bodies then failed only because table privileges were revoked. Migration
   `20261004130000` revokes every existing function from both roles and removes their future
   function/sequence defaults. PostgreSQL keeps PUBLIC's built-in EXECUTE on new functions
   (verified: `alter default privileges ... revoke ... from public` does not remove it), so the
   per-function revoke is mandatory and is enforced by the function scan in `rls.test.ts`.
7. **A concurrent second approval still aborted with a raw unique violation (Medium, fixed).**
   The typed guard (item 3) fixed the sequential case; with two truly overlapping sessions the
   loser still hit `23505` on `payments_one_approved_per_order_idx` — reproduced, then closed
   with a transaction-scoped advisory lock per order inside the guard, after which the same race
   yields `PT409 DOUBLE_PAYMENT_CONFLICT`.

## 8. Pre-frontend closure (2026-10-04)

The closure phase adopted the strict Data API surface (`schemas = ["public"]`, `graphql_public`
removed, `auto_expose_new_tables = false`) and re-verified the whole privilege model on the real
Supabase stack (PostgREST 16.4, PostgreSQL 17.11). One further defect of the same class as item 5
was found and fixed: under the strict defaults `service_role` lost the platform's automatic
grants (140 → 61) and **every** backend call answered `403 42501` — the migrations had always
relied on those grants. Migration `20261004150000` makes the backend self-sufficient: explicit
`select/insert/update/delete` on all tables and `usage/select` on all sequences for
`service_role`, re-established as default privileges for future objects;
`tests/schema/backend-role-access.test.ts` now recreates the strict baseline (roles present, no
automatic grants) and fails 3/3 without the migration.

Re-verified on the live stack afterwards: `service_role` table grants 140, `anon` 0,
`authenticated` 0; function EXECUTE 0/0/43 of 52; `service_role` can use `app_private`,
`anon`/`authenticated` cannot; 19/19 tables with RLS, 0 policies. New tables and sequences
inherit the safe defaults (probe: `{postgres=arwdDxtm,service_role=arwdDxtm}`, no
`anon`/`authenticated`). One PostgreSQL behaviour is recorded because it constrains every future
migration: the built-in `EXECUTE` to `PUBLIC` on **new functions** cannot be removed through
default privileges — re-confirmed on PG 17.11, where even an in-transaction
`alter default privileges … revoke … from public` left `proacl` NULL — so each new function needs
its explicit grant/revoke, and the function scan in `rls.test.ts` is the guard. `supabase db
lint` was also run on the real stack for the first time: it reported one volatility mismatch
(`app_private.normalize_order_input` marked IMMUTABLE while calling the STABLE
`jsonb_build_object`), fixed by migration `20261004160000`; the six remaining findings are
cosmetic plpgsql warnings (unused variables / shadowing in `create_order`, `confirm_payment` and
`finish_payment_reconciliation`) recorded as accepted, and `supabase db diff` reports no schema
drift. Full evidence: [audits/pre-frontend-closure-01.md](audits/pre-frontend-closure-01.md).

## 9. Incident response (first 30 minutes)

1. **Rotate first**: change the affected credential(s) (`supabase secrets set`, Wompi dashboard,
   Resend dashboard) and redeploy. Do not wait for a root cause.
2. **Preserve evidence**: export function logs and the `payment_events` table before they age out.
3. **Assess impact**: which orders/payments were touched, whether tickets were issued, whether any
   personal data was exposed. The log lines carry `orderId`, `paymentId`, `wompiReference`,
   `ticketId` for exactly this purpose.
4. **Contain**: if ticket tokens may have leaked, cancel the affected tickets and re-issue with new
   tokens (the schema supports cancelling a ticket without touching the payment record).
5. **Notify**: tell the client; legal notification obligations for personal data breaches are the
   client's call, but the incident facts must be available quickly.

## 10. Review checklist for new code

- [ ] No secret, key, token or credential is read, logged or returned outside `config/env.ts`.
- [ ] New public endpoint: whose authentication, which fields are returned, and how it is rate
      limited?
- [ ] New table: RLS enabled, no policies, identifiers only in logs. Privileges stay revoked
      from `anon`/`authenticated`.
- [ ] New function: `revoke all on function ... from public, anon, authenticated` (a direct
      platform grant survives a `revoke ... from public`, and PUBLIC's built-in EXECUTE on new
      functions cannot be removed by default privileges — verified on PostgreSQL 17), then
      `grant execute ... to service_role` if the backend calls it. `rls.test.ts` fails otherwise.
- [ ] New helper in `app_private`: `service_role` needs USAGE on the schema and EXECUTE on any
      helper called from inside another function (the call is checked as the caller).
- [ ] New personal-data field: does it appear in the Sheets export and the retention policy?
- [ ] New external call: does it fail safe (no state change on an unexpected response)?
- [ ] New state change: is it idempotent, and is the transition expressed in the state machine?
- [ ] Money: `CopCents`, integers only, computed from the database.
