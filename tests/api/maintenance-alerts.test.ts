/**
 * H8 integration: operational alerts through the real maintenance run (`runMaintenance`) and
 * the real reconciliation sweep, with an in-memory alert ledger that follows the SQL contract
 * of migration 20261023150000 (dedupe by key, claim with 5/10/20.. min backoff and an attempt
 * cap, finish marks notified). The SQL itself is covered by tests/schema/operational-alerts.
 */

import { describe, expect, it, vi } from "vitest";

import { loadConfig, type BackendConfig } from "@shared/config/env.ts";
import { runMaintenance } from "@shared/api/maintenance-handler.ts";
import type { AlertGateway } from "@shared/db/alerts.ts";
import type { AlertInput, ClaimedAlert } from "@shared/domain/alerts.ts";
import { ALERT_SEVERITY } from "@shared/domain/alerts.ts";
import type {
  ClaimedReconciliation,
  ConfirmPaymentResult,
  OrderStatusGateway,
  PaymentGateway,
} from "@shared/db/payments.ts";
import type { EpaycoClient } from "@shared/integrations/epayco/client.ts";
import type { EpaycoTransactionData } from "@shared/integrations/epayco/types.ts";
import type { ResendClient } from "@shared/integrations/resend/client.ts";
import type { SheetsGateway } from "@shared/db/sheets.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_REF = "EVT-2026-000007";
const REF_PAYCO = "987654321";

function fakeCredential(prefix: string): string {
  return `${prefix}${"0123456789abcdefghijklmnop".slice(0, 24)}`;
}

function config(overrides: Record<string, string> = {}): BackendConfig {
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
    EMAIL_ENABLED: "true",
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM: "Boleteria <no-responder@example.com>",
    ALERT_EMAIL_TO: "ops@example.com",
    ...overrides,
  });
}

/** In-memory ledger with the SQL contract of `operational_alerts`. */
function memoryLedger(options: { unresolvedPaymentIds?: () => readonly string[] } = {}) {
  type Row = AlertInput & {
    alertId: string;
    occurrences: number;
    notified: boolean;
    attempts: number;
    nextNotifyAt: number;
  };
  const clock = { now: Date.parse("2026-10-23T12:00:00Z") };
  const rows = new Map<string, Row>();
  let sequence = 0;

  const insert = (alert: AlertInput) => {
    const existing = rows.get(alert.dedupeKey);
    if (existing !== undefined) {
      existing.occurrences += 1;
      return { created: false, occurrences: existing.occurrences };
    }
    sequence += 1;
    rows.set(alert.dedupeKey, {
      ...alert,
      alertId: `alert-${String(sequence)}`,
      occurrences: 1,
      notified: false,
      attempts: 0,
      nextNotifyAt: clock.now,
    });
    return { created: true, occurrences: 1 };
  };

  const gateway: AlertGateway = {
    recordAlert: vi.fn(async (alert: AlertInput) => insert(alert)),
    raiseUnresolvedPaymentAlerts: vi.fn(async () => {
      let created = 0;
      for (const paymentId of options.unresolvedPaymentIds?.() ?? []) {
        if (!rows.has(`unresolved:${paymentId}`)) {
          insert({
            kind: "UNRESOLVED_PAYMENT",
            dedupeKey: `unresolved:${paymentId}`,
            paymentId,
            orderReference: ORDER_REF,
            detail: "status pending, attempts 8",
          });
          created += 1;
        }
      }
      return created;
    }),
    claimAlertNotifications: vi.fn(async (limit: number, maxAttempts: number) => {
      const due = [...rows.values()]
        .filter(
          (row) => !row.notified && row.nextNotifyAt <= clock.now && row.attempts < maxAttempts,
        )
        .slice(0, limit);
      return due.map((row): ClaimedAlert => {
        // Same backoff as the SQL: 5 * 2^(attempts before this claim) minutes.
        row.nextNotifyAt = clock.now + 5 * 2 ** row.attempts * 60_000;
        row.attempts += 1;
        return {
          alertId: row.alertId,
          kind: row.kind,
          severity: ALERT_SEVERITY[row.kind],
          orderReference: row.orderReference ?? null,
          paymentId: row.paymentId ?? null,
          provider: row.provider ?? null,
          detail: row.detail ?? null,
          occurrences: row.occurrences,
          firstSeenAt: "2026-10-23T12:00:00Z",
          lastSeenAt: "2026-10-23T12:00:00Z",
        };
      });
    }),
    finishAlertNotifications: vi.fn(async (ids: readonly string[]) => {
      let finished = 0;
      for (const row of rows.values()) {
        if (ids.includes(row.alertId) && !row.notified) {
          row.notified = true;
          finished += 1;
        }
      }
      return finished;
    }),
  };
  return { gateway, rows, clock };
}

