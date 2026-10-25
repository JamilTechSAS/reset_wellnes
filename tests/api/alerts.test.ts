/**
 * H8: operational alerts — raising (sink), mapping, the digest, and its delivery rules.
 */

import { describe, expect, it, vi } from "vitest";

import { createAlertSink, runAlertDigest } from "@shared/api/alerts.ts";
import { alertForSweepOutcome } from "@shared/api/reconciliation-handler.ts";
import {
  ALERT_SEVERITY,
  alertForApprovalConflict,
  alertForConfirmation,
  buildAlertDigest,
  sanitizeAlert,
  type ClaimedAlert,
} from "@shared/domain/alerts.ts";
import type { AlertGateway } from "@shared/db/alerts.ts";
import type { ClaimedReconciliation } from "@shared/db/payments.ts";
import type { ResendClient } from "@shared/integrations/resend/client.ts";
import { createLogger } from "@shared/logging/logger.ts";

const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: "test",
    environment: "development",
    level: "debug",
    sink: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { logger, lines };
}

function gateway(overrides: Partial<AlertGateway> = {}): AlertGateway {
  return {
    recordAlert: vi.fn().mockResolvedValue({ created: true, occurrences: 1 }),
    raiseUnresolvedPaymentAlerts: vi.fn().mockResolvedValue(0),
    claimAlertNotifications: vi.fn().mockResolvedValue([]),
    finishAlertNotifications: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function claimedAlert(overrides: Partial<ClaimedAlert> = {}): ClaimedAlert {
  return {
    alertId: "a1",
    kind: "PAYMENT_REVERSED_AFTER_APPROVAL",
    severity: "critical",
    orderReference: "EVT-2026-000003",
    paymentId: PAYMENT_ID,
    provider: "epayco",
    detail: "PAYMENT_REVERSED_AFTER_APPROVAL",
    occurrences: 1,
    firstSeenAt: "2026-10-23T06:00:00Z",
    lastSeenAt: "2026-10-23T06:00:00Z",
    ...overrides,
  };
}

describe("alert sink", () => {
  it("records a sanitized alert and keeps provider free text and bad identifiers out", async () => {
    const g = gateway();
    const { logger } = capturingLogger();
    await createAlertSink(
      g,
      logger,
    )({
      kind: "PROVIDER_RECORD_MISMATCH",
      dedupeKey: "record-mismatch:987:INVOICE_MISMATCH",
      orderReference: "<script>",
      paymentId: "not-a-uuid",
      provider: "epayco",
      detail: "buyer ana@example.com said hi",
    });
    expect(g.recordAlert).toHaveBeenCalledWith({
      kind: "PROVIDER_RECORD_MISMATCH",
      dedupeKey: "record-mismatch:987:INVOICE_MISMATCH",
      orderReference: undefined,
      paymentId: undefined,
      provider: "epayco",
      detail: undefined,
    });
  });

  it("never throws when the alert cannot be recorded, and logs it", async () => {
    const { logger, lines } = capturingLogger();
    const sink = createAlertSink(
      gateway({ recordAlert: vi.fn().mockRejectedValue(new Error("db down")) }),
      logger,
    );
    await expect(
      sink({ kind: "LATE_APPROVAL", dedupeKey: `late:${PAYMENT_ID}` }),
    ).resolves.toBeUndefined();
    expect(lines.some((line) => line.msg === "could not record operational alert")).toBe(true);
  });
});

describe("alert mapping", () => {
  it.each([
    ["PAYMENT_REVERSED_AFTER_APPROVAL", "PAYMENT_REVERSED_AFTER_APPROVAL", "reversal"],
    ["ORDER_NOT_PAYABLE_EXPIRED", "LATE_APPROVAL", "late"],
  ])("maps a RECONCILIATION_REQUIRED confirmation (%s) to %s", (reason, kind, prefix) => {
    expect(
      alertForConfirmation({
        result: "RECONCILIATION_REQUIRED",
        reason,
        orderReference: "EVT-2026-000003",
        paymentId: PAYMENT_ID,
        provider: "epayco",
      }),
    ).toMatchObject({ kind, dedupeKey: `${prefix}:${PAYMENT_ID}` });
  });

  it.each(["APPLIED", "DUPLICATE"])("raises nothing for a %s confirmation", (result) => {
    expect(
      alertForConfirmation({
        result,
        reason: "PAYMENT_APPROVED",
        orderReference: "EVT-2026-000003",
        paymentId: PAYMENT_ID,
        provider: "epayco",
      }),
    ).toBeUndefined();
  });

  const row = (attempts: number): ClaimedReconciliation => ({
    paymentId: PAYMENT_ID,
    orderId: "33333333-3333-4333-8333-333333333333",
    paymentAttempt: 1,
    paymentProvider: "epayco",
    providerTransactionId: "987",
    wompiReference: "EVT-2026-000003",
    wompiTransactionId: "987",
    paymentStatus: "pending",
    amountCents: 1_000_000,
    currency: "COP",
    reconciliationAttempts: attempts,
    orderReference: "EVT-2026-000003",
    orderStatus: "PENDING",
    orderTotalInCents: 1_000_000,
    orderCurrency: "COP",
  });

  it.each([
    ["MISMATCH", 1, "RECONCILIATION_MISMATCH"],
    ["NOT_FOUND_AT_PROVIDER", 1, "PROVIDER_NOT_FOUND"],
    ["RECONCILIATION_REQUIRED", 1, "LATE_APPROVAL"],
    ["UPSTREAM_ERROR", 3, "REPEATED_PROVIDER_FAILURE"],
  ] as const)("maps the sweep outcome %s (attempt %i) to %s", (result, attempts, kind) => {
    expect(alertForSweepOutcome(row(attempts), result)?.kind).toBe(kind);
  });

  it.each([
    ["UPSTREAM_ERROR", 2],
    ["STILL_PENDING", 8],
    ["APPROVED_APPLIED", 1],
    ["DECLINED", 1],
  ] as const)("does not alert on %s (attempt %i)", (result, attempts) => {
    expect(alertForSweepOutcome(row(attempts), result)).toBeUndefined();
  });

  it("uses the same key for a late approval from the webhook and from the sweep", () => {
    const fromWebhook = alertForConfirmation({
      result: "RECONCILIATION_REQUIRED",
      reason: "ORDER_NOT_PAYABLE_EXPIRED",
      orderReference: "EVT-2026-000003",
      paymentId: PAYMENT_ID,
      provider: "epayco",
    });
    expect(alertForSweepOutcome(row(1), "RECONCILIATION_REQUIRED")?.dedupeKey).toBe(
      fromWebhook?.dedupeKey,
    );
  });

  it("raises a critical alert for a signed approval refused by a conflict", () => {
    const alert = alertForApprovalConflict({
      code: "CONFLICT",
      orderReference: "EVT-2026-000009",
      transactionId: "390996469",
      paymentStatus: "approved",
      eventId: PAYMENT_ID,
      refusalReason: "REFERENCE_MISMATCH",
    });
    expect(alert).toEqual({
      kind: "PAYMENT_CONFLICT",
      dedupeKey: "conflict:EVT-2026-000009:390996469",
      orderReference: "EVT-2026-000009",
      provider: "epayco",
      detail: `CONFLICT REFERENCE_MISMATCH ref 390996469 evt ${PAYMENT_ID}`,
    });
    expect(ALERT_SEVERITY.PAYMENT_CONFLICT).toBe("critical");
  });

  it("drops a refusal reason that is not code-like", () => {
    expect(
      alertForApprovalConflict({
        code: "CONFLICT",
        orderReference: "EVT-2026-000009",
        transactionId: "390996469",
        paymentStatus: "approved",
        refusalReason: "Database reported a conflict: ana@example.com",
      })?.detail,
    ).toBe("CONFLICT ref 390996469");
  });

  it("keys the alert on the order and transaction, not on the refusal detail", () => {
    const base = {
      code: "CONFLICT",
      orderReference: "EVT-2026-000009",
      transactionId: "390996469",
      paymentStatus: "approved",
    };
    expect(alertForApprovalConflict({ ...base })?.dedupeKey).toBe(
      alertForApprovalConflict({ ...base, refusalReason: "AMOUNT_MISMATCH" })?.dedupeKey,
    );
  });

  it("keeps one identity for repeated redeliveries of the same refused approval", () => {
    const alert = () =>
      alertForApprovalConflict({
        code: "CONFLICT",
        orderReference: "EVT-2026-000009",
        transactionId: "390996469",
        paymentStatus: "approved",
      });
    expect(alert()?.dedupeKey).toBe(alert()?.dedupeKey);
    // Without an event id the detail still names the transaction, never a buyer or a payload.
    expect(alert()?.detail).toBe("CONFLICT ref 390996469");
  });

  it.each([
    ["a refused decline", "CONFLICT", "declined"],
    ["a refused pending delivery", "CONFLICT", "pending"],
    ["a malformed or mismatched delivery", "VALIDATION_ERROR", "approved"],
    ["an unknown order", "NOT_FOUND", "approved"],
  ])("raises nothing for %s", (_label, code, paymentStatus) => {
    expect(
      alertForApprovalConflict({
        code,
        orderReference: "EVT-2026-000009",
        transactionId: "390996469",
        paymentStatus,
      }),
    ).toBeUndefined();
  });

  it("drops a detail that is not code-like", () => {
    expect(
      sanitizeAlert({ kind: "LATE_APPROVAL", dedupeKey: "late:x", detail: "ok_CODE:1" }).detail,
    ).toBe("ok_CODE:1");
    expect(
      sanitizeAlert({ kind: "LATE_APPROVAL", dedupeKey: "late:x", detail: "x\ny" }).detail,
    ).toBeUndefined();
  });
});

describe("alert digest", () => {
  it("lists order references and kinds only, escaped, with critical alerts called out", () => {
    const digest = buildAlertDigest({
      alerts: [
        claimedAlert(),
        claimedAlert({
          alertId: "a2",
          kind: "RECONCILIATION_MISMATCH",
          severity: "warning",
          orderReference: null,
          detail: "<b>MISMATCH</b>",
          occurrences: 4,
        }),
      ],
      serviceName: "event-ticketing",
      environment: "sandbox",
    });
    expect(digest.subject).toBe("[sandbox] 2 alerta(s) de pagos — 1 crítica(s)");
    expect(digest.text).toContain("orden EVT-2026-000003");
    expect(digest.text).toContain("4 veces");
    expect(digest.html).not.toContain("<b>MISMATCH</b>");
    expect(digest.html).toContain("&lt;b&gt;MISMATCH&lt;/b&gt;");
    expect(digest.text).not.toContain(PAYMENT_ID);
  });

  function resend(send = vi.fn().mockResolvedValue({ id: "m1" })): ResendClient {
    return { send };
  }

  const base = {
    from: "Boleteria <no-responder@example.com>",
    serviceName: "event-ticketing",
    environment: "sandbox",
    reconciliationMaxAttempts: 8,
  };

  it("still raises unresolved-payment alerts but sends nothing when email is disabled", async () => {
    const g = gateway({ raiseUnresolvedPaymentAlerts: vi.fn().mockResolvedValue(2) });
    const { logger, lines } = capturingLogger();
    const summary = await runAlertDigest({
      ...base,
      alerts: g,
      resend: undefined,
      recipients: ["ops@example.com"],
      logger,
    });
    expect(summary).toEqual({
      skipped: "EMAIL_DISABLED",
      recipientIssue: null,
      unresolvedRaised: 2,
      claimed: 0,
      sent: 0,
      failed: false,
    });
    expect(g.raiseUnresolvedPaymentAlerts).toHaveBeenCalledWith(8);
    expect(g.claimAlertNotifications).not.toHaveBeenCalled();
    // Visible: the run says the alerts are not being emailed and why.
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "operational alerts are recorded but not emailed",
        reason: "EMAIL_DISABLED",
      }),
    );
  });

  it("does not claim anything without recipients", async () => {
    const g = gateway();
    const { logger } = capturingLogger();
    const summary = await runAlertDigest({
      ...base,
      alerts: g,
      resend: resend(),
      recipients: [],
      logger,
    });
    expect(summary.skipped).toBe("NO_RECIPIENTS");
    expect(g.claimAlertNotifications).not.toHaveBeenCalled();
  });

  it("reports invalid recipients visibly and keeps the alerts unclaimed", async () => {
    const g = gateway();
    const { logger, lines } = capturingLogger();
    const summary = await runAlertDigest({
      ...base,
      alerts: g,
      resend: resend(),
      recipients: [],
      recipientIssue: "ALERT_EMAIL_TO has 1 invalid address(es)",
      logger,
    });
    expect(summary).toMatchObject({
      skipped: "INVALID_RECIPIENTS",
      recipientIssue: "ALERT_EMAIL_TO has 1 invalid address(es)",
    });
    expect(g.claimAlertNotifications).not.toHaveBeenCalled();
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "operational alert recipients misconfigured" }),
    );
  });

  it("still emails the valid recipients when some entries were ignored", async () => {
    const g = gateway({ claimAlertNotifications: vi.fn().mockResolvedValue([claimedAlert()]) });
    const mail = resend();
    const { logger } = capturingLogger();
    const summary = await runAlertDigest({
      ...base,
      alerts: g,
      resend: mail,
      recipients: ["ops@example.com"],
      recipientIssue: "ALERT_EMAIL_TO has 1 invalid address(es)",
      logger,
    });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ skipped: null, sent: 1 });
  });

  it("never lets two different batches share an idempotency key", async () => {
    // 20 alerts whose ids share a long prefix: a truncated key would collide.
    const prefix = "33333333-3333-4333-8333-3333333333";
    const batch = (last: string) =>
      Array.from({ length: 20 }, (_, i) =>
        claimedAlert({ alertId: `${prefix}${String(i).padStart(2, "0")}` }),
      ).concat([claimedAlert({ alertId: last })]);
    const keys: string[] = [];
    for (const last of ["zz-first", "zz-second"]) {
      const mail = resend();
      const { logger } = capturingLogger();
      await runAlertDigest({
        ...base,
        alerts: gateway({ claimAlertNotifications: vi.fn().mockResolvedValue(batch(last)) }),
        resend: mail,
        recipients: ["ops@example.com"],
        logger,
      });
      keys.push(vi.mocked(mail.send).mock.calls[0]?.[0].idempotencyKey ?? "");
    }
    expect(keys[0]).toMatch(/^alerts:[0-9a-f]{64}$/);
    expect(keys[1]).toMatch(/^alerts:[0-9a-f]{64}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("sends one digest per recipient for the whole batch and marks it notified", async () => {
    const g = gateway({
      claimAlertNotifications: vi
        .fn()
        .mockResolvedValue([claimedAlert({ alertId: "b" }), claimedAlert({ alertId: "a" })]),
    });
    const mail = resend();
    const { logger } = capturingLogger();
    const summary = await runAlertDigest({
      ...base,
      alerts: g,
      resend: mail,
      recipients: ["ops@example.com", "lead@example.com"],
      logger,
    });

    expect(mail.send).toHaveBeenCalledTimes(2);
    const keys = vi.mocked(mail.send).mock.calls.map((call) => call[0].idempotencyKey);
    expect(vi.mocked(mail.send).mock.calls.map((call) => call[0].to)).toEqual([
      "ops@example.com",
      "lead@example.com",
    ]);
    // One stable key per recipient and batch (order-independent: ids are sorted first).
    expect(keys[0]).toMatch(/^alerts:[0-9a-f]{64}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(g.finishAlertNotifications).toHaveBeenCalledWith(["a", "b"]);
    expect(summary).toMatchObject({ claimed: 2, sent: 2, failed: false });
  });

  it("leaves alerts unnotified for a later retry when the send fails", async () => {
    const g = gateway({ claimAlertNotifications: vi.fn().mockResolvedValue([claimedAlert()]) });
    const { logger } = capturingLogger();
    const summary = await runAlertDigest({
      ...base,
      alerts: g,
      resend: resend(vi.fn().mockRejectedValue(new Error("resend 503"))),
      recipients: ["ops@example.com"],
      logger,
    });

    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: true });
    expect(g.finishAlertNotifications).not.toHaveBeenCalled();
  });

  it("sends nothing when there is nothing new to report", async () => {
    const mail = resend();
    const { logger } = capturingLogger();
    const summary = await runAlertDigest({
      ...base,
      alerts: gateway(),
      resend: mail,
      recipients: ["ops@example.com"],
      logger,
    });
    expect(mail.send).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ skipped: null, claimed: 0, sent: 0 });
  });
});
