/**
 * ePayco signature computation and verification (docs.epayco.co).
 *
 * Official formula:
 *   SHA-256(p_cust_id_cliente ^ p_key ^ x_ref_payco ^ x_transaction_id ^ x_amount ^ x_currency_code)
 *
 * Note on x_amount:
 * ePayco formats the amount in the signature as integer or decimal without thousands separators,
 * matching the exact string or numeric representation passed in x_amount.
 */

import { validationError } from "../../domain/errors.ts";

export type ComputeSignatureInput = {
  readonly custIdCliente: string;
  readonly pKey: string;
  readonly refPayco: string;
  readonly transactionId: string;
  readonly amount: string | number;
  readonly currency: string;
};

/**
 * Computes the official ePayco SHA-256 signature.
 */
export async function computeEpaycoSignature(input: ComputeSignatureInput): Promise<string> {
  const custId = input.custIdCliente.trim();
  const pKey = input.pKey.trim();
  const ref = input.refPayco.trim();
  const txId = input.transactionId.trim();
  const amountStr = String(input.amount).trim();
  const currency = input.currency.trim();

  if (custId.length === 0 || pKey.length === 0) {
    throw validationError("ePayco customer ID and p_key are required to compute signature", {
      context: { surface: "epayco-signature" },
    });
  }

  const raw = `${custId}^${pKey}^${ref}^${txId}^${amountStr}^${currency}`;
  const encoded = new TextEncoder().encode(raw);
  const digestBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(digestBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type VerifySignatureInput = {
  readonly payload: {
    readonly x_cust_id_cliente?: string | number | undefined;
    readonly p_cust_id_cliente?: string | number | undefined;
    readonly x_ref_payco: string;
    readonly x_transaction_id: string;
    readonly x_amount: string | number;
    readonly x_currency_code: string;
    readonly x_signature: string;
  };
  readonly credentials: {
    readonly custIdCliente: string;
    readonly pKey: string;
  };
};

/**
 * Verifies the authenticity of an incoming ePayco webhook or query response.
 */
export async function verifyEpaycoSignature(input: VerifySignatureInput): Promise<boolean> {
  const incomingSignature = input.payload.x_signature.trim().toLowerCase();
  if (incomingSignature.length !== 64) {
    return false;
  }

  // The customer ID used in the signature can be provided by credentials or checked against payload
  const custId = input.credentials.custIdCliente.trim();
  const pKey = input.credentials.pKey.trim();

  const payloadCustId =
    input.payload.x_cust_id_cliente !== undefined
      ? String(input.payload.x_cust_id_cliente).trim()
      : input.payload.p_cust_id_cliente !== undefined
        ? String(input.payload.p_cust_id_cliente).trim()
        : "";

  if (payloadCustId.length > 0 && payloadCustId !== custId) {
    return false;
  }

  const expectedSignature = await computeEpaycoSignature({
    custIdCliente: custId,
    pKey,
    refPayco: input.payload.x_ref_payco,
    transactionId: input.payload.x_transaction_id,
    amount: input.payload.x_amount,
    currency: input.payload.x_currency_code,
  });

  return expectedSignature.toLowerCase() === incomingSignature;
}
