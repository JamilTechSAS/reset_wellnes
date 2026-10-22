/**
 * Wompi events (webhooks): parsing and authenticity verification.
 *
 * Verified algorithm (docs/colombia/eventos/, "Step by step: verify the authenticity of
 * an event", re-read 2026-10-03):
 *
 *   checksum = SHA256( concat(data[property] for property in signature.properties)
 *                      + timestamp
 *                      + eventsSecret )
 *
 * Key facts encoded here:
 * - `signature.properties` VARIES per event and per future event types, so the property
 *   list must be read from the payload and never hardcoded.
 * - `timestamp` is a UNIX timestamp (integer) and is part of the hash; `sent_at` is NOT
 *   part of the hash (it is the first-notification time).
 * - The same checksum is available in the `X-Event-Checksum` header and in
 *   `signature.checksum`; either source may be used.
 * - The event secret is NOT the private key and must stay server-side.
 *
 * DELTA FOUND ON 2026-10-03 (Phase 4 re-verification): the current official envelope puts
 * `timestamp` and `environment` at the TOP LEVEL of the body:
 *
 *   { "event": …, "data": {…}, "environment": "prod",
 *     "signature": { "properties": [...], "checksum": "…" },
 *     "timestamp": 1530291411, "sent_at": "…" }
 *
 * Older Wompi examples (and the Phase 1 notes) showed `signature.timestamp`. The exact same
 * concatenation is hashed in both shapes, so the parser accepts EITHER location but
 * rejects a body where the two disagree: a payload carrying two different timestamps
 * cannot be unambiguously verified, so it is refused rather than guessed.
 *
 * `environment` is read when present: an event minted for `test` must never confirm a
 * production order and vice versa (see `verifyWompiEvent`).
 *
 * Fail-safe behavior: anything that cannot be verified with certainty is rejected with a
 * machine-readable reason. A rejected event never marks an order as paid; the order is
 * later reconciled through the private-key transaction lookup, so rejecting is always
 * better than trusting.
 */

import { z } from "zod";
import { constantTimeEqualsHex, sha256Hex } from "./signature.ts";
import {
  WOMPI_ENVIRONMENT_VALUES,
  WOMPI_TRANSACTION_UPDATED_EVENT,
  type WompiEventEnvironment,
  type WompiTransactionEventPayload,
} from "./types.ts";

/** Paths that must never be resolvable from an untrusted payload. */
const FORBIDDEN_PATH_SEGMENTS = ["__proto__", "prototype", "constructor"];

export const WOMPI_EVENT_REJECTION_REASONS = [
  "MALFORMED_BODY",
  "MISSING_SIGNATURE",
  "AMBIGUOUS_TIMESTAMP",
  "UNRESOLVABLE_PROPERTY",
  "UNSUPPORTED_PROPERTY_VALUE",
  "CHECKSUM_MISMATCH",
  "ENVIRONMENT_MISMATCH",
] as const;

export type WompiEventRejectionReason = (typeof WOMPI_EVENT_REJECTION_REASONS)[number];

export type WompiEventSignature = {
  readonly properties: readonly string[];
  readonly checksum: string;
  readonly timestamp: number;
};

export type WompiEventEnvelope = {
  readonly event: string;
  readonly data: Record<string, unknown>;
  readonly sentAt: string | undefined;
  /** `test` for Sandbox, `prod` for Production. Undefined when the body omits it. */
  readonly environment: WompiEventEnvironment | undefined;
  readonly signature: WompiEventSignature;
};

const envelopeSchema = z.object({
  event: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  sent_at: z.string().optional(),
  environment: z.string().optional(),
  // Current documented shape: timestamp at the top level of the body.
  timestamp: z.union([z.number(), z.string().min(1)]).optional(),
  signature: z.object({
    properties: z.array(z.string().min(1)).min(1),
    // Optional: the checksum may instead arrive in the `X-Event-Checksum` header (Wompi
    // documents both carriers as equivalent). At least one of the two must be present and
    // match, which the verifier enforces.
    checksum: z.string().min(1).optional(),
    // Legacy/alternate shape: timestamp inside `signature`.
    timestamp: z.union([z.number(), z.string().min(1)]).optional(),
  }),
});

