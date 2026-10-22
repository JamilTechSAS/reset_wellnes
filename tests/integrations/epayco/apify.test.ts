import { describe, expect, it, vi } from "vitest";
import { createEpaycoApifyClient, EpaycoApifyError } from "@shared/integrations/epayco/apify.ts";

describe("ePayco Apify client (Smart Checkout V2)", () => {
  it("authenticates using Basic auth (PUBLIC_KEY:PRIVATE_KEY) and obtains token", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/login")) {
        const auth = init?.headers ? (init.headers as Record<string, string>).Authorization : "";
        expect(auth).toBe(`Basic ${globalThis.btoa("pub_key_123:prv_key_456")}`);
        return Promise.resolve(
          new Response(JSON.stringify({ token: "jwt_token_sample_abc" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const client = createEpaycoApifyClient({
      publicKey: "pub_key_123",
      privateKey: "prv_key_456",
      fetch: fetchMock,
    });

    const token = await client.login();
    expect(token).toBe("jwt_token_sample_abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Subsequent login call reuses cached token
    const tokenCached = await client.login();
    expect(tokenCached).toBe("jwt_token_sample_abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws EpaycoApifyError on login failure without leaking credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Invalid credentials" }), {
        status: 401,
      }),
    );

    const client = createEpaycoApifyClient({
      publicKey: "pub_wrong",
      privateKey: "prv_wrong",
      fetch: fetchMock,
    });

    await expect(client.login()).rejects.toThrow(EpaycoApifyError);
    await expect(client.login()).rejects.toThrow(/Authentication failed/);
  });

  it("creates a payment session using Bearer token and returns sessionId", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/login")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "token_xyz" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/payment/session/create")) {
        const auth = (init?.headers as Record<string, string>).Authorization;
        expect(auth).toBe("Bearer token_xyz");

        const body = JSON.parse(init?.body as string) as {
          checkout_version: string;
          name: string;
          amount: number;
          currency: string;
          invoice: string;
          confirmation: string;
          response: string;
          test: boolean;
        };
        expect(body.checkout_version).toBe("2");
        expect(body.name).toBe("Re set Sunset Vol. 1");
        expect(body.amount).toBe(160000);
        expect(body.currency).toBe("COP");
        expect(body.invoice).toBe("EVT-2026-000001");
        expect(body.confirmation).toBe("https://api.example.com/webhooks-epayco");
        expect(body.response).toBe("https://example.com/gracias");
        expect(body.test).toBe(true);

        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                sessionId: "session_abc_12345",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const client = createEpaycoApifyClient({
      publicKey: "pub_key_123",
      privateKey: "prv_key_456",
      test: true,
      fetch: fetchMock,
    });

    const result = await client.createSession({
      name: "Re set Sunset Vol. 1",
      currency: "COP",
      amount: 160000,
      invoice: "EVT-2026-000001",
      confirmation: "https://api.example.com/webhooks-epayco",
      response: "https://example.com/gracias",
    });

    expect(result.sessionId).toBe("session_abc_12345");
  });

  it("handles token expiration (401) on session creation by re-logging in and retrying", async () => {
    let sessionCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/login")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "refreshed_token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/payment/session/create")) {
        sessionCalls++;
        if (sessionCalls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: "Token expired" }), { status: 401 }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              data: { sessionId: "session_after_refresh" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const client = createEpaycoApifyClient({
      publicKey: "pub_key_123",
      privateKey: "prv_key_456",
      fetch: fetchMock,
    });

    const result = await client.createSession({
      name: "Re set Sunset Vol. 1",
      currency: "COP",
      amount: 160000,
      invoice: "EVT-2026-000001",
    });

    expect(result.sessionId).toBe("session_after_refresh");
    expect(sessionCalls).toBe(2);
  });

  it("handles malformed session creation response safely", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/login")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "valid_token" }), { status: 200 }),
        );
      }
      if (url.endsWith("/payment/session/create")) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: false, data: {} }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const client = createEpaycoApifyClient({
      publicKey: "pub_key_123",
      privateKey: "prv_key_456",
      fetch: fetchMock,
    });

    await expect(
      client.createSession({
        name: "Test",
        currency: "COP",
        amount: 1000,
        invoice: "EVT-01",
      }),
    ).rejects.toThrow(/missing sessionId/);
  });

  it("handles HTTP error status from session creation safely", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/login")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "valid_token" }), { status: 200 }),
        );
      }
      if (url.endsWith("/payment/session/create")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Amount out of bounds" }), { status: 400 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const client = createEpaycoApifyClient({
      publicKey: "pub_key_123",
      privateKey: "prv_key_456",
      fetch: fetchMock,
    });

    await expect(
      client.createSession({
        name: "Test",
        currency: "COP",
        amount: -50,
        invoice: "EVT-01",
      }),
    ).rejects.toThrow(/ePayco session creation failed with HTTP 400/);
  });
});
