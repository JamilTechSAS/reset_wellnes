/**
 * Google Sheets client — Google Apps Script web-app connector.
 *
 * The backend never holds a Google Cloud service-account key. Instead, a standalone Apps
 * Script project owns the spreadsheet and exposes one signed POST endpoint:
 *
 *   backend -> HTTPS POST /exec -> Apps Script (as its owner) -> configured spreadsheet
 *
 * Authentication is an HMAC-SHA256 signature over an exact canonical message:
 *
 *   v1\n{timestamp}\n{nonce}\n{payloadJson}
 *
 * `payloadJson` is serialized once and carried as a string inside the envelope, so the bytes
 * signed by this client are exactly the bytes verified by the script. The envelope is:
 *
 *   { version: 1, timestamp, nonce, payload: "<json string>", signature: "<base64url>" }
 *
 * The script also enforces a short clock-skew window and a nonce cache. The spreadsheet ID
 * and tab names live only in Apps Script Script Properties; a request can select only the
 * fixed `data` or `status` grid, never an arbitrary spreadsheet, tab or range.
 *
 * The connector is still an outbox drain, not a checkout dependency. A Google outage delays
 * the sheet and nothing else.
 */

export const SHEETS_REQUEST_VERSION = 1;
export const SHEETS_MAX_DATA_ROWS = 5_000;
export const SHEETS_MAX_DATA_COLUMNS = 22;
export const SHEETS_MAX_STATUS_ROWS = 20;
export const SHEETS_MAX_STATUS_COLUMNS = 2;
export const SHEETS_MAX_CLOCK_SKEW_SECONDS = 300;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_MESSAGE_CHARS = 300;

export type SheetsCell = string | number | boolean;
export type SheetsGrid = readonly (readonly SheetsCell[])[];

export type SheetsWriteInput = {
  /** Fixed target. Apps Script maps this to DATA_TAB or STATUS_TAB. */
  readonly grid: "data" | "status";
  readonly values: SheetsGrid;
};

export type SheetsWriteResult =
  | {
      readonly ok: true;
      readonly grid: "data" | "status";
      readonly written: true;
      readonly rowsWritten: number;
      readonly updatedRanges: number;
      readonly updatedCells: number;
    }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      /** Bounded, non-secret description. */
      readonly error: string;
      readonly httpStatus: number | undefined;
    };

export type SheetsHealth = {
  readonly operation: "health";
  readonly spreadsheetAccessible: true;
  readonly dataTab: true;
  readonly statusTab: true;
  readonly timeZone: string;
};

export type SheetsSelfTest = {
  readonly operation: "self_test";
  readonly spreadsheetAccessible: true;
  readonly dataTab: true;
  readonly statusTab: true;
  readonly writeReadDelete: true;
  readonly cleanedUp: true;
};

export type SheetsOperationResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly error: string;
      readonly httpStatus: number | undefined;
    };

export type SheetsClient = {
  writeProjection(input: SheetsWriteInput): Promise<SheetsWriteResult>;
  /** Signed health check for setup and diagnostics. */
  health(): Promise<SheetsOperationResult<SheetsHealth>>;
  /** Signed temporary write/read/delete test; never touches participant or status data. */
  selfTest(): Promise<SheetsOperationResult<SheetsSelfTest>>;
};

export type SheetsClientOptions = {
  /** Deployed Apps Script `/exec` URL. */
  readonly url: string;
  /** Shared HMAC secret; the same value is stored in Apps Script Script Properties. */
  readonly secret: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Injected clock (ms) for tests. */
  readonly now?: () => number;
  /** Injected nonce generator for deterministic tests. */
  readonly nonce?: () => string;
};

type ConnectorEnvelope = {
  readonly version: number;
  readonly timestamp: number;
  readonly nonce: string;
  readonly payload: string;
  readonly signature: string;
};

