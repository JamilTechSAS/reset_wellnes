/**
 * Order API handlers (runtime-agnostic).
 *
 * These are the orchestration layer: parse the request, call the database transaction, verify
 * the arithmetic it returned, and build the Wompi checkout payload. They hold no HTTP or Deno
 * specifics, so the exact code that runs in an Edge Function is what the unit tests exercise
 * (the thin `index.ts` adapters only read the request, the environment and the headers).
 *
 * Rules enforced here:
 *   - The client never supplies a price. The only amounts in the response come from the row
 *     the database just wrote.
 *   - The response is checked against its own parts (`assertQuoteConsistency`) before it is
 *     returned, so a database bug cannot silently charge a wrong amount.
 *   - No secret is ever placed in a response: the checkout payload carries the public key and
 *     the computed signature, never the integrity secret or the private key.
 */

import { DISCOUNT_CODE_REASONS, isDiscountCodeReason } from "../domain/pricing.ts";
import { copCents } from "../domain/money.ts";
import { validationError } from "../domain/errors.ts";
import { assertQuoteConsistency } from "../domain/pricing.ts";
import type { BackendConfig } from "../config/env.ts";
import type { CreateOrderResult, OrderGateway, QuoteResult } from "../db/orders.ts";
import type { Logger } from "../logging/logger.ts";
import { buildWompiCheckout, type WompiCheckout } from "../integrations/wompi/checkout.ts";
import { buildEpaycoCheckout } from "../integrations/epayco/checkout.ts";
import { createEpaycoApifyClient, type EpaycoApifyClient } from "../integrations/epayco/apify.ts";
import type { EpaycoCheckout } from "../integrations/epayco/types.ts";
import {
  parseCreateOrderRequest,
  parseQuoteRequest,
  type ParsedCreateOrderRequest,
} from "./order-requests.ts";

export type PaymentCheckout = WompiCheckout | EpaycoCheckout;

export type QuoteResponse = {
  readonly event: { readonly code: string; readonly name: string };
  readonly ticketType: { readonly code: string; readonly name: string };
  readonly quantity: number;
  readonly pricingTier: QuoteResult["pricingTier"];
  readonly subtotalInCents: number;
  readonly quantityDiscount: QuoteResult["quantityDiscount"];
  readonly quantityDiscountInCents: number;
  readonly discountCode: QuoteResult["discountCode"];
  readonly discountCodeInCents: number;
  readonly discountCombination: string;
  readonly totalDiscountInCents: number;
  readonly totalInCents: number;
  readonly currency: string;
  readonly availability: QuoteResult["availability"];
  readonly availableQuantity: number | null;
  readonly expiresAt: string;
};

