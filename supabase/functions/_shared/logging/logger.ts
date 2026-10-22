/**
 * Structured logging.
 *
 * Rules (from the security requirements):
 * - Never log secrets: keys, tokens, signatures, authorization headers.
 * - Never log full personal data. Emails and phones are partially masked so support can
 *   still correlate a complaint with a participant; national IDs are never logged.
 * - Every relevant event is traceable by identifier: order id, payment id, Wompi
 *   reference, ticket id.
 * - One line of JSON per event, which is what the Supabase log explorer indexes well.
 *
 * Redaction is applied structurally before serialization, so a new field cannot leak by
 * accident: any key that looks sensitive is replaced regardless of where it appears.
 */

import { LOG_LEVEL_RANK, type LogLevel } from "./levels.ts";

export type LogFields = Record<string, unknown>;

/** Key patterns whose values are always replaced. Order does not matter. */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|phrase)?/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /integrity/i,
  /signature/i,
  /checksum/i,
  /cookie/i,
  /credential/i,
  /national[_-]?id/i,
  /cedula/i,
  /document/i,
  /legal[_-]?id/i,
  /card/i,
  /cvv/i,
  /^email$/i,
  /e-?mail/i,
  /^phone/i,
  /whatsapp/i,
  /^address/i,
  /instagram/i,
];

export const REDACTED = "[redacted]";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** `juan@dominio.com` -> `j***@dominio.com` (domain kept: it identifies the mail provider). */
export function maskEmail(value: string): string {
  const atIndex = value.indexOf("@");
  if (atIndex <= 0) {
    return REDACTED;
  }
  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * `573019777777` -> `573***7777`. The last four digits are enough for support to match a
 * participant, the leading country code keeps the value interpretable, and nothing else
 * is written to the log.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 6) {
    return REDACTED;
  }
  return `${digits.slice(0, 3)}***${digits.slice(-4)}`;
}

export function maskEmailLike(value: string): string {
  return value.includes("@") ? maskEmail(value) : maskPhone(value);
}

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;

/**
 * Deep-redacts a value for logging.
 * Masks by key name, truncates long strings and bounds depth/breadth so a log line can
 * never blow up the terminal or hide a leak in a nested object.
 */
export function redactForLog(value: unknown, key = "", depth = 0): unknown {
  if (isSensitiveKey(key)) {
    if (typeof value === "string" && value.includes("@")) {
      return maskEmail(value);
    }
    if (typeof value === "string" && /^\+?\d[\d\s-]{5,}$/.test(value)) {
      return maskPhone(value);
    }
    return REDACTED;
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…(truncated)` : value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return describeError(value, depth);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return `[array(${String(value.length)})]`;
    }
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactForLog(item, key, depth + 1));
  }
  if (depth >= MAX_DEPTH) {
    return "[object]";
  }
  const result: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    result[nestedKey] = redactForLog(nestedValue, nestedKey, depth + 1);
  }
  return result;
}

/** Errors keep their message and code (useful) but never their full payload. */
export function describeError(error: Error, depth = 0): Record<string, unknown> {
  const described: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    described.code = (error as { code: string }).code;
  }
  if ("context" in error) {
    described.context = redactForLog(
      (error as { context?: unknown }).context,
      "context",
      depth + 1,
    );
  }
  return described;
}

export type Logger = {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

export type LoggerOptions = {
  readonly service: string;
  readonly environment: string;
  readonly level: LogLevel;
  /** Sink for the serialized line; defaults to stdout via `console.log`. */
  readonly sink?: (line: string) => void;
  /** Fields attached to every line (for example requestId, orderId). */
  readonly fields?: LogFields;
};

function defaultSink(line: string): void {
  // The logger is the single place in the backend allowed to write to stdout.
  // eslint-disable-next-line no-console
  console.log(line);
}

export function createLogger(options: LoggerOptions, parentFields: LogFields = {}): Logger {
  const sink = options.sink ?? defaultSink;
  // Fields passed by a `child()` win over the factory-level defaults.
  const baseFields = { ...(options.fields ?? {}), ...parentFields };

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[options.level]) {
      return;
    }
    const line = {
      ts: new Date().toISOString(),
      level,
      service: options.service,
      env: options.environment,
      msg: message,
      ...(redactForLog(baseFields) as Record<string, unknown>),
      ...(fields === undefined ? {} : (redactForLog(fields) as Record<string, unknown>)),
    };
    try {
      sink(JSON.stringify(line));
    } catch {
      // Logging must never take down a request: fall back to a minimal line, and if the
      // sink itself is broken, swallow the failure rather than failing the request.
      try {
        sink(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            msg: "log serialization failed",
          }),
        );
      } catch {
        // Intentionally ignored: an unusable log sink must not break payment processing.
      }
    }
  }

  return {
    level: options.level,
    debug: (message, fields) => {
      emit("debug", message, fields);
    },
    info: (message, fields) => {
      emit("info", message, fields);
    },
    warn: (message, fields) => {
      emit("warn", message, fields);
    },
    error: (message, fields) => {
      emit("error", message, fields);
    },
    child: (fields) => createLogger(options, { ...baseFields, ...fields }),
  };
}
