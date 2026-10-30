/**
 * Order/pricing database gateway.
 *
 * The transaction lives in SQL (migrations 20261003210008/…09) because PostgREST cannot run
 * multi-statement transactions; this module is the typed boundary between the backend and
 * those functions. It has three jobs:
 *
 *   1. call the RPCs with the service-role client;
 *   2. translate PostgreSQL errors into the API error model, WITHOUT leaking SQL text,
 *      constraint names or stack details to the client;
 *   3. hand back a validated, typed payload.
 *
 * Error mapping: the SQL functions raise `PT400` / `PT404` / `PT409` with a machine-readable
 * `detail` (for example `SOLD_OUT`, `DISCOUNT_EXHAUSTED`). Those details are a deliberate
 * contract between the database and this layer. Everything else (a CHECK constraint, a type
 * error, a missing table) is an internal fault: it is logged and reported as
 * `INTERNAL_ERROR`, because a constraint name in a response is an information leak.
 */

import type { BundleCode } from "../api/order-requests.ts";
import type { PaymentProvider } from "../config/env.ts";
import { conflictError, notFoundError, validationError, AppError } from "../domain/errors.ts";
import type { DbClient } from "./client.ts";
import type { Json } from "./database.types.ts";

/** PostgreSQL SQLSTATEs raised by the pricing/order functions, mapped to API errors. */
const SQLSTATE_VALIDATION = "PT400";
const SQLSTATE_NOT_FOUND = "PT404";
const SQLSTATE_CONFLICT = "PT409";

export type SqlErrorDetails = {
  /** Machine-readable detail raised by the function (e.g. `SOLD_OUT`). */
  readonly detail: string | undefined;
  readonly sqlState: string | undefined;
  readonly message: string | undefined;
};

/**
 * Extracts the safe part of a Supabase/PostgREST error.
 *
 * Only the SQLSTATE and the `detail` are read. `message` is kept for server-side logs only
 * and must never be returned to a client (it can name constraints and columns).
 */
export function extractSqlError(error: unknown): SqlErrorDetails {
  if (error === null || typeof error !== "object") {
    return { detail: undefined, sqlState: undefined, message: undefined };
  }
  const record = error as Record<string, unknown>;
  const detail = typeof record.details === "string" ? record.details : undefined;
  const sqlState = typeof record.code === "string" ? record.code : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;
  return { detail, sqlState, message };
}

/** Error details that are meaningful to the API layer, mapped to Spanish-friendly codes. */
export type OrderErrorDetail =
  | "INVALID_QUANTITY"
  | "INVALID_RESERVATION_WINDOW"
  | "INVALID_BUYER_EMAIL"
  | "INVALID_BUYER_NAME"
  | "INVALID_BUYER_PHONE"
  | "INVALID_PARTICIPANT_NAME"
  | "INVALID_NATIONAL_ID"
  | "INVALID_PARTICIPANT_EMAIL"
  | "INVALID_PARTICIPANT_PHONE"
  | "INVALID_CITY"
  | "INVALID_INSTAGRAM"
  | "INVALID_EXTRA_FIELDS"
  | "INVALID_IDEMPOTENCY_KEY"
  | "CONSENT_REQUIRED"
  | "EVENT_NOT_FOUND"
  | "TICKET_TYPE_NOT_FOUND"
  | "EVENT_NOT_ON_SALE"
  | "TICKET_TYPE_INACTIVE"
  | "QUANTITY_LIMIT"
  | "BUNDLE_QUANTITY_INVALID"
  | "SOLD_OUT"
  | "NO_ASSIGNABLE_UNIT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | `DISCOUNT_${string}`;

/** Maps a SQLSTATE + detail onto the API error taxonomy. Never leaks SQL text. */
export function mapSqlErrorToAppError(error: unknown): AppError {
  const { detail, sqlState, message } = extractSqlError(error);

  if (sqlState === SQLSTATE_NOT_FOUND) {
    return notFoundError(`Database reported not found: ${detail ?? "unknown"}`, {
      context: { detail: detail ?? null },
    });
  }
  if (sqlState === SQLSTATE_VALIDATION) {
    return validationError(`Database rejected input: ${detail ?? "unknown"}`, {
      context: { detail: detail ?? null },
    });
  }
  if (sqlState === SQLSTATE_CONFLICT) {
    // A named package has a fixed size, so a quantity that does not match its included
    // admissions can never be a valid request — it is a client mistake (400), not a state
    // that changed under the caller (409). The detail still travels in the context.
    if (detail === "BUNDLE_QUANTITY_INVALID") {
      return validationError("Bundle quantity must equal the admissions the bundle includes", {
        context: { detail },
      });
    }
    return conflictError(`Database reported a conflict: ${detail ?? "unknown"}`, {
      context: { detail: detail ?? null },
    });
  }

  // Anything else is an internal fault. The message is preserved for logs only; the HTTP
  // layer never serializes it.
  return new AppError("INTERNAL_ERROR", message ?? "Database call failed", { cause: error });
}

export type QuoteRequest = {
  readonly eventCode: string;
  readonly ticketTypeCode: string;
  readonly quantity: number;
  readonly bundleCode?: BundleCode;
  readonly discountCode: string | undefined;
  readonly reservationMinutes: number;
};

