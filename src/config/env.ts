/**
 * Frontend configuration (Phase 6B, extended in Phase 6D).
 *
 * Only `VITE_*` variables exist here, and only values that are safe to ship in a browser
 * bundle. Nothing in this module can read a private key or a server credential: Vite exposes
 * an `import.meta.env` entry to the bundle only when it is prefixed `VITE_`, and the backend
 * secrets (`SUPABASE_SECRET_KEY`, `EPAYCO_PRIVATE_KEY`, `EPAYCO_P_KEY`, Resend key, Google
 * Apps Script secret) are never configured on the frontend at all.
 *
 * Every variable has a development-safe default so the app runs with zero configuration
 * locally; the production defaults below point at the real hosted backend so a `vite build`
 * without any environment variables still reaches the deployed Edge Functions instead of a
 * developer's laptop (Phase 6D).
 */

export type FrontendConfig = {
  /** Base URL of the Edge Functions, e.g. `https://<ref>.supabase.co/functions/v1`. */
  readonly apiBaseUrl: string;
  /** Event code the landing page sells (`GET /events/{code}`). */
  readonly eventCode: string;
  /** Ticket type code inside that event. */
  readonly ticketTypeCode: string;
  /**
   * Whether this build may start a real checkout.
   *
   * Default `true`. A build that sets `VITE_CHECKOUT_ENABLED=false` is a **containment** build:
   * it shows the real catalogue and prices, but every purchase entry point explains that buying
   * is temporarily unavailable instead of starting an order. It exists so the public site can
   * point at a backend whose payment provider is not configured yet without ever creating an
   * order, a checkout session or a payment. QA and demo builds never set it.
   */
  readonly checkoutEnabled: boolean;
};

/** Local Supabase Edge Functions (the value `npm run functions:serve` serves). */
export const LOCAL_API_BASE_URL = "http://127.0.0.1:54321/functions/v1";

/**
 * Hosted Supabase project of the client event ("Reset Wellnes", East US).
 *
 * A project URL is public by construction — it is visible in every request the browser makes —
 * so it is safe to keep here. The keys that would make it dangerous are never frontend
 * variables (see the module comment above).
 */
export const HOSTED_API_BASE_URL = "https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1";

/**
 * Canonical event code for Re set Sunset Vol. 1.
 *
 * Operator data, not client content: it must equal the `code` of the event row in the database.
 * The backend normalizes codes to upper case (`normalizeEventCode`), so the canonical form is
 * the upper-case one. The placeholder event's code is gone from every production-facing file
 * (Phase 6D); `tests/frontend/hosted-config.test.ts` fails if it comes back.
 */
export const DEFAULT_EVENT_CODE = "RESET-SUNSET-2026";

/**
 * Ticket type the page sells by default.
 *
 * "GENERAL" is the one product name the client uses that is also a plausible ticket-type code
 * under either modelling of the catalogue (a single general admission with staged
 * preventa/general tiers, or separate preventa/comparte/general products). The operator sets
 * `VITE_TICKET_TYPE_CODE` once the catalogue exists; the backend stays authoritative for the
 * price and availability of whatever code is configured.
 */
export const DEFAULT_TICKET_TYPE_CODE = "GENERAL";

export type FrontendEnv = {
  readonly VITE_API_BASE_URL?: string | undefined;
  readonly VITE_EVENT_CODE?: string | undefined;
  readonly VITE_TICKET_TYPE_CODE?: string | undefined;
  /** Containment switch; only an explicit falsy value disables checkout. See `FrontendConfig`. */
  readonly VITE_CHECKOUT_ENABLED?: string | undefined;
  /**
   * Vite's own `import.meta.env.PROD`: true in a `vite build`, false in `vite dev` and in the
   * test runner. It selects the default backend: hosted for a real build, the local stack
   * otherwise. An explicit `VITE_API_BASE_URL` always wins.
   */
  readonly PROD?: boolean | undefined;
};

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Strips a trailing slash so URL joining is predictable. */
function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Reads the containment switch.
 *
 * Only an explicit falsy word disables checkout; an absent, empty or unrecognised value keeps the
 * normal behaviour (`fallback`). A typo must never silently take sales offline — the containment
 * build is always the one that sets the variable on purpose.
 */
export function parseCheckoutEnabled(value: string | undefined): boolean {
  const normalized = clean(value)?.toLowerCase();
  if (normalized === undefined) {
    return true;
  }
  return !["false", "0", "no", "off"].includes(normalized);
}

export function loadFrontendConfig(env: FrontendEnv): FrontendConfig {
  const isProductionBuild = env.PROD === true;
  return {
    apiBaseUrl: withoutTrailingSlash(
      clean(env.VITE_API_BASE_URL) ??
        (isProductionBuild ? HOSTED_API_BASE_URL : LOCAL_API_BASE_URL),
    ),
    eventCode: (clean(env.VITE_EVENT_CODE) ?? DEFAULT_EVENT_CODE).toUpperCase(),
    ticketTypeCode: (clean(env.VITE_TICKET_TYPE_CODE) ?? DEFAULT_TICKET_TYPE_CODE).toUpperCase(),
    checkoutEnabled: parseCheckoutEnabled(env.VITE_CHECKOUT_ENABLED),
  };
}

/**
 * Reads a Vite-injected value as a string, discarding anything that is not one.
 *
 * `import.meta.env` is typed as `any` through its index signature; this keeps only strings
 * from reaching the configuration, so a stray object in an environment variable cannot become
 * a URL.
 */
function envString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Configuration resolved once for the running bundle.
 *
 * The values are listed explicitly instead of passing the whole `import.meta.env`: what a
 * browser bundle may read from the environment is the shortest possible list, and both the
 * TypeScript build and `tests/frontend/hosted-config.test.ts` keep it that way.
 */
export const FRONTEND_CONFIG: FrontendConfig = loadFrontendConfig({
  VITE_API_BASE_URL: envString(import.meta.env.VITE_API_BASE_URL),
  VITE_EVENT_CODE: envString(import.meta.env.VITE_EVENT_CODE),
  VITE_TICKET_TYPE_CODE: envString(import.meta.env.VITE_TICKET_TYPE_CODE),
  VITE_CHECKOUT_ENABLED: envString(import.meta.env.VITE_CHECKOUT_ENABLED),
  PROD: import.meta.env.PROD,
});
