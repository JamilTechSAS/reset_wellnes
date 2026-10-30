// @vitest-environment happy-dom
/**
 * "Comparte tu experiencia" — the commercial package (3 admissions, $539.700).
 *
 * The backend now prices and reserves it (`SHARE_EXPERIENCE`, migration 20261024230000), so the
 * card can start a checkout, but only while the General stage is the one on sale. The retired
 * two-admission `DOUBLE_EXPERIENCE` package is never offered to a new buyer.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  PACKAGE_ADMISSIONS,
  PACKAGE_CHECKOUT_ENABLED,
  PACKAGE_NAME,
  PACKAGE_TOTAL_CENTS,
  PACKAGE_TOTAL_PRICE_LABEL,
  PACKAGE_UNIT_CENTS,
  PACKAGE_UNIT_PRICE_LABEL,
  PACKAGE_UNAVAILABLE_NOTE,
  packageCheckoutAvailable,
} from "../../src/purchase/package-availability.ts";
import { initClientInteractions } from "../../src/utils/client-interactions.ts";

const ROOT = path.resolve(__dirname, "../..");
const HTML = readFileSync(path.join(ROOT, "entradas.html"), "utf8");

function packageCardHtml(): string {
  const start = HTML.indexOf('data-tipo="duo"');
  const end = HTML.indexOf("</label>", start);
  return HTML.slice(start, end);
}

/** The card's visible text, tags stripped, so the copy reads as the buyer sees it. */
function packageCardText(): string {
  return packageCardHtml()
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("package commercial terms", () => {
  it("is a three-admission package at $179.900 per admission", () => {
    expect(PACKAGE_NAME).toBe("Comparte tu experiencia");
    expect(PACKAGE_ADMISSIONS).toBe(3);
    expect(PACKAGE_UNIT_PRICE_LABEL).toBe("$179.900");
    expect(PACKAGE_TOTAL_PRICE_LABEL).toBe("$539.700");
    // 3 × 179.900 = 539.700, checked as numbers rather than as formatted text.
    expect(3 * 179_900).toBe(539_700);
    // The charge the API and the database use: hundredths of a peso, charged once per package.
    expect(PACKAGE_UNIT_CENTS).toBe(17_990_000);
    expect(PACKAGE_TOTAL_CENTS).toBe(53_970_000);
    expect(PACKAGE_TOTAL_CENTS).toBe(PACKAGE_UNIT_CENTS * 3);
  });

  it("is purchasable now that the backend prices the three-admission package", () => {
    expect(PACKAGE_CHECKOUT_ENABLED).toBe(true);
    expect(packageCheckoutAvailable()).toBe(true);
  });

  it("renders the package card with three admissions and the per-person price", () => {
    const card = packageCardHtml();
    const text = packageCardText();
    expect(text).toContain("Comparte tu experiencia (3 entradas)");
    expect(text).toContain("$179.900 por persona");
    expect(text).not.toContain("$169.900");
    expect(text).not.toContain("$509.700");
    // The package total is no longer printed on the card.
    expect(text).not.toContain(PACKAGE_TOTAL_PRICE_LABEL);
    expect(card).not.toContain("$340.000");
    expect(card).not.toContain("2 entradas");
  });

  it("keeps the three-entry unit label unbreakable on narrow screens", () => {
    // At 320px the label used to split inside the parentheses: "(3" on one line, "entradas)"
    // on the next. The unit is one piece of copy, so the card must let it wrap as a whole.
    const css = readFileSync(path.join(ROOT, "src/styles/reset.css"), "utf8");
    const rule = /\.tipo-nombre small \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("white-space: nowrap");
    expect(packageCardHtml()).toContain("<small>(3 entradas)</small>");
  });

  it("ships the package option disabled so it cannot be selected before General opens", () => {
    expect(packageCardHtml()).toContain('value="duo" disabled');
  });

  it("shows only the General-stage availability line under the title and price", () => {
    const text = packageCardText();
    expect(text).toContain(PACKAGE_UNAVAILABLE_NOTE);
    expect(PACKAGE_UNAVAILABLE_NOTE).toBe("Disponible al iniciar la etapa general");
    // Nothing else: no dates, no stage rationale, no leftover "próximamente" explanation.
    expect(text).not.toMatch(/de (octubre|noviembre)/);
    expect(text).not.toContain("próximamente");
    expect(text).not.toContain("solo en la etapa");
  });
});

describe("package purchase guard", () => {
  let openPurchase: Mock;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // General is open, which is when the package is advertised. The radio is force-enabled here to
    // simulate a stale page or a hand-edited DOM: the guard must still refuse.
    vi.setSystemTime(Date.parse("2026-10-30T15:00:00Z")); // 2026-10-30 10:00 Bogotá, General open
    openPurchase = vi.fn();
    document.body.innerHTML = `
      <fieldset class="tipos">
        <label class="tipo" data-tipo="preventa">
          <input type="radio" name="tipo" value="preventa" />
          <span class="tipo-nota" data-nota></span>
        </label>
        <label class="tipo" data-tipo="general">
          <input type="radio" name="tipo" value="general" />
          <span class="tipo-nota" data-nota></span>
        </label>
        <label class="tipo" data-tipo="duo">
          <input type="radio" name="tipo" value="duo" checked />
          <span class="tipo-nota" data-nota></span>
        </label>
      </fieldset>
      <input type="checkbox" id="acepto-terminos" />
      <button class="comprar" id="comprar" type="button" aria-disabled="true">Paga aquí</button>
      <p class="comprar-ayuda" id="comprar-ayuda"></p>
    `;
    cleanup = initClientInteractions({ openPurchase });
  });

  afterEach(() => {
    cleanup?.();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("opens one checkout for exactly three admissions when General is on sale", () => {
    const duo = document.querySelector<HTMLInputElement>('.tipo[data-tipo="duo"] input');
    if (duo !== null) {
      duo.disabled = false;
      duo.checked = true;
    }
    (document.getElementById("acepto-terminos") as HTMLInputElement).checked = true;
    document.getElementById("comprar")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // One package = one purchase of three admissions; the backend re-prices and re-reserves it.
    expect(openPurchase).toHaveBeenCalledTimes(1);
    expect(openPurchase).toHaveBeenCalledWith(
      "ticket-section",
      expect.objectContaining({ tier: "duo", quantity: PACKAGE_ADMISSIONS, acceptedTerms: true }),
    );
  });

  it("keeps the package closed until the catalog confirms the General stage", () => {
    // No catalog answer here, so the package stays locked exactly as it ships in the markup.
    const duo = document.querySelector<HTMLInputElement>('.tipo[data-tipo="duo"] input');
    expect(duo?.disabled).toBe(true);

    (document.getElementById("acepto-terminos") as HTMLInputElement).checked = true;
    document.getElementById("comprar")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(openPurchase).not.toHaveBeenCalled();
  });
});
