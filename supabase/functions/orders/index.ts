/**
 * Orders Edge Function.
 *
 *   POST /orders                          -> create the order atomically, return the Wompi checkout
 *   POST /orders/quote                    -> authoritative price quote (no side effects)
 *   GET  /orders/{reference}              -> buyer-facing status polling
 *   POST /orders/{reference}/retry        -> new payment attempt with a fresh Wompi reference
 *   POST /orders/{reference}/payment-hint -> buyer returns the `?id=` transaction id from Wompi
 *   POST /orders/{reference}/participants -> attach a participant to an admission (Phase 5)
 *   PUT  /orders/{reference}/participants/{participantId} -> edit a participant of the order
 *
 * This file is a THIN ADAPTER: it reads the request and the environment, delegates to the
 * portable core (`_shared/api/…`) and serializes the response. No business rule lives here,
 * because everything business-critical is unit-tested under Node.
 *
 * Public (`verify_jwt = false` in config.toml) because buyers have no Supabase account.
 * The endpoints authenticate nobody by design and are protected by: strict input
 * validation, prices that come from the database, a reference+email possession check on
 * every order-scoped route (see `order-status-handler.ts` for why the reference alone is
 * not enough), per-IP/per-reference rate limits, and the same `confirm_payment` pipeline
 * for webhooks, the reconciliation sweep and the buyer's payment hint.
 *
 * The buyer email travels in the `X-Buyer-Email` header rather than the query string, so it
 * does not end up in proxy logs or browser history.
 *
 * It never returns a secret: the checkout payload contains the public key and the computed
 * integrity signature only.
 */

import {
  assertPaymentReady,
  ConfigError,
  loadOrderConfig,
  parseCorsAllowedOrigins,
  type BackendConfig,
} from "../_shared/config/env.ts";
import { createServiceRoleClient } from "../_shared/db/client.ts";
import {
  createOrderStatusGateway,
  createPaymentGateway,
  type OrderStatusGateway,
  type PaymentGateway,
} from "../_shared/db/payments.ts";
import { createOrderGateway, type OrderGateway } from "../_shared/db/orders.ts";
import {
  createCheckoutSessionGateway,
  type CheckoutSessionGateway,
} from "../_shared/db/checkout-sessions.ts";
import { createParticipantGateway, type ParticipantGateway } from "../_shared/db/participants.ts";
import { createRateLimitGateway, type RateLimitGateway } from "../_shared/db/rate-limits.ts";
import {
  bundleQuantityRefusal,
  checkoutConflictDetails,
  handleCreateOrder,
  handleQuote,
  parseIdempotencyKey,
  purchaseRuleDetails,
} from "../_shared/api/orders-handler.ts";
import { handleOrderStatus, handlePaymentRetry } from "../_shared/api/order-status-handler.ts";
import {
  handleAttachParticipant,
  handleUpdateParticipant,
} from "../_shared/api/participants-handler.ts";
import { handlePaymentHint } from "../_shared/api/payment-hint-handler.ts";
import { guardRateLimit } from "../_shared/api/rate-limit-guard.ts";
import { isParticipantValidationError } from "../_shared/api/order-requests.ts";
import { readJsonBody } from "../_shared/http/body.ts";
import { resolveClientIp } from "../_shared/http/client-ip.ts";
import { toAppError } from "../_shared/domain/errors.ts";
import type { RateLimitScope } from "../_shared/domain/rate-limits.ts";
import { createWompiClient } from "../_shared/integrations/wompi/client.ts";
import { createEpaycoClient } from "../_shared/integrations/epayco/client.ts";
import {
  errorResponse,
  jsonResponse,
  preflightResponse,
  resolveCorsHeaders,
  successResponse,
} from "../_shared/http/json.ts";
import { createLogger, type Logger } from "../_shared/logging/logger.ts";

const MAX_BODY_BYTES = 32 * 1024;

