/**
 * Phase 6B pure helpers: money/date formatting, form validation, browser-local persistence,
 * payment-return parsing, form normalization and session persistence.
 *
 * These are the modules where a mistake would be invisible in a happy-path click-through, so
 * they are exercised directly and adversarially (corrupt storage, a provider return that
 * carries nothing, and hostile form input).
 */

import { describe, expect, it } from "vitest";
import {
  availabilityIsPurchasable,
  availabilityLabel,
  formatCopCents,
  formatEventDate,
  formatEventTime,
  isDeclinedPaymentStatus,
  isUnrecoverableOrderStatus,
} from "../../src/purchase/format.ts";
import {
  EMPTY_PARTICIPANT_FORM,
  backendPathToField,
  digitsOnly,
  issuesForField,
  normalizeInstagram,
  validateParticipantForm,
  type ParticipantFormValues,
} from "../../src/purchase/validation.ts";
import {
  defaultStore,
  generateIdempotencyKey,
  loadDraft,
  loadPendingOrder,
  participantFromDraft,
  saveDraft,
  savePendingOrder,
} from "../../src/purchase/persistence.ts";
import { parseReturnContext } from "../../src/purchase/return-route.ts";

const VALID_FORM: ParticipantFormValues = {
  firstName: "Ana",
  lastName: "Pérez",
  nationalId: "1023456789",
  email: "ana@example.com",
  phone: "3001234567",
  city: "Bogotá",
  instagram: "anap",
  dataProcessing: true,
  futureEvents: false,
};

describe("formatCopCents", () => {
  it("formats integer centavos as Colombian pesos", () => {
    expect(formatCopCents(0)).toBe("$0");
    expect(formatCopCents(9_500_000)).toBe("$95.000");
    expect(formatCopCents(100_000_000)).toBe("$1.000.000");
    expect(formatCopCents(99)).toBe("$0,99");
    expect(formatCopCents(150)).toBe("$1,50");
  });

  it("keeps the sign of a discount line", () => {
    expect(formatCopCents(-9_500_000)).toBe("-$95.000");
  });

  it("never renders NaN or Infinity to the buyer", () => {
    expect(formatCopCents(Number.NaN)).toBe("$0");
    expect(formatCopCents(Number.POSITIVE_INFINITY)).toBe("$0");
  });
});

describe("event date and time", () => {
  it("renders the Spanish date in the event's own time zone", () => {
    // The real event window: 18:00 UTC is 1:00 p. m. in Bogotá (UTC-5), same day.
    expect(formatEventDate("2026-11-15T18:00:00.000Z", "America/Bogota")).toBe(
      "15 de noviembre de 2026",
    );
    expect(formatEventTime("2026-11-15T18:00:00.000Z", "America/Bogota")).toBe("1:00 p. m.");
  });

  it("falls back when the backend has no usable date", () => {
    expect(formatEventDate(null, "America/Bogota")).toBe("Fecha por confirmar");
    expect(formatEventDate("no-es-fecha", "America/Bogota")).toBe("Fecha por confirmar");
    expect(formatEventTime(null, "America/Bogota")).toBe("");
    expect(formatEventTime("no-es-fecha", "America/Bogota")).toBe("");
  });

  it("falls back on an unknown time zone instead of throwing", () => {
    expect(formatEventDate("2026-11-15T18:00:00.000Z", "Marte/Olympus")).toBe(
      "Fecha por confirmar",
    );
  });
});

describe("availability", () => {
  it("labels every documented availability value in Spanish", () => {
    expect(availabilityLabel("AVAILABLE")).toBe("Disponible");
    expect(availabilityLabel("LOW")).toBe("Últimos cupos");
    expect(availabilityLabel("SOLD_OUT")).toBe("Agotado");
    expect(availabilityLabel("NOT_STARTED")).toBe("Venta próximamente");
    expect(availabilityLabel("CLOSED")).toBe("Venta cerrada");
  });

  it("only treats available and low as purchasable", () => {
    expect(availabilityIsPurchasable("AVAILABLE")).toBe(true);
    expect(availabilityIsPurchasable("LOW")).toBe(true);
    expect(availabilityIsPurchasable("SOLD_OUT")).toBe(false);
    expect(availabilityIsPurchasable("NOT_STARTED")).toBe(false);
    expect(availabilityIsPurchasable("CLOSED")).toBe(false);
  });
});

