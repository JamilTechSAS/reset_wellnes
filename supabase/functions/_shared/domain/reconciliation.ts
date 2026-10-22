/**
 * Payment reconciliation: vocabulary and decisions.
 *
 * A verified Wompi webhook is the normal way a payment converges; reconciliation is the
 * bounded safety net for the case where the delivery never arrived (or arrived only for
 * `PENDING`). It NEVER invents a payment decision: it re-reads the transaction with the
 * private key and feeds the SAME `confirm_payment` transaction the webhook uses.
 *
 * Verified Wompi facts this module depends on (docs.wompi.co, read 2026-10-03):
 *   * the only lookup is `GET /v1/transactions/{transaction_id}` with the private key —
 *     there is no query by reference, which is why only attempts with a known transaction
 *     id can be swept, and why the redirect URL's `?id=` is used as a buyer-supplied hint;
 *   * a used reference can never be reused;
 *   * statuses are PENDING | APPROVED | DECLINED | VOIDED | ERROR (anything else is
 *     stored raw and never advances the payment).
 *
 * The result/failure vocabularies below are persisted in `payments.last_reconciliation_*`
 * and enforced by CHECK constraints in migration 20261003210012; the schema suite asserts
 * parity so the two can never drift.
 */

import { CONFIRMATION_RESULTS, type ConfirmationResult } from "./payment-confirmation.ts";
import { mapWompiTransactionStatus, type InternalPaymentStatus } from "./payment-status.ts";

export const RECONCILIATION_RESULTS = [
  /** Wompi APPROVED and this sweep issued the tickets (or moved the order to review). */
  "APPROVED_APPLIED",
  /** Wompi APPROVED and the confirmation was already applied by an earlier delivery. */
  "APPROVED_DUPLICATE",
  /** Approved for an order that can no longer be fulfilled (CANCELLED/EXPIRED). */
  "RECONCILIATION_REQUIRED",
  /** Still PENDING at Wompi; the sweep will try again within the attempt budget. */
  "STILL_PENDING",
  "DECLINED",
  "VOIDED",
  "ERROR",
  /** A status this backend does not know; stored raw, never treated as success. */
  "UNKNOWN_STATUS",
  /** The transaction does not match the local order (amount/reference/currency/id). */
  "MISMATCH",
  /** Wompi answered 404 for a transaction id we had recorded; needs an operator. */
  "NOT_FOUND_AT_PROVIDER",
  /** The lookup itself failed; retried within the attempt budget. */
  "UPSTREAM_ERROR",
] as const;

export type ReconciliationResult = (typeof RECONCILIATION_RESULTS)[number];

export function isReconciliationResult(value: unknown): value is ReconciliationResult {
  return typeof value === "string" && (RECONCILIATION_RESULTS as readonly string[]).includes(value);
}

/**
 * Terminal results clear the next attempt: either the payment converged, or a human must
 * look at it. `STILL_PENDING`, `UNKNOWN_STATUS` and `UPSTREAM_ERROR` keep the schedule.
 */
export const TERMINAL_RECONCILIATION_RESULTS: readonly ReconciliationResult[] = [
  "APPROVED_APPLIED",
  "APPROVED_DUPLICATE",
  "RECONCILIATION_REQUIRED",
  "DECLINED",
  "VOIDED",
  "ERROR",
  "MISMATCH",
  "NOT_FOUND_AT_PROVIDER",
];

export function isTerminalReconciliationResult(result: ReconciliationResult): boolean {
  return TERMINAL_RECONCILIATION_RESULTS.includes(result);
}

/**
 * Results an operator must see: approved money on a non-payable order, a transaction that
 * does not match our record, or a recorded transaction Wompi no longer knows. Everything
 * else either converged or is still retrying within the budget.
 */
export function requiresReconciliationReview(result: ReconciliationResult): boolean {
  return (
    result === "RECONCILIATION_REQUIRED" ||
    result === "MISMATCH" ||
    result === "NOT_FOUND_AT_PROVIDER"
  );
}

export const RECONCILIATION_FAILURES = [
  "UPSTREAM_ERROR",
  "VALIDATION_MISMATCH",
  "PROVIDER_NOT_FOUND",
  "CONFIRMATION_FAILED",
] as const;

export type ReconciliationFailure = (typeof RECONCILIATION_FAILURES)[number];

