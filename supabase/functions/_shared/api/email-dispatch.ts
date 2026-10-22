/**
 * Email outbox dispatcher.
 *
 * Runs AFTER the confirmation transaction commits. Ordering matters:
 *
 *   1. the confirmation writes the payment, the order, the tickets and the outbox rows in
 *      ONE database transaction;
 *   2. it commits;
 *   3. only then does anything touch the network.
 *
 * Sending inside a transaction would risk emailing a buyer for a payment that then rolled
 * back, so the send never happens there. The cost of the split is that a process can die
 * between commit and send — which is exactly what the outbox is for: the row is still
 * QUEUED, and the next dispatch run (another webhook, the scheduled maintenance function)
 * picks it up. Nothing is lost and nothing is sent twice.
 *
 * Idempotency has three independent layers:
 *   - `email_deliveries.idempotency_key` is unique: one row per (ticket, template), and the
 *     row is only created once, inside the confirmation transaction;
 *   - the row is CLAIMED with `for update skip locked` before the send, so two concurrent
 *     dispatchers cannot both send it;
 *   - the same key is passed to Resend as an `Idempotency-Key` header (deduplicated for 24
 *     hours), which covers the narrow window where the provider accepted a message and our
 *     UPDATE of the row was lost.
 */

import { toAppError } from "../domain/errors.ts";
import {
  MAX_EMAIL_SEND_ATTEMPTS,
  canAttemptEmailSend,
  computeEmailRetryDelayMs,
} from "../domain/email-delivery.ts";
import { buildTicketConfirmationEmail } from "../domain/email-content.ts";
import type { BackendConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";
import type { PaymentGateway, OrderStatusGateway, EmailContext } from "../db/payments.ts";
import type { ResendClient } from "../integrations/resend/client.ts";

export type DispatchSummary = {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly skipped: number;
};

export type DispatchEmailsInput = {
  readonly config: BackendConfig;
  readonly logger: Logger;
  readonly payments: PaymentGateway;
  readonly orderStatus: OrderStatusGateway;
  readonly resend: ResendClient | undefined;
  readonly limit: number;
  readonly now?: Date;
};

const ZERO_SUMMARY: DispatchSummary = {
  claimed: 0,
  sent: 0,
  failed: 0,
  abandoned: 0,
  skipped: 0,
};

/**
 * Claims and sends up to `limit` due deliveries.
 *
 * Never throws for a delivery failure: a broken send is recorded on the row (with the
 * next attempt instant) and the remaining deliveries still run. Only a database failure
 * propagates, because then the queue itself is unusable.
 */
export async function dispatchEmails(input: DispatchEmailsInput): Promise<DispatchSummary> {
  const { config, logger, payments, orderStatus, resend } = input;

  if (!config.email.enabled || resend === undefined) {
    // Email is optional: with it disabled the outbox rows simply stay QUEUED, which is a
    // valid, visible state for an environment without provider credentials.
    logger.debug("email dispatch skipped: email is disabled");
    return ZERO_SUMMARY;
  }

  const claimed = await payments.claimEmailDeliveries(input.limit, MAX_EMAIL_SEND_ATTEMPTS);
  if (claimed.length === 0) {
    return ZERO_SUMMARY;
  }

  let sent = 0;
  let failed = 0;
  let abandoned = 0;
  let skipped = 0;

  for (const delivery of claimed) {
    // `template` is bounded by a CHECK constraint, but the dispatcher only knows one
    // template; anything else is left alone rather than guessed at.
    if (delivery.template !== "TICKET_CONFIRMATION") {
      skipped += 1;
      await payments
        .finishEmailDelivery({
          deliveryId: delivery.id,
          status: "CANCELLED",
          error: "Unsupported template",
        })
        .catch(() => undefined);
      continue;
    }

    const context = await orderStatus.findEmailContext(delivery.id);
    if (context === undefined) {
      skipped += 1;
      await payments
        .finishEmailDelivery({
          deliveryId: delivery.id,
          status: "FAILED",
          error: "Ticket context is incomplete",
        })
        .catch(() => undefined);
      continue;
    }

    const outcome = await sendOne({
      ...input,
      context,
      attemptCount: delivery.attempt_count,
    });
    if (outcome === "SENT") {
      sent += 1;
    } else if (outcome === "ABANDONED") {
      abandoned += 1;
    } else {
      failed += 1;
    }
  }

  logger.info("email outbox dispatched", {
    claimed: claimed.length,
    sent,
    failed,
    abandoned,
    skipped,
  });

  return { claimed: claimed.length, sent, failed, abandoned, skipped };
}

type SendOutcome = "SENT" | "FAILED" | "ABANDONED";

async function sendOne(
  input: DispatchEmailsInput & {
    readonly context: EmailContext;
    /** Attempts counted so far, as reported by the atomic claim. */
    readonly attemptCount: number;
  },
): Promise<SendOutcome> {
  const { config, logger, payments, resend, context } = input;
  if (resend === undefined || config.email.from === undefined) {
    return "FAILED";
  }

  const message = buildTicketConfirmationEmail({
    context,
    ticketBaseUrl: config.ticketBaseUrl,
  });
  const idempotencyKey = `ticket:${context.ticketToken}:TICKET_CONFIRMATION`.slice(0, 256);

  try {
    const result = await resend.send({
      from: config.email.from,
      to: context.recipientEmail,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(config.email.replyTo === undefined ? {} : { replyTo: config.email.replyTo }),
      idempotencyKey,
    });

    if (result.ok) {
      await payments.finishEmailDelivery({
        deliveryId: context.deliveryId,
        status: "SENT",
        providerMessageId: result.messageId,
      });
      logger.info("confirmation email sent", {
        deliveryId: context.deliveryId,
        orderReference: context.orderReference,
        unit: context.ticketUnit,
        providerMessageId: result.messageId,
      });
      return "SENT";
    }

    // A permanent provider error (bad address, revoked key) is not retried: repeating it
    // only burns sender reputation and the row already carries the reason.
    const attempt = input.attemptCount;
    const retryable = result.retryable && canAttemptEmailSend(attempt);
    const nextAttemptAt = retryable
      ? new Date(Date.now() + computeEmailRetryDelayMs(attempt + 1)).toISOString()
      : undefined;

    await payments.finishEmailDelivery({
      deliveryId: context.deliveryId,
      status: retryable ? "FAILED" : "CANCELLED",
      error: result.error,
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    });

    if (retryable) {
      logger.warn("confirmation email failed; retry scheduled", {
        deliveryId: context.deliveryId,
        orderReference: context.orderReference,
        httpStatus: result.httpStatus ?? null,
        attempt,
      });
      return "FAILED";
    }

    logger.error("confirmation email permanently failed", {
      deliveryId: context.deliveryId,
      orderReference: context.orderReference,
      httpStatus: result.httpStatus ?? null,
      attempt,
    });
    return "ABANDONED";
  } catch (error) {
    // An unexpected local failure (not a provider answer): keep the row retryable and let
    // the next run deal with it. The driver never throws for one delivery.
    logger.error("confirmation email could not be processed", {
      deliveryId: context.deliveryId,
      error: toAppError(error).code,
    });
    await payments
      .finishEmailDelivery({
        deliveryId: context.deliveryId,
        status: "FAILED",
        error: "Local processing error",
        nextAttemptAt: new Date(Date.now() + computeEmailRetryDelayMs(1)).toISOString(),
      })
      .catch(() => undefined);
    return "FAILED";
  }
}
