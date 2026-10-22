# Pre-frontend closure report 01

**Date:** 2026-10-04
**Scope:** close every condition of the independent pre-frontend audit
([pre-frontend-audit-01.md](pre-frontend-audit-01.md), verdict APPROVED WITH CONDITIONS) and
decide whether the backend can be frozen before frontend development begins.
**Deliverable:** this report. **Final decision:** §15.

## Verification levels used in this report

Each claim below is labeled with the strongest level that actually ran. The levels are not
interchangeable, and nothing in this document calls a mock "live".

| Level                     | Meaning                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Real Supabase (local)** | The full self-hosted Supabase stack on this machine: Kong, **PostgREST 16.4**, GoTrue, PostgreSQL 17.11 (`supabase_db_event-ticketing-backend`), Studio, Mailpit; real keys from `supabase status`. |
| **Real PostgreSQL 17**    | SQL executed against a real PostgreSQL 17 instance (local stack or the dedicated `pg-tatiana` container), never PGlite.                                                                             |
| **Injected/mocked**       | The provider HTTP call (Wompi, Resend, Google) is replaced by an injected `fetch` in tests. The database side is real; the provider side is not.                                                    |
| **Not executed**          | A real provider call that could not be made.                                                                                                                                                        |

**What does not exist in this environment** (checked during this phase): no hosted Supabase
project, no project reference, no `.env.local` / `.env.sandbox` / `.env.production` (only
`.env.example`, with placeholders), and no Wompi / Resend / Google / Supabase credentials in the
shell environment. Every "Not executed" item below exists because of this, and every one of them
was kept as a labeled gate instead of being simulated.

## 1. Objective

The independent audit closed with seven conditions. This phase existed to close them, re-run the
release gates after the changes, and produce one exact release decision — with no frontend work
and no unrelated functionality.

| #   | Audit condition                                                                         | Final status                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Decide and close the Supabase Data API / PostgREST exposure strategy                    | **Closed** (§2): kept enabled with an intentionally minimal surface; strict defaults adopted; official platform direction verified.                                                                                                       |
| 2   | Deploy/verify the corrected privilege configuration against the actual Supabase project | **Closed on the real local stack, hosted deploy not executed** (§3, §4): no hosted project or credentials exist; the full real Supabase stack was run locally and the privilege matrix verified there. Hosted deploy is a pre-sales gate. |
| 3   | Perform live Wompi Sandbox verification                                                 | **Not executed — gate** (§5): no Wompi credentials exist. Procedure documented; environment safety verified at config level.                                                                                                              |
| 4   | Perform live Resend verification                                                        | **Not executed — gate** (§6): no Resend key exists. Outbox and client verified with injected fetch + real SQL.                                                                                                                            |
| 5   | Perform live Google Sheets verification                                                 | **Not executed — gate** (§7): no service account exists. Client and isolation verified with injected fetch + real SQL.                                                                                                                    |
| 6   | Confirm the final production environment configuration                                  | **Closed** (§8): variable inventory matched against the loader and `.env.example`; public/server-only split defined; topology documented.                                                                                                 |
| 7   | Re-run the relevant release gates after those changes                                   | **Closed** (§12): full gate green, exit codes recorded, plus the two new migrations re-verified from zero.                                                                                                                                |

