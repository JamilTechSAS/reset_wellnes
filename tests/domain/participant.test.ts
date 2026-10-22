import { describe, expect, it } from "vitest";

import {
  formatFullName,
  normalizeColombianPhone,
  normalizeInstagram,
  normalizeNationalId,
  parseParticipantInput,
} from "@shared/domain/participant.ts";

const VALID_INPUT = {
  firstName: "María José",
  lastName: "O'Brien",
  nationalId: "1.020.456.789",
  email: "  Maria@Example.COM  ",
  phone: "+57 301 977 7777",
  city: "  Bogotá   D.C. ",
  instagram: "@maria.eventos",
  consents: { dataProcessing: true, futureEvents: false },
};

function issuesOf(result: ReturnType<typeof parseParticipantInput>): readonly string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe("participant input", () => {
  it("accepts and normalizes the documented field set", () => {
    const result = parseParticipantInput(VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual({
      firstName: "María José",
      lastName: "O'Brien",
      nationalId: "1020456789",
      email: "maria@example.com",
      phone: "573019777777",
      city: "Bogotá D.C.",
      instagram: "maria.eventos",
      consents: { dataProcessing: true, futureEvents: false },
    });
  });

  it("strips unknown fields so a client cannot set them", () => {
    const result = parseParticipantInput({
      ...VALID_INPUT,
      ticketPriceInCents: 1,
      orderStatus: "PAID",
      role: "admin",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.value).sort()).toEqual([
      "city",
      "consents",
      "email",
      "firstName",
      "instagram",
      "lastName",
      "nationalId",
      "phone",
    ]);
  });

  it("requires consent to personal data processing", () => {
    const result = parseParticipantInput({
      ...VALID_INPUT,
      consents: { dataProcessing: false, futureEvents: true },
    });
    expect(result.ok).toBe(false);
    expect(issuesOf(result)).toContain("consents.dataProcessing");
  });

  it("accepts a pasted Instagram profile URL and rejects junk handles", () => {
    expect(normalizeInstagram("https://instagram.com/Maria.Eventos/")).toBe("maria.eventos");
    expect(normalizeInstagram("  @Maria_Eventos ")).toBe("maria_eventos");
    expect(normalizeInstagram("")).toBeUndefined();
    expect(normalizeInstagram(undefined)).toBeUndefined();
    expect(normalizeInstagram("not a handle!")).toBeUndefined();
    expect(
      issuesOf(parseParticipantInput({ ...VALID_INPUT, instagram: "not a handle!" })),
    ).toContain("instagram");
  });

  it("reports each invalid field by path instead of throwing", () => {
    const result = parseParticipantInput({
      ...VALID_INPUT,
      nationalId: "abc",
      email: "not-an-email",
      phone: "12",
      city: "",
      lastName: "",
    });
    expect(result.ok).toBe(false);
    const paths = issuesOf(result);
    expect(paths).toContain("nationalId");
    expect(paths).toContain("email");
    expect(paths).toContain("phone");
    expect(paths).toContain("city");
    expect(paths).toContain("lastName");
  });

  it("rejects names containing digits or symbols", () => {
    expect(issuesOf(parseParticipantInput({ ...VALID_INPUT, firstName: "Juan123" }))).toContain(
      "firstName",
    );
    expect(
      issuesOf(parseParticipantInput({ ...VALID_INPUT, lastName: "Pérez <script>" })),
    ).toContain("lastName");
    // Real Colombian names must keep working.
    for (const name of ["María José", "De la Cruz", "O'Brien", "Gutiérrez-Peña", "Ángel"]) {
      expect(issuesOf(parseParticipantInput({ ...VALID_INPUT, firstName: name }))).toEqual([]);
    }
  });

  it("normalizes document numbers as people write them", () => {
    expect(normalizeNationalId("1.020.456.789")).toBe("1020456789");
    expect(normalizeNationalId("1020 456 789")).toBe("1020456789");
    expect(normalizeNationalId("1020456789")).toBe("1020456789");
  });

  it("normalizes Colombian phone numbers to digits with the country code", () => {
    expect(normalizeColombianPhone("3019777777")).toBe("573019777777");
    expect(normalizeColombianPhone("301 977 7777")).toBe("573019777777");
    expect(normalizeColombianPhone("+57 301 977 7777")).toBe("573019777777");
    expect(normalizeColombianPhone("57-301-9777777")).toBe("573019777777");
    expect(normalizeColombianPhone("6012345678")).toBe("576012345678");
    expect(normalizeColombianPhone("0573019777777")).toBe("573019777777");
    expect(normalizeColombianPhone("12")).toBeUndefined();
    expect(normalizeColombianPhone("")).toBeUndefined();
    expect(normalizeColombianPhone("abc")).toBeUndefined();
  });

  it("formats the full name for emails and operator views", () => {
    expect(formatFullName({ firstName: "María José", lastName: "O'Brien" })).toBe(
      "María José O'Brien",
    );
  });
});
