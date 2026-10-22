/**
 * Email delivery bookkeeping (Resend is the delivery provider).
 *
 * Requirement: repeated Wompi webhooks must never send the same confirmation twice.
 * The mechanism is database-first, not provider-first:
 *
 *   1. The post-payment workflow inserts an `email_deliveries` row with a unique
 *      idempotency key (`ticket:<ticketId>:<template>`). A duplicate insert either
 *      fails the unique constraint or finds the existing row, so only one send can be
 *      attempted at a time.
 *   2. The row moves QUEUED -> SENDING -> SENT (or FAILED with an attempt counter).
 *   3. Only rows that are retryable are picked up again by the retry job, with bounded
 *      exponential backoff.
 *
 * This module holds the pure parts: statuses, the idempotency key, and the backoff.
 */

export const EMAIL_TEMPLATES = ["TICKET_CONFIRMATION"] as const;

export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/** Spanish subject lines; used by the sender and by operator tooling. */
export const EMAIL_TEMPLATE_SUBJECTS_ES: Record<EmailTemplate, string> = {
  TICKET_CONFIRMATION: "Tu entrada está confirmada 🎟️",
};

export const EMAIL_DELIVERY_STATUSES = [
  "QUEUED",
  "SENDING",
  "SENT",
  "FAILED",
  "CANCELLED",
] as const;

export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export const EMAIL_DELIVERY_STATUS_LABELS_ES: Record<EmailDeliveryStatus, string> = {
  QUEUED: "En cola",
  SENDING: "Enviando",
  SENT: "Enviado",
  FAILED: "Falló",
  CANCELLED: "Cancelado",
};

export type EmailDeliveryKey = {
  readonly ticketId: string;
  readonly template: EmailTemplate;
};

/**
 * Unique key for one email of one template about one ticket.
 * Stored in a `unique` column, which is what actually prevents duplicate sends.
 */
export function buildEmailIdempotencyKey(key: EmailDeliveryKey): string {
  if (key.ticketId.trim().length === 0) {
    throw new RangeError("ticketId must not be empty");
  }
  return `ticket:${key.ticketId}:${key.template}`;
}

export function isEmailDeliveryStatus(value: string): value is EmailDeliveryStatus {
  return (EMAIL_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/** A delivery that finished successfully is final and must never be resent. */
export function isFinalDeliveryStatus(status: EmailDeliveryStatus): boolean {
  return status === "SENT" || status === "CANCELLED";
}

export function isRetryableDeliveryStatus(status: EmailDeliveryStatus): boolean {
  return status === "QUEUED" || status === "FAILED";
}

export const MAX_EMAIL_SEND_ATTEMPTS = 5;

/**
 * Backoff before attempt N (1-based). Bounded and deterministic so retries can be
 * reasoned about and tested: 1 min, 5 min, 15 min, 1 h, then capped at 6 h.
 */
export function computeEmailRetryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be a positive integer");
  }
  const minute = 60_000;
  const schedule = [1, 5, 15, 60, 360].map((minutes) => minutes * minute);
  const index = Math.min(attempt - 1, schedule.length - 1);
  return schedule[index] ?? 6 * 60 * minute;
}

/** Whether another attempt is allowed after `failedAttempts` failures. */
export function canAttemptEmailSend(failedAttempts: number): boolean {
  return failedAttempts < MAX_EMAIL_SEND_ATTEMPTS;
}
