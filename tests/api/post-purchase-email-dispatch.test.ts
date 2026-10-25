/**
 * Post-purchase email dispatcher.
 *
 * Everything here is provider-mocked: no email leaves the process, no order or delivery row is
 * created. The properties under test are the ones an operator depends on:
 *   - exactly one send per claimed delivery, to the order's buyer email, with the derived
 *     Resend idempotency key;
 *   - a retryable failure is recorded with its next attempt, a permanent one is cancelled;
 *   - a lost lease is never reported as sent (and never overwrites the newer claim);
 *   - a row the database refuses to build a context for is cancelled, not retried forever;
 *   - with EMAIL_ENABLED=false nothing is claimed or sent.
 */

import { describe, expect, it, vi } from "vitest";

import { loadConfig, type BackendConfig } from "@shared/config/env.ts";
import {
  dispatchPostPurchaseEmails,
  resolveEmailAssetsBaseUrl,
  ZERO_POST_PURCHASE_DISPATCH_SUMMARY,
} from "@shared/api/post-purchase-email-dispatch.ts";
import { createLogger } from "@shared/logging/logger.ts";
import type {
  ClaimedOrderEmail,
  PostPurchaseEmailGateway,
} from "@shared/db/post-purchase-emails.ts";
import type { PostPurchaseEmailContext } from "@shared/domain/post-purchase-email.ts";
import type { ResendClient, ResendSendResult } from "@shared/integrations/resend/client.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

function fakeCredential(prefix: string): string {
  return `${prefix}${"0123456789abcdefghijklmnop".slice(0, 24)}`;
}

function testConfig(overrides: Record<string, string> = {}): BackendConfig {
  return loadConfig({
    APP_ENV: "development",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SECRET_KEY: fakeCredential("sb_secret_"),
    PAYMENT_PROVIDER: "epayco",
    EPAYCO_PUBLIC_KEY: fakeCredential("epayco_pub_"),
    EPAYCO_PRIVATE_KEY: fakeCredential("epayco_prv_"),
    EPAYCO_P_KEY: fakeCredential("epayco_pkey_"),
    EPAYCO_CUST_ID_CLIENTE: "123456",
    EPAYCO_TEST: "true",
    WOMPI_PUBLIC_KEY: fakeCredential("pub_test_"),
    WOMPI_PRIVATE_KEY: fakeCredential("prv_test_"),
    WOMPI_INTEGRITY_SECRET: fakeCredential("test_integrity_"),
    WOMPI_EVENTS_SECRET: fakeCredential("test_events_"),
    PUBLIC_WEB_BASE_URL: "https://evento.example",
    API_BASE_URL: "http://127.0.0.1:54321/functions/v1",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    EMAIL_ENABLED: "true",
    RESEND_API_KEY: fakeCredential("re_"),
    EMAIL_FROM: "Re set <no-responder@evento.example>",
    ...overrides,
  });
}

const DELIVERY: ClaimedOrderEmail = {
  id: "11111111-1111-4111-8111-111111111111",
  orderId: "22222222-2222-4222-8222-222222222222",
  template: "POST_PURCHASE",
  recipientEmail: "ana@example.com",
  status: "SENDING",
  attemptCount: 1,
  claimToken: "33333333-3333-4333-8333-333333333333",
};

const CONTEXT: PostPurchaseEmailContext = {
  deliveryId: DELIVERY.id,
  template: "POST_PURCHASE",
  attemptCount: 1,
  recipientEmail: DELIVERY.recipientEmail,
  orderReference: "EVT-2026-000012",
  currency: "COP",
  totalInCents: 16_000_000,
  quantity: 1,
  registeredParticipants: 1,
  unitPriceInCents: 16_000_000,
  packageName: "Entrada general",
  pricingTierName: "Preventa",
  bundleCode: null,
  eventCode: "RESET-SUNSET-2026",
  eventName: "Re set Sunset — Vol. 1",
  eventStartsAt: "2026-11-15T18:00:00.000Z",
  eventTimezone: "America/Bogota",
  venueName: "Terraza del hotel GHL",
  venueAddress: null,
  city: "Montería",
  buyerFirstName: "Ana",
  buyerLastName: "Pérez",
  buyerDocumentLast4: "6789",
};

type GatewayDouble = {
  readonly gateway: PostPurchaseEmailGateway;
  readonly claim: ReturnType<typeof vi.fn>;
  readonly finish: ReturnType<typeof vi.fn>;
  readonly findContext: ReturnType<typeof vi.fn>;
};

function gatewayWith(
  options: {
    readonly claimed?: readonly ClaimedOrderEmail[];
    readonly context?: PostPurchaseEmailContext | undefined;
    readonly finishUpdated?: number;
  } = {},
): GatewayDouble {
  const claimed = options.claimed ?? [DELIVERY];
  const claim = vi.fn().mockResolvedValue(claimed);
  const finish = vi
    .fn()
    .mockImplementation((input: { readonly status: string }) =>
      Promise.resolve({ updatedCount: options.finishUpdated ?? 1, status: input.status }),
    );
  const findContext = vi.fn().mockResolvedValue("context" in options ? options.context : CONTEXT);
  return {
    gateway: { claim, finish, findContext },
    claim,
    finish,
    findContext,
  };
}

function resendWith(results: readonly ResendSendResult[]): {
  readonly resend: ResendClient;
  readonly send: ReturnType<typeof vi.fn>;
} {
  const queue = [...results];
  const send = vi
    .fn()
    .mockImplementation(() => Promise.resolve(queue.shift() ?? { ok: true, messageId: "re_1" }));
  return { resend: { send }, send };
}

