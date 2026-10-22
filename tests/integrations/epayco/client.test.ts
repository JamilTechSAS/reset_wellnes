import { describe, expect, it, vi } from "vitest";
import { createEpaycoClient, EpaycoApiError } from "@shared/integrations/epayco/client.ts";

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
});
