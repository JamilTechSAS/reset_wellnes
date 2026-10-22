# Google Sheets operational projection

**Status: implemented (Phase 5).** The project's PostgreSQL is the source of truth; the client's
spreadsheet is a read-oriented operational view written by the backend through a per-ticket
outbox. It is **not** required for payments, ticket issuance or check-in.

## 1. Non-negotiable rules

1. **PostgreSQL is the source of truth.** The sheet is a projection, never authoritative.
2. **Read-only.** Google has no write path into the backend: the service account can only edit
   the one spreadsheet the client shared with it, and the only backend objects it touches are
   `operational_export` (read) and the Sheets API (write).
3. Manual edits in the sheet are **overwritten** by the next successful sync. The `Estado` tab
   says so explicitly.
4. A Google outage can never block a payment, a ticket or a check-in. Enqueueing is a local
   insert; the HTTP call happens only in the maintenance worker, after all payment work is
   committed.
5. With `SHEETS_ENABLED=false` (the default), nothing is claimed and nothing is written; every
   other maintenance job still runs.

## 2. Architecture

```text
any change to tickets / participants / attendance / consents
   └── trigger app_private.enqueue_sheet_projection()          (same transaction)
        └── public.sheets_projections     one row per ticket (PK ticket_id), status QUEUED
             └── maintenance run (pg_cron → POST /orders-maintenance)
                  ├── claim_sheet_projections(SKIP LOCKED) → SYNCING, attempt_count + 1
                  ├── read public.operational_export (SQL whitelist, service_role only)
                  ├── write the COMPLETE grid to the client's sheet (values:batchUpdate)
                  └── finish_sheet_projections(SYNCED | FAILED)
```

- **Collapsing:** one row per ticket, so any number of changes (participant edit, consent,
  attendance, ticket status) becomes one logical projection event.
- **Mid-write changes:** `finish_sheet_projections` updates only rows still in `SYNCING`. A change
  that arrived while the worker was writing was re-queued by its trigger and stays queued for the
  next run — the newer state is never marked as synced.
- **Failures:** claimed rows go back to `FAILED` with a backoff (1 m, 5 m, 15 m, 1 h, 6 h) and a
  6-attempt ceiling. A row that exhausted its budget stays `FAILED` and visible until **new data
  arrives**, which re-queues it and resets the counter. A Google or database failure is reported
  in the maintenance response (`sheetProjections.error`, `jobErrors`) and never affects another
  job.
- **Stale claims:** a worker that died after claiming leaves `SYNCING` rows; they become
  reclaimable after 15 minutes.

## 3. Configuration and setup

```bash
# 1. Create a dedicated service account in Google Cloud and a JSON key (PKCS#8).
# 2. Share the client's spreadsheet with the service account email as EDITOR (not "anyone").
# 3. Create the tabs (Datos, Estado) or let the first sync create them.
# 4. Set the Edge Function secrets:
SHEETS_ENABLED=true
GOOGLE_SERVICE_ACCOUNT_EMAIL=<name>@<project>.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
GOOGLE_SPREADSHEET_ID=<id from the spreadsheet URL>
GOOGLE_SHEETS_DATA_TAB=Datos      # optional, defaults to Datos
GOOGLE_SHEETS_STATUS_TAB=Estado   # optional, defaults to Estado
# 5. Run one maintenance call (or wait for the scheduler) and check the sheet + Estado tab.
```

The private key lives only in Edge Function secrets, is masked in the log-safe config projection,
and is never included in an error. `GOOGLE_SPREADSHEET_ID` is the only Google identifier the
backend needs.

## 4. The sheet

`Datos` — one row per ticket, rebuilt completely on every successful sync (self-healing after a
failure; deleted/cancelled tickets disappear). All values are written with
`valueInputOption: "RAW"`, so a participant value starting with `=` is text, never a formula.

| Column (ES)                                               | Formatting                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `Evento` … `Instagram`                                    | Raw values (empty cell when not provided)                          |
| `Tipo de entrada` / `Etapa de venta`                      | Names from the catalog                                             |
| `Precio` / `Moneda`                                       | `$95.000` via the tested COP formatter + `COP`                     |
| `Estado de la orden`                                      | Spanish label from the Phase 1 vocabulary                          |
| `Estado del pago`                                         | Spanish label (+ raw Wompi status when known)                      |
| `Estado de la entrada`                                    | Spanish label                                                      |
| `Ingreso` / `Fecha de ingreso`                            | `Sí`/`No` + America/Bogota timestamp                               |
| `Autorización de datos` / `Autorización próximos eventos` | `Sí`/`No` (+ policy version and captured date for data processing) |
| `Creada`                                                  | America/Bogota timestamp                                           |

`Estado` — key/value tab written after each successful data sync: last sync time, total/synced/
queued/in-progress/failed counts, and the reminder that manual edits are overwritten.

## 5. Access control and privacy

- The sheet contains the operational personal data the client explicitly needs for the door
  (name, cédula, email, phone, city, Instagram, consents). It is shared **only** with the client's
  Google account(s), never "anyone with the link".
- The service account has edit access to that one spreadsheet and no database access; the backend
  writes to the spreadsheet and never reads it back.
- `operational_export` is a SQL view (`security_invoker`) readable only by the service role; RLS
  stays enabled everywhere else. Adding a column to the view is a deliberate migration, not an
  accident of `select *`.
- The projection is bounded: `SHEETS_MAX_ROWS = 5000`; exceeding it is logged loudly instead of
  silently writing a partial operational view.

## 6. Troubleshooting

| Symptom                               | Check                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Sheet not updating                    | `SHEETS_ENABLED=true` and credentials set; maintenance runs (cron job or manual call)                                                        |
| `Estado` shows failures / "Con error" | Read `error` in the maintenance response; `select status, attempt_count, last_error from public.sheets_projections where status <> 'SYNCED'` |
| One row stuck                         | It exhausted its 6 attempts; fix the cause (sheet access, id) and touch the underlying ticket/participant to re-queue it                     |
| Google returns 403/404                | Spreadsheet shared with the service account? Id/tab names correct?                                                                           |
| Turn it off temporarily               | `SHEETS_ENABLED=false` — every other job keeps running                                                                                       |

## 7. What the client cannot do

- Cannot change payment status, ticket status or attendance: those fields are overwritten from
  PostgreSQL on every sync.
- Manual attendance overrides happen through the check-in API (audited in `attendance`), never in
  the sheet.