describe("order and payment terminal states", () => {
  it("flags a settled payment that was not approved", () => {
    for (const status of ["declined", "voided", "refunded", "error"]) {
      expect(isDeclinedPaymentStatus(status)).toBe(true);
    }
    // An approved payment is settled but must never be routed to the "declined" copy.
    expect(isDeclinedPaymentStatus("approved")).toBe(false);
    expect(isDeclinedPaymentStatus("pending")).toBe(false);
    expect(isDeclinedPaymentStatus(undefined)).toBe(false);
  });

  it("flags the order states that cannot be fixed by waiting", () => {
    expect(isUnrecoverableOrderStatus("EXPIRED")).toBe(true);
    expect(isUnrecoverableOrderStatus("CANCELLED")).toBe(true);
    expect(isUnrecoverableOrderStatus("PENDING")).toBe(false);
    expect(isUnrecoverableOrderStatus("PAID")).toBe(false);
  });
});

describe("validateParticipantForm", () => {
  it("accepts a complete form and reports nothing", () => {
    expect(validateParticipantForm(VALID_FORM)).toEqual([]);
  });

  it("reports every required field at once on an empty form", () => {
    const issues = validateParticipantForm(EMPTY_PARTICIPANT_FORM);
    const fields = issues.map((issue) => issue.field);
    expect(fields).toEqual(
      expect.arrayContaining(["firstName", "lastName", "nationalId", "email", "phone", "city"]),
    );
    expect(issuesForField(issues, "dataProcessing")).toEqual([
      "Debes autorizar el tratamiento de tus datos para continuar.",
    ]);
    // Future-events communications are optional: no issue when unchecked.
    expect(issuesForField(issues, "futureEvents")).toEqual([]);
  });

  it("treats the future-events consent as optional but the data consent as mandatory", () => {
    expect(validateParticipantForm({ ...VALID_FORM, futureEvents: false })).toEqual([]);
    expect(
      validateParticipantForm({ ...VALID_FORM, dataProcessing: false }).map((i) => i.field),
    ).toEqual(["dataProcessing"]);
  });

  it("rejects a cédula that is not 6 to 12 digits once punctuation is stripped", () => {
    for (const nationalId of ["12345", "1234567890123", "", "sin digito"]) {
      expect(
        issuesForField(validateParticipantForm({ ...VALID_FORM, nationalId }), "nationalId"),
      ).toEqual(["La cédula debe tener entre 6 y 12 dígitos."]);
    }
    // The backend stores digits only, so a formatted cédula is accepted as typed.
    expect(validateParticipantForm({ ...VALID_FORM, nationalId: "1.023.456" })).toEqual([]);
    expect(validateParticipantForm({ ...VALID_FORM, nationalId: "102345" })).toEqual([]);
    expect(validateParticipantForm({ ...VALID_FORM, nationalId: "102345678901" })).toEqual([]);
  });

  it("rejects a malformed email", () => {
    for (const email of ["", "ana@", "ana@example", "@example.com", "ana example@x.co"]) {
      expect(issuesForField(validateParticipantForm({ ...VALID_FORM, email }), "email")).toEqual([
        "Escribe un correo electrónico válido.",
      ]);
    }
    expect(validateParticipantForm({ ...VALID_FORM, email: "ana.perez+1@example.co" })).toEqual([]);
  });

  it("rejects a phone that is not 7 to 15 digits once punctuation is stripped", () => {
    for (const phone of ["300123", "", "sin digito"]) {
      expect(issuesForField(validateParticipantForm({ ...VALID_FORM, phone }), "phone")).toEqual([
        "El celular debe tener entre 7 y 15 dígitos.",
      ]);
    }
    expect(validateParticipantForm({ ...VALID_FORM, phone: "3001234567" })).toEqual([]);
    // A formatted or international number is accepted as typed; the digits are what count.
    expect(validateParticipantForm({ ...VALID_FORM, phone: "+57 (300) 123-4567" })).toEqual([]);
  });

  it("requires a plausible city and normalizes an optional Instagram handle", () => {
    expect(issuesForField(validateParticipantForm({ ...VALID_FORM, city: "A" }), "city")).toEqual([
      "Escribe la ciudad donde resides.",
    ]);
    expect(issuesForField(validateParticipantForm({ ...VALID_FORM, city: "  " }), "city")).toEqual([
      "Escribe la ciudad donde resides.",
    ]);
    // An empty handle is fine; a handle with characters the backend would reject is not.
    expect(validateParticipantForm({ ...VALID_FORM, instagram: "" })).toEqual([]);
    expect(
      issuesForField(
        validateParticipantForm({ ...VALID_FORM, instagram: "ana-perez" }),
        "instagram",
      ),
    ).toEqual(["El usuario de Instagram solo admite letras, números, punto y guion bajo."]);
    // `@Ana.P` normalizes to a valid handle.
    expect(validateParticipantForm({ ...VALID_FORM, instagram: "@Ana.P" })).toEqual([]);
  });

  it("trims surrounding whitespace instead of rejecting it", () => {
    expect(
      validateParticipantForm({
        ...VALID_FORM,
        firstName: "  Ana ",
        lastName: " Pérez ",
        city: " Bogotá ",
        email: " ana@example.com ",
      }),
    ).toEqual([]);
  });
});

