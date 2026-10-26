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

/** Hard ceiling of the stepper, whatever the backend says: a UI sanity bound, not a rule. */
export const MAX_ORDER_QUANTITY = 10;

/**
 * How many admissions one order may buy RIGHT NOW.
 *
 * Two different caps apply and the smaller one wins:
 *   - `ticket_types.max_per_order` is the product-wide limit;
 *   - `currentTier.maxPerOrder` is the ACTIVE stage's limit — the database seeds Preventa with
 *     1, because the stage sells one admission per payment.
 *
 * Reading only the ticket type (as the stepper used to) offered quantities the quote answers
 * with `QUANTITY_LIMIT`, so the buyer could select 4 tickets in Preventa and only learn about
 * the cap when paying. This helper is the single place the storefront derives the cap.
 */
export function effectiveMaxQuantity(
  ticketType: PublicTicketType | undefined,
  fallback: number,
): number {
  const caps = [ticketType?.maxPerOrder, ticketType?.currentTier?.maxPerOrder].filter(
    (cap): cap is number => typeof cap === "number" && Number.isFinite(cap) && cap >= 1,
  );
  const limit = caps.length === 0 ? fallback : Math.min(...caps);
  return Math.max(1, Math.min(limit, MAX_ORDER_QUANTITY));
}
