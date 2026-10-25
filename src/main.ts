/**
 * Application entrypoint (Phase 6A landing page + Phase 6B purchase flow + Phase 6C legal).
 *
 * Two responsibilities, deliberately separated so the landing page can be tested without any
 * network:
 *
 *   `initApp`   — render the landing page and route purchases/legal requests to injected openers.
 *   `bootstrap` — production wiring: build the purchase controller, mount the purchase and legal
 *                 dialogs, and resume a checkout return (`/gracias?ref_payco=…`) if the URL is one.
 */

import "./styles/main.css";
import { EVENT_CONTENT_CONFIG } from "./config/event-content.ts";
import { FRONTEND_CONFIG } from "./config/env.ts";
import { renderNavbar } from "./components/Navbar.ts";
import { renderHero } from "./components/Hero.ts";
import { renderExperience } from "./components/Experience.ts";
import { renderWhatIsIncluded } from "./components/WhatIsIncluded.ts";
import { renderAlliedBrands } from "./components/AlliedBrands.ts";
import { renderEventDetails } from "./components/EventDetails.ts";
import { renderFaq, initFaqAccordion } from "./components/Faq.ts";
import { renderContact } from "./components/Contact.ts";
import { renderFinalCta } from "./components/FinalCta.ts";
import { renderStickyBar, initStickyBar } from "./components/StickyBar.ts";
import { renderFooter } from "./components/Footer.ts";
import { mountPurchaseDialog, type PurchaseDialogContext } from "./components/PurchaseDialog.ts";
import { mountLegalDialog, type LegalDialog } from "./components/LegalDialog.ts";
import { createPurchaseController } from "./purchase/controller.ts";
import { showCheckoutUnavailable } from "./purchase/checkout-unavailable.ts";
import { parseReturnContext } from "./purchase/return-route.ts";
import { openEpaycoCheckout } from "./purchase/epayco.ts";
import { dispatchBuyTicket, onBuyTicket, onOpenLegal } from "./utils/events.ts";
import type { BuyTicketEventDetail, LegalTabId } from "./types/content.ts";
import { initClientInteractions } from "./utils/client-interactions.ts";

/** Selector of the "consultar mi compra" entry point in the footer. */
export const LOOKUP_SELECTOR = 'a[href="#consultar"]';

/** Legal links carry their document in `data-legal-tab`; the shell opens the dialog for them. */
export const LEGAL_LINK_SELECTOR = "[data-legal-tab]";

export function renderApp(): string {
  return `
    <a href="#inicio" class="skip-link">Saltar al contenido principal</a>
    ${renderNavbar(EVENT_CONTENT_CONFIG)}
    <main id="main-content">
      ${renderHero(EVENT_CONTENT_CONFIG)}
      ${renderExperience(EVENT_CONTENT_CONFIG)}
      ${renderWhatIsIncluded(EVENT_CONTENT_CONFIG)}
      ${renderAlliedBrands(EVENT_CONTENT_CONFIG)}
      ${renderEventDetails(EVENT_CONTENT_CONFIG)}
      ${renderFaq(EVENT_CONTENT_CONFIG)}
      ${renderContact(EVENT_CONTENT_CONFIG)}
      ${renderFinalCta(EVENT_CONTENT_CONFIG)}
    </main>
    ${renderStickyBar(EVENT_CONTENT_CONFIG)}
    ${renderFooter(EVENT_CONTENT_CONFIG)}
  `;
}

export type AppOptions = {
  /** Called for every purchase CTA. `bootstrap` opens the purchase dialog here. */
  readonly openPurchase?: (detail: BuyTicketEventDetail) => void;
  /** Called when the buyer asks to look up an existing purchase. */
  readonly openLookup?: () => void;
  /** Called when the visitor opens a legal document. */
  readonly openLegal?: (tab: LegalTabId) => void;
};

export function initApp(container: HTMLElement, options: AppOptions = {}): { cleanup: () => void } {
  container.innerHTML = renderApp();

  const cleanupFaq = initFaqAccordion(container);
  const cleanupSticky = initStickyBar(container);

  const ctaButtons = container.querySelectorAll<HTMLButtonElement>("[data-buy-source]");
  const ctaHandlers: { el: HTMLButtonElement; handler: () => void }[] = [];
  ctaButtons.forEach((btn) => {
    const source = (btn.getAttribute("data-buy-source") ??
      "hero") as BuyTicketEventDetail["source"];
    const handler = (): void => {
      dispatchBuyTicket(source);
    };
    btn.addEventListener("click", handler);
    ctaHandlers.push({ el: btn, handler });
  });

  const legalLinks = container.querySelectorAll<HTMLAnchorElement>(LEGAL_LINK_SELECTOR);
  const legalHandlers: { el: HTMLAnchorElement; handler: (event: MouseEvent) => void }[] = [];
  legalLinks.forEach((link) => {
    const handler = (event: MouseEvent): void => {
      event.preventDefault();
      const tab = link.getAttribute("data-legal-tab") as LegalTabId | null;
      if (tab !== null) {
        options.openLegal?.(tab);
      }
    };
    link.addEventListener("click", handler);
    legalHandlers.push({ el: link, handler });
  });

  const lookupLink = container.querySelector<HTMLAnchorElement>(LOOKUP_SELECTOR);
  const lookupHandler = (event: MouseEvent): void => {
    event.preventDefault();
    options.openLookup?.();
  };
  lookupLink?.addEventListener("click", lookupHandler);

  // A CTA click (from any component, via the event bus) opens the purchase flow.
  const unsubscribeBuyTicket = onBuyTicket((detail) => {
    options.openPurchase?.(detail);
  });

  const cleanup = (): void => {
    cleanupFaq();
    cleanupSticky();
    unsubscribeBuyTicket();
    lookupLink?.removeEventListener("click", lookupHandler);
    legalHandlers.forEach(({ el, handler }) => {
      el.removeEventListener("click", handler);
    });
    ctaHandlers.forEach(({ el, handler }) => {
      el.removeEventListener("click", handler);
    });
  };

  return { cleanup };
}

