/**
 * Pricing rules (pure functions).
 *
 * IMPORTANT — where the authoritative price comes from
 * ---------------------------------------------------
 * The price a buyer is charged is computed in SQL, inside the order transaction
 * (`public.create_order` / `public.quote_order_price`, migration
 * `20261003210008_pricing.sql`). That is deliberate: a price computed outside the
 * transaction can go stale between "quote" and "create", and the database is the only
 * place where the reservation, the discount counter and the price can move together.
 *
 * This module is NOT a second pricing engine. It exists so that the backend can:
 *
 *   1. re-check the arithmetic the database returned (defence in depth: if the two ever
 *      disagree, the request fails instead of charging a wrong amount);
 *   2. report a stable, typed contract to the API layer without JSON spelunking;
 *   3. let the rules be unit-tested in fast Node tests.
 *
 * `tests/schema/pricing-parity.test.ts` runs the same scenarios through this module and
 * through the real SQL functions and fails the build if they drift.
 *
 * Money is integer centavos (`CopCents`), never a float. Nothing here holds a price.
 */

import { addCopCents, copCents, multiplyCopCents, type CopCents } from "./money.ts";
import { validationError } from "./errors.ts";

/**
 * How a quantity discount and a discount code combine on one order.
 *
 * This mirrors `pricing_policy.discount_combination`. It is DATA in the database, not a
 * constant: the client has not decided yet, so the schema carries the decision and the
 * default is the conservative one.
 */
export const DISCOUNT_COMBINATIONS = ["BEST_SINGLE", "STACK"] as const;
export type DiscountCombination = (typeof DISCOUNT_COMBINATIONS)[number];

/** Basis points: 10000 = 100 %. Integer arithmetic only. */
export const BPS_SCALE = 10000;

export function isDiscountCombination(value: string): value is DiscountCombination {
  return (DISCOUNT_COMBINATIONS as readonly string[]).includes(value);
}

/**
 * Applies a basis-point rate to an amount, flooring the result.
 *
 * Flooring is deliberate and matches the SQL (`(subtotal * bps) / 10000`): the buyer is
 * never charged more than the promised percentage, and the centavo is never invented.
 */
export function applyBasisPoints(amount: CopCents, percentBps: number): CopCents {
  if (!Number.isInteger(percentBps) || percentBps < 0 || percentBps > BPS_SCALE) {
    throw new RangeError("percentBps must be an integer between 0 and 10000");
  }
  return copCents(Math.floor((amount * percentBps) / BPS_SCALE));
}

export type DiscountAmountsInput = {
  readonly subtotal: CopCents;
  /** Amount the quantity discount would remove, on its own. */
  readonly quantityDiscount: CopCents;
  /** Amount the discount code would remove, on its own. */
  readonly codeDiscount: CopCents;
  readonly combination: DiscountCombination;
};

export type DiscountAmounts = {
  /** Amount actually taken off by the quantity discount. */
  readonly quantityDiscountApplied: CopCents;
  /** Amount actually taken off by the discount code. */
  readonly codeDiscountApplied: CopCents;
  readonly totalDiscount: CopCents;
  readonly total: CopCents;
};

/**
 * Resolves which discounts actually apply, given the configured policy.
 *
 *   BEST_SINGLE — only the larger discount applies; the loser is stored as 0.
 *   STACK       — both apply, capped at the subtotal (the total can never go negative).
 *
 * The returned amounts are the amounts APPLIED, which is what the `orders` CHECK constraint
 * (`subtotal - quantity_discount - discount_code = total`) requires.
 */
export function resolveDiscountAmounts(input: DiscountAmountsInput): DiscountAmounts {
  const { subtotal, quantityDiscount, codeDiscount, combination } = input;

  let quantityApplied = 0;
  let codeApplied = 0;

  if (combination === "STACK") {
    quantityApplied = quantityDiscount;
    // The code takes whatever is left after the quantity discount: capping it keeps
    // `total >= 0` without silently changing the configured discount value.
    codeApplied = Math.min(codeDiscount, subtotal - quantityApplied);
  } else if (quantityDiscount >= codeDiscount) {
    quantityApplied = quantityDiscount;
  } else {
    codeApplied = codeDiscount;
  }

  const totalDiscount = addCopCents(copCents(quantityApplied), copCents(codeApplied));
  const total = subtotal - totalDiscount;
  return {
    quantityDiscountApplied: copCents(quantityApplied),
    codeDiscountApplied: copCents(codeApplied),
    totalDiscount,
    total: copCents(total),
  };
}

