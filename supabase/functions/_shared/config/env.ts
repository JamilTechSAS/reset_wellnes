/**
 * Environment configuration: loading, validation and safe reporting.
 *
 * Design rules
 * ------------
 * 1. This module is runtime-agnostic. It never touches `Deno.env` or `process.env`;
 *    the Edge Function adapter reads the environment and passes a plain record in.
 *    That keeps every rule below unit-testable and portable.
 * 2. Configuration is validated once, at process/request boundary, and fails fast.
 *    Invalid configuration must abort before any payment logic runs.
 * 3. Error messages name the VARIABLE, never its value. Secrets must not leak into
 *    logs, HTTP responses or error trackers.
 * 4. Credentials are tied to an environment. Wompi uses different credentials and a
 *    different API host per environment (verified in the official docs, "Ambientes y
 *    llaves"), so a sandbox deployment must reject production keys and vice versa.
 *    This is the cheapest possible protection against the classic "tested with prod
 *    keys" incident.
 */

import { LOG_LEVELS, type LogLevel } from "../logging/levels.ts";

export const APP_ENVIRONMENTS = ["development", "sandbox", "production"] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export const PAYMENT_PROVIDERS = ["epayco", "wompi"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export type EpaycoConfig = {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly pKey: string;
  readonly custIdCliente: string;
  readonly test: boolean;
  readonly baseUrl: string;
};

export const WOMPI_ENVIRONMENTS = ["sandbox", "production"] as const;
export type WompiEnvironment = (typeof WOMPI_ENVIRONMENTS)[number];

/**
 * Credential prefixes and API base URLs per Wompi environment.
 *
 * Source: https://docs.wompi.co/docs/colombia/ambientes-y-llaves/ (read 2026-10-03).
 * Sandbox:    pub_test_ / prv_test_ / test_events_ / test_integrity_  -> https://sandbox.wompi.co/v1
 * Production: pub_prod_ / prv_prod_ / prod_events_ / prod_integrity_  -> https://production.wompi.co/v1
 */
export const WOMPI_ENVIRONMENT_DETAILS: Record<
  WompiEnvironment,
  {
    readonly publicKeyPrefix: string;
    readonly privateKeyPrefix: string;
    readonly integritySecretPrefix: string;
    readonly eventsSecretPrefix: string;
    readonly baseUrl: string;
  }
> = {
  sandbox: {
    publicKeyPrefix: "pub_test_",
    privateKeyPrefix: "prv_test_",
    integritySecretPrefix: "test_integrity_",
    eventsSecretPrefix: "test_events_",
    baseUrl: "https://sandbox.wompi.co/v1",
  },
  production: {
    publicKeyPrefix: "pub_prod_",
    privateKeyPrefix: "prv_prod_",
    integritySecretPrefix: "prod_integrity_",
    eventsSecretPrefix: "prod_events_",
    baseUrl: "https://production.wompi.co/v1",
  },
};

/**
 * Kind of Supabase key supplied.
 *
 * Supabase is migrating from long-lived `anon` / `service_role` JWTs to
 * `sb_publishable_*` and `sb_secret_*` keys (legacy keys are deprecated by the end
 * of 2026). New projects should use `sb_secret_*`; both are accepted here, but a
 * publishable/anon key is always rejected because the backend needs full authority.
 */
export type SupabaseKeyKind = "sb_secret" | "legacy_service_role_jwt";

export type BackendConfig = {
  readonly appEnv: AppEnvironment;
  /** True for `sandbox` and `production`: relaxed development rules no longer apply. */
  readonly isDeployed: boolean;
  readonly serviceName: string;
  readonly logLevel: LogLevel;
  readonly timezone: string;
  readonly supabase: {
    readonly url: string;
    readonly secretKey: string;
    readonly keyKind: SupabaseKeyKind;
  };
  readonly paymentProvider: PaymentProvider;
  readonly epayco: EpaycoConfig;
  readonly wompi: {
    readonly environment: WompiEnvironment;
    readonly baseUrl: string;
    readonly publicKey: string;
    readonly privateKey: string;
    readonly integritySecret: string;
    readonly eventsSecret: string;
  };
  readonly email: {
    readonly provider: "resend";
    readonly enabled: boolean;
    readonly apiKey: string | undefined;
    readonly from: string | undefined;
    readonly replyTo: string | undefined;
  };
  /** Public site base URL (frontend, deployed separately, used for redirects/links). */
  readonly publicWebBaseUrl: string;
  /** Base URL of this backend's Edge Functions (used for QR/confirmation links). */
  readonly apiBaseUrl: string;
  /**
   * Application-level rate limiting (PostgreSQL fixed windows). Enabled by default; the
   * switch exists for documented emergencies only (for example a false positive at the
   * door), because disabling it removes an abuse control, not a correctness property.
   */
  readonly rateLimitEnabled: boolean;
  /**
   * Google Sheets operational projection. Optional by design: without credentials the
   * projection is skipped and every other job runs untouched (`SHEETS_ENABLED=false`).
   * When enabled, all three credential variables are required so a half-configured
   * deployment fails at startup instead of writing to the wrong spreadsheet.
   */
  readonly googleSheets:
    | { readonly enabled: false; readonly dataSheet: string; readonly statusSheet: string }
    | {
        readonly enabled: true;
        readonly serviceAccountEmail: string;
        readonly privateKey: string;
        readonly spreadsheetId: string;
        readonly dataSheet: string;
        readonly statusSheet: string;
      };
  /**
   * How long a PENDING order holds its inventory, in minutes.
   *
   * A TECHNICAL DEFAULT, not a client decision: the client has not confirmed the real window
   * yet (docs/data-model.md section 8.6), so it is configuration with a documented fallback
   * instead of a value baked into code.
   */
  readonly orderReservationMinutes: number;
  /** Optional Wompi `redirect-url`; the return page is never proof of payment. */
  readonly wompiRedirectUrl: string | undefined;
  /**
   * Optional base URL for the public ticket page linked from the confirmation email.
   * The page itself is a later frontend deliverable, so the link is omitted when this is
   * not configured rather than shipping a link to a 404.
   */
  readonly ticketBaseUrl: string | undefined;
  /**
   * How many confirmation emails one dispatch run may send. Bounded so a webhook response
   * cannot be held open by a long queue.
   */
  readonly emailDispatchBatchSize: number;
  /** Shared secret protecting the scheduled maintenance endpoint. */
  readonly maintenanceApiToken: string | undefined;
  readonly corsAllowedOrigins: readonly string[];
};

/** Thrown when configuration is missing or inconsistent. Lists variable names only. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid backend configuration (${issues.length} problem(s)):\n` +
        issues.map((issue) => `  - ${issue}`).join("\n"),
    );
    this.name = "ConfigError";
    this.issues = [...issues];
  }
}

type EnvRecord = Record<string, string | undefined>;

/**
 * Renders a credential so an operator can tell WHICH credential is loaded without
 * exposing its value: only the documented prefix and the length are kept.
 */
export function describeCredential(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return "(not set)";
  }
  const knownPrefixes = [
    "pub_test_",
    "prv_test_",
    "test_integrity_",
    "test_events_",
    "pub_prod_",
    "prv_prod_",
    "prod_integrity_",
    "prod_events_",
    "sb_secret_",
    "sb_publishable_",
    "re_",
  ];
  const prefix = knownPrefixes.find((candidate) => value.startsWith(candidate));
  return `${prefix ?? ""}…(len=${value.length})`;
}

