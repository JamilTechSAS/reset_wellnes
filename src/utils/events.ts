/**
 * Event Bus and CTA Architecture Hook (Phase 6A -> Phase 6B)
 *
 * This module provides a clean, decoupled boundary for the purchase CTA.
 * In Phase 6A, clicking "COMPRAR ENTRADA" triggers `dispatchBuyTicket()`,
 * which dispatches a custom event. Phase 6B can replace or augment the listener
 * with the real checkout flow without restructuring any component.
 */

import type { BuyTicketEventDetail, LegalTabId, OpenLegalEventDetail } from "../types/content.ts";

export const BUY_TICKET_EVENT = "ticket:buy-requested";
export const OPEN_LEGAL_EVENT = "legal:open-requested";

/**
 * Dispatches a request to initiate ticket purchase.
 *
 * @param source Which CTA button triggered the action
 */
export function dispatchBuyTicket(source: BuyTicketEventDetail["source"]): void {
  const detail: BuyTicketEventDetail = {
    source,
    timestamp: Date.now(),
  };

  const event = new CustomEvent<BuyTicketEventDetail>(BUY_TICKET_EVENT, {
    bubbles: true,
    cancelable: true,
    detail,
  });

  window.dispatchEvent(event);
}

/**
 * Subscribes to the purchase CTA event.
 *
 * @param callback Handler invoked whenever a purchase CTA is triggered
 * @returns Cleanup function to unsubscribe
 */
export function onBuyTicket(callback: (detail: BuyTicketEventDetail) => void): () => void {
  const handler = (event: Event): void => {
    const customEvent = event as CustomEvent<BuyTicketEventDetail>;
    callback(customEvent.detail);
  };

  window.addEventListener(BUY_TICKET_EVENT, handler);
  return () => {
    window.removeEventListener(BUY_TICKET_EVENT, handler);
  };
}

/**
 * Asks the shell to open the legal dialog on a specific document.
 *
 * Any surface (footer link, consent copy, FAQ) can request it without knowing how the dialog
 * is mounted; `bootstrap` owns the single dialog instance.
 */
export function dispatchOpenLegal(tab: LegalTabId): void {
  const detail: OpenLegalEventDetail = { tab, timestamp: Date.now() };
  window.dispatchEvent(
    new CustomEvent<OpenLegalEventDetail>(OPEN_LEGAL_EVENT, {
      bubbles: true,
      cancelable: true,
      detail,
    }),
  );
}

/** Subscribes to legal-dialog requests. */
export function onOpenLegal(callback: (detail: OpenLegalEventDetail) => void): () => void {
  const handler = (event: Event): void => {
    callback((event as CustomEvent<OpenLegalEventDetail>).detail);
  };
  window.addEventListener(OPEN_LEGAL_EVENT, handler);
  return () => {
    window.removeEventListener(OPEN_LEGAL_EVENT, handler);
  };
}
