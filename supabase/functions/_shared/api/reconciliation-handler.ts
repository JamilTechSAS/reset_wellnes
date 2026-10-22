/**
 * Payment reconciliation sweep.
 *
 * The safety net for the one hole a webhook cannot cover: an APPROVED payment whose
 * notification never arrived. The sweep never decides a payment itself — it re-reads the
 * transaction with the private key and feeds the SAME `public.confirm_payment` transaction
 * the webhook uses (`domain/payment-confirmation.ts` is the shared specification), so the
 * two paths can never disagree about what an approval means.
 *
 * Bounded by construction:
 *   * `claim_payment_reconciliations` locks candidates with SKIP LOCKED and consumes an
 *     attempt, so two concurrent runs split the work and nothing is queried twice;
 *   * the attempt budget stops a permanently pending attempt from being swept forever;
 *   * a transient Wompi/database failure is scheduled for a sooner retry (2 min) instead of
 *     waiting for the next backoff step;
 *   * terminal outcomes clear the schedule entirely (see migration 20261003210012).
 *
 * Safety notes:
 *   * PAID orders are excluded at claim time (a second approval would violate the
 *     one-approved-payment-per-order index); an approval for an EXPIRED/CANCELLED order
 *     goes through `confirm_payment` and becomes RECONCILIATION_REQUIRED for an operator.
 *   * The sweep logs identifiers and outcomes only — never request or provider bodies.
 */

import { toAppError } from "../domain/errors.ts";
import {
  failureForResult,
  mapSweepOutcome,
  RECONCILIATION_DEFAULTS,
  requiresReconciliationReview,
  type ReconciliationResult,
} from "../domain/reconciliation.ts";
import {
  boundStatusMessage,
  isConfirmationResult,
  validateTransactionAgainstPayment,
} from "../domain/payment-confirmation.ts";
import { WompiApiError } from "../integrations/wompi/client.ts";
import { buildProviderPayload } from "./payment-payload.ts";
import type { WompiClient } from "../integrations/wompi/client.ts";
import type {
  ClaimedReconciliation,
  ConfirmPaymentResult,
  PaymentGateway,
} from "../db/payments.ts";
import type { Logger } from "../logging/logger.ts";
import type { ConfirmationResult } from "../domain/payment-confirmation.ts";

/** A confirmation whose `result` has been narrowed to the closed vocabulary. */
type AppliedConfirmation = Omit<ConfirmPaymentResult, "result"> & {
  readonly result: ConfirmationResult;
};

/** The three gateway capabilities the sweep needs; a narrower port keeps tests simple. */
export type ReconciliationGateway = Pick<
  PaymentGateway,
  | "claimPaymentReconciliations"
  | "finishPaymentReconciliation"
  | "confirmPayment"
  | "queueTicketEmails"
>;

export type ReconciliationSweepSummary = {
  readonly claimed: number;
  /** Count per reconciliation result, only for results that occurred. */
  readonly byResult: Readonly<Partial<Record<ReconciliationResult, number>>>;
  /** Approved transactions this sweep confirmed (APPLIED or DUPLICATE). */
  readonly confirmedApproved: number;
  /** Orders that need an operator (late approval, mismatch, transaction not at Wompi). */
  readonly reviewRequired: readonly string[];
  /** Confirmation emails queued by a recovery that moved an order to PAID. */
  readonly emailsQueued: number;
};

export type RunReconciliationSweepInput = {
  readonly payments: ReconciliationGateway;
  readonly wompi: WompiClient;
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly upstreamRetrySeconds?: number;
  /** Injected clock for deterministic retry timestamps. */
  readonly now?: () => Date;
};

type FinishInput = {
  readonly paymentId: string;
  readonly result: ReconciliationResult;
  readonly failure?: string | undefined;
  readonly nextAttemptAt?: string | undefined;
};

