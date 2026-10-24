/**
 * Participant assignment gateway.
 *
 * Reference + buyer email ownership is enforced inside the SQL functions, not here: this
 * module only calls them and re-validates the returned shapes. `found:false` covers an
 * unknown reference AND a wrong email AND a participant that belongs to another order — the
 * three are indistinguishable from outside on purpose.
 *
 * Tickets are discontinued: the admission a participant takes is derived from
 * `order_items.quantity` inside SQL, so nothing here carries a ticket token.
 */

import { AppError } from "../domain/errors.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";
import type { Json } from "./database.types.ts";

export type ParticipantConsentSummary = {
  readonly dataProcessing: boolean;
  readonly futureEvents: boolean;
  readonly policyVersion: string;
  readonly capturedAt: string;
};

export type AttachParticipantResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly orderReference: string;
      /** 1-based admission ordinal inside the order (the buyer's own row is unit 1). */
      readonly unit: number;
      readonly participant: {
        readonly participantId: string;
        readonly firstName: string;
        readonly lastName: string;
      };
      readonly consents: ParticipantConsentSummary;
      readonly consentsAppended: number;
      readonly remainingUnassigned: number;
    };

export type UpdateParticipantResult =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly participantId: string;
      readonly firstName: string;
      readonly lastName: string;
      readonly consents: ParticipantConsentSummary;
      readonly consentsAppended: number;
    };

export type ParticipantGateway = {
  attachParticipant(input: {
    readonly orderReference: string;
    readonly buyerEmail: string;
    readonly participant: Json;
    readonly policyVersion?: string | undefined;
  }): Promise<AttachParticipantResult>;
  updateParticipant(input: {
    readonly orderReference: string;
    readonly buyerEmail: string;
    readonly participantId: string;
    readonly participant: Json;
    readonly policyVersion?: string | undefined;
  }): Promise<UpdateParticipantResult>;
};

function throwMapped(error: unknown): never {
  throw mapSqlErrorToAppError(error);
}

function requireObject(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null) {
    throw new AppError("INTERNAL_ERROR", "Participant operation returned an unexpected payload");
  }
  return data as Record<string, unknown>;
}

export function createParticipantGateway(client: DbClient): ParticipantGateway {
  return {
    async attachParticipant(input) {
      const { data, error } = await client.rpc("attach_participant", {
        p_order_reference: input.orderReference,
        p_buyer_email: input.buyerEmail,
        p_participant: input.participant,
        ...(input.policyVersion === undefined ? {} : { p_policy_version: input.policyVersion }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      const value = requireObject(data);
      if (value.found !== true) {
        return { found: false };
      }
      return value as unknown as AttachParticipantResult;
    },

    async updateParticipant(input) {
      const { data, error } = await client.rpc("update_participant", {
        p_order_reference: input.orderReference,
        p_buyer_email: input.buyerEmail,
        p_participant_id: input.participantId,
        p_participant: input.participant,
        ...(input.policyVersion === undefined ? {} : { p_policy_version: input.policyVersion }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      const value = requireObject(data);
      if (value.found !== true) {
        return { found: false };
      }
      return value as unknown as UpdateParticipantResult;
    },
  };
}
