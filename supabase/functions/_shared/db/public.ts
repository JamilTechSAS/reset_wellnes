/**
 * Public read gateway: event, availability and public-safe ticket lookup.
 *
 * Every projection is built in SQL (a whitelist), not in TypeScript: adding a column to a
 * table can never leak it here. The gateway only calls the functions and re-validates the
 * `found` flag.
 */

import { AppError } from "../domain/errors.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";

export type PublicTicketType = {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly minPerOrder: number;
  readonly maxPerOrder: number | null;
  readonly salesOpen: boolean;
  readonly availability: "AVAILABLE" | "LOW" | "SOLD_OUT" | "NOT_STARTED" | "CLOSED";
  readonly currentTier: {
    readonly name: string;
    readonly sequence: number;
    readonly priceInCents: number;
  } | null;
};

export type PublicSales = {
  readonly currency: string;
  readonly salesOpen: boolean;
  readonly availability: "AVAILABLE" | "LOW" | "SOLD_OUT" | "NOT_STARTED" | "CLOSED";
  readonly ticketTypes: readonly PublicTicketType[];
};

export type PublicEventResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly event: {
        readonly code: string;
        readonly name: string;
        readonly description: string | null;
        readonly status: string;
        readonly startsAt: string;
        readonly endsAt: string | null;
        readonly timezone: string;
        readonly currency: string;
        readonly venue: {
          readonly name: string | null;
          readonly address: string | null;
          readonly city: string | null;
        };
      };
      readonly sales: PublicSales;
    };

export type PublicAvailabilityResult =
  | { readonly found: false }
  | { readonly found: true; readonly code: string; readonly sales: PublicSales };

export type PublicTicketResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly ticket: {
        readonly code: string;
        readonly status: string;
        readonly displayName: string | null;
      };
      readonly event: {
        readonly code: string;
        readonly name: string;
        readonly startsAt: string;
        readonly endsAt: string | null;
        readonly timezone: string;
        readonly city: string | null;
        readonly venueName: string | null;
        readonly venueAddress: string | null;
      };
    };

export type PublicGateway = {
  getPublicEvent(code: string): Promise<PublicEventResult>;
  getPublicAvailability(code: string): Promise<PublicAvailabilityResult>;
  getPublicTicket(token: string): Promise<PublicTicketResult>;
};

function throwMapped(error: unknown): never {
  throw mapSqlErrorToAppError(error);
}

function requireObject(data: unknown, surface: string): Record<string, unknown> {
  if (typeof data !== "object" || data === null) {
    throw new AppError("INTERNAL_ERROR", `${surface} returned an unexpected payload`);
  }
  return data as Record<string, unknown>;
}

export function createPublicGateway(client: DbClient): PublicGateway {
  return {
    async getPublicEvent(code) {
      const { data, error } = await client.rpc("get_public_event", { p_code: code });
      if (error !== null) {
        throwMapped(error);
      }
      const value = requireObject(data, "Public event lookup");
      if (value.found !== true) {
        return { found: false };
      }
      return value as unknown as PublicEventResult;
    },

    async getPublicAvailability(code) {
      const { data, error } = await client.rpc("get_public_availability", { p_code: code });
      if (error !== null) {
        throwMapped(error);
      }
      const value = requireObject(data, "Public availability lookup");
      if (value.found !== true) {
        return { found: false };
      }
      return value as unknown as PublicAvailabilityResult;
    },

    async getPublicTicket(token) {
      const { data, error } = await client.rpc("get_public_ticket", { p_ticket_token: token });
      if (error !== null) {
        throwMapped(error);
      }
      const value = requireObject(data, "Public ticket lookup");
      if (value.found !== true) {
        return { found: false };
      }
      return value as unknown as PublicTicketResult;
    },
  };
}
