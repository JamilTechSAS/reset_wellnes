// @vitest-environment happy-dom
/**
 * CTA routing: a buy CTA that is a link to a real page (the homepage hero → /entradas) must
 * navigate there instead of opening the purchase dialog. Button CTAs still open the dialog.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { initClientInteractions } from "../../src/utils/client-interactions.ts";

describe("buy CTA routing", () => {
  let openPurchase: Mock;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    openPurchase = vi.fn();
  });

  afterEach(() => {
    cleanup?.();
    document.body.innerHTML = "";
  });

  it("does not open the dialog for a hero link that points to /entradas", () => {
    document.body.innerHTML = `
      <a id="hero-buy-btn" class="hero-cta" data-buy-source="hero" href="/entradas">
        <span class="hero-cta-action">Comprar entrada</span>
      </a>`;
    cleanup = initClientInteractions({ openPurchase });

    const cta = document.getElementById("hero-buy-btn")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    cta.dispatchEvent(event);

    expect(openPurchase).not.toHaveBeenCalled();
    // The click is left to navigate natively (not intercepted).
    expect(event.defaultPrevented).toBe(false);
  });

  it("still opens the dialog for a button CTA without a page destination", () => {
    document.body.innerHTML = `
      <button id="nav-buy-btn" type="button" data-buy-source="navbar">Comprar entrada</button>`;
    cleanup = initClientInteractions({ openPurchase });

    document
      .getElementById("nav-buy-btn")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openPurchase).toHaveBeenCalledTimes(1);
    expect(openPurchase).toHaveBeenCalledWith("navbar");
  });
});
