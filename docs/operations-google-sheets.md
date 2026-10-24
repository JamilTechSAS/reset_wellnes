# Google Sheets operational projection

**Status: implemented for the participant-based flow; staging configuration and a live write are
still pending (2026-10-24).** PostgreSQL is the source of truth. The client's spreadsheet is a
read-oriented operational view written by the backend from `public.operational_export`; it is
**not** required for payments, participant assignment or check-in.

Tickets are discontinued. The projection contains **participants of `PAID` orders**, not ticket
records, QR codes or ticket tokens.

## 1. Non-negotiable rules

1. **PostgreSQL is the source of truth.** The sheet is a projection, never authoritative.
2. **Read-only.** Google has no write path into the backend: the service account can only edit
   the one spreadsheet shared with it, and the only backend objects the worker touches are
   `public.operational_export` (read) and the Sheets API (write).
3. Manual edits in the sheet are overwritten for the cells the next successful sync writes. The
   worker writes the data grid from `A1`; it does **not** clear rows below a shorter export (see
   §4).
4. A Google outage can never block a payment, participant assignment or check-in. Enqueueing is a
   local insert inside the same transaction; the HTTP call happens only in the maintenance worker,
   after payment work is committed.
5. With `SHEETS_ENABLED=false` (the default), the worker does not claim or write anything, and
   every other maintenance job still runs. Payments still enqueue participant projections while
   the projection is disabled; those rows remain queued until it is enabled.
6. This phase sends no buyer email: `EMAIL_ENABLED=false` is intentional. Ticket emails are
   discontinued, and the purchase welcome email is deferred until its HTML design is approved.

## 2. Architecture

```text
PAID transition in public.confirm_payment
  └── enqueue every participant of the order
participant INSERT/UPDATE on a PAID order
  └── trigger app_private.sheets_enqueue_participant_paid()
       └── public.sheets_participant_projections   one row per participant (PK participant_id)
            status QUEUED | SYNCING | SYNCED | FAILED
              └── maintenance run (pg_cron → POST /orders-maintenance)
                   ├── claim_participant_sheet_projections(50, now(), 900, 6)
                   │     FOR UPDATE SKIP LOCKED → SYNCING, attempt_count + 1
                   ├── read public.operational_export  (PAID orders, one row per participant)
                   ├── write Datos!A1  (complete header + rows, valueInputOption RAW)
                   ├── finish_participant_sheet_projections(SYNCED | FAILED)
                   └── write Estado counters
```

- **One row per participant.** Any number of changes to that participant collapse into the same
  outbox row. Re-queueing resets `attempt_count`, `last_error` and `next_attempt_at`.
- **Initial enqueue.** `confirm_payment` enqueues every participant when the order reaches
  `PAID`. That includes a replay that leaves an already-PAID order PAID; re-queueing is
  idempotent.
- **Later enqueue.** The participant trigger enqueues on any participant `INSERT` or `UPDATE`
  whose order is already `PAID`. This covers the companion attached with
  `POST /orders/{reference}/participants` and later participant edits. Pre-payment participant
  inserts do not enqueue; there was nothing paid to project yet.
- **Consent-only changes do not have their own trigger.** The participant update path appends the
  consent evidence and updates the participant in the same operation, so it re-queues. A direct
  consent insert with no participant update would not enqueue.
- **Mid-write changes.** `finish_participant_sheet_projections` updates only rows still
  `SYNCING`. A participant changed while the worker was writing was re-queued by its trigger and
  stays `QUEUED` for the next run; the newer state is never marked as synced.
- **Failures.** Claimed rows go back to `FAILED` with a backoff of 1 m, 5 m, 15 m, 1 h, 6 h and a
  six-attempt ceiling. A row that exhausts its budget stays `FAILED` and visible until a new
  participant change re-queues it and resets the counter.
- **Stale claims.** A worker that died after claiming leaves `SYNCING` rows; they become
  reclaimable after 15 minutes.
- **Failure isolation.** The Sheets job runs last in maintenance and is caught like the other
  non-critical jobs. A Google or database failure is reported in `sheetProjections.error` and
  `jobErrors`; it does not affect payments, expiry, reconciliation or check-in.
