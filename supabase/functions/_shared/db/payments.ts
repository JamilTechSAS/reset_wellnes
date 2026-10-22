/**
 * Payment confirmation database gateway.
 *
 * The multi-table work (payment, order, inventory, tickets, outbox) lives in
 * `public.confirm_payment` and friends because PostgREST cannot run multi-statement
 * transactions. This module is the typed boundary: it calls the RPCs, maps PostgreSQL
 * errors onto the API error model WITHOUT leaking SQL text, and re-validates the shapes it
 * depends on.
 *
 * Read-only lookups (the order + payment a transaction belongs to) are plain `select`s:
 * they run before the confirmation, they change nothing, and the authoritative validation
 * happens again inside the transaction.
 */

import { AppError, notFoundError } from "../domain/errors.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";
import type { Json } from "./database.types.ts";

// ---------------------------------------------------------------------------
// Read model: the payment attempt behind a Wompi reference or transaction id
// ---------------------------------------------------------------------------

export type PaymentLookup = {
  readonly paymentId: string;
  readonly paymentAttempt: number;
  readonly wompiReference: string;
  readonly wompiTransactionId: string | null;
  readonly paymentStatus: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly orderId: string;
  readonly orderReference: string;
  readonly orderStatus: string;
  readonly orderTotalInCents: number;
  readonly orderCurrency: string;
};

// ---------------------------------------------------------------------------
// Phase 5: reconciliation sweep shapes
// ---------------------------------------------------------------------------

export type ClaimedReconciliation = {
  readonly paymentId: string;
  readonly orderId: string;
  readonly paymentAttempt: number;
  readonly wompiReference: string;
  readonly wompiTransactionId: string;
  readonly paymentStatus: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly reconciliationAttempts: number;
  readonly orderReference: string;
  readonly orderStatus: string;
  readonly orderTotalInCents: number;
  readonly orderCurrency: string;
};

export type FinishReconciliationResult = {
  readonly paymentId: string;
  readonly result: string;
  readonly failure: string | null;
  readonly reconciliationAttempts: number;
  readonly nextReconciliationAt: string | null;
};

/** `found:false` covers unknown reference AND wrong email — indistinguishable on purpose. */
export type BuyerPaymentLookup =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly paymentId: string;
      readonly paymentAttempt: number;
      readonly paymentStatus: string;
      readonly paymentProvider?: string | undefined;
      readonly providerReference?: string | undefined;
      readonly providerTransactionId?: string | null | undefined;
      readonly wompiReference: string;
      readonly wompiTransactionId: string | null;
      readonly amountCents: number;
      readonly currency: string;
      readonly orderId: string;
      readonly orderReference: string;
      readonly orderStatus: string;
      readonly orderTotalInCents: number;
      readonly orderCurrency: string;
    };

// ---------------------------------------------------------------------------
// Phase 5: buyers' payment lookup for the hint endpoint
// ---------------------------------------------------------------------------

/** Re-validates one claimed reconciliation row; a malformed row is an internal error. */
function toClaimedReconciliation(row: unknown): ClaimedReconciliation {
  if (typeof row !== "object" || row === null) {
    throw new AppError("INTERNAL_ERROR", "Reconciliation claim returned a malformed row");
  }
  const value = row as Record<string, unknown>;
  if (
    typeof value.paymentId !== "string" ||
    typeof value.wompiReference !== "string" ||
    typeof value.wompiTransactionId !== "string" ||
    typeof value.orderReference !== "string" ||
    typeof value.amountCents !== "number" ||
    typeof value.orderTotalInCents !== "number"
  ) {
    throw new AppError("INTERNAL_ERROR", "Reconciliation claim row is missing required fields");
  }
  return value as unknown as ClaimedReconciliation;
}

type PaymentLookupRow = {
  readonly id: string;
  readonly attempt: number;
  readonly wompi_reference: string;
  readonly wompi_transaction_id: string | null;
  readonly status: string;
  readonly amount_cents: number;
  readonly currency: string;
  readonly orders: {
    readonly id: string;
    readonly reference: string;
    readonly status: string;
    readonly total_cents: number;
    readonly currency: string;
  } | null;
};

