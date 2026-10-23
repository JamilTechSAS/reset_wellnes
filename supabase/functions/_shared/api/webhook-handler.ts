/**
 * Wompi webhook handler (runtime-agnostic orchestration).
 *
 * The exact sequence, and why each step exists:
 *
 *   1. Parse the body           — malformed input never reaches the database.
 *   2. Verify the checksum      — proves the delivery came from Wompi (events secret).
 *   3. Compute the event key    — a stable identity for deduplication.
 *   4. CLAIM the event          — inserts it; a FINALIZED duplicate loses the unique
 *                                 constraint and is answered 200 immediately, so Wompi
 *                                 stops retrying. A duplicate that was never finalized
 *                                 (the previous run failed transiently) is processed
 *                                 again: answering 200 there would swallow the retry the
 *                                 503 contract depends on.
 *   5. Look up the transaction  — `GET /v1/transactions/{id}` with the PRIVATE key. This is
 *                                 the authoritative status; the webhook body is only a
 *                                 pointer to which transaction to read.
 *   6. Validate it locally      — reference, amount, currency, transaction id, all exact.
 *   7. CONFIRM                  — one SQL transaction: payment, order, inventory, tickets.
 *   8. Queue emails             — inside the same transaction (part of step 7's function
 *                                 chain in the caller) so a rollback sends nothing.
 *   9. FINALIZE the event       — records the outcome on the ledger row.
 *
 * Response contract (derived from the documented retry model: a non-200 is retried after
 * 30 minutes, 3 hours and 24 hours, up to three attempts):
 *
 *   200  durably handled: applied, duplicate, ignored, or reconciliation required. Wompi
 *        must NOT retry — correctness does not depend on another delivery.
 *   400  the delivery is not authentic (bad checksum, malformed, wrong environment).
 *   503  a transient failure (Wompi unreachable, database error). Retrying is exactly what
 *        should happen; the event row stays unprocessed so the retry can complete it.
 *
 * The handler never returns a secret, never echoes the request body and never logs personal
 * data: it logs identifiers (reference, transaction id, event id) and outcomes only.
 */

