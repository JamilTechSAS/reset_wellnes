/**
 * Payment confirmation domain rules.
 *
 * These tests cover the decisions that must hold before anything is written:
 *   - the dedupe identity of a delivery, including the rejected namespace;
 *   - the exact comparison between a Wompi transaction and our own payment row;
 *   - the forward-only payment transition table (mirrored in SQL).
 */

import { describe, expect, it } from "vitest";

import {
  buildEventDedupeKey,
  buildEventFingerprint,
  validateTransactionAgainstPayment,
  boundStatusMessage,
  CONFIRMATION_RESULTS,
  isConfirmationReason,
  isConfirmationResult,
  MAX_STATUS_MESSAGE_LENGTH,
  requiresOperatorReview,
} from "@shared/domain/payment-confirmation.ts";
import { parseWompiEventEnvelope } from "@shared/integrations/wompi/events.ts";
import type { WompiTransaction } from "@shared/integrations/wompi/types.ts";
import {
  advancePaymentStatus,
  isFailedPaymentStatus,
  mapWompiTransactionStatus,
  PAYMENT_STATUS_RANK,
  INTERNAL_PAYMENT_STATUSES,
} from "@shared/domain/payment-status.ts";

/** Builds an event body in the CURRENT documented envelope shape (top-level timestamp). */
function eventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "transaction.updated",
    data: {
      transaction: {
        id: "1292-1602113476-10985",
        reference: "EVT-2026-000001",
        status: "APPROVED",
        amount_in_cents: 9500000,
        currency: "COP",
      },
    },
    environment: "test",
    signature: {
      properties: ["transaction.id", "transaction.status", "transaction.amount_in_cents"],
      checksum: "a".repeat(64),
    },
    timestamp: 1530291411,
    sent_at: "2018-07-20T16:45:05.000Z",
    ...overrides,
  };
}

function envelopeOf(body: Record<string, unknown>) {
  const parsed = parseWompiEventEnvelope(body);
  if (!parsed.ok) {
    throw new Error(`test envelope should parse: ${parsed.reason}`);
  }
  return parsed.envelope;
}

const TRANSACTION: WompiTransaction = {
  id: "1292-1602113476-10985",
  reference: "EVT-2026-000001",
  status: "APPROVED",
  amountInCents: 9500000,
  currency: "COP",
  customerEmail: undefined,
  paymentMethodType: "CARD",
  statusMessage: "Transacción aprobada",
  createdAt: undefined,
  finalizedAt: undefined,
};

const PAYMENT = {
  wompiReference: "EVT-2026-000001",
  wompiTransactionId: null,
  amountCents: 9500000,
  currency: "COP",
};

const ORDER = { totalInCents: 9500000, currency: "COP" };

describe("event fingerprint and dedupe key", () => {
  it("is stable for the same event and independent of sent_at", async () => {
    const first = await buildEventDedupeKey(envelopeOf(eventBody()), { accepted: true });
    const second = await buildEventDedupeKey(
      envelopeOf(eventBody({ sent_at: "2019-01-01T00:00:00.000Z" })),
      { accepted: true },
    );
    expect(first).toBeDefined();
    expect(first).toBe(second);
    expect(first).toMatch(/^evt:[0-9a-f]{64}$/);
  });

  it("differs when a signed property differs (a real state change is a new event)", async () => {
    const approved = await buildEventDedupeKey(envelopeOf(eventBody()), { accepted: true });
    const declined = await buildEventDedupeKey(
      envelopeOf(
        eventBody({
          data: {
            transaction: {
              ...{
                id: "1292-1602113476-10985",
                reference: "EVT-2026-000001",
                amount_in_cents: 9500000,
                currency: "COP",
              },
              status: "DECLINED",
            },
          },
        }),
      ),
      { accepted: true },
    );
    expect(approved).not.toBe(declined);
  });

  it("uses a separate namespace for refused deliveries so a spoof cannot occupy the real slot", async () => {
    const accepted = await buildEventDedupeKey(envelopeOf(eventBody()), { accepted: true });
    const rejected = await buildEventDedupeKey(envelopeOf(eventBody()), { accepted: false });
    expect(accepted).not.toBe(rejected);
    expect(rejected).toMatch(/^rej:[0-9a-f]{64}$/);
    // Both stay inside the payment_events.dedupe_key CHECK (printable ASCII, 16-200 chars).
    for (const key of [accepted, rejected]) {
      expect(key).toMatch(/^[!-~]{16,200}$/);
    }
  });

  it("refuses to fingerprint an event whose properties do not resolve", () => {
    const envelope = envelopeOf({
      event: "transaction.updated",
      // `signature.properties` lists a path that is not present in `data`.
      data: { transaction: { id: "x" } },
      signature: { properties: ["transaction.id", "transaction.status"], checksum: "a".repeat(64) },
      timestamp: 1530291411,
    });
    expect(buildEventFingerprint(envelope)).toBeUndefined();
  });

  it("rejects prototype-polluting property paths", () => {
    const envelope = envelopeOf({
      event: "transaction.updated",
      data: { transaction: { id: "x" } },
      signature: { properties: ["__proto__.polluted"], checksum: "a".repeat(64) },
      timestamp: 1530291411,
    });
    expect(buildEventFingerprint(envelope)).toBeUndefined();
  });
});

