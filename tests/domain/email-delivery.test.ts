import { describe, expect, it } from "vitest";

import {
  buildEmailIdempotencyKey,
  canAttemptEmailSend,
  computeEmailRetryDelayMs,
  EMAIL_DELIVERY_STATUSES,
  EMAIL_TEMPLATES,
  isRetryableDeliveryStatus,
  isFinalDeliveryStatus,
  MAX_EMAIL_SEND_ATTEMPTS,
} from "@shared/domain/email-delivery.ts";

describe("email delivery bookkeeping", () => {
  it("builds one stable idempotency key per ticket and template", () => {
    const key = buildEmailIdempotencyKey({ ticketId: "TKT_ABC", template: "TICKET_CONFIRMATION" });
    expect(key).toBe("ticket:TKT_ABC:TICKET_CONFIRMATION");
    // Same inputs always produce the same key: that is what makes the unique constraint
    // able to stop a duplicate send caused by a repeated Wompi webhook.
    expect(buildEmailIdempotencyKey({ ticketId: "TKT_ABC", template: "TICKET_CONFIRMATION" })).toBe(
      key,
    );
    // Different tickets or templates must never collide.
    expect(
      buildEmailIdempotencyKey({ ticketId: "TKT_ABC2", template: "TICKET_CONFIRMATION" }),
    ).not.toBe(key);
    for (const template of EMAIL_TEMPLATES) {
      expect(buildEmailIdempotencyKey({ ticketId: "TKT_ABC", template })).toContain(template);
    }
  });

  it("rejects an empty ticket id", () => {
    expect(() =>
      buildEmailIdempotencyKey({ ticketId: "  ", template: "TICKET_CONFIRMATION" }),
    ).toThrow(RangeError);
  });

  it("classifies final and retryable statuses", () => {
    expect(EMAIL_DELIVERY_STATUSES).toHaveLength(5);
    expect(isFinalDeliveryStatus("SENT")).toBe(true);
    expect(isFinalDeliveryStatus("CANCELLED")).toBe(true);
    expect(isFinalDeliveryStatus("FAILED")).toBe(false);
    expect(isRetryableDeliveryStatus("FAILED")).toBe(true);
    expect(isRetryableDeliveryStatus("QUEUED")).toBe(true);
    expect(isRetryableDeliveryStatus("SENT")).toBe(false);
    expect(isRetryableDeliveryStatus("SENDING")).toBe(false);
  });

  it("uses bounded, increasing backoff and then stops", () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => computeEmailRetryDelayMs(attempt));
    expect(delays[0]).toBe(60_000);
    for (let index = 1; index < delays.length; index += 1) {
      const previous = delays[index - 1] ?? 0;
      const current = delays[index] ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
      expect(current).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    }
    expect(() => computeEmailRetryDelayMs(0)).toThrow(RangeError);

    expect(canAttemptEmailSend(0)).toBe(true);
    expect(canAttemptEmailSend(MAX_EMAIL_SEND_ATTEMPTS - 1)).toBe(true);
    expect(canAttemptEmailSend(MAX_EMAIL_SEND_ATTEMPTS)).toBe(false);
  });
});
