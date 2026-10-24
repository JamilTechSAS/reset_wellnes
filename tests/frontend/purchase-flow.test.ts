/**
 * Phase 6B purchase flow (the controller state machine).
 *
 * This is where the buyer journey is decided, so the tests drive the real controller with a
 * fake `TicketingApi` and assert the properties the phase depends on:
 *   - prices and availability are always the backend's;
 *   - one intentional attempt creates at most one order (and one `Idempotency-Key`);
 *   - an ePayco handoff, and a payment hint, are never treated as proof of payment;
 *   - polling is bounded, stops on a terminal state, and stops on unmount;
 *   - a refresh or a repeated return re-reads the same order and never re-creates it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "../../src/api/client.ts";
import { loadFrontendConfig } from "../../src/config/env.ts";
import {
  createPurchaseController,
  type PurchaseController,
} from "../../src/purchase/controller.ts";
import type { EpaycoCheckout } from "../../src/api/types.ts";
import { parseReturnContext } from "../../src/purchase/return-route.ts";
import {
  createFakeApi,
  createMemoryStore,
  draftEntry,
  firstCreateOrderInput,
  makeCheckout,
  makeCreatedOrder,
  makeEpaycoCheckout,
  makeEvent,
  makeOrderStatus,
  makePaidOrderStatus,
  makePaymentHint,
  makeQuote,
  makeRetriedPayment,
  pendingOrderEntry,
  TEST_BUYER_EMAIL,
  TEST_EVENT_CODE,
  TEST_TICKET_TYPE_CODE,
  type FakeTicketingApi,
} from "./support/ticketing-fixtures.ts";

const TEST_CONFIG = loadFrontendConfig({});

type Env = {
  readonly api: FakeTicketingApi;
  readonly store: ReturnType<typeof createMemoryStore>;
  readonly clock: { now: number };
  readonly checkouts: { checkout: EpaycoCheckout; reference: string }[];
  readonly controller: PurchaseController;
};

let active: PurchaseController[] = [];

function setup(
  options: {
    readonly api?: FakeTicketingApi;
    readonly seed?: Record<string, string>;
    readonly polling?: { readonly intervalMs?: number; readonly maxDurationMs?: number };
  } = {},
): Env {
  const api = options.api ?? createFakeApi();
  const store = createMemoryStore(options.seed);
  const clock = { now: Date.parse("2026-10-05T19:00:00.000Z") };
  const checkouts: { checkout: EpaycoCheckout; reference: string }[] = [];
  const controller = createPurchaseController({
    config: TEST_CONFIG,
    api,
    store,
    now: () => clock.now,
    onCheckout: (checkout, reference) => {
      checkouts.push({ checkout, reference });
    },
    ...(options.polling === undefined ? {} : { polling: options.polling }),
  });
  active.push(controller);
  return { api, store, clock, checkouts, controller };
}

/** Advances the injected clock AND the fake timers together (the controller reads both). */
async function advance(env: Env, ms: number): Promise<void> {
  env.clock.now += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

/** Flushes the in-flight promises of a fire-and-forget poll without moving time. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** A filled form: the buyer's data comes from the restored draft, the consent from the buyer. */
async function reachReview(env: Env): Promise<void> {
  await env.controller.start();
  env.controller.setField("dataProcessing", true);
  await env.controller.requestQuote();
}

beforeEach(() => {
  vi.useFakeTimers();
  active = [];
});

afterEach(() => {
  for (const controller of active) {
    controller.dispose();
  }
  vi.useRealTimers();
});

describe("loading the event", () => {
  it("opens the form with the backend's availability and current price", async () => {
    const env = setup();
    await env.controller.start();

    const state = env.controller.getState();
    expect(state.step).toBe("form");
    expect(state.event?.event.name).toBe("Re set Sunset — Vol. 1");
    expect(state.availability).toBe("AVAILABLE");
    expect(env.api.getEvent).toHaveBeenCalledWith(TEST_EVENT_CODE, expect.anything());
  });

  it("restores what the buyer had typed, but never a consent", async () => {
    const env = setup({ seed: draftEntry(2) });
    await env.controller.start();

    const state = env.controller.getState();
    expect(state.quantity).toBe(2);
    expect(state.participant.firstName).toBe("Ana");
    expect(state.participant.email).toBe(TEST_BUYER_EMAIL);
    expect(state.participant.dataProcessing).toBe(false);
    expect(state.participant.futureEvents).toBe(false);
  });

  it("closes the sale when the ticket type is sold out", async () => {
    const api = createFakeApi();
    const base = makeEvent();
    api.getEvent.mockResolvedValue({
      ...base,
      sales: {
        ...base.sales,
        availability: "SOLD_OUT",
        ticketTypes: [{ ...base.sales.ticketTypes[0]!, availability: "SOLD_OUT" }],
      },
    });
    const env = setup({ api });
    await env.controller.start();

    const state = env.controller.getState();
    expect(state.step).toBe("closed");
    expect(state.problem?.kind).toBe("sold_out");
    expect(state.problem?.canRetry).toBe(false);
  });

  it("closes the sale when the ticket type is not on sale yet", async () => {
    const api = createFakeApi();
    const base = makeEvent();
    api.getEvent.mockResolvedValue({
      ...base,
      sales: {
        ...base.sales,
        salesOpen: false,
        ticketTypes: [{ ...base.sales.ticketTypes[0]!, salesOpen: false }],
      },
    });
    const env = setup({ api });
    await env.controller.start();

    expect(env.controller.getState().step).toBe("closed");
    expect(env.controller.getState().problem?.kind).toBe("sales_closed");
  });

  it("shows a friendly closed state for an unknown event without leaking the error code", async () => {
    const api = createFakeApi();
    api.getEvent.mockRejectedValue(
      new ApiError({ code: "NOT_FOUND", status: 404, message: "Event not found" }),
    );
    const env = setup({ api });
    await env.controller.start();

    const state = env.controller.getState();
    expect(state.step).toBe("closed");
    expect(state.problem?.title).toBe("Venta no disponible");
    expect(JSON.stringify(state.problem)).not.toContain("NOT_FOUND");
  });

  it("offers a retry when the backend fails transiently", async () => {
    const api = createFakeApi();
    api.getEvent.mockRejectedValue(
      new ApiError({ code: "INTERNAL_ERROR", status: 500, message: "boom" }),
    );
    const env = setup({ api });
    await env.controller.start();

    const state = env.controller.getState();
    expect(state.step).toBe("form");
    expect(state.problem?.kind).toBe("server");
    expect(state.problem?.canRetry).toBe(true);
    expect(JSON.stringify(state.problem)).not.toContain("boom");
  });

  it("reports a connection problem as such", async () => {
    const api = createFakeApi();
    api.getEvent.mockRejectedValue(new NetworkError("fetch failed"));
    const env = setup({ api });
    await env.controller.start();

    expect(env.controller.getState().problem?.kind).toBe("network");
    expect(env.controller.getState().problem?.canRetry).toBe(true);
  });
});

describe("quantity", () => {
  it("keeps the quantity inside the ticket type's limits", async () => {
    const env = setup();
    await env.controller.start();

    env.controller.setQuantity(99);
    expect(env.controller.getState().quantity).toBe(4);
    env.controller.setQuantity(0);
    expect(env.controller.getState().quantity).toBe(1);
    env.controller.setQuantity(2.7);
    expect(env.controller.getState().quantity).toBe(2);
  });

  it("invalidates a quote that no longer matches the basket", async () => {
    const env = setup({ seed: draftEntry(1) });
    await reachReview(env);
    expect(env.controller.getState().quote).not.toBeNull();

    env.controller.setQuantity(3);
    expect(env.controller.getState().quote).toBeNull();
  });
});

describe("server-side quote", () => {
  it("refuses to quote an incomplete form instead of guessing a price", async () => {
    const env = setup();
    await env.controller.start();
    await env.controller.requestQuote();

    const state = env.controller.getState();
    expect(state.step).toBe("form");
    expect(state.issues.length).toBeGreaterThan(0);
    expect(env.api.quote).not.toHaveBeenCalled();
  });

  it("shows the backend's authoritative total on the review step", async () => {
    const api = createFakeApi();
    api.quote.mockResolvedValue(
      makeQuote({
        quantity: 2,
        subtotalInCents: 19_000_000,
        quantityDiscount: { applies: true, percentBps: 500, amountInCents: 950_000 },
        quantityDiscountInCents: 950_000,
        totalDiscountInCents: 950_000,
        totalInCents: 18_050_000,
      }),
    );
    const env = setup({ api, seed: draftEntry(2) });
    await reachReview(env);

    const state = env.controller.getState();
    expect(state.step).toBe("review");
    expect(state.quote?.totalInCents).toBe(18_050_000);
    expect(env.api.quote).toHaveBeenCalledWith(
      { eventCode: TEST_EVENT_CODE, ticketTypeCode: TEST_TICKET_TYPE_CODE, quantity: 2 },
      expect.anything(),
    );
  });

  it("quotes Doble experiencia as a named two-admission product", async () => {
    const api = createFakeApi();
    const event = makeEvent();
    api.getEvent.mockResolvedValue({
      ...event,
      sales: {
        ...event.sales,
        ticketTypes: event.sales.ticketTypes.map((ticketType) => ({
          ...ticketType,
          currentTier: { name: "General", sequence: 2, priceInCents: 20_000_000 },
        })),
      },
    });
    api.quote.mockResolvedValue(
      makeQuote({
        quantity: 2,
        ticketType: { code: "DOUBLE_EXPERIENCE", name: "Doble experiencia" },
        pricingTier: { name: "General", sequence: 2, unitPriceInCents: 17_000_000 },
        subtotalInCents: 34_000_000,
        quantityDiscount: { applies: false, percentBps: 0, amountInCents: 0 },
        quantityDiscountInCents: 0,
        totalDiscountInCents: 0,
        totalInCents: 34_000_000,
      }),
    );
    const env = setup({ api, seed: draftEntry(1) });
    env.controller.setBundleCode("DOUBLE_EXPERIENCE");
    await reachReview(env);

    expect(env.controller.getState().quantity).toBe(2);
    expect(env.controller.getState().quote?.totalInCents).toBe(34_000_000);
    expect(env.api.quote).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: TEST_EVENT_CODE,
        ticketTypeCode: TEST_TICKET_TYPE_CODE,
        quantity: 2,
        bundleCode: "DOUBLE_EXPERIENCE",
      }),
      expect.anything(),
    );
    env.controller.setQuantity(4);
    expect(env.controller.getState().quantity).toBe(2);
  });

  it("sends the discount code and surfaces the backend's verdict on it", async () => {
    const api = createFakeApi();
    const event = makeEvent();
    api.getEvent.mockResolvedValue({
      ...event,
      sales: {
        ...event.sales,
        ticketTypes: event.sales.ticketTypes.map((ticketType) => ({
          ...ticketType,
          currentTier: { name: "General", sequence: 2, priceInCents: 20_000_000 },
        })),
      },
    });
    api.quote.mockResolvedValue(
      makeQuote({
        discountCode: {
          supplied: true,
          applies: false,
          reason: "EXPIRED",
          code: "VERANO",
          kind: "PERCENT",
          percentBps: 1000,
          amountInCents: 0,
          remainingRedemptions: null,
        },
      }),
    );
    const env = setup({ api, seed: draftEntry(1) });
    await env.controller.start();
    env.controller.setDiscountCode(" verano ");
    env.controller.setField("dataProcessing", true);
    await env.controller.requestQuote();

    expect(env.api.quote).toHaveBeenCalledWith(
      expect.objectContaining({ discountCode: "VERANO" }),
      expect.anything(),
    );
    expect(env.controller.getState().quote?.discountCode.reason).toBe("EXPIRED");
    // An unusable code never blocks the purchase: the review step is still reachable.
    expect(env.controller.getState().step).toBe("review");
  });

  it("stops the purchase when the backend reports the tickets sold out at quote time", async () => {
    const api = createFakeApi();
    api.quote.mockResolvedValue(makeQuote({ availability: "SOLD_OUT", availableQuantity: 0 }));
    const env = setup({ api, seed: draftEntry(1) });
    await reachReview(env);

    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.kind).toBe("sold_out");
    expect(state.problem?.canEditForm).toBe(true);
  });

  it("returns to the form with a useful problem when the quote fails", async () => {
    const api = createFakeApi();
    api.quote.mockRejectedValue(
      new ApiError({ code: "VALIDATION_ERROR", status: 400, message: "bad" }),
    );
    const env = setup({ api, seed: draftEntry(1) });
    await reachReview(env);

    const state = env.controller.getState();
    expect(state.step).toBe("form");
    expect(state.problem?.kind).toBe("validation");
    expect(state.issues).toEqual([]);
  });

  it("can go back to the form without losing what the buyer typed", async () => {
    const env = setup({ seed: draftEntry(1) });
    await reachReview(env);
    env.controller.backToForm();

    const state = env.controller.getState();
    expect(state.step).toBe("form");
    expect(state.participant.firstName).toBe("Ana");
    expect(state.quote).toBeNull();
  });

  it("re-quotes after the buyer edits their data, so the price always matches the basket", async () => {
    const env = setup({ seed: draftEntry(1) });
    await reachReview(env);
    expect(env.api.quote).toHaveBeenCalledTimes(1);

    env.controller.backToForm();
    await env.controller.requestQuote();

    expect(env.api.quote).toHaveBeenCalledTimes(2);
    expect(env.controller.getState().step).toBe("review");
  });
});

