import { describe, expect, it } from "vitest";

import { AppError, validationError } from "@shared/domain/errors.ts";
import {
  DEFAULT_ERROR_MESSAGES_ES,
  ERROR_HTTP_STATUS,
  errorResponse,
  jsonResponse,
  preflightResponse,
  resolveCorsHeaders,
  successResponse,
  withRequestId,
} from "@shared/http/json.ts";

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("HTTP response contract", () => {
  it("wraps successful payloads in { ok: true, data }", async () => {
    const response = successResponse({ reference: "EVT-2026-000001" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bodyOf(response)).toEqual({ ok: true, data: { reference: "EVT-2026-000001" } });
  });

  it("maps every error code to its documented HTTP status and Spanish message", async () => {
    const expected: Record<string, number> = {
      VALIDATION_ERROR: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      UPSTREAM_ERROR: 502,
      INTERNAL_ERROR: 500,
    };
    expect(ERROR_HTTP_STATUS).toEqual(expected);

    for (const [code, status] of Object.entries(expected)) {
      const response = errorResponse(
        new AppError(code as keyof typeof ERROR_HTTP_STATUS, "internal detail"),
      );
      expect(response.status).toBe(status);
      const body = await bodyOf(response);
      expect(body).toMatchObject({ ok: false, error: { code } });
      const message = (body.error as { message: string }).message;
      expect(message).toBe(DEFAULT_ERROR_MESSAGES_ES[code as keyof typeof ERROR_HTTP_STATUS]);
    }
  });

  it("never returns internal messages for unexpected errors", async () => {
    const response = errorResponse(new Error("connection string supabase://secret leaked"));
    const body = await bodyOf(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(500);
    expect(serialized).not.toContain("connection string");
    expect(serialized).not.toContain("secret");
    expect((body.error as { message: string }).message).toBe(
      DEFAULT_ERROR_MESSAGES_ES.INTERNAL_ERROR,
    );
  });

  it("passes safe validation details through", async () => {
    const response = errorResponse(validationError("participant payload rejected"), {
      details: { issues: [{ path: "email", message: "A valid email address is required" }] },
    });
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: DEFAULT_ERROR_MESSAGES_ES.VALIDATION_ERROR,
        details: { issues: [{ path: "email", message: "A valid email address is required" }] },
      },
    });
  });

  it("allows overriding the user-facing message without changing the code", async () => {
    const response = errorResponse(new AppError("CONFLICT", "order already paid"), {
      message: "La orden ya fue pagada.",
    });
    const body = await bodyOf(response);
    expect(body.error).toEqual({
      code: "CONFLICT",
      message: "La orden ya fue pagada.",
    });
  });

  it("echoes only explicitly allowed CORS origins", () => {
    const allowed = resolveCorsHeaders(["https://evento.example"], "https://evento.example");
    expect(allowed["access-control-allow-origin"]).toBe("https://evento.example");
    expect(allowed.vary).toBe("origin");

    const rejected = resolveCorsHeaders(["https://evento.example"], "https://evil.example");
    expect(rejected["access-control-allow-origin"]).toBeUndefined();
    expect(rejected.vary).toBe("origin");

    const missingOrigin = resolveCorsHeaders(["https://evento.example"], undefined);
    expect(missingOrigin["access-control-allow-origin"]).toBeUndefined();

    const preflight = preflightResponse(["https://evento.example"], "https://evento.example");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("tags responses with the request id", () => {
    expect(withRequestId({ "content-type": "application/json" }, "req_123")).toEqual({
      "content-type": "application/json",
      "x-request-id": "req_123",
    });
  });

  it("serializes arbitrary bodies without leaking object prototypes", async () => {
    const response = jsonResponse({ ok: true });
    expect(await bodyOf(response)).toEqual({ ok: true });
  });
});
