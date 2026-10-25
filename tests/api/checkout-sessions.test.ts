/**
 * Checkout-session pinning at the API boundary (migration 20261024170000).
 *
 * The database decides (REUSE / CREATE / LEASED / RETRY_REQUIRED); these tests prove the
 * handler honours that decision: a replay never calls ePayco again, a refused attempt never
 * mints a session, a provider failure frees the lease, and a session the database refused to
 * record is never handed to the browser.
 */

import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { loadConfig, type BackendConfig } from "@shared/config/env.ts";
import { createEpaycoCheckoutForAttempt, handleCreateOrder } from "@shared/api/orders-handler.ts";
import { handlePaymentRetry } from "@shared/api/order-status-handler.ts";
import type { OrderGateway } from "@shared/db/orders.ts";
import type { OrderStatusGateway, PaymentGateway } from "@shared/db/payments.ts";
import {
  toCheckoutSessionPlan,
  type CheckoutSessionGateway,
  type CheckoutSessionPlan,
  type RetryRequiredReason,
} from "@shared/db/checkout-sessions.ts";
import { EpaycoApifyError, type EpaycoApifyClient } from "@shared/integrations/epayco/apify.ts";
import { createLogger } from "@shared/logging/logger.ts";

/** Syntactically valid but obviously fake credentials (see orders-handler.test.ts). */
function fakeCredential(prefix: string): string {
  return `${prefix}${"0123456789abcdefghijklmnop".slice(0, 24)}`;
}

function epaycoConfig(): BackendConfig {
  return loadConfig({
    APP_ENV: "development",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SECRET_KEY: fakeCredential("sb_secret_"),
    WOMPI_PUBLIC_KEY: fakeCredential("pub_test_"),
    WOMPI_PRIVATE_KEY: fakeCredential("prv_test_"),
    WOMPI_INTEGRITY_SECRET: fakeCredential("test_integrity_"),
    WOMPI_EVENTS_SECRET: fakeCredential("test_events_"),
    PUBLIC_WEB_BASE_URL: "http://localhost:3000",
    API_BASE_URL: "http://127.0.0.1:54321/functions/v1",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    ORDER_RESERVATION_MINUTES: "15",
    PAYMENT_PROVIDER: "epayco",
    EPAYCO_PUBLIC_KEY: fakeCredential("epayco_pub_"),
    EPAYCO_PRIVATE_KEY: fakeCredential("epayco_prv_"),
    EPAYCO_P_KEY: fakeCredential("epayco_pkey_"),
    EPAYCO_CUST_ID_CLIENTE: "123456",
    EPAYCO_TEST: "true",
    PAYMENT_RETURN_URL: "http://localhost:3000/gracias",
  });
}

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const REFERENCE = "EVT-2026-000001";

const ORDER = {
  replayed: false,
  orderId: "11111111-1111-4111-8111-111111111111",
  reference: REFERENCE,
  status: "PENDING",
  quantity: 2,
  unitPriceInCents: 20_000_000,
  pricingTierName: "General",
  subtotalInCents: 40_000_000,
  quantityDiscountInCents: 0,
  discountCodeInCents: 0,
  totalDiscountInCents: 0,
  discountCombination: "BEST_SINGLE",
  totalInCents: 40_000_000,
  currency: "COP",
  reservationExpiresAt: "2026-10-24T15:15:00.000Z",
  paymentAttempt: 1,
  wompiReference: REFERENCE,
  participantId: "22222222-2222-4222-8222-222222222222",
};

const VALID_ORDER_BODY = {
  eventCode: "RESET-SUNSET-2026",
  ticketTypeCode: "GENERAL",
  quantity: 2,
  buyer: { email: "buyer@example.com", fullName: "Comprador Uno", phone: "3001234567" },
  participant: {
    firstName: "Ana",
    lastName: "Pérez",
    nationalId: "1020456789",
    email: "ana@example.com",
    phone: "3001234567",
    city: "Bogotá",
    consents: { dataProcessing: true, futureEvents: false },
  },
};

const CREATE_PLAN: CheckoutSessionPlan = {
  state: "CREATE",
  paymentId: "33333333-3333-4333-8333-333333333333",
  paymentReference: REFERENCE,
  paymentAttempt: 1,
  generation: 4,
};

type SessionSpies = {
  gateway: CheckoutSessionGateway;
  begin: MockedFunction<CheckoutSessionGateway["begin"]>;
  complete: MockedFunction<CheckoutSessionGateway["complete"]>;
  abandon: MockedFunction<CheckoutSessionGateway["abandon"]>;
};

