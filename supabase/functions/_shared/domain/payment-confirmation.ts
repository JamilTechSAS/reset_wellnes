/**
 * Payment confirmation: the pure rules that turn a verified Wompi transaction into a
 * business outcome.
 *
 * This module is the SPECIFICATION; `public.confirm_payment` in the database is the
 * implementation that actually writes. Both are tested, and the handler reconciles the
 * two: everything here is a decision, never a side effect.
 *
 * Two ideas carry the whole phase:
 *
 *   1. The webhook payload is NOT the payment decision. It is only an identity (which
 *      event arrived, which transaction to look at). The decision comes from the
 *      transaction the backend re-reads from Wompi with the private key. A forged event
 *      therefore cannot approve anything even if it somehow produced a valid checksum.
 *
 *   2. Confirmation is a fixed sequence of forward-only steps. Every step either does
 *      nothing (the state is already there) or moves forward; nothing can move backwards,
 *      so replaying an event any number of times, in any order, converges.
 */

import { sha256Hex } from "../integrations/wompi/signature.ts";
import type { WompiEventEnvelope } from "../integrations/wompi/events.ts";
import type { WompiTransaction } from "../integrations/wompi/types.ts";
import { WOMPI_SUPPORTED_CURRENCY } from "../integrations/wompi/types.ts";

/**
 * Outcomes of `public.confirm_payment`, mirrored here so the handler can branch on a
 * closed set instead of comparing raw SQL strings.
 */
export const CONFIRMATION_RESULTS = [
  /** Something changed: payment recorded, order paid, tickets issued. */
  "APPLIED",
  /** The transaction was already fully reflected; nothing changed (replay). */
  "DUPLICATE",
  /** Approved money for an order that can no longer be fulfilled: manual review. */
  "RECONCILIATION_REQUIRED",
] as const;

export type ConfirmationResult = (typeof CONFIRMATION_RESULTS)[number];

export function isConfirmationResult(value: unknown): value is ConfirmationResult {
  return typeof value === "string" && (CONFIRMATION_RESULTS as readonly string[]).includes(value);
}

/** Machine-readable reasons returned by the confirmation function. */
export const CONFIRMATION_REASONS = [
  "PAYMENT_APPROVED",
  "PAYMENT_PENDING",
  "PAYMENT_DECLINED",
  "PAYMENT_VOIDED",
  "PAYMENT_REFUNDED",
  "PAYMENT_ERROR",
  "UNKNOWN_PROVIDER_STATUS",
  "ORDER_NOT_PAYABLE_CANCELLED",
  "ORDER_NOT_PAYABLE_EXPIRED",
] as const;

export type ConfirmationReason = (typeof CONFIRMATION_REASONS)[number];

export function isConfirmationReason(value: unknown): value is ConfirmationReason {
  return typeof value === "string" && (CONFIRMATION_REASONS as readonly string[]).includes(value);
}

/** True when the outcome needs a human: approved money on a non-payable order. */
export function requiresOperatorReview(result: ConfirmationResult): boolean {
  return result === "RECONCILIATION_REQUIRED";
}

// ---------------------------------------------------------------------------
// Event identity (deduplication)
// ---------------------------------------------------------------------------

/**
 * Canonical identity of a delivered event.
 *
 * Built from the event name, the resolved values of `signature.properties` (in the order
 * Wompi listed them) and the signature timestamp — everything that makes two deliveries
 * "the same event" — but NOT the events secret, so the key is stable across a secret
 * rotation and does not depend on the environment.
 *
 * Wompi redelivers the same event with the same `sent_at`/timestamp, so the key is stable
 * across retries. Two genuinely different events (for example PENDING then APPROVED) have
 * different property values and therefore different keys.
 *
 * The same construction is used for rejected deliveries with a `rejected:` prefix, so a
 * forged event can never occupy the dedupe slot of the genuine event it imitates. That is
 * not a theoretical concern: without the prefix, one spoofed delivery would make the real
 * payment notification look like a duplicate and the order would never be confirmed.
 */
export function buildEventFingerprint(envelope: WompiEventEnvelope): string | undefined {
  const parts: string[] = [];
  for (const property of envelope.signature.properties) {
    const value = resolvePropertyForFingerprint(envelope.data, property);
    if (value === undefined) {
      return undefined;
    }
    parts.push(`${property}=${value}`);
  }
  parts.push(`timestamp=${String(envelope.signature.timestamp)}`);
  return `${envelope.event}|${parts.join("|")}`;
}

/**
 * Local copy of the dotted-path resolver, deliberately independent from the verification
 * module so the fingerprint can also be computed for a payload that FAILED verification.
 * Anything unresolvable returns undefined; the caller then records nothing.
 */
