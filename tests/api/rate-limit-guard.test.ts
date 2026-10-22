import { describe, expect, it, vi } from "vitest";

import { guardRateLimit } from "@shared/api/rate-limit-guard.ts";
import { AppError } from "@shared/domain/errors.ts";
import { RATE_LIMIT_RULES } from "@shared/domain/rate-limits.ts";
import { createLogger } from "@shared/logging/logger.ts";
import type { RateLimitGateway } from "@shared/db/rate-limits.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

function decision(allowed: boolean): {
  allowed: boolean;
  limit: number;
  remaining: number;
  windowSeconds: number;
  resetAt: string;
} {
  return {
    allowed,
    limit: 20,
    remaining: allowed ? 19 : 0,
    windowSeconds: 3600,
    resetAt: "2026-10-03T13:00:00.000Z",
  };
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

describe("rate-limit guard", () => {
  it("consumes one slot with the documented rule for the scope", async () => {
    const consume = vi.fn<RateLimitGateway["consume"]>().mockResolvedValue(decision(true));
    const gateway: RateLimitGateway = { consume, cleanup: vi.fn().mockResolvedValue(0) };

    await guardRateLimit({
      gateway,
      enabled: true,
      logger,
      scope: "orders:create",
      identifier: "203.0.113.7",
      surface: "orders:create",
    });

    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith({
      scope: "orders:create",
      key: "ip:203.0.113.7",
      limit: RATE_LIMIT_RULES["orders:create"].limit,
      windowSeconds: RATE_LIMIT_RULES["orders:create"].windowSeconds,
    });
  });

  it("rejects with RATE_LIMITED when the budget is exhausted", async () => {
    const gateway: RateLimitGateway = {
      consume: vi.fn().mockResolvedValue(decision(false)),
      cleanup: vi.fn().mockResolvedValue(0),
    };
    const error = await expectCode(
      guardRateLimit({
        gateway,
        enabled: true,
        logger,
        scope: "orders:quote",
        identifier: "203.0.113.7",
        surface: "orders:quote",
      }),
      "RATE_LIMITED",
    );
    expect(error.context.scope).toBe("orders:quote");
  });

  it("does nothing when the switch is off (documented emergency switch)", async () => {
    const consume = vi.fn().mockResolvedValue(decision(false));
    const gateway: RateLimitGateway = { consume, cleanup: vi.fn().mockResolvedValue(0) };
    await guardRateLimit({
      gateway,
      enabled: false,
      logger,
      scope: "orders:create",
      identifier: "203.0.113.7",
      surface: "orders:create",
    });
    expect(consume).not.toHaveBeenCalled();
  });

  it("allows a request that cannot be keyed instead of sharing a bucket", async () => {
    const consume = vi.fn().mockResolvedValue(decision(false));
    const gateway: RateLimitGateway = { consume, cleanup: vi.fn().mockResolvedValue(0) };

    await guardRateLimit({
      gateway,
      enabled: true,
      logger,
      scope: "events:read",
      identifier: undefined,
      surface: "events:read",
    });
    await guardRateLimit({
      gateway,
      enabled: true,
      logger,
      scope: "events:read",
      identifier: "   ",
      surface: "events:read",
    });
    expect(consume).not.toHaveBeenCalled();
  });

  it("fails OPEN when the limiter itself errors", async () => {
    // An abuse control must never take down checkout or the door. The error is logged, the
    // request proceeds, and the endpoint's own protections still apply.
    const gateway: RateLimitGateway = {
      consume: vi.fn().mockRejectedValue(new Error("rate limit table unavailable")),
      cleanup: vi.fn().mockResolvedValue(0),
    };
    await guardRateLimit({
      gateway,
      enabled: true,
      logger,
      scope: "orders:create",
      identifier: "203.0.113.7",
      surface: "orders:create",
    });
  });
});
