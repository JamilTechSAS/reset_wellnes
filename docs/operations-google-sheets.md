# Google Sheets operational projection

**Status: implemented through a Google Apps Script connector; staging configuration and a live
write are still pending (last verified 2026-10-24; this implementation was prepared locally without
touching staging).** PostgreSQL is the source of truth. The client's spreadsheet is a read-oriented
operational view written from `public.operational_export`; it is **not** required for payments,
participant assignment or check-in.

Tickets are discontinued. The projection contains **participants of `PAID` orders**, not ticket
records, QR codes or ticket tokens.

The backend no longer needs a Google Cloud service account, a private key or a spreadsheet ID.
A standalone Apps Script web app owns those values in Script Properties and exposes one signed
POST endpoint. The backend holds only `GOOGLE_APPS_SCRIPT_URL` and `GOOGLE_APPS_SCRIPT_SECRET`.

## 1. Non-negotiable rules

1. **PostgreSQL is the source of truth.** The sheet is a projection, never authoritative.
2. **Read-only from our side.** The Apps Script runs as its owner and can edit only the configured
   spreadsheet. The backend only reads `public.operational_export` and calls the connector.
3. Manual edits in the sheet are overwritten for the cells the next successful sync writes. The
   worker writes the data grid from `A1`; it does **not** clear rows below a shorter export (see
   §5).
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
                   ├── signed POST → Apps Script /exec
                   │     operation "sync", grid "data", complete header + rows
                   │     Apps Script maps "data" → SPREADSHEET_ID/DATA_TAB
                   ├── finish_participant_sheet_projections(SYNCED | FAILED)
                   └── signed POST → Apps Script, grid "status" → STATUS_TAB counters
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
  non-critical jobs. A connector or database failure is reported in `sheetProjections.error` and
  `jobErrors`; it does not affect payments, expiry, reconciliation or check-in. A failed status-tab
  write is a warning only: the data write already succeeded and the claimed participants stay
  `SYNCED`.
- **Queued is not synced.** A successful payment only inserts outbox rows. Nothing reaches the
  spreadsheet until a maintenance run claims them and the connector acknowledges the write.

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
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/<deployment-id>/exec
GOOGLE_APPS_SCRIPT_SECRET=<shared HMAC secret, at least 32 characters>
```

`GOOGLE_APPS_SCRIPT_SECRET` must have no whitespace and must be exactly the same value as the
Apps Script property `HMAC_SECRET`. The spreadsheet ID and tab names are **not** backend
environment variables.

Required Apps Script Script Properties:

| Property         | Required | Default  |
| ---------------- | -------- | -------- |
| `SPREADSHEET_ID` | yes      | —        |
| `HMAC_SECRET`    | yes      | —        |
| `DATA_TAB`       | no       | `Datos`  |
| `STATUS_TAB`     | no       | `Estado` |

The URL must be the deployed Apps Script `/exec` endpoint on `script.google.com`; the config
loader rejects any other host, path, query or fragment. The `/dev` URL is not accepted.

**Set the whole group together.** `SHEETS_ENABLED=true` without both connector values makes the
configuration loader reject the environment for **every** Edge Function, not just maintenance.
Check `/health` after setting them; it reports variable **names**, never values.

### Install the Apps Script

The ready-to-install source is in
[`integrations/google-apps-script/`](../integrations/google-apps-script/README.md).

1. Sign in to Google Apps Script with the Google account that owns the staging spreadsheet.
2. Create a standalone project.
3. Replace `Code.gs`, add `lib.js`, and install the provided `appsscript.json`.
4. Create the spreadsheet manually with `Datos` and `Estado` tabs. The script does not create
   them and does not resize them; give each tab at least the rows/columns of its grid.
5. Set `SPREADSHEET_ID`, `HMAC_SECRET`, and optionally `DATA_TAB` / `STATUS_TAB` in **Project
   Settings → Script Properties**.
6. Deploy as a web app: execute as **Me**, and choose the minimum access that permits the Supabase
   server-to-server call. With a standard Google account that is **Anyone**; the endpoint is still
   protected by the mandatory HMAC signature. If the organisation forbids anonymous endpoint
   access, document the blocker instead of removing signature verification. Every code change needs
   a new version/deployment; copy the new `/exec` URL if Google changes it.
7. Authorize the script, copy the URL ending in `/exec`, and configure the two Supabase staging
   secrets. Store them in a git-ignored file without printing the secret to the terminal or a
   shell history entry:

```bash
# Creates/overwrites a git-ignored file. The secret is generated into the file, not printed.
umask 077
printf 'GOOGLE_APPS_SCRIPT_URL=%s\nGOOGLE_APPS_SCRIPT_SECRET=%s\n' \
  'https://script.google.com/macros/s/<deployment-id>/exec' \
  "$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))")" \
  > .env.staging.secrets