describe("order creation", () => {
  it("creates one order with a contract-valid idempotency key and hands the real checkout over", async () => {
    const api = createFakeApi();
    const order = makeCreatedOrder();
    api.createOrder.mockResolvedValue(order);
    const env = setup({ api, seed: draftEntry(1) });
    await reachReview(env);
    await env.controller.submit();

    expect(env.api.createOrder).toHaveBeenCalledTimes(1);
    const input = firstCreateOrderInput(api);
    expect(input.idempotencyKey).toMatch(/^order-[0-9a-f-]{36}$/);
    expect(input.quantity).toBe(1);
    expect(input.participant.consents).toEqual({ dataProcessing: true, futureEvents: false });
    expect(input.buyer.email).toBe(TEST_BUYER_EMAIL);
    expect(input.participant.nationalId).toBe("1023456789");

    // The checkout the browser opens is exactly the backend's ePayco session.
    expect(env.checkouts).toHaveLength(1);
    expect(env.checkouts[0]?.checkout).toEqual(order.checkout);
    expect(env.checkouts[0]?.checkout.sessionId).toBe("fixture-epayco-session-123");
    expect(env.checkouts[0]?.reference).toBe(order.reference);

    const state = env.controller.getState();
    expect(state.step).toBe("verifying");
    expect(state.reference).toBe(order.reference);
  });

  it("submits order with ePayco Smart Checkout V2 and transitions to verifying with sessionId", async () => {
    const epaycoCheckout = makeEpaycoCheckout();
    const order = makeCreatedOrder({ checkout: epaycoCheckout });
    const api = createFakeApi();
    api.createOrder.mockResolvedValue(order);
    const env = setup({ api, seed: draftEntry(1) });

    await reachReview(env);
    await env.controller.submit();

    expect(env.checkouts).toHaveLength(1);
    // The handoff carries the backend's ePayco session verbatim: provider, session id and test
    // flag all come from the server, never from the browser.
    expect(env.checkouts[0]?.checkout).toEqual(epaycoCheckout);
    expect(env.checkouts[0]?.reference).toBe(order.reference);

    const state = env.controller.getState();
    expect(state.step).toBe("verifying");
    expect(state.reference).toBe(order.reference);
  });

  it("polls ePayco order until confirmed when webhook marks order paid", async () => {
    const epaycoCheckout = makeEpaycoCheckout();
    const order = makeCreatedOrder({ checkout: epaycoCheckout });
    const paid = makePaidOrderStatus({ reference: order.reference });
    const api = createFakeApi();
    api.createOrder.mockResolvedValue(order);
    api.getOrderStatus.mockResolvedValue(paid);
    const polling = { intervalMs: 2_500, maxDurationMs: 30_000 };
    const env = setup({ api, seed: draftEntry(1), polling });

    await reachReview(env);
    await env.controller.submit();
    await settle();

    const state = env.controller.getState();
    expect(state.step).toBe("confirmed");
    expect(state.status?.status).toBe("PAID");
  });

  it("polls ePayco order and displays declined state when payment fails", async () => {
    const epaycoCheckout = makeEpaycoCheckout();
    const order = makeCreatedOrder({ checkout: epaycoCheckout });
    const failed = makeOrderStatus({ reference: order.reference, status: "FAILED" });
    const api = createFakeApi();
    api.createOrder.mockResolvedValue(order);
    api.getOrderStatus.mockResolvedValue(failed);
    const polling = { intervalMs: 2_500, maxDurationMs: 30_000 };
    const env = setup({ api, seed: draftEntry(1), polling });

    await reachReview(env);
    await env.controller.submit();
    await settle();

    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.kind).toBe("declined");
    expect(state.problem?.canRetryPayment).toBe(true);
  });

  it("never sends a price from the browser", async () => {
    const env = setup({ seed: draftEntry(1) });
    await reachReview(env);
    await env.controller.submit();

    const input = firstCreateOrderInput(env.api);
    const serialized = JSON.stringify(input);
    for (const forbidden of [
      "totalInCents",
      "unitPriceInCents",
      "amountInCents",
      "subtotalInCents",
      "integritySignature",
      "discountCodeInCents",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("creates a single order when the buyer double-clicks pay", async () => {
    const env = setup({ seed: draftEntry(1) });
    await reachReview(env);

    await Promise.all([env.controller.submit(), env.controller.submit(), env.controller.submit()]);

    expect(env.api.createOrder).toHaveBeenCalledTimes(1);
    expect(env.checkouts).toHaveLength(1);
  });

  it("reuses the same idempotency key when a failed attempt is retried", async () => {
    const api = createFakeApi();
    api.createOrder
      .mockRejectedValueOnce(new NetworkError("connection reset"))
      .mockResolvedValueOnce(makeCreatedOrder());
    const env = setup({ api, seed: draftEntry(1) });
    await reachReview(env);

    await env.controller.submit();
    expect(env.controller.getState().step).toBe("problem");
    expect(env.controller.getState().problem?.kind).toBe("network");

    await env.controller.submit();
    expect(env.api.createOrder).toHaveBeenCalledTimes(2);
    const [first, second] = api.createOrder.mock.calls;
    expect(second?.[0].idempotencyKey).toBe(first?.[0].idempotencyKey);
    expect(env.controller.getState().step).toBe("verifying");
  });

  it("maps backend field issues back onto the form", async () => {
    const api = createFakeApi();
    api.createOrder.mockRejectedValue(
      new ApiError({
        code: "VALIDATION_ERROR",
        status: 400,
        message: "Datos inválidos",
        issues: [
          { path: "nationalId", message: "La cédula ya está registrada." },
          { path: "consents.dataProcessing", message: "Consentimiento obligatorio." },
        ],
      }),
    );
    const env = setup({ api, seed: draftEntry(1) });
    await reachReview(env);
    await env.controller.submit();

    const state = env.controller.getState();
    expect(state.step).toBe("form");
    expect(state.issues).toEqual([
      { field: "nationalId", message: "La cédula ya está registrada." },
      { field: "dataProcessing", message: "Consentimiento obligatorio." },
    ]);
  });

  it("explains a conflict as tickets running out, and never claims a charge", async () => {
    const api = createFakeApi();
    api.createOrder.mockRejectedValue(
      new ApiError({ code: "CONFLICT", status: 409, message: "conflict" }),
    );
    const env = setup({ api, seed: draftEntry(1) });
    await reachReview(env);
    await env.controller.submit();

    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.kind).toBe("sold_out");
    expect(state.problem?.message).toContain("No se realizó ningún cobro");
    expect(JSON.stringify(state.problem)).not.toContain("409");
    expect(env.checkouts).toHaveLength(0);
  });

  it("adopts a replayed order as the same purchase, with no second handoff", async () => {
    const api = createFakeApi();
    const order = makeCreatedOrder({ replayed: true });
    api.createOrder.mockResolvedValue(order);
    const env = setup({ api, seed: draftEntry(1) });
    await reachReview(env);
    await env.controller.submit();
    // A second submit after the handoff is a no-op: the buyer is already on the way to Wompi.
    await env.controller.submit();

    expect(env.api.createOrder).toHaveBeenCalledTimes(1);
    expect(env.controller.getState().reference).toBe(order.reference);
    // Exactly one correlation for the return page, pointing at that one order.
    const stored = JSON.parse(env.store.getItem("ticket:pending-order:v1") ?? "{}") as {
      reference?: string;
    };
    expect(stored.reference).toBe(order.reference);
    expect(env.checkouts).toHaveLength(1);
  });

  it("gives a second purchase in the same session its own idempotency key", async () => {
    const api = createFakeApi();
    api.createOrder
      .mockResolvedValueOnce(makeCreatedOrder({ reference: "EVT-2026-000001" }))
      .mockResolvedValueOnce(makeCreatedOrder({ reference: "EVT-2026-000002", replayed: false }));
    const env = setup({ api, seed: draftEntry(1) });

    // First purchase.
    await reachReview(env);
    await env.controller.submit();
    await settle();
    expect(env.controller.getState().step).toBe("verifying");

    // The buyer closes the dialog and buys again later in the same session.
    env.controller.cancel();
    await env.controller.start();
    env.controller.setField("dataProcessing", true);
    await env.controller.requestQuote();
    await env.controller.submit();

    expect(api.createOrder).toHaveBeenCalledTimes(2);
    const [first, second] = api.createOrder.mock.calls;
    const firstKey = first?.[0].idempotencyKey;
    const secondKey = second?.[0].idempotencyKey;
    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();
    expect(secondKey).not.toBe(firstKey);
    expect(env.controller.getState().reference).toBe("EVT-2026-000002");
  });

  it("asks the backend for a quote when the buyer submits without one", async () => {
    const env = setup({ seed: draftEntry(1) });
    await env.controller.start();
    env.controller.setField("dataProcessing", true);
    await env.controller.submit();

    expect(env.api.quote).toHaveBeenCalledTimes(1);
    expect(env.api.createOrder).not.toHaveBeenCalled();
    expect(env.controller.getState().step).toBe("review");
  });
});

describe("payment truth", () => {
  const polling = { intervalMs: 100, maxDurationMs: 250 };

  it("never treats the ePayco handoff as proof of payment", async () => {
    const env = setup({ seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    const state = env.controller.getState();
    expect(env.checkouts).toHaveLength(1);
    expect(state.step).not.toBe("confirmed");
    expect(state.status?.status).toBe("PENDING");
    expect(state.reference).not.toBeNull();
    // The correlation stays in the session so a refresh can still find the order.
    expect(env.store.getItem("ticket:pending-order:v1")).not.toBeNull();
  });

  it("confirms only when the backend reports the order as paid", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    const state = env.controller.getState();
    expect(state.step).toBe("confirmed");
    expect(state.status?.status).toBe("PAID");
    expect(state.status?.paidAt).toBe("2026-10-05T19:05:00.000Z");
  });

  it("stops polling as soon as the order reaches a terminal state", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    const calls = api.getOrderStatus.mock.calls.length;
    await advance(env, 5_000);
    expect(api.getOrderStatus.mock.calls.length).toBe(calls);
  });

  it("keeps verifying while the payment is in flight, then reports that it is still in process", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "PENDING" }));
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    expect(env.controller.getState().step).toBe("verifying");
    await advance(env, 100);
    expect(api.getOrderStatus.mock.calls.length).toBeGreaterThan(1);
    expect(env.controller.getState().step).toBe("verifying");

    // Past the bounded window the flow stops asking and tells the buyer the truth.
    await advance(env, 400);
    expect(env.controller.getState().step).toBe("pending");
    expect(env.controller.getState().problem).toBeNull();

    const calls = api.getOrderStatus.mock.calls.length;
    await advance(env, 5_000);
    expect(api.getOrderStatus.mock.calls.length).toBe(calls);
  });

  it("maps a declined payment to an explanation with a safe retry", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(
      makeOrderStatus({
        status: "PENDING",
        payment: {
          attempt: 1,
          status: "declined",
          methodType: "CARD",
          statusMessage: "Fondos insuficientes",
          approvedAt: null,
        },
      }),
    );
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.kind).toBe("declined");
    expect(state.problem?.canRetryPayment).toBe(true);
    expect(state.problem?.message).toContain("no se realizó ningún cobro");
    // The provider's raw message is not shown to the buyer.
    expect(JSON.stringify(state.problem)).not.toContain("Fondos insuficientes");
  });

  it("maps a failed order to the declined explanation", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "FAILED" }));
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    expect(env.controller.getState().problem?.kind).toBe("declined");
    expect(env.controller.getState().problem?.canRetryPayment).toBe(true);
  });

  it("maps an expired reservation to a retryable problem", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "EXPIRED" }));
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.kind).toBe("expired");
    expect(state.problem?.canRetryPayment).toBe(true);
  });

  it("keeps the buyer on the verifying screen through a transient error and still confirms", async () => {
    const api = createFakeApi();
    api.getOrderStatus
      .mockRejectedValueOnce(new NetworkError("offline"))
      .mockRejectedValueOnce(new NetworkError("offline"))
      .mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    expect(env.controller.getState().step).toBe("verifying");
    await advance(env, 100);
    expect(env.controller.getState().step).toBe("verifying");
    await advance(env, 100);
    expect(env.controller.getState().step).toBe("confirmed");
  });

  it("ends on the pending screen instead of a scary error when every poll fails", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockRejectedValue(new NetworkError("offline"));
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await advance(env, 500);

    const state = env.controller.getState();
    expect(state.step).toBe("pending");
    expect(state.problem).toBeNull();
  });

  it("asks for the reference and email when the order is unknown", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockRejectedValue(
      new ApiError({ code: "NOT_FOUND", status: 404, message: "not found" }),
    );
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();

    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.kind).toBe("not_found");
    expect(JSON.stringify(state.problem)).not.toContain("NOT_FOUND");
  });

  it("retries the payment with a brand-new backend checkout", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "EXPIRED" }));
    const retry = makeRetriedPayment();
    api.retryPayment.mockResolvedValue(retry);
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();
    expect(env.controller.getState().problem?.kind).toBe("expired");

    // The retry starts a new attempt, so the previous idempotency key must not be reused.
    await env.controller.retryPayment();

    expect(env.api.retryPayment).toHaveBeenCalledWith(
      "EVT-2026-000001",
      TEST_BUYER_EMAIL,
      expect.anything(),
    );
    expect(env.checkouts).toHaveLength(2);
    expect(env.checkouts[1]?.checkout).toEqual(retry.checkout);
    // The order keeps its reference; the new attempt lives in the checkout payload's reference.
    expect(env.checkouts[1]?.reference).toBe("EVT-2026-000001");
    expect(env.checkouts[1]?.checkout.reference).toBe("EVT-2026-000001-2");
    expect(env.controller.getState().step).toBe("verifying");

    const stored = JSON.parse(env.store.getItem("ticket:pending-order:v1") ?? "{}") as {
      attempt?: number;
    };
    expect(stored.attempt).toBe(2);
  });

  it("explains a refused payment retry instead of calling it a sell-out", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "EXPIRED" }));
    api.retryPayment.mockRejectedValue(
      new ApiError({ code: "CONFLICT", status: 409, message: "not retryable" }),
    );
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await settle();
    await env.controller.retryPayment();

    const state = env.controller.getState();
    expect(state.problem?.kind).toBe("expired");
    expect(state.problem?.title).toBe("No pudimos iniciar un nuevo intento");
    expect(state.problem?.canRetryPayment).toBe(false);
    expect(state.problem?.message).not.toContain("cupos");
  });
});

