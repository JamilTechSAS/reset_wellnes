/**
 * Order API handlers (runtime-agnostic).
 *
 * These are the orchestration layer: parse the request, call the database transaction, verify
 * the arithmetic it returned, and build the ePayco checkout payload. They hold no HTTP or Deno
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
import { conflictError, toAppError, validationError } from "../domain/errors.ts";
import { assertQuoteConsistency } from "../domain/pricing.ts";
import type { BackendConfig } from "../config/env.ts";
import type { CreateOrderResult, OrderGateway, QuoteResult } from "../db/orders.ts";
import type { Logger } from "../logging/logger.ts";
import { buildEpaycoCheckout } from "../integrations/epayco/checkout.ts";
import {
  RETRY_REQUIRED_REASONS,
  type CheckoutSessionGateway,
  type CheckoutSessionOutcome,
} from "../db/checkout-sessions.ts";
import {
  createEpaycoApifyClient,
  EpaycoApifyError,
  type EpaycoApifyClient,
} from "../integrations/epayco/apify.ts";
import type { EpaycoCheckout } from "../integrations/epayco/types.ts";
import {
  parseCreateOrderRequest,
  parseQuoteRequest,
  type ParsedCreateOrderRequest,
} from "./order-requests.ts";

/**
 * The only checkout payload the API can return.
 *
 * Wompi was retired, so there is no second variant to branch on: a buyer either receives
 * ePayco Smart Checkout V2 material or the request failed.
 */
export type PaymentCheckout = EpaycoCheckout;

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
    ...(request.bundleCode === undefined ? {} : { bundleCode: request.bundleCode }),
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
 * Smallest and largest amounts (COP pesos) ePayco accepts for a Smart Checkout session, as
 * reported by the provider itself ("property Amount must be between 5000 and 5000000").
 * Checked before calling ePayco so the buyer gets a clear validation error instead of an
 * opaque upstream failure.
 */
export const EPAYCO_MIN_AMOUNT_PESOS = 5_000;
export const EPAYCO_MAX_AMOUNT_PESOS = 5_000_000;

/**
 * Creates (or resumes) the ePayco Smart Checkout session for ONE payment attempt and returns
 * the secret-free checkout payload. Shared by order creation and payment retry so both paths
 * send the same invoice (the attempt reference: `EVT-…` for attempt 1, `EVT-…-N` after a
 * retry) that the confirmation webhook later maps back to the order.
 *
 * SESSION PINNING (migration 20261024170000). ePayco mints a new transaction id every time a
 * session is opened, and `payments` keeps exactly one transaction id per reference. A repeated
 * `POST /orders` used to create a second session for the same invoice, so an approval could
 * arrive for a transaction the database did not record (staging, EVT-2026-000009). The
 * database now decides:
 *
 *   REUSE          → hand the buyer the session that already exists; call ePayco not at all.
 *   CREATE         → this request holds a short lease; create one and record it.
 *   LEASED         → another request is doing it; refuse instead of racing it.
 *   RETRY_REQUIRED → the attempt can no longer be paid (not PENDING, reservation elapsed, or
 *                    a transaction is already recorded). Only a new attempt can be paid, so
 *                    the buyer is sent to `POST /orders/{reference}/retry`.
 */
