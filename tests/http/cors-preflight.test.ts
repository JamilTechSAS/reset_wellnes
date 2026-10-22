import { describe, expect, it } from "vitest";

import { errorResponse, preflightResponse, resolveCorsHeaders } from "@shared/http/json.ts";
import { ConfigError, loadConfig, parseCorsAllowedOrigins } from "@shared/config/env.ts";

describe("CORS preflight and unconfigured environment handling", () => {
  const UNCONFIGURED_STAGING_ENV: Record<string, string | undefined> = {
    APP_ENV: "sandbox",
    CORS_ALLOWED_ORIGINS: "https://resetwellness.co,https://soqmdpqjjdmdhtgsutab.supabase.co",
  };

  it("handles CORS preflight successfully when application secrets are completely absent", () => {
    const corsOrigins = parseCorsAllowedOrigins(UNCONFIGURED_STAGING_ENV);
    expect(corsOrigins).toEqual([
      "https://resetwellness.co",
      "https://soqmdpqjjdmdhtgsutab.supabase.co",
    ]);

    const allowedOrigin = "https://resetwellness.co";
    const response = preflightResponse(corsOrigins, allowedOrigin);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("idempotency-key");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-buyer-email");
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });

  it("handles CORS preflight for unallowed origins without echoing origin header", () => {
    const corsOrigins = parseCorsAllowedOrigins(UNCONFIGURED_STAGING_ENV);
    const unallowedOrigin = "https://malicious.example";
    const response = preflightResponse(corsOrigins, unallowedOrigin);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBe("origin");
  });

  it("handles CORS preflight without origin header gracefully", () => {
    const corsOrigins = parseCorsAllowedOrigins(UNCONFIGURED_STAGING_ENV);
    const response = preflightResponse(corsOrigins, undefined);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBe("origin");
  });

  it("attaches CORS headers to configuration error responses so browsers can inspect the error", async () => {
    const corsOrigins = parseCorsAllowedOrigins(UNCONFIGURED_STAGING_ENV);
    const requestOrigin = "https://resetwellness.co";
    const fallbackCorsHeaders = resolveCorsHeaders(corsOrigins, requestOrigin);

    let caughtError: unknown;
    try {
      loadConfig(UNCONFIGURED_STAGING_ENV);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(ConfigError);

    const issues = caughtError instanceof ConfigError ? caughtError.issues : [];
    const response = errorResponse(caughtError, {
      message: "La configuración del backend está incompleta.",
      details: { issues },
      headers: fallbackCorsHeaders,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe(requestOrigin);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string; details?: { issues?: string[] } };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("La configuración del backend está incompleta.");
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
    expect(body.error.details?.issues?.length).toBeGreaterThan(0);
  });
});
