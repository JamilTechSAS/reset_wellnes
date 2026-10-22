/**
 * Money.
 *
 * Unit of account: the smallest currency unit. For COP (Colombian pesos) that is the
 * centavo, which matches Wompi's `amount_in_cents` one-to-one — the official docs
 * state that $95.000 COP is sent as 9500000.
 *
 * Rules
 * -----
 * - Money is always an integer number of centavos. Floating point is never used for
 *   monetary amounts, so no rounding drift can ever reach a payment.
 * - `CopCents` is a branded type: raw numbers cannot be passed where money is
 *   expected, which stops "pesos vs centavos" mix-ups at compile time.
 * - This module performs no I/O and holds no prices: every amount comes from the
 *   database, never from configuration or hardcoded defaults.
 */

declare const copCentsBrand: unique symbol;

/** Amount of money in centavos of Colombian peso. */
export type CopCents = number & { readonly [copCentsBrand]: true };

export const CURRENCY_COP = "COP" as const;
export type SupportedCurrency = typeof CURRENCY_COP;

/** 1 COP peso = 100 centavos. */
export const CENTS_PER_PESO = 100;

/**
 * Maximum amount accepted, in centavos (~COP $90.071.992.547.409).
 * Far beyond any realistic ticket price, but keeps every amount inside the exact
 * integer range so arithmetic never loses precision.
 */
export const MAX_COP_CENTS = Number.MAX_SAFE_INTEGER;

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(
      `${label} must be an integer number of centavos (received a non-integer value)`,
    );
  }
}

/** Validates and brands an amount in centavos. Throws `RangeError` when invalid. */
export function copCents(value: number): CopCents {
  assertInteger(value, "amount");
  if (value < 0) {
    throw new RangeError("amount must not be negative");
  }
  if (value > MAX_COP_CENTS) {
    throw new RangeError("amount exceeds the maximum supported value");
  }
  return value as CopCents;
}

/** Type guard for values that are valid centavo amounts. */
export function isCopCents(value: unknown): value is CopCents {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COP_CENTS
  );
}

export function zeroCopCents(): CopCents {
  return 0 as CopCents;
}

/** Sums amounts. Overflow throws instead of silently losing precision. */
export function addCopCents(...values: readonly CopCents[]): CopCents {
  let total = 0;
  for (const value of values) {
    total += value;
    if (total > MAX_COP_CENTS) {
      throw new RangeError("sum of amounts exceeds the maximum supported value");
    }
  }
  return total as CopCents;
}

/**
 * Multiplies a unit price by a quantity. Used for order lines where every unit has
 * the same price; quantity-based discounts are applied by the pricing tier logic,
 * not here.
 */
export function multiplyCopCents(unitAmount: CopCents, quantity: number): CopCents {
  assertInteger(quantity, "quantity");
  if (quantity < 0) {
    throw new RangeError("quantity must not be negative");
  }
  const result = unitAmount * quantity;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("product of amount and quantity exceeds the maximum supported value");
  }
  return result as CopCents;
}

/** Subtracts a discount or refund from an amount. Never returns a negative amount. */
export function subtractCopCents(amount: CopCents, deduction: CopCents): CopCents {
  return (amount > deduction ? amount - deduction : 0) as CopCents;
}

/** Converts centavos to whole pesos for display purposes. */
export function copCentsToPesos(amount: CopCents): number {
  return amount / CENTS_PER_PESO;
}

/**
 * Formats an amount the way Colombians write money: `$1.234` (dot as thousands
 * separator). Centavos are only shown when present, which never happens for real
 * ticket prices but keeps the function honest.
 */
export function formatCopCents(amount: CopCents): string {
  const pesos = Math.trunc(amount / CENTS_PER_PESO);
  const centavos = amount % CENTS_PER_PESO;
  const grouped = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return centavos === 0 ? `$${grouped}` : `$${grouped},${String(centavos).padStart(2, "0")}`;
}

/**
 * Parses a human/operator-supplied peso amount into centavos.
 *
 * Accepted input: `95000`, `95.000` (Colombian thousands separator), `95000,50`
 * (comma as the decimal separator), or a plain number of pesos.
 * Rejected input: anything with ambiguous grouping or non-numeric characters.
 */
export function parsePesosToCopCents(input: string | number): CopCents {
  if (typeof input === "number") {
    assertInteger(input, "peso amount");
    return copCents(input * CENTS_PER_PESO);
  }

  const trimmed = input.trim();
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(trimmed)) {
    throw new RangeError("amount must be a positive number of pesos, optionally grouped with dots");
  }

  const [integerPart = "", decimalPart = ""] = trimmed.replace(/\./g, "").split(",");
  const pesos = Number.parseInt(integerPart, 10);
  const centavos = decimalPart.length === 0 ? 0 : Number.parseInt(decimalPart.padEnd(2, "0"), 10);
  return copCents(pesos * CENTS_PER_PESO + centavos);
}
