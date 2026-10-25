/**
 * Demo checkout panel — the review screen the demo CTA opens.
 *
 * It reuses the real checkout's surface (`.purchase-overlay` / `.purchase-panel`, the gold hairline,
 * the bottom sheet on a phone) so the demo looks like the product, but it is a different component:
 * it contains no form, no input and no provider code, and it has no way to reach ePayco.
 *
 * Accessibility mirrors the real dialog: the panel is a modal `role="dialog"` with an accessible
 * name and description, focus moves into it on open, Tab cycles inside it, Escape and the overlay
 * close it, and focus returns to the button that opened it.
 */

import type { DemoTotals } from "./catalog.ts";
import { renderDemoCheckoutPanel } from "./view.ts";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type DemoCheckoutPanel = {
  /** The overlay element (kept in the DOM; `hidden` while closed). */
  readonly element: HTMLElement;
  readonly isOpen: () => boolean;
  readonly open: (totals: DemoTotals) => void;
  readonly close: () => void;
  readonly dispose: () => void;
};

export function mountDemoCheckout(documentRef: Document, root: HTMLElement): DemoCheckoutPanel {
  const overlay = documentRef.createElement("div");
  overlay.className = "purchase-overlay demo-overlay";
  overlay.id = "demo-checkout";
  overlay.hidden = true;
  root.appendChild(overlay);

  let previouslyFocused: HTMLElement | null = null;

  const isOpen = (): boolean => !overlay.hidden;

  const close = (): void => {
    if (!isOpen()) {
      return;
    }
    overlay.hidden = true;
    overlay.classList.remove("is-open");
    overlay.innerHTML = "";
    documentRef.body.style.overflow = "";
    if (previouslyFocused !== null && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
  };

  const open = (totals: DemoTotals): void => {
    overlay.innerHTML = renderDemoCheckoutPanel(totals);
    previouslyFocused =
      documentRef.activeElement instanceof HTMLElement ? documentRef.activeElement : null;
    overlay.hidden = false;
    overlay.classList.add("is-open");
    documentRef.body.style.overflow = "hidden";
    const target =
      overlay.querySelector<HTMLElement>("#demo-checkout-title") ??
      overlay.querySelector<HTMLElement>("[data-demo-close]");
    target?.focus({ preventScroll: true });
  };

  const handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    // A click on the backdrop closes; a click inside the panel does not.
    if (target === overlay) {
      close();
      return;
    }
    if (target.closest("[data-demo-close]") !== null) {
      event.preventDefault();
      close();
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!isOpen()) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    const active = documentRef.activeElement;
    const inside = active !== null && overlay.contains(active);
    if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  };

  overlay.addEventListener("click", handleClick);
  documentRef.addEventListener("keydown", handleKeyDown);

  return {
    element: overlay,
    isOpen,
    open,
    close,
    dispose: () => {
      close();
      overlay.removeEventListener("click", handleClick);
      documentRef.removeEventListener("keydown", handleKeyDown);
      overlay.remove();
    },
  };
}
