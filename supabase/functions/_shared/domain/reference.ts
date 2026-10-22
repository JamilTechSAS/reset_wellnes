/**
 * Wompi payment references.
 *
 * Verified constraints (official docs, read 2026-10-03):
 * - `Widget & Checkout Web`, step 2: references must be unique per purchase and
 *   "once a reference is used for a payment on your account, it will not be possible
 *   to use it again". Recommended charset: numeric or alphanumeric, optionally
 *   including dashes (-) or underscores (_).
 * - `Transactions`: reference max length 255 characters.
 *
 * Consequences implemented here:
 * - An order has exactly one human-traceable reference (`EVT-2026-000001`).
 * - Every payment ATTEMPT uses its own Wompi reference, because a declined or voided
 *   transaction consumes its reference. Attempt 1 uses the order reference verbatim;
 *   later attempts append `-<attempt>`. Traceability is preserved and no reference is
 *   ever reused.
 * - Uniqueness itself is guaranteed by the database (a sequence plus a unique
 *   constraint), never by randomness in this module.
 */

export const ORDER_REFERENCE_PREFIX = "EVT";
export const ORDER_REFERENCE_SEQUENCE_WIDTH = 6;

/** Reference limit documented by Wompi for the `reference` field. */
export const MAX_WOMPI_REFERENCE_LENGTH = 255;

/** Allowed characters, per the documented recommendation (alphanumeric, dash, underscore). */
const WOMPI_REFERENCE_PATTERN = /^[A-Za-z0-9_-]+$/;

const ORDER_REFERENCE_PATTERN = /^EVT-(\d{4})-(\d{6,})$/;

export type OrderReferenceParts = {
  /** Four-digit year of the sales season the order belongs to. */
  readonly year: number;
  /** Monotonic, gap-tolerant sequence assigned by the database. */
  readonly sequence: number;
};

/**
 * Builds the order reference, for example `EVT-2026-000001`.
 * The caller supplies a sequence produced by a database sequence so that two
 * concurrent orders can never receive the same reference.
 */
export function formatOrderReference(parts: OrderReferenceParts): string {
  if (!Number.isInteger(parts.year) || parts.year < 2000 || parts.year > 9999) {
    throw new RangeError("year must be a four-digit integer");
  }
  if (!Number.isInteger(parts.sequence) || parts.sequence < 1) {
    throw new RangeError("sequence must be a positive integer");
  }
  return `${ORDER_REFERENCE_PREFIX}-${String(parts.year)}-${String(parts.sequence).padStart(
    ORDER_REFERENCE_SEQUENCE_WIDTH,
    "0",
  )}`;
}

/** Parses an order reference produced by `formatOrderReference`. */
export function parseOrderReference(reference: string): OrderReferenceParts | undefined {
  const match = ORDER_REFERENCE_PATTERN.exec(reference);
  if (match === null) {
    return undefined;
  }
  const [, yearText, sequenceText] = match;
  if (yearText === undefined || sequenceText === undefined) {
    return undefined;
  }
  return { year: Number.parseInt(yearText, 10), sequence: Number.parseInt(sequenceText, 10) };
}

export function isValidOrderReference(reference: string): boolean {
  return parseOrderReference(reference) !== undefined;
}

/**
 * Reference for a specific payment attempt of an order.
 * Attempt 1 is the order reference itself; further attempts are suffixed.
 */
export function formatPaymentReference(orderReference: string, attempt: number): string {
  if (!isValidOrderReference(orderReference)) {
    throw new RangeError("orderReference must match the EVT-<year>-<sequence> format");
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("attempt must be an integer greater than or equal to 1");
  }
  const reference = attempt === 1 ? orderReference : `${orderReference}-${String(attempt)}`;
  assertValidWompiReference(reference);
  return reference;
}

export type WompiReferenceProblem = "empty" | "too_long" | "invalid_characters";

/** Validates a reference against the documented Wompi constraints. */
export function findWompiReferenceProblem(reference: string): WompiReferenceProblem | undefined {
  if (reference.length === 0) {
    return "empty";
  }
  if (reference.length > MAX_WOMPI_REFERENCE_LENGTH) {
    return "too_long";
  }
  if (!WOMPI_REFERENCE_PATTERN.test(reference)) {
    return "invalid_characters";
  }
  return undefined;
}

export function isValidWompiReference(reference: string): boolean {
  return findWompiReferenceProblem(reference) === undefined;
}

/** Throws a descriptive error when a reference would be rejected by Wompi. */
export function assertValidWompiReference(reference: string): void {
  const problem = findWompiReferenceProblem(reference);
  if (problem === "empty") {
    throw new RangeError("reference must not be empty");
  }
  if (problem === "too_long") {
    throw new RangeError(
      `reference must be at most ${String(MAX_WOMPI_REFERENCE_LENGTH)} characters`,
    );
  }
  if (problem === "invalid_characters") {
    throw new RangeError(
      "reference may only contain letters, digits, dashes and underscores (Wompi rejects other characters)",
    );
  }
}
