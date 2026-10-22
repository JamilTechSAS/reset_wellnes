/**
 * Tickets: statuses, QR payload policy and public-safe identifiers.
 *
 * Security requirements implemented here:
 * - The QR code never contains personal data (no cédula, no email, no phone).
 * - The QR payload is an opaque token (`TKT_...`) that only the backend can resolve,
 *   so a leaked screenshot reveals nothing about the participant.
 * - Tickets are always tied to an order, an event and a ticket type; the price paid is
 *   stored per unit, so later price changes never rewrite history.
 */

export const TICKET_STATUSES = ["ACTIVE", "CANCELLED", "REFUNDED"] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Spanish labels for operator-facing surfaces (Google Sheets export, check-in UI). */
export const TICKET_STATUS_LABELS_ES: Record<TicketStatus, string> = {
  ACTIVE: "Válida",
  CANCELLED: "Cancelada",
  REFUNDED: "Reembolsada",
};

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

/** A ticket can only be used at the door when it is ACTIVE. */
export function isRedeemableTicketStatus(status: TicketStatus): boolean {
  return status === "ACTIVE";
}

export const CHECKIN_STATUSES = ["NOT_CHECKED_IN", "CHECKED_IN"] as const;
export type CheckInStatus = (typeof CHECKIN_STATUSES)[number];

export const CHECKIN_STATUS_LABELS_ES: Record<CheckInStatus, string> = {
  NOT_CHECKED_IN: "Sin ingreso",
  CHECKED_IN: "Ingresó",
};

/**
 * QR payload policy: the payload is the bare opaque token.
 *
 * A bare token scans reliably with generic QR readers and keeps the printed flyer
 * flow independent from the web domain. If the printed stage ever needs a scannable
 * URL instead, `buildTicketUrl` is the documented alternative and the check-in
 * endpoint accepts the token in both forms.
 */
export function buildTicketQrPayload(token: string): string {
  return token;
}

/** Human/operator shareable ticket link (used in emails, never as the QR content). */
export function buildTicketUrl(apiBaseUrl: string, token: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/t/${token}`;
}
