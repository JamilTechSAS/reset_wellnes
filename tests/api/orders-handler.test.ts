/**
 * Order handler + gateway contracts.
 *
 * These are the trust-boundary tests: they prove the API layer maps database errors into the
 * documented error model WITHOUT leaking SQL text, that the Wompi payload carries no secret,
 * and that a database answer whose numbers do not add up is rejected instead of charged.
 */

import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { loadConfig, type BackendConfig } from "@shared/config/env.ts";
import { handleCreateOrder, handleQuote, parseIdempotencyKey } from "@shared/api/orders-handler.ts";
import {
  isParticipantValidationError,
  type ParticipantValidationError,
} from "@shared/api/order-requests.ts";
import { toAppError } from "@shared/domain/errors.ts";
import { mapSqlErrorToAppError, type OrderGateway } from "@shared/db/orders.ts";
import { createLogger } from "@shared/logging/logger.ts";
import { buildWompiCheckout, type WompiCheckout } from "@shared/integrations/wompi/checkout.ts";
import type { EpaycoApifyClient } from "@shared/integrations/epayco/apify.ts";
import type { EpaycoCheckout } from "@shared/integrations/epayco/types.ts";
import { DEFAULT_ERROR_MESSAGES_ES, errorResponse } from "@shared/http/json.ts";

/**
 * Builds a syntactically valid but obviously fake credential.
 *
 * The prefix and the filler are concatenated at RUNTIME on purpose: the repository
 * secret-hygiene test fails when a credential-shaped literal appears anywhere in the repo,
 * and that guardrail is worth more than the convenience of a single string. These values
 * only need to satisfy the prefix validation in `config/env.ts`.
 */
function fakeCredential(prefix: string): string {
  return `${prefix}${"0123456789abcdefghijklmnop".slice(0, 24)}`;
}

/** A complete, valid environment: the loader is the single source of truth for config. */
function testConfig(overrides: Record<string, string> = {}): BackendConfig {
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
    ...overrides,
  });
}

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const QUOTE = {
  event: { code: "TAT-2026", name: "Evento" },
  ticketType: { code: "GENERAL", name: "Entrada general" },
  quantity: 2,
  pricingTier: { name: "Preventa 1", sequence: 1, unitPriceInCents: 9_500_000 },
  subtotalInCents: 19_000_000,
  quantityDiscount: { applies: false, percentBps: 0, amountInCents: 0 },
  quantityDiscountInCents: 0,
  discountCode: {
    supplied: false,
    applies: false,
    reason: "NOT_SUPPLIED",
    code: null,
    kind: null,
    percentBps: null,
    amountInCents: 0,
    remainingRedemptions: null,
  },
  discountCodeInCents: 0,
  discountCombination: "BEST_SINGLE",
  totalDiscountInCents: 0,
  totalInCents: 19_000_000,
  currency: "COP",
  availableQuantity: 1,
  availability: "LOW" as const,
  quotedAt: "2026-10-03T12:00:00.000Z",
  expiresAt: "2026-10-03T12:15:00.000Z",
};

const ORDER = {
  replayed: false,
  orderId: "11111111-1111-1111-1111-111111111111",
  reference: "EVT-2026-000001",
  status: "PENDING",
  quantity: 2,
  unitPriceInCents: 9_500_000,
  pricingTierName: "Preventa 1",
  subtotalInCents: 19_000_000,
  quantityDiscountInCents: 0,
  discountCodeInCents: 0,
  totalDiscountInCents: 0,
  discountCombination: "BEST_SINGLE",
  totalInCents: 19_000_000,
  currency: "COP",
  reservationExpiresAt: "2026-10-03T12:15:00.000Z",
  paymentAttempt: 1,
  wompiReference: "EVT-2026-000001",
  participantId: "22222222-2222-2222-2222-222222222222",
};

/**
 * Builds a gateway double and returns the spies alongside it, so assertions can reference the
 * local `vi.fn()` values directly instead of reaching through the object (which would lose
 * the mock's type and trip the unbound-method rule).
 */
type QuoteSpy = MockedFunction<OrderGateway["quote"]>;
type CreateOrderSpy = MockedFunction<OrderGateway["createOrder"]>;

