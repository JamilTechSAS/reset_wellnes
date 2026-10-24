import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const SECRET = "test_apps_script_secret_0123456789abcdef";
const TIMESTAMP = 1_792_829_768;
const NONCE = "abcdefghijklmnopqrstuvwxyz012345";
const SIGNATURE = "PZmOGvjgm8EEUxV5bCz3_zN2s0TK_lqZGQRjavKGR3Y";
const SOURCE = readFileSync(
  new URL("../../integrations/google-apps-script/lib.js", import.meta.url),
  "utf8",
);

type Result = {
  readonly ok: boolean;
  readonly [key: string]: unknown;
};

type AppsScriptLib = {
  readonly RW_REQUEST_VERSION: number;
  readonly RW_MAX_CLOCK_SKEW_SECONDS: number;
  readonly rwCanonicalMessage_: (timestamp: number, nonce: string, payload: string) => string;
  readonly rwHmacBase64Url_: (message: string, secret: string) => string;
  readonly rwConstantTimeEqual_: (a: string, b: string) => boolean;
  readonly rwVerifyEnvelope_: (envelope: unknown, secret: string, nowSeconds: number) => Result;
  readonly rwConsumeNonce_: (
    nonce: string,
    cache: { get(key: string): string | null; put(key: string, value: string, ttl: number): void },
    lock: { tryLock(ms: number): boolean; releaseLock(): void },
  ) => Result;
  readonly rwSanitizeCellValue_: (value: unknown) => unknown;
  readonly rwSanitizeGrid_: (values: readonly (readonly unknown[])[]) => unknown[][];
  readonly rwValidateGrid_: (values: unknown, maxRows: number, maxColumns: number) => Result;
  readonly rwValidateSyncPayload_: (payload: unknown) => Result;
  readonly rwValidateOperation_: (payload: unknown) => Result;
  readonly rwReadConfig_: (properties: { getProperty(key: string): string | null }) => Result;
};

function loadLib(): AppsScriptLib {
  const context = {
    module: { exports: {} as Record<string, unknown> },
    exports: {},
    Utilities: {
      computeHmacSha256Signature: (message: string, secret: string): number[] =>
        Array.from(createHmac("sha256", secret).update(message, "utf8").digest()),
      base64EncodeWebSafe: (bytes: readonly number[]): string =>
        Buffer.from(Uint8Array.from(bytes)).toString("base64url"),
    },
    console: { error: (): void => undefined },
  };
  runInNewContext(SOURCE, context);
  return context.module.exports as unknown as AppsScriptLib;
}

const lib = loadLib();

function payload(): string {
  return JSON.stringify({ operation: "health" });
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = {
    version: 1,
    timestamp: TIMESTAMP,
    nonce: NONCE,
    payload: payload(),
    signature: SIGNATURE,
    ...overrides,
  };
  return body;
}

describe("Apps Script envelope verification", () => {
  it("uses the same canonical message and HMAC vector as the TypeScript client", () => {
    expect(lib.rwCanonicalMessage_(TIMESTAMP, NONCE, payload())).toBe(
      `v1\n${TIMESTAMP}\n${NONCE}\n${payload()}`,
    );
    expect(lib.rwHmacBase64Url_(lib.rwCanonicalMessage_(TIMESTAMP, NONCE, payload()), SECRET)).toBe(
      SIGNATURE,
    );
    expect(lib.rwVerifyEnvelope_(envelope(), SECRET, TIMESTAMP).ok).toBe(true);
  });

  it("rejects an expired or excessively future timestamp", () => {
    expect(lib.rwVerifyEnvelope_(envelope(), SECRET, TIMESTAMP + 301)).toMatchObject({
      ok: false,
      error: { code: "EXPIRED_REQUEST", retryable: false },
    });
    expect(lib.rwVerifyEnvelope_(envelope(), SECRET, TIMESTAMP - 301)).toMatchObject({
      ok: false,
      error: { code: "FUTURE_REQUEST", retryable: false },
    });
  });

  it("rejects a tampered payload with a non-retryable signature error", () => {
    const tampered = envelope({ payload: JSON.stringify({ operation: "self_test" }) });
    expect(lib.rwVerifyEnvelope_(tampered, SECRET, TIMESTAMP)).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED", retryable: false },
    });
  });

  it("rejects malformed envelopes before any operation", () => {
    for (const candidate of [
      null,
      [],
      envelope({ version: 2 }),
      envelope({ timestamp: "1792829768" }),
      envelope({ nonce: "short" }),
      envelope({ payload: "" }),
      envelope({ signature: "short" }),
    ]) {
      expect(lib.rwVerifyEnvelope_(candidate, SECRET, TIMESTAMP).ok).toBe(false);
    }
    expect(lib.rwVerifyEnvelope_(envelope(), "short", TIMESTAMP)).toMatchObject({
      ok: false,
      error: { code: "CONFIGURATION" },
    });
  });

  it("compares signatures without accepting prefixes or case changes", () => {
    expect(lib.rwConstantTimeEqual_(SIGNATURE, SIGNATURE)).toBe(true);
    expect(lib.rwConstantTimeEqual_(SIGNATURE, SIGNATURE.slice(0, -1))).toBe(false);
    expect(lib.rwConstantTimeEqual_(SIGNATURE, SIGNATURE.toUpperCase())).toBe(false);
    expect(lib.rwConstantTimeEqual_("", "x")).toBe(false);
  });
});

