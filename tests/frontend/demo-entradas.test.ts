// @vitest-environment happy-dom
/**
 * `/demo-entradas` — the presentation page.
 *
 * The page exists to show the product, never to sell it. These tests therefore pin three things:
 *
 *  1. every option and control is usable whatever the real calendar says (the live Preventa window
 *     opens on 25 Oct 2026 and General on 29 Oct 2026, yet the demo never reads a clock);
 *  2. the arithmetic is exactly the published prices — three General admissions are $599.700 and
 *     the package is ONE charge of $539.700 for three admissions;
 *  3. the page cannot reach a purchase endpoint, ask for personal data or open a provider checkout.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_TIERS,
  EMPTY_DEMO_CART,
  clampQuantity,
  demoTierByCode,
  demoTotals,
  setDemoQuantity,
} from "../../src/demo/catalog.ts";
import { mountDemoPage } from "../../src/demo/page.ts";

const ROOT = process.cwd();

type Mounted = { readonly root: HTMLElement; readonly cleanup: () => void };

const mounted: Mounted[] = [];

function mountPage(): Mounted {
  const root = document.createElement("div");
  root.id = "demo-app";
  document.body.appendChild(root);
  const page = mountDemoPage(root, document);
  const entry: Mounted = { root, cleanup: page.cleanup };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.cleanup();
    entry.root.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing ${what}`);
  }
  return value;
}

function card(root: HTMLElement, code: string): HTMLElement {
  return required(root.querySelector<HTMLElement>(`li[data-demo-tier="${code}"]`), `card ${code}`);
}

function stepper(root: HTMLElement, code: string, direction: 1 | -1): HTMLButtonElement {
  const buttons = Array.from(
    card(root, code).querySelectorAll<HTMLButtonElement>("button[data-demo-step]"),
  );
  const wanted = String(direction);
  return required(
    buttons.find((button) => button.dataset.demoStep === wanted),
    `stepper ${direction} for ${code}`,
  );
}

function quantityText(root: HTMLElement, code: string): string {
  return required(
    root.querySelector<HTMLElement>(`[data-demo-quantity="${code}"]`),
    `quantity ${code}`,
  ).textContent;
}

function totalText(root: HTMLElement): string {
  return required(root.querySelector<HTMLElement>("#demo-comprar-total"), "CTA total").textContent;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("demo catalogue arithmetic", () => {
  it("uses the published prices in hundredths of a peso", () => {
    expect(demoTierByCode("preventa").unitCents).toBe(15_990_000);
    expect(demoTierByCode("general").unitCents).toBe(19_990_000);
    expect(demoTierByCode("paquete").unitCents).toBe(53_970_000);
    // The per-person figure is a caption, never a multiplier applied on top of the total.
    expect(demoTierByCode("paquete").admissionsPerUnit).toBe(3);
  });

  it("charges three General admissions as $599.700 with no quantity discount", () => {
    const totals = demoTotals(setDemoQuantity(EMPTY_DEMO_CART, "general", 3));
    expect(totals.totalCents).toBe(59_970_000);
    expect(totals.admissions).toBe(3);
    expect(totals.lines).toHaveLength(1);
  });

  it("charges the package once for three admissions", () => {
    const totals = demoTotals(setDemoQuantity(EMPTY_DEMO_CART, "paquete", 1));
    expect(totals.totalCents).toBe(53_970_000);
    expect(totals.admissions).toBe(3);
  });

  it("mirrors the commercial caps: one Preventa admission, one package, ten General", () => {
    expect(clampQuantity("preventa", 2)).toBe(1);
    expect(clampQuantity("paquete", 2)).toBe(1);
    expect(clampQuantity("general", 99)).toBe(10);
    expect(clampQuantity("general", -3)).toBe(0);
  });
});

describe("demo page options", () => {
  it("keeps every option selectable long after the real sale is over", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-06-01T12:00:00Z"));
    const { root } = mountPage();

    for (const tier of DEMO_TIERS) {
      expect(stepper(root, tier.code, 1).disabled).toBe(false);
      expect(card(root, tier.code).classList.contains("is-off")).toBe(false);
    }
    expect(root.textContent).not.toMatch(/preventa finalizada|no disponible|venta cerrada/i);

    click(stepper(root, "preventa", 1));
    expect(quantityText(root, "preventa")).toBe("1");
  });

  it("keeps every option selectable before the real sale opens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T12:00:00Z"));
    const { root } = mountPage();

    for (const tier of DEMO_TIERS) {
      expect(stepper(root, tier.code, 1).disabled).toBe(false);
    }

    click(stepper(root, "paquete", 1));
    expect(quantityText(root, "paquete")).toBe("1");
  });

  it("shows the published prices on the cards", () => {
    const { root } = mountPage();
    const preventa = card(root, "preventa").textContent;
    const general = card(root, "general").textContent;
    const paquete = card(root, "paquete").textContent;

    expect(preventa).toContain("$159.900");
    // The Preventa card's crossed-out reference is the current General price.
    expect(preventa).toContain("$199.900");
    expect(general).toContain("$199.900");
    expect(paquete).toContain("$539.700");
    expect(paquete).toContain("$179.900 por persona");
    // The real price is never crossed out on the General card. Only Preventa has a reference.
    expect(general).not.toContain("$159.900");
  });

  it("totals three General admissions at $599.700", () => {
    const { root } = mountPage();
    const add = stepper(root, "general", 1);
    click(add);
    click(add);
    click(add);

    expect(quantityText(root, "general")).toBe("3");
    expect(totalText(root)).toBe("$599.700");
    expect(required(root.querySelector("[data-demo-summary]"), "summary").textContent).toContain(
      "$599.700",
    );
    expect(
      required(root.querySelector("[data-demo-admissions]"), "admissions").textContent,
    ).toContain("3");
    expect(required(root.querySelector("#demo-comprar"), "CTA").getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  it("prices one Preventa admission at $159.900 and clamps a second attempt", () => {
    const { root } = mountPage();
    const add = stepper(root, "preventa", 1);
    click(add);

    expect(quantityText(root, "preventa")).toBe("1");
    expect(totalText(root)).toBe("$159.900");
    expect(add.disabled).toBe(true);

    // Even a programmatic click on the disabled control cannot push the order past the cap.
    click(add);
    expect(quantityText(root, "preventa")).toBe("1");
    expect(totalText(root)).toBe("$159.900");
  });

  it("keeps the package at exactly three admissions for $539.700", () => {
    const { root } = mountPage();
    const add = stepper(root, "paquete", 1);
    click(add);

    expect(quantityText(root, "paquete")).toBe("1");
    expect(
      required(root.querySelector("[data-demo-admissions]"), "admissions").textContent,
    ).toContain("3");
    expect(totalText(root)).toBe("$539.700");
    expect(add.disabled).toBe(true);

    click(add);
    expect(quantityText(root, "paquete")).toBe("1");
    expect(totalText(root)).toBe("$539.700");
  });

  it("decrements back to an empty summary", () => {
    const { root } = mountPage();
    const add = stepper(root, "general", 1);
    click(add);
    click(add);
    click(stepper(root, "general", -1));

    expect(quantityText(root, "general")).toBe("1");
    click(stepper(root, "general", -1));

    expect(quantityText(root, "general")).toBe("0");
    expect(totalText(root)).toBe("$0");
    expect(required(root.querySelector("#demo-comprar"), "CTA").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
});

describe("demo checkout", () => {
  it("opens a review with the same totals and no field to fill in", () => {
    const { root } = mountPage();
    click(stepper(root, "general", 1));
    click(stepper(root, "general", 1));

    const buy = required(root.querySelector<HTMLButtonElement>("#demo-comprar"), "CTA");
    buy.focus();
    click(buy);

    const overlay = required(document.querySelector<HTMLElement>("#demo-checkout"), "overlay");
    expect(overlay.hidden).toBe(false);
    expect(overlay.querySelector("[role='dialog']")).not.toBeNull();
    expect(overlay.getAttribute("aria-hidden")).toBeNull();
    expect(overlay.textContent).toContain("Modo demostración");
    expect(overlay.textContent).toContain("no se procesa ningún pago");
    expect(overlay.textContent).toContain("$399.800");
    // A demo checkout has no form, no field and no payment link.
    expect(overlay.querySelectorAll("input, textarea, select, form").length).toBe(0);
    expect(overlay.querySelectorAll("a[href*='epayco'], button[type='submit']").length).toBe(0);
  });

  it("closes with Escape, with the close button and with the backdrop", () => {
    const { root } = mountPage();
    click(stepper(root, "paquete", 1));
    const buy = required(root.querySelector<HTMLButtonElement>("#demo-comprar"), "CTA");
    const overlay = required(document.querySelector<HTMLElement>("#demo-checkout"), "overlay");

    buy.focus();
    click(buy);
    expect(overlay.hidden).toBe(false);
    pressEscape();
    expect(overlay.hidden).toBe(true);
    // Focus went back to the control that opened the panel.
    expect(document.activeElement).toBe(buy);

    click(buy);
    expect(overlay.hidden).toBe(false);
    click(required(overlay.querySelector("[data-demo-close]"), "close button"));
    expect(overlay.hidden).toBe(true);

    click(buy);
    expect(overlay.hidden).toBe(false);
    click(overlay);
    expect(overlay.hidden).toBe(true);

    // Closing never touches the cart.
    expect(totalText(root)).toBe("$539.700");
  });

  it("cannot add anything to the checkout from an empty selection", () => {
    const { root } = mountPage();
    const buy = required(root.querySelector<HTMLButtonElement>("#demo-comprar"), "CTA");
    click(buy);

    const overlay = required(document.querySelector<HTMLElement>("#demo-checkout"), "overlay");
    expect(overlay.hidden).toBe(true);
    expect(required(root.querySelector("#demo-comprar-ayuda"), "help").textContent).toContain(
      "Agrega al menos una entrada",
    );
  });

  it("never calls the network", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { root } = mountPage();

    for (const tier of DEMO_TIERS) {
      click(stepper(root, tier.code, 1));
    }
    const buy = required(root.querySelector<HTMLButtonElement>("#demo-comprar"), "CTA");
    click(buy);
    pressEscape();
    click(buy);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelectorAll("script[src*='epayco']").length).toBe(0);
    expect(document.querySelectorAll("iframe[src*='epayco']").length).toBe(0);
  });
});

describe("/demo-entradas wiring", () => {
  function source(file: string): string {
    return readFileSync(path.join(ROOT, "src", "demo", file), "utf8");
  }

  it("is its own Vite input and HTML page", () => {
    const viteConfig = readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
    // Registered as its own entry, filtered by the build target: QA serves it, production does not.
    expect(viteConfig).toContain('demoEntradas: "demo-entradas.html"');
    expect(viteConfig).toContain("includesPage(target, page)");

    const html = readFileSync(path.join(ROOT, "demo-entradas.html"), "utf8");
    expect(html).toContain('src="/src/demo/demo-entradas.ts"');
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).toContain("Terraza del hotel GHL, Montería");
    expect(html).toContain('href="/entradas"');
    // The demo never loads the real purchase entrypoint.
    expect(html).not.toContain("/src/main.ts");
  });

  it("keeps the real ticket page untouched and unaware of the demo", () => {
    const entradas = readFileSync(path.join(ROOT, "entradas.html"), "utf8");
    expect(entradas).toContain('src="/src/main.ts"');
    expect(entradas).not.toContain("/src/demo/");
    expect(entradas).not.toContain("/demo-entradas");
  });

  it("imports no purchase controller, API client or provider module", () => {
    for (const file of [
      "catalog.ts",
      "view.ts",
      "checkout-panel.ts",
      "page.ts",
      "demo-entradas.ts",
    ]) {
      const code = source(file);
      // Only the module specifiers are inspected: the files mention these paths in prose on
      // purpose ("it does NOT import …"), and a comment is not a dependency.
      const specifiers = [
        ...Array.from(code.matchAll(/from\s+"([^"]+)"/g), (match) => match[1] ?? ""),
        ...Array.from(code.matchAll(/import\(\s*"([^"]+)"/g), (match) => match[1] ?? ""),
      ];
      for (const specifier of specifiers) {
        expect(specifier, `${file} must not import ${specifier}`).not.toMatch(/^\.\.\/api\//);
        expect(specifier, `${file} must not import ${specifier}`).not.toMatch(
          /purchase\/(controller|epayco|validation|persistence|return-route)/,
        );
      }
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket/);
    }
  });
});