function readString(env: EnvRecord, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalHostUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Minimal, pragmatic email shape check (full validation happens at sign-up/checkout). */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * `EMAIL_FROM` accepts either `pedro@dominio.com` or `Nombre <pedro@dominio.com>`.
 * Returns the raw value; format validation is reported through `issues`.
 */
function isEmailFromValid(value: string): boolean {
  const match = /^(?:[^<>]+<\s*(?<addr>[^\s<>]+)\s*>|(?<plain>[^\s<>]+))$/.exec(value);
  const address = match?.groups?.addr ?? match?.groups?.plain;
  return address !== undefined && looksLikeEmail(address);
}

function readBoolean(env: EnvRecord, name: string, fallback: boolean, issues: string[]): boolean {
  const raw = readString(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  issues.push(`${name} must be exactly "true" or "false" (received a different value)`);
  return fallback;
}

function readEnum<T extends string>(
  env: EnvRecord,
  name: string,
  allowed: readonly T[],
  fallback: T,
  issues: string[],
): T {
  const raw = readString(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  issues.push(`${name} must be one of: ${allowed.join(", ")}`);
  return fallback;
}

/**
 * Reads a required value.
 *
 * On a missing variable it records the problem and returns an empty string: the empty
 * value can never escape, because `loadConfig` throws a `ConfigError` whenever `issues` is
 * non-empty. Returning a plain string here (instead of `string | undefined`) keeps the
 * rest of the function free of type assertions, which is where mistakes hide.
 */
function requireValue(env: EnvRecord, name: string, issues: string[], guidance: string): string {
  const value = readString(env, name);
  if (value === undefined) {
    issues.push(`${name} is required (${guidance})`);
    return "";
  }
  return value;
}

/**
 * Extracts `name -> key` pairs from either documented shape of a platform-provided key bag:
 * a JSON object (`{"default":"sb_secret_…"}`) or an array of `{ name, api_key }` entries.
 * Anything else yields an empty map; values are never echoed into an issue.
 */
function platformSecretKeyEntries(parsed: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const key = record.api_key ?? record.apiKey;
      if (typeof record.name === "string" && typeof key === "string" && key.length > 0) {
        entries.set(record.name, key);
      }
    }
    return entries;
  }
  if (typeof parsed === "object" && parsed !== null) {
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        entries.set(name, value);
      }
    }
  }
  return entries;
}

