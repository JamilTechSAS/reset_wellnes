/**
 * Post-purchase email dispatcher.
 *
 * Same shape as the legacy ticket-confirmation dispatcher (`email-dispatch.ts`) and the same
 * delivery guarantees, applied to the order-keyed outbox:
 *
 *   1. `confirm_payment` writes the PAID transition and the outbox row in ONE transaction;
 *   2. it commits;
 *   3. only then does anything touch the network.
 *
 * Idempotency layers:
 *   - `order_email_deliveries.order_id + template` is unique: one logical email per order, and
 *     the row is written by the PAID trigger, never by a caller;
 *   - the row is leased (`status = SENDING` + claim token) before the send, so two dispatchers
 *     cannot both send it and a stale worker cannot overwrite a newer attempt;
 *   - the same derived key travels to Resend as its `Idempotency-Key` (24 h dedupe), which is
 *     the only protection for the narrow window where the provider accepted a message and our
 *     finish UPDATE was lost.
 *
 * Guarantee, stated honestly: this is at-most-one *logical* email per order and no automatic
 * resend after a recorded SENT. It is NOT strict exactly-once: a crash between Resend's 200
 * and the SENT update can produce one duplicate after the lease expires (24 h Resend dedupe
 * bounds it in practice). A permanent provider error is recorded and never retried.
 */

