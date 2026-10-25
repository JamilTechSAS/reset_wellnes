/**
 * Post-purchase email gateway.
 *
 * Thin typed boundary over the outbox added in migration 20261024210000. It owns no policy:
 * the claim/finish rules (leases, attempt counter, PAID-only) live in SQL, and the message
 * itself lives in `domain/post-purchase-email.ts`.
 *
 * Errors are mapped through the same SQLSTATE translation as the order gateway, so a database
 * problem never leaks constraint text or SQL into a response or a log line.
 */

import { AppError } from "../domain/errors.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";
import type { PostPurchaseEmailContext } from "../domain/post-purchase-email.ts";
import type { EmailDeliveryStatus } from "../domain/email-delivery.ts";

/** One claimed delivery row, as returned by `claim_order_email_deliveries`. */
export type ClaimedOrderEmail = {
  readonly id: string;
  readonly orderId: string;
  readonly template: string;
  readonly recipientEmail: string;
  readonly status: EmailDeliveryStatus;
  readonly attemptCount: number;
  readonly claimToken: string;
};

export type ClaimOrderEmailsRow = {
  readonly id: string;
  readonly order_id: string;
  readonly template: string;
  readonly recipient_email: string;
  readonly status: EmailDeliveryStatus;
  readonly attempt_count: number;
  readonly claim_token: string | null;
  readonly claim_expires_at: string | null;
};

export type FinishOrderEmailResult = {
  readonly updatedCount: number;
  readonly status: EmailDeliveryStatus;
};

export type FinishOrderEmailInput = {
  readonly deliveryId: string;
  /** The lease token this worker received when it claimed the row. */
  readonly claimToken: string;
  readonly status: "SENT" | "FAILED" | "CANCELLED";
  readonly providerMessageId?: string | undefined;
  readonly error?: string | undefined;
  readonly nextAttemptAt?: string | undefined;
};

export type PostPurchaseEmailGateway = {
  claim(
    limit: number,
    maxAttempts: number,
    leaseSeconds?: number,
  ): Promise<readonly ClaimedOrderEmail[]>;
  finish(input: FinishOrderEmailInput): Promise<FinishOrderEmailResult>;
  /** Order + buyer context for one delivery, or undefined when it must not be sent. */
  findContext(deliveryId: string): Promise<PostPurchaseEmailContext | undefined>;
};

function throwMapped(error: unknown): never {
  throw mapSqlErrorToAppError(error);
}

/** A claimed row is only usable when the database handed us the lease token too. */
function toClaimedOrderEmail(row: ClaimOrderEmailsRow): ClaimedOrderEmail | undefined {
  if (typeof row.claim_token !== "string" || row.claim_token.length === 0) {
    return undefined;
  }
  return {
    id: row.id,
    orderId: row.order_id,
    template: row.template,
    recipientEmail: row.recipient_email,
    status: row.status,
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
  };
}

/** Rejects a payload whose identifying fields are missing, instead of emailing a guess. */
function toContext(value: unknown): PostPurchaseEmailContext | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const required = [
    "deliveryId",
    "recipientEmail",
    "orderReference",
    "eventName",
    "eventStartsAt",
    "eventTimezone",
    "currency",
  ];
  for (const key of required) {
    const field = record[key];
    if (typeof field !== "string" || field.length === 0) {
      return undefined;
    }
  }
  return value as PostPurchaseEmailContext;
}

export function createPostPurchaseEmailGateway(client: DbClient): PostPurchaseEmailGateway {
  return {
    async claim(limit, maxAttempts, leaseSeconds = 300) {
      const { data, error } = await client.rpc("claim_order_email_deliveries", {
        p_limit: limit,
        p_max_attempts: maxAttempts,
        p_lease_seconds: leaseSeconds,
      });
      if (error !== null) {
        throwMapped(error);
      }
      const rows: readonly ClaimOrderEmailsRow[] = data;
      const claimed: ClaimedOrderEmail[] = [];
      for (const row of rows) {
        const mapped = toClaimedOrderEmail(row);
        if (mapped !== undefined) {
          claimed.push(mapped);
        }
      }
      return claimed;
    },

    async finish(input) {
      const { data, error } = await client.rpc("finish_order_email_delivery", {
        p_delivery_id: input.deliveryId,
        p_claim_token: input.claimToken,
        p_status: input.status,
        ...(input.providerMessageId === undefined
          ? {}
          : { p_provider_message_id: input.providerMessageId }),
        ...(input.error === undefined ? {} : { p_error: input.error }),
        ...(input.nextAttemptAt === undefined ? {} : { p_next_attempt_at: input.nextAttemptAt }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      if (data === null || typeof data !== "object") {
        throw new AppError("INTERNAL_ERROR", "Email finish returned an unexpected payload");
      }
      const record = data as { updatedCount?: unknown; status?: unknown };
      return {
        updatedCount: typeof record.updatedCount === "number" ? record.updatedCount : 0,
        status: (record.status ?? input.status) as EmailDeliveryStatus,
      };
    },

    async findContext(deliveryId) {
      const { data, error } = await client.rpc("get_post_purchase_email_context", {
        p_delivery_id: deliveryId,
      });
      if (error !== null) {
        throwMapped(error);
      }
      return toContext(data);
    },
  };
}
