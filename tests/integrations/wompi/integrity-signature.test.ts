import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AppError } from "@shared/domain/errors.ts";
import {
  buildIntegritySignaturePayload,
  computeIntegritySignature,
  constantTimeEqualsHex,
  formatWompiExpirationTime,
  sha256Hex,
} from "@shared/integrations/wompi/signature.ts";

/** Independent reference implementation, deliberately not using Web Crypto. */
function sha256HexWithNode(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("Wompi integrity signature", () => {
  // Exact values published in the official documentation
  // (docs.wompi.co > Widget & Checkout Web > step 3 > Generate an integrity signature).
  const OFFICIAL_REFERENCE = "sk8-438k4-xmxm392-sn2m";
  const OFFICIAL_AMOUNT_IN_CENTS = 2_490_000;
  const OFFICIAL_CURRENCY = "COP";
  const OFFICIAL_INTEGRITY_SECRET = "prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6";
  const OFFICIAL_SIGNATURE = "37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5";

  it("reproduces the official documentation vector", async () => {
    const signature = await computeIntegritySignature({
      reference: OFFICIAL_REFERENCE,
      amountInCents: OFFICIAL_AMOUNT_IN_CENTS,
      currency: OFFICIAL_CURRENCY,
      integritySecret: OFFICIAL_INTEGRITY_SECRET,
    });
    expect(signature).toBe(OFFICIAL_SIGNATURE);
  });

  it("hashes the values in the documented order: reference, amount, currency, secret", () => {
    const payload = buildIntegritySignaturePayload({
      reference: OFFICIAL_REFERENCE,
      amountInCents: OFFICIAL_AMOUNT_IN_CENTS,
      currency: OFFICIAL_CURRENCY,
      integritySecret: OFFICIAL_INTEGRITY_SECRET,
    });
    expect(payload).toBe(
      `${OFFICIAL_REFERENCE}${String(OFFICIAL_AMOUNT_IN_CENTS)}${OFFICIAL_CURRENCY}${OFFICIAL_INTEGRITY_SECRET}`,
    );
    expect(payload).toBe(
      "sk8-438k4-xmxm392-sn2m2490000COPprod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6",
    );
  });

  it("inserts expiration-time before the secret, as documented", async () => {
    const expirationTime = "2023-06-09T20:28:50.000Z";
    const input = {
      reference: OFFICIAL_REFERENCE,
      amountInCents: OFFICIAL_AMOUNT_IN_CENTS,
      currency: OFFICIAL_CURRENCY,
      expirationTime,
      integritySecret: OFFICIAL_INTEGRITY_SECRET,
    };

    const payload = buildIntegritySignaturePayload(input);
    expect(payload).toBe(
      "sk8-438k4-xmxm392-sn2m2490000COP2023-06-09T20:28:50.000Zprod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6",
    );

    // Cross-checked against an independent SHA-256 implementation.
    expect(await computeIntegritySignature(input)).toBe(sha256HexWithNode(payload));
    // With an expiration the digest must differ from the plain form.
    expect(await computeIntegritySignature(input)).not.toBe(OFFICIAL_SIGNATURE);
  });

  it("formats expiration-time as Wompi documents it (millisecond, Z suffix)", () => {
    const formatted = formatWompiExpirationTime(new Date("2023-06-09T20:28:50.000Z"));
    expect(formatted).toBe("2023-06-09T20:28:50.000Z");
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("produces the same hex as an independent SHA-256 implementation", async () => {
    const sample = "boleteria-2026";
    expect(await sha256Hex(sample)).toBe(sha256HexWithNode(sample));
    expect(await sha256Hex(sample)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("only signs COP amounts, because Wompi supports no other currency", async () => {
    await expect(
      computeIntegritySignature({
        reference: OFFICIAL_REFERENCE,
        amountInCents: 1000,
        currency: "USD",
        integritySecret: OFFICIAL_INTEGRITY_SECRET,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses to sign invalid inputs instead of producing a hash Wompi will reject", async () => {
    await expect(
      computeIntegritySignature({
        reference: "reference with spaces",
        amountInCents: 1000,
        currency: "COP",
        integritySecret: OFFICIAL_INTEGRITY_SECRET,
      }),
    ).rejects.toBeInstanceOf(AppError);

    await expect(
      computeIntegritySignature({
        reference: OFFICIAL_REFERENCE,
        amountInCents: 10.5,
        currency: "COP",
        integritySecret: OFFICIAL_INTEGRITY_SECRET,
      }),
    ).rejects.toBeInstanceOf(AppError);

    await expect(
      computeIntegritySignature({
        reference: OFFICIAL_REFERENCE,
        amountInCents: 1000,
        currency: "COP",
        integritySecret: "",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("compares digests in constant time and case-insensitively", () => {
    const upper = OFFICIAL_SIGNATURE.toUpperCase();
    expect(constantTimeEqualsHex(OFFICIAL_SIGNATURE, OFFICIAL_SIGNATURE)).toBe(true);
    expect(constantTimeEqualsHex(` ${upper} `, OFFICIAL_SIGNATURE)).toBe(true);
    expect(constantTimeEqualsHex("00", OFFICIAL_SIGNATURE)).toBe(false);
    expect(constantTimeEqualsHex(OFFICIAL_SIGNATURE.slice(0, -1), OFFICIAL_SIGNATURE)).toBe(false);
  });
});
