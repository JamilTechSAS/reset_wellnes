/**
 * HTTP client for the Edge Functions (Phase 6B).
 *
 * Responsibilities, and nothing else:
 *   - build the URL from the configured base URL and a relative path;
 *   - send/receive JSON;
 *   - turn the `{ ok, data }` / `{ ok:false, error }` envelope into either a value or a
 *     typed error;
 *   - apply a timeout and observe an external abort signal.
 *
 * It never computes a price, never signs anything and never decides whether a payment
 * succeeded: those are backend facts.
 */

import type { ApiFieldIssue } from "./types.ts";

/** The documented error codes of the frozen contract (`docs/api.md`). */
export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** A structured refusal from the backend. Carries the documented error code. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly issues: readonly ApiFieldIssue[];

  constructor(args: {
    readonly code: ApiErrorCode;
    readonly status: number;
    readonly message: string;
    readonly issues?: readonly ApiFieldIssue[];
  }) {
    super(args.message);
    this.name = "ApiError";
    this.code = args.code;
    this.status = args.status;
    this.issues = args.issues ?? [];
  }

  /** True when retrying the same request could plausibly succeed. */
  get isRetryable(): boolean {
    return (
      this.code === "UPSTREAM_ERROR" ||
      this.code === "INTERNAL_ERROR" ||
      this.code === "RATE_LIMITED"
    );
  }
}

/** A transport failure: the request never produced a well-formed backend answer. */
export class NetworkError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, options: { readonly timedOut?: boolean } = {}) {
    super(message);
    this.name = "NetworkError";
    this.timedOut = options.timedOut ?? false;
  }
}

/** Thrown when the caller aborted the request on purpose (unmount, new attempt). */
export class AbortError extends Error {
  constructor() {
    super("The request was aborted");
    this.name = "AbortError";
  }
}

/** Internal abort reason that distinguishes our own timeout from a caller abort. */
class RequestTimeout extends Error {}

export type RequestOptions = {
  readonly method: "GET" | "POST" | "PUT";
  /** Path relative to the API base URL, e.g. `/orders/quote`. */
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type ApiClient = {
  readonly baseUrl: string;
  request<T>(options: RequestOptions): Promise<T>;
};

const DEFAULT_TIMEOUT_MS = 15_000;

const UNEXPECTED_RESPONSE = "El servidor respondió de forma inesperada.";
const GENERIC_FAILURE = "No pudimos completar la solicitud.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isApiErrorCode(value: string): value is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(value);
}

/** Maps a non-2xx status with no parseable body to a documented code. */
function fallbackCodeForStatus(status: number): ApiErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL_ERROR";
  return "VALIDATION_ERROR";
}

type Envelope =
  { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: unknown };

/** Narrows an arbitrary JSON body to the documented envelope, or nothing. */
function parseEnvelope(value: unknown): Envelope | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (record.ok === true) {
    return { ok: true, data: record.data };
  }
  if (record.ok === false) {
    return { ok: false, error: record.error };
  }
  return undefined;
}

function readErrorCode(error: unknown, status: number): ApiErrorCode {
  const record = asRecord(error);
  const code = record?.code;
  return typeof code === "string" && isApiErrorCode(code) ? code : fallbackCodeForStatus(status);
}

function readErrorMessage(error: unknown): string {
  const record = asRecord(error);
  const message = record?.message;
  return typeof message === "string" && message.length > 0 ? message : GENERIC_FAILURE;
}

function extractIssues(details: unknown): readonly ApiFieldIssue[] {
  const record = asRecord(details);
  const issues = record?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    const entry = asRecord(issue);
    const path = entry?.path;
    const message = entry?.message;
    return typeof path === "string" && typeof message === "string" ? [{ path, message }] : [];
  });
}

export function createApiClient(options: {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(requestOptions: RequestOptions): Promise<T> {
    const { path, method, body, headers, signal } = requestOptions;
    const timeoutMs = requestOptions.timeoutMs ?? defaultTimeout;

    // One controller drives both the timeout and a caller abort; `AbortSignal.any` is not
    // available everywhere, so the two are combined manually.
    const controller = new AbortController();
    const onCallerAbort = (): void => {
      controller.abort();
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        throw new AbortError();
      }
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = globalThis.setTimeout(() => {
      controller.abort(new RequestTimeout());
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // A caller abort wins over our own timeout: it is not a failure to report.
      if (signal?.aborted === true) {
        throw new AbortError();
      }
      if (controller.signal.reason instanceof RequestTimeout) {
        throw new NetworkError("La solicitud tardó demasiado. Revisa tu conexión.", {
          timedOut: true,
        });
      }
      throw new NetworkError(
        error instanceof Error ? error.message : "No se pudo contactar al servidor.",
      );
    } finally {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      if (!response.ok) {
        throw new ApiError({
          code: fallbackCodeForStatus(response.status),
          status: response.status,
          message: UNEXPECTED_RESPONSE,
        });
      }
      throw new NetworkError(UNEXPECTED_RESPONSE);
    }

    const envelope = parseEnvelope(parsed);
    if (envelope === undefined) {
      throw new NetworkError(UNEXPECTED_RESPONSE);
    }
    if (envelope.ok) {
      return envelope.data as T;
    }

    const error = asRecord(envelope.error);
    return Promise.reject(
      new ApiError({
        code: readErrorCode(envelope.error, response.status),
        status: response.status,
        message: readErrorMessage(envelope.error),
        issues: extractIssues(error?.details),
      }),
    );
  }

  return { baseUrl, request };
}
