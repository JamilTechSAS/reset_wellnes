/**
 * Phase 6B test fixtures and a controllable `TicketingApi` double.
 *
 * The doubles return REAL response shapes (copied from `docs/api.md` and `src/api/types.ts`),
 * so a test failure means the frontend mishandled a real contract — not that a mock drifted.
 * Nothing here fabricates a success the backend would not produce: every fixture is an
 * explicit argument of the test that uses it.
 */

import { vi, type Mock } from "vitest";
import type {
  AttachedParticipant,
  CreatedOrder,
  EpaycoCheckout,
  OrderStatus,
  PaymentHint,
  PublicAvailability,
  PublicEvent,
  Quote,
  RetriedPayment,
  WompiCheckout,
} from "../../../src/api/types.ts";
import type { CreateOrderInput, TicketingApi } from "../../../src/api/ticketing.ts";

export const TEST_EVENT_CODE = "RESET-SUNSET-2026";
export const TEST_TICKET_TYPE_CODE = "GENERAL";
export const TEST_BUYER_EMAIL = "ana@example.com";

export function makeEvent(overrides: Partial<PublicEvent["event"]> = {}): PublicEvent {
  return {
    found: true,
    event: {
      code: TEST_EVENT_CODE,
      name: "Re set Sunset — Vol. 1",
      description:
        "Todas las experiencias del día, activaciones de marcas, kit de bienvenida y espacios para compartir y conectar.",
      status: "PUBLISHED",
      startsAt: "2026-11-15T18:00:00.000Z",
      endsAt: "2026-11-16T00:00:00.000Z",
      timezone: "America/Bogota",
      currency: "COP",
      // The client did not supply a street address: the fixture keeps it null rather than
      // inventing one (the frontend must never render a made-up location).
      venue: { name: "Terraza del hotel GHL", address: null, city: "Montería" },
      ...overrides,
    },
    sales: {
      currency: "COP",
      salesOpen: true,
      availability: "AVAILABLE",
      ticketTypes: [
        {
          code: TEST_TICKET_TYPE_CODE,
          name: "Entrada general",
          description: null,
          minPerOrder: 1,
          maxPerOrder: 4,
          salesOpen: true,
          availability: "AVAILABLE",
          currentTier: { name: "Preventa", sequence: 1, priceInCents: 16_000_000 },
        },
      ],
    },
  };
}

export function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    event: { code: TEST_EVENT_CODE, name: "Re set Sunset — Vol. 1" },
    ticketType: { code: TEST_TICKET_TYPE_CODE, name: "Entrada general" },
    quantity: 1,
    pricingTier: { name: "Preventa", sequence: 1, unitPriceInCents: 16_000_000 },
    subtotalInCents: 16_000_000,
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
    discountCombination: "NONE",
    totalDiscountInCents: 0,
    totalInCents: 16_000_000,
    currency: "COP",
    availability: "AVAILABLE",
    availableQuantity: 40,
    expiresAt: "2026-10-05T20:15:00.000Z",
    ...overrides,
  };
}

export function makeCheckout(overrides: Partial<WompiCheckout> = {}): WompiCheckout {
  return {
    publicKey: "pub_test_fixture_key",
    currency: "COP",
    amountInCents: 16_000_000,
    reference: "EVT-2026-000001-1",
    integritySignature: "fixture-integrity-signature",
    expirationTime: "2026-10-05T20:15:00.000Z",
    redirectUrl: "http://localhost:3000/gracias",
    customerData: {
      email: TEST_BUYER_EMAIL,
      fullName: "Ana Pérez",
      phoneNumber: "3001234567",
      phoneNumberPrefix: "+57",
    },
    ...overrides,
  };
}

export function makeEpaycoCheckout(overrides: Partial<EpaycoCheckout> = {}): EpaycoCheckout {
  return {
    provider: "epayco",
    sessionId: "fixture-epayco-session-123",
    publicKey: "epayco_pub_fixture_key",
    test: true,
    reference: "EVT-2026-000001",
    amountInCents: 16_000_000,
    currency: "COP",
    redirectUrl: "http://localhost:3000/gracias",
    confirmationUrl: "http://localhost:3000/functions/v1/webhooks-epayco",
    customerData: {
      email: TEST_BUYER_EMAIL,
      fullName: "Ana Pérez",
      phoneNumber: "3001234567",
      phoneNumberPrefix: "+57",
    },
    ...overrides,
  };
}

export function makeCreatedOrder(overrides: Partial<CreatedOrder> = {}): CreatedOrder {
  return {
    reference: "EVT-2026-000001",
    status: "PENDING",
    replayed: false,
    quantity: 1,
    pricingTierName: "Preventa",
    unitPriceInCents: 16_000_000,
    subtotalInCents: 16_000_000,
    quantityDiscountInCents: 0,
    discountCodeInCents: 0,
    totalDiscountInCents: 0,
    totalInCents: 16_000_000,
    currency: "COP",
    reservationExpiresAt: "2026-10-05T20:15:00.000Z",
    paymentAttempt: 1,
    // ePayco is the only provider the site sells with, so it is the fixture default too.
    checkout: makeEpaycoCheckout(),
    ...overrides,
  };
}

export function makeOrderStatus(overrides: Partial<OrderStatus> = {}): OrderStatus {
  return {
    reference: "EVT-2026-000001",
    status: "PENDING",
    quantity: 1,
    totalInCents: 16_000_000,
    currency: "COP",
    createdAt: "2026-10-05T19:00:00.000Z",
    paidAt: null,
    reservationExpiresAt: "2026-10-05T20:15:00.000Z",
    payment: null,
    paymentAttempts: [],
    ...overrides,
  };
}