import { toAppError } from "../domain/errors.ts";
import {
  MAX_EMAIL_SEND_ATTEMPTS,
  canAttemptEmailSend,
  computeEmailRetryDelayMs,
} from "../domain/email-delivery.ts";
import {
  buildPostPurchaseEmail,
  buildPostPurchaseIdempotencyKey,
  POST_PURCHASE_TEMPLATE,
} from "../domain/post-purchase-email.ts";
import type { BackendConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";
import type { PostPurchaseEmailGateway } from "../db/post-purchase-emails.ts";
import type { ResendClient } from "../integrations/resend/client.ts";

/** Same counters as the legacy dispatcher, so operators read one vocabulary. */
export type PostPurchaseDispatchSummary = {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly skipped: number;
};

export type DispatchPostPurchaseEmailsInput = {
  readonly config: BackendConfig;
  readonly logger: Logger;
  readonly gateway: PostPurchaseEmailGateway;
  readonly resend: ResendClient | undefined;
  readonly limit: number;
  readonly now?: Date;
};

export const ZERO_POST_PURCHASE_DISPATCH_SUMMARY: PostPurchaseDispatchSummary = {
  claimed: 0,
  sent: 0,
  failed: 0,
  abandoned: 0,
  skipped: 0,
};

const ZERO_SUMMARY: PostPurchaseDispatchSummary = {
  claimed: 0,
  sent: 0,
  failed: 0,
  abandoned: 0,
  skipped: 0,
};

/**
 * Claims and sends up to `limit` due deliveries.
 *
 * Never throws for one delivery: a failed send is recorded on its row with the next attempt
 * instant and the rest of the batch still runs. Only a database failure propagates, because
 * then the queue itself is unusable.
 */
export async function dispatchPostPurchaseEmails(
  input: DispatchPostPurchaseEmailsInput,
): Promise<PostPurchaseDispatchSummary> {
  const { config, logger, gateway, resend } = input;

  if (!config.email.enabled || resend === undefined) {
    // Without provider credentials the rows simply stay QUEUED: a visible, recoverable state.
    logger.debug("post-purchase email dispatch skipped: email is disabled");
    return ZERO_SUMMARY;
  }

  const claimed = await gateway.claim(input.limit, MAX_EMAIL_SEND_ATTEMPTS);
  if (claimed.length === 0) {
    return ZERO_SUMMARY;
  }

  let sent = 0;
  let failed = 0;
  let abandoned = 0;
  let skipped = 0;

  for (const delivery of claimed) {
    if (delivery.template !== POST_PURCHASE_TEMPLATE) {
      // Unknown order-level template: leave it alone (CANCELLED, never guessed at).
      skipped += 1;
      await gateway
        .finish({
          deliveryId: delivery.id,
          claimToken: delivery.claimToken,
          status: "CANCELLED",
          error: "Unsupported template",
        })
        .catch(() => undefined);
      continue;
    }

    const context = await gateway.findContext(delivery.id);
    if (context === undefined) {
      // The SQL context refuses an order that is not PAID or whose buyer email changed. That
      // is permanent for this row: retrying could only email the wrong person or an unpaid
      // order, so it is cancelled with a safe reason.
      skipped += 1;
      logger.warn("post-purchase email cancelled: order context unavailable", {
        deliveryId: delivery.id,
      });
      await gateway
        .finish({
          deliveryId: delivery.id,
          claimToken: delivery.claimToken,
          status: "CANCELLED",
          error: "Order is not payable for this email",
        })
        .catch(() => undefined);
      continue;
    }

    const outcome = await sendOne({
      ...input,
      deliveryId: delivery.id,
      claimToken: delivery.claimToken,
      orderId: delivery.orderId,
      attemptCount: delivery.attemptCount,
      context,
    });

    if (outcome === "SENT") {
      sent += 1;
    } else if (outcome === "ABANDONED") {
      abandoned += 1;
    } else {
      failed += 1;
    }
  }

  logger.info("post-purchase email outbox dispatched", {
    claimed: claimed.length,
    sent,
    failed,
    abandoned,
    skipped,
  });

  return { claimed: claimed.length, sent, failed, abandoned, skipped };
}

type SendOutcome = "SENT" | "FAILED" | "ABANDONED";

/** Where the two supplied images live; the configuration may override it. */
export function resolveEmailAssetsBaseUrl(config: BackendConfig): string {
  const configured = config.email.assetsBaseUrl;
  const base =
    configured !== undefined && configured.length > 0
      ? configured
      : `${config.publicWebBaseUrl.replace(/\/+$/, "")}/correo/img`;
  return base.replace(/\/+$/, "");
}

async function sendOne(
  input: DispatchPostPurchaseEmailsInput & {
    readonly deliveryId: string;
    readonly claimToken: string;
    readonly orderId: string;
    /** Attempts counted so far, as reported by the atomic claim. */
    readonly attemptCount: number;
    readonly context: NonNullable<Awaited<ReturnType<PostPurchaseEmailGateway["findContext"]>>>;
  },
): Promise<SendOutcome> {
  const { config, logger, gateway, resend, context } = input;
  if (resend === undefined || config.email.from === undefined) {
    return "FAILED";
  }

  const message = buildPostPurchaseEmail({
    context,
    assetsBaseUrl: resolveEmailAssetsBaseUrl(config),
    publicWebBaseUrl: config.publicWebBaseUrl,
  });

  try {
    const result = await resend.send({
      from: config.email.from,
      to: context.recipientEmail,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(config.email.replyTo === undefined ? {} : { replyTo: config.email.replyTo }),
      idempotencyKey: buildPostPurchaseIdempotencyKey(input.orderId),
    });

    if (result.ok) {
      const finished = await gateway.finish({
        deliveryId: input.deliveryId,
        claimToken: input.claimToken,
        status: "SENT",
        providerMessageId: result.messageId,
      });
      if (finished.updatedCount === 0) {
        // Our lease was taken over while the provider accepted the message. The row is owned
        // by another worker now, so this run must not claim the send.
        logger.warn("post-purchase email sent but the claim had expired", {
          deliveryId: input.deliveryId,
          orderReference: context.orderReference,
        });
        return "FAILED";
      }
      logger.info("post-purchase email sent", {
        deliveryId: input.deliveryId,
        orderReference: context.orderReference,
        providerMessageId: result.messageId,
      });
      return "SENT";
    }

    const attempt = input.attemptCount;
    const retryable = result.retryable && canAttemptEmailSend(attempt);
    const nextAttemptAt = retryable
      ? new Date(Date.now() + computeEmailRetryDelayMs(attempt + 1)).toISOString()
      : undefined;

    await gateway.finish({
      deliveryId: input.deliveryId,
      claimToken: input.claimToken,
      status: retryable ? "FAILED" : "CANCELLED",
      error: result.error,
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    });

    if (retryable) {
      logger.warn("post-purchase email failed; retry scheduled", {
        deliveryId: input.deliveryId,
        orderReference: context.orderReference,
        httpStatus: result.httpStatus ?? null,
        attempt,
      });
      return "FAILED";
    }

    logger.error("post-purchase email permanently failed", {
      deliveryId: input.deliveryId,
      orderReference: context.orderReference,
      httpStatus: result.httpStatus ?? null,
      attempt,
    });
    return "ABANDONED";
  } catch (error) {
    // An unexpected local failure (not a provider answer): keep the row retryable.
    logger.error("post-purchase email could not be processed", {
      deliveryId: input.deliveryId,
      error: toAppError(error).code,
    });
    await gateway
      .finish({
        deliveryId: input.deliveryId,
        claimToken: input.claimToken,
        status: "FAILED",
        error: "Local processing error",
        nextAttemptAt: new Date(Date.now() + computeEmailRetryDelayMs(1)).toISOString(),
      })
      .catch(() => undefined);
    return "FAILED";
  }
}
