import { describe, expect, it } from "vitest";

import {
  assertPaymentReady,
  ConfigError,
  describeConfigForLogs,
  describeCredential,
  detectSupabaseKeyKind,
  loadCatalogConfig,
  loadConfig,
  loadOrderConfig,
  parseCorsAllowedOrigins,
  WOMPI_ENVIRONMENT_DETAILS,
} from "@shared/config/env.ts";

const SECRET_KEY = `sb_secret_${"x".repeat(40)}`;

/** Complete, valid development environment. Individual tests override single values. */
const VALID_DEV_ENV: Record<string, string | undefined> = {
  APP_ENV: "development",
  SERVICE_NAME: "event-ticketing",
  LOG_LEVEL: "debug",
  TIMEZONE: "America/Bogota",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SECRET_KEY: SECRET_KEY,
  WOMPI_PUBLIC_KEY: "pub_test_abc",
  WOMPI_PRIVATE_KEY: "prv_test_abc",
  WOMPI_INTEGRITY_SECRET: "test_integrity_abc",
  WOMPI_EVENTS_SECRET: "test_events_abc",
  EMAIL_ENABLED: "false",
  PUBLIC_WEB_BASE_URL: "http://localhost:3000",
  API_BASE_URL: "http://127.0.0.1:54321/functions/v1",
  MAINTENANCE_API_TOKEN: "b".repeat(32),
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
};

const VALID_SANDBOX_ENV: Record<string, string | undefined> = {
  ...VALID_DEV_ENV,
  APP_ENV: "sandbox",
  LOG_LEVEL: "info",
  SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  PUBLIC_WEB_BASE_URL: "https://evento.example",
  API_BASE_URL: "https://abcdefghijklmnop.supabase.co/functions/v1",
  CORS_ALLOWED_ORIGINS: "https://evento.example",
  EMAIL_ENABLED: "true",
  RESEND_API_KEY: "re_abc123",
  EMAIL_FROM: "Boleteria <no-responder@evento.example>",
};

function expectConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("loadConfig should have thrown");
}