chmod 600 .env.staging.secrets

npx supabase secrets set --env-file .env.staging.secrets \
  --project-ref soqmdpqjjdmdhtgsutab
npx supabase secrets list --project-ref soqmdpqjjdmdhtgsutab   # names + digests, not values
```

Use the same generated value for Apps Script `HMAC_SECRET`; copy it through the Apps Script
Project Settings UI, never through a commit, chat, screenshot or log. If the file already exists,
append or edit it locally instead of overwriting unrelated staging variables.

8. Run the signed health and self-test checks **before enabling the projection**:

```bash
node --env-file=.env.staging.secrets scripts/sheets-connector-check.ts health
node --env-file=.env.staging.secrets scripts/sheets-connector-check.ts self_test
```

`self_test` creates a temporary tab, writes and reads one cell, then deletes the tab. It does not
touch participant rows or the `Datos`/`Estado` data.

9. Deploy the current `orders-maintenance` function. Secret changes are read at runtime, but a
   function that predates this code cannot call the Apps Script contract.
10. Set `SHEETS_ENABLED=true` only after both signed checks succeed. Verify `/health` still returns
    200 and the names are present.

Never commit the shared secret or a real `.env` file. `.env.staging.example` contains placeholders
only. The command above writes a fresh secret directly to the git-ignored file. Do not `cat` that
file, paste its contents into a ticket or chat, or reuse the value across environments.

> The Apps Script endpoint may answer through a Google redirect. The backend fetch follows
> redirects by default. This hosted behavior cannot be fully exercised in the local runner; it is
> part of the manual deployment check.

### Current staging status

Last verified on 2026-10-24: staging has no Google Sheets configuration. `SHEETS_ENABLED` and the
Apps Script URL/secret were absent, and there was no live write. This code task did not change
staging. Google Sheets QA remains blocked until the owner installs the script, creates the
spreadsheet/tabs, runs the signed health and self-test, and verifies a real `PAID` projection.

## 4. Signed request contract

The backend sends:

```json
{
  "version": 1,
  "timestamp": 1792829768,
  "nonce": "base64url-random-32-bytes",
  "payload": "{\"operation\":\"sync\",\"grid\":\"data\",\"values\":[[...]]}",
  "signature": "base64url-hmac-sha256"
}
```

`payload` is an exact JSON string. The canonical message is:

```text
v1\n{timestamp}\n{nonce}\n{payload}
```

The Apps Script verifies the HMAC before parsing the payload, rejects timestamps outside ±300
seconds, consumes each nonce once under a script lock for 600 seconds, and accepts only
`health`, `self_test` and `sync`. A request can select only `grid: "data"` or
`grid: "status"`; Apps Script maps those fixed names to `DATA_TAB` / `STATUS_TAB`. There is no
request field for a spreadsheet, tab or arbitrary range.

Content Service returns HTTP 200 even for an application error, so the backend checks
`{ok:true}` and the required write acknowledgement rather than the transport status alone.

## 5. The sheet

### `Datos`

One row per participant of a `PAID` order, with a header row, written starting at `A1`. The Apps
Script uses `Range.setValues`, which interprets a leading `=` as a formula. It first prefixes
formula-leading strings (`=`, `+`, `-`, `@`, tab, CR, LF) with the Sheets text marker `'` so the
value is stored as text; numbers and booleans remain typed. Do not bypass `rwSanitizeCellValue_`
when changing the writer.