function claimedRow(overrides: Partial<ClaimedReconciliation> = {}): ClaimedReconciliation {
  return {
    paymentId: PAYMENT_ID,
    orderId: "33333333-3333-4333-8333-333333333333",
    paymentAttempt: 1,
    paymentProvider: "epayco",
    providerTransactionId: REF_PAYCO,
    wompiReference: ORDER_REF,
    wompiTransactionId: REF_PAYCO,
    paymentStatus: "pending",
    amountCents: 1_000_000,
    currency: "COP",
    reconciliationAttempts: 1,
    orderReference: ORDER_REF,
    orderStatus: "PENDING",
    orderTotalInCents: 1_000_000,
    orderCurrency: "COP",
    ...overrides,
  };
}

function record(overrides: Partial<EpaycoTransactionData> = {}): EpaycoTransactionData {
  return {
    id: REF_PAYCO,
    refPayco: REF_PAYCO,
    responseRefPayco: REF_PAYCO,
    amountText: "10000",
    custIdCliente: null,
    reference: ORDER_REF,
    invoice: ORDER_REF,
    transactionId: "tx-1",
    status: "approved",
    rawStatus: "1",
    amount: 10_000,
    amountInCents: 1_000_000,
    currency: "COP",
    responseCode: 1,
    responseText: "Aceptada",
    statusMessage: "Aprobada",
    paymentMethodType: "PSE",
    signature: "",
    isTest: true,
    franchise: "PSE",
    bankName: null,
    transactionDate: null,
    rawPayload: { x_ref_payco: REF_PAYCO },
    ...overrides,
  };
}

function confirmation(overrides: Partial<ConfirmPaymentResult> = {}): ConfirmPaymentResult {
  return {
    result: "APPLIED",
    reason: "PAYMENT_APPROVED",
    orderId: "33333333-3333-4333-8333-333333333333",
    orderReference: ORDER_REF,
    orderStatus: "PAID",
    paymentId: PAYMENT_ID,
    paymentStatus: "approved",
    rawWompiStatus: "1",
    paymentAttempt: 1,
    wompiReference: ORDER_REF,
    wompiTransactionId: REF_PAYCO,
    amountInCents: 1_000_000,
    currency: "COP",
    ticketsIssued: 1,
    ticketsExpected: 1,
    reconciliationRequired: false,
    ...overrides,
  };
}

function payments(options: {
  rows?: () => readonly ClaimedReconciliation[];
  confirmation?: ConfirmPaymentResult;
}) {
  const gateway = {
    expirePendingOrders: vi
      .fn()
      .mockResolvedValue({ expiredCount: 0, releasedTiers: 0, references: [], ranAt: "x" }),
    claimEmailDeliveries: vi.fn().mockResolvedValue([]),
    claimPaymentReconciliations: vi.fn(async () => options.rows?.() ?? []),
    finishPaymentReconciliation: vi.fn().mockResolvedValue({}),
    confirmPayment: vi.fn().mockResolvedValue(options.confirmation ?? confirmation()),
    queueTicketEmails: vi.fn().mockResolvedValue({
      queued: 1,
      alreadyQueued: 0,
      total: 1,
      template: "TICKET_CONFIRMATION",
    }),
  };
  return gateway as typeof gateway & PaymentGateway;
}