describe("return, refresh and repeated returns", () => {
  const polling = { intervalMs: 100, maxDurationMs: 1_000 };

  it("resumes the stored order, nudges the backend with Wompi's id and reads the truth", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, seed: pendingOrderEntry(), polling });

    await env.controller.resumeReturn({ transactionId: "1234-5678-9012" });

    expect(api.sendPaymentHint).toHaveBeenCalledWith(
      "EVT-2026-000001",
      TEST_BUYER_EMAIL,
      "1234-5678-9012",
    );
    expect(api.getOrderStatus).toHaveBeenCalledWith(
      "EVT-2026-000001",
      TEST_BUYER_EMAIL,
      expect.anything(),
    );
    expect(env.controller.getState().step).toBe("confirmed");
  });

  it("loads the public event on resume, so the ticket header is the backend's event", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, seed: pendingOrderEntry(), polling });
    expect(api.getEvent).not.toHaveBeenCalled();

    await env.controller.resumeReturn({});

    expect(api.getEvent).toHaveBeenCalledWith(TEST_EVENT_CODE, expect.anything());
    expect(env.controller.getState().event?.event.name).toBe("Re set Sunset — Vol. 1");
    expect(env.controller.getState().step).toBe("confirmed");
  });

  it("still confirms when the resume-time event lookup fails", async () => {
    const api = createFakeApi();
    api.getEvent.mockRejectedValue(new NetworkError("offline"));
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, seed: pendingOrderEntry(), polling });

    await env.controller.resumeReturn({});

    expect(env.controller.getState().event).toBeNull();
    expect(env.controller.getState().step).toBe("confirmed");
  });

  it("does not confirm on the strength of a payment hint alone", async () => {
    const api = createFakeApi();
    api.sendPaymentHint.mockResolvedValue(
      makePaymentHint({ outcome: "APPROVED_APPLIED", orderStatus: "PAID" }),
    );
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "PENDING" }));
    const env = setup({ api, seed: pendingOrderEntry(), polling });

    await env.controller.resumeReturn({ transactionId: "1234-5678-9012" });
    await advance(env, 2_000);

    const state = env.controller.getState();
    expect(state.hintOutcome).toBe("APPROVED_APPLIED");
    expect(state.step).toBe("pending");
    expect(state.status?.status).toBe("PENDING");
  });

  it("forwards ePayco's ref_payco as a hint and stays pending until the backend confirms", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "PENDING" }));
    const env = setup({ api, seed: pendingOrderEntry(), polling });
    const { transactionId } = parseReturnContext(
      new URL("https://reset-wellnes-staging.vercel.app/gracias?ref_payco=987654"),
    );

    await env.controller.resumeReturn({ transactionId });
    await advance(env, 2_000);

    expect(api.sendPaymentHint).toHaveBeenCalledWith("EVT-2026-000001", TEST_BUYER_EMAIL, "987654");
    expect(env.controller.getState().step).toBe("pending");
  });

  it("does not send an ePayco hint when this browser has no stored order", async () => {
    const api = createFakeApi();
    const env = setup({ api });

    await env.controller.resumeReturn({ transactionId: "987654" });

    expect(api.sendPaymentHint).not.toHaveBeenCalled();
    expect(api.getOrderStatus).not.toHaveBeenCalled();
    expect(env.controller.getState().problem?.kind).toBe("not_found");
  });

  it("keeps working when the hint itself fails", async () => {
    const api = createFakeApi();
    api.sendPaymentHint.mockRejectedValue(
      new ApiError({ code: "UPSTREAM_ERROR", status: 502, message: "wompi down" }),
    );
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, seed: pendingOrderEntry(), polling });

    await env.controller.resumeReturn({ transactionId: "1234-5678-9012" });

    expect(env.controller.getState().hintOutcome).toBe("HINT_FAILED");
    expect(env.controller.getState().step).toBe("confirmed");
  });

  it("shows a refresh- or reopen-proof confirmation and never creates another order", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, seed: pendingOrderEntry(), polling });

    await env.controller.resumeReturn({});
    await env.controller.resumeReturn({});
    await advance(env, 500);

    expect(api.createOrder).not.toHaveBeenCalled();
    const state = env.controller.getState();
    expect(state.step).toBe("confirmed");
    expect(state.status?.reference).toBe("EVT-2026-000001");
  });

  it("re-reads the same order after a real page reload (new controller, same session)", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const first = setup({ api, seed: draftEntry(1), polling });
    await reachReview(first);
    await first.controller.submit();
    await settle();
    first.controller.dispose();

    // A reload: brand-new controller over the same sessionStorage, same backend.
    const second = setup({ api, seed: Object.fromEntries(first.store.entries), polling });
    await second.controller.resumeReturn({});

    expect(api.createOrder).toHaveBeenCalledTimes(1);
    expect(second.controller.getState().step).toBe("confirmed");
    expect(second.controller.getState().status?.status).toBe("PAID");
  });

  it("asks for the reference and email when this browser has no stored order", async () => {
    const env = setup();
    await env.controller.resumeReturn({});

    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.kind).toBe("not_found");
    expect(state.problem?.canRetry).toBe(false);
  });

  it("recovers a purchase from reference + email, normalizing both", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const env = setup({ api, polling });

    await env.controller.recoverOrder(" evt-2026-000001 ", " ANA@Example.com ");

    expect(api.getOrderStatus).toHaveBeenCalledWith(
      "EVT-2026-000001",
      "ana@example.com",
      expect.anything(),
    );
    expect(env.controller.getState().step).toBe("confirmed");
  });

  it("asks for both fields when the recovery form is submitted empty", async () => {
    const env = setup();
    await env.controller.recoverOrder("", "  ");

    expect(env.api.getOrderStatus).not.toHaveBeenCalled();
    const state = env.controller.getState();
    expect(state.problem?.title).toBe("Completa los datos");
    expect(state.problem?.message).toContain("referencia");
  });

  it("treats a wrong email exactly like an unknown reference (no enumeration)", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockRejectedValue(
      new ApiError({ code: "NOT_FOUND", status: 404, message: "not found" }),
    );
    const env = setup({ api, polling });

    await env.controller.recoverOrder("EVT-2026-000001", "otra@example.com");

    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.kind).toBe("not_found");
    expect(state.problem?.message).toContain("Verifica la referencia de la orden");
  });
});