/** Sweeps one claimed attempt through the same pipeline the webhook uses. */
async function sweepOne(input: {
  readonly claimed: ClaimedReconciliation;
  readonly deps: RunReconciliationSweepInput;
  readonly finish: (args: FinishInput) => Promise<void>;
}): Promise<{ readonly result: ReconciliationResult; readonly emailsQueued: number }> {
  const { claimed, deps } = input;
  const logger = deps.logger;

  let transaction;
  try {
    transaction = await deps.wompi.getTransaction(claimed.wompiTransactionId);
  } catch (error) {
    if (error instanceof WompiApiError && error.httpStatus === 404) {
      // The id was recorded locally but Wompi does not know it. That is not a payment
      // decision: it needs a human, so the result is terminal for scheduling purposes.
      logger.error("reconciliation: transaction id is unknown at Wompi", {
        orderReference: claimed.orderReference,
        paymentId: claimed.paymentId,
        transactionId: claimed.wompiTransactionId,
      });
      await input.finish({
        paymentId: claimed.paymentId,
        result: "NOT_FOUND_AT_PROVIDER",
        failure: "PROVIDER_NOT_FOUND",
      });
      return { result: "NOT_FOUND_AT_PROVIDER", emailsQueued: 0 };
    }
    // Network error, 429, 5xx, unexpected payload: retry soon, within the attempt budget.
    logger.warn("reconciliation: Wompi lookup failed", {
      orderReference: claimed.orderReference,
      paymentId: claimed.paymentId,
      error: toAppError(error).code,
    });
    const retryAt = new Date(
      (deps.now?.() ?? new Date()).getTime() +
        (deps.upstreamRetrySeconds ?? RECONCILIATION_DEFAULTS.upstreamRetryDelaySeconds) * 1000,
    ).toISOString();
    await input.finish({
      paymentId: claimed.paymentId,
      result: "UPSTREAM_ERROR",
      failure: "UPSTREAM_ERROR",
      nextAttemptAt: retryAt,
    });
    return { result: "UPSTREAM_ERROR", emailsQueued: 0 };
  }

  const problems = validateTransactionAgainstPayment({
    transaction,
    eventTransactionId: claimed.wompiTransactionId,
    // There is no event reference in a sweep; the authoritative comparison is inside the
    // validator (`transaction.reference` against the recorded reference).
    eventReference: transaction.reference,
    payment: {
      wompiReference: claimed.wompiReference,
      wompiTransactionId: claimed.wompiTransactionId,
      amountCents: claimed.amountCents,
      currency: claimed.currency,
    },
    order: { totalInCents: claimed.orderTotalInCents, currency: claimed.orderCurrency },
  });

  if (problems.length > 0) {
    logger.error("reconciliation: transaction does not match our record", {
      orderReference: claimed.orderReference,
      paymentId: claimed.paymentId,
      problems,
    });
    await input.finish({
      paymentId: claimed.paymentId,
      result: "MISMATCH",
      failure: "VALIDATION_MISMATCH",
    });
    return { result: "MISMATCH", emailsQueued: 0 };
  }

  let confirmation: AppliedConfirmation | undefined;
  try {
    // The SAME confirmation transaction as the webhook path. The attempt id travels with
    // the reference/amount so `confirm_payment` can never attach this transaction to a
    // different attempt.
    const applied = await deps.payments.confirmPayment({
      orderReference: claimed.orderReference,
      wompiReference: claimed.wompiReference,
      wompiTransactionId: transaction.id,
      wompiStatus: transaction.status,
      amountCents: transaction.amountInCents,
      currency: transaction.currency,
      paymentMethodType: transaction.paymentMethodType,
      statusMessage: boundStatusMessage(transaction.statusMessage),
      providerPayload: buildProviderPayload(transaction),
    });
    if (!isConfirmationResult(applied.result)) {
      // The database function returns a closed set; anything else is a local bug, not a
      // payment decision, so it is retried (and finally surfaced) rather than interpreted.
      throw new Error("Unrecognized confirmation result");
    }
    // The spread keeps the narrowed result type: the property is a `ConfirmationResult`
    // from here on, so `mapSweepOutcome` accepts it without a cast.
    confirmation = { ...applied, result: applied.result };
  } catch (error) {
    // A local inconsistency (or a transient database failure) while applying a validated
    // transaction: retry within the budget; the attempt stays visible after it is spent.
    logger.error("reconciliation: confirmation failed", {
      orderReference: claimed.orderReference,
      paymentId: claimed.paymentId,
      error: toAppError(error).code,
    });
    const retryAt = new Date(
      (deps.now?.() ?? new Date()).getTime() +
        (deps.upstreamRetrySeconds ?? RECONCILIATION_DEFAULTS.upstreamRetryDelaySeconds) * 1000,
    ).toISOString();
    await input.finish({
      paymentId: claimed.paymentId,
      result: "UPSTREAM_ERROR",
      failure: "CONFIRMATION_FAILED",
      nextAttemptAt: retryAt,
    });
    return { result: "UPSTREAM_ERROR", emailsQueued: 0 };
  }

  let emailsQueued = 0;
  if (confirmation.orderStatus === "PAID" && confirmation.ticketsExpected > 0) {
    // A recovery that just moved the order to PAID must also queue the confirmation
    // emails; the outbox function is idempotent, so a later webhook replay queues nothing.
    const queued = await deps.payments.queueTicketEmails(confirmation.orderId);
    emailsQueued = queued.queued;
  }

  const result = mapSweepOutcome({
    providerStatus: transaction.status,
    confirmation: confirmation.result,
  });
  const failure = failureForResult(result);

  logger.info("reconciliation sweep applied", {
    orderReference: claimed.orderReference,
    paymentId: claimed.paymentId,
    attempt: claimed.paymentAttempt,
    providerStatus: transaction.status,
    confirmationResult: confirmation.result,
    result,
    orderStatus: confirmation.orderStatus,
    ticketsIssued: confirmation.ticketsIssued,
    ticketsExpected: confirmation.ticketsExpected,
    emailsQueued,
  });

  await input.finish({
    paymentId: claimed.paymentId,
    result,
    ...(failure === undefined ? {} : { failure }),
  });
  return { result, emailsQueued };
}

