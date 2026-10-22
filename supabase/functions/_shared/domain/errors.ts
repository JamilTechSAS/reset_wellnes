/**
 * Error taxonomy shared by every layer.
 *
 * `code` is a stable English identifier used by clients, logs and tests.
 * `message` is an internal, developer-facing description and is never shown to end
 * users verbatim; the HTTP layer maps codes to Spanish product messages.
 *
 * Errors never carry secrets or full personal data. When extra context is needed for
 * logs, attach identifiers (order id, ticket id, Wompi reference) only.
 */

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type AppErrorOptions = {
  readonly cause?: unknown;
  /** Safe, non-sensitive context for logs (identifiers only). */
  readonly context?: Record<string, string | number | boolean | null>;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly context: Record<string, string | number | boolean | null>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.context = options.context ?? {};
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Convenience constructors for the cases that appear most often. */
export function validationError(message: string, options?: AppErrorOptions): AppError {
  return new AppError("VALIDATION_ERROR", message, options);
}

export function notFoundError(message: string, options?: AppErrorOptions): AppError {
  return new AppError("NOT_FOUND", message, options);
}

export function conflictError(message: string, options?: AppErrorOptions): AppError {
  return new AppError("CONFLICT", message, options);
}

export function unauthorizedError(message: string, options?: AppErrorOptions): AppError {
  return new AppError("UNAUTHORIZED", message, options);
}

/** Authenticated, but not allowed: the account exists and is not an authorized operator. */
export function forbiddenError(message: string, options?: AppErrorOptions): AppError {
  return new AppError("FORBIDDEN", message, options);
}

/**
 * Normalizes any thrown value into an `AppError`.
 * Unexpected errors become `INTERNAL_ERROR` with the original message kept for logs
 * only; the HTTP layer replaces it with a generic Spanish message.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) {
    return value;
  }
  if (value instanceof Error) {
    return new AppError("INTERNAL_ERROR", value.message, { cause: value });
  }
  return new AppError("INTERNAL_ERROR", "Unexpected non-error value was thrown");
}
