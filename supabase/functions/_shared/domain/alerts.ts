/**
 * Operational alerts (H8): the closed vocabulary, the mapping from payment outcomes to alerts,
 * and the notification digest.
 *
 * An alert names WHAT needs a human and WHERE (order reference, payment id, provider) and
 * nothing else: no provider payloads, buyer names, emails, documents or amounts. Deduplication
 * is by `dedupeKey` in the database (`record_operational_alert`), so a webhook redelivery or a
 * repeated sweep raises the same alert again only as another occurrence.
 */

export const ALERT_KINDS = [
  "PAYMENT_REVERSED_AFTER_APPROVAL",
  "LATE_APPROVAL",
  "PAYMENT_CONFLICT",
  "PROVIDER_RECORD_MISMATCH",
  "RECONCILIATION_MISMATCH",
  "PROVIDER_NOT_FOUND",
  "REPEATED_PROVIDER_FAILURE",
  "UNRESOLVED_PAYMENT",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertSeverity = "critical" | "warning";

/** Severity is fixed per kind: money moved without a matching ticket outcome is critical. */
export const ALERT_SEVERITY: Readonly<Record<AlertKind, AlertSeverity>> = {
  PAYMENT_REVERSED_AFTER_APPROVAL: "critical",
  LATE_APPROVAL: "critical",
  PAYMENT_CONFLICT: "critical",
  PROVIDER_RECORD_MISMATCH: "warning",
  RECONCILIATION_MISMATCH: "warning",
  PROVIDER_NOT_FOUND: "warning",
  REPEATED_PROVIDER_FAILURE: "warning",
  UNRESOLVED_PAYMENT: "warning",
};

const ALERT_LABEL: Readonly<Record<AlertKind, string>> = {
  PAYMENT_REVERSED_AFTER_APPROVAL:
    "Pago reversado después de aprobado (orden pagada con entradas activas)",
  LATE_APPROVAL: "Pago aprobado para una orden que ya no se podía pagar",
  PAYMENT_CONFLICT: "Pago aprobado rechazado por conflicto de transacción o referencia",
  PROVIDER_RECORD_MISMATCH: "Notificación del proveedor contradice su propio registro",
  RECONCILIATION_MISMATCH: "La transacción del proveedor no coincide con la orden",
  PROVIDER_NOT_FOUND: "El proveedor no reconoce una transacción registrada",
  REPEATED_PROVIDER_FAILURE: "Fallos repetidos al consultar o confirmar un pago",
  UNRESOLVED_PAYMENT: "Pago sin resolver tras agotar la conciliación automática",
};

/** Consecutive failed sweeps of one attempt before it becomes an alert. */
export const REPEATED_FAILURE_THRESHOLD = 3;

export type AlertInput = {
  readonly kind: AlertKind;
  /** Stable identity of the situation, e.g. `reversal:<paymentId>`. */
  readonly dedupeKey: string;
  readonly orderReference?: string | undefined;
  readonly paymentId?: string | undefined;
  readonly provider?: "wompi" | "epayco" | undefined;
  /** Short, code-like context (letters, digits, `_:,. -`); anything else is dropped. */
  readonly detail?: string | undefined;
};

const ORDER_REFERENCE = /^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]{1,3})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DETAIL = /^[A-Za-z0-9_:,. -]{1,200}$/;

/**
 * Keeps only values that match the ledger's own constraints, so an alert can never be lost to a
 * CHECK violation and never carries free text from a provider or a buyer.
 */
export function sanitizeAlert(input: AlertInput): AlertInput {
  return {
    kind: input.kind,
    // The ledger accepts printable ASCII only (8-200 chars); a provider id with spaces or
    // non-ASCII characters must not make the alert unrecordable.
    dedupeKey: input.dedupeKey
      .replace(/[^!-~]/g, "_")
      .padEnd(8, "_")
      .slice(0, 200),
    orderReference:
      input.orderReference !== undefined && ORDER_REFERENCE.test(input.orderReference)
        ? input.orderReference
        : undefined,
    paymentId:
      input.paymentId !== undefined && UUID.test(input.paymentId) ? input.paymentId : undefined,
    provider: input.provider,
    detail: input.detail !== undefined && DETAIL.test(input.detail) ? input.detail : undefined,
  };
}

/** Alert for a `confirm_payment` RECONCILIATION_REQUIRED result, or undefined. */
export function alertForConfirmation(input: {
  readonly result: string;
  readonly reason: string;
  readonly orderReference: string;
  readonly paymentId: string;
  readonly provider: "wompi" | "epayco";
}): AlertInput | undefined {
  if (input.result !== "RECONCILIATION_REQUIRED") {
    return undefined;
  }
  const kind: AlertKind =
    input.reason === "PAYMENT_REVERSED_AFTER_APPROVAL"
      ? "PAYMENT_REVERSED_AFTER_APPROVAL"
      : "LATE_APPROVAL";
  return {
    kind,
    dedupeKey: `${kind === "LATE_APPROVAL" ? "late" : "reversal"}:${input.paymentId}`,
    orderReference: input.orderReference,
    paymentId: input.paymentId,
    provider: input.provider,
    detail: input.reason,
  };
}

