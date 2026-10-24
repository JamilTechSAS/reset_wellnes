/**
 * Apps Script web-app entrypoint tests.
 *
 * Google's hosted runtime cannot run in this repository, but `Code.gs` is plain JavaScript.
 * These tests load it with the real `lib.js` and a small fake of the Apps Script services it
 * uses, which pins the request wiring, spreadsheet target selection and write acknowledgement
 * without pretending to be a live Google Sheets test.
 */

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const SECRET = "test_apps_script_secret_0123456789abcdef";
const SPREADSHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const LIB_SOURCE = readFileSync(
  new URL("../../integrations/google-apps-script/lib.js", import.meta.url),
  "utf8",
);
const CODE_SOURCE = readFileSync(
  new URL("../../integrations/google-apps-script/Code.gs", import.meta.url),
  "utf8",
);

type JsonResponse = {
  readonly ok: boolean;
  readonly [key: string]: unknown;
};

type AppsScriptOutput = {
  readonly content: string;
  mimeType: string;
  setMimeType(value: string): AppsScriptOutput;
};

type AppsScriptContext = {
  doGet(): AppsScriptOutput;
  doPost(event: { postData?: { contents?: string } }): AppsScriptOutput;
};

type FakeSheet = {
  readonly name: string;
  readonly writes: { row: number; column: number; values: unknown[][] }[];
  readonly cells: Map<string, unknown>;
  getRange(row: number, column: number, numRows: number, numColumns: number): unknown;
};

type Runtime = {
  readonly context: AppsScriptContext;
  readonly sheets: Map<string, FakeSheet>;
  readonly logs: unknown[][];
};

function canonical(timestamp: number, nonce: string, payload: string): string {
  return `v1\n${String(timestamp)}\n${nonce}\n${payload}`;
}

function sign(timestamp: number, nonce: string, payload: string): string {
  return createHmac("sha256", SECRET)
    .update(canonical(timestamp, nonce, payload), "utf8")
    .digest("base64url");
}

function fakeSheet(name: string, writable = true): FakeSheet {
  const cells = new Map<string, unknown>();
  const writes: { row: number; column: number; values: unknown[][] }[] = [];
  const sheet: FakeSheet = {
    name,
    writes,
    cells,
    getRange(row, column, numRows, numColumns) {
      if (!writable) {
        throw new Error("protected sheet");
      }
      if (row < 1 || column < 1 || numRows < 1 || numColumns < 1) {
        throw new Error("invalid range");
      }
      return {
        setValues(values: unknown[][]) {
          writes.push({ row, column, values: values.map((line) => [...line]) });
          for (let r = 0; r < values.length; r += 1) {
            for (let c = 0; c < (values[r]?.length ?? 0); c += 1) {
              cells.set(`${String(row + r)}:${String(column + c)}`, values[r]?.[c]);
            }
          }
        },
        setValue(value: unknown) {
          cells.set(`${String(row)}:${String(column)}`, value);
        },
        getValue() {
          return cells.get(`${String(row)}:${String(column)}`) ?? null;
        },
      };
    },
  };
  return sheet;
}

function runtime(
  options: {
    readonly tabs?: readonly string[];
    readonly writeFailure?: boolean;
    readonly patchProperties?: Record<string, string | null>;
  } = {},
): Runtime {
  const properties = new Map<string, string>([
    ["SPREADSHEET_ID", SPREADSHEET_ID],
    ["HMAC_SECRET", SECRET],
    ["DATA_TAB", "Datos"],
    ["STATUS_TAB", "Estado"],
  ]);
  for (const [key, value] of Object.entries(options.patchProperties ?? {})) {
    if (value === null) {
      properties.delete(key);
    } else {
      properties.set(key, value);
    }
  }

  const sheets = new Map<string, FakeSheet>();
  for (const tab of options.tabs ?? ["Datos", "Estado"]) {
    sheets.set(tab, fakeSheet(tab, !options.writeFailure));
  }
  const logs: unknown[][] = [];
  const cache = new Map<string, string>();
  let locked = false;
  const output = (content: string): AppsScriptOutput => {
    const value: AppsScriptOutput = {
      content,
      mimeType: "text/plain",
      setMimeType(mime: string) {
        value.mimeType = mime;
        return value;
      },
    };
    return value;
  };

  const spreadsheet = {
    getSheetByName: (name: string): FakeSheet | null => sheets.get(name) ?? null,
    insertSheet: (name: string): FakeSheet => {
      if (sheets.has(name)) {
        throw new Error("sheet exists");
      }
      const sheet = fakeSheet(name, true);
      sheets.set(name, sheet);
      return sheet;
    },
    deleteSheet: (sheet: FakeSheet): void => {
      if (!sheets.delete(sheet.name)) {
        throw new Error("sheet missing");
      }
    },
    getSpreadsheetTimeZone: (): string => "America/Bogota",
  };

  const context = {
    module: { exports: {} },
    exports: {},
    Utilities: {
      computeHmacSha256Signature: (message: string, secret: string): number[] =>
        Array.from(createHmac("sha256", secret).update(message, "utf8").digest()),
      base64EncodeWebSafe: (bytes: readonly number[]): string =>
        Buffer.from(Uint8Array.from(bytes)).toString("base64url"),
      getUuid: (): string => "12345678-1234-1234-1234-123456789012",
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string): string | null => properties.get(key) ?? null,
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (key: string): string | null => cache.get(key) ?? null,
        put: (key: string, value: string): void => {
          cache.set(key, value);
        },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: (): boolean => {
          if (locked) {
            return false;
          }
          locked = true;
          return true;
        },
        releaseLock: (): void => {
          locked = false;
        },
      }),
    },
    SpreadsheetApp: {
      openById: (id: string) => {
        if (id !== SPREADSHEET_ID) {
          throw new Error("not found");
        }
        return spreadsheet;
      },
      flush: (): void => undefined,
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (content: string): AppsScriptOutput => output(content),
    },
    console: {
      error: (...args: unknown[]): void => {
        logs.push(args);
      },
    },
  };

  runInNewContext(LIB_SOURCE, context);
  runInNewContext(CODE_SOURCE, context);
  return { context: context as unknown as AppsScriptContext, sheets, logs };
}