/**
 * Picks the server-side key out of `SUPABASE_SECRET_KEYS`.
 *
 * Supabase reserves the `SUPABASE_` prefix for platform-provided variables, so a deployment
 * cannot define a custom `SUPABASE_SECRET_KEY`; modern projects expose the secret keys as a JSON
 * object in `SUPABASE_SECRET_KEYS`, whose `default` entry is the one a server should use. A bag
 * holding exactly one key is accepted without a name preference, so an operator who renamed the
 * entry is not locked out. Problems are reported by variable name only.
 */
function pickPlatformSecretKey(raw: string, issues: string[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push(
      "SUPABASE_SECRET_KEYS must be a JSON object of key names to secret keys (the platform-provided value)",
    );
    return undefined;
  }
  const entries = platformSecretKeyEntries(parsed);
  if (entries.size === 0) {
    issues.push("SUPABASE_SECRET_KEYS contains no usable secret key");
    return undefined;
  }
  const preferred = entries.get("default");
  if (preferred !== undefined) {
    return preferred;
  }
  if (entries.size === 1) {
    return [...entries.values()][0];
  }
  issues.push(
    'SUPABASE_SECRET_KEYS has no "default" entry, so the server-side key to use is ambiguous',
  );
  return undefined;
}

/**
 * Resolves the server-side Supabase key, which needs full database authority (it bypasses RLS).
 *
 * Precedence, first non-empty wins — every source below is a server-side secret and is never
 * exposed to the browser:
 *
 *   1. `SUPABASE_SECRET_KEY`        explicit override: local development, self-hosting, tests.
 *   2. `SUPABASE_SECRET_KEYS`       platform JSON bag; the `default` entry (see above).
 *   3. `SUPABASE_SERVICE_ROLE_KEY`  platform legacy key, on hosts that still inject it.
 *
 * A publishable/anon key is rejected by the caller whatever its source, and the chosen value is
 * only ever handed to the database client — never logged, never returned in an error.
 */
