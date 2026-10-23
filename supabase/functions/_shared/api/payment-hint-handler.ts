/**
 * Payment-hint endpoint: the buyer returns the transaction id Wompi put in the redirect.
 *
 *   POST /orders/{reference}/payment-hint   { transactionId }
 *
 * WHY THIS EXISTS
 * Wompi cannot be queried by reference (verified in the docs, 2026-10-03): the only lookup
 * is `GET /v1/transactions/{id}` with the private key. When a webhook is lost, the automatic
 * sweep can only recover attempts that already recorded a transaction id. This endpoint is
 * the missing path for the other case: the buyer comes back from the checkout to
 * `https://<redirect-url>?id=01-...` and the frontend posts that id here.
 *
 * THE HINT IS NEVER TRUSTED
 * The id is only a pointer. The backend re-reads the transaction with the private key and
 * validates reference, amount and currency against the buyer's own payment before anything
 * happens; the confirmation is the SAME `public.confirm_payment` transaction the webhook
 * uses. A buyer can therefore accelerate their own payment, but cannot fabricate one.
 *
 * ACCESS MODEL
 * Reference + buyer email, exactly like the status and retry endpoints: an enumerable
 * reference alone proves nothing, and a wrong email is indistinguishable from an unknown
 * reference (`found:false`). Rate-limited per order reference.
 */

import { AppError, notFoundError, toAppError, validationError } from "../domain/errors.ts";
import { mapSweepOutcome, type ReconciliationResult } from "../domain/reconciliation.ts";
import {
  boundStatusMessage,
  isConfirmationResult,
  validateTransactionAgainstPayment,
} from "../domain/payment-confirmation.ts";
import { WOMPI_TRANSACTION_ID_PATTERN } from "../integrations/wompi/types.ts";
import { WompiApiError } from "../integrations/wompi/client.ts";
import { EpaycoApiError, type EpaycoClient } from "../integrations/epayco/client.ts";
import { verifyEpaycoRecord } from "../integrations/epayco/verify.ts";
import { buildProviderPayload } from "./payment-payload.ts";
import { normalizeLookupEmail } from "./order-status-handler.ts";
import type { WompiClient } from "../integrations/wompi/client.ts";
import type { BuyerPaymentLookup, PaymentGateway } from "../db/payments.ts";
import type { Json } from "../db/database.types.ts";
import type { PaymentProvider } from "../config/env.ts";
import type { Logger } from "../logging/logger.ts";

const REFERENCE_PATTERN = /^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]+)?$/;
const TRANSACTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TRANSACTION_ID_LENGTH = 64;

/** The three gateway capabilities the hint needs. */
export type PaymentHintGateway = Pick<
  PaymentGateway,
  "resolvePaymentForBuyer" | "confirmPayment" | "queueTicketEmails"
>;

/**
 * Outcome vocabulary: the reconciliation results plus `TRANSACTION_NOT_FOUND` for an id
 * Wompi does not know. One vocabulary everywhere means a log line, a database column and
 * an API response all read the same way.
 */
export type PaymentHintOutcome = ReconciliationResult | "TRANSACTION_NOT_FOUND";

export type PaymentHintResponse = {
  readonly orderReference: string;
  readonly orderStatus: string;
  readonly paymentStatus: string;
  readonly outcome: PaymentHintOutcome;
};

export type ParsedPaymentHintRequest = {
  readonly transactionId: string;
  readonly email: string | undefined;
};

/** Parses the hint body; unknown keys are ignored, the transaction id is strictly shaped. */
export function parsePaymentHintRequest(rawBody: unknown): ParsedPaymentHintRequest {
  if (typeof rawBody !== "object" || rawBody === null) {
    throw validationError("Request body must be a JSON object", {
      context: { surface: "payment-hint" },
    });
  }
  const body = rawBody as Record<string, unknown>;
  const transactionId = typeof body.transactionId === "string" ? body.transactionId.trim() : "";
  if (transactionId.length === 0) {
    throw validationError("transactionId is required", { context: { surface: "payment-hint" } });
  }
  if (
    transactionId.length > MAX_TRANSACTION_ID_LENGTH ||
    (!TRANSACTION_ID_PATTERN.test(transactionId) &&
      !WOMPI_TRANSACTION_ID_PATTERN.test(transactionId))
  ) {
    throw validationError("transactionId has an unexpected format", {
      context: { surface: "payment-hint" },
    });
  }
  const email =
    typeof body.email === "string" && body.email.trim().length > 0 ? body.email.trim() : undefined;
  return { transactionId, email };
}

function requireReference(reference: string): string {
  const trimmed = reference.trim();
  if (!REFERENCE_PATTERN.test(trimmed)) {
    throw validationError("Order reference has an unexpected format", {
      context: { surface: "payment-hint" },
    });
  }
  return trimmed;
}

