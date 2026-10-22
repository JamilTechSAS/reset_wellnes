/**
 * Consents.
 *
 * Requirement: never store a bare boolean. Every consent captures WHAT was accepted,
 * WHEN, and under WHICH policy text version, so the client can prove the legal basis
 * for processing personal data (Ley 1581 de 2012 in Colombia).
 *
 * Consent history is append-only: a participant who later withdraws the "future
 * events" consent produces a new record instead of overwriting the original.
 */

import { validationError } from "./errors.ts";

export const CONSENT_KINDS = ["DATA_PROCESSING", "FUTURE_EVENTS"] as const;

export type ConsentKind = (typeof CONSENT_KINDS)[number];

export const CONSENT_KIND_LABELS_ES: Record<ConsentKind, string> = {
  DATA_PROCESSING: "Autorización de tratamiento de datos personales",
  FUTURE_EVENTS: "Autorización para recibir información de próximos eventos",
};

/**
 * Version identifier of the consent text shown to the buyer.
 * Bump it whenever the wording changes, so each record points at the exact text that
 * was accepted. The literal value is a product decision; the mechanism is not.
 */
export const DEFAULT_CONSENT_POLICY_VERSION = "v1";

export type ConsentDecisionInput = {
  readonly dataProcessing: boolean;
  readonly futureEvents: boolean;
};

export type ConsentRecord = {
  readonly kind: ConsentKind;
  /** Whether the consent was granted at `capturedAt`. */
  readonly granted: boolean;
  readonly policyVersion: string;
  /** ISO-8601 timestamp; supplied by the caller so this module stays pure. */
  readonly capturedAt: string;
};

export type BuildConsentRecordsOptions = {
  readonly capturedAt: string;
  readonly policyVersion?: string;
};

/**
 * Consent to personal data processing is mandatory to complete a purchase: without it
 * there is no lawful basis to store the participant's data at all.
 */
export function assertDataProcessingConsent(input: ConsentDecisionInput): void {
  if (!input.dataProcessing) {
    throw validationError("Consent to personal data processing is required to complete the order", {
      context: { consentKind: "DATA_PROCESSING" },
    });
  }
}

export function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value.includes("T");
}

/**
 * Builds the consent records to persist for one participant or purchase.
 * The optional "future events" consent is always recorded explicitly — including when
 * it is declined — because "we asked and the answer was no" is also evidence.
 */
export function buildConsentRecords(
  input: ConsentDecisionInput,
  options: BuildConsentRecordsOptions,
): readonly ConsentRecord[] {
  if (!isIsoTimestamp(options.capturedAt)) {
    throw validationError("capturedAt must be an ISO-8601 timestamp", {
      context: { capturedAt: options.capturedAt },
    });
  }
  const policyVersion = options.policyVersion ?? DEFAULT_CONSENT_POLICY_VERSION;
  return [
    {
      kind: "DATA_PROCESSING",
      granted: input.dataProcessing,
      policyVersion,
      capturedAt: options.capturedAt,
    },
    {
      kind: "FUTURE_EVENTS",
      granted: input.futureEvents,
      policyVersion,
      capturedAt: options.capturedAt,
    },
  ];
}

/** Latest decision for a kind, given append-only history. */
export function findLatestConsent(
  records: readonly ConsentRecord[],
  kind: ConsentKind,
): ConsentRecord | undefined {
  let latest: ConsentRecord | undefined;
  for (const record of records) {
    if (record.kind !== kind) {
      continue;
    }
    if (latest === undefined || Date.parse(record.capturedAt) >= Date.parse(latest.capturedAt)) {
      latest = record;
    }
  }
  return latest;
}

/** Spanish label used by the Google Sheets operational export. */
export function describeConsentForExport(record: ConsentRecord | undefined): string {
  if (record === undefined) {
    return "Sin registro";
  }
  return record.granted
    ? `Sí (${record.policyVersion}, ${record.capturedAt})`
    : `No (${record.policyVersion}, ${record.capturedAt})`;
}
