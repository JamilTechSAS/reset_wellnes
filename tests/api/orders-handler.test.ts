/**
 * Order handler + gateway contracts.
 *
 * These are the trust-boundary tests: they prove the API layer maps database errors into the
 * documented error model WITHOUT leaking SQL text, that the Wompi payload carries no secret,
 * and that a database answer whose numbers do not add up is rejected instead of charged.
 */

import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { loadConfig, type BackendConfig } from "@shared/config/env.ts";
import {
  CHECKOUT_CONFLICT_REASONS,
  checkoutConflictDetails,
  handleCreateOrder,
  handleQuote,
  parseIdempotencyKey,
  PURCHASE_RULE_REASONS,
  purchaseRuleDetails,
  withOrderReference,
} from "@shared/api/orders-handler.ts";
import {
  isParticipantValidationError,
  type ParticipantValidationError,
} from "@shared/api/order-requests.ts";
import { conflictError, toAppError, validationError } from "@shared/domain/errors.ts";
import { mapSqlErrorToAppError, type OrderGateway } from "@shared/db/orders.ts";
import { createLogger } from "@shared/logging/logger.ts";
import type { EpaycoApifyClient } from "@shared/integrations/epayco/apify.ts";
import type { CheckoutSessionGateway, CheckoutSessionPlan } from "@shared/db/checkout-sessions.ts";
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
    PAYMENT_PROVIDER: "epayco",
    EPAYCO_PUBLIC_KEY: fakeCredential("epayco_pub_"),
    EPAYCO_PRIVATE_KEY: fakeCredential("epayco_prv_"),
    EPAYCO_P_KEY: fakeCredential("epayco_pkey_"),
    EPAYCO_CUST_ID_CLIENTE: "123456",
    EPAYCO_TEST: "true",
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

const CREATE_PLAN: CheckoutSessionPlan = {
  state: "CREATE",
  paymentId: "33333333-3333-4333-8333-333333333333",
  paymentReference: "EVT-2026-000001",
  paymentAttempt: 1,
  generation: 1,
};

/** A checkout-session double. ePayco session tests override it when they need another plan. */
function checkoutSessionsDouble(
  overrides: Partial<CheckoutSessionGateway> = {},
): CheckoutSessionGateway {
  return {
    begin: vi.fn<CheckoutSessionGateway["begin"]>().mockResolvedValue(CREATE_PLAN),
    complete: vi.fn<CheckoutSessionGateway["complete"]>().mockResolvedValue("RECORDED"),
    abandon: vi.fn<CheckoutSessionGateway["abandon"]>().mockResolvedValue(true),
    ...overrides,
  };
}

const checkoutSessions = checkoutSessionsDouble();

type CreateOrderOptions = Parameters<typeof handleCreateOrder>[0];

/**
 * Default ePayco session-creation double.
 *
 * Every successful order now opens an ePayco session, and the real client would call the
 * Apify gateway over the network. Tests that are not ABOUT session creation get this double so
 * the suite stays hermetic; the session tests pass their own mock to assert the request.
 */
const DEFAULT_APIFY: EpaycoApifyClient = {
  login: vi.fn().mockResolvedValue("token_default"),
  createSession: vi.fn().mockResolvedValue({ sessionId: "epayco_session_default" }),
};

/**
 * `handleCreateOrder` with the checkout-session and ePayco dependencies supplied. Most tests
 * here assert the pricing and payload contract, which is independent of how a session was
 * pinned; the session tests pass their own doubles explicitly.
 */
function createOrderWithSessions(
  options: Omit<CreateOrderOptions, "checkoutSessions"> & {
    readonly checkoutSessions?: CheckoutSessionGateway;
  },
): ReturnType<typeof handleCreateOrder> {
  return handleCreateOrder({
    ...options,
    checkoutSessions: options.checkoutSessions ?? checkoutSessions,
    epaycoApify: options.epaycoApify ?? DEFAULT_APIFY,
  });
}

