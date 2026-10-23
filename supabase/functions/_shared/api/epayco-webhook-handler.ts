/**
 * ePayco Webhook / Confirmation Handler (runtime-agnostic).
 *
 * Sequence:
 *   1. Parse incoming body (handles JSON and URL-encoded key-value pairs).
 *   2. Authenticate the delivery using the documented ePayco signature:
 *        SHA-256(p_cust_id_cliente ^ p_key ^ x_ref_payco ^ x_transaction_id ^ x_amount ^ x_currency_code)
 *   3. Generate stable deduplication key and claim the event in the ledger (`payment_events`).
 *   4. Check idempotency: redeliveries of already finalized events return 200 without reprocessing.
 *   5. Perform server-side validation against order reference, amount and currency.
 *   6. Atomically confirm payment via `confirm_payment` in PostgreSQL.
 *   7. Queue ticket confirmation emails if paid.
 *   8. Finalize the event ledger row with the recorded outcome.
 */

import { verifyEpaycoSignature } from "../integrations/epayco/signature.ts";
import type { EpaycoClient } from "../integrations/epayco/client.ts";
import type { PaymentGateway } from "../db/payments.ts";
import type { BackendConfig } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";
import { toAppError } from "../domain/errors.ts";

export type EpaycoWebhookOutcome = {
  readonly status: number;
  readonly outcome:
    "APPLIED" | "DUPLICATE" | "IGNORED" | "RECONCILIATION_REQUIRED" | "REJECTED" | "RETRY";
  readonly eventId: string | undefined;
  readonly orderReference: string | undefined;
  readonly transactionId: string | undefined;
  readonly ticketsIssued: number;
  readonly reason: string;
  readonly reviewRequired: boolean;
};

export type HandleEpaycoWebhookInput = {
  readonly rawBody: unknown;
  readonly config: BackendConfig;
  readonly logger: Logger;
  readonly payments: PaymentGateway;
  readonly epayco?: EpaycoClient | undefined;
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

function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && ["true", "1", "yes"].includes(value.trim().toLowerCase());
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
  const invoice = payload.x_id_invoice ?? payload.x_id_factura ?? payload.invoice ?? "";
  const { orderReference, paymentReference } = resolveEpaycoReferences(invoice);
  const codResponseStr = payload.x_cod_response ?? payload.x_cod_transaction_state ?? "";
  const statusMessage = payload.x_response_reason_text ?? payload.x_response ?? undefined;
  const paymentMethod = payload.x_franchise ?? payload.x_payment_method ?? undefined;

  // 1. Basic payload shape check
  if (!refPayco || !signature || !orderReference) {
    logger.warn("epayco webhook payload missing required fields", {
      hasRefPayco: Boolean(refPayco),
      hasSignature: Boolean(signature),
      hasOrderReference: Boolean(orderReference),
    });
    return {
      status: 400,
      outcome: "REJECTED",
      eventId: undefined,
      orderReference: orderReference || undefined,
      transactionId: refPayco || undefined,
      ticketsIssued: 0,
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
      orderReference,
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
      orderReference,
      transactionId: refPayco,
      ticketsIssued: 0,
      reason: "SIGNATURE_MISMATCH",
      reviewRequired: true,
    };
  }

  // 2b. A sandbox transaction must never settle an order while the backend runs live.
  //     Test and live deliveries are signed with the same merchant keys, so the signature
  //     alone cannot tell them apart.
  if (isTruthyFlag(payload.x_test_request) && !config.epayco.test) {
    logger.warn("epayco test transaction received while live mode is active", {
      orderReference,
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
      orderReference,
      transactionId: refPayco,
      ticketsIssued: 0,
      reason: "TEST_TRANSACTION_IN_LIVE_MODE",
      reviewRequired: true,
    };
  }

  // 3. Deduplication and idempotency claim
  const eventDigest = await sha256Hex(
    `epayco:${refPayco}:${transactionId}:${codResponseStr}:${paymentReference}`,
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
      reason: "ALREADY_PROCESSED",
      reviewRequired: false,
    };
  }

  // 4. Amount parsing (ePayco sends pesos, database stores bigint centavos)
  const amountNumeric = Number(amountStr);
  if (Number.isNaN(amountNumeric) || amountNumeric < 0) {
    return {
      status: 400,
      outcome: "REJECTED",
      eventId: claim.eventId,
      orderReference,
      transactionId: refPayco,
      ticketsIssued: 0,
      reason: "INVALID_AMOUNT",
      reviewRequired: true,
    };
  }
  const amountInCents = Math.round(amountNumeric * 100);

  // 5. Atomic confirmation in database
  let confirmation;
  try {
    confirmation = await payments.confirmPayment({
      orderReference,
      wompiReference: paymentReference,
      wompiTransactionId: refPayco,
      wompiStatus: codResponseStr,
      amountCents: amountInCents,
      currency,
      paymentMethodType: paymentMethod,
      statusMessage,
      providerPayload: payload,
      provider: "epayco",
    });
  } catch (err) {
    const appError = toAppError(err);
    logger.error("epayco confirm_payment rejected or failed", {
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

    return {
      status: 200, // 200 so ePayco does not loop-retry business conflicts
      outcome: "REJECTED",
      eventId: claim.eventId,
      orderReference,
      transactionId: refPayco,
      ticketsIssued: 0,
      reason: appError.code,
      reviewRequired: true,
    };
  }

  // 6. Queue emails if paid
  if (confirmation.orderStatus === "PAID" && confirmation.ticketsExpected > 0) {
    try {
      await payments.queueTicketEmails(confirmation.orderId);
    } catch (e) {
      logger.error("failed to queue ticket emails after epayco confirmation", {
        orderId: confirmation.orderId,
        error: toAppError(e).code,
      });
    }
  }

  // 7. Finalize webhook event in ledger
  const outcomeResult =
    confirmation.result === "APPLIED" || confirmation.result === "DUPLICATE"
      ? confirmation.result
      : "REJECTED";

  if (claim.eventId) {
    await payments.finalizeWebhookEvent({
      eventId: claim.eventId,
      result: outcomeResult,
      httpStatus: 200,
      paymentId: confirmation.paymentId,
      transactionId: refPayco,
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
    reason: confirmation.reason,
    reviewRequired: confirmation.reconciliationRequired,
  };
}
