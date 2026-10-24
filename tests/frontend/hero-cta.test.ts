// @vitest-environment happy-dom
/**
 * Homepage hero CTA: the action ("Comprar entrada") is a visually distinct element, while the
 * lead copy ("Regálate este momento") is preserved. The purchase target and wiring are unchanged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const INDEX = readFileSync(path.join(ROOT, "index.html"), "utf8");

describe("homepage hero CTA", () => {
  it("keeps the CTA target and purchase wiring unchanged", () => {
    document.documentElement.innerHTML = INDEX;
    const cta = document.querySelector<HTMLAnchorElement>("#hero-buy-btn");
    expect(cta).not.toBeNull();
    expect(cta?.getAttribute("href")).toBe("/entradas");
    expect(cta?.getAttribute("data-buy-source")).toBe("hero");
    expect(cta?.classList.contains("hero-cta")).toBe(true);
  });

  it("preserves the lead copy and differentiates the action in its own element", () => {
    document.documentElement.innerHTML = INDEX;
    const lead = document.querySelector<HTMLElement>("#hero-buy-btn .hero-cta-lead");
    const action = document.querySelector<HTMLElement>("#hero-buy-btn .hero-cta-action");
    expect(lead?.textContent.trim()).toBe("Regálate este momento");
    expect(action?.textContent.trim()).toBe("Comprar entrada");
  });

  it("no longer renders the two labels as one undifferentiated string", () => {
    expect(INDEX).not.toContain("Regálate este momento · Comprar entrada");
  });
});
