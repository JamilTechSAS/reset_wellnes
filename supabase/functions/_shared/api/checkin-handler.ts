/**
 * Operator check-in API.
 *
 *   POST /check-in           { ticketToken }        -> the admission decision
 *   GET  /check-in/{token}                          -> operator ticket lookup
 *
 * Both routes require an authenticated operator (Supabase Auth + an active `operators`
 * row); the check-in records the operator's identity, never a client-supplied label.
 *
 * RESPONSE CONTRACT (deliberate): every check-in outcome is a 200 with a `status` value —
 * VALID, ALREADY_USED, NOT_PAID, CANCELLED, NOT_FOUND, INVALID. The scanner UI branches on
 * `status`; HTTP errors are reserved for transport-level failures (auth, rate limit,
 * malformed body, upstream). An ALREADY_USED scan is normal door operation, not a server
 * error, and a NOT_FOUND/INVALID scan must not produce a retry storm.
 *
 * The response is minimal by design: no cédula, email, phone, order internals or consent
 * history ever leaves this endpoint. A VALID decision includes the participant's name so
 * the operator can greet the person; everything else returns only the code and timestamp.
 */

import { notFoundError, validationError } from "../domain/errors.ts";
import { normalizeTicketToken } from "../domain/ticket-token.ts";
import type { CheckInGateway, CheckInOutcomeCode, OperatorTicketView } from "../db/checkin.ts";
import type { OperatorIdentity } from "../domain/operators.ts";
import type { Logger } from "../logging/logger.ts";

const MAX_TOKEN_INPUT_LENGTH = 120;

export type CheckInStatus = CheckInOutcomeCode | "INVALID";

export type CheckInResponse = {
  readonly status: CheckInStatus;
  readonly ticketCode?: string;
  readonly participant?: { readonly name: string };
  readonly checkedInAt?: string;
};

export type HandleCheckInInput = {
  readonly rawBody: unknown;
  readonly operator: OperatorIdentity;
  readonly gateway: CheckInGateway;
  readonly logger: Logger;
};

/** Extracts `ticketToken` from a JSON object without trusting any other field. */
export function extractTicketToken(rawBody: unknown): string {
  if (typeof rawBody !== "object" || rawBody === null) {
    throw validationError("Request body must be a JSON object", {
      context: { surface: "check-in" },
    });
  }
  const value = (rawBody as Record<string, unknown>).ticketToken;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("ticketToken is required", { context: { surface: "check-in" } });
  }
  if (value.length > MAX_TOKEN_INPUT_LENGTH) {
    throw validationError("ticketToken is too long", { context: { surface: "check-in" } });
  }
  return value;
}

export async function handleCheckIn(input: HandleCheckInInput): Promise<CheckInResponse> {
  const rawToken = extractTicketToken(input.rawBody);
  const token = normalizeTicketToken(rawToken);
  if (token === undefined) {
    // A QR that is not one of our tickets: reported as an outcome (the scanner shows
    // "no válido"), never as a server error and never a database lookup.
    input.logger.warn("check-in with a malformed token", { operatorId: input.operator.userId });
    return { status: "INVALID" };
  }

  const record = await input.gateway.recordCheckIn({
    ticketToken: token,
    operatorLabel: input.operator.displayName,
    operatorUserId: input.operator.userId,
    method: "QR_SCAN",
  });

  switch (record.outcome) {
    case "VALID": {
      input.logger.info("check-in admitted", {
        operatorId: input.operator.userId,
        ticketCode: record.ticketCode,
      });
      return {
        status: "VALID",
        ...(record.ticketCode === undefined ? {} : { ticketCode: record.ticketCode }),
        ...(record.participantName === undefined
          ? {}
          : { participant: { name: record.participantName } }),
        ...(record.checkedInAt === undefined ? {} : { checkedInAt: record.checkedInAt }),
      };
    }
    case "ALREADY_USED": {
      input.logger.info("check-in repeated", {
        operatorId: input.operator.userId,
        ticketCode: record.ticketCode,
      });
      return {
        status: "ALREADY_USED",
        ...(record.ticketCode === undefined ? {} : { ticketCode: record.ticketCode }),
        ...(record.checkedInAt === undefined ? {} : { checkedInAt: record.checkedInAt }),
      };
    }
    case "NOT_PAID":
      input.logger.warn("check-in refused: not paid", {
        operatorId: input.operator.userId,
        ticketCode: record.ticketCode,
      });
      return {
        status: "NOT_PAID",
        ...(record.ticketCode === undefined ? {} : { ticketCode: record.ticketCode }),
      };
    case "CANCELLED":
      input.logger.warn("check-in refused: cancelled", {
        operatorId: input.operator.userId,
        ticketCode: record.ticketCode,
      });
      return {
        status: "CANCELLED",
        ...(record.ticketCode === undefined ? {} : { ticketCode: record.ticketCode }),
      };
    case "NOT_FOUND":
      input.logger.warn("check-in refused: unknown token", { operatorId: input.operator.userId });
      return { status: "NOT_FOUND" };
  }
}

// ---------------------------------------------------------------------------
// Operator ticket lookup
// ---------------------------------------------------------------------------

export type OperatorTicketResponse = {
  readonly ticket: NonNullable<OperatorTicketView["ticket"]>;
  readonly event: NonNullable<OperatorTicketView["event"]>;
  readonly participant: NonNullable<OperatorTicketView["participant"]> | null;
  readonly admission: NonNullable<OperatorTicketView["admission"]>;
};

/**
 * `GET /check-in/{token}`.
 *
 * The operator may look up a specific ticket before scanning it (or when the QR cannot be
 * read). Returns the admission-oriented view: identity data needed to verify the person,
 * plus the order/payment/attendance state.
 *
 * @throws {AppError} NOT_FOUND for malformed or unknown tokens — symmetric with the
 *   public-safe lookup and impossible to use for enumeration (the token is 100-bit random).
 */
export async function handleOperatorTicketLookup(input: {
  readonly rawToken: string;
  readonly operator: OperatorIdentity;
  readonly gateway: CheckInGateway;
  readonly logger: Logger;
}): Promise<OperatorTicketResponse> {
  const token = normalizeTicketToken(input.rawToken);
  if (token === undefined) {
    throw notFoundError("Unknown ticket token", { context: { surface: "operator-ticket" } });
  }
  const view = await input.gateway.getOperatorTicket(token);
  if (
    !view.found ||
    view.ticket === undefined ||
    view.event === undefined ||
    view.admission === undefined
  ) {
    throw notFoundError("Unknown ticket token", { context: { surface: "operator-ticket" } });
  }
  input.logger.info("operator ticket lookup", {
    operatorId: input.operator.userId,
    ticketCode: view.ticket.code,
    checkedIn: view.admission.checkedIn,
  });
  return {
    ticket: view.ticket,
    event: view.event,
    participant: view.participant ?? null,
    admission: view.admission,
  };
}
