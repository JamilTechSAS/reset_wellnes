import { describe, expect, it, vi } from "vitest";

import { AppError } from "@shared/domain/errors.ts";
import {
  createLogger,
  isSensitiveKey,
  maskEmail,
  maskPhone,
  REDACTED,
  redactForLog,
} from "@shared/logging/logger.ts";

describe("log redaction", () => {
  it("flags sensitive keys, in any casing and nesting position", () => {
    for (const key of [
      "password",
      "secret",
      "wompiPrivateKey",
      "integritySecret",
      "events_secret",
      "authorization",
      "token",
      "apiKey",
      "nationalId",
      "cedula",
      "legal_id",
      "email",
      "customerEmail",
      "phone",
      "cardNumber",
      "cvv",
      "signature",
      "checksum",
      "cookie",
    ]) {
      expect(isSensitiveKey(key), `${key} should be treated as sensitive`).toBe(true);
    }
    for (const key of ["orderId", "reference", "ticketId", "status", "amountInCents", "city"]) {
      expect(isSensitiveKey(key), `${key} should be loggable`).toBe(false);
    }
  });

  it("masks emails and phones so support can identify a participant without storing them in logs", () => {
    expect(maskEmail("maria@example.com")).toBe("m***@example.com");
    expect(maskEmail("no-at-sign")).toBe(REDACTED);
    expect(maskPhone("573019777777")).toBe("573***7777");
    expect(maskPhone("12345")).toBe(REDACTED);
  });

  it("replaces sensitive values at any depth", () => {
    const redacted = redactForLog({
      orderId: "order_1",
      customer: {
        email: "maria@example.com",
        phone: "+57 301 977 7777",
        nationalId: "1020456789",
        city: "Bogotá",
      },
      wompi: { privateKey: "prv_test_super_secret", reference: "EVT-2026-000001" },
      consents: { dataProcessing: true },
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("prv_test_super_secret");
    expect(serialized).not.toContain("1020456789");
    expect(serialized).not.toContain("maria@example.com");
    expect(serialized).not.toContain("3019777777");
    expect(serialized).toContain("order_1");
    expect(serialized).toContain("EVT-2026-000001");
    expect(serialized).toContain("Bogotá");
    expect((redacted.customer as Record<string, unknown>).email).toBe("m***@example.com");
  });

  it("bounds depth, breadth and string length", () => {
    const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
    expect(JSON.stringify(redactForLog(deep))).not.toContain("too deep");

    const wide = { items: Array.from({ length: 100 }, (_, index) => index) };
    const redactedWide = redactForLog(wide) as { items: number[] };
    expect(redactedWide.items.length).toBeLessThanOrEqual(20);

    const long = { note: "x".repeat(1_000) };
    expect(JSON.stringify(redactForLog(long))).toContain("truncated");

    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => JSON.stringify(redactForLog(circular))).not.toThrow();
  });

  it("describes errors with code and context but without payloads", () => {
    const error = new AppError("CONFLICT", "order already paid", {
      context: { orderId: "order_1", customerEmail: "maria@example.com" },
    });
    const described = redactForLog({ error }) as { error: Record<string, unknown> };
    expect(described.error.name).toBe("AppError");
    expect(described.error.code).toBe("CONFLICT");
    expect(JSON.stringify(described)).not.toContain("maria@example.com");
    expect(JSON.stringify(described)).toContain("order_1");
  });
});

describe("structured logger", () => {
  function capture() {
    const lines: string[] = [];
    return {
      lines,
      sink: (line: string) => {
        lines.push(line);
      },
    };
  }

  it("emits one JSON line per event with service and environment", () => {
    const { lines, sink } = capture();
    const logger = createLogger({
      service: "event-ticketing",
      environment: "sandbox",
      level: "info",
      sink,
    });

    logger.info("webhook received", { requestId: "req_1", orderId: "order_1" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: "info",
      service: "event-ticketing",
      env: "sandbox",
      msg: "webhook received",
      requestId: "req_1",
      orderId: "order_1",
    });
    expect(typeof parsed.ts).toBe("string");
  });

  it("honours the level threshold", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ service: "s", environment: "production", level: "warn", sink });
    logger.debug("hidden");
    logger.info("hidden too");
    logger.warn("visible");
    logger.error("visible");
    expect(lines).toHaveLength(2);
  });

  it("redacts sensitive fields and carries context into children", () => {
    const { lines, sink } = capture();
    const logger = createLogger({
      service: "s",
      environment: "sandbox",
      level: "info",
      sink,
    }).child({
      orderId: "order_1",
    });

    logger.error("payment failed", {
      privateKey: "prv_test_secret",
      customerEmail: "maria@example.com",
      wompiReference: "EVT-2026-000001",
    });

    const line = lines[0]!;
    expect(line).not.toContain("prv_test_secret");
    expect(line).not.toContain("maria@example.com");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.orderId).toBe("order_1");
    expect(parsed.wompiReference).toBe("EVT-2026-000001");
  });

  it("never throws when the sink fails", () => {
    const sink = vi.fn(() => {
      throw new Error("stdout closed");
    });
    const logger = createLogger({ service: "s", environment: "sandbox", level: "info", sink });
    expect(() => {
      logger.info("still fine");
    }).not.toThrow();
  });
});