const REFERENCE = "EVT-[0-9]{4}-[0-9]{6,}(?:-[0-9]+)?";
const REFERENCE_PATH = new RegExp(`/orders/(${REFERENCE})$`);
const RETRY_PATH = new RegExp(`/orders/(${REFERENCE})/retry$`);
const ATTACH_PATH = new RegExp(`/orders/(${REFERENCE})/participants$`);
const UPDATE_PATH = new RegExp(`/orders/(${REFERENCE})/participants/([0-9a-fA-F-]{36})$`);
const HINT_PATH = new RegExp(`/orders/(${REFERENCE})/payment-hint$`);

type HandlerContext = {
  readonly config: BackendConfig;
  readonly orders: OrderGateway;
  readonly payments: PaymentGateway;
  readonly orderStatus: OrderStatusGateway;
  readonly checkoutSessions: CheckoutSessionGateway;
  readonly participants: ParticipantGateway;
  readonly rateLimits: RateLimitGateway;
  readonly logger: Logger;
};

/** The buyer email used by order-scoped endpoints. Header first; body is the fallback. */
function resolveBuyerEmail(request: Request): string {
  return (request.headers.get("x-buyer-email") ?? "").trim();
}

function emailFromBody(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    "email" in body &&
    typeof (body as { email?: unknown }).email === "string"
    ? (body as { email: string }).email.trim()
    : "";
}

