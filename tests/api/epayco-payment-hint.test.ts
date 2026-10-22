import { describe, expect, it, vi } from "vitest";
import { handlePaymentHint, type PaymentHintGateway } from "@shared/api/payment-hint-handler.ts";
import { EpaycoApiError, type EpaycoClient } from "@shared/integrations/epayco/client.ts";
import type { WompiClient } from "@shared/integrations/wompi/client.ts";
import type { BuyerPaymentLookup, ConfirmPaymentResult } from "@shared/db/payments.ts";
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
        status: "approved",
        rawStatus: "1",
        amountInCents: 9_500_000,
        currency: "COP",
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
    expect(gateway.queueTicketEmails).toHaveBeenCalled();
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
        status: "approved",
        rawStatus: "1",
        amountInCents: 9_500_000,
        currency: "COP",
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
      logger,
    });

    expect(response.outcome).toBe("MISMATCH");
    expect(gateway.confirmPayment).not.toHaveBeenCalled();
  });
});
