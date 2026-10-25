/**
 * `/demo-entradas` — the presentation page's controller.
 *
 * It owns an in-memory cart, renders the option cards, keeps the summary and the demo CTA in sync,
 * and opens the demo checkout panel. It deliberately does NOT:
 *
 *   - read the clock, so no sales window can disable an option (the demo is always "open");
 *   - call the catalog, quote, order or checkout endpoints;
 *   - import `src/purchase/controller.ts`, `src/api/*` or `src/purchase/epayco.ts`.
 *
 * The only state is the quantity per option; nothing is persisted, so a reload starts over.
 */

import { formatCopCents } from "../purchase/format.ts";
import {
  DEMO_TIERS,
  EMPTY_DEMO_CART,
  demoTotals,
  isDemoTierCode,
  stepDemoQuantity,
  type DemoCart,
} from "./catalog.ts";
import { mountDemoCheckout } from "./checkout-panel.ts";
import { quantityLabel, renderDemoSection, renderDemoSummary } from "./view.ts";

/** The element the page mounts into (`demo-entradas.html`). */
export const DEMO_ROOT_ID = "demo-app";

const EMPTY_HELP = "Agrega al menos una entrada para ver el resumen de la compra.";
const READY_HELP = "Se abrirá un resumen de demostración. No se cobra nada.";

function must(scope: ParentNode, selector: string): HTMLElement {
  const element = scope.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`La demo de entradas no encontró ${selector}`);
  }
  return element;
}

function mustButton(scope: ParentNode, selector: string): HTMLButtonElement {
  const element = must(scope, selector);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`La demo de entradas esperaba un botón en ${selector}`);
  }
  return element;
}

/** Mobile menu toggle. The demo page runs this instead of the site-wide interactions module. */
function initNavToggle(documentRef: Document): () => void {
  const toggle = documentRef.getElementById("nav-toggle");
  const menu = documentRef.getElementById("nav-menu");
  if (toggle === null || menu === null) {
    return () => undefined;
  }

  const collapse = (): void => {
    menu.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Menú";
  };

  const handleToggle = (): void => {
    const open = menu.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Cerrar" : "Menú";
  };

  const links = Array.from(menu.querySelectorAll("a"));
  toggle.addEventListener("click", handleToggle);
  links.forEach((link) => {
    link.addEventListener("click", collapse);
  });

  return () => {
    toggle.removeEventListener("click", handleToggle);
    links.forEach((link) => {
      link.removeEventListener("click", collapse);
    });
  };
}

export type DemoPage = {
  readonly cleanup: () => void;
};

export function mountDemoPage(root: HTMLElement, documentRef: Document = document): DemoPage {
  let cart: DemoCart = EMPTY_DEMO_CART;
  root.innerHTML = renderDemoSection(cart);

  const tiers = must(root, "[data-demo-tiers]");
  const summarySlot = must(root, "[data-demo-summary-slot]");
  const buyButton = mustButton(root, "#demo-comprar");
  const buyTotal = must(root, "#demo-comprar-total");
  const help = must(root, "#demo-comprar-ayuda");

  const panel = mountDemoCheckout(documentRef, documentRef.body);
  const disposeNav = initNavToggle(documentRef);

  /** Paints the current cart into the cards, the summary and the CTA (no re-render, no lost focus). */
  const paint = (): void => {
    const totals = demoTotals(cart);

    for (const tier of DEMO_TIERS) {
      const quantity = cart[tier.code];
      const card = tiers.querySelector<HTMLElement>(`li[data-demo-tier="${tier.code}"]`);
      const cardQuantity = tiers.querySelector<HTMLElement>(`[data-demo-quantity="${tier.code}"]`);
      const cardLabel = tiers.querySelector<HTMLElement>(
        `[data-demo-quantity-label="${tier.code}"]`,
      );
      const lineTotal = tiers.querySelector<HTMLElement>(`[data-demo-line-total="${tier.code}"]`);
      const buttons = card?.querySelectorAll<HTMLButtonElement>("button[data-demo-step]") ?? [];

      card?.classList.toggle("is-selected", quantity > 0);
      if (cardQuantity !== null) {
        cardQuantity.textContent = String(quantity);
      }
      if (cardLabel !== null) {
        cardLabel.textContent = quantityLabel(tier.unitNoun, quantity);
      }
      if (lineTotal !== null) {
        lineTotal.textContent = quantity > 0 ? formatCopCents(quantity * tier.unitCents) : "";
      }
      buttons.forEach((button) => {
        const steps = Number(button.dataset.demoStep);
        button.disabled = steps > 0 ? quantity >= tier.maxQuantity : quantity === 0;
      });
    }

    summarySlot.innerHTML = renderDemoSummary(totals);
    buyTotal.textContent = totals.isEmpty ? "$0" : formatCopCents(totals.totalCents);
    buyButton.setAttribute("aria-disabled", String(totals.isEmpty));
    help.textContent = totals.isEmpty ? EMPTY_HELP : READY_HELP;
  };

  const handleStepperClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-demo-step]");
    if (button === null) {
      return;
    }
    event.preventDefault();

    // The tier comes from the card the button lives in; the button only carries the direction.
    const code = button.closest<HTMLElement>("li[data-demo-tier]")?.dataset.demoTier;
    const step = Number(button.dataset.demoStep);
    if (!isDemoTierCode(code) || !Number.isFinite(step) || step === 0) {
      return;
    }

    cart = stepDemoQuantity(cart, code, step);
    paint();

    // A stepper that reaches its limit becomes disabled, which would drop keyboard focus. Hand it
    // to the opposite button so the visitor can keep adjusting without tabbing from the top.
    if (button.disabled) {
      const sibling = Array.from(
        button
          .closest("li[data-demo-tier]")
          ?.querySelectorAll<HTMLButtonElement>("button[data-demo-step]") ?? [],
      ).find((candidate) => !candidate.disabled);
      sibling?.focus();
    }
  };

  const handleBuyClick = (): void => {
    const totals = demoTotals(cart);
    if (totals.isEmpty) {
      help.textContent = EMPTY_HELP;
      return;
    }
    panel.open(totals);
  };

  tiers.addEventListener("click", handleStepperClick);
  buyButton.addEventListener("click", handleBuyClick);
  paint();

  return {
    cleanup: () => {
      tiers.removeEventListener("click", handleStepperClick);
      buyButton.removeEventListener("click", handleBuyClick);
      panel.dispose();
      disposeNav();
      root.innerHTML = "";
      cart = EMPTY_DEMO_CART;
    },
  };
}
