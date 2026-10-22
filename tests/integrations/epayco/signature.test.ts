import { describe, expect, it } from "vitest";
import {
  computeEpaycoSignature,
  verifyEpaycoSignature,
} from "@shared/integrations/epayco/signature.ts";

describe("ePayco signature", () => {
  const credentials = {
    custIdCliente: "12345",
    pKey: "secret_pkey_abcdef",
  };

  it("computes the expected SHA-256 digest from the documented formula", async () => {
    // Formula: SHA-256("12345^secret_pkey_abcdef^987654^tx-112233^95000^COP")
    const expectedRaw = "12345^secret_pkey_abcdef^987654^tx-112233^95000^COP";
    const encoded = new TextEncoder().encode(expectedRaw);
    const buffer = await crypto.subtle.digest("SHA-256", encoded);
    const expectedHex = Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const signature = await computeEpaycoSignature({
      custIdCliente: credentials.custIdCliente,
      pKey: credentials.pKey,
      refPayco: "987654",
      transactionId: "tx-112233",
      amount: "95000",
      currency: "COP",
    });

    expect(signature).toBe(expectedHex);
    expect(signature).toHaveLength(64);
  });

  it("verifies a valid incoming signature", async () => {
    const signature = await computeEpaycoSignature({
      custIdCliente: credentials.custIdCliente,
      pKey: credentials.pKey,
      refPayco: "987654",
      transactionId: "tx-112233",
      amount: 95000,
      currency: "COP",
    });

    const isValid = await verifyEpaycoSignature({
      payload: {
        x_cust_id_cliente: "12345",
        x_ref_payco: "987654",
        x_transaction_id: "tx-112233",
        x_amount: 95000,
        x_currency_code: "COP",
        x_signature: signature,
      },
      credentials,
    });

    expect(isValid).toBe(true);
  });

  it("rejects a tampered amount or currency", async () => {
    const signature = await computeEpaycoSignature({
      custIdCliente: credentials.custIdCliente,
      pKey: credentials.pKey,
      refPayco: "987654",
      transactionId: "tx-112233",
      amount: 95000,
      currency: "COP",
    });

    const tamperedAmount = await verifyEpaycoSignature({
      payload: {
        x_cust_id_cliente: "12345",
        x_ref_payco: "987654",
        x_transaction_id: "tx-112233",
        x_amount: 50000, // tampered!
        x_currency_code: "COP",
        x_signature: signature,
      },
      credentials,
    });
    expect(tamperedAmount).toBe(false);

    const tamperedCurrency = await verifyEpaycoSignature({
      payload: {
        x_cust_id_cliente: "12345",
        x_ref_payco: "987654",
        x_transaction_id: "tx-112233",
        x_amount: 95000,
        x_currency_code: "USD", // tampered!
        x_signature: signature,
      },
      credentials,
    });
    expect(tamperedCurrency).toBe(false);
  });

  it("rejects mismatched customer ID", async () => {
    const signature = await computeEpaycoSignature({
      custIdCliente: "99999", // different customer id
      pKey: credentials.pKey,
      refPayco: "987654",
      transactionId: "tx-112233",
      amount: 95000,
      currency: "COP",
    });

    const isWrongCustomer = await verifyEpaycoSignature({
      payload: {
        x_cust_id_cliente: "99999",
        x_ref_payco: "987654",
        x_transaction_id: "tx-112233",
        x_amount: 95000,
        x_currency_code: "COP",
        x_signature: signature,
      },
      credentials, // expects 12345
    });

    expect(isWrongCustomer).toBe(false);
  });
});
