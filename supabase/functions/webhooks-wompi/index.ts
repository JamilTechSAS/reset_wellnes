/**
 * Wompi webhook Edge Function — `POST /webhooks/wompi`.
 *
 * This is the ONLY endpoint that may mark an order as paid, and it does so only after
 * re-reading the transaction from Wompi with the private key.
 *
 * A thin adapter: read the body and the `X-Event-Checksum` header, delegate to the portable
 * handler, serialize the outcome. No business rule lives here.
 *
 * Public (`verify_jwt = false` in config.toml) because Wompi cannot present a Supabase JWT.
 * The endpoint authenticates the DELIVERY instead: the event checksum is an HMAC-style
 * digest over the signed properties, the timestamp and the events secret, and a delivery
 * that does not verify changes nothing.
 *
 * Response contract — matched to Wompi's documented retry schedule (a non-200 is retried
 * after 30 minutes, 3 hours and 24 hours, three attempts in total):
 *
 *   200  the event was durably handled (applied, duplicate, ignored) — do not retry;
 *   400/401  the delivery is not authentic — do not retry;
 *   503  a transient failure — please retry.
 *
 * After a successful confirmation the handler drains the email outbox for the deliveries it
 * just queued. That happens AFTER the database transaction committed, so no email is ever
 * sent for a payment that rolled back.
 */

import { loadConfig, type BackendConfig } from "../_shared/config/env.ts";
import { createServiceRoleClient } from "../_shared/db/client.ts";
import {
  createOrderStatusGateway,
  createPaymentGateway,
  type PaymentGateway,
} from "../_shared/db/payments.ts";
import { handleWompiWebhook } from "../_shared/api/webhook-handler.ts";
import { dispatchEmails } from "../_shared/api/email-dispatch.ts";
import { createWompiClient, type WompiClient } from "../_shared/integrations/wompi/client.ts";
import { createResendClient, type ResendClient } from "../_shared/integrations/resend/client.ts";
import { errorResponse, jsonResponse } from "../_shared/http/json.ts";
import { createLogger, type Logger } from "../_shared/logging/logger.ts";
import { toAppError } from "../_shared/domain/errors.ts";

/** Wompi event bodies are small; an unbounded body is a cheap denial-of-service vector. */
const MAX_BODY_BYTES = 64 * 1024;

type WebhookContext = {
  readonly config: BackendConfig;
  readonly payments: PaymentGateway;
  readonly wompi: WompiClient;
  readonly resend: ResendClient | undefined;
  readonly logger: Logger;
};

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number.parseInt(declaredLength, 10) > MAX_BODY_BYTES) {
    throw new Error("Request body is too large");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error("Request body is too large");
  }
  if (text.trim().length === 0) {
    throw new Error("Request body is empty");
  }
  return JSON.parse(text) as unknown;
}

function buildContext(config: BackendConfig, logger: Logger): WebhookContext {
  const client = createServiceRoleClient(config);
  const resend =
    config.email.enabled && config.email.apiKey !== undefined
      ? createResendClient({ apiKey: config.email.apiKey })
      : undefined;
  return {
    config,
    payments: createPaymentGateway(client),
    wompi: createWompiClient({
      baseUrl: config.wompi.baseUrl,
      privateKey: config.wompi.privateKey,
    }),
    resend,
    logger,
  };
}

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();
  const env = Deno.env.toObject();

  let config: BackendConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    return errorResponse(error, { message: "La configuración del backend está incompleta." });
  }

  const logger = createLogger({
    service: config.serviceName,
    environment: config.appEnv,
    level: config.logLevel,
    fields: { requestId, function: "webhooks-wompi" },
  });

  if (request.method !== "POST") {
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Método no permitido." } },
      { status: 405 },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    // Never log the body: it can carry personal data even when it is malformed.
    logger.warn("wompi webhook body could not be read", { error: toAppError(error).code });
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Solicitud no válida." } },
      { status: 400 },
    );
  }

  let context: WebhookContext;
  try {
    context = buildContext(config, logger);
  } catch (error) {
    logger.error("failed to build the webhook dependencies", { error: toAppError(error).code });
    return jsonResponse(
      { ok: false, error: { code: "INTERNAL_ERROR", message: "Error interno." } },
      { status: 503 },
    );
  }

  try {
    const outcome = await handleWompiWebhook({
      rawBody: body,
      headerChecksum: request.headers.get("x-event-checksum") ?? undefined,
      config: context.config,
      logger: context.logger,
      payments: context.payments,
      wompi: context.wompi,
    });

    // Drain the outbox for anything this delivery queued or left unfinished. Outside the
    // confirmation transaction on purpose; failures here are already recorded on the
    // delivery rows and can never change the payment outcome.
    if (outcome.status === 200) {
      try {
        await dispatchEmails({
          config: context.config,
          logger: context.logger,
          payments: context.payments,
          orderStatus: createOrderStatusGateway(createServiceRoleClient(context.config)),
          resend: context.resend,
          limit: context.config.emailDispatchBatchSize,
        });
      } catch (error) {
        logger.error("email dispatch after the webhook failed", {
          error: toAppError(error).code,
        });
      }
    }

    // Wompi only cares about the status code; the body is for operators and tests.
    return jsonResponse(
      { ok: outcome.status === 200, data: { outcome: outcome.outcome, reason: outcome.reason } },
      { status: outcome.status },
    );
  } catch (error) {
    const appError = toAppError(error);
    // Anything that reaches here is a bug or a database outage: 503 so Wompi retries.
    logger.error("wompi webhook failed unexpectedly", { code: appError.code });
    return jsonResponse(
      { ok: false, error: { code: appError.code, message: "Error interno." } },
      { status: 503 },
    );
  }
});