describe("polling lifecycle", () => {
  const polling = { intervalMs: 100, maxDurationMs: 10_000 };

  it("does not keep polling after the flow is disposed", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "PENDING" }));
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await advance(env, 200);

    const calls = api.getOrderStatus.mock.calls.length;
    expect(calls).toBeGreaterThan(1);

    env.controller.dispose();
    await advance(env, 5_000);
    expect(api.getOrderStatus.mock.calls.length).toBe(calls);
  });

  it("stops polling when the buyer closes the dialog", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "PENDING" }));
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachReview(env);
    await env.controller.submit();
    await advance(env, 200);

    const calls = api.getOrderStatus.mock.calls.length;
    env.controller.cancel();
    await advance(env, 5_000);
    expect(api.getOrderStatus.mock.calls.length).toBe(calls);
  });

  it("runs a single polling loop even if the buyer refreshes twice", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makeOrderStatus({ status: "PENDING" }));
    const env = setup({ api, seed: pendingOrderEntry(), polling });

    await env.controller.resumeReturn({});
    const before = api.getOrderStatus.mock.calls.length;

    await Promise.all([env.controller.refreshStatus(), env.controller.refreshStatus()]);
    expect(api.getOrderStatus.mock.calls.length).toBe(before + 2);

    await advance(env, 100);
    expect(api.getOrderStatus.mock.calls.length).toBe(before + 3);

    await advance(env, 100);
    expect(api.getOrderStatus.mock.calls.length).toBe(before + 4);
  });

  it("notifies subscribers and stops after dispose", async () => {
    const env = setup({ seed: draftEntry(1) });
    const seen: string[] = [];
    const unsubscribe = env.controller.subscribe((state) => seen.push(state.step));

    await env.controller.start();
    env.controller.setField("dataProcessing", true);
    await env.controller.requestQuote();

    expect(seen).toContain("form");
    expect(seen).toContain("review");

    unsubscribe();
    const count = seen.length;
    env.controller.setQuantity(2);
    expect(seen.length).toBe(count);
  });
});

