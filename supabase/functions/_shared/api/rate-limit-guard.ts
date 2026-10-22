/**
 * Rate-limit guard.
 *
 * Applies the documented rule for a scope to a request identifier. Two properties matter:
 *
 *   1. A request that cannot be keyed (missing/oversized identifier) is allowed: silently
 *      putting it in a shared bucket could throttle unrelated users.
 *   2. The guard FAILS OPEN. If the limiter itself errors, the request proceeds — an abuse
 *      control must never take down checkout or the check-in line. The failure is logged
 *      loudly so an operator sees it, and the endpoints' own protections (validation,
 *      reference+email possession, 100-bit tokens) still apply.
 */

import { AppError, toAppError } from "../domain/errors.ts";
import { rateLimitKey, RATE_LIMIT_RULES, type RateLimitScope } from "../domain/rate-limits.ts";
import type { Logger } from "../logging/logger.ts";
import type { RateLimitGateway } from "../db/rate-limits.ts";

export type GuardRateLimitInput = {
  readonly gateway: RateLimitGateway;
  /** From config; `false` disables all application-level limits (documented emergency switch). */
  readonly enabled: boolean;
  readonly logger: Logger;
  readonly scope: RateLimitScope;
  /** The raw identifier for the rule's key kind (IP, order reference, operator id…). */
  readonly identifier: string | undefined;
  /** Stable surface name for logs, e.g. "orders:create". */
  readonly surface: string;
};

/**
 * Consumes one slot. Throws `RATE_LIMITED` when the budget is exhausted; never throws for a
 * limiter failure.
 */
export async function guardRateLimit(input: GuardRateLimitInput): Promise<void> {
  if (!input.enabled) {
    return;
  }
  const rule = RATE_LIMIT_RULES[input.scope];
  const key =
    input.identifier === undefined ? undefined : rateLimitKey(rule.keyKind, input.identifier);
  if (key === undefined) {
    return;
  }

  let allowed: boolean;
  try {
    const decision = await input.gateway.consume({
      scope: input.scope,
      key,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
    });
    allowed = decision.allowed;
  } catch (error) {
    input.logger.error("rate limit check failed; allowing the request", {
      surface: input.surface,
      scope: input.scope,
      error: toAppError(error).code,
    });
    return;
  }

  if (!allowed) {
    input.logger.warn("rate limit exceeded", {
      surface: input.surface,
      scope: input.scope,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
    });
    throw new AppError("RATE_LIMITED", `Rate limit exceeded for ${input.scope}`, {
      context: { surface: input.surface, scope: input.scope },
    });
  }
}
