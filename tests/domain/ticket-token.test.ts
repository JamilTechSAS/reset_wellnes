import { describe, expect, it } from "vitest";

import {
  generateTicketToken,
  isValidTicketToken,
  normalizeTicketToken,
  TICKET_TOKEN_PREFIX,
  TICKET_TOKEN_RANDOM_LENGTH,
} from "@shared/domain/ticket-token.ts";

describe("ticket tokens", () => {
  it("issues opaque TKT_ tokens with the documented shape", () => {
    const token = generateTicketToken();
    expect(token.startsWith(TICKET_TOKEN_PREFIX)).toBe(true);
    expect(token).toMatch(/^TKT_[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(isValidTicketToken(token)).toBe(true);
    expect(token.length).toBe(TICKET_TOKEN_PREFIX.length + TICKET_TOKEN_RANDOM_LENGTH);
  });

  it("contains no personal data and no readable structure", () => {
    const token = generateTicketToken();
    // Crockford base32 excludes I, L, O and U so humans cannot misread them.
    const body = token.slice(TICKET_TOKEN_PREFIX.length);
    expect(body).not.toMatch(/[ILOU]/);
    expect(token).not.toMatch(/@|\d{6,}-\d/);
  });

  it("draws 13 random bytes (104 bits) so guessing is infeasible", () => {
    let requested: number | undefined;
    generateTicketToken((length) => {
      requested = length;
      return new Uint8Array(length).fill(7);
    });
    expect(requested).toBe(13);
  });

  it("is deterministic when the byte source is injected", () => {
    const zeros = generateTicketToken(() => new Uint8Array(13));
    expect(zeros).toBe("TKT_00000000000000000000");
    const ones = generateTicketToken(() => new Uint8Array(13).fill(0xff));
    expect(ones).toBe("TKT_ZZZZZZZZZZZZZZZZZZZZ");
  });

  it("does not repeat across a large sample", () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      tokens.add(generateTicketToken());
    }
    expect(tokens.size).toBe(2_000);
  });

  it("rejects malformed tokens", () => {
    const valid = generateTicketToken();
    expect(isValidTicketToken(valid.toLowerCase())).toBe(false);
    expect(isValidTicketToken(`${valid}X`)).toBe(false);
    expect(isValidTicketToken(valid.slice(0, -1))).toBe(false);
    expect(isValidTicketToken("TKT_OOOOOOOOOOOOOOOOOOOO")).toBe(false);
    expect(isValidTicketToken("TKT_")).toBe(false);
    expect(isValidTicketToken("")).toBe(false);
  });

  it("normalizes scanner and manual input to the canonical form", () => {
    const token = generateTicketToken();
    expect(normalizeTicketToken(token)).toBe(token);
    expect(normalizeTicketToken(`  ${token.toLowerCase()}  `)).toBe(token);
    expect(normalizeTicketToken(`#${token}`)).toBe(token);
    expect(normalizeTicketToken(`https://api.example.com/functions/v1/t/${token}`)).toBe(token);
    expect(normalizeTicketToken(`https://evento.example/t/${token}/`)).toBe(token);
    expect(normalizeTicketToken("https://evento.example/t/not-a-token")).toBeUndefined();
    expect(normalizeTicketToken("   ")).toBeUndefined();
  });
});