function requireEmail(email: string): string {
  const normalized = normalizeLookupEmail(email);
  if (normalized.length === 0) {
    throw validationError("Buyer email is required to send a payment hint", {
      context: { surface: "payment-hint" },
    });
  }
  return normalized;
}

function lookupResponse(
  lookup: Extract<BuyerPaymentLookup, { found: true }>,
  outcome: PaymentHintOutcome,
): PaymentHintResponse {
  return {
    orderReference: lookup.orderReference,
    orderStatus: lookup.orderStatus,
    paymentStatus: lookup.paymentStatus,
    outcome,
  };
}

/**
 * `POST /orders/{reference}/payment-hint`.
 *
 * @throws {AppError} NOT_FOUND for an unknown reference or a wrong email (identical
 *   responses); UPSTREAM_ERROR when Wompi cannot be reached (the frontend may retry).
 */
export async function handlePaymentHint(input: {
  readonly reference: string;
  readonly email: string;
  readonly rawBody: unknown;
  readonly gateway: PaymentHintGateway;
  readonly wompi: WompiClient;
  readonly logger: Logger;
  readonly epayco?: EpaycoClient | undefined;
  readonly provider?: PaymentProvider | undefined;
  /**
   * `config.epayco.test`. Only `true` admits ePayco sandbox transactions; anything else is
   * live mode, so a missing value can never let a test payment settle a real order.
   */
  readonly epaycoTest?: boolean | undefined;
  /**
   * Merchant credentials (`config.epayco.custIdCliente` / `pKey`). A hint carries nothing signed,
   * so the record must prove it belongs to this merchant; without credentials it never can.
   */
  readonly epaycoCredentials?:
    { readonly custIdCliente: string; readonly pKey: string } | undefined;
}): Promise<PaymentHintResponse> {
  const reference = requireReference(input.reference);
  const parsed = parsePaymentHintRequest(input.rawBody);
  // The header wins because the body is optional for this endpoint.
  const email = requireEmail(input.email.length > 0 ? input.email : (parsed.email ?? ""));

  const lookup = await input.gateway.resolvePaymentForBuyer(reference, email);
  if (!lookup.found) {
    throw notFoundError("Order reference is unknown", { context: { surface: "payment-hint" } });
  }
  const found = lookup;

  // An attempt already attached to a DIFFERENT transaction cannot be handed another one.
  // The transaction id is the identity of a payment; a mismatch is a refusal, not a merge.
  const existingTxId = found.providerTransactionId ?? found.wompiTransactionId;
  if (existingTxId !== null && existingTxId !== parsed.transactionId) {
    input.logger.warn("payment hint does not match the recorded transaction", {
      reference,
      attempt: found.paymentAttempt,
    });
    return lookupResponse(found, "MISMATCH");
  }

  const isEpayco =
    input.provider === "epayco" ||
    found.paymentProvider === "epayco" ||
    (input.epayco !== undefined && input.provider !== "wompi" && found.paymentProvider !== "wompi");

  let transaction: {
    readonly id: string;
    readonly reference: string;
    readonly status: string;
    readonly rawStatus?: string | undefined;
    readonly amountInCents: number;
    readonly currency: string;
    readonly paymentMethodType?: string | undefined;
    readonly statusMessage?: string | undefined;
    readonly rawResponse?: unknown;
  };

  // H15: an ePayco attempt is only ever looked up at ePayco. Without an ePayco client it is
  // not sent to Wompi instead; the hint fails (the webhook and the sweep still apply).
  if (isEpayco && input.epayco === undefined) {
    input.logger.error("payment hint for an epayco attempt but no epayco client", { reference });
    throw new AppError("UPSTREAM_ERROR", "ePayco lookup is unavailable for the payment hint", {
      context: { surface: "payment-hint" },
    });
  }

  if (isEpayco && input.epayco) {
    try {
      const epaycoTx = await input.epayco.getTransaction(parsed.transactionId);
      // The buyer chooses the `ref_payco`, so the record must prove it is this merchant's
      // transaction (C1b), echo the requested reference, and not be a sandbox transaction while
      // the backend runs live (test and live share the merchant keys).
      const problems =
        input.epaycoCredentials === undefined
          ? (["MERCHANT_UNVERIFIED"] as const)
          : await verifyEpaycoRecord({
              record: epaycoTx,
              requestedRefPayco: parsed.transactionId,
              credentials: input.epaycoCredentials,
              testMode: input.epaycoTest === true,
            });
      if (problems.length > 0) {
        input.logger.warn("payment hint epayco record failed verification", {
          reference,
          paymentId: found.paymentId,
          problems: problems.join(","),
        });
        return lookupResponse(found, "MISMATCH");
      }
      transaction = {
        id: epaycoTx.id,
        reference: epaycoTx.reference,
        status: epaycoTx.status,
        rawStatus: epaycoTx.rawStatus,
        amountInCents: epaycoTx.amountInCents,
        currency: epaycoTx.currency,
        paymentMethodType: epaycoTx.paymentMethodType ?? undefined,
        statusMessage: epaycoTx.statusMessage ?? undefined,
        rawResponse: epaycoTx.rawResponse,
      };
    } catch (error) {
      if (error instanceof EpaycoApiError && error.httpStatus === 404) {
        input.logger.warn("payment hint referenced an unknown epayco transaction", {
          reference,
          transactionIdLength: parsed.transactionId.length,
        });
        return lookupResponse(found, "TRANSACTION_NOT_FOUND");
      }
      input.logger.error("payment hint epayco lookup failed", {
        reference,
        error: toAppError(error).code,
      });
      throw new AppError("UPSTREAM_ERROR", "ePayco lookup failed for the payment hint", {
        cause: error,
        context: { surface: "payment-hint" },
      });
    }
  } else {
    try {
      transaction = await input.wompi.getTransaction(parsed.transactionId);
    } catch (error) {
      if (error instanceof WompiApiError && error.httpStatus === 404) {
        input.logger.warn("payment hint referenced an unknown transaction", {
          reference,
          transactionIdLength: parsed.transactionId.length,
        });
        return lookupResponse(found, "TRANSACTION_NOT_FOUND");
      }
      input.logger.error("payment hint lookup failed", {
        reference,
        error: toAppError(error).code,
      });
      throw new AppError("UPSTREAM_ERROR", "Wompi lookup failed for the payment hint", {
        cause: error,
        context: { surface: "payment-hint" },
      });
    }
  }

  const problems = validateTransactionAgainstPayment({
    transaction: {
      id: transaction.id,
      reference: transaction.reference,
      status: transaction.status,
      amountInCents: transaction.amountInCents,
      currency: transaction.currency,
      paymentMethodType: transaction.paymentMethodType,
      statusMessage: transaction.statusMessage,
      customerEmail: undefined,
      createdAt: undefined,
      finalizedAt: undefined,
    },
    eventTransactionId: parsed.transactionId,
    eventReference: transaction.reference,
    payment: {
      wompiReference: found.wompiReference,
      wompiTransactionId: found.wompiTransactionId,
      amountCents: found.amountCents,
      currency: found.currency,
    },
    order: {
      totalInCents: found.orderTotalInCents,
      currency: found.orderCurrency,
    },
  });

  if (problems.length > 0) {
    input.logger.error("payment hint transaction does not match our record", {
      reference,
      paymentId: found.paymentId,
      problems,
    });
    return lookupResponse(found, "MISMATCH");
  }

  // The SAME confirmation transaction as the webhook and the sweep. If this succeeds, the
  // order and tickets are exactly as if the webhook had arrived.
  const confirmation = await input.gateway.confirmPayment({
    orderReference: found.orderReference,
    wompiReference: found.wompiReference,
    wompiTransactionId: transaction.id,
    wompiStatus:
      transaction.rawStatus !== undefined && transaction.rawStatus.length > 0
        ? transaction.rawStatus
        : transaction.status,
    amountCents: transaction.amountInCents,
    currency: transaction.currency,
    paymentMethodType: transaction.paymentMethodType,
    statusMessage: boundStatusMessage(transaction.statusMessage),
    providerPayload:
      (transaction.rawResponse as Json | undefined) ??
      buildProviderPayload(transaction as unknown as Parameters<typeof buildProviderPayload>[0]),
    // The provider whose API was actually queried above (H15).
    provider: isEpayco ? "epayco" : "wompi",
  });

  if (!isConfirmationResult(confirmation.result)) {
    throw new AppError("INTERNAL_ERROR", "confirmation returned an unknown result", {
      context: { result: confirmation.result },
    });
  }

  let emailsQueued = 0;
  if (confirmation.orderStatus === "PAID" && confirmation.ticketsExpected > 0) {
    const queued = await input.gateway.queueTicketEmails(confirmation.orderId);
    emailsQueued = queued.queued;
  }

  const outcome = mapSweepOutcome({
    providerStatus: transaction.status,
    confirmation: confirmation.result,
  });
  if (outcome === "UPSTREAM_ERROR" || outcome === "NOT_FOUND_AT_PROVIDER") {
    // Unreachable: both are produced only when no confirmation ran, and one ran here.
    throw new AppError("INTERNAL_ERROR", "payment hint produced an impossible outcome", {
      context: { outcome },
    });
  }

  input.logger.info("payment hint applied", {
    reference,
    attempt: confirmation.paymentAttempt,
    providerStatus: transaction.status,
    confirmationResult: confirmation.result,
    outcome,
    orderStatus: confirmation.orderStatus,
    ticketsIssued: confirmation.ticketsIssued,
    emailsQueued,
  });

  return {
    orderReference: confirmation.orderReference,
    orderStatus: confirmation.orderStatus,
    paymentStatus: confirmation.paymentStatus,
    outcome,
  };
}
