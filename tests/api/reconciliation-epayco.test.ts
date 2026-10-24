/**
 * H4: provider-aware reconciliation.
 *
 * Each claimed attempt is swept by its OWN provider: ePayco attempts are re-read from ePayco's
 * validation API (verified with `verifyEpaycoRecord`) and Wompi attempts from Wompi; neither is
 * ever sent to the other, and an attempt with no provider is queried nowhere. Both go through
 * the same `confirm_payment` transaction.
 */

import { describe, expect, it, vi } from "vitest";

import {
  runReconciliationSweep,
  type EpaycoReconciliationDeps,
  type ReconciliationGateway,
} from "@shared/api/reconciliation-handler.ts";
import { EpaycoApiError, type EpaycoClient } from "@shared/integrations/epayco/client.ts";
import type { EpaycoTransactionData } from "@shared/integrations/epayco/types.ts";
import { WompiApiError, type WompiClient } from "@shared/integrations/wompi/client.ts";
import type { AlertInput } from "@shared/domain/alerts.ts";
import type { ClaimedReconciliation, ConfirmPaymentResult } from "@shared/db/payments.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const NOW = new Date("2026-10-23T12:00:00.000Z");
const ORDER_REF = "EVT-2026-000007";
const REF_PAYCO = "987654321";
const MERCHANT = { custIdCliente: "123456", pKey: "pkey_test_value" };

function claimedEpayco(overrides: Partial<ClaimedReconciliation> = {}): ClaimedReconciliation {
  return {
    paymentId: "22222222-2222-4222-8222-222222222222",
    orderId: "33333333-3333-4333-8333-333333333333",
    paymentAttempt: 1,
    paymentProvider: "epayco",
    providerTransactionId: REF_PAYCO,
    wompiReference: ORDER_REF,
    wompiTransactionId: REF_PAYCO,
    paymentStatus: "pending",
    amountCents: 1_000_000,
    currency: "COP",
    reconciliationAttempts: 1,
    orderReference: ORDER_REF,
    orderStatus: "PENDING",
    orderTotalInCents: 1_000_000,
    orderCurrency: "COP",
    ...overrides,
  };
}

function record(overrides: Partial<EpaycoTransactionData> = {}): EpaycoTransactionData {
  return {
    id: REF_PAYCO,
    refPayco: REF_PAYCO,
    responseRefPayco: REF_PAYCO,
    amountText: "10000",
    custIdCliente: null,
    reference: ORDER_REF,
    invoice: ORDER_REF,
    transactionId: "tx-1",
    status: "approved",
    rawStatus: "1",
    amount: 10_000,
    amountInCents: 1_000_000,
    currency: "COP",
    responseCode: 1,
    responseText: "Aceptada",
    statusMessage: "Aprobada",
    paymentMethodType: "PSE",
    signature: "",
    isTest: true,
    franchise: "PSE",
    bankName: null,
    transactionDate: null,
    rawPayload: { x_ref_payco: REF_PAYCO, x_cod_response: "1", x_amount: "10000" },
    ...overrides,
  };
}

function confirmation(overrides: Partial<ConfirmPaymentResult> = {}): ConfirmPaymentResult {
  return {
    result: "APPLIED",
    reason: "PAYMENT_APPROVED",
    orderId: "33333333-3333-4333-8333-333333333333",
    orderReference: ORDER_REF,
    orderStatus: "PAID",
    paymentId: "22222222-2222-4222-8222-222222222222",
    paymentStatus: "approved",
    rawWompiStatus: "1",
    paymentAttempt: 1,
    wompiReference: ORDER_REF,
    wompiTransactionId: REF_PAYCO,
    amountInCents: 1_000_000,
    currency: "COP",
    ticketsIssued: 1,
    ticketsExpected: 1,
    reconciliationRequired: false,
    ...overrides,
  };
}

