/**
 * Wompi checkout preparation.
 *
 * Produces the exact set of values the future frontend needs to open Widget / Web Checkout,
 * and nothing else. Verified against the official docs (docs/colombia/widget-checkout-web/,
 * re-read 2026-10-03):
 *
 *   Required: public-key, currency, amount-in-cents, reference, signature:integrity
 *   Optional: redirect-url, customer-data:*, expiration-time (which CHANGES the signature)
 *
 * Security rules enforced here:
 *   - The private key, the integrity secret and the events secret NEVER appear in the
 *     returned object. Only the public key, the amount, the reference and the hash do.
 *   - The amount is not a parameter of this module: it comes from the order the database
 *     just created, so there is no code path where a client-supplied amount could be signed.
 *   - `expiration-time`, when used, is formatted ONCE and used verbatim in both the signature
 *     and the checkout payload; the two can therefore never disagree (a mismatch would make
 *     Wompi reject the payment, or worse, sign a different amount than the one charged).
 *
 * Wompi supports COP only, and the amount is in cents (COP $95.000 -> 9500000).
 */

import { validationError } from "../../domain/errors.ts";
import { computeIntegritySignature, formatWompiExpirationTime } from "./signature.ts";
import { WOMPI_SUPPORTED_CURRENCY } from "./types.ts";

export type WompiCheckoutRequest = {
  /** Public key for the active environment (`pub_test_…` / `pub_prod_…`). */
  readonly publicKey: string;
  /** Integrity secret. Server-side only; never returned. */
  readonly integritySecret: string;
  /** Reference of the payment attempt (attempt 1 = order reference). */
  readonly reference: string;
  /** Amount in cents, taken from the created order — never from a request body. */
  readonly amountInCents: number;
  readonly currency: string;
  /**
   * Checkout expiration (ISO-8601). Optional: when omitted, neither the signature nor the
   * payload carries an expiration, which is the simplest correct configuration.
   */
  readonly expirationTime?: Date | undefined;
  /** Where Wompi returns the buyer. Informative only — never proof of payment. */
  readonly redirectUrl?: string | undefined;
  /** Prefills the checkout's "enter your details" step. */
  readonly customerData?: {
    readonly email?: string | undefined;
    readonly fullName?: string | undefined;
    readonly phoneNumber?: string | undefined;
    readonly phoneNumberPrefix?: string | undefined;
  };
};

/** Client-safe checkout payload. Contains no secret of any kind. */
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

/**
 * Builds the checkout payload and the integrity signature together, so they can never
 * disagree about the amount, the reference or the expiration.
 *
 * @throws {AppError} VALIDATION_ERROR for a malformed reference, amount or currency.
 */
export async function buildWompiCheckout(request: WompiCheckoutRequest): Promise<WompiCheckout> {
  if (request.currency !== WOMPI_SUPPORTED_CURRENCY) {
    throw validationError(`Wompi only supports ${WOMPI_SUPPORTED_CURRENCY}`, {
      context: { currency: request.currency },
    });
  }

  // Formatted once: this exact string goes into the hash and into the payload.
  const expirationTime =
    request.expirationTime === undefined
      ? undefined
      : formatWompiExpirationTime(request.expirationTime);

  const integritySignature = await computeIntegritySignature({
    reference: request.reference,
    amountInCents: request.amountInCents,
    currency: request.currency,
    integritySecret: request.integritySecret,
    ...(expirationTime === undefined ? {} : { expirationTime }),
  });

  return {
    publicKey: request.publicKey,
    currency: request.currency,
    amountInCents: request.amountInCents,
    reference: request.reference,
    integritySignature,
    expirationTime: expirationTime ?? null,
    redirectUrl: request.redirectUrl ?? null,
    customerData: {
      email: request.customerData?.email ?? null,
      fullName: request.customerData?.fullName ?? null,
      phoneNumber: request.customerData?.phoneNumber ?? null,
      phoneNumberPrefix: request.customerData?.phoneNumberPrefix ?? null,
    },
  };
}