describe("companion (second admission) after a confirmed payment", () => {
  const polling = { intervalMs: 100, maxDurationMs: 1_000 };

  function fillCompanion(controller: PurchaseController): void {
    controller.setCompanionField("firstName", "Beto");
    controller.setCompanionField("lastName", "Gómez");
    controller.setCompanionField("nationalId", "987654321");
    controller.setCompanionField("email", "beto@example.com");
    controller.setCompanionField("phone", "3001112233");
    controller.setCompanionField("city", "Cali");
    controller.setCompanionField("dataProcessing", true);
  }

  async function reachConfirmed(env: Env, quantity: number): Promise<void> {
    await reachReview(env);
    await env.controller.submit();
    await settle();
    expect(env.controller.getState().step).toBe("confirmed");
    expect(env.controller.getState().status?.quantity).toBe(quantity);
  }

  it("attaches the companion of two regular General tickets to the PAID order", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(
      makePaidOrderStatus({ quantity: 2, totalInCents: 40_000_000 }),
    );
    const env = setup({ api, seed: draftEntry(2), polling });
    await reachConfirmed(env, 2);

    // The buyer's own participant occupies the first admission.
    expect(env.controller.getState().remainingAdmissions).toBe(1);

    fillCompanion(env.controller);
    await env.controller.submitCompanion();

    expect(api.attachParticipant).toHaveBeenCalledTimes(1);
    const [reference, buyerEmail, payload] = api.attachParticipant.mock.calls[0] ?? [];
    expect(reference).toBe("EVT-2026-000001");
    expect(buyerEmail).toBe(TEST_BUYER_EMAIL);
    expect(payload).toMatchObject({
      firstName: "Beto",
      lastName: "Gómez",
      nationalId: "987654321",
      email: "beto@example.com",
      city: "Cali",
      consents: { dataProcessing: true, futureEvents: false },
    });
    expect(payload).not.toHaveProperty("ticketToken");

    const state = env.controller.getState();
    expect(state.companionStatus).toBe("saved");
    expect(state.companionName).toBe("Beto Gómez");
    expect(state.remainingAdmissions).toBe(0);
  });

  it("works identically for the Doble experiencia bundle", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(
      makePaidOrderStatus({ quantity: 2, totalInCents: 34_000_000 }),
    );
    const env = setup({ api, seed: draftEntry(2), polling });
    env.controller.setBundleCode("DOUBLE_EXPERIENCE");
    await reachConfirmed(env, 2);
    expect(env.controller.getState().bundleCode).toBe("DOUBLE_EXPERIENCE");

    fillCompanion(env.controller);
    await env.controller.submitCompanion();

    expect(api.attachParticipant).toHaveBeenCalledTimes(1);
    expect(env.controller.getState().companionStatus).toBe("saved");
  });

  it("reports a fully assigned order without inventing a retry", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(
      makePaidOrderStatus({ quantity: 2, totalInCents: 40_000_000 }),
    );
    api.attachParticipant.mockRejectedValue(
      new ApiError({ code: "CONFLICT", status: 409, message: "no admission left" }),
    );
    const env = setup({ api, seed: draftEntry(2), polling });
    await reachConfirmed(env, 2);

    fillCompanion(env.controller);
    await env.controller.submitCompanion();

    const state = env.controller.getState();
    expect(state.companionStatus).toBe("unavailable");
    expect(state.companionError).toContain("todos sus participantes");
    expect(state.step).toBe("confirmed");
  });

  it("validates the companion before calling the backend", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(
      makePaidOrderStatus({ quantity: 2, totalInCents: 40_000_000 }),
    );
    const env = setup({ api, seed: draftEntry(2), polling });
    await reachConfirmed(env, 2);

    await env.controller.submitCompanion();

    const state = env.controller.getState();
    expect(state.companionStatus).toBe("idle");
    expect(state.companionIssues.length).toBeGreaterThan(0);
    expect(api.attachParticipant).not.toHaveBeenCalled();
  });

  it("does not offer a companion for a single admission", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus({ quantity: 1 }));
    const env = setup({ api, seed: draftEntry(1), polling });
    await reachConfirmed(env, 1);

    expect(env.controller.getState().remainingAdmissions).toBe(0);
    fillCompanion(env.controller);
    await env.controller.submitCompanion();
    expect(api.attachParticipant).not.toHaveBeenCalled();
  });

  it("never persists the companion's personal data", async () => {
    const api = createFakeApi();
    api.getOrderStatus.mockResolvedValue(
      makePaidOrderStatus({ quantity: 2, totalInCents: 40_000_000 }),
    );
    const env = setup({ api, seed: draftEntry(2), polling });
    await reachConfirmed(env, 2);
    fillCompanion(env.controller);

    const stored = [...env.store.entries.values()].join("\n");
    expect(stored).not.toContain("beto@example.com");
    expect(stored).not.toContain("987654321");
  });
});

describe("payment provider", () => {
  it("refuses to open a checkout that is not ePayco", async () => {
    const api = createFakeApi();
    api.createOrder.mockResolvedValue(makeCreatedOrder({ checkout: makeCheckout() }));
    const env = setup({ api, seed: draftEntry(1) });

    await reachReview(env);
    await env.controller.submit();

    expect(env.checkouts).toHaveLength(0);
    const state = env.controller.getState();
    expect(state.step).toBe("problem");
    expect(state.problem?.title).toBe("Pasarela de pago no disponible");
    // The order exists, so the buyer can still look it up with the reference.
    expect(env.store.getItem("ticket:pending-order:v1")).not.toBeNull();
  });
});