/** The SQL function's own refusal codes (`REFERENCE_MISMATCH`, `AMOUNT_MISMATCH`, …). */
const REFUSAL_REASON = /^[A-Za-z0-9_]{1,40}$/;

/**
 * Alert for a signed, provider-verified APPROVAL that `confirm_payment` refused with a conflict,
 * or undefined.
 *
 * The delivery is authentic and the money moved, but the order could not take it: without this
 * alert the situation would only exist in the logs, because the webhook answers 200 to stop
 * ePayco's retries. Only `CONFLICT` qualifies (a second transaction under one merchant
 * reference, an amount or currency mismatch): `VALIDATION_ERROR` and `NOT_FOUND` mean a
 * malformed or unknown order, not captured money. The verified record must also say `approved`;
 * a refused decline is expected noise and must not page anyone.
 */
export function alertForApprovalConflict(input: {
  readonly code: string;
  readonly orderReference: string;
  readonly transactionId: string;
  readonly paymentStatus: string;
  readonly eventId?: string | undefined;
  /** `confirm_payment`'s own detail, e.g. `REFERENCE_MISMATCH`; dropped when not code-like. */
  readonly refusalReason?: string | undefined;
}): AlertInput | undefined {
  if (input.code !== "CONFLICT" || input.paymentStatus !== "approved") {
    return undefined;
  }
  const transactionId = input.transactionId.trim();
  const refusalReason = input.refusalReason?.trim();
  return {
    kind: "PAYMENT_CONFLICT",
    // Keyed on the order and the transaction, not on the refusal detail: a redelivery whose
    // reason changed is the same money and must not split into a second alert.
    dedupeKey: `conflict:${input.orderReference}:${transactionId}`,
    orderReference: input.orderReference,
    provider: "epayco",
    // The reason names the refusal, the transaction id identifies the money at the provider and
    // the event id ties the alert to the ledger row. All provider/ledger identifiers, no buyer
    // data and no signature.
    detail:
      `CONFLICT${refusalReason !== undefined && REFUSAL_REASON.test(refusalReason) ? ` ${refusalReason}` : ""}` +
      ` ref ${transactionId}` +
      (input.eventId === undefined ? "" : ` evt ${input.eventId}`),
  };
}

/** A claimed alert, as returned by `claim_alert_notifications`. */
export type ClaimedAlert = {
  readonly alertId: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly orderReference: string | null;
  readonly paymentId: string | null;
  readonly provider: string | null;
  readonly detail: string | null;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** One digest message for a batch of alerts: subject, plain text and HTML. */
export function buildAlertDigest(input: {
  readonly alerts: readonly ClaimedAlert[];
  readonly serviceName: string;
  readonly environment: string;
}): { readonly subject: string; readonly text: string; readonly html: string } {
  const critical = input.alerts.filter((alert) => alert.severity === "critical").length;
  const subject =
    `[${input.environment}] ${String(input.alerts.length)} alerta(s) de pagos` +
    (critical > 0 ? ` — ${String(critical)} crítica(s)` : "");

  const lines = input.alerts.map((alert) => {
    const parts = [
      alert.severity === "critical" ? "CRÍTICA" : "Aviso",
      ALERT_LABEL[alert.kind],
      alert.orderReference === null ? "sin orden" : `orden ${alert.orderReference}`,
      alert.provider === null ? undefined : `proveedor ${alert.provider}`,
      alert.detail ?? undefined,
      alert.occurrences > 1 ? `${String(alert.occurrences)} veces` : undefined,
      `desde ${alert.firstSeenAt}`,
    ].filter((part): part is string => part !== undefined);
    return parts.join(" · ");
  });

  const text = [
    `${input.serviceName} (${input.environment}) — pagos que requieren revisión manual:`,
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    "Este aviso no contiene datos personales ni del medio de pago. Revise cada orden en el panel.",
  ].join("\n");

  const html = [
    `<p>${escapeHtml(input.serviceName)} (${escapeHtml(input.environment)}) — pagos que requieren revisión manual:</p>`,
    "<ul>",
    ...lines.map((line) => `<li>${escapeHtml(line)}</li>`),
    "</ul>",
    "<p>Este aviso no contiene datos personales ni del medio de pago. Revise cada orden en el panel.</p>",
  ].join("");

  return { subject, text, html };
}
