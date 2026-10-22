# Phase 1 report — repository and infrastructure foundation

Date: 2026-10-03 · Scope: **Phase 1 only** (no frontend, no live payments, no invented business
rules).

## 1. Objective and outcome

**Objective:** establish a clean, production-oriented backend foundation for a one-time event
ticketing system in Colombia, with payments (Wompi), email (Resend), Supabase PostgreSQL and a
read-only Google Sheets operational view — and with the current Wompi integration requirements
verified from official documentation before writing payment code.

**Outcome: complete.** Every item in the Phase 1 definition of done is implemented and verified by
an executable check (tests, type checks or a live function run). Nothing is claimed that was not
executed. The two things that could not be executed in this environment (a Docker-dependent local
Supabase stack, and any real Wompi call) are listed explicitly in §6.

## 2. What was found

| Finding      | Detail                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Repository   | Empty directory (`Tatiana/`), only a `.freebuff/project-id` marker. **No git repository**, no code, no configuration   |
| Node / npm   | Node 24.21.0, npm 11.19.0                                                                                              |
| Supabase CLI | Not installed → added as a dev dependency (`supabase` 2.119.0)                                                         |
| Deno         | Not installed → added as a dev dependency (`deno` 2.9.6), used for Edge Function type checking                         |
| Docker       | Installed but **the daemon is not running** → no local Supabase stack, no `supabase db reset`, no PostgREST/RLS checks |
| Platform     | Windows + Git Bash → all npm scripts are cross-platform (no shell globs, no POSIX-only tools)                          |

## 3. What was created

**67 project files** (excluding `node_modules`, lockfiles, tool state and generated artifacts);
~5 900 lines of TypeScript, SQL, tests and configuration.

### Repository foundation

`.gitignore` (secrets, local Supabase state, Deno locks), `package.json` (verified script set),
`tsconfig.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`),
`eslint.config.js` (typed rules, Deno-aware for entrypoints), `.prettierrc.json` +
`.prettierignore`, `vitest.config.ts`, `.env.example` (every variable documented, placeholders only),
`.vscode/` (Deno limited to `supabase/functions`), `git init -b main`.

### Portable backend core — `supabase/functions/_shared/`

Written to be runtime-agnostic (no Deno APIs, no Node APIs) so the exact modules that run in Edge
Functions are the ones the unit tests exercise.

| Area          | Files                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration | `config/env.ts` — validated environment model, environment↔credential prefix binding, publishable-key rejection, log-safe projection                                                |
| Domain        | `money.ts`, `reference.ts`, `order-state.ts`, `payment-status.ts`, `tickets.ts`, `ticket-token.ts`, `checkin.ts`, `consents.ts`, `participant.ts`, `email-delivery.ts`, `errors.ts` |
| Wompi         | `integrations/wompi/{types,signature,events,client}.ts` — integrity signature, event checksum verification, status mapping, private-key transaction client                          |
| Persistence   | `db/client.ts` — service-role client factory (server-side only, sessions disabled)                                                                                                  |
| Transport     | `http/json.ts` — response envelope, status mapping, Spanish user messages, CORS                                                                                                     |
| Observability | `logging/{levels,logger}.ts` — one JSON line per event, structural redaction, masking                                                                                               |
| Deno config   | `_shared/deno.json` — pinned `npm:` mappings for local `deno check`                                                                                                                 |

### Supabase structure

`supabase/config.toml` (project id, per-function JWT policy: `health` public, future webhook/public
functions documented), `supabase/migrations/20261003202241_init.sql` (extensions/staging schema,
`app_private`, `updated_at` trigger, guarded role revokes), `…_domain_status_enums.sql` (four status
enums mirrored by TypeScript), `supabase/seed.sql` (**deliberately empty**: no invented prices),
`supabase/functions/health/` (deploy smoke test + its own `deno.json`).

### Tests — `tests/` (18 files, 137 tests)

Domain (money, references, order/payment states, tokens, check-in, participants, consents, email),
Wompi (official signature vector, event verification incl. tampering and replay paths, HTTP client),
configuration, HTTP contract, logging redaction, schema (migrations applied to a real Postgres),
and tooling guardrails (dependency parity, `.env.example` coverage, repository secret hygiene).

### Documentation — `docs/`

`architecture.md`, `data-model.md` (Phase 2 target schema), `wompi-integration.md` (verified facts
with source URLs), `api.md`, `environments.md`, `security.md`, `operations-google-sheets.md`,
`testing.md`, and this report.