function parse(value: AppsScriptOutput): JsonResponse {
  return JSON.parse(value.content) as JsonResponse;
}

function post(
  context: AppsScriptContext,
  payload: Record<string, unknown>,
  options: { nonce?: string; mutateSignature?: boolean; timestamp?: number } = {},
): JsonResponse {
  const nonce = options.nonce ?? `nonce-${randomBytes(16).toString("hex")}`;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const payloadJson = JSON.stringify(payload);
  const signature = sign(timestamp, nonce, payloadJson);
  const submitted = options.mutateSignature
    ? `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`
    : signature;
  return parse(
    context.doPost({
      postData: {
        contents: JSON.stringify({
          version: 1,
          timestamp,
          nonce,
          payload: payloadJson,
          signature: submitted,
        }),
      },
    }),
  );
}

describe("Apps Script web-app entrypoint", () => {
  it("refuses GET and missing bodies without touching a spreadsheet", () => {
    const { context } = runtime();
    expect(parse(context.doGet())).toMatchObject({
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED" },
    });
    expect(parse(context.doPost({}))).toMatchObject({
      ok: false,
      error: { code: "BAD_REQUEST" },
    });
  });

  it("verifies the signature before selecting an operation", () => {
    const { context, sheets } = runtime();
    const response = post(
      context,
      { operation: "sync", grid: "data", values: [["header"], ["Ana"]] },
      { mutateSignature: true },
    );

    expect(response).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(sheets.get("Datos")?.writes).toEqual([]);
    expect(sheets.get("Estado")?.writes).toEqual([]);
  });

  it("writes the complete data grid to the fixed DATA_TAB and reports rows", () => {
    const { context, sheets } = runtime();
    const response = post(context, {
      operation: "sync",
      grid: "data",
      values: [
        ["Nombre", "Correo"],
        ['=HYPERLINK("https://evil")', "ana@example.com"],
      ],
    });

    expect(response).toMatchObject({
      ok: true,
      data: { operation: "sync", grid: "data", written: true, rowsWritten: 1, updatedRanges: 1 },
    });
    const writes = sheets.get("Datos")?.writes ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]?.row).toBe(1);
    expect(writes[0]?.column).toBe(1);
    expect(writes[0]?.values[1]?.[0]).toBe('\'=HYPERLINK("https://evil")');
    expect(sheets.get("Estado")?.writes).toEqual([]);
  });

  it("writes the status grid to STATUS_TAB with its own row count", () => {
    const { context, sheets } = runtime();
    const response = post(context, {
      operation: "sync",
      grid: "status",
      values: [["Total", 2]],
    });

    expect(response).toMatchObject({
      ok: true,
      data: { operation: "sync", grid: "status", rowsWritten: 1 },
    });
    expect(sheets.get("Estado")?.writes[0]?.values).toEqual([["Total", 2]]);
    expect(sheets.get("Datos")?.writes).toEqual([]);
  });

  it("fails closed with MISSING_TAB instead of creating tabs", () => {
    const { context, sheets } = runtime({ tabs: ["Datos"] });
    const response = post(context, {
      operation: "sync",
      grid: "data",
      values: [["header"]],
    });

    expect(response).toMatchObject({ ok: false, error: { code: "MISSING_TAB" } });
    expect(sheets.has("Estado")).toBe(false);
    expect(sheets.get("Datos")?.writes).toEqual([]);
  });

  it("rejects a replayed nonce", () => {
    const { context } = runtime();
    const nonce = "replay-nonce-0123456789abcdef";
    expect(post(context, { operation: "health" }, { nonce }).ok).toBe(true);
    expect(post(context, { operation: "health" }, { nonce })).toMatchObject({
      ok: false,
      error: { code: "REPLAY", retryable: false },
    });
  });

  it("self-tests a temporary tab and removes it without touching participant data", () => {
    const { context, sheets } = runtime();
    const response = post(context, { operation: "self_test" });

    expect(response).toMatchObject({
      ok: true,
      data: { operation: "self_test", writeReadDelete: true, cleanedUp: true },
    });
    expect(sheets.has("Datos")).toBe(true);
    expect(sheets.has("Estado")).toBe(true);
    expect([...sheets.keys()].some((name) => name.startsWith("__rw_self_test_"))).toBe(false);
    expect(sheets.get("Datos")?.writes).toEqual([]);
    expect(sheets.get("Estado")?.writes).toEqual([]);
  });

  it("returns a structured retryable failure when the sheet write fails", () => {
    const { context } = runtime({ writeFailure: true });
    const response = post(context, {
      operation: "sync",
      grid: "data",
      values: [["header"]],
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "WRITE_FAILED", retryable: true },
    });
  });

  it("never puts the secret in an error or an execution log", () => {
    const { context, logs } = runtime();
    const response = post(context, { operation: "health" }, { mutateSignature: true });

    expect(JSON.stringify(response)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("fails closed when a required Script Property is absent", () => {
    const { context } = runtime({ patchProperties: { HMAC_SECRET: null } });
    expect(post(context, { operation: "health" })).toMatchObject({
      ok: false,
      error: { code: "CONFIGURATION" },
    });
  });
});