const transactionSchema = z.object({
  id: z.string().min(1),
  reference: z.string().min(1),
  status: z.string().min(1),
  amount_in_cents: z.number().int(),
  currency: z.string().min(1),
  customer_email: z.string().optional(),
  payment_method_type: z.string().optional(),
  status_message: z.string().optional(),
  created_at: z.string().optional(),
  finalized_at: z.string().optional(),
});

function parseTimestamp(value: number | string): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : undefined;
  }
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : undefined;
}

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: WompiEventEnvelope }
  | { readonly ok: false; readonly reason: WompiEventRejectionReason };

/** Parses and structurally validates an event envelope. */
export function parseWompiEventEnvelope(raw: unknown): EnvelopeParseResult {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "MALFORMED_BODY" };
  }

  const fromTopLevel =
    parsed.data.timestamp === undefined ? undefined : parseTimestamp(parsed.data.timestamp);
  const fromSignature =
    parsed.data.signature.timestamp === undefined
      ? undefined
      : parseTimestamp(parsed.data.signature.timestamp);

  if (
    parsed.data.timestamp !== undefined &&
    fromTopLevel === undefined &&
    fromSignature === undefined
  ) {
    return { ok: false, reason: "MISSING_SIGNATURE" };
  }
  if (parsed.data.signature.timestamp !== undefined && fromSignature === undefined) {
    return { ok: false, reason: "MISSING_SIGNATURE" };
  }

  // Both locations present with different values: the payload cannot be verified
  // unambiguously, so it is refused instead of guessed.
  if (fromTopLevel !== undefined && fromSignature !== undefined && fromTopLevel !== fromSignature) {
    return { ok: false, reason: "AMBIGUOUS_TIMESTAMP" };
  }

  const timestamp = fromTopLevel ?? fromSignature;
  if (timestamp === undefined) {
    return { ok: false, reason: "MISSING_SIGNATURE" };
  }

  return {
    ok: true,
    envelope: {
      event: parsed.data.event,
      data: parsed.data.data,
      sentAt: parsed.data.sent_at,
      environment: parseEnvironment(parsed.data.environment),
      signature: {
        properties: parsed.data.signature.properties,
        checksum: parsed.data.signature.checksum ?? "",
        timestamp,
      },
    },
  };
}

/** Maps the documented `environment` value; an unknown value is reported as undefined. */
function parseEnvironment(value: string | undefined): WompiEventEnvironment | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return (WOMPI_ENVIRONMENT_VALUES as readonly string[]).includes(normalized)
    ? (normalized as WompiEventEnvironment)
    : undefined;
}

/**
 * Resolves a dotted property path inside the event `data` object.
 * Rejects prototype-polluting paths and paths that do not resolve to a scalar.
 */
export function resolveEventProperty(
  data: Record<string, unknown>,
  path: string,
): { readonly ok: true; readonly value: string | number | boolean } | { readonly ok: false } {
  const segments = path.split(".");
  if (
    segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.includes(segment) || segment.length === 0)
  ) {
    return { ok: false };
  }

  let current: unknown = data;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return { ok: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { ok: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current === "string" || typeof current === "boolean") {
    return { ok: true, value: current };
  }
  if (typeof current === "number") {
    // Non-integer numbers would stringify ambiguously ("1" vs "1.0"), so they are
    // rejected instead of guessed. Wompi sends string identifiers and integer amounts.
    return Number.isInteger(current) ? { ok: true, value: current } : { ok: false };
  }
  return { ok: false };
}

export type ChecksumBuildResult =
  | { readonly ok: true; readonly payload: string }
  | { readonly ok: false; readonly reason: WompiEventRejectionReason; readonly property?: string };

/**
 * Builds the exact string that Wompi hashes for an event.
 * Exported so the concatenation (property order + timestamp + secret) can be asserted
 * in tests without digesting.
 */
