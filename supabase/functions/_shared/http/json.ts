/**
 * HTTP response contract shared by every Edge Function.
 *
 * Contract:
 *   success -> 200/201 { ok: true, data: ... }
 *   failure -> 4xx/5xx { ok: false, error: { code, message, details? } }
 *
 * `code` is a stable English identifier for the frontend to branch on; `message` is the
 * Spanish text a person reads. Internal messages (English, sometimes technical) are
 * NEVER returned to clients: they can name variables or hint at infrastructure state.
 */

import { toAppError, type ErrorCode } from "../domain/errors.ts";

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
};

/** User-facing Spanish messages (the product speaks Spanish; identifiers stay English). */
export const DEFAULT_ERROR_MESSAGES_ES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "Los datos enviados no son válidos.",
  UNAUTHORIZED: "No autorizado.",
  FORBIDDEN: "No tienes permisos para realizar esta acción.",
  NOT_FOUND: "No encontramos la información solicitada.",
  CONFLICT: "La operación no se puede completar con el estado actual.",
  RATE_LIMITED: "Demasiadas solicitudes. Intenta de nuevo en unos segundos.",
  UPSTREAM_ERROR:
    "No pudimos comunicarnos con la pasarela de pagos. Intenta de nuevo en unos minutos.",
  INTERNAL_ERROR: "Ocurrió un error inesperado. Intenta de nuevo en unos minutos.",
};

export type ErrorBody = {
  readonly ok: false;
  readonly error: {
    readonly code: ErrorCode;
    /** Spanish text for the end user. */
    readonly message: string;
    readonly details?: unknown;
  };
};

/**
 * Response options accepted by this module. Only plain header objects are supported, so a
 * `Headers` instance or an array of pairs can never be spread into the headers by mistake.
 */
export type JsonResponseInit = {
  readonly status?: number;
  readonly headers?: Record<string, string>;
};

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export function jsonResponse(body: unknown, init: JsonResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...(init.status === undefined ? {} : { status: init.status }),
    headers: { ...BASE_HEADERS, ...(init.headers ?? {}) },
  });
}

/** Successful responses always use the `{ ok: true, data }` envelope. */
export function successResponse(data: unknown, init: JsonResponseInit = {}): Response {
  return jsonResponse({ ok: true, data }, init);
}

export type ErrorResponseOptions = {
  /** Overrides the default Spanish message (still user-safe text only). */
  readonly message?: string;
  /** Safe, structured details, typically field-level validation issues. */
  readonly details?: unknown;
  readonly headers?: Record<string, string>;
};

/**
 * Builds an error response from any thrown value.
 * Unexpected errors are collapsed to a generic Spanish message; the real cause is only
 * logged by the caller, never serialized into the response.
 */
export function errorResponse(error: unknown, options: ErrorResponseOptions = {}): Response {
  const appError = toAppError(error);
  const status = ERROR_HTTP_STATUS[appError.code];
  const body: ErrorBody = {
    ok: false,
    error: {
      code: appError.code,
      message: options.message ?? DEFAULT_ERROR_MESSAGES_ES[appError.code],
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
  return jsonResponse(body, {
    status,
    headers: { ...(options.headers ?? {}) },
  });
}

/** Headers that tell logs which request id the response belongs to. */
export function withRequestId(
  headers: Record<string, string>,
  requestId: string,
): Record<string, string> {
  return { ...headers, "x-request-id": requestId };
}

/**
 * CORS for browser clients (the future frontend on Vercel and the private check-in UI).
 * Only explicitly allowed origins are echoed; anything else receives no CORS headers,
 * so the browser blocks the response.
 */
export function resolveCorsHeaders(
  allowedOrigins: readonly string[],
  requestOrigin: string | undefined,
): Record<string, string> {
  if (requestOrigin === undefined || !allowedOrigins.includes(requestOrigin)) {
    return { vary: "origin" };
  }
  return {
    "access-control-allow-origin": requestOrigin,
    // PUT is used by the participant update route; denying it would break the preflight.
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    // Every request header the API actually reads must be listed here, or the browser
    // blocks the request during preflight (x-buyer-email carries the possession factor
    // for order reads/retries/participants; idempotency-key protects order creation).
    "access-control-allow-headers":
      "authorization,content-type,x-request-id,x-buyer-email,idempotency-key",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

export function preflightResponse(
  allowedOrigins: readonly string[],
  requestOrigin: string | undefined,
): Response {
  return new Response(null, {
    status: 204,
    headers: resolveCorsHeaders(allowedOrigins, requestOrigin),
  });
}
