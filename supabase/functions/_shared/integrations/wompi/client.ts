/**
 * Wompi API client.
 *
 * Deliberately thin and dependency-free: Wompi has no official JavaScript SDK, and the
 * only server-side capability the backend needs is reading a transaction by id with the
 * PRIVATE key.
 *
 * Verified facts (docs/colombia/transacciones/, read 2026-10-03):
 * - `GET /v1/transactions/{transaction_id}` requires `Authorization: Bearer prv_...`.
 *   Requests without authentication, or with a public key, now return 404 — which is
 *   also why the backend must never rely on the buyer's browser for payment truth.
 * - `POST /v1/transactions/{id}/void` voids a card transaction (not needed yet).
 * - Common error codes: 422 duplicate reference, 422 invalid amount, 401 invalid key.
 *
 * The client is created with an injected `fetch` so it can be tested without network
 * access, and it never logs or echoes the private key.
 */

import { z } from "zod";
import { AppError } from "../../domain/errors.ts";
import { WOMPI_TRANSACTION_ID_PATTERN, type WompiTransaction } from "./types.ts";

export const WOMPI_TRANSACTIONS_PATH = "/transactions";

const transactionResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    reference: z.string().min(1),
    status: z.string().min(1),
    amount_in_cents: z.number().int(),
    currency: z.string().min(1),
    customer_email: z.string().optional(),
    payment_method_type: z.string().optional(),
    status_message: z.string().optional(),
    created_at: z.string().optional(),
    finalized_at: z.string().optional(),
  }),
});

/** Error raised for any non-successful Wompi interaction. Carries no credentials. */
export class WompiApiError extends AppError {
  readonly httpStatus: number | undefined;
  readonly wompiErrorType: string | undefined;

  constructor(
    message: string,
    options: {
      readonly httpStatus?: number;
      readonly wompiErrorType?: string;
      readonly cause?: unknown;
      readonly context?: Record<string, string | number | boolean | null>;
    } = {},
  ) {
    super("UPSTREAM_ERROR", message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      context: {
        ...options.context,
        ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
      },
    });
    this.name = "WompiApiError";
    this.httpStatus = options.httpStatus;
    this.wompiErrorType = options.wompiErrorType;
  }
}

export type WompiClientOptions = {
  /** Base URL for the environment: sandbox or production (never mixed with keys). */
  readonly baseUrl: string;
  readonly privateKey: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Retries only apply to idempotent GETs (network errors, 429 and 5xx responses). */
  readonly maxRetries?: number;
  readonly retryDelaysMs?: readonly number[];
};

export type WompiClient = {
  getTransaction(transactionId: string): Promise<WompiTransaction>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 750] as const;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createWompiClient(options: WompiClientOptions): WompiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxRetries = options.maxRetries ?? retryDelays.length;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  async function requestTransaction(transactionId: string): Promise<WompiTransaction> {
    if (!WOMPI_TRANSACTION_ID_PATTERN.test(transactionId)) {
      throw new WompiApiError("Wompi transaction id has an unexpected format", {
        context: { transactionIdLength: transactionId.length },
      });
    }

    const url = `${baseUrl}${WOMPI_TRANSACTIONS_PATH}/${encodeURIComponent(transactionId)}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${options.privateKey}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const errorType = await readWompiErrorType(response);
          const error = new WompiApiError(`Wompi returned HTTP ${String(response.status)}`, {
            httpStatus: response.status,
            ...(errorType === undefined ? {} : { wompiErrorType: errorType }),
            context: { transactionId },
          });
          if (!isRetryableStatus(response.status) || attempt === maxRetries) {
            throw error;
          }
          lastError = error;
        } else {
          return await parseTransactionResponse(response);
        }
      } catch (error) {
        if (error instanceof WompiApiError && !isRetryableStatus(error.httpStatus ?? 0)) {
          throw error;
        }
        lastError = error;
        if (attempt === maxRetries) {
          break;
        }
      }

      const delay = retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 0;
      await sleep(delay);
    }

    if (lastError instanceof WompiApiError) {
      throw lastError;
    }
    throw new WompiApiError("Wompi transaction lookup failed after retries", {
      ...(lastError === undefined ? {} : { cause: lastError }),
      context: { transactionId },
    });
  }

  return { getTransaction: requestTransaction };
}

async function parseTransactionResponse(response: Response): Promise<WompiTransaction> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new WompiApiError("Wompi returned a non-JSON response", { cause: error });
  }

  const parsed = transactionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    // The response shape is documented but never assumed: an unexpected payload must
    // never be interpreted as a successful payment.
    throw new WompiApiError("Wompi transaction response did not match the documented shape", {
      context: { issueCount: parsed.error.issues.length },
    });
  }

  const transaction = parsed.data.data;
  return {
    id: transaction.id,
    reference: transaction.reference,
    status: transaction.status,
    amountInCents: transaction.amount_in_cents,
    currency: transaction.currency,
    customerEmail: transaction.customer_email,
    paymentMethodType: transaction.payment_method_type,
    statusMessage: transaction.status_message,
    createdAt: transaction.created_at,
    finalizedAt: transaction.finalized_at,
  };
}

/** Reads `error.type` from a Wompi error body without leaking the body itself. */
async function readWompiErrorType(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = (payload as { error?: unknown }).error;
      if (typeof error === "object" && error !== null && "type" in error) {
        const type = (error as { type?: unknown }).type;
        if (typeof type === "string") {
          return type.slice(0, 100);
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
