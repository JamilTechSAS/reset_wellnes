import { describe, expect, it, vi } from "vitest";

import { loadConfig, type BackendConfig } from "@shared/config/env.ts";
import {
  isMaintenanceAuthorized,
  runMaintenance,
  runMaintenanceSafely,
} from "@shared/api/maintenance-handler.ts";
import { createLogger } from "@shared/logging/logger.ts";
import type {
  OrderStatusGateway,
  PaymentGateway,
  ClaimWebhookEventResult,
  FinalizeWebhookEventResult,
  ConfirmPaymentResult,
  QueueTicketEmailsResult,
  ExpirePendingOrdersResult,
  RetryPaymentResult,
  FinishEmailDeliveryResult,
  EmailContext,
} from "@shared/db/payments.ts";
import type { SheetsGateway } from "@shared/db/sheets.ts";
import type { RateLimitGateway } from "@shared/db/rate-limits.ts";

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
    WOMPI_PUBLIC_KEY: fakeCredential("pub_test_"),
    WOMPI_PRIVATE_KEY: fakeCredential("prv_test_"),
    WOMPI_INTEGRITY_SECRET: fakeCredential("test_integrity_"),
    WOMPI_EVENTS_SECRET: fakeCredential("test_events_"),
    PUBLIC_WEB_BASE_URL: "http://localhost:3000",
    API_BASE_URL: "http://127.0.0.1:54321/functions/v1",
    CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    EMAIL_ENABLED: "false",
    ...overrides,
  });
}

const APPLIED: ConfirmPaymentResult = {
  result: "APPLIED",
  reason: "PAYMENT_APPROVED",
  orderId: "33333333-3333-4333-8333-333333333333",
  orderReference: "EVT-2026-000001",
  orderStatus: "PAID",
  paymentId: "22222222-2222-4222-8222-222222222222",
  paymentStatus: "approved",
  rawWompiStatus: "APPROVED",
  paymentAttempt: 1,
  wompiReference: "EVT-2026-000001",
  wompiTransactionId: "1292-1602113476-10985",
  amountInCents: 9_500_000,
  currency: "COP",
  ticketsIssued: 1,
  ticketsExpected: 1,
  reconciliationRequired: false,
};

function paymentsStub(overrides: Partial<PaymentGateway> = {}): {
  payments: PaymentGateway;
  expirePendingOrders: ReturnType<typeof vi.fn>;
} {
  const expirePendingOrders = vi.fn().mockResolvedValue({
    expiredCount: 0,
    releasedTiers: 0,
    references: [],
    ranAt: "x",
  } satisfies ExpirePendingOrdersResult);
  const payments: PaymentGateway = {
    findPaymentByReference: vi.fn().mockResolvedValue(undefined),
    findPaymentByTransactionId: vi.fn().mockResolvedValue(undefined),
    claimWebhookEvent: vi.fn<() => Promise<ClaimWebhookEventResult>>().mockResolvedValue({
      claimed: true,
      eventId: "e",
      result: null,
      processedAt: null,
      httpStatus: null,
    }),
    finalizeWebhookEvent: vi.fn<() => Promise<FinalizeWebhookEventResult>>().mockResolvedValue({
      finalized: true,
      eventId: "e",
      result: "APPLIED",
      processedAt: null,
    }),
    recordWebhookRejection: vi.fn().mockResolvedValue({ eventId: "e", recorded: true }),
    confirmPayment: vi.fn<() => Promise<ConfirmPaymentResult>>().mockResolvedValue(APPLIED),
    queueTicketEmails: vi.fn<() => Promise<QueueTicketEmailsResult>>().mockResolvedValue({
      queued: 0,
      alreadyQueued: 0,
      total: 0,
      template: "TICKET_CONFIRMATION",
    }),
    expirePendingOrders,
    retryPayment: vi
      .fn<() => Promise<RetryPaymentResult>>()
      .mockRejectedValue(new Error("not used")),
    claimEmailDeliveries: vi.fn().mockResolvedValue([]),
    finishEmailDelivery: vi
      .fn<() => Promise<FinishEmailDeliveryResult>>()
      .mockRejectedValue(new Error("not used")),
    claimPaymentReconciliations: vi.fn().mockResolvedValue([]),
    finishPaymentReconciliation: vi.fn().mockRejectedValue(new Error("not used")),
    resolvePaymentForBuyer: vi.fn().mockRejectedValue(new Error("not used")),
    ...overrides,
  };
  return { payments, expirePendingOrders };
}

function orderStatusStub(): OrderStatusGateway {
  return {
    getOrderStatus: vi.fn().mockResolvedValue({ found: false }),
    findEmailContext: vi
      .fn<(deliveryId: string) => Promise<EmailContext | undefined>>()
      .mockResolvedValue(undefined),
  };
}

