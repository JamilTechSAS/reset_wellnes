/**
 * Payment-return URL parsing (Phase 6B).
 *
 * ePayco sends the buyer back to the session's `response` URL with `ref_payco` (its transaction
 * reference, docs.epayco.com "Páginas de Respuesta y Confirmación") and, because the backend
 * names the order on that URL, `ref`. Both are HINTS: the frontend posts the transaction id to
 * `POST /orders/{reference}/payment-hint`, which re-reads it from ePayco's validation endpoint
 * with the private key, and the order status comes from `GET /orders/{reference}`. Nothing in
 * the URL is ever treated as proof of payment.
 *
 * Wompi is retired. Its legacy `id` parameter is still parsed so an old link (or a bookmark from
 * before the retirement) degrades into that same hint path instead of failing outright.
 *
 * The buyer's own tab is not always the one that comes back: sessionStorage is per tab, so a
 * return opened elsewhere has no stored correlation at all. The order reference therefore comes
 * from the URL when the provider carries one (`ref`, `reference`, or ePayco's `x_id_invoice`
 * invoice field) and otherwise from the stored pending order. The reference is only a pointer to
 * WHICH order to ask about — the buyer email is still required, and the backend answers the same
 * 404 for a wrong email as for an unknown order, so naming an order reveals nothing.
 *
 * `/gracias` is served by `gracias.html` (Vercel `cleanUrls`), whose entry (`src/gracias.ts`)
 * reads this context and verifies the order authoritatively before showing a confirmed message.
 */

export type ReturnContext = {
  /** True when the current URL looks like a checkout return rather than a fresh visit. */
  readonly isReturn: boolean;
  readonly transactionId: string | undefined;
  /** Order reference (retry suffix removed), normalized to upper case. */
  readonly reference: string | undefined;
};

const ATTEMPT_REFERENCE_PATTERN = /^(EVT-[0-9]{4}-[0-9]{6,})-[0-9]{1,3}$/;
const ORDER_REFERENCE_PATTERN = /^EVT-[0-9]{4}-[0-9]{6,}$/;
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

/**
 * Normalizes a reference taken from the return URL.
 *
 * A retry URL names the attempt (`EVT-…-2`); the buyer-facing lookup is about the ORDER, so the
 * suffix is dropped. Anything that is not one of our references is ignored rather than trusted.
 */
export function normalizeReturnedReference(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toUpperCase();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  const base = trimmed.replace(ATTEMPT_REFERENCE_PATTERN, "$1");
  return ORDER_REFERENCE_PATTERN.test(base) ? base : undefined;
}

export function parseReturnContext(url: URL): ReturnContext {
  const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
  const transactionId = firstNonEmpty(
    url.searchParams.get("id"),
    url.searchParams.get("transaction-id"),
    url.searchParams.get("ref_payco"),
  );
  // ePayco echoes the invoice (its name for our reference) on some responses; a retry invoice
  // (`EVT-…-2`) is reduced to its order by `normalizeReturnedReference`.
  const reference = normalizeReturnedReference(
    firstNonEmpty(
      url.searchParams.get("ref"),
      url.searchParams.get("reference"),
      url.searchParams.get("x_id_invoice"),
    ),
  );

  const isReturn =
    pathname.endsWith(RETURN_PATH) || transactionId !== undefined || reference !== undefined;

  return { isReturn, transactionId, reference };
}
