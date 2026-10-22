import { describe, expect, it, vi } from "vitest";

import { createOperatorAuthenticator, parseBearerToken } from "@shared/api/operator-auth.ts";
import { AppError } from "@shared/domain/errors.ts";
import type { OperatorRole } from "@shared/domain/operators.ts";
import type { OperatorGateway, OperatorRecord } from "@shared/db/operators.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const USER_ID = "11111111-1111-4111-8111-111111111111";

function operator(overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    userId: USER_ID,
    displayName: "Operador Puerta",
    role: "OPERATOR",
    isActive: true,
    ...overrides,
  };
}

function authenticator(
  options: {
    readonly user?: { userId: string; email: string | undefined } | undefined;
    readonly record?: OperatorRecord | undefined;
  } = {},
) {
  const findOperatorByUserId = vi
    .fn<OperatorGateway["findOperatorByUserId"]>()
    .mockResolvedValue(options.record);
  const gateway: OperatorGateway = { findOperatorByUserId };
  const auth = createOperatorAuthenticator({
    getUserByToken: vi.fn().mockResolvedValue(options.user),
    operators: gateway,
    logger,
  });
  return { auth, findOperatorByUserId };
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

describe("bearer parsing", () => {
  it("accepts the documented scheme case-insensitively and rejects anything else", () => {
    expect(parseBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(parseBearerToken("bearer  abc")).toBe("abc");
    expect(parseBearerToken("Basic abc")).toBeUndefined();
    expect(parseBearerToken("Bearer   ")).toBeUndefined();
    expect(parseBearerToken(null)).toBeUndefined();
  });
});

describe("operator authentication and authorization", () => {
  it("rejects a request without a token as UNAUTHORIZED", async () => {
    const { auth, findOperatorByUserId } = authenticator();
    await expectCode(auth.authenticate(null), "UNAUTHORIZED");
    // No token means no operator lookup at all.
    expect(findOperatorByUserId).not.toHaveBeenCalled();
  });

  it("rejects a token Supabase Auth cannot verify as UNAUTHORIZED", async () => {
    const { auth, findOperatorByUserId } = authenticator({ user: undefined });
    await expectCode(auth.authenticate("Bearer not-a-real-session"), "UNAUTHORIZED");
    expect(findOperatorByUserId).not.toHaveBeenCalled();
  });

  it("distinguishes FORBIDDEN for an authenticated non-operator", async () => {
    const { auth } = authenticator({
      user: { userId: USER_ID, email: "random@example.com" },
      record: undefined,
    });
    // An account exists and is valid; it simply may not admit tickets. That is 403, not 401.
    await expectCode(auth.authenticate("Bearer valid"), "FORBIDDEN");
  });

  it("rejects a deactivated operator as FORBIDDEN", async () => {
    const { auth } = authenticator({
      user: { userId: USER_ID, email: "puerta@example.com" },
      record: operator({ isActive: false }),
    });
    await expectCode(auth.authenticate("Bearer valid"), "FORBIDDEN");
  });

  it("fails closed when the database returns a role outside the vocabulary", async () => {
    const { auth } = authenticator({
      user: { userId: USER_ID, email: "puerta@example.com" },
      record: operator({ role: "SUPERUSER" as OperatorRole }),
    });
    await expectCode(auth.authenticate("Bearer valid"), "FORBIDDEN");
  });

  it("returns the verified identity for an active operator", async () => {
    const { auth } = authenticator({
      user: { userId: USER_ID, email: "puerta@example.com" },
      record: operator(),
    });
    const identity = await auth.authenticate("Bearer valid");
    expect(identity).toEqual({
      userId: USER_ID,
      email: "puerta@example.com",
      displayName: "Operador Puerta",
      role: "OPERATOR",
    });
  });

  it("refuses an operator whose display name is empty after bounding", async () => {
    const { auth } = authenticator({
      user: { userId: USER_ID, email: "puerta@example.com" },
      record: operator({ displayName: " \n " }),
    });
    await expectCode(auth.authenticate("Bearer valid"), "INTERNAL_ERROR");
  });
});
