/**
 * Google Sheets client (service account).
 *
 * The operational projection is written server-side with a DEDICATED service identity:
 *
 *   1. build a JWT assertion (RS256, WebCrypto — no third-party dependency) and exchange it
 *      at Google's OAuth token endpoint for an access token scoped to
 *      `https://www.googleapis.com/auth/spreadsheets`;
 *   2. call `values:batchUpdate` on the client's spreadsheet.
 *
 * Verified against the Google Sheets API v4 documentation (read 2026-10-03): the write
 * endpoint is `POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdate` with
 * `{ valueInputOption, data: [{ range, values }] }`; the OAuth JWT-bearer flow posts
 * `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` plus the signed assertion.
 *
 * Security properties:
 *   * the private key lives only in the server environment and is never logged, returned or
 *     included in an error (errors carry HTTP status and a bounded provider message);
 *   * the service account has edit access only to the one spreadsheet the client shared
 *     with it (`GOOGLE_SERVICE_ACCOUNT_EMAIL`); it has no database access at all;
 *   * the token is cached in memory until shortly before expiry; worker instances are
 *     short-lived, so no token ever leaves the process.
 *
 * The client takes an injected `fetch` and `now`, so tests verify the exact JWT signature
 * with a locally generated key and the whole flow without network access.
 */

import { AppError } from "../../domain/errors.ts";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export type SheetsRange = {
  /** A1 notation, for example `'Datos'!A1`. */
  readonly range: string;
  readonly values: readonly (readonly (string | number | boolean)[])[];
};

export type SheetsWriteResult =
  | { readonly ok: true; readonly updatedRanges: number; readonly updatedCells: number }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      /** Bounded, non-secret description. */
      readonly error: string;
      readonly httpStatus: number | undefined;
    };

export type SheetsClient = {
  writeRanges(input: { readonly ranges: readonly SheetsRange[] }): Promise<SheetsWriteResult>;
};