function resolveSupabaseSecretKey(env: EnvRecord, issues: string[]): string {
  const explicit = readString(env, "SUPABASE_SECRET_KEY");
  if (explicit !== undefined) {
    return explicit;
  }

  const platformKeys = readString(env, "SUPABASE_SECRET_KEYS");
  if (platformKeys !== undefined) {
    const resolved = pickPlatformSecretKey(platformKeys, issues);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  const serviceRoleKey = readString(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (serviceRoleKey !== undefined) {
    return serviceRoleKey;
  }

  issues.push(
    "SUPABASE_SECRET_KEY is required (server-side secret key (sb_secret_*) or legacy " +
      "service_role JWT; never expose it to the browser). Hosted Supabase provides it as " +
      "SUPABASE_SECRET_KEYS, and the platform's SUPABASE_SERVICE_ROLE_KEY is accepted too",
  );
  return "";
}

function requirePrefix(
  value: string,
  name: string,
  expectedPrefix: string,
  wompiEnvironment: WompiEnvironment,
  issues: string[],
): void {
  if (value.length === 0) {
    // Missing values are already reported by requireValue.
    return;
  }
  if (!value.startsWith(expectedPrefix)) {
    issues.push(
      `${name} must start with "${expectedPrefix}" for the ${wompiEnvironment} Wompi environment; ` +
        `the supplied value does not match this environment. Credentials from different ` +
        `environments must never be mixed.`,
    );
  }
}

function requireAbsoluteUrl(
  value: string,
  name: string,
  { isDeployed }: { isDeployed: boolean },
  issues: string[],
): string {
  if (value.length === 0) {
    // Missing value already reported by requireValue.
    return "";
  }
  if (!isHttpUrl(value)) {
    issues.push(`${name} must be an absolute http(s) URL`);
    return "";
  }
  if (isDeployed && new URL(value).protocol !== "https:") {
    issues.push(`${name} must use https outside of development`);
  }
  return value;
}

/**
 * Detects the kind of Supabase key. Legacy keys are JWTs, so the (already
 * authenticated) role claim is decoded read-only for validation purposes only.
 */
export function detectSupabaseKeyKind(
  rawKey: string,
): SupabaseKeyKind | "publishable" | "legacy_anon" | "unknown" {
  if (rawKey.startsWith("sb_secret_")) {
    return "sb_secret";
  }
  if (rawKey.startsWith("sb_publishable_")) {
    return "publishable";
  }
  const parts = rawKey.split(".");
  if (parts.length === 3) {
    const payload = parts[1];
    if (payload !== undefined) {
      const role = readJwtClaim(payload, "role");
      if (role === "service_role") {
        return "legacy_service_role_jwt";
      }
      if (role !== undefined) {
        return "legacy_anon";
      }
    }
  }
  return "unknown";
}

function readJwtClaim(payloadSegment: string, claim: string): string | undefined {
  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = globalThis.atob(padded);
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as Record<string, unknown>)[claim];
      return typeof value === "string" ? value : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Safely extracts CORS allowed origins from the environment without throwing.
 * Used for preflight (OPTIONS) responses and early error responses before full
 * configuration validation occurs.
 */
export function parseCorsAllowedOrigins(env: EnvRecord): readonly string[] {
  const corsRaw = readString(env, "CORS_ALLOWED_ORIGINS");
  if (corsRaw === undefined) {
    const appEnv = env.APP_ENV;
    if (appEnv !== "production" && appEnv !== "sandbox") {
      return ["http://localhost:3000", "http://127.0.0.1:3000"];
    }
    return [];
  }
  return corsRaw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Loads and validates the backend configuration.
 *
 * @throws {ConfigError} when the configuration is incomplete or inconsistent.
 */
export function loadConfig(env: EnvRecord): BackendConfig {
  const issues: string[] = [];

  const appEnv = readEnum(env, "APP_ENV", APP_ENVIRONMENTS, "development", issues);
  const isDeployed = appEnv !== "development";
  const serviceName = readString(env, "SERVICE_NAME") ?? "event-ticketing";

  // --- Supabase -----------------------------------------------------------
  const supabaseUrl = requireValue(
    env,
    "SUPABASE_URL",
    issues,
    "Supabase dashboard > Project Settings > Data API",
  );
  requireAbsoluteUrl(supabaseUrl, "SUPABASE_URL", { isDeployed }, issues);

  const supabaseSecretKey = resolveSupabaseSecretKey(env, issues);
  let supabaseKeyKind: SupabaseKeyKind = "sb_secret";
  if (supabaseSecretKey.length > 0) {
    const detected = detectSupabaseKeyKind(supabaseSecretKey);
    if (detected === "publishable" || detected === "legacy_anon") {
      issues.push(
        "SUPABASE_SECRET_KEY looks like a publishable/anon key. The backend needs a secret " +
          "(sb_secret_*) or legacy service_role key; publishable keys are for browser clients only.",
      );
    } else if (detected === "unknown") {
      issues.push(
        "SUPABASE_SECRET_KEY has an unrecognized format (expected sb_secret_* or a JWT with the service_role claim)",
      );
    } else {
      supabaseKeyKind = detected;
    }
  }

  // --- Payment Provider ---------------------------------------------------
  const defaultProvider: PaymentProvider =
    env.PAYMENT_PROVIDER === "epayco" ||
    (env.EPAYCO_PUBLIC_KEY !== undefined && env.PAYMENT_PROVIDER !== "wompi")
      ? "epayco"
      : "wompi";
  const paymentProvider = readEnum(
    env,
    "PAYMENT_PROVIDER",
    PAYMENT_PROVIDERS,
    defaultProvider,
    issues,
  );

  // --- ePayco -------------------------------------------------------------
  const epaycoPublicKey =
    paymentProvider === "epayco"
      ? requireValue(
          env,
          "EPAYCO_PUBLIC_KEY",
          issues,
          "ePayco dashboard > Integraciones > Llaves API (PUBLIC_KEY)",
        )
      : (env.EPAYCO_PUBLIC_KEY?.trim() ?? "");
  const epaycoPrivateKey =
    paymentProvider === "epayco"
      ? requireValue(
          env,
          "EPAYCO_PRIVATE_KEY",
          issues,
          "ePayco dashboard > Integraciones > Llaves API (PRIVATE_KEY)",
        )
      : (env.EPAYCO_PRIVATE_KEY?.trim() ?? "");
  const epaycoPKey =
    paymentProvider === "epayco"
      ? requireValue(
          env,
          "EPAYCO_P_KEY",
          issues,
          "ePayco dashboard > Integraciones > Llaves API (P_KEY)",
        )
      : (env.EPAYCO_P_KEY?.trim() ?? "");
  const epaycoCustIdCliente =
    paymentProvider === "epayco"
      ? requireValue(
          env,
          "EPAYCO_CUST_ID_CLIENTE",
          issues,
          "ePayco dashboard > Integraciones > Llaves API (P_CUST_ID_CLIENTE)",
        )
      : (env.EPAYCO_CUST_ID_CLIENTE?.trim() ?? "");
  const epaycoTest = readBoolean(env, "EPAYCO_TEST", appEnv !== "production", issues);
  const epaycoBaseUrlRaw = readString(env, "EPAYCO_BASE_URL");
  let epaycoBaseUrl = "https://secure.epayco.co/validation/v1/reference";
  if (epaycoBaseUrlRaw !== undefined) {
    if (isDeployed) {
      issues.push("EPAYCO_BASE_URL is only allowed when APP_ENV=development");
    } else if (!isHttpUrl(epaycoBaseUrlRaw)) {
      issues.push("EPAYCO_BASE_URL must be an absolute http(s) URL");
    } else {
      epaycoBaseUrl = epaycoBaseUrlRaw.replace(/\/+$/, "");
    }
  }

  // --- Wompi --------------------------------------------------------------
  // The Wompi environment is derived from APP_ENV and is never configured
  // independently: production money can only be touched by a production deployment.
  const wompiEnvironment: WompiEnvironment = appEnv === "production" ? "production" : "sandbox";
  const wompiDetails = WOMPI_ENVIRONMENT_DETAILS[wompiEnvironment];

  const wompiPublicKey =
    paymentProvider === "wompi"
      ? requireValue(
          env,
          "WOMPI_PUBLIC_KEY",
          issues,
          "Wompi dashboard > Developers > technical integration secrets",
        )
      : (env.WOMPI_PUBLIC_KEY?.trim() ?? "");
  const wompiPrivateKey =
    paymentProvider === "wompi"
      ? requireValue(env, "WOMPI_PRIVATE_KEY", issues, "server-side only")
      : (env.WOMPI_PRIVATE_KEY?.trim() ?? "");
  const wompiIntegritySecret =
    paymentProvider === "wompi"
      ? requireValue(env, "WOMPI_INTEGRITY_SECRET", issues, "signature:integrity")
      : (env.WOMPI_INTEGRITY_SECRET?.trim() ?? "");
  const wompiEventsSecret =
    paymentProvider === "wompi"
      ? requireValue(
          env,
          "WOMPI_EVENTS_SECRET",
          issues,
          "verifies webhook authenticity (X-Event-Checksum)",
        )
      : (env.WOMPI_EVENTS_SECRET?.trim() ?? "");

  if (paymentProvider === "wompi") {
    requirePrefix(
      wompiPublicKey,
      "WOMPI_PUBLIC_KEY",
      wompiDetails.publicKeyPrefix,
      wompiEnvironment,
      issues,
    );
    requirePrefix(
      wompiPrivateKey,
      "WOMPI_PRIVATE_KEY",
      wompiDetails.privateKeyPrefix,
      wompiEnvironment,
      issues,
    );
    requirePrefix(
      wompiIntegritySecret,
      "WOMPI_INTEGRITY_SECRET",
      wompiDetails.integritySecretPrefix,
      wompiEnvironment,
      issues,
    );
    requirePrefix(
      wompiEventsSecret,
      "WOMPI_EVENTS_SECRET",
      wompiDetails.eventsSecretPrefix,
      wompiEnvironment,
      issues,
    );
  }

  const wompiBaseUrlRaw = readString(env, "WOMPI_BASE_URL");
  let wompiBaseUrl = wompiDetails.baseUrl;
  if (wompiBaseUrlRaw !== undefined) {
    // Overrides exist so integration tests can point at a local fake, but they are
    // development-only: nothing else may redirect traffic away from the real host.
    if (isDeployed) {
      issues.push(
        `WOMPI_BASE_URL is only allowed when APP_ENV=development (expected ${wompiDetails.baseUrl} for ${wompiEnvironment})`,
      );
    } else if (!isHttpUrl(wompiBaseUrlRaw)) {
      issues.push("WOMPI_BASE_URL must be an absolute http(s) URL");
    } else {
      wompiBaseUrl = wompiBaseUrlRaw.replace(/\/+$/, "");
    }
  }

  // --- Email (Resend) -----------------------------------------------------
  const emailEnabled = readBoolean(env, "EMAIL_ENABLED", isDeployed, issues);
  const resendApiKey = readString(env, "RESEND_API_KEY");
  const emailFrom = readString(env, "EMAIL_FROM");
  const emailReplyTo = readString(env, "EMAIL_REPLY_TO");

  if (emailEnabled) {
    if (resendApiKey === undefined) {
      issues.push("RESEND_API_KEY is required when EMAIL_ENABLED=true");
    } else if (!resendApiKey.startsWith("re_")) {
      issues.push("RESEND_API_KEY must start with `re_`");
    }
    if (emailFrom === undefined) {
      issues.push(
        "EMAIL_FROM is required when EMAIL_ENABLED=true (for example `Boleteria <no-responder@dominio.com>`)",
      );
    } else if (!isEmailFromValid(emailFrom)) {
      issues.push("EMAIL_FROM must be an email address, optionally with a display name");
    }
  }
  if (emailReplyTo !== undefined && !looksLikeEmail(emailReplyTo)) {
    issues.push("EMAIL_REPLY_TO must be a valid email address");
  }

  // --- Public URLs --------------------------------------------------------
  const publicWebBaseUrl = requireAbsoluteUrl(
    requireValue(
      env,
      "PUBLIC_WEB_BASE_URL",
      issues,
      "public site URL, for example https://evento.example",
    ),
    "PUBLIC_WEB_BASE_URL",
    { isDeployed },
    issues,
  );
  const apiBaseUrl = requireAbsoluteUrl(
    requireValue(env, "API_BASE_URL", issues, "Supabase project functions URL"),
    "API_BASE_URL",
    { isDeployed },
    issues,
  );

  // --- Order reservation window -------------------------------------------
  // Technical default (15 minutes) until the client confirms the real value. Validated here
  // so a bad value fails at startup rather than mid-checkout.
  const reservationRaw = readString(env, "ORDER_RESERVATION_MINUTES");
  let orderReservationMinutes = 15;
  if (reservationRaw !== undefined) {
    const parsedReservation = Number.parseInt(reservationRaw, 10);
    if (!/^\d+$/.test(reservationRaw) || parsedReservation < 1 || parsedReservation > 1440) {
      issues.push("ORDER_RESERVATION_MINUTES must be an integer between 1 and 1440");
    } else {
      orderReservationMinutes = parsedReservation;
    }
  }

  const wompiRedirectUrlRaw = readString(env, "WOMPI_REDIRECT_URL");
  let wompiRedirectUrl: string | undefined;
  if (wompiRedirectUrlRaw !== undefined) {
    wompiRedirectUrl = requireAbsoluteUrl(
      wompiRedirectUrlRaw,
      "WOMPI_REDIRECT_URL",
      { isDeployed },
      issues,
    );
  }

  // --- Confirmation email links and dispatch -----------------------------
  const ticketBaseUrlRaw = readString(env, "TICKET_BASE_URL");
  let ticketBaseUrl: string | undefined;
  if (ticketBaseUrlRaw !== undefined) {
    ticketBaseUrl = requireAbsoluteUrl(ticketBaseUrlRaw, "TICKET_BASE_URL", { isDeployed }, issues);
  }

  const dispatchBatchRaw = readString(env, "EMAIL_DISPATCH_BATCH_SIZE");
  let emailDispatchBatchSize = 10;
  if (dispatchBatchRaw !== undefined) {
    const parsedBatch = Number.parseInt(dispatchBatchRaw, 10);
    if (!/^\d+$/.test(dispatchBatchRaw) || parsedBatch < 1 || parsedBatch > 100) {
      issues.push("EMAIL_DISPATCH_BATCH_SIZE must be an integer between 1 and 100");
    } else {
      emailDispatchBatchSize = parsedBatch;
    }
  }

  // --- Rate limiting ------------------------------------------------------
  // PostgreSQL fixed windows; no Redis in this architecture. The emergency switch is
  // documented in docs/environments.md.
  const rateLimitEnabled = readBoolean(env, "RATE_LIMIT_ENABLED", true, issues);

  // --- Google Sheets projection (optional) --------------------------------
  // `SHEETS_ENABLED` gates the whole projection. Credentials are only validated when the
  // projection is on, so a deployment can carry the variables before enabling it.
  const sheetsEnabled = readBoolean(env, "SHEETS_ENABLED", false, issues);
  const sheetsDataSheetRaw = readString(env, "GOOGLE_SHEETS_DATA_TAB") ?? "Datos";
  const sheetsStatusSheetRaw = readString(env, "GOOGLE_SHEETS_STATUS_TAB") ?? "Estado";
  for (const [name, value] of [
    ["GOOGLE_SHEETS_DATA_TAB", sheetsDataSheetRaw],
    ["GOOGLE_SHEETS_STATUS_TAB", sheetsStatusSheetRaw],
  ] as const) {
    if (value.length > 100) {
      issues.push(`${name} must be at most 100 characters (a Google Sheets tab name limit)`);
    }
  }
  const sheetsServiceAccountEmail = readString(env, "GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const sheetsPrivateKey = readString(env, "GOOGLE_PRIVATE_KEY");
  const sheetsSpreadsheetId = readString(env, "GOOGLE_SPREADSHEET_ID");
  let googleSheets: BackendConfig["googleSheets"] = {
    enabled: false,
    dataSheet: sheetsDataSheetRaw,
    statusSheet: sheetsStatusSheetRaw,
  };
  if (sheetsEnabled) {
    const missing: string[] = [];
    if (sheetsServiceAccountEmail === undefined) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    if (sheetsPrivateKey === undefined) missing.push("GOOGLE_PRIVATE_KEY");
    if (sheetsSpreadsheetId === undefined) missing.push("GOOGLE_SPREADSHEET_ID");
    if (missing.length > 0) {
      issues.push(
        `SHEETS_ENABLED=true requires: ${missing.join(", ")} (projection is optional; set SHEETS_ENABLED=false to disable it)`,
      );
    } else {
      if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(sheetsServiceAccountEmail ?? "")) {
        issues.push(
          "GOOGLE_SERVICE_ACCOUNT_EMAIL must be a service account address (*.iam.gserviceaccount.com)",
        );
      }
      if (!(sheetsPrivateKey ?? "").includes("-----BEGIN PRIVATE KEY-----")) {
        issues.push("GOOGLE_PRIVATE_KEY must be a PKCS#8 PEM private key (BEGIN PRIVATE KEY)");
      }
      if (!/^[A-Za-z0-9_-]{10,120}$/.test(sheetsSpreadsheetId ?? "")) {
        issues.push(
          "GOOGLE_SPREADSHEET_ID must be the id from the sheet URL (letters, digits, - and _)",
        );
      }
      if (issues.length === 0) {
        googleSheets = {
          enabled: true,
          serviceAccountEmail: sheetsServiceAccountEmail ?? "",
          privateKey: sheetsPrivateKey ?? "",
          spreadsheetId: sheetsSpreadsheetId ?? "",
          dataSheet: sheetsDataSheetRaw,
          statusSheet: sheetsStatusSheetRaw,
        };
      }
    }
  }

  // --- Scheduled maintenance ---------------------------------------------
  // Protects the reservation-expiry + outbox-retry endpoint. Required outside development
  // because it mutates orders and sends email.
  const maintenanceApiToken = readString(env, "MAINTENANCE_API_TOKEN");
  if (isDeployed && maintenanceApiToken === undefined) {
    issues.push("MAINTENANCE_API_TOKEN is required outside of development (>= 32 characters)");
  }
  if (maintenanceApiToken !== undefined && maintenanceApiToken.length < 32) {
    issues.push("MAINTENANCE_API_TOKEN must be at least 32 characters long");
  }

  // --- CORS ---------------------------------------------------------------
  const corsRaw = readString(env, "CORS_ALLOWED_ORIGINS");
  const corsAllowedOrigins = (corsRaw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const localhostOriginsAllowed = !isDeployed;
  for (const origin of corsAllowedOrigins) {
    if (!isHttpUrl(origin)) {
      issues.push("CORS_ALLOWED_ORIGINS entries must be absolute http(s) origins");
      continue;
    }
    const parsed = new URL(origin);
    if (isDeployed && parsed.protocol !== "https:") {
      issues.push("CORS_ALLOWED_ORIGINS entries must use https outside of development");
    }
    if (origin !== parsed.origin) {
      issues.push(
        "CORS_ALLOWED_ORIGINS entries must be origins only, without paths or trailing slashes",
      );
    }
    if (!localhostOriginsAllowed && isLocalHostUrl(origin)) {
      issues.push("CORS_ALLOWED_ORIGINS must not include localhost outside of development");
    }
  }
  if (isDeployed && corsAllowedOrigins.length === 0) {
    issues.push(
      "CORS_ALLOWED_ORIGINS is required outside of development (comma-separated origins)",
    );
  }
  if (corsAllowedOrigins.includes("*")) {
    issues.push("CORS_ALLOWED_ORIGINS must list explicit origins; `*` is not accepted");
  }

  // --- Observability ------------------------------------------------------
  const logLevel = readEnum(env, "LOG_LEVEL", LOG_LEVELS, "info", issues);
  if (appEnv === "production" && logLevel === "debug") {
    issues.push(
      "LOG_LEVEL=debug is not allowed when APP_ENV=production (debug payloads can leak personal data)",
    );
  }
  const timezone = readString(env, "TIMEZONE") ?? "America/Bogota";
  if (!isValidTimeZone(timezone)) {
    issues.push("TIMEZONE must be a valid IANA time zone (for example America/Bogota)");
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    appEnv,
    isDeployed,
    serviceName,
    logLevel,
    timezone,
    supabase: {
      url: supabaseUrl,
      secretKey: supabaseSecretKey,
      keyKind: supabaseKeyKind,
    },
    paymentProvider,
    epayco: {
      publicKey: epaycoPublicKey,
      privateKey: epaycoPrivateKey,
      pKey: epaycoPKey,
      custIdCliente: epaycoCustIdCliente,
      test: epaycoTest,
      baseUrl: epaycoBaseUrl,
    },
    wompi: {
      environment: wompiEnvironment,
      baseUrl: wompiBaseUrl,
      publicKey: wompiPublicKey,
      privateKey: wompiPrivateKey,
      integritySecret: wompiIntegritySecret,
      eventsSecret: wompiEventsSecret,
    },
    email: {
      provider: "resend",
      enabled: emailEnabled,
      apiKey: resendApiKey,
      from: emailFrom,
      replyTo: emailReplyTo,
    },
    publicWebBaseUrl,
    apiBaseUrl,
    rateLimitEnabled,
    googleSheets,
    orderReservationMinutes,
    wompiRedirectUrl,
    ticketBaseUrl,
    emailDispatchBatchSize,
    maintenanceApiToken,
    corsAllowedOrigins,
  };
}

/**
 * Safe projection of the configuration for logs and health endpoints.
 * Every credential is replaced by its documented prefix and length.
 */
export function describeConfigForLogs(config: BackendConfig): Record<string, unknown> {
  return {
    appEnv: config.appEnv,
    serviceName: config.serviceName,
    logLevel: config.logLevel,
    timezone: config.timezone,
    supabase: {
      url: config.supabase.url,
      keyKind: config.supabase.keyKind,
      secretKey: describeCredential(config.supabase.secretKey),
    },
    paymentProvider: config.paymentProvider,
    epayco: {
      publicKey: describeCredential(config.epayco.publicKey),
      privateKey: describeCredential(config.epayco.privateKey),
      pKey: describeCredential(config.epayco.pKey),
      custIdCliente:
        config.epayco.custIdCliente.length > 0
          ? `…(len=${config.epayco.custIdCliente.length})`
          : "(not set)",
      test: config.epayco.test,
      baseUrl: config.epayco.baseUrl,
    },
    wompi: {
      environment: config.wompi.environment,
      baseUrl: config.wompi.baseUrl,
      publicKey: describeCredential(config.wompi.publicKey),
      privateKey: describeCredential(config.wompi.privateKey),
      integritySecret: describeCredential(config.wompi.integritySecret),
      eventsSecret: describeCredential(config.wompi.eventsSecret),
    },
    email: {
      provider: config.email.provider,
      enabled: config.email.enabled,
      apiKey: describeCredential(config.email.apiKey),
      from: config.email.from,
      replyTo: config.email.replyTo,
    },
    publicWebBaseUrl: config.publicWebBaseUrl,
    apiBaseUrl: config.apiBaseUrl,
    rateLimitEnabled: config.rateLimitEnabled,
    googleSheets: {
      enabled: config.googleSheets.enabled,
      serviceAccountEmail: config.googleSheets.enabled
        ? config.googleSheets.serviceAccountEmail
        : "(not set)",
      privateKey: config.googleSheets.enabled
        ? `…(len=${config.googleSheets.privateKey.length})`
        : "(not set)",
      spreadsheetId: config.googleSheets.enabled ? config.googleSheets.spreadsheetId : "(not set)",
      dataSheet: config.googleSheets.dataSheet,
      statusSheet: config.googleSheets.statusSheet,
    },
    orderReservationMinutes: config.orderReservationMinutes,
    wompiRedirectUrl: config.wompiRedirectUrl ?? null,
    ticketBaseUrl: config.ticketBaseUrl ?? null,
    emailDispatchBatchSize: config.emailDispatchBatchSize,
    maintenanceApiToken: describeCredential(config.maintenanceApiToken),
    corsAllowedOrigins: config.corsAllowedOrigins,
  };
}