describe("validation value normalization", () => {
  it("keeps digits only for cédula and phone", () => {
    expect(digitsOnly("1.023.456.789")).toBe("1023456789");
    expect(digitsOnly("+57 (300) 123-4567")).toBe("573001234567");
    expect(digitsOnly("sin numeros")).toBe("");
  });

  it("normalizes an Instagram handle the way the backend does", () => {
    expect(normalizeInstagram("  @Ana.P  ")).toBe("ana.p");
    expect(normalizeInstagram("@@ana")).toBe("ana");
    expect(normalizeInstagram("")).toBe("");
  });

  it("maps backend issue paths onto form fields", () => {
    expect(backendPathToField("nationalId")).toBe("nationalId");
    expect(backendPathToField("consents.dataProcessing")).toBe("dataProcessing");
    expect(backendPathToField("consents.futureEvents")).toBe("futureEvents");
    expect(backendPathToField("dataProcessing")).toBe("dataProcessing");
    expect(backendPathToField("quantity")).toBeUndefined();
    expect(backendPathToField("")).toBeUndefined();
  });
});

describe("idempotency key", () => {
  it("satisfies the backend contract of 16–128 printable ASCII characters", () => {
    const key = generateIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^[\x20-\x7e]+$/);
    expect(key).toMatch(/^order-[0-9a-f-]{36}$/);
  });

  it("is unique per generation", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  it("uses the injected random source (so tests are deterministic)", () => {
    expect(generateIdempotencyKey(() => "11111111-2222-3333-4444-555555555555")).toBe(
      "order-11111111-2222-3333-4444-555555555555",
    );
  });
});

describe("pending-order correlation", () => {
  function memory() {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      map,
    };
  }

  it("round-trips the order the browser must ask about after a return", () => {
    const store = memory();
    savePendingOrder(store, {
      reference: "EVT-2026-000042",
      buyerEmail: "ana@example.com",
      attempt: 1,
      createdAt: "2026-10-05T19:00:00.000Z",
    });
    expect(loadPendingOrder(store)).toEqual({
      reference: "EVT-2026-000042",
      buyerEmail: "ana@example.com",
      attempt: 1,
      createdAt: "2026-10-05T19:00:00.000Z",
    });
  });

  it("discards a corrupt entry instead of breaking the return page", () => {
    const store = memory();
    store.setItem("ticket:pending-order:v1", "{not json");
    expect(loadPendingOrder(store)).toBeUndefined();
    expect(store.getItem("ticket:pending-order:v1")).toBeNull();
  });

  it("discards an entry that no longer has the required fields", () => {
    const store = memory();
    store.setItem("ticket:pending-order:v1", JSON.stringify({ reference: 42 }));
    expect(loadPendingOrder(store)).toBeUndefined();
    expect(store.getItem("ticket:pending-order:v1")).toBeNull();
  });

  it("tolerates a missing attempt/createdAt from an older draft", () => {
    const store = memory();
    store.setItem(
      "ticket:pending-order:v1",
      JSON.stringify({ reference: "EVT-2026-000001", buyerEmail: "ana@example.com" }),
    );
    expect(loadPendingOrder(store)).toEqual({
      reference: "EVT-2026-000001",
      buyerEmail: "ana@example.com",
      attempt: 1,
      createdAt: "",
    });
  });
});

describe("form draft", () => {
  function memory() {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      map,
    };
  }

  it("restores what the buyer typed, but never the consents", () => {
    const store = memory();
    saveDraft(store, {
      quantity: 2,
      discountCode: "VERANO",
      participant: {
        firstName: "Ana",
        lastName: "Pérez",
        nationalId: "1023456789",
        email: "ana@example.com",
        phone: "3001234567",
        city: "Bogotá",
        instagram: "anap",
      },
    });
    const draft = loadDraft(store);
    expect(draft).toEqual({
      quantity: 2,
      discountCode: "VERANO",
      participant: {
        firstName: "Ana",
        lastName: "Pérez",
        nationalId: "1023456789",
        email: "ana@example.com",
        phone: "3001234567",
        city: "Bogotá",
        instagram: "anap",
      },
    });

    const restored = participantFromDraft(draft, EMPTY_PARTICIPANT_FORM);
    expect(restored.firstName).toBe("Ana");
    expect(restored.dataProcessing).toBe(false);
    expect(restored.futureEvents).toBe(false);
  });

  it("does not restore a consent even if a tampered draft claims it", () => {
    const store = memory();
    store.setItem(
      "ticket:purchase-draft:v1",
      JSON.stringify({
        quantity: 1,
        discountCode: "",
        participant: {
          firstName: "Ana",
          lastName: "Pérez",
          nationalId: "1023456789",
          email: "ana@example.com",
          phone: "3001234567",
          city: "Bogotá",
          instagram: "",
          dataProcessing: true,
          futureEvents: true,
        },
      }),
    );
    const restored = participantFromDraft(loadDraft(store), EMPTY_PARTICIPANT_FORM);
    expect(restored.dataProcessing).toBe(false);
    expect(restored.futureEvents).toBe(false);
  });

  it("ignores a draft without a quantity and fills missing fields with blanks", () => {
    const store = memory();
    store.setItem("ticket:purchase-draft:v1", JSON.stringify({ discountCode: "X" }));
    expect(loadDraft(store)).toBeUndefined();

    store.setItem(
      "ticket:purchase-draft:v1",
      JSON.stringify({ quantity: 1, participant: { firstName: "Ana" } }),
    );
    const draft = loadDraft(store);
    expect(draft?.participant.lastName).toBe("");
    expect(draft?.participant.email).toBe("");
  });

  it("returns the blank form when there is no draft at all", () => {
    expect(participantFromDraft(undefined, EMPTY_PARTICIPANT_FORM)).toBe(EMPTY_PARTICIPANT_FORM);
  });
});