/**
 * Claims and sweeps one bounded batch. Each attempt is fully isolated: a failure on one
 * payment never aborts the sink for the rest.
 */
export async function runReconciliationSweep(
  input: RunReconciliationSweepInput,
): Promise<ReconciliationSweepSummary> {
  const batchSize = input.batchSize ?? RECONCILIATION_DEFAULTS.batchSize;
  const maxAttempts = input.maxAttempts ?? RECONCILIATION_DEFAULTS.maxAttempts;

  const claimed = await input.payments.claimPaymentReconciliations(batchSize, maxAttempts);
  const byResult: Partial<Record<ReconciliationResult, number>> = {};
  const reviewRequired: string[] = [];
  let confirmedApproved = 0;
  let emailsQueued = 0;

  const record = (result: ReconciliationResult): void => {
    byResult[result] = (byResult[result] ?? 0) + 1;
    if (result === "APPROVED_APPLIED" || result === "APPROVED_DUPLICATE") {
      confirmedApproved += 1;
    }
  };

  const finish = async (args: FinishInput): Promise<void> => {
    await input.payments.finishPaymentReconciliation({
      paymentId: args.paymentId,
      result: args.result,
      ...(args.failure === undefined ? {} : { failure: args.failure }),
      ...(args.nextAttemptAt === undefined ? {} : { nextAttemptAt: args.nextAttemptAt }),
    });
  };

  for (const row of claimed) {
    try {
      const outcome = await sweepOne({ claimed: row, deps: input, finish });
      record(outcome.result);
      if (requiresReconciliationReview(outcome.result)) {
        reviewRequired.push(row.orderReference);
      }
      emailsQueued += outcome.emailsQueued;
    } catch (error) {
      // The claim already advanced the schedule; recording the result is best-effort so an
      // unexpected error in one row cannot stop the others. The row keeps its schedule and
      // will be swept again within the attempt budget.
      input.logger.error("reconciliation sweep row failed unexpectedly", {
        paymentId: row.paymentId,
        orderReference: row.orderReference,
        error: toAppError(error).code,
      });
      record("UPSTREAM_ERROR");
    }
  }

  if (claimed.length > 0 && confirmedApproved > 0) {
    input.logger.info("reconciliation recovered approved payments", { confirmedApproved });
  }

  return {
    claimed: claimed.length,
    byResult,
    confirmedApproved,
    reviewRequired,
    emailsQueued,
  };
}
