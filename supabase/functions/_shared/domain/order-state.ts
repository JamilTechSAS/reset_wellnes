/**
 * Order state machine.
 *
 * The states and transitions below are the authoritative reference for both the
 * database (Phase 2 constraints) and the backend logic. Order state answers
 * "where is this purchase?", while payment state answers "what did Wompi say about
 * this attempt?" — the two are deliberately separate (one order may have several
 * payment attempts).
 *
 * States
 * ------
 * PENDING    Order created, inventory reserved, price frozen. Waiting for payment.
 * PAID       An approved payment has been validated server-side. Tickets issued.
 * FAILED     The last payment attempt failed (declined/voided/error).
 * CANCELLED  Cancelled on purpose (buyer, operator or business rule).
 * EXPIRED    Reservation expired before payment completed; inventory released.
 *
 * EXPIRED is the one refinement over the initial PENDING/PAID/FAILED/CANCELLED set:
 * limited inventory per pricing stage must be reclaimable, so a reservation needs a
 * terminal state that is not a business cancellation. It is currently the only
 * addition, and `REFUNDED` is intentionally NOT implemented yet (documented as a
 * future state so no half-built refund flow exists in the codebase).
 *
 * Transitions
 * -----------
 *   PENDING   -> PAID | FAILED | CANCELLED | EXPIRED
 *   PAID      -> (terminal; refunds are a future state)
 *   FAILED    -> PENDING (new payment attempt) | CANCELLED
 *   EXPIRED   -> PENDING (re-reserve, only when inventory can be reclaimed) | CANCELLED
 *   CANCELLED -> (terminal)
 */

import { AppError } from "./errors.ts";

export const ORDER_STATUSES = ["PENDING", "PAID", "FAILED", "CANCELLED", "EXPIRED"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Spanish labels for operator-facing surfaces (emails, Google Sheets export). */
export const ORDER_STATUS_LABELS_ES: Record<OrderStatus, string> = {
  PENDING: "Pendiente de pago",
  PAID: "Pagada",
  FAILED: "Pago fallido",
  CANCELLED: "Cancelada",
  EXPIRED: "Expirada",
};

const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["PAID", "FAILED", "CANCELLED", "EXPIRED"],
  PAID: [],
  FAILED: ["PENDING", "CANCELLED"],
  EXPIRED: ["PENDING", "CANCELLED"],
  CANCELLED: [],
};

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

export function allowedOrderTransitions(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[from];
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[status].length === 0;
}

/** Only a PENDING order may be handed to Wompi for payment. */
export function isPayableOrderStatus(status: OrderStatus): boolean {
  return status === "PENDING";
}

/** True when the order still holds reserved inventory. */
export function holdsInventoryReservation(status: OrderStatus): boolean {
  return status === "PENDING";
}

/**
 * Throws a `CONFLICT` error when a transition is not allowed. Callers use this
 * before writing, so an out-of-order webhook can never move an order backwards.
 */
export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new AppError("CONFLICT", `Order transition ${from} -> ${to} is not allowed`, {
      context: { from, to },
    });
  }
}
