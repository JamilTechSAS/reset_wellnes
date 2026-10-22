import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  extractTransactionEventPayload,
  parseWompiEventEnvelope,
  verifyWompiEvent,
} from "@shared/integrations/wompi/events.ts";
import {
  WOMPI_EVENT_CHECKSUM_HEADER,
  WOMPI_EVENT_RETRY_SCHEDULE_MINUTES,
} from "@shared/integrations/wompi/types.ts";
import { mapWompiTransactionStatus } from "@shared/domain/payment-status.ts";

const EVENTS_SECRET = "test_events_FAKE_SECRET_FOR_TESTS_ONLY";

/** Independent SHA-256 (Node) used to sign fixtures, not the production implementation. */
function sha256HexWithNode(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

type TransactionData = Record<string, unknown>;

const TRANSACTION: TransactionData = {
  id: "1234-1610641025-49201",
  reference: "EVT-2026-000001",
  status: "APPROVED",
  amount_in_cents: 9_500_000,
  currency: "COP",
  customer_email: "maria@example.com",
  payment_method_type: "CARD",
};

function resolve(data: TransactionData, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, segment) =>
        typeof current === "object" && current !== null
          ? (current as TransactionData)[segment]
          : undefined,
      data,
    );
}

type SignOptions = {
  readonly properties?: readonly string[];
  readonly timestamp?: number;
  readonly data?: TransactionData;
  readonly secret?: string;
  /** Uppercase the checksum on purpose: Wompi's docs show both cases. */
  readonly uppercase?: boolean;
};

function signEvent(options: SignOptions = {}): { body: Record<string, unknown>; checksum: string } {
  const properties = options.properties ?? [
    "transaction.id",
    "transaction.status",
    "transaction.amount_in_cents",
  ];
  const data = options.data ?? { transaction: TRANSACTION };
  const timestamp = options.timestamp ?? 1_530_291_411;
  const secret = options.secret ?? EVENTS_SECRET;

  const payload = `${properties.map((path) => String(resolve(data, path))).join("")}${String(timestamp)}${secret}`;
  const checksum = sha256HexWithNode(payload);
  return {
    body: {
      event: "transaction.updated",
      data,
      sent_at: "2026-10-03T15:45:05.000Z",
      signature: {
        properties,
        checksum: options.uppercase === true ? checksum.toUpperCase() : checksum,
        timestamp,
      },
    },
    checksum,
  };
}