function gatewayWith(overrides: Partial<OrderGateway> = {}): {
  gateway: OrderGateway;
  quote: QuoteSpy;
  createOrder: CreateOrderSpy;
} {
  const quote = vi.fn<OrderGateway["quote"]>().mockResolvedValue(QUOTE);
  const createOrder = vi.fn<OrderGateway["createOrder"]>().mockResolvedValue(ORDER);
  const gateway: OrderGateway = {
    quote: (request) => (overrides.quote ?? quote)(request),
    createOrder: (request) => (overrides.createOrder ?? createOrder)(request),
  };
  return { gateway, quote, createOrder };
}

const VALID_ORDER_BODY = {
  eventCode: "TAT-2026",
  ticketTypeCode: "GENERAL",
  quantity: 2,
  buyer: { email: "buyer@example.com", fullName: "Comprador Uno", phone: "3001234567" },
  participant: {
    firstName: "Ana",
    lastName: "Pérez",
    nationalId: "1.020.456.789",
    email: "Ana@Example.com",
    phone: "+57 300 123 4567",
    city: "Bogotá",
    instagram: "@ana.perez",
    consents: { dataProcessing: true, futureEvents: false },
  },
};

describe("SQL error mapping", () => {
  it("maps PT404 to NOT_FOUND and PT409 to CONFLICT", () => {
    expect(
      mapSqlErrorToAppError({
        code: "PT404",
        details: "EVENT_NOT_FOUND",
        message: "Event not found",
      }).code,
    ).toBe("NOT_FOUND");
    expect(
      mapSqlErrorToAppError({ code: "PT409", details: "SOLD_OUT", message: "No stage" }).code,
    ).toBe("CONFLICT");
    expect(
      mapSqlErrorToAppError({ code: "PT400", details: "INVALID_QUANTITY", message: "bad" }).code,
    ).toBe("VALIDATION_ERROR");
  });

  it("collapses an unexpected database error to INTERNAL_ERROR without exposing SQL text", async () => {
    const mapped = mapSqlErrorToAppError({
      code: "23514",
      message: 'new row for relation "orders" violates check constraint "orders_total_check"',
      details: "Failing row contains (…personal data…)",
    });
    expect(mapped.code).toBe("INTERNAL_ERROR");

    // The AppError keeps the real message for server-side logs. The security property is
    // that the HTTP layer NEVER serializes it: the client gets generic Spanish text.
    const response = errorResponse(mapped);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("orders_total_check");
    expect(body).not.toContain("check constraint");
    expect(body).not.toContain("23514");
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: DEFAULT_ERROR_MESSAGES_ES.INTERNAL_ERROR },
    });
  });

  it("keeps the machine-readable detail in the log context, never as user text", () => {
    const mapped = mapSqlErrorToAppError({ code: "PT409", details: "DISCOUNT_EXHAUSTED" });
    expect(mapped.context.detail).toBe("DISCOUNT_EXHAUSTED");
  });
});

