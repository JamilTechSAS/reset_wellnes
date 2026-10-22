/**
 * Google Sheets projection: column layout, formatting and retry policy.
 *
 * Google Sheets is a READ-ORIENTED operational view of PostgreSQL, never a backend. This
 * module turns rows of `public.operational_export` (raw values: enum labels, centavos,
 * timestamptz) into the Spanish, human-readable grid the client's sheet shows. One
 * formatting implementation — the Phase 1 label maps and `domain/money.ts` — so the sheet
 * and the API can never disagree about a status name.
 *
 * Privacy: the projection contains exactly the columns the client needs operationally
 * (including cédula/email/phone, which the brief requires for the door). It is written to
 * the client's spreadsheet with a service account; the sheet is shared only with the
 * client's Google account. Nothing here is exposed publicly.
 */

import { formatCopCents, copCents, CURRENCY_COP } from "./money.ts";
import { ORDER_STATUS_LABELS_ES, isOrderStatus } from "./order-state.ts";
import { PAYMENT_STATUS_LABELS_ES, isInternalPaymentStatus } from "./payment-status.ts";
import { TICKET_STATUS_LABELS_ES, isTicketStatus } from "./tickets.ts";

/** Parity with `public.sheets_projection_status` (asserted by the schema suite). */
export const SHEET_PROJECTION_STATUSES = ["QUEUED", "SYNCING", "SYNCED", "FAILED"] as const;
export type SheetProjectionStatus = (typeof SHEET_PROJECTION_STATUSES)[number];

export const SHEETS_DEFAULT_DATA_SHEET = "Datos";
export const SHEETS_DEFAULT_STATUS_SHEET = "Estado";

/** Retry policy for the outbox worker; attempt_count starts at 1 for the first try. */
export const SHEETS_MAX_ATTEMPTS = 6;
export const SHEETS_CLAIM_BATCH_SIZE = 50;
export const SHEETS_MAX_ROWS = 5000;
const SHEETS_RETRY_DELAY_SECONDS = [60, 300, 900, 3600, 21600] as const;

export function sheetsRetryDelaySeconds(attemptCount: number): number {
  const index = Math.min(Math.max(Math.trunc(attemptCount), 1), SHEETS_RETRY_DELAY_SECONDS.length);
  return SHEETS_RETRY_DELAY_SECONDS[index - 1] ?? SHEETS_RETRY_DELAY_SECONDS[0];
}

/**
 * One row of `public.operational_export`, typed by the exact column names of the view.
 * The generator emits these Spanish identifiers; the mapping below is the only place that
 * knows the layout.
 */
export type OperationalExportRow = {
  readonly Evento: string | null;
  readonly "Código de entrada": string | null;
  readonly Nombre: string | null;
  readonly Apellido: string | null;
  readonly Cédula: string | null;
  readonly Correo: string | null;
  readonly Teléfono: string | null;
  readonly Ciudad: string | null;
  readonly Instagram: string | null;
  readonly "Tipo de entrada": string | null;
  readonly "Etapa de venta": string | null;
  readonly "Precio centavos": number | null;
  readonly Moneda: string | null;
  readonly "Referencia de la orden": string | null;
  readonly "Estado de la orden": string | null;
  readonly "Estado del pago": string | null;
  readonly "Estado Wompi": string | null;
  readonly "Estado de la entrada": string | null;
  readonly Ingreso: boolean | null;
  readonly "Fecha de ingreso": string | null;
  readonly "Autorización de datos": boolean | null;
  readonly "Autorización de datos versión": string | null;
  readonly "Autorización de datos fecha": string | null;
  readonly "Autorización próximos eventos": boolean | null;
  readonly Creada: string | null;
};

export const SHEETS_COLUMN_HEADERS_ES: readonly string[] = [
  "Evento",
  "Código de entrada",
  "Nombre",
  "Apellido",
  "Cédula",
  "Correo",
  "Teléfono",
  "Ciudad",
  "Instagram",
  "Tipo de entrada",
  "Etapa de venta",
  "Precio",
  "Moneda",
  "Referencia de la orden",
  "Estado de la orden",
  "Estado del pago",
  "Estado de la entrada",
  "Ingreso",
  "Fecha de ingreso",
  "Autorización de datos",
  "Autorización próximos eventos",
  "Creada",
];

