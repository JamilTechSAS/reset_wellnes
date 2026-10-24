# Reset Wellness purchase backend

Backend for a one-time event in Colombia: order creation, ePayco (COP) payments, participant
assignment, check-in, and a read-only operational export for the client. Tickets and QR codes
are discontinued: a paid order is the confirmation, and its participants are the admissions.

**Status: ePayco-only, no-ticket purchase flow implemented and integrated with the frontend.**
The canonical event code is `RESET-SUNSET-2026` and the production bundle targets
`https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1`. The backend can price a request from
database state, reserve inventory atomically, create the order transactionally, open an ePayco
Smart Checkout session, confirm a verified payment through the ePayco webhook (and recover lost
webhooks through reconciliation or the buyer's payment hint), attach the second person of a
two-admission purchase as a participant, serve the public event API, authenticate real operators
(Supabase Auth) and check people in at the door, enforce PostgreSQL rate limits, and project each
participant to the client's read-only Google Sheet on a schedule. `GET /orders/{reference}` reports
the order's admissions and a names-only participant roster, so the confirmation survives a refresh
without tickets.

Tickets, QR codes, ticket tokens, ticket lookup and ticket-based purchase emails are gone from the
buyer journey; the legacy tables and `webhooks-wompi` remain only for historical data and are not
part of the active flow. **The Spanish buyer frontend is built** — the client's landing page wired
to these APIs by the purchase flow (see [docs/frontend.md](docs/frontend.md)) — as a thin client
that never talks to PostgreSQL, PostgREST or GraphQL directly, carrying the **real client content**
(branding, prices, dates, contact, legal documents) with everything the client has not supplied
rendered as "por confirmar" instead of being invented.

**Not verified live:** no ePayco sandbox payment, email delivery or Google Sheets write has been
executed from this repository (no credentials), and the hosted project answers `500` until an
operator sets its secrets. See [docs/phases/phase-06d.md](docs/phases/phase-06d.md),
[docs/phases/phase-06d1.md](docs/phases/phase-06d1.md) and the earlier phase reports for what was
verified in each step.

---

## Source of truth

| Concern                                  | Owner                                                     |
| ---------------------------------------- | --------------------------------------------------------- |
| Orders, payments, participants, check-in | Supabase PostgreSQL **plus** backend logic                |
| Whether a payment really happened        | **ePayco**, verified server-side via webhook + validation |
| Price of an admission                    | Backend calculation from database configuration           |
| Client-facing operational view           | Google Sheets, **read-only** export (never authoritative) |

The browser is never trusted for price, payment state or admission validity. Reaching a
"success" URL proves nothing: only a verified ePayco event (or a server-side validation
lookup) can mark an order as paid. There is no ticket to validate at the door — the
participant roster of a PAID order is the admission list.

## Stack

- **Runtime / API**: Supabase Edge Functions (Deno 2), TypeScript, strict.
- **Database**: Supabase PostgreSQL 17 with SQL migrations.
- **Payments**: ePayco Colombia (Smart Checkout V2 + confirmation webhooks).
- **Email**: Resend (transactional; operational notifications — no ticket delivery).
- **Operational export**: Google Sheets, read-only.
- **Tooling**: Node 24+, Vitest, ESLint (typed), Prettier, Supabase CLI, Deno.
- **Money**: integer **centavos** (1/100 COP). Floating point is never used for money.

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
│       │   ├── domain/          # money, pricing, orders, payments, confirmation, reconciliation, participants, check-in, consents, operators, rate limits, sheets
│       │   ├── integrations/    # vendor-specific code (epayco/, wompi/ legacy, resend/, google/), isolated from the core
│       │   ├── db/              # Supabase client factory + typed gateways + generated Database types
│       │   ├── http/            # response envelope, CORS, Spanish errors, body/client-IP helpers
│       │   └── logging/         # structured JSON logging with PII/secret redaction
│       ├── deno.json            # dependency mapping for `deno check` (local dev)
│       ├── health/              # deploy smoke test (public, exposes nothing sensitive)
│       ├── events/              # public event + availability
│       ├── tickets/             # legacy public ticket lookup (tickets are discontinued)
│       ├── checkin/             # operator check-in + admission lookup (Supabase Auth)
│       ├── orders/              # create, quote, buyer status, retry, payment hint, participants
│       ├── webhooks-epayco/     # the only endpoint that can mark an order paid
│       └── orders-maintenance/  # expiry + email + reconciliation + cleanup + Sheets (bearer token)
├── tests/                       # Vitest: domain, integrations, config, schema, tooling
├── scripts/                     # verification scripts (Deno typecheck)
└── docs/                        # architecture, data model, API, environments…
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
  `reference`, with automatic redaction of secrets and personal data.

## Documentation

| Document                                                             | Contents                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)                         | Layers, flows, state machines, testing strategy                                                  |
| [docs/data-model.md](docs/data-model.md)                             | Implemented schema, constraints, identifiers, RLS, open decisions                                |
| [docs/wompi-integration.md](docs/wompi-integration.md)               | Legacy Wompi behaviour (historical provider, retired for this event)                             |
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
