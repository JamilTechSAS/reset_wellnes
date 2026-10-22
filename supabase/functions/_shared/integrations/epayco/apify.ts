/**
 * ePayco Apify REST API client (Smart Checkout V2).
 *
 * Implements server-to-server authentication and session creation:
 * 1. POST https://apify.epayco.co/login (HTTP Basic Auth with PUBLIC_KEY:PRIVATE_KEY)
 * 2. POST https://apify.epayco.co/payment/session/create (Bearer token auth)
 *
 * Security rules:
 * - Confidential keys (PRIVATE_KEY, P_KEY) NEVER leave the server or appear in error messages.
 * - Injected fetch implementation allows isolated testing without real network calls.
 * - Credentials and tokens are never logged.
 */

import { z } from "zod";
import { AppError } from "../../domain/errors.ts";

export const DEFAULT_APIFY_BASE_URL = "https://apify.epayco.co";

export class EpaycoApifyError extends AppError {
  readonly httpStatus: number | undefined;

  constructor(
    message: string,
    options: {
      readonly httpStatus?: number | undefined;
      readonly cause?: unknown;
      readonly context?: Record<string, string | number | boolean | null> | undefined;
    } = {},
  ) {
    super("UPSTREAM_ERROR", message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      context: {
        ...options.context,
        surface: "epayco-apify",
        ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
      },
    });
    this.name = "EpaycoApifyError";
    this.httpStatus = options.httpStatus;
  }
}

const loginResponseSchema = z.object({
  token: z.string().min(1),
});

const sessionResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    sessionId: z.string().min(1),
  }),
});

export type CreateSessionParams = {
  readonly checkoutVersion?: string | undefined;
  readonly name: string;
  readonly description?: string | undefined;
  readonly currency: string;
  readonly amount: number; // in pesos
  readonly invoice: string;
  readonly response?: string | undefined;
  readonly confirmation?: string | undefined;
  readonly test?: boolean | undefined;
  readonly taxBase?: number | undefined;
  readonly tax?: number | undefined;
  readonly taxIco?: number | undefined;
  readonly country?: string | undefined;
  readonly lang?: string | undefined;
};

export type EpaycoApifyClientOptions = {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly test?: boolean | undefined;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
};

export type EpaycoApifyClient = {
  login(): Promise<string>;
  createSession(params: CreateSessionParams): Promise<{ sessionId: string }>;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export function createEpaycoApifyClient(options: EpaycoApifyClientOptions): EpaycoApifyClient {
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? DEFAULT_APIFY_BASE_URL).replace(/\/+$/, "");

  const cleanPublicKey = options.publicKey.trim();
  const cleanPrivateKey = options.privateKey.trim();

  let cachedToken: string | null = null;

  async function login(): Promise<string> {
    if (cachedToken) {
      return cachedToken;
    }

    if (cleanPublicKey.length === 0 || cleanPrivateKey.length === 0) {
      throw new EpaycoApifyError("Missing ePayco API credentials for Apify login", {
        context: { hasPublicKey: cleanPublicKey.length > 0 },
      });
    }

    const credentials = `${cleanPublicKey}:${cleanPrivateKey}`;
    const basicAuth = globalThis.btoa(credentials);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(`${baseUrl}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Basic ${basicAuth}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new EpaycoApifyError("Authentication failed with ePayco Apify", {
          httpStatus: response.status,
        });
      }

      const rawText = await response.text();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (error) {
        throw new EpaycoApifyError("ePayco Apify login returned invalid JSON", {
          cause: error,
          httpStatus: response.status,
        });
      }

      const validation = loginResponseSchema.safeParse(parsedJson);
      if (!validation.success) {
        throw new EpaycoApifyError("ePayco Apify login response missing token", {
          httpStatus: response.status,
        });
      }

      cachedToken = validation.data.token;
      return cachedToken;
    } catch (error) {
      if (error instanceof EpaycoApifyError) {
        throw error;
      }
      throw new EpaycoApifyError("Failed to connect to ePayco Apify login", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function createSession(params: CreateSessionParams): Promise<{ sessionId: string }> {
    let token = await login();

    const body = {
      checkout_version: params.checkoutVersion ?? "2",
      name: params.name,
      description: params.description ?? params.name,
      currency: params.currency,
      amount: params.amount,
      invoice: params.invoice,
      ...(params.response ? { response: params.response } : {}),
      ...(params.confirmation ? { confirmation: params.confirmation } : {}),
      taxBase: params.taxBase ?? 0,
      tax: params.tax ?? 0,
      taxIco: params.taxIco ?? 0,
      country: params.country ?? "CO",
      lang: params.lang ?? "ES",
      test: params.test ?? options.test ?? false,
    };

    let controller = new AbortController();
    let timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      let response = await fetchImpl(`${baseUrl}/payment/session/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // If token expired, clear cache, re-login once and retry
      if (response.status === 401 && cachedToken) {
        cachedToken = null;
        token = await login();
        clearTimeout(timer);
        controller = new AbortController();
        timer = setTimeout(() => {
          controller.abort();
        }, timeoutMs);

        response = await fetchImpl(`${baseUrl}/payment/session/create`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      }

      if (!response.ok) {
        throw new EpaycoApifyError(`ePayco session creation failed with HTTP ${response.status}`, {
          httpStatus: response.status,
          context: { invoice: params.invoice },
        });
      }

      const rawText = await response.text();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (error) {
        throw new EpaycoApifyError("ePayco session creation returned invalid JSON", {
          cause: error,
          httpStatus: response.status,
          context: { invoice: params.invoice },
        });
      }

      const validation = sessionResponseSchema.safeParse(parsedJson);
      if (!validation.success) {
        throw new EpaycoApifyError("ePayco session creation response missing sessionId", {
          httpStatus: response.status,
          context: { invoice: params.invoice },
        });
      }

      return {
        sessionId: validation.data.data.sessionId,
      };
    } catch (error) {
      if (error instanceof EpaycoApifyError) {
        throw error;
      }
      throw new EpaycoApifyError("Failed to connect to ePayco session creation", {
        cause: error,
        context: { invoice: params.invoice },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    login,
    createSession,
  };
}