describe("transaction validation against our payment record", () => {
  it("accepts an exact match", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: TRANSACTION,
        eventTransactionId: TRANSACTION.id,
        eventReference: TRANSACTION.reference,
        payment: PAYMENT,
        order: ORDER,
      }),
    ).toEqual([]);
  });

  it("flags an amount mismatch of a single centavo", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: { ...TRANSACTION, amountInCents: 9500001 },
        eventTransactionId: TRANSACTION.id,
        eventReference: TRANSACTION.reference,
        payment: PAYMENT,
        order: ORDER,
      }),
    ).toEqual(["AMOUNT_MISMATCH"]);
  });

  it("flags a payment amount that no longer matches the order total", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: TRANSACTION,
        eventTransactionId: TRANSACTION.id,
        eventReference: TRANSACTION.reference,
        payment: { ...PAYMENT, amountCents: 1 },
        order: ORDER,
      }),
    ).toEqual(["AMOUNT_MISMATCH"]);
  });

  it("flags a non-COP currency on either side", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: { ...TRANSACTION, currency: "USD" },
        eventTransactionId: TRANSACTION.id,
        eventReference: TRANSACTION.reference,
        payment: PAYMENT,
        order: ORDER,
      }),
    ).toContain("CURRENCY_MISMATCH");
    expect(
      validateTransactionAgainstPayment({
        transaction: TRANSACTION,
        eventTransactionId: TRANSACTION.id,
        eventReference: TRANSACTION.reference,
        payment: PAYMENT,
        order: { totalInCents: 9500000, currency: "USD" },
      }),
    ).toContain("CURRENCY_MISMATCH");
  });

  it("flags a reference that does not belong to the payment", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: { ...TRANSACTION, reference: "EVT-2026-000999" },
        eventTransactionId: TRANSACTION.id,
        eventReference: "EVT-2026-000999",
        payment: PAYMENT,
        order: ORDER,
      }),
    ).toEqual(["REFERENCE_MISMATCH"]);
  });

  it("flags an event reference that disagrees with the authoritative one", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: TRANSACTION,
        eventTransactionId: TRANSACTION.id,
        eventReference: "EVT-2026-000002",
        payment: PAYMENT,
        order: ORDER,
      }),
    ).toEqual(["REFERENCE_MISMATCH"]);
  });

  it("flags a transaction id that differs from the one the event pointed at", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: { ...TRANSACTION, id: "1292-0000000000-00001" },
        eventTransactionId: TRANSACTION.id,
        eventReference: TRANSACTION.reference,
        payment: PAYMENT,
        order: ORDER,
      }),
    ).toEqual(["TRANSACTION_ID_MISMATCH"]);
  });

  it("flags a transaction id that is already bound to another transaction", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: TRANSACTION,
        eventTransactionId: TRANSACTION.id,
        eventReference: TRANSACTION.reference,
        payment: { ...PAYMENT, wompiTransactionId: "1292-9999999999-99999" },
        order: ORDER,
      }),
    ).toEqual(["TRANSACTION_ID_MISMATCH"]);
  });

  it("flags an empty transaction id", () => {
    expect(
      validateTransactionAgainstPayment({
        transaction: { ...TRANSACTION, id: "" },
        eventTransactionId: "",
        eventReference: TRANSACTION.reference,
        payment: PAYMENT,
        order: ORDER,
      }),
    ).toEqual(["MISSING_TRANSACTION_ID"]);
  });

  it("accumulates every problem instead of reporting only the first", () => {
    const problems = validateTransactionAgainstPayment({
      transaction: { ...TRANSACTION, amountInCents: 1, currency: "USD" },
      eventTransactionId: TRANSACTION.id,
      eventReference: "EVT-2026-000003",
      payment: PAYMENT,
      order: ORDER,
    });
    expect(problems).toContain("AMOUNT_MISMATCH");
    expect(problems).toContain("CURRENCY_MISMATCH");
    expect(problems).toContain("REFERENCE_MISMATCH");
  });
});

