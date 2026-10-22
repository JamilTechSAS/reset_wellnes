import { describe, expect, it, vi } from "vitest";

import {
  runReconciliationSweep,
  type ReconciliationGateway,
} from "@shared/api/reconciliation-handler.ts";
import { RECONCILIATION_DEFAULTS } from "@shared/domain/reconciliation.ts";
import { WompiApiError, type WompiClient } from "@shared/integrations/wompi/client.ts";
import type { WompiTransaction } from "@shared/integrations/wompi/types.ts";
import type { ClaimedReconciliation, ConfirmPaymentResult } from "@shared/db/payments.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const NOW = new Date("2026-10-03T12:00:00.000Z");

function claimed(overrides: Partial<ClaimedReconciliation> = {}): ClaimedReconciliation {
  return {
    paymentId: "22222222-2222-4222-8222-222222222222",
    orderId: "33333333-3333-4333-8333-333333333333",
    paymentAttempt: 1,
    wompiReference: "EVT-2026-000001",
    wompiTransactionId: "1292-1602113476-10985",
    paymentStatus: "pending",
    amountCents: 9_500_000,
    currency: "COP",
    reconciliationAttempts: 1,
    orderReference: "EVT-2026-000001",
    orderStatus: "PENDING",
    orderTotalInCents: 9_500_000,
    orderCurrency: "COP",
    ...overrides,
  };
}

function transaction(overrides: Partial<WompiTransaction> = {}): WompiTransaction {
  return {
    id: "1292-1602113476-10985",
    reference: "EVT-2026-000001",
    status: "APPROVED",
    amountInCents: 9_500_000,
    currency: "COP",
    customerEmail: undefined,
    paymentMethodType: "CARD",
    statusMessage: "Aprobada",
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
    orderReference: "EVT-2026-000001",
    orderStatus: "PAID",
    paymentId: "22222222-2222-4222-8222-222222222222",
    paymentStatus: "approved",
    rawWompiStatus: "APPROVED",
    paymentAttempt: 1,
    wompiReference: "EVT-2026-000001",
    wompiTransactionId: "1292-1602113476-10985",
    amountInCents: 9_500_000,
    currency: "COP",
    ticketsIssued: 1,
    ticketsExpected: 1,
    reconciliationRequired: false,
    ...overrides,
  };
}

function setup(options: {
  readonly rows?: readonly ClaimedReconciliation[];
  readonly transaction?: WompiTransaction | Error;
  readonly confirmation?: ConfirmPaymentResult | Error;
}) {
  const claim = vi.fn().mockResolvedValue(options.rows ?? [claimed()]);
  const finish = vi.fn().mockImplementation(async (input: { paymentId: string }) => ({
    paymentId: input.paymentId,
    result: "x",
    failure: null,
    reconciliationAttempts: 1,
    nextReconciliationAt: null,
  }));
  const confirmPayment =
    options.confirmation instanceof Error
      ? vi.fn().mockRejectedValue(options.confirmation)
      : vi.fn().mockResolvedValue(options.confirmation ?? confirmation());
  const queueTicketEmails = vi
    .fn()
    .mockResolvedValue({ queued: 1, alreadyQueued: 0, total: 1, template: "TICKET_CONFIRMATION" });

  const payments: ReconciliationGateway = {
    claimPaymentReconciliations: claim,
    finishPaymentReconciliation: finish,
    confirmPayment,
    queueTicketEmails,
  };
  const getTransaction =
    options.transaction instanceof Error
      ? vi.fn().mockRejectedValue(options.transaction)
      : vi.fn().mockResolvedValue(options.transaction ?? transaction());
  const wompi: WompiClient = { getTransaction };

  return { payments, wompi, claim, finish, confirmPayment, queueTicketEmails, getTransaction };
}