function toPaymentLookup(row: PaymentLookupRow): PaymentLookup | undefined {
  if (row.orders === null) {
    return undefined;
  }
  return {
    paymentId: row.id,
    paymentAttempt: row.attempt,
    wompiReference: row.wompi_reference,
    wompiTransactionId: row.wompi_transaction_id,
    paymentStatus: row.status,
    amountCents: row.amount_cents,
    currency: row.currency,
    orderId: row.orders.id,
    orderReference: row.orders.reference,
    orderStatus: row.orders.status,
    orderTotalInCents: row.orders.total_cents,
    orderCurrency: row.orders.currency,
  };
}

const PAYMENT_LOOKUP_SELECT =
  "id, attempt, wompi_reference, wompi_transaction_id, status, amount_cents, currency, " +
  "orders!inner (id, reference, status, total_cents, currency)";

// ---------------------------------------------------------------------------
// RPC payload shapes (contracts with the migrations, re-validated here)
// ---------------------------------------------------------------------------

export type ClaimWebhookEventResult = {
  readonly claimed: boolean;
  readonly eventId: string;
  readonly result: string | null;
  readonly processedAt: string | null;
  readonly httpStatus: number | null;
};

export type FinalizeWebhookEventResult = {
  readonly finalized: boolean;
  readonly eventId: string;
  readonly result: string | null;
  readonly processedAt: string | null;
};

export type ConfirmPaymentResult = {
  readonly result: string;
  readonly reason: string;
  readonly orderId: string;
  readonly orderReference: string;
  readonly orderStatus: string;
  readonly paymentId: string;
  readonly paymentStatus: string;
  readonly paymentProvider?: string | undefined;
  readonly providerReference?: string | undefined;
  readonly providerTransactionId?: string | null | undefined;
  readonly rawProviderStatus?: string | null | undefined;
  readonly rawWompiStatus: string | null;
  readonly paymentAttempt: number;
  readonly wompiReference: string;
  readonly wompiTransactionId: string | null;
  readonly amountInCents: number;
  readonly currency: string;
  readonly ticketsIssued: number;
  readonly ticketsExpected: number;
  readonly reconciliationRequired: boolean;
};

export type QueueTicketEmailsResult = {
  readonly queued: number;
  readonly alreadyQueued: number;
  readonly total: number;
  readonly template: string;
};

export type ExpirePendingOrdersResult = {
  readonly expiredCount: number;
  readonly releasedTiers: number;
  readonly references: readonly string[];
  readonly ranAt: string;
};

export type RetryPaymentResult = {
  readonly orderId: string;
  readonly reference: string;
  readonly status: string;
  readonly paymentAttempt: number;
  readonly wompiReference: string;
  readonly totalInCents: number;
  readonly currency: string;
  readonly reservationExpiresAt: string | null;
};

export type ClaimedEmailDelivery = {
  readonly id: string;
  readonly ticket_id: string;
  readonly template: string;
  readonly recipient_email: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly provider: string;
  readonly last_error: string | null;
  readonly next_attempt_at: string | null;
};

export type FinishEmailDeliveryResult = {
  readonly deliveryId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly providerMessageId: string | null;
  readonly nextAttemptAt: string | null;
};

export type PaymentGateway = {
  findPaymentByReference(reference: string): Promise<PaymentLookup | undefined>;
  findPaymentByTransactionId(transactionId: string): Promise<PaymentLookup | undefined>;
  claimWebhookEvent(input: {
    readonly dedupeKey: string;
    readonly eventName: string;
    readonly transactionId: string | undefined;
    readonly checksumValid: boolean;
    readonly provider?: string | undefined;
  }): Promise<ClaimWebhookEventResult>;
  finalizeWebhookEvent(input: {
    readonly eventId: string;
    readonly result: "APPLIED" | "DUPLICATE" | "REJECTED" | "IGNORED";
    readonly httpStatus: number;
    readonly paymentId?: string | undefined;
    readonly errorCode?: string | undefined;
    readonly transactionId?: string | undefined;
  }): Promise<FinalizeWebhookEventResult>;
  recordWebhookRejection(input: {
    readonly dedupeKey: string;
    readonly eventName: string;
    readonly httpStatus: number;
    readonly errorCode: string;
    readonly provider?: string | undefined;
  }): Promise<{ readonly eventId: string; readonly recorded: boolean }>;
  confirmPayment(input: {
    readonly orderReference: string;
    readonly wompiReference: string;
    readonly wompiTransactionId: string;
    readonly wompiStatus: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly paymentMethodType: string | undefined;
    readonly statusMessage: string | undefined;
    readonly providerPayload: Json | undefined;
    readonly provider?: string | undefined;
  }): Promise<ConfirmPaymentResult>;
  queueTicketEmails(orderId: string): Promise<QueueTicketEmailsResult>;
  expirePendingOrders(limit: number): Promise<ExpirePendingOrdersResult>;
  retryPayment(input: {
    readonly orderReference: string;
    readonly buyerEmail: string;
    readonly reservationMinutes: number;
  }): Promise<RetryPaymentResult>;
  claimEmailDeliveries(
    limit: number,
    maxAttempts: number,
  ): Promise<readonly ClaimedEmailDelivery[]>;
  finishEmailDelivery(input: {
    readonly deliveryId: string;
    readonly status: "SENT" | "FAILED" | "CANCELLED";
    readonly providerMessageId?: string | undefined;
    readonly error?: string | undefined;
    readonly nextAttemptAt?: string | undefined;
  }): Promise<FinishEmailDeliveryResult>;
  /** Phase 5: the bounded reconciliation sweep (see domain/reconciliation.ts). */
  claimPaymentReconciliations(
    limit: number,
    maxAttempts: number,
  ): Promise<readonly ClaimedReconciliation[]>;
  finishPaymentReconciliation(input: {
    readonly paymentId: string;
    readonly result: string;
    readonly failure?: string | undefined;
    readonly nextAttemptAt?: string | undefined;
  }): Promise<FinishReconciliationResult>;
  /** Reference + buyer email gate for the payment-hint endpoint. */
  resolvePaymentForBuyer(reference: string, email: string): Promise<BuyerPaymentLookup>;
};

