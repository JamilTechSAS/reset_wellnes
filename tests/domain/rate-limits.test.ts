import { describe, expect, it } from "vitest";

import {
  isRateLimitScope,
  rateLimitKey,
  RATE_LIMIT_CLEANUP_HORIZON_SECONDS,
  RATE_LIMIT_MAX_KEY_LENGTH,
  RATE_LIMIT_RULES,
  RATE_LIMIT_SCOPES,
} from "@shared/domain/rate-limits.ts";

describe("rate-limit policy", () => {
  it("documents every scope the API applies", () => {
    expect([...RATE_LIMIT_SCOPES]).toEqual([
      "events:read",
      "orders:quote",
      "orders:create",
      "orders:retry",
      "orders:status",
      "orders:participants",
      "orders:hint",
      "tickets:lookup",
      "checkin:attempt",
      "checkin:operator",
    ]);
    expect(isRateLimitScope("orders:create")).toBe(true);
    expect(isRateLimitScope("orders:delete")).toBe(false);
  });

  it("gives every scope a bounded, generous rule", () => {
    for (const scope of RATE_LIMIT_SCOPES) {
      const rule = RATE_LIMIT_RULES[scope];
      expect(rule.limit, `${scope} limit`).toBeGreaterThan(0);
      expect(rule.limit, `${scope} limit`).toBeLessThanOrEqual(1000);
      expect(rule.windowSeconds, `${scope} window`).toBeGreaterThanOrEqual(60);
      expect(rule.windowSeconds, `${scope} window`).toBeLessThanOrEqual(3600);
      expect(["ip", "reference", "token", "operator"]).toContain(rule.keyKind);
    }
  });

  it("keys order-scoped scopes by reference so one venue IP cannot throttle everyone", () => {
    expect(RATE_LIMIT_RULES["orders:status"].keyKind).toBe("reference");
    expect(RATE_LIMIT_RULES["orders:retry"].keyKind).toBe("reference");
    expect(RATE_LIMIT_RULES["orders:participants"].keyKind).toBe("reference");
    expect(RATE_LIMIT_RULES["orders:hint"].keyKind).toBe("reference");
    expect(RATE_LIMIT_RULES["checkin:operator"].keyKind).toBe("operator");
  });

  it("allows far more check-ins per minute than the whole event has attendees", () => {
    const rule = RATE_LIMIT_RULES["checkin:operator"];
    expect(rule.limit).toBeGreaterThanOrEqual(120);
    // The scanner can legitimately burst at the door; the limit is per operator, so the
    // venue NAT address can never exhaust it.
    expect(rule.windowSeconds).toBe(60);
  });

  it("namespaces keys so one identifier can never collide with another kind", () => {
    expect(rateLimitKey("ip", "127.0.0.1")).toBe("ip:127.0.0.1");
    expect(rateLimitKey("reference", "EVT-2026-000001")).toBe("ref:EVT-2026-000001");
    expect(rateLimitKey("token", "TKT_ABC")).toBe("tkt:TKT_ABC");
    expect(rateLimitKey("operator", "user-uuid")).toBe("op:user-uuid");
    expect(rateLimitKey("ip", " 127.0.0.1 ")).toBe("ip:127.0.0.1");
  });

  it("refuses to build a key from an empty or oversized identifier", () => {
    // A request that cannot be keyed must not land in (or poison) a shared bucket.
    expect(rateLimitKey("ip", "")).toBeUndefined();
    expect(rateLimitKey("ip", "   ")).toBeUndefined();
    expect(rateLimitKey("reference", "x".repeat(RATE_LIMIT_MAX_KEY_LENGTH))).toBeUndefined();
  });

  it("cleans counters after the largest window plus a wide margin", () => {
    const largestWindow = Math.max(
      ...RATE_LIMIT_SCOPES.map((scope) => RATE_LIMIT_RULES[scope].windowSeconds),
    );
    expect(RATE_LIMIT_CLEANUP_HORIZON_SECONDS).toBeGreaterThan(largestWindow);
  });
});