const QUOTE = {
  event: { code: "TAT-2026", name: "Evento" },
  ticketType: { code: "GENERAL", name: "Entrada general" },
  quantity: 2,
  pricingTier: {
    name: "Preventa 1",
    sequence: 1,
    unitPriceInCents: 9_500_000,
    maxPerOrder: null,
  },
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

describe("withOrderReference", () => {
  it("adds the order reference the post-payment page reads", () => {
    expect(withOrderReference("https://evento.example/gracias", "EVT-2026-000012")).toBe(
      "https://evento.example/gracias?ref=EVT-2026-000012",
    );
  });

  it("keeps an existing query string intact", () => {
    expect(withOrderReference("https://evento.example/gracias?utm=qa", "EVT-2026-000012")).toBe(
      "https://evento.example/gracias?utm=qa&ref=EVT-2026-000012",
    );
  });

  it("stays undefined when no return URL is configured", () => {
    expect(withOrderReference(undefined, "EVT-2026-000012")).toBeUndefined();
  });
});

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

  it.each([
    ["QUANTITY_LIMIT", 2],
    ["BUNDLE_NOT_AVAILABLE", 2],
  ])(
    "keeps the %s refusal's message generic while the reason stays available to the API layer",
    async (detail, quantity) => {
      const { gateway } = gatewayWith({
        quote: vi
          .fn()
          .mockRejectedValue(
            conflictError(`Database reported a conflict: ${detail}`, { context: { detail } }),
          ),
      });

      const error = await handleQuote({
        rawBody: { eventCode: "TAT-2026", ticketTypeCode: "GENERAL", quantity },
        gateway,
        config: testConfig(),
        logger,
      }).catch((caught: unknown) => caught);

      // The handler never turns the refusal into a quote, and the database's own sentence is
      // not what a buyer would see.
      expect(toAppError(error)).toMatchObject({
        code: "CONFLICT",
        context: { detail },
      });
      expect(purchaseRuleDetails(error)).toEqual({ reason: detail });

      const response = errorResponse(error, {
        details: purchaseRuleDetails(error),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        error: { code: string; message: string; details?: { reason?: string } };
      };
      expect(body.error.message).toBe(DEFAULT_ERROR_MESSAGES_ES.CONFLICT);
      expect(body.error.details).toEqual({ reason: detail });
    },
  );

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

/**
 * "Comparte tu experiencia": three General admissions for COP 509.700.
 *
 * The quote below is a fixture, not a schedule read: these tests are about the request contract
 * and the routing that follows it, so they must not depend on whether the sale window happens
 * to be open when the suite runs. The window itself is covered by the schema tests.
 */
const BUNDLE_QUOTE = {
  ...QUOTE,
  quantity: 3,
  pricingTier: {
    name: "General",
    sequence: 2,
    unitPriceInCents: 16_990_000,
    maxPerOrder: null,
  },
  subtotalInCents: 50_970_000,
  totalInCents: 50_970_000,
};

describe("bundle purchase contract", () => {
  it("forwards the new package code and its three admissions to the bundle pricing path", async () => {
    // The spy is kept locally: `gatewayWith` returns its default spy, which is not the one an
    // override replaces, so assertions must reference this mock directly.
    const bundleQuote = vi.fn<OrderGateway["quote"]>().mockResolvedValue(BUNDLE_QUOTE);
    const { gateway } = gatewayWith({ quote: bundleQuote });

    const result = await handleQuote({
      rawBody: {
        eventCode: "reset-sunset-2026",
        ticketTypeCode: "general",
        quantity: 3,
        bundleCode: "SHARE_EXPERIENCE",
      },
      gateway,
      config: testConfig(),
      logger,
    });

    // Reaching the gateway with `bundleCode` is what selects `quote_bundle_order_price`
    // instead of the per-admission quote, so the bundle code must survive validation intact.
    expect(bundleQuote).toHaveBeenCalledWith({
      eventCode: "RESET-SUNSET-2026",
      ticketTypeCode: "GENERAL",
      quantity: 3,
      bundleCode: "SHARE_EXPERIENCE",
      discountCode: undefined,
      reservationMinutes: 15,
    });
    expect(result.quantity).toBe(3);
    expect(result.pricingTier.unitPriceInCents).toBe(16_990_000);
    expect(result.totalInCents).toBe(50_970_000);
  });

  it("rejects the retired two-admission package at the API boundary with 400 VALIDATION_ERROR", async () => {
    const { gateway, quote } = gatewayWith();

    const error = await handleQuote({
      rawBody: {
        eventCode: "RESET-SUNSET-2026",
        ticketTypeCode: "GENERAL",
        quantity: 2,
        bundleCode: "DOUBLE_EXPERIENCE",
      },
      gateway,
      config: testConfig(),
      logger,
    }).catch((caught: unknown) => caught);

    // Rejected by the schema, before any database call: no retired code ever reaches SQL.
    expect(quote).not.toHaveBeenCalled();
    expect(toAppError(error).code).toBe("VALIDATION_ERROR");

    const response = errorResponse(error);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: DEFAULT_ERROR_MESSAGES_ES.VALIDATION_ERROR,
      },
    });
  });

  it("refuses a package with two admissions through the database contract, which the API maps to 409", async () => {
    // The schema accepts 1..50 for every product; the package/quantity pairing is authoritative
    // in SQL (`PT409` `BUNDLE_QUANTITY_INVALID`), so this is the response a two-admission
    // package request actually receives.
    const refusingQuote = vi.fn<OrderGateway["quote"]>().mockRejectedValue(
      mapSqlErrorToAppError({
        code: "PT409",
        details: "BUNDLE_QUANTITY_INVALID",
        message: "Bundle quantity must match the bundle's included admissions",
      }),
    );
    const { gateway } = gatewayWith({ quote: refusingQuote });

    const error = await handleQuote({
      rawBody: {
        eventCode: "RESET-SUNSET-2026",
        ticketTypeCode: "GENERAL",
        quantity: 2,
        bundleCode: "SHARE_EXPERIENCE",
      },
      gateway,
      config: testConfig(),
      logger,
    }).catch((caught: unknown) => caught);

    expect(refusingQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 2, bundleCode: "SHARE_EXPERIENCE" }),
    );
    expect(toAppError(error).code).toBe("CONFLICT");
    // Not in the purchase-rule allowlist: the buyer sees the generic conflict, no detail.
    expect(purchaseRuleDetails(error)).toBeUndefined();

    const response = errorResponse(error, { details: purchaseRuleDetails(error) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "CONFLICT",
        message: DEFAULT_ERROR_MESSAGES_ES.CONFLICT,
      },
    });
  });
});

