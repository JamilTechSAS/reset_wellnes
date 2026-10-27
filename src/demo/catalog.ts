/**
 * Demo ticket catalogue and cart arithmetic — presentation only.
 *
 * `/demo-entradas` exists to show a prospective client the ticket-purchase experience. It must
 * never be able to sell a ticket, so nothing under `src/demo/` imports the purchase controller, the
 * API client or the ePayco loader, the cart below lives in the page's memory, and every amount is a
 * constant: there is no clock, no catalog request and no quote behind this page.
 *
 * The amounts are the same integer hundredths of a peso the backend and the rest of the site use,
 * so the arithmetic is exact rather than floating point:
 *
 *   Preventa  15_990_000 × 1  = 15_990_000  ($159.900)   cap of one per order, as in production
 *   General   19_990_000 × n  = 59_970_000  ($599.700)   for three, with no quantity discount
 *   Paquete   53_970_000 × 1  = 53_970_000  ($539.700)   ONE charge for three admissions
 *
 * The package's per-person price ($179.900) is a display caption: `unitCents` is what a buyer is
 * charged, so the total is never multiplied by three a second time.
 */

import {
  PACKAGE_ADMISSIONS,
  PACKAGE_TOTAL_CENTS,
  PACKAGE_UNIT_CENTS,
  PACKAGE_UNIT_PRICE_LABEL,
} from "../purchase/package-availability.ts";

export type DemoTierCode = "preventa" | "general" | "paquete";

export type DemoTier = {
  readonly code: DemoTierCode;
  readonly name: string;
  /** The amount charged once per selected unit, in hundredths of a peso. */
  readonly unitCents: number;
  /** Crossed-out reference price (Preventa only), in hundredths of a peso. */
  readonly referenceCents: number | null;
  /** Badge above the price (Preventa's discount), or null. */
  readonly badge: string | null;
  /** Secondary price line, e.g. the package's per-person price, or null. */
  readonly unitCaption: string | null;
  /** What one selected unit is called in the quantity stepper. */
  readonly unitNoun: "entrada" | "paquete";
  /** Admissions one unit consumes; the package is three. */
  readonly admissionsPerUnit: number;
  /** Per-order cap the demo mirrors from the real rules (Preventa: one admission). */
  readonly maxQuantity: number;
  readonly note: string;
  /** The real sales window, shown for context only: the demo never gates on it. */
  readonly scheduleLabel: string;
};

/** COP $159.900 per Preventa admission. */
export const PREVENTA_UNIT_CENTS = 15_990_000;
/** The General price Preventa is discounted from (the crossed-out reference). */
export const PREVENTA_REFERENCE_CENTS = 19_990_000;
/** COP $199.900 per General admission. */
export const GENERAL_UNIT_CENTS = 19_990_000;
/**
 * How many individual General admissions the demo lets a visitor add.
 *
 * Production has no per-order cap on General, only the shared 100-admission pool; ten is a demo
 * ceiling so a presentation cannot produce an absurdly long summary.
 */
export const GENERAL_MAX_QUANTITY = 10;

export const DEMO_TIERS: readonly DemoTier[] = [
  {
    code: "preventa",
    name: "Preventa",
    unitCents: PREVENTA_UNIT_CENTS,
    referenceCents: PREVENTA_REFERENCE_CENTS,
    badge: "20% de descuento",
    unitCaption: null,
    unitNoun: "entrada",
    admissionsPerUnit: 1,
    maxQuantity: 1,
    note: "Máximo 1 entrada por pedido.",
    scheduleLabel: "25 de octubre, 10:00 a. m. – 28 de octubre, 11:59 p. m.",
  },
  {
    code: "general",
    name: "General",
    unitCents: GENERAL_UNIT_CENTS,
    referenceCents: null,
    badge: null,
    unitCaption: null,
    unitNoun: "entrada",
    admissionsPerUnit: 1,
    maxQuantity: GENERAL_MAX_QUANTITY,
    note: "Compra individual · sin descuento por cantidad.",
    scheduleLabel: "29 de octubre, 12:01 a. m. – 13 de noviembre, 11:59 p. m.",
  },
  {
    code: "paquete",
    name: "Comparte tu experiencia (3 entradas)",
    // Charged once per package: three admissions for $539.700, never $539.700 × 3.
    unitCents: PACKAGE_TOTAL_CENTS,
    referenceCents: null,
    badge: null,
    unitCaption: `${PACKAGE_UNIT_PRICE_LABEL} por persona`,
    unitNoun: "paquete",
    admissionsPerUnit: PACKAGE_ADMISSIONS,
    maxQuantity: 1,
    note: `3 entradas en una sola compra · ${PACKAGE_UNIT_PRICE_LABEL} por persona.`,
    scheduleLabel: "29 de octubre, 12:01 a. m. – 13 de noviembre, 11:59 p. m.",
  },
];

/** The package's per-admission amount, kept for the caption and for the tests' cross-checks. */
export const PACKAGE_PER_ADMISSION_CENTS = PACKAGE_UNIT_CENTS;

export function isDemoTierCode(value: string | undefined): value is DemoTierCode {
  return value === "preventa" || value === "general" || value === "paquete";
}

export function demoTierByCode(code: DemoTierCode): DemoTier {
  const tier = DEMO_TIERS.find((candidate) => candidate.code === code);
  if (tier === undefined) {
    throw new Error(`Unknown demo tier: ${code}`);
  }
  return tier;
}

export type DemoCart = Readonly<Record<DemoTierCode, number>>;

export const EMPTY_DEMO_CART: DemoCart = { preventa: 0, general: 0, paquete: 0 };

/** Quantity clamped into `0 … maxQuantity`; NaN and fractions never reach the totals. */
export function clampQuantity(code: DemoTierCode, quantity: number): number {
  if (!Number.isFinite(quantity)) {
    return 0;
  }
  const max = demoTierByCode(code).maxQuantity;
  return Math.min(max, Math.max(0, Math.trunc(quantity)));
}

export function setDemoQuantity(cart: DemoCart, code: DemoTierCode, quantity: number): DemoCart {
  return { ...cart, [code]: clampQuantity(code, quantity) };
}

export function stepDemoQuantity(cart: DemoCart, code: DemoTierCode, delta: number): DemoCart {
  return setDemoQuantity(cart, code, cart[code] + delta);
}

export type DemoLine = {
  readonly code: DemoTierCode;
  readonly name: string;
  readonly quantity: number;
  readonly admissions: number;
  readonly unitCents: number;
  readonly subtotalCents: number;
};

export type DemoTotals = {
  readonly lines: readonly DemoLine[];
  readonly admissions: number;
  readonly totalCents: number;
  readonly isEmpty: boolean;
};

export function demoLines(cart: DemoCart): readonly DemoLine[] {
  return DEMO_TIERS.filter((tier) => cart[tier.code] > 0).map((tier) => {
    const quantity = cart[tier.code];
    return {
      code: tier.code,
      name: tier.name,
      quantity,
      admissions: quantity * tier.admissionsPerUnit,
      unitCents: tier.unitCents,
      subtotalCents: quantity * tier.unitCents,
    };
  });
}

export function demoTotals(cart: DemoCart): DemoTotals {
  const lines = demoLines(cart);
  return {
    lines,
    admissions: lines.reduce((sum, line) => sum + line.admissions, 0),
    totalCents: lines.reduce((sum, line) => sum + line.subtotalCents, 0),
    isEmpty: lines.length === 0,
  };
}

/** The cart a demo starts with: nothing selected. */
export function emptyDemoCart(): DemoCart {
  return EMPTY_DEMO_CART;
}