## 4. Verification log

| Command                                                    | Result                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`                                              | ok (runtime: `zod` 4.6.5, `@supabase/supabase-js` 2.117.2; dev: TypeScript 6.0.3, ESLint 10, Vitest 5.0.3, Deno 2.9.6, Supabase CLI 2.119.0, PGlite)                                                                |
| `npx tsc --noEmit`                                         | **0 errors** (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)                                                                                                                                     |
| `npm test` (`vitest run`)                                  | **18 files, 137 tests passed**                                                                                                                                                                                      |
| `npx eslint .`                                             | **0 problems** (type-aware rules; Deno entrypoints handled explicitly)                                                                                                                                              |
| `npx prettier --check .`                                   | **clean**                                                                                                                                                                                                           |
| `npm run functions:check` (real Deno)                      | **deno check ok: 1 function entrypoint, 20 shared files**                                                                                                                                                           |
| `npm run check` (full pipeline)                            | **exit 0**                                                                                                                                                                                                          |
| Migrations applied to a real Postgres (PGlite, in-process) | both migrations applied; enum labels match the TypeScript state machines exactly; `app_private.set_updated_at()` proven to stamp `updated_at` on update; `public` still contains no domain tables (Phase 2)         |
| Live Edge Function run (`deno run` + `curl`)               | **HTTP 200** `{"ok":true,"data":{…,"environment":"development","wompiEnvironment":"sandbox","checks":{"configuration":"ok","database":"not-checked"}}}` plus a structured JSON log line                             |
| Same function with mismatched credentials                  | **HTTP 500** with the generic Spanish message and `details.issues` naming `WOMPI_PUBLIC_KEY` / `WOMPI_PRIVATE_KEY` and explaining the prefix rule — **the supplied values never appear in the response or the log** |

Wompi verification used primary sources, not memory:

- Integrity signature reproduced against the **value published in Wompi's documentation**
  (`…37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5`), plus a cross-check against
  an independent SHA-256 implementation for the `expiration-time` variant.
- Event checksums verified with fixtures signed by an independent SHA-256 implementation, including
  property reordering, `sent_at` noise, header-only checksums, tampering, unknown event names and
  prototype-pollution attempts.
- Client behaviour tested against documented status codes (401/404/422/5xx), retry policy and
  fail-closed parsing of unexpected payloads.

Full gate: nothing is committed yet (no commit was requested); `git status` shows the new tree as
untracked, with secrets excluded by `.gitignore` and by an automated scan.

## 5. Important technical decisions

1. **Portable core inside `supabase/functions/_shared/`.** The Supabase deployer only bundles files
   inside a function's directory, so shared code must live there. Layering inside it (domain,
   config, integrations, http, logging, db) is enforced by a rule the tests rely on: no Deno/Node
   APIs in the core, so production code and tests are literally the same modules. A `src/`-outside
   layout would require a bundling step and would risk drift between what is tested and what runs.
2. **Database is the source of truth; the browser never is.** Price calculation, state changes and
   ticket issuance will live in SQL/Edge Functions. The return URL is explicitly not a payment
   signal (Wompi documents this; public-key transaction queries now return 404).
3. **Money as branded integer centavos** (`CopCents`), matching Wompi's `amount_in_cents`
   one-to-one. Floats cannot reach a payment, and mix-ups between pesos and centavos fail at
   compile time.
4. **Wompi references per payment attempt.** Attempt 1 reuses the order reference
   (`EVT-2026-000001`); later attempts append `-2`, `-3`… because Wompi documents that a used
   reference can never be reused — a retry after a decline needs a fresh one without losing
   traceability.
5. **States separated and forward-only.** Order and payment states are different concerns;
   `EXPIRED` was added to the initial four states (reservations must be reclaimable), `REFUNDED` was
   deliberately **not** implemented (no half-built refund flow). Terminal payment states never
   regress, and an unknown Wompi status maps to `unknown`, which is never treated as success.
6. **Idempotency by construction.** A `payment_events` table with a unique dedupe key (an addition
   to the initial entity list, justified by the retry behaviour), unique constraints for a single
   approved payment per order, one attendance row per ticket, and unique email idempotency keys.
7. **Credentials are environment-bound.** `APP_ENV` decides the Wompi environment; credential
   prefixes are validated against it, and a production base URL cannot be overridden. Supabase's
   key migration is handled: `sb_secret_*` preferred, legacy `service_role` JWT accepted,
   publishable/anon keys rejected — legacy keys are deprecated by the end of 2026.
8. **Config errors name variables, never values.** Verified live: the 500 response lists variable
   names and the rule that failed, and contains no credential material.
9. **Language split.** Identifiers, docs, logs and error codes in English; every user-facing string
   (messages, labels, email subjects, Sheets columns) in Spanish.
10. **Migration verification without Docker.** PGlite (Postgres compiled to WASM) applies the real
    migration files inside `npm test`, so "migrations are ready" is verified rather than asserted.
    The Docker-based local stack remains the final confirmation step, because it also covers
    Supabase-specific roles and PostgREST exposure.
11. **Deno type checking is explicit about configuration.** Deno's config auto-discovery resolves
    from the current directory and silently adopted the Node-side `tsconfig.json`, which removed the
    Deno globals (bogus "Cannot find name 'console'"). The check script therefore passes `--config`
    per target, mirroring how the deployer resolves each function's `deno.json`. This is documented
    in `docs/testing.md` and in the script itself so it is not rediscovered later.
12. **No invented business data.** No price, quantity, discount rule, reservation window or event
    copy exists anywhere in the codebase. `seed.sql` is intentionally empty and the open decisions
    are tracked in `docs/data-model.md` §6 and `docs/wompi-integration.md` §10.

## 6. Known limitations (nothing hidden)

| Limitation                         | Why                                                                                     | Impact                                                                                          | Closed by                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Local Supabase stack never started | Docker daemon not running in this environment                                           | `supabase db reset`, Studio, PostgREST/RLS behaviour and `db diff` are unverified here          | First Docker-enabled machine: `npm run db:start && npm run db:reset` |
| No live Wompi call                 | No credentials exist yet                                                                | Crypto and HTTP behaviour are verified against documented vectors/fixtures only                 | Phase 5 (sandbox)                                                    |
| Postgres version skew              | PGlite ships Postgres 18, Supabase local 17                                             | Only stable DDL is involved (`create schema/type/function/trigger`); no version-specific syntax | `npm run db:reset` confirmation                                      |
| No domain tables yet               | Phase 2 work, and creating them before pricing/discount decisions would force a rewrite | Nothing persists business data yet                                                              | Phase 2                                                              |
| End-to-end HTTP tests              | Only `health` exists as a function                                                      | Request-level wiring is untested beyond that one function                                       | Phase 11                                                             |
| Google Sheets sync not implemented | Phase 10, design only                                                                   | Client has no view yet                                                                          | Phase 10                                                             |

## 7. Remaining questions for the client

Product/data decisions (blocking Phase 3–4): number of sales stages, quantities and prices per
stage; existence of quantity discounts and their breakpoints; which discount codes exist and their
rules; duplicate-registration policy for a cédula; whether a separate "buyer" block is required;
reservation window length; whether participants may edit their data after payment; manual check-in
fallback policy; the exact legal wording + version of both consents; any extra participant fields.

Wompi/account decisions (blocking Phase 5–6): which account will be used and whether Web Checkout is
enabled; which payment methods to enable (`PSE`/`Nequi`/Bancolombia transfer introduce delayed
approval, which changes reservation and email semantics); whether `expiration-time` should be used;
whether refunds will ever be needed.

Operational decisions: who receives the Google Sheets export and how it is shared; retention policy
for participant data (draft in `docs/data-model.md` §5).

## 8. What Phase 2 will do

Deliverable: **the database schema and its verification**, still with no business rules invented.

1. Tables exactly as specified in `docs/data-model.md` §2 (events, ticket_types, pricing_tiers,
   discount_codes + redemptions, orders, order_items, participants, tickets, payments,
   payment_events, attendance, consents, email_deliveries) with keys, foreign keys, unique/check
   constraints, indexes, RLS enabled with no policies, and `updated_at` triggers.
2. `order_reference_seq` and the reference format from `docs/data-model.md` §3.
3. `operational_export` view (read-only, Spanish columns) for Phase 10.
4. Generated `database.types.ts` + typed client, with the untyped escape hatch in `db/client.ts`
   removed.
5. Schema tests extended: constraints under concurrency, RLS behaviour (with Docker), enum parity
   maintained, and one test per constraint that protects money or inventory.
6. Everything re-verified with `npm run check` and `npm run db:reset` on a Docker-enabled machine.

Phase 2 does **not** need the Wompi account, but it does need the pricing/discount answers above
before Phase 3 can compute a price — the schema can absorb the structure either way.
