import { describe, expect, it, vi } from "vitest";
import { handleEpaycoWebhook } from "@shared/api/epayco-webhook-handler.ts";
import { computeEpaycoSignature } from "@shared/integrations/epayco/signature.ts";
import { createLogger } from "@shared/logging/logger.ts";
import type { BackendConfig } from "@shared/config/env.ts";
import type { PaymentGateway } from "@shared/db/payments.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const credentials = {
  custIdCliente: "12345",
  pKey: "secret_p_key_abc",
};

const mockConfig = {
  paymentProvider: "epayco",
  epayco: {
    publicKey: "pub_test_123",
    privateKey: "prv_test_123",
    pKey: credentials.pKey,
    custIdCliente: credentials.custIdCliente,
    test: true,
    baseUrl: "https://secure.epayco.co/validation/v1/reference",
  },
} as unknown as BackendConfig;

describe("ePayco webhook handler", () => {
  const ORDER_REF = "EVT-2026-000001";
  const REF_PAYCO = "889900";
  const TX_ID = "tx-123456";
  const AMOUNT = "95000";

  async function makePayload(overrides: Record<string, string> = {}) {
    const base = {
      x_ref_payco: REF_PAYCO,
      x_transaction_id: TX_ID,
      x_amount: AMOUNT,
      x_currency_code: "COP",
      x_id_invoice: ORDER_REF,
      x_cod_response: "1",
      x_response_reason_text: "Aprobada",
      x_franchise: "VISA",
      x_cust_id_cliente: credentials.custIdCliente,
      ...overrides,
    };
    const signature = await computeEpaycoSignature({
      custIdCliente: credentials.custIdCliente,
      pKey: credentials.pKey,
      refPayco: base.x_ref_payco,
      transactionId: base.x_transaction_id,
      amount: base.x_amount,
      currency: base.x_currency_code,
    });
    return {
      ...base,
      x_signature: signature,
      ...overrides, // allows overriding signature if specifically testing invalid signature
    };
  }

  function mockGateway(overrides: Partial<PaymentGateway> = {}): PaymentGateway {
    return {
      claimWebhookEvent: vi.fn().mockResolvedValue({
        claimed: true,
        eventId: "evt-0001",
        result: null,
        processedAt: null,
        httpStatus: null,
      }),
      finalizeWebhookEvent: vi.fn().mockResolvedValue({
        finalized: true,
        eventId: "evt-0001",
        result: "APPLIED",
        processedAt: new Date().toISOString(),
      }),
      recordWebhookRejection: vi.fn().mockResolvedValue({
        eventId: "evt-rej",
        recorded: true,
      }),
      confirmPayment: vi.fn().mockResolvedValue({
        result: "APPLIED",
        reason: "PAYMENT_APPROVED",
        orderId: "order-uuid-1",
        orderReference: ORDER_REF,
        orderStatus: "PAID",
        paymentId: "payment-uuid-1",
        paymentStatus: "approved",
        rawWompiStatus: "1",
        paymentAttempt: 1,
        wompiReference: ORDER_REF,
        wompiTransactionId: REF_PAYCO,
        amountInCents: 9_500_000,
        currency: "COP",
        ticketsIssued: 1,
        ticketsExpected: 1,
        reconciliationRequired: false,
      }),
      queueTicketEmails: vi.fn().mockResolvedValue({
        inserted: 1,
        alreadyQueued: 0,
        total: 1,
        template: "TICKET_CONFIRMATION",
      }),
      findPaymentByReference: vi.fn(),
      findPaymentByTransactionId: vi.fn(),
      expirePendingOrders: vi.fn(),
      retryPayment: vi.fn(),
      claimEmailDeliveries: vi.fn(),
      finishEmailDelivery: vi.fn(),
      resolvePaymentForBuyer: vi.fn(),
      ...overrides,
    } as unknown as PaymentGateway;
  }

  it("handles a valid approved payment confirmation", async () => {
    const payload = await makePayload();
    const gateway = mockGateway();

    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: mockConfig,
      logger,
      payments: gateway,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("APPLIED");
    expect(outcome.orderReference).toBe(ORDER_REF);
    expect(outcome.ticketsIssued).toBe(1);

    expect(gateway.claimWebhookEvent).toHaveBeenCalled();
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
    expect(gateway.queueTicketEmails).toHaveBeenCalledWith("order-uuid-1");
    expect(gateway.finalizeWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt-0001",
        result: "APPLIED",
      }),
    );
  });

  it("handles a declined payment (code 2)", async () => {
    const payload = await makePayload({ x_cod_response: "2", x_response_reason_text: "Rechazada" });
    const gateway = mockGateway({
      confirmPayment: vi.fn().mockResolvedValue({
        result: "APPLIED",
        reason: "PAYMENT_DECLINED",
        orderId: "order-uuid-1",
        orderReference: ORDER_REF,
        orderStatus: "FAILED",
        paymentId: "payment-uuid-1",
        paymentStatus: "declined",
        rawWompiStatus: "2",
        paymentAttempt: 1,
        wompiReference: ORDER_REF,
        wompiTransactionId: REF_PAYCO,
        amountInCents: 9_500_000,
        currency: "COP",
        ticketsIssued: 0,
        ticketsExpected: 0,
        reconciliationRequired: false,
      }),
    });

    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: mockConfig,
      logger,
      payments: gateway,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("APPLIED");
    expect(outcome.ticketsIssued).toBe(0);
    expect(gateway.queueTicketEmails).not.toHaveBeenCalled();
    expect(gateway.finalizeWebhookEvent).toHaveBeenCalled();
  });

  it("rejects an invalid signature and records the refusal", async () => {
    const payload = await makePayload();
    payload.x_signature = "invalid_signature_hex_00000000000000000000000000000000000000000000";

    const gateway = mockGateway();
    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: mockConfig,
      logger,
      payments: gateway,
    });

    expect(outcome.status).toBe(401);
    expect(outcome.outcome).toBe("REJECTED");
    expect(outcome.reason).toBe("SIGNATURE_MISMATCH");
    expect(gateway.recordWebhookRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "SIGNATURE_MISMATCH",
        provider: "epayco",
      }),
    );
    expect(gateway.confirmPayment).not.toHaveBeenCalled();
  });

  it("handles duplicate delivery idempotently without reprocessing", async () => {
    const payload = await makePayload();
    const gateway = mockGateway({
      claimWebhookEvent: vi.fn().mockResolvedValue({
        claimed: false,
        eventId: "evt-0001",
        result: "APPLIED",
        processedAt: new Date().toISOString(),
        httpStatus: 200,
      }),
    });

    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: mockConfig,
      logger,
      payments: gateway,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("DUPLICATE");
    expect(outcome.reason).toBe("ALREADY_PROCESSED");
    expect(gateway.confirmPayment).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads missing key fields", async () => {
    const gateway = mockGateway();
    const outcome = await handleEpaycoWebhook({
      rawBody: { foo: "bar" },
      config: mockConfig,
      logger,
      payments: gateway,
    });

    expect(outcome.status).toBe(400);
    expect(outcome.outcome).toBe("REJECTED");
    expect(outcome.reason).toBe("MALFORMED_PAYLOAD");
  });
  it("maps a retry invoice (EVT-…-N) to its order and keeps the attempt reference", async () => {
    const payload = await makePayload({ x_id_invoice: `${ORDER_REF}-2` });
    const gateway = mockGateway();

    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: mockConfig,
      logger,
      payments: gateway,
    });

    expect(outcome.status).toBe(200);
    expect(gateway.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderReference: ORDER_REF,
        wompiReference: `${ORDER_REF}-2`,
      }),
    );
  });

  it("rejects a sandbox transaction while the backend runs in live mode", async () => {
    const payload = await makePayload({ x_test_request: "TRUE" });
    const gateway = mockGateway();
    const liveConfig = {
      ...mockConfig,
      epayco: { ...mockConfig.epayco, test: false },
    } as unknown as BackendConfig;

    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: liveConfig,
      logger,
      payments: gateway,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("REJECTED");
    expect(outcome.reason).toBe("TEST_TRANSACTION_IN_LIVE_MODE");
    expect(gateway.confirmPayment).not.toHaveBeenCalled();
    expect(gateway.recordWebhookRejection).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "TEST_TRANSACTION_IN_LIVE_MODE" }),
    );
  });

  it("accepts a sandbox transaction while the backend runs in test mode", async () => {
    const payload = await makePayload({ x_test_request: "TRUE" });
    const gateway = mockGateway();

    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: mockConfig,
      logger,
      payments: gateway,
    });

    expect(outcome.outcome).toBe("APPLIED");
    expect(gateway.confirmPayment).toHaveBeenCalled();
  });
});