export type SheetsSignedRequest = {
  readonly envelope: ConnectorEnvelope;
  readonly body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The canonical UTF-8 message signed by this client and verified by `lib.js`.
 * Keep the version, separators and `String(timestamp)` representation in lockstep.
 */
export function canonicalSheetsMessage(
  timestamp: number,
  nonce: string,
  payloadJson: string,
): string {
  return `v1\n${String(timestamp)}\n${nonce}\n${payloadJson}`;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacBase64Url(key: CryptoKey, message: string): Promise<string> {
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Exported for tests and for the local connector-check command. */
export async function signSheetsRequest(input: {
  readonly secret: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly payloadJson: string;
}): Promise<string> {
  const key = await importHmacKey(input.secret);
  return hmacBase64Url(
    key,
    canonicalSheetsMessage(input.timestamp, input.nonce, input.payloadJson),
  );
}

/** Builds the exact body sent to Apps Script. Exported for signature tests. */
export async function buildSheetsSignedRequest(input: {
  readonly secret: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly payloadJson: string;
}): Promise<SheetsSignedRequest> {
  const signature = await signSheetsRequest(input);
  const envelope: ConnectorEnvelope = {
    version: SHEETS_REQUEST_VERSION,
    timestamp: input.timestamp,
    nonce: input.nonce,
    payload: input.payloadJson,
    signature,
  };
  return { envelope, body: JSON.stringify(envelope) };
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function safeMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/[\n\r\t]+/g, " ").trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, MAX_ERROR_MESSAGE_CHARS);
}

type ConnectorFailure = {
  readonly ok: false;
  readonly retryable: boolean;
  readonly error: string;
  readonly httpStatus: number | undefined;
};

function failure(
  error: string,
  retryable: boolean,
  httpStatus: number | undefined,
): ConnectorFailure {
  return { ok: false, retryable, error, httpStatus };
}

function readError(body: unknown): { message: string; retryable: boolean } | undefined {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }
  return {
    message:
      safeMessage(body.error.message) ??
      safeMessage(body.error.code) ??
      "The Apps Script connector rejected the request",
    retryable: body.error.retryable === true,
  };
}

type PostResult = { readonly ok: true; readonly body: Record<string, unknown> } | ConnectorFailure;