describe("configuration", () => {
  it("loads a complete development configuration", () => {
    const config = loadConfig(VALID_DEV_ENV);
    expect(config.appEnv).toBe("development");
    expect(config.isDeployed).toBe(false);
    expect(config.wompi.environment).toBe("sandbox");
    expect(config.wompi.baseUrl).toBe(WOMPI_ENVIRONMENT_DETAILS.sandbox.baseUrl);
    expect(config.wompi.baseUrl).toBe("https://sandbox.wompi.co/v1");
    expect(config.supabase.keyKind).toBe("sb_secret");
    expect(config.email.enabled).toBe(false);
    expect(config.timezone).toBe("America/Bogota");
  });

  it("loads a complete sandbox configuration and derives the Wompi environment", () => {
    const config = loadConfig(VALID_SANDBOX_ENV);
    expect(config.wompi.environment).toBe("sandbox");
    expect(config.email.enabled).toBe(true);
    expect(config.isDeployed).toBe(true);
  });

  it("derives production only from APP_ENV=production", () => {
    const production = loadConfig({
      ...VALID_SANDBOX_ENV,
      APP_ENV: "production",
      WOMPI_PUBLIC_KEY: "pub_prod_abc",
      WOMPI_PRIVATE_KEY: "prv_prod_abc",
      WOMPI_INTEGRITY_SECRET: "prod_integrity_abc",
      WOMPI_EVENTS_SECRET: "prod_events_abc",
    });
    expect(production.wompi.environment).toBe("production");
    expect(production.wompi.baseUrl).toBe("https://production.wompi.co/v1");
  });

  it("refuses to mix Wompi credentials between environments", () => {
    // Production keys in a sandbox deployment.
    const error = expectConfigError({
      ...VALID_SANDBOX_ENV,
      WOMPI_PRIVATE_KEY: "prv_prod_abc",
      WOMPI_PUBLIC_KEY: "pub_prod_abc",
      WOMPI_INTEGRITY_SECRET: "prod_integrity_abc",
      WOMPI_EVENTS_SECRET: "prod_events_abc",
    });
    expect(error.issues.some((issue) => issue.includes("WOMPI_PRIVATE_KEY"))).toBe(true);
    expect(error.issues.some((issue) => issue.includes("pub_test_"))).toBe(true);

    // Sandbox keys in a production deployment.
    const prodError = expectConfigError({
      ...VALID_SANDBOX_ENV,
      APP_ENV: "production",
    });
    expect(prodError.issues.some((issue) => issue.includes("WOMPI_PUBLIC_KEY"))).toBe(true);
  });

  it("never echoes credential values in error messages", () => {
    const error = expectConfigError({
      ...VALID_SANDBOX_ENV,
      WOMPI_PRIVATE_KEY: "prv_prod_SUPER_SECRET_VALUE",
    });
    const serialized = `${error.message}\n${error.issues.join("\n")}`;
    expect(serialized).not.toContain("SUPER_SECRET_VALUE");
    expect(serialized).toContain("WOMPI_PRIVATE_KEY");
  });

  it("rejects publishable/anon Supabase keys and accepts legacy service_role JWTs", () => {
    const publishable = `sb_publishable_${"y".repeat(30)}`;
    const publishableError = expectConfigError({
      ...VALID_DEV_ENV,
      SUPABASE_SECRET_KEY: publishable,
    });
    expect(publishableError.issues.some((issue) => issue.includes("publishable"))).toBe(true);

    const anonJwt = makeJwt({ role: "anon" });
    const anonError = expectConfigError({ ...VALID_DEV_ENV, SUPABASE_SECRET_KEY: anonJwt });
    expect(anonError.issues.some((issue) => issue.includes("publishable"))).toBe(true);

    const serviceRoleJwt = makeJwt({ role: "service_role" });
    const config = loadConfig({ ...VALID_DEV_ENV, SUPABASE_SECRET_KEY: serviceRoleJwt });
    expect(config.supabase.keyKind).toBe("legacy_service_role_jwt");

    const nonsenseError = expectConfigError({ ...VALID_DEV_ENV, SUPABASE_SECRET_KEY: "not-a-key" });
    expect(nonsenseError.issues.some((issue) => issue.includes("unrecognized format"))).toBe(true);
  });

  it("requires every Wompi credential", () => {
    const error = expectConfigError({
      ...VALID_DEV_ENV,
      WOMPI_PUBLIC_KEY: undefined,
      WOMPI_PRIVATE_KEY: undefined,
      WOMPI_INTEGRITY_SECRET: undefined,
      WOMPI_EVENTS_SECRET: undefined,
    });
    for (const name of [
      "WOMPI_PUBLIC_KEY",
      "WOMPI_PRIVATE_KEY",
      "WOMPI_INTEGRITY_SECRET",
      "WOMPI_EVENTS_SECRET",
    ]) {
      expect(error.issues.some((issue) => issue.startsWith(`${name} is required`))).toBe(true);
    }
  });

  it("only allows a Wompi base URL override in development", () => {
    const dev = loadConfig({ ...VALID_DEV_ENV, WOMPI_BASE_URL: "http://127.0.0.1:8787/v1/" });
    expect(dev.wompi.baseUrl).toBe("http://127.0.0.1:8787/v1");

    const sandboxError = expectConfigError({
      ...VALID_SANDBOX_ENV,
      WOMPI_BASE_URL: "http://127.0.0.1:8787/v1",
    });
    expect(sandboxError.issues.some((issue) => issue.includes("WOMPI_BASE_URL"))).toBe(true);
  });

  it("enforces https, CORS and maintenance token rules outside development", () => {
    const error = expectConfigError({
      ...VALID_SANDBOX_ENV,
      PUBLIC_WEB_BASE_URL: "http://evento.example",
      API_BASE_URL: "http://evento.example/functions/v1",
      CORS_ALLOWED_ORIGINS: "http://localhost:3000,https://evento.example/path",
      MAINTENANCE_API_TOKEN: "short",
    });
    expect(error.issues.some((issue) => issue.includes("PUBLIC_WEB_BASE_URL must use https"))).toBe(
      true,
    );
    expect(error.issues.some((issue) => issue.includes("API_BASE_URL must use https"))).toBe(true);
    expect(error.issues.some((issue) => issue.includes("localhost outside of development"))).toBe(
      true,
    );
    expect(error.issues.some((issue) => issue.includes("origins only"))).toBe(true);
    expect(error.issues.some((issue) => issue.includes("MAINTENANCE_API_TOKEN"))).toBe(true);
  });

  it("reads the payment return URL from PAYMENT_RETURN_URL, falling back to WOMPI_REDIRECT_URL", () => {
    expect(loadConfig(VALID_DEV_ENV).paymentReturnUrl).toBeUndefined();
    expect(
      loadConfig({ ...VALID_DEV_ENV, PAYMENT_RETURN_URL: "http://localhost:3000/gracias" })
        .paymentReturnUrl,
    ).toBe("http://localhost:3000/gracias");
    expect(
      loadConfig({ ...VALID_DEV_ENV, WOMPI_REDIRECT_URL: "http://localhost:3000/legacy" })
        .paymentReturnUrl,
    ).toBe("http://localhost:3000/legacy");
    expect(
      loadConfig({
        ...VALID_DEV_ENV,
        PAYMENT_RETURN_URL: "http://localhost:3000/gracias",
        WOMPI_REDIRECT_URL: "http://localhost:3000/legacy",
      }).paymentReturnUrl,
    ).toBe("http://localhost:3000/gracias");
  });

  it("validates the payment return URL under the variable that supplied it", () => {
    const current = expectConfigError({
      ...VALID_SANDBOX_ENV,
      PAYMENT_RETURN_URL: "http://evento.example/gracias",
    });
    expect(
      current.issues.some((issue) => issue.includes("PAYMENT_RETURN_URL must use https")),
    ).toBe(true);

    const legacy = expectConfigError({ ...VALID_SANDBOX_ENV, WOMPI_REDIRECT_URL: "not-a-url" });
    expect(legacy.issues.some((issue) => issue.includes("WOMPI_REDIRECT_URL"))).toBe(true);

    // The current name wins, so a broken legacy value next to it is never read.
    const config = loadConfig({
      ...VALID_SANDBOX_ENV,
      PAYMENT_RETURN_URL: "https://evento.example/gracias",
      WOMPI_REDIRECT_URL: "not-a-url",
    });
    expect(config.paymentReturnUrl).toBe("https://evento.example/gracias");
    expect(describeConfigForLogs(config)).toMatchObject({
      paymentReturnUrl: "https://evento.example/gracias",
    });
  });

  it("requires the maintenance token outside development", () => {
    const error = expectConfigError({ ...VALID_SANDBOX_ENV, MAINTENANCE_API_TOKEN: undefined });
    expect(error.issues.some((issue) => issue.includes("MAINTENANCE_API_TOKEN is required"))).toBe(
      true,
    );
  });

  it("validates the email dispatch batch size and the ticket base URL", () => {
    const error = expectConfigError({
      ...VALID_SANDBOX_ENV,
      EMAIL_DISPATCH_BATCH_SIZE: "0",
      TICKET_BASE_URL: "not-a-url",
    });
    expect(error.issues.some((issue) => issue.includes("EMAIL_DISPATCH_BATCH_SIZE"))).toBe(true);
    expect(error.issues.some((issue) => issue.includes("TICKET_BASE_URL"))).toBe(true);

    const config = loadConfig({
      ...VALID_SANDBOX_ENV,
      TICKET_BASE_URL: "https://evento.example/entrada",
      EMAIL_DISPATCH_BATCH_SIZE: "25",
    });
    expect(config.ticketBaseUrl).toBe("https://evento.example/entrada");
    expect(config.emailDispatchBatchSize).toBe(25);
  });

  it("rejects a wildcard CORS policy and requires explicit origins when deployed", () => {
    const wildcard = expectConfigError({ ...VALID_SANDBOX_ENV, CORS_ALLOWED_ORIGINS: "*" });
    expect(wildcard.issues.some((issue) => issue.includes("*"))).toBe(true);

    const missing = expectConfigError({ ...VALID_SANDBOX_ENV, CORS_ALLOWED_ORIGINS: "" });
    expect(missing.issues.some((issue) => issue.includes("CORS_ALLOWED_ORIGINS is required"))).toBe(
      true,
    );
  });

  it("requires the email credentials when email is enabled", () => {
    const error = expectConfigError({
      ...VALID_SANDBOX_ENV,
      RESEND_API_KEY: undefined,
      EMAIL_FROM: "not-an-email",
    });
    expect(error.issues.some((issue) => issue.includes("RESEND_API_KEY is required"))).toBe(true);
    expect(error.issues.some((issue) => issue.includes("EMAIL_FROM"))).toBe(true);

    const badPrefix = expectConfigError({ ...VALID_SANDBOX_ENV, RESEND_API_KEY: "sk_live_123" });
    expect(badPrefix.issues.some((issue) => issue.includes("re_"))).toBe(true);
  });

  it("keeps debug logging out of production and validates the time zone", () => {
    const error = expectConfigError({
      ...VALID_SANDBOX_ENV,
      APP_ENV: "production",
      WOMPI_PUBLIC_KEY: "pub_prod_abc",
      WOMPI_PRIVATE_KEY: "prv_prod_abc",
      WOMPI_INTEGRITY_SECRET: "prod_integrity_abc",
      WOMPI_EVENTS_SECRET: "prod_events_abc",
      LOG_LEVEL: "debug",
      TIMEZONE: "Moon/Base",
    });
    expect(error.issues.some((issue) => issue.includes("LOG_LEVEL=debug"))).toBe(true);
    expect(error.issues.some((issue) => issue.includes("TIMEZONE"))).toBe(true);
  });

  it("collects every problem at once instead of failing on the first", () => {
    const error = expectConfigError({});
    expect(error.issues.length).toBeGreaterThanOrEqual(8);
  });

  it("reports which credential is loaded without revealing it", () => {
    expect(describeCredential("prv_test_ABC123")).toBe("prv_test_…(len=15)");
    expect(describeCredential("prod_integrity_XYZ")).toBe("prod_integrity_…(len=18)");
    expect(describeCredential("unknown-format-value")).toBe("…(len=20)");
    expect(describeCredential(undefined)).toBe("(not set)");
    expect(describeCredential("")).toBe("(not set)");
  });

  it("produces a log-safe projection that contains no credential values", () => {
    const config = loadConfig({
      ...VALID_SANDBOX_ENV,
      SHEETS_ENABLED: "true",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "projection@proyecto.iam.gserviceaccount.com",
      GOOGLE_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----",
      GOOGLE_SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    });
    expect(config.googleSheets.enabled).toBe(true);
    const projection = JSON.stringify(describeConfigForLogs(config));

    for (const secret of [
      config.supabase.secretKey,
      config.wompi.privateKey,
      config.wompi.integritySecret,
      config.wompi.eventsSecret,
      config.email.apiKey ?? "",
      config.maintenanceApiToken ?? "",
      config.googleSheets.enabled ? config.googleSheets.privateKey : "",
    ]) {
      if (secret.length > 0) {
        expect(projection).not.toContain(secret);
      }
    }
    expect(projection).toContain("sandbox");
    expect(projection).toContain("prv_test_");
  });

  it("enables rate limiting by default and keeps the Sheets projection off", () => {
    const config = loadConfig(VALID_DEV_ENV);
    expect(config.rateLimitEnabled).toBe(true);
    expect(config.googleSheets.enabled).toBe(false);
    expect(config.googleSheets.dataSheet).toBe("Datos");
    expect(config.googleSheets.statusSheet).toBe("Estado");

    const off = loadConfig({ ...VALID_DEV_ENV, RATE_LIMIT_ENABLED: "false" });
    expect(off.rateLimitEnabled).toBe(false);

    const bad = expectConfigError({ ...VALID_DEV_ENV, RATE_LIMIT_ENABLED: "yes please" });
    expect(bad.issues.some((issue) => issue.includes("RATE_LIMIT_ENABLED"))).toBe(true);
  });

  it("requires every Google credential once the projection is enabled", () => {
    const error = expectConfigError({ ...VALID_DEV_ENV, SHEETS_ENABLED: "true" });
    for (const name of [
      "GOOGLE_SERVICE_ACCOUNT_EMAIL",
      "GOOGLE_PRIVATE_KEY",
      "GOOGLE_SPREADSHEET_ID",
    ]) {
      expect(error.issues.some((issue) => issue.includes(name))).toBe(true);
    }
    // A half-configured deployment must fail at startup instead of writing somewhere else.
    const partial = expectConfigError({
      ...VALID_DEV_ENV,
      SHEETS_ENABLED: "true",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "projection@proyecto.iam.gserviceaccount.com",
    });
    expect(partial.issues.some((issue) => issue.includes("GOOGLE_PRIVATE_KEY"))).toBe(true);
    expect(partial.issues.some((issue) => issue.includes("GOOGLE_SPREADSHEET_ID"))).toBe(true);
  });

  it("validates the shape of the Google credentials when enabled", () => {
    const error = expectConfigError({
      ...VALID_DEV_ENV,
      SHEETS_ENABLED: "true",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "someone@gmail.com",
      GOOGLE_PRIVATE_KEY: "not-a-pem",
      GOOGLE_SPREADSHEET_ID: "too short",
      GOOGLE_SHEETS_DATA_TAB: "x".repeat(101),
    });
    expect(
      error.issues.some((issue) => issue.includes("GOOGLE_SERVICE_ACCOUNT_EMAIL must be")),
    ).toBe(true);
    expect(error.issues.some((issue) => issue.includes("GOOGLE_PRIVATE_KEY must be"))).toBe(true);
    expect(error.issues.some((issue) => issue.includes("GOOGLE_SPREADSHEET_ID must be"))).toBe(
      true,
    );
    expect(error.issues.some((issue) => issue.includes("GOOGLE_SHEETS_DATA_TAB"))).toBe(true);

    const valid = loadConfig({
      ...VALID_DEV_ENV,
      SHEETS_ENABLED: "true",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "projection@proyecto.iam.gserviceaccount.com",
      GOOGLE_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----",
      GOOGLE_SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      GOOGLE_SHEETS_DATA_TAB: "Entradas",
    });
    expect(valid.googleSheets.enabled).toBe(true);
    if (valid.googleSheets.enabled) {
      expect(valid.googleSheets.spreadsheetId).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
      expect(valid.googleSheets.dataSheet).toBe("Entradas");
    }
  });

  it("accepts present-but-unused Google credentials while the projection is off", () => {
    // A deployment can carry the variables before enabling the projection; nothing is
    // validated until SHEETS_ENABLED=true, and no Google call is ever made.
    const config = loadConfig({
      ...VALID_DEV_ENV,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "not-even-an-email",
      GOOGLE_SPREADSHEET_ID: "not a valid id",
    });
    expect(config.googleSheets.enabled).toBe(false);
  });

  it("detects key kinds directly", () => {
    expect(detectSupabaseKeyKind("sb_secret_abc")).toBe("sb_secret");
    expect(detectSupabaseKeyKind("sb_publishable_abc")).toBe("publishable");
    expect(detectSupabaseKeyKind(makeJwt({ role: "service_role" }))).toBe(
      "legacy_service_role_jwt",
    );
    expect(detectSupabaseKeyKind(makeJwt({ role: "anon" }))).toBe("legacy_anon");
    expect(detectSupabaseKeyKind("garbage")).toBe("unknown");
    expect(detectSupabaseKeyKind("a.b")).toBe("unknown");
  });
});