function resolvePropertyForFingerprint(
  data: Record<string, unknown>,
  path: string,
): string | undefined {
  const segments = path.split(".");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || ["__proto__", "prototype", "constructor"].includes(segment),
    )
  ) {
    return undefined;
  }
  let current: unknown = data;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "string" || typeof current === "boolean") {
    return String(current);
  }
  if (typeof current === "number" && Number.isInteger(current)) {
    return String(current);
  }
  return undefined;
}

/**
 * Dedupe key stored in `payment_events.dedupe_key` (printable ASCII, 16-200 characters).
 * `accepted` selects the namespace: an authenticated delivery owns the plain key, a
 * rejected one owns only the `rejected:` variant.
 */
export async function buildEventDedupeKey(
  envelope: WompiEventEnvelope,
  options: { readonly accepted: boolean },
): Promise<string | undefined> {
  const fingerprint = buildEventFingerprint(envelope);
  if (fingerprint === undefined) {
    return undefined;
  }
  const digest = await sha256Hex(`${options.accepted ? "event" : "rejected"}:${fingerprint}`);
  return `${options.accepted ? "evt" : "rej"}:${digest}`;
}

// ---------------------------------------------------------------------------
// Transaction validation
// ---------------------------------------------------------------------------

export type TransactionValidationProblem =
  | "TRANSACTION_ID_MISMATCH"
  | "REFERENCE_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "MISSING_TRANSACTION_ID";

export type TransactionValidationInput = {
  /** Transaction as returned by `GET /v1/transactions/{id}` with the private key. */
  readonly transaction: WompiTransaction;
  /** Transaction id that the (verified) event pointed at. */
  readonly eventTransactionId: string;
  /** Reference the event carried; informational, the authoritative one is on the row. */
  readonly eventReference: string;
  /** Local payment attempt this order created for that reference. */
  readonly payment: {
    readonly wompiReference: string;
    readonly wompiTransactionId: string | null;
    readonly amountCents: number;
    readonly currency: string;
  };
  readonly order: { readonly totalInCents: number; readonly currency: string };
};

/**
 * Compares the Wompi transaction against our own record. Any problem at all means the
 * payment must NOT be approved: the caller records the event, leaves the payment
 * untouched and logs it.
 *
 * The comparison is exact and integer-based. There is no tolerance: `$95.000` is
 * 9500000 centavos on both sides or the transaction is not ours.
 */
export function validateTransactionAgainstPayment(
  input: TransactionValidationInput,
): readonly TransactionValidationProblem[] {
  // A set, not a list: one comparison can be violated in two ways (for example the
  // transaction reference AND the event reference both disagreeing), and reporting the same
  // code twice would make the log line read like two separate problems.
  const problems = new Set<TransactionValidationProblem>();
  const { transaction, payment, order } = input;

  if (transaction.id.trim().length === 0) {
    problems.add("MISSING_TRANSACTION_ID");
  } else if (transaction.id !== input.eventTransactionId) {
    // The lookup was performed with the id from the verified event; a different id in the
    // response means the two pieces of information do not belong together.
    problems.add("TRANSACTION_ID_MISMATCH");
  }

  // The reference on the Wompi transaction is the authoritative one. The event's copy is
  // only a hint; if the two disagree, something is wrong with the delivery itself.
  if (
    transaction.reference !== payment.wompiReference ||
    input.eventReference !== payment.wompiReference
  ) {
    problems.add("REFERENCE_MISMATCH");
  }
  if (payment.wompiTransactionId !== null && payment.wompiTransactionId !== transaction.id) {
    problems.add("TRANSACTION_ID_MISMATCH");
  }

  if (
    transaction.amountInCents !== payment.amountCents ||
    transaction.amountInCents !== order.totalInCents
  ) {
    problems.add("AMOUNT_MISMATCH");
  }

  if (
    transaction.currency.trim().toUpperCase() !== WOMPI_SUPPORTED_CURRENCY ||
    payment.currency !== WOMPI_SUPPORTED_CURRENCY ||
    order.currency !== WOMPI_SUPPORTED_CURRENCY
  ) {
    problems.add("CURRENCY_MISMATCH");
  }

  return [...problems];
}

/**
 * Shortest safe Wompi status message we are willing to persist. Provider messages can
 * contain customer-visible text but never secrets; the length bound keeps a hostile or
 * broken payload from bloating the row.
 */
export const MAX_STATUS_MESSAGE_LENGTH = 300;

export function boundStatusMessage(message: string | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  const trimmed = message.trim().replace(/[\n\r\t]+/g, " ");
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, MAX_STATUS_MESSAGE_LENGTH);
}
