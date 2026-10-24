/**
 * Wompi webhook handler.
 *
 * The webhook is the only path that can mark an order paid, so this suite attacks it
 * instead of trusting it:
 *
 *   - a forged checksum is refused and nothing is written;
 *   - a valid checksum whose transaction does NOT match our record approves nothing;
 *   - a duplicate delivery is answered 200 without reprocessing;
 *   - a transient Wompi failure answers 503 so the documented retry can finish the job;
 *   - an event we do not know is acknowledged, not treated as a payment.
 *
 * Every fixture is built at runtime. The signing secret is a fake assembled from a
 * variable ("test_events_" + filler) so no credential-shaped literal exists in the
 * repository — the same guardrail that protects .env.example.
 */

import { describe, expect, it, vi } from "vitest";

import { handleWompiWebhook } from "@shared/api/webhook-handler.ts";
import { loadConfig, type BackendConfig } from "@shared/config/env.ts";
import { WompiApiError, type WompiClient } from "@shared/integrations/wompi/client.ts";
import { sha256Hex } from "@shared/integrations/wompi/signature.ts";
import type {
  ClaimWebhookEventResult,
  ConfirmPaymentResult,
  FinalizeWebhookEventResult,
  PaymentGateway,
  PaymentLookup,
  QueueTicketEmailsResult,
} from "@shared/db/payments.ts";
import { createLogger } from "@shared/logging/logger.ts";
import { AppError, conflictError } from "@shared/domain/errors.ts";
import type { WompiTransaction } from "@shared/integrations/wompi/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds a credential-shaped string at runtime so no literal is ever committed. */
function fakeCredential(prefix: string, length = 32): string {
  return prefix + "A".repeat(length);
}

const EVENTS_SECRET = fakeCredential("test_events_");

const CONFIG: BackendConfig = loadConfig({
  APP_ENV: "development",
  LOG_LEVEL: "error",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SECRET_KEY: fakeCredential("sb_secret_", 40),
  WOMPI_PUBLIC_KEY: fakeCredential("pub_test_", 20),
  WOMPI_PRIVATE_KEY: fakeCredential("prv_test_", 20),
  WOMPI_INTEGRITY_SECRET: fakeCredential("test_integrity_", 20),
  WOMPI_EVENTS_SECRET: EVENTS_SECRET,
  EMAIL_ENABLED: "false",
  PUBLIC_WEB_BASE_URL: "http://localhost:3000",
  API_BASE_URL: "http://127.0.0.1:54321/functions/v1",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
});

const TRANSACTION_ID = "1292-1602113476-10985";
const ORDER_REFERENCE = "EVT-2026-000001";
const AMOUNT = 9500000;

/** Signs an envelope exactly the way Wompi documents it. */
async function signedEvent(options: {
  readonly status?: string;
  readonly amount?: number;
  readonly reference?: string;
  readonly transactionId?: string;
  readonly timestamp?: number;
  readonly properties?: readonly string[];
  readonly eventName?: string;
}): Promise<Record<string, unknown>> {
  const properties = options.properties ?? [
    "transaction.id",
    "transaction.status",
    "transaction.amount_in_cents",
  ];
  const data = {
    transaction: {
      id: options.transactionId ?? TRANSACTION_ID,
      reference: options.reference ?? ORDER_REFERENCE,
      status: options.status ?? "APPROVED",
      amount_in_cents: options.amount ?? AMOUNT,
      currency: "COP",
      payment_method_type: "CARD",
      status_message: "Transacción aprobada",
    },
  };
  const timestamp = options.timestamp ?? 1530291411;

  let payload = "";
  for (const property of properties) {
    const segments = property.split(".");
    let current: unknown = data;
    for (const segment of segments) {
      current = (current as Record<string, unknown>)[segment];
    }
    payload += String(current);
  }
  payload += String(timestamp) + EVENTS_SECRET;

  return {
    event: options.eventName ?? "transaction.updated",
    data,
    environment: "test",
    signature: { properties, checksum: await sha256Hex(payload) },
    timestamp,
    sent_at: "2018-07-20T16:45:05.000Z",
  };
}

const PAYMENT: PaymentLookup = {
  paymentId: "11111111-1111-4111-8111-111111111111",
  paymentAttempt: 1,
  wompiReference: ORDER_REFERENCE,
  wompiTransactionId: null,
  paymentStatus: "pending",
  amountCents: AMOUNT,
  currency: "COP",
  orderId: "22222222-2222-4222-8222-222222222222",
  orderReference: ORDER_REFERENCE,
  orderStatus: "PENDING",
  orderTotalInCents: AMOUNT,
  orderCurrency: "COP",
};

