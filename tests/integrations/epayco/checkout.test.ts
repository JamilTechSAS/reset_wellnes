import { describe, expect, it } from "vitest";
import { buildEpaycoCheckout } from "@shared/integrations/epayco/checkout.ts";

describe("ePayco checkout preparation", () => {
  it("builds a client-safe payload with no secrets", () => {
    const checkout = buildEpaycoCheckout({
      publicKey: "pub_test_12345",
      test: true,
      reference: "EVT-2026-000001",
      amountInCents: 9_500_000,
      currency: "COP",
      redirectUrl: "https://example.com/gracias",
      confirmationUrl: "https://api.example.com/webhooks-epayco",
      customerData: {
        email: "buyer@example.com",
        fullName: "Comprador Ejemplo",
        phoneNumber: "3001234567",
      },
    });

    expect(checkout.provider).toBe("epayco");
    expect(checkout.publicKey).toBe("pub_test_12345");
    expect(checkout.test).toBe(true);
    expect(checkout.reference).toBe("EVT-2026-000001");
    expect(checkout.amountInCents).toBe(9_500_000);
    expect(checkout.currency).toBe("COP");
    expect(checkout.redirectUrl).toBe("https://example.com/gracias");
    expect(checkout.confirmationUrl).toBe("https://api.example.com/webhooks-epayco");
    expect(checkout.customerData.email).toBe("buyer@example.com");

    const serialized = JSON.stringify(checkout);
    expect(serialized).not.toContain("p_key");
    expect(serialized).not.toContain("private_key");
    expect(serialized).not.toContain("secret");
  });

  it("refuses unsupported currency", () => {
    expect(() =>
      buildEpaycoCheckout({
        publicKey: "pub_test_12345",
        test: true,
        reference: "EVT-2026-000001",
        amountInCents: 9_500_000,
        currency: "USD",
      }),
    ).toThrow(/only supports COP/);
  });

  it("refuses non-positive amounts", () => {
    expect(() =>
      buildEpaycoCheckout({
        publicKey: "pub_test_12345",
        test: true,
        reference: "EVT-2026-000001",
        amountInCents: 0,
        currency: "COP",
      }),
    ).toThrow(/Amount must be greater than zero/);
  });

  it("includes sessionId when provided for Smart Checkout V2", () => {
    const checkout = buildEpaycoCheckout({
      sessionId: "session_12345",
      publicKey: "pub_test_12345",
      test: true,
      reference: "EVT-2026-000001",
      amountInCents: 9_500_000,
      currency: "COP",
    });

    expect(checkout.sessionId).toBe("session_12345");
  });
});
