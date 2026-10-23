/**
 * Operational alerts (H8): raising them from the payment paths, and the maintenance digest.
 *
 * Raising is best-effort by design: an alert is a side channel, so a failure to record one is
 * logged and never changes the webhook response, the sweep outcome or the confirmation. The
 * digest is bounded (one email per run, a capped batch) and each alert is notified once;
 * failed sends are retried by `claim_alert_notifications` with backoff and an attempt cap.
 */

import { toAppError } from "../domain/errors.ts";
import { buildAlertDigest, sanitizeAlert, type AlertInput } from "../domain/alerts.ts";
import type { AlertGateway } from "../db/alerts.ts";
import type { ResendClient } from "../integrations/resend/client.ts";
import type { Logger } from "../logging/logger.ts";

/** Records an alert; never throws. */
export type AlertSink = (alert: AlertInput) => Promise<void>;

export function createAlertSink(
  gateway: Pick<AlertGateway, "recordAlert">,
  logger: Logger,
): AlertSink {
  return async (alert) => {
    const safe = sanitizeAlert(alert);
    try {
      const recorded = await gateway.recordAlert(safe);
      logger.warn("operational alert", {
        kind: safe.kind,
        orderReference: safe.orderReference ?? null,
        paymentId: safe.paymentId ?? null,
        created: recorded.created,
        occurrences: recorded.occurrences,
      });
    } catch (error) {
      // The alert is lost only if the database is down; the situation itself is still in the
      // logs (this line) and in the payment row, and the next sweep raises it again.
      logger.error("could not record operational alert", {
        kind: safe.kind,
        orderReference: safe.orderReference ?? null,
        error: toAppError(error).code,
      });
    }
  };
}

/**
 * Raises an alert through any sink without ever letting it affect the caller: the payment
 * outcome is already decided when an alert is raised, and an alert failure must not change it.
 */
export async function raiseAlertSafely(
  sink: AlertSink | undefined,
  alert: AlertInput,
  logger: Logger,
): Promise<void> {
  if (sink === undefined) {
    return;
  }
  try {
    await sink(alert);
  } catch (error) {
    logger.error("operational alert sink failed", {
      kind: alert.kind,
      error: toAppError(error).code,
    });
  }
}

export const ALERT_DIGEST_DEFAULTS = {
  batchSize: 20,
  maxAttempts: 5,
} as const;

export type AlertDigestSkipReason =
  "NO_RECIPIENTS" | "INVALID_RECIPIENTS" | "EMAIL_DISABLED" | "NOT_CONFIGURED";

/** Stable, bounded idempotency key for one digest batch to one recipient. */
async function digestIdempotencyKey(
  recipient: string,
  sortedIds: readonly string[],
): Promise<string> {
  const bytes = new TextEncoder().encode(`${recipient}|${sortedIds.join(",")}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `alerts:${hex.join("")}`;
}

export type AlertDigestSummary = {
  /**
   * Why nothing was emailed on purpose: no ALERT_EMAIL_TO, only invalid addresses in it, or
   * email disabled. Alerts are still recorded and stay unclaimed until delivery is possible.
   */
  readonly skipped: AlertDigestSkipReason | null;
  /** Ignored ALERT_EMAIL_TO entries, surfaced on every run so the problem stays visible. */
  readonly recipientIssue: string | null;
  readonly unresolvedRaised: number;
  readonly claimed: number;
  readonly sent: number;
  readonly failed: boolean;
};

/**
 * Raises alerts for attempts whose reconciliation budget is spent, then sends ONE digest email
 * with the alerts not yet notified. Without recipients or an email provider, alerts are still
 * recorded (and logged) but nothing is claimed, so they are delivered once email is configured.
 */
export async function runAlertDigest(input: {
  readonly alerts: AlertGateway;
  readonly resend: ResendClient | undefined;
  readonly recipients: readonly string[];
  /** Why some ALERT_EMAIL_TO entries were ignored (`config.alertRecipientIssue`). */
  readonly recipientIssue?: string | undefined;
  readonly from: string | undefined;
  readonly serviceName: string;
  readonly environment: string;
  readonly reconciliationMaxAttempts: number;
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
}): Promise<AlertDigestSummary> {
  const unresolvedRaised = await input.alerts.raiseUnresolvedPaymentAlerts(
    input.reconciliationMaxAttempts,
  );
  if (unresolvedRaised > 0) {
    input.logger.warn("operational alert", {
      kind: "UNRESOLVED_PAYMENT",
      raised: unresolvedRaised,
    });
  }

  const recipientIssue = input.recipientIssue ?? null;
  if (recipientIssue !== null) {
    input.logger.warn("operational alert recipients misconfigured", { issue: recipientIssue });
  }

  const skipped: AlertDigestSkipReason | null =
    input.recipients.length === 0
      ? recipientIssue === null
        ? "NO_RECIPIENTS"
        : "INVALID_RECIPIENTS"
      : input.resend === undefined || input.from === undefined
        ? "EMAIL_DISABLED"
        : null;
  if (skipped !== null || input.resend === undefined || input.from === undefined) {
    // Visible on every run: alerts accumulate unclaimed (so nothing is lost) until delivery works.
    input.logger.warn("operational alerts are recorded but not emailed", {
      reason: skipped ?? "EMAIL_DISABLED",
    });
    return {
      skipped: skipped ?? "EMAIL_DISABLED",
      recipientIssue,
      unresolvedRaised,
      claimed: 0,
      sent: 0,
      failed: false,
    };
  }
  const resend = input.resend;
  const from = input.from;

  const claimed = await input.alerts.claimAlertNotifications(
    input.batchSize ?? ALERT_DIGEST_DEFAULTS.batchSize,
    input.maxAttempts ?? ALERT_DIGEST_DEFAULTS.maxAttempts,
  );
  if (claimed.length === 0) {
    return { skipped: null, recipientIssue, unresolvedRaised, claimed: 0, sent: 0, failed: false };
  }

  const digest = buildAlertDigest({
    alerts: claimed,
    serviceName: input.serviceName,
    environment: input.environment,
  });
  const ids = claimed.map((alert) => alert.alertId).sort();
  try {
    for (const recipient of input.recipients) {
      await resend.send({
        from,
        to: recipient,
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
        // Same batch to the same recipient is delivered once even if the run is retried (a
        // partial failure re-sends the batch; recipients already served are deduplicated).
        // Hashed, never truncated: two different batches must never share a key.
        idempotencyKey: await digestIdempotencyKey(recipient, ids),
      });
    }
  } catch (error) {
    // Left unnotified: the claim already scheduled a backoff, and the attempt cap stops it
    // from being retried forever.
    input.logger.error("operational alert digest could not be sent", {
      alerts: claimed.length,
      error: toAppError(error).code,
    });
    return {
      skipped: null,
      recipientIssue,
      unresolvedRaised,
      claimed: claimed.length,
      sent: 0,
      failed: true,
    };
  }

  await input.alerts.finishAlertNotifications(ids);
  input.logger.info("operational alert digest sent", {
    alerts: claimed.length,
    recipients: input.recipients.length,
  });
  return {
    skipped: null,
    recipientIssue,
    unresolvedRaised,
    claimed: claimed.length,
    sent: claimed.length,
    failed: false,
  };
}
