/**
 * Request contracts for the public pricing and order endpoints.
 *
 * These schemas are the trust boundary: they define EXACTLY what a client may send. The
 * fields a client must never control (price, subtotal, total, Wompi amount, discount amount,
 * payment/order/ticket state) are simply not part of the schema, and zod strips unknown keys,
 * so sending them has no effect at all — there is no code path where a client value could
 * reach the price.
 *
 * Validation here is about SHAPE and obvious nonsense. The authoritative business validation
 * (stage availability, code validity, limits) happens in SQL inside the order transaction,
 * because only there is the answer current.
 */

import { z } from "zod";

import { parseParticipantInput } from "../domain/participant.ts";
import { AppError, validationError } from "../domain/errors.ts";

/** Upper bound on a single order. The real per-order limits come from the database. */
export const MAX_ORDER_QUANTITY = 50;

/**
 * The only named bundle a NEW purchase may ask for: "Comparte tu experiencia", three General
 * admissions for a fixed COP 539.700 (catalogued in `ticket_bundles`).
 *
 * `DOUBLE_EXPERIENCE` (two admissions, COP 340.000) is retired: the migration deactivates its
 * row, and this schema never accepts the code again. Historical orders keep reading it because
 * they store the bundle id and the frozen name on the order line, not a request parameter.
 */
export const BUNDLE_CODE = "SHARE_EXPERIENCE" as const;
export type BundleCode = typeof BUNDLE_CODE;
const bundleCodeField = z.literal(BUNDLE_CODE);

/** Client-supplied idempotency keys must be long enough to be unguessable. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const codeField = z
  .string()
  .trim()
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Codes may contain letters, digits, dashes and underscores");

export const quoteRequestSchema = z.object({
  eventCode: codeField,
  ticketTypeCode: codeField,
  quantity: z.number().int().min(1).max(MAX_ORDER_QUANTITY),
  bundleCode: bundleCodeField.optional(),
  discountCode: z.string().trim().max(64).optional(),
});

export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>;

/**
 * Buyer block. The email is the buyer's own contact address (it may differ from the
 * participant's), which is why it is a separate field rather than being copied from the
 * participant payload.
 */
const buyerSchema = z.object({
  email: z.string().trim().max(254),
  fullName: z.string().trim().max(160),
  phone: z.string().trim().max(30),
});

export const createOrderRequestSchema = z.object({
  eventCode: codeField,
  ticketTypeCode: codeField,
  quantity: z.number().int().min(1).max(MAX_ORDER_QUANTITY),
  bundleCode: bundleCodeField.optional(),
  discountCode: z.string().trim().max(64).optional(),
  buyer: buyerSchema,
  /**
   * Participant data is validated by the Phase 1 domain module (`parseParticipantInput`),
   * which normalizes and collects every problem in one pass. It is passed through as an
   * unknown object here so the domain stays the single source of truth for those rules.
   */
  participant: z.unknown(),
});

export type CreateOrderRequestInput = z.infer<typeof createOrderRequestSchema>;

export type ParsedQuoteRequest = {
  readonly eventCode: string;
  readonly ticketTypeCode: string;
  readonly quantity: number;
  readonly bundleCode?: BundleCode;
  readonly discountCode: string | undefined;
};

export type ParsedCreateOrderRequest = ParsedQuoteRequest & {
  readonly buyer: { readonly email: string; readonly fullName: string; readonly phone: string };
  /** Normalized participant values, ready to persist. */
  readonly participant: {
    readonly firstName: string;
    readonly lastName: string;
    readonly nationalId: string;
    readonly email: string;
    readonly phone: string;
    readonly city: string;
    readonly instagram: string | undefined;
    readonly consents: { readonly dataProcessing: boolean; readonly futureEvents: boolean };
  };
};

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "Invalid request body";
  }
  const path = issue.path.map((segment) => String(segment)).join(".");
  return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
}

/**
 * Parses a quote request.
 *
 * @throws {AppError} VALIDATION_ERROR with a field-level description.
 */
export function parseQuoteRequest(raw: unknown): ParsedQuoteRequest {
  const parsed = quoteRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(firstIssueMessage(parsed.error), { context: { surface: "quote" } });
  }
  const data = parsed.data;
  return {
    eventCode: data.eventCode.toUpperCase(),
    ticketTypeCode: data.ticketTypeCode.toUpperCase(),
    quantity: data.quantity,
    ...(data.bundleCode === undefined ? {} : { bundleCode: data.bundleCode }),
    discountCode:
      data.discountCode === undefined || data.discountCode === "" ? undefined : data.discountCode,
  };
}

/**
 * Parses an order-creation request, including the participant block.
 *
 * Participant problems are reported field by field (`consents.dataProcessing`, `nationalId`,
 * …) so the future Spanish checkout form can highlight exactly what to fix in one round trip.
 *
 * @throws {AppError} VALIDATION_ERROR.
 */
export function parseCreateOrderRequest(raw: unknown): ParsedCreateOrderRequest {
  const parsed = createOrderRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(firstIssueMessage(parsed.error), { context: { surface: "order" } });
  }
  const data = parsed.data;

  const participant = parseParticipantInput(data.participant);
  if (!participant.ok) {
    const issues = participant.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    }));
    throw new ParticipantValidationError(issues);
  }

  return {
    eventCode: data.eventCode.toUpperCase(),
    ticketTypeCode: data.ticketTypeCode.toUpperCase(),
    quantity: data.quantity,
    ...(data.bundleCode === undefined ? {} : { bundleCode: data.bundleCode }),
    discountCode:
      data.discountCode === undefined || data.discountCode === "" ? undefined : data.discountCode,
    buyer: {
      email: data.buyer.email.toLowerCase(),
      fullName: data.buyer.fullName,
      phone: data.buyer.phone.replace(/[^0-9]/g, ""),
    },
    participant: {
      firstName: participant.value.firstName,
      lastName: participant.value.lastName,
      nationalId: participant.value.nationalId,
      email: participant.value.email,
      phone: participant.value.phone,
      city: participant.value.city,
      instagram: participant.value.instagram,
      consents: participant.value.consents,
    },
  };
}

/**
 * Validation error that carries field-level issues for the frontend form.
 *
 * It extends `AppError` so every layer maps it correctly without special cases: the HTTP
 * adapter answers 400 `VALIDATION_ERROR` (not 500) and attaches `details.issues` — the
 * contract docs/api.md documents for the order endpoints.
 */
export class ParticipantValidationError extends AppError {
  readonly issues: readonly { readonly path: string; readonly message: string }[];

  constructor(issues: readonly { readonly path: string; readonly message: string }[]) {
    super("VALIDATION_ERROR", "Participant data is invalid", {
      context: { surface: "participant" },
    });
    this.name = "ParticipantValidationError";
    this.issues = issues;
  }
}

export function isParticipantValidationError(value: unknown): value is ParticipantValidationError {
  return value instanceof ParticipantValidationError;
}

/** Narrow helper so the handler can treat both error kinds uniformly. */
export function asAppError(value: unknown): AppError | ParticipantValidationError | undefined {
  if (value instanceof ParticipantValidationError) {
    return value;
  }
  return undefined;
}
