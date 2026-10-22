/**
 * Ticket-type selection (Phase 6C)
 *
 * An event can expose several ticket types (Re set Sunset sells preventa, a 2-ticket bundle and
 * general). The page sells the one configured in `VITE_TICKET_TYPE_CODE`, so every display must
 * resolve THAT type instead of assuming the first row the backend returns.
 *
 * Fallback: if the configured code is not present (renamed by the operator, sold-out type
 * removed, or a different event), the first returned type is used so the buyer still sees the
 * event's real product rather than an empty panel. The backend remains authoritative for price
 * and availability either way.
 */

import type { PublicEvent, PublicTicketType } from "../api/types.ts";

export function selectTicketType(
  event: PublicEvent | null,
  ticketTypeCode: string,
): PublicTicketType | undefined {
  if (event === null) {
    return undefined;
  }
  const types = event.sales.ticketTypes;
  return types.find((type) => type.code === ticketTypeCode) ?? types[0];
}
