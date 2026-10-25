/**
 * Scheduled maintenance: reservation expiry, outbox retry, reconciliation, cleanup, Sheets.
 *
 * Jobs that must exist but must NOT be on the payment path:
 *
 *   1. `expireOrders`  — releases inventory held by orders past their reservation window.
 *   2. `dispatchEmails` — retries failed / unsent confirmation emails with bounded backoff
 *      (legacy ticket-keyed outbox) and `postPurchaseEmails` — drains the order-keyed
 *      post-purchase outbox written on the PAID transition.
 *   3. `reconciliation` — sweeps payment attempts whose webhook never arrived (Phase 5).
 *   4. `rateLimitCleanup` — deletes expired fixed-window counters.
 *   5. `sheetsSync`    — drains the Google Sheets projection outbox (Phase 5).
 *
 * Every job is idempotent and concurrent-safe at the database level
 * (`FOR UPDATE SKIP LOCKED`, atomic claims), so running the endpoint twice, or from two
 * schedulers at once, is harmless. None of them can mark an order paid: only a verified
 * Wompi transaction (webhook, sweep or buyer hint) can do that, and all three feed the SAME
 * `confirm_payment` transaction.
 *
 * Failure isolation: expiry and email are critical jobs — if they fail, the run reports an
 * error (500) so the scheduler surfaces it. The three Phase 5 jobs are bounded side work:
 * each is wrapped so a Wompi or Google problem is logged and listed in `jobErrors` without
 * stopping the other jobs. Nothing they do can affect a payment or a ticket.
 *
 * TRIGGERING: the scheduler is `pg_cron` → `net.http_post` → this endpoint (migration
 * 20261003210015, secrets read from Vault), with a documented HTTP fallback:
 *
 *   curl -X POST "$API_BASE_URL/orders-maintenance" \
 *     -H "authorization: Bearer $MAINTENANCE_API_TOKEN"
 */