describe("forward-only payment transitions", () => {
  it("never regresses a terminal status", () => {
    expect(advancePaymentStatus("approved", "pending")).toBe("approved");
    expect(advancePaymentStatus("declined", "pending")).toBe("declined");
    // `error` outranks `declined` in the fixed order, so an out-of-order delivery cannot
    // downgrade a provider-reported error into a softer failure.
    expect(advancePaymentStatus("error", "declined")).toBe("error");
    // A void can only ever follow an approval; the refund marker outranks it.
    expect(advancePaymentStatus("voided", "refunded")).toBe("voided");
  });

  it("never advances on an unknown provider status", () => {
    expect(advancePaymentStatus("pending", "unknown")).toBe("pending");
    expect(advancePaymentStatus("declined", "unknown")).toBe("declined");
  });

  it("moves pending forward to any terminal status", () => {
    expect(advancePaymentStatus("pending", "approved")).toBe("approved");
    expect(advancePaymentStatus("pending", "declined")).toBe("declined");
    expect(advancePaymentStatus("pending", "error")).toBe("error");
  });

  it("treats a Wompi VOIDED after an approval as a refund", () => {
    expect(advancePaymentStatus("approved", "refunded")).toBe("refunded");
  });

  it("agrees with the SQL ranking order", () => {
    const ranked = [...INTERNAL_PAYMENT_STATUSES].sort(
      (left, right) => PAYMENT_STATUS_RANK[left] - PAYMENT_STATUS_RANK[right],
    );
    expect(ranked[0]).toBe("pending");
    expect(ranked.indexOf("unknown")).toBeLessThan(ranked.indexOf("approved"));
    expect(ranked.indexOf("approved")).toBeLessThan(ranked.indexOf("refunded"));
    expect(ranked.indexOf("refunded")).toBeLessThan(ranked.indexOf("voided"));
  });

  it("maps every documented Wompi status and treats anything else as unknown", () => {
    expect(mapWompiTransactionStatus("APPROVED")).toBe("approved");
    expect(mapWompiTransactionStatus("declined")).toBe("declined");
    expect(mapWompiTransactionStatus("  VOIDED ")).toBe("voided");
    expect(mapWompiTransactionStatus("CHARGEBACK")).toBe("unknown");
  });

  it("classifies which statuses mean the attempt will not be paid", () => {
    expect(isFailedPaymentStatus("declined")).toBe(true);
    expect(isFailedPaymentStatus("voided")).toBe(true);
    expect(isFailedPaymentStatus("error")).toBe(true);
    expect(isFailedPaymentStatus("refunded")).toBe(true);
    expect(isFailedPaymentStatus("pending")).toBe(false);
    expect(isFailedPaymentStatus("approved")).toBe(false);
  });
});

describe("confirmation vocabulary", () => {
  it("exposes a closed set of results and reasons", () => {
    expect(CONFIRMATION_RESULTS).toEqual(["APPLIED", "DUPLICATE", "RECONCILIATION_REQUIRED"]);
    expect(isConfirmationResult("APPLIED")).toBe(true);
    expect(isConfirmationResult("SOMETHING_ELSE")).toBe(false);
    expect(isConfirmationReason("PAYMENT_APPROVED")).toBe(true);
    expect(isConfirmationReason("NOPE")).toBe(false);
  });

  it("flags only reconciliation outcomes for human review", () => {
    expect(requiresOperatorReview("RECONCILIATION_REQUIRED")).toBe(true);
    expect(requiresOperatorReview("APPLIED")).toBe(false);
    expect(requiresOperatorReview("DUPLICATE")).toBe(false);
  });

  it("bounds and flattens a provider status message", () => {
    expect(boundStatusMessage("  ok  ")).toBe("ok");
    expect(boundStatusMessage("line\nbreak\there")).toBe("line break here");
    expect(boundStatusMessage(undefined)).toBeUndefined();
    expect(boundStatusMessage("   ")).toBeUndefined();
    expect(boundStatusMessage("x".repeat(900))).toHaveLength(MAX_STATUS_MESSAGE_LENGTH);
  });
});
