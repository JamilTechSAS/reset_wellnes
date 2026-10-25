/**
 * Thank-you page entry (`gracias.html`).
 *
 * Payment integrity: the page NEVER claims a payment is confirmed from the return URL or a
 * browser redirect. It starts in the "verifying" state and only reveals the confirmed message
 * when the backend reports the order as PAID. The authoritative status comes from the existing
 * order-status endpoint (`GET /orders/{reference}` with the buyer's email); the optional payment
 * hint merely nudges the backend to re-read the provider before we ask.
 *
 * Correlation: ePayco returns the buyer with only its own `ref_payco`, and the buyer's tab is not
 * always the one that comes back (sessionStorage is per tab). The order reference therefore comes
 * from the URL when the provider carries one (`ref`, `reference`, `x_id_invoice`) and otherwise
 * from the stored pending order. The URL never carries the buyer email, so a known reference
 * without a stored email shows a short form that asks for the email only; with no correlation at
 * all the same form asks for both fields. A reference alone can never confirm a purchase.
 */

import "./styles/main.css";
import { createApiClient } from "./api/client.ts";
import { createTicketingApi, type TicketingApi } from "./api/ticketing.ts";
import { FRONTEND_CONFIG } from "./config/env.ts";
import { normalizeReturnedReference, parseReturnContext } from "./purchase/return-route.ts";
import { defaultStore, loadPendingOrder, type PendingOrder } from "./purchase/persistence.ts";
import { initClientInteractions } from "./utils/client-interactions.ts";

export type GraciasView = "confirmed" | "pending" | "recover";
export type LookupView = "confirmed" | "pending" | "not_found" | "error";

type StatusApi = Pick<TicketingApi, "getOrderStatus" | "sendPaymentHint">;

/**
 * What the first load should render, before the buyer types anything.
 *
 * - correlation available (stored order, or a stored order matching the URL reference): ask the
 *   backend and render its verdict;
 * - no stored email: `recover`, so the buyer can supply it;
 * - nothing at all: `recover` too — never a fabricated confirmation.
 */
export async function resolveGraciasView(deps: {
  readonly pending: PendingOrder | undefined;
  readonly reference?: string | undefined;
  readonly transactionId: string | undefined;
  readonly api: StatusApi;
}): Promise<GraciasView> {
  const { pending, transactionId, api } = deps;
  const returnedReference = normalizeReturnedReference(deps.reference);
  const correlated = correlate(pending, returnedReference);
  if (correlated === undefined) {
    return "recover";
  }
  try {
    if (transactionId !== undefined) {
      // Best-effort nudge so the backend re-reads the provider; its result is not trusted here.
      try {
        await api.sendPaymentHint(correlated.reference, correlated.buyerEmail, transactionId);
      } catch {
        // Ignore: the authoritative status read below is what decides.
      }
    }
    const status = await api.getOrderStatus(correlated.reference, correlated.buyerEmail);
    return status.status === "PAID" ? "confirmed" : "pending";
  } catch {
    return "pending";
  }
}

/**
 * Re-reads one order with an explicit reference and email (the recovery form).
 *
 * Distinguishes "the backend says this order is not paid" from "the reference/email pair is not
 * ours" from "we could not ask": the first is honest pending copy, the second re-shows the form
 * with a neutral message, and the third asks the buyer to try again rather than implying anything
 * about the payment.
 */
export async function lookupOrder(deps: {
  readonly reference: string;
  readonly buyerEmail: string;
  readonly api: StatusApi;
}): Promise<LookupView> {
  const reference = normalizeReturnedReference(deps.reference);
  const buyerEmail = deps.buyerEmail.trim().toLowerCase();
  if (reference === undefined || buyerEmail.length === 0) {
    return "not_found";
  }
  try {
    const status = await deps.api.getOrderStatus(reference, buyerEmail);
    return status.status === "PAID" ? "confirmed" : "pending";
  } catch (error) {
    return isNotFound(error) ? "not_found" : "error";
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "NOT_FOUND"
  );
}

/** The stored order, when it belongs to the reference the URL names (or to no reference). */
function correlate(
  pending: PendingOrder | undefined,
  returnedReference: string | undefined,
): PendingOrder | undefined {
  if (pending === undefined) {
    return undefined;
  }
  if (returnedReference === undefined) {
    return pending;
  }
  return pending.reference === returnedReference ? pending : undefined;
}

