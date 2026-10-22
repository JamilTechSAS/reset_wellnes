# Event ticketing backend

Backend for a one-time event in Colombia: order creation, Wompi (COP) payments, ticket and
QR issuance, check-in, confirmation email, and a read-only operational export for the client.

**Status: Phase 6D (frontend wired to the hosted Supabase project) done — PASS WITH CONDITIONS.**
The production bundle now targets `https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1`, the real
buyer journey (event → quote → order → Wompi handoff) has been executed against the frozen backend
with the client's event data, and the canonical event code is `RESET-SUNSET-2026`. The hosted
project itself answers `500` on every endpoint until an operator sets its secrets — none are
configured yet — so the hosted purchase flow is **not** live
([docs/phases/phase-06d.md](docs/phases/phase-06d.md)). **Phase 6D.1 fixed the two backend issues
that integration exposed**: the server-side Supabase key now comes from the platform's
`SUPABASE_SECRET_KEYS` bag (a hosted project cannot define a `SUPABASE_`-prefixed secret), and an
idempotent `POST /orders` replay returns the same payload as a fresh order instead of answering
`500` ([docs/phases/phase-06d1.md](docs/phases/phase-06d1.md)). Phase 6C (real client content for Reset
Wellness Club — Re set Sunset Vol. 1) done. The backend can price
a request from database state, reserve inventory atomically, create the order transactionally, return a signed
Wompi checkout configuration, confirm a verified payment through `POST /webhooks/wompi` (and
recover lost webhooks via reconciliation or the buyer's payment hint), issue exactly-once
tickets, deliver confirmation emails through the database outbox, assign participants, serve
public event/ticket APIs, authenticate real operators (Supabase Auth) and check people in at the
door, enforce PostgreSQL rate limits, and project everything to the client's read-only Google
Sheet on a schedule. **The Spanish buyer frontend is built** — the Phase 6A landing page wired to
these APIs by the Phase 6B purchase flow (see [docs/frontend.md](docs/frontend.md)) — as a thin
client that never talks to PostgreSQL, PostgREST or GraphQL directly, and as of Phase 6C it carries
the **real client content** (branding, prices, dates, contact, legal documents) with everything the
client has not supplied rendered as "por confirmar" instead of being invented. No live
Wompi/email/Google call has been made yet (no credentials) — see
[docs/phases/phase-06c.md](docs/phases/phase-06c.md),
[docs/phases/phase-06b.md](docs/phases/phase-06b.md),
[docs/phases/phase-05.md](docs/phases/phase-05.md) and the earlier phase reports for exactly what
exists, what is verified, and what is still pending.

---

## Source of truth

| Concern                               | Owner                                                     |
| ------------------------------------- | --------------------------------------------------------- |
| Orders, payments, tickets, attendance | Supabase PostgreSQL **plus** backend logic                |
| Whether a payment really happened     | **Wompi**, verified server-side via events + private API  |
| Price of a ticket                     | Backend calculation from database configuration           |
| Client-facing operational view        | Google Sheets, **read-only** export (never authoritative) |

The browser is never trusted for price, payment state or ticket validity. Reaching a
"success" URL proves nothing: only a verified Wompi event (or a server-side transaction
lookup) can mark an order as paid.

## Stack

- **Runtime / API**: Supabase Edge Functions (Deno 2), TypeScript, strict.
- **Database**: Supabase PostgreSQL 17 with SQL migrations.
- **Payments**: Wompi Colombia (Widget / Web Checkout + `transaction.updated` webhooks).
- **Email**: Resend (transactional; QR ticket confirmation).
- **Operational export**: Google Sheets, read-only.
- **Tooling**: Node 24+, Vitest, ESLint (typed), Prettier, Supabase CLI, Deno.
- **Money**: integer **centavos** (1/100 COP), matching Wompi's `amount_in_cents`. Floating
  point is never used for money.

## Quick start

```bash
npm install                 # also installs the Supabase CLI and Deno locally
cp .env.example .env.local  # then fill in the values (never commit this file)

npm run check               # typecheck + lint + format + deno check + tests
npm run functions:check     # deno check on the Edge Functions (runtime-accurate typing)
```

Local database (requires a **running Docker daemon**):

```bash
npm run db:start            # starts the local Supabase stack
npm run db:reset            # applies supabase/migrations + supabase/seed.sql
npm run types:generate      # regenerates database.types.ts from the live schema
npm run db:stop
```

> On machines where the local stack cannot start (reserved Windows TCP port ranges), point the
> CLI at a database that has the migrations applied instead; the exact command is in
> [docs/phases/phase-02.md](docs/phases/phase-02.md).

Running an Edge Function locally:

```bash
npm run functions:serve     # serves every function with .env.local
curl http://127.0.0.1:54321/functions/v1/health
```

> The `health` function is the deploy smoke test: it validates the whole environment and
> reports missing variable **names** (never values) outside production.

## Repository layout

```
├── supabase/
│   ├── config.toml              # local stack + per-function Edge Function policies
│   ├── migrations/              # ordered, immutable SQL migrations
│   ├── seed.sql                 # local seed (no business data invented — see file header)
│   └── functions/
│       ├── _shared/             # portable backend core: deployable, runtime-agnostic
│       │   ├── config/          # environment loading + validation
│       │   ├── api/             # handlers: quote, orders, participants, hint, public, check-in, reconciliation, sheets, maintenance
│       │   ├── domain/          # money, pricing, orders, payments, confirmation, reconciliation, tickets, check-in, consents, operators, rate limits, sheets
│       │   ├── integrations/    # vendor-specific code (wompi/, resend/, google/), isolated from the core
│       │   ├── db/              # Supabase client factory + typed gateways + generated Database types
│       │   ├── http/            # response envelope, CORS, Spanish errors, body/client-IP helpers
│       │   └── logging/         # structured JSON logging with PII/secret redaction
│       ├── deno.json            # dependency mapping for `deno check` (local dev)
│       ├── health/              # deploy smoke test (public, exposes nothing sensitive)
│       ├── events/              # public event + availability
│       ├── tickets/             # public ticket lookup by opaque token
│       ├── checkin/             # operator check-in + admission lookup (Supabase Auth)
│       ├── orders/              # create, quote, buyer status, retry, payment hint, participants
│       ├── webhooks-wompi/      # the only endpoint that can mark an order paid
│       └── orders-maintenance/  # expiry + email + reconciliation + cleanup + Sheets (bearer token)
├── tests/                       # Vitest: domain, integrations, config, schema, tooling
├── scripts/                     # verification scripts (Deno typecheck)
└── docs/                        # architecture, data model, Wompi, API, environments…
```

**Why the core lives inside `supabase/functions/_shared/`:** the Supabase deployer bundles
only files inside a function's own directory, so cross-function code must live under
`supabase/functions/`. Everything in `_shared` is written to be runtime-agnostic (no Deno or
Node APIs), which is what lets the same modules run in Edge Functions **and** in fast Node
unit tests.

## Commands

| Command                    | What it does                                                               |
| -------------------------- | -------------------------------------------------------------------------- |
| `npm run check`            | Full verification pipeline (typecheck, lint, format, deno check, tests)    |
| `npm run typecheck`        | `tsc --noEmit` over the core, tests and scripts                            |
| `npm run lint`             | ESLint with type-aware rules                                               |
| `npm run format`           | Prettier                                                                   |
| `npm test`                 | Vitest (fast, no network, includes migration + enum parity checks)         |
| `npm run functions:check`  | `deno check` per function, using each function's own `deno.json`           |
| `npm run db:*`             | Local Supabase stack, migrations, schema diff                              |
| `npm run types:generate`   | Regenerates database types from the local stack (or a `--db-url` database) |
| `npm run functions:deploy` | Deploys Edge Functions                                                     |

## Conventions

- **Language**: identifiers, comments, docs and commit messages in English; everything the
  end user reads (emails, errors, Sheets columns) in Spanish.
- **Money**: `CopCents` (branded integer). Never floats, never `number` for pesos.
- **Migrations**: `<YYYYMMDDHHMMSS>_snake_case.sql`, append-only once applied. Status enums
  are mirrored between SQL and TypeScript, and `npm test` fails if they drift.
- **Config**: one validated module (`_shared/config/env.ts`); credentials are bound to an
  environment by prefix, so sandbox keys cannot be loaded by a production deployment.
- **Secrets**: `.env.local` locally, Supabase secrets in hosted environments. Nothing
  credential-shaped may be committed — an automated test scans the repository for it.
- **Logging**: one JSON line per event, traceable by `orderId` / `paymentId` /
  `wompiReference` / `ticketId`, with automatic redaction of secrets and personal data.

## Documentation

| Document                                                             | Contents                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)                         | Layers, flows, state machines, testing strategy                                                  |
| [docs/data-model.md](docs/data-model.md)                             | Implemented schema, constraints, identifiers, RLS, open decisions                                |
| [docs/wompi-integration.md](docs/wompi-integration.md)               | Verified Wompi behaviour + payment flow                                                          |
| [docs/api.md](docs/api.md)                                           | Implemented endpoint contracts and error codes                                                   |
| [docs/environments.md](docs/environments.md)                         | dev/sandbox/prod, secrets inventory, runbook                                                     |
| [docs/security.md](docs/security.md)                                 | Threat model, PII handling, review checklist                                                     |
| [docs/operations-google-sheets.md](docs/operations-google-sheets.md) | Read-only operational export                                                                     |
| [docs/testing.md](docs/testing.md)                                   | Test strategy and how to run everything                                                          |
| [docs/phases/phase-01.md](docs/phases/phase-01.md)                   | Phase 1 report: done, verified, risks, next steps                                                |
| [docs/phases/phase-02.md](docs/phases/phase-02.md)                   | Phase 2 report: schema, verification, limitations                                                |
| [docs/phases/phase-03.md](docs/phases/phase-03.md)                   | Phase 3 report: pricing, orders, races, limitations                                              |
| [docs/phases/phase-04.md](docs/phases/phase-04.md)                   | Phase 4 report: webhook, confirmations, tickets, outbox, races                                   |
| [docs/phases/phase-05.md](docs/phases/phase-05.md)                   | Phase 5 report: reconciliation, check-in, public APIs, Sheets, scheduler, security review, races |
| [docs/phases/phase-06a.md](docs/phases/phase-06a.md)                 | Phase 6A report: landing page, design system, accessibility, SEO                                 |
| [docs/phases/phase-06b.md](docs/phases/phase-06b.md)                 | Phase 6B report: purchase flow over the frozen backend, browser QA                               |
| [docs/phases/phase-06c.md](docs/phases/phase-06c.md)                 | Phase 6C report: real client content, visual integration, pending client data                    |
| [docs/phases/phase-06d.md](docs/phases/phase-06d.md)                 | Phase 6D report: hosted wiring, recorded endpoint responses, replay defect, local end-to-end run |
| [docs/phases/phase-06d1.md](docs/phases/phase-06d1.md)               | Phase 6D.1 report: platform key resolution, idempotency replay fix, migration, redeploy          |