export function isReconciliationFailure(value: unknown): value is ReconciliationFailure {
  return (
    typeof value === "string" && (RECONCILIATION_FAILURES as readonly string[]).includes(value)
  );
}

/** Failure classification for a result, when the result means something went wrong. */
export function failureForResult(result: ReconciliationResult): ReconciliationFailure | undefined {
  switch (result) {
    case "MISMATCH":
      return "VALIDATION_MISMATCH";
    case "NOT_FOUND_AT_PROVIDER":
      return "PROVIDER_NOT_FOUND";
    case "UPSTREAM_ERROR":
      return "UPSTREAM_ERROR";
    default:
      return undefined;
  }
}

/** Documented limits; the Edge Function passes them to the SQL claim. */
export const RECONCILIATION_DEFAULTS = {
  /** Sweeps per maintenance run. Bounded so one run cannot hammer Wompi. */
  batchSize: 10,
  /** Maximum sweeps per payment attempt; after this the attempt stays visible for review. */
  maxAttempts: 8,
  /** A transient Wompi failure is retried sooner than the normal backoff would. */
  upstreamRetryDelaySeconds: 120,
} as const;

/**
 * Backoff schedule, parity-tested against `app_private.reconciliation_delay_seconds`.
 * Indexed by the number of sweeps already completed (1-based), capped at 24 h.
 */
export const RECONCILIATION_DELAY_SECONDS = [
  120, 300, 900, 3600, 10800, 21600, 43200, 86400,
] as const;

export function reconciliationDelaySeconds(completedAttempts: number): number {
  const index = Math.min(
    Math.max(Math.trunc(completedAttempts), 1),
    RECONCILIATION_DELAY_SECONDS.length,
  );
  return RECONCILIATION_DELAY_SECONDS[index - 1] ?? RECONCILIATION_DELAY_SECONDS[0];
}

/**
 * Maps the outcome of a sweep to the persisted result.
 *
 * `confirmation` is `undefined` when the sweep only READ a still-pending transaction (no
 * confirmation ran). The mapping is deliberately explicit: a new confirmation result or a
 * new provider status fails the switch (exhaustiveness), instead of falling into a
 * permissive default.
 */
export function mapSweepOutcome(input: {
  readonly providerStatus: string;
  readonly confirmation: ConfirmationResult | undefined;
}): ReconciliationResult {
  const normalized = mapWompiTransactionStatus(input.providerStatus);
  const confirmation = input.confirmation;
  if (
    confirmation !== undefined &&
    !(CONFIRMATION_RESULTS as readonly string[]).includes(confirmation)
  ) {
    // Defensive: the type already closes the set, so this can only fire if an untyped
    // caller passes a raw string. Never echo it (it comes from the database).
    throw new Error("Unknown confirmation result");
  }

  if (confirmation === "RECONCILIATION_REQUIRED") {
    return "RECONCILIATION_REQUIRED";
  }

  if (normalized === "approved") {
    if (confirmation === "APPLIED") {
      return "APPROVED_APPLIED";
    }
    if (confirmation === "DUPLICATE") {
      return "APPROVED_DUPLICATE";
    }
    // Approved at Wompi but the sweep could not confirm it (the confirmation was not run
    // or threw): reported as a retryable failure, never silently as success.
    return "UPSTREAM_ERROR";
  }

  if (confirmation !== undefined) {
    // A non-approved transaction was applied: the order may have moved to FAILED, but no
    // ticket was issued and nothing approved.
    return resultForNonApproved(normalized);
  }

  if (normalized === "pending") {
    return "STILL_PENDING";
  }
  if (normalized === "unknown") {
    return "UNKNOWN_STATUS";
  }
  return resultForNonApproved(normalized);
}

function resultForNonApproved(status: InternalPaymentStatus): ReconciliationResult {
  switch (status) {
    case "declined":
      return "DECLINED";
    case "voided":
    case "refunded":
      // An approved-then-voided attempt is already `refunded` locally; the sweep reports it
      // as VOIDED in the raw vocabulary so operators can see what Wompi said.
      return "VOIDED";
    case "error":
      return "ERROR";
    case "approved":
      // Only reachable with an undefined confirmation, which cannot happen for an approved
      // transaction (the sweep confirms anything approved). Kept exhaustively safe.
      return "MISMATCH";
    case "pending":
      return "STILL_PENDING";
    case "unknown":
      return "UNKNOWN_STATUS";
  }
}
