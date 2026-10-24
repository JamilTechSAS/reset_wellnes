import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildSheetsSignedRequest,
  canonicalSheetsMessage,
  createSheetsClient,
  signSheetsRequest,
} from "@shared/integrations/google/sheets-client.ts";

const URL = "https://script.google.com/macros/s/AKfycbxTestDeploymentId1234567890/exec";
const SECRET = "test_apps_script_secret_0123456789abcdef";
const NONCE = "abcdefghijklmnopqrstuvwxyz012345";
const NOW = 1_792_829_768_000;
const TIMESTAMP = 1_792_829_768;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected a string request body");
  }
  return body;
}

function clientWith(fetchImpl: typeof globalThis.fetch) {
  return createSheetsClient({
    url: URL,
    secret: SECRET,
    fetchImpl,
    now: () => NOW,
    nonce: () => NONCE,
    timeoutMs: 1_000,
  });
}

function signedBody(body: unknown): {
  readonly version: number;
  readonly timestamp: number;
  readonly nonce: string;
  readonly payload: string;
  readonly signature: string;
} {
  return JSON.parse(String(body)) as {
    readonly version: number;
    readonly timestamp: number;
    readonly nonce: string;
    readonly payload: string;
    readonly signature: string;
  };
}

function expectedSignature(payload: string): string {
  return createHmac("sha256", SECRET)
    .update(canonicalSheetsMessage(TIMESTAMP, NONCE, payload), "utf8")
    .digest("base64url");
}

describe("Apps Script request signing", () => {
  it("builds the exact canonical message and a deterministic HMAC vector", async () => {
    const payload = JSON.stringify({ operation: "health" });
    expect(canonicalSheetsMessage(TIMESTAMP, NONCE, payload)).toBe(
      `v1\n${TIMESTAMP}\n${NONCE}\n${payload}`,
    );
    expect(
      await signSheetsRequest({
        secret: SECRET,
        timestamp: TIMESTAMP,
        nonce: NONCE,
        payloadJson: payload,
      }),
    ).toBe("PZmOGvjgm8EEUxV5bCz3_zN2s0TK_lqZGQRjavKGR3Y");

    const request = await buildSheetsSignedRequest({
      secret: SECRET,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      payloadJson: payload,
    });
    expect(request.envelope).toEqual({
      version: 1,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      payload,
      signature: "PZmOGvjgm8EEUxV5bCz3_zN2s0TK_lqZGQRjavKGR3Y",
    });
    expect(request.body).toBe(JSON.stringify(request.envelope));
  });

  it("sends the signed envelope and parses a successful data write", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        data: {
          operation: "sync",
          grid: "data",
          written: true,
          rowsWritten: 1,
          updatedRanges: 1,
          updatedCells: 22,
        },
      }),
    );
    const client = clientWith(fetchImpl);

    const result = await client.writeProjection({
      grid: "data",
      values: [["header"], ["Ana"]],
    });

    expect(result).toEqual({
      ok: true,
      grid: "data",
      written: true,
      rowsWritten: 1,
      updatedRanges: 1,
      updatedCells: 22,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("follow");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
    });

    const envelope = signedBody(requestBody(init));
    expect(envelope.version).toBe(1);
    expect(envelope.timestamp).toBe(TIMESTAMP);
    expect(envelope.nonce).toBe(NONCE);
    expect(JSON.parse(envelope.payload)).toEqual({
      operation: "sync",
      grid: "data",
      values: [["header"], ["Ana"]],
    });
    expect(envelope.signature).toBe(expectedSignature(envelope.payload));
  });

  it("sends the fixed status-grid target without any spreadsheet or tab name", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        data: {
          operation: "sync",
          grid: "status",
          written: true,
          rowsWritten: 1,
          updatedRanges: 1,
          updatedCells: 2,
        },
      }),
    );
    const client = clientWith(fetchImpl);

    const result = await client.writeProjection({
      grid: "status",
      values: [["Total", 1]],
    });

    expect(result.ok).toBe(true);
    const envelope = signedBody(requestBody(fetchImpl.mock.calls[0]?.[1]));
    expect(JSON.parse(envelope.payload)).toEqual({
      operation: "sync",
      grid: "status",
      values: [["Total", 1]],
    });
    expect(envelope.payload).not.toContain("spreadsheet");
    expect(envelope.payload).not.toContain("Datos");
  });

  it("supports signed health and self-test operations", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          ok: true,
          data: {
            operation: "health",
            spreadsheetAccessible: true,
            dataTab: true,
            statusTab: true,
            timeZone: "America/Bogota",
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          ok: true,
          data: {
            operation: "self_test",
            spreadsheetAccessible: true,
            dataTab: true,
            statusTab: true,
            writeReadDelete: true,
            cleanedUp: true,
          },
        }),
      );
    const client = clientWith(fetchImpl);

    const health = await client.health();
    const selfTest = await client.selfTest();

    expect(health.ok).toBe(true);
    expect(selfTest.ok).toBe(true);
    if (health.ok) {
      expect(health.data.timeZone).toBe("America/Bogota");
    }
    if (selfTest.ok) {
      expect(selfTest.data.cleanedUp).toBe(true);
    }
    const first = signedBody(requestBody(fetchImpl.mock.calls[0]?.[1]));
    const second = signedBody(requestBody(fetchImpl.mock.calls[1]?.[1]));
    expect(JSON.parse(first.payload)).toEqual({ operation: "health" });
    expect(JSON.parse(second.payload)).toEqual({ operation: "self_test" });
  });
});

