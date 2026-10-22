import { describe, expect, it, vi } from "vitest";

import {
  createWompiClient,
  WompiApiError,
  type WompiClientOptions,
} from "@shared/integrations/wompi/client.ts";

const PRIVATE_KEY = "prv_test_FAKE_PRIVATE_KEY_FOR_TESTS";
const BASE_URL = "https://sandbox.wompi.co/v1";

/**
 * Documented response shape (docs.wompi.co > Transactions > Check transaction status).
 */
const DOCUMENTED_RESPONSE = {
  data: {
    id: "1292-1602113476-10985",
    reference: "EVT-2026-000001",
    status: "APPROVED",
    amount_in_cents: 9_500_000,
    currency: "COP",
    customer_email: "maria@example.com",
    payment_method_type: "CARD",
    status_message: "Transaction approved",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof globalThis.fetch, options: Partial<WompiClientOptions> = {}) {
  return createWompiClient({
    baseUrl: BASE_URL,
    privateKey: PRIVATE_KEY,
    fetchImpl,
    // No real waiting in tests; the retry policy itself is asserted by call counts.
    retryDelaysMs: [0],
    ...options,
  });
}

describe("Wompi client", () => {
  it("reads a transaction with the private key over the documented endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DOCUMENTED_RESPONSE));
    const client = clientWith(fetchImpl);

    const transaction = await client.getTransaction("1292-1602113476-10985");

    expect(transaction).toEqual({
      id: "1292-1602113476-10985",
      reference: "EVT-2026-000001",
      status: "APPROVED",
      amountInCents: 9_500_000,
      currency: "COP",
      customerEmail: "maria@example.com",
      paymentMethodType: "CARD",
      statusMessage: "Transaction approved",
      createdAt: undefined,
      finalizedAt: undefined,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/transactions/1292-1602113476-10985`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${PRIVATE_KEY}`);
  });

  it("keeps the raw status so unknown values reach the database unchanged", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { ...DOCUMENTED_RESPONSE.data, status: "SOMETHING_NEW" } }),
    );
    const client = clientWith(fetchImpl);
    const transaction = await client.getTransaction("1292-1602113476-10985");
    expect(transaction.status).toBe("SOMETHING_NEW");
  });

  it("does not retry authentication or not-found errors, and never leaks the key", async () => {
    for (const status of [401, 404]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ error: { type: "UNAUTHORIZED" } }, status),
      );
      const client = clientWith(fetchImpl);

      await expect(client.getTransaction("1292-1602113476-10985")).rejects.toBeInstanceOf(
        WompiApiError,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      let caught: unknown;
      try {
        await client.getTransaction("1292-1602113476-10985");
      } catch (error) {
        caught = error;
      }
      expect(JSON.stringify(caught instanceof Error ? caught.message : caught)).not.toContain(
        PRIVATE_KEY,
      );
      expect((caught as WompiApiError).httpStatus).toBe(status);
      expect((caught as WompiApiError).code).toBe("UPSTREAM_ERROR");
    }
  });

  it("captures the Wompi error type without copying the response body (which can hold PII)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            type: "DUPLICATE_REFERENCE",
            messages: { reference: ["already used"] },
            customer_email: "maria@example.com",
          },
        },
        422,
      ),
    );
    const client = clientWith(fetchImpl);

    let caught: unknown;
    try {
      await client.getTransaction("1292-1602113476-10985");
    } catch (error) {
      caught = error;
    }

    const error = caught as WompiApiError;
    expect(error.wompiErrorType).toBe("DUPLICATE_REFERENCE");
    expect(error.httpStatus).toBe(422);
    expect(JSON.stringify(error.message)).not.toContain("maria@example.com");
    expect(JSON.stringify(error.context)).not.toContain("maria@example.com");
  });

  it("retries transient failures and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: "boom" }, 500) : jsonResponse(DOCUMENTED_RESPONSE);
    });
    const client = clientWith(fetchImpl, {
      retryDelaysMs: [0, 0],
    });

    const transaction = await client.getTransaction("1292-1602113476-10985");
    expect(transaction.status).toBe("APPROVED");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured retries on persistent server errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 503));
    const client = clientWith(fetchImpl, {
      maxRetries: 2,
      retryDelaysMs: [0, 0],
    });

    await expect(client.getTransaction("1292-1602113476-10985")).rejects.toBeInstanceOf(
      WompiApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries network failures and surfaces them as upstream errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const client = clientWith(fetchImpl, {
      maxRetries: 1,
      retryDelaysMs: [0],
    });

    let caught: unknown;
    try {
      await client.getTransaction("1292-1602113476-10985");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WompiApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never treats an unexpected payload as a paid transaction", async () => {
    const wrongShape = vi.fn(async () => jsonResponse({ data: { status: "APPROVED" } }));
    await expect(
      clientWith(wrongShape as unknown as typeof globalThis.fetch).getTransaction("1292-1-1"),
    ).rejects.toBeInstanceOf(WompiApiError);

    const notJson = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 }));
    await expect(
      clientWith(notJson as unknown as typeof globalThis.fetch).getTransaction("1292-1-1"),
    ).rejects.toBeInstanceOf(WompiApiError);

    const nonIntegerAmount = vi.fn(async () =>
      jsonResponse({ data: { ...DOCUMENTED_RESPONSE.data, amount_in_cents: 1.5 } }),
    );
    await expect(
      clientWith(nonIntegerAmount as unknown as typeof globalThis.fetch).getTransaction("1292-1-1"),
    ).rejects.toBeInstanceOf(WompiApiError);
  });

  it("rejects malformed transaction ids before any network call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(DOCUMENTED_RESPONSE));
    const client = clientWith(fetchImpl);

    await expect(client.getTransaction("../admin")).rejects.toBeInstanceOf(WompiApiError);
    await expect(client.getTransaction("")).rejects.toBeInstanceOf(WompiApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
