import { describe, expect, it, vi } from "vitest";
import { handlePaymentHint, type PaymentHintGateway } from "@shared/api/payment-hint-handler.ts";
import { EpaycoApiError, type EpaycoClient } from "@shared/integrations/epayco/client.ts";
import type { WompiClient } from "@shared/integrations/wompi/client.ts";
import type { BuyerPaymentLookup, ConfirmPaymentResult } from "@shared/db/payments.ts";
import { computeEpaycoSignature } from "@shared/integrations/epayco/signature.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const ORDER_REF = "EVT-2026-000001";
const REF_PAYCO = "998877";
const BUYER_EMAIL = "buyer@example.com";
const MERCHANT = { custIdCliente: "123456", pKey: "pkey_test_value" };

function lookup(
  overrides: Partial<Extract<BuyerPaymentLookup, { found: true }>> = {},
): Extract<BuyerPaymentLookup, { found: true }> {
  return {
    found: true,
    paymentId: "22222222-2222-4222-8222-222222222222",
    paymentAttempt: 1,
    paymentStatus: "pending",
    paymentProvider: "epayco",
    providerReference: ORDER_REF,
    providerTransactionId: null,
    wompiReference: ORDER_REF,
    wompiTransactionId: null,
    amountCents: 9_500_000,
    currency: "COP",
    orderId: "33333333-3333-4333-8333-333333333333",
    orderReference: ORDER_REF,
    orderStatus: "PENDING",
    orderTotalInCents: 9_500_000,
    orderCurrency: "COP",
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
    paymentProvider: "epayco",
    providerReference: ORDER_REF,
    providerTransactionId: REF_PAYCO,
    rawWompiStatus: "1",
    paymentAttempt: 1,
    wompiReference: ORDER_REF,
    wompiTransactionId: REF_PAYCO,
    amountInCents: 9_500_000,
    currency: "COP",
    ticketsIssued: 1,
    ticketsExpected: 1,
    reconciliationRequired: false,
    ...overrides,
  };
}