describe("hosted Supabase key resolution", () => {
  /**
   * The valid environment WITHOUT the explicit server key, which is how a hosted deployment
   * looks: Supabase reserves the `SUPABASE_` prefix, so a custom `SUPABASE_SECRET_KEY` cannot
   * exist there and the platform provides the key bags instead.
   */
  function hostedEnv(
    extra: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...VALID_DEV_ENV };
    delete env.SUPABASE_SECRET_KEY;
    return { ...env, ...extra };
  }

  it("uses the platform key bag when a deployment cannot define a SUPABASE_ name", () => {
    const config = loadConfig(
      hostedEnv({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }) }),
    );
    expect(config.supabase.secretKey).toBe(SECRET_KEY);
    expect(config.supabase.keyKind).toBe("sb_secret");
  });

  it("accepts a bag whose single entry is named something else", () => {
    const config = loadConfig(
      hostedEnv({ SUPABASE_SECRET_KEYS: JSON.stringify({ reset: SECRET_KEY }) }),
    );
    expect(config.supabase.secretKey).toBe(SECRET_KEY);
  });

  it("accepts the array shape a platform may expose", () => {
    const config = loadConfig(
      hostedEnv({
        SUPABASE_SECRET_KEYS: JSON.stringify([{ name: "default", api_key: SECRET_KEY }]),
      }),
    );
    expect(config.supabase.secretKey).toBe(SECRET_KEY);
  });

  it("falls back to the platform's legacy service-role variable", () => {
    const jwt = makeJwt({ role: "service_role" });
    const config = loadConfig(hostedEnv({ SUPABASE_SERVICE_ROLE_KEY: jwt }));
    expect(config.supabase.secretKey).toBe(jwt);
    expect(config.supabase.keyKind).toBe("legacy_service_role_jwt");
  });

  it("prefers the explicit SUPABASE_SECRET_KEY when several sources exist", () => {
    const explicit = `sb_secret_${"y".repeat(40)}`;
    const config = loadConfig(
      hostedEnv({
        SUPABASE_SECRET_KEY: explicit,
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }),
        SUPABASE_SERVICE_ROLE_KEY: makeJwt({ role: "service_role" }),
      }),
    );
    expect(config.supabase.secretKey).toBe(explicit);
  });

  it("still refuses a publishable key coming from the platform bag", () => {
    const publishable = `sb_publishable_${"z".repeat(30)}`;
    const error = expectConfigError(
      hostedEnv({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: publishable }) }),
    );
    expect(error.issues.some((issue) => issue.includes("publishable"))).toBe(true);
  });

  it("reports a malformed bag by variable name without echoing its contents", () => {
    const error = expectConfigError(
      hostedEnv({ SUPABASE_SECRET_KEYS: "not-json-at-all-secret-value" }),
    );
    const serialized = `${error.message}\n${error.issues.join("\n")}`;
    expect(serialized).toContain("SUPABASE_SECRET_KEYS");
    expect(serialized).not.toContain("not-json-at-all-secret-value");
  });

  it("reports an ambiguous bag instead of guessing which key to use", () => {
    const error = expectConfigError(
      hostedEnv({
        SUPABASE_SECRET_KEYS: JSON.stringify({
          first: SECRET_KEY,
          second: `sb_secret_${"w".repeat(40)}`,
        }),
      }),
    );
    expect(error.issues.some((issue) => issue.includes("default"))).toBe(true);
  });

  it("still requires a key when no source provides one", () => {
    const error = expectConfigError(hostedEnv());
    expect(error.issues.some((issue) => issue.startsWith("SUPABASE_SECRET_KEY is required"))).toBe(
      true,
    );
  });
});