function labelFor(value: string | null, kind: "order" | "payment" | "ticket"): string {
  if (value === null) {
    return "";
  }
  if (kind === "order" && isOrderStatus(value)) {
    return ORDER_STATUS_LABELS_ES[value];
  }
  if (kind === "payment" && isInternalPaymentStatus(value)) {
    return PAYMENT_STATUS_LABELS_ES[value];
  }
  if (kind === "ticket" && isTicketStatus(value)) {
    return TICKET_STATUS_LABELS_ES[value];
  }
  // A status the TypeScript vocabulary does not know is shown raw instead of hidden: a
  // silently empty cell would hide exactly the row an operator needs to investigate.
  return value;
}

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents === null) {
    return "";
  }
  // `Intl` with es-CO would render "$ 95.000"; the Phase 1 formatter is the single source.
  return currency === CURRENCY_COP ? formatCopCents(copCents(cents)) : String(cents);
}

/** `2026-10-03T12:00:00.000Z` -> `2026-10-03 07:00 America/Bogota`, or empty. */
export function formatTimestampInZone(iso: string | null, timeZone: string): string {
  if (iso === null || iso.length === 0) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function formatConsent(
  granted: boolean | null,
  version: string | null,
  capturedAt: string | null,
  timeZone: string,
): string {
  if (granted === null) {
    return "Sin registro";
  }
  const base = granted ? "Sí" : "No";
  if (version === null) {
    return base;
  }
  const when = formatTimestampInZone(capturedAt, timeZone);
  return when.length > 0 ? `${base} (${version}, ${when})` : `${base} (${version})`;
}

export type ProjectionGrid = {
  readonly header: readonly string[];
  readonly rows: readonly (readonly (string | number | boolean)[])[];
};

/**
 * Builds the data grid: header row plus one row per ticket. Empty cells are empty
 * strings (never the text "null"), so the sheet reads naturally.
 */
export function buildProjectionGrid(
  rows: readonly OperationalExportRow[],
  options: { readonly timezone: string },
): ProjectionGrid {
  const timezone = options.timezone;
  const mapped = rows.map((row) => [
    row.Evento ?? "",
    row["Código de entrada"] ?? "",
    row.Nombre ?? "",
    row.Apellido ?? "",
    row["Cédula"] ?? "",
    row.Correo ?? "",
    row["Teléfono"] ?? "",
    row.Ciudad ?? "",
    row.Instagram ?? "",
    row["Tipo de entrada"] ?? "",
    row["Etapa de venta"] ?? "",
    formatMoney(row["Precio centavos"], row.Moneda),
    row.Moneda ?? "",
    row["Referencia de la orden"] ?? "",
    labelFor(row["Estado de la orden"], "order"),
    row["Estado Wompi"] === null
      ? labelFor(row["Estado del pago"], "payment")
      : `${labelFor(row["Estado del pago"], "payment")} (${row["Estado Wompi"]})`,
    labelFor(row["Estado de la entrada"], "ticket"),
    row.Ingreso ? "Sí" : "No",
    formatTimestampInZone(row["Fecha de ingreso"], timezone),
    formatConsent(
      row["Autorización de datos"],
      row["Autorización de datos versión"],
      row["Autorización de datos fecha"],
      timezone,
    ),
    row["Autorización próximos eventos"] === null
      ? "Sin registro"
      : row["Autorización próximos eventos"]
        ? "Sí"
        : "No",
    formatTimestampInZone(row.Creada, timezone),
  ]);
  return { header: SHEETS_COLUMN_HEADERS_ES, rows: mapped };
}

/** Key/value rows for the status tab: staleness and pending work at a glance. */
export function buildStatusRows(input: {
  readonly syncedAt: string | null;
  readonly stats: {
    readonly queued: number;
    readonly syncing: number;
    readonly synced: number;
    readonly failed: number;
    readonly total: number;
  };
  readonly timezone: string;
  readonly note: string;
}): readonly (readonly (string | number)[])[] {
  return [
    ["Última sincronización", formatTimestampInZone(input.syncedAt, input.timezone) || "Nunca"],
    ["Total de entradas", input.stats.total],
    ["Sincronizadas", input.stats.synced],
    ["En cola", input.stats.queued],
    ["En curso", input.stats.syncing],
    ["Con error", input.stats.failed],
    [
      "Nota",
      `${input.note} Los cambios manuales en la hoja '${SHEETS_DEFAULT_DATA_SHEET}' se sobrescriben en la próxima sincronización.`,
    ],
  ];
}
