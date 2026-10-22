import { describe, expect, it } from "vitest";

import {
  addCopCents,
  CENTS_PER_PESO,
  copCents,
  copCentsToPesos,
  formatCopCents,
  isCopCents,
  multiplyCopCents,
  parsePesosToCopCents,
  subtractCopCents,
  zeroCopCents,
} from "@shared/domain/money.ts";

describe("COP money", () => {
  it("uses centavos as the unit of account, matching Wompi amount_in_cents", () => {
    // Documented example: $95.000 COP is sent as 9500000.
    expect(parsePesosToCopCents("95.000")).toBe(9_500_000);
    expect(copCentsToPesos(copCents(9_500_000))).toBe(95_000);
    expect(CENTS_PER_PESO).toBe(100);
  });

  it("rejects non-integer, negative and unbounded amounts", () => {
    expect(() => copCents(12.5)).toThrow(RangeError);
    expect(() => copCents(-1)).toThrow(RangeError);
    expect(() => copCents(Number.NaN)).toThrow(RangeError);
    expect(() => copCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it("guards amounts at runtime", () => {
    expect(isCopCents(100)).toBe(true);
    expect(isCopCents(1.5)).toBe(false);
    expect(isCopCents("100")).toBe(false);
    expect(isCopCents(-100)).toBe(false);
  });

  it("adds amounts without precision loss", () => {
    expect(addCopCents(copCents(1), copCents(2), copCents(3))).toBe(6);
    expect(addCopCents()).toBe(0);
    expect(zeroCopCents()).toBe(0);
    // The classic floating point failure that integer centavos avoid.
    expect(addCopCents(copCents(10), copCents(20))).not.toBe(30.000000000000004);
  });

  it("multiplies unit prices by quantity", () => {
    expect(multiplyCopCents(copCents(9_500_000), 2)).toBe(19_000_000);
    expect(multiplyCopCents(copCents(9_500_000), 0)).toBe(0);
    expect(() => multiplyCopCents(copCents(9_500_000), 1.5)).toThrow(RangeError);
    expect(() => multiplyCopCents(copCents(9_500_000), -1)).toThrow(RangeError);
  });

  it("never returns a negative amount when applying a deduction", () => {
    expect(subtractCopCents(copCents(10_000), copCents(2_500))).toBe(7_500);
    expect(subtractCopCents(copCents(1_000), copCents(2_000))).toBe(0);
    expect(subtractCopCents(copCents(1_000), copCents(1_000))).toBe(0);
  });

  it("formats amounts the Colombian way", () => {
    expect(formatCopCents(copCents(9_500_000))).toBe("$95.000");
    expect(formatCopCents(copCents(120_000_000))).toBe("$1.200.000");
    expect(formatCopCents(copCents(0))).toBe("$0");
    expect(formatCopCents(copCents(9_500_050))).toBe("$95.000,50");
  });

  it("parses operator input tolerantly but never guesses", () => {
    expect(parsePesosToCopCents(95_000)).toBe(9_500_000);
    expect(parsePesosToCopCents("95000")).toBe(9_500_000);
    expect(parsePesosToCopCents("95.000")).toBe(9_500_000);
    expect(parsePesosToCopCents("1.200.000")).toBe(120_000_000);
    expect(parsePesosToCopCents("95000,50")).toBe(9_500_050);
    expect(() => parsePesosToCopCents(95_000.5)).toThrow(RangeError);
    expect(() => parsePesosToCopCents("noventa mil")).toThrow(RangeError);
    expect(() => parsePesosToCopCents("95.00")).toThrow(RangeError);
    expect(() => parsePesosToCopCents("")).toThrow(RangeError);
  });
});
