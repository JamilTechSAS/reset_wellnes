/**
 * Presentation helpers for the purchase flow (Phase 6B).
 *
 * Pure functions only: they turn backend values into Spanish text. No business rule lives
 * here — money comes from the backend in centavos and is only formatted, never recalculated.
 */

import type { AvailabilityLabel } from "../api/types.ts";

// ---------------------------------------------------------------------------
// Money (integer centavos, COP)
// ---------------------------------------------------------------------------

/**
 * Formats integer centavos as Colombian pesos: `9500000` → `$95.000`.
 *
 * Colombian pesos have no everyday decimals; the rare non-zero remainder (a ticket price
 * that had to absorb an integer division remainder) is shown with two decimals so the number
 * is never silently wrong.
 */
export function formatCopCents(cents: number): string {
  if (!Number.isFinite(cents)) {
    return "$0";
  }
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const pesos = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const grouped = pesos.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimals = remainder === 0 ? "" : `,${remainder.toString().padStart(2, "0")}`;
  return `${negative ? "-" : ""}$${grouped}${decimals}`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_FALLBACK = "Fecha por confirmar";

/** `15 de noviembre de 2026` in the event's own time zone. */
export function formatEventDate(iso: string | null | undefined, timeZone: string): string {
  if (iso === null || iso === undefined || iso.length === 0) {
    return DATE_FALLBACK;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return DATE_FALLBACK;
  }
  try {
    return new Intl.DateTimeFormat("es-CO", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone,
    }).format(date);
  } catch {
    return DATE_FALLBACK;
  }
}

/** `3:00 p. m.` in the event's own time zone. */
export function formatEventTime(iso: string | null | undefined, timeZone: string): string {
  if (iso === null || iso === undefined || iso.length === 0) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat("es-CO", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(date);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export function availabilityLabel(availability: AvailabilityLabel): string {
  switch (availability) {
    case "AVAILABLE":
      return "Disponible";
    case "LOW":
      return "Últimos cupos";
    case "SOLD_OUT":
      return "Agotado";
    case "NOT_STARTED":
      return "Venta próximamente";
    case "CLOSED":
      return "Venta cerrada";
  }
}

export function availabilityIsPurchasable(availability: AvailabilityLabel): boolean {
  return availability === "AVAILABLE" || availability === "LOW";
}

// ---------------------------------------------------------------------------
// Order / payment state
// ---------------------------------------------------------------------------

/** A settled payment that was NOT approved: the buyer must act (retry) or contact us. */
export function isDeclinedPaymentStatus(status: string | undefined): status is string {
  return status !== undefined && ["declined", "voided", "refunded", "error"].includes(status);
}

/** The order cannot be completed by waiting: the buyer must act (retry) or contact us. */
export function isUnrecoverableOrderStatus(status: string): boolean {
  return status === "EXPIRED" || status === "CANCELLED";
}
