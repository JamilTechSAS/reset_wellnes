/**
 * A confirmation delivery as the *record* the confirmation pipeline expects.
 *
 * ePayco's documented confirmation channel is the signed webhook: the delivery carries
 * `x_signature = SHA256(p_cust_id_cliente ^ p_key ^ x_ref_payco ^ x_transaction_id ^
 * x_amount ^ x_currency_code)`, computed with the merchant's own keys, and that signature is
 * what proves the delivery is ours. The validation API (`secure.epayco.co/validation/...`)
 * is an unauthenticated GET whose answer is only protected by TLS, and it is not always
 * available: on the 2026-10-24 staging run it answered `{"status":false,"message":"Error de
 * datos o conexión."}` for the merchant's approved transaction, its own historical reference
 * and a session id alike, so the lookup could never succeed for any value.
 *
 * When the lookup *works*, its record stays the preferred evidence (it can be asked again,
 * and `record.rawStatus` feeds deduplication). When it is *unavailable*, the delivery has
 * already been authenticated with our `p_key`, so this module reproduces the record from
 * exactly those signed fields. Callers must only reach it after the signature check passed;
 * a lookup that answers 404 (a signed delivery naming a transaction ePayco says does not
 * exist) is a contradiction, not an outage, and must keep failing.
 *
 * Nothing here weakens the amount/currency/reference checks: the values come from the same
 * signed fields the verifier compares against, and `confirm_payment` re-validates them
 * against the order before anything is marked paid.
 */

import { epaycoStatusFromResponseCode, parseEpaycoAmountToCents } from "./client.ts";
import type { EpaycoTransactionData } from "./types.ts";

export type SignedDeliveryFields = {
  /** `x_ref_payco` from the delivery; already covered by the verified signature. */
  readonly refPayco: string;
  readonly transactionId: string;
  /** `x_amount` exactly as delivered: the signature is computed over this text. */
  readonly amountText: string;
  readonly currency: string;
  readonly invoice: string;
  /** `x_cod_response` / `x_cod_response_state`: `1` approved, `2` rejected, `3` pending... */
  readonly responseCode: string;
  readonly responseText: string;
  readonly statusMessage: string | null;
  readonly isTest: boolean;
  readonly franchise: string | null;
  readonly approvalCode: string | null;
  readonly transactionDate: string | null;
  /** The normalized delivery, kept for audit purposes only (never re-parsed). */
  readonly payload: Record<string, string>;
};

/**
 * Builds the record for a signature-verified delivery, or `null` when the delivery cannot be
 * interpreted as a transaction (an amount that is not exact centavos, or no reference at all).
 * A `null` keeps the caller in its retry path instead of confirming something unreadable.
 */
export function buildSignedDeliveryRecord(
  delivery: SignedDeliveryFields,
): EpaycoTransactionData | null {
  const refPayco = delivery.refPayco.trim();
  const transactionId = delivery.transactionId.trim();
  const invoice = delivery.invoice.trim();
  if (refPayco.length === 0 || invoice.length === 0) {
    return null;
  }

  const amountInCents = parseEpaycoAmountToCents(delivery.amountText);
  if (amountInCents === null) {
    return null;
  }

  const currency = delivery.currency.trim().toUpperCase();
  const rawCode = delivery.responseCode.trim();
  const responseCode = /^[0-9]{1,3}$/.test(rawCode) ? Number(rawCode) : 0;

  return {
    id: refPayco,
    refPayco,
    responseRefPayco: refPayco,
    amountText: delivery.amountText,
    // The delivery names the merchant through the signature, not through this field; leaving
    // it null keeps `verifyEpaycoRecord` from inventing merchant evidence it does not have.
    custIdCliente: null,
    reference: invoice,
    invoice,
    transactionId,
    status: epaycoStatusFromResponseCode(responseCode),
    rawStatus: rawCode,
    amount: amountInCents / 100,
    amountInCents,
    currency,
    responseCode,
    responseText: delivery.responseText,
    statusMessage: delivery.statusMessage,
    paymentMethodType: delivery.franchise,
    // No per-transaction signature is present in a delivery, only the delivery signature.
    signature: "",
    isTest: delivery.isTest,
    franchise: delivery.franchise,
    bankName: null,
    transactionDate: delivery.transactionDate,
    rawPayload: delivery.payload,
    rawResponse: {
      success: true,
      source: "signed-confirmation-delivery",
      data: delivery.payload,
    },
  };
}
