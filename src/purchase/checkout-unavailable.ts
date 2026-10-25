/**
 * Containment notice for builds that must not sell.
 *
 * A `VITE_CHECKOUT_ENABLED=false` build still renders the real catalogue, prices and dates; it only
 * refuses to start a purchase. This module owns that refusal so there is exactly one place with the
 * buyer-facing wording and exactly one way to surface it — instead of each CTA inventing its own
 * behaviour.
 *
 * It never calls the API: showing it creates no order, no checkout session and no payment, which is
 * the whole point of the flag.
 */

/** Title of the containment notice. */
export const CHECKOUT_UNAVAILABLE_TITLE = "Pago no disponible";

/**
 * Buyer-facing explanation.
 *
 * Deliberately does not promise a date or a successful payment: it says buying is paused and offers
 * the way to come back, because this build ships before the payment provider is configured.
 */
export const CHECKOUT_UNAVAILABLE_MESSAGE =
  "La compra de entradas está temporalmente en pausa mientras terminamos de habilitar el pago en línea. " +
  "Los precios y las fechas ya son definitivos; vuelve a intentarlo en unos minutos.";

/** Id of the rendered notice, so a second click reuses the visible one instead of stacking copies. */
export const CHECKOUT_UNAVAILABLE_ID = "checkout-unavailable";

/** Markup of the notice. Pure: no state, no side effects, no network. */
export function renderCheckoutUnavailableNotice(): string {
  return `
    <div class="checkout-unavailable" id="${CHECKOUT_UNAVAILABLE_ID}" role="status" aria-live="polite">
      <div class="checkout-unavailable-body">
        <p class="checkout-unavailable-title">${CHECKOUT_UNAVAILABLE_TITLE}</p>
        <p class="checkout-unavailable-text">${CHECKOUT_UNAVAILABLE_MESSAGE}</p>
      </div>
      <button type="button" class="checkout-unavailable-close" data-checkout-unavailable-close>
        Cerrar
      </button>
    </div>
  `;
}

export type CheckoutUnavailableOptions = {
  /** Document to render into; defaults to the global one. */
  readonly document?: Document | undefined;
};

/**
 * Shows the notice and returns its cleanup.
 *
 * The notice is appended to `document.body` rather than to a page container so it is reachable from
 * every surface that can request a purchase (landing page, `/entradas`, the sticky bar). Clicking an
 * entry point again while it is open leaves the single copy in place.
 */
export function showCheckoutUnavailable(options: CheckoutUnavailableOptions = {}): () => void {
  const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
  if (doc === undefined) {
    return () => undefined;
  }

  const existing = doc.getElementById(CHECKOUT_UNAVAILABLE_ID);
  if (existing !== null) {
    // Already on screen: a second click must not stack copies of the same message.
    existing.querySelector<HTMLButtonElement>("[data-checkout-unavailable-close]")?.focus();
    return () => undefined;
  }

  const container = doc.createElement("div");
  container.innerHTML = renderCheckoutUnavailableNotice();
  const notice = container.firstElementChild;
  if (notice === null) {
    return () => undefined;
  }

  const close = (): void => {
    notice.remove();
  };
  const closeButton = notice.querySelector<HTMLButtonElement>("[data-checkout-unavailable-close]");
  closeButton?.addEventListener("click", close);
  doc.body.appendChild(notice);
  closeButton?.focus();

  return () => {
    closeButton?.removeEventListener("click", close);
    notice.remove();
  };
}