/** The order + payment context an email needs, joined once per delivery. */
export type EmailContext = {
  readonly deliveryId: string;
  readonly ticketToken: string;
  readonly ticketUnit: number;
  readonly ticketStatus: string;
  readonly recipientEmail: string;
  readonly participantFirstName: string | null;
  readonly participantLastName: string | null;
  readonly eventName: string;
  readonly eventCode: string;
  readonly eventStartsAt: string;
  readonly eventTimezone: string;
  readonly venueName: string | null;
  readonly venueAddress: string | null;
  readonly city: string | null;
  readonly orderReference: string;
  readonly pricePaidCents: number;
  readonly currency: string;
};

export type EmailContextRow = {
  readonly id: string;
  readonly recipient_email: string;
  readonly tickets: {
    readonly token: string;
    readonly order_item_seq: number;
    readonly status: string;
    readonly price_paid_cents: number;
    readonly participants: {
      readonly first_name: string;
      readonly last_name: string;
    } | null;
    readonly orders: {
      readonly reference: string;
      readonly currency: string;
      readonly events: {
        readonly code: string;
        readonly name: string;
        readonly starts_at: string;
        readonly timezone: string;
        readonly venue_name: string | null;
        readonly venue_address: string | null;
        readonly city: string | null;
      } | null;
    } | null;
  } | null;
};

export function toEmailContext(row: EmailContextRow): EmailContext | undefined {
  const ticket = row.tickets;
  const order = ticket?.orders ?? null;
  const event = order?.events ?? null;
  if (ticket === null || order === null || event === null) {
    return undefined;
  }
  return {
    deliveryId: row.id,
    ticketToken: ticket.token,
    ticketUnit: ticket.order_item_seq,
    ticketStatus: ticket.status,
    recipientEmail: row.recipient_email,
    participantFirstName: ticket.participants?.first_name ?? null,
    participantLastName: ticket.participants?.last_name ?? null,
    eventName: event.name,
    eventCode: event.code,
    eventStartsAt: event.starts_at,
    eventTimezone: event.timezone,
    venueName: event.venue_name,
    venueAddress: event.venue_address,
    city: event.city,
    orderReference: order.reference,
    pricePaidCents: ticket.price_paid_cents,
    currency: order.currency,
  };
}

const EMAIL_CONTEXT_SELECT =
  "id, recipient_email, tickets!inner (token, order_item_seq, status, price_paid_cents, " +
  "participants (first_name, last_name), " +
  "orders!inner (reference, currency, events!inner (code, name, starts_at, timezone, " +
  "venue_name, venue_address, city)))";

/** Maps a Supabase error onto the API taxonomy, keeping SQL text out of responses. */
function throwMapped(error: unknown): never {
  throw mapSqlErrorToAppError(error);
}