function sessionSpies(plan: CheckoutSessionPlan = CREATE_PLAN): SessionSpies {
  const begin = vi.fn<CheckoutSessionGateway["begin"]>().mockResolvedValue(plan);
  const complete = vi.fn<CheckoutSessionGateway["complete"]>().mockResolvedValue("RECORDED");
  const abandon = vi.fn<CheckoutSessionGateway["abandon"]>().mockResolvedValue(true);
  return { gateway: { begin, complete, abandon }, begin, complete, abandon };
}

function orderGateway(replayed = false): OrderGateway {
  return {
    quote: vi.fn(),
    createOrder: vi.fn().mockResolvedValue({ ...ORDER, replayed }),
  };
}

function apifyWith(
  createSession: MockedFunction<EpaycoApifyClient["createSession"]>,
): EpaycoApifyClient {
  return { login: vi.fn().mockResolvedValue("token"), createSession };
}

function apifyReturning(sessionId = "sess_created_1") {
  return apifyWith(vi.fn().mockResolvedValue({ sessionId }));
}

describe("POST /orders with ePayco", () => {
  it("creates a session under the lease and hands it to the buyer", async () => {
    const sessions = sessionSpies();
    const apify = apifyReturning("sess_created_1");

    const result = await handleCreateOrder({
      rawBody: VALID_ORDER_BODY,
      idempotencyKey: "idem-key-00000001",
      ipAddress: "203.0.113.10",
      userAgent: "vitest/1.0",
      gateway: orderGateway(),
      config: epaycoConfig(),
      logger,
      checkoutSessions: sessions.gateway,
      epaycoApify: apify,
    });

    expect(apify.createSession).toHaveBeenCalledTimes(1);
    expect(sessions.complete).toHaveBeenCalledWith({
      paymentReference: REFERENCE,
      generation: 4,
      sessionId: "sess_created_1",
    });
    expect(result.checkout.sessionId).toBe("sess_created_1");
  });

  it("resumes the stored session on a replay and never calls ePayco again", async () => {
    const sessions = sessionSpies({
      state: "REUSE",
      paymentId: "33333333-3333-4333-8333-333333333333",
      paymentReference: REFERENCE,
      paymentAttempt: 1,
      sessionId: "sess_stored_1",
      sessionExpiresAt: "2026-10-24T15:15:00.000Z",
    });
    const apify = apifyReturning("sess_should_not_exist");

    const result = await handleCreateOrder({
      rawBody: VALID_ORDER_BODY,
      idempotencyKey: "idem-key-00000001",
      ipAddress: "203.0.113.10",
      userAgent: "vitest/1.0",
      gateway: orderGateway(true),
      config: epaycoConfig(),
      logger,
      checkoutSessions: sessions.gateway,
      epaycoApify: apify,
    });

    expect(apify.createSession).not.toHaveBeenCalled();
    expect(sessions.complete).not.toHaveBeenCalled();
    expect(result.replayed).toBe(true);
    expect(result.checkout.sessionId).toBe("sess_stored_1");
    // Everything else in the payload is derived from the stored order, not from the replay.
    expect(result.checkout.reference).toBe(REFERENCE);
    expect(result.checkout.amountInCents).toBe(ORDER.totalInCents);
  });

  it("refuses when another request is already creating the session", async () => {
    const sessions = sessionSpies({
      state: "LEASED",
      paymentId: "33333333-3333-4333-8333-333333333333",
      paymentReference: REFERENCE,
      paymentAttempt: 1,
    });
    const apify = apifyReturning();

    await expect(
      handleCreateOrder({
        rawBody: VALID_ORDER_BODY,
        idempotencyKey: "idem-key-00000001",
        ipAddress: "203.0.113.10",
        userAgent: "vitest/1.0",
        gateway: orderGateway(),
        config: epaycoConfig(),
        logger,
        checkoutSessions: sessions.gateway,
        epaycoApify: apify,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      context: { detail: "CHECKOUT_LEASE_ACTIVE" },
    });

    expect(apify.createSession).not.toHaveBeenCalled();
    expect(sessions.complete).not.toHaveBeenCalled();
  });

  const retryReasons: readonly RetryRequiredReason[] = [
    "ORDER_NOT_PENDING",
    "RESERVATION_EXPIRED",
    "TRANSACTION_RECORDED",
  ];

  it.each(retryReasons)(
    "refuses to mint a session when the database answers RETRY_REQUIRED (%s)",
    async (reason) => {
      const sessions = sessionSpies({
        state: "RETRY_REQUIRED",
        paymentId: "33333333-3333-4333-8333-333333333333",
        paymentReference: REFERENCE,
        paymentAttempt: 1,
        reason,
      });
      const apify = apifyReturning();

      await expect(
        handleCreateOrder({
          rawBody: VALID_ORDER_BODY,
          idempotencyKey: "idem-key-00000001",
          ipAddress: "203.0.113.10",
          userAgent: "vitest/1.0",
          gateway: orderGateway(true),
          config: epaycoConfig(),
          logger,
          checkoutSessions: sessions.gateway,
          epaycoApify: apify,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", context: { detail: reason } });

      expect(apify.createSession).not.toHaveBeenCalled();
    },
  );

  it("frees the lease when ePayco fails, so the buyer can retry immediately", async () => {
    const sessions = sessionSpies();
    const failure = new EpaycoApifyError("ePayco session creation failed", {
      httpStatus: 500,
      context: { invoice: REFERENCE },
    });
    const apify = apifyWith(vi.fn().mockRejectedValue(failure));

    await expect(
      createEpaycoCheckoutForAttempt({
        config: epaycoConfig(),
        orderReference: REFERENCE,
        paymentReference: REFERENCE,
        amountInCents: ORDER.totalInCents,
        currency: "COP",
        buyerEmail: "buyer@example.com",
        clientIp: "203.0.113.10",
        sessions: sessions.gateway,
        logger,
        epaycoApify: apify,
      }),
    ).rejects.toBe(failure);

    expect(sessions.abandon).toHaveBeenCalledWith({
      paymentReference: REFERENCE,
      generation: 4,
    });
    expect(sessions.complete).not.toHaveBeenCalled();
  });

  it("hands the winner's session to the browser when its own could not be recorded", async () => {
    const begin = vi
      .fn<CheckoutSessionGateway["begin"]>()
      .mockResolvedValueOnce(CREATE_PLAN)
      .mockResolvedValueOnce({
        state: "REUSE",
        paymentId: "33333333-3333-4333-8333-333333333333",
        paymentReference: REFERENCE,
        paymentAttempt: 1,
        sessionId: "sess_winner",
        sessionExpiresAt: "2026-10-24T15:15:00.000Z",
      });
    const sessions: CheckoutSessionGateway = {
      begin,
      complete: vi.fn<CheckoutSessionGateway["complete"]>().mockResolvedValue("LEASE_LOST"),
      abandon: vi.fn<CheckoutSessionGateway["abandon"]>().mockResolvedValue(true),
    };

    const checkout = await createEpaycoCheckoutForAttempt({
      config: epaycoConfig(),
      orderReference: REFERENCE,
      paymentReference: REFERENCE,
      amountInCents: ORDER.totalInCents,
      currency: "COP",
      buyerEmail: "buyer@example.com",
      clientIp: "203.0.113.10",
      sessions,
      logger,
      epaycoApify: apifyReturning("sess_orphan"),
    });

    // The orphan session is never surfaced: the buyer gets the one the database knows.
    expect(checkout.sessionId).toBe("sess_winner");
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it("refuses instead of surfacing a session the database did not record", async () => {
    const sessions: CheckoutSessionGateway = {
      begin: vi
        .fn<CheckoutSessionGateway["begin"]>()
        .mockResolvedValueOnce(CREATE_PLAN)
        .mockResolvedValueOnce({ ...CREATE_PLAN, state: "LEASED" }),
      complete: vi.fn<CheckoutSessionGateway["complete"]>().mockResolvedValue("LEASE_LOST"),
      abandon: vi.fn<CheckoutSessionGateway["abandon"]>().mockResolvedValue(true),
    };

    await expect(
      createEpaycoCheckoutForAttempt({
        config: epaycoConfig(),
        orderReference: REFERENCE,
        paymentReference: REFERENCE,
        amountInCents: ORDER.totalInCents,
        currency: "COP",
        buyerEmail: "buyer@example.com",
        clientIp: "203.0.113.10",
        sessions,
        logger,
        epaycoApify: apifyReturning("sess_orphan"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      context: { detail: "CHECKOUT_SESSION_NOT_RECORDED" },
    });
  });

  it("releases the recovery lease so an immediate retry is not answered LEASED", async () => {
    const RECOVERY_PLAN: CheckoutSessionPlan = { ...CREATE_PLAN, generation: 5 };
    const abandon = vi.fn<CheckoutSessionGateway["abandon"]>().mockResolvedValue(true);
    const sessions: CheckoutSessionGateway = {
      begin: vi
        .fn<CheckoutSessionGateway["begin"]>()
        .mockResolvedValueOnce(CREATE_PLAN)
        .mockResolvedValueOnce(RECOVERY_PLAN),
      complete: vi.fn<CheckoutSessionGateway["complete"]>().mockResolvedValue("LEASE_LOST"),
      abandon,
    };

    await expect(
      createEpaycoCheckoutForAttempt({
        config: epaycoConfig(),
        orderReference: REFERENCE,
        paymentReference: REFERENCE,
        amountInCents: ORDER.totalInCents,
        currency: "COP",
        buyerEmail: "buyer@example.com",
        clientIp: "203.0.113.10",
        sessions,
        logger,
        epaycoApify: apifyReturning("sess_orphan"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      context: { detail: "CHECKOUT_SESSION_NOT_RECORDED" },
    });

    // The recovery `begin` claimed a lease of its own; leaving it behind would answer the
    // buyer's next click with CHECKOUT_LEASE_ACTIVE for a session nobody is creating.
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledWith({ paymentReference: REFERENCE, generation: 5 });
  });

  it("keeps the original refusal when releasing the recovery lease fails", async () => {
    const sessions: CheckoutSessionGateway = {
      begin: vi
        .fn<CheckoutSessionGateway["begin"]>()
        .mockResolvedValueOnce(CREATE_PLAN)
        .mockResolvedValueOnce({ ...CREATE_PLAN, generation: 5 }),
      complete: vi.fn<CheckoutSessionGateway["complete"]>().mockResolvedValue("LEASE_LOST"),
      abandon: vi
        .fn<CheckoutSessionGateway["abandon"]>()
        .mockRejectedValue(new Error("database unavailable")),
    };

    await expect(
      createEpaycoCheckoutForAttempt({
        config: epaycoConfig(),
        orderReference: REFERENCE,
        paymentReference: REFERENCE,
        amountInCents: ORDER.totalInCents,
        currency: "COP",
        buyerEmail: "buyer@example.com",
        clientIp: "203.0.113.10",
        sessions,
        logger,
        epaycoApify: apifyReturning("sess_orphan"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      context: { detail: "CHECKOUT_SESSION_NOT_RECORDED" },
    });
  });
});

describe("checkout session plan parsing", () => {
  const base = {
    paymentId: "33333333-3333-4333-8333-333333333333",
    paymentReference: REFERENCE,
    paymentAttempt: 1,
  };

  it.each([
    [{ ...base, state: "REUSE", sessionId: "sess_1", sessionExpiresAt: "2026-10-24T15:15:00Z" }],
    [{ ...base, state: "CREATE", generation: 7, leaseUntil: "2026-10-24T15:15:00Z" }],
    [{ ...base, state: "LEASED" }],
    [{ ...base, state: "RETRY_REQUIRED", reason: "RESERVATION_EXPIRED" }],
  ])("accepts the documented shape %#", (payload) => {
    expect(toCheckoutSessionPlan(payload)).toMatchObject({ state: payload.state });
  });

  it.each([
    ["a missing payment identity", { state: "LEASED" }],
    ["an unknown state", { ...base, state: "MAYBE" }],
    ["an unknown retry reason", { ...base, state: "RETRY_REQUIRED", reason: "WHY_NOT" }],
    ["a resume without a session id", { ...base, state: "REUSE" }],
    ["a create without a generation", { ...base, state: "CREATE" }],
    ["a non-object", "LEASED"],
  ])("rejects %s instead of guessing", (_label, payload) => {
    expect(() => toCheckoutSessionPlan(payload)).toThrow(/checkout session/i);
  });
});

describe("POST /orders/{reference}/retry with ePayco", () => {
  it("pins the session to the NEW attempt reference", async () => {
    const sessions = sessionSpies({
      state: "CREATE",
      paymentId: "44444444-4444-4444-8444-444444444444",
      paymentReference: `${REFERENCE}-2`,
      paymentAttempt: 2,
      generation: 1,
    });
    const payments = {
      retryPayment: vi.fn().mockResolvedValue({
        orderId: ORDER.orderId,
        reference: REFERENCE,
        status: "PENDING",
        paymentAttempt: 2,
        wompiReference: `${REFERENCE}-2`,
        totalInCents: ORDER.totalInCents,
        currency: "COP",
        reservationExpiresAt: "2026-10-24T15:30:00.000Z",
      }),
    } as unknown as PaymentGateway;
    const orderStatus = {
      getOrderStatus: vi.fn().mockResolvedValue({ found: true, reference: REFERENCE }),
    } as unknown as OrderStatusGateway;
    const apify = apifyReturning("sess_attempt_2");

    const result = await handlePaymentRetry({
      reference: REFERENCE,
      email: "buyer@example.com",
      payments,
      orderStatus,
      checkoutSessions: sessions.gateway,
      config: epaycoConfig(),
      logger,
      clientIp: "203.0.113.10",
      epaycoApify: apify,
    });

    expect(sessions.begin).toHaveBeenCalledWith({ paymentReference: `${REFERENCE}-2` });
    expect(apify.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: `${REFERENCE}-2` }),
    );
    expect(result.checkout.sessionId).toBe("sess_attempt_2");
    expect(sessions.complete).toHaveBeenCalledWith({
      paymentReference: `${REFERENCE}-2`,
      generation: 1,
      sessionId: "sess_attempt_2",
    });
  });
});
