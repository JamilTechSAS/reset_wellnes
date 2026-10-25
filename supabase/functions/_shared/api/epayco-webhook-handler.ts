/**
 * ePayco Webhook / Confirmation Handler (runtime-agnostic).
 *
 * Sequence:
 *   1. Parse incoming body (handles JSON and URL-encoded key-value pairs).
 *   2. Authenticate the delivery using the documented ePayco signature:
 *        SHA-256(p_cust_id_cliente ^ p_key ^ x_ref_payco ^ x_transaction_id ^ x_amount ^ x_currency_code)
 *      That signature does NOT cover status, invoice or the test flag.
 *   3. Read the authoritative record by `ref_payco` from ePayco's validation API and verify it
 *      against the signed fields (`integrations/epayco/verify.ts`). Lookup failures and records
 *      that still lag behind a final delivered state answer 503 so ePayco retries; records that
 *      contradict the delivery are rejected. Status, invoice and amount come only from the record.
 *   4. Claim the event in the ledger (`payment_events`) with a key derived from the record;
 *      redeliveries of already finalized events return 200 without reprocessing.
 *   5. Atomically confirm payment via `confirm_payment` in PostgreSQL, which re-checks order
 *      reference, amount, currency and payment-state transitions.
 *   7. Queue ticket confirmation emails if paid.
 *   8. Finalize the event ledger row with the recorded outcome.
 */

import { verifyEpaycoSignature } from "../integrations/epayco/signature.ts";
import {
  buildSignedDeliveryRecord,
  epaycoStatusFromCode,
  verifyEpaycoRecord,
} from "../integrations/epayco/verify.ts";
import type { EpaycoTransactionData } from "../integrations/epayco/types.ts";
import { EpaycoApiError, type EpaycoClient } from "../integrations/epayco/client.ts";
import type { PaymentGateway } from "../db/payments.ts";
import type { BackendConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";
import { toAppError } from "../domain/errors.ts";
import { alertForApprovalConflict, alertForConfirmation } from "../domain/alerts.ts";
import { raiseAlertSafely, type AlertSink } from "./alerts.ts";

export type EpaycoWebhookOutcome = {
  readonly status: number;
  readonly outcome:
    "APPLIED" | "DUPLICATE" | "IGNORED" | "RECONCILIATION_REQUIRED" | "REJECTED" | "RETRY";
  readonly eventId: string | undefined;
  readonly orderReference: string | undefined;
  readonly transactionId: string | undefined;
  readonly ticketsIssued: number;
  /**
   * Order status after the confirmation (`PENDING`, `PAID`, `EXPIRED`, …). The HTTP layer uses
   * it to trigger the post-purchase email exactly when the transition committed as PAID; it is
   * never read from the request.
   */
  readonly orderStatus: string | undefined;
  readonly reason: string;
  readonly reviewRequired: boolean;
};

export type HandleEpaycoWebhookInput = {
  readonly rawBody: unknown;
  readonly config: BackendConfig;
  readonly logger: Logger;
  readonly payments: PaymentGateway;
  readonly epayco?: EpaycoClient | undefined;
  /** Operational alerts (H8); best-effort, never changes the response. */
  readonly alerts?: AlertSink | undefined;
};

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Order references are `EVT-YYYY-NNNNNN`; payment retries append `-<attempt>`
 * (see `public.retry_payment`). The invoice ePayco echoes back is the ATTEMPT reference, so
 * the order reference is recovered by dropping a retry suffix when one is present.
 * `confirm_payment` re-checks that the attempt reference belongs to that order.
 */
const ATTEMPT_REFERENCE = /^(EVT-[0-9]{4}-[0-9]{6,})(?:-([0-9]{1,3}))?$/;

export function resolveEpaycoReferences(invoice: string): {
  readonly orderReference: string;
  readonly paymentReference: string;
} {
  const trimmed = invoice.trim();
  const match = ATTEMPT_REFERENCE.exec(trimmed);
  if (match?.[1] === undefined) {
    return { orderReference: trimmed, paymentReference: trimmed };
  }
  return { orderReference: match[1], paymentReference: trimmed };
}

/** Error codes that mean `confirm_payment` itself refused the payment (see `mapSqlErrorToAppError`). */
const PERMANENT_CONFIRMATION_ERRORS: ReadonlySet<string> = new Set([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
]);

function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && ["true", "1", "yes"].includes(value.trim().toLowerCase());
}