describe("Apps Script nonce replay protection", () => {
  function store() {
    const values = new Map<string, string>();
    return {
      values,
      cache: {
        get: (key: string): string | null => values.get(key) ?? null,
        put: (key: string, value: string): void => {
          values.set(key, value);
        },
      },
      lock: {
        locked: 0,
        released: 0,
        tryLock(): boolean {
          this.locked += 1;
          return true;
        },
        releaseLock(): void {
          this.released += 1;
        },
      },
    };
  }

  it("accepts a nonce once and rejects its replay", () => {
    const { cache, lock } = store();
    expect(lib.rwConsumeNonce_(NONCE, cache, lock).ok).toBe(true);
    expect(lib.rwConsumeNonce_(NONCE, cache, lock)).toMatchObject({
      ok: false,
      error: { code: "REPLAY", retryable: false },
    });
    expect(lock.released).toBe(2);
  });

  it("fails closed when the lock is busy or the cache is unavailable", () => {
    const { cache } = store();
    const busy = {
      tryLock: (): boolean => false,
      releaseLock: (): void => undefined,
    };
    expect(lib.rwConsumeNonce_(NONCE, cache, busy)).toMatchObject({
      ok: false,
      error: { code: "BUSY", retryable: true },
    });
    expect(lib.rwConsumeNonce_(NONCE, undefined as never, busy)).toMatchObject({
      ok: false,
      error: { code: "NONCE_STORE_UNAVAILABLE", retryable: true },
    });
  });
});

describe("Apps Script grid validation", () => {
  it("accepts the data and status shapes and rejects unknown targets", () => {
    expect(
      lib.rwValidateSyncPayload_({
        operation: "sync",
        grid: "data",
        values: [["header"], ["Ana"]],
      }).ok,
    ).toBe(true);
    expect(
      lib.rwValidateSyncPayload_({
        operation: "sync",
        grid: "status",
        values: [["Total", 1]],
      }).ok,
    ).toBe(true);
    expect(
      lib.rwValidateSyncPayload_({
        operation: "sync",
        grid: "other",
        values: [["x"]],
      }),
    ).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
  });

  it("rejects ragged, oversized, empty, and non-primitive cells", () => {
    for (const values of [
      [],
      [["a"], ["b", "c"]],
      [["a", "b", "c"]].map((row) => [
        ...row,
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r",
        "s",
        "t",
        "u",
        "v",
        "w",
        "x",
        "y",
      ]),
      [[null]],
      [[{ value: "x" }]],
      [[Number.NaN]],
    ]) {
      expect(lib.rwValidateGrid_(values, 10, 22).ok).toBe(false);
    }
  });

  it("allows only the three explicitly defined operations", () => {
    expect(lib.rwValidateOperation_({ operation: "health" }).ok).toBe(true);
    expect(lib.rwValidateOperation_({ operation: "self_test" }).ok).toBe(true);
    expect(lib.rwValidateOperation_({ operation: "sync", grid: "data", values: [["h"]] }).ok).toBe(
      true,
    );
    expect(lib.rwValidateOperation_({ operation: "read" })).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_OPERATION" },
    });
  });

  it("neutralizes formula-leading strings before setValues", () => {
    expect(lib.rwSanitizeCellValue_('=HYPERLINK("https://evil")')).toBe(
      '\'=HYPERLINK("https://evil")',
    );
    expect(lib.rwSanitizeCellValue_("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(lib.rwSanitizeCellValue_("-1+1")).toBe("'-1+1");
    expect(lib.rwSanitizeCellValue_("@cmd")).toBe("'@cmd");
    expect(lib.rwSanitizeCellValue_("\tformula")).toBe("'\tformula");
    expect(lib.rwSanitizeCellValue_("Ana")).toBe("Ana");
    expect(lib.rwSanitizeCellValue_(42)).toBe(42);
    expect(
      lib.rwSanitizeGrid_([
        ["=bad", "Ana"],
        ["+bad", true],
      ]),
    ).toEqual([
      ["'=bad", "Ana"],
      ["'+bad", true],
    ]);
  });
});

describe("Apps Script configuration", () => {
  function properties(values: Record<string, string>) {
    return { getProperty: (key: string): string | null => values[key] ?? null };
  }

  it("reads the spreadsheet and defaults the two tabs from Script Properties", () => {
    const config = lib.rwReadConfig_(
      properties({
        SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        HMAC_SECRET: SECRET,
      }),
    );
    expect(config.ok).toBe(true);
    expect(config.dataTab).toBe("Datos");
    expect(config.statusTab).toBe("Estado");
  });

  it("fails closed on missing or unsafe configuration", () => {
    for (const values of [
      {},
      { SPREADSHEET_ID: "too short", HMAC_SECRET: SECRET },
      { SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
      {
        SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        HMAC_SECRET: "has whitespace in the secret value",
      },
      {
        SPREADSHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        HMAC_SECRET: SECRET,
        DATA_TAB: "Same",
        STATUS_TAB: "Same",
      },
    ]) {
      expect(lib.rwReadConfig_(properties(values)).ok).toBe(false);
    }
  });
});
