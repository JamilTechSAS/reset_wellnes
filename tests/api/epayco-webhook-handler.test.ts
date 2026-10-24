import { describe, expect, it, vi } from "vitest";
import { handleEpaycoWebhook } from "@shared/api/epayco-webhook-handler.ts";
import { computeEpaycoSignature } from "@shared/integrations/epayco/signature.ts";
import { EpaycoApiError, type EpaycoClient } from "@shared/integrations/epayco/client.ts";
import type { EpaycoTransactionData } from "@shared/integrations/epayco/types.ts";
import { AppError, conflictError, notFoundError, validationError } from "@shared/domain/errors.ts";
import { mapSqlErrorToAppError } from "@shared/db/orders.ts";
import { createAlertSink } from "@shared/api/alerts.ts";
import type { AlertGateway } from "@shared/db/alerts.ts";
import type { AlertInput } from "@shared/domain/alerts.ts";
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

const liveConfig = {
  ...mockConfig,
  epayco: { ...mockConfig.epayco, test: false },
} as unknown as BackendConfig;

const STATUS_BY_CODE: Record<string, EpaycoTransactionData["status"]> = {
  "1": "approved",
  "2": "declined",
  "3": "pending",
  "4": "error",
  "6": "voided",
  "7": "pending",
  "8": "pending",
  "9": "declined",
  "10": "declined",
  "11": "declined",
};

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

  /**
   * The authoritative record ePayco's validation API would return for the delivery: by default
   * it agrees with the signed fields of the payload; tests override single fields to model a
   * tampered delivery or a lagging record.
   */
  function recordFor(
    payload: Record<string, string>,
    overrides: Partial<EpaycoTransactionData> = {},
  ): EpaycoTransactionData {
    const code = payload.x_cod_response ?? "1";
    const amountText = payload.x_amount ?? AMOUNT;
    return {
      id: payload.x_ref_payco ?? REF_PAYCO,
      refPayco: payload.x_ref_payco ?? REF_PAYCO,
      responseRefPayco: payload.x_ref_payco ?? REF_PAYCO,
      amountText,
      custIdCliente: credentials.custIdCliente,
      reference: payload.x_id_invoice ?? ORDER_REF,
      invoice: payload.x_id_invoice ?? ORDER_REF,
      transactionId: payload.x_transaction_id ?? TX_ID,
      status: STATUS_BY_CODE[code] ?? "unknown",
      rawStatus: code,
      amount: Number(amountText),
      amountInCents: Math.round(Number(amountText) * 100),
      currency: payload.x_currency_code ?? "COP",
      responseCode: Number(code),
      responseText: payload.x_response_reason_text ?? "",
      statusMessage: payload.x_response_reason_text ?? null,
      paymentMethodType: payload.x_franchise ?? null,
      signature: payload.x_signature ?? "",
      isTest: (payload.x_test_request ?? "").toLowerCase() === "true",
      franchise: payload.x_franchise ?? null,
      bankName: null,
      transactionDate: null,
      rawPayload: { ...payload },
      ...overrides,
    };
  }

  function clientReturning(result: EpaycoTransactionData | Error): EpaycoClient {
    return {
      getTransaction:
        result instanceof Error
          ? vi.fn().mockRejectedValue(result)
          : vi.fn().mockResolvedValue(result),
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
    const epayco = clientReturning(recordFor(payload));

    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: mockConfig,
      logger,
      payments: gateway,
      epayco,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("APPLIED");
    expect(outcome.orderReference).toBe(ORDER_REF);
    expect(outcome.ticketsIssued).toBe(1);

    expect(epayco.getTransaction).toHaveBeenCalledWith(REF_PAYCO);
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
    expect(gateway.queueTicketEmails).not.toHaveBeenCalled();
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
      epayco: clientReturning(recordFor(payload)),
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
    const epayco = clientReturning(recordFor(payload));
    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: mockConfig,
      logger,
      payments: gateway,
      epayco,
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
    // Forged traffic never triggers a provider lookup.
    expect(epayco.getTransaction).not.toHaveBeenCalled();
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
      epayco: clientReturning(recordFor(payload)),
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
      epayco: clientReturning(recordFor(payload)),
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

    const outcome = await handleEpaycoWebhook({
      rawBody: payload,
      config: liveConfig,
      logger,
      payments: gateway,
      epayco: clientReturning(recordFor(payload)),
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
      epayco: clientReturning(recordFor(payload)),
    });

    expect(outcome.outcome).toBe("APPLIED");
    expect(gateway.confirmPayment).toHaveBeenCalled();
  });

  describe("authoritative record (C1)", () => {
    async function deliver(
      payload: Record<string, string>,
      epayco: EpaycoClient | undefined,
      config: BackendConfig = mockConfig,
      gateway: PaymentGateway = mockGateway(),
    ) {
      const outcome = await handleEpaycoWebhook({
        rawBody: payload,
        config,
        logger,
        payments: gateway,
        epayco,
      });
      return { outcome, gateway };
    }

    it("never approves from a tampered status: the record's pending state is retried, not applied", async () => {
      const payload = await makePayload({ x_cod_response: "1" });
      const record = recordFor(payload, { status: "pending", rawStatus: "3", responseCode: 3 });
      const { outcome, gateway } = await deliver(payload, clientReturning(record));

      expect(outcome.status).toBe(503);
      expect(outcome.outcome).toBe("RETRY");
      expect(outcome.reason).toBe("PROVIDER_STATUS_NOT_SETTLED");
      expect(gateway.claimWebhookEvent).not.toHaveBeenCalled();
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("applies the record's declined status when the delivery claims approval", async () => {
      const payload = await makePayload({ x_cod_response: "1" });
      const record = recordFor(payload, { status: "declined", rawStatus: "2", responseCode: 2 });
      const { gateway } = await deliver(payload, clientReturning(record));

      expect(gateway.confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({ wompiStatus: "2" }),
      );
    });

    it("applies the record's approval when the delivery still reports pending", async () => {
      const payload = await makePayload({ x_cod_response: "3" });
      const record = recordFor(payload, { status: "approved", rawStatus: "1", responseCode: 1 });
      const { outcome, gateway } = await deliver(payload, clientReturning(record));

      expect(outcome.outcome).toBe("APPLIED");
      expect(gateway.confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({ wompiStatus: "1" }),
      );
    });

    it("rejects a delivery whose invoice points to a different order than the record", async () => {
      const payload = await makePayload({ x_id_invoice: "EVT-2026-999999" });
      const record = recordFor(payload, { invoice: ORDER_REF, reference: ORDER_REF });
      const { outcome, gateway } = await deliver(payload, clientReturning(record));

      expect(outcome.status).toBe(200);
      expect(outcome.outcome).toBe("REJECTED");
      expect(outcome.reason).toBe("INVOICE_MISMATCH");
      expect(outcome.reviewRequired).toBe(true);
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
      expect(gateway.recordWebhookRejection).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "INVOICE_MISMATCH", provider: "epayco" }),
      );
    });

    it("confirms against the record's invoice even when the delivery omits it", async () => {
      const payload = await makePayload({ x_id_invoice: "" });
      const record = recordFor(payload, { invoice: ORDER_REF, reference: ORDER_REF });
      const { gateway } = await deliver(payload, clientReturning(record));

      expect(gateway.confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({ orderReference: ORDER_REF, wompiReference: ORDER_REF }),
      );
    });

    it("rejects for review instead of guessing when the record has no invoice", async () => {
      const payload = await makePayload();
      const record = recordFor(payload, { invoice: "", reference: "" });
      const { outcome, gateway } = await deliver(payload, clientReturning(record));

      expect(outcome.outcome).toBe("REJECTED");
      expect(outcome.reason).toBe("INVOICE_MISSING");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("trusts the record's test flag over a delivery that hides it in live mode", async () => {
      const payload = await makePayload({ x_test_request: "FALSE" });
      const record = recordFor(payload, { isTest: true });
      const { outcome, gateway } = await deliver(payload, clientReturning(record), liveConfig);

      expect(outcome.outcome).toBe("REJECTED");
      expect(outcome.reason).toBe("TEST_TRANSACTION_IN_LIVE_MODE");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("rejects a record whose amount differs from the signed delivery", async () => {
      const payload = await makePayload();
      const record = recordFor(payload, {
        amountText: "1000",
        amount: 1000,
        amountInCents: 100_000,
      });
      const { outcome, gateway } = await deliver(payload, clientReturning(record));

      expect(outcome.reason).toBe("AMOUNT_MISMATCH");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("does not reject the same amount written with decimals", async () => {
      const payload = await makePayload({ x_amount: "95000" });
      const record = recordFor(payload, { amountText: "95000.00" });
      const { outcome, gateway } = await deliver(payload, clientReturning(record));

      expect(outcome.outcome).toBe("APPLIED");
      expect(gateway.confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 9_500_000 }),
      );
    });

    it.each([
      ["a different currency", "USD", "CURRENCY_MISMATCH"],
      ["no currency", "", "CURRENCY_MISSING"],
    ])("rejects a record with %s", async (_label, currency, reason) => {
      const payload = await makePayload();
      const record = recordFor(payload, { currency });
      const { outcome, gateway } = await deliver(payload, clientReturning(record));

      expect(outcome.outcome).toBe("REJECTED");
      expect(outcome.reason).toBe(reason);
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("rejects a record that belongs to another merchant", async () => {
      const payload = await makePayload();
      const record = recordFor(payload, { custIdCliente: "99999" });
      const { outcome, gateway } = await deliver(payload, clientReturning(record));

      expect(outcome.reason).toBe("MERCHANT_MISMATCH");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("rejects a record for a different ref_payco or transaction", async () => {
      const payload = await makePayload();
      for (const [override, reason] of [
        [{ responseRefPayco: "111111" }, "REF_PAYCO_MISMATCH"],
        [{ transactionId: "tx-other" }, "TRANSACTION_ID_MISMATCH"],
      ] as const) {
        const { outcome, gateway } = await deliver(
          payload,
          clientReturning(recordFor(payload, override)),
        );
        expect(outcome.reason).toBe(reason);
        expect(gateway.confirmPayment).not.toHaveBeenCalled();
      }
    });

    it.each([
      [
        "a provider outage",
        new EpaycoApiError("ePayco returned HTTP 503", { httpStatus: 503 }),
        "PROVIDER_LOOKUP_FAILED",
      ],
      [
        "an invalid provider response",
        new EpaycoApiError("ePayco returned invalid JSON"),
        "PROVIDER_LOOKUP_FAILED",
      ],
      [
        "a record not yet visible",
        new EpaycoApiError("not found", { httpStatus: 404 }),
        "PROVIDER_RECORD_NOT_FOUND",
      ],
      ["a network failure", new TypeError("fetch failed"), "PROVIDER_LOOKUP_FAILED"],
    ])("answers 503 without claiming or confirming on %s", async (_label, error, reason) => {
      const payload = await makePayload();
      const { outcome, gateway } = await deliver(payload, clientReturning(error));

      expect(outcome.status).toBe(503);
      expect(outcome.outcome).toBe("RETRY");
      expect(outcome.reason).toBe(reason);
      expect(gateway.claimWebhookEvent).not.toHaveBeenCalled();
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
      expect(gateway.finalizeWebhookEvent).not.toHaveBeenCalled();
    });

    it("fails closed when no validation client is available", async () => {
      const payload = await makePayload();
      const { outcome, gateway } = await deliver(payload, undefined);

      expect(outcome.status).toBe(503);
      expect(outcome.reason).toBe("PROVIDER_CLIENT_UNAVAILABLE");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });

    it("keys idempotency on the record, so a tampered redelivery of the same state is a duplicate", async () => {
      const original = await makePayload({ x_cod_response: "3" });
      const tampered = await makePayload({ x_cod_response: "8" });
      const record = recordFor(original, { status: "pending", rawStatus: "3", responseCode: 3 });

      const first = await deliver(original, clientReturning(record));
      const second = await deliver(tampered, clientReturning(record));

      const firstKey = vi.mocked(first.gateway.claimWebhookEvent).mock.calls[0]?.[0].dedupeKey;
      const secondKey = vi.mocked(second.gateway.claimWebhookEvent).mock.calls[0]?.[0].dedupeKey;
      expect(firstKey).toBeDefined();
      expect(secondKey).toBe(firstKey);
    });

    it("stores the provider record, not the delivered body, as the payment payload", async () => {
      const payload = await makePayload({ x_extra1: "forged" });
      const record = recordFor(payload, {
        rawPayload: { x_ref_payco: REF_PAYCO, x_cod_response: "1" },
      });
      const { gateway } = await deliver(payload, clientReturning(record));

      expect(gateway.confirmPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          providerPayload: { x_ref_payco: REF_PAYCO, x_cod_response: "1" },
        }),
      );
    });
  });

  describe("transient confirmation failures (H3)", () => {
    const UNFINALIZED_CLAIM = {
      claimed: false,
      eventId: "evt-0001",
      result: null,
      processedAt: null,
      httpStatus: null,
    };

    async function deliverWith(gateway: PaymentGateway) {
      const payload = await makePayload();
      return handleEpaycoWebhook({
        rawBody: payload,
        config: mockConfig,
        logger,
        payments: gateway,
        epayco: clientReturning(recordFor(payload)),
      });
    }

    it.each([
      [
        "a lost database connection",
        mapSqlErrorToAppError({ message: "Connection terminated unexpectedly" }),
      ],
      [
        "a statement timeout",
        mapSqlErrorToAppError({
          code: "57014",
          message: "canceling statement due to statement timeout",
        }),
      ],
      ["a deadlock", mapSqlErrorToAppError({ code: "40P01", message: "deadlock detected" })],
      ["a network failure before the RPC answered", new TypeError("fetch failed")],
      ["an unexpected platform error", new AppError("INTERNAL_ERROR", "PostgREST 502")],
    ])("answers 503 and leaves the event open on %s", async (_label, failure) => {
      const gateway = mockGateway({ confirmPayment: vi.fn().mockRejectedValue(failure) });
      const outcome = await deliverWith(gateway);

      expect(outcome.status).toBe(503);
      expect(outcome.outcome).toBe("RETRY");
      expect(outcome.reason).toBe("CONFIRMATION_TEMPORARILY_FAILED");
      expect(gateway.finalizeWebhookEvent).not.toHaveBeenCalled();
      expect(gateway.queueTicketEmails).not.toHaveBeenCalled();
    });

    it.each([
      [
        "an amount conflict",
        conflictError("Database reported a conflict: AMOUNT_MISMATCH", {
          context: { detail: "AMOUNT_MISMATCH" },
        }),
        "CONFLICT",
      ],
      [
        "an invalid payment reference",
        validationError("Database rejected input: MISSING_REFERENCE"),
        "VALIDATION_ERROR",
      ],
      [
        "an unknown order",
        notFoundError("Database reported not found: ORDER_NOT_FOUND"),
        "NOT_FOUND",
      ],
      [
        "the mapped SQL conflict",
        mapSqlErrorToAppError({ code: "PT409", details: "REFERENCE_MISMATCH", message: "x" }),
        "CONFLICT",
      ],
    ])("keeps rejecting %s permanently with 200", async (_label, failure, code) => {
      const gateway = mockGateway({ confirmPayment: vi.fn().mockRejectedValue(failure) });
      const outcome = await deliverWith(gateway);

      expect(outcome.status).toBe(200);
      expect(outcome.outcome).toBe("REJECTED");
      expect(outcome.reason).toBe(code);
      expect(outcome.reviewRequired).toBe(true);
      expect(gateway.finalizeWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ result: "REJECTED", httpStatus: 409, errorCode: code }),
      );
    });

    it("applies the approval on ePayco's redelivery after a transient failure", async () => {
      const first = mockGateway({
        confirmPayment: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
      });
      expect((await deliverWith(first)).status).toBe(503);

      // The redelivery finds the same event still unfinalized and confirms it.
      const second = mockGateway({
        claimWebhookEvent: vi.fn().mockResolvedValue(UNFINALIZED_CLAIM),
      });
      const outcome = await deliverWith(second);

      expect(outcome.status).toBe(200);
      expect(outcome.outcome).toBe("APPLIED");
      expect(outcome.ticketsIssued).toBe(1);
      expect(second.confirmPayment).toHaveBeenCalledTimes(1);
      expect(second.queueTicketEmails).not.toHaveBeenCalled();
      expect(second.finalizeWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: "evt-0001", result: "APPLIED" }),
      );
      // Both deliveries used the same idempotency key.
      expect(vi.mocked(second.claimWebhookEvent).mock.calls[0]?.[0].dedupeKey).toBe(
        vi.mocked(first.claimWebhookEvent).mock.calls[0]?.[0].dedupeKey,
      );
    });

    it("issues no extra tickets when the failed attempt had in fact committed", async () => {
      const second = mockGateway({
        claimWebhookEvent: vi.fn().mockResolvedValue(UNFINALIZED_CLAIM),
        confirmPayment: vi.fn().mockResolvedValue({
          result: "DUPLICATE",
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
          ticketsIssued: 0,
          ticketsExpected: 1,
          reconciliationRequired: false,
        }),
      });
      const outcome = await deliverWith(second);

      expect(outcome.status).toBe(200);
      expect(outcome.outcome).toBe("DUPLICATE");
      expect(outcome.ticketsIssued).toBe(0);
      expect(second.finalizeWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ result: "DUPLICATE" }),
      );
    });

    it("still ignores a redelivery once the event was finalized", async () => {
      const gateway = mockGateway({
        claimWebhookEvent: vi
          .fn()
          .mockResolvedValue({ ...UNFINALIZED_CLAIM, result: "APPLIED", httpStatus: 200 }),
      });
      const outcome = await deliverWith(gateway);

      expect(outcome.outcome).toBe("DUPLICATE");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
    });
  });

  describe("ePayco states 6-11 (H7)", () => {
    async function deliver(code: string, gateway: PaymentGateway, recordCode = code) {
      const payload = await makePayload({ x_cod_response: code });
      const record = recordFor(await makePayload({ x_cod_response: recordCode }));
      return handleEpaycoWebhook({
        rawBody: payload,
        config: mockConfig,
        logger,
        payments: gateway,
        epayco: clientReturning(record),
      });
    }

    it.each(["6", "7", "8", "9", "10", "11"])(
      "hands the record's raw code %s to confirm_payment",
      async (code) => {
        const gateway = mockGateway({
          confirmPayment: vi.fn().mockResolvedValue({
            result: "APPLIED",
            reason: "PAYMENT_PENDING",
            orderId: "order-uuid-1",
            orderReference: ORDER_REF,
            orderStatus: "PENDING",
            paymentId: "payment-uuid-1",
            paymentStatus: "pending",
            ticketsIssued: 0,
            ticketsExpected: 0,
            reconciliationRequired: false,
          }),
        });
        const outcome = await deliver(code, gateway);

        expect(outcome.status).toBe(200);
        expect(gateway.confirmPayment).toHaveBeenCalledWith(
          expect.objectContaining({ wompiStatus: code }),
        );
        expect(gateway.queueTicketEmails).not.toHaveBeenCalled();
      },
    );

    it.each(["6", "9", "10", "11"])(
      "waits for the record instead of applying a delivered final code %s it does not show yet",
      async (code) => {
        const gateway = mockGateway();
        const outcome = await deliver(code, gateway, "3");

        expect(outcome.status).toBe(503);
        expect(outcome.reason).toBe("PROVIDER_STATUS_NOT_SETTLED");
        expect(gateway.confirmPayment).not.toHaveBeenCalled();
      },
    );

    it("surfaces a reversal after approval for review and keeps it in the ledger as applied", async () => {
      const gateway = mockGateway({
        confirmPayment: vi.fn().mockResolvedValue({
          result: "RECONCILIATION_REQUIRED",
          reason: "PAYMENT_REVERSED_AFTER_APPROVAL",
          orderId: "order-uuid-1",
          orderReference: ORDER_REF,
          orderStatus: "PAID",
          paymentId: "payment-uuid-1",
          paymentStatus: "refunded",
          ticketsIssued: 0,
          ticketsExpected: 0,
          reconciliationRequired: true,
        }),
      });
      const outcome = await deliver("6", gateway);

      expect(outcome.status).toBe(200);
      expect(outcome.outcome).toBe("RECONCILIATION_REQUIRED");
      expect(outcome.reason).toBe("PAYMENT_REVERSED_AFTER_APPROVAL");
      expect(outcome.reviewRequired).toBe(true);
      expect(gateway.queueTicketEmails).not.toHaveBeenCalled();
      expect(gateway.finalizeWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          result: "APPLIED",
          errorCode: "PAYMENT_REVERSED_AFTER_APPROVAL",
        }),
      );
    });
  });

  describe("operational alerts (H8)", () => {
    const REVIEW = (reason: string, orderStatus: string, paymentStatus: string) => ({
      result: "RECONCILIATION_REQUIRED",
      reason,
      orderId: "order-uuid-1",
      orderReference: ORDER_REF,
      orderStatus,
      paymentId: "22222222-2222-4222-8222-222222222222",
      paymentStatus,
      ticketsIssued: 0,
      ticketsExpected: 0,
      reconciliationRequired: true,
    });

    async function deliverWithAlerts(options: {
      code?: string;
      gateway?: PaymentGateway;
      record?: Partial<EpaycoTransactionData>;
      payload?: Record<string, string>;
      alerts?: (alert: AlertInput) => Promise<void>;
    }) {
      const payload = await makePayload({
        x_cod_response: options.code ?? "1",
        ...options.payload,
      });
      const gateway = options.gateway ?? mockGateway();
      const alerts = options.alerts ?? vi.fn().mockResolvedValue(undefined);
      const outcome = await handleEpaycoWebhook({
        rawBody: payload,
        config: mockConfig,
        logger,
        payments: gateway,
        epayco: clientReturning(
          recordFor(await makePayload({ x_cod_response: options.code ?? "1" }), options.record),
        ),
        alerts,
      });
      return { outcome, gateway, alerts };
    }

    it("raises a critical alert for a reversal after approval", async () => {
      const { outcome, alerts } = await deliverWithAlerts({
        code: "6",
        gateway: mockGateway({
          confirmPayment: vi
            .fn()
            .mockResolvedValue(REVIEW("PAYMENT_REVERSED_AFTER_APPROVAL", "PAID", "refunded")),
        }),
      });
      expect(outcome.outcome).toBe("RECONCILIATION_REQUIRED");
      expect(alerts).toHaveBeenCalledWith({
        kind: "PAYMENT_REVERSED_AFTER_APPROVAL",
        dedupeKey: "reversal:22222222-2222-4222-8222-222222222222",
        orderReference: ORDER_REF,
        paymentId: "22222222-2222-4222-8222-222222222222",
        provider: "epayco",
        detail: "PAYMENT_REVERSED_AFTER_APPROVAL",
      });
    });

    it("raises a late-approval alert for an order that was no longer payable", async () => {
      const { alerts } = await deliverWithAlerts({
        gateway: mockGateway({
          confirmPayment: vi
            .fn()
            .mockResolvedValue(REVIEW("ORDER_NOT_PAYABLE_EXPIRED", "EXPIRED", "approved")),
        }),
      });
      expect(alerts).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "LATE_APPROVAL",
          dedupeKey: "late:22222222-2222-4222-8222-222222222222",
        }),
      );
    });

    it("raises a mismatch alert when the delivery contradicts the ePayco record", async () => {
      const { outcome, gateway, alerts } = await deliverWithAlerts({
        payload: { x_id_invoice: "EVT-2026-999999" },
      });
      expect(outcome.reason).toBe("INVOICE_MISMATCH");
      expect(gateway.confirmPayment).not.toHaveBeenCalled();
      expect(alerts).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "PROVIDER_RECORD_MISMATCH",
          dedupeKey: `record-mismatch:${REF_PAYCO}:INVOICE_MISMATCH`,
          provider: "epayco",
        }),
      );
    });

    it("raises nothing for an ordinary approval, or for a finalized redelivery", async () => {
      expect((await deliverWithAlerts({})).alerts).not.toHaveBeenCalled();
      const redelivery = await deliverWithAlerts({
        code: "6",
        gateway: mockGateway({
          claimWebhookEvent: vi.fn().mockResolvedValue({
            claimed: false,
            eventId: "evt-0001",
            result: "APPLIED",
            processedAt: "2026-10-23T00:00:00Z",
            httpStatus: 200,
          }),
        }),
      });
      expect(redelivery.outcome.outcome).toBe("DUPLICATE");
      expect(redelivery.alerts).not.toHaveBeenCalled();
    });

    it("raises nothing again for an unfinalized redelivery that confirm_payment reports as duplicate", async () => {
      const { alerts } = await deliverWithAlerts({
        code: "6",
        gateway: mockGateway({
          claimWebhookEvent: vi.fn().mockResolvedValue({
            claimed: false,
            eventId: "evt-0001",
            result: null,
            processedAt: null,
            httpStatus: null,
          }),
          confirmPayment: vi.fn().mockResolvedValue({
            ...REVIEW("PAYMENT_REFUNDED", "PAID", "refunded"),
            result: "DUPLICATE",
            reconciliationRequired: false,
          }),
        }),
      });
      expect(alerts).not.toHaveBeenCalled();
    });

    it("keeps an approval paid, emailed and finalized when the alert ledger is down", async () => {
      const broken: AlertGateway = {
        recordAlert: vi.fn().mockRejectedValue(new Error("db down")),
        raiseUnresolvedPaymentAlerts: vi.fn(),
        claimAlertNotifications: vi.fn(),
        finishAlertNotifications: vi.fn(),
      };
      const { outcome, gateway } = await deliverWithAlerts({
        gateway: mockGateway({
          confirmPayment: vi
            .fn()
            .mockResolvedValue(REVIEW("ORDER_NOT_PAYABLE_EXPIRED", "EXPIRED", "approved")),
        }),
        alerts: createAlertSink(broken, logger),
      });
      expect(broken.recordAlert).toHaveBeenCalled();
      expect(outcome.status).toBe(200);
      expect(outcome.reviewRequired).toBe(true);
      expect(gateway.finalizeWebhookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ result: "APPLIED", errorCode: "ORDER_NOT_PAYABLE_EXPIRED" }),
      );
    });

    it("never turns a confirmed approval into a failure, even with a throwing sink", async () => {
      const { outcome, gateway } = await deliverWithAlerts({
        gateway: mockGateway({
          confirmPayment: vi
            .fn()
            .mockResolvedValue(REVIEW("ORDER_NOT_PAYABLE_EXPIRED", "EXPIRED", "approved")),
        }),
        alerts: vi.fn().mockRejectedValue(new Error("sink bug")),
      });
      expect(outcome.status).toBe(200);
      expect(gateway.confirmPayment).toHaveBeenCalledTimes(1);
      expect(gateway.finalizeWebhookEvent).toHaveBeenCalled();
    });
  });
});
