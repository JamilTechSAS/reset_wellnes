# Data model

**Status: implemented and verified** by test suites including real-PostgreSQL concurrency runs;
there is no "target schema" below — every table described here exists. See
[phases/phase-02.md](phases/phase-02.md), [phases/phase-03.md](phases/phase-03.md) and
[phases/phase-04.md](phases/phase-04.md) for the historical verification logs.

**Tickets are discontinued.** A PAID order's admissions are its `participants` rows, derived from
`order_items.quantity`; `get_order_status` projects `admissions` and a names-only roster, and
`attach_participant` fills the next free admission without reading `tickets`. The ticket,
attendance and per-ticket email tables are retained only for historical data (and the legacy
check-in path), so the ticket sections below describe storage, not current purchase behaviour.

| Migration                                    | Contents                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261003202241_init.sql`                    | schemas, `set_updated_at()`, role hygiene                                                                                                                      |
| `20261003202242_domain_status_enums.sql`     | `order_status`, `payment_status`, `ticket_status`, `email_delivery_status`                                                                                     |
| `20261003210001_catalog.sql`                 | `events`, `ticket_types`, `pricing_tiers`, `quantity_discounts`, `discount_codes`                                                                              |
| `20261003210002_orders.sql`                  | `order_reference_seq`, `next_order_reference()`, `orders`, `order_items`, `discount_redemptions`                                                               |
| `20261003210003_participants_tickets.sql`    | `participants`, `tickets`                                                                                                                                      |
| `20261003210004_payments.sql`                | `payments`, `payment_events`                                                                                                                                   |
| `20261003210005_attendance_consents.sql`     | `attendance`, `consents`, append-only guard                                                                                                                    |
| `20261003210006_email_deliveries.sql`        | `email_deliveries`                                                                                                                                             |     | `20261003210007_rls_and_operational_export.sql` | RLS posture + `operational_export` view |
| `20261003210008_pricing.sql`                 | `pricing_policy`, `orders.idempotency_key`, SQL pricing helpers, `quote_order_price`                                                                           |
| `20261003210009_order_creation.sql`          | `normalize_order_input`, `reserve_pricing_tier`, `claim_discount_redemption`, `create_order`                                                                   |
| `20261003210010_payment_status_refunded.sql` | `refunded` added to `payment_status` (alone: an enum value cannot be consumed in the transaction that adds it)                                                 |
| `20261003210011_payment_confirmation.sql`    | `tickets.order_item_seq` + unique index, `payment_transition_rank`, webhook ledger, `confirm_payment`, email outbox, expiry, retry, `get_order_status`, grants |

## 1. Conventions

- **Primary keys**: `uuid` with `gen_random_uuid()` (Postgres 17 core function) for entities,
  so ids are safe to expose in URLs. Human-facing numbers (order references) are separate and
  never used as keys.
- **Money**: `bigint` **centavos** (`…_cents`), never `numeric`/`float`. Currency is `COP` and
  every currency column has a `check (currency = 'COP')`. The column-name choice (`amount_cents`
  rather than the brief's example `amount_in_cents`) is deliberate: one shared convention for
  every monetary column while staying 1:1 with Wompi's `amount_in_cents` (1 peso = 100 centavos).
- **Timestamps**: `timestamptz`, `created_at`/`updated_at` on every mutable table, `updated_at`
  maintained by `app_private.set_updated_at()`. Append-only tables (`attendance`, `consents`,
  `payment_events`, `discount_redemptions`) intentionally have no `updated_at`: they are never
  edited.
- **Statuses**: Postgres enums that mirror the TypeScript state machines; parity is enforced by
  `tests/schema/migrations.test.ts`. Enum labels that conflicted with the Phase 1 domain were
  resolved in favor of Phase 1 (mapping table in section 7).
- **Constraints**: `unique`, `check` and foreign keys with explicit `on delete` behaviour. Every
  foreign key has an index. Money and quantity checks are non-negotiable (`> 0` / `>= 0`).
- **RLS**: enabled on every table with **no policies**; browser-facing roles (`anon`,
  `authenticated`) additionally have no table privileges at all. The backend uses the secret key
  (service-role semantics, bypasses RLS). See section 5.
- **Personal data**: stored only in the columns that need it, never duplicated into logs or
  payload dumps (see [security.md](security.md)).

### 1.1 Identifiers

| Identifier              | Where                             | Why it is safe                                                       |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Internal id             | every table (`uuid`)              | Random, not enumerable, safe in admin URLs                           |
| Order reference         | `orders.reference`                | `EVT-<year>-<sequence>` from a DB sequence; traceable, never reused  |
| Ticket token            | `tickets.token`                   | `TKT_` + 20 Crockford base32 chars (100 bits CSPRNG); the QR payload |
| Wompi payment reference | `payments.wompi_reference` unique | attempt 1 = order reference, later attempts append `-<attempt>`      |
| Wompi transaction id    | `payments.wompi_transaction_id`   | Assigned by Wompi; unique when present                               |

No identifier contains personal data, and none is derived from another identifier (no
guessable patterns beyond the sequence that _is_ meant to be human-readable).

## 2. Catalog

### events

`id`, `code` (unique, `^[A-Z0-9][A-Z0-9_-]{1,31}$`), `name`, `description`, `venue_name`,
`venue_address`, `city`, `starts_at`, `ends_at`, `timezone` (default `America/Bogota`),
`currency` (`COP`), `status` (`event_status`: `DRAFT` → `PUBLISHED` → `CLOSED`), `capacity`
(null or `> 0`), `created_at`, `updated_at`. Check `ends_at > starts_at` when present.

Nothing about a specific event is hardcoded anywhere: a second event is rows, not code.

### ticket_types

`id`, `event_id` → events (cascade), `code`, `name`, `description`, `is_active`,
`min_per_order` (default 1), `max_per_order` (null = unlimited), unique `(event_id, code)`.
Today: one row ("Entrada general"). Per-order limits are configuration, not code.

### pricing_tiers (sales stages / presales)

`id`, `ticket_type_id` → ticket_types (cascade), `name`, `sequence` (`>= 1`, unique per ticket
type), `price_cents` (`>= 0`), `quantity_limit` (null = unlimited, else `> 0`),
`quantity_reserved`, `quantity_sold` (both `>= 0`), `sales_starts_at`, `sales_ends_at`,
`is_active`, `created_at`, `updated_at`.

- **Oversell protection**: `check (quantity_limit is null or quantity_reserved + quantity_sold
<= quantity_limit)` is the second line of defence; the first is the atomic reservation in the
  ordering transaction:
  `update pricing_tiers set quantity_reserved = quantity_reserved + n where id = … and