describe("ePayco configuration", () => {
  const VALID_EPAYCO_ENV: Record<string, string | undefined> = {
    APP_ENV: "development",
    PAYMENT_PROVIDER: "epayco",
    SERVICE_NAME: "event-ticketing",
    LOG_LEVEL: "debug",
    TIMEZONE: "America/Bogota",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SECRET_KEY: SECRET_KEY,
    EPAYCO_PUBLIC_KEY: "mock_public_key_123",
    EPAYCO_PRIVATE_KEY: "mock_private_key_123",
    EPAYCO_P_KEY: "mock_p_key_123",
    EPAYCO_CUST_ID_CLIENTE: "998877",
    EPAYCO_TEST: "true",
    EMAIL_ENABLED: "false",
    PUBLIC_WEB_BASE_URL: "http://localhost:3000",
    API_BASE_URL: "http://127.0.0.1:54321/functions/v1",
    MAINTENANCE_API_TOKEN: "b".repeat(32),
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  };

  it("loads a complete ePayco configuration", () => {
    const config = loadConfig(VALID_EPAYCO_ENV);
    expect(config.paymentProvider).toBe("epayco");
    expect(config.epayco.publicKey).toBe("mock_public_key_123");
    expect(config.epayco.privateKey).toBe("mock_private_key_123");
    expect(config.epayco.pKey).toBe("mock_p_key_123");
    expect(config.epayco.custIdCliente).toBe("998877");
    expect(config.epayco.test).toBe(true);
    expect(config.epayco.baseUrl).toBe("https://secure.epayco.co/validation/v1/reference");
  });

  it("requires every ePayco credential when PAYMENT_PROVIDER=epayco", () => {
    const error = expectConfigError({
      ...VALID_EPAYCO_ENV,
      EPAYCO_PUBLIC_KEY: undefined,
      EPAYCO_PRIVATE_KEY: undefined,
      EPAYCO_P_KEY: undefined,
      EPAYCO_CUST_ID_CLIENTE: undefined,
    });
    for (const name of [
      "EPAYCO_PUBLIC_KEY",
      "EPAYCO_PRIVATE_KEY",
      "EPAYCO_P_KEY",
      "EPAYCO_CUST_ID_CLIENTE",
    ]) {
      expect(error.issues.some((issue) => issue.startsWith(`${name} is required`))).toBe(true);
    }
  });

  it("only allows an ePayco base URL override in development", () => {
    const dev = loadConfig({
      ...VALID_EPAYCO_ENV,
      EPAYCO_BASE_URL: "http://127.0.0.1:8787/validation/v1/reference/",
    });
    expect(dev.epayco.baseUrl).toBe("http://127.0.0.1:8787/validation/v1/reference");

    const deployedError = expectConfigError({
      ...VALID_EPAYCO_ENV,
      APP_ENV: "sandbox",
      EPAYCO_BASE_URL: "http://127.0.0.1:8787/validation/v1/reference",
    });
    expect(deployedError.issues.some((issue) => issue.includes("EPAYCO_BASE_URL"))).toBe(true);
  });

  describe("payment provider selection and validation", () => {
    it("defaults to wompi when PAYMENT_PROVIDER is absent and no ePayco credentials exist", () => {
      const config = loadConfig(VALID_DEV_ENV);
      expect(config.paymentProvider).toBe("wompi");
      expect(config.wompi.publicKey).toBe("pub_test_abc");
    });

    it("defaults to epayco when PAYMENT_PROVIDER is absent but EPAYCO_PUBLIC_KEY is provided", () => {
      const withoutProvider: Record<string, string | undefined> = { ...VALID_EPAYCO_ENV };
      delete withoutProvider.PAYMENT_PROVIDER;
      const config = loadConfig(withoutProvider);
      expect(config.paymentProvider).toBe("epayco");
      expect(config.epayco.publicKey).toBe("mock_public_key_123");
    });

    it("requires ePayco credentials when PAYMENT_PROVIDER=epayco without requiring Wompi credentials", () => {
      const config = loadConfig(VALID_EPAYCO_ENV);
      expect(config.paymentProvider).toBe("epayco");
      // Wompi keys are empty placeholders and no Wompi issues are raised
      expect(config.wompi.publicKey).toBe("");
      expect(config.wompi.privateKey).toBe("");
    });

    it("reports missing ePayco credentials when PAYMENT_PROVIDER=epayco and never asks for Wompi credentials", () => {
      const error = expectConfigError({
        ...VALID_DEV_ENV,
        PAYMENT_PROVIDER: "epayco",
        WOMPI_PUBLIC_KEY: undefined,
        WOMPI_PRIVATE_KEY: undefined,
        WOMPI_INTEGRITY_SECRET: undefined,
        WOMPI_EVENTS_SECRET: undefined,
      });
      expect(error.issues.some((issue) => issue.includes("EPAYCO_PUBLIC_KEY is required"))).toBe(
        true,
      );
      expect(error.issues.some((issue) => issue.includes("EPAYCO_PRIVATE_KEY is required"))).toBe(
        true,
      );
      expect(error.issues.some((issue) => issue.includes("EPAYCO_P_KEY is required"))).toBe(true);
      expect(
        error.issues.some((issue) => issue.includes("EPAYCO_CUST_ID_CLIENTE is required")),
      ).toBe(true);
      expect(error.issues.some((issue) => issue.includes("WOMPI_"))).toBe(false);
    });

    it("reports missing Wompi credentials when PAYMENT_PROVIDER=wompi and never asks for ePayco credentials", () => {
      const error = expectConfigError({
        ...VALID_DEV_ENV,
        PAYMENT_PROVIDER: "wompi",
        WOMPI_PUBLIC_KEY: undefined,
        WOMPI_PRIVATE_KEY: undefined,
        WOMPI_INTEGRITY_SECRET: undefined,
        WOMPI_EVENTS_SECRET: undefined,
      });
      expect(error.issues.some((issue) => issue.includes("WOMPI_PUBLIC_KEY is required"))).toBe(
        true,
      );
      expect(error.issues.some((issue) => issue.includes("WOMPI_PRIVATE_KEY is required"))).toBe(
        true,
      );
      expect(
        error.issues.some((issue) => issue.includes("WOMPI_INTEGRITY_SECRET is required")),
      ).toBe(true);
      expect(error.issues.some((issue) => issue.includes("WOMPI_EVENTS_SECRET is required"))).toBe(
        true,
      );
      expect(error.issues.some((issue) => issue.includes("EPAYCO_"))).toBe(false);
    });
  });

  describe("CORS origin parser", () => {
    it("parses comma-separated origins cleanly", () => {
      const origins = parseCorsAllowedOrigins({
        CORS_ALLOWED_ORIGINS:
          " https://resetwellness.co , https://soqmdpqjjdmdhtgsutab.supabase.co ",
      });
      expect(origins).toEqual([
        "https://resetwellness.co",
        "https://soqmdpqjjdmdhtgsutab.supabase.co",
      ]);
    });

    it("returns development default origins when unconfigured in development", () => {
      const devOrigins = parseCorsAllowedOrigins({ APP_ENV: "development" });
      expect(devOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);

      const emptyEnvOrigins = parseCorsAllowedOrigins({});
      expect(emptyEnvOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
    });

    it("returns empty array when unconfigured in sandbox or production", () => {
      expect(parseCorsAllowedOrigins({ APP_ENV: "sandbox" })).toEqual([]);
      expect(parseCorsAllowedOrigins({ APP_ENV: "production" })).toEqual([]);
    });
  });

  describe("decoupled configuration validation", () => {
    const MINIMAL_DB_ENV: Record<string, string | undefined> = {
      APP_ENV: "sandbox",
      SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
      SUPABASE_SECRET_KEY: SECRET_KEY,
    };

    it("loads catalog configuration cleanly without payment credentials or public URLs", () => {
      const config = loadCatalogConfig(MINIMAL_DB_ENV);
      expect(config.appEnv).toBe("sandbox");
      expect(config.supabase.url).toBe("https://abcdefghijklmnop.supabase.co");
      expect(config.epayco.publicKey).toBe("");
      expect(config.wompi.publicKey).toBe("");
      expect(config.publicWebBaseUrl).toBe("");
      expect(config.apiBaseUrl).toBe("");
    });

    it("loads order configuration cleanly without payment credentials to allow quoting", () => {
      const config = loadOrderConfig(MINIMAL_DB_ENV);
      expect(config.orderReservationMinutes).toBe(15);
      expect(config.epayco.publicKey).toBe("");
      expect(config.wompi.publicKey).toBe("");
    });

    it("assertPaymentReady detects missing ePayco credentials and apiBaseUrl at payment time", () => {
      const config = loadOrderConfig({
        ...MINIMAL_DB_ENV,
        PAYMENT_PROVIDER: "epayco",
      });

      expect(() => {
        assertPaymentReady(config);
      }).toThrow(ConfigError);
      try {
        assertPaymentReady(config);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const issues = (error as ConfigError).issues;
        expect(issues.some((i) => i.includes("EPAYCO_PUBLIC_KEY"))).toBe(true);
        expect(issues.some((i) => i.includes("EPAYCO_PRIVATE_KEY"))).toBe(true);
        expect(issues.some((i) => i.includes("EPAYCO_P_KEY"))).toBe(true);
        expect(issues.some((i) => i.includes("EPAYCO_CUST_ID_CLIENTE"))).toBe(true);
        expect(issues.some((i) => i.includes("API_BASE_URL"))).toBe(true);
        expect(issues.some((i) => i.includes("WOMPI_"))).toBe(false);
      }
    });

    it("assertPaymentReady succeeds when ePayco credentials and apiBaseUrl are provided", () => {
      const config = loadOrderConfig({
        ...MINIMAL_DB_ENV,
        PAYMENT_PROVIDER: "epayco",
        EPAYCO_PUBLIC_KEY: "mock_pub_key",
        EPAYCO_PRIVATE_KEY: "mock_prv_key",
        EPAYCO_P_KEY: "mock_p_key",
        EPAYCO_CUST_ID_CLIENTE: "123456",
        API_BASE_URL: "https://abcdefghijklmnop.supabase.co/functions/v1",
      });

      expect(() => {
        assertPaymentReady(config);
      }).not.toThrow();
    });

    it("assertPaymentReady detects missing Wompi credentials when provider is wompi", () => {
      const config = loadOrderConfig({
        ...MINIMAL_DB_ENV,
        PAYMENT_PROVIDER: "wompi",
      });

      expect(() => {
        assertPaymentReady(config);
      }).toThrow(ConfigError);
      try {
        assertPaymentReady(config);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const issues = (error as ConfigError).issues;
        expect(issues.some((i) => i.includes("WOMPI_PUBLIC_KEY"))).toBe(true);
        expect(issues.some((i) => i.includes("WOMPI_PRIVATE_KEY"))).toBe(true);
        expect(issues.some((i) => i.includes("WOMPI_INTEGRITY_SECRET"))).toBe(true);
        expect(issues.some((i) => i.includes("WOMPI_EVENTS_SECRET"))).toBe(true);
        expect(issues.some((i) => i.includes("EPAYCO_"))).toBe(false);
      }
    });
  });
});

/** Builds a decodable (not validly signed) JWT for validation tests. */
function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}
