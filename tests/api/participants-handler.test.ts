import { describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  handleAttachParticipant,
  handleUpdateParticipant,
  parseParticipantRequest,
} from "@shared/api/participants-handler.ts";
import {
  type ParticipantValidationError,
  isParticipantValidationError,
} from "@shared/api/order-requests.ts";
import { AppError } from "@shared/domain/errors.ts";
import type { ParticipantGateway } from "@shared/db/participants.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const REFERENCE = "EVT-2026-000001";
const PARTICIPANT_ID = "44444444-4444-4444-8444-444444444444";

const VALID_PARTICIPANT = {
  firstName: "  Ana ",
  lastName: "Pérez",
  nationalId: "1.020.456.789",
  email: "ANA@Example.com",
  phone: "+57 301 977 7777",
  city: "Bogotá",
  instagram: "@ana.perez",
  consents: { dataProcessing: true, futureEvents: false },
};

const CONSENTS = {
  dataProcessing: true,
  futureEvents: false,
  policyVersion: "2026-v1",
  capturedAt: "2026-10-03T15:30:00.000Z",
};

type AttachParticipantSpy = MockedFunction<ParticipantGateway["attachParticipant"]>;
type UpdateParticipantSpy = MockedFunction<ParticipantGateway["updateParticipant"]>;

