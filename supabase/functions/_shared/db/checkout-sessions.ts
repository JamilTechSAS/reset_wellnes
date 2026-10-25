/**
 * Data access for checkout sessions (migration 20261024170000).
 *
 * The database owns the rule "one live ePayco session per payment attempt"; this module is the
 * typed transport for it. It never decides anything itself: `begin` returns the plan the SQL
 * function chose, `complete` records the provider session only if this request still holds the
 * lease, and `abandon` releases the lease after a failed provider call.
 *
 * Calls go through SECURITY INVOKER functions with the service-role client, like every other
 * gateway in this directory.
 */

import { AppError } from "../domain/errors.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";

/** Lease held while the provider call runs. It only has to outlast one ePayco request. */
export const CHECKOUT_LEASE_SECONDS = 30;

export type CheckoutSessionPlan =
  /** This attempt already has a usable session: hand the buyer the same one, create nothing. */
  | {
      readonly state: "REUSE";
      readonly paymentId: string;
      readonly paymentReference: string;
      readonly paymentAttempt: number;
      readonly sessionId: string;
      readonly sessionExpiresAt: string | null;
    }
  /** Nobody has a live session: this request owns the lease and may create one. */
  | {
      readonly state: "CREATE";
      readonly paymentId: string;
      readonly paymentReference: string;
      readonly paymentAttempt: number;
      readonly generation: number;
    }
  /** Another request is creating the session right now. */
  | {
      readonly state: "LEASED";
      readonly paymentId: string;
      readonly paymentReference: string;
      readonly paymentAttempt: number;
    }
  /** The attempt can no longer be paid: only a new attempt (`/retry`) can issue a session. */
  | {
      readonly state: "RETRY_REQUIRED";
      readonly paymentId: string;
      readonly paymentReference: string;
      readonly paymentAttempt: number;
      readonly reason: string;
    };

export type CheckoutSessionOutcome =
  | "RECORDED"
  /** Another request claimed a newer lease (or already completed it). */
  | "LEASE_LOST"
  /** The order reservation lapsed while the provider call was in flight. */
  | "RESERVATION_EXPIRED";

/** The reasons the SQL function may report for RETRY_REQUIRED (closed vocabulary). */
export const RETRY_REQUIRED_REASONS = [
  "ORDER_NOT_PENDING",
  "RESERVATION_EXPIRED",
  "TRANSACTION_RECORDED",
] as const;

export type RetryRequiredReason = (typeof RETRY_REQUIRED_REASONS)[number];

export type CheckoutSessionGateway = {
  begin(input: {
    readonly paymentReference: string;
    readonly leaseSeconds?: number;
  }): Promise<CheckoutSessionPlan>;
  complete(input: {
    readonly paymentReference: string;
    readonly generation: number;
    readonly sessionId: string;
  }): Promise<CheckoutSessionOutcome>;
  abandon(input: {
    readonly paymentReference: string;
    readonly generation: number;
  }): Promise<boolean>;
};

/** Raised when the function answers a shape this gateway does not know. */
function malformed(message: string): AppError {
  return new AppError("INTERNAL_ERROR", message);
}

function isRetryRequiredReason(value: unknown): value is RetryRequiredReason {
  return typeof value === "string" && (RETRY_REQUIRED_REASONS as readonly string[]).includes(value);
}

/** Validates the identity every plan carries, so a drift fails loudly instead of silently. */
function toPlanBase(row: Record<string, unknown>): {
  paymentId: string;
  paymentReference: string;
  paymentAttempt: number;
} {
  if (
    typeof row.paymentId !== "string" ||
    typeof row.paymentReference !== "string" ||
    typeof row.paymentAttempt !== "number"
  ) {
    throw malformed("Checkout session plan is missing its payment identity");
  }
  return {
    paymentId: row.paymentId,
    paymentReference: row.paymentReference,
    paymentAttempt: row.paymentAttempt,
  };
}

export function toCheckoutSessionPlan(value: unknown): CheckoutSessionPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed("Checkout session plan is not an object");
  }
  const row = value as Record<string, unknown>;
  const base = toPlanBase(row);

  switch (row.state) {
    case "REUSE":
      if (typeof row.sessionId !== "string" || row.sessionId.length === 0) {
        throw malformed("Checkout session plan has no session id to resume");
      }
      return {
        state: "REUSE",
        ...base,
        sessionId: row.sessionId,
        sessionExpiresAt: typeof row.sessionExpiresAt === "string" ? row.sessionExpiresAt : null,
      };
    case "CREATE":
      if (typeof row.generation !== "number") {
        throw malformed("Checkout session plan has no lease generation");
      }
      return { state: "CREATE", ...base, generation: row.generation };
    case "LEASED":
      return { state: "LEASED", ...base };
    case "RETRY_REQUIRED":
      if (!isRetryRequiredReason(row.reason)) {
        throw malformed("Checkout session plan carried an unknown retry reason");
      }
      return { state: "RETRY_REQUIRED", ...base, reason: row.reason };
    default:
      throw malformed("Checkout session plan carried an unknown state");
  }
}

export function createCheckoutSessionGateway(client: DbClient): CheckoutSessionGateway {
  return {
    async begin(input) {
      const { data, error } = await client.rpc("begin_checkout_session", {
        p_payment_reference: input.paymentReference,
        p_lease_seconds: input.leaseSeconds ?? CHECKOUT_LEASE_SECONDS,
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      return toCheckoutSessionPlan(data);
    },

    async complete(input) {
      const { data, error } = await client.rpc("complete_checkout_session", {
        p_payment_reference: input.paymentReference,
        p_generation: input.generation,
        p_session_id: input.sessionId,
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      const row = data as { readonly created?: unknown; readonly reason?: unknown };
      if (row.created === true) {
        return "RECORDED";
      }
      if (row.reason === "RESERVATION_EXPIRED") {
        return "RESERVATION_EXPIRED";
      }
      if (row.reason === "LEASE_LOST") {
        return "LEASE_LOST";
      }
      throw malformed("Checkout session completion returned an unknown answer");
    },

    async abandon(input) {
      const { data, error } = await client.rpc("abandon_checkout_session", {
        p_payment_reference: input.paymentReference,
        p_generation: input.generation,
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      return (data as { readonly released?: unknown }).released === true;
    },
  };
}
