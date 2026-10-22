/**
 * Operator check-in Edge Function.
 *
 *   POST /check-in          { ticketToken }   admission decision (VALID / ALREADY_USED / …)
 *   GET  /check-in/{token}                    operator ticket lookup before scanning
 *
 * AUTHENTICATION — real Supabase Auth, not a shared secret:
 *   * `Authorization: Bearer <access token>` is verified by Supabase Auth itself
 *     (`auth.getUser`). The token belongs to a real user account; there is no custom
 *     username/password store and no permanent operator secret anywhere.
 *   * AUTHORIZATION is a row in `public.operators` (role OPERATOR/ADMIN, active). A valid
 *     user who is not an active operator gets 403 FORBIDDEN; a missing/expired token gets
 *     401 UNAUTHORIZED. The verified identity is what the attendance row records — never a
 *     client-supplied label.
 *
 * `verify_jwt = false` in config.toml on purpose: the platform's own JWT gate answers with
 * an opaque 401 body and would prevent the IP-based pre-auth rate limit from running, while
 * this function verifies the same token with the same Supabase Auth service and returns the
 * documented `{ ok:false, error }` envelope. There is no path that skips verification.
 *
 * RATE LIMITS: `checkin:attempt` (per IP) is consumed ONLY when a request arrives without a
 * valid token — credential stuffing is bounded without ever throttling a real operator (the
 * venue may share one NAT address). `checkin:operator` (600/min per operator) is far above
 * a 120-person door.
 *
 * The response contract is 200-with-`status` for every check-in outcome; HTTP errors are
 * reserved for transport-level failures (auth, rate limit, malformed body, upstream).
 */

import {
  loadCatalogConfig,
  parseCorsAllowedOrigins,
  type BackendConfig,
} from "../_shared/config/env.ts";
import { createServiceRoleClient } from "../_shared/db/client.ts";
import { createOperatorGateway } from "../_shared/db/operators.ts";
import { createCheckInGateway, type CheckInGateway } from "../_shared/db/checkin.ts";
import { createRateLimitGateway, type RateLimitGateway } from "../_shared/db/rate-limits.ts";
import {
  createOperatorAuthenticator,
  type OperatorAuthenticator,
} from "../_shared/api/operator-auth.ts";
import { handleCheckIn, handleOperatorTicketLookup } from "../_shared/api/checkin-handler.ts";
import { guardRateLimit } from "../_shared/api/rate-limit-guard.ts";
import { readJsonBody } from "../_shared/http/body.ts";
import { resolveClientIp } from "../_shared/http/client-ip.ts";
import { AppError, notFoundError, toAppError } from "../_shared/domain/errors.ts";
import {
  errorResponse,
  jsonResponse,
  preflightResponse,
  resolveCorsHeaders,
  successResponse,
} from "../_shared/http/json.ts";
import { createLogger, type Logger } from "../_shared/logging/logger.ts";
import type { OperatorIdentity } from "../_shared/domain/operators.ts";

const OPERATOR_TICKET_PATH = /\/check-in\/([A-Za-z0-9_-]{1,120})$/;
/** Tiny body by design: a ticket token and nothing else. */
const MAX_BODY_BYTES = 8 * 1024;

type HandlerContext = {
  readonly config: BackendConfig;
  readonly auth: OperatorAuthenticator;
  readonly checkin: CheckInGateway;
  readonly rateLimits: RateLimitGateway;
  readonly logger: Logger;
};

/**
 * Authenticates the operator; an UNAUTHORIZED outcome additionally consumes the per-IP
 * attempt budget before the error is returned (a request limited at that point gets 429).
 */
async function authenticateOperator(
  request: Request,
  context: HandlerContext,
): Promise<OperatorIdentity> {
  try {
    return await context.auth.authenticate(request.headers.get("authorization"));
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHORIZED") {
      await guardRateLimit({
        gateway: context.rateLimits,
        enabled: context.config.rateLimitEnabled,
        logger: context.logger,
        scope: "checkin:attempt",
        identifier: resolveClientIp(request),
        surface: "checkin:auth",
      });
    }
    throw error;
  }
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
    fields: { requestId, function: "checkin" },
  });
  const corsHeaders = resolveCorsHeaders(config.corsAllowedOrigins, requestOrigin);

  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
  const isPost = request.method === "POST" && pathname.endsWith("/check-in");
  const tokenMatch = request.method === "GET" ? OPERATOR_TICKET_PATH.exec(pathname) : null;
  if (!isPost && tokenMatch === null) {
    if (request.method !== "GET" && request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: { code: "VALIDATION_ERROR", message: "Método no permitido." } },
        { status: 405, headers: corsHeaders },
      );
    }
    return errorResponse(notFoundError("Unknown route"), { headers: corsHeaders });
  }

  let context: HandlerContext;
  try {
    const client = createServiceRoleClient(config);
    context = {
      config,
      auth: createOperatorAuthenticator({
        getUserByToken: async (token) => {
          // Verified by Supabase Auth itself; never decoded locally.
          const { data, error } = await client.auth.getUser(token);
          if (error !== null) {
            return undefined;
          }
          return { userId: data.user.id, email: data.user.email ?? undefined };
        },
        operators: createOperatorGateway(client),
        logger,
      }),
      checkin: createCheckInGateway(client),
      rateLimits: createRateLimitGateway(client),
      logger,
    };
  } catch (error) {
    logger.error("failed to build the database client", { error: toAppError(error).code });
    return errorResponse(error, { headers: corsHeaders });
  }

  try {
    const operator = await authenticateOperator(request, context);
    await guardRateLimit({
      gateway: context.rateLimits,
      enabled: context.config.rateLimitEnabled,
      logger: context.logger,
      scope: "checkin:operator",
      identifier: operator.userId,
      surface: "checkin:operator",
    });

    if (isPost) {
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      const data = await handleCheckIn({
        rawBody: body,
        operator,
        gateway: context.checkin,
        logger: context.logger,
      });
      return successResponse(data, { headers: corsHeaders });
    }

    // tokenMatch is non-null here: the route check above guarantees it.
    const data = await handleOperatorTicketLookup({
      rawToken: tokenMatch?.[1] ?? "",
      operator,
      gateway: context.checkin,
      logger: context.logger,
    });
    return successResponse(data, { headers: corsHeaders });
  } catch (error) {
    const appError = toAppError(error);
    logger.warn("check-in request rejected", {
      code: appError.code,
      detail: appError.context.detail ?? null,
    });
    return errorResponse(appError, { headers: corsHeaders });
  }
});
