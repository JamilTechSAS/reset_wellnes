/**
 * Buyer-facing order endpoints.
 *
 *   GET  /orders/{reference}         current state, tickets once paid, confirmation status
 *   POST /orders/{reference}/retry   a new payment attempt with a fresh Wompi reference
 *
 * ACCESS MODEL (the question the brief asks explicitly: is the order reference unguessable?)
 *
 *   No. `EVT-2026-000001` is sequential, so anyone can enumerate references. Two
 *   protections are therefore required before any order data leaves the backend:
 *
 *   1. the endpoint returns a WHITELIST of fields (built in SQL, not in TypeScript), so
 *      adding a column to `orders`/`participants` cannot leak it by accident;
 *   2. every response requires the buyer's email to match the order — the same possession
 *      check the idempotency replay uses. A wrong email and an unknown reference return
 *      the SAME 404, so the endpoint cannot be used to discover which references exist.
 *
 *   The buyer email is compared after normalization (trim + lowercase) and only for the
 *   order that owns the reference. Ticket tokens are returned ONLY for a paid order, and
 *   the retry endpoint returns a checkout payload only after the retry was accepted.
 */

import { notFoundError, toAppError, validationError } from "../domain/errors.ts";
import type { BackendConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";
import type { OrderStatus, OrderStatusGateway, PaymentGateway } from "../db/payments.ts";
import { buildWompiCheckout, type WompiCheckout } from "../integrations/wompi/checkout.ts";

/** Normalizes an email the same way the order row stores it. */
export function normalizeLookupEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type OrderStatusRequest = {
  readonly reference: string;
  readonly email: string;
};

/**
 * The subset of the SQL projection that is safe to hand to a browser.
 *
 * `paymentAttempts[].wompiReference` is included on purpose: it is the identifier the buyer
 * sees on their Wompi receipt and support needs it. It is not a capability — it cannot be
 * used to query Wompi without the private key, and the reference is already part of the
 * order reference the buyer was given.
 */
export type OrderStatusResponse = {
  readonly reference: string;
  readonly status: string;
  readonly quantity: number;
  readonly totalInCents: number;
  readonly currency: string;
  readonly createdAt: string | null;
  readonly paidAt: string | null;
  readonly reservationExpiresAt: string | null;
  readonly payment: {
    readonly attempt: number;
    readonly status: string;
    readonly methodType: string | null;
    readonly statusMessage: string | null;
    readonly approvedAt: string | null;
  } | null;
  readonly paymentAttempts: readonly {
    readonly attempt: number;
    readonly status: string;
    readonly wompiReference: string;
    readonly amountInCents: number;
    readonly createdAt: string;
    readonly finalizedAt: string | null;
  }[];
  readonly tickets: readonly {
    readonly token: string;
    readonly unit: number;
    readonly status: string;
    readonly assigned: boolean;
    readonly pricePaidCents: number;
    readonly participantName: string | null;
  }[];
  readonly confirmation: {
    readonly queued: number;
    readonly sent: number;
    readonly failed: number;
    readonly ready: boolean;
  } | null;
};

function toResponse(status: OrderStatus): OrderStatusResponse {
  return {
    reference: status.reference ?? "",
    status: status.status ?? "PENDING",
    quantity: status.quantity ?? 0,
    totalInCents: status.totalInCents ?? 0,
    currency: status.currency ?? "COP",
    createdAt: status.createdAt ?? null,
    paidAt: status.paidAt ?? null,
    reservationExpiresAt: status.reservationExpiresAt ?? null,
    payment: status.payment ?? null,
    paymentAttempts: (status.paymentAttempts ?? []).map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      wompiReference: attempt.wompiReference,
      amountInCents: attempt.amountInCents,
      createdAt: attempt.createdAt,
      finalizedAt: attempt.finalizedAt,
    })),
    // The buyer's own tickets. `assigned` tells the future frontend whether an attendee
    // has been attached to a unit yet; the participant's name is included because the
    // buyer supplied it, and only for the order they just proved they own.
    tickets: (status.tickets ?? []).map((ticket) => ({
      token: ticket.token,
      unit: ticket.unit,
      status: ticket.status,
      assigned: ticket.assigned,
      pricePaidCents: ticket.pricePaidCents,
      participantName:
        ticket.participant === null
          ? null
          : `${ticket.participant.firstName} ${ticket.participant.lastName}`.trim(),
    })),
    confirmation: status.confirmation ?? null,
  };
}

