/**
 * Public read endpoints: event page, availability and public-safe ticket lookup.
 *
 *   GET /events/{code}         landing-page content (published/closed events only)
 *   GET /events/{code}/availability   coarse sales state
 *   GET /tickets/{token}       the minimum a participant needs (never cédula/email/phone)
 *
 * These endpoints authenticate nobody — they ARE the public surface. The security boundary
 * is the SQL projections (`public.get_public_event`, `get_public_availability`,
 * `get_public_ticket`): each returns a hand-written whitelist, so adding a column to a table
 * cannot leak it here.
 *
 * Availability is deliberately COARSE (AVAILABLE / LOW / SOLD_OUT / NOT_STARTED / CLOSED):
 * a public endpoint can never report the exact remaining units without becoming a race-prone
 * promise. The authoritative check stays inside `create_order`'s transaction.
 *
 * An unknown event code and a malformed one return the SAME NOT_FOUND, so the endpoints
 * cannot be used to probe which events exist.
 */

import { notFoundError } from "../domain/errors.ts";
import { normalizeTicketToken } from "../domain/ticket-token.ts";
import type {
  PublicAvailabilityResult,
  PublicEventResult,
  PublicGateway,
  PublicTicketResult,
} from "../db/public.ts";
import type { Logger } from "../logging/logger.ts";

/** Same shape the `events.code` constraint enforces, so a bad slug never reaches the DB. */
const EVENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
const MAX_TOKEN_INPUT_LENGTH = 120;

/** `null` when the input cannot be an event code at all. */
export function normalizeEventCode(raw: string): string | undefined {
  const code = raw.trim().toUpperCase();
  return EVENT_CODE_PATTERN.test(code) ? code : undefined;
}

/** `GET /events/{code}`. */
export async function handleGetPublicEvent(input: {
  readonly code: string;
  readonly gateway: PublicGateway;
  readonly logger: Logger;
}): Promise<Extract<PublicEventResult, { found: true }>> {
  const code = normalizeEventCode(input.code);
  if (code === undefined) {
    throw notFoundError("Unknown event", { context: { surface: "public-event" } });
  }
  const result = await input.gateway.getPublicEvent(code);
  if (!result.found) {
    throw notFoundError("Unknown event", { context: { surface: "public-event" } });
  }
  input.logger.info("public event read", {
    code,
    ticketTypes: result.sales.ticketTypes.length,
    salesOpen: result.sales.salesOpen,
  });
  return result;
}

/** `GET /events/{code}/availability`. */
export async function handleGetPublicAvailability(input: {
  readonly code: string;
  readonly gateway: PublicGateway;
  readonly logger: Logger;
}): Promise<Extract<PublicAvailabilityResult, { found: true }>> {
  const code = normalizeEventCode(input.code);
  if (code === undefined) {
    throw notFoundError("Unknown event", { context: { surface: "public-availability" } });
  }
  const result = await input.gateway.getPublicAvailability(code);
  if (!result.found) {
    throw notFoundError("Unknown event", { context: { surface: "public-availability" } });
  }
  return result;
}

/**
 * `GET /tickets/{token}`.
 *
 * Only a well-formed opaque token is looked up; anything else is NOT_FOUND without touching
 * the database. Tokens carry 100 bits of entropy, so enumeration is infeasible, and the
 * response never contains cédula, email, phone, order internals or consent history.
 */
export async function handleGetPublicTicket(input: {
  readonly rawToken: string;
  readonly gateway: PublicGateway;
  readonly logger: Logger;
}): Promise<Extract<PublicTicketResult, { found: true }>> {
  if (input.rawToken.length > MAX_TOKEN_INPUT_LENGTH) {
    throw notFoundError("Unknown ticket", { context: { surface: "public-ticket" } });
  }
  const token = normalizeTicketToken(input.rawToken);
  if (token === undefined) {
    throw notFoundError("Unknown ticket", { context: { surface: "public-ticket" } });
  }
  const result = await input.gateway.getPublicTicket(token);
  if (!result.found) {
    throw notFoundError("Unknown ticket", { context: { surface: "public-ticket" } });
  }
  input.logger.info("public ticket read", {
    ticketCode: result.ticket.code,
    ticketStatus: result.ticket.status,
  });
  return result;
}