/** Reasons a supplied discount code may be refused (mirrors the SQL verdict). */
export const DISCOUNT_CODE_REASONS = [
  "NOT_SUPPLIED",
  "NOT_FOUND",
  "INACTIVE",
  "NOT_STARTED",
  "EXPIRED",
  "EXHAUSTED",
  "WRONG_TICKET_TYPE",
  "MIN_QUANTITY",
  "OK",
] as const;

export type DiscountCodeReason = (typeof DISCOUNT_CODE_REASONS)[number];

export function isDiscountCodeReason(value: string): value is DiscountCodeReason {
  return (DISCOUNT_CODE_REASONS as readonly string[]).includes(value);
}

/**
 * Spanish explanations for the buyer-facing UI. Kept here (not in the database) because
 * they are product copy: the reason CODE is the stable contract, the sentence is not.
 */
export const DISCOUNT_CODE_REASON_LABELS_ES: Record<DiscountCodeReason, string> = {
  NOT_SUPPLIED: "No aplicaste ningún código.",
  NOT_FOUND: "Ese código no existe para este evento.",
  INACTIVE: "Ese código ya no está disponible.",
  NOT_STARTED: "Ese código todavía no está activo.",
  EXPIRED: "Ese código ya venció.",
  EXHAUSTED: "Ese código alcanzó su límite de usos.",
  WRONG_TICKET_TYPE: "Ese código no aplica al tipo de entrada seleccionado.",
  MIN_QUANTITY: "Ese código requiere comprar más entradas.",
  OK: "Código aplicado.",
};

export type QuoteBreakdown = {
  readonly unitPrice: CopCents;
  readonly quantity: number;
  readonly subtotal: CopCents;
  readonly quantityDiscount: CopCents;
  readonly codeDiscount: CopCents;
  readonly totalDiscount: CopCents;
  readonly total: CopCents;
};

/**
 * Recomputes a quote from its own parts and asserts the database's answer is internally
 * consistent. Used to verify the SQL response before it reaches a buyer.
 *
 * @throws {AppError} VALIDATION_ERROR when the numbers do not add up.
 */
export function assertQuoteConsistency(input: {
  readonly unitPrice: CopCents;
  readonly quantity: number;
  readonly subtotal: CopCents;
  readonly quantityDiscount: CopCents;
  readonly codeDiscount: CopCents;
  readonly totalDiscount: CopCents;
  readonly total: CopCents;
}): QuoteBreakdown {
  const expectedSubtotal = multiplyCopCents(input.unitPrice, input.quantity);
  if (expectedSubtotal !== input.subtotal) {
    throw validationError("Pricing inconsistency: subtotal does not match unit price x quantity", {
      context: { expectedSubtotal, receivedSubtotal: input.subtotal },
    });
  }

  const expectedDiscount = addCopCents(input.quantityDiscount, input.codeDiscount);
  if (expectedDiscount !== input.totalDiscount) {
    throw validationError("Pricing inconsistency: total discount does not match its parts", {
      context: { expectedDiscount, receivedTotalDiscount: input.totalDiscount },
    });
  }

  if (input.subtotal - input.totalDiscount !== input.total) {
    throw validationError("Pricing inconsistency: total does not match subtotal minus discount", {
      context: { expectedTotal: input.subtotal - input.totalDiscount, receivedTotal: input.total },
    });
  }

  return {
    unitPrice: input.unitPrice,
    quantity: input.quantity,
    subtotal: input.subtotal,
    quantityDiscount: input.quantityDiscount,
    codeDiscount: input.codeDiscount,
    totalDiscount: input.totalDiscount,
    total: input.total,
  };
}
