/**
 * Wompi Web Checkout handoff (Phase 6B).
 *
 * The backend computes and signs everything (`public-key`, `amount-in-cents`, `reference`,
 * `signature:integrity`); this module only turns that already-authorized payload into the
 * checkout URL and hands the browser over. It NEVER recomputes the signature, changes the
 * amount, or invents a reference — the signature would no longer match and the payment would
 * be rejected (or, worse, a different amount would be charged).
 *
 * The result of the checkout is meaningless to us: when the buyer comes back, the app asks the
 * backend for the real state. The URL is the only place a redirect could be trusted, and it is
 * explicitly not.
 */

import type { WompiCheckout } from "../api/types.ts";

/** Builds `https://checkout.wompi.co/p/?…` with the backend-signed parameters. */
export function buildWompiCheckoutUrl(baseUrl: string, checkout: WompiCheckout): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  const parts: string[] = [
    `public-key=${encodeURIComponent(checkout.publicKey)}`,
    `currency=${encodeURIComponent(checkout.currency)}`,
    `amount-in-cents=${encodeURIComponent(String(checkout.amountInCents))}`,
    `reference=${encodeURIComponent(checkout.reference)}`,
    // Wompi expects the literal parameter name `signature:integrity`.
    `signature:integrity=${encodeURIComponent(checkout.integritySignature)}`,
  ];
  if (checkout.redirectUrl !== null && checkout.redirectUrl.length > 0) {
    parts.push(`redirect-url=${encodeURIComponent(checkout.redirectUrl)}`);
  }
  if (checkout.expirationTime !== null && checkout.expirationTime.length > 0) {
    parts.push(`expiration-time=${encodeURIComponent(checkout.expirationTime)}`);
  }
  if (checkout.customerData.email !== null && checkout.customerData.email.length > 0) {
    parts.push(`customer-data:email=${encodeURIComponent(checkout.customerData.email)}`);
  }
  return `${baseUrl}${separator}${parts.join("&")}`;
}

/** Navigates the browser to the Wompi checkout. */
export function redirectToWompi(baseUrl: string, checkout: WompiCheckout): void {
  window.location.assign(buildWompiCheckoutUrl(baseUrl, checkout));
}
