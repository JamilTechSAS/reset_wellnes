/**
 * Public ticket Edge Function.
 *
 *   GET /tickets/{token}   the participant-facing view of one ticket
 *
 * Public (`verify_jwt = false`): the opaque token IS the capability. It carries 100 bits of
 * entropy, so guessing is infeasible, and the response is the minimum needed by a
 * participant-facing page: event identity, ticket code, ticket status and an abbreviated
 * display name. It NEVER contains cédula, email, phone, order internals or consent history —
 * the projection is built in SQL (`public.get_public_ticket`), so a new column cannot leak.
 *
 * A malformed or unknown token answers the SAME 404, which keeps the endpoint useless for
 * enumeration. Rate-limited per IP (`tickets:lookup`), generous for page refreshes.
 *
 * Operators see the admission view instead (`GET /check-in/{token}`), which requires a real
 * Supabase Auth session and an active operator role.
 */

import { loadConfig, parseCorsAllowedOrigins, type BackendConfig } from "../_shared/config/env.ts";
import { createServiceRoleClient } from "../_shared/db/client.ts";
import { createPublicGateway, type PublicGateway } from "../_shared/db/public.ts";
import { createRateLimitGateway, type RateLimitGateway } from "../_shared/db/rate-limits.ts";
import { guardRateLimit } from "../_shared/api/rate-limit-guard.ts";
import { handleGetPublicTicket } from "../_shared/api/public-handler.ts";
import { resolveClientIp } from "../_shared/http/client-ip.ts";
import { notFoundError, toAppError } from "../_shared/domain/errors.ts";
import {
  errorResponse,
  jsonResponse,
  preflightResponse,
  resolveCorsHeaders,
  successResponse,
} from "../_shared/http/json.ts";
import { createLogger, type Logger } from "../_shared/logging/logger.ts";

/** Token-shaped path segment only; the real format check lives in the ticket domain. */
const TICKET_PATH = /\/tickets\/([A-Za-z0-9_-]{1,120})$/;

type HandlerContext = {
  readonly config: BackendConfig;
  readonly public: PublicGateway;
  readonly rateLimits: RateLimitGateway;
  readonly logger: Logger;
};

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
    config = loadConfig(env);
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
    fields: { requestId, function: "tickets" },
  });
  const corsHeaders = resolveCorsHeaders(config.corsAllowedOrigins, requestOrigin);
  if (request.method !== "GET") {
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Método no permitido." } },
      { status: 405, headers: corsHeaders },
    );
  }

  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
  const match = TICKET_PATH.exec(pathname);
  if (match?.[1] === undefined) {
    return errorResponse(notFoundError("Unknown ticket"), { headers: corsHeaders });
  }

  let context: HandlerContext;
  try {
    const client = createServiceRoleClient(config);
    context = {
      config,
      public: createPublicGateway(client),
      rateLimits: createRateLimitGateway(client),
      logger,
    };
  } catch (error) {
    logger.error("failed to build the database client", { error: toAppError(error).code });
    return errorResponse(error, { headers: corsHeaders });
  }

  try {
    await guardRateLimit({
      gateway: context.rateLimits,
      enabled: context.config.rateLimitEnabled,
      logger: context.logger,
      scope: "tickets:lookup",
      identifier: resolveClientIp(request),
      surface: "tickets:lookup",
    });
    const data = await handleGetPublicTicket({
      rawToken: match[1],
      gateway: context.public,
      logger: context.logger,
    });
    return successResponse(data, { headers: corsHeaders });
  } catch (error) {
    const appError = toAppError(error);
    context.logger.warn("public ticket request rejected", {
      code: appError.code,
      detail: appError.context.detail ?? null,
    });
    return errorResponse(appError, { headers: corsHeaders });
  }
});