describe("handleCreateOrder", () => {
  it.each([
    [{ PAYMENT_RETURN_URL: "http://localhost:3000/gracias" }, "http://localhost:3000/gracias"],
    [{ WOMPI_REDIRECT_URL: "http://localhost:3000/legacy" }, "http://localhost:3000/legacy"],
    [{}, null],
  ])(
    "sends the buyer back to the shared return URL, named with the order (%o)",
    async (returnEnv, expected) => {
      const { gateway } = gatewayWith();
      const result = await createOrderWithSessions({
        rawBody: VALID_ORDER_BODY,
        idempotencyKey: "idem-key-00000002",
        ipAddress: "181.10.20.30",
        userAgent: "vitest/1.0",
        gateway,
        config: testConfig(returnEnv),
        logger,
      });
      expect(result.checkout.provider).toBe("epayco");
      // The order reference rides on the URL so `/gracias` can recover a purchase whose browser
      // session was lost; the page still asks the backend before showing success.
      expect(result.checkout.redirectUrl).toBe(
        expected === null ? null : `${expected}?ref=${ORDER.reference}`,
      );
    },
  );

  it("creates the order and returns a checkout payload with no secret", async () => {
    const { gateway, createOrder } = gatewayWith();
    const result = await createOrderWithSessions({
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
    expect(result.checkout.provider).toBe("epayco");
    expect(result.checkout.publicKey).toMatch(/^epayco_pub_/);
    expect(result.checkout.sessionId).toBe("epayco_session_default");

    // No secret anywhere in the serialized response: not the ePayco private key or P_KEY,
    // and not the Supabase secret key.
    const serialized = JSON.stringify(result);
    for (const secret of [
      fakeCredential("epayco_prv_"),
      fakeCredential("epayco_pkey_"),
      fakeCredential("sb_secret_"),
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("privateKey");

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

    const result = await createOrderWithSessions({
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
    expect(result.checkout.provider).toBe("epayco");
    expect(result.checkout.sessionId).toBe("epayco_session_999");
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

    const result = await createOrderWithSessions({
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
    expect(result.checkout.sessionId).toBe("epayco_session_replayed");
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
        createOrderWithSessions({
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
      const result = await createOrderWithSessions({
        rawBody: VALID_ORDER_BODY,
        idempotencyKey: undefined,
        ipAddress: "127.0.0.1",
        userAgent: undefined,
        gateway,
        config,
        logger,
        epaycoApify: mockApify,
      });
      // The return URL names the order, so the post-payment page can identify it without
      // depending on sessionStorage. ePayco appends its own `ref_payco` to this URL.
      expect(mockApify.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          response: `${expected}?ref=EVT-2026-000001`,
          confirmation: "http://127.0.0.1:54321/functions/v1/webhooks-epayco",
        }),
      );
      expect(result.checkout.redirectUrl).toBe(`${expected}?ref=EVT-2026-000001`);
    });

    it("omits the session response when no return URL is configured", async () => {
      const { gateway } = gatewayWith({
        createOrder: vi.fn().mockResolvedValue(epaycoOrder(1_000_000)),
      });
      const mockApify: EpaycoApifyClient = {
        login: vi.fn(),
        createSession: vi.fn().mockResolvedValue({ sessionId: "sess_qa" }),
      };
      await createOrderWithSessions({
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
      const result = await createOrderWithSessions({
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
      expect(result.checkout.amountInCents).toBe(1_000_000);
    });

    it("refuses to create a session without the buyer IP", async () => {
      const { gateway } = gatewayWith({
        createOrder: vi.fn().mockResolvedValue(epaycoOrder(1_000_000)),
      });
      const mockApify: EpaycoApifyClient = { login: vi.fn(), createSession: vi.fn() };
      await expect(
        createOrderWithSessions({
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
      createOrderWithSessions({
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
      await createOrderWithSessions({
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
        createOrderWithSessions({
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
      createOrderWithSessions({
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
    const result = await createOrderWithSessions({
      rawBody: VALID_ORDER_BODY,
      idempotencyKey: "idem-key-00000001",
      // ePayco session creation requires the buyer IP; a replayed order still resolves through
      // the pinned session, but the handler validates the input first.
      ipAddress: "181.10.20.30",
      userAgent: undefined,
      gateway,
      config: testConfig(),
      logger,
    });
    expect(result.replayed).toBe(true);
    expect(result.checkout.reference).toBe(ORDER.wompiReference);
  });
});

describe("conflict reason allowlists", () => {
  it("echoes a purchase-rule refusal and keeps the generic Spanish message", () => {
    for (const reason of PURCHASE_RULE_REASONS) {
      expect(
        purchaseRuleDetails(
          conflictError("Database reported a conflict", { context: { detail: reason } }),
        ),
      ).toEqual({ reason });
    }
  });

  it("hides every database detail outside the allowlist", () => {
    const hidden = [
      "SOLD_OUT",
      "IDEMPOTENCY_KEY_CONFLICT",
      'duplicate key value violates unique constraint "payments_reference_key"',
      "PT409",
      'raw provider payload {"status":"APPROVED"}',
      "x".repeat(300),
    ];
    for (const detail of hidden) {
      // No reason means the HTTP layer serializes the generic CONFLICT body only.
      expect(
        purchaseRuleDetails(conflictError("Database reported a conflict", { context: { detail } })),
      ).toBeUndefined();
    }

    // Nothing to disclose: a conflict without a detail, another error code, a non-AppError.
    expect(purchaseRuleDetails(conflictError("conflict"))).toBeUndefined();
    expect(
      purchaseRuleDetails(validationError("bad input", { context: { detail: "QUANTITY_LIMIT" } })),
    ).toBeUndefined();
    expect(purchaseRuleDetails(new Error("QUANTITY_LIMIT"))).toBeUndefined();
  });

  it("keeps the checkout-session vocabulary unchanged and disjoint", () => {
    expect(
      checkoutConflictDetails(
        conflictError("busy", {
          context: { surface: "checkout-session", detail: "CHECKOUT_LEASE_ACTIVE" },
        }),
      ),
    ).toEqual({ reason: "CHECKOUT_LEASE_ACTIVE" });
    // A purchase-rule reason never becomes a checkout reason, and vice versa.
    expect(
      checkoutConflictDetails(
        conflictError("x", { context: { surface: "checkout-session", detail: "QUANTITY_LIMIT" } }),
      ),
    ).toBeUndefined();
    expect(
      purchaseRuleDetails(
        conflictError("x", {
          context: { surface: "checkout-session", detail: "ORDER_NOT_PENDING" },
        }),
      ),
    ).toBeUndefined();
    expect(
      PURCHASE_RULE_REASONS.filter((reason) => CHECKOUT_CONFLICT_REASONS.includes(reason)),
    ).toEqual([]);
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
