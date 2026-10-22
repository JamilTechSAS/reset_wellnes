import { describe, expect, it } from "vitest";

import {
  failureForResult,
  isReconciliationFailure,
  isReconciliationResult,
  isTerminalReconciliationResult,
  mapSweepOutcome,
  RECONCILIATION_DEFAULTS,
  RECONCILIATION_DELAY_SECONDS,
  RECONCILIATION_FAILURES,
  RECONCILIATION_RESULTS,
  reconciliationDelaySeconds,
  requiresReconciliationReview,
  TERMINAL_RECONCILIATION_RESULTS,
} from "@shared/domain/reconciliation.ts";

describe("reconciliation vocabulary", () => {
  it("closes the result and failure sets the database CHECK constraints mirror", () => {
    expect([...RECONCILIATION_RESULTS]).toEqual([
      "APPROVED_APPLIED",
      "APPROVED_DUPLICATE",
      "RECONCILIATION_REQUIRED",
      "STILL_PENDING",
      "DECLINED",
      "VOIDED",
      "ERROR",
      "UNKNOWN_STATUS",
      "MISMATCH",
      "NOT_FOUND_AT_PROVIDER",
      "UPSTREAM_ERROR",
    ]);
    expect([...RECONCILIATION_FAILURES]).toEqual([
      "UPSTREAM_ERROR",
      "VALIDATION_MISMATCH",
      "PROVIDER_NOT_FOUND",
      "CONFIRMATION_FAILED",
    ]);

    expect(isReconciliationResult("APPROVED_APPLIED")).toBe(true);
    expect(isReconciliationResult("NOT_A_RESULT")).toBe(false);
    expect(isReconciliationFailure("VALIDATION_MISMATCH")).toBe(true);
    expect(isReconciliationFailure("whatever")).toBe(false);
  });

  it("classifies a retryable result as non-terminal and an outcome as terminal", () => {
    for (const retryable of ["STILL_PENDING", "UNKNOWN_STATUS", "UPSTREAM_ERROR"] as const) {
      expect(TERMINAL_RECONCILIATION_RESULTS).not.toContain(retryable);
      expect(isTerminalReconciliationResult(retryable)).toBe(false);
    }
    for (const terminal of [
      "APPROVED_APPLIED",
      "APPROVED_DUPLICATE",
      "RECONCILIATION_REQUIRED",
      "DECLINED",
      "VOIDED",
      "ERROR",
      "MISMATCH",
      "NOT_FOUND_AT_PROVIDER",
    ] as const) {
      expect(isTerminalReconciliationResult(terminal)).toBe(true);
    }
  });

  it("names the failure classification for every result that needs one", () => {
    expect(failureForResult("MISMATCH")).toBe("VALIDATION_MISMATCH");
    expect(failureForResult("NOT_FOUND_AT_PROVIDER")).toBe("PROVIDER_NOT_FOUND");
    expect(failureForResult("UPSTREAM_ERROR")).toBe("UPSTREAM_ERROR");
    expect(failureForResult("APPROVED_APPLIED")).toBeUndefined();
    expect(failureForResult("STILL_PENDING")).toBeUndefined();
  });

  it("flags exactly the results an operator must see", () => {
    expect(requiresReconciliationReview("RECONCILIATION_REQUIRED")).toBe(true);
    expect(requiresReconciliationReview("MISMATCH")).toBe(true);
    expect(requiresReconciliationReview("NOT_FOUND_AT_PROVIDER")).toBe(true);
    for (const quiet of [
      "APPROVED_APPLIED",
      "APPROVED_DUPLICATE",
      "STILL_PENDING",
      "DECLINED",
      "VOIDED",
      "ERROR",
      "UNKNOWN_STATUS",
      "UPSTREAM_ERROR",
    ] as const) {
      expect(requiresReconciliationReview(quiet)).toBe(false);
    }
  });

  it("keeps the documented bounded defaults", () => {
    expect(RECONCILIATION_DEFAULTS.batchSize).toBeGreaterThan(0);
    expect(RECONCILIATION_DEFAULTS.batchSize).toBeLessThanOrEqual(50);
    expect(RECONCILIATION_DEFAULTS.maxAttempts).toBeGreaterThan(0);
    expect(RECONCILIATION_DEFAULTS.maxAttempts).toBeLessThanOrEqual(20);
    expect(RECONCILIATION_DEFAULTS.upstreamRetryDelaySeconds).toBeGreaterThan(0);
  });

  it("follows a strictly non-decreasing backoff schedule and clamps at both ends", () => {
    expect([...RECONCILIATION_DELAY_SECONDS]).toEqual([
      120, 300, 900, 3600, 10800, 21600, 43200, 86400,
    ]);
    for (let index = 1; index < RECONCILIATION_DELAY_SECONDS.length; index += 1) {
      expect(RECONCILIATION_DELAY_SECONDS[index]!).toBeGreaterThan(
        RECONCILIATION_DELAY_SECONDS[index - 1]!,
      );
    }
    expect(reconciliationDelaySeconds(1)).toBe(120);
    expect(reconciliationDelaySeconds(8)).toBe(86400);
    expect(reconciliationDelaySeconds(100)).toBe(86400);
    expect(reconciliationDelaySeconds(0)).toBe(120);
    expect(reconciliationDelaySeconds(2.7)).toBe(300);
  });
});

