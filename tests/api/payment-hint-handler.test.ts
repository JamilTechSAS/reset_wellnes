import { describe, expect, it, vi } from "vitest";

import {
  handlePaymentHint,
  parsePaymentHintRequest,
  type PaymentHintGateway,
} from "@shared/api/payment-hint-handler.ts";
import { AppError } from "@shared/domain/errors.ts";
import { WompiApiError, type WompiClient } from "@shared/integrations/wompi/client.ts";
import type { WompiTransaction } from "@shared/integrations/wompi/types.ts";
import type { BuyerPaymentLookup, ConfirmPaymentResult } from "@shared/db/payments.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const TRANSACTION_ID = "1292-1602113476-10985";
const REFERENCE = "EVT-2026-000001";

function found(
  overrides: Partial<Extract<BuyerPaymentLookup, { found: true }>> = {},
): Extract<BuyerPaymentLookup, { found: true }> {
  return {
    found: true,
    paymentId: "22222222-2222-4222-8222-222222222222",
    paymentAttempt: 1,
    paymentStatus: "pending",
    wompiReference: REFERENCE,
    wompiTransactionId: null,
    amountCents: 9_500_000,
    currency: "COP",
    orderId: "33333333-3333-4333-8333-333333333333",
    orderReference: REFERENCE,
    orderStatus: "PENDING",
    orderTotalInCents: 9_500_000,
    orderCurrency: "COP",
    ...overrides,
  };
}

function transaction(overrides: Partial<WompiTransaction> = {}): WompiTransaction {
  return {
    id: TRANSACTION_ID,
    reference: REFERENCE,
    status: "APPROVED",
    amountInCents: 9_500_000,
    currency: "COP",
    customerEmail: undefined,
    paymentMethodType: "CARD",
    statusMessage: undefined,
    createdAt: undefined,
    finalizedAt: undefined,
    ...overrides,
  };
}

function confirmation(overrides: Partial<ConfirmPaymentResult> = {}): ConfirmPaymentResult {
  return {
    result: "APPLIED",
    reason: "PAYMENT_APPROVED",
    orderId: "33333333-3333-4333-8333-333333333333",
    orderReference: REFERENCE,
    orderStatus: "PAID",
    paymentId: "22222222-2222-4222-8222-222222222222",
    paymentStatus: "approved",
    rawWompiStatus: "APPROVED",
    paymentAttempt: 1,
    wompiReference: REFERENCE,
    wompiTransactionId: TRANSACTION_ID,
    amountInCents: 9_500_000,
    currency: "COP",
    ticketsIssued: 1,
    ticketsExpected: 1,
    reconciliationRequired: false,
    ...overrides,
  };
}

