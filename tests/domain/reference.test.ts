import { describe, expect, it } from "vitest";

import {
  formatOrderReference,
  formatPaymentReference,
  findWompiReferenceProblem,
  isValidOrderReference,
  isValidWompiReference,
  MAX_WOMPI_REFERENCE_LENGTH,
  parseOrderReference,
} from "@shared/domain/reference.ts";

describe("order references", () => {
  it("formats the documented EVT-<year>-<sequence> shape", () => {
    expect(formatOrderReference({ year: 2026, sequence: 1 })).toBe("EVT-2026-000001");
    expect(formatOrderReference({ year: 2026, sequence: 42 })).toBe("EVT-2026-000042");
    expect(formatOrderReference({ year: 2026, sequence: 1234567 })).toBe("EVT-2026-1234567");
  });

  it("round-trips through parsing", () => {
    expect(parseOrderReference("EVT-2026-000001")).toEqual({ year: 2026, sequence: 1 });
    expect(parseOrderReference("EVT-2026-000001-A2")).toBeUndefined();
    expect(parseOrderReference("evt-2026-000001")).toBeUndefined();
    expect(isValidOrderReference("EVT-2026-000001")).toBe(true);
    expect(isValidOrderReference("ORDER-2024-001")).toBe(false);
  });

  it("rejects malformed inputs instead of producing a bad reference", () => {
    expect(() => formatOrderReference({ year: 26, sequence: 1 })).toThrow(RangeError);
    expect(() => formatOrderReference({ year: 2026, sequence: 0 })).toThrow(RangeError);
    expect(() => formatOrderReference({ year: 2026, sequence: 1.5 })).toThrow(RangeError);
  });

  it("derives a distinct Wompi reference per payment attempt", () => {
    const orderReference = formatOrderReference({ year: 2026, sequence: 7 });
    // Attempt 1 keeps the order reference verbatim so support can match them 1:1.
    expect(formatPaymentReference(orderReference, 1)).toBe("EVT-2026-000007");
    // A declined transaction consumes its reference (Wompi docs), so retries must differ.
    expect(formatPaymentReference(orderReference, 2)).toBe("EVT-2026-000007-2");
    expect(formatPaymentReference(orderReference, 3)).not.toBe(
      formatPaymentReference(orderReference, 2),
    );
    expect(() => formatPaymentReference(orderReference, 0)).toThrow(RangeError);
    expect(() => formatPaymentReference("not-an-order", 1)).toThrow(RangeError);
  });

  it("enforces the documented Wompi reference constraints", () => {
    expect(isValidWompiReference("EVT-2026-000001")).toBe(true);
    expect(isValidWompiReference("58e281-177ab976cbf9-d162d2")).toBe(true);
    expect(isValidWompiReference("38932_3293298")).toBe(true);
    expect(findWompiReferenceProblem("")).toBe("empty");
    expect(findWompiReferenceProblem("EVT 2026 1")).toBe("invalid_characters");
    expect(findWompiReferenceProblem("EVT.2026.1")).toBe("invalid_characters");
    expect(findWompiReferenceProblem("ñandú")).toBe("invalid_characters");
    expect(findWompiReferenceProblem("a".repeat(MAX_WOMPI_REFERENCE_LENGTH + 1))).toBe("too_long");
    expect(MAX_WOMPI_REFERENCE_LENGTH).toBe(255);
  });
});