function setup(options: {
  readonly rows: readonly ClaimedReconciliation[];
  readonly record?: EpaycoTransactionData | Error;
  readonly confirmation?: ConfirmPaymentResult | Error;
  readonly epayco?: "none";
  readonly testMode?: boolean;
}) {
  const finish = vi.fn().mockImplementation(async (input: { paymentId: string }) => ({
    paymentId: input.paymentId,
    result: "x",
    failure: null,
    reconciliationAttempts: 1,
    nextReconciliationAt: null,
  }));
  const payments: ReconciliationGateway = {
    claimPaymentReconciliations: vi.fn().mockResolvedValue(options.rows),
    finishPaymentReconciliation: finish,
    confirmPayment:
      options.confirmation instanceof Error
        ? vi.fn().mockRejectedValue(options.confirmation)
        : vi.fn().mockResolvedValue(options.confirmation ?? confirmation()),
    queueTicketEmails: vi.fn().mockResolvedValue({
      queued: 1,
      alreadyQueued: 0,
      total: 1,
      template: "TICKET_CONFIRMATION",
    }),
  };
  const epaycoClient: EpaycoClient = {
    getTransaction:
      options.record instanceof Error
        ? vi.fn().mockRejectedValue(options.record)
        : vi.fn().mockResolvedValue(options.record ?? record()),
  };
  const wompi: WompiClient = { getTransaction: vi.fn() };
  const epayco: EpaycoReconciliationDeps | undefined =
    options.epayco === "none"
      ? undefined
      : { client: epaycoClient, credentials: MERCHANT, testMode: options.testMode ?? true };

  const run = () => runReconciliationSweep({ payments, wompi, epayco, logger, now: () => NOW });
  return { run, payments, finish, epaycoClient, wompi };
}