/** Copy the dialog needs before (or without) an API response. */
function purchaseContext(): PurchaseDialogContext {
  const config = EVENT_CONTENT_CONFIG;
  return {
    config: FRONTEND_CONFIG,
    fallbackEvent: {
      eventName: `${config.branding.eventName} ${config.branding.edition}`,
      dateLabel: config.hero.dateLabel,
      timeLabel: config.hero.timeLabel,
      venueLabel: `${config.details.venueName} · ${config.details.city}`,
    },
    contactHref: `mailto:${config.contact.email}`,
    contactLabel: "Escríbenos",
  };
}

/** Opens the legal document addressed by the URL hash (`#legal-participantes`, …). */
function legalTabFromHash(hash: string): LegalTabId | null {
  const match = /^#legal-(participantes|reembolsos|privacidad)$/.exec(hash);
  if (match === null) {
    return null;
  }
  const [, tab] = match;
  return (tab ?? null) as LegalTabId | null;
}

/** Production wiring: client website + purchase dialog + legal dialog + checkout return. */
export function bootstrap(): { cleanup: () => void } {
  const controller = createPurchaseController({
    config: FRONTEND_CONFIG,
    onCheckout: (checkout) => {
      void openEpaycoCheckout({
        checkout,
        onResponse: () => {
          void controller.refreshStatus();
        },
        onClosed: () => {
          void controller.refreshStatus();
        },
        onError: () => {
          // ePayco errors surface through the checkout hooks and the polling loop.
        },
      });
    },
  });

  const dialog = mountPurchaseDialog({ controller, context: purchaseContext() });
  const legal: LegalDialog = mountLegalDialog();

  // Containment build (`VITE_CHECKOUT_ENABLED=false`): the catalogue, prices and dates are real,
  // but no entry point may start an order. Every purchase and lookup path is funnelled through
  // these two callbacks, so refusing here is enough to keep the whole page read-only.
  const checkoutEnabled = FRONTEND_CONFIG.checkoutEnabled;
  const openPurchase = (): void => {
    if (!checkoutEnabled) {
      showCheckoutUnavailable();
      return;
    }
    dialog.open();
  };
  const openLookup = (): void => {
    if (!checkoutEnabled) {
      showCheckoutUnavailable();
      return;
    }
    dialog.open({ resume: {} });
  };

  const rootElement = document.getElementById("app");
  let appCleanup = (): void => undefined;
  if (rootElement !== null) {
    const app = initApp(rootElement, {
      openPurchase,
      openLookup,
      openLegal: (tab) => {
        legal.open(tab);
      },
    });
    appCleanup = app.cleanup;
  }

  // Initialize client-delivered page interactions (menu, modal, reveal, form, sales stage)
  const clientCleanup = initClientInteractions({
    salesConfig: {
      apiBaseUrl: FRONTEND_CONFIG.apiBaseUrl,
      eventCode: FRONTEND_CONFIG.eventCode,
      ticketTypeCode: FRONTEND_CONFIG.ticketTypeCode,
    },
    openPurchase: (_source, details) => {
      if (!checkoutEnabled) {
        showCheckoutUnavailable();
        return;
      }
      dialog.open(details);
    },
    openLookup,
    openLegal: (tab) => {
      legal.open(tab as LegalTabId);
    },
  });

  // Consent copy and any other surface can request a legal document through the event bus.
  const unsubscribeLegal = onOpenLegal((detail) => {
    legal.open(detail.tab);
  });

  // A direct return from ePayco (`/gracias?ref_payco=…&ref=EVT-…`) resumes automatically. Neither
  // the reference nor the transaction id is proof of payment: the dialog asks the backend.
  const returnContext = parseReturnContext(new URL(window.location.href));
  if (returnContext.isReturn && !checkoutEnabled) {
    // A return URL in a containment build can only come from an attempt made before this build;
    // it must not resume a flow that could retry a payment.
    showCheckoutUnavailable();
  } else if (returnContext.isReturn) {
    dialog.open({
      resume: {
        ...(returnContext.reference === undefined ? {} : { reference: returnContext.reference }),
        ...(returnContext.transactionId === undefined
          ? {}
          : { transactionId: returnContext.transactionId }),
      },
    });
  } else {
    const tabFromHash = legalTabFromHash(new URL(window.location.href).hash);
    if (tabFromHash !== null) {
      legal.open(tabFromHash);
    }
  }

  return {
    cleanup: () => {
      appCleanup();
      clientCleanup();
      unsubscribeLegal();
      legal.dispose();
      dialog.dispose();
      controller.dispose();
    },
  };
}

// Auto-mount in the browser.
if (typeof document !== "undefined") {
  bootstrap();
}