Additionally, the phase re-ran the audit's own fixes on the real stack (AUD-06 privilege
regression, §4), found and fixed **one new critical defect of the same class** (strict defaults
removing the backend's grants, §4), found and fixed one quality defect surfaced by `supabase db
lint` (§10), and froze the API contract (§9) and the database (§10).

**Stop condition honored:** no frontend code, no new functionality, no backend redesign, no
commits.

## 2. Supabase Data API decision

### Decision

**Option B — keep the Data API (PostgREST) enabled with an intentionally minimal surface.**
`anon` and `authenticated` hold **zero** privileges; `service_role` holds explicit grants; the
frontend never talks to it.

### Why not disable it (option A)

The backend itself is a PostgREST client. `_shared/db/client.ts` creates a `supabase-js` client
with the **secret key**, and every gateway call in `_shared/db/` goes through it:

- **27 `client.rpc(…)` calls** (`create_order`, `confirm_payment`, `record_check_in`,
  `get_public_event`, …);
- **5 table/view reads** via `.from(…)`: `operators`, `payments` (3 call sites),
  `email_deliveries`, `operational_export`.

Disabling the Data API would break the backend's own transport — the Edge Functions are deployed
per project and PostgREST is how they reach SQL. "Disable it" is therefore not available without
a redesign, which this phase explicitly precludes.

### Why not a public read model (option C)

Nothing in the product needs it. The event is ~120 participants; the frontend consumes the Edge
Functions only. Exposing a read model would add attack surface with no consumer.

### Exact configuration

`supabase/config.toml` (local; comments carry the production equivalents):

- `schemas = ["public"]` — `graphql_public` removed; the GraphQL route answers
  `PGRST106 / HTTP 406` ("Only the following schemas are exposed: public").
- `auto_expose_new_tables = false` — the "explicit grants only" mode.
- `verify_jwt = false` per function for all seven functions (`health`, `events`, `orders`,
  `tickets`, `checkin`, `webhooks-wompi`, `orders-maintenance`), each authenticating its own
  callers (see [api.md](../api.md) §1).
- Production equivalents: Dashboard → Settings → API → "Exposed schemas" = `public` only;
  "Automatically expose new tables" off; explicit grants live in migrations.

### Official platform behavior (verified, not assumed)

Supabase's changelog _"Tables not exposed to Data and GraphQL API automatically"_ (2026-04-28)
confirms this is the platform direction:

- the project-creation opt-out makes tables in `public` unreachable through the Data API without
  an explicit `GRANT` (PostgREST answers `42501` with a `GRANT …` hint — the exact shape observed
  in §4);
- the new behavior becomes the default for new projects on **2026-05-30** and is enforced on
  **all existing projects on 2026-10-30**;
- `pg_graphql` is no longer enabled by default since 2026-05-18.

Consequence for this project: the strict configuration is not just hardening — it is the
platform's future default **26 days from this report**, before any plausible launch window for
this event. Migration `20261004150000` (§4) is what makes the backend survive that date; without
it, the enforcement would have removed the `service_role` grants and every backend call would
have answered `403`.

### Consequences

- New tables/sequences created by migrations inherit safe defaults: `service_role` DML,
  nothing for `anon`/`authenticated` (verified on the real stack, §4).
- New **functions** still need an explicit `grant`/`revoke`: PostgreSQL's built-in `EXECUTE` to
  `PUBLIC` cannot be removed through default privileges (re-confirmed on PG 17.11); the function
  scan in `tests/schema/rls.test.ts` fails the build if either API role ever gains execution.
- Frontend implications: the browser must never call `/rest/v1` or `/graphql/v1`. The only
  Supabase endpoint the frontend may use is **Auth** (`/auth/v1/*`) for operator sign-in, with
  the publishable key — a value that is public by design and reads nothing (zero Data API
  grants). This is recorded in [api.md](../api.md) §5 and [environments.md](../environments.md)
  §2 and §8.

## 3. Actual Supabase deployment status

**Not deployed to a hosted project. No hosted project exists in this environment.** Evidence:
no `.env.local` / `.env.sandbox` / `.env.production`, no project reference anywhere, no
credentials in the shell environment; the only `.env` file is `.env.example` (28 variables, all
placeholders such as `prv_test_REPLACE_ME`, `re_REPLACE_ME`).

The strongest available substitute was executed instead: **the real Supabase stack, run locally**
(previous sessions assumed it could not start on this machine — it can):

| Component   | Observed                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------ |
| API gateway | Kong at `http://127.0.0.1:54321` (`/rest/v1`, `/auth/v1`, `/functions/v1`, `/graphql/v1`)        |
| Data API    | **PostgREST 16.4**                                                                               |
| Database    | Supabase Postgres image 17.11.0.002 at `127.0.0.1:54322` (`supabase_db_event-ticketing-backend`) |
| Auth        | GoTrue (signup, password sign-in, admin API exercised)                                           |
| Studio/Mail | Studio 54323, Mailpit 54324 (local auth emails only — not Resend)                                |
| Migrations  | all **22 applied from zero** (`npx supabase db reset`, exit 0), no errors                        |

**What this proves:** migrations, schema, RLS, grants, function privileges, the Data API
boundary and real-key behavior (§4–§10) — all against the real components, not mocks.

**What it does not prove:** hosted infrastructure behavior (Kong layer, connection pooler,
platform secrets), real email delivery, provider webhook reachability from the internet, and
production performance. **Required action (gate, not a frontend blocker):** create the sandbox
and production projects, `supabase db push`, set secrets, `functions:deploy`, then re-run the §4
probe matrix against the hosted project.

## 4. Privilege verification

All evidence below is **Real Supabase (local)** / **Real PostgreSQL 17.11**.

### Positive path (backend identity)

`service_role` (real secret key from `supabase status`):

- combined function EXECUTE: **43 of 52** (`anon` 0, `authenticated` 0);
- all **27 of 27** `public` functions executable; table grants **140** (= `postgres`);
- `app_private` USAGE = **true**; the audit's AUD-06 regression (`get_public_event` →
  `permission denied for schema app_private`) is gone;
- HTTP: `GET /rest/v1/orders` → **200**, `GET /rest/v1/operational_export` → **200**,
  `POST /rest/v1/rpc/get_public_event` → **200 `{"found":false}`**,
  `POST /rest/v1/rpc/get_public_ticket` → **200 `{"found":false}`**.

### Negative path (browser identities)

`anon` (anon key): `GET /rest/v1/orders` → **401**
`{"code":"42501","hint":"Grant the required privileges to the current role with: GRANT SELECT ON public.orders TO anon;","message":"permission denied for table orders"}`;
`operational_export` → **401** `permission denied for view`; `get_public_event`,
`get_public_ticket`, `record_check_in` → **401** `permission denied for function …`.

`authenticated` (real GoTrue session, token minted through `/auth/v1`): same calls → **403** with
the same `42501` class; `app_private` USAGE = false, function EXECUTE = 0.

GraphQL: `POST /graphql/v1` → **406** `{"code":"PGRST106","hint":"Only the following schemas are exposed: public","message":"Invalid schema: graphql_public"}`.

### The critical defect found and fixed in this phase

Under the strict defaults (`auto_expose_new_tables = false`), `service_role` lost the platform's
automatic grants (**61** grants instead of **140**) and **every** backend call answered
`403 42501 permission denied for table …`. The migrations had always relied on the platform's
implicit grants — the same defect class as the audit's AUD-06 (privilege assumptions that only
fail at runtime).

Fix: migration **`20261004150000_explicit_backend_role_grants.sql`** — explicit
`select/insert/update/delete` on every table in `public` and `usage/select` on every sequence for
`service_role`, **re-established as default privileges for future objects** (idempotent, guarded
by role existence).

Regression proof: `tests/schema/backend-role-access.test.ts` was rewritten to recreate the strict
platform baseline (roles present, no automatic grants) and **fails 3/3 without the migration**
(`permission denied for table events` / `orders`), **passes 3/3 with it**.

### Future-object behavior (probed on the live stack)

- New table created by migrations: ACL `{postgres=arwdDxtm,service_role=arwdDxtm}` — `service_role`
  true, `anon` false, `authenticated` false.
- New sequence: same safe shape.
- New function: `proacl` stays NULL → PostgreSQL's built-in `EXECUTE` to `PUBLIC` survives
  (re-confirmed on PG 17.11, even with an in-transaction `alter default privileges … revoke … from
public`). Recorded as a permanent constraint: every new function needs its explicit
  grant/revoke, enforced by the function scan in `tests/schema/rls.test.ts`.

## 5. Wompi Sandbox result

**NOT VERIFIED LIVE — no Wompi credentials exist in this environment.** Nothing in this report,
the phase notes or the test suite claims a live payment.

### What was verified instead (Injected/mocked + Real PostgreSQL 17)

- Event checksum verification against published vectors; envelope parsing; `GET
/v1/transactions/{id}` client with injected `fetch`; status mapping; unknown statuses never
  advance state.
- The whole confirmation pipeline on real SQL: claim → validate → `confirm_payment` → PAID →
  tickets with unique `(order_item_id, order_item_seq)` → QR token → email outbox.
- Replay/dedupe: unique `payment_events.dedupe_key`; duplicate delivery answers from the ledger;
  an unprocessed duplicate is reprocessed exactly once (audit fix).
- Retry: a new attempt gets a **new** Wompi reference; a consumed reference is never reused.
- Second approval: typed `PT409 DOUBLE_PAYMENT_CONFLICT` guard, sequential **and** concurrent
  (advisory lock).
- Reconciliation: lost-webhook sweep feeds the same `confirm_payment`, bounded by
  schedule/attempts; terminal results stop sweeping.
- Payment hint: same confirmation pipeline, idempotent.

### The five required Sandbox tests — status

| #   | Test                          | Status           | Exact procedure when credentials exist                                                                                        |
| --- | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Approved payment (`4242…`)    | **Not executed** | Create order → Widget/Web Checkout → webhook → checksum → lookup → PAID → exact ticket quantity → QR → email outbox → status. |
| 2   | Duplicate/replayed webhook    | **Not executed** | Repeat the same delivery; expect one payment, one ticket set, one outbox row, `DUPLICATE` outcome.                            |
| 3   | Lost webhook / reconciliation | **Not executed** | Withhold the event; run reconciliation; same pipeline, no duplicate tickets.                                                  |
| 4   | Declined payment (`4111…`)    | **Not executed** | Order must not become PAID; `FAILED` recorded; no tickets.                                                                    |
| 5   | Retry after failure           | **Not executed** | Retry the order; expect a **new** reference, old one unusable.                                                                |

The full live checklist (cards, Nequi/Daviplata phones, PSE codes, sandbox OTPs) is documented in
[phases/phase-04.md](../phases/phase-04.md) §13.

### Environment safety (verified at config level)

- Credential prefixes must match the environment derived from `APP_ENV` (production keys rejected
  in sandbox and vice versa), enforced at startup by `_shared/config/env.ts` and covered by
  `tests/config/env.test.ts`.
- `WOMPI_BASE_URL` may only be overridden when `APP_ENV=development`; deployed environments are
  pinned to the official sandbox/production hosts.
- No credentials were present, so none could cross environments, and none are printed anywhere
  in this report.
- Required action: provide the four sandbox values (`pub_test_*`, `prv_test_*`, integrity +
  events secrets), set `APP_ENV=sandbox` on the sandbox project, execute Tests 1–5.

## 6. Resend result

**NOT VERIFIED LIVE — no `RESEND_API_KEY` exists in this environment.**

Verified instead (Injected/mocked + Real SQL):

- The outbox is the contract: unique row per `(ticket, template)`, `SKIP LOCKED` claim so two
  dispatchers cannot share a row, `finish` updates only claimed rows — a duplicate email is
  impossible at three layers (unique key, claim, provider `Idempotency-Key` = outbox key).
- The Resend client is tested with an injected `fetch`: accepted responses recorded with the
  provider message id; transient failures remain `QUEUED` with retry/backoff; logs never contain
  the key (redaction suite).
- `EMAIL_ENABLED` gating: disabled locally by default; a deployment with email enabled but
  missing `RESEND_API_KEY`/`EMAIL_FROM` fails startup with variable names only.
- Spanish content rendered from real ticket/event rows in tests.

Required action (gate): provide `re_*` key + verified sender (`EMAIL_FROM`), send one controlled
confirmation to a controlled inbox, verify provider message id in the delivery row, no duplicate
outbox row, retry safety, and no secrets in logs. The outbox staying `QUEUED` is a valid visible
state until then.

## 7. Google Sheets result

**NOT VERIFIED LIVE — no service account exists in this environment.**

Verified instead (Injected/mocked + Real SQL):

- The service-account flow is tested with a locally generated PKCS#8 key and an injected `fetch`
  (JWT assertion, token exchange, `values.append`/`batchUpdate` calls).
- The projection is an outbox: triggers on `tickets`/`participants`/`attendance`/`consents`
  enqueue one row per ticket (collapsing changes), claimed with `SKIP LOCKED`; a change that
  arrives mid-write stays queued.
- **Isolation is enforced and tested**: enqueueing is a plain insert; the HTTP call happens only
  in `orders-maintenance`; failures never touch payment, ticket issuance or check-in;
  `SHEETS_ENABLED=false` (the default) skips the projection entirely and every other job runs.
- Formula injection: writes use `valueInputOption: "RAW"`; a value starting with `=` is stored as
  text.
- The export read model (`operational_export`) is `security_invoker`, so it fails closed without
  base-table rights; only `service_role` reads it today.

The required failure drill (deliberately breaking the Sheets call and confirming payment/ticket/
check-in survive, then retrying the projection) is **partially** covered: client failure and
worker isolation are covered by tests at the handler boundary; the live-API failure drill was not
executed. Required action (gate): dedicated spreadsheet, share with the service account, set
`SHEETS_ENABLED=true`, verify participant row / payment status / ticket code / attendance /
consent fields, then break the API key on purpose and confirm the retry path.

## 8. Production environment configuration

Audited against `_shared/config/env.ts`, `.env.example` (parity enforced by
`tests/tooling/env-template.test.ts`) and [environments.md](../environments.md).

| Category                | Variables                                                                                                                                                                                                                                                                     | Placement / audience                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Supabase (server)       | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (must be `sb_secret_*` or service-role JWT; publishable rejected at startup)                                                                                                                                                            | Edge Function secrets — server only                             |
| Supabase (browser)      | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`                                                                                                                                                                                                                                    | Public; **Auth sign-in only**, reads nothing                    |
| Wompi (server)          | `WOMPI_PRIVATE_KEY`, `WOMPI_INTEGRITY_SECRET`, `WOMPI_EVENTS_SECRET`                                                                                                                                                                                                          | Edge Function secrets — server only                             |
| Wompi (browser)         | `WOMPI_PUBLIC_KEY`                                                                                                                                                                                                                                                            | Public by design (merchant id)                                  |
| Email                   | `RESEND_API_KEY`, `EMAIL_FROM` (required when deployed; `EMAIL_ENABLED` defaults to true outside development), `EMAIL_REPLY_TO` (optional)                                                                                                                                    | Edge Function secrets — server only                             |
| Google (optional)       | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SHEETS_DATA_TAB` (`Datos`), `GOOGLE_SHEETS_STATUS_TAB` (`Estado`)                                                                                                                      | Edge Function secrets; required only when `SHEETS_ENABLED=true` |
| Maintenance / scheduler | `MAINTENANCE_API_TOKEN` (≥32 chars, required outside development) + Vault secrets `project_url`, `maintenance_api_token`                                                                                                                                                      | Server only; Vault readable by the cron job                     |
| Public URLs             | `API_BASE_URL`, `PUBLIC_WEB_BASE_URL`, `TICKET_BASE_URL` (optional), `WOMPI_REDIRECT_URL` (optional)                                                                                                                                                                          | Public values (frontend links/callback)                         |
| Ops/tuning              | `APP_ENV`, `SERVICE_NAME`, `LOG_LEVEL` (`info`; `debug` refused in production), `TIMEZONE` (`America/Bogota`), `ORDER_RESERVATION_MINUTES` (15), `EMAIL_DISPATCH_BATCH_SIZE` (10), `RATE_LIMIT_ENABLED` (true), `SHEETS_ENABLED` (false), `WOMPI_BASE_URL` (development only) | Edge Function env vars                                          |

**Public values that may reach the browser:** functions base URL, Wompi public key, event code,
Supabase URL + publishable key (operator Auth sign-in), public site URL. **No private credential
is required by the browser**, and nothing in the browser is authoritative for price, inventory,
payment state, ticket validity or attendance.

Topology and deploy plan (what deploys where; secrets in Vercel vs Supabase; Vault; sandbox vs
production; how the frontend points to the backend) is recorded in
[environments.md](../environments.md) §8. Hosted secret creation was **not executed** (no
project) — it is part of the deploy gate in §14.

## 9. API contract freeze

Method: the actual routes were re-derived from the handlers and compared with
[docs/api.md](../api.md) — headings, auth, request/response shapes, error codes, sensitive-field
projections, idempotency and rate-limit scopes. Handler sources: `orders/index.ts` (reference,
retry, participants attach/update, payment-hint, create, quote), `checkin/index.ts` (POST
`/check-in`, GET `/check-in/{token}`), `tickets/index.ts`, `events/index.ts`,
`webhooks-wompi/index.ts`, `orders-maintenance/index.ts`, `health/index.ts`; rate-limit scopes in
`_shared/domain/rate-limits.ts` vs [api.md](../api.md) §3 (all 10 scopes matched).

**Result: no discrepancy found.** One documentation change was made in this phase:
[api.md](../api.md) gained §5 (Data API boundary) and §6 (the freeze table below), and its status
line now says the contract is frozen.

| Endpoint                              | Auth                                | Safety / idempotency                             |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `GET /health`                         | public                              | read-only                                        |
| `GET /events/{code}`                  | public                              | whitelisted projection                           |
| `GET /events/{code}/availability`     | public                              | read-only                                        |
| `POST /orders/quote`                  | public                              | pure; stores nothing                             |
| `POST /orders`                        | public                              | price/inventory re-validated in SQL              |
| `GET /orders/{ref}`                   | reference + `X-Buyer-Email`         | wrong email == unknown reference                 |
| `POST /orders/{ref}/retry`            | reference + buyer email             | new Wompi reference per attempt                  |
| `POST /orders/{ref}/participants`     | reference + buyer email             | validated in transaction                         |
| `PUT /orders/{ref}/participants/{id}` | reference + buyer email             | foreign id answered `NOT_FOUND`                  |
| `POST /orders/{ref}/payment-hint`     | reference + buyer email             | safe to repeat                                   |
| `GET /tickets/{token}`                | opaque token (capability)           | whitelisted projection                           |
| `POST /check-in`                      | Supabase Auth + active operator     | first scan wins (`unique (ticket_id)`)           |
| `GET /check-in/{token}`               | Supabase Auth + active operator     | read-only admission view                         |
| `POST /webhooks/wompi`                | event checksum + private-key lookup | dedupe per event; replays answer from the ledger |
| `POST /orders-maintenance`            | `Bearer <MAINTENANCE_API_TOKEN>`    | every job idempotent + `SKIP LOCKED`             |

Sensitive fields: responses are SQL whitelists; the browser receives only `integritySignature`
(hash), never the integrity secret; ticket tokens are capabilities (100 bits CSPRNG, opaque);
cédula is never returned by ticket/status endpoints and never in the QR.

**Frozen.** Additive changes may still ship; a breaking change requires a new function name
(`orders-v2`) and a coordinated frontend deploy. Unless a real defect is found, shapes do not
change.

## 10. Database freeze verification

All on **Real Supabase (local)**, PostgreSQL 17.11, 22 migrations applied from zero
(`npx supabase db reset`, exit 0; log: 22 × `Applying migration`, final
`20261004160000_normalize_order_input_volatility.sql`).

| Item          | Value                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Tables        | 19                                                                                                    |
| Views         | 1 (`operational_export`, `security_invoker`)                                                          |
| Indexes       | 71 (38 unique)                                                                                        |
| Constraints   | 160 — check 95, FK 30, PK 19, unique 16                                                               |
| Enums         | 9                                                                                                     |
| Functions     | 52 (27 `public` + 25 `app_private`)                                                                   |
| Triggers      | 22 in `public` (project); platform schemas add cron 1, realtime 1, storage 7                          |
| RLS           | **19/19 tables enabled, 0 policies** (deny-by-default, as designed)                                   |
| Extensions    | `pg_cron`, `pg_net`, `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`       |
| Scheduled job | 1: `event-ticketing-maintenance`, `*/5 * * * *`, `select app_private.invoke_scheduled_maintenance();` |
| Vault secrets | 0 (correct: Vault contents are deployment configuration, created per project)                         |

- **Types**: `npx supabase gen types typescript --local` → 680 lines, **byte-identical** to
  `supabase/functions/_shared/db/database.types.ts` (empty diff).
- **Drift**: `npx supabase db diff --local` → **"No schema changes found"** (exit 0).
- **Lint (first run ever — it needs the stack)**: `npx supabase db lint --local`, exit 0. It
  reported 7 warnings; 1 was a correctness-class mismatch —
  `app_private.normalize_order_input` marked IMMUTABLE while calling the STABLE
  `jsonb_build_object` — fixed by migration **`20261004160000`** (now `provolatile = s`; no
  behavior change: its only caller passes a variable, and no index/CHECK relied on the claim).
  The remaining **6 are cosmetic** plpgsql warnings, accepted as-is rather than rewriting
  behavior-tested SQL during a freeze: unused variables in `create_order` (`v_replay`,
  `v_payment_id`) and `confirm_payment` (`v_unit`, `v_max_attempt`, one shadowing) and an unused
  parameter in `finish_payment_reconciliation` (`p_now`). None changes a result; all six sites
  are covered by behavior tests.

No unexpected drift. The database is frozen at 22 migrations.

## 11. Final security sweep

| Area                 | Evidence (level)                                                                                                         | Result |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| Secrets in the repo  | automated credential-shaped-string scan + `.env.example` template test; only placeholders exist (Injected/mocked + repo) | Pass   |
| Secrets in logs      | redaction suite (secrets, tokens, signatures, email/phone/cédula masked at any depth)                                    | Pass   |
| Data API boundary    | §4 probe matrix on the real stack (Real Supabase)                                                                        | Pass   |
| RLS                  | 19/19 enabled, 0 policies, `anon`/`authenticated` cannot read (Real PostgreSQL 17)                                       | Pass   |
| Function privileges  | 0/0/43 of 52 EXECUTE; function scan in `rls.test.ts` guards future functions                                             | Pass   |
| Operator auth        | real GoTrue session + `operators.is_active`; deactivation revokes immediately; 401 vs 403 semantic                       | Pass   |
| Check-in             | outcome precedence, `unique (ticket_id)` + row lock; real-PG concurrency (two scans, one wins)                           | Pass   |
| Order enumeration    | reference + buyer email, identical `NOT_FOUND`, re-checked in SQL; concurrent reads                                      | Pass   |
| Ticket enumeration   | 100-bit CSPRNG tokens, uniform 404 for malformed/unknown                                                                 | Pass   |
| Rate limits          | 10 scopes; documented fail-open; IP normalization (AUD-04 fix) regression-tested                                         | Pass   |
| Webhook verification | checksum constant-time; replay gate; typed `PT409` guard + advisory lock; reprocess-once fix                             | Pass   |
| PII                  | whitelisted projections; cédula never in rest/QR; consent rows append-only                                               | Pass   |
| Maintenance endpoint | constant-time bearer (≥32 chars); no DB work on wrong token; Vault-held for cron                                         | Pass   |
| Scheduler            | `pg_cron` job present; reads credentials from Vault, none in migrations                                                  | Pass   |
| Sheets isolation     | outbox + worker separation; `SHEETS_ENABLED=false` default; RAW input vs formula injection                               | Pass   |

New findings this phase: the strict-defaults grant defect (§4, Critical — fixed + regression) and
the volatility mismatch (§10, quality — fixed). **No other vulnerability was found; none is
open.** Residual risks carried (documented, accepted): rate-limit fail-open, unthrottled but
secret-guarded maintenance endpoint, client-held operational data in the spreadsheet, hosted
project not yet probed.

## 12. Final test results

Exact commands and exit codes (all after the final code/migration change; no test was weakened,
skipped or suppressed):

| Command                              | Exit | Output                                                         |
| ------------------------------------ | ---- | -------------------------------------------------------------- |
| `npx supabase db reset`              | 0    | 22 migrations applied from zero, seed loaded                   |
| `npm run typecheck`                  | 0    | no errors                                                      |
| `npm run lint` (ESLint)              | 0    | no findings                                                    |
| `npm run format:check` (Prettier)    | 0    | all files formatted                                            |
| `npm run functions:check` (Deno)     | 0    | all Edge Functions type-check                                  |
| `npm run test` (Vitest)              | 0    | **43 files / 439 tests passed**                                |
| `npm run check` (the gate)           | 0    | same run composed; also re-run green after migration `…160000` |
| `npx supabase db lint --local`       | 0    | no correctness warnings (6 cosmetic accepted, §10)             |
| `npx supabase db diff --local`       | 0    | "No schema changes found"                                      |
| types regeneration vs committed file | 0    | 680 lines, empty diff                                          |

The audit baseline was 427 tests in 42 files; the audit's fixes brought it to 439 in 43 (the
strict-baseline `backend-role-access` suite is the extra file, and it is proven discriminating:
3/3 failures without migration `20261004150000`).

> **Note (2026-10-05, Phase 6B):** the `43 files / 439 tests` figures above are the recorded state
> at this report's date. The count has since grown to **631 tests in 51 files** with the Phase 6A/6B
> frontend suites; the 43 backend files and their 439 tests are unchanged. See
> [docs/testing.md](../testing.md) for the current count.

## 13. Remaining business decisions

Product decisions the client still owes; none requires a backend redesign, and none blocks the
frontend (each is config/data or a documented policy), but several are needed before the first
sale. Mirrors [data-model.md](../data-model.md) §8:

1. Duplicate-registration policy (cédula unique per event / per type / warning-only).
2. Final prices, number of pricing stages, quantities and dates per stage.
3. Quantity-discount breakpoints/percentages (`quantity_discounts` ships empty).
4. Discount codes: which, values, validity, limits, combination with quantity discounts.
5. Discount combination policy (`pricing_policy.discount_combination` defaults to `BEST_SINGLE`).
6. Reservation window (`ORDER_RESERVATION_MINUTES`, technical default 15).
7. Participant-edit policy after payment (audit trail design).
8. Manual check-in fallback policy (admit pending payments? `attendance.method='MANUAL'` exists).
9. Consent wording and version (mechanism ready: `policy_version`, `policy_text_hash`).
10. Extra participant fields beyond the current list (`extra_fields` absorbs them).
11. Wompi `expiration-time` in checkout (supported, disabled by default).
12. Data retention window, including `provider_payload` (may contain personal data).
13. Refund process (backend records `refunded`; no refund flow exists — client + Wompi support).
14. Final email copy (currently provided Spanish templates; copy review pending).

## 14. Remaining technical limitations

1. **No hosted Supabase project** — deployment (migrations, secrets, functions) has not been
   executed; the privilege matrix must be re-run against the hosted project (§3, gate).
2. **No live Wompi sandbox run** (Tests 1–5), **no live Resend send**, **no live Google Sheets
   write** — no credentials exist in this environment; procedures documented (§5–§7). These are
   pre-sales gates, not code conditions.
3. **Production credentials and webhook configuration do not exist yet** (Wompi production keys,
   production event URL, verified Resend domain, Sheets share, operator accounts, Vault secrets,
   cron verification) — all part of the deploy gate.
4. **Local-stack caveats**: `imgproxy`/`pooler` are disabled in the local config; the `vector`
   container restarts noisily under Docker Desktop; local keys are public development defaults.
5. **Rate limiter fails open** by design (documented); abuse control is defense-in-depth, not a
   hard guarantee.
6. **Maintenance endpoint is unthrottled** (secret ≥32 chars; wrong tokens cause no DB work).
7. **No sustained load test**; event scale is ~120 participants / one page.
8. **No automated HTTP end-to-end test of Edge Functions in the gate** — they are tested at the
   handler boundary, and this phase's PostgREST probes were manual (scripted, not committed).
9. **Six cosmetic plpgsql lint warnings** accepted (§10).
10. **Provider-failure drills** for Sheets/Resend are covered at the client/isolation boundary;
    the live-API failure drill remains to be run in sandbox.

## 15. FINAL RELEASE STATUS

The audit's conditions are resolved to the strongest level this environment allows: the two
conditions that no credential can substitute (Data API strategy, production environment
configuration) are closed, the privilege configuration is verified on the real Supabase stack
(replacing "against the actual project" — no project exists), the release gate re-ran green, and
the three provider conditions are impossible to execute because **no credentials exist**; their
exact procedures are documented and gated. The audit's definition requires live provider smoke
tests "where required/available"; they are not available, and nothing fake was ever presented as
live. Remaining gaps are external (accounts, credentials, a hosted project), not code, schema,
contract or security conditions, and none is launch-blocking for starting the frontend.

**Frozen artifacts:** API contract ([api.md](../api.md) §6), database at 22 migrations
(§10), backend privilege model (§4), security posture (§11), release gate (§12).

**Pre-sales gates — required before the first real payment, do not block frontend work:**

1. Create sandbox + production Supabase projects; `db push` (22 migrations); deploy functions;
   set secrets; verify Vault + cron.
2. Re-run the §4 probe matrix against the hosted project (anon 401 / authenticated 403 /
   service_role 200; GraphQL 406).
3. Execute Wompi Sandbox Tests 1–5 (§5) on the sandbox project.
4. One controlled live Resend send (§6) with message-id and idempotency verification.
5. Google Sheets live test + failure drill (§7) with a dedicated spreadsheet.
6. Production Wompi credentials, production webhook URL and `WOMPI_REDIRECT_URL`.
7. Operator accounts created (Auth + `operators` rows).
8. Business decisions needed for pricing/data (§13) loaded as data; consent text approved.

**BACKEND FROZEN**