export async function createEpaycoCheckoutForAttempt(input: {
  readonly config: BackendConfig;
  /** The ORDER reference (`EVT-YYYY-NNNNNN`), without any retry suffix. */
  readonly orderReference: string;
  readonly paymentReference: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly buyerEmail: string;
  readonly clientIp: string | undefined;
  readonly sessions: CheckoutSessionGateway;
  readonly logger: Logger;
  readonly epaycoApify?: EpaycoApifyClient | undefined;
}): Promise<EpaycoCheckout> {
  const { config } = input;
  if (!input.clientIp) {
    throw new EpaycoApifyError("Client IP is required by ePayco session creation", {
      context: { invoice: input.paymentReference },
    });
  }
  if (input.amountInCents % 100 !== 0) {
    // COP has no minor unit at ePayco: a fractional peso would be silently rounded.
    throw validationError("ePayco amounts must be whole pesos", {
      context: { surface: "epayco-amount", amountInCents: input.amountInCents },
    });
  }
  const amountInPesos = input.amountInCents / 100;
  if (amountInPesos < EPAYCO_MIN_AMOUNT_PESOS || amountInPesos > EPAYCO_MAX_AMOUNT_PESOS) {
    throw validationError(
      `ePayco only accepts amounts between ${EPAYCO_MIN_AMOUNT_PESOS} and ${EPAYCO_MAX_AMOUNT_PESOS} COP`,
      { context: { surface: "epayco-amount", amountInPesos } },
    );
  }

  // Both the session and the payload carry the ORDER reference on the return URL, so the
  // post-payment page can name the purchase without depending on browser storage.
  const returnUrl = withOrderReference(config.paymentReturnUrl, input.orderReference);

  // The session must be identified by the attempt the database knows; the payload builder
  // below is shared by the resume and create paths so both are byte-identical.
  const payloadFor = (sessionId: string): EpaycoCheckout =>
    buildEpaycoCheckout({
      sessionId,
      publicKey: config.epayco.publicKey,
      test: config.epayco.test,
      reference: input.paymentReference,
      amountInCents: input.amountInCents,
      currency: input.currency,
      redirectUrl: returnUrl,
      confirmationUrl: `${config.apiBaseUrl}/webhooks-epayco`,
      customerData: {
        email: input.buyerEmail,
        fullName: undefined,
        phoneNumber: undefined,
        phoneNumberPrefix: undefined,
      },
    });

  const plan = await input.sessions.begin({ paymentReference: input.paymentReference });
  if (plan.state === "REUSE") {
    input.logger.info("checkout session resumed", {
      reference: input.paymentReference,
      attempt: plan.paymentAttempt,
    });
    return payloadFor(plan.sessionId);
  }
  if (plan.state === "LEASED") {
    input.logger.warn("checkout session creation already in progress", {
      reference: input.paymentReference,
      attempt: plan.paymentAttempt,
    });
    throw conflictError("A checkout session is already being created for this payment", {
      context: { surface: "checkout-session", detail: "CHECKOUT_LEASE_ACTIVE" },
    });
  }
  if (plan.state === "RETRY_REQUIRED") {
    input.logger.warn("checkout session requires a new payment attempt", {
      reference: input.paymentReference,
      attempt: plan.paymentAttempt,
      reason: plan.reason,
    });
    throw conflictError("This payment attempt cannot open a checkout session", {
      context: { surface: "checkout-session", detail: plan.reason },
    });
  }

  const apify =
    input.epaycoApify ??
    createEpaycoApifyClient({
      publicKey: config.epayco.publicKey,
      privateKey: config.epayco.privateKey,
      test: config.epayco.test,
    });

  let sessionId: string;
  try {
    const session = await apify.createSession({
      checkoutVersion: "2",
      name: "Re set Sunset Vol. 1",
      description: `Entrada Re set Sunset Vol. 1 · Ref: ${input.paymentReference}`,
      currency: input.currency,
      amount: amountInPesos,
      ip: input.clientIp,
      invoice: input.paymentReference,
      response: returnUrl,
      confirmation: `${config.apiBaseUrl}/webhooks-epayco`,
      test: config.epayco.test,
      taxBase: 0,
      tax: 0,
      taxIco: 0,
      country: "CO",
      lang: "ES",
    });
    sessionId = session.sessionId;
  } catch (error) {
    // Free the lease so the buyer can retry at once. Best effort: if this fails the lease
    // expires on its own, which only costs a short wait.
    await input.sessions
      .abandon({ paymentReference: input.paymentReference, generation: plan.generation })
      .catch(() => undefined);
    throw error;
  }

  const outcome: CheckoutSessionOutcome = await input.sessions.complete({
    paymentReference: input.paymentReference,
    generation: plan.generation,
    sessionId,
  });
  if (outcome === "RECORDED") {
    input.logger.info("checkout session created", {
      reference: input.paymentReference,
      attempt: plan.paymentAttempt,
    });
    return payloadFor(sessionId);
  }

  // The lease was lost or the reservation lapsed between the provider call and this write.
  // Never hand the browser a session the database does not know about: prefer the winner's.
  input.logger.warn("checkout session was not recorded", {
    reference: input.paymentReference,
    attempt: plan.paymentAttempt,
    outcome,
  });
  const after = await input.sessions.begin({ paymentReference: input.paymentReference });
  if (after.state === "REUSE") {
    return payloadFor(after.sessionId);
  }
  if (after.state === "CREATE") {
    // The recovery begin claimed a lease of its own. Release it, or the buyer's immediate
    // retry would be answered LEASED for a session nobody is creating. Best effort: if this
    // fails the lease expires on its own.
    await input.sessions
      .abandon({ paymentReference: input.paymentReference, generation: after.generation })
      .catch(() => undefined);
  }
  throw conflictError("The checkout session was replaced while it was being created", {
    context: { surface: "checkout-session", detail: "CHECKOUT_SESSION_NOT_RECORDED" },
  });
}