/**
 * `GET /orders/{reference}`.
 *
 * @throws {AppError} NOT_FOUND — for an unknown reference, a wrong email, or a cancelled
 *   order. All three are indistinguishable from outside, which is the point.
 */
export async function handleOrderStatus(options: {
  readonly reference: string;
  readonly email: string;
  readonly gateway: OrderStatusGateway;
  readonly logger: Logger;
}): Promise<OrderStatusResponse> {
  const reference = options.reference.trim();
  if (!/^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]+)?$/.test(reference)) {
    throw validationError("Order reference has an unexpected format", {
      context: { surface: "order-status" },
    });
  }
  const email = normalizeLookupEmail(options.email);
  if (email.length === 0) {
    throw validationError("Buyer email is required to read an order", {
      context: { surface: "order-status" },
    });
  }

  // The database compares reference AND buyer email, and returns the same `found: false`
  // for an unknown reference, a wrong email and a nonexistent order. Nothing about which
  // references exist can be learned from the outside.
  const status = await options.gateway.getOrderStatus(reference, email);
  if (!status.found || status.reference !== reference) {
    throw notFoundError("Order reference is unknown", { context: { surface: "order-status" } });
  }

  options.logger.info("order status read", {
    reference,
    status: status.status ?? "unknown",
    ticketCount: status.tickets?.length ?? 0,
  });

  return toResponse(status);
}

// ---------------------------------------------------------------------------
// Payment retry
// ---------------------------------------------------------------------------

export type PaymentRetryResponse = {
  readonly reference: string;
  readonly status: string;
  readonly paymentAttempt: number;
  readonly totalInCents: number;
  readonly currency: string;
  readonly reservationExpiresAt: string | null;
  readonly checkout: WompiCheckout;
};

/**
 * `POST /orders/{reference}/retry`.
 *
 * Only a FAILED or EXPIRED order can be retried. The database performs the transition and
 * creates the new attempt; this handler only builds the checkout payload for the reference
 * the database returned, so the amount and the integrity signature can never disagree with
 * what is stored.
 */
export async function handlePaymentRetry(options: {
  readonly reference: string;
  readonly email: string;
  readonly payments: PaymentGateway;
  readonly orderStatus: OrderStatusGateway;
  readonly config: BackendConfig;
  readonly logger: Logger;
}): Promise<PaymentRetryResponse> {
  const reference = options.reference.trim();
  if (!/^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]+)?$/.test(reference)) {
    throw validationError("Order reference has an unexpected format", {
      context: { surface: "retry" },
    });
  }
  const email = normalizeLookupEmail(options.email);
  if (email.length === 0) {
    throw validationError("Buyer email is required to retry a payment", {
      context: { surface: "retry" },
    });
  }

  // Ownership first: the retry endpoint must not reveal whether a reference exists. The
  // same check runs again inside the database transaction, where it cannot be raced.
  const current = await options.orderStatus.getOrderStatus(reference, email);
  if (!current.found || current.reference !== reference) {
    throw notFoundError("Order reference is unknown", { context: { surface: "retry" } });
  }

  try {
    const retry = await options.payments.retryPayment({
      orderReference: reference,
      buyerEmail: email,
      reservationMinutes: options.config.orderReservationMinutes,
    });

    const checkout = await buildWompiCheckout({
      publicKey: options.config.wompi.publicKey,
      integritySecret: options.config.wompi.integritySecret,
      reference: retry.wompiReference,
      amountInCents: retry.totalInCents,
      currency: retry.currency,
      redirectUrl: options.config.wompiRedirectUrl,
      customerData: {
        email,
        fullName: undefined,
        phoneNumber: undefined,
        phoneNumberPrefix: undefined,
      },
    });

    options.logger.info("payment retry created", {
      reference: retry.reference,
      attempt: retry.paymentAttempt,
      amountInCents: retry.totalInCents,
    });

    return {
      reference: retry.reference,
      status: retry.status,
      paymentAttempt: retry.paymentAttempt,
      totalInCents: retry.totalInCents,
      currency: retry.currency,
      reservationExpiresAt: retry.reservationExpiresAt,
      checkout,
    };
  } catch (error) {
    const appError = toAppError(error);
    options.logger.warn("payment retry refused", {
      reference,
      code: appError.code,
      detail: appError.context.detail ?? null,
    });
    throw appError;
  }
}
