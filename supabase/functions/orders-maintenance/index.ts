/**
 * Maintenance Edge Function — expiry, email outbox, reconciliation, cleanup, Sheets.
 *
 *   POST /orders-maintenance    (Authorization: Bearer <MAINTENANCE_API_TOKEN>)
 *
 * Intended to be called by a scheduler (Supabase scheduled functions, cron, an operator).
 * The endpoint is deliberately NOT part of the payment path: if it never runs, no payment
 * is lost and no ticket is wrong — inventory simply stays reserved longer and confirmation
 * emails wait in the outbox, which is a visible, recoverable state.
 *
 * Protected by a shared secret compared in constant time, because it mutates orders and
 * sends email. `verify_jwt = false` in config.toml (a scheduler has no Supabase JWT); the
 * bearer token below IS the authentication.
 *
 * Both jobs are idempotent and safe to run concurrently, so a duplicated schedule, an
 * overlapping run or a manual call cause no harm.
 */

import { loadConfig, type BackendConfig } from "../_shared/config/env.ts";
import { createServiceRoleClient } from "../_shared/db/client.ts";
import { createOrderStatusGateway, createPaymentGateway } from "../_shared/db/payments.ts";
import { createRateLimitGateway } from "../_shared/db/rate-limits.ts";
import { createSheetsGateway } from "../_shared/db/sheets.ts";
import {
  isMaintenanceAuthorized,
  runMaintenanceSafely,
} from "../_shared/api/maintenance-handler.ts";
import { createResendClient, type ResendClient } from "../_shared/integrations/resend/client.ts";
import { createWompiClient } from "../_shared/integrations/wompi/client.ts";
import { createEpaycoClient } from "../_shared/integrations/epayco/client.ts";
import { createAlertGateway } from "../_shared/db/alerts.ts";
import { createPostPurchaseEmailGateway } from "../_shared/db/post-purchase-emails.ts";
import { createSheetsClient } from "../_shared/integrations/google/sheets-client.ts";
import { errorResponse, jsonResponse, successResponse } from "../_shared/http/json.ts";
import { createLogger } from "../_shared/logging/logger.ts";
import { toAppError } from "../_shared/domain/errors.ts";

async function run(config: BackendConfig, authorization: string | null): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createLogger({
    service: config.serviceName,
    environment: config.appEnv,
    level: config.logLevel,
    fields: { requestId, function: "orders-maintenance" },
  });

  const presented = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;

  if (!isMaintenanceAuthorized(config.maintenanceApiToken, presented)) {
    // No hint about whether the token is configured, missing or wrong.
    logger.warn("maintenance call refused", { reason: "unauthorized" });
    return jsonResponse(
      { ok: false, error: { code: "UNAUTHORIZED", message: "No autorizado." } },
      { status: 401 },
    );
  }

  const client = createServiceRoleClient(config);
  const resend: ResendClient | undefined =
    config.email.enabled && config.email.apiKey !== undefined
      ? createResendClient({ apiKey: config.email.apiKey })
      : undefined;
  // The projection is optional: without the connector the sync is skipped and every other
  // job runs untouched. The shared secret lives only in the server environment (never in SQL);
  // the spreadsheet ID and tab names live in Apps Script Script Properties.
  const sheetsClient = config.googleSheets.enabled
    ? createSheetsClient({
        url: config.googleSheets.appsScriptUrl,
        secret: config.googleSheets.appsScriptSecret,
      })
    : undefined;

  const outcome = await runMaintenanceSafely({
    config,
    logger,
    payments: createPaymentGateway(client),
    orderStatus: createOrderStatusGateway(client),
    resend,
    postPurchaseEmail: createPostPurchaseEmailGateway(client),
    wompi: createWompiClient({
      baseUrl: config.wompi.baseUrl,
      privateKey: config.wompi.privateKey,
    }),
    // ePayco attempts are reconciled only when the merchant credentials their records are
    // verified against exist; otherwise they are retried, never sent to Wompi.
    epayco:
      config.epayco.custIdCliente.length > 0 && config.epayco.pKey.length > 0
        ? createEpaycoClient({
            baseUrl: config.epayco.baseUrl,
            publicKey: config.epayco.publicKey,
            privateKey: config.epayco.privateKey,
          })
        : undefined,
    alerts: createAlertGateway(client),
    sheets: createSheetsGateway(client),
    sheetsClient,
    rateLimits: createRateLimitGateway(client),
  });

  if (!outcome.ok) {
    return jsonResponse(
      { ok: false, error: { code: "INTERNAL_ERROR", message: "Error interno." } },
      { status: 500 },
    );
  }

  return successResponse(outcome.result);
}

Deno.serve(async (request: Request): Promise<Response> => {
  const env = Deno.env.toObject();

  let config: BackendConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    return errorResponse(error, { message: "La configuración del backend está incompleta." });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Método no permitido." } },
      { status: 405 },
    );
  }

  try {
    return await run(config, request.headers.get("authorization"));
  } catch (error) {
    const appError = toAppError(error);
    // Never echo the internal message; the code is enough for an operator log.
    return jsonResponse(
      { ok: false, error: { code: appError.code, message: "Error interno." } },
      { status: 500 },
    );
  }
});