The target tab must already have at least the rows and columns being written. The connector writes
an exact range from `A1` and does not insert rows/columns or create tabs; a tab that is too small
returns `WRITE_FAILED` and the outbox retries it.

The view keeps the historical 22-column shape. Because tickets are discontinued, these columns
are **always empty** in the current export:

- `Código de entrada`
- `Estado de la entrada`
- `Fecha de ingreso`

`Ingreso` is written as **`No`**, not empty, because the formatter maps a null attendance flag to
`No`. There is no ticket or attendance data behind it.

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
written as separate columns. The field name is historical; ePayco is the only active provider.

**No clearing.** The worker writes the header plus rows at `A1`; it does not clear the rest of the
sheet. If an export ever contains fewer rows than a previous one, the older rows below the new
grid remain. In the current participant flow rows normally only grow (participants are not deleted
and only `PAID` orders are exported), but do not describe the sheet as fully rebuilt or claim that
removed rows disappear. If a shrinking export must be supported, add a reviewed clear step before
writing.

**Row bound.** `SHEETS_MAX_ROWS = 5000`. If the export is larger, the worker logs an error and
still writes at most the first 5,000 rows; the sheet is then a partial view. The Apps Script rejects
a data grid above 5,001 rows (header + 5,000 participants) or 22 columns.

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

## 6. Staging setup and verification

Prerequisites:

- migrations `20261024120000_remove_tickets_participant_sheets.sql`,
  `20261024130000_participant_units_without_tickets.sql` and
  `20261024140000_order_status_admissions.sql` are applied on staging;
- the current `orders-maintenance` function is deployed;
- a legitimate `PAID` order with at least one participant exists;
- the Apps Script is deployed and its signed `health` + `self_test` succeed;
- `Datos` and `Estado` exist;
- `SHEETS_ENABLED=true` is set together with both connector values;
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

   - `skipped: false` and `configured: true` — the connector was loaded;
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

### What was tested locally

The TypeScript tests cover deterministic HMAC vectors, invalid/expired/future signatures, nonce
replay, malformed payloads, fixed grid targets, unsafe `{ok:true}` responses, HTTP/network
failures, formula-safe cell handling, a throwing connector client and outbox retry behavior. The
Apps Script helpers and the `Code.gs` entrypoint are loaded in Node against a small fake of the Apps
Script spreadsheet/content/cache/lock services; that covers request wiring, fixed tab selection,
formula sanitization and the write acknowledgement, not Google's hosted services.

They do **not** execute Google's hosted Apps Script runtime. After deployment, the manual checks
are the signed `health`/`self_test` calls and then a real `PAID` projection. Do not claim the hosted
runtime is verified from TypeScript tests alone.

## 7. Troubleshooting

| Symptom                              | Check                                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `sheetProjections.skipped=true`      | `SHEETS_ENABLED=false` or the connector is not configured; `configured` will be false                                                         |
| `configured=true`, `claimed=0`       | Nothing due. Queue a projection with a new PAID order or a participant update; a payment alone does not write until maintenance runs          |
| `CONFIGURATION` from Apps Script     | Script Properties missing; check `SPREADSHEET_ID`, `HMAC_SECRET`, tab names                                                                   |
| `MISSING_TAB`                        | Create `Datos` and `Estado` manually, or fix `DATA_TAB` / `STATUS_TAB`                                                                        |
| `UNAUTHORIZED`                       | The Supabase secret and Apps Script `HMAC_SECRET` differ, or the body was changed after signing                                               |
| `EXPIRED_REQUEST` / `FUTURE_REQUEST` | The server clock is outside the ±300 s window; check the runtime clock                                                                        |
| `REPLAY`                             | The same nonce was reused; create a fresh nonce per request                                                                                   |
| `BUSY`                               | Another request holds the script lock; the outbox retry will pick it up                                                                       |
| `SPREADSHEET_ACCESS`                 | The deploying account cannot open `SPREADSHEET_ID`; share it with that account or fix the property                                            |
| `WRITE_FAILED`                       | Quota, protected range, or invalid tab; check Apps Script Executions                                                                          |
| Non-JSON response / sign-in HTML     | The deployment access mode is wrong or the `/dev` URL was used; redeploy the web app and use `/exec`                                          |
| HTTP 200 but `ok:false`              | Expected: Content Service cannot set an HTTP error status. Read the structured error code                                                     |
| `Estado` not updated                 | The data write succeeded but the status write failed; read the maintenance warning. `Datos` is authoritative for the data grid                |
| Rows stuck `FAILED`                  | The six-attempt budget is exhausted; fix the cause, then touch the participant (update/attach) or create a new PAID projection to re-queue it |
| Rows stuck `SYNCING`                 | The worker died after claiming; they become reclaimable after 15 minutes                                                                      |
| Sheet has extra old rows             | The worker does not clear beyond the written range; remove them manually or add a reviewed clear step                                         |
| Too many rows                        | The export is bounded at 5,000 rows; the worker logs an error and writes a partial view                                                       |
| Turn it off temporarily              | `SHEETS_ENABLED=false`; every other maintenance job continues. Already queued rows stay queued and are picked up when it is enabled again     |