describe("dispatchPostPurchaseEmails", () => {
  it("sends once, to the order's buyer email, with the derived idempotency key", async () => {
    const { gateway, finish, findContext } = gatewayWith();
    const { resend, send } = resendWith([{ ok: true, messageId: "re_msg_1" }]);

    const summary = await dispatchPostPurchaseEmails({
      config: testConfig(),
      logger,
      gateway,
      resend,
      limit: 10,
    });

    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0, abandoned: 0, skipped: 0 });
    expect(findContext).toHaveBeenCalledWith(DELIVERY.id);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      idempotencyKey: string;
      html: string;
      attachments?: unknown;
    };
    expect(message.to).toBe("ana@example.com");
    expect(message.subject).toBe("Tu entrada para Re set Sunset está lista");
    expect(message.idempotencyKey).toBe(`order:${DELIVERY.orderId}:POST_PURCHASE`);
    expect(message.html).toContain("https://evento.example/correo/img/encabezado.jpg");
    // No attachment is invented: the design's images are hosted at a public URL.
    expect(message.attachments).toBeUndefined();

    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: DELIVERY.id,
        claimToken: DELIVERY.claimToken,
        status: "SENT",
        providerMessageId: "re_msg_1",
      }),
    );
  });

  it("claims nothing and sends nothing when email is disabled", async () => {
    const { gateway, claim } = gatewayWith();
    const { resend, send } = resendWith([]);

    const summary = await dispatchPostPurchaseEmails({
      config: testConfig({ EMAIL_ENABLED: "false" }),
      logger,
      gateway,
      resend,
      limit: 10,
    });

    expect(summary).toEqual(ZERO_POST_PURCHASE_DISPATCH_SUMMARY);
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("records a retryable provider failure and schedules the next attempt", async () => {
    const { gateway, finish } = gatewayWith();
    const { resend } = resendWith([
      { ok: false, retryable: true, error: "provider returned HTTP 503", httpStatus: 503 },
    ]);

    const summary = await dispatchPostPurchaseEmails({
      config: testConfig(),
      logger,
      gateway,
      resend,
      limit: 10,
    });

    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1, abandoned: 0, skipped: 0 });
    const finished = finish.mock.calls[0]?.[0] as {
      status: string;
      nextAttemptAt?: string;
      error?: string;
    };
    expect(finished.status).toBe("FAILED");
    expect(finished.error).toBe("provider returned HTTP 503");
    expect(typeof finished.nextAttemptAt).toBe("string");
    expect(Date.parse(finished.nextAttemptAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("cancels a permanent provider failure instead of retrying it", async () => {
    const { gateway, finish } = gatewayWith();
    const { resend } = resendWith([
      { ok: false, retryable: false, error: "invalid recipient", httpStatus: 422 },
    ]);

    const summary = await dispatchPostPurchaseEmails({
      config: testConfig(),
      logger,
      gateway,
      resend,
      limit: 10,
    });

    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 0, abandoned: 1, skipped: 0 });
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED", error: "invalid recipient" }),
    );
  });

  it("keeps a local processing failure retryable", async () => {
    const { gateway, finish } = gatewayWith();
    const send = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const summary = await dispatchPostPurchaseEmails({
      config: testConfig(),
      logger,
      gateway,
      resend: { send },
      limit: 10,
    });

    expect(summary.failed).toBe(1);
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        error: "Local processing error",
        nextAttemptAt: expect.any(String) as unknown as string,
      }),
    );
  });

  it("never reports a send whose lease was taken over", async () => {
    const { gateway } = gatewayWith({ finishUpdated: 0 });
    const { resend } = resendWith([{ ok: true, messageId: "re_msg_2" }]);

    const summary = await dispatchPostPurchaseEmails({
      config: testConfig(),
      logger,
      gateway,
      resend,
      limit: 10,
    });

    // The provider accepted the message, but another worker owns the row now: this run must not
    // claim success (Resend's own idempotency key bounds the duplicate).
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(1);
  });

  it("cancels a delivery whose order context the database refuses", async () => {
    const { gateway, finish } = gatewayWith({ context: undefined });
    const { resend, send } = resendWith([]);
    const summary = await dispatchPostPurchaseEmails({
      config: testConfig(),
      logger,
      gateway,
      resend,
      limit: 10,
    });

    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 0, abandoned: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "CANCELLED",
        error: "Order is not payable for this email",
      }),
    );
  });

  it("leaves a delivery of an unknown template alone", async () => {
    const { gateway, finish, findContext } = gatewayWith({
      claimed: [{ ...DELIVERY, template: "SOMETHING_ELSE" }],
    });
    const { resend } = resendWith([]);

    const summary = await dispatchPostPurchaseEmails({
      config: testConfig(),
      logger,
      gateway,
      resend,
      limit: 10,
    });

    expect(summary.skipped).toBe(1);
    expect(findContext).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED", error: "Unsupported template" }),
    );
  });

  it("sends nothing on a later run when the queue is empty", async () => {
    const { gateway } = gatewayWith({ claimed: [] });
    const { resend, send } = resendWith([]);
    const summary = await dispatchPostPurchaseEmails({
      config: testConfig(),
      logger,
      gateway,
      resend,
      limit: 10,
    });

    expect(summary).toEqual(ZERO_POST_PURCHASE_DISPATCH_SUMMARY);
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves the assets directory from configuration, defaulting to the public site", () => {
    expect(resolveEmailAssetsBaseUrl(testConfig())).toBe("https://evento.example/correo/img");
    expect(
      resolveEmailAssetsBaseUrl(
        testConfig({ EMAIL_ASSETS_BASE_URL: "https://cdn.example/email-assets/" }),
      ),
    ).toBe("https://cdn.example/email-assets");
  });
});