- **Queued is not synced.** A successful payment only inserts outbox rows. Nothing reaches the
  spreadsheet until a maintenance run claims them.

### Previously paid participants and backfill

`operational_export` contains every participant of every `PAID` order, but the outbox is not
backfilled automatically when the feature is enabled. There is no automatic historical backfill:

- if the outbox is empty, maintenance claims nothing and writes nothing;
- the first eligible projection (a new PAID order or a participant insert/update on a PAID order)
  causes the worker to read the **complete** export and write all PAID participants, including
  older ones;
- a normal purchase or companion attachment is therefore enough to populate the historical rows,
  but the work is triggered by a queued participant, not by enabling the feature.

## 3. Configuration and setup

Required Edge Function secrets:

```text
SHEETS_ENABLED=true
GOOGLE_SERVICE_ACCOUNT_EMAIL=<name>@<project>.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=<PKCS#8 PEM: "-----BEGIN PRIVATE KEY-----">
GOOGLE_SPREADSHEET_ID=<id from the spreadsheet URL>
```

Optional tab names (defaults shown):

```text
GOOGLE_SHEETS_DATA_TAB=Datos
GOOGLE_SHEETS_STATUS_TAB=Estado
```

The private key must be a PKCS#8 PEM (`BEGIN PRIVATE KEY`, not `BEGIN RSA PRIVATE KEY`) with
**real newlines**. The client strips whitespace before base64-decoding; it does not interpret a
literal two-character `\n` escape, so a key pasted as one line with `\n` separators will fail.
Set it from the key file (for example `npx supabase secrets set GOOGLE_PRIVATE_KEY="$(cat key.pem)"`)
or from an env file whose value preserves real newlines. The spreadsheet ID is the segment between
`/d/` and `/edit` in the sheet URL.

**Set the whole group together.** `SHEETS_ENABLED=true` without all three Google values makes the
configuration loader reject the environment for **every** Edge Function, not just maintenance.
Check `/health` after setting them; it reports variable **names**, never values.

### Create the spreadsheet and tabs

1. Create or select the authorized Google Cloud project.
2. Enable the **Google Sheets API**.
3. Create a dedicated service account for staging and generate a PKCS#8 key through the approved
   secure process.
4. Create the staging spreadsheet.
5. **Create the `Datos` and `Estado` tabs manually.** The client only calls
   `values:batchUpdate`; it never calls `addSheet`. A missing `Datos` tab makes the data write
   fail. A missing `Estado` tab makes the data write succeed but the status write fail with a
   warning.
6. Share the spreadsheet with the service-account email as **Editor**. Never share it as
   "anyone with the link".
7. Store the values in a **git-ignored** file and set them on staging only:

```bash
npx supabase secrets set --env-file .env.staging.secrets \
  --project-ref soqmdpqjjdmdhtgsutab
npx supabase secrets list --project-ref soqmdpqjjdmdhtgsutab   # names + digests, not values
```

8. Deploy the current `orders-maintenance` function. It must be running before any queued
   participant can be synced; the pre-Phase-5 version does not know the participant outbox. Secret
   changes themselves are read at runtime and do not require a function redeploy.
9. Verify the secret **names** are present (the command above prints names, never values) and that
   `GET /health` still returns 200. A non-200 after enabling usually means one Google value is
   missing or malformed, which invalidates configuration for every function.
10. Only after a real `PAID` staging order exists, run one maintenance pass and verify `SYNCED` rows
    plus the spreadsheet contents (§5). Do not enable the projection merely to "see if it works"
    without the spreadsheet and tabs already in place.

Never commit a service-account key, spreadsheet credential or real `.env` file. `.env.staging.example`
contains placeholders only.

## 4. The sheet

### `Datos`

One row per participant of a `PAID` order, with a header row, written starting at `A1` using
`valueInputOption: "RAW"`. RAW input means a value beginning with `=` is stored as text and is
never evaluated as a formula.

The view keeps the historical 22-column shape. Because tickets are discontinued, these columns
are **always empty** in the current export:

- `Código de entrada`
- `Estado de la entrada`
- `Ingreso`
- `Fecha de ingreso`

The other columns are:

| Column (ES)                     | Source                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `Evento`                        | `events.code`                                                                                 |
| `Nombre` / `Apellido`           | `participants.first_name` / `last_name`                                                       |
| `Cédula`                        | `participants.national_id`                                                                    |
| `Correo`                        | `participants.email`                                                                          |
| `Teléfono`                      | `participants.phone`                                                                          |
| `Ciudad`                        | `participants.city`                                                                           |
| `Instagram`                     | `participants.instagram`                                                                      |
| `Tipo de entrada`               | `ticket_types.name` via `order_items`                                                         |
| `Etapa de venta`                | `pricing_tiers.name` via `order_items`                                                        |
| `Precio`                        | per admission: `order_items.line_total_cents / quantity`                                      |
| `Moneda`                        | `orders.currency`                                                                             |
| `Referencia de la orden`        | `orders.reference`                                                                            |
| `Estado de la orden`            | `orders.status`                                                                               |
| `Estado del pago`               | latest meaningful `payments.status`, plus the raw provider status in parentheses when present |
| `Autorización de datos`         | latest `DATA_PROCESSING` consent; the cell also carries its version and captured date         |
| `Autorización próximos eventos` | latest `FUTURE_EVENTS` consent                                                                |
| `Creada`                        | `participants.created_at`                                                                     |

`Precio` is **per participant/admission**, not the order total. For the `DOUBLE_EXPERIENCE`
bundle the order line is 2 admissions at 17,000,000 centavos, so each participant row shows
$170,000; the order total is $340,000. The order reference allows the client to group rows.

There is no separate `Estado Wompi` column in the written grid. `operational_export` still exposes
the legacy `payments.raw_wompi_status` field, and the worker appends it to the `Estado del pago`
cell in parentheses. For ePayco that raw value is the ePayco code/text (for example `1` or
`APROBADA`). Likewise, consent version and captured date are folded into the consent cell, not
written as separate columns.

**No clearing.** The worker writes the header plus rows at `A1`; it does not clear the rest of the
sheet. If an export ever contains fewer rows than a previous one, the older rows below the new
grid remain. In the current participant flow rows normally only grow (participants are not deleted
and only `PAID` orders are exported), but do not describe the sheet as fully rebuilt or claim that
removed rows disappear. If a shrinking export must be supported, add a reviewed clear step before
writing.

**Row bound.** `SHEETS_MAX_ROWS = 5000`. If the export is larger, the worker logs an error and
still writes at most the first 5,000 rows; the sheet is then a partial view.

### `Estado`

The worker writes key/value rows after a successful data write:

- `Última sincronización`
- `Total de entradas` (participant projection rows; the label is legacy wording)
- `Sincronizadas`
- `En cola`
- `En curso`
- `Con error`
- `Nota` (manual edits are overwritten in the next synchronization)

A failure writing `Estado` is logged as a warning and does not change the data sync result.

## 5. Staging setup and verification

Prerequisites:

- migrations `20261024120000_remove_tickets_participant_sheets.sql`,
  `20261024130000_participant_units_without_tickets.sql` and
  `20261024140000_order_status_admissions.sql` are applied on staging (remote head recorded in
  `supabase_migrations.schema_migrations`);
- the current `orders-maintenance` function is deployed (the old version cannot drain the
  participant outbox);
- a `PAID` test order with at least one participant exists;
- the spreadsheet and tabs exist and are shared with the service account;
- `SHEETS_ENABLED=true` is set together with all three Google values (never enable it with any
  of them missing);
- `/health` still returns 200 after the change.

Then:

1. Verify the outbox has due rows:

   ```sql
   select status, count(*)
     from public.sheets_participant_projections
    group by status
    order by status;
   ```

2. Run one maintenance pass with the bearer token:

   ```bash
   curl -X POST "https://soqmdpqjjdmdhtgsutab.supabase.co/functions/v1/orders-maintenance" \
     -H "authorization: Bearer $MAINTENANCE_API_TOKEN"
   ```

