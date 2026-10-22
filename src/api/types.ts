/**
 * Types for the frozen backend contract (Phase 6B).
 *
 * These mirror the response shapes documented in `docs/api.md` and implemented in
 * `supabase/functions/_shared/api/*`. They describe what the backend RETURNS; the frontend
 * never invents a field, and never treats a value here as authoritative business truth
 * (price, availability and payment state always come from a fresh backend response).
 */

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type ApiErrorBody = {
  readonly code: string;
  readonly message: string;
  readonly details?: { readonly issues?: readonly ApiFieldIssue[] } | undefined;
};

export type ApiFieldIssue = {
  readonly path: string;
  readonly message: string;
};

// ---------------------------------------------------------------------------
// GET /events/{code}
// ---------------------------------------------------------------------------

export type AvailabilityLabel = "AVAILABLE" | "LOW" | "SOLD_OUT" | "NOT_STARTED" | "CLOSED";

export type PublicPricingTier = {
  readonly name: string;
  readonly sequence: number;
  readonly priceInCents: number;
};

export type PublicTicketType = {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly minPerOrder: number;
  readonly maxPerOrder: number | null;
  readonly salesOpen: boolean;
  readonly availability: AvailabilityLabel;
  readonly currentTier: PublicPricingTier | null;
};

export type PublicSales = {
  readonly currency: string;
  readonly salesOpen: boolean;
  readonly availability: AvailabilityLabel;
  readonly ticketTypes: readonly PublicTicketType[];
};

export type PublicEvent = {
  readonly found: true;
  readonly event: {
    readonly code: string;
    readonly name: string;
    readonly description: string | null;
    readonly status: string;
    readonly startsAt: string;
    readonly endsAt: string | null;
    readonly timezone: string;
    readonly currency: string;
    readonly venue: {
      readonly name: string | null;
      readonly address: string | null;
      readonly city: string | null;
    };
  };
  readonly sales: PublicSales;
};

export type PublicAvailability = {
  readonly found: true;
  readonly code: string;
  readonly sales: PublicSales;
};

// ---------------------------------------------------------------------------
// POST /orders/quote
// ---------------------------------------------------------------------------

export const DISCOUNT_CODE_REASONS = [
  "NOT_SUPPLIED",
  "NOT_FOUND",
  "INACTIVE",
  "NOT_STARTED",
  "EXPIRED",
  "EXHAUSTED",
  "WRONG_TICKET_TYPE",
  "WRONG_SALES_STAGE",
  "MIN_QUANTITY",
  "WRONG_QUANTITY",
  "OK",
] as const;

export type DiscountCodeReason = (typeof DISCOUNT_CODE_REASONS)[number];

export type QuoteDiscountCode = {
  readonly supplied: boolean;
  readonly applies: boolean;
  readonly reason: DiscountCodeReason;
  readonly code: string | null;
  readonly kind: string | null;
  readonly percentBps: number | null;
  readonly amountInCents: number;
  readonly remainingRedemptions: number | null;
};

export type Quote = {
  readonly event: { readonly code: string; readonly name: string };
  readonly ticketType: { readonly code: string; readonly name: string };
  readonly quantity: number;
  readonly pricingTier: {
    readonly name: string;
    readonly sequence: number;
    readonly unitPriceInCents: number;
  };
  readonly subtotalInCents: number;
  readonly quantityDiscount: {
    readonly applies: boolean;
    readonly percentBps: number;
    readonly amountInCents: number;
  };
  readonly quantityDiscountInCents: number;
  readonly discountCode: QuoteDiscountCode;
  readonly discountCodeInCents: number;
  readonly discountCombination: string;
  readonly totalDiscountInCents: number;
  readonly totalInCents: number;
  readonly currency: string;
  readonly availability: AvailabilityLabel;
  readonly availableQuantity: number | null;
  readonly expiresAt: string;
};

// ---------------------------------------------------------------------------
// POST /orders
// ---------------------------------------------------------------------------

/** The only secret-free checkout material the browser is allowed to hold. */
export type WompiCheckout = {
  readonly publicKey: string;
  readonly currency: string;
  readonly amountInCents: number;
  readonly reference: string;
  readonly integritySignature: string;
  readonly expirationTime: string | null;
  readonly redirectUrl: string | null;
  readonly customerData: {
    readonly email: string | null;
    readonly fullName: string | null;
    readonly phoneNumber: string | null;
    readonly phoneNumberPrefix: string | null;
  };
};

/** Secret-free ePayco Smart Checkout V2 material returned by the backend. */
export type EpaycoCheckout = {
  readonly provider: "epayco";
  readonly sessionId?: string | undefined;
  readonly publicKey: string;
  readonly test: boolean;
  readonly reference: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly redirectUrl: string | null;
  readonly confirmationUrl: string | null;
  readonly customerData: {
    readonly email: string | null;
    readonly fullName: string | null;
    readonly phoneNumber: string | null;
    readonly phoneNumberPrefix: string | null;
  };
};

export type PaymentCheckout = WompiCheckout | EpaycoCheckout;

export function isEpaycoCheckout(checkout: PaymentCheckout): checkout is EpaycoCheckout {
  return "provider" in checkout;
}

export type CreatedOrder = {
  readonly reference: string;
  readonly status: string;
  readonly replayed: boolean;
  readonly quantity: number;
  readonly pricingTierName: string;
  readonly unitPriceInCents: number;
  readonly subtotalInCents: number;
  readonly quantityDiscountInCents: number;
  readonly discountCodeInCents: number;
  readonly totalDiscountInCents: number;
  readonly totalInCents: number;
  readonly currency: string;
  readonly reservationExpiresAt: string;
  readonly paymentAttempt: number;
  readonly checkout: PaymentCheckout;
};

// ---------------------------------------------------------------------------
// GET /orders/{reference}
// ---------------------------------------------------------------------------

export type OrderStatusValue = "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "CANCELLED";

export type OrderTicket = {
  readonly token: string;
  readonly unit: number;
  readonly status: string;
  readonly assigned: boolean;
  readonly pricePaidCents: number;
  readonly participantName: string | null;
};

export type OrderConfirmationStatus = {
  readonly queued: number;
  readonly sent: number;
  readonly failed: number;
  readonly ready: boolean;
};

export type OrderStatus = {
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
  readonly tickets: readonly OrderTicket[];
  readonly confirmation: OrderConfirmationStatus | null;
};

// ---------------------------------------------------------------------------
// POST /orders/{reference}/retry  and  POST /orders/{reference}/payment-hint
// ---------------------------------------------------------------------------

export type RetriedPayment = {
  readonly reference: string;
  readonly status: string;
  readonly paymentAttempt: number;
  readonly totalInCents: number;
  readonly currency: string;
  readonly reservationExpiresAt: string | null;
  readonly checkout: WompiCheckout;
};

export type PaymentHintOutcome =
  | "APPROVED_APPLIED"
  | "APPROVED_DUPLICATE"
  | "RECONCILIATION_REQUIRED"
  | "STILL_PENDING"
  | "DECLINED"
  | "VOIDED"
  | "ERROR"
  | "UNKNOWN_STATUS"
  | "MISMATCH"
  | "TRANSACTION_NOT_FOUND";

export type PaymentHint = {
  readonly orderReference: string;
  readonly orderStatus: string;
  readonly paymentStatus: string;
  readonly outcome: PaymentHintOutcome;
};
