// @vitest-environment happy-dom
/**
 * Checkout containment.
 *
 * A production build ships before the payment provider is configured, and while it does, the
 * public page must be unable to start a purchase. These tests pin the three properties that make
 * that safe: the flag only turns off on an explicit falsy value, the refusal renders one clear
 * message, and the refusal path contains no API call at all.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadFrontendConfig, parseCheckoutEnabled } from "../../src/config/env.ts";
import {
  CHECKOUT_UNAVAILABLE_ID,
  CHECKOUT_UNAVAILABLE_MESSAGE,
  CHECKOUT_UNAVAILABLE_TITLE,
  renderCheckoutUnavailableNotice,
  showCheckoutUnavailable,
} from "../../src/purchase/checkout-unavailable.ts";

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("checkout flag", () => {
  it("stays enabled when the variable is absent, empty or unrecognised", () => {
    expect(parseCheckoutEnabled(undefined)).toBe(true);
    expect(parseCheckoutEnabled("")).toBe(true);
    expect(parseCheckoutEnabled("   ")).toBe(true);
    expect(parseCheckoutEnabled("true")).toBe(true);
    expect(parseCheckoutEnabled("trrue")).toBe(true);
  });

  it("turns off only on an explicit falsy value, case-insensitively", () => {
    for (const value of ["false", "FALSE", " false ", "0", "no", "off"]) {
      expect(parseCheckoutEnabled(value), value).toBe(false);
    }
  });

  it("threads the flag through the resolved frontend configuration", () => {
    const enabled = loadFrontendConfig({ PROD: true });
    expect(enabled.checkoutEnabled).toBe(true);

    const contained = loadFrontendConfig({ PROD: true, VITE_CHECKOUT_ENABLED: "false" });
    expect(contained.checkoutEnabled).toBe(false);
    // The containment build still knows the real backend and catalogue: only buying is off.
    expect(contained.apiBaseUrl).toContain("supabase.co/functions/v1");
    expect(contained.eventCode).toBe("RESET-SUNSET-2026");
  });
});

describe("containment notice", () => {
  it("explains the pause without promising a payment", () => {
    const html = renderCheckoutUnavailableNotice();
    expect(html).toContain(CHECKOUT_UNAVAILABLE_TITLE);
    expect(html).toContain(CHECKOUT_UNAVAILABLE_MESSAGE);
    expect(html).toContain('role="status"');
    expect(html.toLowerCase()).not.toContain("pago exitoso");
    expect(html.toLowerCase()).not.toContain("pago confirmado");
  });

  it("renders once, is announced politely and can be dismissed", () => {
    showCheckoutUnavailable({ document });
    const notice = document.getElementById(CHECKOUT_UNAVAILABLE_ID);
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("aria-live")).toBe("polite");
    expect(notice?.textContent).toContain(CHECKOUT_UNAVAILABLE_MESSAGE);

    const close = notice?.querySelector<HTMLButtonElement>("[data-checkout-unavailable-close]");
    expect(close).not.toBeNull();
    close?.click();
    expect(document.getElementById(CHECKOUT_UNAVAILABLE_ID)).toBeNull();
  });

  it("does not stack copies when every CTA is clicked", () => {
    showCheckoutUnavailable({ document });
    showCheckoutUnavailable({ document });
    showCheckoutUnavailable({ document });
    expect(document.querySelectorAll(".checkout-unavailable")).toHaveLength(1);
  });

  it("never calls the API: the module has no client import and no fetch", () => {
    const source = read("src/purchase/checkout-unavailable.ts");
    expect(source).not.toContain("api/client");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("orders");
    expect(source).not.toContain("checkout-session");
  });
});

describe("containment wiring", () => {
  it("refuses purchase, lookup and resume before opening the dialog", () => {
    const main = read("src/main.ts");
    expect(main).toContain("FRONTEND_CONFIG.checkoutEnabled");
    expect(main).toContain("showCheckoutUnavailable");
    // Every path that could start a purchase must be guarded, including the ePayco return URL.
    expect(main).toContain("if (!checkoutEnabled)");
    expect(main).not.toMatch(/openPurchase:\s*\(\)\s*=>\s*\{\s*dialog\.open\(\);/);
    expect(main).toContain("returnContext.isReturn && !checkoutEnabled");
  });

  it("leaves the QA demo page independent from the containment flag", () => {
    const demoEntry = read("src/demo/demo-entradas.ts");
    expect(demoEntry).not.toContain("checkoutEnabled");
    expect(demoEntry).not.toContain("showCheckoutUnavailable");
    expect(read("src/demo/page.ts")).not.toContain("checkoutEnabled");
  });
});
