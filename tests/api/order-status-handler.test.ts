/**
 * `GET /orders/{reference}` projection.
 *
 * The SQL function is covered by the schema suites; this suite covers what the Edge Function
 * hands to the browser. Tickets are discontinued, so the response must carry the order's
 * admissions and a names-only roster instead of ticket tokens, and it must never widen the
 * database projection (a column added to `participants` cannot leak through this mapper).
 */

import { describe, expect, it, vi } from "vitest";

import { handleOrderStatus } from "@shared/api/order-status-handler.ts";
import { AppError } from "@shared/domain/errors.ts";
import { createLogger } from "@shared/logging/logger.ts";
import type { OrderStatus, OrderStatusGateway } from "@shared/db/payments.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const REFERENCE = "EVT-2026-000001";
const EMAIL = "buyer@example.com";

const PAID_STATUS: OrderStatus = {
  found: true,
  reference: REFERENCE,
  status: "PAID",
  quantity: 2,
  totalInCents: 40_000_000,
  currency: "COP",
  createdAt: "2026-10-24T15:00:00.000Z",
  paidAt: "2026-10-24T15:05:00.000Z",
  reservationExpiresAt: "2026-10-24T15:15:00.000Z",
  payment: {
    attempt: 1,
    status: "approved",
    methodType: "CARD",
    statusMessage: null,
    approvedAt: "2026-10-24T15:05:00.000Z",
  },
  paymentAttempts: [
    {
      attempt: 1,
      status: "approved",
      wompiReference: REFERENCE,
      amountInCents: 40_000_000,
      statusMessage: null,
      createdAt: "2026-10-24T15:00:00.000Z",
      finalizedAt: "2026-10-24T15:05:00.000Z",
    },
  ],
  admissions: { quantity: 2, assigned: 2, remainingUnassigned: 0 },
  participants: [
    { unit: 1, firstName: "Ana", lastName: "Pérez" },
    { unit: 2, firstName: "Beto", lastName: "Gómez" },
  ],
};

function gateway(status: OrderStatus): OrderStatusGateway {
  return {
    getOrderStatus: vi.fn(async () => status),
    findEmailContext: vi.fn(async () => undefined),
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("order status projection", () => {
  it("returns the admission roster and never the ticket-era fields", async () => {
    const result = await handleOrderStatus({
      reference: REFERENCE,
      email: EMAIL,
      gateway: gateway(PAID_STATUS),
      logger,
    });

    expect(result.admissions).toEqual({ quantity: 2, assigned: 2, remainingUnassigned: 0 });
    expect(result.participants).toEqual([
      { unit: 1, firstName: "Ana", lastName: "Pérez" },
      { unit: 2, firstName: "Beto", lastName: "Gómez" },
    ]);
    expect(result).not.toHaveProperty("tickets");
    expect(result).not.toHaveProperty("confirmation");
  });

  it("drops any extra database column from the roster", async () => {
    const leaked = {
      ...PAID_STATUS,
      participants: [
        {
          unit: 1,
          firstName: "Ana",
          lastName: "Pérez",
          nationalId: "1020456789",
          email: "ana@example.com",
          phone: "3001234567",
        },
      ],
    } as unknown as OrderStatus;

    const result = await handleOrderStatus({
      reference: REFERENCE,
      email: EMAIL,
      gateway: gateway(leaked),
      logger,
    });

    expect(result.participants).toEqual([{ unit: 1, firstName: "Ana", lastName: "Pérez" }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("1020456789");
    expect(serialized).not.toContain("ana@example.com");
    expect(serialized).not.toContain("3001234567");
  });

  it("derives the counts when an older projection does not carry them", async () => {
    const legacy = {
      ...PAID_STATUS,
      admissions: undefined,
      participants: [{ unit: 1, firstName: "Ana", lastName: "Pérez" }],
    } as unknown as OrderStatus;

    const result = await handleOrderStatus({
      reference: REFERENCE,
      email: EMAIL,
      gateway: gateway(legacy),
      logger,
    });

    expect(result.admissions).toEqual({ quantity: 2, assigned: 1, remainingUnassigned: 1 });
  });

  it("hides an unknown reference and a wrong email behind the same NOT_FOUND", async () => {
    await expectCode(
      handleOrderStatus({
        reference: REFERENCE,
        email: "someone@else.com",
        gateway: gateway({ found: false }),
        logger,
      }),
      "NOT_FOUND",
    );

    await expectCode(
      handleOrderStatus({
        reference: REFERENCE,
        email: EMAIL,
        gateway: gateway({ ...PAID_STATUS, reference: "EVT-2026-000099" }),
        logger,
      }),
      "NOT_FOUND",
    );
  });

  it("validates the reference and the buyer email before reading the database", async () => {
    const fake = gateway(PAID_STATUS);
    await expectCode(
      handleOrderStatus({ reference: "nope", email: EMAIL, gateway: fake, logger }),
      "VALIDATION_ERROR",
    );
    await expectCode(
      handleOrderStatus({ reference: REFERENCE, email: "   ", gateway: fake, logger }),
      "VALIDATION_ERROR",
    );
    expect(fake.getOrderStatus).not.toHaveBeenCalled();
  });
});