import {
  buildEventDedupeKey,
  boundStatusMessage,
  isConfirmationReason,
  isConfirmationResult,
  requiresOperatorReview,
  validateTransactionAgainstPayment,
  type ConfirmationResult,
} from "../domain/payment-confirmation.ts";
import { AppError, toAppError } from "../domain/errors.ts";
import { toPaymentStatusSnapshot } from "../domain/payment-status.ts";
import {
  parseWompiEventEnvelope,
  verifyWompiEvent,
  type WompiEventEnvelope,
  type WompiEventRejectionReason,
} from "../integrations/wompi/events.ts";
import type { WompiClient } from "../integrations/wompi/client.ts";
import {
  WOMPI_TRANSACTION_UPDATED_EVENT,
  toAppEnvironment,
  type WompiTransactionEventPayload,
} from "../integrations/wompi/types.ts";
import { extractTransactionEventPayload } from "../integrations/wompi/events.ts";
import { buildProviderPayload } from "./payment-payload.ts";
import type { PaymentGateway, PaymentLookup } from "../db/payments.ts";
import type { BackendConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";

export type WebhookOutcome = {
  /** HTTP status this delivery must answer with. */
  readonly status: number;
  /** Stable machine-readable outcome for logs and tests. */
  readonly outcome:
    "APPLIED" | "DUPLICATE" | "IGNORED" | "RECONCILIATION_REQUIRED" | "REJECTED" | "RETRY";
  readonly eventId: string | undefined;
  readonly orderReference: string | undefined;
  readonly transactionId: string | undefined;
  readonly ticketsIssued: number;
  readonly reason: string;
  /** True when an operator must look at this by hand. */
  readonly reviewRequired: boolean;
};

export type HandleWompiWebhookInput = {
  /** Parsed JSON body of the request. */
  readonly rawBody: unknown;
  /** `X-Event-Checksum` header, when present. */
  readonly headerChecksum: string | undefined;
  readonly config: BackendConfig;
  readonly logger: Logger;
  readonly payments: PaymentGateway;
  readonly wompi: WompiClient;
};

/** Log-safe description of a rejection reason. */
function rejectionStatus(reason: WompiEventRejectionReason): number {
  return reason === "CHECKSUM_MISMATCH" ||
    reason === "ENVIRONMENT_MISMATCH" ||
    reason === "MISSING_SIGNATURE"
    ? 401
    : 400;
}

const REJECTION_OUTCOMES = new Map<WompiEventRejectionReason, string>([
  ["MALFORMED_BODY", "MALFORMED_BODY"],
  ["MISSING_SIGNATURE", "MISSING_SIGNATURE"],
  ["AMBIGUOUS_TIMESTAMP", "AMBIGUOUS_TIMESTAMP"],
  ["UNRESOLVABLE_PROPERTY", "UNRESOLVABLE_PROPERTY"],
  ["UNSUPPORTED_PROPERTY_VALUE", "UNSUPPORTED_PROPERTY_VALUE"],
  ["CHECKSUM_MISMATCH", "CHECKSUM_MISMATCH"],
  ["ENVIRONMENT_MISMATCH", "ENVIRONMENT_MISMATCH"],
]);

export function describeRejection(reason: WompiEventRejectionReason): string {
  return REJECTION_OUTCOMES.get(reason) ?? "REJECTED";
}

/**
 * `POST /webhooks/wompi`.
 *
 * Returns a `WebhookOutcome`; the adapter serializes `status` and a small body. The
 * handler never throws for a business refusal — only for a genuinely unexpected error,
 * which the adapter turns into a 503 so Wompi retries.
 */
export async function handleWompiWebhook(input: HandleWompiWebhookInput): Promise<WebhookOutcome> {
  const { logger, config, payments } = input;

  // -------------------------------------------------------------------------
  // 1-2. Parse and authenticate.
  // -------------------------------------------------------------------------
  const verification = await verifyWompiEvent({
    rawBody: input.rawBody,
    eventsSecret: config.wompi.eventsSecret,
    ...(input.headerChecksum === undefined ? {} : { headerChecksum: input.headerChecksum }),
    expectedEnvironment: config.wompi.environment === "production" ? "prod" : "test",
  });

  if (!verification.ok) {
    const status = rejectionStatus(verification.reason);
    logger.warn("wompi webhook rejected", {
      reason: verification.reason,
      detail: verification.detail ?? null,
      status,
    });
    await recordRejectionSafely(input, verification.reason, status);
    return {
      status,
      outcome: "REJECTED",
      eventId: undefined,
      orderReference: undefined,
      transactionId: undefined,
      ticketsIssued: 0,
      reason: describeRejection(verification.reason),
      reviewRequired: false,
    };
  }

  const envelope = verification.envelope;
  logger.info("wompi webhook verified", {
    event: envelope.event,
    checksumSource: verification.checksumUsed,
  });

  // -------------------------------------------------------------------------
  // 3-4. Deduplicate: claim the event before doing any work.
  // -------------------------------------------------------------------------
  const dedupeKey = await buildEventDedupeKey(envelope, { accepted: true });
  if (dedupeKey === undefined) {
    // The envelope verified, so this cannot normally happen; if it does, the properties
    // were resolvable during verification but not now, which means a bug, not a forgery.
    logger.error("wompi webhook could not be fingerprinted after verification", {
      event: envelope.event,
    });
    return {
      status: 200,
      outcome: "IGNORED",
      eventId: undefined,
      orderReference: undefined,
      transactionId: undefined,
      ticketsIssued: 0,
      reason: "UNFINGERPRINTABLE",
      reviewRequired: false,
    };
  }

  const transactionPayload = extractTransactionEventPayload(envelope);
  const claim = await payments.claimWebhookEvent({
    dedupeKey,
    eventName: envelope.event,
    transactionId: transactionPayload?.id,
    checksumValid: true,
    provider: "wompi",
  });

  if (!claim.claimed && claim.processedAt !== null) {
    // A finalized redelivery (or a concurrent request that won the race): its recorded
    // outcome is the answer. Replaying it is what makes the endpoint idempotent.
    const recorded = claim.result;
    logger.info("wompi webhook duplicate", {
      eventId: claim.eventId,
      recordedResult: recorded,
      transactionId: transactionPayload?.id ?? null,
    });
    return {
      status: claim.httpStatus ?? 200,
      outcome: "DUPLICATE",
      eventId: claim.eventId,
      orderReference: undefined,
      transactionId: transactionPayload?.id ?? undefined,
      ticketsIssued: 0,
      reason: recorded ?? "ALREADY_RECORDED",
      reviewRequired: recorded === "REJECTED",
    };
  }

  if (!claim.claimed) {
    // The event was claimed earlier but never finalized: the worker died mid-run, or the
    // previous delivery answered 503 and Wompi is retrying. Processing it again is the
    // only way the documented retry can finish the job — answering 200 here would swallow
    // it and could leave an approved payment pending forever. Reprocessing is safe:
    // `confirm_payment` and the email outbox are idempotent, and `finalize_webhook_event`
    // only updates a row whose `processed_at` is still null, so whichever run finishes
    // first owns the recorded outcome.
    logger.warn("wompi webhook reprocessing an event that was never finalized", {
      eventId: claim.eventId,
      transactionId: transactionPayload?.id ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // From here the caller OWNS the event: every exit path finalizes it.
  // -------------------------------------------------------------------------
  try {
    return await processClaimedEvent({
      input,
      envelope,
      eventId: claim.eventId,
      transactionPayload,
    });
  } catch (error) {
    const appError = toAppError(error);
    // Transient failures stay unprocessed so Wompi's retry can finish the job. A permanent
    // failure (validation) is recorded as REJECTED and answered 200: retrying cannot fix it.
    const transient =
      appError.code === "INTERNAL_ERROR" ||
      appError.code === "UPSTREAM_ERROR" ||
      appError.code === "RATE_LIMITED";

    logger.error("wompi webhook processing failed", {
      eventId: claim.eventId,
      code: appError.code,
      detail: appError.context.detail ?? null,
      transient,
      transactionId: transactionPayload?.id ?? null,
    });

    if (!transient) {
      await finalizeSafely(input, {
        eventId: claim.eventId,
        result: "REJECTED",
        httpStatus: 200,
        errorCode: String(appError.context.detail ?? appError.code),
        transactionId: transactionPayload?.id,
      });
      return {
        status: 200,
        outcome: "REJECTED",
        eventId: claim.eventId,
        orderReference: undefined,
        transactionId: transactionPayload?.id ?? undefined,
        ticketsIssued: 0,
        reason: String(appError.context.detail ?? appError.code),
        reviewRequired: true,
      };
    }

    return {
      status: 503,
      outcome: "RETRY",
      eventId: claim.eventId,
      orderReference: undefined,
      transactionId: transactionPayload?.id ?? undefined,
      ticketsIssued: 0,
      reason: appError.code,
      reviewRequired: false,
    };
  }
}

async function processClaimedEvent(args: {
  readonly input: HandleWompiWebhookInput;
  readonly envelope: WompiEventEnvelope;
  readonly eventId: string;
  readonly transactionPayload: WompiTransactionEventPayload | undefined;
}): Promise<WebhookOutcome> {
  const { input, envelope, eventId, transactionPayload } = args;
  const { logger, payments, wompi } = input;

  // -------------------------------------------------------------------------
  // 5. Only `transaction.updated` carries a payment outcome here. The other documented
  //    event types (Nequi/Bancolombia tokens) are authenticated and recorded, then
  //    acknowledged: this backend does not depend on them.
  // -------------------------------------------------------------------------
  if (envelope.event !== WOMPI_TRANSACTION_UPDATED_EVENT || transactionPayload === undefined) {
    await finalizeSafely(input, {
      eventId,
      result: "IGNORED",
      httpStatus: 200,
      errorCode: "EVENT_NOT_ACTIONABLE",
      transactionId: transactionPayload?.id,
    });
    logger.info("wompi webhook ignored", { event: envelope.event, eventId });
    return {
      status: 200,
      outcome: "IGNORED",
      eventId,
      orderReference: undefined,
      transactionId: transactionPayload?.id ?? undefined,
      ticketsIssued: 0,
      reason: "EVENT_NOT_ACTIONABLE",
      reviewRequired: false,
    };
  }

  const transactionId = transactionPayload.id;

  // -------------------------------------------------------------------------
  // 5b. The payment attempt this transaction belongs to. If we have never seen the
  //     reference we ignore the event instead of guessing: our own rows are written
  //     before a checkout can exist, so an unknown reference is not ours.
  // -------------------------------------------------------------------------
  let payment: PaymentLookup | undefined = await payments.findPaymentByTransactionId(transactionId);
  payment ??= await payments.findPaymentByReference(transactionPayload.reference);

  if (payment === undefined) {
    await finalizeSafely(input, {
      eventId,
      result: "IGNORED",
      httpStatus: 200,
      errorCode: "UNKNOWN_REFERENCE",
      transactionId,
    });
    logger.warn("wompi webhook for an unknown reference", {
      eventId,
      transactionId,
      referenceLength: transactionPayload.reference.length,
    });
    return {
      status: 200,
      outcome: "IGNORED",
      eventId,
      orderReference: undefined,
      transactionId,
      ticketsIssued: 0,
      reason: "UNKNOWN_REFERENCE",
      reviewRequired: false,
    };
  }

  // -------------------------------------------------------------------------
  // 6. Authoritative read. The delivery's own status is NOT used for the decision.
  // -------------------------------------------------------------------------
  const transaction = await wompi.getTransaction(transactionId);

  const problems = validateTransactionAgainstPayment({
    transaction,
    eventTransactionId: transactionId,
    eventReference: transactionPayload.reference,
    payment,
    order: { totalInCents: payment.orderTotalInCents, currency: payment.orderCurrency },
  });

  if (problems.length > 0) {
    await finalizeSafely(input, {
      eventId,
      result: "REJECTED",
      httpStatus: 200,
      paymentId: payment.paymentId,
      errorCode: problems.join(","),
      transactionId,
    });
    logger.error("wompi transaction does not match our record", {
      eventId,
      orderReference: payment.orderReference,
      paymentId: payment.paymentId,
      problems,
    });
    return {
      status: 200,
      outcome: "RECONCILIATION_REQUIRED",
      eventId,
      orderReference: payment.orderReference,
      transactionId,
      ticketsIssued: 0,
      reason: problems.join(","),
      reviewRequired: true,
    };
  }

  // -------------------------------------------------------------------------
  // 7. Apply. One transaction inside the database.
  // -------------------------------------------------------------------------
  const statusMessage = boundStatusMessage(transaction.statusMessage);
  const confirmation = await payments.confirmPayment({
    orderReference: payment.orderReference,
    wompiReference: payment.wompiReference,
    wompiTransactionId: transaction.id,
    wompiStatus: transaction.status,
    amountCents: transaction.amountInCents,
    currency: transaction.currency,
    paymentMethodType: transaction.paymentMethodType,
    statusMessage,
    providerPayload: buildProviderPayload(transaction),
    provider: "wompi",
  });

  if (!isConfirmationResult(confirmation.result)) {
    throw new AppError("INTERNAL_ERROR", "confirmation returned an unknown result", {
      context: { result: confirmation.result },
    });
  }

  // -------------------------------------------------------------------------
  // 8. Queue the confirmation emails. Only for a paid order with issued tickets, and
  //    only through the idempotent outbox function: a replay queues nothing.
  // -------------------------------------------------------------------------
  let queued = 0;
  if (confirmation.orderStatus === "PAID" && confirmation.ticketsExpected > 0) {
    const queueResult = await payments.queueTicketEmails(confirmation.orderId);
    queued = queueResult.queued;
  }

  // -------------------------------------------------------------------------
  // 9. Record the outcome on the ledger.
  // -------------------------------------------------------------------------
  const outcome = normalizeOutcome(confirmation.result);
  await finalizeSafely(input, {
    eventId,
    result: outcome.ledgerResult,
    httpStatus: 200,
    paymentId: confirmation.paymentId,
    errorCode: outcome.reviewRequired ? confirmation.reason : undefined,
    transactionId,
  });

  const snapshot = toPaymentStatusSnapshot(transaction.status);
  logger.info("wompi payment confirmed", {
    eventId,
    orderReference: confirmation.orderReference,
    orderStatus: confirmation.orderStatus,
    paymentStatus: confirmation.paymentStatus,
    rawWompiStatus: snapshot.rawWompiStatus,
    ticketsIssued: confirmation.ticketsIssued,
    ticketsExpected: confirmation.ticketsExpected,
    emailsQueued: queued,
    result: confirmation.result,
    reason: confirmation.reason,
  });

  if (requiresOperatorReview(confirmation.result)) {
    logger.error("payment approved for an order that cannot be fulfilled", {
      eventId,
      orderReference: confirmation.orderReference,
      orderStatus: confirmation.orderStatus,
      reference: confirmation.wompiReference,
    });
  }

  if (
    confirmation.ticketsExpected > 0 &&
    confirmation.ticketsIssued < confirmation.ticketsExpected &&
    confirmation.orderStatus === "PAID"
  ) {
    // Either a replay (tickets already existed) or a genuine gap. Both are logged so an
    // operator can tell them apart from the ledger; nothing is invented here.
    logger.warn("ticket issuance did not reach the expected count", {
      eventId,
      orderReference: confirmation.orderReference,
      issued: confirmation.ticketsIssued,
      expected: confirmation.ticketsExpected,
    });
  }

  return {
    status: 200,
    outcome: outcome.outcome,
    eventId,
    orderReference: confirmation.orderReference,
    transactionId,
    ticketsIssued: confirmation.ticketsIssued,
    reason: confirmation.reason,
    reviewRequired: outcome.reviewRequired,
  };
}

type NormalizedOutcome = {
  readonly outcome: WebhookOutcome["outcome"];
  readonly ledgerResult: "APPLIED" | "DUPLICATE" | "REJECTED" | "IGNORED";
  readonly reviewRequired: boolean;
};

function normalizeOutcome(result: ConfirmationResult): NormalizedOutcome {
  switch (result) {
    case "APPLIED":
      return { outcome: "APPLIED", ledgerResult: "APPLIED", reviewRequired: false };
    case "DUPLICATE":
      return { outcome: "DUPLICATE", ledgerResult: "DUPLICATE", reviewRequired: false };
    case "RECONCILIATION_REQUIRED":
      return {
        outcome: "RECONCILIATION_REQUIRED",
        ledgerResult: "APPLIED",
        reviewRequired: true,
      };
  }
}

/** Finalizes an event without letting a logging failure change the HTTP answer. */
async function finalizeSafely(
  input: HandleWompiWebhookInput,
  args: {
    readonly eventId: string;
    readonly result: "APPLIED" | "DUPLICATE" | "REJECTED" | "IGNORED";
    readonly httpStatus: number;
    readonly paymentId?: string | undefined;
    readonly errorCode?: string | undefined;
    readonly transactionId?: string | undefined;
  },
): Promise<void> {
  try {
    const finalized = await input.payments.finalizeWebhookEvent({
      eventId: args.eventId,
      result: args.result,
      httpStatus: args.httpStatus,
      ...(args.paymentId === undefined ? {} : { paymentId: args.paymentId }),
      ...(args.errorCode === undefined ? {} : { errorCode: args.errorCode }),
      ...(args.transactionId === undefined ? {} : { transactionId: args.transactionId }),
    });
    if (!finalized.finalized) {
      input.logger.warn("webhook event was already finalized by another request", {
        eventId: args.eventId,
      });
    }
  } catch (error) {
    // The delivery itself is unaffected; the ledger row simply stays unprocessed, which
    // is exactly the state an operator looks for.
    input.logger.error("could not finalize the webhook event", {
      eventId: args.eventId,
      error: toAppError(error).code,
    });
  }
}

/** Records a refused delivery without ever failing the request because of it. */
async function recordRejectionSafely(
  input: HandleWompiWebhookInput,
  reason: WompiEventRejectionReason,
  httpStatus: number,
): Promise<void> {
  const parsed = parseWompiEventEnvelope(input.rawBody);
  if (!parsed.ok) {
    // Not even a fingerprintable body: nothing to record, and it is not worth a row.
    return;
  }
  const dedupeKey = await buildEventDedupeKey(parsed.envelope, { accepted: false });
  if (dedupeKey === undefined) {
    return;
  }
  try {
    await input.payments.recordWebhookRejection({
      dedupeKey,
      eventName: parsed.envelope.event,
      httpStatus,
      errorCode: describeRejection(reason),
      provider: "wompi",
    });
  } catch (error) {
    input.logger.error("could not record the refused webhook delivery", {
      error: toAppError(error).code,
      reason,
    });
  }
}

/** True when the outcome means "an operator must look at this by hand". */
export function needsHumanReview(outcome: WebhookOutcome): boolean {
  return outcome.reviewRequired;
}

/**
 * Splits the documented Wompi environment onto this backend's vocabulary. Exported for the
 * adapter so the mapping lives in one place.
 */
export { toAppEnvironment };

/** Re-exported for tests: the reason set the confirmation function may return. */
export { isConfirmationReason };