const WALLET_TRANSACTION: WompiTransaction = {
  id: TRANSACTION_ID,
  reference: ORDER_REFERENCE,
  status: "APPROVED",
  amountInCents: AMOUNT,
  currency: "COP",
  customerEmail: undefined,
  paymentMethodType: "CARD",
  statusMessage: "Transacción aprobada",
  createdAt: undefined,
  finalizedAt: undefined,
};

const APPLIED: ConfirmPaymentResult = {
  result: "APPLIED",
  reason: "PAYMENT_APPROVED",
  orderId: PAYMENT.orderId,
  orderReference: ORDER_REFERENCE,
  orderStatus: "PAID",
  paymentId: PAYMENT.paymentId,
  paymentStatus: "approved",
  rawWompiStatus: "APPROVED",
  paymentAttempt: 1,
  wompiReference: ORDER_REFERENCE,
  wompiTransactionId: TRANSACTION_ID,
  amountInCents: AMOUNT,
  currency: "COP",
  ticketsIssued: 3,
  ticketsExpected: 3,
  reconciliationRequired: false,
};

type Stubs = {
  readonly gateway: PaymentGateway;
  readonly wompi: WompiClient;
  readonly calls: {
    confirmPayment: number;
    queueTicketEmails: number;
    finalize: { result: string; errorCode?: string | undefined }[];
    claim: number;
    recordRejection: number;
    providers: string[];
  };
};

function stubs(
  options: {
    readonly claim?: (call: number) => ClaimWebhookEventResult;
    readonly payment?: PaymentLookup | undefined;
    readonly paymentByTransactionId?: PaymentLookup | undefined;
    readonly transaction?: WompiTransaction;
    readonly transactionError?: Error;
    readonly confirmation?: ConfirmPaymentResult;
    readonly queue?: QueueTicketEmailsResult;
  } = {},
): Stubs {
  const calls = {
    confirmPayment: 0,
    queueTicketEmails: 0,
    finalize: [] as { result: string; errorCode?: string | undefined }[],
    claim: 0,
    recordRejection: 0,
    /** Provider each gateway write declared (H15). */
    providers: [] as string[],
  };

  let claimCount = 0;
  const gateway: PaymentGateway = {
    async findPaymentByReference() {
      return options.payment;
    },
    async findPaymentByTransactionId() {
      return options.paymentByTransactionId;
    },
    async claimWebhookEvent(input): Promise<ClaimWebhookEventResult> {
      claimCount += 1;
      calls.claim += 1;
      calls.providers.push(`claim:${input.provider}`);
      return (
        options.claim?.(claimCount) ?? {
          claimed: true,
          eventId: "33333333-3333-4333-8333-333333333333",
          result: null,
          processedAt: null,
          httpStatus: null,
        }
      );
    },
    async finalizeWebhookEvent(input): Promise<FinalizeWebhookEventResult> {
      calls.finalize.push({
        result: input.result,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      });
      return {
        finalized: true,
        eventId: input.eventId,
        result: input.result,
        processedAt: "2026-10-03T00:00:00.000Z",
      };
    },
    async recordWebhookRejection(input) {
      calls.recordRejection += 1;
      calls.providers.push(`rejection:${input.provider}`);
      return { eventId: "44444444-4444-4444-8444-444444444444", recorded: true };
    },
    async confirmPayment(input) {
      calls.confirmPayment += 1;
      calls.providers.push(`confirm:${input.provider}`);
      return (
        options.confirmation ?? {
          ...APPLIED,
          result: "APPLIED",
        }
      );
    },
    async queueTicketEmails(): Promise<QueueTicketEmailsResult> {
      calls.queueTicketEmails += 1;
      return (
        options.queue ?? { queued: 3, alreadyQueued: 0, total: 3, template: "TICKET_CONFIRMATION" }
      );
    },
    async expirePendingOrders() {
      return { expiredCount: 0, releasedTiers: 0, references: [], ranAt: "x" };
    },
    async retryPayment() {
      throw new Error("not used");
    },
    async claimEmailDeliveries() {
      return [];
    },
    async finishEmailDelivery() {
      throw new Error("not used");
    },
    // Phase 5 reconciliation methods are not part of this suite.
    async claimPaymentReconciliations() {
      return [];
    },
    async finishPaymentReconciliation() {
      throw new Error("not used");
    },
    async resolvePaymentForBuyer() {
      throw new Error("not used");
    },
  };

  const wompi: WompiClient = {
    async getTransaction() {
      if (options.transactionError !== undefined) {
        throw options.transactionError;
      }
      return options.transaction ?? WALLET_TRANSACTION;
    },
  };

  return { gateway, wompi, calls };
}