export type QuoteResult = {
  readonly event: { readonly code: string; readonly name: string };
  readonly ticketType: { readonly code: string; readonly name: string };
  readonly quantity: number;
  readonly pricingTier: {
    readonly name: string;
    readonly sequence: number;
    readonly unitPriceInCents: number;
    /** Stage-level cap on one order (Preventa is 1); null means the stage has no cap. */
    readonly maxPerOrder: number | null;
  };
  readonly subtotalInCents: number;
  readonly quantityDiscount: {
    readonly applies: boolean;
    readonly percentBps: number;
    readonly amountInCents: number;
  };
  readonly quantityDiscountInCents: number;
  readonly discountCode: {
    readonly supplied: boolean;
    readonly applies: boolean;
    readonly reason: string;
    readonly code: string | null;
    readonly kind: string | null;
    readonly percentBps: number | null;
    readonly amountInCents: number;
    readonly remainingRedemptions: number | null;
  };
  readonly discountCodeInCents: number;
  readonly discountCombination: string;
  readonly totalDiscountInCents: number;
  readonly totalInCents: number;
  readonly currency: string;
  readonly availableQuantity: number | null;
  readonly availability: "AVAILABLE" | "LOW" | "SOLD_OUT";
  readonly quotedAt: string;
  readonly expiresAt: string;
};

export type CreateOrderRequest = QuoteRequest & {
  readonly buyerEmail: string;
  readonly buyerName: string;
  readonly buyerPhone: string;
  /** Participant payload: validated and normalized by the caller before it is sent. */
  readonly participant: Json;
  readonly idempotencyKey: string | undefined;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
};

export type CreateOrderResult = {
  readonly replayed: boolean;
  readonly orderId: string;
  readonly reference: string;
  readonly status: string;
  readonly quantity: number;
  readonly unitPriceInCents: number;
  readonly pricingTierName: string;
  readonly subtotalInCents: number;
  readonly quantityDiscountInCents: number;
  readonly discountCodeInCents: number;
  readonly totalDiscountInCents: number;
  readonly discountCombination: string;
  readonly totalInCents: number;
  readonly currency: string;
  readonly reservationExpiresAt: string;
  readonly paymentAttempt: number;
  readonly wompiReference: string;
  readonly participantId: string;
};

export type OrderGateway = {
  quote(request: QuoteRequest): Promise<QuoteResult>;
  createOrder(request: CreateOrderRequest): Promise<CreateOrderResult>;
};

/**
 * Creates the gateway over a Supabase client.
 *
 * The RPC responses are cast to the documented shape: the functions are owned by this
 * repository and covered by schema tests, so the shape is a contract rather than a guess.
 * Numeric and string fields are still re-validated by the caller (`domain/pricing.ts` and
 * the response type), which is where a drift would be caught.
 */
export function createOrderGateway(
  client: DbClient,
  /**
   * The provider this deployment charges with. Only ePayco can create orders now; the value is
   * stored on the attempt-1 payment row so a pending order is never later reconciled against
   * the wrong provider (H15 follow-up). Historical rows keep `wompi`, which is why
   * `payments.payment_provider` still has that value in the database.
   */
  paymentProvider: PaymentProvider,
): OrderGateway {
  return {
    async quote(request: QuoteRequest): Promise<QuoteResult> {
      if (request.bundleCode !== undefined) {
        const { data, error } = await client.rpc("quote_bundle_order_price", {
          p_event_code: request.eventCode,
          p_ticket_type_code: request.ticketTypeCode,
          p_quantity: request.quantity,
          p_reservation_minutes: request.reservationMinutes,
          p_bundle_code: request.bundleCode,
          ...(request.discountCode === undefined ? {} : { p_discount_code: request.discountCode }),
        });
        if (error !== null) {
          throw mapSqlErrorToAppError(error);
        }
        return data as QuoteResult;
      }

      const { data, error } = await client.rpc("quote_order_price", {
        p_event_code: request.eventCode,
        p_ticket_type_code: request.ticketTypeCode,
        p_quantity: request.quantity,
        p_reservation_minutes: request.reservationMinutes,
        ...(request.discountCode === undefined ? {} : { p_discount_code: request.discountCode }),
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      return data as QuoteResult;
    },

    async createOrder(request: CreateOrderRequest): Promise<CreateOrderResult> {
      const rpcArgs = {
        p_event_code: request.eventCode,
        p_ticket_type_code: request.ticketTypeCode,
        p_quantity: request.quantity,
        p_reservation_minutes: request.reservationMinutes,
        p_buyer_email: request.buyerEmail,
        p_buyer_name: request.buyerName,
        p_buyer_phone: request.buyerPhone,
        p_participant: request.participant,
        ...(request.discountCode === undefined ? {} : { p_discount_code: request.discountCode }),
        ...(request.idempotencyKey === undefined
          ? {}
          : { p_idempotency_key: request.idempotencyKey }),
        ...(request.ipAddress === undefined ? {} : { p_ip_address: request.ipAddress }),
        ...(request.userAgent === undefined ? {} : { p_user_agent: request.userAgent }),
        p_payment_provider: paymentProvider,
      };

      if (request.bundleCode !== undefined) {
        const { data, error } = await client.rpc("create_bundle_order", {
          ...rpcArgs,
          p_bundle_code: request.bundleCode,
        });
        if (error !== null) {
          throw mapSqlErrorToAppError(error);
        }
        return data as CreateOrderResult;
      }

      const { data, error } = await client.rpc("create_order", rpcArgs);
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      return data as CreateOrderResult;
    },
  };
}