describe("defaultStore", () => {
  it("falls back to an in-memory store outside the browser (no sessionStorage)", () => {
    // The vitest environment is `node`: this exercises the fallback that keeps the purchase
    // flow working in environments without sessionStorage.
    expect(typeof sessionStorage).toBe("undefined");
    const store = defaultStore();
    store.setItem("probe", "1");
    expect(defaultStore().getItem("probe")).toBe("1");
    store.removeItem("probe");
    expect(store.getItem("probe")).toBeNull();
  });
});

describe("parseReturnContext", () => {
  it("recognizes a Wompi return with the transaction id", () => {
    const context = parseReturnContext(
      new URL("http://localhost:3000/gracias?id=1234-5678-9012&env=test"),
    );
    expect(context.isReturn).toBe(true);
    expect(context.transactionId).toBe("1234-5678-9012");
    expect(context.reference).toBeUndefined();
  });

  it("accepts the alternative parameter names Wompi may send", () => {
    const context = parseReturnContext(
      new URL("http://localhost:3000/gracias/?transaction-id=abc-123"),
    );
    expect(context.transactionId).toBe("abc-123");
    expect(context.isReturn).toBe(true);
  });

  it("reads a reference when present, normalizes its case and drops the retry suffix", () => {
    const context = parseReturnContext(
      new URL("http://localhost:3000/gracias?ref=evt-2026-000001-2"),
    );
    // The buyer-facing lookup is about the ORDER, not the payment attempt.
    expect(context.reference).toBe("EVT-2026-000001");
  });

  it("ignores a reference that is not shaped like one of ours", () => {
    const context = parseReturnContext(new URL("http://localhost:3000/gracias?ref=HOLA"));
    expect(context.reference).toBeUndefined();
    expect(context.isReturn).toBe(true);
  });

  it("treats the return path as a return even with no parameters at all", () => {
    expect(parseReturnContext(new URL("http://localhost:3000/gracias")).isReturn).toBe(true);
  });

  it("does not mistake a normal landing-page visit for a return", () => {
    const context = parseReturnContext(new URL("http://localhost:3000/"));
    expect(context.isReturn).toBe(false);
    expect(context.transactionId).toBeUndefined();
    expect(context.reference).toBeUndefined();
  });

  it("treats a transaction id anywhere as a return", () => {
    expect(parseReturnContext(new URL("http://localhost:3000/?id=tx-1")).isReturn).toBe(true);
  });

  it("recognizes an ePayco return by its documented ref_payco parameter", () => {
    const context = parseReturnContext(
      new URL(
        "https://reset-wellnes-staging.vercel.app/gracias?ref_payco=68fb83729d094878e015be00",
      ),
    );
    expect(context.isReturn).toBe(true);
    expect(context.transactionId).toBe("68fb83729d094878e015be00");
    expect(context.reference).toBeUndefined();
  });

  it("does not read the webhook-only x_ref_payco field from the return URL", () => {
    const context = parseReturnContext(new URL("http://localhost:3000/?x_ref_payco=987654"));
    expect(context.isReturn).toBe(false);
    expect(context.transactionId).toBeUndefined();
  });

  it("never derives a payment outcome from success-looking parameters", () => {
    const context = parseReturnContext(
      new URL(
        "http://localhost:3000/gracias?ref_payco=987654&x_response=Aceptada&x_cod_response=1",
      ),
    );
    expect(Object.keys(context).sort()).toEqual(["isReturn", "reference", "transactionId"]);
  });
});
