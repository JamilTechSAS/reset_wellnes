/**
 * Check-in decisions.
 *
 * This module is the pure decision layer: given a resolved ticket (with its order and
 * payment state) it answers whether the person may enter. Persistence and atomicity
 * belong to the database (Phase 8): the check-in operation must be a single
 * transaction that inserts at most one attendance row per ticket
 * (`unique (ticket_id)` on `attendance`), so the first valid scan wins and
 * near-simultaneous scans can never produce two attendance rows.
 *
 * Precedence (the first matching rule wins; documented because operators ask about it):
 *   1. unknown token            -> INVALID   (no ticket, nothing to disclose)
 *   2. cancelled/refunded       -> CANCELLED
 *   3. order/payment not paid   -> NOT_PAID
 *   4. already checked in       -> ALREADY_USED
 *   5. otherwise                -> VALID
 *
 * Order matters: a cancelled ticket that was never paid reports CANCELLED (the ticket
 * state the operator can act on), and an unpaid ticket that somehow has an attendance
 * row reports NOT_PAID rather than admitting the person.
 */

import type { InternalPaymentStatus } from "./payment-status.ts";
import type { OrderStatus } from "./order-state.ts";
import type { TicketStatus } from "./tickets.ts";
import { isRedeemableTicketStatus } from "./tickets.ts";
import { isSuccessfulPaymentStatus } from "./payment-status.ts";

export const CHECKIN_OUTCOMES = [
  "VALID",
  "ALREADY_USED",
  "INVALID",
  "NOT_PAID",
  "CANCELLED",
] as const;

export type CheckInOutcome = (typeof CHECKIN_OUTCOMES)[number];

/** Spanish messages for the operator-facing check-in screen. */
export const CHECKIN_OUTCOME_LABELS_ES: Record<CheckInOutcome, string> = {
  VALID: "Ingreso permitido",
  ALREADY_USED: "Este código ya fue usado",
  INVALID: "Código no válido",
  NOT_PAID: "Sin pago confirmado",
  CANCELLED: "Entrada cancelada",
};

export type CheckInTicketSnapshot = {
  readonly ticketId: string;
  readonly ticketStatus: TicketStatus;
  readonly orderStatus: OrderStatus;
  readonly paymentStatus: InternalPaymentStatus;
};

export type CheckInDecisionInput = {
  /** Resolved ticket, or undefined when the token does not exist. */
  readonly ticket: CheckInTicketSnapshot | undefined;
  /** Whether an attendance row already exists for this ticket. */
  readonly alreadyCheckedIn: boolean;
};

export type CheckInDecision = {
  readonly outcome: CheckInOutcome;
  /** Stable English reason code for logs and metrics (never shows personal data). */
  readonly reason: string;
  readonly ticketId: string | undefined;
};

export function decideCheckIn(input: CheckInDecisionInput): CheckInDecision {
  const { ticket, alreadyCheckedIn } = input;

  if (ticket === undefined) {
    return { outcome: "INVALID", reason: "TICKET_NOT_FOUND", ticketId: undefined };
  }

  if (!isRedeemableTicketStatus(ticket.ticketStatus)) {
    return {
      outcome: "CANCELLED",
      reason: `TICKET_${ticket.ticketStatus}`,
      ticketId: ticket.ticketId,
    };
  }

  const paymentApproved = isSuccessfulPaymentStatus(ticket.paymentStatus);
  const orderPaid = ticket.orderStatus === "PAID";
  if (!paymentApproved || !orderPaid) {
    return {
      outcome: "NOT_PAID",
      reason: !orderPaid
        ? `ORDER_${ticket.orderStatus}`
        : `PAYMENT_${ticket.paymentStatus.toUpperCase()}`,
      ticketId: ticket.ticketId,
    };
  }

  if (alreadyCheckedIn) {
    return { outcome: "ALREADY_USED", reason: "ATTENDANCE_EXISTS", ticketId: ticket.ticketId };
  }

  return { outcome: "VALID", reason: "OK", ticketId: ticket.ticketId };
}

/** Only a VALID decision admits the participant. */
export function mayEnterWithOutcome(outcome: CheckInOutcome): boolean {
  return outcome === "VALID";
}
