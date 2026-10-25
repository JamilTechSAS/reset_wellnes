# Environments, secrets and deployment

## 1. Environments

|              | `development`                               | `sandbox`                                                              | `production`                        |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| Purpose      | Local work                                  | Integration + ePayco test money                                        | Real sales                          |
| Database     | Local Supabase stack (Docker)               | Hosted Supabase project (separate)                                     | Hosted Supabase project (separate)  |
| ePayco       | Test mode (`EPAYCO_TEST=true`)              | Test mode                                                              | Production (`EPAYCO_TEST=false`)    |
| Wompi        | Dormant legacy webhook only                 | Dormant legacy webhook only                                            | Dormant legacy webhook only         |
| Email        | Disabled by default (`EMAIL_ENABLED=false`) | Disabled in this phase (`EMAIL_ENABLED=false`); welcome email deferred | Resend verified domain when enabled |
| `verify_jwt` | per function in `config.toml`               | same                                                                   | same                                |

Rules that the configuration loader enforces (see `_shared/config/env.ts`):

- `APP_ENV` is the only switch. `production` requires `EPAYCO_TEST=false`; test credentials
  must never settle a real order, and the loader refuses the combination at startup.
- `EPAYCO_BASE_URL` may only be overridden in development (integration tests point it at a fake).
- `PAYMENT_PROVIDER` accepts only `epayco`. `wompi` and `mercadopago` are rejected at
  startup as retired, so a stale environment cannot select a gateway that builds no checkout.
- `WOMPI_*` values are optional and only read by the dormant `webhooks-wompi` function; they
  are never required and are validated by prefix only when present.
- Outside development: `https` is required for public URLs, CORS origins must be explicit
  origins (no `*`, no localhost), `MAINTENANCE_API_TOKEN` is required (≥32 chars), email
  credentials are required when `EMAIL_ENABLED=true` (the default), and `LOG_LEVEL=debug` is
  refused.
- Operator authentication has **no environment variable**: it is Supabase Auth + the
  `public.operators` table (see §6 "Operator accounts").
- `SHEETS_ENABLED=true` requires `GOOGLE_APPS_SCRIPT_URL` (the deployed Apps Script `/exec` URL)
  and `GOOGLE_APPS_SCRIPT_SECRET` (32-512 characters, no whitespace); with the default `false`,
  the projection is skipped and every other job still runs. The spreadsheet ID and the `Datos` /
  `Estado` tab names live in Apps Script Script Properties, not in this environment. The tabs must
  already exist: the connector writes values only and does not create tabs. `RATE_LIMIT_ENABLED`
  defaults to `true`; `false` is an emergency switch that removes application-level abuse control.
- This phase deliberately sends no buyer email: `EMAIL_ENABLED=false`. Ticket emails are
  discontinued and the purchase welcome email is deferred until its HTML design is approved.
- The server-side Supabase key must be an `sb_secret_*` key or a legacy `service_role` JWT; a
  publishable/anon key is rejected. (Supabase is deprecating the legacy `anon`/`service_role`
  JWTs by the end of 2026 — new keys use `sb_publishable_*` / `sb_secret_*`.) Since Phase 6D.1 it
  is read from the first of these that is set: `SUPABASE_SECRET_KEY` (explicit override;
  local/self-hosted), `SUPABASE_SECRET_KEYS` (the platform's JSON bag — its `default` entry, or a
  one-entry bag whatever the entry is named) or `SUPABASE_SERVICE_ROLE_KEY` (the platform's legacy
  key). This replaces the earlier requirement that a hosted deployment define
  `SUPABASE_SECRET_KEY`, which the reserved `SUPABASE_` prefix does not allow.
- A missing or inconsistent configuration aborts the request with a `ConfigError`; the `health`
  function reports the offending **variable names** (never values) outside production.

## 2. Secrets inventory