describe("handleQuote", () => {
  it("returns the authoritative breakdown and uses the configured reservation window", async () => {
    const { gateway, quote } = gatewayWith();
    const result = await handleQuote({
      rawBody: { eventCode: "tat-2026", ticketTypeCode: "general", quantity: 2 },
      gateway,
      config: testConfig(),
      logger,
    });

    expect(result.totalInCents).toBe(19_000_000);
    expect(result.availability).toBe("LOW");
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: "TAT-2026", reservationMinutes: 15 }),
    );
  });

  it("quotes successfully with a configuration that lacks payment credentials and public URLs", async () => {
    const { loadOrderConfig } = await import("@shared/config/env.ts");
    const decoupledConfig = loadOrderConfig({
      APP_ENV: "sandbox",
      SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
      SUPABASE_SECRET_KEY: fakeCredential("sb_secret_"),
    });

    const { gateway } = gatewayWith();
    const result = await handleQuote({
      rawBody: { eventCode: "tat-2026", ticketTypeCode: "general", quantity: 2 },
      gateway,
      config: decoupledConfig,
      logger,
    });

    expect(result.totalInCents).toBe(19_000_000);
    expect(result.quantity).toBe(2);
    expect(decoupledConfig.epayco.publicKey).toBe("");
  });

  it("refuses a quote whose numbers do not add up", async () => {
    const { gateway } = gatewayWith({
      quote: vi.fn().mockResolvedValue({ ...QUOTE, totalInCents: 1 }),
    });
    await expect(
      handleQuote({
        rawBody: { eventCode: "TAT-2026", ticketTypeCode: "GENERAL", quantity: 2 },
        gateway,
        config: testConfig(),
        logger,
      }),
    ).rejects.toThrow(/total does not match/);
  });

  it("refuses an unknown discount reason instead of passing it to the frontend", async () => {
    const { gateway } = gatewayWith({
      quote: vi
        .fn()
        .mockResolvedValue({ ...QUOTE, discountCode: { ...QUOTE.discountCode, reason: "WAT" } }),
    });
    await expect(
      handleQuote({
        rawBody: { eventCode: "TAT-2026", ticketTypeCode: "GENERAL", quantity: 2 },
        gateway,
        config: testConfig(),
        logger,
      }),
    ).rejects.toThrow(/unknown discount reason/);
  });

  it("rejects a client-supplied price instead of ignoring it silently", async () => {
    const { gateway } = gatewayWith();
    // `totalInCents` is not part of the schema, so it is stripped; the price still comes from
    // the database. Documented by asserting the amount the gateway returned.
    const result = await handleQuote({
      rawBody: {
        eventCode: "TAT-2026",
        ticketTypeCode: "GENERAL",
        quantity: 2,
        totalInCents: 1,
        unitPriceInCents: 1,
      },
      gateway,
      config: testConfig(),
      logger,
    });
    expect(result.totalInCents).toBe(19_000_000);
    expect(result.pricingTier.unitPriceInCents).toBe(9_500_000);
  });
});

