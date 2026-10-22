/**
 * Pricing rules (pure functions).
 *
 * These tests pin the ARITHMETIC and the policy semantics. The authoritative price is still
 * computed in SQL; `tests/schema/pricing-parity.test.ts` proves the two agree, so a change
 * here that is not mirrored in the migration fails the build.
 */

import { describe, expect, it } from "vitest";

import { copCents } from "@shared/domain/money.ts";
import {
  applyBasisPoints,
  assertQuoteConsistency,
  isDiscountCombination,
  isDiscountCodeReason,
  resolveDiscountAmounts,
  DISCOUNT_CODE_REASONS,
} from "@shared/domain/pricing.ts";

describe("applyBasisPoints", () => {
  it("applies a percentage in basis points using integer arithmetic", () => {
    // 25 % of COP $95.000 (9500000 centavos) = 2375000
    expect(applyBasisPoints(copCents(9_500_000), 2500)).toBe(2_375_000);
    expect(applyBasisPoints(copCents(9_500_000), 1000)).toBe(950_000);
    expect(applyBasisPoints(copCents(1_000), 10_000)).toBe(1_000);
    expect(applyBasisPoints(copCents(1_000), 0)).toBe(0);
  });

  it("floors, so the buyer is never charged more than the promised percentage", () => {
    // 33.33 % of 100 centavos is 33.33 -> 33, never 34.
    expect(applyBasisPoints(copCents(100), 3333)).toBe(33);
    expect(applyBasisPoints(copCents(7), 5000)).toBe(3);
  });

  it("rejects rates outside 0..10000 or non-integers", () => {
    expect(() => applyBasisPoints(copCents(100), -1)).toThrow(RangeError);
    expect(() => applyBasisPoints(copCents(100), 10_001)).toThrow(RangeError);
    expect(() => applyBasisPoints(copCents(100), 12.5)).toThrow(RangeError);
  });
});

describe("resolveDiscountAmounts", () => {
  const subtotal = copCents(28_500_000);

  it("BEST_SINGLE applies only the larger discount and zeroes the other", () => {
    // Quantity 10 % (2.850.000) vs code 25 % (7.125.000) -> the code wins.
    const result = resolveDiscountAmounts({
      subtotal,
      quantityDiscount: copCents(2_850_000),
      codeDiscount: copCents(7_125_000),
      combination: "BEST_SINGLE",
    });
    expect(result.quantityDiscountApplied).toBe(0);
    expect(result.codeDiscountApplied).toBe(7_125_000);
    expect(result.totalDiscount).toBe(7_125_000);
    expect(result.total).toBe(21_375_000);
  });

  it("BEST_SINGLE keeps the quantity discount when it is larger", () => {
    const result = resolveDiscountAmounts({
      subtotal,
      quantityDiscount: copCents(9_000_000),
      codeDiscount: copCents(1_000_000),
      combination: "BEST_SINGLE",
    });
    expect(result.quantityDiscountApplied).toBe(9_000_000);
    expect(result.codeDiscountApplied).toBe(0);
    expect(result.total).toBe(19_500_000);
  });

  it("BEST_SINGLE with no discounts leaves the subtotal untouched", () => {
    const result = resolveDiscountAmounts({
      subtotal,
      quantityDiscount: copCents(0),
      codeDiscount: copCents(0),
      combination: "BEST_SINGLE",
    });
    expect(result.totalDiscount).toBe(0);
    expect(result.total).toBe(subtotal);
  });

  it("STACK applies both discounts", () => {
    const result = resolveDiscountAmounts({
      subtotal,
      quantityDiscount: copCents(2_850_000),
      codeDiscount: copCents(7_125_000),
      combination: "STACK",
    });
    expect(result.quantityDiscountApplied).toBe(2_850_000);
    expect(result.codeDiscountApplied).toBe(7_125_000);
    expect(result.totalDiscount).toBe(9_975_000);
    expect(result.total).toBe(18_525_000);
  });

  it("STACK caps the total at the subtotal so the price can never go negative", () => {
    const result = resolveDiscountAmounts({
      subtotal: copCents(1_000_000),
      quantityDiscount: copCents(600_000),
      codeDiscount: copCents(600_000),
      combination: "STACK",
    });
    expect(result.quantityDiscountApplied).toBe(600_000);
    expect(result.codeDiscountApplied).toBe(400_000);
    expect(result.totalDiscount).toBe(1_000_000);
    expect(result.total).toBe(0);
  });

  it("never produces a discount larger than the subtotal", () => {
    const result = resolveDiscountAmounts({
      subtotal: copCents(500_000),
      quantityDiscount: copCents(0),
      codeDiscount: copCents(9_000_000),
      combination: "STACK",
    });
    expect(result.totalDiscount).toBe(500_000);
    expect(result.total).toBe(0);
  });
});

describe("assertQuoteConsistency", () => {
  const consistent = {
    unitPrice: copCents(9_500_000),
    quantity: 3,
    subtotal: copCents(28_500_000),
    quantityDiscount: copCents(0),
    codeDiscount: copCents(7_125_000),
    totalDiscount: copCents(7_125_000),
    total: copCents(21_375_000),
  };

  it("accepts an internally consistent quote", () => {
    const result = assertQuoteConsistency(consistent);
    expect(result.total).toBe(21_375_000);
    expect(result.quantity).toBe(3);
  });

  it("rejects a subtotal that does not match unit price x quantity", () => {
    expect(() => assertQuoteConsistency({ ...consistent, subtotal: copCents(1) })).toThrow(
      /subtotal does not match/,
    );
  });

  it("rejects a total discount that does not match its parts", () => {
    expect(() => assertQuoteConsistency({ ...consistent, totalDiscount: copCents(1) })).toThrow(
      /total discount does not match/,
    );
  });

  it("rejects a total that does not match subtotal minus discount", () => {
    expect(() => assertQuoteConsistency({ ...consistent, total: copCents(1) })).toThrow(
      /total does not match/,
    );
  });
});

describe("discount vocabulary", () => {
  it("recognizes exactly the documented combination policies", () => {
    expect(isDiscountCombination("BEST_SINGLE")).toBe(true);
    expect(isDiscountCombination("STACK")).toBe(true);
    expect(isDiscountCombination("SUM")).toBe(false);
  });

  it("recognizes exactly the documented refusal reasons", () => {
    for (const reason of DISCOUNT_CODE_REASONS) {
      expect(isDiscountCodeReason(reason)).toBe(true);
    }
    expect(isDiscountCodeReason("MADE_UP")).toBe(false);
  });
});
