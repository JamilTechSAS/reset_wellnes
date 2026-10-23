# Environments, secrets and deployment

## 1. Environments

|                | `development`                                               | `sandbox`                          | `production`                       |
| -------------- | ----------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| Purpose        | Local work                                                  | Integration + Wompi test money     | Real sales                         |
| Database       | Local Supabase stack (Docker)                               | Hosted Supabase project (separate) | Hosted Supabase project (separate) |
| Wompi          | Sandbox (`pub_test_*`…)                                     | Sandbox                            | Production (`pub_prod_*`…)         |
| Wompi base URL | `https://sandbox.wompi.co/v1` (overridable for local fakes) | `https://sandbox.wompi.co/v1`      | `https://production.wompi.co/v1`   |
| Email          | Disabled by default (`EMAIL_ENABLED=false`)                 | Resend test sender                 | Resend verified domain             |
| `verify_jwt`   | per function in `config.toml`                               | same                               | same                               |

Rules that the configuration loader enforces (see `_shared/config/env.ts`):

- `APP_ENV` is the only switch. `production` is the only value that selects the production Wompi
  environment; credentials whose prefix does not match are rejected **at startup**.
- `WOMPI_BASE_URL` may only be overridden in development.
- Outside development: `https` is required for public URLs, CORS origins must be explicit
  origins (no `*`, no localhost), `MAINTENANCE_API_TOKEN` is required (≥32 chars), email
  credentials are required when `EMAIL_ENABLED=true` (the default), and `LOG_LEVEL=debug` is
  refused.
- Operator authentication has **no environment variable**: it is Supabase Auth + the
  `public.operators` table (see §6 "Operator accounts").
- `SHEETS_ENABLED=true` requires `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` (a PKCS#8
  PEM) and `GOOGLE_SPREADSHEET_ID`; with the default `false`, the projection is skipped and every
  other job still runs. `RATE_LIMIT_ENABLED` defaults to `true`; `false` is an emergency switch
  that removes application-level abuse control.
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

