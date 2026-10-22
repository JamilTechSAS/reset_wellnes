# Pre-frontend adversarial audit — 01

**Date:** 2026-10-04
**Auditor:** independent review pass (no reliance on phase reports, prior tests or documentation)
**Subject:** the whole backend repository at `C:\Jamil Tech\Jamil Web\Tatiana`
**Verdict:** **APPROVED WITH CONDITIONS** — one critical defect was found and fixed; the
conditions in § 14 must be met before the frontend is connected to a live payment account.

---

## 1. Executive verdict

**Is the backend safe, consistent and reliable if the frontend were connected tomorrow and a
real Colombian customer paid?**

_After the fixes in this audit, at the code and database level: yes._ The money path is
price-authoritative (no amount ever comes from the client), the webhook body is treated as an
identity pointer only, confirmation is a single atomic SQL transition, tickets and attendance
are exactly-once by database constraint, and the email outbox is idempotent by a derived
key. Every one of those properties was re-derived from the SQL and re-tested on PostgreSQL 17.

**Before the fixes: no.** Two of the seven findings below would have broken or visibly damaged a
real deployment:

- the backend's own database role could not execute **15 of the 27 public SQL functions**
  (`permission denied for schema app_private`), including the very first call of the public
  flow — reproducible on PostgreSQL 17, invisible to the existing test suites;
- a transient Wompi webhook failure could **never be retried** (the redelivery was answered
  `200` without reprocessing), leaving a paid order pending with no operator-visible outcome.

No finding remains open. The verdict is **APPROVED WITH CONDITIONS** rather than **APPROVED**
because the fixes were verified on a self-hosted PostgreSQL 17 with Supabase's role and
privilege model reproduced, **not** against the real Wompi/Resend/Google APIs, and because
several business decisions are still open (§ 13). Those are conditions on _deployment_, not
defects in the code.

Had the two blocking defects above been left in place, the verdict would have been
**NOT APPROVED**.

---

## 2. Scope and method

Audited from zero, as delivered code:

- all 20 SQL migrations (`supabase/migrations/`), read in full;
- all Edge Functions (`supabase/functions/*/index.ts`) and the whole `_shared` core
  (api / db / domain / http / integrations / logging / config);
- the test suite (43 files) — read for _quality_, not trusted for _correctness_;
- the configuration surface: `supabase/config.toml`, `.env.example`, `deno.json` files,
  `docs/*.md`, README.

Method, in this order:

1. **Architecture reconstruction** from code alone (no phase documents), then comparison with
   the documentation.
2. **Adversarial reading** of the money path, the auth model, the API surface, the error
   contract and the rate limiter, looking for reachable states that violate an invariant.
3. **Reproduction** of every suspected defect (PGlite for SQL semantics, a real
   PostgreSQL 17.11 container for privileges, concurrency and invocation as `service_role`).
4. **Fixing** real defects with the smallest correct change, each with a regression test, then
   re-running the full suite and the real-database evidence.

Deliberately **not** done: no frontend work, no new product features, no changes to skill
files, no commits, no deployment.

Evidence conventions below: `PG17` = PostgreSQL 17.11 in Docker (host port 15432, database
`tatiana_verify` / `tatiana_final`), `PGlite` = the project's schema test engine,
`E2E-SR` = the API's SQL entry points invoked as `service_role` on PG17.

**What the auditor could not do (never downgraded to "verified"):** start the local Supabase
stack (Windows reserves ports 54321/54322, so PostgREST/GoTrue/Storage cannot run here), or
call a real Wompi, Resend or Google API (no credentials exist in the repository). See § 12.

---

## 3. Architecture reconstruction (independent)