describe("Wompi event verification", () => {
  it("accepts a correctly signed transaction.updated event", async () => {
    const { body, checksum } = signEvent({ uppercase: true });
    const result = await verifyWompiEvent({ rawBody: body, eventsSecret: EVENTS_SECRET });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.checksumUsed).toBe("body");
    expect(result.envelope.event).toBe("transaction.updated");
    expect(result.envelope.signature.timestamp).toBe(1_530_291_411);

    const transaction = extractTransactionEventPayload(result.envelope);
    expect(transaction).toEqual({
      id: "1234-1610641025-49201",
      reference: "EVT-2026-000001",
      status: "APPROVED",
      amountInCents: 9_500_000,
      currency: "COP",
      customerEmail: "maria@example.com",
      paymentMethodType: "CARD",
    });
    expect(checksum).toBe(result.envelope.signature.checksum.toLowerCase());
  });

  it("accepts the checksum from the X-Event-Checksum header as documented", async () => {
    const { body, checksum } = signEvent();
    // Tamper with the body copy while the header keeps the authentic value.
    body.signature = { ...(body.signature as object), checksum: "0".repeat(64) };

    const result = await verifyWompiEvent({
      rawBody: body,
      eventsSecret: EVENTS_SECRET,
      headerChecksum: checksum.toUpperCase(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checksumUsed).toBe("header");
    }
    expect(WOMPI_EVENT_CHECKSUM_HEADER).toBe("x-event-checksum");
  });

  it("follows the property order sent by Wompi instead of assuming one", async () => {
    const properties = ["transaction.status", "transaction.reference", "transaction.currency"];
    const { body } = signEvent({ properties });

    const result = await verifyWompiEvent({ rawBody: body, eventsSecret: EVENTS_SECRET });
    expect(result.ok).toBe(true);

    // Same data, different order -> different digest -> rejected. That proves the
    // property list is not hardcoded anywhere.
    const reordered = signEvent({ properties: [...properties].reverse() });
    const reorderedResult = await verifyWompiEvent({
      rawBody: reordered.body,
      eventsSecret: EVENTS_SECRET,
    });
    expect(reorderedResult.ok).toBe(true);

    const mismatchedBody = {
      ...body,
      signature: { ...(body.signature as object), checksum: reordered.checksum },
    };
    const mismatch = await verifyWompiEvent({
      rawBody: mismatchedBody,
      eventsSecret: EVENTS_SECRET,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.reason).toBe("CHECKSUM_MISMATCH");
    }
  });

  it("rejects a tampered amount", async () => {
    const { body } = signEvent();
    const tampered = {
      ...body,
      data: { transaction: { ...TRANSACTION, amount_in_cents: 1 } },
    };
    const result = await verifyWompiEvent({ rawBody: tampered, eventsSecret: EVENTS_SECRET });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CHECKSUM_MISMATCH");
    }
  });

  it("rejects an event signed with a different secret", async () => {
    const { body } = signEvent({ secret: "test_events_ATTACKER_SECRET" });
    const result = await verifyWompiEvent({ rawBody: body, eventsSecret: EVENTS_SECRET });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed bodies and missing signatures", async () => {
    const cases: readonly unknown[] = [
      null,
      {},
      { event: "transaction.updated" },
      { event: "transaction.updated", data: {}, signature: {} },
      {
        event: "transaction.updated",
        data: {},
        signature: { properties: [], checksum: "x", timestamp: 1 },
      },
      {
        event: "transaction.updated",
        data: {},
        signature: { properties: ["a"], checksum: "", timestamp: 1 },
      },
      {
        event: "transaction.updated",
        data: {},
        signature: { properties: ["a"], checksum: "x", timestamp: "abc" },
      },
      { event: "", data: {}, signature: { properties: ["a"], checksum: "x", timestamp: 1 } },
    ];
    for (const rawBody of cases) {
      const result = await verifyWompiEvent({ rawBody, eventsSecret: EVENTS_SECRET });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects properties that cannot be resolved or stringified deterministically", async () => {
    const missing = signEvent({ properties: ["transaction.id", "transaction.shipping_address"] });
    const missingResult = await verifyWompiEvent({
      rawBody: missing.body,
      eventsSecret: EVENTS_SECRET,
    });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.reason).toBe("UNRESOLVABLE_PROPERTY");
      expect(missingResult.detail).toContain("transaction.shipping_address");
    }

    const floatData: TransactionData = {
      transaction: { ...TRANSACTION, amount_in_cents: 9_500_000.5 },
    };
    const floatResult = await verifyWompiEvent({
      rawBody: signEvent({ properties: ["transaction.amount_in_cents"], data: floatData }).body,
      eventsSecret: EVENTS_SECRET,
    });
    expect(floatResult.ok).toBe(false);

    const objectData: TransactionData = {
      transaction: { ...TRANSACTION, extra: { nested: true } },
    };
    const objectResult = await verifyWompiEvent({
      rawBody: signEvent({ properties: ["transaction.extra"], data: objectData }).body,
      eventsSecret: EVENTS_SECRET,
    });
    expect(objectResult.ok).toBe(false);
    if (!objectResult.ok) {
      expect(objectResult.reason).toBe("UNRESOLVABLE_PROPERTY");
    }
  });

  it("never resolves prototype-polluting paths", async () => {
    const polluted = {} as Record<string, unknown>;
    const data = { transaction: TRANSACTION, ["__proto__"]: { polluted: "yes" } };
    const result = await verifyWompiEvent({
      rawBody: signEvent({ properties: ["transaction.__proto__"], data }).body,
      eventsSecret: EVENTS_SECRET,
    });
    expect(result.ok).toBe(false);
    expect(polluted.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const envelope = parseWompiEventEnvelope({
      event: "transaction.updated",
      data,
      signature: { properties: ["transaction.constructor"], checksum: "x", timestamp: 1 },
    });
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const nested = await verifyWompiEvent({
        rawBody: {
          event: "transaction.updated",
          data,
          signature: { properties: ["transaction.constructor"], checksum: "x", timestamp: 1 },
        },
        eventsSecret: EVENTS_SECRET,
      });
      expect(nested.ok).toBe(false);
    }
  });

  it("ignores fields that are not part of the hash", async () => {
    const { body } = signEvent();
    const withNoise = {
      ...body,
      // `sent_at` is the first-notification time and is NOT hashed; extra unknown fields
      // are ignored by the parser as well.
      sent_at: "2030-01-01T00:00:00.000Z",
      unexpected: { note: "Wompi may add fields; they must not break verification" },
    };
    const result = await verifyWompiEvent({ rawBody: withNoise, eventsSecret: EVENTS_SECRET });
    expect(result.ok).toBe(true);
  });

  it("accepts a numeric timestamp sent as a string and unknown event names", async () => {
    const { body } = signEvent({ timestamp: 1_530_291_411 });
    const signature = body.signature as Record<string, unknown>;
    const stringTimestamp = {
      ...body,
      signature: { ...signature, timestamp: "1530291411" },
    };
    const result = await verifyWompiEvent({
      rawBody: stringTimestamp,
      eventsSecret: EVENTS_SECRET,
    });
    expect(result.ok).toBe(true);

    const other = signEvent();
    const otherBody = { ...other.body, event: "some.future.event.type" };
    const otherResult = await verifyWompiEvent({ rawBody: otherBody, eventsSecret: EVENTS_SECRET });
    expect(otherResult.ok).toBe(true);
    if (otherResult.ok) {
      // Unknown event types verify (their signature is valid) but carry no transaction.
      expect(extractTransactionEventPayload(otherResult.envelope)).toBeUndefined();
    }
  });

  it("maps a status we do not know yet to `unknown` instead of trusting it", async () => {
    const data: TransactionData = { transaction: { ...TRANSACTION, status: "REFUNDED" } };
    const { body } = signEvent({ properties: ["transaction.id", "transaction.status"], data });
    const result = await verifyWompiEvent({ rawBody: body, eventsSecret: EVENTS_SECRET });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const transaction = extractTransactionEventPayload(result.envelope);
    expect(transaction?.status).toBe("REFUNDED");
    expect(mapWompiTransactionStatus(transaction?.status ?? "")).toBe("unknown");
  });

  it("records the documented retry schedule for operators", () => {
    expect([...WOMPI_EVENT_RETRY_SCHEDULE_MINUTES]).toEqual([30, 180, 1440]);
  });
});