| Secret                                                                                                                       | Where it lives                                                                                        | Who can see it    | Notes                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| Server-side Supabase key (`SUPABASE_SECRET_KEY`, or the platform's `SUPABASE_SECRET_KEYS` bag / `SUPABASE_SERVICE_ROLE_KEY`) | Edge Function secrets; on hosted Supabase the platform provides the bag                               | Backend only      | Full database authority. Never in the frontend, never in logs                    |
| `WOMPI_PRIVATE_KEY`                                                                                                          | Edge Function secrets                                                                                 | Backend only      | Used for `GET /v1/transactions/{id}`                                             |
| `WOMPI_INTEGRITY_SECRET`                                                                                                     | Edge Function secrets                                                                                 | Backend only      | Signs checkout amounts; the frontend gets only the hash                          |
| `WOMPI_EVENTS_SECRET`                                                                                                        | Edge Function secrets                                                                                 | Backend only      | Verifies webhook authenticity                                                    |
| `RESEND_API_KEY`                                                                                                             | Edge Function secrets                                                                                 | Backend only      | Email sending (outbox dispatcher)                                                |
| `MAINTENANCE_API_TOKEN`                                                                                                      | Edge Function secrets + Supabase Vault (`maintenance_api_token`)                                      | Backend/operators | Bearer for `orders-maintenance` (expiry, email, reconciliation, cleanup, Sheets) |
| `WOMPI_PUBLIC_KEY`                                                                                                           | Backend + frontend checkout                                                                           | Public by design  | Only ever used to identify the merchant                                          |
| `SUPABASE_PUBLISHABLE_KEY`                                                                                                   | Frontend, operator sign-in only (legacy `anon` key equivalent)                                        | Public by design  | Mints Supabase Auth sessions for operators; reads nothing (zero Data API grants) |
| Google service account                                                                                                       | Edge Function secrets (`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SPREADSHEET_ID`) | Backend           | Writes the client's spreadsheet; no database access                              |
| `.env.local`                                                                                                                 | Developer machine                                                                                     | Developer         | Git-ignored; `.env.example` is the template                                      |

Set hosted secrets per environment (never reuse the same file across environments):

```bash
# sandbox project
npx supabase secrets set --env-file .env.sandbox --project-ref <sandbox-ref>
# production project
npx supabase secrets set --env-file .env.production --project-ref <prod-ref>
npx supabase secrets list --project-ref <prod-ref>   # names + digests, never values
```

`.env.sandbox` / `.env.production` are git-ignored. Real Wompi credentials are only ever obtained
from the merchant dashboard ("Developers > Secrets for technical integration").

**Current hosted status (Phase 6D.1, 2026-10-07): the Supabase key resolves; the rest is still
unset.** No application secret is configured on `pzogdjjdkgolybfcegcs` (`npx supabase secrets list`
shows only the platform-reserved names), so `GET /health` answers `500` — now naming **six**
variables instead of seven, because the server-side Supabase key comes from the platform's own
`SUPABASE_SECRET_KEYS` bag and is no longer something an operator must define. The remaining six are
the four `WOMPI_*` values, `PUBLIC_WEB_BASE_URL` and `API_BASE_URL` (plus `CORS_ALLOWED_ORIGINS`
and `MAINTENANCE_API_TOKEN` once `APP_ENV` is `sandbox`). Until they are set, every public endpoint
— including the landing page's `GET /events/{code}` — returns `INTERNAL_ERROR`, and responses carry
no `access-control-allow-origin` header at all.

## 3. Scheduler (hosted project)

The maintenance job runs from the database itself (migration 015): `pg_cron` → `pg_net` →
`POST /orders-maintenance`, every 5 minutes. The endpoint expects the maintenance token; the
cron function reads it from **Supabase Vault**, so no secret lives in a migration or in the
repository. Create the two secrets once per project:

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

1. Generate the new value in the provider dashboard (for Wompi, both keys of the same environment).
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
- [ ] Wompi event URL for the environment points at `…/functions/v1/webhooks-wompi`, and the
      production one is configured with production credentials.
- [ ] Vault holds `project_url` and `maintenance_api_token`, and `cron.job` shows
      `event-ticketing-maintenance` (§3); expiry, emails, reconciliation, cleanup and Sheets are
      off the payment path but must still run.
- [ ] Operator accounts exist in Supabase Auth and in `public.operators` (§6); deactivated
      accounts are `is_active = false`.
- [ ] `RATE_LIMIT_ENABLED=true` (the emergency `false` is documented and temporary).
- [ ] If `SHEETS_ENABLED=true`: the client's spreadsheet is shared with the service account, the
      tabs exist (or the first sync creates them), and `SHEETS_ENABLED=false` was used in every
      environment where no scope has been agreed.
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
       └─ Supabase Edge Functions (orders, events, tickets, checkin, webhooks-wompi,
            orders-maintenance, health)
                 └─ Supabase PostgreSQL (19 tables, RLS on, no policies; the Data API is
                      used only by the backend with the secret key)
                           └─ Wompi (COP) · Resend (email) · Google Sheets (read-only projection)
```

Nothing in the browser is authoritative: price, inventory, payment state, ticket validity and
attendance are decided inside the Edge Functions and SQL; the frontend only sends input and
renders the documented responses ([api.md](api.md)).

| Piece                 | Deploys to                                    | Holds                                                                                                                 |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Spanish frontend      | Vercel (static / SPA build)                   | Public values only: functions base URL, `WOMPI_PUBLIC_KEY`, event code, Supabase URL + publishable key (Auth sign-in) |
| Edge Functions        | Supabase project (`npm run functions:deploy`) | All backend secrets, set with `npx supabase secrets set` (§2)                                                         |
| Database + migrations | Supabase project (`npx supabase db push`)     | Schema, RLS, explicit grants (migration `20261004150000`), `pg_cron` job, Vault secrets                               |
| Wompi configuration   | Wompi merchant dashboard                      | Event URL → `…/functions/v1/webhooks-wompi`; redirect → the Vercel site                                               |
| Resend domain         | Resend dashboard                              | Verified sender identity used by `EMAIL_FROM`                                                                         |
| Spreadsheet           | Google Drive (client account)                 | Shared with the service account; our side only ever writes to it                                                      |

### What lives where (Vercel vs Supabase)

- **Vercel (frontend)**: no private credential, ever. Only the functions base URL, the Wompi
  **public** key (merchant identification), the event code, and the Supabase project URL +
  publishable key for the operator sign-in flow (Supabase Auth only — with zero Data API grants,
  it cannot read a single row). Anything that is not safe in a browser tab does not belong here.
- **Supabase (Edge Function secrets, per environment)**: `SUPABASE_URL` + the server-side key
  (`SUPABASE_SECRET_KEY` where the host allows defining it, otherwise the platform's
  `SUPABASE_SECRET_KEYS` bag — used only by the functions), the four Wompi values (`WOMPI_PUBLIC_KEY`,
  `WOMPI_PRIVATE_KEY`, `WOMPI_INTEGRITY_SECRET`, `WOMPI_EVENTS_SECRET`), `RESEND_API_KEY`,
  `MAINTENANCE_API_TOKEN`, and — when `SHEETS_ENABLED=true` — `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
  `GOOGLE_PRIVATE_KEY`, `GOOGLE_SPREADSHEET_ID`.
- **Vault (inside the database)**: `project_url` and `maintenance_api_token`, read by the
  `pg_cron` job (§3). Vault never holds Wompi/Resend/Google keys — those stay in Edge Function
  secrets.
- **Non-secret backend settings** (also Edge Function env vars): `APP_ENV`, `API_BASE_URL`,
  `PUBLIC_WEB_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `TICKET_BASE_URL`, `EMAIL_ENABLED`, `EMAIL_FROM`,
  `EMAIL_REPLY_TO`, `ALERT_EMAIL_TO` (optional payment-alert digest recipients; invalid entries
  are ignored and reported, never a config error), `PAYMENT_RETURN_URL` (legacy fallback: `WOMPI_REDIRECT_URL`),
  `ORDER_RESERVATION_MINUTES`, `EMAIL_DISPATCH_BATCH_SIZE`,
  `RATE_LIMIT_ENABLED`, `SHEETS_ENABLED`, `GOOGLE_SHEETS_DATA_TAB`, `GOOGLE_SHEETS_STATUS_TAB`,
  `LOG_LEVEL`, `TIMEZONE`, `SERVICE_NAME`. `APP_ENV` is the one switch that decides the Wompi
  environment; the loader rejects credentials whose prefix does not match it.

### Sandbox/staging vs production

Two separate hosted projects, never mixed:

|                   | Sandbox (staging)                    | Production                           |
| ----------------- | ------------------------------------ | ------------------------------------ |
| `APP_ENV`         | `sandbox`                            | `production`                         |
| Wompi credentials | `pub_test_*` / `prv_test_*` prefixes | `pub_prod_*` / `prv_prod_*` prefixes |
| Wompi base URL    | `https://sandbox.wompi.co/v1`        | `https://production.wompi.co/v1`     |
| Email             | Resend test sender                   | Verified domain (`EMAIL_FROM`)       |
| Data              | Disposable test data                 | Real orders                          |

`WOMPI_BASE_URL` cannot be overridden outside `development`, so a sandbox key can never reach the
production endpoint and vice versa. The frontend points at the sandbox project URL in preview
deployments and at the production project URL in production (Vercel environment variables).

### Frontend rules

The frontend must not call `/rest/v1` or `/graphql/v1`, must never receive a secret/private key,
and must not compute prices, payment states or ticket validity locally — those come only from the
Edge Functions ([api.md](api.md) §5).

The landing page's content is the client's, from the handover ZIP; values the client has not
supplied are rendered as "por confirmar" rather than invented
([phases/phase-06c.md](phases/phase-06c.md) §5). `VITE_EVENT_CODE` / `VITE_TICKET_TYPE_CODE` must
match the event and ticket-type rows in the target project. The frontend targets the hosted project
by default: `vite build` uses `https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1` and
`vite dev` the local stack ([phases/phase-06d.md](phases/phase-06d.md) §3) — the hosted project
itself still needs the secrets above before it can answer. The official brand fonts were not
delivered: the page loads the substitute faces (Fraunces + Questrial) from the Google Fonts CDN,
with system fonts behind them, and self-hosting them is an open pre-launch item.
