# Google Sheets connector — Apps Script

This standalone Apps Script project writes the Reset Wellness operational projection. It
replaces the previous Google Cloud service-account/private-key integration. The backend holds
only the deployed `/exec` URL and a shared HMAC secret.

The spreadsheet ID and tab names are stored in Apps Script **Script Properties**. A request can
select only the fixed `data` or `status` grid; it cannot choose a spreadsheet, tab or arbitrary
range.

## Files

- `Code.gs` — web-app entrypoint and spreadsheet operations.
- `lib.js` — signature verification, replay protection, payload validation and formula-safe cell
  handling. Apps Script loads it into the same global scope as `Code.gs`.
- `appsscript.json` — V8 manifest. Adjust `webapp.access` only if the organisation's policy
  requires a different minimum.

## Install

1. Sign in to Google Apps Script with the Google account that owns the staging spreadsheet.
2. Create a **standalone** project (`script.new` or Apps Script home → New project).
3. Replace `Code.gs` with this repository's `Code.gs`, add `lib.js` as a second script file, and
   replace the manifest with `appsscript.json` (Project Settings → Show "appsscript.json").
4. Create the spreadsheet and manually create the `Datos` and `Estado` tabs. The script does not
   create them. Give each tab at least the rows/columns of the grid it will receive; the connector
   writes an exact range from `A1` and does not insert rows, columns or sheets.
5. In Project Settings → Script Properties, set:

   | Property         | Required | Default  |
   | ---------------- | -------- | -------- |
   | `SPREADSHEET_ID` | yes      | —        |
   | `HMAC_SECRET`    | yes      | —        |
   | `DATA_TAB`       | no       | `Datos`  |
   | `STATUS_TAB`     | no       | `Estado` |

   `HMAC_SECRET` must be at least 32 characters with no whitespace. Generate it locally into a
   git-ignored file without printing it, for example:

   ```bash
   umask 077
   printf 'GOOGLE_APPS_SCRIPT_SECRET=%s\n' \
     "$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))")" \
     > .env.staging.secrets
   chmod 600 .env.staging.secrets
   ```

   Copy the generated value into Script Properties without printing it to a chat or commit. Store
   the same value in Supabase staging as `GOOGLE_APPS_SCRIPT_SECRET`. Never commit it, paste it into
   documentation or a chat, or log it. Do not reuse it across environments.

6. Deploy → New deployment → **Web app**:
   - Execute as: **Me**
   - Who has access: the minimum that permits the Supabase server-to-server call. With the
     standard Google account option this is **Anyone**; the HMAC signature is mandatory and
     unauthenticated requests are rejected. If your organisation forbids that access mode,
     stop and document the blocker instead of weakening the signature check.
7. Authorize the script. Copy the deployed URL ending in `/exec`.
8. Add the URL to the git-ignored staging env file created in step 5 (do not overwrite it):

   ```bash
   printf 'GOOGLE_APPS_SCRIPT_URL=%s\n' \
     'https://script.google.com/macros/s/<deployment-id>/exec' \
     >> .env.staging.secrets
   ```

9. From the repository, run the signed checks without printing the secret:

   ```bash
   node --env-file=.env.staging.secrets scripts/sheets-connector-check.ts health
   node --env-file=.env.staging.secrets scripts/sheets-connector-check.ts self_test
   ```

   `self_test` creates a temporary tab, writes and reads one cell, then deletes the tab. It does
   not touch `Datos` or `Estado`.

## Request contract

The HTTP body is a JSON envelope:

```json
{
  "version": 1,
  "timestamp": 1792829768,
  "nonce": "base64url-random-32-bytes",
  "payload": "{\"operation\":\"health\"}",
  "signature": "base64url-hmac-sha256"
}
```

`payload` is a **string**, not a nested object. The signed canonical message is exactly:

```text
v1\n{timestamp}\n{nonce}\n{payload}
```

The client and verifier use UTF-8 and base64url without padding. Requests outside a ±300 second
window are rejected; nonces are consumed under a script lock for 600 seconds. The body is bounded
at 9 MiB and the payload at 8 MiB before parsing. The response is always HTTP 200 from Content
Service, so `ok` must be checked:

```json
{ "ok": true, "data": { "operation": "health", "...": "..." } }
```

```json
{ "ok": false, "error": { "code": "UNAUTHORIZED", "message": "..." } }
```

## Security notes

- The Apps Script runtime can read Script Properties. The secret is never returned, logged or
  included in an error. `doGet` and every unsigned/invalid POST return a structured failure
  without touching the spreadsheet.
- The script never logs request bodies, participant data, signatures or secrets.
- `setValues` interprets a leading `=` as a formula; `rwSanitizeCellValue_` prefixes formula
  markers (`=`, `+`, `-`, `@`, tab, CR, LF) with the Sheets text marker `'` so the value is stored
  as text. Keep this behaviour when editing the grid writer.
- The app writes only the configured `DATA_TAB` or `STATUS_TAB`, from `A1`, using the supplied
  grid. It does not clear rows below the written range; the backend intentionally preserves that
  existing behaviour. A target tab that is too small fails rather than resizing itself.
- A retry rewrites the same complete grid; it does not append rows.
- The script can only access the spreadsheet owned/shared with the deploying account. Its OAuth
  scope is `spreadsheets`; there is no database access.
- If the HMAC secret may have leaked, disable `SHEETS_ENABLED` on the backend, rotate the secret in
  Script Properties and Supabase together, then run the signed health/self-test again. Never
  remove the signature check or expose an unauthenticated write endpoint to fix an outage.

## Quotas

Apps Script is not unlimited: execution time, URL Fetch/request, script runtime and Sheets
operations are subject to Google quotas. Monitor **Executions** in the Apps Script editor and the
maintenance `sheetProjections` result. A quota failure is a failed projection and will use the
normal outbox backoff; it never changes a payment or participant.

## Limits

- `data`: at most 5,001 rows (header + 5,000 participants) and 22 columns.
- `status`: at most 20 rows and 2 columns.
- Each cell is a string (max 10,000 characters), finite number, or boolean.
- Missing `Datos`/`Estado` tabs and missing properties fail closed with `MISSING_TAB` or
  `CONFIGURATION`.

## Manual verification

The local tests cover signature vectors, nonce replay, payload validation, formula-safe cells, the
TypeScript transport contract, and the `Code.gs` entrypoint against a stubbed Apps Script runtime.
They do **not** execute Google's hosted Apps Script services or a real spreadsheet. After
deploying, run the two signed checks in step 9 and confirm `self_test` cleans up its temporary tab.
Then verify a real sync only with a legitimate `PAID` participant; a queued projection is not proof
that the spreadsheet was written.

Manual runtime checks that cannot pass on an undeployed script:

1. Open the `/exec` URL in a browser. The expected response is `{"ok":false,...}` with code
   `METHOD_NOT_ALLOWED`, not a Google sign-in page.
2. POST an unsigned body. The expected response is `UNAUTHORIZED` and no spreadsheet write.
3. Replay one signed request. The second response is `REPLAY`.
4. Inspect **Executions** for a completed run without a stack trace or secret in the logs.
5. Confirm the spreadsheet owner is the deploying account or has shared the sheet with it as
   Editor, and that both tabs exist.