/**
 * Adds the ORDER reference to the provider's return URL.
 *
 * ePayco appends only its own `ref_payco` to the session's `response` URL, so the browser came
 * back to `/gracias` with no way to name the purchase: the page had to rely on `sessionStorage`,
 * and any lost session (a different origin, a cleared session, a different device) ended on the
 * "no pudimos ubicar tu compra" screen even when the payment was approved.
 *
 * The reference is a CONVENIENCE, never proof: the page still asks `GET /orders/{reference}` with
 * the buyer email, and the backend answers the same 404 for a wrong email and an unknown order.
 * `ref` is the parameter `src/purchase/return-route.ts` already reads.
 */
export function withOrderReference(
  returnUrl: string | undefined,
  orderReference: string,
): string | undefined {
  if (returnUrl === undefined) {
    return undefined;
  }
  try {
    const url = new URL(returnUrl);
    url.searchParams.set("ref", orderReference);
    return url.toString();
  } catch {
    // The loader already validated the URL; if it still is not parseable, send it untouched
    // rather than break the redirect.
    return returnUrl;
  }
}

/**
 * Builds the ePayco checkout payload for a freshly created (or replayed) order.
 */
async function buildCheckout(
  order: CreateOrderResult,
  config: BackendConfig,
  buyerEmail: string,
  clientIp: string | undefined,
  sessions: CheckoutSessionGateway,
  logger: Logger,
  epaycoApify?: EpaycoApifyClient,
): Promise<PaymentCheckout> {
  return createEpaycoCheckoutForAttempt({
    config,
    orderReference: order.reference,
    // Legacy column name: `wompiReference` is the per-attempt payment reference the database
    // generated, independently of which provider charges it.
    paymentReference: order.wompiReference,
    amountInCents: order.totalInCents,
    currency: order.currency,
    buyerEmail,
    clientIp,
    sessions,
    logger,
    epaycoApify,
  });
}

/**
 * `POST /orders`.
 *
 * Creates the order atomically in the database and returns everything the frontend needs to
 * open the checkout. A replayed request (same idempotency key, same buyer) returns the
 * original order and — for ePayco — the SAME checkout session, so a network retry, a double
 * click or a reopened modal cannot mint a second provider transaction under one reference.
 *
 * @throws {AppError} NOT_FOUND / CONFLICT / VALIDATION_ERROR — mapped from SQLSTATE. A
 *   CONFLICT also covers the checkout-session outcomes: another request is creating the
 *   session (`CHECKOUT_LEASE_ACTIVE`) or the attempt can only be paid again through
 *   `POST /orders/{reference}/retry` (`ORDER_NOT_PENDING` / `RESERVATION_EXPIRED` /
 *   `TRANSACTION_RECORDED`).
 */