(quantity_limit is null or quantity_reserved + quantity_sold + n <= quantity_limit)
returning id` — no row returned ⇒ sold out. Verified under two simultaneous sessions
  (phase-02 report).
- **Stage selection (Phase 3)**: lowest `sequence` that is active, inside its window and has
  availability. Computed in SQL inside the order transaction, never by the client.
- Partial index `pricing_tiers_active_lookup_idx` on `(ticket_type_id, sequence)
where is_active` supports that lookup.

### quantity_discounts

`id`, `ticket_type_id` → ticket_types (cascade), `min_quantity` (`>= 2`), `percent_bps`
(1…10000), `is_active`, unique `(ticket_type_id, min_quantity)`. **Ships empty**: whether the
client uses quantity discounts, and with which breakpoints, is a business decision. The
structure exists so the pricing engine can apply it without a migration.

### discount_codes

`id`, `event_id` → events (cascade), `ticket_type_id` (nullable, cascade), `code` (stored
uppercase, unique per event), `kind` (`discount_kind`: `PERCENT` | `FIXED`), `percent_bps`
(basis points, integer), `amount_cents` (bigint), `currency` (`COP`), `min_quantity`,
`max_redemptions` (null = unlimited), `redeemed_count`, `valid_from`, `valid_until`,
`is_active`, `created_at`, `updated_at`.

A shape check makes the model unambiguous per `kind`: `PERCENT` requires `percent_bps` and
forbids `amount_cents`; `FIXED` requires `amount_cents` and forbids `percent_bps`.

**Combining rules are data, not code** (Phase 3): `pricing_policy` (single row,
`id boolean primary key check (id)`) holds `discount_combination`, either `BEST_SINGLE` (only the
larger discount applies — the default) or `STACK` (both, capped at the subtotal). `redeemed_count`
is advanced only for the discount that actually reduced the price, and only through
`app_private.claim_discount_redemption`, which claims atomically under the row lock.

### pricing_policy

Singleton configuration row: `id` (always `true`), `discount_combination`
(`BEST_SINGLE` | `STACK`), `updated_at` (trigger-maintained). It exists so the one policy the
client has not decided is a row an operator can change, instead of a rule baked into code.

### discount_redemptions

`id`, `discount_code_id` → discount_codes (restrict), `order_id` → orders (cascade),
`amount_cents` (`>= 0`), `created_at`. Unique `(discount_code_id, order_id)` records each use
once, so usage accounting is auditable independently of `redeemed_count`. **Append-only**
(an UPDATE is rejected by a trigger).

## 3. Orders

### orders

`id`, `reference` (unique, `EVT-<year>-<6+ digit sequence>`), `event_id` → events (restrict),
`status` (`order_status`), buyer contact (`buyer_email` required + normalized lowercase,
`buyer_name`, `buyer_phone`), money breakdown `subtotal_cents`, `quantity_discount_cents`,
`discount_code_cents`, `total_cents` with
`check (subtotal_cents - quantity_discount_cents - discount_code_cents = total_cents)`,
`currency`, `discount_code_id` (set null on delete), `reservation_expires_at`, `paid_at`,
`failed_at`, `cancelled_at`, `source` (`WEB` | `MANUAL`), `ip_address inet`, `user_agent`,
`notes`, `created_at`, `updated_at`.

**Phase 3 additions:** `idempotency_key` (nullable, 16–128 printable ASCII) with a partial unique
index `orders_idempotency_key_idx`. The money columns hold the discounts **actually applied**
(under `BEST_SINGLE` the losing discount is `0`), which is what the total check constraint
requires. The buyer's own participant data is a separate row: one buyer may purchase several
tickets.

- `check (paid_at is null or status = 'PAID')`: a payment timestamp on a non-paid order is a
  data-integrity bug, not a state.
- Indexes: `(event_id)`, `(event_id, status)`, `(reservation_expires_at) where status =
'PENDING'` (expiry job), `(discount_code_id)`.
- The buyer is deliberately **separate** from participants: one buyer may purchase several
  tickets, each assigned to its own participant.

### order_items

`id`, `order_id` → orders (cascade), `ticket_type_id` → ticket_types (restrict),
`pricing_tier_id` → pricing_tiers (restrict), `quantity` (`> 0`), `unit_price_cents`,
`quantity_discount_cents`, `line_total_cents` with
`check (unit_price_cents * quantity - quantity_discount_cents = line_total_cents)`, snapshot
columns `ticket_type_name`, `pricing_tier_name`, `created_at`, `updated_at`. Unique
`(order_id, ticket_type_id, pricing_tier_id)`: two lines for the same stage would make the
money breakdown and inventory accounting ambiguous.

Prices are frozen at order creation; later catalog edits never rewrite history.

## 4. People, tickets, payments, evidence### participants

`id`, `event_id` → events (restrict), `order_id` → orders (restrict), `order_item_id` →
order_items (nullable, restrict), `first_name`, `last_name` (1–80 chars), `national_id`
(digits only, 6–12), `email` (lowercase, valid shape), `phone` (digits only), `city`,
`instagram` (nullable, lowercase handle), `extra_fields jsonb not null default '{}'` (must be a
JSON object), `created_at`, `updated_at`.

Order creation writes ONE participant (the simple flow for this event) with both consent rows,
normalized by `app_private.normalize_order_input` — including stripping a pasted `@` from the
Instagram handle. Attaching the remaining participants of a multi-ticket order is
`POST /orders/{reference}/participants` (Phase 5).

- Values are stored **normalized**, mirroring `domain/participant.ts`: cédula digits only,
  lowercase email, canonical phone. The database rejects what is clearly broken; stricter
  policies (landline acceptance, foreign documents) remain open decisions.
- **No uniqueness on `(event_id, national_id)` yet** — whether a cédula may appear twice is an
  open decision (section 8.1). Indexes `(event_id, national_id)`, `(email)`, `(order_id)` make
  the check cheap when the policy is confirmed.
- Personal data is never deleted silently: `on delete restrict` on both parents forces an
  explicit erasure flow.

### tickets

`id`, `event_id` (restrict), `order_id` (restrict), `order_item_id` (restrict),
**`order_item_seq`** (`>= 1`, the 1-based unit number inside the order line),
`participant_id` (**nullable and unique**, restrict), `ticket_type_id` (restrict), `token`
(unique, `TKT_` + 20 Crockford base32), `status` (`ticket_status`), `price_paid_cents`
(`>= 0`), `issued_at`, `cancelled_at`, `created_at`, `updated_at`. **Unique
`(order_item_id, order_item_seq)`** is the exactly-once issuance guarantee: a replayed webhook
inserts `on conflict do nothing` and can never create a second ticket for a unit.

- `participant_id` is nullable so a ticket can be issued before the buyer assigns a person;
  the unique constraint makes it impossible for two tickets to share one participant.
- The token is generated by the trusted backend and is the only QR content. The QR image is
  never stored: the token is authoritative.
- Indexes: `(event_id)`, `(event_id, status)`, `(order_id)`, `(order_item_id)`,
  `(ticket_type_id)` and the unique `(order_item_id, order_item_seq)`.

### payments

`id`, `order_id` → orders (restrict), `attempt` (`>= 1`, unique with `order_id`),
`wompi_reference` (unique, `EVT-<year>-<sequence>[-<attempt>]`), `wompi_transaction_id`
(unique, nullable until Wompi assigns it), `status` (`payment_status`), `raw_wompi_status`,
`amount_cents`, `currency`, `payment_method_type`, `status_message`, `integrity_signature`,
`provider_payload jsonb` (nullable; contains customer email — never exposed, retention policy
pending), `approved_at`, `finalized_at`, `created_at`, `updated_at`.

Order creation inserts the attempt as `pending` with `amount_cents = orders.total_cents` and
`wompi_reference = orders.reference` (attempt 1). It is **never** marked approved there: only a
verified Wompi event may do that (Phase 4).

- **Exactly one approved payment per order**, guaranteed by a partial unique index
  `payments_one_approved_per_order_idx on payments (order_id) where status = 'approved'`.
  Migration `20261004120000_guard_second_approved_payment` adds a BEFORE INSERT/UPDATE trigger
  (`app_private.guard_single_approved_payment`) that turns the _illegal_ transition (a second
  attempt entering `approved`) into the typed contract `PT409 DOUBLE_PAYMENT_CONFLICT`: the
  index alone would abort `confirm_payment` with a raw `23505`, which the webhook path can only
  answer as `503` forever without ever finalizing the ledger row. The index remains the hard
  guarantee; the trigger makes the refusal clean and operator-visible. A replay on the already
  approved row and a first approval are untouched. The trigger also takes a transaction-scoped
  advisory lock keyed by the order while it checks: without it, two truly overlapping approvals
  could each read before the other committed and the loser still failed with the raw `23505`
  (reproduced on PostgreSQL 17, then re-tested as `PT409` with the lock in place).
- **Forward-only transitions (Phase 4)** — `app_private.payment_transition_rank`
  (`pending/unknown 0 < approved 1 < refunded 2 < voided 3 < declined 4 < error 5`) is applied
  inside `confirm_payment`: `approved`/`refunded` never regress, `unknown` never advances, and
  an approved attempt that Wompi later voids becomes `refunded` with `approved_at` preserved.
- `check (approved_at is null or status in ('approved','voided','refunded'))`: an approval is a
  historical fact that survives a later void/refund, but can never appear on an attempt that was
  never approved. `check (finalized_at is null or status <> 'pending')`.
- One order → many attempts: declined references can never be reused at Wompi, so retries need
  their own reference.

**Phase 5 reconciliation bookkeeping** (same table): `reconciliation_attempts` (`>= 0`),
`last_reconciled_at`, `next_reconciliation_at` (NULL = nothing scheduled), and the two CHECKed
vocabularies `last_reconciliation_result` (`APPROVED_APPLIED`, `APPROVED_DUPLICATE`,
`RECONCILIATION_REQUIRED`, `STILL_PENDING`, `DECLINED`, `VOIDED`, `ERROR`, `UNKNOWN_STATUS`,
`MISMATCH`, `NOT_FOUND_AT_PROVIDER`, `UPSTREAM_ERROR`) and `last_reconciliation_failure`
(`UPSTREAM_ERROR`, `VALIDATION_MISMATCH`, `PROVIDER_NOT_FOUND`, `CONFIRMATION_FAILED`). A BEFORE
INSERT trigger schedules the first sweep for a new `pending`/`unknown` attempt; the due-sweep
partial index covers `(next_reconciliation_at) where status in ('pending','unknown') and
wompi_transaction_id is not null`.

### payment_events (webhook ledger + idempotency gate)

`id`, `dedupe_key` (unique, printable ASCII 16–200 chars: the event identity),
`wompi_event_name`, `wompi_transaction_id`, `payment_id` → payments (nullable, set null),
`checksum_valid`, `received_at`, `processed_at`, `result` (`payment_event_result`: `APPLIED` |
`DUPLICATE` | `REJECTED` | `IGNORED`), `error_code`, `http_status`, `created_at`.

The unique `dedupe_key` is what makes "the same event twice ⇒ exactly one effect" true even
under simultaneous deliveries: the second insert conflicts. `result`/`processed_at` are
nullable on purpose — a row with NULL is a received event that never finished processing,
which is exactly the forensic case operators need.

### attendance (check-in)

`id`, `ticket_id` (**unique**, restrict), `event_id` (restrict), `checked_in_at`,
`checked_in_by` (mandatory operator identifier), `method` (`QR_SCAN` | `MANUAL`), `notes`,
`created_at`. No `updated_at`: rows are inserted once and are the proof of use.

`unique (ticket_id)` is the atomicity guarantee: the first valid scan inserts, every later or
simultaneous scan hits the constraint and reports `ALREADY_USED`. Phase 5 adds
`checked_in_by_user_id` (the authenticated Supabase Auth user id), while `checked_in_by` keeps
the human-readable operator label; the row itself stays append-only. Verified with two parallel
sessions (phase-02 and phase-05 reports).

### consents

`id`, `event_id` (restrict), `participant_id` → participants (cascade), `kind`
(`consent_kind`: `DATA_PROCESSING` | `FUTURE_EVENTS`), `granted`, `policy_version`,
`policy_text_hash` (optional SHA-256), `captured_at`, `ip_address inet`, `created_at`.

- **Append-only**: an UPDATE is rejected by `app_private.reject_update()`. A withdrawal is a
  new row with `granted = false`; the latest row per `(participant_id, kind)` is effective and
  the earlier evidence stays intact (Ley 1581 de 2012).
- `DATA_PROCESSING` is mandatory to buy (enforced by the domain); `FUTURE_EVENTS` is recorded
  even when declined.
- Index `(participant_id, kind, captured_at desc)` serves the "effective consent" lookup used
  by the export view.

### email_deliveries

`id`, `ticket_id` → tickets (cascade), `template` (format-checked; `TICKET_CONFIRMATION`
today), `idempotency_key` (unique; **CHECK that it equals
`'ticket:' || ticket_id || ':' || template`**), `recipient_email` (resolved at queue time and
stored), `status` (`email_delivery_status`), `attempt_count`, `provider` (default `resend`),
`provider_message_id`, `last_error`, `next_attempt_at`, `queued_at`, `sent_at`, `created_at`,
`updated_at`.

Deriving the key from the row's own identity means a mis-keyed row cannot exist, so the unique
constraint provably prevents duplicate confirmation sends when Wompi redelivers an event. Retry
index: `(next_attempt_at) where status in ('QUEUED','FAILED')`.

### operators (Phase 5)

`user_id` (PK; equals `auth.users.id`, with a conditional FK when the auth schema exists),
`display_name` (1–120 chars, no control characters), `role` (`OPERATOR` | `ADMIN`, default
`OPERATOR`), `is_active`, `created_at`, `updated_at`.

Authorization data only: authentication is Supabase Auth. No password, hash or shared secret is
stored here, and there is no self-registration path — an operator is a `auth.users` row plus a
row in this table. Deactivating (`is_active = false`) revokes access immediately; a valid user
without an active row gets `403 FORBIDDEN`.

### rate_limit_counters (Phase 5)

`scope`, `key_hash` (md5 of the namespaced key), `window_start`, `counter` (PK
`(scope, key_hash, window_start)`). Fixed-window counters consumed atomically
(`insert … on conflict … returning counter`). Namespaced keys (`ip:`, `ref:`, `op:`) are hashed
before storage, so no raw IP, reference or operator id lives in this table. Rows older than the
horizon (default 2 h) are deleted by maintenance. Not evidence — abuse control only.

### sheets_participant_projections (Google Sheets outbox)

`participant_id` (PK → participants cascade), `event_id` → events, `status`
(`sheets_projection_status`: `QUEUED` | `SYNCING` | `SYNCED` | `FAILED`), `attempt_count`,
`last_error` (≤500 chars), `last_synced_at`, `next_attempt_at`, `created_at`, `updated_at`.

One row per participant. `confirm_payment` enqueues every participant of the order in the same
transaction that marks the order `PAID`; the `participants` trigger re-queues later inserts or
edits, but only while the order is `PAID`. Re-queuing resets the attempt counter, so any number
of changes collapse into one logical projection. `claim_participant_sheet_projections` takes due
rows with `FOR UPDATE SKIP LOCKED`, reclaims stale `SYNCING` rows after a timeout, and increments
the attempt counter; `finish_participant_sheet_projections` updates only rows still `SYNCING`, so
a change that arrives mid-write stays queued. `participant_sheet_projection_stats` exposes
queued / syncing / synced / failed / total plus `lastSyncedAt` and `oldestPendingAt`. This table
is an outbox, not evidence: losing it loses only a pending sheet update, and `QUEUED` does not
mean synced.

## 5. Access control (RLS and the export view)

- RLS is enabled on **all 19 tables** and **no policy exists**. A role that does not bypass RLS
  (`anon`, `authenticated`, any future API role) reads nothing and writes nothing. This is
  intentional and documented, not an oversight: the backend uses the secret key, and the future
  frontend must never talk to Postgres directly.
- Defense in depth: the Phase 2 migration revokes every table/sequence privilege from `anon`
  and `authenticated` and removes their **table** default privileges; migration
  `20261004130000` does the same for **functions** (on Supabase a new `public` function is
  granted EXECUTE directly to both roles, so `revoke ... from public` alone was not enough) and
  for future sequence defaults. A table or function that needs PostgREST access would require
  an explicit grant + policies decision.
- The backend's own role is granted explicitly: migration `20261004150000` gives `service_role`
  `select/insert/update/delete` on every table in `public` and `usage/select` on every sequence,
  re-established as default privileges for future objects. This is what makes the backend
  independent of the platform's automatic grants — with the strict Supabase defaults
  (`auto_expose_new_tables = false`, the documented platform direction) those disappear and every
  gateway call would otherwise answer `403`. Future functions still need their explicit
  grant/revoke: PostgreSQL's built-in `EXECUTE` to `PUBLIC` on new functions cannot be removed
  through default privileges (re-confirmed on PG 17.11), and the function scan in
  `rls.test.ts` enforces it.
- `app_private` is the backend's helper schema. `anon`/`authenticated` have no USAGE and no
  EXECUTE there; `service_role` has USAGE plus EXECUTE on the helpers that its own functions
  call internally — a `SECURITY INVOKER` call is privileged as the caller, so
  `20261004140000` grants exactly those (verified by running the API as `service_role` on
  PostgreSQL 17; see [security.md](security.md) § 7).
- `operational_export` is the only read model exposed to non-backend tooling. It is created
  with `security_invoker = true`, so granting it to a role without base-table rights fails
  closed. Only `service_role` can read it today.
- Buyer-facing reads and writes will always go through Edge Functions with whitelisted fields
  ([api.md](api.md)); they never query tables from the client.

## 6. Read models for the client

### operational_export (one row per participant of a PAID order)

| Column (ES)                     | Source                                       | Notes                                       |
| ------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `Evento`                        | `events.code`                                | Used to filter by event                     |
| `Código de entrada`             | always `NULL`                                | Ticket-only column, retained for shape      |
| `Nombre` / `Apellido`           | `participants.first_name` / `last_name`      | One row per participant                     |
| `Cédula`                        | `participants.national_id`                   | Personal data — restricted                  |
| `Correo`                        | `participants.email`                         | Personal data — restricted                  |
| `Teléfono`                      | `participants.phone`                         | Personal data — restricted                  |
| `Ciudad`                        | `participants.city`                          |                                             |
| `Instagram`                     | `participants.instagram`                     | Nullable                                    |
| `Tipo de entrada`               | `ticket_types.name` via `order_items`        |                                             |
| `Etapa de venta`                | `pricing_tiers.name` via `order_items`       |                                             |
| `Precio centavos`               | `order_items.line_total_cents / quantity`    | Per-admission centavos, not formatted money |
| `Moneda`                        | `orders.currency`                            |                                             |
| `Referencia de la orden`        | `orders.reference`                           |                                             |
| `Estado de la orden`            | `orders.status`                              | Always `PAID` — the view filters on it      |
| `Estado del pago`               | latest meaningful `payments.status`          | Approved attempt when present, else latest  |
| `Estado Wompi`                  | `payments.raw_wompi_status`                  | Legacy column; null for ePayco rows         |
| `Estado de la entrada`          | always `NULL`                                | Ticket-only column, retained for shape      |
| `Ingreso`                       | always `NULL`                                | Attendance no longer applies                |
| `Fecha de ingreso`              | always `NULL`                                | Attendance no longer applies                |
| `Autorización de datos`         | latest `DATA_PROCESSING` consent → `granted` | Plus version and captured_at columns        |
| `Autorización próximos eventos` | latest `FUTURE_EVENTS` consent → `granted`   |                                             |
| `Creada`                        | `participants.created_at`                    | Stable export ordering                      |

The view returns **raw values** (enum labels, centavos, `timestamptz`): the Spanish labels and
money/date formatting live in the Phase 1 label maps and are applied by the export function
([operations-google-sheets.md](operations-google-sheets.md)). One formatting implementation,
not two. The export is the whole event's PAID participants, not just the claimed rows, so the
first sync after enabling Sheets backfills every previously paid participant.

Buyer-facing lookups (order status) also go through Edge Functions that return whitelisted
fields; they never query tables directly from the client.

## 7. Conflicts resolved against the brief (Phase 1 kept as source of truth)

| Brief / external naming                                            | Implemented (Phase 1)                                | Why                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Ticket states `ISSUED` / `USED` / `CANCELLED`                      | `ACTIVE` / `CANCELLED` / `REFUNDED` + attendance row | "Used" is an attendance fact, not a ticket state; refunds are a real state |
| Consent `PERSONAL_DATA_PROCESSING` / `FUTURE_EVENT_COMMUNICATIONS` | `DATA_PROCESSING` / `FUTURE_EVENTS`                  | Phase 1 enum already shipped and tested; labels live in Spanish UI text    |
| `amount_in_cents` column naming                                    | `*_cents` (`total_cents`, `amount_cents`, …)         | One convention across tables, 1:1 with Wompi's field                       |

## 8. Open decisions (not encoded in the schema)

1. **Duplicate registration policy**: is a cédula unique per event, per ticket type, or allowed
   with a warning? The indexes exist; the constraint is deliberately absent.
2. ~~Buyer vs participant~~ — resolved: buyer fields live on `orders`, each ticket gets its own
   participant row, so one buyer can purchase many tickets.
3. **Pricing stages**: how many, prices and quantities each. Schema supports any number.
4. **Quantity discounts**: breakpoints and percentages, if any. `quantity_discounts` ships empty.
5. **Discount codes**: which codes exist, values, validity, limits, and whether they combine
   with quantity discounts. `discount_codes` / `discount_redemptions` ship empty.
6. **Reservation window**: how long a `PENDING` order keeps inventory. Implemented as
   `ORDER_RESERVATION_MINUTES` with a **technical default of 15** (not a client decision); the
   value is validated at startup and passed into `create_order`. The expiry job is implemented
   (Phase 4: `expire_pending_orders`, run by the `orders-maintenance` function).
7. **Discount combination** (new in Phase 3): `pricing_policy.discount_combination` defaults to
   `BEST_SINGLE` — the conservative choice that never stacks discounts. `STACK` is one `UPDATE`
   away once the client decides.
8. **Participant data edits**: may a buyer fix a name/cédula after payment? Today
   `updated_at` makes edits traceable, but no audit-row design exists yet.
9. **Manual check-in fallback**: may an operator admit someone whose payment is pending, and how
   is that recorded? `attendance.method = 'MANUAL'` + `notes` is the target; the policy is open.
10. **Consent text and version**: exact legal wording and version id (`policy_version` /
    `policy_text_hash` are ready; order creation writes `v1` when the client sends no version).
11. **Extra participant fields**: anything beyond the current list. `participants.extra_fields`
    absorbs them without a migration; they must be added to the export/email when they exist.
12. **`expiration-time` in the Wompi checkout**: supported by the code and the signature, disabled
    by default until the client decides (it changes the checkout UX and the signature inputs).
13. **Data retention** (section 9): keep participant data for the event plus a window; delete or
    anonymize afterwards. `provider_payload` should have a shorter retention (it may contain
    personal data). Needs the client's confirmation.
14. **Refunds**: `payment_status.refunded` records an approved-then-voided attempt (Phase 4) with
    the approval timestamp preserved. No refund is initiated by the backend, and no refund flow
    exists; the process is the client's to define with Wompi support.

## 9. Pricing, inventory and the order transaction (Phase 3)

The authoritative price is computed in SQL, inside the order transaction:
`public.quote_order_price` (display, no side effects) and `public.create_order` (commitment).
Neither takes an amount parameter, so a client-supplied price has nowhere to enter the system.

**Stage selection** (`app_private.active_pricing_tier_id`): lowest `sequence` that is active,
inside its sales window and able to hold the whole quantity. An exhausted stage is skipped; the
next eligible stage serves the order at ITS price. If none can, the order fails with `SOLD_OUT`.

**Discount arithmetic:** subtotal `= price_cents × quantity` (from the reserved row); quantity
discount `= floor(subtotal × percent_bps / 10000)`; code discount from
`app_private.evaluate_discount_code`; combination from `pricing_policy`; total `= subtotal −
applied discounts`, never negative.

**Reservation** (`app_private.reserve_pricing_tier`): one conditional `UPDATE … RETURNING`, so the
predicate is evaluated under the row lock and the price provably belongs to the reserved stage.
The Phase 2 inventory check constraint is the second line of defence.

**Idempotency**: `orders.idempotency_key` (partial unique index). A retry with the same key and
the same buyer returns the original order; a different buyer gets `IDEMPOTENCY_KEY_CONFLICT`
rather than someone else's order.

**The transaction writes**: `orders` (PENDING, applied discount split), `order_items` (snapshot
names), `participants` (normalized), `consents` (both kinds, append-only), `payments`
(attempt 1, pending), and `discount_redemptions` when a code was applied. Any failure rolls all
of it back.

## 10. Migration and evolution strategy

- **Migrations are append-only once applied.** Naming is the Supabase CLI convention
  `<YYYYMMDDHHMMSS>_snake_case.sql`; historical files are never edited, so `db push` and
  `db diff` stay meaningful.
- **Expand → contract.** New columns are added nullable or with defaults, then backfilled, then
  constrained in a later migration. Nothing in Phase 2 drops or rewrites existing user data.
- **Verification.** Every migration is applied in order to PGlite (Postgres 18 in WASM) on every
  `npm test`; the Phase 2 and Phase 4 runs additionally applied all migrations to a real
  PostgreSQL 17 instance and verified structure, constraints, RLS, the export view and the
  confirmation-pipeline races under two parallel sessions (see the phase reports).
- **Functions.** All public entry points (`quote_order_price`, `create_order`, `confirm_payment`,
  `claim_webhook_event`, `finalize_webhook_event`, `record_webhook_rejection`,
  `queue_ticket_emails`, `claim_email_deliveries`, `finish_email_delivery`,
  `expire_pending_orders`, `retry_payment`, `get_order_status`) are executable by `service_role`
  only (`EXECUTE` revoked from `PUBLIC`); the helpers live in `app_private`.
- **Types.** `supabase/functions/_shared/db/database.types.ts` is generated by the Supabase CLI
  from a database with the migrations applied (`npm run types:generate`). It is never
  hand-edited; the file is excluded from Prettier and the root tsconfig so a regeneration diff
  stays clean.

## 11. Payment confirmation and delivery (Phase 4)

All of it lives in `20261003210011_payment_confirmation.sql` and is callable by `service_role`
only.

**`confirm_payment(order_reference, wompi_reference, transaction_id, raw_status, amount, currency, …)`**
— one transaction that:

1. locks the order (`for update`), which serializes every confirmation per order;
2. validates reference shape/ownership, amount equal to `orders.total_cents`, currency `COP`;
3. finds the payment by transaction id first, then by reference, and creates the row only when
   neither exists (a retry attempt derived from `<order reference>-<n>`);
4. applies the transition forward-only (rank table above);
5. on approval: `FAILED`/`PENDING` → `PAID`, inventory `quantity_reserved → quantity_sold`;
   `CANCELLED`/`EXPIRED` → `RECONCILIATION_REQUIRED` (no revival, no refund, no ticket);
6. issues exactly one ticket per purchased unit (`on conflict (order_item_id, order_item_seq) do
nothing`), attaching the line's participants in creation order and giving the last unit the
   integer remainder so `sum(price_paid_cents) = line_total_cents`;
7. reports `APPLIED` / `DUPLICATE` / `RECONCILIATION_REQUIRED` with the ids an operator needs.

**`payment_events`** is the webhook ledger: `claim_webhook_event` inserts under the unique
`dedupe_key` and reports whether the caller owns the event; `finalize_webhook_event` records the
outcome exactly once; `record_webhook_rejection` stores a refused (forged or malformed) delivery
with `checksum_valid = false`. `processed_at is null` is the "received but never finished"
operator query, indexed by `payment_events_unprocessed_idx`.

**Email outbox.** `queue_ticket_emails(order_id, template)` is a legacy function and the purchase
flow no longer calls it; `EMAIL_ENABLED=false` in this phase. `claim_email_deliveries` takes due
rows with `FOR UPDATE SKIP LOCKED` (stale `SENDING` rows are reclaimable after a timeout) and
`finish_email_delivery` records `SENT`/`FAILED`/`CANCELLED` with the next attempt instant.

**Lifecycle.** `expire_pending_orders` returns inventory and marks `PENDING`/`FAILED` orders past
their deadline `EXPIRED` (concurrent-safe, never touches paid orders). `retry_payment` creates a
new attempt with a fresh reference for a `FAILED`/`EXPIRED` order, gated on reference + buyer
email, capped at 10 attempts, re-reserving at the original stage and price when needed.

**`get_order_status(reference, buyer_email)`** is the buyer-facing projection: a SQL whitelist
(no cédula, email, phone, IP, user agent, Wompi transaction id, signature or provider payload),
admission counts derived from `order_items` and `participants`, a names-only participant roster
for a paid order, and the same `found: false` for an unknown reference and a wrong email.

## 12. Phase 5 operations (reconciliation, participants, check-in, public reads)

All callable by `service_role` only, `SECURITY INVOKER`, `search_path = ''`.

**Reconciliation** (`20261003210012`): `claim_payment_reconciliations(batch, max_attempts, now)`
claims due attempts with `FOR UPDATE SKIP LOCKED`, consumes one attempt and advances the
backoff schedule; `finish_payment_reconciliation(payment_id, result, failure, next_attempt_at)`
validates the vocabulary and clears the schedule for terminal results;
`resolve_payment_for_buyer(reference, email)` is the reference+email gate for the payment hint.
The initial schedule is applied by a BEFORE INSERT trigger on `payments`, so every creation path
(order, retry, recovery) is covered without touching `create_order`.

**Participants** (`20261003210013`, re-grained in `20261024130000`):
`attach_participant(reference, email, payload, policy_version?)` creates a participant and
assigns it to the next free admission of the order. Capacity is
`sum(order_items.quantity)` and assignment is the first order line still below its quantity, so
the line's ticket type / stage attribution stays correct for the Sheets export. The order row
is locked with `FOR UPDATE`, which serializes concurrent calls on the same order (a
participant count above capacity raises `PT409 NO_ASSIGNABLE_UNIT`); no ticket row, token or QR
is involved. `update_participant(reference, email, participant_id, payload, …)` edits only a
participant of that order. Both normalize/validate the payload in SQL (`PT400` with stable
details) and append consent evidence — never update history. Unknown reference, wrong email and
a foreign participant id all return `{found:false}` / `NOT_FOUND` identically.

**Check-in** (`20261003210013`): `record_check_in(token, operator_label, operator_user_id?,
method?, notes?, now)` locks the ticket, decides (cancelled → not paid → already used → valid),
inserts attendance exactly once (`on conflict (ticket_id) do nothing`) and returns the outcome
JSON. `get_public_ticket(token)` is the holder-safe projection; `get_operator_ticket(token)` is
the admission view (name, cédula, city, ticket, order/payment/attendance) without email, phone,
order internals or consent history.

**Public reads** (`20261003210014`): `get_public_event(code)` / `get_public_availability(code)`
return a field-by-field whitelist built in SQL, with the coarse availability bucket from
`app_private.availability_label`; `consume_rate_limit(scope, key, limit, window)` and
`cleanup_rate_limit_counters(horizon)` implement the fixed-window limiter.

**Sheets outbox** (`20261003210015`): `claim_sheet_projections(limit, now, stale_after, max_attempts)`,
`finish_sheet_projections(ticket_ids, status, error?, next_attempt_at?)` and
`sheet_projection_stats()`; the enqueue triggers are described in §4. The scheduler function
`app_private.invoke_scheduled_maintenance()` reads Vault secrets and POSTs the maintenance
endpoint via `pg_net`.
