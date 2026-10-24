/**
 * Signed Apps Script connector check.
 *
 * Usage:
 *   node --env-file=.env.staging.secrets scripts/sheets-connector-check.ts health
 *   node --env-file=.env.staging.secrets scripts/sheets-connector-check.ts self_test
 *
 * The secret is read from the environment and never printed. The command exits non-zero when
 * the connector reports `{ok:false}` so it can gate a setup step.
 */

import { createSheetsClient } from "../supabase/functions/_shared/integrations/google/sheets-client.ts";

const operation = process.argv[2] ?? "health";
if (operation !== "health" && operation !== "self_test") {
  console.error("Usage: sheets-connector-check.ts [health|self_test]");
  process.exitCode = 2;
} else {
  const url = process.env.GOOGLE_APPS_SCRIPT_URL;
  const secret = process.env.GOOGLE_APPS_SCRIPT_SECRET;
  if (url === undefined || url.length === 0) {
    console.error("GOOGLE_APPS_SCRIPT_URL is required");
    process.exitCode = 2;
  } else if (secret === undefined || secret.length === 0) {
    console.error("GOOGLE_APPS_SCRIPT_SECRET is required");
    process.exitCode = 2;
  } else {
    const client = createSheetsClient({ url, secret });
    const result = operation === "health" ? await client.health() : await client.selfTest();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  }
}