Do not "fix" a permissions problem by granting browser roles access. The outbox and export are
`service_role` only.

### Rotating the shared secret

1. Generate a new secret into a git-ignored file as shown above.
2. Update Apps Script `HMAC_SECRET` **and** the Supabase `GOOGLE_APPS_SCRIPT_SECRET` for the same
   environment. Change both before the next maintenance run; requests signed with the old value
   are rejected with `UNAUTHORIZED`.
3. Run the signed `health` and `self_test` with the new value. Queued projections remain queued and
   are picked up by the normal retry policy; nothing is lost.
4. If the secret may have leaked, also disable `SHEETS_ENABLED` until rotation and verification are
   complete. Never weaken signature verification to make an old deployment work.

## 8. Access control, privacy and quotas

- The sheet contains the participant personal data the client needs for operations: name, cédula,
  email, phone, city, Instagram and consent evidence. Share it only with the client's authorized
  Google accounts and the Apps Script owner, never "anyone with the link".
- The Apps Script owner can edit that one spreadsheet; the script has no database access. The
  backend writes to the spreadsheet and never reads it back.
- The connector is published as a web app because Supabase must reach it server-to-server. The
  HMAC signature is mandatory; an unsigned request cannot read or write anything. If the
  organisation cannot allow the required access mode, document the blocker rather than weakening
  authentication.
- The HMAC secret is stored only in Apps Script Script Properties and Supabase Edge Function
  secrets. It is never returned, logged, committed or placed in a client bundle.
- Script Properties are the only source of `SPREADSHEET_ID`, `DATA_TAB` and `STATUS_TAB`. A
  request cannot select another spreadsheet or tab.
- Apps Script is not unlimited: execution time, request and Sheets quotas apply. Monitor the
  script's **Executions** page and the maintenance `sheetProjections` result. A quota failure is a
  failed projection and uses the normal outbox backoff; it cannot change a payment.
- Formula injection is prevented by `rwSanitizeCellValue_` prefixing formula-leading text before
  `setValues`; do not remove it.
- No ticket token, QR code or attendance record is produced or exported by the current purchase
  flow. The ticket-era columns remain in the sheet shape but carry no ticket or attendance data;
  `Ingreso` is always `No` and the other ticket-era cells are empty.

## 9. What the client cannot do

- Cannot change payment status, order status, participant data or admission counts: those fields
  are overwritten from PostgreSQL on the next successful sync.
- Cannot add an admission to the sheet and have it accepted anywhere; the sheet is not read back.
- Manual edits within the written range are overwritten. Edits below a shorter export are not
  cleared by the worker and must be removed manually.

## 10. Related documentation

- [data-model.md](data-model.md) — outbox and export schema.
- [environments.md](environments.md) — secrets, scheduler and deployment.
- [architecture.md](architecture.md) — overall flow.
- [api.md](api.md) — order and participant endpoints.
- [Apps Script README](../integrations/google-apps-script/README.md) — installation and connector
  contract.
