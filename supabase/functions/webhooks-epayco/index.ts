/**
 * ePayco Webhook / Confirmation Edge Function — `POST /webhooks-epayco`.
 *
 * Public (`verify_jwt = false` in config.toml) because ePayco cannot present a Supabase JWT.
 * The delivery is authenticated by ePayco's SHA-256 signature calculated from the merchant's
 * private p_key and customer ID.
 */

import { loadConfig, type BackendConfig } from "../_shared/config/env.ts";
import { createServiceRoleClient } from "../_shared/db/client.ts";
import { createAlertGateway } from "../_shared/db/alerts.ts";
import { createAlertSink, type AlertSink } from "../_shared/api/alerts.ts";
import {
  createOrderStatusGateway,
  createPaymentGateway,
  type PaymentGateway,
} from "../_shared/db/payments.ts";
import { handleEpaycoWebhook } from "../_shared/api/epayco-webhook-handler.ts";
import { dispatchEmails } from "../_shared/api/email-dispatch.ts";
import { dispatchPostPurchaseEmails } from "../_shared/api/post-purchase-email-dispatch.ts";
import {
  createPostPurchaseEmailGateway,
  type PostPurchaseEmailGateway,
} from "../_shared/db/post-purchase-emails.ts";
import { createEpaycoClient, type EpaycoClient } from "../_shared/integrations/epayco/client.ts";
import { createResendClient, type ResendClient } from "../_shared/integrations/resend/client.ts";
import { errorResponse, jsonResponse } from "../_shared/http/json.ts";
import { createLogger, type Logger } from "../_shared/logging/logger.ts";
import { toAppError } from "../_shared/domain/errors.ts";

const MAX_BODY_BYTES = 64 * 1024;

type WebhookContext = {
  readonly config: BackendConfig;
  readonly payments: PaymentGateway;
  readonly epayco: EpaycoClient;
  readonly alerts: AlertSink;
  readonly resend: ResendClient | undefined;
  readonly postPurchaseEmails: PostPurchaseEmailGateway;
  readonly logger: Logger;
};

async function readRequestBody(request: Request): Promise<Record<string, unknown>> {
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

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const result: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      result[key] = value;
    }
    return result;
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // If not strict JSON, try URLSearchParams fallback
    const params = new URLSearchParams(text);
    const result: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      result[key] = value;
    }
    return result;
  }
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
    alerts: createAlertSink(createAlertGateway(client), logger),
    epayco: createEpaycoClient({
      baseUrl: config.epayco.baseUrl,
      publicKey: config.epayco.publicKey,
      privateKey: config.epayco.privateKey,
      // ePayco expects an answer within 30 s; keep the record lookup well inside that budget.
      timeoutMs: 5_000,
      retryDelaysMs: [300],
    }),
    resend,
    postPurchaseEmails: createPostPurchaseEmailGateway(client),
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
    fields: { requestId, function: "webhooks-epayco" },
  });

  if (request.method !== "POST" && request.method !== "GET") {
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Método no permitido." } },
      { status: 405 },
    );
  }

  let body: Record<string, unknown>;
  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      body = {};
      for (const [key, value] of url.searchParams.entries()) {
        body[key] = value;
      }
    } else {
      body = await readRequestBody(request);
    }
  } catch (error) {
    logger.warn("epayco webhook body could not be read", { error: toAppError(error).code });
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Solicitud no válida." } },
      { status: 400 },
    );
  }

  let context: WebhookContext;
  try {
    context = buildContext(config, logger);
  } catch (error) {
    logger.error("failed to build epayco webhook dependencies", { error: toAppError(error).code });
    return jsonResponse(
      { ok: false, error: { code: "INTERNAL_ERROR", message: "Error interno." } },
      { status: 503 },
    );
  }

  try {
    const outcome = await handleEpaycoWebhook({
      rawBody: body,
      config: context.config,
      logger: context.logger,
      payments: context.payments,
      epayco: context.epayco,
      alerts: context.alerts,
    });

    // The email is triggered by the PAID transition the confirmation just committed, never by
    // the response itself: a rejected signature, a declined transaction or a duplicate delivery
    // that left the order unpaid reports another status here and sends nothing.
    if (outcome.status === 200 && outcome.orderStatus === "PAID") {
      try {
        await dispatchPostPurchaseEmails({
          config: context.config,
          logger: context.logger,
          gateway: context.postPurchaseEmails,
          resend: context.resend,
          limit: context.config.emailDispatchBatchSize,
        });
      } catch (error) {
        logger.error("post-purchase email dispatch after epayco webhook failed", {
          error: toAppError(error).code,
        });
      }
    }

    if (outcome.status === 200 && outcome.ticketsIssued > 0) {
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
        logger.error("email dispatch after epayco webhook failed", {
          error: toAppError(error).code,
        });
      }
    }

    return jsonResponse(
      { ok: outcome.status === 200, data: { outcome: outcome.outcome, reason: outcome.reason } },
      { status: outcome.status },
    );
  } catch (error) {
    const appError = toAppError(error);
    logger.error("epayco webhook failed unexpectedly", { code: appError.code });
    return jsonResponse(
      { ok: false, error: { code: appError.code, message: "Error interno." } },
      { status: 503 },
    );
  }
});
