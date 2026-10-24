/**
 * Payment-return URL parsing (Phase 6B).
 *
 * Wompi sends the buyer back to the configured redirect URL with its own query parameters,
 * most importantly `id` — the Wompi transaction id. That id is a HINT: the frontend posts it
 * to `POST /orders/{reference}/payment-hint`, which re-reads the transaction with the private
 * key before anything happens. Nothing in the URL is ever treated as proof of payment.
 *
 * ePayco sends the buyer back to the session's `response` URL with `ref_payco` (its
 * transaction reference, docs.epayco.com "Páginas de Respuesta y Confirmación"). It takes the
 * same hint path: the backend re-reads it from ePayco's validation endpoint.
 *
 * The order reference is not added by either provider, so it comes from the (optional) `ref`
 * parameter when present and otherwise from the session's stored pending order.
 *
 * `/gracias` is served by `gracias.html` (Vercel `cleanUrls`), whose entry (`src/gracias.ts`)
 * reads this context and verifies the order authoritatively before showing a confirmed message.
 */

export type ReturnContext = {
  /** True when the current URL looks like a checkout return rather than a fresh visit. */
  readonly isReturn: boolean;
  readonly transactionId: string | undefined;
  readonly reference: string | undefined;
};

const REFERENCE_PATTERN = /^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]+)?$/;
const RETURN_PATH = "/gracias";

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

export function parseReturnContext(url: URL): ReturnContext {
  const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
  const transactionId = firstNonEmpty(
    url.searchParams.get("id"),
    url.searchParams.get("transaction-id"),
    url.searchParams.get("ref_payco"),
  );
  const rawReference = firstNonEmpty(
    url.searchParams.get("ref"),
    url.searchParams.get("reference"),
  );
  const reference =
    rawReference !== undefined && REFERENCE_PATTERN.test(rawReference.toUpperCase())
      ? rawReference.toUpperCase()
      : undefined;

  const isReturn =
    pathname.endsWith(RETURN_PATH) || transactionId !== undefined || reference !== undefined;

  return { isReturn, transactionId, reference };
}
