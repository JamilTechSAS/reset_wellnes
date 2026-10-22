# Phase 2 report — PostgreSQL schema

Date: 2026-10-03 · Scope: **Phase 2 only** (backend/database; no frontend, no invented business
values, no changes to the Phase 1 foundation beyond what the schema required).

## 1. Objective and outcome

**Objective:** turn the conceptual data model into the authoritative PostgreSQL schema for
events, ticket types, sales stages, discount codes, orders, order items, participants, tickets,
payments, payment events, attendance, consents and email deliveries — with the constraints,
indexes, RLS posture, operational export view, generated types, tests and documentation that
make it trustworthy.

**Outcome: complete.** Nine migrations create 15 tables, 8 enums, 3 helper functions, 1 sequence
and 1 view. Everything was applied to a **real PostgreSQL 17** instance and to PGlite, the
critical rejections were verified behaviorally, and the two race-sensitive guarantees (double
check-in, oversell) were verified with **two parallel PostgreSQL sessions**. `npm run check` is
green: typecheck, ESLint, Prettier, `deno check` and **159 tests** (27 of them schema tests).

No price, quantity, date, discount value or consent wording was invented: every table ships
empty, and the open business decisions are listed in
[data-model.md](../data-model.md#8-open-decisions-not-encoded-in-the-schema).

## 2. Migration files

| Migration                                          | Contents                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `20261003202241_init.sql` (Phase 1)                | schemas, `set_updated_at()`, role hygiene                                                                          |
| `20261003202242_domain_status_enums.sql` (Phase 1) | `order_status`, `payment_status`, `ticket_status`, `email_delivery_status`                                         |
| `20261003210001_catalog.sql`                       | `event_status`, `discount_kind`; `events`, `ticket_types`, `pricing_tiers`, `quantity_discounts`, `discount_codes` |
| `20261003210002_orders.sql`                        | `order_reference_seq`, `next_order_reference()`, `orders`, `order_items`, `discount_redemptions`                   |
| `20261003210003_participants_tickets.sql`          | `participants`, `tickets`                                                                                          |
| `20261003210004_payments.sql`                      | `payment_event_result`; `payments`, `payment_events`                                                               |
| `20261003210005_attendance_consents.sql`           | `consent_kind`; `attendance`, `consents`, append-only guard `reject_update()`                                      |
| `20261003210006_email_deliveries.sql`              | `email_deliveries`                                                                                                 |
| `20261003210007_rls_and_operational_export.sql`    | RLS on all tables, privilege hardening, `operational_export` view                                                  |

Historical migrations were not edited. New migrations are append-only and follow the existing
`<YYYYMMDDHHMMSS>_snake_case.sql` convention.

## 3. Tables created

| Table                  | Purpose                                                        | Key guarantees                                                                        |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `events`               | Reusable event definition, COP-only                            | unique `code`; capacity/window checks; `updated_at` trigger                           |
| `ticket_types`         | Kind of admission; per-order limits as configuration           | unique `(event_id, code)`; `max_per_order >= min_per_order`                           |
| `pricing_tiers`        | Sales stages: price, window, quantity, inventory counters      | unique `(ticket_type_id, sequence)`; `reserved + sold <= quantity_limit`              |
| `quantity_discounts`   | Optional quantity-based discount structure (ships empty)       | `min_quantity >= 2`; `percent_bps` 1…10000; unique per breakpoint                     |
| `discount_codes`       | Percentage or fixed-amount codes with limits and window        | shape check per kind; unique `(event_id, code)`; redemption limit check               |
| `orders`               | Purchase intent: buyer, money breakdown, reservation, status   | `subtotal - quantity_discount - discount_code = total`; `paid_at` only when `PAID`    |
| `order_items`          | Lines with frozen prices and catalog snapshots                 | `quantity > 0`; line-total check; unique `(order, ticket type, stage)`                |
| `discount_redemptions` | Append-only usage ledger                                       | unique `(code, order)`; UPDATE rejected by trigger                                    |
| `participants`         | One row per ticketed person (normalized data + `extra_fields`) | format checks; duplicate cédula deliberately **not** constrained yet                  |
| `tickets`              | One admission; opaque token is the QR payload                  | token format + unique; `participant_id` unique; price `>= 0`                          |
| `payments`             | Payment attempts reconciled with Wompi                         | unique reference/transaction; **one approved payment per order** (partial unique idx) |
| `payment_events`       | Webhook ledger and idempotency gate                            | unique `dedupe_key`; nullable result = "received, not finished"                       |
| `attendance`           | Check-in fact, immutable by design                             | **unique `ticket_id`** (no double check-in); operator required                        |
| `consents`             | Append-only consent history (Ley 1581)                         | `consent_kind` enum; UPDATE rejected; latest row per kind is effective                |
| `email_deliveries`     | Idempotent email bookkeeping                                   | unique + derived `idempotency_key`; retry index                                       |

Two supporting tables were added, both already planned in the Phase 1 data model:
`quantity_discounts` (the brief requires quantity-discount support) and `discount_redemptions`
(auditable usage accounting, referenced by the documented model). The export view is not a table.

## 4. Schema decisions recorded in the migrations

1. **Money** uses `bigint` centavos with a shared `*_cents` convention (1:1 with Wompi's
   `amount_in_cents`); never `numeric`/`float`. The brief's example name `amount_in_cents` was
   not adopted (documented in [data-model.md](../data-model.md#7-conflicts-resolved-against-the-brief-phase-1-kept-as-source-of-truth)).
2. **Identifiers**: internal `uuid`; order reference `EVT-<year>-<sequence>` from a sequence;
   ticket token `TKT_` + 100 bits of Crockford base32; per-attempt Wompi references. No
   identifier leaks personal data or is guessable.
3. **Buyer ≠ participant**: buyer contact lives on `orders`, each ticket gets its own participant
   row, so one buyer can purchase several tickets.
4. **Ticket states**: `ACTIVE | CANCELLED | REFUNDED` (Phase 1) with `attendance` as the "used"
   fact; consent kinds `DATA_PROCESSING | FUTURE_EVENTS`. Both mappings are documented.
5. **History is immutable where it must be**: catalog FKs use `restrict`, prices are snapshotted,
   consents and redemptions reject UPDATEs.
6. **Reservation model**: `PENDING` orders hold counters (`quantity_reserved`), released by the
   expiry job; the atomic conditional `update` is documented in the migration.

## 5. Security model

- **RLS on all 15 tables, zero policies.** Any role that does not bypass RLS reads and writes
  nothing. The backend uses the secret key (service-role semantics).
- **Privileges revoked**: `anon` and `authenticated` lose every table/sequence privilege, and
  their _default_ privileges are revoked so future tables also start unreadable. Verified both
  on real PostgreSQL and in the simulated-role test.
- **Export view** (`operational_export`) is `security_invoker = true`, so an accidental grant to a
  role without base-table rights fails closed. Only `service_role` can read it.
- **Append-only evidence**: a trigger rejects UPDATEs on `consents` and `discount_redemptions`;
  withdrawal/amendments are new rows.
- **Raw provider payloads** (`payments.provider_payload`) may contain the customer's email: never
  logged, never exposed, first candidate for short retention.

## 6. Verification log

All commands were executed in this environment on 2026-10-03.

| #   | What                                                | How                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | All 9 migrations apply to **real PostgreSQL 17.11** | Docker container `pg-tatiana` (postgres:17, port 15432), fresh DB `tatiana_verify`, all files applied in one session with `ON_ERROR_STOP=1`     | Exit 0, no errors                                                                                                                                                                                                                                                                                                                                                          |
| 2   | Structural inventory                                | `pg_tables`, `pg_type`/`pg_enum`, `pg_class`, `pg_policies`                                                                                     | 15 tables, 8 enums, 15/15 RLS enabled, 0 policies                                                                                                                                                                                                                                                                                                                          |
| 3   | Privilege hardening                                 | `has_table_privilege` / `has_sequence_privilege` for `anon`, `authenticated`, `service_role`; new-table probe                                   | No privileges for browser roles (incl. view and sequence); `service_role` can read the view; new tables start without grants                                                                                                                                                                                                                                               |
| 4   | Full happy path through every entity                | Event → ticket type → stage → order → item → participant → ticket → consents → payment → webhook event → attendance → email → order marked PAID | All inserts accepted; order/item/payment arithmetic consistent                                                                                                                                                                                                                                                                                                             |     | 5   | `operational_export` content | `select` of the view columns for the fixture ticket (23 of the 25 columns; the other two are direct projections of the consent timestamp and ticket creation timestamp) | One correct row with Spanish columns, latest consent/payment resolution working |
| 6   | 16 critical rejections                              | `do $$ … exception …` blocks asserting the exact SQLSTATE per case                                                                              | All rejected: duplicate attendance, second approved payment, duplicate Wompi reference, duplicate transaction id, duplicate webhook event, duplicate email key, invalid consent kind, consent UPDATE, discount shape mismatch, `paid_at` on non-PAID order, negative money, total mismatch, zero quantity, invalid national id, oversell, `approved_at` on pending payment |
| 7   | **Double check-in race** (two parallel sessions)    | Session A inserts attendance and holds the transaction 3 s; session B inserts the same ticket concurrently                                      | B rejected with `attendance_ticket_id_key` unique violation; exactly **1** attendance row                                                                                                                                                                                                                                                                                  |
| 8   | **Oversell race** (two parallel sessions)           | Stage with `quantity_limit = 1`; both sessions run the conditional reservation UPDATE                                                           | A reserved (counter 1), B matched **0 rows**; counter stayed 1                                                                                                                                                                                                                                                                                                             |
| 9   | `npm run typecheck`                                 | `tsc --noEmit` (with the generated `Database` type wired into the client)                                                                       | 0 errors                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | `npm run lint`                                      | ESLint typed config                                                                                                                             | 0 errors                                                                                                                                                                                                                                                                                                                                                                   |
| 11  | `npm run format:check`                              | Prettier (generated types file excluded by design)                                                                                              | Clean                                                                                                                                                                                                                                                                                                                                                                      |
| 12  | `npm run functions:check`                           | `deno check` per function with its own `deno.json`                                                                                              | 1 function + 20 shared files, ok                                                                                                                                                                                                                                                                                                                                           |
| 13  | `npm run test`                                      | Vitest: domain, integrations, config, HTTP, logging, tooling, schema                                                                            | **20 files, 159 tests passed** (schema: 27)                                                                                                                                                                                                                                                                                                                                |
| 14  | Database type generation                            | `npx supabase gen types typescript --db-url "postgresql://…/tatiana_verify?sslmode=disable"`                                                    | Exit 0; 500-line `database.types.ts` (15 tables + view + 8 enums)                                                                                                                                                                                                                                                                                                          |

Schema test suites added/updated:

- `tests/schema/migrations.test.ts` — naming convention, Phase 1 + Phase 2 enum labels, schema
  layout, exact table inventory, `updated_at` trigger coverage on every table that has the
  column, and a behavioral bump on `events`.
- `tests/schema/constraints.test.ts` — 27 foreign keys, required named indexes, and behavioral
  rejections (duplicate payment/ticket/attendance/email/webhook, money and quantity checks, state
  combinations, invalid consent kinds, append-only consents, deliberate allowance of duplicate
  cédulas, atomic oversell pattern).
- `tests/schema/rls.test.ts` — simulates the Supabase baseline (`anon`, `authenticated`,
  `service_role` + default grants) before applying migrations, then asserts RLS everywhere, zero
  policies, no browser-role privileges (including runtime `permission denied`), future-table
  defaults, `security_invoker` on the view and service-role read access.

## 7. What could not be tested

1. **The Supabase local stack** (`supabase start`, `npm run db:reset`, Studio, PostgREST,
   `db diff`, `db lint`). Docker is running, but Windows reserved TCP port ranges
   (54232–54331, 54075–54174, 54432–54631, 54732–54831, 50000–50059) make the daemon refuse the
   stack's port bindings (54321/54322). The migrations were instead verified on the closest
   available equivalent: a plain PostgreSQL 17 container with Supabase-equivalent roles.
2. **PostgREST runtime behaviour with a publishable key.** RLS semantics were verified at the SQL
   level (`set role`, privilege checks) and in the PGlite simulation, not through the HTTP API.
3. **Supabase-platform schemas** (`auth`, `storage`, platform extensions). The plain container
   does not have them, so generated types contain only the schema this backend owns (`public`).
4. **Live Wompi calls** — still no credentials (unchanged from Phase 1; Phase 5).
5. **Retention/deletion workflows** — the policy is still an open decision, so no retention job
   or anonymization function exists yet.

## 8. Remaining limitations and risks

- The local-stack gap above is the main one: the first action on a machine where `db:reset` can
  run is to confirm the same migrations, then re-run `npm run types:generate --local` to keep the
  canonical workflow.
- `pg-tatiana` (the verification container) was created for this phase and removed after
  verification; it was never part of the project's tooling.
- The window between "Wompi approved" and "tickets issued" is not yet implemented; the schema is
  ready but an end-to-end payment cannot be exercised until Phase 3–5.
- Duplicate-cédula policy, prices, stage quantities, discount values and the reservation window
  remain **client decisions**; the schema supports them all without changes.
- `attendance` rows are immutable by design but not trigger-protected (unlike consents); noted for
  Phase 8 in case operator corrections must be auditable.

## 9. What Phase 3 will implement

1. **Pricing engine in SQL/backend**: stage selection (lowest active sequence with availability),
   subtotal from `pricing_tiers.price_cents`, quantity-discount application, discount-code
   validation (window, limits, shape, redemption counter) — all inside the order transaction.
2. **Order creation endpoint**: validates the request with the existing domain schemas, reserves
   inventory with the atomic conditional update, allocates the reference from
   `next_order_reference()`, writes order + items + redemption rows, and returns the Wompi
   checkout parameters with the integrity signature.
3. **Wompi integration**: Widget/Web Checkout redirect flow, per-attempt references, transaction
   lookup with the private key.
4. **Webhook processing**: checksum → `payment_events` dedupe insert → server-side transaction
   lookup → reference/amount/currency validation → payment and order state transitions → ticket
   issuance with generated tokens → consents + participants persistence → email delivery rows.
5. **Idempotency and retry**: replayed events and out-of-order statuses follow the existing state
   machines; the ledger keeps the forensic trail.
6. Still **not** invented: the event's real prices, stages, quantities and discount rules are
   loaded as data once the client confirms them (seed or operator entry).