export function createSheetsClient(options: SheetsClientOptions): SheetsClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const nonceFactory = options.nonce ?? randomNonce;

  let keyPromise: Promise<CryptoKey> | undefined;
  function key(): Promise<CryptoKey> {
    keyPromise ??= importHmacKey(options.secret);
    return keyPromise;
  }

  async function post(payload: Record<string, unknown>): Promise<PostResult> {
    // Signing must never throw out of the worker: a thrown error would leave the claimed
    // projections SYNCING until stale recovery instead of recording a normal failure.
    let body: string;
    try {
      const payloadJson = JSON.stringify(payload);
      const timestamp = Math.floor(now() / 1000);
      const nonce = nonceFactory();
      const signature = await hmacBase64Url(
        await key(),
        canonicalSheetsMessage(timestamp, nonce, payloadJson),
      );
      body = JSON.stringify({
        version: SHEETS_REQUEST_VERSION,
        timestamp,
        nonce,
        payload: payloadJson,
        signature,
      } satisfies ConnectorEnvelope);
    } catch {
      // Never include the secret or a provider message in the error.
      return failure("connector signing is unavailable", false, undefined);
    }

    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        // ContentService answers through a Google redirect; following it is required.
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return failure(
        error instanceof Error ? `network: ${error.name}` : "network error",
        true,
        undefined,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return failure(
        error instanceof Error ? `response body: ${error.name}` : "response body unavailable",
        true,
        response.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      // A 200 with an HTML sign-in page or a transient Google error page is malformed, not a
      // success; retry it through the outbox so it consumes the normal attempt budget.
      return failure(
        response.ok
          ? "connector returned non-JSON"
          : `connector returned HTTP ${String(response.status)}`,
        response.ok ? true : isRetryableStatus(response.status),
        response.status,
      );
    }

    if (!response.ok) {
      const described = readError(parsed);
      return failure(
        described?.message ?? `connector returned HTTP ${String(response.status)}`,
        described?.retryable ?? isRetryableStatus(response.status),
        response.status,
      );
    }

    if (!isRecord(parsed)) {
      return failure("connector returned an invalid JSON body", true, response.status);
    }
    if (parsed.ok === false) {
      const described = readError(parsed);
      if (described === undefined) {
        return failure("connector returned an invalid error body", true, response.status);
      }
      return failure(described.message, described.retryable, response.status);
    }
    if (parsed.ok !== true) {
      return failure("connector response is missing ok:true", true, response.status);
    }
    return { ok: true, body: parsed };
  }

  function readData(body: Record<string, unknown>): Record<string, unknown> | undefined {
    return isRecord(body.data) ? body.data : undefined;
  }

  return {
    async writeProjection(input): Promise<SheetsWriteResult> {
      const result = await post({
        operation: "sync",
        grid: input.grid,
        values: input.values,
      });
      if (!result.ok) {
        return {
          ok: false,
          retryable: result.retryable,
          error: result.error,
          httpStatus: result.httpStatus,
        };
      }

      const data = readData(result.body);
      const operation = data?.operation;
      const written = data?.written;
      const grid = data?.grid;
      const rowsWritten = data?.rowsWritten;
      const updatedRanges = data?.updatedRanges;
      const updatedCells = data?.updatedCells;
      const expectedRows =
        input.grid === "data" ? Math.max(0, input.values.length - 1) : input.values.length;
      if (
        data === undefined ||
        operation !== "sync" ||
        written !== true ||
        grid !== input.grid ||
        typeof rowsWritten !== "number" ||
        !Number.isInteger(rowsWritten) ||
        rowsWritten !== expectedRows ||
        typeof updatedRanges !== "number" ||
        !Number.isInteger(updatedRanges) ||
        updatedRanges < 1 ||
        typeof updatedCells !== "number" ||
        !Number.isInteger(updatedCells) ||
        updatedCells < 1
      ) {
        return {
          ok: false,
          retryable: true,
          error: "connector returned an unsafe sync acknowledgement",
          httpStatus: 200,
        };
      }
      return {
        ok: true,
        grid: input.grid,
        written: true,
        rowsWritten,
        updatedRanges,
        updatedCells,
      };
    },

    async health(): Promise<SheetsOperationResult<SheetsHealth>> {
      const result = await post({ operation: "health" });
      if (!result.ok) {
        return {
          ok: false,
          retryable: result.retryable,
          error: result.error,
          httpStatus: result.httpStatus,
        };
      }
      const data = readData(result.body);
      if (data === undefined) {
        return {
          ok: false,
          retryable: true,
          error: "connector returned an unsafe health response",
          httpStatus: 200,
        };
      }
      if (
        data.operation !== "health" ||
        data.spreadsheetAccessible !== true ||
        data.dataTab !== true ||
        data.statusTab !== true ||
        typeof data.timeZone !== "string"
      ) {
        return {
          ok: false,
          retryable: true,
          error: "connector returned an unsafe health response",
          httpStatus: 200,
        };
      }
      return {
        ok: true,
        data: {
          operation: "health",
          spreadsheetAccessible: true,
          dataTab: true,
          statusTab: true,
          timeZone: data.timeZone,
        },
      };
    },

    async selfTest(): Promise<SheetsOperationResult<SheetsSelfTest>> {
      const result = await post({ operation: "self_test" });
      if (!result.ok) {
        return {
          ok: false,
          retryable: result.retryable,
          error: result.error,
          httpStatus: result.httpStatus,
        };
      }
      const data = readData(result.body);
      if (data === undefined) {
        return {
          ok: false,
          retryable: true,
          error: "connector returned an unsafe self-test response",
          httpStatus: 200,
        };
      }
      if (
        data.operation !== "self_test" ||
        data.spreadsheetAccessible !== true ||
        data.dataTab !== true ||
        data.statusTab !== true ||
        data.writeReadDelete !== true ||
        data.cleanedUp !== true
      ) {
        return {
          ok: false,
          retryable: true,
          error: "connector returned an unsafe self-test response",
          httpStatus: 200,
        };
      }
      return {
        ok: true,
        data: {
          operation: "self_test",
          spreadsheetAccessible: true,
          dataTab: true,
          statusTab: true,
          writeReadDelete: true,
          cleanedUp: true,
        },
      };
    },
  };
}