describe("ePayco reconciliation (H4)", () => {
  it("recovers an approved payment through confirm_payment with the record's data", async () => {
    const env = setup({ rows: [claimedEpayco()] });
    const summary = await env.run();

    expect(env.epaycoClient.getTransaction).toHaveBeenCalledWith(REF_PAYCO);
    expect(env.wompi.getTransaction).not.toHaveBeenCalled();
    expect(env.payments.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderReference: ORDER_REF,
        wompiReference: ORDER_REF,
        wompiTransactionId: REF_PAYCO,
        wompiStatus: "1",
        amountCents: 1_000_000,
        currency: "COP",
        provider: "epayco",
        providerPayload: { x_ref_payco: REF_PAYCO, x_cod_response: "1", x_amount: "10000" },
      }),
    );
    // Tickets are discontinued: a recovered approval queues no ticket email.
    expect(env.payments.queueTicketEmails).not.toHaveBeenCalled();
    expect(env.finish).toHaveBeenCalledWith({
      paymentId: "22222222-2222-4222-8222-222222222222",
      result: "APPROVED_APPLIED",
    });
    expect(summary.confirmedApproved).toBe(1);
    expect(summary.emailsQueued).toBe(0);
  });

  it("reports an approval already applied by the webhook as a duplicate, with no new tickets", async () => {
    const env = setup({
      rows: [claimedEpayco()],
      confirmation: confirmation({ result: "DUPLICATE", ticketsIssued: 0 }),
    });
    const summary = await env.run();

    expect(summary.byResult).toEqual({ APPROVED_DUPLICATE: 1 });
    expect(env.finish).toHaveBeenCalledWith(
      expect.objectContaining({ result: "APPROVED_DUPLICATE" }),
    );
  });

  it.each([
    ["pending", "3", "STILL_PENDING", "PENDING"],
    ["declined", "2", "DECLINED", "FAILED"],
    ["error", "4", "ERROR", "FAILED"],
  ] as const)(
    "applies a %s record without issuing tickets",
    async (status, rawStatus, expected, orderStatus) => {
      const env = setup({
        rows: [claimedEpayco()],
        record: record({ status, rawStatus }),
        confirmation: confirmation({
          orderStatus,
          paymentStatus: status,
          ticketsIssued: 0,
          ticketsExpected: 0,
        }),
      });
      const summary = await env.run();

      expect(env.payments.confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({ wompiStatus: rawStatus }),
      );
      expect(env.payments.queueTicketEmails).not.toHaveBeenCalled();
      expect(summary.byResult).toEqual({ [expected]: 1 });
      expect(summary.confirmedApproved).toBe(0);
    },
  );

  it("surfaces a late approval for an expired order for an operator", async () => {
    const env = setup({
      rows: [claimedEpayco({ orderStatus: "EXPIRED" })],
      confirmation: confirmation({
        result: "RECONCILIATION_REQUIRED",
        orderStatus: "EXPIRED",
        ticketsIssued: 0,
        ticketsExpected: 0,
        reconciliationRequired: true,
      }),
    });
    const summary = await env.run();

    expect(summary.byResult).toEqual({ RECONCILIATION_REQUIRED: 1 });
    expect(summary.reviewRequired).toEqual([ORDER_REF]);
  });

  it.each([
    ["another order's invoice", { invoice: "EVT-2026-999999", reference: "EVT-2026-999999" }],
    ["a different amount", { amountText: "1000", amount: 1000, amountInCents: 100_000 }],
    ["a different currency", { currency: "USD" }],
    ["no currency", { currency: "" }],
    ["no invoice", { invoice: "", reference: "" }],
    ["a different ref_payco", { responseRefPayco: "111111" }],
    ["another merchant", { custIdCliente: "999999" }],
  ] satisfies [string, Partial<EpaycoTransactionData>][])(
    "never confirms a record with %s",
    async (_label, override) => {
      const env = setup({ rows: [claimedEpayco()], record: record(override) });
      const summary = await env.run();

      expect(env.payments.confirmPayment).not.toHaveBeenCalled();
      expect(summary.byResult).toEqual({ MISMATCH: 1 });
      expect(summary.reviewRequired).toEqual([ORDER_REF]);
      expect(env.finish).toHaveBeenCalledWith(
        expect.objectContaining({ result: "MISMATCH", failure: "VALIDATION_MISMATCH" }),
      );
    },
  );

  it("never confirms a sandbox record while the backend runs live", async () => {
    const env = setup({
      rows: [claimedEpayco()],
      record: record({ isTest: true }),
      testMode: false,
    });
    const summary = await env.run();

    expect(env.payments.confirmPayment).not.toHaveBeenCalled();
    expect(summary.byResult).toEqual({ MISMATCH: 1 });
  });

  it.each([
    ["a provider outage", new EpaycoApiError("ePayco returned HTTP 503", { httpStatus: 503 })],
    ["a record not yet visible", new EpaycoApiError("not found", { httpStatus: 404 })],
    ["a malformed response", new EpaycoApiError("ePayco returned invalid JSON")],
    ["a network timeout", new DOMException("aborted", "AbortError")],
  ])("keeps the attempt eligible for retry on %s", async (_label, failure) => {
    const env = setup({ rows: [claimedEpayco()], record: failure });
    const summary = await env.run();

    expect(env.payments.confirmPayment).not.toHaveBeenCalled();
    expect(summary.byResult).toEqual({ UPSTREAM_ERROR: 1 });
    expect(env.finish).toHaveBeenCalledWith({
      paymentId: "22222222-2222-4222-8222-222222222222",
      result: "UPSTREAM_ERROR",
      failure: "UPSTREAM_ERROR",
      nextAttemptAt: "2026-10-23T12:02:00.000Z",
    });
  });

  it("retries a transient database failure while applying an approved record", async () => {
    const env = setup({
      rows: [claimedEpayco()],
      confirmation: new Error("Connection terminated unexpectedly"),
    });
    const summary = await env.run();

    expect(summary.byResult).toEqual({ UPSTREAM_ERROR: 1 });
    expect(summary.confirmedApproved).toBe(0);
    expect(env.finish).toHaveBeenCalledWith(
      expect.objectContaining({ result: "UPSTREAM_ERROR", failure: "CONFIRMATION_FAILED" }),
    );
  });

  it("applies the approval on the next sweep after a transient failure", async () => {
    const first = setup({ rows: [claimedEpayco()], record: new EpaycoApiError("HTTP 502") });
    expect((await first.run()).byResult).toEqual({ UPSTREAM_ERROR: 1 });

    const second = setup({ rows: [claimedEpayco({ reconciliationAttempts: 2 })] });
    const summary = await second.run();
    expect(summary.byResult).toEqual({ APPROVED_APPLIED: 1 });
    expect(second.payments.confirmPayment).toHaveBeenCalledTimes(1);
  });

  describe("provider isolation", () => {
    it("never sends an ePayco attempt to Wompi, even without an ePayco client", async () => {
      const env = setup({ rows: [claimedEpayco()], epayco: "none" });
      const summary = await env.run();

      expect(env.wompi.getTransaction).not.toHaveBeenCalled();
      expect(env.payments.confirmPayment).not.toHaveBeenCalled();
      expect(summary.byResult).toEqual({ UPSTREAM_ERROR: 1 });
      expect(env.finish).toHaveBeenCalledWith(
        expect.objectContaining({ failure: "PROVIDER_CLIENT_UNAVAILABLE" }),
      );
    });

    it("never sends a Wompi attempt to ePayco", async () => {
      const env = setup({
        rows: [
          claimedEpayco({ paymentProvider: "wompi", wompiTransactionId: "1292-1602113476-1" }),
        ],
      });
      vi.mocked(env.wompi.getTransaction).mockRejectedValue(new Error("network"));
      await env.run();

      expect(env.wompi.getTransaction).toHaveBeenCalledWith("1292-1602113476-1");
      expect(env.epaycoClient.getTransaction).not.toHaveBeenCalled();
    });

    it("queries nobody for an attempt whose provider is unknown", async () => {
      const env = setup({ rows: [claimedEpayco({ paymentProvider: undefined })] });
      const summary = await env.run();

      expect(env.wompi.getTransaction).not.toHaveBeenCalled();
      expect(env.epaycoClient.getTransaction).not.toHaveBeenCalled();
      expect(env.payments.confirmPayment).not.toHaveBeenCalled();
      expect(summary.byResult).toEqual({ UPSTREAM_ERROR: 1 });
      expect(env.finish).toHaveBeenCalledWith(
        expect.objectContaining({ failure: "PROVIDER_UNKNOWN" }),
      );
    });

    it("routes a mixed batch to each attempt's own provider", async () => {
      const wompiRow = claimedEpayco({
        paymentId: "44444444-4444-4444-8444-444444444444",
        paymentProvider: "wompi",
        wompiTransactionId: "1292-1602113476-2",
      });
      const env = setup({ rows: [wompiRow, claimedEpayco()] });
      vi.mocked(env.wompi.getTransaction).mockRejectedValue(new Error("network"));
      await env.run();

      expect(env.wompi.getTransaction).toHaveBeenCalledTimes(1);
      expect(env.wompi.getTransaction).toHaveBeenCalledWith("1292-1602113476-2");
      expect(env.epaycoClient.getTransaction).toHaveBeenCalledTimes(1);
      expect(env.epaycoClient.getTransaction).toHaveBeenCalledWith(REF_PAYCO);
    });
  });

  describe("ePayco states 6-11 (H7)", () => {
    it.each([
      ["7", "pending", "STILL_PENDING"],
      ["8", "pending", "STILL_PENDING"],
      ["9", "declined", "DECLINED"],
      ["10", "declined", "DECLINED"],
      ["11", "declined", "DECLINED"],
      ["6", "voided", "VOIDED"],
    ] as const)(
      "reconciles code %s (%s) without tickets as %s",
      async (rawStatus, status, expected) => {
        const env = setup({
          rows: [claimedEpayco()],
          record: record({ status, rawStatus }),
          confirmation: confirmation({
            orderStatus: status === "pending" ? "PENDING" : "FAILED",
            paymentStatus: status,
            ticketsIssued: 0,
            ticketsExpected: 0,
          }),
        });
        const summary = await env.run();

        expect(env.payments.confirmPayment).toHaveBeenCalledWith(
          expect.objectContaining({ wompiStatus: rawStatus }),
        );
        expect(env.payments.queueTicketEmails).not.toHaveBeenCalled();
        expect(summary.byResult).toEqual({ [expected]: 1 });
        expect(summary.confirmedApproved).toBe(0);
      },
    );

    it("gives the same answer on a repeated sweep of an expired transaction", async () => {
      const outcomes = [];
      for (const result of ["APPLIED", "DUPLICATE"] as const) {
        const env = setup({
          rows: [claimedEpayco()],
          record: record({ status: "declined", rawStatus: "9" }),
          confirmation: confirmation({
            result,
            orderStatus: "FAILED",
            paymentStatus: "declined",
            ticketsIssued: 0,
            ticketsExpected: 0,
          }),
        });
        outcomes.push((await env.run()).byResult);
      }
      expect(outcomes).toEqual([{ DECLINED: 1 }, { DECLINED: 1 }]);
    });
  });

  describe("operational alerts (H8)", () => {
    async function sweepWithAlerts(
      env: ReturnType<typeof setup>,
      sink: (alert: AlertInput) => Promise<void> = vi.fn().mockResolvedValue(undefined),
    ) {
      const summary = await runReconciliationSweep({
        payments: env.payments,
        wompi: env.wompi,
        epayco: { client: env.epaycoClient, credentials: MERCHANT, testMode: true },
        alerts: sink,
        logger,
        now: () => NOW,
      });
      return { summary, sink };
    }

    it("raises a mismatch alert keyed on the payment", async () => {
      const env = setup({ rows: [claimedEpayco()], record: record({ currency: "USD" }) });
      const { sink } = await sweepWithAlerts(env);
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "RECONCILIATION_MISMATCH",
          dedupeKey: `recon-mismatch:${claimedEpayco().paymentId}`,
          orderReference: ORDER_REF,
          provider: "epayco",
        }),
      );
    });

    it("raises a not-found alert when Wompi does not know a recorded transaction", async () => {
      const env = setup({
        rows: [
          claimedEpayco({ paymentProvider: "wompi", wompiTransactionId: "1292-1602113476-9" }),
        ],
      });
      vi.mocked(env.wompi.getTransaction).mockRejectedValue(
        new WompiApiError("not found", { httpStatus: 404 }),
      );
      const { summary, sink } = await sweepWithAlerts(env);
      expect(summary.byResult).toEqual({ NOT_FOUND_AT_PROVIDER: 1 });
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "PROVIDER_NOT_FOUND", provider: "wompi" }),
      );
    });

    it("raises a repeated-failure alert only from the third failed attempt", async () => {
      const failing = new EpaycoApiError("ePayco returned HTTP 503", { httpStatus: 503 });
      const second = await sweepWithAlerts(
        setup({ rows: [claimedEpayco({ reconciliationAttempts: 2 })], record: failing }),
      );
      expect(second.sink).not.toHaveBeenCalled();

      const third = await sweepWithAlerts(
        setup({ rows: [claimedEpayco({ reconciliationAttempts: 3 })], record: failing }),
      );
      expect(third.summary.byResult).toEqual({ UPSTREAM_ERROR: 1 });
      expect(third.sink).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "REPEATED_PROVIDER_FAILURE",
          dedupeKey: `failing:${claimedEpayco().paymentId}`,
        }),
      );
    });

    it("raises nothing for a recovered approval, a pending or a declined payment", async () => {
      for (const env of [
        setup({ rows: [claimedEpayco()] }),
        setup({ rows: [claimedEpayco()], record: record({ status: "pending", rawStatus: "3" }) }),
        setup({ rows: [claimedEpayco()], record: record({ status: "declined", rawStatus: "2" }) }),
      ]) {
        const { sink } = await sweepWithAlerts(env);
        expect(sink).not.toHaveBeenCalled();
      }
    });

    it("keeps a retryable failure retryable when the alert itself fails", async () => {
      const env = setup({
        rows: [claimedEpayco({ reconciliationAttempts: 4 })],
        record: new EpaycoApiError("HTTP 502", { httpStatus: 502 }),
      });
      const { summary } = await sweepWithAlerts(env, vi.fn().mockRejectedValue(new Error("boom")));
      // A throwing sink is a programming error the sweep contains per row; the attempt keeps
      // its retry schedule.
      expect(summary.byResult).toEqual({ UPSTREAM_ERROR: 1 });
      expect(env.finish).toHaveBeenCalledWith(
        expect.objectContaining({
          result: "UPSTREAM_ERROR",
          nextAttemptAt: "2026-10-23T12:02:00.000Z",
        }),
      );
    });
  });
});