type Elements = {
  readonly verifying: HTMLElement | null;
  readonly confirmed: HTMLElement | null;
  readonly pending: HTMLElement | null;
  readonly recover: HTMLElement | null;
  readonly recoverReference: HTMLInputElement | null;
  readonly recoverEmail: HTMLInputElement | null;
  readonly recoverSubmit: HTMLButtonElement | null;
  readonly recoverMessage: HTMLElement | null;
  readonly pendingReference: HTMLElement | null;
};

function elements(): Elements {
  return {
    verifying: document.querySelector<HTMLElement>("[data-gracias-verifying]"),
    confirmed: document.querySelector<HTMLElement>("[data-gracias-confirmed]"),
    pending: document.querySelector<HTMLElement>("[data-gracias-pending]"),
    recover: document.querySelector<HTMLElement>("[data-gracias-recover]"),
    recoverReference: document.querySelector<HTMLInputElement>("[data-gracias-reference]"),
    recoverEmail: document.querySelector<HTMLInputElement>("[data-gracias-email]"),
    recoverSubmit: document.querySelector<HTMLButtonElement>("[data-gracias-submit]"),
    recoverMessage: document.querySelector<HTMLElement>("[data-gracias-message]"),
    pendingReference: document.querySelector<HTMLElement>("[data-gracias-pending-reference]"),
  };
}

/** Shows exactly one of the four states; every other block stays hidden. */
export function applyView(view: "verifying" | GraciasView, dom: Elements = elements()): void {
  const visible: Record<string, HTMLElement | null> = {
    verifying: dom.verifying,
    confirmed: dom.confirmed,
    pending: dom.pending,
    recover: dom.recover,
  };
  for (const [key, element] of Object.entries(visible)) {
    if (element !== null) {
      element.hidden = key !== view;
    }
  }
}

function setMessage(text: string, dom: Elements): void {
  if (dom.recoverMessage !== null) {
    dom.recoverMessage.textContent = text;
  }
}

async function run(): Promise<void> {
  const api = createTicketingApi(createApiClient({ baseUrl: FRONTEND_CONFIG.apiBaseUrl }));
  const dom = elements();
  const pending = loadPendingOrder(defaultStore());
  const context = parseReturnContext(new URL(window.location.href));
  const returnedReference = context.reference;
  const correlated = correlate(pending, returnedReference);

  // Prefill whatever the link already told us; the email is never in the URL.
  if (dom.recoverReference !== null) {
    dom.recoverReference.value = returnedReference ?? "";
  }
  if (dom.recoverEmail !== null && correlated !== undefined) {
    dom.recoverEmail.value = correlated.buyerEmail;
  }

  applyView("verifying");
  const view = await resolveGraciasView({
    pending,
    reference: returnedReference,
    transactionId: context.transactionId,
    api,
  });

  if (view === "pending") {
    if (dom.pendingReference !== null && correlated !== undefined) {
      dom.pendingReference.textContent = correlated.reference;
    }
  }
  if (view === "recover") {
    setMessage(
      returnedReference === undefined
        ? "Escribe la referencia de tu orden y el correo con el que compraste."
        : "Confirma el correo con el que compraste para mostrarte el estado de tu compra.",
      dom,
    );
  }
  applyView(view);

  dom.recoverSubmit?.addEventListener("click", () => {
    void submitRecovery();
  });
  // "Volver a consultar" re-reads the same order with the values already in the inputs.
  document
    .querySelector<HTMLButtonElement>("[data-gracias-recheck]")
    ?.addEventListener("click", () => {
      void submitRecovery();
    });

  async function submitRecovery(): Promise<void> {
    const reference = dom.recoverReference?.value ?? "";
    const email = dom.recoverEmail?.value ?? "";
    setMessage("Consultando tu compra…", dom);
    if (dom.recoverSubmit !== null) {
      dom.recoverSubmit.disabled = true;
    }
    const result = await lookupOrder({ reference, buyerEmail: email, api });
    if (dom.recoverSubmit !== null) {
      dom.recoverSubmit.disabled = false;
    }
    if (result === "confirmed") {
      applyView("confirmed");
      return;
    }
    if (result === "pending") {
      if (dom.pendingReference !== null) {
        dom.pendingReference.textContent = normalizeReturnedReference(reference) ?? "";
      }
      applyView("pending");
      return;
    }
    setMessage(
      result === "not_found"
        ? "No encontramos esa compra. Revisa la referencia y el correo, o escríbenos."
        : "No pudimos consultar tu compra ahora. Inténtalo de nuevo en un momento.",
      dom,
    );
    applyView("recover");
  }
}

if (typeof document !== "undefined") {
  // Shared header/footer/community behavior, without the purchase dialog (no return resume here).
  initClientInteractions();
  void run();
}