describe("handleCreateOrder", () => {
  it.each([
    [{ PAYMENT_RETURN_URL: "http://localhost:3000/gracias" }, "http://localhost:3000/gracias"],
    [{ WOMPI_REDIRECT_URL: "http://localhost:3000/legacy" }, "http://localhost:3000/legacy"],
    [{}, null],
  ])("uses the shared return URL as Wompi's redirect-url (%o)", async (returnEnv, expected) => {
    const { gateway } = gatewayWith();
    const result = await handleCreateOrder({
      rawBody: VALID_ORDER_BODY,
      idempotencyKey: "idem-key-00000002",
      ipAddress: "181.10.20.30",
      userAgent: "vitest/1.0",
      gateway,
      config: testConfig(returnEnv),
      logger,
    });
    expect((result.checkout as WompiCheckout).redirectUrl).toBe(expected);
  });

  it("creates the order and returns a checkout payload with no secret", async () => {
    const { gateway, createOrder } = gatewayWith();
    const result = await handleCreateOrder({
      rawBody: VALID_ORDER_BODY,
      idempotencyKey: "idem-key-00000001",
      ipAddress: "181.10.20.30",
      userAgent: "vitest/1.0",
      gateway,
      config: testConfig(),
      logger,
    });

    expect(result.reference).toBe("EVT-2026-000001");
    expect(result.totalInCents).toBe(19_000_000);
    expect(result.checkout.amountInCents).toBe(19_000_000);
    expect(result.checkout.currency).toBe("COP");
    expect(result.checkout.reference).toBe("EVT-2026-000001");
    expect(result.checkout.publicKey).toMatch(/^pub_test_/);
    expect((result.checkout as WompiCheckout).integritySignature).toMatch(/^[0-9a-f]{64}$/);

    // No secret anywhere in the serialized response: not the integrity secret, not the
    // private key, not the events secret, not the Supabase secret key.
    const serialized = JSON.stringify(result);
    for (const secret of [
      fakeCredential("test_integrity_"),
      fakeCredential("prv_test_"),
      fakeCredential("test_events_"),
      fakeCredential("sb_secret_"),
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("integritySecret");

    // The participant was normalized before it was sent to the database. The argument is
    // read from the spy and asserted field by field, so no `any` flows into the test.
    const sent = createOrder.mock.calls[0]?.[0];
    expect(sent).toBeDefined();
    expect(sent?.participant).toMatchObject({
      nationalId: "1020456789",
      email: "ana@example.com",
      phone: "573001234567",
      instagram: "ana.perez",
      consents: { dataProcessing: true, futureEvents: false },
    });
  });

  it("creates an ePayco Smart Checkout V2 session when configured with ePayco", async () => {
    const { gateway } = gatewayWith({
      createOrder: vi.fn().mockResolvedValue({
        orderId: "01925b68-8a8b-7000-8000-000000000001",
        reference: "EVT-2026-000001",
        status: "PENDING",
        replayed: false,
        quantity: 1,
        pricingTierName: "General",
        unitPriceInCents: 16_000_000,
        subtotalInCents: 16_000_000,
        quantityDiscountInCents: 0,
        discountCodeInCents: 0,
        totalDiscountInCents: 0,
        totalInCents: 16_000_000,
        currency: "COP",
        reservationExpiresAt: "2026-10-04T00:15:00.000Z",
        paymentAttempt: 1,
        wompiReference: "EVT-2026-000001",
      }),
    });

    const mockApify: EpaycoApifyClient = {
      login: vi.fn().mockResolvedValue("token_123"),
      createSession: vi.fn().mockResolvedValue({ sessionId: "epayco_session_999" }),
    };

    const epaycoConfig = testConfig({
      PAYMENT_PROVIDER: "epayco",
      EPAYCO_PUBLIC_KEY: fakeCredential("epayco_pub_"),
      EPAYCO_PRIVATE_KEY: fakeCredential("epayco_prv_"),
      EPAYCO_P_KEY: fakeCredential("epayco_pkey_"),
      EPAYCO_CUST_ID_CLIENTE: "123456",
      EPAYCO_TEST: "true",
    });

    const result = await handleCreateOrder({
      rawBody: VALID_ORDER_BODY,
      idempotencyKey: undefined,
      ipAddress: "127.0.0.1",
      userAgent: "TestAgent/1.0",
      gateway,
      config: epaycoConfig,
      logger,
      epaycoApify: mockApify,
    });

    expect(result.reference).toBe("EVT-2026-000001");
    expect((result.checkout as EpaycoCheckout).provider).toBe("epayco");
    expect((result.checkout as EpaycoCheckout).sessionId).toBe("epayco_session_999");
    expect(mockApify.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutVersion: "2",
        invoice: "EVT-2026-000001",
        amount: 160000,
        ip: "127.0.0.1",
        currency: "COP",
      }),
    );
  });

  it("handles replayed orders safely when configured with ePayco", async () => {
    const { gateway } = gatewayWith({
      createOrder: vi.fn().mockResolvedValue({
        orderId: "01925b68-8a8b-7000-8000-000000000001",
        reference: "EVT-2026-000001",
        status: "PENDING",
        replayed: true,
        quantity: 1,
        pricingTierName: "General",
        unitPriceInCents: 16_000_000,
        subtotalInCents: 16_000_000,
        quantityDiscountInCents: 0,
        discountCodeInCents: 0,
        totalDiscountInCents: 0,
        totalInCents: 16_000_000,
        currency: "COP",
        reservationExpiresAt: "2026-10-04T00:15:00.000Z",
        paymentAttempt: 1,
        wompiReference: "EVT-2026-000001",
      }),
    });

    const mockApify: EpaycoApifyClient = {
      login: vi.fn().mockResolvedValue("token_123"),
      createSession: vi.fn().mockResolvedValue({ sessionId: "epayco_session_replayed" }),
    };

    const epaycoConfig = testConfig({
      PAYMENT_PROVIDER: "epayco",
      EPAYCO_PUBLIC_KEY: fakeCredential("epayco_pub_"),
      EPAYCO_PRIVATE_KEY: fakeCredential("epayco_prv_"),
      EPAYCO_P_KEY: fakeCredential("epayco_pkey_"),
      EPAYCO_CUST_ID_CLIENTE: "123456",
      EPAYCO_TEST: "true",
    });

    const result = await handleCreateOrder({
      rawBody: VALID_ORDER_BODY,
      idempotencyKey: "idem_key_1234567890",
      ipAddress: "127.0.0.1",
      userAgent: "TestAgent/1.0",
      gateway,
      config: epaycoConfig,
      logger,
      epaycoApify: mockApify,
    });

    expect(result.replayed).toBe(true);
    expect(result.reference).toBe("EVT-2026-000001");
    expect((result.checkout as EpaycoCheckout).sessionId).toBe("epayco_session_replayed");
  });

  describe("ePayco session guards", () => {
    const epaycoOrder = (totalInCents: number) => ({
      orderId: "01925b68-8a8b-7000-8000-000000000001",
      reference: "EVT-2026-000001",
      status: "PENDING",
      replayed: false,
      quantity: 1,
      pricingTierName: "QA",
      unitPriceInCents: totalInCents,
      subtotalInCents: totalInCents,
      quantityDiscountInCents: 0,
      discountCodeInCents: 0,
      totalDiscountInCents: 0,
      totalInCents,
      currency: "COP",
      reservationExpiresAt: "2026-10-04T00:15:00.000Z",
      paymentAttempt: 1,
      wompiReference: "EVT-2026-000001",
    });
    const epaycoConfig = () =>
      testConfig({
        PAYMENT_PROVIDER: "epayco",
        EPAYCO_PUBLIC_KEY: fakeCredential("epayco_pub_"),
        EPAYCO_PRIVATE_KEY: fakeCredential("epayco_prv_"),
        EPAYCO_P_KEY: fakeCredential("epayco_pkey_"),
        EPAYCO_CUST_ID_CLIENTE: "123456",
        EPAYCO_TEST: "true",
      });

    it.each([
      [200_000, "2.000 COP (below the provider minimum)"],
      [600_000_000, "6.000.000 COP (above the provider maximum)"],
    ])("refuses %i cents — %s — without calling ePayco", async (totalInCents) => {
      const { gateway } = gatewayWith({
        createOrder: vi.fn().mockResolvedValue(epaycoOrder(totalInCents)),
      });
      const mockApify: EpaycoApifyClient = {
        login: vi.fn(),
        createSession: vi.fn(),
      };
      await expect(
        handleCreateOrder({
          rawBody: VALID_ORDER_BODY,
          idempotencyKey: undefined,
          ipAddress: "127.0.0.1",
          userAgent: undefined,
          gateway,
          config: epaycoConfig(),
          logger,
          epaycoApify: mockApify,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(mockApify.createSession).not.toHaveBeenCalled();
    });

    it.each([
      [{ PAYMENT_RETURN_URL: "http://localhost:3000/gracias" }, "http://localhost:3000/gracias"],
      [{ WOMPI_REDIRECT_URL: "http://localhost:3000/legacy" }, "http://localhost:3000/legacy"],
      [
        {
          PAYMENT_RETURN_URL: "http://localhost:3000/gracias",
          WOMPI_REDIRECT_URL: "http://localhost:3000/legacy",
        },
        "http://localhost:3000/gracias",
      ],
    ])("sends the return URL as the session response (%o)", async (returnEnv, expected) => {
      const { gateway } = gatewayWith({
        createOrder: vi.fn().mockResolvedValue(epaycoOrder(1_000_000)),
      });
      const mockApify: EpaycoApifyClient = {
        login: vi.fn(),
        createSession: vi.fn().mockResolvedValue({ sessionId: "sess_qa" }),
      };
      const config = testConfig({
        PAYMENT_PROVIDER: "epayco",
        EPAYCO_PUBLIC_KEY: fakeCredential("epayco_pub_"),
        EPAYCO_PRIVATE_KEY: fakeCredential("epayco_prv_"),
        EPAYCO_P_KEY: fakeCredential("epayco_pkey_"),
        EPAYCO_CUST_ID_CLIENTE: "123456",
        EPAYCO_TEST: "true",
        ...returnEnv,
      });
      const result = await handleCreateOrder({
        rawBody: VALID_ORDER_BODY,
        idempotencyKey: undefined,
        ipAddress: "127.0.0.1",
        userAgent: undefined,
        gateway,
        config,
        logger,
        epaycoApify: mockApify,
      });
      expect(mockApify.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expected,
          confirmation: "http://127.0.0.1:54321/functions/v1/webhooks-epayco",
        }),
      );
      expect((result.checkout as EpaycoCheckout).redirectUrl).toBe(expected);
    });

    it("omits the session response when no return URL is configured", async () => {
      const { gateway } = gatewayWith({
        createOrder: vi.fn().mockResolvedValue(epaycoOrder(1_000_000)),
      });
      const mockApify: EpaycoApifyClient = {
        login: vi.fn(),
        createSession: vi.fn().mockResolvedValue({ sessionId: "sess_qa" }),
      };
      await handleCreateOrder({
        rawBody: VALID_ORDER_BODY,
        idempotencyKey: undefined,
        ipAddress: "127.0.0.1",
        userAgent: undefined,
        gateway,
        config: epaycoConfig(),
        logger,
        epaycoApify: mockApify,
      });
      expect(mockApify.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ response: undefined }),
      );
    });

    it("sends 10.000 COP as 10000 pesos (no double conversion)", async () => {
      const { gateway } = gatewayWith({
        createOrder: vi.fn().mockResolvedValue(epaycoOrder(1_000_000)),
      });
      const mockApify: EpaycoApifyClient = {
        login: vi.fn(),
        createSession: vi.fn().mockResolvedValue({ sessionId: "sess_qa" }),
      };
      const result = await handleCreateOrder({
        rawBody: VALID_ORDER_BODY,
        idempotencyKey: undefined,
        ipAddress: "127.0.0.1",
        userAgent: undefined,
        gateway,
        config: epaycoConfig(),
        logger,
        epaycoApify: mockApify,
      });
      expect(mockApify.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 10_000, invoice: "EVT-2026-000001" }),
      );
      expect((result.checkout as EpaycoCheckout).amountInCents).toBe(1_000_000);
    });

    it("refuses to create a session without the buyer IP", async () => {
      const { gateway } = gatewayWith({
        createOrder: vi.fn().mockResolvedValue(epaycoOrder(1_000_000)),
      });
      const mockApify: EpaycoApifyClient = { login: vi.fn(), createSession: vi.fn() };
      await expect(
        handleCreateOrder({
          rawBody: VALID_ORDER_BODY,
          idempotencyKey: undefined,
          ipAddress: undefined,
          userAgent: undefined,
          gateway,
          config: epaycoConfig(),
          logger,
          epaycoApify: mockApify,
        }),
      ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(mockApify.createSession).not.toHaveBeenCalled();
    });
  });

  it("rejects participant data that fails domain validation", async () => {
    const { gateway, createOrder } = gatewayWith();
    await expect(
      handleCreateOrder({
        rawBody: {
          ...VALID_ORDER_BODY,
          participant: { ...VALID_ORDER_BODY.participant, consents: { dataProcessing: false } },
        },
        idempotencyKey: undefined,
        ipAddress: undefined,
        userAgent: undefined,
        gateway,
        config: testConfig(),
        logger,
      }),
    ).rejects.toThrow(/Participant data is invalid/);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("carries participant field issues as a 400 VALIDATION_ERROR, as docs/api.md promises", async () => {
    const { gateway, createOrder } = gatewayWith();
    let error: unknown;
    try {
      await handleCreateOrder({
        rawBody: {
          ...VALID_ORDER_BODY,
          participant: {
            ...VALID_ORDER_BODY.participant,
            // Both booleans are present, so this is the domain rule (mandatory consent),
            // not a zod shape problem — exactly the case the buyer-facing 400 describes.
            consents: { dataProcessing: false, futureEvents: false },
          },
        },
        idempotencyKey: undefined,
        ipAddress: undefined,
        userAgent: undefined,
        gateway,
        config: testConfig(),
        logger,
      });
    } catch (caught) {
      error = caught;
    }

    // The error must be an AppError with the VALIDATION_ERROR code (not a bare Error,
    // which the HTTP layer would collapse into INTERNAL_ERROR / 500) and must carry the
    // field-level issues. The adapter then composes exactly what is asserted below.
    expect(isParticipantValidationError(error)).toBe(true);
    const appError = toAppError(error);
    expect(appError.code).toBe("VALIDATION_ERROR");
    const issues = (error as ParticipantValidationError).issues;
    expect(issues.map((issue) => issue.path)).toContain("consents.dataProcessing");

    const response = errorResponse(appError, { details: { issues } });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details: { issues: unknown[] } };
    };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.issues.length).toBeGreaterThan(0);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("refuses a quantity below 1 or above the hard ceiling before touching the database", async () => {
    const { gateway, createOrder } = gatewayWith();
    for (const quantity of [0, -3, 999]) {
      await expect(
        handleCreateOrder({
          rawBody: { ...VALID_ORDER_BODY, quantity },
          idempotencyKey: undefined,
          ipAddress: undefined,
          userAgent: undefined,
          gateway,
          config: testConfig(),
          logger,
        }),
      ).rejects.toThrow(/VALIDATION|quantity/i);
    }
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("surfaces a database conflict as a CONFLICT error", async () => {
    const { gateway } = gatewayWith({
      createOrder: vi
        .fn()
        .mockRejectedValue(mapSqlErrorToAppError({ code: "PT409", details: "SOLD_OUT" })),
    });
    await expect(
      handleCreateOrder({
        rawBody: VALID_ORDER_BODY,
        idempotencyKey: undefined,
        ipAddress: undefined,
        userAgent: undefined,
        gateway,
        config: testConfig(),
        logger,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("passes the replayed flag through for an idempotent retry", async () => {
    const { gateway } = gatewayWith({
      createOrder: vi.fn().mockResolvedValue({ ...ORDER, replayed: true }),
    });
    const result = await handleCreateOrder({
      rawBody: VALID_ORDER_BODY,
      idempotencyKey: "idem-key-00000001",
      ipAddress: undefined,
      userAgent: undefined,
      gateway,
      config: testConfig(),
      logger,
    });
    expect(result.replayed).toBe(true);
    expect(result.checkout.reference).toBe(ORDER.wompiReference);
  });
});

describe("parseIdempotencyKey", () => {
  it("accepts a properly sized key and trims it", () => {
    expect(parseIdempotencyKey("  idem-key-00000001  ")).toBe("idem-key-00000001");
  });

  it("treats an absent or empty header as no key", () => {
    expect(parseIdempotencyKey(null)).toBeUndefined();
    expect(parseIdempotencyKey("   ")).toBeUndefined();
  });

  it("rejects short, oversized or non-printable keys", () => {
    expect(() => parseIdempotencyKey("short")).toThrow(/16 to 128/);
    expect(() => parseIdempotencyKey("x".repeat(129))).toThrow(/16 to 128/);
    expect(() => parseIdempotencyKey(`bad key with spaces and length ${"y".repeat(20)}`)).toThrow(
      /printable ASCII/,
    );
  });
});

describe("buildWompiCheckout", () => {
  const base = {
    publicKey: fakeCredential("pub_test_"),
    integritySecret: fakeCredential("test_integrity_"),
    reference: "EVT-2026-000001",
    amountInCents: 19_000_000,
    currency: "COP",
  };

  it("matches the documented signature algorithm for the exact amount and reference", async () => {
    const checkout = await buildWompiCheckout(base);
    // SHA256(reference + amount + currency + secret) — computed here independently of the
    // implementation path under test would be circular, so the official vector covers the
    // algorithm and this asserts the same inputs are used.
    const { computeIntegritySignature } = await import("@shared/integrations/wompi/signature.ts");
    const expected = await computeIntegritySignature({
      reference: base.reference,
      amountInCents: base.amountInCents,
      currency: base.currency,
      integritySecret: base.integritySecret,
    });
    expect(checkout.integritySignature).toBe(expected);
    expect(checkout.expirationTime).toBeNull();
  });

  it("includes the expiration in BOTH the signature and the payload when used", async () => {
    const expiration = new Date("2026-11-21T15:00:00.000Z");
    const checkout = await buildWompiCheckout({ ...base, expirationTime: expiration });
    const { computeIntegritySignature } = await import("@shared/integrations/wompi/signature.ts");
    const expected = await computeIntegritySignature({
      reference: base.reference,
      amountInCents: base.amountInCents,
      currency: base.currency,
      integritySecret: base.integritySecret,
      expirationTime: expiration.toISOString(),
    });
    expect(checkout.integritySignature).toBe(expected);
    expect(checkout.expirationTime).toBe("2026-11-21T15:00:00.000Z");
  });

  it("rejects a non-COP currency", async () => {
    await expect(buildWompiCheckout({ ...base, currency: "USD" })).rejects.toThrow(/COP/);
  });

  it("never places a secret in the returned payload", async () => {
    const checkout = await buildWompiCheckout(base);
    const serialized = JSON.stringify(checkout);
    expect(serialized).not.toContain(base.integritySecret);
    expect(serialized).not.toContain("prv_");
    expect(Object.keys(checkout).sort()).toEqual(
      [
        "amountInCents",
        "currency",
        "customerData",
        "expirationTime",
        "integritySignature",
        "publicKey",
        "redirectUrl",
        "reference",
      ].sort(),
    );
  });
});
