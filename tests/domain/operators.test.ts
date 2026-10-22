import { describe, expect, it } from "vitest";

import {
  ADMISSION_ROLES,
  canAdmitTickets,
  isOperatorRole,
  operatorAttendanceLabel,
  OPERATOR_LABEL_MAX_LENGTH,
  OPERATOR_ROLES,
  type OperatorIdentity,
} from "@shared/domain/operators.ts";

function identity(overrides: Partial<OperatorIdentity> = {}): OperatorIdentity {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "puerta@evento.example",
    displayName: "Operador Puerta 1",
    role: "OPERATOR",
    ...overrides,
  };
}

describe("operator authorization vocabulary", () => {
  it("declares exactly the roles the database CHECK constraint accepts", () => {
    expect([...OPERATOR_ROLES]).toEqual(["OPERATOR", "ADMIN"]);
    expect(isOperatorRole("OPERATOR")).toBe(true);
    expect(isOperatorRole("ADMIN")).toBe(true);
    expect(isOperatorRole("FINANCE")).toBe(false);
    expect(isOperatorRole(undefined)).toBe(false);
    expect(isOperatorRole(7)).toBe(false);
  });

  it("only lets admission roles admit tickets", () => {
    expect([...ADMISSION_ROLES]).toEqual(["OPERATOR", "ADMIN"]);
    for (const role of OPERATOR_ROLES) {
      expect(canAdmitTickets(role)).toBe(true);
    }
    // A value outside the vocabulary fails closed even when forced through the type.
    expect(canAdmitTickets("VIEWER" as never)).toBe(false);
  });

  it("bounds the recorded label and strips control characters", () => {
    expect(operatorAttendanceLabel(identity())).toBe("Operador Puerta 1");
    expect(operatorAttendanceLabel(identity({ displayName: "  Puerta\n1\tNorte  " }))).toBe(
      "Puerta 1 Norte",
    );
    const long = operatorAttendanceLabel(identity({ displayName: "x".repeat(200) }));
    expect(long.length).toBe(OPERATOR_LABEL_MAX_LENGTH);
  });
});
