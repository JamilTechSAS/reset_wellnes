/**
 * Payment status: mapping between Wompi transaction states and our internal model.
 *
 * Verified source (official docs `Transactions`, read 2026-10-03): a transaction can
 * be PENDING, APPROVED, DECLINED, VOIDED or ERROR. A newly created transaction is
 * always PENDING; PENDING / APPROVED / DECLINED / VOIDED / ERROR arrive through the
 * `transaction.updated` event.
 *
 * We always persist BOTH representations:
 * - `rawWompiStatus`: exactly what Wompi sent (never normalized away, never overwritten).
 * - `normalizedStatus`: our lowercase internal value used by business rules.
 *
 * Unknown values are mapped to `unknown` instead of throwing. `unknown` is treated as
 * non-terminal and non-successful, so a new Wompi status can never accidentally mark
 * an order as paid — it only shows up as an operational warning.
 */

export const WOMPI_TRANSACTION_STATUSES = [
  "PENDING",
  "APPROVED",
  "DECLINED",
  "VOIDED",
  "ERROR",
] as const;

export type WompiTransactionStatus = (typeof WOMPI_TRANSACTION_STATUSES)[number];

export const INTERNAL_PAYMENT_STATUSES = [
  "pending",
  "approved",
  "declined",
  "voided",
  "error",
  "unknown",
  "refunded",
] as const;

export type InternalPaymentStatus = (typeof INTERNAL_PAYMENT_STATUSES)[number];

/** Spanish labels for operator-facing surfaces. */
export const PAYMENT_STATUS_LABELS_ES: Record<InternalPaymentStatus, string> = {
  pending: "Pendiente",
  approved: "Aprobado",
  declined: "Rechazado",
  voided: "Anulado",
  error: "Error",
  unknown: "Desconocido",
  // Phase 4: an approved card payment that Wompi later voided. Recorded, never invented:
  // refunds are handled by a human (docs/phases/phase-04.md section 7).
  refunded: "Reembolsado",
};

export function isWompiTransactionStatus(value: string): value is WompiTransactionStatus {
  return (WOMPI_TRANSACTION_STATUSES as readonly string[]).includes(value);
}

export function isInternalPaymentStatus(value: string): value is InternalPaymentStatus {
  return (INTERNAL_PAYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Maps a raw Wompi status onto the internal model. Case-insensitive and tolerant of
 * surrounding whitespace because the value arrives over the network.
 */
export function mapWompiTransactionStatus(raw: string): InternalPaymentStatus {
  const normalized = raw.trim().toUpperCase();
  return isWompiTransactionStatus(normalized)
    ? (normalized.toLowerCase() as InternalPaymentStatus)
    : "unknown";
}

export type PaymentStatusSnapshot = {
  /** Raw status exactly as sent by Wompi. */
  readonly rawWompiStatus: string;
  /** Internal normalized status. */
  readonly normalizedStatus: InternalPaymentStatus;
};

export function toPaymentStatusSnapshot(raw: string): PaymentStatusSnapshot {
  return { rawWompiStatus: raw.trim(), normalizedStatus: mapWompiTransactionStatus(raw) };
}

/** True when no further changes are expected for this payment. */
export function isTerminalPaymentStatus(status: InternalPaymentStatus): boolean {
  return status !== "pending" && status !== "unknown";
}

/** The only status that may confirm an order and issue tickets. */
export function isSuccessfulPaymentStatus(status: InternalPaymentStatus): boolean {
  return status === "approved";
}

/** Statuses that mean "this attempt will not be paid". */
export function isFailedPaymentStatus(status: InternalPaymentStatus): boolean {
  return (
    status === "declined" || status === "voided" || status === "error" || status === "refunded"
  );
}

/**
 * Wompi retries a webhook up to 3 times (30 minutes, 3 hours, 24 hours) when we do
 * not answer HTTP 200, so the same status can legitimately arrive more than once.
 * A repeated status is never a state change: `advance` returns the current status.
 */
/**
 * Forward-only ranking, mirrored exactly by `app_private.payment_transition_rank`.
 *
 *   pending/unknown(0) < approved(1) < refunded(2) < voided(3) < declined(4) < error(5)
 *
 * The Phase 4 addition is `refunded` between approved and voided: an approved card
 * transaction that Wompi later VOIDs is a refund from the buyer's point of view, and
 * recording it as a plain void would conflate "never charged" with "charged and returned".
 */
export const PAYMENT_STATUS_RANK: Record<InternalPaymentStatus, number> = {
  pending: 0,
  unknown: 0,
  approved: 1,
  refunded: 2,
  voided: 3,
  declined: 4,
  error: 5,
};

export function advancePaymentStatus(
  current: InternalPaymentStatus,
  incoming: InternalPaymentStatus,
): InternalPaymentStatus {
  if (incoming === current) {
    return current;
  }
  // `unknown` is recorded in raw_wompi_status but never advances the normalized status: a
  // Wompi status we do not recognize must not be able to move anything, least of all to a
  // success.
  if (incoming === "unknown") {
    return current;
  }
  // `approved` is terminal for the attempt, with one exception: Wompi never un-approves,
  // so a later VOIDED is a refund from the buyer's point of view. A later DECLINED or ERROR
  // is just recorded. `confirm_payment` enforces the same rule in SQL.
  if (current === "approved" || current === "refunded") {
    if (incoming === "voided") {
      return current === "approved" ? "refunded" : current;
    }
    return incoming === "refunded" ? "refunded" : current;
  }
  // Terminal (final) statuses never regress: an out-of-order or replayed event cannot
  // move a payment backwards.
  if (PAYMENT_STATUS_RANK[incoming] > PAYMENT_STATUS_RANK[current]) {
    return incoming;
  }
  return current;
}