/** Delivery metadata kept only for audit: an empty or absent field is `null`, never a guess. */
function textOrNull(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

/** Parses raw JSON or URLSearchParams into a flat string record */
export function normalizeEpaycoPayload(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value.trim();
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
    }
  }
  return result;
}

export async function handleEpaycoWebhook(
  input: HandleEpaycoWebhookInput,
): Promise<EpaycoWebhookOutcome> {
  const { config, logger, payments } = input;
  const payload = normalizeEpaycoPayload(input.rawBody);

  const refPayco = payload.x_ref_payco ?? payload.ref_payco ?? "";
  const transactionId = payload.x_transaction_id ?? payload.transaction_id ?? "";
  const amountStr = payload.x_amount ?? payload.amount ?? "";
  const currency = (payload.x_currency_code ?? payload.currency ?? "COP").toUpperCase();
  const signature = payload.x_signature ?? payload.signature ?? "";
  // Unsigned delivery fields: used only for logging and to detect contradictions with the record.
  const bodyInvoice = payload.x_id_invoice ?? payload.x_id_factura ?? payload.invoice ?? "";
  const bodyOrderReference = resolveEpaycoReferences(bodyInvoice).orderReference;
  const codResponseStr = payload.x_cod_response ?? payload.x_cod_transaction_state ?? "";

  // 1. Basic payload shape check
  if (!refPayco || !signature) {
    logger.warn("epayco webhook payload missing required fields", {
      hasRefPayco: Boolean(refPayco),
      hasSignature: Boolean(signature),
    });
    return {
      status: 400,
      outcome: "REJECTED",
      eventId: undefined,
      orderReference: bodyOrderReference || undefined,
      transactionId: refPayco || undefined,
      ticketsIssued: 0,
      orderStatus: undefined,
      reason: "MALFORMED_PAYLOAD",
      reviewRequired: false,
    };
  }

  // 2. Authenticate the delivery signature
  const isAuthentic = await verifyEpaycoSignature({
    payload: {
      x_ref_payco: refPayco,
      x_transaction_id: transactionId,
      x_amount: amountStr,
      x_currency_code: currency,
      x_signature: signature,
      x_cust_id_cliente: payload.x_cust_id_cliente,
      p_cust_id_cliente: payload.p_cust_id_cliente,
    },
    credentials: {
      custIdCliente: config.epayco.custIdCliente,
      pKey: config.epayco.pKey,
    },
  });

  if (!isAuthentic) {
    logger.warn("epayco webhook signature mismatch", {
      orderReference: bodyOrderReference,
      refPayco,
    });
    const rejDigest = await sha256Hex(`epayco:rej:${refPayco}:${signature}`);
    const dedupeKey = `rej:epayco:${rejDigest.slice(0, 32)}`;
    try {
      await payments.recordWebhookRejection({
        dedupeKey,
        eventName: "epayco.confirmation",
        httpStatus: 401,
        errorCode: "SIGNATURE_MISMATCH",
        provider: "epayco",
      });
    } catch (e) {
      logger.error("failed to record webhook rejection", { error: toAppError(e).code });
    }
    return {
      status: 401,
      outcome: "REJECTED",
      eventId: undefined,
      orderReference: bodyOrderReference,
      transactionId: refPayco,
      ticketsIssued: 0,
      orderStatus: undefined,
      reason: "SIGNATURE_MISMATCH",
      reviewRequired: true,
    };
  }

  // 2b. A sandbox transaction must never settle an order while the backend runs live.
  //     Test and live deliveries are signed with the same merchant keys, so the signature
  //     alone cannot tell them apart.
  if (isTruthyFlag(payload.x_test_request) && !config.epayco.test) {
    logger.warn("epayco test transaction received while live mode is active", {
      orderReference: bodyOrderReference,
      refPayco,
    });
    const testDigest = await sha256Hex(`epayco:test:${refPayco}:${transactionId}`);
    try {
      await payments.recordWebhookRejection({
        dedupeKey: `rej:epayco:${testDigest.slice(0, 32)}`,
        eventName: "epayco.confirmation",
        httpStatus: 200,
        errorCode: "TEST_TRANSACTION_IN_LIVE_MODE",
        provider: "epayco",
      });
    } catch (e) {
      logger.error("failed to record webhook rejection", { error: toAppError(e).code });
    }
    // 200 so ePayco stops retrying a delivery that can never be applied.
    return {
      status: 200,
      outcome: "REJECTED",
      eventId: undefined,
      orderReference: bodyOrderReference,
      transactionId: refPayco,
      ticketsIssued: 0,
      orderStatus: undefined,
      reason: "TEST_TRANSACTION_IN_LIVE_MODE",
      reviewRequired: true,
    };
  }

  // 3. Authoritative record. The signature does not cover status, invoice or the test flag, so
  //    those come only from ePayco's own record, fetched by the signed `ref_payco`.
  const retry = (reason: string): EpaycoWebhookOutcome => ({
    status: 503, // not 200: ePayco retries, and nothing has been claimed or confirmed yet
    outcome: "RETRY",
    eventId: undefined,
    orderReference: bodyOrderReference || undefined,
    transactionId: refPayco,
    ticketsIssued: 0,
    orderStatus: undefined,
    reason,
    reviewRequired: false,
  });

  if (input.epayco === undefined) {
    logger.error("epayco webhook has no validation client; refusing to confirm", { refPayco });
    return retry("PROVIDER_CLIENT_UNAVAILABLE");
  }

  let record: EpaycoTransactionData;
  try {
    record = await input.epayco.getTransaction(refPayco);
  } catch (error) {
    const notFound = error instanceof EpaycoApiError && error.httpStatus === 404;
    logger.warn("epayco webhook could not read the transaction record", {
      refPayco,
      notFound,
      error: toAppError(error).code,
    });
    if (notFound) {
      // A delivery whose signature is valid but whose transaction ePayco says does not exist
      // is a contradiction, not an outage: keep retrying and never settle on it.
      return retry("PROVIDER_RECORD_NOT_FOUND");
    }
    // The lookup is an unauthenticated GET that is only TLS-protected and is not always
    // available; the delivery, by contrast, is signed with our `p_key`. ePayco documents the
    // signed confirmation as the authoritative channel, so an unavailable lookup must not
    // leave a legitimately signed approval unconfirmed. The amount, currency, reference and
    // transaction id still go through the same verification and `confirm_payment` re-checks
    // them against the order before anything is marked paid.
    const signedRecord = buildSignedDeliveryRecord({
      refPayco,
      transactionId,
      amountText: amountStr,
      currency,
      invoice: bodyInvoice,
      responseCode: payload.x_cod_response ?? payload.x_cod_transaction_state ?? "",
      responseText: payload.x_response ?? payload.x_respuesta ?? "",
      statusMessage: textOrNull(payload.x_response_reason_text),
      isTest: isTruthyFlag(payload.x_test_request),
      franchise: textOrNull(payload.x_franchise),
      approvalCode: textOrNull(payload.x_approval_code),
      transactionDate: textOrNull(payload.x_transaction_date ?? payload.x_fecha_transaccion),
      payload,
    });
    if (signedRecord === null) {
      return retry("PROVIDER_LOOKUP_FAILED");
    }
    logger.warn("epayco provider lookup unavailable; confirming from the signed delivery", {
      refPayco,
      orderReference: bodyOrderReference,
      error: toAppError(error).code,
    });
    record = signedRecord;
  }

  const problems = await verifyEpaycoRecord({
    record,
    requestedRefPayco: refPayco,
    credentials: { custIdCliente: config.epayco.custIdCliente, pKey: config.epayco.pKey },
    testMode: config.epayco.test,
    signed: { refPayco, transactionId, amountText: amountStr, currency, invoice: bodyInvoice },
  });
  const firstProblem = problems[0];
  if (firstProblem !== undefined) {
    logger.warn("epayco webhook delivery contradicts the provider record", {
      refPayco,
      problems: problems.join(","),
    });
    const mismatchDigest = await sha256Hex(`epayco:mismatch:${refPayco}:${problems.join(",")}`);
    try {
      await payments.recordWebhookRejection({
        dedupeKey: `rej:epayco:${mismatchDigest.slice(0, 32)}`,
        eventName: "epayco.confirmation",
        httpStatus: 200,
        errorCode: firstProblem,
        provider: "epayco",
      });
    } catch (e) {
      logger.error("failed to record webhook rejection", { error: toAppError(e).code });
    }
    await raiseAlertSafely(
      input.alerts,
      {
        kind: "PROVIDER_RECORD_MISMATCH",
        dedupeKey: `record-mismatch:${refPayco}:${firstProblem}`,
        orderReference: bodyOrderReference,
        provider: "epayco",
        detail: problems.join(","),
      },
      logger,
    );
    // 200: the record will not change into a consistent one by retrying the same delivery.
    return {
      status: 200,
      outcome: "REJECTED",
      eventId: undefined,
      orderReference: bodyOrderReference || undefined,
      transactionId: refPayco,
      ticketsIssued: 0,
      orderStatus: undefined,
      reason: firstProblem,
      reviewRequired: true,
    };
  }

  // 3b. The record may lag behind the delivery (still pending while the delivery reports a
  //     final state). Never apply the delivered status; ask ePayco to retry instead, so the
  //     final state is applied once the record shows it.
  const recordIsOpen = record.status === "pending" || record.status === "unknown";
  const deliveredStatus = epaycoStatusFromCode(codResponseStr);
  if (
    recordIsOpen &&
    deliveredStatus !== "pending" &&
    deliveredStatus !== "unknown" &&
    deliveredStatus !== record.status
  ) {
    logger.info("epayco record still open while the delivery reports a final state", {
      refPayco,
      recordStatus: record.status,
      deliveredStatus,
    });
    return retry("PROVIDER_STATUS_NOT_SETTLED");
  }

  const { orderReference, paymentReference } = resolveEpaycoReferences(record.invoice);

  // 4. Deduplication and idempotency claim, keyed on the record (never on unsigned fields), so a
  //    tampered redelivery of the same transaction state is a duplicate.
  const eventDigest = await sha256Hex(
    `epayco:${refPayco}:${record.transactionId}:${record.rawStatus}:${paymentReference}`,
  );
  const dedupeKey = `evt:epayco:${eventDigest.slice(0, 32)}`;

  const claim = await payments.claimWebhookEvent({
    dedupeKey,
    eventName: "epayco.confirmation",
    transactionId: refPayco,
    checksumValid: true,
    provider: "epayco",
  });

  if (!claim.claimed && claim.result !== null) {
    logger.info("epayco webhook duplicate delivery ignored", {
      orderReference,
      refPayco,
      eventId: claim.eventId,
      result: claim.result,
    });
    return {
      status: 200,
      outcome: "DUPLICATE",
      eventId: claim.eventId,
      orderReference,
      transactionId: refPayco,
      ticketsIssued: 0,
      orderStatus: undefined,
      reason: "ALREADY_PROCESSED",
      reviewRequired: false,
    };
  }

  // 5. Atomic confirmation in database, from the verified record only. `confirm_payment` still
  //    enforces reference, amount, currency and monotonic payment-state transitions.
  let confirmation;
  try {
    confirmation = await payments.confirmPayment({
      orderReference,
      wompiReference: paymentReference,
      wompiTransactionId: refPayco,
      wompiStatus: record.rawStatus,
      amountCents: record.amountInCents,
      currency: record.currency,
      paymentMethodType: record.paymentMethodType ?? undefined,
      statusMessage: record.statusMessage ?? (record.responseText || undefined),
      providerPayload: normalizeEpaycoPayload(record.rawPayload),
      provider: "epayco",
    });
  } catch (err) {
    const appError = toAppError(err);

    // Only the SQL function's own refusals (PT400/PT404/PT409 → VALIDATION_ERROR, NOT_FOUND,
    // CONFLICT) are permanent. Anything else — connection loss, timeouts, deadlocks, PostgREST
    // or platform failures — says nothing about the payment: the event stays unfinalized and the
    // answer is 503, so ePayco's redelivery re-runs `confirm_payment`. That re-run is safe:
    // the function is transactional and idempotent (a confirmation that committed before the
    // failure comes back as DUPLICATE; tickets are unique per order item unit).
    if (!PERMANENT_CONFIRMATION_ERRORS.has(appError.code)) {
      logger.error("epayco confirm_payment failed transiently; asking ePayco to retry", {
        orderReference,
        refPayco,
        code: appError.code,
      });
      return {
        status: 503,
        outcome: "RETRY",
        eventId: claim.eventId,
        orderReference,
        transactionId: refPayco,
        ticketsIssued: 0,
        orderStatus: undefined,
        reason: "CONFIRMATION_TEMPORARILY_FAILED",
        reviewRequired: false,
      };
    }

    logger.error("epayco confirm_payment rejected the payment", {
      orderReference,
      refPayco,
      code: appError.code,
    });

    if (claim.eventId) {
      await payments.finalizeWebhookEvent({
        eventId: claim.eventId,
        result: "REJECTED",
        httpStatus: 409,
        errorCode: appError.code,
        transactionId: refPayco,
      });
    }

    // The delivery was authentic and the verified record says approved, but the order could not
    // take the money (typically a second transaction under one merchant reference, or an amount
    // that no longer matches). The 200 below stops ePayco from retrying, so an operator has to
    // hear about it here or the capture exists only in the logs.
    const approvalConflictAlert = alertForApprovalConflict({
      code: appError.code,
      orderReference,
      transactionId: record.transactionId,
      paymentStatus: record.status,
      eventId: claim.eventId,
      refusalReason:
        typeof appError.context.detail === "string" ? appError.context.detail : undefined,
    });
    if (approvalConflictAlert !== undefined) {
      await raiseAlertSafely(input.alerts, approvalConflictAlert, logger);
    }

    return {
      status: 200, // 200 so ePayco does not loop-retry business conflicts
      outcome: "REJECTED",
      eventId: claim.eventId,
      orderReference,
      transactionId: refPayco,
      ticketsIssued: 0,
      orderStatus: undefined,
      reason: appError.code,
      reviewRequired: true,
    };
  }

  // Late approval or reversal after approval: a human must look at it (H8).
  const confirmationAlert = alertForConfirmation({
    result: confirmation.result,
    reason: confirmation.reason,
    orderReference: confirmation.orderReference,
    paymentId: confirmation.paymentId,
    provider: "epayco",
  });
  if (confirmationAlert !== undefined) {
    await raiseAlertSafely(input.alerts, confirmationAlert, logger);
  }

  // 6. Tickets are discontinued: no ticket-confirmation email is queued here. The welcome
  //    email is deferred until its HTML design is provided. Buyer data reaches Google Sheets
  //    through the participant projection enqueued by `confirm_payment` on the PAID transition.

  // 7. Finalize webhook event in ledger
  // RECONCILIATION_REQUIRED (late approval, reversal after approval) WAS recorded by
  // `confirm_payment`, so the ledger says APPLIED and keeps the reason as its error code for the
  // audit trail; the outcome below still asks for review.
  const needsReview = confirmation.result === "RECONCILIATION_REQUIRED";
  const outcomeResult =
    confirmation.result === "APPLIED" || confirmation.result === "DUPLICATE"
      ? confirmation.result
      : needsReview
        ? "APPLIED"
        : "REJECTED";

  if (claim.eventId) {
    await payments.finalizeWebhookEvent({
      eventId: claim.eventId,
      result: outcomeResult,
      httpStatus: 200,
      paymentId: confirmation.paymentId,
      transactionId: refPayco,
      ...(needsReview ? { errorCode: confirmation.reason } : {}),
    });
  }

  logger.info("epayco webhook processed successfully", {
    orderReference,
    refPayco,
    result: confirmation.result,
    ticketsIssued: confirmation.ticketsIssued,
  });

  return {
    status: 200,
    outcome: confirmation.result as EpaycoWebhookOutcome["outcome"],
    eventId: claim.eventId,
    orderReference,
    transactionId: refPayco,
    ticketsIssued: confirmation.ticketsIssued,
    orderStatus: confirmation.orderStatus,
    reason: confirmation.reason,
    reviewRequired: confirmation.reconciliationRequired,
  };
}
