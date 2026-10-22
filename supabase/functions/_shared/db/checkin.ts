/**
 * Check-in gateway.
 *
 * `record_check_in` is the single atomic operation (ticket row lock + unique
 * `attendance.ticket_id`); this module calls it and maps the returned outcome. The
 * operator label/user id come from the authenticated operator identity, never from the
 * request body, so a client cannot claim someone else admitted a ticket.
 */

import { AppError } from "../domain/errors.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";

export type CheckInOutcomeCode = "VALID" | "ALREADY_USED" | "NOT_PAID" | "CANCELLED" | "NOT_FOUND";

export type CheckInRecord = {
  readonly outcome: CheckInOutcomeCode;
  readonly reason: string | undefined;
  readonly ticketCode: string | undefined;
  readonly checkedInAt: string | undefined;
  readonly participantName: string | undefined;
};

export type OperatorTicketView = {
  readonly found: boolean;
  readonly ticket?: {
    readonly code: string;
    readonly status: string;
    readonly ticketType: string | null;
    readonly pricePaidCents: number;
    readonly unit: number;
  };
  readonly event?: {
    readonly code: string;
    readonly name: string;
    readonly startsAt: string;
    readonly timezone: string;
    readonly city: string | null;
    readonly venueName: string | null;
  };
  readonly participant?: {
    readonly firstName: string;
    readonly lastName: string;
    readonly nationalId: string;
    readonly city: string;
  } | null;
  readonly admission?: {
    readonly orderStatus: string;
    readonly paymentStatus: string;
    readonly checkedIn: boolean;
    readonly checkedInAt: string | null;
    readonly checkedInBy: string | null;
  };
};

export type CheckInGateway = {
  recordCheckIn(input: {
    readonly ticketToken: string;
    readonly operatorLabel: string;
    readonly operatorUserId: string | undefined;
    readonly method: "QR_SCAN" | "MANUAL";
    readonly notes?: string | undefined;
  }): Promise<CheckInRecord>;
  getOperatorTicket(ticketToken: string): Promise<OperatorTicketView>;
};

const OUTCOMES: readonly CheckInOutcomeCode[] = [
  "VALID",
  "ALREADY_USED",
  "NOT_PAID",
  "CANCELLED",
  "NOT_FOUND",
];

function throwMapped(error: unknown): never {
  throw mapSqlErrorToAppError(error);
}

function toRecord(data: unknown): CheckInRecord {
  if (typeof data !== "object" || data === null) {
    throw new AppError("INTERNAL_ERROR", "Check-in returned an unexpected payload");
  }
  const value = data as Record<string, unknown>;
  const outcome = value.outcome;
  if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) {
    throw new AppError("INTERNAL_ERROR", "Check-in returned an unknown outcome");
  }
  return {
    outcome: outcome as CheckInOutcomeCode,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    ticketCode: typeof value.ticketCode === "string" ? value.ticketCode : undefined,
    checkedInAt: typeof value.checkedInAt === "string" ? value.checkedInAt : undefined,
    participantName: typeof value.participantName === "string" ? value.participantName : undefined,
  };
}

export function createCheckInGateway(client: DbClient): CheckInGateway {
  return {
    async recordCheckIn(input) {
      const { data, error } = await client.rpc("record_check_in", {
        p_ticket_token: input.ticketToken,
        p_operator_label: input.operatorLabel,
        ...(input.operatorUserId === undefined ? {} : { p_operator_user_id: input.operatorUserId }),
        p_method: input.method,
        ...(input.notes === undefined ? {} : { p_notes: input.notes }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      return toRecord(data);
    },

    async getOperatorTicket(ticketToken) {
      const { data, error } = await client.rpc("get_operator_ticket", {
        p_ticket_token: ticketToken,
      });
      if (error !== null) {
        throwMapped(error);
      }
      if (typeof data !== "object" || data === null) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Operator ticket lookup returned an unexpected payload",
        );
      }
      return data as unknown as OperatorTicketView;
    },
  };
}
