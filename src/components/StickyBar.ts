/**
 * Sticky Mobile Purchase Bar Component (Phase 6A, reveal logic hardened in Phase 6C)
 *
 * Thumb-friendly bottom floating bar for mobile viewports, ensuring high conversion from
 * social media / Instagram traffic.
 *
 * It stays off-screen until the hero CTA has scrolled above the viewport, so the first thing a
 * visitor sees is the ticket button of the hero, not two competing buttons.
 */

import type { EventLandingConfig } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

export function renderStickyBar(config: EventLandingConfig): string {
  return `
    <aside class="sticky-mobile-bar" id="sticky-bar" aria-label="Acceso rápido a compra de entradas">
      <div class="sticky-bar-inner">
        <div class="sticky-bar-info">
          <span class="sticky-bar-event">${escapeHtml(config.branding.eventName)}</span>
          <span class="sticky-bar-capacity">
            <span class="sticky-bar-dot" aria-hidden="true"></span>
            ${escapeHtml(config.branding.badgeText)}
          </span>
        </div>
        <button
          type="button"
          class="btn btn-primary btn-sm sticky-bar-btn"
          id="sticky-buy-btn"
          data-buy-source="sticky-bar"
        >
          <span>Comprar</span>
          ${renderIcon("arrow-right")}
        </button>
      </div>
    </aside>
  `;
}

/**
 * Reveals the bar once the hero CTA is above the viewport.
 *
 * The reveal is driven by scroll/resize listeners rather than an `IntersectionObserver`: the page
 * can scroll on the window, on the document (this layout scrolls the root) or on an inner
 * container, and a scroll event always reaches the element that actually scrolled. Updates are
 * coalesced into one animation frame, so a fast scroll costs a single layout read.
 */
export function initStickyBar(root: Document | HTMLElement = document): () => void {
  const stickyBar = root.querySelector<HTMLElement>("#sticky-bar");
  const heroBtn = root.querySelector<HTMLElement>("#hero-buy-btn");

  if (stickyBar === null || heroBtn === null) {
    return (): void => {
      // Nothing to observe: the bar or the hero CTA is not on this page.
    };
  }

  let frame = 0;

  const apply = (): void => {
    frame = 0;
    stickyBar.classList.toggle("is-visible", heroBtn.getBoundingClientRect().bottom < 0);
  };

  const requestUpdate = (): void => {
    if (frame !== 0) {
      return;
    }
    frame = requestAnimationFrame(apply);
  };

  // `capture: true` is what makes a scroll inside any container reach these listeners: scroll
  // events do not bubble, but they do travel down the capture phase to the scrolling element.
  const scrollTargets: readonly EventTarget[] = [window, document, document.body];
  for (const target of scrollTargets) {
    target.addEventListener("scroll", requestUpdate, { passive: true, capture: true });
  }
  window.addEventListener("resize", requestUpdate, { passive: true });

  apply();

  return () => {
    for (const target of scrollTargets) {
      target.removeEventListener("scroll", requestUpdate, { capture: true });
    }
    window.removeEventListener("resize", requestUpdate);
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