export type SheetsClientOptions = {
  readonly serviceAccountEmail: string;
  /** PEM (PKCS#8) private key; literal `\n` escapes from env files are normalized. */
  readonly privateKeyPem: string;
  readonly spreadsheetId: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Injected clock (ms) for token-cache tests. */
  readonly now?: () => number;
  readonly tokenUrl?: string;
  readonly apiBaseUrl?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh the token this many seconds before it expires. */
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// base64url helpers (runtime-agnostic: btoa/atob exist in Deno and Node >= 16)
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

/**
 * Decodes a PKCS#8 PEM (with or without `\n` escapes) into DER bytes.
 * The return type is pinned to an `ArrayBuffer`-backed view so it can be passed directly
 * to `crypto.subtle.importKey` (which rejects `SharedArrayBuffer`-backed views).
 */
export function decodePrivateKeyPem(pem: string): Uint8Array<ArrayBuffer> {
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (body.length === 0) {
    throw new AppError("INTERNAL_ERROR", "GOOGLE_PRIVATE_KEY is empty or not a PKCS#8 PEM", {
      context: { surface: "google-sheets" },
    });
  }
  let binary: string;
  try {
    binary = globalThis.atob(body);
  } catch {
    throw new AppError("INTERNAL_ERROR", "GOOGLE_PRIVATE_KEY is not valid base64 PEM content", {
      context: { surface: "google-sheets" },
    });
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  try {
    return await globalThis.crypto.subtle.importKey(
      "pkcs8",
      decodePrivateKeyPem(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    // Never include the key material or a provider message in the error.
    throw new AppError("INTERNAL_ERROR", "GOOGLE_PRIVATE_KEY could not be imported", {
      cause: error,
      context: { surface: "google-sheets" },
    });
  }
}

/** Builds and signs the OAuth assertion. Exported so tests can verify the signature. */
export async function signServiceAccountJwt(input: {
  readonly serviceAccountEmail: string;
  readonly privateKey: CryptoKey;
  readonly tokenUrl: string;
  readonly issuedAtSeconds: number;
  readonly lifetimeSeconds?: number;
}): Promise<string> {
  const header = textToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = textToBase64Url(
    JSON.stringify({
      iss: input.serviceAccountEmail,
      scope: SHEETS_SCOPE,
      aud: input.tokenUrl,
      iat: input.issuedAtSeconds,
      exp: input.issuedAtSeconds + (input.lifetimeSeconds ?? 3600),
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = await globalThis.crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    input.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function describeGoogleError(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") {
    return error.slice(0, 200);
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message.replace(/[\n\r\t]+/g, " ").slice(0, 200);
    }
  }
  return undefined;
}

export function createSheetsClient(options: SheetsClientOptions): SheetsClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
  const apiBaseUrl = (options.apiBaseUrl ?? GOOGLE_SHEETS_API_BASE).replace(/\/+$/, "");
  const spreadsheetId = options.spreadsheetId;

  let cachedKey: Promise<CryptoKey> | undefined;
  let cachedToken: { readonly token: string; readonly expiresAtMs: number } | undefined;

  function privateKey(): Promise<CryptoKey> {
    cachedKey ??= importPrivateKey(options.privateKeyPem);
    return cachedKey;
  }

  async function accessToken(): Promise<
    | { readonly ok: true; readonly token: string }
    | { readonly ok: false; readonly error: string; readonly httpStatus: number | undefined }
  > {
    const nowMs = now();
    if (
      cachedToken !== undefined &&
      cachedToken.expiresAtMs > nowMs + TOKEN_REFRESH_MARGIN_SECONDS * 1000
    ) {
      return { ok: true, token: cachedToken.token };
    }

    const key = await privateKey();
    const assertion = await signServiceAccountJwt({
      serviceAccountEmail: options.serviceAccountEmail,
      privateKey: key,
      tokenUrl,
      issuedAtSeconds: Math.floor(nowMs / 1000),
    });

    let response: Response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        httpStatus: undefined,
        error: error instanceof Error ? `network: ${error.name}` : "network error",
      };
    }

    if (!response.ok) {
      let described: string | undefined;
      try {
        described = describeGoogleError(await response.json());
      } catch {
        described = undefined;
      }
      return {
        ok: false,
        httpStatus: response.status,
        error: described ?? `token endpoint returned HTTP ${String(response.status)}`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, httpStatus: response.status, error: "token endpoint returned non-JSON" };
    }
    const token = (payload as { access_token?: unknown }).access_token;
    const expiresIn = (payload as { expires_in?: unknown }).expires_in;
    if (typeof token !== "string" || token.length === 0) {
      return {
        ok: false,
        httpStatus: response.status,
        error: "token response missing access_token",
      };
    }
    const lifetimeSeconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
    cachedToken = { token, expiresAtMs: nowMs + lifetimeSeconds * 1000 };
    return { ok: true, token };
  }

  return {
    async writeRanges(input): Promise<SheetsWriteResult> {
      if (input.ranges.length === 0) {
        return { ok: true, updatedRanges: 0, updatedCells: 0 };
      }

      const token = await accessToken();
      if (!token.ok) {
        return { ok: false, retryable: true, httpStatus: token.httpStatus, error: token.error };
      }

      let response: Response;
      try {
        response = await fetchImpl(
          `${apiBaseUrl}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              valueInputOption: "RAW",
              data: input.ranges.map((range) => ({ range: range.range, values: range.values })),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      } catch (error) {
        return {
          ok: false,
          retryable: true,
          httpStatus: undefined,
          error: error instanceof Error ? `network: ${error.name}` : "network error",
        };
      }

      if (!response.ok) {
        let described: string | undefined;
        try {
          described = describeGoogleError(await response.json());
        } catch {
          described = undefined;
        }
        return {
          ok: false,
          retryable: isRetryableStatus(response.status),
          httpStatus: response.status,
          error: described ?? `sheets API returned HTTP ${String(response.status)}`,
        };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return {
          ok: false,
          retryable: true,
          httpStatus: response.status,
          error: "non-JSON success body",
        };
      }
      const updatedRanges = (payload as { totalUpdatedRanges?: unknown }).totalUpdatedRanges;
      const updatedCells = (payload as { totalUpdatedCells?: unknown }).totalUpdatedCells;
      return {
        ok: true,
        updatedRanges: typeof updatedRanges === "number" ? updatedRanges : input.ranges.length,
        updatedCells: typeof updatedCells === "number" ? updatedCells : 0,
      };
    },
  };
}
