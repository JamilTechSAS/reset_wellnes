/**
 * ePayco checkout preparation.
 *
 * Produces the client-safe ePayco checkout payload. Contains NO secrets of any kind
 * (p_key, private_key, cust_id_cliente NEVER appear here).
 */

import { validationError } from "../../domain/errors.ts";
import { EPAYCO_SUPPORTED_CURRENCY, type EpaycoCheckout } from "./types.ts";

export type EpaycoCheckoutRequest = {
  /** ePayco Smart Checkout session ID (V2). */
  readonly sessionId?: string | undefined;
  /** ePayco public key (`PUBLIC_KEY`). Safe for client exposure. */
  readonly publicKey: string;
  readonly test: boolean;
  readonly reference: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly redirectUrl?: string | undefined;
  readonly confirmationUrl?: string | undefined;
  readonly customerData?:
    | {
        readonly email?: string | undefined;
        readonly fullName?: string | undefined;
        readonly phoneNumber?: string | undefined;
        readonly phoneNumberPrefix?: string | undefined;
      }
    | undefined;
};

export function buildEpaycoCheckout(request: EpaycoCheckoutRequest): EpaycoCheckout {
  if (request.currency !== EPAYCO_SUPPORTED_CURRENCY) {
    throw validationError(`ePayco only supports ${EPAYCO_SUPPORTED_CURRENCY}`, {
      context: { currency: request.currency },
    });
  }

  if (request.amountInCents <= 0) {
    throw validationError("Amount must be greater than zero", {
      context: { amountInCents: request.amountInCents },
    });
  }

  return {
    provider: "epayco",
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    publicKey: request.publicKey,
    test: request.test,
    reference: request.reference,
    amountInCents: request.amountInCents,
    currency: request.currency,
    redirectUrl: request.redirectUrl ?? null,
    confirmationUrl: request.confirmationUrl ?? null,
    customerData: {
      email: request.customerData?.email ?? null,
      fullName: request.customerData?.fullName ?? null,
      phoneNumber: request.customerData?.phoneNumber ?? null,
      phoneNumberPrefix: request.customerData?.phoneNumberPrefix ?? null,
    },
  };
}
