// @vitest-environment happy-dom
/**
 * FAQ Accordion Interaction and Accessibility Tests (Phase 6A)
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EVENT_CONTENT_CONFIG } from "../../src/config/event-content.ts";
import { renderFaq, initFaqAccordion } from "../../src/components/Faq.ts";

describe("FAQ Accordion Component", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;

  beforeEach(() => {
    container = document.createElement("div");
    container.innerHTML = renderFaq(EVENT_CONTENT_CONFIG);
    document.body.appendChild(container);
    cleanup = initFaqAccordion(container);
  });

  afterEach(() => {
    cleanup();
    container.remove();
  });

  it("starts with all accordion items collapsed", () => {
    const buttons = container.querySelectorAll<HTMLButtonElement>(".faq-button");
    const panels = container.querySelectorAll<HTMLElement>(".faq-panel");
    const items = container.querySelectorAll<HTMLElement>(".faq-item");

    expect(buttons.length).toBeGreaterThan(0);
    buttons.forEach((btn) => {
      expect(btn.getAttribute("aria-expanded")).toBe("false");
    });
    panels.forEach((p) => {
      expect(p.getAttribute("aria-hidden")).toBe("true");
    });
    items.forEach((item) => {
      expect(item.classList.contains("is-open")).toBe(false);
    });
  });

  it("expands panel on click and updates aria attributes", () => {
    const firstButton = container.querySelector<HTMLButtonElement>(".faq-button");
    expect(firstButton).not.toBeNull();

    const controlsId = firstButton?.getAttribute("aria-controls");
    const panel = container.querySelector(`#${controlsId ?? ""}`);
    const itemWrapper = firstButton?.closest(".faq-item");

    firstButton?.click();

    expect(firstButton?.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.getAttribute("aria-hidden")).toBe("false");
    expect(itemWrapper?.classList.contains("is-open")).toBe(true);

    // Click again to collapse
    firstButton?.click();

    expect(firstButton?.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.getAttribute("aria-hidden")).toBe("true");
    expect(itemWrapper?.classList.contains("is-open")).toBe(false);
  });

  it("handles keyboard navigation between accordion headers", () => {
    const buttons = container.querySelectorAll<HTMLButtonElement>(".faq-button");
    expect(buttons.length).toBeGreaterThan(1);

    const first = buttons[0];
    const second = buttons[1];
    const last = buttons[buttons.length - 1];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(last).toBeDefined();

    if (!first || !second || !last) return;

    first.focus();
    expect(document.activeElement).toBe(first);

    // Press ArrowDown from first -> second
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(second);

    // Press ArrowUp from second -> first
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(first);

    // Press End from first -> last
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(last);

    // Press Home from last -> first
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(first);
  });
});