export async function handleCreateOrder(options: {
  readonly rawBody: unknown;
  readonly idempotencyKey: string | undefined;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
  readonly gateway: OrderGateway;
  readonly config: BackendConfig;
  readonly logger: Logger;
  /** Required: an ePayco checkout is only opened through a session the database pinned. */
  readonly checkoutSessions: CheckoutSessionGateway;
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
    ...(request.bundleCode === undefined ? {} : { bundleCode: request.bundleCode }),
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
    options.ipAddress,
    options.checkoutSessions,
    options.logger,
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

/**
 * The closed vocabulary of checkout-session refusals the API may echo back to a browser.
 *
 * `CHECKOUT_LEASE_ACTIVE` / `CHECKOUT_SESSION_NOT_RECORDED` are raised by this handler;
 * the rest come from `begin_checkout_session`. They are code-like identifiers, never
 * provider or buyer data, so the HTTP layer can safely return them in `details.reason`
 * (the Spanish `message` stays generic).
 */
export const CHECKOUT_CONFLICT_REASONS: readonly string[] = [
  "CHECKOUT_LEASE_ACTIVE",
  "CHECKOUT_SESSION_NOT_RECORDED",
  ...RETRY_REQUIRED_REASONS,
];

/**
 * `{ reason }` for a checkout-session CONFLICT, or undefined for every other error.
 *
 * The frontend needs to tell "we are preparing your session" apart from a sell-out and from
 * "start a new attempt"; exposing the reason is what makes that possible without leaking
 * SQLSTATE text or provider details. Anything outside the allowlist is dropped.
 */
export function checkoutConflictDetails(error: unknown): { readonly reason: string } | undefined {
  const appError = toAppError(error);
  if (appError.code !== "CONFLICT" || appError.context.surface !== "checkout-session") {
    return undefined;
  }
  const reason = appError.context.detail;
  return typeof reason === "string" && CHECKOUT_CONFLICT_REASONS.includes(reason)
    ? { reason }
    : undefined;
}

/**
 * The closed vocabulary of purchase-rule refusals the API may echo back to a browser.
 *
 * `QUANTITY_LIMIT`  — the active sales stage sells fewer tickets per order than requested
 *                     (Preventa: one admission per payment).
 * `BUNDLE_NOT_AVAILABLE` — the named package is not on sale in the active stage yet.
 *
 * Both identifiers are raised by this repository's SQL and carry no provider text, SQLSTATE
 * message or buyer data, so they are safe in `details.reason`. Every other detail — `SOLD_OUT`,
 * `IDEMPOTENCY_KEY_CONFLICT`, a constraint name, an arbitrary `DETAIL` string — stays behind
 * the generic `CONFLICT` message.
 */
export const PURCHASE_RULE_REASONS: readonly string[] = ["QUANTITY_LIMIT", "BUNDLE_NOT_AVAILABLE"];

/**
 * `{ reason }` for an allowlisted purchase-rule CONFLICT, or undefined for everything else.
 *
 * The Spanish `message` and the HTTP status are untouched: the reason only lets the storefront
 * tell "this stage sells one ticket" and "this package is not available yet" apart from a
 * sell-out, instead of showing one generic conflict for three different situations.
 */
export function purchaseRuleDetails(error: unknown): { readonly reason: string } | undefined {
  const appError = toAppError(error);
  if (appError.code !== "CONFLICT") {
    return undefined;
  }
  const reason = appError.context.detail;
  return typeof reason === "string" && PURCHASE_RULE_REASONS.includes(reason)
    ? { reason }
    : undefined;
}

/** Exported for the handler tests: the full reason set the API understands. */
export { DISCOUNT_CODE_REASONS };
