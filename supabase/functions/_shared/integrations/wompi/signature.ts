/**
 * Wompi integrity signature and hashing helpers.
 *
 * Verified algorithm (docs/colombia/widget-checkout-web/, step 3):
 *
 *   SHA256("<Reference><AmountInCents><Currency><IntegritySecret>")
 *
 * and, when `expiration-time` is used, the expiration value is inserted before the
 * secret:
 *
 *   SHA256("<Reference><AmountInCents><Currency><ExpirationTime><IntegritySecret>")
 *
 * Official example vector (used as a test):
 *   input  "sk8-438k4-xmxm392-sn2m" + "2490000" + "COP" + "prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6"
 *   output 37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5
 *
 * The docs recommend computing this on the server rather than in the browser, because
 * the integrity secret must never reach the client. The frontend receives only the
 * resulting hash.
 */

import { AppError, validationError } from "../../domain/errors.ts";
import { WOMPI_SUPPORTED_CURRENCY } from "./types.ts";
import { isValidWompiReference } from "../../domain/reference.ts";

export type IntegritySignatureInput = {
  /** The exact reference that will be sent to Wompi. */
  readonly reference: string;
  /** Amount in cents (Wompi `amount_in_cents`). */
  readonly amountInCents: number;
  readonly currency: string;
  /**
   * The exact `expiration-time` string that will be sent to Wompi, in the documented
   * ISO-8601 form `2023-06-09T20:28:50.000Z`. Use `formatWompiExpirationTime` so the
   * signature and the checkout parameter can never disagree.
   */
  readonly expirationTime?: string;
  readonly integritySecret: string;
};

/** SHA-256 as lowercase hexadecimal. Available in Node, Deno and browsers (Web Crypto). */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Canonical form of Wompi's `expiration-time` parameter (docs show `.000Z`). */
export function formatWompiExpirationTime(date: Date): string {
  return date.toISOString();
}

/**
 * Builds the exact string that is hashed for the integrity signature.
 * Exported separately from the hash so the concatenation order can be asserted
 * directly in tests, without relying on a digest.
 */
export function buildIntegritySignaturePayload(input: IntegritySignatureInput): string {
  if (!isValidWompiReference(input.reference)) {
    throw validationError("Reference is not valid for Wompi (charset or length)", {
      context: { referenceLength: input.reference.length },
    });
  }
  if (!Number.isInteger(input.amountInCents) || input.amountInCents < 0) {
    throw validationError("amountInCents must be a non-negative integer", {
      context: { amountInCents: input.amountInCents },
    });
  }
  if (input.currency !== WOMPI_SUPPORTED_CURRENCY) {
    throw validationError(`Wompi only supports ${WOMPI_SUPPORTED_CURRENCY}`, {
      context: { currency: input.currency },
    });
  }
  if (input.integritySecret.length === 0) {
    throw validationError("integritySecret must not be empty");
  }
  const expiration = input.expirationTime ?? "";
  return `${input.reference}${String(input.amountInCents)}${input.currency}${expiration}${input.integritySecret}`;
}

/** Computes the lowercase hex SHA-256 signature sent as `signature:integrity`. */
export async function computeIntegritySignature(input: IntegritySignatureInput): Promise<string> {
  return sha256Hex(buildIntegritySignaturePayload(input));
}

/**
 * Constant-time string comparison.
 *
 * Used for every secret comparison in this backend (event checksums today, the
 * maintenance token as well): a byte-by-byte comparison that does not return early, so
 * the time taken cannot reveal how many leading characters were correct. Length is
 * compared first, which leaks only the length — acceptable for fixed-length digests and
 * for tokens whose length is already documented.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Constant-time comparison for hex digests. Both values are normalized to lowercase
 * first: Wompi's documentation examples mix upper and lower case hex, so the comparison
 * must not depend on case.
 */
export function constantTimeEqualsHex(left: string, right: string): boolean {
  return constantTimeEquals(left.trim().toLowerCase(), right.trim().toLowerCase());
}

/** Thrown when a signature does not match; never includes the secret or the digest. */
export function signatureMismatchError(surface: string): AppError {
  return new AppError("UNAUTHORIZED", `${surface} signature verification failed`, {
    context: { surface },
  });
}