3. In the response, check `sheetProjections`:

   - `skipped: false` and `configured: true` — credentials were loaded;
   - `claimed` — participants claimed in this run;
   - `syncedTickets` — rows marked `SYNCED` (the field name is legacy; it counts participant
     projections);
   - `failedTickets: 0`;
   - `rowsWritten` — participant rows written to `Datos`;
   - `statusTabWritten: true`;
   - `error: null`.

   A `skipped: true` / `configured: false` result means the client was not configured. A
   `configured: true` result with `claimed: 0` means nothing was due; it does not prove a write.

4. Verify the projected rows and the outbox:

   ```sql
   select count(*) from public.operational_export;
   select status, count(*), min(attempt_count), max(last_error)
     from public.sheets_participant_projections
    group by status;
   ```

5. Open the spreadsheet and verify one row per participant in `Datos`, including the holder and
   the companion, and the counters in `Estado`.

6. The work is idempotent at the outbox level, but every successful run rewrites the full grid.
   A queued row is not evidence that a write happened; only `SYNCED` plus the sheet contents are.

## 6. Troubleshooting

| Symptom                                       | Check                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Sheet not updating                            | `SHEETS_ENABLED=true`; all four Google values set; `/health` 200; maintenance runs; outbox has due `QUEUED`/`FAILED` rows                     |
| `sheetProjections.skipped=true`               | Projection disabled or client not configured; `configured` will be false                                                                      |
| `configured=true`, `claimed=0`                | Nothing due. Queue a projection with a new PAID order or a participant update; a payment alone does not write until maintenance runs          |
| Google returns 403                            | Spreadsheet not shared with the service account, or the service account lacks access; confirm the exact spreadsheet ID                        |
| Google returns 404 or "Unable to parse range" | Create the `Datos` and `Estado` tabs manually (or fix the configured tab names). The client does not create tabs                              |
| `Estado` not updated                          | The data write succeeded but the status write failed; read the maintenance warning. `Datos` is authoritative for the data grid                |
| Rows stuck `FAILED`                           | The six-attempt budget is exhausted; fix the cause, then touch the participant (update/attach) or create a new PAID projection to re-queue it |
| Rows stuck `SYNCING`                          | The worker died after claiming; they become reclaimable after 15 minutes                                                                      |
| Sheet has extra old rows                      | The worker does not clear beyond the written range; remove them manually or add a reviewed clear step                                         |
| Too many rows                                 | The export is bounded at 5,000 rows; the worker logs an error and writes a partial view                                                       |
| Turn it off temporarily                       | `SHEETS_ENABLED=false`; every other maintenance job continues. Already queued rows stay queued and are picked up when it is enabled again     |

Do not "fix" a permissions problem by granting browser roles access. The outbox and export are
`service_role` only.

## 7. Access control and privacy

- The sheet contains the participant personal data the client needs for operations: name, cédula,
  email, phone, city, Instagram and consent evidence. Share it only with the client's authorized
  Google accounts, never "anyone with the link".
- The service account has edit access to that one spreadsheet and no database access. The backend
  writes to the spreadsheet and never reads it back.
- `operational_export` is a `security_invoker` view readable only by `service_role`; RLS remains
  enabled on the outbox and every other table. Adding a column to the view is a deliberate
  migration, not an accident of `select *`.
- No ticket token, QR code or attendance record is produced or exported by the current purchase
  flow. The ticket-era columns remain in the sheet shape but are always empty.
- Formula injection is prevented by `valueInputOption: "RAW"`.

## 8. What the client cannot do

- Cannot change payment status, order status, participant data or admission counts: those fields
  are overwritten from PostgreSQL on the next successful sync.
- Cannot add an admission to the sheet and have it accepted anywhere; the sheet is not read back.
- Manual edits within the written range are overwritten. Edits below a shorter export are not
  cleared by the worker and must be removed manually.

## 9. Related documentation

- [data-model.md](data-model.md) — outbox and export schema.
- [environments.md](environments.md) — secrets, scheduler and deployment.
- [architecture.md](architecture.md) — overall flow.
- [api.md](api.md) — order and participant endpoints.