describe("reconciliation sweep", () => {
  it("asks the claim for one bounded batch with the documented attempt budget", async () => {
    const { payments, wompi, claim } = setup({ rows: [] });
    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(claim).toHaveBeenCalledWith(
      RECONCILIATION_DEFAULTS.batchSize,
      RECONCILIATION_DEFAULTS.maxAttempts,
    );
    expect(summary).toEqual({
      claimed: 0,
      byResult: {},
      confirmedApproved: 0,
      reviewRequired: [],
      emailsQueued: 0,
    });
  });

  it("recovers an approved payment through the SAME confirmation transaction as the webhook", async () => {
    const { payments, wompi, confirmPayment, finish, queueTicketEmails } = setup({});
    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });

    expect(confirmPayment).toHaveBeenCalledTimes(1);
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderReference: "EVT-2026-000001",
        wompiReference: "EVT-2026-000001",
        wompiTransactionId: "1292-1602113476-10985",
        wompiStatus: "APPROVED",
        amountCents: 9_500_000,
        currency: "COP",
      }),
    );
    expect(queueTicketEmails).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
    expect(finish).toHaveBeenCalledWith({
      paymentId: claimed().paymentId,
      result: "APPROVED_APPLIED",
    });
    expect(summary.confirmedApproved).toBe(1);
    expect(summary.emailsQueued).toBe(1);
    expect(summary.byResult.APPROVED_APPLIED).toBe(1);
  });

  it("reports a replayed approval as APPROVED_DUPLICATE", async () => {
    const { payments, wompi, finish } = setup({
      confirmation: confirmation({ result: "DUPLICATE", reason: "PAYMENT_APPROVED" }),
    });
    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(finish).toHaveBeenCalledWith({
      paymentId: claimed().paymentId,
      result: "APPROVED_DUPLICATE",
    });
    expect(summary.byResult.APPROVED_DUPLICATE).toBe(1);
  });

  it("keeps a still-pending transaction scheduled and confirms nothing twice", async () => {
    const { payments, wompi, finish, queueTicketEmails } = setup({
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
    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(finish).toHaveBeenCalledWith({
      paymentId: claimed().paymentId,
      result: "STILL_PENDING",
    });
    expect(queueTicketEmails).not.toHaveBeenCalled();
    expect(summary.byResult.STILL_PENDING).toBe(1);
    expect(summary.confirmedApproved).toBe(0);
  });

  it("flags a late approval for manual review instead of reviving a non-payable order", async () => {
    const { payments, wompi, finish } = setup({
      rows: [claimed({ orderStatus: "EXPIRED" })],
      confirmation: confirmation({
        result: "RECONCILIATION_REQUIRED",
        reason: "ORDER_NOT_PAYABLE_EXPIRED",
        orderStatus: "EXPIRED",
        ticketsIssued: 0,
        ticketsExpected: 0,
      }),
    });
    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(finish).toHaveBeenCalledWith({
      paymentId: claimed().paymentId,
      result: "RECONCILIATION_REQUIRED",
    });
    expect(summary.reviewRequired).toEqual(["EVT-2026-000001"]);
  });

  it("treats a transaction id Wompi no longer knows as terminal, for review", async () => {
    const { payments, wompi, confirmPayment, finish } = setup({
      transaction: new WompiApiError("Wompi returned HTTP 404", { httpStatus: 404 }),
    });
    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith({
      paymentId: claimed().paymentId,
      result: "NOT_FOUND_AT_PROVIDER",
      failure: "PROVIDER_NOT_FOUND",
    });
    expect(summary.reviewRequired).toEqual(["EVT-2026-000001"]);
  });

  it("retries an upstream failure sooner than the normal backoff", async () => {
    const { payments, wompi, finish } = setup({
      transaction: new WompiApiError("Wompi unreachable"),
    });
    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(finish).toHaveBeenCalledWith({
      paymentId: claimed().paymentId,
      result: "UPSTREAM_ERROR",
      failure: "UPSTREAM_ERROR",
      nextAttemptAt: "2026-10-03T12:02:00.000Z",
    });
    expect(summary.byResult.UPSTREAM_ERROR).toBe(1);
  });

  it("never approves a transaction that does not match our record", async () => {
    const { payments, wompi, confirmPayment, finish } = setup({
      transaction: transaction({ amountInCents: 1 }),
    });
    await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith({
      paymentId: claimed().paymentId,
      result: "MISMATCH",
      failure: "VALIDATION_MISMATCH",
    });
  });

  it("retries within the budget when the confirmation itself fails", async () => {
    const { payments, wompi, finish } = setup({
      confirmation: new Error("confirm_payment exploded"),
    });
    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(finish).toHaveBeenCalledWith({
      paymentId: claimed().paymentId,
      result: "UPSTREAM_ERROR",
      failure: "CONFIRMATION_FAILED",
      nextAttemptAt: "2026-10-03T12:02:00.000Z",
    });
    expect(summary.byResult.UPSTREAM_ERROR).toBe(1);
  });

  it("isolates one failing row so the rest of the batch still converges", async () => {
    const second = claimed({
      paymentId: "44444444-4444-4444-8444-444444444444",
      orderReference: "EVT-2026-000002",
      wompiReference: "EVT-2026-000002",
      wompiTransactionId: "1292-1602113476-10986",
    });
    const claim = vi.fn().mockResolvedValue([claimed(), second]);
    const finish = vi
      .fn()
      .mockImplementation(async (input: { paymentId: string; result: string }) => {
        if (input.paymentId === claimed().paymentId) {
          throw new Error("database write failed for the first row");
        }
        return {
          paymentId: input.paymentId,
          result: input.result,
          failure: null,
          reconciliationAttempts: 2,
          nextReconciliationAt: null,
        };
      });
    const confirmPayment = vi.fn().mockResolvedValue(confirmation());
    const queueTicketEmails = vi.fn().mockResolvedValue({
      queued: 1,
      alreadyQueued: 0,
      total: 1,
      template: "TICKET_CONFIRMATION",
    });
    const payments: ReconciliationGateway = {
      claimPaymentReconciliations: claim,
      finishPaymentReconciliation: finish,
      confirmPayment,
      queueTicketEmails,
    };
    const wompi: WompiClient = {
      // Each claimed attempt gets its own matching transaction, as Wompi would answer.
      getTransaction: vi
        .fn()
        .mockImplementation(async (id: string) =>
          id === second.wompiTransactionId
            ? transaction({ id, reference: second.wompiReference })
            : transaction(),
        ),
    };

    const summary = await runReconciliationSweep({ payments, wompi, logger, now: () => NOW });
    expect(summary.claimed).toBe(2);
    // The first row's `finish` threw before its outcome could be recorded; the sweep
    // reports it as a retryable failure and still finishes the second row.
    expect(summary.byResult.UPSTREAM_ERROR).toBe(1);
    expect(confirmPayment).toHaveBeenCalledTimes(2);
  });
});
