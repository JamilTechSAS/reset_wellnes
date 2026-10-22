/**
 * Opaque ticket tokens.
 *
 * Format: `TKT_` + 20 characters of Crockford base32 (100 bits of entropy from a CSPRNG).
 *
 * Why not a UUID? The token is read by humans when support has to find a ticket and it
 * is printed on a QR code; Crockford base32 excludes the visually ambiguous letters
 * I, L, O and U, so mis-read tokens are far rarer. 100 bits makes guessing a valid
 * ticket infeasible (a brute-force sweep of the whole address space is out of reach).
 *
 * The generator accepts an injected byte source so tests are deterministic.
 */

export const TICKET_TOKEN_PREFIX = "TKT_";

/** Number of random characters after the prefix. */
export const TICKET_TOKEN_RANDOM_LENGTH = 20;

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const TOKEN_PATTERN = /^TKT_[0-9A-HJKMNP-TV-Z]{20}$/;

type RandomBytes = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Generates a ticket token. 13 random bytes provide 104 bits, of which the first 100
 * are used (20 characters x 5 bits); the remaining 4 bits are discarded.
 */
export function generateTicketToken(randomBytes: RandomBytes = defaultRandomBytes): string {
  const bytes = randomBytes(13);
  let accumulator = 0;
  let availableBits = 0;
  let token = "";

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    availableBits += 8;
    while (availableBits >= 5 && token.length < TICKET_TOKEN_RANDOM_LENGTH) {
      availableBits -= 5;
      const index = (accumulator >>> availableBits) & 0b11111;
      token += CROCKFORD_BASE32[index] ?? "0";
    }
  }

  if (token.length !== TICKET_TOKEN_RANDOM_LENGTH) {
    throw new Error("Ticket token generation produced an unexpected length");
  }

  return `${TICKET_TOKEN_PREFIX}${token}`;
}

export function isValidTicketToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/**
 * Normalizes user/scanner input into the canonical token form.
 * Accepts surrounding whitespace, lowercase input, a leading `#`, and the URL form
 * `.../t/<token>` produced by `buildTicketUrl`, because QR scanners and manual entry
 * both feed this function eventually.
 */
export function normalizeTicketToken(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Drop any query string, then any trailing slashes, then keep the last path segment.
  const withoutQuery = trimmed.split("?")[0] ?? trimmed;
  const withoutTrailingSlash = withoutQuery.replace(/\/+$/, "");
  const lastSegment = withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf("/") + 1);
  const withoutHash = lastSegment.replace(/^#/, "");
  const upperCased = withoutHash.toUpperCase();
  return isValidTicketToken(upperCased) ? upperCased : undefined;
}
