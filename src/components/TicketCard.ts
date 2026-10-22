/**
 * Digital ticket card (Phase 6B).
 *
 * Renders ONE ticket the backend issued. The QR encodes only the opaque `TKT_…` token —
 * never a cédula, email, phone or internal id — so a screenshot of the code is useless to
 * anyone else, and the token is exactly what the operator scanner reads at the door.
 *
 * The visual is the one deliberate flourish of the purchase surface: a ticket-shaped receipt
 * with a perforated edge and the code stamped in the brand gold, so the buyer immediately
 * recognises "this is my ticket".
 */

import { escapeHtml, renderIcon } from "../utils/dom.ts";
import { renderTicketQrSvg } from "../purchase/qr.ts";

export type TicketCardEvent = {
  readonly eventName: string;
  readonly dateLabel: string;
  readonly timeLabel: string;
  readonly venueLabel: string;
};

export type TicketCardData = {
  readonly token: string;
  readonly unit: number;
  readonly quantity: number;
  readonly status: string;
  readonly assigned: boolean;
  readonly participantName: string | null;
};

export type TicketCardOptions = {
  /** Optional role hint: the confirmation screen seeds focus into the first card. */
  readonly labelledById?: string;
};

function statusLabel(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "Válida";
    case "CANCELLED":
      return "Anulada";
    case "REFUNDED":
      return "Reembolsada";
    default:
      return "En revisión";
  }
}

export function renderTicketCard(
  event: TicketCardEvent,
  ticket: TicketCardData,
  options: TicketCardOptions = {},
): string {
  const holder = ticket.assigned
    ? (ticket.participantName ?? "Titular registrado")
    : "Pendiente de asignar";
  const labelId = options.labelledById ?? `ticket-${ticket.unit}-label`;

  return `
    <article class="ticket-card" aria-labelledby="${escapeHtml(labelId)}">
      <header class="ticket-card-head">
        <div>
          <p class="ticket-card-event">${escapeHtml(event.eventName)}</p>
          <p class="ticket-card-meta">
            ${escapeHtml(event.dateLabel)}${event.timeLabel.length > 0 ? ` · ${escapeHtml(event.timeLabel)}` : ""}
          </p>
          <p class="ticket-card-venue">${escapeHtml(event.venueLabel)}</p>
        </div>
        <span class="ticket-card-status" data-status="${escapeHtml(ticket.status.toLowerCase())}">
          ${escapeHtml(statusLabel(ticket.status))}
        </span>
      </header>

      <div class="ticket-card-body">
        <div class="ticket-card-qr" aria-hidden="true">
          ${renderTicketQrSvg(ticket.token)}
        </div>
        <dl class="ticket-card-facts">
          <div>
            <dt id="${escapeHtml(labelId)}">Titular</dt>
            <dd>${escapeHtml(holder)}</dd>
          </div>
          <div>
            <dt>Entrada</dt>
            <dd>${ticket.unit} de ${ticket.quantity}</dd>
          </div>
          <div>
            <dt>Código</dt>
            <dd class="ticket-code">${escapeHtml(ticket.token)}</dd>
          </div>
        </dl>
      </div>

      <p class="ticket-card-note">
        ${renderIcon("shield-check")}
        <span>Presenta este código QR en la entrada. También queda registrado en tu correo.</span>
      </p>
    </article>
  `;
}
