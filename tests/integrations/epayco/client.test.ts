import { describe, expect, it, vi } from "vitest";
import {
  createEpaycoClient,
  EpaycoApiError,
  epaycoStatusFromResponseCode,
  parseEpaycoAmountToCents,
} from "@shared/integrations/epayco/client.ts";
import { epaycoStatusFromCode } from "@shared/integrations/epayco/verify.ts";

describe("ePayco API client", () => {
  const BASE_URL = "https://secure.epayco.co/validation/v1/reference";

  it("fetches and normalizes an approved transaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            x_ref_payco: "123456",
            x_transaction_id: "tx-999",
            x_id_invoice: "EVT-2026-000001",
            x_amount: "95000",
            x_currency_code: "COP",
            x_cod_response: "1",
            x_response_reason_text: "Aprobada",
            x_franchise: "VISA",
            x_customer_email: "buyer@example.com",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const client = createEpaycoClient({
      baseUrl: BASE_URL,
      publicKey: "pub_123",
      privateKey: "prv_123",
      fetch: fetchMock,
    });

    const tx = await client.getTransaction("123456");

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/123456`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(tx.id).toBe("123456");
    expect(tx.transactionId).toBe("tx-999");
    expect(tx.reference).toBe("EVT-2026-000001");
    expect(tx.status).toBe("approved");
    expect(tx.rawStatus).toBe("1");
    expect(tx.amountInCents).toBe(9_500_000);
    expect(tx.currency).toBe("COP");
    expect(tx.paymentMethodType).toBe("VISA");
    expect(tx.statusMessage).toBe("Aprobada");
  });

  it("maps declined, pending and error status codes", async () => {
    const testCases: [string, string][] = [
      ["2", "declined"],
      ["3", "pending"],
      ["4", "error"],
      ["99", "unknown"],
    ];

    for (const [code, expectedStatus] of testCases) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              x_ref_payco: "987",
              x_transaction_id: "tx-000",
              x_id_invoice: "EVT-2026-000001",
              x_amount: "50000",
              x_currency_code: "COP",
              x_cod_response: code,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const client = createEpaycoClient({
        baseUrl: BASE_URL,
        publicKey: "pub_123",
        privateKey: "prv_123",
        fetch: fetchMock,
      });

      const tx = await client.getTransaction("987");
      expect(tx.status).toBe(expectedStatus);
    }
  });

  it("throws EpaycoApiError with httpStatus 404 when transaction is not found", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, data: null }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createEpaycoClient({
      baseUrl: BASE_URL,
      publicKey: "pub_123",
      privateKey: "prv_123",
      fetch: fetchMock,
    });

    await expect(client.getTransaction("unknown_ref")).rejects.toThrow(EpaycoApiError);
  });

  describe("authoritative record fields (C1)", () => {
    function clientFor(data: Record<string, unknown>) {
      return createEpaycoClient({
        baseUrl: BASE_URL,
        publicKey: "pub_123",
        privateKey: "prv_123",
        maxRetries: 0,
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ success: true, data }), { status: 200 }),
          ),
      });
    }
    const base = {
      x_ref_payco: "123456",
      x_transaction_id: "tx-999",
      x_id_invoice: "EVT-2026-000001",
      x_amount: "95000",
      x_currency_code: "COP",
      x_cod_response: "1",
    };

    it("exposes the echoed ref_payco, the exact amount text and the merchant id", async () => {
      const tx = await clientFor({
        ...base,
        x_amount: "95000.00",
        x_cust_id_cliente: 777,
      }).getTransaction("123456");
      expect(tx.responseRefPayco).toBe("123456");
      expect(tx.amountText).toBe("95000.00");
      expect(tx.amountInCents).toBe(9_500_000);
      expect(tx.custIdCliente).toBe("777");
    });

    it("reports absent optional fields as null instead of inventing them", async () => {
      const withoutRef: Record<string, unknown> = { ...base };
      delete withoutRef.x_ref_payco;
      const tx = await clientFor(withoutRef).getTransaction("123456");
      expect(tx.responseRefPayco).toBeNull();
      expect(tx.custIdCliente).toBeNull();
    });

    it("never defaults a missing currency to COP", async () => {
      const withoutCurrency: Record<string, unknown> = { ...base };
      delete withoutCurrency.x_currency_code;
      const tx = await clientFor(withoutCurrency).getTransaction("123456");
      expect(tx.currency).toBe("");
    });

    it.each(["", "abc", "-5", "1e3", "95000.005"])("rejects the amount %j", async (amount) => {
      await expect(
        clientFor({ ...base, x_amount: amount }).getTransaction("123456"),
      ).rejects.toThrow(EpaycoApiError);
    });
  });

  it.each([
    ["10000", 1_000_000],
    ["10000.5", 1_000_050],
    ["10000.05", 1_000_005],
    ["10000.00", 1_000_000],
    ["0", 0],
  ])("parses %s pesos to %i centavos exactly", (text, cents) => {
    expect(parseEpaycoAmountToCents(text)).toBe(cents);
  });

  it.each(["", " ", "1.", ".5", "1,000", "-1", "1e3", "1.234", "NaN"])(
    "refuses the malformed amount %j",
    (text) => {
      expect(parseEpaycoAmountToCents(text)).toBeNull();
    },
  );

  describe("ePayco states 6-11 (H7)", () => {
    const EXPECTED: [number, string][] = [
      [1, "approved"],
      [2, "declined"],
      [3, "pending"],
      [4, "error"],
      [5, "unknown"],
      [6, "voided"],
      [7, "pending"],
      [8, "pending"],
      [9, "declined"],
      [10, "declined"],
      [11, "declined"],
      [12, "unknown"],
      [0, "unknown"],
    ];

    it.each(EXPECTED)("maps response code %i to %s", (code, status) => {
      expect(epaycoStatusFromResponseCode(code)).toBe(status);
      // The webhook uses the textual form of the same code; both must agree.
      expect(epaycoStatusFromCode(String(code))).toBe(status);
    });

    it.each(["", "abc", "1.0", "-1", "1e1"])("treats the malformed code %j as unknown", (code) => {
      expect(epaycoStatusFromCode(code)).toBe("unknown");
    });

    it("normalizes a reversed record returned by the validation API", async () => {
      const client = createEpaycoClient({
        baseUrl: BASE_URL,
        publicKey: "pub_123",
        privateKey: "prv_123",
        maxRetries: 0,
        fetch: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                x_ref_payco: "123456",
                x_id_invoice: "EVT-2026-000001",
                x_amount: "95000",
                x_currency_code: "COP",
                x_cod_response: 6,
              },
            }),
            { status: 200 },
          ),
        ),
      });
      const tx = await client.getTransaction("123456");
      expect(tx.status).toBe("voided");
      expect(tx.rawStatus).toBe("6");
    });
  });
});
