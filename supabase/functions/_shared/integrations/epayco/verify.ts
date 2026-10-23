/**
 * Verification of an ePayco transaction record read from the validation API.
 *
 * ePayco's signature covers ONLY `x_ref_payco`, `x_transaction_id`, `x_amount` and
 * `x_currency_code` (plus the merchant's `p_cust_id_cliente`/`p_key`). Status, invoice and the
 * test flag are not signed, so a confirmation is never decided from a delivered payload: the
 * record fetched by `ref_payco` over TLS is the authority for those fields, and this module
 * checks that the record is consistent with whatever WAS signed.
 *
 * Merchant identity:
 *   - Webhook: the delivery signature (verified with our `p_key`) binds the signed fields to this
 *     merchant; a record whose signed fields match it is therefore ours.
 *   - Payment hint: nothing is signed, so the record itself must prove the merchant, either by
 *     `x_cust_id_cliente` or by an `x_signature` that recomputes with our credentials.
 *   - Reconciliation: the `ref_payco` comes from our own payment row, written only after a
 *     verified delivery, so it is trusted like a signed one (`referenceIsTrusted`).
 */

import { epaycoStatusFromResponseCode, parseEpaycoAmountToCents } from "./client.ts";
import { computeEpaycoSignature } from "./signature.ts";
import type { EpaycoTransactionData, EpaycoTransactionStatus } from "./types.ts";

export type EpaycoRecordProblem =
  | "REF_PAYCO_MISMATCH"
  | "TRANSACTION_ID_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISSING"
  | "CURRENCY_MISMATCH"
  | "INVOICE_MISSING"
  | "INVOICE_MISMATCH"
  | "MERCHANT_MISMATCH"
  | "MERCHANT_UNVERIFIED"
  | "TEST_TRANSACTION_IN_LIVE_MODE";

/** Fields of a webhook delivery whose signature was already verified. */
export type SignedEpaycoFields = {
  readonly refPayco: string;
  readonly transactionId: string;
  readonly amountText: string;
  readonly currency: string;
  /** Unsigned; only used to detect a contradiction with the record. */
  readonly invoice: string;
};

export type VerifyEpaycoRecordInput = {
  readonly record: EpaycoTransactionData;
  readonly requestedRefPayco: string;
  readonly credentials: { readonly custIdCliente: string; readonly pKey: string };
  /** `config.epayco.test`; only `true` admits sandbox transactions. */
  readonly testMode: boolean;
  /** Present for webhook deliveries; absent for payment hints and reconciliation. */
  readonly signed?: SignedEpaycoFields | undefined;
  /**
   * True when `requestedRefPayco` comes from our own payment row, recorded only after a
   * signed delivery was verified (reconciliation). The reference itself is then proof of
   * merchant, as in the webhook; a record that names another merchant is still rejected.
   */
  readonly referenceIsTrusted?: boolean | undefined;
};

type MerchantEvidence = "verified" | "contradicted" | "unknown";

async function merchantEvidence(input: VerifyEpaycoRecordInput): Promise<MerchantEvidence> {
  const { record, credentials } = input;
  const ourCustId = credentials.custIdCliente.trim();
  if (record.custIdCliente !== null) {
    return record.custIdCliente === ourCustId ? "verified" : "contradicted";
  }
  if (/^[0-9a-fA-F]{64}$/.test(record.signature)) {
    const expected = await computeEpaycoSignature({
      custIdCliente: ourCustId,
      pKey: credentials.pKey,
      refPayco: record.responseRefPayco ?? input.requestedRefPayco,
      transactionId: record.transactionId,
      amount: record.amountText,
      currency: record.currency,
    });
    // A non-matching record signature is not proof of another merchant: the validation API's
    // signature formula is not documented. It only counts as positive evidence.
    if (expected === record.signature.toLowerCase()) {
      return "verified";
    }
  }
  return "unknown";
}

/** Returns every inconsistency found; an empty list means the record can be trusted. */
export async function verifyEpaycoRecord(
  input: VerifyEpaycoRecordInput,
): Promise<readonly EpaycoRecordProblem[]> {
  const { record, signed } = input;
  const problems: EpaycoRecordProblem[] = [];
  const requested = input.requestedRefPayco.trim();

  if (record.responseRefPayco !== null && record.responseRefPayco !== requested) {
    problems.push("REF_PAYCO_MISMATCH");
  }
  if (record.currency.length === 0) {
    problems.push("CURRENCY_MISSING");
  }
  if (record.invoice.trim().length === 0) {
    problems.push("INVOICE_MISSING");
  }

  if (signed !== undefined) {
    if (
      signed.transactionId.trim().length > 0 &&
      record.transactionId.length > 0 &&
      signed.transactionId.trim() !== record.transactionId
    ) {
      problems.push("TRANSACTION_ID_MISMATCH");
    }
    if (parseEpaycoAmountToCents(signed.amountText) !== record.amountInCents) {
      problems.push("AMOUNT_MISMATCH");
    }
    if (record.currency.length > 0 && signed.currency.trim().toUpperCase() !== record.currency) {
      problems.push("CURRENCY_MISMATCH");
    }
    if (
      signed.invoice.trim().length > 0 &&
      record.invoice.trim().length > 0 &&
      signed.invoice.trim() !== record.invoice.trim()
    ) {
      problems.push("INVOICE_MISMATCH");
    }
  }

  const merchant = await merchantEvidence(input);
  if (merchant === "contradicted") {
    problems.push("MERCHANT_MISMATCH");
  } else if (merchant === "unknown" && signed === undefined && input.referenceIsTrusted !== true) {
    problems.push("MERCHANT_UNVERIFIED");
  }

  if (record.isTest && !input.testMode) {
    problems.push("TEST_TRANSACTION_IN_LIVE_MODE");
  }

  return problems;
}

/** Normalized status of a raw ePayco response code (same mapping as the validation client). */
export function epaycoStatusFromCode(code: string): EpaycoTransactionStatus {
  const trimmed = code.trim();
  return /^[0-9]{1,3}$/.test(trimmed) ? epaycoStatusFromResponseCode(Number(trimmed)) : "unknown";
}
