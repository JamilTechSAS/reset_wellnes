/**
 * Presentation helpers for the purchase flow (Phase 6B).
 *
 * Pure functions only: they turn backend values into Spanish text. No business rule lives
 * here — money comes from the backend in centavos and is only formatted, never recalculated.
 */

import type { AvailabilityLabel, OrderConfirmationStatus } from "../api/types.ts";

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
// Email outbox status (never claimed unless the backend says so)
// ---------------------------------------------------------------------------

export type EmailStatusKind = "sent" | "sending" | "retrying" | "failed" | "unknown";

export type EmailStatus = {
  readonly kind: EmailStatusKind;
  readonly message: string;
};

/**
 * Turns the backend `confirmation` counters into one honest sentence.
 *
 * `sent` counts deliveries the provider accepted. We only say "enviada" when every expected
 * delivery is in that state; while some are still queued we say it is on its way, and we
 * never claim an email arrived when the backend has not reported it as sent.
 */
export function describeEmailStatus(
  confirmation: OrderConfirmationStatus | null,
  expectedCount: number,
): EmailStatus {
  // No outbox row to report (email disabled, or nothing scheduled yet): say nothing about the
  // email rather than implying one is on its way.
  const unknown: EmailStatus = {
    kind: "unknown",
    message: "Tu entrada quedó registrada. Guárdala desde esta pantalla.",
  };
  if (confirmation === null) {
    return unknown;
  }
  const { queued, sent, failed } = confirmation;
  const expected = Math.max(expectedCount, sent + queued + failed);

  if (expected > 0 && sent >= expected) {
    return {
      kind: "sent",
      message: "Enviamos tu entrada a tu correo electrónico.",
    };
  }
  if (sent > 0) {
    return {
      kind: "sending",
      message: `Ya enviamos ${sent} de ${expected}. El resto está en camino.`,
    };
  }
  if (queued > 0) {
    return {
      kind: "sending",
      message: "Estamos enviando una copia a tu correo electrónico.",
    };
  }
  if (failed > 0) {
    return {
      kind: "failed",
      message:
        "No pudimos enviar el correo todavía. Tu entrada es válida y puedes guardarla desde esta pantalla.",
    };
  }
  return unknown;
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
