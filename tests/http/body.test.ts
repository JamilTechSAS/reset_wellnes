import { describe, expect, it } from "vitest";

import { AppError } from "@shared/domain/errors.ts";
import { readJsonBody } from "@shared/http/body.ts";

function post(body?: string): Request {
  return new Request("http://localhost/functions/v1/orders", {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}

describe("bounded JSON body reader", () => {
  it("parses a JSON object", async () => {
    expect(await readJsonBody(post(JSON.stringify({ quantity: 2 })), 1024)).toEqual({
      quantity: 2,
    });
  });

  it("treats an empty body as an empty object", async () => {
    expect(await readJsonBody(post(), 1024)).toEqual({});
    expect(await readJsonBody(post("   "), 1024)).toEqual({});
  });

  it("maps malformed JSON to VALIDATION_ERROR, never INTERNAL_ERROR", async () => {
    const error = await expectCode(readJsonBody(post("{not-json"), 1024), "VALIDATION_ERROR");
    expect(error.context.detail).toBe("INVALID_JSON");
  });

  it("rejects a body larger than the limit with VALIDATION_ERROR", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(200) });
    const error = await expectCode(readJsonBody(post(oversized), 64), "VALIDATION_ERROR");
    expect(error.context.detail).toBe("BODY_TOO_LARGE");
  });
});
