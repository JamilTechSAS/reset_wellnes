import { describe, expect, it, vi } from "vitest";

import {
  handleGetPublicAvailability,
  handleGetPublicEvent,
  handleGetPublicTicket,
  normalizeEventCode,
} from "@shared/api/public-handler.ts";
import { AppError } from "@shared/domain/errors.ts";
import type { PublicGateway, PublicSales } from "@shared/db/public.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const TOKEN = "TKT_0123456789ABCDEFGHJK"; // "O" is not in the base32 alphabet.

const SALES: PublicSales = {
  currency: "COP",
  salesOpen: true,
  availability: "LOW",
  ticketTypes: [
    {
      code: "GENERAL",
      name: "Entrada general",
      description: null,
      minPerOrder: 1,
      maxPerOrder: 4,
      salesOpen: true,
      availability: "LOW",
      currentTier: { name: "Preventa 1", sequence: 1, priceInCents: 9_500_000 },
    },
  ],
};

function gateway(overrides: Partial<PublicGateway> = {}): {
  gateway: PublicGateway;
  getPublicEvent: ReturnType<typeof vi.fn>;
  getPublicAvailability: ReturnType<typeof vi.fn>;
  getPublicTicket: ReturnType<typeof vi.fn>;
} {
  const getPublicEvent = vi.fn().mockResolvedValue({
    found: true,
    event: {
      code: "TAT-2026",
      name: "Concierto",
      description: null,
      status: "PUBLISHED",
      startsAt: "2026-11-20T00:00:00.000Z",
      endsAt: null,
      timezone: "America/Bogota",
      currency: "COP",
      venue: { name: "Teatro", address: null, city: "Bogotá" },
    },
    sales: SALES,
  });
  const getPublicAvailability = vi.fn().mockResolvedValue({
    found: true,
    code: "TAT-2026",
    sales: SALES,
  });
  const getPublicTicket = vi.fn().mockResolvedValue({
    found: true,
    ticket: { code: "TKT-000001", status: "ACTIVE", displayName: "Ana P." },
    event: {
      code: "TAT-2026",
      name: "Concierto",
      startsAt: "2026-11-20T00:00:00.000Z",
      endsAt: null,
      timezone: "America/Bogota",
      city: "Bogotá",
      venueName: "Teatro",
      venueAddress: null,
    },
  });
  return {
    gateway: { getPublicEvent, getPublicAvailability, getPublicTicket, ...overrides },
    getPublicEvent,
    getPublicAvailability,
    getPublicTicket,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}

describe("event code normalization", () => {
  it("uppercases and accepts the documented slug shape", () => {
    expect(normalizeEventCode(" tat-2026 ")).toBe("TAT-2026");
    expect(normalizeEventCode("EVENTO_1")).toBe("EVENTO_1");
  });

  it("rejects anything that cannot be an event code", () => {
    expect(normalizeEventCode("")).toBeUndefined();
    expect(normalizeEventCode("a")).toBeUndefined();
    expect(normalizeEventCode("EVT 2026")).toBeUndefined();
    expect(normalizeEventCode("EVT/2026")).toBeUndefined();
    expect(normalizeEventCode("%")).toBeUndefined();
    expect(normalizeEventCode("x".repeat(40))).toBeUndefined();
  });
});

describe("public event projection", () => {
  it("returns the SQL projection untouched", async () => {
    const { gateway: g } = gateway();
    const result = await handleGetPublicEvent({ code: "tat-2026", gateway: g, logger });
    expect(result.found).toBe(true);
    expect(result.event.code).toBe("TAT-2026");
    expect(result.sales.ticketTypes[0]?.currentTier?.priceInCents).toBe(9_500_000);
    // The projection has no capacity/counters by construction.
    expect(JSON.stringify(result)).not.toContain("capacity");
    expect(JSON.stringify(result)).not.toContain("quantity");
  });

  it("answers NOT_FOUND for a malformed code without touching the database", async () => {
    const { gateway: g, getPublicEvent } = gateway();
    await expectCode(handleGetPublicEvent({ code: "!!", gateway: g, logger }), "NOT_FOUND");
    expect(getPublicEvent).not.toHaveBeenCalled();
  });

  it("answers the SAME NOT_FOUND for an unpublished/unknown event", async () => {
    const getPublicEvent = vi.fn().mockResolvedValue({ found: false });
    const { gateway: g } = gateway({ getPublicEvent });
    await expectCode(handleGetPublicEvent({ code: "TAT-2026", gateway: g, logger }), "NOT_FOUND");
    expect(getPublicEvent).toHaveBeenCalledWith("TAT-2026");
  });

  it("exposes coarse availability only", async () => {
    const { gateway: g } = gateway();
    const result = await handleGetPublicAvailability({ code: "TAT-2026", gateway: g, logger });
    expect(result.found).toBe(true);
    expect(result.sales.availability).toBe("LOW");
    expect(result.sales.ticketTypes[0]?.availability).toBe("LOW");
  });
});

describe("public ticket lookup", () => {
  it("returns the public-safe projection for a valid token", async () => {
    const { gateway: g, getPublicTicket } = gateway();
    const result = await handleGetPublicTicket({ rawToken: TOKEN, gateway: g, logger });
    expect(getPublicTicket).toHaveBeenCalledWith(TOKEN);
    expect(result.found).toBe(true);
    // Only the minimum: event identity, code, status, display name. No PII fields exist
    // in the projection at all.
    expect(result.ticket.displayName).toBe("Ana P.");
    const serialized = JSON.stringify(result);
    for (const forbidden of ["nationalId", "cédula", "email", "phone", "consent"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("rejects a malformed token with NOT_FOUND without a database lookup", async () => {
    const { gateway: g, getPublicTicket } = gateway();
    await expectCode(
      handleGetPublicTicket({ rawToken: "not-a-token", gateway: g, logger }),
      "NOT_FOUND",
    );
    await expectCode(
      handleGetPublicTicket({ rawToken: "TKT_IIIIIIIIIIIIIIIIIIII", gateway: g, logger }),
      "NOT_FOUND",
    );
    expect(getPublicTicket).not.toHaveBeenCalled();
  });

  it("rejects an oversized token before normalization", async () => {
    const { gateway: g, getPublicTicket } = gateway();
    await expectCode(
      handleGetPublicTicket({ rawToken: "x".repeat(500), gateway: g, logger }),
      "NOT_FOUND",
    );
    expect(getPublicTicket).not.toHaveBeenCalled();
  });

  it("normalizes scanner input (URL form, lowercase, whitespace)", async () => {
    const { gateway: g, getPublicTicket } = gateway();
    await handleGetPublicTicket({
      rawToken: `  https://evento.example/entrada/t/${TOKEN.toLowerCase()}?utm=qr  `,
      gateway: g,
      logger,
    });
    expect(getPublicTicket).toHaveBeenCalledWith(TOKEN);
  });

  it("answers NOT_FOUND for an unknown token without revealing which part was wrong", async () => {
    const { gateway: g } = gateway({
      getPublicTicket: vi.fn().mockResolvedValue({ found: false }),
    });
    await expectCode(handleGetPublicTicket({ rawToken: TOKEN, gateway: g, logger }), "NOT_FOUND");
  });
});