function logger() {
  return createLogger({
    service: "test",
    environment: "test",
    level: "error",
    sink: () => undefined,
  });
}

async function run(
  body: unknown,
  stubbed: Stubs,
  headerChecksum?: string,
): Promise<Awaited<ReturnType<typeof handleWompiWebhook>>> {
  return handleWompiWebhook({
    rawBody: body,
    headerChecksum,
    config: CONFIG,
    logger: logger(),
    payments: stubbed.gateway,
    wompi: stubbed.wompi,
  });
}

// ---------------------------------------------------------------------------
// Authenticity
// ---------------------------------------------------------------------------

describe("webhook authenticity", () => {
  it("accepts an event signed with the documented algorithm", async () => {
    const s = stubs({ payment: PAYMENT });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("APPLIED");
    expect(outcome.ticketsIssued).toBe(3);
    expect(s.calls.confirmPayment).toBe(1);
    expect(s.calls.queueTicketEmails).toBe(0);
    // H15: every write of the Wompi path declares Wompi.
    expect(s.calls.providers).toEqual(["claim:wompi", "confirm:wompi"]);
  });

  it("accepts the checksum from the X-Event-Checksum header when the body omits it", async () => {
    const event = await signedEvent({});
    const checksum = (event.signature as { checksum: string }).checksum;
    const body = {
      ...event,
      signature: { properties: (event.signature as { properties: unknown }).properties },
    };
    const s = stubs({ payment: PAYMENT });
    const outcome = await run(body, s, checksum);
    expect(outcome.status).toBe(200);
    expect(s.calls.confirmPayment).toBe(1);
  });

  it("refuses a tampered amount and writes nothing", async () => {
    const event = await signedEvent({});
    // Flip the amount AFTER signing: the checksum no longer matches.
    (event.data as { transaction: { amount_in_cents: number } }).transaction.amount_in_cents = 1;
    const s = stubs({ payment: PAYMENT });
    const outcome = await run(event, s);
    expect(outcome.status).toBe(401);
    expect(outcome.reason).toBe("CHECKSUM_MISMATCH");
    expect(s.calls.confirmPayment).toBe(0);
    expect(s.calls.claim).toBe(0);
    // The refused delivery is recorded under its own namespace for forensics.
    expect(s.calls.recordRejection).toBe(1);
    expect(s.calls.providers).toEqual(["rejection:wompi"]);
  });

  it("refuses a well-formed body with no signature at all", async () => {
    const s = stubs({ payment: PAYMENT });
    const outcome = await run({ event: "transaction.updated", data: {} }, s);
    expect(outcome.status).toBe(400);
    expect(outcome.reason).toBe("MALFORMED_BODY");
    expect(s.calls.confirmPayment).toBe(0);
  });

  it("refuses an event minted for the other Wompi environment", async () => {
    const event = await signedEvent({});
    event.environment = "prod";
    const s = stubs({ payment: PAYMENT });
    const outcome = await run(event, s);
    expect(outcome.status).toBe(401);
    expect(outcome.reason).toBe("ENVIRONMENT_MISMATCH");
    expect(s.calls.confirmPayment).toBe(0);
  });

  it("refuses an envelope carrying two different timestamps", async () => {
    const event = await signedEvent({});
    (event.signature as Record<string, unknown>).timestamp = 1;
    const s = stubs({ payment: PAYMENT });
    const outcome = await run(event, s);
    expect(outcome.status).toBe(400);
    expect(outcome.reason).toBe("AMBIGUOUS_TIMESTAMP");
  });

  it("accepts the legacy timestamp location inside signature", async () => {
    const event = await signedEvent({});
    const timestamp = event.timestamp;
    delete event.timestamp;
    (event.signature as Record<string, unknown>).timestamp = timestamp;
    const s = stubs({ payment: PAYMENT });
    const outcome = await run(event, s);
    expect(outcome.status).toBe(200);
    expect(s.calls.confirmPayment).toBe(1);
  });

  it("never exposes the events secret in the outcome", async () => {
    const s = stubs({ payment: PAYMENT });
    const outcome = await run(await signedEvent({}), s);
    expect(JSON.stringify(outcome)).not.toContain(EVENTS_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("webhook deduplication", () => {
  it("answers 200 to a redelivery without processing it again", async () => {
    const s = stubs({
      payment: PAYMENT,
      claim: () => ({
        claimed: false,
        eventId: "33333333-3333-4333-8333-333333333333",
        result: "APPLIED",
        processedAt: "2026-10-03T00:00:00.000Z",
        httpStatus: 200,
      }),
    });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("DUPLICATE");
    expect(s.calls.confirmPayment).toBe(0);
    expect(s.calls.queueTicketEmails).toBe(0);
  });

  it("reprocesses an event that was claimed but never finalized", async () => {
    // The previous delivery answered 503 (transient failure), so the ledger row is still
    // unprocessed. Wompi's retry MUST process the payment: answering 200 here would
    // swallow the retry the response contract depends on and could leave an approved
    // payment pending forever (reconciliation cannot see a transaction id that was never
    // stored).
    const s = stubs({
      payment: PAYMENT,
      claim: () => ({
        claimed: false,
        eventId: "33333333-3333-4333-8333-333333333333",
        result: null,
        processedAt: null,
        httpStatus: null,
      }),
    });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("APPLIED");
    expect(s.calls.confirmPayment).toBe(1);
    expect(s.calls.queueTicketEmails).toBe(0);
    // The retry owns the outcome now; the finalize still happens exactly once.
    expect(s.calls.finalize.at(-1)?.result).toBe("APPLIED");
  });

  it("does not even look up the transaction when the event is already recorded", async () => {
    const getTransaction = vi.fn();
    const s = stubs({
      payment: PAYMENT,
      claim: () => ({
        claimed: false,
        eventId: "33333333-3333-4333-8333-333333333333",
        result: "APPLIED",
        processedAt: "2026-10-03T00:00:00.000Z",
        httpStatus: 200,
      }),
    });
    const wompi: WompiClient = { getTransaction };
    const outcome = await handleWompiWebhook({
      rawBody: await signedEvent({}),
      headerChecksum: undefined,
      config: CONFIG,
      logger: logger(),
      payments: s.gateway,
      wompi,
    });
    expect(outcome.outcome).toBe("DUPLICATE");
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("replays the recorded rejection for a refused delivery that arrives twice", async () => {
    const s = stubs({
      payment: PAYMENT,
      claim: () => ({
        claimed: false,
        eventId: "33333333-3333-4333-8333-333333333333",
        result: "REJECTED",
        processedAt: "2026-10-03T00:00:00.000Z",
        httpStatus: 200,
      }),
    });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.status).toBe(200);
    expect(outcome.reviewRequired).toBe(true);
    expect(s.calls.confirmPayment).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The transaction lookup is authoritative
// ---------------------------------------------------------------------------

describe("server-side transaction lookup", () => {
  it("ignores a valid event whose reference we have never seen", async () => {
    const s = stubs({ payment: undefined, paymentByTransactionId: undefined });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("IGNORED");
    expect(outcome.reason).toBe("UNKNOWN_REFERENCE");
    expect(s.calls.confirmPayment).toBe(0);
    expect(s.calls.finalize.at(-1)?.result).toBe("IGNORED");
  });

  it("does NOT approve when Wompi reports a different amount than our order", async () => {
    const s = stubs({
      payment: PAYMENT,
      transaction: { ...WALLET_TRANSACTION, amountInCents: AMOUNT + 100 },
    });
    const outcome = await run(await signedEvent({ amount: AMOUNT + 100 }), s);
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(outcome.reason).toContain("AMOUNT_MISMATCH");
    expect(s.calls.confirmPayment).toBe(0);
    expect(s.calls.finalize.at(-1)?.result).toBe("REJECTED");
  });

  it("does NOT approve when the looked-up transaction carries another reference", async () => {
    const s = stubs({
      payment: PAYMENT,
      transaction: { ...WALLET_TRANSACTION, reference: "EVT-2026-000999" },
    });
    const outcome = await run(await signedEvent({ reference: "EVT-2026-000999" }), s);
    expect(outcome.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(s.calls.confirmPayment).toBe(0);
  });

  it("does NOT approve when the currency is not COP", async () => {
    const s = stubs({
      payment: PAYMENT,
      transaction: { ...WALLET_TRANSACTION, currency: "USD" },
    });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(s.calls.confirmPayment).toBe(0);
  });

  it("returns 503 when Wompi cannot be reached, so the documented retry can finish it", async () => {
    const s = stubs({
      payment: PAYMENT,
      transactionError: new WompiApiError("Wompi returned HTTP 500", { httpStatus: 500 }),
    });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.status).toBe(503);
    expect(outcome.outcome).toBe("RETRY");
    // Nothing was finalized: the ledger row stays unprocessed on purpose so the retry works.
    expect(s.calls.finalize).toHaveLength(0);
    expect(s.calls.confirmPayment).toBe(0);
  });

  it("uses the transaction id lookup first and falls back to the reference", async () => {
    const byTransaction = vi.fn(async () => undefined);
    const byReference = vi.fn(async () => PAYMENT);
    const s = stubs({});
    const gateway: PaymentGateway = {
      ...s.gateway,
      findPaymentByTransactionId: byTransaction,
      findPaymentByReference: byReference,
    };
    const outcome = await handleWompiWebhook({
      rawBody: await signedEvent({}),
      headerChecksum: undefined,
      config: CONFIG,
      logger: logger(),
      payments: gateway,
      wompi: s.wompi,
    });
    expect(byTransaction).toHaveBeenCalledTimes(1);
    expect(byReference).toHaveBeenCalledTimes(1);
    expect(outcome.outcome).toBe("APPLIED");
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe("confirmation outcomes", () => {
  it("treats a duplicate confirmation as a 200 duplicate, not an error", async () => {
    const s = stubs({
      payment: PAYMENT,
      confirmation: { ...APPLIED, result: "DUPLICATE", ticketsIssued: 0 },
    });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("DUPLICATE");
    expect(s.calls.finalize.at(-1)?.result).toBe("DUPLICATE");
  });

  it("flags an approved payment for a non-payable order for human review", async () => {
    const s = stubs({
      payment: PAYMENT,
      confirmation: {
        ...APPLIED,
        result: "RECONCILIATION_REQUIRED",
        reason: "ORDER_NOT_PAYABLE_EXPIRED",
        orderStatus: "EXPIRED",
        ticketsIssued: 0,
        reconciliationRequired: true,
      },
    });
    const outcome = await run(await signedEvent({}), s);
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(outcome.reviewRequired).toBe(true);
    expect(s.calls.finalize.at(-1)?.errorCode).toBe("ORDER_NOT_PAYABLE_EXPIRED");
    // No email is queued for an order that was not fulfilled.
    expect(s.calls.queueTicketEmails).toBe(0);
  });

  it("queues no email when the order did not reach PAID", async () => {
    const s = stubs({
      payment: PAYMENT,
      confirmation: {
        ...APPLIED,
        result: "APPLIED",
        reason: "PAYMENT_DECLINED",
        orderStatus: "FAILED",
        paymentStatus: "declined",
        ticketsIssued: 0,
        ticketsExpected: 0,
      },
    });
    const outcome = await run(await signedEvent({ status: "DECLINED" }), s);
    expect(outcome.status).toBe(200);
    expect(s.calls.queueTicketEmails).toBe(0);
  });

  it("acknowledges a documented but non-actionable event type", async () => {
    const s = stubs({ payment: PAYMENT });
    const outcome = await run(await signedEvent({ eventName: "nequi_token.updated" }), s);
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("IGNORED");
    expect(s.calls.confirmPayment).toBe(0);
    expect(s.calls.finalize.at(-1)?.result).toBe("IGNORED");
  });

  it("returns 503 when the confirmation itself fails transiently", async () => {
    const s = stubs({ payment: PAYMENT });
    const failing: PaymentGateway = {
      ...s.gateway,
      async confirmPayment() {
        // An unexpected database fault: NOT a business refusal.
        throw new AppError("INTERNAL_ERROR", "connection terminated unexpectedly");
      },
    };
    const outcome = await handleWompiWebhook({
      rawBody: await signedEvent({}),
      headerChecksum: undefined,
      config: CONFIG,
      logger: logger(),
      payments: failing,
      wompi: s.wompi,
    });
    expect(outcome.status).toBe(503);
    expect(outcome.outcome).toBe("RETRY");
  });

  it("records a permanent confirmation refusal as rejected with a 200", async () => {
    const s = stubs({ payment: PAYMENT });
    const failing: PaymentGateway = {
      ...s.gateway,
      async confirmPayment() {
        // What the SQL contract actually produces for a mismatch: PT409 -> CONFLICT.
        throw conflictError("Database reported a conflict: AMOUNT_MISMATCH", {
          context: { detail: "AMOUNT_MISMATCH" },
        });
      },
    };
    const outcome = await handleWompiWebhook({
      rawBody: await signedEvent({}),
      headerChecksum: undefined,
      config: CONFIG,
      logger: logger(),
      payments: failing,
      wompi: s.wompi,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.outcome).toBe("REJECTED");
    expect(outcome.reviewRequired).toBe(true);
  });
});