export type CreateOrderResponse = {
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

/** Re-checks the arithmetic the database returned; throws if it does not add up. */
function verifyNumbers(input: {
  readonly unitPriceInCents: number;
  readonly quantity: number;
  readonly subtotalInCents: number;
  readonly quantityDiscountInCents: number;
  readonly discountCodeInCents: number;
  readonly totalDiscountInCents: number;
  readonly totalInCents: number;
}): void {
  assertQuoteConsistency({
    unitPrice: copCents(input.unitPriceInCents),
    quantity: input.quantity,
    subtotal: copCents(input.subtotalInCents),
    quantityDiscount: copCents(input.quantityDiscountInCents),
    codeDiscount: copCents(input.discountCodeInCents),
    totalDiscount: copCents(input.totalDiscountInCents),
    total: copCents(input.totalInCents),
  });
}

/**
 * `POST /pricing/quote`.
 *
 * A quote is informational: it reserves nothing. It never fails because a code is invalid —
 * it REPORTS why, so the checkout can explain it before the buyer submits. Availability is
 * bucketed (`LOW`/`SOLD_OUT`) instead of exposing exact inventory.
 */
export async function handleQuote(options: {
  readonly rawBody: unknown;
  readonly gateway: OrderGateway;
  readonly config: BackendConfig;
  readonly logger: Logger;
}): Promise<QuoteResponse> {
  const request = parseQuoteRequest(options.rawBody);

  const quote = await options.gateway.quote({
    eventCode: request.eventCode,
    ticketTypeCode: request.ticketTypeCode,
    quantity: request.quantity,
    discountCode: request.discountCode,
    reservationMinutes: options.config.orderReservationMinutes,
  });

  verifyNumbers({
    unitPriceInCents: quote.pricingTier.unitPriceInCents,
    quantity: quote.quantity,
    subtotalInCents: quote.subtotalInCents,
    quantityDiscountInCents: quote.quantityDiscountInCents,
    discountCodeInCents: quote.discountCodeInCents,
    totalDiscountInCents: quote.totalDiscountInCents,
    totalInCents: quote.totalInCents,
  });

  const reason = quote.discountCode.reason;
  if (!isDiscountCodeReason(reason)) {
    // A reason outside the documented set means the SQL and TypeScript contracts drifted.
    options.logger.error("quote returned an unknown discount reason", {
      reason,
      eventCode: request.eventCode,
    });
    throw validationError("Pricing response carried an unknown discount reason", {
      context: { reason },
    });
  }

  return {
    event: quote.event,
    ticketType: quote.ticketType,
    quantity: quote.quantity,
    pricingTier: quote.pricingTier,
    subtotalInCents: quote.subtotalInCents,
    quantityDiscount: quote.quantityDiscount,
    quantityDiscountInCents: quote.quantityDiscountInCents,
    discountCode: quote.discountCode,
    discountCodeInCents: quote.discountCodeInCents,
    discountCombination: quote.discountCombination,
    totalDiscountInCents: quote.totalDiscountInCents,
    totalInCents: quote.totalInCents,
    currency: quote.currency,
    availability: quote.availability,
    availableQuantity: quote.availableQuantity,
    expiresAt: quote.expiresAt,
  };
}

/**
 * Builds the checkout payload (ePayco or Wompi) for a freshly created (or replayed) order.
 */
async function buildCheckout(
  order: CreateOrderResult,
  config: BackendConfig,
  buyerEmail: string,
  epaycoApify?: EpaycoApifyClient,
): Promise<PaymentCheckout> {
  if (config.paymentProvider === "epayco") {
    const apify =
      epaycoApify ??
      createEpaycoApifyClient({
        publicKey: config.epayco.publicKey,
        privateKey: config.epayco.privateKey,
        test: config.epayco.test,
      });

    const amountInPesos = Math.round(order.totalInCents / 100);
    const session = await apify.createSession({
      checkoutVersion: "2",
      name: "Re set Sunset Vol. 1",
      description: `Entrada Re set Sunset Vol. 1 · Ref: ${order.reference}`,
      currency: order.currency,
      amount: amountInPesos,
      invoice: order.reference,
      response: config.wompiRedirectUrl,
      confirmation: `${config.apiBaseUrl}/webhooks-epayco`,
      test: config.epayco.test,
      taxBase: 0,
      tax: 0,
      taxIco: 0,
      country: "CO",
      lang: "ES",
    });
    const sessionId = session.sessionId;

    return buildEpaycoCheckout({
      sessionId,
      publicKey: config.epayco.publicKey,
      test: config.epayco.test,
      reference: order.wompiReference,
      amountInCents: order.totalInCents,
      currency: order.currency,
      redirectUrl: config.wompiRedirectUrl,
      confirmationUrl: `${config.apiBaseUrl}/webhooks-epayco`,
      customerData: {
        email: buyerEmail,
        fullName: undefined,
        phoneNumber: undefined,
        phoneNumberPrefix: undefined,
      },
    });
  }

  return buildWompiCheckout({
    publicKey: config.wompi.publicKey,
    integritySecret: config.wompi.integritySecret,
    reference: order.wompiReference,
    amountInCents: order.totalInCents,
    currency: order.currency,
    redirectUrl: config.wompiRedirectUrl,
    customerData: {
      email: buyerEmail,
      fullName: undefined,
      phoneNumber: undefined,
      phoneNumberPrefix: undefined,
    },
  });
}

/**
 * `POST /orders`.
 *
 * Creates the order atomically in the database and returns everything the frontend needs to
 * open Wompi Checkout. A replayed request (same idempotency key, same buyer) returns the
 * original order and a freshly computed signature for the SAME amount and reference, so a
 * network retry can safely reopen the checkout.
 *
 * @throws {AppError} NOT_FOUND / CONFLICT / VALIDATION_ERROR — mapped from SQLSTATE.
 */
export async function handleCreateOrder(options: {
  readonly rawBody: unknown;
  readonly idempotencyKey: string | undefined;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
  readonly gateway: OrderGateway;
  readonly config: BackendConfig;
  readonly logger: Logger;
  readonly epaycoApify?: EpaycoApifyClient | undefined;
}): Promise<CreateOrderResponse> {
  // Participant field problems are NOT swallowed: `ParticipantValidationError` is an
  // AppError (VALIDATION_ERROR) carrying `issues`, so the HTTP adapter answers 400 with
  // `details.issues[]` — the documented field-level contract.
  const request: ParsedCreateOrderRequest = parseCreateOrderRequest(options.rawBody);

  const order = await options.gateway.createOrder({
    eventCode: request.eventCode,
    ticketTypeCode: request.ticketTypeCode,
    quantity: request.quantity,
    discountCode: request.discountCode,
    reservationMinutes: options.config.orderReservationMinutes,
    buyerEmail: request.buyer.email,
    buyerName: request.buyer.fullName,
    buyerPhone: request.buyer.phone,
    participant: {
      firstName: request.participant.firstName,
      lastName: request.participant.lastName,
      nationalId: request.participant.nationalId,
      email: request.participant.email,
      phone: request.participant.phone,
      city: request.participant.city,
      ...(request.participant.instagram === undefined
        ? {}
        : { instagram: request.participant.instagram }),
      consents: request.participant.consents,
    },
    idempotencyKey: options.idempotencyKey,
    ipAddress: options.ipAddress,
    userAgent: options.userAgent,
  });

  // The database wrote this order; before it is handed to a buyer (and to Wompi), its own
  // numbers are re-checked against each other.
  verifyNumbers({
    unitPriceInCents: order.unitPriceInCents,
    quantity: order.quantity,
    subtotalInCents: order.subtotalInCents,
    quantityDiscountInCents: order.quantityDiscountInCents,
    discountCodeInCents: order.discountCodeInCents,
    totalDiscountInCents: order.totalDiscountInCents,
    totalInCents: order.totalInCents,
  });

  const checkout = await buildCheckout(
    order,
    options.config,
    request.buyer.email,
    options.epaycoApify,
  );

  options.logger.info(order.replayed ? "order replayed" : "order created", {
    orderId: order.orderId,
    reference: order.reference,
    quantity: order.quantity,
    totalInCents: order.totalInCents,
    currency: order.currency,
    replayed: order.replayed,
  });

  return {
    reference: order.reference,
    status: order.status,
    replayed: order.replayed,
    quantity: order.quantity,
    pricingTierName: order.pricingTierName,
    unitPriceInCents: order.unitPriceInCents,
    subtotalInCents: order.subtotalInCents,
    quantityDiscountInCents: order.quantityDiscountInCents,
    discountCodeInCents: order.discountCodeInCents,
    totalDiscountInCents: order.totalDiscountInCents,
    totalInCents: order.totalInCents,
    currency: order.currency,
    reservationExpiresAt: order.reservationExpiresAt,
    paymentAttempt: order.paymentAttempt,
    checkout,
  };
}

/**
 * Validates the `Idempotency-Key` header shape before it reaches the database.
 * Returns undefined when absent, so the order is created without retry protection
 * (the database column stays NULL and no uniqueness is claimed).
 */
export function parseIdempotencyKey(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length < 16 || trimmed.length > 128 || !/^[!-~]+$/.test(trimmed)) {
    throw validationError("Idempotency-Key must be 16 to 128 printable ASCII characters", {
      context: { surface: "idempotency" },
    });
  }
  return trimmed;
}

/** Exported for the handler tests: the full reason set the API understands. */
export { DISCOUNT_CODE_REASONS };