describe("Apps Script failure handling", () => {
  it("returns a retryable failure for an HTTP 503", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ ok: false, error: { code: "BUSY", message: "try later", retryable: true } }, 503),
      );
    const result = await clientWith(fetchImpl).writeProjection({
      grid: "data",
      values: [["header"]],
    });

    expect(result).toEqual({
      ok: false,
      retryable: true,
      error: "try later",
      httpStatus: 503,
    });
  });

  it("respects a non-retryable structured rejection even with HTTP 200", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: false,
        error: { code: "MISSING_TAB", message: "Create the tabs first.", retryable: false },
      }),
    );
    const result = await clientWith(fetchImpl).writeProjection({
      grid: "status",
      values: [["Total", 0]],
    });

    expect(result).toEqual({
      ok: false,
      retryable: false,
      error: "Create the tabs first.",
      httpStatus: 200,
    });
  });

  it("rejects a malformed success body without treating HTTP 200 as success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>sign in</html>", { status: 200 }));
    const result = await clientWith(fetchImpl).writeProjection({
      grid: "data",
      values: [["header"]],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("non-JSON");
      expect(result.httpStatus).toBe(200);
      expect(result.retryable).toBe(true);
    }
  });

  it("retries a malformed {ok:false} body instead of treating it as a durable rejection", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false }, 200));
    const result = await clientWith(fetchImpl).writeProjection({
      grid: "data",
      values: [["header"]],
    });

    expect(result).toEqual({
      ok: false,
      retryable: true,
      error: "connector returned an invalid error body",
      httpStatus: 200,
    });
  });

  it("rejects a success body that is not a sync acknowledgement", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        data: {
          operation: "health",
          grid: "data",
          written: true,
          rowsWritten: 1,
          updatedRanges: 1,
          updatedCells: 22,
        },
      }),
    );
    const result = await clientWith(fetchImpl).writeProjection({
      grid: "data",
      values: [["header"], ["Ana"]],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe sync acknowledgement");
      expect(result.retryable).toBe(true);
    }
  });

  it("rejects an unsafe success acknowledgement", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        data: {
          operation: "sync",
          grid: "data",
          written: false,
          rowsWritten: 1,
          updatedRanges: 1,
          updatedCells: 22,
        },
      }),
    );
    const result = await clientWith(fetchImpl).writeProjection({
      grid: "data",
      values: [["header"]],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe sync acknowledgement");
    }
  });

  it("rejects a success body with the wrong grid target", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        data: {
          operation: "sync",
          grid: "status",
          written: true,
          rowsWritten: 1,
          updatedRanges: 1,
          updatedCells: 22,
        },
      }),
    );
    const result = await clientWith(fetchImpl).writeProjection({
      grid: "data",
      values: [["header"]],
    });

    expect(result.ok).toBe(false);
  });

  it("turns a network timeout into a retryable failure", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    const result = await clientWith(fetchImpl).writeProjection({
      grid: "data",
      values: [["header"]],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toBe("network: TimeoutError");
    }
  });

  it("does not leak the shared secret in connector errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(SECRET));
    const result = await clientWith(fetchImpl).health();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(SECRET);
    }
  });
});
