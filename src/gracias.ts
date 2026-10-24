/**
 * Thank-you page entry (`gracias.html`).
 *
 * Payment integrity: the page NEVER claims a payment is confirmed from the return URL or a
 * browser redirect. It starts in the "verifying" state and only reveals the confirmed message
 * when the backend reports the order as PAID. The authoritative status comes from the existing
 * order-status endpoint (`GET /orders/{reference}` with the buyer's email); the optional payment
 * hint merely nudges the backend to re-read the provider before we ask. No tickets or QR codes
 * are issued here — that stays entirely in the backend.
 */

import "./styles/main.css";
import { createApiClient } from "./api/client.ts";
import { createTicketingApi, type TicketingApi } from "./api/ticketing.ts";
import { FRONTEND_CONFIG } from "./config/env.ts";
import { parseReturnContext } from "./purchase/return-route.ts";
import { defaultStore, loadPendingOrder, type PendingOrder } from "./purchase/persistence.ts";
import { initClientInteractions } from "./utils/client-interactions.ts";

export type GraciasView = "confirmed" | "pending";

type StatusApi = Pick<TicketingApi, "getOrderStatus" | "sendPaymentHint">;

/**
 * Decides which message to show. Returns "confirmed" only when the backend authoritatively
 * reports the order as PAID; everything else (no correlated order, non-PAID status, or any
 * network/verification error) resolves to "pending".
 */
export async function resolveGraciasView(deps: {
  readonly pending: PendingOrder | undefined;
  readonly transactionId: string | undefined;
  readonly api: StatusApi;
}): Promise<GraciasView> {
  const { pending, transactionId, api } = deps;
  if (pending === undefined) {
    return "pending";
  }
  try {
    if (transactionId !== undefined) {
      // Best-effort nudge so the backend re-reads the provider; its result is not trusted here.
      try {
        await api.sendPaymentHint(pending.reference, pending.buyerEmail, transactionId);
      } catch {
        // Ignore: the authoritative status read below is what decides.
      }
    }
    const status = await api.getOrderStatus(pending.reference, pending.buyerEmail);
    return status.status === "PAID" ? "confirmed" : "pending";
  } catch {
    return "pending";
  }
}

function applyView(view: GraciasView): void {
  const pendingEl = document.querySelector<HTMLElement>("[data-gracias-pending]");
  const confirmedEl = document.querySelector<HTMLElement>("[data-gracias-confirmed]");
  if (pendingEl === null || confirmedEl === null) {
    return;
  }
  const confirmed = view === "confirmed";
  confirmedEl.hidden = !confirmed;
  pendingEl.hidden = confirmed;
}

async function run(): Promise<void> {
  const api = createTicketingApi(createApiClient({ baseUrl: FRONTEND_CONFIG.apiBaseUrl }));
  const pending = loadPendingOrder(defaultStore());
  const { transactionId } = parseReturnContext(new URL(window.location.href));
  const view = await resolveGraciasView({ pending, transactionId, api });
  applyView(view);
}

if (typeof document !== "undefined") {
  // Shared header/footer/community behavior, without the purchase dialog (no return resume here).
  initClientInteractions();
  void run();
}
