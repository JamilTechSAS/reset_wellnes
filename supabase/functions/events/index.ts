/**
 * Public events Edge Function.
 *
 *   GET /events/{code}                landing-page content (published/closed events only)
 *   GET /events/{code}/availability   coarse sales state for the ticket area
 *
 * Public (`verify_jwt = false` in config.toml): visitors have no Supabase account. The
 * endpoints expose NO personal data — only the event's public identity, dates, venue and a
 * hand-written sales projection built in SQL. Availability is deliberately coarse
 * (AVAILABLE / LOW / SOLD_OUT / NOT_STARTED / CLOSED); the authoritative inventory check
 * stays inside the order-creation transaction.
 *
 * Rate-limited per IP (`events:read`), generously, so a landing page and its polling can
 * never be throttled by one visitor while scraping loops still stop.
 *
 * This file is a THIN ADAPTER: it reads the request/environment, delegates to
 * `_shared/api/public-handler.ts` and serializes the `{ ok, data }` envelope.
 */

import {
  loadCatalogConfig,
  parseCorsAllowedOrigins,
  type BackendConfig,
} from "../_shared/config/env.ts";
import { createServiceRoleClient } from "../_shared/db/client.ts";
import { createPublicGateway, type PublicGateway } from "../_shared/db/public.ts";
import { createRateLimitGateway, type RateLimitGateway } from "../_shared/db/rate-limits.ts";
import { guardRateLimit } from "../_shared/api/rate-limit-guard.ts";
import {
  handleGetPublicAvailability,
  handleGetPublicEvent,
} from "../_shared/api/public-handler.ts";
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

const AVAILABILITY_PATH = /\/events\/([A-Za-z0-9_-]{1,40})\/availability$/;
const EVENT_PATH = /\/events\/([A-Za-z0-9_-]{1,40})$/;

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
    config = loadCatalogConfig(env);
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
    fields: { requestId, function: "events" },
  });
  const corsHeaders = resolveCorsHeaders(config.corsAllowedOrigins, requestOrigin);

  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
  const availabilityMatch = AVAILABILITY_PATH.exec(pathname);
  const eventMatch = eventMatchFrom(pathname);

  if (request.method !== "GET") {
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Método no permitido." } },
      { status: 405, headers: corsHeaders },
    );
  }
  if (availabilityMatch === null && eventMatch === null) {
    return errorResponse(notFoundError("Unknown route"), {
      headers: corsHeaders,
    });
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
    // The IP limit runs before validation: an abusive client must be slowed even when it
    // sends nonsense paths. A request that cannot be keyed is allowed (documented).
    await guardRateLimit({
      gateway: context.rateLimits,
      enabled: context.config.rateLimitEnabled,
      logger: context.logger,
      scope: "events:read",
      identifier: resolveClientIp(request),
      surface: "events:read",
    });

    if (availabilityMatch?.[1] !== undefined) {
      const data = await handleGetPublicAvailability({
        code: availabilityMatch[1],
        gateway: context.public,
        logger: context.logger,
      });
      return successResponse(data, { headers: corsHeaders });
    }
    if (eventMatch?.[1] !== undefined) {
      const data = await handleGetPublicEvent({
        code: eventMatch[1],
        gateway: context.public,
        logger: context.logger,
      });
      return successResponse(data, { headers: corsHeaders });
    }
    // Unreachable: the path was matched above.
    return errorResponse(notFoundError("Unknown route"), { headers: corsHeaders });
  } catch (error) {
    const appError = toAppError(error);
    logger.warn("public event request rejected", {
      code: appError.code,
      detail: appError.context.detail ?? null,
    });
    return errorResponse(appError, { headers: corsHeaders });
  }
});

/** `/events/{code}` — but not the `/availability` suffix, which is matched separately. */
function eventMatchFrom(pathname: string): RegExpExecArray | null {
  const match = EVENT_PATH.exec(pathname);
  if (match === null) {
    return null;
  }
  return pathname.endsWith("/availability") ? null : match;
}
