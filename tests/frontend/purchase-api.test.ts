/**
 * Phase 6B HTTP layer: the envelope contract, timeouts and aborts, plus the exact headers and
 * bodies each buyer-journey endpoint must send.
 *
 * The assertions are deliberately about the wire: an `Idempotency-Key` that is missing, a
 * `X-Buyer-Email` that the backend requires, or a discount code sent as `undefined` are all
 * silent failures in a click-through, but break the frozen contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AbortError,
  ApiError,
  NetworkError,
  createApiClient,
  type RequestOptions,
} from "../../src/api/client.ts";
import { createTicketingApi } from "../../src/api/ticketing.ts";
import type { ApiClient } from "../../src/api/client.ts";
import {
  makeAttachedParticipant,
  makeEpaycoCheckout,
  makePaidOrderStatus,
} from "./support/ticketing-fixtures.ts";

type FetchCall = { readonly url: string; readonly init: RequestInit | undefined };
type HeaderBag = Record<string, string>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch double that records every call and answers with the queued body. */
function recordingFetch(
  body: unknown,
  status = 200,
): {
  fetchImpl: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    calls.push({ url: urlOf(input), init });
    return Promise.resolve(jsonResponse(body, status));
  };
  return { fetchImpl, calls };
}

const BASE_URL = "http://127.0.0.1:54321/functions/v1";

