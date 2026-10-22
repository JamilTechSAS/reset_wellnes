/**
 * Wompi types and documented constants.
 *
 * Everything here traces back to the official documentation (docs.wompi.co, Colombia),
 * read on 2026-10-03. Sources are cited per item so a future reader can re-verify
 * without guessing:
 *
 * - Environments and keys: docs/colombia/ambientes-y-llaves/
 * - Widget / Web Checkout and integrity signature: docs/colombia/widget-checkout-web/
 * - Transactions API, statuses, error codes: docs/colombia/transacciones/
 * - Events (webhooks) and checksum: docs/colombia/eventos/
 * - Sandbox test data: docs/colombia/datos-de-prueba-en-sandbox/
 */

/**
 * Transaction resource as returned by `GET /v1/transactions/{id}` (private key only).
 * Only the fields this backend actually needs are modelled. `status` is kept as the raw
 * string exactly as received; normalize it with `mapWompiTransactionStatus`.
 */
export type WompiTransaction = {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly customerEmail: string | undefined;
  readonly paymentMethodType: string | undefined;
  readonly statusMessage: string | undefined;
  readonly createdAt: string | undefined;
  readonly finalizedAt: string | undefined;
};

/** Transaction ids look like `1292-1602113476-10985` (digits and dashes). */
export const WOMPI_TRANSACTION_ID_PATTERN = /^[0-9A-Za-z-]{5,64}$/;

/** Transaction fields carried by a `transaction.updated` event. */
export type WompiTransactionEventPayload = {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly customerEmail: string | undefined;
  readonly paymentMethodType: string | undefined;
  readonly statusMessage: string | undefined;
  readonly createdAt: string | undefined;
  readonly finalizedAt: string | undefined;
};

/**
 * Value of the envelope's `environment` field (documented 2026-10-03): `test` for Sandbox,
 * `prod` for Production. Present in current payloads; older ones may omit it, in which case
 * the credential prefix configured for the deployment is the only environment signal.
 */
export const WOMPI_ENVIRONMENT_VALUES = ["test", "prod"] as const;

export type WompiEventEnvironment = (typeof WOMPI_ENVIRONMENT_VALUES)[number];

/** Maps a Wompi environment onto this backend's environment vocabulary. */
export function toAppEnvironment(environment: WompiEventEnvironment): "sandbox" | "production" {
  return environment === "prod" ? "production" : "sandbox";
}

/**
 * Event names documented by Wompi. The list can grow, so unknown names are accepted by
 * the parser and ignored by the handlers instead of being treated as invalid.
 */
export const WOMPI_EVENT_NAMES = [
  "transaction.updated",
  "nequi_token.updated",
  "bancolombia_transfer_token.updated",
] as const;

export type WompiEventName = (typeof WOMPI_EVENT_NAMES)[number];

export const WOMPI_TRANSACTION_UPDATED_EVENT: WompiEventName = "transaction.updated";

/**
 * Header that mirrors `signature.checksum`, documented as case-insensitive HTTP header
 * `X-Event-Checksum`.
 */
export const WOMPI_EVENT_CHECKSUM_HEADER = "x-event-checksum";

/** Wompi supports COP only ("Only COP (Colombian pesos) is currently available"). */
export const WOMPI_SUPPORTED_CURRENCY = "COP";

/**
 * Documented retry schedule for failed event delivery: up to 3 retries within 24 hours
 * (30 minutes, 3 hours, 24 hours after the first attempt). Recorded here so operators
 * know how long an order can legitimately stay without a delivered webhook.
 */
export const WOMPI_EVENT_RETRY_SCHEDULE_MINUTES = [30, 180, 1440] as const;

/** Documented duplicate-reference error code returned when a reference was already used. */
export const WOMPI_DUPLICATE_REFERENCE_STATUS = 422;

/** Documented status code for an invalid amount (negative or non-integer). */
export const WOMPI_INVALID_AMOUNT_STATUS = 422;