function setup(options: {
  readonly lookup?: BuyerPaymentLookup;
  readonly transaction?: WompiTransaction | Error;
  readonly confirmation?: ConfirmPaymentResult;
}) {
  const resolvePaymentForBuyer = vi.fn().mockResolvedValue(options.lookup ?? found());
  const confirmPayment = vi.fn().mockResolvedValue(options.confirmation ?? confirmation());
  const queueTicketEmails = vi
    .fn()
    .mockResolvedValue({ queued: 1, alreadyQueued: 0, total: 1, template: "TICKET_CONFIRMATION" });
  const gateway: PaymentHintGateway = {
    resolvePaymentForBuyer,
    confirmPayment,
    queueTicketEmails,
  };
  const getTransaction =
    options.transaction instanceof Error
      ? vi.fn().mockRejectedValue(options.transaction)
      : vi.fn().mockResolvedValue(options.transaction ?? transaction());
  const wompi: WompiClient = { getTransaction };
  return {
    gateway,
    wompi,
    resolvePaymentForBuyer,
    confirmPayment,
    queueTicketEmails,
    getTransaction,
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

describe("payment hint parsing", () => {
  it("requires a strictly shaped transaction id and ignores unknown keys", () => {
    expect(parsePaymentHintRequest({ transactionId: ` ${TRANSACTION_ID} ` })).toEqual({
      transactionId: TRANSACTION_ID,
      email: undefined,
    });
    expect(
      parsePaymentHintRequest({ transactionId: TRANSACTION_ID, email: "a@b.co", extra: 1 }),
    ).toMatchObject({ email: "a@b.co" });

    for (const body of [null, "x", {}, { transactionId: "" }, { transactionId: "has spaces" }]) {
      expect(() => parsePaymentHintRequest(body)).toThrow(AppError);
    }
    expect(() => parsePaymentHintRequest({ transactionId: "x".repeat(200) })).toThrow(AppError);
  });
});

describe("payment hint endpoint", () => {
  it("hides an unknown reference or a wrong email behind the same NOT_FOUND", async () => {
    const { gateway, wompi } = setup({ lookup: { found: false } });
    await expectCode(
      handlePaymentHint({
        reference: REFERENCE,
        email: "wrong@example.com",
        rawBody: { transactionId: TRANSACTION_ID },
        gateway,
        wompi,
        logger,
      }),
      "NOT_FOUND",
    );
  });

  it("refuses a transaction id that does not match the recorded one without calling Wompi", async () => {
    const { gateway, wompi, getTransaction } = setup({
      lookup: found({ wompiTransactionId: "1292-1602113476-00001" }),
    });
    const result = await handlePaymentHint({
      reference: REFERENCE,
      email: "buyer@example.com",
      rawBody: { transactionId: TRANSACTION_ID },
      gateway,
      wompi,
      logger,
    });
    expect(result.outcome).toBe("MISMATCH");
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("reports an unknown transaction at Wompi as an outcome, not an error", async () => {
    const { gateway, wompi } = setup({
      transaction: new WompiApiError("Wompi returned HTTP 404", { httpStatus: 404 }),
    });
    const result = await handlePaymentHint({
      reference: REFERENCE,
      email: "buyer@example.com",
      rawBody: { transactionId: TRANSACTION_ID },
      gateway,
      wompi,
      logger,
    });
    expect(result.outcome).toBe("TRANSACTION_NOT_FOUND");
    expect(result.orderReference).toBe(REFERENCE);
  });

  it("never confirms a transaction whose amount or reference does not match", async () => {
    const { gateway, wompi, confirmPayment } = setup({
      transaction: transaction({ amountInCents: 1 }),
    });
    const result = await handlePaymentHint({
      reference: REFERENCE,
      email: "buyer@example.com",
      rawBody: { transactionId: TRANSACTION_ID },
      gateway,
      wompi,
      logger,
    });
    expect(result.outcome).toBe("MISMATCH");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("confirms an approved transaction through the shared pipeline and queues the emails", async () => {
    const { gateway, wompi, confirmPayment, queueTicketEmails } = setup({});
    const result = await handlePaymentHint({
      reference: REFERENCE,
      email: "Buyer@Example.com",
      rawBody: { transactionId: TRANSACTION_ID },
      gateway,
      wompi,
      logger,
    });
    expect(result).toEqual({
      orderReference: REFERENCE,
      orderStatus: "PAID",
      paymentStatus: "approved",
      outcome: "APPROVED_APPLIED",
    });
    // The email is normalized before the possession check.
    expect(gateway.resolvePaymentForBuyer).toHaveBeenCalledWith(REFERENCE, "buyer@example.com");
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ wompiTransactionId: TRANSACTION_ID, wompiStatus: "APPROVED" }),
    );
    expect(queueTicketEmails).toHaveBeenCalledTimes(1);
  });

  it("reports a still-pending transaction without queueing anything", async () => {
    const { gateway, wompi, queueTicketEmails } = setup({
      transaction: transaction({ status: "PENDING" }),
      confirmation: confirmation({
        result: "APPLIED",
        reason: "PAYMENT_PENDING",
        orderStatus: "PENDING",
        paymentStatus: "pending",
        ticketsIssued: 0,
        ticketsExpected: 0,
      }),
    });
    const result = await handlePaymentHint({
      reference: REFERENCE,
      email: "buyer@example.com",
      rawBody: { transactionId: TRANSACTION_ID },
      gateway,
      wompi,
      logger,
    });
    expect(result.outcome).toBe("STILL_PENDING");
    expect(queueTicketEmails).not.toHaveBeenCalled();
  });

  it("reports a declined transaction", async () => {
    const { gateway, wompi } = setup({
      transaction: transaction({ status: "DECLINED" }),
      confirmation: confirmation({
        result: "APPLIED",
        reason: "PAYMENT_DECLINED",
        orderStatus: "FAILED",
        paymentStatus: "declined",
        ticketsIssued: 0,
        ticketsExpected: 0,
      }),
    });
    const result = await handlePaymentHint({
      reference: REFERENCE,
      email: "buyer@example.com",
      rawBody: { transactionId: TRANSACTION_ID },
      gateway,
      wompi,
      logger,
    });
    expect(result.outcome).toBe("DECLINED");
    expect(result.orderStatus).toBe("FAILED");
  });

  it("propagates a Wompi outage as UPSTREAM_ERROR so the frontend can retry", async () => {
    const { gateway, wompi } = setup({ transaction: new WompiApiError("Wompi unreachable") });
    await expectCode(
      handlePaymentHint({
        reference: REFERENCE,
        email: "buyer@example.com",
        rawBody: { transactionId: TRANSACTION_ID },
        gateway,
        wompi,
        logger,
      }),
      "UPSTREAM_ERROR",
    );
  });

  it("requires the buyer email and rejects a malformed reference before any query", async () => {
    const { gateway, wompi, resolvePaymentForBuyer } = setup({});
    await expectCode(
      handlePaymentHint({
        reference: REFERENCE,
        email: "",
        rawBody: { transactionId: TRANSACTION_ID },
        gateway,
        wompi,
        logger,
      }),
      "VALIDATION_ERROR",
    );
    await expectCode(
      handlePaymentHint({
        reference: "not-a-reference",
        email: "buyer@example.com",
        rawBody: { transactionId: TRANSACTION_ID },
        gateway,
        wompi,
        logger,
      }),
      "VALIDATION_ERROR",
    );
    expect(resolvePaymentForBuyer).not.toHaveBeenCalled();
  });
});