describe("ePayco payment hint", () => {
  it("confirms an approved ePayco payment from client hint", async () => {
    const resolvePaymentForBuyer = vi.fn().mockResolvedValue(lookup());
    const confirmPayment = vi.fn().mockResolvedValue(confirmation());
    const queueTicketEmails = vi.fn().mockResolvedValue({ queued: 1 });

    const gateway: PaymentHintGateway = {
      resolvePaymentForBuyer,
      confirmPayment,
      queueTicketEmails,
    };

    const epaycoClient = {
      getTransaction: vi.fn().mockResolvedValue({
        id: REF_PAYCO,
        transactionId: "tx-bank-123",
        reference: ORDER_REF,
        invoice: ORDER_REF,
        amountText: "95000",
        status: "approved",
        rawStatus: "1",
        amountInCents: 9_500_000,
        currency: "COP",
        custIdCliente: MERCHANT.custIdCliente,
        responseRefPayco: REF_PAYCO,
        signature: "",
        paymentMethodType: "VISA",
        statusMessage: "Aprobada",
        rawResponse: { x_ref_payco: REF_PAYCO },
      }),
    } as unknown as EpaycoClient;

    const dummyWompiClient = {} as unknown as WompiClient;

    const response = await handlePaymentHint({
      reference: ORDER_REF,
      email: BUYER_EMAIL,
      rawBody: { transactionId: REF_PAYCO },
      gateway,
      epayco: epaycoClient,
      wompi: dummyWompiClient,
      provider: "epayco",
      epaycoCredentials: MERCHANT,
      logger,
    });

    expect(response.orderReference).toBe(ORDER_REF);
    expect(response.orderStatus).toBe("PAID");
    expect(response.paymentStatus).toBe("approved");
    expect(response.outcome).toBe("APPROVED_APPLIED");

    expect(epaycoClient.getTransaction).toHaveBeenCalledWith(REF_PAYCO);
    expect(gateway.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderReference: ORDER_REF,
        wompiTransactionId: REF_PAYCO,
        wompiStatus: "1",
        amountCents: 9_500_000,
        currency: "COP",
        provider: "epayco",
      }),
    );
    expect(gateway.queueTicketEmails).not.toHaveBeenCalled();
  });

  it("handles transaction not found (404 from ePayco)", async () => {
    const resolvePaymentForBuyer = vi.fn().mockResolvedValue(lookup());
    const confirmPayment = vi.fn();
    const queueTicketEmails = vi.fn();

    const gateway: PaymentHintGateway = {
      resolvePaymentForBuyer,
      confirmPayment,
      queueTicketEmails,
    };

    const epaycoClient = {
      getTransaction: vi
        .fn()
        .mockRejectedValue(new EpaycoApiError("Not found", { httpStatus: 404 })),
    } as unknown as EpaycoClient;

    const dummyWompiClient = {} as unknown as WompiClient;

    const response = await handlePaymentHint({
      reference: ORDER_REF,
      email: BUYER_EMAIL,
      rawBody: { transactionId: "unknown_id" },
      gateway,
      epayco: epaycoClient,
      wompi: dummyWompiClient,
      provider: "epayco",
      epaycoCredentials: MERCHANT,
      logger,
    });

    expect(response.outcome).toBe("TRANSACTION_NOT_FOUND");
    expect(gateway.confirmPayment).not.toHaveBeenCalled();
  });

  it("refuses mismatch when ePayco transaction belongs to another order", async () => {
    const resolvePaymentForBuyer = vi.fn().mockResolvedValue(lookup());
    const confirmPayment = vi.fn();
    const queueTicketEmails = vi.fn();

    const gateway: PaymentHintGateway = {
      resolvePaymentForBuyer,
      confirmPayment,
      queueTicketEmails,
    };

    const epaycoClient = {
      getTransaction: vi.fn().mockResolvedValue({
        id: REF_PAYCO,
        transactionId: "tx-bank-123",
        reference: "EVT-2026-999999", // Different order reference!
        invoice: "EVT-2026-999999",
        amountText: "95000",
        status: "approved",
        rawStatus: "1",
        amountInCents: 9_500_000,
        currency: "COP",
        custIdCliente: MERCHANT.custIdCliente,
        responseRefPayco: REF_PAYCO,
        signature: "",
      }),
    } as unknown as EpaycoClient;

    const dummyWompiClient = {} as unknown as WompiClient;

    const response = await handlePaymentHint({
      reference: ORDER_REF,
      email: BUYER_EMAIL,
      rawBody: { transactionId: REF_PAYCO },
      gateway,
      epayco: epaycoClient,
      wompi: dummyWompiClient,
      provider: "epayco",
      epaycoCredentials: MERCHANT,
      logger,
    });

    expect(response.outcome).toBe("MISMATCH");
    expect(gateway.confirmPayment).not.toHaveBeenCalled();
  });

  describe("sandbox transactions", () => {
    function hintWith(epaycoTest: boolean | undefined) {
      const gateway: PaymentHintGateway = {
        resolvePaymentForBuyer: vi.fn().mockResolvedValue(lookup()),
        confirmPayment: vi.fn().mockResolvedValue(confirmation()),
        queueTicketEmails: vi.fn().mockResolvedValue({ queued: 1 }),
      };
      const epaycoClient = {
        getTransaction: vi.fn().mockResolvedValue({
          id: REF_PAYCO,
          transactionId: "tx-bank-123",
          reference: ORDER_REF,
          invoice: ORDER_REF,
          amountText: "95000",
          status: "approved",
          rawStatus: "1",
          amountInCents: 9_500_000,
          currency: "COP",
          custIdCliente: MERCHANT.custIdCliente,
          responseRefPayco: REF_PAYCO,
          signature: "",
          isTest: true,
          rawResponse: { x_ref_payco: REF_PAYCO, x_test_request: "TRUE" },
        }),
      } as unknown as EpaycoClient;
      const run = () =>
        handlePaymentHint({
          reference: ORDER_REF,
          email: BUYER_EMAIL,
          rawBody: { transactionId: REF_PAYCO },
          gateway,
          epayco: epaycoClient,
          wompi: {} as unknown as WompiClient,
          provider: "epayco",
          epaycoCredentials: MERCHANT,
          epaycoTest,
          logger,
        });
      return { gateway, run };
    }

    it("refuses a sandbox transaction while the backend runs live", async () => {
      const { gateway, run } = hintWith(false);
      const response = await run();
      expect(response.outcome).toBe("MISMATCH");
      expect(response.orderStatus).toBe("PENDING");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
      expect(gateway.queueTicketEmails).not.toHaveBeenCalled();
    });

    it("treats a missing test-mode flag as live mode", async () => {
      const { gateway, run } = hintWith(undefined);
      expect((await run()).outcome).toBe("MISMATCH");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("accepts a sandbox transaction while the backend runs in test mode", async () => {
      const { gateway, run } = hintWith(true);
      const response = await run();
      expect(response.outcome).toBe("APPROVED_APPLIED");
      expect(gateway.confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({ wompiTransactionId: REF_PAYCO, provider: "epayco" }),
      );
    });
  });

  describe("merchant verification (C1b)", () => {
    const approvedRecord = {
      id: REF_PAYCO,
      transactionId: "tx-bank-123",
      reference: ORDER_REF,
      invoice: ORDER_REF,
      status: "approved",
      rawStatus: "1",
      amountText: "95000",
      amountInCents: 9_500_000,
      currency: "COP",
      responseRefPayco: REF_PAYCO,
      custIdCliente: null as string | null,
      signature: "",
      isTest: false,
    };

    async function hint(
      record: Record<string, unknown>,
      credentials: typeof MERCHANT | null = MERCHANT,
    ) {
      const gateway: PaymentHintGateway = {
        resolvePaymentForBuyer: vi.fn().mockResolvedValue(lookup()),
        confirmPayment: vi.fn().mockResolvedValue(confirmation()),
        queueTicketEmails: vi.fn().mockResolvedValue({ queued: 1 }),
      };
      const response = await handlePaymentHint({
        reference: ORDER_REF,
        email: BUYER_EMAIL,
        rawBody: { transactionId: REF_PAYCO },
        gateway,
        epayco: { getTransaction: vi.fn().mockResolvedValue(record) },
        wompi: {} as unknown as WompiClient,
        provider: "epayco",
        epaycoTest: false,
        epaycoCredentials: credentials ?? undefined,
        logger,
      });
      return { response, gateway };
    }

    it("refuses a transaction from another merchant that names our order", async () => {
      const { response, gateway } = await hint({ ...approvedRecord, custIdCliente: "999999" });
      expect(response.outcome).toBe("MISMATCH");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("refuses a record that cannot prove its merchant", async () => {
      const { response, gateway } = await hint({ ...approvedRecord, custIdCliente: null });
      expect(response.outcome).toBe("MISMATCH");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("refuses when no merchant credentials are configured", async () => {
      const { response, gateway } = await hint(
        { ...approvedRecord, custIdCliente: MERCHANT.custIdCliente },
        null,
      );
      expect(response.outcome).toBe("MISMATCH");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("accepts a record whose signature recomputes with our merchant keys", async () => {
      const signature = await computeEpaycoSignature({
        custIdCliente: MERCHANT.custIdCliente,
        pKey: MERCHANT.pKey,
        refPayco: REF_PAYCO,
        transactionId: approvedRecord.transactionId,
        amount: approvedRecord.amountText,
        currency: approvedRecord.currency,
      });
      const { response, gateway } = await hint({ ...approvedRecord, signature });
      expect(response.outcome).toBe("APPROVED_APPLIED");
      expect(gateway.confirmPayment).toHaveBeenCalled();
    });

    it("refuses a record that answers for a different ref_payco", async () => {
      const { response, gateway } = await hint({
        ...approvedRecord,
        custIdCliente: MERCHANT.custIdCliente,
        responseRefPayco: "111111",
      });
      expect(response.outcome).toBe("MISMATCH");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });
  });

  describe("provider attribution (H15)", () => {
    it("never sends an ePayco attempt to Wompi when no ePayco client is available", async () => {
      const wompi = { getTransaction: vi.fn() } as unknown as WompiClient;
      const gateway: PaymentHintGateway = {
        resolvePaymentForBuyer: vi.fn().mockResolvedValue(lookup()),
        confirmPayment: vi.fn(),
        queueTicketEmails: vi.fn(),
      };
      await expect(
        handlePaymentHint({
          reference: ORDER_REF,
          email: BUYER_EMAIL,
          rawBody: { transactionId: REF_PAYCO },
          gateway,
          wompi,
          provider: "epayco",
          logger,
        }),
      ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(wompi.getTransaction).not.toHaveBeenCalled();
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("confirms a Wompi attempt as Wompi", async () => {
      const wompi = {
        getTransaction: vi.fn().mockResolvedValue({
          id: "1292-1602113476-10985",
          reference: ORDER_REF,
          status: "APPROVED",
          amountInCents: 9_500_000,
          currency: "COP",
          customerEmail: undefined,
          paymentMethodType: "CARD",
          statusMessage: undefined,
          createdAt: undefined,
          finalizedAt: undefined,
        }),
      } as unknown as WompiClient;
      const gateway: PaymentHintGateway = {
        resolvePaymentForBuyer: vi.fn().mockResolvedValue(lookup({ paymentProvider: "wompi" })),
        confirmPayment: vi.fn().mockResolvedValue(confirmation({ paymentProvider: "wompi" })),
        queueTicketEmails: vi.fn().mockResolvedValue({ queued: 1 }),
      };
      await handlePaymentHint({
        reference: ORDER_REF,
        email: BUYER_EMAIL,
        rawBody: { transactionId: "1292-1602113476-10985" },
        gateway,
        wompi,
        provider: "wompi",
        logger,
      });
      expect(gateway.confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "wompi" }),
      );
    });
  });
});
