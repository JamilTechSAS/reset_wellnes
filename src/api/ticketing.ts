/**
 * The buyer-journey endpoints (Phase 6B).
 *
 * One function per frozen backend route. Each returns the documented response type; the
 * caller never sees a raw HTTP detail. The endpoints are the ONLY way the browser reaches
 * business data — there is no direct database access anywhere in `src/`.
 *
 *   GET  /events/{code}                        landing content + current price + availability
 *   POST /orders/quote                         authoritative price (reserves nothing)
 *   POST /orders                               create the order (Idempotency-Key)
 *   GET  /orders/{reference}                   buyer status (reference + X-Buyer-Email)
 *   POST /orders/{reference}/retry             new attempt, fresh reference
 *   POST /orders/{reference}/payment-hint      nudge confirmation with Wompi's ?id=
 */

import type { ApiClient } from "./client.ts";
import type {
  CreatedOrder,
  OrderStatus,
  PaymentHint,
  PublicAvailability,
  PublicEvent,
  Quote,
  RetriedPayment,
} from "./types.ts";

export type ParticipantPayload = {
  readonly firstName: string;
  readonly lastName: string;
  readonly nationalId: string;
  readonly email: string;
  readonly phone: string;
  readonly city: string;
  readonly instagram?: string | undefined;
  readonly consents: {
    readonly dataProcessing: boolean;
    readonly futureEvents: boolean;
  };
};

export type CreateOrderInput = {
  readonly eventCode: string;
  readonly ticketTypeCode: string;
  readonly quantity: number;
  readonly discountCode?: string | undefined;
  readonly buyer: { readonly email: string; readonly fullName: string; readonly phone: string };
  readonly participant: ParticipantPayload;
  readonly idempotencyKey?: string | undefined;
};

/**
 * The buyer-journey surface the purchase controller depends on.
 *
 * Declared explicitly (rather than inferred from the factory) so the controller and the tests
 * can provide a fake implementation without reaching for `ReturnType`, and so a signature
 * change has to be made deliberately in one place.
 */
export type TicketingApi = {
  getEvent(code: string, signal?: AbortSignal): Promise<PublicEvent>;
  getAvailability(code: string, signal?: AbortSignal): Promise<PublicAvailability>;
  quote(
    input: {
      readonly eventCode: string;
      readonly ticketTypeCode: string;
      readonly quantity: number;
      readonly discountCode?: string | undefined;
    },
    signal?: AbortSignal,
  ): Promise<Quote>;
  createOrder(input: CreateOrderInput, signal?: AbortSignal): Promise<CreatedOrder>;
  getOrderStatus(reference: string, buyerEmail: string, signal?: AbortSignal): Promise<OrderStatus>;
  retryPayment(
    reference: string,
    buyerEmail: string,
    signal?: AbortSignal,
  ): Promise<RetriedPayment>;
  sendPaymentHint(
    reference: string,
    buyerEmail: string,
    transactionId: string,
    signal?: AbortSignal,
  ): Promise<PaymentHint>;
};

export function createTicketingApi(client: ApiClient): TicketingApi {
  return {
    getEvent(code: string, signal?: AbortSignal): Promise<PublicEvent> {
      return client.request<PublicEvent>({
        method: "GET",
        path: `/events/${encodeURIComponent(code)}`,
        ...(signal === undefined ? {} : { signal }),
      });
    },

    getAvailability(code: string, signal?: AbortSignal): Promise<PublicAvailability> {
      return client.request<PublicAvailability>({
        method: "GET",
        path: `/events/${encodeURIComponent(code)}/availability`,
        ...(signal === undefined ? {} : { signal }),
      });
    },

    quote(
      input: {
        readonly eventCode: string;
        readonly ticketTypeCode: string;
        readonly quantity: number;
        readonly discountCode?: string | undefined;
      },
      signal?: AbortSignal,
    ): Promise<Quote> {
      return client.request<Quote>({
        method: "POST",
        path: "/orders/quote",
        body: {
          eventCode: input.eventCode,
          ticketTypeCode: input.ticketTypeCode,
          quantity: input.quantity,
          ...(input.discountCode === undefined ? {} : { discountCode: input.discountCode }),
        },
        ...(signal === undefined ? {} : { signal }),
      });
    },

    createOrder(input: CreateOrderInput, signal?: AbortSignal): Promise<CreatedOrder> {
      return client.request<CreatedOrder>({
        method: "POST",
        path: "/orders",
        body: {
          eventCode: input.eventCode,
          ticketTypeCode: input.ticketTypeCode,
          quantity: input.quantity,
          ...(input.discountCode === undefined ? {} : { discountCode: input.discountCode }),
          buyer: input.buyer,
          participant: {
            firstName: input.participant.firstName,
            lastName: input.participant.lastName,
            nationalId: input.participant.nationalId,
            email: input.participant.email,
            phone: input.participant.phone,
            city: input.participant.city,
            ...(input.participant.instagram === undefined
              ? {}
              : { instagram: input.participant.instagram }),
            consents: input.participant.consents,
          },
        },
        headers: {
          ...(input.idempotencyKey === undefined
            ? {}
            : { "Idempotency-Key": input.idempotencyKey }),
        },
        ...(signal === undefined ? {} : { signal }),
      });
    },

    getOrderStatus(
      reference: string,
      buyerEmail: string,
      signal?: AbortSignal,
    ): Promise<OrderStatus> {
      return client.request<OrderStatus>({
        method: "GET",
        path: `/orders/${encodeURIComponent(reference)}`,
        headers: { "X-Buyer-Email": buyerEmail },
        ...(signal === undefined ? {} : { signal }),
      });
    },

    retryPayment(
      reference: string,
      buyerEmail: string,
      signal?: AbortSignal,
    ): Promise<RetriedPayment> {
      return client.request<RetriedPayment>({
        method: "POST",
        path: `/orders/${encodeURIComponent(reference)}/retry`,
        body: { email: buyerEmail },
        headers: { "X-Buyer-Email": buyerEmail },
        ...(signal === undefined ? {} : { signal }),
      });
    },

    sendPaymentHint(
      reference: string,
      buyerEmail: string,
      transactionId: string,
      signal?: AbortSignal,
    ): Promise<PaymentHint> {
      return client.request<PaymentHint>({
        method: "POST",
        path: `/orders/${encodeURIComponent(reference)}/payment-hint`,
        body: { transactionId },
        headers: { "X-Buyer-Email": buyerEmail },
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