function participantErrorDetails(error: unknown): unknown {
  if (isParticipantValidationError(error)) {
    return { issues: error.issues };
  }
  return undefined;
}

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();
  const requestOrigin = request.headers.get("origin") ?? undefined;
  const env = Deno.env.toObject();
  const corsAllowedOrigins = parseCorsAllowedOrigins(env);

  if (request.method === "OPTIONS") {
    return preflightResponse(corsAllowedOrigins, requestOrigin);
  }

  const fallbackCorsHeaders = resolveCorsHeaders(corsAllowedOrigins, requestOrigin);

  let config: BackendConfig;
  try {
    config = loadOrderConfig(env);
  } catch (error) {
    return errorResponse(error, {
      message: "La configuración del backend está incompleta.",
      headers: fallbackCorsHeaders,
    });
  }

  const logger = createLogger({
    service: config.serviceName,
    environment: config.appEnv,
    level: config.logLevel,
    fields: { requestId },
  });
  const corsHeaders = resolveCorsHeaders(config.corsAllowedOrigins, requestOrigin);

  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
  const retryMatch = request.method === "POST" ? RETRY_PATH.exec(pathname) : null;
  const attachMatch = request.method === "POST" ? ATTACH_PATH.exec(pathname) : null;
  const hintMatch = request.method === "POST" ? HINT_PATH.exec(pathname) : null;
  const updateMatch = request.method === "PUT" ? UPDATE_PATH.exec(pathname) : null;
  const referenceMatch = request.method === "GET" ? REFERENCE_PATH.exec(pathname) : null;
  const isCreate = request.method === "POST" && pathname.endsWith("/orders");
  const isQuote = request.method === "POST" && pathname.endsWith("/orders/quote");

  if (
    referenceMatch === null &&
    retryMatch === null &&
    attachMatch === null &&
    hintMatch === null &&
    updateMatch === null &&
    !isCreate &&
    !isQuote
  ) {
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Método no permitido." } },
      { status: 405, headers: corsHeaders },
    );
  }

  let context: HandlerContext;
  try {
    const client = createServiceRoleClient(config);
    context = {
      config,
      orders: createOrderGateway(client, config.paymentProvider),
      payments: createPaymentGateway(client),
      orderStatus: createOrderStatusGateway(client),
      checkoutSessions: createCheckoutSessionGateway(client),
      participants: createParticipantGateway(client),
      rateLimits: createRateLimitGateway(client),
      logger,
    };
  } catch (error) {
    logger.error("failed to build the database client", { error: toAppError(error).code });
    return errorResponse(error, { headers: corsHeaders });
  }

  /** Applies the documented rule for one scope; a missing identifier fails open. */
  const limit = async (scope: RateLimitScope, identifier: string | undefined): Promise<void> => {
    await guardRateLimit({
      gateway: context.rateLimits,
      enabled: context.config.rateLimitEnabled,
      logger: context.logger,
      scope,
      identifier,
      surface: scope,
    });
  };

  try {
    // -----------------------------------------------------------------------
    // GET /orders/{reference}
    // -----------------------------------------------------------------------
    if (referenceMatch?.[1] !== undefined) {
      await limit("orders:status", referenceMatch[1]);
      const data = await handleOrderStatus({
        reference: referenceMatch[1],
        email: resolveBuyerEmail(request),
        gateway: context.orderStatus,
        logger: context.logger,
      });
      return successResponse(data, { headers: corsHeaders });
    }

    // -----------------------------------------------------------------------
    // POST /orders/{reference}/retry
    // -----------------------------------------------------------------------
    if (retryMatch?.[1] !== undefined) {
      assertPaymentReady(context.config);
      await limit("orders:retry", retryMatch[1]);
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      // The email may travel in the header or the body; the header wins, because the body
      // is optional for this endpoint.
      const email = resolveBuyerEmail(request) || emailFromBody(body);

      const data = await handlePaymentRetry({
        reference: retryMatch[1],
        email,
        payments: context.payments,
        orderStatus: context.orderStatus,
        checkoutSessions: context.checkoutSessions,
        config: context.config,
        logger: context.logger,
        clientIp: resolveClientIp(request),
      });
      return successResponse(data, { headers: corsHeaders });
    }

    // -----------------------------------------------------------------------
    // POST /orders/{reference}/payment-hint
    // -----------------------------------------------------------------------
    if (hintMatch?.[1] !== undefined) {
      assertPaymentReady(context.config);
      await limit("orders:hint", hintMatch[1]);
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      const data = await handlePaymentHint({
        reference: hintMatch[1],
        email: resolveBuyerEmail(request) || emailFromBody(body),
        rawBody: body,
        gateway: context.payments,
        provider: context.config.paymentProvider,
        epaycoTest: context.config.epayco.test,
        epaycoCredentials: {
          custIdCliente: context.config.epayco.custIdCliente,
          pKey: context.config.epayco.pKey,
        },
        epayco: createEpaycoClient({
          baseUrl: context.config.epayco.baseUrl,
          publicKey: context.config.epayco.publicKey,
          privateKey: context.config.epayco.privateKey,
        }),
        wompi: createWompiClient({
          baseUrl: context.config.wompi.baseUrl,
          privateKey: context.config.wompi.privateKey,
        }),
        logger: context.logger,
      });
      return successResponse(data, { headers: corsHeaders });
    }

    // -----------------------------------------------------------------------
    // POST /orders/{reference}/participants  (attach)
    // -----------------------------------------------------------------------
    if (attachMatch?.[1] !== undefined) {
      await limit("orders:participants", attachMatch[1]);
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      const data = await handleAttachParticipant({
        reference: attachMatch[1],
        email: resolveBuyerEmail(request) || emailFromBody(body),
        rawBody: body,
        gateway: context.participants,
        logger: context.logger,
      });
      return successResponse(data, { status: 201, headers: corsHeaders });
    }

    // -----------------------------------------------------------------------
    // PUT /orders/{reference}/participants/{participantId}
    // -----------------------------------------------------------------------
    if (updateMatch?.[1] !== undefined && updateMatch[2] !== undefined) {
      await limit("orders:participants", updateMatch[1]);
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      const data = await handleUpdateParticipant({
        reference: updateMatch[1],
        email: resolveBuyerEmail(request) || emailFromBody(body),
        participantId: updateMatch[2],
        rawBody: body,
        gateway: context.participants,
        logger: context.logger,
      });
      return successResponse(data, { headers: corsHeaders });
    }

    // -----------------------------------------------------------------------
    // POST /orders and POST /orders/quote
    // -----------------------------------------------------------------------
    if (isQuote) {
      await limit("orders:quote", resolveClientIp(request));
    } else {
      await limit("orders:create", resolveClientIp(request));
    }
    const body = await readJsonBody(request, MAX_BODY_BYTES);

    if (isQuote) {
      const data = await handleQuote({
        rawBody: body,
        gateway: context.orders,
        config: context.config,
        logger: context.logger,
      });
      return successResponse(data, { headers: corsHeaders });
    }

    assertPaymentReady(context.config);
    const idempotencyKey = parseIdempotencyKey(request.headers.get("idempotency-key"));
    const data = await handleCreateOrder({
      rawBody: body,
      idempotencyKey,
      ipAddress: resolveClientIp(request),
      userAgent: request.headers.get("user-agent") ?? undefined,
      gateway: context.orders,
      checkoutSessions: context.checkoutSessions,
      config: context.config,
      logger: context.logger,
    });
    return successResponse(data, { status: 201, headers: corsHeaders });
  } catch (error) {
    const appError = toAppError(error);
    const isProviderError = appError.context.surface === "epayco-apify";
    // Sanitised provider diagnostics (no keys, tokens or buyer data — see apify.ts). They are
    // always logged so a production failure stays diagnosable, but only returned to the
    // caller outside production.
    const providerDiagnostics = isProviderError
      ? {
          provider: "epayco-apify",
          message: appError.message,
          httpStatus: appError.context.httpStatus ?? null,
          providerSuccess: appError.context.providerSuccess ?? null,
          providerTitleResponse: appError.context.providerTitleResponse ?? null,
          providerTextResponse: appError.context.providerTextResponse ?? null,
          providerMessage: appError.context.providerMessage ?? null,
          providerLastAction: appError.context.providerLastAction ?? null,
          providerValidationErrors: appError.context.providerValidationErrors ?? null,
          responseKeys: appError.context.responseKeys ?? null,
          dataKeys: appError.context.dataKeys ?? null,
        }
      : undefined;
    // Only the error CODE and safe field-level details are logged; never the request body
    // (it contains personal data) and never SQL text.
    logger.warn("order request rejected", {
      code: appError.code,
      detail: appError.context.detail ?? null,
      ...(providerDiagnostics ?? {}),
    });
    const isConfig = error instanceof ConfigError;
    const exposeDiagnostics = context.config.appEnv !== "production";
    const configIssues = isConfig && exposeDiagnostics ? { issues: error.issues } : undefined;
    // A checkout-session conflict carries only its code-like reason (`CHECKOUT_LEASE_ACTIVE`,
    // `ORDER_NOT_PENDING`, …): the buyer needs it to be told "wait a moment" instead of
    // "sold out", and it is safe in every environment.
    // The two vocabularies are disjoint by construction (see the allowlists' tests), so the
    // order here cannot change an existing checkout-session answer.
    // A package request with the wrong number of admissions is a malformed request: it gets
    // a 400 naming the rule instead of the generic conflict the buyer cannot act on.
    const bundleRefusal = bundleQuantityRefusal(appError);
    const details =
      participantErrorDetails(error) ??
      configIssues ??
      (exposeDiagnostics ? providerDiagnostics : undefined) ??
      checkoutConflictDetails(appError) ??
      purchaseRuleDetails(appError) ??
      bundleRefusal?.details;
    return errorResponse(appError, {
      ...(isConfig ? { message: "La configuración del backend está incompleta." } : {}),
      ...(bundleRefusal === undefined ? {} : { message: bundleRefusal.message }),
      ...(details === undefined ? {} : { details }),
      headers: corsHeaders,
    });
  }
});
