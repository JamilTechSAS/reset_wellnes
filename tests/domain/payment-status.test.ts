import { describe, expect, it } from "vitest";

import {
  advancePaymentStatus,
  isFailedPaymentStatus,
  isSuccessfulPaymentStatus,
  isTerminalPaymentStatus,
  isWompiTransactionStatus,
  mapWompiTransactionStatus,
  toPaymentStatusSnapshot,
  WOMPI_TRANSACTION_STATUSES,
} from "@shared/domain/payment-status.ts";

describe("Wompi transaction status mapping", () => {
  it("covers exactly the documented Wompi statuses", () => {
    expect([...WOMPI_TRANSACTION_STATUSES]).toEqual([
      "PENDING",
      "APPROVED",
      "DECLINED",
      "VOIDED",
      "ERROR",
    ]);
    for (const status of WOMPI_TRANSACTION_STATUSES) {
      expect(isWompiTransactionStatus(status)).toBe(true);
    }
    expect(isWompiTransactionStatus("REFUNDED")).toBe(false);
  });

  it("maps every documented status into the internal model", () => {
    expect(mapWompiTransactionStatus("PENDING")).toBe("pending");
    expect(mapWompiTransactionStatus("APPROVED")).toBe("approved");
    expect(mapWompiTransactionStatus("DECLINED")).toBe("declined");
    expect(mapWompiTransactionStatus("VOIDED")).toBe("voided");
    expect(mapWompiTransactionStatus("ERROR")).toBe("error");
  });

  it("tolerates casing and whitespace from the network", () => {
    expect(mapWompiTransactionStatus(" approved ")).toBe("approved");
    expect(mapWompiTransactionStatus("Declined")).toBe("declined");
  });

  it("never treats an unknown status as successful", () => {
    const unknown = mapWompiTransactionStatus("PARTIALLY_REFUNDED");
    expect(unknown).toBe("unknown");
    expect(isSuccessfulPaymentStatus(unknown)).toBe(false);
    expect(isTerminalPaymentStatus(unknown)).toBe(false);
    expect(isFailedPaymentStatus(unknown)).toBe(false);
  });

  it("keeps the raw Wompi value next to the normalized one", () => {
    expect(toPaymentStatusSnapshot(" APPROVED ")).toEqual({
      rawWompiStatus: "APPROVED",
      normalizedStatus: "approved",
    });
    expect(toPaymentStatusSnapshot("SomethingNew")).toEqual({
      rawWompiStatus: "SomethingNew",
      normalizedStatus: "unknown",
    });
  });

  it("only approves and fails on the expected statuses", () => {
    expect(isSuccessfulPaymentStatus("approved")).toBe(true);
    for (const status of ["pending", "declined", "voided", "error", "unknown"] as const) {
      expect(isSuccessfulPaymentStatus(status)).toBe(false);
    }
    expect(isFailedPaymentStatus("declined")).toBe(true);
    expect(isFailedPaymentStatus("voided")).toBe(true);
    expect(isFailedPaymentStatus("error")).toBe(true);
    // A refunded payment is money that came back: not revenue, but not "never paid" either.
    expect(isFailedPaymentStatus("refunded")).toBe(true);
    expect(isFailedPaymentStatus("pending")).toBe(false);
    expect(isFailedPaymentStatus("approved")).toBe(false);
  });

  it("treats PENDING and unknown as non-terminal", () => {
    expect(isTerminalPaymentStatus("pending")).toBe(false);
    expect(isTerminalPaymentStatus("unknown")).toBe(false);
    expect(isTerminalPaymentStatus("approved")).toBe(true);
    expect(isTerminalPaymentStatus("declined")).toBe(true);
  });

  it("never lets a replayed or out-of-order event regress a final status", () => {
    // Duplicate delivery of the same status is a no-op.
    expect(advancePaymentStatus("approved", "approved")).toBe("approved");
    // A late PENDING event cannot un-approve a paid order.
    expect(advancePaymentStatus("approved", "pending")).toBe("approved");
    expect(advancePaymentStatus("declined", "pending")).toBe("declined");
    // A forward transition still applies.
    expect(advancePaymentStatus("pending", "approved")).toBe("approved");
    expect(advancePaymentStatus("pending", "declined")).toBe("declined");
    // An unknown status is recorded raw but never advances the normalized status.
    expect(advancePaymentStatus("unknown", "approved")).toBe("approved");
    expect(advancePaymentStatus("pending", "unknown")).toBe("pending");
    expect(advancePaymentStatus("declined", "unknown")).toBe("declined");
    // An approved attempt is never un-approved by a later event...
    expect(advancePaymentStatus("approved", "declined")).toBe("approved");
    expect(advancePaymentStatus("approved", "error")).toBe("approved");
    // ...but a later VOIDED is a refund, not a plain void.
    expect(advancePaymentStatus("approved", "voided")).toBe("refunded");
  });
});
