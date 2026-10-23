/**
 * ePayco API client for transaction verification.
 *
 * Implements server-side transaction lookup via ePayco's validation API:
 *   GET https://secure.epayco.co/validation/v1/reference/{ref_payco}
 *
 * Security rules:
 * - Credentials are never logged or echoed into error messages.
 * - Injected fetch implementation allows unit testing without real network calls.
 * - Retries apply only to idempotent GET requests (network errors, 429, 5xx).
 */

import { z } from "zod";
import { AppError } from "../../domain/errors.ts";
import type { EpaycoTransactionData, EpaycoTransactionStatus } from "./types.ts";

export const DEFAULT_EPAYCO_VALIDATION_BASE_URL =
  "https://secure.epayco.co/validation/v1/reference";

const epaycoTransactionResponseSchema = z.object({
  success: z.boolean(),
  data: z.record(z.string(), z.unknown()),
});

function asString(val: unknown, fallback = ""): string {
  if (typeof val === "string") {
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return fallback;
}

/**
 * Converts an ePayco peso amount (`"10000"`, `"10000.5"`, `"10000.00"`) to integer centavos.
 * Exact decimal parsing, no floating point: anything else (negative, exponent, more than two
 * decimals, empty) is `null`, so a malformed amount can never be rounded into a match.
 */
export function parseEpaycoAmountToCents(text: string): number | null {
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match?.[1] === undefined) {
    return null;
  }
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function asNumber(val: unknown, fallback = 0): number {
  if (typeof val === "number") {
    return val;
  }
  if (typeof val === "string") {
    const parsed = Number.parseFloat(val);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

/**
 * ePayco response code to normalized state. Must stay identical to the SQL mapping in
 * `confirm_payment` (migration 20261023130000) so webhook, hint and reconciliation agree.
 */
export function epaycoStatusFromResponseCode(code: number): EpaycoTransactionStatus {
  switch (code) {
    case 1:
      return "approved";
    case 2:
    case 9: // Expirada / Caducada
    case 10: // Abandonada
    case 11: // Cancelada
      return "declined";
    case 3:
    case 7: // Retenida
    case 8: // Iniciada
      return "pending";
    case 4:
      return "error";
    case 6: // Reversada
      return "voided";
    default:
      return "unknown";
  }
}

export class EpaycoApiError extends AppError {
  readonly httpStatus: number | undefined;

  constructor(
    message: string,
    options: {
      readonly httpStatus?: number | undefined;
      readonly cause?: unknown;
      readonly context?: Record<string, string | number | boolean | null> | undefined;
    } = {},
  ) {
    super("UPSTREAM_ERROR", message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      context: {
        ...options.context,
        ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
      },
    });
    this.name = "EpaycoApiError";
    this.httpStatus = options.httpStatus;
  }
}

export type EpaycoClientOptions = {
  /** Validation base URL (e.g. `https://secure.epayco.co/validation/v1/reference`). */
  readonly baseUrl?: string | undefined;
  readonly validationBaseUrl?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly publicKey?: string | undefined;
  readonly privateKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly retryDelaysMs?: readonly number[] | undefined;
};

export type EpaycoClient = {
  getTransaction(refPayco: string): Promise<EpaycoTransactionData>;
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

export function createEpaycoClient(options: EpaycoClientOptions = {}): EpaycoClient {
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxRetries = options.maxRetries ?? retryDelays.length;
  const baseUrl = (
    options.baseUrl ??
    options.validationBaseUrl ??
    DEFAULT_EPAYCO_VALIDATION_BASE_URL
  ).replace(/\/+$/, "");

  return {
    async getTransaction(refPayco: string): Promise<EpaycoTransactionData> {
      const cleanRef = refPayco.trim();
      if (cleanRef.length === 0) {
        throw new EpaycoApiError("ref_payco cannot be empty", {
          context: { surface: "epayco-client" },
        });
      }

      const url = `${baseUrl}/${encodeURIComponent(cleanRef)}`;
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          const delay = retryDelays[attempt - 1] ?? 500;
          await sleep(delay);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, timeoutMs);

        try {
          const response = await fetchImpl(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
            },
            signal: controller.signal,
          });

          if (!response.ok) {
            if (response.status === 404) {
              throw new EpaycoApiError("Transaction reference not found at ePayco", {
                httpStatus: 404,
                context: { refPayco: cleanRef },
              });
            }

            if (isRetryableStatus(response.status) && attempt < maxRetries) {
              lastError = new EpaycoApiError(`ePayco returned HTTP ${response.status}`, {
                httpStatus: response.status,
              });
              continue;
            }

            throw new EpaycoApiError(`ePayco returned HTTP ${response.status}`, {
              httpStatus: response.status,
              context: { refPayco: cleanRef },
            });
          }

          const rawText = await response.text();
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rawText);
          } catch (error) {
            throw new EpaycoApiError("ePayco returned invalid JSON", {
              cause: error,
              context: { refPayco: cleanRef },
            });
          }

          const validation = epaycoTransactionResponseSchema.safeParse(parsedJson);
          if (!validation.success || !validation.data.success) {
            throw new EpaycoApiError("ePayco validation query unsuccessful", {
              context: { refPayco: cleanRef },
            });
          }

          const data = validation.data.data;
          const invoice = asString(data.x_id_invoice ?? data.x_id_factura).trim();
          const transactionId = asString(data.x_transaction_id).trim();
          const amountText = asString(data.x_amount ?? data.x_amount_ok).trim();
          const amountInCents = parseEpaycoAmountToCents(amountText);
          // No default: a record without a currency must fail verification, not become COP.
          const currency = asString(data.x_currency_code).trim().toUpperCase();
          const responseRefPayco = asString(data.x_ref_payco).trim();
          const custIdCliente = asString(data.x_cust_id_cliente ?? data.p_cust_id_cliente).trim();
          const rawCode =
            data.x_cod_response ?? data.x_cod_respuesta ?? data.x_cod_transaction_state ?? 0;
          const responseCode = asNumber(rawCode, 0);
          const responseText = asString(data.x_response ?? data.x_respuesta).trim();
          const signature = asString(data.x_signature).trim();
          const franchise = typeof data.x_franchise === "string" ? data.x_franchise.trim() : null;
          const bankName = typeof data.x_bank_name === "string" ? data.x_bank_name.trim() : null;
          const transactionDate =
            typeof data.x_transaction_date === "string"
              ? data.x_transaction_date.trim()
              : typeof data.x_fecha_transaccion === "string"
                ? data.x_fecha_transaccion.trim()
                : null;
          const statusMessage =
            typeof data.x_response_reason_text === "string"
              ? data.x_response_reason_text.trim()
              : null;
          const isTest =
            data.x_test_request === true || asString(data.x_test_request).toLowerCase() === "true";

          if (amountInCents === null) {
            throw new EpaycoApiError("ePayco response contains invalid amount", {
              context: { refPayco: cleanRef },
            });
          }

          const normalizedStatus = epaycoStatusFromResponseCode(responseCode);

          return {
            id: cleanRef,
            refPayco: cleanRef,
            responseRefPayco: responseRefPayco.length > 0 ? responseRefPayco : null,
            amountText,
            custIdCliente: custIdCliente.length > 0 ? custIdCliente : null,
            reference: invoice,
            invoice,
            transactionId,
            status: normalizedStatus,
            rawStatus: asString(rawCode),
            amount: amountInCents / 100,
            amountInCents,
            currency,
            responseCode: Number.isNaN(responseCode) ? 0 : responseCode,
            responseText,
            statusMessage,
            paymentMethodType: franchise,
            signature,
            isTest,
            franchise,
            bankName,
            transactionDate,
            rawPayload: data,
            rawResponse: parsedJson,
          };
        } catch (error) {
          if (error instanceof EpaycoApiError && error.httpStatus === 404) {
            throw error;
          }
          lastError = error;
          if (attempt === maxRetries) {
            if (error instanceof EpaycoApiError) {
              throw error;
            }
            throw new EpaycoApiError("ePayco request failed after retries", {
              cause: error,
              context: { refPayco: cleanRef },
            });
          }
        } finally {
          clearTimeout(timer);
        }
      }

      throw new EpaycoApiError("ePayco request failed", { cause: lastError });
    },
  };
}
