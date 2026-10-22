/**
 * Projection of a Wompi transaction persisted on `payments.provider_payload`.
 *
 * Shared by the webhook path and the reconciliation sweep so both record exactly the same
 * thing: the fields this backend acts on. Deliberately a small, explicit projection — the
 * raw Wompi body can contain the customer's email and address, and `provider_payload` is
 * subject to a retention policy (docs/data-model.md). The whole response is never stored.
 */

import { boundStatusMessage } from "../domain/payment-confirmation.ts";
import type { Json } from "../db/database.types.ts";

export type PersistableTransaction = {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly paymentMethodType: string | undefined;
  readonly statusMessage: string | undefined;
  readonly createdAt: string | undefined;
  readonly finalizedAt: string | undefined;
};

export function buildProviderPayload(transaction: PersistableTransaction): Json {
  return {
    id: transaction.id,
    reference: transaction.reference,
    status: transaction.status,
    amount_in_cents: transaction.amountInCents,
    currency: transaction.currency,
    ...(transaction.paymentMethodType === undefined
      ? {}
      : { payment_method_type: transaction.paymentMethodType }),
    ...(transaction.statusMessage === undefined
      ? {}
      : { status_message: boundStatusMessage(transaction.statusMessage) }),
    ...(transaction.createdAt === undefined ? {} : { created_at: transaction.createdAt }),
    ...(transaction.finalizedAt === undefined ? {} : { finalized_at: transaction.finalizedAt }),
  };
}