describe("createApiClient envelope handling", () => {
  it("unwraps a success envelope and returns the payload", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, data: { hello: "mundo" } });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.request({ method: "GET", path: "/health" })).resolves.toEqual({
      hello: "mundo",
    });
    expect(calls[0]?.url).toBe(`${BASE_URL}/health`);
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("strips a trailing slash from the base URL so paths do not double up", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, data: null });
    const client = createApiClient({ baseUrl: `${BASE_URL}/`, fetchImpl });
    await client.request({ method: "GET", path: "/health" });
    expect(calls[0]?.url).toBe(`${BASE_URL}/health`);
    expect(client.baseUrl).toBe(BASE_URL);
  });

  it("sends JSON with the documented content type when there is a body", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, data: null });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });
    await client.request({ method: "POST", path: "/orders/quote", body: { quantity: 2 } });

    expect(calls[0]?.init?.body).toBe(JSON.stringify({ quantity: 2 }));
    const headers = calls[0]?.init?.headers as HeaderBag;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.accept).toBe("application/json");
  });

  it("turns a failure envelope into an ApiError carrying code, status and issues", async () => {
    const { fetchImpl } = recordingFetch(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Datos inválidos",
          details: {
            issues: [
              { path: "nationalId", message: "La cédula debe tener entre 6 y 12 dígitos." },
              { path: "consents.dataProcessing", message: "Consentimiento obligatorio." },
            ],
          },
        },
      },
      400,
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const error = await client
      .request({ method: "POST", path: "/orders" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe("VALIDATION_ERROR");
    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe("Datos inválidos");
    expect(apiError.issues).toEqual([
      { path: "nationalId", message: "La cédula debe tener entre 6 y 12 dígitos." },
      { path: "consents.dataProcessing", message: "Consentimiento obligatorio." },
    ]);
  });

  it("falls back to the HTTP status for an unrecognized error code", async () => {
    const { fetchImpl } = recordingFetch(
      { ok: false, error: { code: "TEAPOT_LEAK", message: "?" } },
      409,
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });
    await expect(client.request({ method: "POST", path: "/orders" })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });

  it("uses a generic Spanish message when the backend sends none", async () => {
    const { fetchImpl } = recordingFetch({ ok: false, error: {} }, 500);
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });
    await expect(client.request({ method: "GET", path: "/events/X" })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "No pudimos completar la solicitud.",
      issues: [],
    });
  });

  it("maps a non-JSON error response to a documented code instead of crashing", async () => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(new Response("<html>Bad gateway</html>", { status: 502 }));
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const error = await client
      .request({ method: "GET", path: "/health" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("INTERNAL_ERROR");
  });

  it("treats a non-JSON 200 and a missing envelope as transport failures", async () => {
    const htmlFetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response("<html>proxy</html>", { status: 200 }));
    await expect(
      createApiClient({ baseUrl: BASE_URL, fetchImpl: htmlFetch }).request({
        method: "GET",
        path: "/health",
      }),
    ).rejects.toBeInstanceOf(NetworkError);

    const { fetchImpl } = recordingFetch({ data: "no envelope" });
    await expect(
      createApiClient({ baseUrl: BASE_URL, fetchImpl }).request({ method: "GET", path: "/health" }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("reports a connection failure as a NetworkError, not an ApiError", async () => {
    const fetchImpl: typeof globalThis.fetch = () => Promise.reject(new TypeError("fetch failed"));
    const error = await createApiClient({ baseUrl: BASE_URL, fetchImpl })
      .request({ method: "GET", path: "/health" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).timedOut).toBe(false);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});

describe("createApiClient timeouts and aborts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a request that outlives the timeout and reports it as a timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl, timeoutMs: 50 });

    const pending = client.request({ method: "GET", path: "/events/X" });
    const settled = pending.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(60);

    const error = await settled;
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).timedOut).toBe(true);
    expect((error as NetworkError).message).toContain("tardó demasiado");
  });

  it("distinguishes a caller abort from a timeout", async () => {
    const fetchImpl: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl, timeoutMs: 10_000 });
    const controller = new AbortController();

    const pending = client.request({
      method: "POST",
      path: "/orders",
      signal: controller.signal,
    });
    const settled = pending.catch((caught: unknown) => caught);
    controller.abort();

    await expect(settled).resolves.toBeInstanceOf(AbortError);
  });

  it("refuses to start when the caller's signal is already aborted", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>();
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.request({ method: "GET", path: "/health", signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ApiError retryability", () => {
  it("marks only the transient backend failures as retryable", () => {
    const of = (code: string): boolean =>
      new ApiError({ code: code as ApiError["code"], status: 500, message: "x" }).isRetryable;

    expect(of("UPSTREAM_ERROR")).toBe(true);
    expect(of("INTERNAL_ERROR")).toBe(true);
    expect(of("RATE_LIMITED")).toBe(true);
    expect(of("CONFLICT")).toBe(false);
    expect(of("VALIDATION_ERROR")).toBe(false);
    expect(of("NOT_FOUND")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Endpoint contract
// ---------------------------------------------------------------------------

/**
 * A client double that records the request options each endpoint builds and answers with
 * `response` (an empty object by default, for tests that only assert the request).
 */
function recordingClient(response: unknown = {}): { client: ApiClient; calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  return {
    calls,
    client: {
      baseUrl: BASE_URL,
      request: <T>(options: RequestOptions): Promise<T> => {
        calls.push(options);
        return Promise.resolve(response as T);
      },
    },
  };
}

function headersOf(call: RequestOptions | undefined): Record<string, string> {
  return call?.headers ?? {};
}

/** `fetch` accepts a string, a URL or a Request; the client always passes a string. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("ticketing endpoints", () => {
  it("encodes the event code in the path", async () => {
    const { client, calls } = recordingClient();
    await createTicketingApi(client).getEvent("RESET SUNSET 2026");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/events/RESET%20SUNSET%202026");
  });

  it("omits the discount code from a quote when the buyer typed none", async () => {
    const { client, calls } = recordingClient();
    const api = createTicketingApi(client);

    await api.quote({ eventCode: "RESET-SUNSET-2026", ticketTypeCode: "GENERAL", quantity: 2 });
    expect(calls[0]?.body).toEqual({
      eventCode: "RESET-SUNSET-2026",
      ticketTypeCode: "GENERAL",
      quantity: 2,
    });

    await api.quote({
      eventCode: "RESET-SUNSET-2026",
      ticketTypeCode: "GENERAL",
      quantity: 2,
      discountCode: "VERANO",
    });
    expect(calls[1]?.body).toEqual({
      eventCode: "RESET-SUNSET-2026",
      ticketTypeCode: "GENERAL",
      quantity: 2,
      discountCode: "VERANO",
    });
  });

  it("sends the Idempotency-Key header the backend deduplicates on", async () => {
    const { client, calls } = recordingClient();
    await createTicketingApi(client).createOrder({
      eventCode: "RESET-SUNSET-2026",
      ticketTypeCode: "GENERAL",
      quantity: 1,
      buyer: { email: "ana@example.com", fullName: "Ana Pérez", phone: "3001234567" },
      participant: {
        firstName: "Ana",
        lastName: "Pérez",
        nationalId: "1023456789",
        email: "ana@example.com",
        phone: "3001234567",
        city: "Bogotá",
        consents: { dataProcessing: true, futureEvents: false },
      },
      idempotencyKey: "order-11111111-2222-3333-4444-555555555555",
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/orders");
    expect(headersOf(calls[0])["Idempotency-Key"]).toBe(
      "order-11111111-2222-3333-4444-555555555555",
    );
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.quantity).toBe(1);
    expect(body.buyer).toEqual({
      email: "ana@example.com",
      fullName: "Ana Pérez",
      phone: "3001234567",
    });
    expect(body.participant).toEqual({
      firstName: "Ana",
      lastName: "Pérez",
      nationalId: "1023456789",
      email: "ana@example.com",
      phone: "3001234567",
      city: "Bogotá",
      consents: { dataProcessing: true, futureEvents: false },
    });
  });

  it("sends an Instagram handle only when the buyer provided one", async () => {
    const { client, calls } = recordingClient();
    const api = createTicketingApi(client);
    const base = {
      eventCode: "RESET-SUNSET-2026",
      ticketTypeCode: "GENERAL",
      quantity: 1,
      buyer: { email: "ana@example.com", fullName: "Ana Pérez", phone: "3001234567" },
    };

    await api.createOrder({
      ...base,
      participant: {
        firstName: "Ana",
        lastName: "Pérez",
        nationalId: "1023456789",
        email: "ana@example.com",
        phone: "3001234567",
        city: "Bogotá",
        consents: { dataProcessing: true, futureEvents: false },
      },
    });
    expect((calls[0]?.body as Record<string, unknown>).participant).not.toHaveProperty("instagram");

    await api.createOrder({
      ...base,
      participant: {
        firstName: "Ana",
        lastName: "Pérez",
        nationalId: "1023456789",
        email: "ana@example.com",
        phone: "3001234567",
        city: "Bogotá",
        instagram: "anap",
        consents: { dataProcessing: true, futureEvents: false },
      },
    });
    expect((calls[1]?.body as Record<string, unknown>).participant).toHaveProperty(
      "instagram",
      "anap",
    );
  });

  it("correlates a status lookup with the buyer email header and no body", async () => {
    const { client, calls } = recordingClient();
    await createTicketingApi(client).getOrderStatus("EVT-2026-000001", "ana@example.com");

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/orders/EVT-2026-000001");
    expect(headersOf(calls[0])["X-Buyer-Email"]).toBe("ana@example.com");
    expect(calls[0]?.body).toBeUndefined();
  });

  it("requests a retry with the buyer email in both the body and the header", async () => {
    const { client, calls } = recordingClient();
    await createTicketingApi(client).retryPayment("EVT-2026-000001", "ana@example.com");

    expect(calls[0]?.path).toBe("/orders/EVT-2026-000001/retry");
    expect(calls[0]?.body).toEqual({ email: "ana@example.com" });
    expect(headersOf(calls[0])["X-Buyer-Email"]).toBe("ana@example.com");
  });

  it("forwards the provider transaction id as a payment hint", async () => {
    const { client, calls } = recordingClient();
    await createTicketingApi(client).sendPaymentHint(
      "EVT-2026-000001",
      "ana@example.com",
      "1234-5678-9012",
    );

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/orders/EVT-2026-000001/payment-hint");
    expect(calls[0]?.body).toEqual({ transactionId: "1234-5678-9012" });
    expect(headersOf(calls[0])["X-Buyer-Email"]).toBe("ana@example.com");
  });

  it("returns typed backend data untouched", async () => {
    const api = createTicketingApi(recordingClient(makePaidOrderStatus()).client);
    const status = await api.getOrderStatus("EVT-2026-000001", "ana@example.com");
    expect(status.status).toBe("PAID");
    expect(status.paidAt).toBe("2026-10-05T19:05:00.000Z");
    // Tickets are discontinued: the status carries no ticket/token list at all.
    expect(status).not.toHaveProperty("tickets");
  });

  it("attaches a companion with the buyer email and no ticket token", async () => {
    const { client, calls } = recordingClient(makeAttachedParticipant());
    const attached = await createTicketingApi(client).attachParticipant(
      "EVT-2026-000001",
      "ana@example.com",
      {
        firstName: "Beto",
        lastName: "Gómez",
        nationalId: "987654321",
        email: "beto@example.com",
        phone: "3001112233",
        city: "Cali",
        consents: { dataProcessing: true, futureEvents: false },
      },
    );

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/orders/EVT-2026-000001/participants");
    expect(headersOf(calls[0])["X-Buyer-Email"]).toBe("ana@example.com");
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("ticketToken");
    expect(body.participant).toMatchObject({
      firstName: "Beto",
      lastName: "Gómez",
      nationalId: "987654321",
      email: "beto@example.com",
      city: "Cali",
      consents: { dataProcessing: true, futureEvents: false },
    });
    expect(attached.unit).toBe(2);
    expect(attached.remainingUnassigned).toBe(0);
  });

  it("passes the checkout payload through with no client-side mutation", async () => {
    const checkout = makeEpaycoCheckout({ amountInCents: 12_345_600 });
    const api = createTicketingApi(recordingClient({ checkout }).client);
    const order = await api.createOrder({
      eventCode: "RESET-SUNSET-2026",
      ticketTypeCode: "GENERAL",
      quantity: 1,
      buyer: { email: "ana@example.com", fullName: "Ana", phone: "3001234567" },
      participant: {
        firstName: "Ana",
        lastName: "Pérez",
        nationalId: "1023456789",
        email: "ana@example.com",
        phone: "3001234567",
        city: "Bogotá",
        consents: { dataProcessing: true, futureEvents: false },
      },
    });
    expect(order.checkout).toEqual(checkout);
    expect(order.checkout.provider).toBe("epayco");
    expect(order.checkout.sessionId).toBe("fixture-epayco-session-123");
  });
});
