/**
 * `POST /orders/{reference}/retry` with ePayco as the active provider.
 *
 * The retry must open a NEW ePayco Smart Checkout session for the attempt reference the
 * database returned (`EVT-…-N`), never a Wompi payload, so the confirmation webhook can map
 * the payment back to the order.
 */

import { describe, expect, it, vi } from "vitest";

import { loadConfig, type BackendConfig } from "@shared/config/env.ts";
import { handlePaymentRetry } from "@shared/api/order-status-handler.ts";
import { createLogger } from "@shared/logging/logger.ts";
import type { EpaycoApifyClient } from "@shared/integrations/epayco/apify.ts";
import type { EpaycoCheckout } from "@shared/integrations/epayco/types.ts";
import type { OrderStatusGateway, PaymentGateway } from "@shared/db/payments.ts";

/** Fake credential assembled at runtime (see the secret-hygiene note in orders-handler.test.ts). */
function fakeCredential(prefix: string): string {
  return `${prefix}${"0123456789abcdefghijklmnop".slice(0, 24)}`;
}

function epaycoConfig(): BackendConfig {
  return loadConfig({
    APP_ENV: "development",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SECRET_KEY: fakeCredential("sb_secret_"),
    WOMPI_PUBLIC_KEY: fakeCredential("pub_test_"),
    WOMPI_PRIVATE_KEY: fakeCredential("prv_test_"),
    WOMPI_INTEGRITY_SECRET: fakeCredential("test_integrity_"),
    WOMPI_EVENTS_SECRET: fakeCredential("test_events_"),
    PUBLIC_WEB_BASE_URL: "http://localhost:3000",
    API_BASE_URL: "http://127.0.0.1:54321/functions/v1",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    ORDER_RESERVATION_MINUTES: "15",
    PAYMENT_PROVIDER: "epayco",
    EPAYCO_PUBLIC_KEY: fakeCredential("epayco_pub_"),
    EPAYCO_PRIVATE_KEY: fakeCredential("epayco_prv_"),
    EPAYCO_P_KEY: fakeCredential("epayco_pkey_"),
    EPAYCO_CUST_ID_CLIENTE: "123456",
    EPAYCO_TEST: "true",
  });
}

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

describe("payment retry with ePayco", () => {
  it("creates an ePayco session for the new attempt reference", async () => {
    const orderStatus = {
      getOrderStatus: vi.fn().mockResolvedValue({ found: true, reference: "EVT-2026-000007" }),
    } as unknown as OrderStatusGateway;
    const payments = {
      retryPayment: vi.fn().mockResolvedValue({
        orderId: "order-1",
        reference: "EVT-2026-000007",
        status: "PENDING",
        paymentAttempt: 2,
        wompiReference: "EVT-2026-000007-2",
        totalInCents: 1_000_000,
        currency: "COP",
        reservationExpiresAt: "2026-10-23T00:15:00.000Z",
      }),
    } as unknown as PaymentGateway;
    const apify: EpaycoApifyClient = {
      login: vi.fn(),
      createSession: vi.fn().mockResolvedValue({ sessionId: "sess_retry_2" }),
    };

    const result = await handlePaymentRetry({
      reference: "EVT-2026-000007",
      email: "buyer@example.com",
      payments,
      orderStatus,
      config: epaycoConfig(),
      logger,
      clientIp: "203.0.113.10",
      epaycoApify: apify,
    });

    const checkout = result.checkout as EpaycoCheckout;
    expect(checkout.provider).toBe("epayco");
    expect(checkout.sessionId).toBe("sess_retry_2");
    expect(checkout.reference).toBe("EVT-2026-000007-2");
    expect(apify.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: "EVT-2026-000007-2",
        amount: 10_000,
        ip: "203.0.113.10",
      }),
    );
  });
});