```text
Spanish frontend (not built)
        │  HTTPS + JSON
        ▼
Supabase Edge Functions (Deno)          verify_jwt = false on every function; each function
  events · orders · orders-status · orders-participants · orders-retry · orders-hint
  orders-maintenance · tickets · checkin · webhooks-wompi · health
        │ thin adapters: parse → authorize → call handler → envelope
        ▼
_shared/api/* handlers (portable TypeScript, unit-tested under Node)
        │
        ▼
_shared/db/* typed gateways  →  PostgREST RPC as service_role
        ▼
public SQL functions (SECURITY INVOKER, `set search_path = ''`, EXECUTE revoked from PUBLIC
and from anon/authenticated, granted to service_role only)
        ▼
19 tables: RLS enabled, ZERO policies, no privileges for anon/authenticated
        ▼
Providers: Wompi (webhook + private-key transaction read), Resend, Google Sheets
           (service-account JWT), Supabase Auth for operators, pg_cron → pg_net → maintenance
```

**Money and trust invariants (re-derived, then individually verified):**

| Invariant                                                   | Mechanism                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Prices come from the database only                          | `create_order` / `quote_order_price` have **no amount parameter**                                 |
| The webhook body is never trusted                           | Body = identity pointer; the decision comes from `GET /v1/transactions/{id}` with the private key |
| One atomic confirmation for webhook, sweep and payment hint | `confirm_payment` is the single transition all three call                                         |
| At most one approved payment per order                      | partial unique index + `PT409` guard trigger                                                      |
| Tickets exactly once                                        | `unique (order_item_id, order_item_seq)` + conditional insert                                     |
| Attendance exactly once                                     | `unique (ticket_id)` + ticket row lock                                                            |
| Email exactly once                                          | outbox idempotency key `ticket:<id>:TEMPLATE` with a derived-key CHECK                            |
| Ticket tokens are unguessable                               | `TKT_` + 20 Crockford characters, 100-bit CSPRNG, unique index                                    |
| No SQL text in HTTP bodies                                  | SQLSTATE `PT400/PT404/PT409` + `detail` → typed app errors                                        |
| Frontend can never reach Postgres directly                  | RLS + zero policies + revoked grants (see finding AUD-05)                                         |

The reconstruction matches `docs/architecture.md` and `docs/data-model.md`; the documentation
was accurate about the design and, as it turned out, **optimistic about two of its own
verification claims** (AUD-05, AUD-06).

---

## 4. Findings

Seven real defects. Two would have blocked a real launch (AUD-06, AUD-01); all seven are fixed
with regression tests. Severity uses the usual scale: Critical = breaks the product or risks
money/data; High = would misbehave on real traffic; Medium = wrong contract or operator
blindness; Low = hardening.

