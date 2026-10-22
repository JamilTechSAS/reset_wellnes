/**
 * Resend email client.
 *
 * Verified against the official API reference (resend.com/docs/api-reference/emails/send-email,
 * re-read 2026-10-03):
 *
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer re_…
 *   { from, to, subject, html, text, reply_to? }  ->  { id: "<message id>" }
 *
 * Facts this client depends on:
 * - The response body is `{ "id": "..." }`; that id is the provider message id we store
 *   on the delivery row for support and reconciliation.
 * - Attachments are a base64 `content` today, and the payload limit is ~40 MB. This phase
 *   sends NO attachment: the QR is a token in the message body, so the limit is irrelevant
 *   and the email cannot be lost to an oversized file.
 * - An `Idempotency-Key` header is supported: it deduplicates requests for 24 hours and is
 *   at most 256 characters. We send the delivery's own idempotency key as a SECOND layer
 *   under the database unique constraint — the database is authoritative, the header is a
 *   safety net for the case where our UPDATE was lost after Resend accepted the message.
 * - Delivery is asynchronous: a 200 means "accepted", not "delivered". Bounces are a
 *   webhook subject and are out of scope here.
 *
 * Failure classification is the important part: `isRetryableResendFailure` separates a
 * transient failure (5xx, 429, network error) from a permanent one (400 validation, 401/403
 * credentials, 422 invalid recipient). Retrying a permanent failure only burns reputation.
 *
 * The client never logs or returns the API key, and never copies a provider response body
 * into an error (it can echo the recipient address).
 */

import { AppError } from "../../domain/errors.ts";

export const RESEND_API_URL = "https://api.resend.com";
export const RESEND_EMAILS_PATH = "/emails";
export const RESEND_IDEMPOTENCY_HEADER = "idempotency-key";

export type ResendSendInput = {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string | undefined;
  /** Unique per logical send; Resend deduplicates identical keys for 24 hours. */
  readonly idempotencyKey?: string | undefined;
};

export type ResendSendResult =
  | { readonly ok: true; readonly messageId: string }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      /** Safe, bounded description; never a raw provider body. */
      readonly error: string;
      readonly httpStatus: number | undefined;
    };

export type ResendClient = {
  send(input: ResendSendInput): Promise<ResendSendResult>;
};

export type ResendClientOptions = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** HTTP statuses worth retrying. Everything else is a permanent defect. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Reads `error.message`/`error.name` from a Resend error body, bounded and trimmed.
 * Only these two fields are read; the rest of the body is discarded unread.
 */
function describeErrorBody(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  const message = (error as { message?: unknown }).message;
  const parts = [name, message].filter((part): part is string => typeof part === "string");
  if (parts.length === 0) {
    return undefined;
  }
  return parts
    .join(": ")
    .replace(/[\n\r\t]+/g, " ")
    .slice(0, 200);
}

export function createResendClient(options: ResendClientOptions): ResendClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? RESEND_API_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(input: ResendSendInput): Promise<ResendSendResult> {
      if (options.apiKey.trim().length === 0) {
        throw new AppError("INTERNAL_ERROR", "Resend API key is not configured");
      }

      const headers: Record<string, string> = {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      };
      if (input.idempotencyKey !== undefined) {
        // Resend documents a 256-character maximum; the derived key is far shorter.
        headers[RESEND_IDEMPOTENCY_HEADER] = input.idempotencyKey.slice(0, 256);
      }

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${RESEND_EMAILS_PATH}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            from: input.from,
            to: [input.to],
            subject: input.subject,
            html: input.html,
            text: input.text,
            ...(input.replyTo === undefined ? {} : { reply_to: input.replyTo }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Network failure or timeout: the message may or may not have been accepted.
        // The caller retries with the same idempotency key, so a duplicate is impossible.
        return {
          ok: false,
          retryable: true,
          httpStatus: undefined,
          error: error instanceof Error ? `network: ${error.name}` : "network error",
        };
      }

      if (response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return {
            ok: false,
            retryable: true,
            httpStatus: response.status,
            error: "provider returned a non-JSON success body",
          };
        }
        const id = (payload as { id?: unknown }).id;
        if (typeof id !== "string" || id.length === 0) {
          return {
            ok: false,
            retryable: true,
            httpStatus: response.status,
            error: "provider success body did not contain a message id",
          };
        }
        return { ok: true, messageId: id.slice(0, 200) };
      }

      let described: string | undefined;
      try {
        described = describeErrorBody(await response.json());
      } catch {
        described = undefined;
      }

      return {
        ok: false,
        retryable: isRetryableStatus(response.status),
        httpStatus: response.status,
        error: described ?? `provider returned HTTP ${String(response.status)}`,
      };
    },
  };
}
