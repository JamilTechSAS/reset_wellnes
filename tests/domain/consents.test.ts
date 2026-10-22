import { describe, expect, it } from "vitest";

import { AppError } from "@shared/domain/errors.ts";
import {
  assertDataProcessingConsent,
  buildConsentRecords,
  DEFAULT_CONSENT_POLICY_VERSION,
  describeConsentForExport,
  findLatestConsent,
  isIsoTimestamp,
} from "@shared/domain/consents.ts";

const CAPTURED_AT = "2026-10-03T15:30:00.000Z";

describe("consents", () => {
  it("records value, timestamp and policy version for both consents", () => {
    const records = buildConsentRecords(
      { dataProcessing: true, futureEvents: false },
      { capturedAt: CAPTURED_AT },
    );

    expect(records).toEqual([
      {
        kind: "DATA_PROCESSING",
        granted: true,
        policyVersion: DEFAULT_CONSENT_POLICY_VERSION,
        capturedAt: CAPTURED_AT,
      },
      {
        kind: "FUTURE_EVENTS",
        granted: false,
        policyVersion: DEFAULT_CONSENT_POLICY_VERSION,
        capturedAt: CAPTURED_AT,
      },
    ]);
  });

  it("never stores a bare boolean: a timestamp is required", () => {
    for (const record of buildConsentRecords(
      { dataProcessing: true, futureEvents: true },
      { capturedAt: CAPTURED_AT },
    )) {
      expect(record.capturedAt).toBe(CAPTURED_AT);
      expect(record.policyVersion.length).toBeGreaterThan(0);
    }
  });

  it("accepts an explicit policy version", () => {
    const [record] = buildConsentRecords(
      { dataProcessing: true, futureEvents: true },
      { capturedAt: CAPTURED_AT, policyVersion: "2027-v2" },
    );
    expect(record?.policyVersion).toBe("2027-v2");
  });

  it("rejects a malformed timestamp instead of storing an unusable record", () => {
    expect(() =>
      buildConsentRecords(
        { dataProcessing: true, futureEvents: false },
        { capturedAt: "03/10/2026" },
      ),
    ).toThrow(AppError);
    expect(isIsoTimestamp(CAPTURED_AT)).toBe(true);
    expect(isIsoTimestamp("2026-10-03")).toBe(false);
  });

  it("requires personal data consent to complete a purchase", () => {
    expect(() => {
      assertDataProcessingConsent({ dataProcessing: true, futureEvents: false });
    }).not.toThrow();

    try {
      assertDataProcessingConsent({ dataProcessing: false, futureEvents: true });
      expect.unreachable("missing consent must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("keeps an append-only history and resolves the latest decision", () => {
    const granted = buildConsentRecords(
      { dataProcessing: true, futureEvents: true },
      { capturedAt: "2026-10-01T10:00:00.000Z" },
    );
    const withdrawn = buildConsentRecords(
      { dataProcessing: true, futureEvents: false },
      { capturedAt: "2026-11-01T10:00:00.000Z" },
    );
    const history = [...granted, ...withdrawn];

    const latest = findLatestConsent(history, "FUTURE_EVENTS");
    expect(latest?.granted).toBe(false);
    expect(latest?.capturedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(findLatestConsent(history, "DATA_PROCESSING")?.granted).toBe(true);
  });

  it("describes consent state in Spanish for the operator export", () => {
    const [granted, declined] = buildConsentRecords(
      { dataProcessing: true, futureEvents: false },
      { capturedAt: CAPTURED_AT },
    );
    expect(describeConsentForExport(granted)).toContain("Sí");
    expect(describeConsentForExport(declined)).toContain("No");
    expect(describeConsentForExport(undefined)).toBe("Sin registro");
  });
});