| ID     | Sev          | Subsystem          | Finding                                                                                   | Status |
| ------ | ------------ | ------------------ | ----------------------------------------------------------------------------------------- | ------ |
| AUD-06 | **Critical** | SQL / privileges   | `service_role` had no USAGE on `app_private`; 15 of 27 public functions fail at runtime   | Fixed  |
| AUD-01 | **High**     | Webhook handler    | An event claimed but never finalized was answered `200` and never reprocessed             | Fixed  |
| AUD-05 | Medium       | SQL / privileges   | `anon`/`authenticated` kept direct EXECUTE on every public function (Supabase defaults)   | Fixed  |
| AUD-03 | Medium       | SQL / payments     | A second approval aborted with a raw `23505` → opaque `503` loop, no recorded outcome     | Fixed  |
| AUD-07 | Medium       | SQL / payments     | A _concurrent_ second approval still hit the raw `23505` (window left by AUD-03's fix)    | Fixed  |
| AUD-02 | Medium       | API / validation   | `ParticipantValidationError` collapsed to `500`; documented `details.issues[]` never sent | Fixed  |
| AUD-04 | Low          | HTTP / rate limits | `ip:port` kept as the bucket key; out-of-range octets accepted                            | Fixed  |

### AUD-06 — Critical — the backend role could not execute most of its own SQL API

**Evidence (PG17, reproduced before the fix):**

```text
set role service_role;
select public.get_public_event('TAT-2026');
ERROR:  permission denied for schema app_private
CONTEXT:  PL/pgSQL function public.get_public_event(text) line 14 at RETURN
```

**Why:** every function is `SECURITY INVOKER`, so privileges are checked as the caller — and
the caller is `service_role`. 15 of the 27 public functions call helpers in `app_private`
(enumerated from `pg_proc.prosrc`): `get_public_event`, `get_public_availability`,
`quote_order_price`, `create_order`, `confirm_payment`, `retry_payment` paths,
`attach_participant`, `update_participant`, `record_check_in`, `get_public_ticket`,
`get_operator_ticket`, `consume_rate_limit`, `cleanup_rate_limit_counters`,
`claim_payment_reconciliations`, `finish_payment_reconciliation`, `sheet_projection_stats`.
`app_private` is created by migration `20261003202241`, which revokes its USAGE from
`anon`/`authenticated` — and nobody ever granted it to `service_role` (a freshly created schema
gives PUBLIC nothing).

**Impact:** the public catalog, order creation, payment confirmation, check-in and the
maintenance jobs would all have failed on a real Supabase project. Effectively: the product
would not have worked.

**Why the existing suites missed it:** PGlite runs as the database owner (which holds USAGE and
EXECUTE implicitly); `has_function_privilege` probes answer about the function's EXECUTE grant,
not about the schema or the helper grants used _inside_ the body. Only invoking the function as
`service_role` exposes it.

**Fix:** migration `20261004140000_backend_role_private_schema_access` — `grant usage on schema
app_private to service_role`, plus EXECUTE on the three helpers reached from inside other
functions (`normalize_participant_payload`, `append_participant_consents`,
`enqueue_sheet_projection`; a `SECURITY INVOKER` call is checked against the caller). Trigger
functions need no EXECUTE to fire and the cron entry point runs as its job owner, so nothing
else is granted.

**Regression test:** `tests/schema/backend-role-access.test.ts` runs the API as `service_role`
(catalog reads, order → payment → tickets → email → check-in, participant attach/update, sheets
claim/finish, exactly-once replay). Verified discriminating: with the migration removed, 3 of 3
tests fail with `permission denied for schema app_private`; with it, 3 of 3 pass.

### AUD-01 — High — a transient webhook failure could never be retried

**Why:** `handleWompiWebhook` treats a delivery whose ledger row was already claimed as a
duplicate and answers `200`. If the first delivery died mid-processing (answering `503`, or the
worker being killed), the row stays `result = NULL`, `processed_at = NULL` — but the redelivery
was still answered `200` without reprocessing. Wompi stops retrying, the approval at Wompi stays
unconfirmed, and if the transaction id was never stored the reconciliation sweep cannot see it
either: money taken, no ticket, no operator signal.

**Fix (`_shared/api/webhook-handler.ts`):** only short-circuit when the claim was _finalized_
(`claim.processedAt !== null`); otherwise log a warning and process the event again.
`confirm_payment` and the outbox are idempotent, and `finalize_webhook_event` updates only
`where processed_at is null`, so exactly one delivery owns the final state.

**Regression test:** `tests/api/webhook-handler.test.ts` — "reprocesses an event that was
claimed but never finalized".

### AUD-05 — Medium — the browser-facing roles could still execute every backend function

**Why:** the migrations revoke EXECUTE from PUBLIC, but Supabase grants EXECUTE on new `public`
functions **directly** to `anon` and `authenticated` (documented in "Securing your API" →
"Default privileges"). A direct grant survives `revoke … from public`. Reproduced (PG17 with
the platform defaults): `anon_exec_fns = 27 / 27`, `auth_exec_fns = 27 / 27`, and calling
`public.create_order(...)` as `anon` reached the function body (returning its own validation
error) before failing on missing table privileges. The documented invariant ("EXECUTE revoked,
service_role only") therefore was not true on the deployment target; the posture held by a
single layer (table privileges) and would not survive the first deliberate grant, a
`SECURITY DEFINER` helper or a platform-default change.

**Fix:** migration `20261004130000_revoke_function_execute_from_api_roles` — revokes every
existing `public`/`app_private` function from `anon`, `authenticated` and PUBLIC, and removes
their future function and sequence default grants (table defaults were already removed by
`20261003210007`).

**Verified PostgreSQL limitation, documented in the migration:** PUBLIC's built-in EXECUTE on
_new_ functions cannot be removed with `alter default privileges … revoke … from public`
(checked on 17.11 through both the plain and the `for role postgres` form: the new function's
ACL still contains `=X/postgres`). The per-function revoke is therefore mandatory, and the
function scan in `tests/schema/rls.test.ts` fails the build if a future migration adds a
function without it. Future **sequences** are covered by the default revoke (verified).

### AUD-03 / AUD-07 — Medium — the second-approval guard, sequentially and concurrently

**Why:** `payments_one_approved_per_order_idx` makes two approved payments per order
impossible, but the way it fails is a raw `23505`. Reachable sequence: attempt 1 is approved at
Wompi but its webhook is lost; the reservation expires; the buyer retries; attempt 2 is paid;
attempt 1's late webhook then tries to approve a second attempt. Consequences: the webhook path
answers `503` (retry forever), no durable ledger outcome, no operator visibility.

**Fix (migration `20261004120000_guard_second_approved_payment`):** a BEFORE INSERT/UPDATE
trigger turns that transition into `PT409 DOUBLE_PAYMENT_CONFLICT`, which the API maps to a
recorded `REJECTED + reviewRequired` with HTTP `200`. A replay on the same approved row and a
first approval are untouched; the index remains the hard guarantee.

**AUD-07 (found while testing the fix):** with two _truly overlapping_ sessions, both ran the
existence check before either committed and the loser still failed with the raw `23505`
(reproduced: `duplicate key value violates unique constraint
"payments_one_approved_per_order_idx"`). Fixed by taking a transaction-scoped advisory lock
keyed by the order for the duration of a real approval transition; the same race then produces
`PT409 DOUBLE_PAYMENT_CONFLICT`.

**Regression tests:** `tests/schema/payment-confirmation.test.ts` (typed `PT409` on a second
approval; the recovery INSERT path) and `tests/schema/constraints.test.ts` (direct insert
refused with the typed contract).

### AUD-02 — Medium — participant validation answered 500 and dropped `details.issues[]`

`ParticipantValidationError` did not extend `AppError`, so `toAppError` collapsed it to
`INTERNAL_ERROR` → HTTP `500`, and the `details.issues[]` array promised by `docs/api.md` was
never delivered. Fixed by making it a `VALIDATION_ERROR` that keeps its `issues`; the redundant
catch in `orders-handler.ts` was removed. Regression test in `tests/api/orders-handler.test.ts`.

### AUD-04 — Low — rate-limit bucket key and client IP normalization

`resolveClientIp` kept `ip:port` as the whole bucket key (each connection an ephemeral port →
a new bucket) and accepted out-of-range shapes such as `999.1.2.3`. Fixed: IPv4 octets
validated, IPv4-with-port stripped, bracketed IPv6 hosts parsed, precedence unchanged
(`cf-connecting-ip` → last `x-forwarded-for` → `x-real-ip`). Regression tests in
`tests/http/client-ip.test.ts`.

### Lower-severity observations (no code risk today; recorded for completeness)

| ID   | Sev  | Observation                                                                                                                                                 | Action                                                                                     |
| ---- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| O-01 | Info | The secret sweep had no pattern for a real PEM private key or a Google service-account JSON — exactly the shape the Sheets integration uses                 | Fixed: patterns + a detection regression test                                              |
| O-02 | Info | `app_private` helpers without an explicit PUBLIC revoke (`set_updated_at`, `reject_update`, `normalize_participant_payload`, `append_participant_consents`) | Now revoked by `20261004130000`; they were unreachable anyway (no USAGE for the API roles) |
| O-03 | Info | `docs/security.md` "Verified on real PostgreSQL" showed privilege probes only, which passed while AUD-06 broke real invocations                             | Replaced with the two-level evidence in § 6 of that document                               |
| O-04 | Info | `maintenance-handler.ts` exports `maintenanceUnauthorized()`, never used                                                                                    | Left as-is (harmless; noted only)                                                          |
| O-05 | Info | `health/index.ts` reports `SERVICE_VERSION = "1.0.0-phase1"`, `database: "not-checked"`, stale comment                                                      | Left as-is; cosmetic, no functional effect                                                 |
| O-06 | Info | `docs/api.md` typo "`SKIP LOCKED`claims"                                                                                                                    | Not corrected (documentation nit)                                                          |
| O-07 | Info | `claim_payment_reconciliations` consumes an attempt at claim time even if the run dies before `finish` (bounded by `maxAttempts`)                           | Accepted by design, as documented                                                          |
| O-08 | Info | The obsolete `CHECKIN_API_TOKEN` is still mentioned in one comment and some phase docs mention "rate limiting is Phase 12"                                  | Historical records; deliberately untouched                                                 |
| O-09 | Info | No load/soak testing was performed (single 120-person event, low concurrency); no performance claim is made                                                 | Stated as a limitation                                                                     |

---

## 5. Security

- **Authentication model.** Public endpoints are authenticated by possession of the order
  reference + buyer email (or the ticket token), operators by Supabase Auth plus an active row
  in `public.operators`. `verify_jwt = false` per function is correct — each function performs
  its own check — and `operator-auth` fails closed for unknown roles (`api/operator-auth.test.ts`).
- **Payment authenticity.** The webhook body is only an identity pointer; the authoritative
  status comes from a private-key `GET /v1/transactions/{id}`. The checksum/properties of the
  event are validated in the handler, and a mismatch is recorded, not acted upon.
- **Database exposure.** After AUD-05: RLS on 19/19 tables, zero policies, zero table
  privileges and zero function EXECUTE for `anon`/`authenticated`, and no future-object defaults
  for them (PG17 evidence: `anon_exec_fns=0`, `auth_exec_fns=0`, `anon_table_grants=0`).
  `operational_export` (the only read model for the client's sheet) is `security_invoker = true`
  and readable by `service_role` only.
- **Internal schema.** `app_private` has no USAGE for the API roles; `service_role` has the
  minimum needed to run the API (AUD-06).
- **Secrets.** No credential-shaped string exists in the repository (the sweep now also detects
  PEM/service-account material); `.env.example` holds placeholders only; no secret is read,
  logged or returned outside `config/env.ts`. `npm audit` (prod and full): 0 vulnerabilities.
- **Rate limits.** Ten scopes, mirrored in `docs/api.md`, enforced via `consume_rate_limit`
  before work; the guard fails **open** on a limiter error, which is a documented, accepted
  residual risk (compensated by validation, tokens and reference+email gates).
- **Residual risks accepted by the design:** rate-limit fail-open; maintenance-token guessing is
  unthrottled but requires a ≥32-character secret and does no database work when wrong; the
  client's Google Sheet holds the operational PII the brief requires.

---

## 6. Payments

Verified on PG17 by driving the real functions as `service_role` (E2E-SR):

- `create_order` with no client amount → order `PENDING`, `EVT-2026-…` reference, matching
  `wompi_reference`, reservation window; a replayed idempotency key returns `replayed: true`
  with the same order.
- `confirm_payment` → `APPLIED`, order `PAID`, exactly **1** ticket for a 1-unit order; an
  immediate replay → `DUPLICATE` with **0** additional tickets; `queue_ticket_emails` →
  `{queued: 1}`, delivery claimed and finished `SENT`.
- `retry_payment` only from `EXPIRED`/`FAILED` (typed refusal otherwise) and always issues a
  **new** reference (`EVT-2026-000007-2`) — declined references are never reused.
- Second approval (sequential and concurrent): typed `PT409 DOUBLE_PAYMENT_CONFLICT`, one
  approved payment remains.
- Reconciliation sweep: claims only pending payments with a known transaction id on a non-paid
  order (`STILL_PENDING` → rescheduled), never touches a paid order's approved payment.
- Amount/currency/reference mismatches are rejected and recorded; the admin/operator sees
  `reviewRequired` rows instead of silent state.

**Concurrency evidence (two parallel sessions, PG17):** one confirmation applies and the other
is `DUPLICATE` with one ticket set; one check-in wins and the other reports `ALREADY_USED`;
a one-slot event creates exactly one order and the other buyer gets a typed `SOLD_OUT`;
one webhook claim per dedupe key.

---

## 7. Data integrity and concurrency

- Constraints do the heavy lifting: partial unique index for approvals, `unique
(order_item_id, order_item_seq)` for tickets, `unique (ticket_id)` for attendance, unique
  tokens, derived-key CHECK for the outbox, forward-only payment ranks by CHECK/enum.
- Oversell is prevented by conditional updates plus CHECK constraints (verified live:
  `SOLD_OUT`, one order created for one slot).
- Expiry releases inventory exactly once (`expiredCount: 1`, `releasedTiers: 1`) and moves the
  order to a retryable state.
- Exactly-once webhook processing: `claim_webhook_event` (dedupe key) + `finalize_webhook_event
… where processed_at is null`; a duplicate delivery is answered `200` once finalized and
  reprocessed while unfinalized (AUD-01).
- The approval guard serializes per order (AUD-03/07), so the refusal is typed even under
  overlap.

---

## 8. API contract

- Envelope `{ok:true,data}` / `{ok:false,error:{code,message,details?}}`, Spanish user-facing
  messages, English identifiers; SQL text never reaches a response body
  (`api/orders-handler.test.ts` asserts this).
- SQLSTATE mapping is complete: `PT400`→`VALIDATION_ERROR`, `PT404`→`NOT_FOUND`,
  `PT409`→`CONFLICT`, everything else→`INTERNAL_ERROR` with no detail leakage.
- `details.issues[]` for participant validation is now actually delivered (AUD-02).
- CORS allow-list, `OPTIONS` preflight, rate-limit scopes documented and mirrored between
  `_shared/domain/rate-limits.ts` and `docs/api.md`.
- Webhook contract: `200` for handled/duplicate/finalized events, `503` only for genuinely
  transient failures (and that `503` is now actually retryable — AUD-01).

---

## 9. Privacy and PII

- Buyer PII is limited to what the brief requires (name, cédula, email, phone, city) plus
  consent records with policy versions; the schema keeps consent history append-only.
- Public projections are whitelisted and minimal (`get_public_ticket`, `get_public_event`);
  no cédula/phone leaks in public reads (asserted in the API suites).
- Logs carry identifiers (orderId, paymentId, wompiReference, ticketId), not PII payloads.
- The operator projection (`get_operator_ticket`) and the Sheets export are the only places
  personal data is exposed, both behind service-role/operator gates.
- **Open client decisions:** retention period and anonymization policy, consent wording and its
  version string, and whether the buyer receives a copy of their own ticket email — see § 13.

---

## 10. Test quality

43 files / 439 tests, all green (`npm run check` → exit 0). Assessment of _quality_, not count:

- **Strong:** the three-layer parity discipline (domain rule ↔ SQL function ↔ handler outcome)
  for payments, pricing and check-in; explicit "rejection" assertions rather than happy-path
  only; the schema suites drive the real SQL entry points rather than re-implementing them;
  error-mapping and "SQL text never leaks" assertions; migration/enum/dependency parity guards.
- **Was weak, now fixed:** every schema suite ran as the function _owner_, so privilege defects
  that only appear for `service_role` were invisible — the critical finding. The new
  `schema/backend-role-access.test.ts` closes that class, and it is verified to fail without its
  migration.
- **Still not covered by tests (inherent):** true multi-session concurrency and the real
  PostgREST/GoTrue stack cannot run in PGlite or on this machine; those were covered by the
  ad-hoc PG17 evidence recorded in § 5 of `docs/security.md`, and remain a manual step per
  release.
- **Secret sweep:** now detects PEM private keys and Google service-account JSON as well
  (regression-tested so the patterns cannot silently rot).

---

## 11. Deployment readiness

| Area              | State                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations        | 20 files apply cleanly from zero on PG17 (verified) and in PGlite (every schema suite)                                                         |
| Types             | `database.types.ts` regenerated against the fully migrated PG17 → **byte-identical**                                                           |
| Privileges / RLS  | Verified on PG17: 19/19 RLS, 0 policies, 0 anon/authenticated table grants and function EXECUTE                                                |
| `npm run check`   | typecheck + eslint + prettier + function check + 439 tests → exit 0                                                                            |
| Dependency audit  | `npm audit` (prod and full): 0 vulnerabilities                                                                                                 |
| Config            | `.env.example` ↔ loader parity enforced by tests; no real secrets in the repository                                                            |
| Scheduled jobs    | pg_cron → pg_net → `orders-maintenance` with Vault secrets; degrades to "NOTICE" when the extensions are absent (PGlite) and works on Supabase |
| Observability     | Structured logs with correlation ids; `health` endpoint reports version/DB state                                                               |
| Frontend coupling | None: no build artifacts, no client SDK usage, no direct PostgREST surface for buyers                                                          |

---

## 12. Live-verification gap (what is NOT proven)

The following were **not** verified and must not be treated as verified:

1. **Real providers.** No Wompi, Resend or Google credentials exist in the repository. The
   signature/checksum vectors are covered by unit tests against the documented examples, but no
   live transaction, live webhook delivery, live email or live Sheets write was performed.
2. **Real Supabase project.** The local stack cannot start on this machine (Windows reserves
   ports 54321/54322). PostgREST/GoTrue behaviour with the publishable key was therefore not
   observed; RLS and privileges were verified at SQL level with the platform roles and defaults
   reproduced (which is what exposed AUD-06 and AUD-05 — a local `supabase start` would also
   have exposed AUD-06).
3. **Operational secrets.** Vault entries for the maintenance job, the maintenance token, the
   operator seed and the Google service account are deployment configuration, not repository
   content.
4. **Load and soak.** No sustained-load or long-running soak test; the design targets one
   ~120-person event.

---

## 13. Remaining business decisions (not silently chosen by this audit)

These are the client's calls, defaulted conservatively in code and flagged for sign-off:

1. Ticket prices, sales stages and their windows (currently one `pricing_tiers` row per stage in
   the seed path; the auditor did not invent prices).
2. Reservation window per order (`create_order` takes it as a parameter; the API default is
   15 minutes).
3. Discount policy: quantity discount vs code discount — stored as data in `pricing_policy`
   with the conservative default `BEST_SINGLE` (never stack; keep the larger).
4. Duplicate-cédula policy: the schema deliberately allows a repeated cédula within an event
   (only an index for lookup exists) — confirm the intended business rule.
5. Consent wording, its version string and whether `futureEvents` is opt-in or opt-out.
6. Wompi `expiration-time` is currently disabled; and which payment methods to accept.
7. Retention/anonymization period for PII, including `provider_payload`.
8. Whether the buyer also receives a copy of the emails sent to participants.

---

## 14. Final recommendation

**Verdict: APPROVED WITH CONDITIONS.**

The backend is structurally sound: money is database-authoritative, confirmation is atomic and
idempotent, tickets and attendance are exactly-once by constraint, the API contract is typed and
leak-free, and the database is closed to browser-facing roles. After this audit it also _works_
as its own database role, which it previously did not.

Conditions to satisfy before sales open (all are deployment/verification steps, none is an open
code defect):

1. **Deploy all migrations**, including the three from this audit
   (`20261004120000`, `20261004130000`, `20261004140000`), and re-run the privilege checks
   (`anon`/`authenticated`: no table privileges, no EXECUTE; `service_role`: USAGE on
   `app_private`; guard trigger present) against the real project.
2. **Run the `service_role` smoke flow once against the real project** — the checks are in
   `tests/schema/backend-role-access.test.ts`; the equivalent real-world check is one successful
   `get_public_event` and one `create_order` through the deployed functions.
3. **Live-verify the providers** with real credentials: one Wompi sandbox payment end-to-end
   (redirect → webhook → tickets → email), one Resend delivery, one Sheets projection row.
4. **Confirm the business decisions** in § 13 (prices/stages/windows, discount policy,
   consent wording, retention).
5. **Keep `RATE_LIMIT_ENABLED=true`** and configure the maintenance token and Vault secrets
   before enabling the scheduler.

If the conditions cannot be met, or if any of them reveals a behaviour that contradicts this
report, the verdict must be re-assessed — the code-level findings are closed, but the live path
is, by definition, unproven until it is exercised once for real.
