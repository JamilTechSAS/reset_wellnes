import { describe, expect, it } from "vitest";

import { AppError } from "@shared/domain/errors.ts";
import {
  allowedOrderTransitions,
  assertOrderTransition,
  canTransitionOrder,
  holdsInventoryReservation,
  isOrderStatus,
  isPayableOrderStatus,
  isTerminalOrderStatus,
  ORDER_STATUSES,
} from "@shared/domain/order-state.ts";

describe("order state machine", () => {
  it("defines the documented states", () => {
    expect([...ORDER_STATUSES]).toEqual(["PENDING", "PAID", "FAILED", "CANCELLED", "EXPIRED"]);
    expect(isOrderStatus("PENDING")).toBe(true);
    expect(isOrderStatus("REFUNDED")).toBe(false);
  });

  it("allows the documented transitions from PENDING", () => {
    expect(canTransitionOrder("PENDING", "PAID")).toBe(true);
    expect(canTransitionOrder("PENDING", "FAILED")).toBe(true);
    expect(canTransitionOrder("PENDING", "CANCELLED")).toBe(true);
    expect(canTransitionOrder("PENDING", "EXPIRED")).toBe(true);
  });

  it("keeps PAID and CANCELLED terminal", () => {
    expect(allowedOrderTransitions("PAID")).toEqual([]);
    expect(allowedOrderTransitions("CANCELLED")).toEqual([]);
    expect(isTerminalOrderStatus("PAID")).toBe(true);
    expect(isTerminalOrderStatus("CANCELLED")).toBe(true);
    expect(isTerminalOrderStatus("PENDING")).toBe(false);
    expect(canTransitionOrder("PAID", "CANCELLED")).toBe(false);
    expect(canTransitionOrder("PAID", "PENDING")).toBe(false);
    expect(canTransitionOrder("CANCELLED", "PENDING")).toBe(false);
  });

  it("allows retrying a failed or expired order without reopening a paid one", () => {
    expect(canTransitionOrder("FAILED", "PENDING")).toBe(true);
    expect(canTransitionOrder("EXPIRED", "PENDING")).toBe(true);
    expect(canTransitionOrder("FAILED", "PAID")).toBe(false);
    expect(canTransitionOrder("EXPIRED", "PAID")).toBe(false);
  });

  it("only treats PENDING as payable and as holding inventory", () => {
    expect(isPayableOrderStatus("PENDING")).toBe(true);
    for (const status of ["PAID", "FAILED", "CANCELLED", "EXPIRED"] as const) {
      expect(isPayableOrderStatus(status)).toBe(false);
      expect(holdsInventoryReservation(status)).toBe(false);
    }
    expect(holdsInventoryReservation("PENDING")).toBe(true);
  });

  it("throws a CONFLICT error with actionable context on invalid transitions", () => {
    expect(() => {
      assertOrderTransition("PENDING", "PAID");
    }).not.toThrow();

    try {
      assertOrderTransition("PAID", "PENDING");
      expect.unreachable("transition should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("CONFLICT");
      expect(appError.context).toEqual({ from: "PAID", to: "PENDING" });
    }
  });
});