describe("mapSweepOutcome", () => {
  it("turns an approved transaction into applied/duplicate from the confirmation", () => {
    expect(mapSweepOutcome({ providerStatus: "APPROVED", confirmation: "APPLIED" })).toBe(
      "APPROVED_APPLIED",
    );
    expect(mapSweepOutcome({ providerStatus: "APPROVED", confirmation: "DUPLICATE" })).toBe(
      "APPROVED_DUPLICATE",
    );
  });

  it("never reports an approved transaction as success when no confirmation ran", () => {
    expect(mapSweepOutcome({ providerStatus: "APPROVED", confirmation: undefined })).toBe(
      "UPSTREAM_ERROR",
    );
  });

  it("passes the review outcome through untouched", () => {
    expect(
      mapSweepOutcome({ providerStatus: "APPROVED", confirmation: "RECONCILIATION_REQUIRED" }),
    ).toBe("RECONCILIATION_REQUIRED");
  });

  it("reports pending provider states as STILL_PENDING, however the confirmation answered", () => {
    expect(mapSweepOutcome({ providerStatus: "PENDING", confirmation: undefined })).toBe(
      "STILL_PENDING",
    );
    expect(mapSweepOutcome({ providerStatus: "PENDING", confirmation: "APPLIED" })).toBe(
      "STILL_PENDING",
    );
    expect(mapSweepOutcome({ providerStatus: "PENDING", confirmation: "DUPLICATE" })).toBe(
      "STILL_PENDING",
    );
  });

  it("maps the final non-approved statuses to their own results", () => {
    expect(mapSweepOutcome({ providerStatus: "DECLINED", confirmation: "APPLIED" })).toBe(
      "DECLINED",
    );
    expect(mapSweepOutcome({ providerStatus: "DECLINED", confirmation: undefined })).toBe(
      "DECLINED",
    );
    expect(mapSweepOutcome({ providerStatus: "VOIDED", confirmation: "APPLIED" })).toBe("VOIDED");
    expect(mapSweepOutcome({ providerStatus: "ERROR", confirmation: "APPLIED" })).toBe("ERROR");
    // Wompi has no REFUNDED status: an approved-then-voided attempt arrives as
    // VOIDED. Anything else is stored raw and never treated as success.
    expect(mapSweepOutcome({ providerStatus: "REFUNDED", confirmation: undefined })).toBe(
      "UNKNOWN_STATUS",
    );
  });

  it("stores an unrecognized provider status raw and never as success", () => {
    expect(mapSweepOutcome({ providerStatus: "SOMETHING_NEW", confirmation: undefined })).toBe(
      "UNKNOWN_STATUS",
    );
    expect(mapSweepOutcome({ providerStatus: "SOMETHING_NEW", confirmation: "APPLIED" })).toBe(
      "UNKNOWN_STATUS",
    );
  });
});