function gateway(overrides: Partial<ParticipantGateway> = {}): {
  gateway: ParticipantGateway;
  attachParticipant: AttachParticipantSpy;
  updateParticipant: UpdateParticipantSpy;
} {
  const attachParticipant = vi.fn<ParticipantGateway["attachParticipant"]>().mockResolvedValue({
    found: true,
    orderReference: REFERENCE,
    unit: 2,
    participant: { participantId: PARTICIPANT_ID, firstName: "Ana", lastName: "Pérez" },
    consents: CONSENTS,
    consentsAppended: 2,
    remainingUnassigned: 0,
  });
  const updateParticipant = vi.fn<ParticipantGateway["updateParticipant"]>().mockResolvedValue({
    found: true,
    participantId: PARTICIPANT_ID,
    firstName: "Ana",
    lastName: "Pérez",
    consents: CONSENTS,
    consentsAppended: 1,
  });
  return {
    gateway: { attachParticipant, updateParticipant, ...overrides },
    attachParticipant,
    updateParticipant,
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

describe("participant request parsing", () => {
  it("normalizes the participant block and strips unknown keys", () => {
    const parsed = parseParticipantRequest({
      participant: { ...VALID_PARTICIPANT, pricePaidCents: 0, ticketStatus: "ACTIVE" },
      // Tickets are discontinued: a legacy ticket token in the body must never reach the
      // database and is not part of the parsed request.
      ticketToken: "TKT_0123456789ABCDEFGHJK",
      consentPolicyVersion: "2026-v1",
      injected: "ignored",
    });
    expect(parsed.participant).toEqual({
      firstName: "Ana",
      lastName: "Pérez",
      nationalId: "1020456789",
      email: "ana@example.com",
      phone: "573019777777",
      city: "Bogotá",
      instagram: "ana.perez",
      consents: { dataProcessing: true, futureEvents: false },
    });
    expect(parsed).not.toHaveProperty("ticketToken");
    expect(parsed.policyVersion).toBe("2026-v1");
    expect(JSON.stringify(parsed.participantJson)).not.toContain("pricePaidCents");
    expect(JSON.stringify(parsed.participantJson)).not.toContain("ticketStatus");
  });

  it("collects field problems instead of failing on the first", () => {
    try {
      parseParticipantRequest({
        participant: {
          firstName: "",
          lastName: "",
          nationalId: "abc",
          email: "not-an-email",
          phone: "12",
          city: "",
          consents: { dataProcessing: false, futureEvents: false },
        },
      });
      expect.unreachable("invalid participant must throw");
    } catch (error) {
      expect(isParticipantValidationError(error)).toBe(true);
      const issues = (error as ParticipantValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(6);
      expect(issues.map((issue) => issue.path)).toContain("consents.dataProcessing");
    }
  });

  it("rejects a non-object body and an oversized policy version", () => {
    expect(() => parseParticipantRequest(null)).toThrow(AppError);
    expect(() =>
      parseParticipantRequest({
        participant: VALID_PARTICIPANT,
        consentPolicyVersion: "x".repeat(100),
      }),
    ).toThrow(AppError);
  });
});

describe("attach participant", () => {
  it("returns only the safe identifiers and the assigned admission", async () => {
    const { gateway: g, attachParticipant } = gateway();
    const result = await handleAttachParticipant({
      reference: REFERENCE,
      email: "Buyer@Example.com",
      rawBody: { participant: VALID_PARTICIPANT },
      gateway: g,
      logger,
    });

    // The normalized argument is read from the spy and asserted field by field, so no
    // `any` flows into the test (same convention as the orders handler suite).
    const sent = attachParticipant.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      orderReference: REFERENCE,
      buyerEmail: "buyer@example.com",
      participant: { nationalId: "1020456789" },
      policyVersion: undefined,
    });
    expect(sent).not.toHaveProperty("ticketToken");
    expect(result).toEqual({
      orderReference: REFERENCE,
      unit: 2,
      participant: { participantId: PARTICIPANT_ID, firstName: "Ana", lastName: "Pérez" },
      consents: CONSENTS,
      remainingUnassigned: 0,
    });
    // The response never echoes cédula, email or phone back over the wire.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("1020456789");
    expect(serialized).not.toContain("ana@example.com");
    expect(serialized).not.toContain("573019777777");
  });

  it("hides an unknown reference, a wrong email and a foreign participant behind one NOT_FOUND", async () => {
    const { gateway: g } = gateway({
      attachParticipant: vi.fn().mockResolvedValue({ found: false }),
    });
    await expectCode(
      handleAttachParticipant({
        reference: REFERENCE,
        email: "buyer@example.com",
        rawBody: { participant: VALID_PARTICIPANT },
        gateway: g,
        logger,
      }),
      "NOT_FOUND",
    );
  });

  it("validates the reference, the email and the body before calling the database", async () => {
    const { gateway: g, attachParticipant } = gateway();
    await expectCode(
      handleAttachParticipant({
        reference: "nope",
        email: "buyer@example.com",
        rawBody: { participant: VALID_PARTICIPANT },
        gateway: g,
        logger,
      }),
      "VALIDATION_ERROR",
    );
    await expectCode(
      handleAttachParticipant({
        reference: REFERENCE,
        email: "   ",
        rawBody: { participant: VALID_PARTICIPANT },
        gateway: g,
        logger,
      }),
      "VALIDATION_ERROR",
    );
    expect(attachParticipant).not.toHaveBeenCalled();
  });
});

describe("update participant", () => {
  it("updates a participant of the same order and reports the appended consents", async () => {
    const { gateway: g, updateParticipant } = gateway();
    const result = await handleUpdateParticipant({
      reference: REFERENCE,
      email: "buyer@example.com",
      participantId: PARTICIPANT_ID,
      rawBody: { participant: { ...VALID_PARTICIPANT, instagram: undefined } },
      gateway: g,
      logger,
    });
    const sent = updateParticipant.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      orderReference: REFERENCE,
      buyerEmail: "buyer@example.com",
      participantId: PARTICIPANT_ID,
      policyVersion: undefined,
    });
    expect(result.consentsAppended).toBe(1);
  });

  it("rejects a malformed participant id and an unknown participant", async () => {
    const { gateway: g } = gateway();
    await expectCode(
      handleUpdateParticipant({
        reference: REFERENCE,
        email: "buyer@example.com",
        participantId: "not-a-uuid",
        rawBody: { participant: VALID_PARTICIPANT },
        gateway: g,
        logger,
      }),
      "VALIDATION_ERROR",
    );

    const missing = gateway({
      updateParticipant: vi.fn().mockResolvedValue({ found: false }),
    });
    await expectCode(
      handleUpdateParticipant({
        reference: REFERENCE,
        email: "buyer@example.com",
        participantId: PARTICIPANT_ID,
        rawBody: { participant: VALID_PARTICIPANT },
        gateway: missing.gateway,
        logger,
      }),
      "NOT_FOUND",
    );
  });
});