export function makePaidOrderStatus(overrides: Partial<OrderStatus> = {}): OrderStatus {
  return makeOrderStatus({
    status: "PAID",
    paidAt: "2026-10-05T19:05:00.000Z",
    payment: {
      attempt: 1,
      status: "approved",
      methodType: "CARD",
      statusMessage: null,
      approvedAt: "2026-10-05T19:05:00.000Z",
    },
    ...overrides,
  });
}

export function makeAttachedParticipant(
  overrides: Partial<AttachedParticipant> = {},
): AttachedParticipant {
  return {
    orderReference: "EVT-2026-000001",
    unit: 2,
    participant: {
      participantId: "44444444-4444-4444-8444-444444444444",
      firstName: "Beto",
      lastName: "Gómez",
    },
    consents: {
      dataProcessing: true,
      futureEvents: false,
      policyVersion: "v1",
      capturedAt: "2026-10-05T19:06:00.000Z",
    },
    remainingUnassigned: 0,
    ...overrides,
  };
}

export function makeRetriedPayment(overrides: Partial<RetriedPayment> = {}): RetriedPayment {
  return {
    reference: "EVT-2026-000001",
    status: "PENDING",
    paymentAttempt: 2,
    totalInCents: 16_000_000,
    currency: "COP",
    reservationExpiresAt: "2026-10-05T20:20:00.000Z",
    checkout: makeEpaycoCheckout({ reference: "EVT-2026-000001-2" }),
    ...overrides,
  };
}

export function makePaymentHint(overrides: Partial<PaymentHint> = {}): PaymentHint {
  return {
    orderReference: "EVT-2026-000001",
    orderStatus: "PAID",
    paymentStatus: "approved",
    outcome: "APPROVED_APPLIED",
    ...overrides,
  };
}

/**
 * The spy-backed API. Each spy keeps the production signature (derived from `TicketingApi`),
 * so a test cannot configure a promise of the wrong shape by accident, and the controller
 * cannot tell the double apart from the real client.
 */
export type FakeTicketingApi = {
  [K in keyof TicketingApi]: TicketingApi[K] extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : never;
};

/**
 * Builds a `TicketingApi` whose every method is an observable spy. Each spy is pre-loaded with
 * the happy-path answer of its endpoint, so a test overrides only the endpoint it is about and
 * an unexpected call still fails a specific assertion rather than crashing on `undefined`.
 */
export function createFakeApi(): FakeTicketingApi {
  const api: FakeTicketingApi = {
    getEvent: vi.fn<(code: string, signal?: AbortSignal) => Promise<PublicEvent>>(),
    getAvailability: vi.fn<(code: string, signal?: AbortSignal) => Promise<PublicAvailability>>(),
    quote:
      vi.fn<
        (input: Parameters<TicketingApi["quote"]>[0], signal?: AbortSignal) => Promise<Quote>
      >(),
    createOrder: vi.fn<(input: CreateOrderInput, signal?: AbortSignal) => Promise<CreatedOrder>>(),
    getOrderStatus:
      vi.fn<
        (reference: string, buyerEmail: string, signal?: AbortSignal) => Promise<OrderStatus>
      >(),
    retryPayment:
      vi.fn<
        (reference: string, buyerEmail: string, signal?: AbortSignal) => Promise<RetriedPayment>
      >(),
    sendPaymentHint:
      vi.fn<
        (
          reference: string,
          buyerEmail: string,
          transactionId: string,
          signal?: AbortSignal,
        ) => Promise<PaymentHint>
      >(),
    attachParticipant:
      vi.fn<
        (
          reference: string,
          buyerEmail: string,
          participant: Parameters<TicketingApi["attachParticipant"]>[2],
          signal?: AbortSignal,
        ) => Promise<AttachedParticipant>
      >(),
  };

  api.getEvent.mockResolvedValue(makeEvent());
  api.getAvailability.mockResolvedValue({
    found: true,
    code: TEST_EVENT_CODE,
    sales: makeEvent().sales,
  });
  api.quote.mockResolvedValue(makeQuote());
  api.createOrder.mockResolvedValue(makeCreatedOrder());
  api.getOrderStatus.mockResolvedValue(makeOrderStatus());
  api.retryPayment.mockResolvedValue(makeRetriedPayment());
  api.sendPaymentHint.mockResolvedValue(makePaymentHint());
  api.attachParticipant.mockResolvedValue(makeAttachedParticipant());

  return api;
}

/** Narrowing helper so tests can read the arguments a spy received without casts. */
export function firstCreateOrderInput(api: FakeTicketingApi): CreateOrderInput {
  const call = api.createOrder.mock.calls[0];
  if (call === undefined) {
    throw new Error("createOrder was never called");
  }
  return call[0];
}

/** In-memory `KeyValueStore` with an inspectable map. */
export function createMemoryStore(seed: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(seed));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
    entries,
  };
}

/** A stored pending order, as `submit` writes it. */
export function pendingOrderEntry(
  reference = "EVT-2026-000001",
  buyerEmail = TEST_BUYER_EMAIL,
): Record<string, string> {
  return {
    "ticket:pending-order:v1": JSON.stringify({
      reference,
      buyerEmail,
      attempt: 1,
      createdAt: "2026-10-05T19:00:00.000Z",
    }),
  };
}

/** A stored form draft: the buyer's typed data, never the consents. */
export function draftEntry(quantity = 1): Record<string, string> {
  return {
    "ticket:purchase-draft:v1": JSON.stringify({
      quantity,
      discountCode: "",
      participant: {
        firstName: "Ana",
        lastName: "Pérez",
        nationalId: "1023456789",
        email: TEST_BUYER_EMAIL,
        phone: "3001234567",
        city: "Bogotá",
        instagram: "anap",
      },
    }),
  };
}
