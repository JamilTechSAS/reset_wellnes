import { describe, expect, it, vi } from "vitest";

import {
  extractTicketToken,
  handleCheckIn,
  handleOperatorTicketLookup,
} from "@shared/api/checkin-handler.ts";
import { AppError } from "@shared/domain/errors.ts";
import type { CheckInGateway, CheckInRecord } from "@shared/db/checkin.ts";
import type { OperatorIdentity } from "@shared/domain/operators.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const OPERATOR: OperatorIdentity = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "puerta@evento.example",
  displayName: "Operador Puerta 1",
  role: "OPERATOR",
};

const TOKEN = "TKT_0123456789ABCDEFGHJK";

function gateway(record: Partial<CheckInRecord> = {}): {
  gateway: CheckInGateway;
  recordCheckIn: ReturnType<typeof vi.fn>;
  getOperatorTicket: ReturnType<typeof vi.fn>;
} {
  const recordCheckIn = vi.fn().mockResolvedValue({
    outcome: "VALID",
    reason: undefined,
    ticketCode: "TKT-000001",
    checkedInAt: "2026-11-20T01:00:00.000Z",
    participantName: "Ana Pérez",
    ...record,
  });
  const getOperatorTicket = vi.fn().mockResolvedValue({
    found: true,
    ticket: {
      code: "TKT-000001",
      status: "ACTIVE",
      ticketType: "General",
      pricePaidCents: 9_500_000,
      unit: 1,
    },
    event: {
      code: "TAT-2026",
      name: "Concierto",
      startsAt: "2026-11-20T00:00:00.000Z",
      timezone: "America/Bogota",
      city: "Bogotá",
      venueName: "Teatro",
    },
    participant: { firstName: "Ana", lastName: "Pérez", nationalId: "1020456789", city: "Bogotá" },
    admission: {
      orderStatus: "PAID",
      paymentStatus: "approved",
      checkedIn: false,
      checkedInAt: null,
      checkedInBy: null,
    },
  });
  return {
    gateway: { recordCheckIn, getOperatorTicket },
    recordCheckIn,
    getOperatorTicket,
  };
}

describe("ticketToken extraction", () => {
  it("rejects a non-object body, a missing token and an oversized token", () => {
    for (const body of [null, "ticket", 42, [], {}]) {
      expect(() => extractTicketToken(body)).toThrow(AppError);
    }
    expect(() => extractTicketToken({ ticketToken: "  " })).toThrow(AppError);
    expect(() => extractTicketToken({ ticketToken: "x".repeat(200) })).toThrow(AppError);
  });

  it("returns the raw token for a well-formed body", () => {
    expect(extractTicketToken({ ticketToken: TOKEN, extra: "ignored" })).toBe(TOKEN);
  });
});

describe("check-in outcomes", () => {
  it("admits a VALID ticket with the participant name and records the operator", async () => {
    const { gateway: g, recordCheckIn } = gateway();
    const result = await handleCheckIn({
      rawBody: { ticketToken: TOKEN },
      operator: OPERATOR,
      gateway: g,
      logger,
    });
    expect(result).toEqual({
      status: "VALID",
      ticketCode: "TKT-000001",
      participant: { name: "Ana Pérez" },
      checkedInAt: "2026-11-20T01:00:00.000Z",
    });
    // The identity comes from the verified operator, never from the request.
    expect(recordCheckIn).toHaveBeenCalledWith({
      ticketToken: TOKEN,
      operatorLabel: "Operador Puerta 1",
      operatorUserId: OPERATOR.userId,
      method: "QR_SCAN",
    });
  });

  it("reports ALREADY_USED with the original timestamp and no participant name", async () => {
    const { gateway: g } = gateway({ outcome: "ALREADY_USED" });
    const result = await handleCheckIn({
      rawBody: { ticketToken: TOKEN },
      operator: OPERATOR,
      gateway: g,
      logger,
    });
    expect(result).toEqual({
      status: "ALREADY_USED",
      ticketCode: "TKT-000001",
      checkedInAt: "2026-11-20T01:00:00.000Z",
    });
    expect("participant" in result).toBe(false);
  });

  it("reports NOT_PAID, CANCELLED and NOT_FOUND as outcomes, never as HTTP errors", async () => {
    for (const outcome of ["NOT_PAID", "CANCELLED", "NOT_FOUND"] as const) {
      const { gateway: g } = gateway({ outcome });
      const result = await handleCheckIn({
        rawBody: { ticketToken: TOKEN },
        operator: OPERATOR,
        gateway: g,
        logger,
      });
      expect(result.status).toBe(outcome);
      expect("participant" in result).toBe(false);
    }
  });

  it("answers INVALID for a malformed token without any database lookup", async () => {
    const { gateway: g, recordCheckIn } = gateway();
    const result = await handleCheckIn({
      rawBody: { ticketToken: "not-a-ticket" },
      operator: OPERATOR,
      gateway: g,
      logger,
    });
    expect(result).toEqual({ status: "INVALID" });
    expect(recordCheckIn).not.toHaveBeenCalled();
  });

  it("normalizes scanner input before the lookup", async () => {
    const { gateway: g, recordCheckIn } = gateway();
    await handleCheckIn({
      rawBody: { ticketToken: `#${TOKEN.toLowerCase()}` },
      operator: OPERATOR,
      gateway: g,
      logger,
    });
    expect(recordCheckIn).toHaveBeenCalledWith(expect.objectContaining({ ticketToken: TOKEN }));
  });
});

describe("operator ticket lookup", () => {
  it("returns the admission view for a valid token", async () => {
    const { gateway: g, getOperatorTicket } = gateway();
    const result = await handleOperatorTicketLookup({
      rawToken: TOKEN,
      operator: OPERATOR,
      gateway: g,
      logger,
    });
    expect(getOperatorTicket).toHaveBeenCalledWith(TOKEN);
    expect(result.ticket.code).toBe("TKT-000001");
    expect(result.admission.checkedIn).toBe(false);
    expect(result.participant?.nationalId).toBe("1020456789");
  });

  it("answers NOT_FOUND for a malformed token without a lookup", async () => {
    const { gateway: g, getOperatorTicket } = gateway();
    await expect(
      handleOperatorTicketLookup({ rawToken: "nope", operator: OPERATOR, gateway: g, logger }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getOperatorTicket).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for an unknown token and for an incomplete view", async () => {
    const unknown = gateway();
    unknown.getOperatorTicket.mockResolvedValue({ found: false });
    await expect(
      handleOperatorTicketLookup({
        rawToken: TOKEN,
        operator: OPERATOR,
        gateway: unknown.gateway,
        logger,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const incomplete = gateway();
    incomplete.getOperatorTicket.mockResolvedValue({ found: true });
    await expect(
      handleOperatorTicketLookup({
        rawToken: TOKEN,
        operator: OPERATOR,
        gateway: incomplete.gateway,
        logger,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