| Secret                                                                                                                       | Where it lives                                                                                                              | Who can see it         | Notes                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| Server-side Supabase key (`SUPABASE_SECRET_KEY`, or the platform's `SUPABASE_SECRET_KEYS` bag / `SUPABASE_SERVICE_ROLE_KEY`) | Edge Function secrets; on hosted Supabase the platform provides the bag                                                     | Backend only           | Full database authority. Never in the frontend, never in logs                    |
| `EPAYCO_PRIVATE_KEY`                                                                                                         | Edge Function secrets                                                                                                       | Backend only           | Creates the Smart Checkout session / validates transactions                      |
| `EPAYCO_P_KEY`                                                                                                               | Edge Function secrets                                                                                                       | Backend only           | Provider credential, never in the browser                                        |
| `EPAYCO_CUST_ID_CLIENTE`                                                                                                     | Edge Function secrets                                                                                                       | Backend only           | Merchant id used by the checkout session                                         |
| `RESEND_API_KEY`                                                                                                             | Edge Function secrets                                                                                                       | Backend only           | Email sending (outbox dispatcher)                                                |
| `MAINTENANCE_API_TOKEN`                                                                                                      | Edge Function secrets + Supabase Vault (`maintenance_api_token`)                                                            | Backend/operators      | Bearer for `orders-maintenance` (expiry, email, reconciliation, cleanup, Sheets) |
| `EPAYCO_PUBLIC_KEY`                                                                                                          | Edge Function secrets                                                                                                       | Public by design       | Merchant identification; the browser only receives the backend's session id      |
| `SUPABASE_PUBLISHABLE_KEY`                                                                                                   | Frontend, operator sign-in only (legacy `anon` key equivalent)                                                              | Public by design       | Mints Supabase Auth sessions for operators; reads nothing (zero Data API grants) |
| Google Apps Script connector                                                                                                 | Edge Function secrets (`GOOGLE_APPS_SCRIPT_URL`, `GOOGLE_APPS_SCRIPT_SECRET`); spreadsheet ID and tabs in Script Properties | Backend + script owner | Signed write to the configured spreadsheet; script has no database access        |
| `.env.local`                                                                                                                 | Developer machine                                                                                                           | Developer              | Git-ignored; `.env.example` is the template                                      |

Set hosted secrets per environment (never reuse the same file across environments):

```bash
# sandbox project
npx supabase secrets set --env-file .env.sandbox --project-ref <sandbox-ref>
# production project
npx supabase secrets set --env-file .env.production --project-ref <prod-ref>
npx supabase secrets list --project-ref <prod-ref>   # names + digests, never values
```

`.env.sandbox` / `.env.production` are git-ignored. Real ePayco credentials are only ever obtained
from the merchant dashboard ("Integraciones > Llaves API"). Wompi keys are legacy.

**Current staging status (last verified 2026-10-24; the Apps Script code change did not touch
staging).** The staging project `soqmdpqjjdmdhtgsutab` has the ePayco merchant values, the
public/return URLs, the CORS origin and the maintenance token; its `GET /health` returns `200` with
`APP_ENV=sandbox`. Google Sheets is **not configured**: there is no `SHEETS_ENABLED` secret (so the
default `false` applies) and no `GOOGLE_APPS_SCRIPT_*` secret. Production is a separate project
(`pzogdjjdkgolybfcegcs`) and must not be used for staging validation. Do not infer staging readiness
from health alone: migrations, Edge Functions and the Vercel build are deployed separately (see
§5).

## 3. Scheduler (hosted project)

The maintenance job runs from the database itself (migration 015): `pg_cron` → `pg_net` →
`POST /orders-maintenance`, every 5 minutes. The endpoint expects the maintenance token; the
cron function reads it from **Supabase Vault**, so no secret lives in a migration or in the
repository. The Sheets projection runs last, after expiry, email, reconciliation, alerts and
cleanup. A participant projection is only written when this job actually runs; `QUEUED` does not
mean synced. Create the two secrets once per project:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the same MAINTENANCE_API_TOKEN>', 'maintenance_api_token');
```

Verify the job:

```sql
select jobid, jobname, schedule, command from cron.job where jobname = 'event-ticketing-maintenance';
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
```

If the extensions are unavailable (for example on a local database), the migration prints a
notice and the documented fallback is any caller that holds the token:

```bash
curl -X POST "$API_BASE_URL/orders-maintenance" -H "authorization: Bearer $MAINTENANCE_API_TOKEN"
```

## 4. Rotating the maintenance token

A credential is rotated without touching source code:

1. Generate the new value in the provider dashboard (for ePayco, the key being rotated).
2. Update the environment file (or secret) and re-deploy / re-set secrets.
3. Verify with `GET /health` — it reports which credential **prefix** was loaded, so a mismatch
   between environments is visible immediately.
4. Revoke the old value in the provider dashboard.
5. If a secret may have leaked, treat it as an incident (see [security.md](security.md)): rotate
   first, investigate second, and check `payment_events` / function logs for unexpected activity.

## 5. Deploying

```bash
# 1. Apply migrations to the target project (sandbox first, always)
npx supabase link --project-ref <ref>
npx supabase db push

# 2. Deploy functions (config.toml decides the JWT policy per function)
npm run functions:deploy

# 3. Smoke test
curl https://<ref>.supabase.co/functions/v1/health
```

Checklist before touching production:

- [ ] `npm run check` is green on the commit being deployed.
- [ ] Migrations were applied to sandbox and to a scratch project first.
- [ ] `CORS_ALLOWED_ORIGINS` lists the real frontend origin.
- [ ] The ePayco confirmation URL points at `…/functions/v1/webhooks-epayco`, the response URL
      points at the site's `/gracias`, and `EPAYCO_TEST=false` in production.
- [ ] Vault holds `project_url` and `maintenance_api_token`, and `cron.job` shows
      `event-ticketing-maintenance` (§3); expiry, emails, reconciliation, cleanup and Sheets are
      off the payment path but must still run.
- [ ] Operator accounts exist in Supabase Auth and in `public.operators` (§6); deactivated
      accounts are `is_active = false`.
- [ ] `RATE_LIMIT_ENABLED=true` (the emergency `false` is documented and temporary).
- [ ] If `SHEETS_ENABLED=true`: `GOOGLE_APPS_SCRIPT_URL` and `GOOGLE_APPS_SCRIPT_SECRET` are set;
      the Apps Script is deployed with `SPREADSHEET_ID`, `HMAC_SECRET`, and the tab properties in
      Script Properties; the spreadsheet is shared with the deploying account; `Datos` and
      `Estado` exist with enough rows/columns; and the signed `health` and `self_test` checks
      succeed. Create those tabs manually. The current `orders-maintenance` must be deployed. Use
      `SHEETS_ENABLED=false` in every environment where no scope has been agreed. Rotation is in
      [operations-google-sheets.md](operations-google-sheets.md#rotating-the-shared-secret).
- [ ] `EMAIL_ENABLED=true` only where sending is intended (never from a laptop).
- [ ] A test order has been run end to end in sandbox, including a declined card and a lost
      webhook recovered by reconciliation or the payment hint.

Rollback: functions are redeployed from the previous commit; migrations are **not** rolled back
automatically (they are append-only). A mistake in a migration is fixed by a new migration, which
is why the first migration of the project contains only conventions and enums.

## 6. Operator accounts

Operators are real Supabase Auth users; the backend only stores their authorization data in
`public.operators` (role `OPERATOR` or `ADMIN`, active flag). There is no password in the schema
and no shared operator secret.

```bash
# 1. Create the user. Two documented options:
#    a) Supabase dashboard: Authentication > Users > "Add user" (email + password, confirm).
#    b) Admin API with the server-side secret key:
curl -X POST "https://<project-ref>.supabase.co/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"puerta1@evento.example","password":"<strong password>","email_confirm":true}'

# 2. Grant the door role (SQL editor / psql; user_id is auth.users.id)
insert into public.operators (user_id, display_name, role)
values ('<auth-user-id>', 'Operador Puerta 1', 'OPERATOR');

# 3. Deactivate immediately when someone leaves the door
update public.operators set is_active = false where user_id = '<auth-user-id>';
```

A valid Supabase user without an active `operators` row gets `403 FORBIDDEN`; an expired or
invalid session gets `401 UNAUTHORIZED`. The scanner signs in with email + password (or a magic
link) and keeps the session on the device.

## 7. Local development

```bash
npm install
cp .env.example .env.local        # fill in values; local values are already pre-filled where possible
npm run db:start                  # needs a running Docker daemon
npx supabase status               # prints local API URL + keys for .env.local
npm run db:reset                  # migrations + seed
npm run functions:serve           # serves all functions using .env.local
```

`npm run functions:serve` currently cannot boot this backend on Supabase CLI ≥ 2.119: the CLI drops
`SUPABASE_*` names from an env file, and the backend requires exactly `SUPABASE_SECRET_KEY`, so
`/health` answers `500` locally. [phases/phase-06d.md](phases/phase-06d.md) §4 describes the Deno
launcher used to work around it while that stands.

The local stack is disposable: `npm run db:stop` and `npm run db:start` reset everything, and
`supabase db reset` re-applies migrations from scratch, which is the fastest way to prove that the
migration history is coherent. The pre-frontend closure verified the full stack on this machine
(PostgREST 16.4 + GoTrue + real keys, 22 migrations applied from zero); the probe matrix and
numbers are in [audits/pre-frontend-closure-01.md](audits/pre-frontend-closure-01.md).

## 8. Production topology (Vercel + Supabase)

```text
Browser
  └─ Vercel (Spanish frontend, static build + public config only)
       └─ Supabase Edge Functions (orders, events, checkin, webhooks-epayco,
            orders-maintenance, health)
                 └─ Supabase PostgreSQL (RLS on, no policies; the Data API is
                      used only by the backend with the secret key)
                           └─ ePayco (COP) · Resend (email) · Apps Script → Google Sheets (read-only)
```

Nothing in the browser is authoritative: price, inventory, payment state and attendance are
decided inside the Edge Functions and SQL; the frontend only sends input and renders the
documented responses ([api.md](api.md)).

| Piece                 | Deploys to                                    | Holds                                                                                             |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Spanish frontend      | Vercel (static / SPA build)                   | Public values only: functions base URL, event code, Supabase URL + publishable key (Auth sign-in) |
| Edge Functions        | Supabase project (`npm run functions:deploy`) | All backend secrets, set with `npx supabase secrets set` (§2)                                     |
| Database + migrations | Supabase project (`npx supabase db push`)     | Schema, RLS, explicit grants (migration `20261004150000`), `pg_cron` job, Vault secrets           |
| ePayco configuration  | ePayco merchant dashboard                     | Confirmation URL → `…/functions/v1/webhooks-epayco`; response URL → the Vercel site               |
| Resend domain         | Resend dashboard                              | Verified sender identity used by `EMAIL_FROM`                                                     |
| Spreadsheet           | Google Drive (client account)                 | Shared with the Apps Script owner; the connector only ever writes the configured tabs             |

### What lives where (Vercel vs Supabase)

- **Vercel (frontend)**: no private credential, ever. Only the functions base URL, the event code,
  and the Supabase project URL + publishable key for the operator sign-in flow (Supabase Auth
  only — with zero Data API grants, it cannot read a single row). The ePayco session id arrives
  from the backend at checkout time; no ePayco key is bundled.
- **Supabase (Edge Function secrets, per environment)**: `SUPABASE_URL` + the server-side key
  (`SUPABASE_SECRET_KEY` where the host allows defining it, otherwise the platform's
  `SUPABASE_SECRET_KEYS` bag — used only by the functions), the four ePayco values
  (`EPAYCO_PUBLIC_KEY`, `EPAYCO_PRIVATE_KEY`, `EPAYCO_P_KEY`, `EPAYCO_CUST_ID_CLIENTE`),
  `RESEND_API_KEY`, `MAINTENANCE_API_TOKEN`, and — when `SHEETS_ENABLED=true` —
  `GOOGLE_APPS_SCRIPT_URL` and `GOOGLE_APPS_SCRIPT_SECRET`. The Apps Script owner keeps the
  spreadsheet ID and tab names in Script Properties.
- **Vault (inside the database)**: `project_url` and `maintenance_api_token`, read by the
  `pg_cron` job (§3). Vault never holds ePayco/Resend credentials or the Apps Script secret — those
  stay in Edge Function secrets and Script Properties.
- **Non-secret backend settings** (also Edge Function env vars): `APP_ENV`, `API_BASE_URL`,
  `PUBLIC_WEB_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `EPAYCO_TEST`, `EMAIL_ENABLED`, `EMAIL_FROM`,
  `EMAIL_REPLY_TO`, `ALERT_EMAIL_TO` (optional payment-alert digest recipients; invalid entries
  are ignored and reported, never a config error), `PAYMENT_RETURN_URL` (legacy fallback: `WOMPI_REDIRECT_URL`),
  `ORDER_RESERVATION_MINUTES`, `EMAIL_DISPATCH_BATCH_SIZE`,
  `EMAIL_ASSETS_BASE_URL` (public directory hosting the post-purchase email images; defaults to
  `<PUBLIC_WEB_BASE_URL>/correo/img`),
  `RATE_LIMIT_ENABLED`, `SHEETS_ENABLED`, `GOOGLE_APPS_SCRIPT_URL`,
  `LOG_LEVEL`, `TIMEZONE`, `SERVICE_NAME`. `APP_ENV` decides whether ePayco test mode is allowed;
  `GOOGLE_APPS_SCRIPT_SECRET` is a secret, not a public setting. `TICKET_BASE_URL` is a legacy
  variable that no purchase flow uses.

### Sandbox/staging vs production

Two separate hosted projects, never mixed:

|             | Sandbox (staging)    | Production                     |
| ----------- | -------------------- | ------------------------------ |
| `APP_ENV`   | `sandbox`            | `production`                   |
| ePayco mode | `EPAYCO_TEST=true`   | `EPAYCO_TEST=false`            |
| Email       | Resend test sender   | Verified domain (`EMAIL_FROM`) |
| Data        | Disposable test data | Real orders                    |

`EPAYCO_BASE_URL` cannot be overridden outside `development`, so a test credential can never be
pointed at a production endpoint. The frontend points at the sandbox project URL in preview
deployments and at the production project URL in production (Vercel environment variables).

### Production release record (2026-10-25)

Project `pzogdjjdkgolybfcegcs` was brought from the 2026-10-07 schema to the current one and its
catalogue was created for the first time:

1. **Migrations.** `npx supabase db push --project-ref pzogdjjdkgolybfcegcs` applied the 22
   migrations pending after `20261007233000`, in timestamp order. The set is additive — it drops
   no table, view, column or row — and it leaves the legacy `tickets` / `attendance` / `consents` /
   `email_deliveries` tables in place while no longer feeding them.
2. **Catalogue.** [../supabase/ops/production/seed_reset_sunset_event.sql](../supabase/ops/production/seed_reset_sunset_event.sql)
   creates `RESET-SUNSET-2026` (capacity 100, venue Terraza del hotel GHL, Montería), the `GENERAL`
   ticket type with its Preventa and General tiers, the retired `DOUBLE_EXPERIENCE` bundle kept
   inactive, and the active `SHARE_EXPERIENCE` bundle (3 admissions, COP 509.700). It is idempotent
   and never writes `quantity_sold` / `quantity_reserved`, so it is safe to re-run.
3. **Functions.** `health`, `events`, `webhooks-epayco`, `orders`, `orders-maintenance`, `checkin`
   and `tickets` were deployed against that ref. `webhooks-wompi` is deliberately left on its
   previous version and dormant: Wompi is retired and no new delivery can arrive.
4. **Non-secret configuration** set as Edge Function secrets: `APP_ENV=production`,
   `PAYMENT_PROVIDER=epayco`, `EPAYCO_TEST=false`, `PUBLIC_WEB_BASE_URL`,
   `API_BASE_URL`, `PAYMENT_RETURN_URL=https://www.resetwellness.com.co/gracias`,
   `CORS_ALLOWED_ORIGINS=https://www.resetwellness.com.co,https://resetwellness.com.co`,
   `EMAIL_ENABLED=false`, `EMAIL_ASSETS_BASE_URL` and `MAINTENANCE_API_TOKEN`.

**Outstanding:** the four ePayco credentials (`EPAYCO_PUBLIC_KEY`, `EPAYCO_PRIVATE_KEY`,
`EPAYCO_P_KEY`, `EPAYCO_CUST_ID_CLIENTE`) are not configured in production. Until they are,
`assertPaymentReady` refuses every order-creating endpoint and `/health` reports an incomplete
configuration — the catalogue and quoting work, checkout does not. Add them with
`npx supabase secrets set --project-ref pzogdjjdkgolybfcegcs --env-file <file>` (never on a command
line, never in the repository), then confirm `/health` returns 200 before publishing the frontend.

### Frontend rules

The frontend must not call `/rest/v1` or `/graphql/v1`, must never receive a secret/private key,
and must not compute prices, payment states or admissions locally — those come only from the Edge
Functions ([api.md](api.md) §5).

The landing page's content is the client's, from the handover ZIP; values the client has not
supplied are rendered as "por confirmar" rather than invented
([phases/phase-06c.md](phases/phase-06c.md) §5). `VITE_EVENT_CODE` / `VITE_TICKET_TYPE_CODE` must
match the event and ticket-type rows in the target project. The frontend's **build default** is the production
project (`https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1`), while `vite dev` uses the local
stack ([phases/phase-06d.md](phases/phase-06d.md) §3). A staging Vercel build **must** set
`VITE_API_BASE_URL` to `https://soqmdpqjjdmdhtgsutab.supabase.co/functions/v1`; otherwise it will
call the production backend. Verify the host in the browser network panel after deploying. The official brand fonts were not
delivered: the page loads the substitute faces (Fraunces + Questrial) from the Google Fonts CDN,
with system fonts behind them, and self-hosting them is an open pre-launch item.
