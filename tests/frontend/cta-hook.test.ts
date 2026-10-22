// @vitest-environment happy-dom
/**
 * Purchase CTA architecture and routing tests.
 *
 * Phase 6B connects every CTA to the real purchase flow. `initApp` stays free of any network
 * dependency: it reports a purchase request through an injected opener, which the production
 * `bootstrap` wires to the purchase dialog and the tests wire to a spy.
 */

import { describe, expect, it, beforeEach, afterEach, vi, type Mock } from "vitest";
import { initApp } from "../../src/main.ts";
import { onBuyTicket, dispatchBuyTicket } from "../../src/utils/events.ts";
import type { BuyTicketEventDetail } from "../../src/types/content.ts";

describe("Purchase CTA architecture", () => {
  let container: HTMLDivElement;
  let appCleanup: () => void;
  let openPurchase: Mock<(detail: BuyTicketEventDetail) => void>;
  let openLookup: Mock<() => void>;

  beforeEach(() => {
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
    openPurchase = vi.fn<(detail: BuyTicketEventDetail) => void>();
    openLookup = vi.fn<() => void>();
    const { cleanup } = initApp(container, { openPurchase, openLookup });
    appCleanup = cleanup;
  });

  afterEach(() => {
    appCleanup();
    container.remove();
  });

  it("dispatches and receives buy ticket events via onBuyTicket", () => {
    const listener = vi.fn();
    const unsubscribe = onBuyTicket(listener);

    dispatchBuyTicket("hero");

    expect(listener).toHaveBeenCalledTimes(1);
    const callArg = listener.mock.calls[0]?.[0] as BuyTicketEventDetail | undefined;
    expect(callArg?.source).toBe("hero");
    expect(typeof callArg?.timestamp).toBe("number");

    unsubscribe();
  });

  it.each([
    ["#hero-buy-btn", "hero"],
    ["#nav-buy-btn", "navbar"],
    ["#final-buy-btn", "final-cta"],
    ["#sticky-buy-btn", "sticky-bar"],
  ])("opens the purchase flow when %s is clicked", (selector, source) => {
    const button = container.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();

    button?.click();

    expect(openPurchase).toHaveBeenCalledTimes(1);
    expect(openPurchase.mock.calls[0]?.[0].source).toBe(source);
  });

  it("opens the purchase lookup when the footer link is used", () => {
    const link = container.querySelector<HTMLAnchorElement>('a[href="#consultar"]');
    expect(link).not.toBeNull();

    link?.click();

    expect(openLookup).toHaveBeenCalledTimes(1);
  });

  it("does not throw on a CTA click when no opener is provided", () => {
    const bare = document.createElement("div");
    bare.id = "app-bare";
    document.body.appendChild(bare);

    const { cleanup } = initApp(bare);
    const heroBtn = bare.querySelector<HTMLButtonElement>("#hero-buy-btn");
    expect(() => heroBtn?.click()).not.toThrow();

    cleanup();
    bare.remove();
  });
});
