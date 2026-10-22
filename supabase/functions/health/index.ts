/**
 * Health / deploy smoke test.
 *
 * Purpose: after deploying, one GET tells an operator whether the runtime is up and
 * whether the environment is completely and consistently configured. It never touches
 * the database and never returns configuration values — only the environment name.
 *
 * Public (`verify_jwt = false` in config.toml) because it must be callable without a
 * Supabase JWT during deploy verification. It exposes no secrets and no personal data.
 * When the configuration is broken it answers with the list of MISSING VARIABLE NAMES
 * outside production (this is what makes the smoke test useful); in production the
 * response stays generic.
 *
 * This file is the only layer allowed to read the process environment. The shared core
 * receives configuration as a plain object, which keeps it portable and testable.
 */

import { ConfigError, loadConfig, parseCorsAllowedOrigins } from "../_shared/config/env.ts";
import {
  errorResponse,
  jsonResponse,
  preflightResponse,
  resolveCorsHeaders,
  successResponse,
} from "../_shared/http/json.ts";
import { createLogger } from "../_shared/logging/logger.ts";

const SERVICE_VERSION = "1.0.0-phase1";
const FALLBACK_SERVICE_NAME = "event-ticketing";

Deno.serve((request: Request): Response | Promise<Response> => {
  const requestId = crypto.randomUUID();
  const requestOrigin = request.headers.get("origin") ?? undefined;
  const env = Deno.env.toObject();
  const corsAllowedOrigins = parseCorsAllowedOrigins(env);

  if (request.method === "OPTIONS") {
    return preflightResponse(corsAllowedOrigins, requestOrigin);
  }

  const fallbackCorsHeaders = resolveCorsHeaders(corsAllowedOrigins, requestOrigin);

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    // Configuration problems are the one case where the issue list is returned, and only
    // outside production. The list contains variable names, never values.
    const appEnv = env["APP_ENV"] ?? "development";
    const logger = createLogger({
      service: FALLBACK_SERVICE_NAME,
      environment: appEnv,
      level: "info",
    });
    logger.error("health check failed: invalid configuration", {
      requestId,
      issues: error instanceof ConfigError ? error.issues : ["unexpected configuration error"],
    });
    const details =
      error instanceof ConfigError && appEnv !== "production"
        ? { issues: error.issues }
        : undefined;
    return errorResponse(error, {
      message: "La configuración del backend está incompleta.",
      ...(details === undefined ? {} : { details }),
      headers: fallbackCorsHeaders,
    });
  }

  const logger = createLogger({
    service: config.serviceName,
    environment: config.appEnv,
    level: config.logLevel,
  });
  const corsHeaders = resolveCorsHeaders(config.corsAllowedOrigins, requestOrigin);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      {
        ok: false,
        error: { code: "VALIDATION_ERROR", message: "Método no permitido." },
      },
      { status: 405, headers: corsHeaders },
    );
  }

  logger.info("health check ok", {
    requestId,
    wompiEnvironment: config.wompi.environment,
  });

  return successResponse(
    {
      service: config.serviceName,
      version: SERVICE_VERSION,
      environment: config.appEnv,
      wompiEnvironment: config.wompi.environment,
      time: new Date().toISOString(),
      checks: {
        configuration: "ok",
        // Database readiness is intentionally not checked here: it requires credentials
        // and a migrated schema. Phase 2 adds it together with the first tables.
        database: "not-checked",
      },
    },
    { headers: { ...corsHeaders, "x-request-id": requestId } },
  );
});