export function buildEventChecksumPayload(
  envelope: WompiEventEnvelope,
  eventsSecret: string,
): ChecksumBuildResult {
  let payload = "";
  for (const property of envelope.signature.properties) {
    const resolved = resolveEventProperty(envelope.data, property);
    if (!resolved.ok) {
      return { ok: false, reason: "UNRESOLVABLE_PROPERTY", property };
    }
    payload += String(resolved.value);
  }
  payload += String(envelope.signature.timestamp);
  payload += eventsSecret;
  return { ok: true, payload };
}

export type WompiEventVerificationResult =
  | {
      readonly ok: true;
      readonly envelope: WompiEventEnvelope;
      readonly checksumUsed: "body" | "header";
    }
  | {
      readonly ok: false;
      readonly reason: WompiEventRejectionReason;
      readonly detail?: string;
    };

export type VerifyWompiEventInput = {
  /** Parsed JSON body of the webhook request. */
  readonly rawBody: unknown;
  readonly eventsSecret: string;
  /** `X-Event-Checksum` header value, when present. */
  readonly headerChecksum?: string | undefined;
  /**
   * Environment this deployment talks to. When set, an event whose `environment` says the
   * other side is rejected: a sandbox event must never confirm a production order.
   */
  readonly expectedEnvironment?: WompiEventEnvironment | undefined;
};

/**
 * Verifies that an event really came from Wompi.
 *
 * The checksum value is taken from `signature.checksum` and, as a fallback, from the
 * `X-Event-Checksum` header. The `signature` object itself must be present either way
 * because it carries `properties`, and the timestamp must be present because it is part of
 * the hash.
 */
export async function verifyWompiEvent(
  input: VerifyWompiEventInput,
): Promise<WompiEventVerificationResult> {
  const parsed = parseWompiEventEnvelope(input.rawBody);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const { envelope } = parsed;

  if (
    input.expectedEnvironment !== undefined &&
    envelope.environment !== undefined &&
    envelope.environment !== input.expectedEnvironment
  ) {
    return {
      ok: false,
      reason: "ENVIRONMENT_MISMATCH",
      detail: `event=${envelope.environment}`,
    };
  }

  const payload = buildEventChecksumPayload(envelope, input.eventsSecret);
  if (!payload.ok) {
    return {
      ok: false,
      reason: payload.reason,
      ...(payload.property === undefined ? {} : { detail: `property=${payload.property}` }),
    };
  }

  const computed = await sha256Hex(payload.payload);
  const fromBody = envelope.signature.checksum;
  const fromHeader = input.headerChecksum;

  // Neither carrier present: nothing to compare against, so the event is unauthenticated.
  if (fromBody.length === 0 && (fromHeader === undefined || fromHeader.length === 0)) {
    return { ok: false, reason: "MISSING_SIGNATURE" };
  }

  if (fromBody.length === 0 || !constantTimeEqualsHex(computed, fromBody)) {
    if (fromHeader === undefined || !constantTimeEqualsHex(computed, fromHeader)) {
      return { ok: false, reason: "CHECKSUM_MISMATCH" };
    }
    return { ok: true, envelope, checksumUsed: "header" };
  }

  return { ok: true, envelope, checksumUsed: "body" };
}

/**
 * Extracts the transaction payload of a `transaction.updated` event.
 * Returns undefined for other event types and for malformed transaction objects.
 */
export function extractTransactionEventPayload(
  envelope: WompiEventEnvelope,
): WompiTransactionEventPayload | undefined {
  if (envelope.event !== WOMPI_TRANSACTION_UPDATED_EVENT) {
    return undefined;
  }
  const parsed = transactionSchema.safeParse(envelope.data.transaction);
  if (!parsed.success) {
    return undefined;
  }
  return {
    id: parsed.data.id,
    reference: parsed.data.reference,
    status: parsed.data.status,
    amountInCents: parsed.data.amount_in_cents,
    currency: parsed.data.currency,
    customerEmail: parsed.data.customer_email,
    paymentMethodType: parsed.data.payment_method_type,
    statusMessage: parsed.data.status_message,
    createdAt: parsed.data.created_at,
    finalizedAt: parsed.data.finalized_at,
  };
}
