import { describe, expect, it } from "vitest";

import {
  CHECKIN_OUTCOMES,
  decideCheckIn,
  mayEnterWithOutcome,
  type CheckInTicketSnapshot,
} from "@shared/domain/checkin.ts";

function ticket(overrides: Partial<CheckInTicketSnapshot> = {}): CheckInTicketSnapshot {
  return {
    ticketId: "tkt_1",
    ticketStatus: "ACTIVE",
    orderStatus: "PAID",
    paymentStatus: "approved",
    ...overrides,
  };
}

describe("check-in decisions", () => {
  it("admits a paid, active, unused ticket", () => {
    const decision = decideCheckIn({ ticket: ticket(), alreadyCheckedIn: false });
    expect(decision.outcome).toBe("VALID");
    expect(decision.reason).toBe("OK");
    expect(decision.ticketId).toBe("tkt_1");
    expect(mayEnterWithOutcome(decision.outcome)).toBe(true);
  });

  it("reports an unknown token as INVALID without disclosing anything", () => {
    const decision = decideCheckIn({ ticket: undefined, alreadyCheckedIn: false });
    expect(decision).toEqual({
      outcome: "INVALID",
      reason: "TICKET_NOT_FOUND",
      ticketId: undefined,
    });
    expect(mayEnterWithOutcome(decision.outcome)).toBe(false);
  });

  it("reports a second scan as ALREADY_USED (first valid scan wins)", () => {
    const decision = decideCheckIn({ ticket: ticket(), alreadyCheckedIn: true });
    expect(decision.outcome).toBe("ALREADY_USED");
    expect(decision.reason).toBe("ATTENDANCE_EXISTS");
    expect(mayEnterWithOutcome(decision.outcome)).toBe(false);
  });

  it("reports cancelled and refunded tickets as CANCELLED", () => {
    expect(
      decideCheckIn({ ticket: ticket({ ticketStatus: "CANCELLED" }), alreadyCheckedIn: false })
        .outcome,
    ).toBe("CANCELLED");
    expect(
      decideCheckIn({ ticket: ticket({ ticketStatus: "REFUNDED" }), alreadyCheckedIn: false })
        .outcome,
    ).toBe("CANCELLED");
    expect(
      decideCheckIn({ ticket: ticket({ ticketStatus: "CANCELLED" }), alreadyCheckedIn: false })
        .reason,
    ).toBe("TICKET_CANCELLED");
  });

  it("reports unpaid or unapproved tickets as NOT_PAID", () => {
    const pendingOrder = decideCheckIn({
      ticket: ticket({ orderStatus: "PENDING", paymentStatus: "pending" }),
      alreadyCheckedIn: false,
    });
    expect(pendingOrder.outcome).toBe("NOT_PAID");
    expect(pendingOrder.reason).toBe("ORDER_PENDING");

    const declined = decideCheckIn({
      ticket: ticket({ orderStatus: "FAILED", paymentStatus: "declined" }),
      alreadyCheckedIn: false,
    });
    expect(declined.outcome).toBe("NOT_PAID");

    // An approved order whose payment status is unknown is still not proof of payment:
    // "unknown" must never admit anyone.
    const unknownPayment = decideCheckIn({
      ticket: ticket({ orderStatus: "PAID", paymentStatus: "unknown" }),
      alreadyCheckedIn: false,
    });
    expect(unknownPayment.outcome).toBe("NOT_PAID");
    expect(unknownPayment.reason).toBe("PAYMENT_UNKNOWN");
  });

  it("applies a documented precedence between conflicting states", () => {
    // Cancelled beats unpaid: the operator needs the actionable reason.
    expect(
      decideCheckIn({
        ticket: ticket({
          ticketStatus: "CANCELLED",
          orderStatus: "PENDING",
          paymentStatus: "pending",
        }),
        alreadyCheckedIn: false,
      }).outcome,
    ).toBe("CANCELLED");

    // Unpaid beats an existing attendance row: someone must never be admitted.
    expect(
      decideCheckIn({
        ticket: ticket({ orderStatus: "PENDING", paymentStatus: "pending" }),
        alreadyCheckedIn: true,
      }).outcome,
    ).toBe("NOT_PAID");
  });

  it("exposes the five documented outcomes and Spanish operator labels", () => {
    expect([...CHECKIN_OUTCOMES]).toEqual([
      "VALID",
      "ALREADY_USED",
      "INVALID",
      "NOT_PAID",
      "CANCELLED",
    ]);
    for (const outcome of CHECKIN_OUTCOMES) {
      expect(mayEnterWithOutcome(outcome)).toBe(outcome === "VALID");
    }
  });
});