function sheetsStub(): { sheets: SheetsGateway; claimProjections: ReturnType<typeof vi.fn> } {
  const claimProjections = vi.fn().mockResolvedValue([]);
  const sheets: SheetsGateway = {
    claimProjections,
    finishProjections: vi.fn().mockResolvedValue({ updatedCount: 0 }),
    stats: vi.fn().mockResolvedValue({
      queued: 0,
      syncing: 0,
      synced: 0,
      failed: 0,
      total: 0,
      lastSyncedAt: null,
      oldestPendingAt: null,
    }),
    listExportRows: vi.fn().mockResolvedValue([]),
  };
  return { sheets, claimProjections };
}

function rateLimitStub(): { rateLimits: RateLimitGateway; cleanup: ReturnType<typeof vi.fn> } {
  const cleanup = vi.fn().mockResolvedValue(3);
  return { rateLimits: { consume: vi.fn(), cleanup }, cleanup };
}

describe("maintenance authorization guard", () => {
  const TOKEN = fakeCredential("test_maintenance_");

  it("accepts only the exact configured token", () => {
    expect(isMaintenanceAuthorized(TOKEN, TOKEN)).toBe(true);
    expect(isMaintenanceAuthorized(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(isMaintenanceAuthorized(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(isMaintenanceAuthorized(TOKEN, TOKEN.toUpperCase())).toBe(false);
  });

  it("refuses a missing or empty configuration instead of opening the door", () => {
    expect(isMaintenanceAuthorized(undefined, TOKEN)).toBe(false);
    expect(isMaintenanceAuthorized("", TOKEN)).toBe(false);
  });

  it("refuses a missing or empty presented token", () => {
    expect(isMaintenanceAuthorized(TOKEN, undefined)).toBe(false);
    expect(isMaintenanceAuthorized(TOKEN, "")).toBe(false);
  });
});

describe("maintenance orchestration", () => {
  it("runs every documented job and reports each outcome", async () => {
    const { payments, expirePendingOrders } = paymentsStub();
    const { sheets, claimProjections } = sheetsStub();
    const { rateLimits, cleanup } = rateLimitStub();

    const result = await runMaintenance({
      config: testConfig(),
      logger,
      payments,
      orderStatus: orderStatusStub(),
      resend: undefined,
      wompi: { getTransaction: vi.fn() },
      sheets,
      sheetsClient: undefined,
      rateLimits,
    });

    expect(expirePendingOrders).toHaveBeenCalledWith(100);
    expect(result.expiredOrders.expiredCount).toBe(0);
    expect(result.emails.claimed).toBe(0);
    expect(result.reconciliation.claimed).toBe(0);
    expect(result.sheetProjections.skipped).toBe(true);
    expect(result.jobErrors).toEqual([]);
    expect(cleanup).toHaveBeenCalledWith(7200);
    expect(result.rateLimitCountersDeleted).toBe(3);
    // Nothing is due, so the Sheets worker never even claims.
    expect(claimProjections).not.toHaveBeenCalled();
  });

  it("contains a reconciliation failure without stopping the other jobs", async () => {
    const { payments } = paymentsStub({
      claimPaymentReconciliations: vi.fn().mockRejectedValue(new Error("claims unavailable")),
    });
    const { sheets } = sheetsStub();
    const { rateLimits, cleanup } = rateLimitStub();

    const result = await runMaintenance({
      config: testConfig(),
      logger,
      payments,
      orderStatus: orderStatusStub(),
      resend: undefined,
      wompi: { getTransaction: vi.fn() },
      sheets,
      sheetsClient: undefined,
      rateLimits,
    });

    expect(result.jobErrors).toEqual(["reconciliation"]);
    expect(result.reconciliation.claimed).toBe(0);
    // Cleanup still ran after the failed job.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("contains a Google failure so a third-party outage is only a job error", async () => {
    const { payments } = paymentsStub();
    const { sheets, claimProjections } = sheetsStub();
    claimProjections.mockRejectedValue(new Error("database error"));
    const { rateLimits } = rateLimitStub();
    const sheetsClient = {
      writeRanges: vi.fn().mockResolvedValue({ ok: true, updatedRanges: 1, updatedCells: 1 }),
    };

    const result = await runMaintenance({
      config: testConfig(),
      logger,
      payments,
      orderStatus: orderStatusStub(),
      resend: undefined,
      wompi: { getTransaction: vi.fn() },
      sheets,
      sheetsClient,
      rateLimits,
    });

    expect(result.jobErrors).toEqual(["sheet-projections"]);
    expect(result.reconciliation.claimed).toBe(0);
  });

  it("reports a critical job failure as an overall failure", async () => {
    const { payments } = paymentsStub({
      expirePendingOrders: vi.fn().mockRejectedValue(new Error("orders table unavailable")),
    });
    const { sheets } = sheetsStub();
    const { rateLimits } = rateLimitStub();

    const outcome = await runMaintenanceSafely({
      config: testConfig(),
      logger,
      payments,
      orderStatus: orderStatusStub(),
      resend: undefined,
      wompi: { getTransaction: vi.fn() },
      sheets,
      sheetsClient: undefined,
      rateLimits,
    });
    expect(outcome.ok).toBe(false);
  });
});
