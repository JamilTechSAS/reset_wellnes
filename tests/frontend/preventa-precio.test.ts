/**
 * Preventa price presentation on the tickets page: the discounted price is the prominent value,
 * the General price is shown crossed out as the reference, and a 20% discount label is present.
 * Only the preventa card changes; the other ticket prices stay as they were.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const HTML = readFileSync(path.join(ROOT, "entradas.html"), "utf8");

function preventaCard(): string {
  const start = HTML.indexOf('data-tipo="preventa"');
  const end = HTML.indexOf("</label>", start);
  return HTML.slice(start, end);
}

describe("preventa discounted price", () => {
  it("shows the discounted preventa price as the prominent value", () => {
    const card = preventaCard();
    expect(card).toContain('<span class="precio-ahora">$159.900</span>');
  });

  it("shows the reference price ($199.900) crossed out", () => {
    const card = preventaCard();
    expect(card).toContain('<span class="precio-antes">$199.900</span>');
  });

  it("shows a visible 20% discount label", () => {
    const card = preventaCard();
    expect(card).toContain('<span class="precio-desc">20% de descuento</span>');
  });

  it("no longer shows the old preventa price of $160.000 anywhere on the page", () => {
    expect(HTML).not.toContain("$160.000");
  });

  it("no longer shows the capacity pill at the bottom of the page", () => {
    expect(HTML).not.toContain("100 boletas en total");
    expect(HTML).not.toContain("det-cupos");
  });

  it("labels the main buy button with the action instead of the price", () => {
    const start = HTML.indexOf('id="comprar"');
    const button = HTML.slice(start, HTML.indexOf("</button>", start));
    expect(button).toContain("Paga aquí");
    expect(button).not.toContain("$159.900");
  });

  it("keeps the General price and shows the package per person, never its total", () => {
    expect(HTML).toContain('<span class="tipo-precio">$199.900</span>');
    expect(HTML).toContain('<span class="precio-ahora">$179.900</span>');
    expect(HTML).toContain("por persona");
    expect(HTML).not.toContain("$539.700");
    expect(HTML).not.toContain("$169.900");
    expect(HTML).not.toContain("$509.700");
    expect(HTML).not.toContain("$340.000");
    expect(HTML).not.toContain("$170.000");
  });
});
