import { describe, expect, it } from "vitest";
import { buildSignedDeliveryRecord } from "@shared/integrations/epayco/verify.ts";

const DELIVERY = {
  refPayco: "390987456",
  transactionId: "tx-390987456",
  amountText: "400000",
  currency: "cop",
  invoice: "EVT-2026-000007",
  responseCode: "1",
  responseText: "Aceptada",
  statusMessage: "Aprobada",
  isTest: true,
  franchise: "VISA",
  approvalCode: "000000",
  transactionDate: "2026-10-24 10:45 AM",
  payload: {
    x_ref_payco: "390987456",
    x_transaction_id: "tx-390987456",
    x_amount: "400000",
    x_currency_code: "COP",
    x_id_invoice: "EVT-2026-000007",
    x_cod_response: "1",
  },
};

describe("buildSignedDeliveryRecord", () => {
  it("reproduces the record shape from the signed fields", () => {
    const record = buildSignedDeliveryRecord(DELIVERY);

    expect(record).not.toBeNull();
    expect(record?.refPayco).toBe("390987456");
    expect(record?.invoice).toBe("EVT-2026-000007");
    expect(record?.transactionId).toBe("tx-390987456");
    expect(record?.status).toBe("approved");
    expect(record?.rawStatus).toBe("1");
    expect(record?.amountInCents).toBe(40_000_000);
    expect(record?.amount).toBe(400_000);
    // Normalized: ePayco may deliver the currency in lower case.
    expect(record?.currency).toBe("COP");
    expect(record?.isTest).toBe(true);
    expect(record?.franchise).toBe("VISA");
    expect(record?.paymentMethodType).toBe("VISA");
    // No merchant id and no per-transaction signature exist in a delivery.
    expect(record?.custIdCliente).toBeNull();
    expect(record?.signature).toBe("");
    expect(record?.rawResponse).toMatchObject({ source: "signed-confirmation-delivery" });
  });

  it.each([
    ["1", "approved"],
    ["2", "declined"],
    ["3", "pending"],
    ["4", "error"],
    ["6", "voided"],
    ["7", "pending"],
    ["8", "pending"],
    ["9", "declined"],
    ["10", "declined"],
    ["11", "declined"],
  ])("maps response code %s to %s", (code, status) => {
    const record = buildSignedDeliveryRecord({ ...DELIVERY, responseCode: code });
    expect(record?.status).toBe(status);
  });

  it("keeps numeric amounts exact, without floating point", () => {
    const record = buildSignedDeliveryRecord({ ...DELIVERY, amountText: "400000.55" });
    expect(record?.amountInCents).toBe(40_000_055);
  });

  it("refuses an amount that is not exact centavos", () => {
    expect(buildSignedDeliveryRecord({ ...DELIVERY, amountText: "400000.999" })).toBeNull();
    expect(buildSignedDeliveryRecord({ ...DELIVERY, amountText: "-400000" })).toBeNull();
    expect(buildSignedDeliveryRecord({ ...DELIVERY, amountText: "4e5" })).toBeNull();
    expect(buildSignedDeliveryRecord({ ...DELIVERY, amountText: "" })).toBeNull();
  });

  it("refuses a delivery without a reference or an invoice", () => {
    expect(buildSignedDeliveryRecord({ ...DELIVERY, refPayco: "  " })).toBeNull();
    expect(buildSignedDeliveryRecord({ ...DELIVERY, invoice: "" })).toBeNull();
  });

  it("reports an unreadable response code as unknown instead of guessing", () => {
    const record = buildSignedDeliveryRecord({ ...DELIVERY, responseCode: "aceptada" });
    expect(record?.status).toBe("unknown");
    expect(record?.responseCode).toBe(0);
  });
});
