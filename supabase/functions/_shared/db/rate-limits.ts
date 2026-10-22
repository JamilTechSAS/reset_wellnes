/**
 * Rate-limit gateway (PostgreSQL-backed fixed windows).
 *
 * One atomic `insert ... on conflict ... returning counter` per check. The caller decides
 * what a failed check means; `consume` only reports the decision.
 */

import { AppError } from "../domain/errors.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";

export type RateLimitDecision = {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly windowSeconds: number;
  readonly resetAt: string;
};

export type RateLimitGateway = {
  consume(input: {
    readonly scope: string;
    readonly key: string;
    readonly limit: number;
    readonly windowSeconds: number;
  }): Promise<RateLimitDecision>;
  cleanup(olderThanSeconds: number): Promise<number>;
};

export function createRateLimitGateway(client: DbClient): RateLimitGateway {
  return {
    async consume(input) {
      const { data, error } = await client.rpc("consume_rate_limit", {
        p_scope: input.scope,
        p_key: input.key,
        p_limit: input.limit,
        p_window_seconds: input.windowSeconds,
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      if (typeof data !== "object" || data === null) {
        throw new AppError("INTERNAL_ERROR", "Rate limit returned an unexpected payload");
      }
      return data as unknown as RateLimitDecision;
    },

    async cleanup(olderThanSeconds) {
      const { data, error } = await client.rpc("cleanup_rate_limit_counters", {
        p_older_than_seconds: olderThanSeconds,
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      const deleted =
        typeof data === "object" && data !== null
          ? (data as { deleted?: unknown }).deleted
          : undefined;
      return typeof deleted === "number" ? deleted : 0;
    },
  };
}