import { constantTimeEquals } from "../integrations/wompi/signature.ts";
import { toAppError, unauthorizedError } from "../domain/errors.ts";
import { RATE_LIMIT_CLEANUP_HORIZON_SECONDS } from "../domain/rate-limits.ts";
import { dispatchEmails, type DispatchSummary } from "./email-dispatch.ts";
import {
  ZERO_POST_PURCHASE_DISPATCH_SUMMARY,
  dispatchPostPurchaseEmails,
  type PostPurchaseDispatchSummary,
} from "./post-purchase-email-dispatch.ts";
import {
  runReconciliationSweep,
  type ReconciliationSweepSummary,
} from "./reconciliation-handler.ts";
import { runSheetsSync, type SheetsSyncSummary } from "./sheets-sync.ts";
import type { BackendConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";
import type { OrderStatusGateway, PaymentGateway } from "../db/payments.ts";
import type { PostPurchaseEmailGateway } from "../db/post-purchase-emails.ts";
import type { RateLimitGateway } from "../db/rate-limits.ts";
import type { SheetsGateway } from "../db/sheets.ts";
import type { ResendClient } from "../integrations/resend/client.ts";
import type { WompiClient } from "../integrations/wompi/client.ts";
import type { EpaycoClient } from "../integrations/epayco/client.ts";
import type { AlertGateway } from "../db/alerts.ts";
import { createAlertSink, runAlertDigest, type AlertDigestSummary } from "./alerts.ts";
import { RECONCILIATION_DEFAULTS } from "../domain/reconciliation.ts";
import type { SheetsClient } from "../integrations/google/sheets-client.ts";

export type MaintenanceResult = {
  readonly expiredOrders: {
    readonly expiredCount: number;
    readonly releasedTiers: number;
    readonly references: readonly string[];
  };
  readonly emails: DispatchSummary;
  /** Order-keyed post-purchase emails dispatched (or scheduled for retry) in this run. */
  readonly postPurchaseEmails: PostPurchaseDispatchSummary;
  readonly reconciliation: ReconciliationSweepSummary;
  /** Operational alerts raised for unresolved payments and the digest sent this run (H8). */
  readonly alerts: AlertDigestSummary;
  readonly sheetProjections: SheetsSyncSummary;
  readonly rateLimitCountersDeleted: number;
  /** Names of non-critical jobs that failed unexpectedly during this run. */
  readonly jobErrors: readonly string[];
  readonly ranAt: string;
};

/**
 * Constant-time comparison of the presented maintenance token.
 * A missing configuration is a refusal, never an open door.
 */
export function isMaintenanceAuthorized(
  configuredToken: string | undefined,
  presentedToken: string | undefined,
): boolean {
  if (configuredToken === undefined || configuredToken.length === 0) {
    return false;
  }
  if (presentedToken === undefined || presentedToken.length === 0) {
    return false;
  }
  return constantTimeEquals(configuredToken, presentedToken);
}

export type RunMaintenanceInput = {
  readonly config: BackendConfig;
  readonly logger: Logger;
  readonly payments: PaymentGateway;
  readonly orderStatus: OrderStatusGateway;
  readonly resend: ResendClient | undefined;
  /**
   * Order-keyed post-purchase outbox. Optional so a deployment or test that does not wire it
   * still runs every other job; the run then reports zeros for that job instead of failing.
   */
  readonly postPurchaseEmail?: PostPurchaseEmailGateway | undefined;
  readonly wompi: WompiClient;
  /**
   * ePayco validation client for reconciling ePayco attempts. Absent when the merchant
   * credentials are not configured: those attempts are then retried, never sent to Wompi.
   */
  readonly epayco?: EpaycoClient | undefined;
  /** Operational alert ledger (H8). Absent: no alerts are raised or sent by this run. */
  readonly alerts?: AlertGateway | undefined;
  readonly sheets: SheetsGateway;
  /** `undefined` when Google credentials are not configured; the sync is then skipped. */
  readonly sheetsClient: SheetsClient | undefined;
  readonly rateLimits: RateLimitGateway;
  /** Maximum orders to expire in one run; bounded so a run cannot be unbounded. */
  readonly orderLimit?: number;
};

/**
 * Runs one non-critical job without letting its failure stop the others.
 * The failure is logged and named in `jobErrors`; the run itself still succeeds.
 */
async function runJob<T>(
  name: string,
  logger: Logger,
  errors: string[],
  fallback: T,
  job: () => Promise<T>,
): Promise<T> {
  try {
    return await job();
  } catch (error) {
    logger.error("maintenance job failed", { job: name, error: toAppError(error).code });
    errors.push(name);
    return fallback;
  }
}

/**
 * Runs every job. Expiry runs BEFORE dispatch so an order expired in this run cannot have
 * its (nonexistent) emails attempted in the same pass. The projection runs LAST because it
 * is the only job that talks to a third party for purely informational data.
 */
export async function runMaintenance(input: RunMaintenanceInput): Promise<MaintenanceResult> {
  const { config, logger, payments } = input;
  const orderLimit = input.orderLimit ?? 100;
  const jobErrors: string[] = [];

  const expired = await payments.expirePendingOrders(orderLimit);
  if (expired.expiredCount > 0) {
    logger.info("expired orders past their reservation window", {
      expiredCount: expired.expiredCount,
      releasedTiers: expired.releasedTiers,
    });
  }

  const emails = await dispatchEmails({
    config,
    logger,
    payments,
    orderStatus: input.orderStatus,
    resend: input.resend,
    limit: config.emailDispatchBatchSize,
  });

  // Retries of the post-purchase email (a transient Resend failure, a crash mid-send). New
  // messages are enqueued by the PAID trigger, never by this job.
  const postPurchaseEmails = await runJob<PostPurchaseDispatchSummary>(
    "post-purchase-emails",
    logger,
    jobErrors,
    ZERO_POST_PURCHASE_DISPATCH_SUMMARY,
    () =>
      input.postPurchaseEmail === undefined
        ? Promise.resolve(ZERO_POST_PURCHASE_DISPATCH_SUMMARY)
        : dispatchPostPurchaseEmails({
            config,
            logger,
            gateway: input.postPurchaseEmail,
            resend: input.resend,
            limit: config.emailDispatchBatchSize,
          }),
  );

  const reconciliation = await runJob<ReconciliationSweepSummary>(
    "reconciliation",
    logger,
    jobErrors,
    { claimed: 0, byResult: {}, confirmedApproved: 0, reviewRequired: [], emailsQueued: 0 },
    () =>
      runReconciliationSweep({
        payments,
        wompi: input.wompi,
        epayco:
          input.epayco === undefined
            ? undefined
            : {
                client: input.epayco,
                credentials: {
                  custIdCliente: config.epayco.custIdCliente,
                  pKey: config.epayco.pKey,
                },
                testMode: config.epayco.test,
              },
        alerts: input.alerts === undefined ? undefined : createAlertSink(input.alerts, logger),
        logger,
      }),
  );

  // After the sweep, so attempts whose budget it just spent are alerted in the same run.
  const alertGateway = input.alerts;
  const alerts = await runJob<AlertDigestSummary>(
    "alerts",
    logger,
    jobErrors,
    { skipped: null, recipientIssue: null, unresolvedRaised: 0, claimed: 0, sent: 0, failed: true },
    async () =>
      alertGateway === undefined
        ? {
            skipped: "NOT_CONFIGURED",
            recipientIssue: config.alertRecipientIssue ?? null,
            unresolvedRaised: 0,
            claimed: 0,
            sent: 0,
            failed: false,
          }
        : runAlertDigest({
            alerts: alertGateway,
            resend: input.resend,
            recipients: config.alertRecipients,
            recipientIssue: config.alertRecipientIssue,
            from: config.email.enabled ? config.email.from : undefined,
            serviceName: config.serviceName,
            environment: config.appEnv,
            reconciliationMaxAttempts: RECONCILIATION_DEFAULTS.maxAttempts,
            logger,
          }),
  );

  const rateLimitCountersDeleted = await runJob("rate-limit-cleanup", logger, jobErrors, 0, () =>
    input.rateLimits.cleanup(RATE_LIMIT_CLEANUP_HORIZON_SECONDS),
  );

  const sheetProjections = await runJob<SheetsSyncSummary>(
    "sheet-projections",
    logger,
    jobErrors,
    {
      skipped: input.sheetsClient === undefined,
      configured: input.sheetsClient !== undefined,
      claimed: 0,
      syncedTickets: 0,
      failedTickets: 0,
      exhaustedTickets: 0,
      rowsWritten: 0,
      statusTabWritten: false,
      error: null,
    },
    () =>
      runSheetsSync({
        sheets: input.sheets,
        client: input.sheetsClient,
        timezone: config.timezone,
        logger,
      }),
  );

  return {
    expiredOrders: {
      expiredCount: expired.expiredCount,
      releasedTiers: expired.releasedTiers,
      references: expired.references,
    },
    emails,
    postPurchaseEmails,
    reconciliation,
    alerts,
    sheetProjections,
    rateLimitCountersDeleted,
    jobErrors,
    ranAt: new Date().toISOString(),
  };
}

/** Wraps a maintenance run so a failure is reported without crashing the runtime. */
export async function runMaintenanceSafely(
  input: RunMaintenanceInput,
): Promise<{ readonly ok: true; readonly result: MaintenanceResult } | { readonly ok: false }> {
  try {
    return { ok: true, result: await runMaintenance(input) };
  } catch (error) {
    input.logger.error("maintenance run failed", { error: toAppError(error).code });
    return { ok: false };
  }
}

/** Thrown for a missing or wrong maintenance token. */
export function maintenanceUnauthorized(): Error {
  return unauthorizedError("Maintenance token is missing or invalid", {
    context: { surface: "maintenance" },
  });
}