export function createPaymentGateway(client: DbClient): PaymentGateway {
  return {
    async findPaymentByReference(reference: string): Promise<PaymentLookup | undefined> {
      const { data, error } = await client
        .from("payments")
        .select(PAYMENT_LOOKUP_SELECT)
        .eq("wompi_reference", reference)
        .maybeSingle();
      if (error !== null) {
        throwMapped(error);
      }
      // The generator types a `maybeSingle()` as a union that includes its error shape,
      // so the documented row shape is asserted here and re-validated by the consumer.
      return data === null ? undefined : toPaymentLookup(data as unknown as PaymentLookupRow);
    },

    async findPaymentByTransactionId(transactionId: string): Promise<PaymentLookup | undefined> {
      const { data, error } = await client
        .from("payments")
        .select(PAYMENT_LOOKUP_SELECT)
        .eq("wompi_transaction_id", transactionId)
        .maybeSingle();
      if (error !== null) {
        throwMapped(error);
      }
      return data === null ? undefined : toPaymentLookup(data as unknown as PaymentLookupRow);
    },

    async claimWebhookEvent(input) {
      // Optional arguments are OMITTED rather than sent as null: the generated types model
      // them as optional, and the SQL default is null anyway.
      const { data, error } = await client.rpc("claim_webhook_event", {
        p_dedupe_key: input.dedupeKey,
        p_event_name: input.eventName,
        p_checksum_valid: input.checksumValid,
        ...(input.transactionId === undefined
          ? {}
          : { p_wompi_transaction_id: input.transactionId }),
        ...(input.provider === undefined ? {} : { p_provider: input.provider }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as ClaimWebhookEventResult;
    },

    async finalizeWebhookEvent(input) {
      const { data, error } = await client.rpc("finalize_webhook_event", {
        p_event_id: input.eventId,
        p_result: input.result,
        p_http_status: input.httpStatus,
        ...(input.paymentId === undefined ? {} : { p_payment_id: input.paymentId }),
        ...(input.errorCode === undefined ? {} : { p_error_code: input.errorCode }),
        ...(input.transactionId === undefined
          ? {}
          : { p_wompi_transaction_id: input.transactionId }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as FinalizeWebhookEventResult;
    },

    async recordWebhookRejection(input) {
      const { data, error } = await client.rpc("record_webhook_rejection", {
        p_dedupe_key: input.dedupeKey,
        p_event_name: input.eventName,
        p_http_status: input.httpStatus,
        p_error_code: input.errorCode,
        ...(input.provider === undefined ? {} : { p_provider: input.provider }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as { readonly eventId: string; readonly recorded: boolean };
    },

    async confirmPayment(input) {
      const { data, error } = await client.rpc("confirm_payment", {
        p_order_reference: input.orderReference,
        p_wompi_reference: input.wompiReference,
        p_wompi_transaction_id: input.wompiTransactionId,
        p_wompi_status: input.wompiStatus,
        p_amount_cents: input.amountCents,
        p_currency: input.currency,
        ...(input.paymentMethodType === undefined
          ? {}
          : { p_payment_method_type: input.paymentMethodType }),
        ...(input.statusMessage === undefined ? {} : { p_status_message: input.statusMessage }),
        ...(input.providerPayload === undefined
          ? {}
          : { p_provider_payload: input.providerPayload }),
        ...(input.provider === undefined ? {} : { p_provider: input.provider }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as ConfirmPaymentResult;
    },

    async queueTicketEmails(orderId) {
      const { data, error } = await client.rpc("queue_ticket_emails", {
        p_order_id: orderId,
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as QueueTicketEmailsResult;
    },

    async expirePendingOrders(limit) {
      const { data, error } = await client.rpc("expire_pending_orders", {
        p_limit: limit,
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as unknown as ExpirePendingOrdersResult;
    },

    async retryPayment(input) {
      const { data, error } = await client.rpc("retry_payment", {
        p_order_reference: input.orderReference,
        p_buyer_email: input.buyerEmail,
        p_reservation_minutes: input.reservationMinutes,
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as RetryPaymentResult;
    },

    async claimEmailDeliveries(limit, maxAttempts) {
      const { data, error } = await client.rpc("claim_email_deliveries", {
        p_limit: limit,
        p_max_attempts: maxAttempts,
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data;
    },

    async finishEmailDelivery(input) {
      const { data, error } = await client.rpc("finish_email_delivery", {
        p_delivery_id: input.deliveryId,
        p_status: input.status,
        ...(input.providerMessageId === undefined
          ? {}
          : { p_provider_message_id: input.providerMessageId }),
        ...(input.error === undefined ? {} : { p_error: input.error }),
        ...(input.nextAttemptAt === undefined ? {} : { p_next_attempt_at: input.nextAttemptAt }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as FinishEmailDeliveryResult;
    },

    async claimPaymentReconciliations(limit, maxAttempts) {
      const { data, error } = await client.rpc("claim_payment_reconciliations", {
        p_limit: limit,
        p_max_attempts: maxAttempts,
      });
      if (error !== null) {
        throwMapped(error);
      }
      // A `returns setof jsonb` always answers an array (empty when nothing is due).
      return data.map((row) => toClaimedReconciliation(row));
    },

    async finishPaymentReconciliation(input) {
      const { data, error } = await client.rpc("finish_payment_reconciliation", {
        p_payment_id: input.paymentId,
        p_result: input.result,
        ...(input.failure === undefined ? {} : { p_failure: input.failure }),
        ...(input.nextAttemptAt === undefined ? {} : { p_next_attempt_at: input.nextAttemptAt }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      return data as unknown as FinishReconciliationResult;
    },

    async resolvePaymentForBuyer(reference, email) {
      const { data, error } = await client.rpc("resolve_payment_for_buyer", {
        p_order_reference: reference,
        p_buyer_email: email,
      });
      if (error !== null) {
        throwMapped(error);
      }
      if (data === null || typeof data !== "object") {
        throw new AppError("INTERNAL_ERROR", "Payment resolution returned an unexpected payload");
      }
      return data as unknown as BuyerPaymentLookup;
    },
  };
}

// ---------------------------------------------------------------------------
// Order status (buyer-facing read model)
// ---------------------------------------------------------------------------

export type OrderStatusTicket = {
  readonly token: string;
  readonly unit: number;
  readonly status: string;
  readonly pricePaidCents: number;
  readonly issuedAt: string;
  readonly assigned: boolean;
  readonly participant: {
    readonly firstName: string;
    readonly lastName: string;
    readonly city: string;
    readonly instagram: string | null;
  } | null;
};

export type OrderStatus = {
  readonly found: boolean;
  readonly reference?: string;
  readonly status?: string;
  readonly quantity?: number;
  readonly currency?: string;
  readonly subtotalInCents?: number;
  readonly quantityDiscountInCents?: number;
  readonly discountCodeInCents?: number;
  readonly totalInCents?: number;
  readonly createdAt?: string | null;
  readonly paidAt?: string | null;
  readonly reservationExpiresAt?: string | null;
  readonly payment?: {
    readonly attempt: number;
    readonly status: string;
    readonly methodType: string | null;
    readonly statusMessage: string | null;
    readonly approvedAt: string | null;
  } | null;
  readonly paymentAttempts?: readonly {
    readonly attempt: number;
    readonly status: string;
    readonly wompiReference: string;
    readonly amountInCents: number;
    readonly statusMessage: string | null;
    readonly createdAt: string;
    readonly finalizedAt: string | null;
  }[];
  readonly tickets?: readonly OrderStatusTicket[];
  readonly confirmation?: {
    readonly queued: number;
    readonly sent: number;
    readonly failed: number;
    readonly ready: boolean;
  };
};

export type OrderStatusGateway = {
  /** `email` is the possession factor: without it the reference alone proves nothing. */
  getOrderStatus(reference: string, email: string): Promise<OrderStatus>;
  findEmailContext(deliveryId: string): Promise<EmailContext | undefined>;
};

export function createOrderStatusGateway(client: DbClient): OrderStatusGateway {
  return {
    async getOrderStatus(reference: string, email: string): Promise<OrderStatus> {
      const { data, error } = await client.rpc("get_order_status", {
        p_order_reference: reference,
        p_buyer_email: email,
      });
      if (error !== null) {
        throwMapped(error);
      }
      if (data === null || typeof data !== "object") {
        throw new AppError("INTERNAL_ERROR", "Order status returned an unexpected payload");
      }
      return data as unknown as OrderStatus;
    },

    async findEmailContext(deliveryId: string): Promise<EmailContext | undefined> {
      const { data, error } = await client
        .from("email_deliveries")
        .select(EMAIL_CONTEXT_SELECT)
        .eq("id", deliveryId)
        .maybeSingle();
      if (error !== null) {
        throwMapped(error);
      }
      return data === null ? undefined : toEmailContext(data as unknown as EmailContextRow);
    },
  };
}

/** Re-exported so callers get the not-found constructor without importing two modules. */
export { notFoundError };