const sheets: SheetsGateway = {
  claimProjections: vi.fn().mockResolvedValue([]),
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

const orderStatus: OrderStatusGateway = {
  getOrderStatus: vi.fn().mockResolvedValue({ found: false }),
  findEmailContext: vi.fn().mockResolvedValue(undefined),
};

function run(input: {
  payments: PaymentGateway;
  alerts: AlertGateway | undefined;
  resend: ResendClient | undefined;
  epaycoRecord?: EpaycoTransactionData;
  cfg?: BackendConfig;
}) {
  const epayco: EpaycoClient = {
    getTransaction: vi.fn().mockResolvedValue(input.epaycoRecord ?? record()),
  };
  return runMaintenance({
    config: input.cfg ?? config(),
    logger,
    payments: input.payments,
    orderStatus,
    resend: input.resend,
    wompi: { getTransaction: vi.fn().mockRejectedValue(new Error("not used")) },
    epayco,
    alerts: input.alerts,
    sheets,
    sheetsClient: undefined,
    rateLimits: { consume: vi.fn(), cleanup: vi.fn().mockResolvedValue(0) },
  });
}

function mailer(send = vi.fn().mockResolvedValue({ id: "m" })): ResendClient {
  return { send };
}

describe("maintenance alerts (H8 integration)", () => {
  it("alerts a reconciliation mismatch once and emails it once across repeated runs", async () => {
    const ledger = memoryLedger();
    const mail = mailer();
    const p = payments({ rows: () => [claimedRow()] });
    const mismatched = record({ invoice: "EVT-2026-999999", reference: "EVT-2026-999999" });

    const first = await run({
      payments: p,
      alerts: ledger.gateway,
      resend: mail,
      epaycoRecord: mismatched,
    });
    const second = await run({
      payments: p,
      alerts: ledger.gateway,
      resend: mail,
      epaycoRecord: mismatched,
    });

    expect(first.reconciliation.byResult).toEqual({ MISMATCH: 1 });
    expect(first.alerts).toMatchObject({ claimed: 1, sent: 1, failed: false });
    expect(second.alerts).toMatchObject({ claimed: 0, sent: 0 });
    expect([...ledger.rows.values()]).toEqual([
      expect.objectContaining({
        kind: "RECONCILIATION_MISMATCH",
        dedupeKey: `recon-mismatch:${PAYMENT_ID}`,
        occurrences: 2,
        notified: true,
      }),
    ]);
    // One email for the whole situation, despite two runs.
    const alertMails = vi
      .mocked(mail.send)
      .mock.calls.filter((call) => call[0].subject.includes("alerta"));
    expect(alertMails).toHaveLength(1);
    expect(p.confirmPayment).not.toHaveBeenCalled();
  });

  it("alerts an exhausted payment once, however many runs follow", async () => {
    const ledger = memoryLedger({ unresolvedPaymentIds: () => [PAYMENT_ID] });
    const mail = mailer();
    const p = payments({});

    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      runs.push(await run({ payments: p, alerts: ledger.gateway, resend: mail }));
    }

    expect(runs.map((r) => r.alerts.unresolvedRaised)).toEqual([1, 0, 0]);
    expect(runs.map((r) => r.alerts.sent)).toEqual([1, 0, 0]);
    expect(vi.mocked(mail.send)).toHaveBeenCalledTimes(1);
    expect(ledger.rows.get(`unresolved:${PAYMENT_ID}`)).toMatchObject({
      kind: "UNRESOLVED_PAYMENT",
      notified: true,
    });
  });

  it("retries a failed digest only after its backoff, then delivers it once", async () => {
    const ledger = memoryLedger({ unresolvedPaymentIds: () => [PAYMENT_ID] });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("resend 503"))
      .mockResolvedValue({ id: "m" });
    const mail = mailer(send);
    const p = payments({});

    const failed = await run({ payments: p, alerts: ledger.gateway, resend: mail });
    expect(failed.alerts).toMatchObject({ claimed: 1, sent: 0, failed: true });
    expect(failed.jobErrors).toEqual([]);

    // Inside the first 5-minute backoff: nothing is claimed or sent again.
    ledger.clock.now += 4 * 60_000;
    expect((await run({ payments: p, alerts: ledger.gateway, resend: mail })).alerts.claimed).toBe(
      0,
    );

    ledger.clock.now += 2 * 60_000;
    const delivered = await run({ payments: p, alerts: ledger.gateway, resend: mail });
    expect(delivered.alerts).toMatchObject({ claimed: 1, sent: 1, failed: false });
    expect(send).toHaveBeenCalledTimes(2);
    // The retry is the same batch: Resend can deduplicate it by key.
    const sent = vi.mocked(mail.send).mock.calls.map((call) => call[0].idempotencyKey);
    expect(sent[0]).toBe(sent[1]);
  });

  it("stops retrying a digest after the attempt cap", async () => {
    const ledger = memoryLedger({ unresolvedPaymentIds: () => [PAYMENT_ID] });
    const send = vi.fn().mockRejectedValue(new Error("resend down"));
    const p = payments({});
    for (let i = 0; i < 7; i += 1) {
      await run({ payments: p, alerts: ledger.gateway, resend: mailer(send) });
      ledger.clock.now += 24 * 60 * 60_000;
    }
    expect(send).toHaveBeenCalledTimes(5);
    expect(ledger.rows.get(`unresolved:${PAYMENT_ID}`)).toMatchObject({
      attempts: 5,
      notified: false,
    });
  });

  it("keeps a recovered approval paid and its emails queued when the alert ledger is down", async () => {
    const broken: AlertGateway = {
      recordAlert: vi.fn().mockRejectedValue(new Error("db down")),
      raiseUnresolvedPaymentAlerts: vi.fn().mockRejectedValue(new Error("db down")),
      claimAlertNotifications: vi.fn().mockRejectedValue(new Error("db down")),
      finishAlertNotifications: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const p = payments({ rows: () => [claimedRow()] });
    const result = await run({ payments: p, alerts: broken, resend: mailer() });

    expect(result.reconciliation.byResult).toEqual({ APPROVED_APPLIED: 1 });
    expect(p.confirmPayment).toHaveBeenCalledTimes(1);
    // Tickets are discontinued: a recovered approval queues no ticket email.
    expect(p.queueTicketEmails).not.toHaveBeenCalled();
    expect(p.finishPaymentReconciliation).toHaveBeenCalledWith({
      paymentId: PAYMENT_ID,
      result: "APPROVED_APPLIED",
    });
    // Only the alert job is reported as failed; the payment work is untouched.
    expect(result.jobErrors).toEqual(["alerts"]);
  });

  it("records a late approval for review even when the alert cannot be stored", async () => {
    const broken: AlertGateway = {
      recordAlert: vi.fn().mockRejectedValue(new Error("db down")),
      raiseUnresolvedPaymentAlerts: vi.fn().mockResolvedValue(0),
      claimAlertNotifications: vi.fn().mockResolvedValue([]),
      finishAlertNotifications: vi.fn().mockResolvedValue(0),
    };
    const p = payments({
      rows: () => [claimedRow({ orderStatus: "EXPIRED" })],
      confirmation: confirmation({
        result: "RECONCILIATION_REQUIRED",
        reason: "ORDER_NOT_PAYABLE_EXPIRED",
        orderStatus: "EXPIRED",
        ticketsIssued: 0,
        ticketsExpected: 0,
        reconciliationRequired: true,
      }),
    });
    const result = await run({ payments: p, alerts: broken, resend: mailer() });

    expect(broken.recordAlert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "LATE_APPROVAL", dedupeKey: `late:${PAYMENT_ID}` }),
    );
    expect(result.reconciliation.byResult).toEqual({ RECONCILIATION_REQUIRED: 1 });
    expect(result.reconciliation.reviewRequired).toEqual([ORDER_REF]);
    expect(p.finishPaymentReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ result: "RECONCILIATION_REQUIRED" }),
    );
    expect(result.jobErrors).toEqual([]);
  });

  it("records alerts but sends nothing, visibly, when ALERT_EMAIL_TO is invalid", async () => {
    const ledger = memoryLedger({ unresolvedPaymentIds: () => [PAYMENT_ID] });
    const mail = mailer();
    const result = await run({
      payments: payments({}),
      alerts: ledger.gateway,
      resend: mail,
      cfg: config({ ALERT_EMAIL_TO: "not-an-email" }),
    });
    expect(result.alerts).toMatchObject({
      skipped: "INVALID_RECIPIENTS",
      recipientIssue: "ALERT_EMAIL_TO has 1 invalid address(es)",
      unresolvedRaised: 1,
      sent: 0,
    });
    expect(mail.send).not.toHaveBeenCalled();
    expect(ledger.rows.get(`unresolved:${PAYMENT_ID}`)?.attempts).toBe(0);
  });
});
