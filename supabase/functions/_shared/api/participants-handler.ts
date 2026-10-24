/**
 * Buyer-facing participant endpoints.
 *
 *   POST /orders/{reference}/participants             attach a person to an admission
 *   PUT  /orders/{reference}/participants/{id}        edit a person of the same order
 *
 * Access model: the order reference AND the buyer email, exactly like the status and retry
 * endpoints. The reference is enumerable, so it is never enough on its own; the SQL
 * functions re-check the pair inside the transaction and report a wrong email, an unknown
 * reference and a participant of another order with the SAME `found:false`.
 *
 * What a client may send is only the participant block (validated and normalized by
 * `parseParticipantInput`, which strips unknown keys); price, status, ids, the admission and
 * the order linkage are decided by the backend. Tickets are discontinued, so there is no
 * ticket token to send or receive: the admission is the next free unit of the order.
 *
 * Privacy: the response returns the identifiers the buyer provided plus the assigned unit —
 * it never echoes cédula, email or phone back over the wire.
 */

import { notFoundError, validationError } from "../domain/errors.ts";
import { parseParticipantInput, type NormalizedParticipant } from "../domain/participant.ts";
import { ParticipantValidationError } from "./order-requests.ts";
import { normalizeLookupEmail } from "./order-status-handler.ts";
import type { Logger } from "../logging/logger.ts";
import type { Json } from "../db/database.types.ts";
import type { ParticipantGateway } from "../db/participants.ts";

const REFERENCE_PATTERN = /^EVT-[0-9]{4}-[0-9]{6,}(-[0-9]+)?$/;
const PARTICIPANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_POLICY_VERSION_LENGTH = 64;

export type ParsedParticipantRequest = {
  readonly participant: NormalizedParticipant;
  readonly participantJson: Json;
  readonly policyVersion: string | undefined;
};

function asJson(participant: NormalizedParticipant): Json {
  return {
    firstName: participant.firstName,
    lastName: participant.lastName,
    nationalId: participant.nationalId,
    email: participant.email,
    phone: participant.phone,
    city: participant.city,
    ...(participant.instagram === undefined ? {} : { instagram: participant.instagram }),
    consents: {
      dataProcessing: participant.consents.dataProcessing,
      futureEvents: participant.consents.futureEvents,
    },
  };
}

/** Parses the request body shared by attach and update; unknown keys are ignored. */
export function parseParticipantRequest(rawBody: unknown): ParsedParticipantRequest {
  if (typeof rawBody !== "object" || rawBody === null) {
    throw validationError("Request body must be a JSON object", {
      context: { surface: "participants" },
    });
  }
  const body = rawBody as Record<string, unknown>;

  const parsed = parseParticipantInput(body.participant);
  if (!parsed.ok) {
    throw new ParticipantValidationError(parsed.issues);
  }

  const policyVersion =
    typeof body.consentPolicyVersion === "string" && body.consentPolicyVersion.trim().length > 0
      ? body.consentPolicyVersion.trim()
      : undefined;
  if (policyVersion !== undefined && policyVersion.length > MAX_POLICY_VERSION_LENGTH) {
    throw validationError("consentPolicyVersion is too long", {
      context: { surface: "participants" },
    });
  }

  return {
    participant: parsed.value,
    participantJson: asJson(parsed.value),
    policyVersion,
  };
}

function requireReference(reference: string): string {
  const trimmed = reference.trim();
  if (!REFERENCE_PATTERN.test(trimmed)) {
    throw validationError("Order reference has an unexpected format", {
      context: { surface: "participants" },
    });
  }
  return trimmed;
}

function requireEmail(email: string): string {
  const normalized = normalizeLookupEmail(email);
  if (normalized.length === 0) {
    throw validationError("Buyer email is required to change participants", {
      context: { surface: "participants" },
    });
  }
  return normalized;
}

export type AttachParticipantResponse = {
  readonly orderReference: string;
  /** 1-based admission ordinal inside the order (the buyer's own row is unit 1). */
  readonly unit: number;
  readonly participant: {
    readonly participantId: string;
    readonly firstName: string;
    readonly lastName: string;
  };
  readonly consents: {
    readonly dataProcessing: boolean;
    readonly futureEvents: boolean;
    readonly policyVersion: string;
    readonly capturedAt: string;
  };
  readonly remainingUnassigned: number;
};

export async function handleAttachParticipant(input: {
  readonly reference: string;
  readonly email: string;
  readonly rawBody: unknown;
  readonly gateway: ParticipantGateway;
  readonly logger: Logger;
}): Promise<AttachParticipantResponse> {
  const reference = requireReference(input.reference);
  const email = requireEmail(input.email);
  const request = parseParticipantRequest(input.rawBody);

  const result = await input.gateway.attachParticipant({
    orderReference: reference,
    buyerEmail: email,
    participant: request.participantJson,
    policyVersion: request.policyVersion,
  });

  if (!result.found) {
    throw notFoundError("Order reference is unknown", { context: { surface: "participants" } });
  }
  // `result.found` was checked above, so TypeScript has narrowed the union member.
  const attached = result;

  input.logger.info("participant attached", {
    reference,
    unit: attached.unit,
    remainingUnassigned: attached.remainingUnassigned,
  });

  return {
    orderReference: attached.orderReference,
    unit: attached.unit,
    participant: attached.participant,
    consents: attached.consents,
    remainingUnassigned: attached.remainingUnassigned,
  };
}

export type UpdateParticipantResponse = {
  readonly participantId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly consents: {
    readonly dataProcessing: boolean;
    readonly futureEvents: boolean;
    readonly policyVersion: string;
    readonly capturedAt: string;
  };
  readonly consentsAppended: number;
};

export async function handleUpdateParticipant(input: {
  readonly reference: string;
  readonly email: string;
  readonly participantId: string;
  readonly rawBody: unknown;
  readonly gateway: ParticipantGateway;
  readonly logger: Logger;
}): Promise<UpdateParticipantResponse> {
  const reference = requireReference(input.reference);
  const email = requireEmail(input.email);
  if (!PARTICIPANT_ID_PATTERN.test(input.participantId.trim())) {
    throw validationError("Participant id has an unexpected format", {
      context: { surface: "participants" },
    });
  }
  const request = parseParticipantRequest(input.rawBody);

  const result = await input.gateway.updateParticipant({
    orderReference: reference,
    buyerEmail: email,
    participantId: input.participantId.trim(),
    participant: request.participantJson,
    policyVersion: request.policyVersion,
  });

  if (!result.found) {
    throw notFoundError("Participant is unknown for this order", {
      context: { surface: "participants" },
    });
  }
  const updated = result;

  input.logger.info("participant updated", {
    reference,
    participantId: updated.participantId,
    consentsAppended: updated.consentsAppended,
  });

  return {
    participantId: updated.participantId,
    firstName: updated.firstName,
    lastName: updated.lastName,
    consents: updated.consents,
    consentsAppended: updated.consentsAppended,
  };
}
