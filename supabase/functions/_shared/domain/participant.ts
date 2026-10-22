/**
 * Participant data: validation and normalization.
 *
 * The field set below is the current requirement (first name, last name, national ID,
 * email, phone, city, Instagram and the two consents). The schema is a single object so
 * new OPTIONAL fields can be added without touching the storage layout: the database keeps
 * canonical columns plus an extension point for additional fields (docs/data-model.md).
 *
 * Validation strategy — one pass, every problem reported:
 *   - zod enforces structure: types, maximum lengths and the consent object shape.
 *   - domain refinements enforce presence and format for each field (names, document
 *     number, email, Colombian phone, handle), collecting ALL issues so the buyer fixes
 *     everything in one round trip instead of discovering errors one at a time.
 *
 * Rules are permissive by design: they reject what is clearly broken and never invent
 * business rules. Exact phone/document policies that depend on client confirmation are
 * documented as open decisions instead of being silently enforced.
 */

import { z } from "zod";

export const PARTICIPANT_FIELD_LIMITS = {
  name: 80,
  email: 254,
  city: 80,
  phone: 30,
  instagramInput: 120,
  nationalId: 20,
} as const;

/** Letters, marks, spaces and the punctuation that appears in real Colombian names. */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}'\-. ]*$/u;

/** Instagram handles: letters, digits, dots and underscores. */
const INSTAGRAM_PATTERN = /^[a-z0-9._]{1,30}$/;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Colombia country calling code, used to build the canonical phone form. */
export const COLOMBIA_CALLING_CODE = "57";

export const participantConsentsSchema = z.object({
  /** Consent to personal data processing (Ley 1581 de 2012). Must be granted. */
  dataProcessing: z.boolean(),
  /** Consent to receive information about future events. Optional by nature. */
  futureEvents: z.boolean(),
});

export const participantInputSchema = z.object({
  firstName: z.string().max(PARTICIPANT_FIELD_LIMITS.name),
  lastName: z.string().max(PARTICIPANT_FIELD_LIMITS.name),
  nationalId: z.string().max(PARTICIPANT_FIELD_LIMITS.nationalId),
  email: z.string().max(PARTICIPANT_FIELD_LIMITS.email),
  phone: z.string().max(PARTICIPANT_FIELD_LIMITS.phone),
  city: z.string().max(PARTICIPANT_FIELD_LIMITS.city),
  instagram: z.string().max(PARTICIPANT_FIELD_LIMITS.instagramInput).optional(),
  consents: participantConsentsSchema,
});

export type ParticipantInput = z.infer<typeof participantInputSchema>;

export type ParticipantConsents = z.infer<typeof participantConsentsSchema>;

/** Participant values in their canonical storage form. */
export type NormalizedParticipant = {
  readonly firstName: string;
  readonly lastName: string;
  /** Digits only (dots and spaces removed, as people write them). */
  readonly nationalId: string;
  /** Lowercased, trimmed. */
  readonly email: string;
  /** Digits only, with the 57 country code when a Colombian number was supplied. */
  readonly phone: string;
  /** Whitespace-collapsed, original casing preserved. */
  readonly city: string;
  /** Handle without the leading @, lowercased; undefined when not supplied. */
  readonly instagram: string | undefined;
  readonly consents: ParticipantConsents;
};

export type ParticipantIssue = { readonly path: string; readonly message: string };

export type ParticipantParseResult =
  | { readonly ok: true; readonly value: NormalizedParticipant }
  | { readonly ok: false; readonly issues: readonly ParticipantIssue[] };

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

/** Removes grouping punctuation from a document number ("1.020.456.789" -> "1020456789"). */
export function normalizeNationalId(value: string): string {
  return value.replace(/[\s.-]/g, "");
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalizes a Colombian phone number to digits with the country code.
 *
 * Accepted: 10-digit mobile (`3019777777`), 10-digit landline with area code,
 * `+57 301 977 7777`, `57-301-9777777`, and 7- to 8-digit local numbers.
 * The rule is intentionally permissive: the exact acceptance policy for landlines and
 * WhatsApp reachability is an open decision with the client.
 */
export function normalizeColombianPhone(value: string): string | undefined {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length === 0) {
    return undefined;
  }
  const withoutLeadingZero = digits.startsWith("0") ? digits.slice(1) : digits;
  if (withoutLeadingZero.startsWith(COLOMBIA_CALLING_CODE) && withoutLeadingZero.length >= 11) {
    return withoutLeadingZero;
  }
  if (withoutLeadingZero.length >= 7 && withoutLeadingZero.length <= 10) {
    return `${COLOMBIA_CALLING_CODE}${withoutLeadingZero}`;
  }
  return undefined;
}

/** Accepts a bare handle or a pasted profile URL, returns the lowercase handle. */
export function normalizeInstagram(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const withoutQuery = trimmed.split("?")[0] ?? trimmed;
  const withoutTrailingSlash = withoutQuery.replace(/\/+$/, "");
  const lastSegment = withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf("/") + 1);
  const handle = lastSegment.replace(/^@/, "").toLowerCase();
  return INSTAGRAM_PATTERN.test(handle) ? handle : undefined;
}

/** Trims every string field before validation: stray whitespace is never meaningful. */
function preprocessStrings(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) {
    return raw;
  }
  const source = raw as Record<string, unknown>;
  const trimmed: Record<string, unknown> = { ...source };
  for (const key of [
    "firstName",
    "lastName",
    "nationalId",
    "email",
    "phone",
    "city",
    "instagram",
  ]) {
    const value = source[key];
    if (typeof value === "string") {
      trimmed[key] = value.trim();
    }
  }
  return trimmed;
}

function toIssues(error: z.ZodError): ParticipantIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
}

/**
 * Parses and normalizes participant input coming from an untrusted client.
 *
 * Never throws: field problems are returned as issues so the API can answer with a 400
 * listing them. Unknown keys are stripped, which prevents a client from setting fields it
 * is not allowed to set (price, status, ids).
 */
export function parseParticipantInput(raw: unknown): ParticipantParseResult {
  const parsed = participantInputSchema.safeParse(preprocessStrings(raw));
  if (!parsed.success) {
    return { ok: false, issues: toIssues(parsed.error) };
  }

  const input = parsed.data;
  const issues: ParticipantIssue[] = [];

  const firstName = collapseWhitespace(input.firstName);
  if (firstName.length === 0) {
    issues.push({ path: "firstName", message: "First name is required" });
  } else if (!NAME_PATTERN.test(firstName)) {
    issues.push({ path: "firstName", message: "First name contains unsupported characters" });
  }

  const lastName = collapseWhitespace(input.lastName);
  if (lastName.length === 0) {
    issues.push({ path: "lastName", message: "Last name is required" });
  } else if (!NAME_PATTERN.test(lastName)) {
    issues.push({ path: "lastName", message: "Last name contains unsupported characters" });
  }

  const nationalId = normalizeNationalId(input.nationalId);
  if (nationalId.length === 0) {
    issues.push({ path: "nationalId", message: "National ID is required" });
  } else if (!/^\d{6,12}$/.test(nationalId)) {
    issues.push({
      path: "nationalId",
      message: "National ID must contain between 6 and 12 digits",
    });
  }

  const email = normalizeEmail(input.email);
  if (email.length === 0) {
    issues.push({ path: "email", message: "Email is required" });
  } else if (!EMAIL_PATTERN.test(email)) {
    issues.push({ path: "email", message: "A valid email address is required" });
  }

  // Empty string is the "could not normalize" sentinel; an issue is pushed for it below,
  // so an unnormalized value can never leave this function.
  const phone = normalizeColombianPhone(input.phone) ?? "";
  if (phone.length === 0) {
    issues.push({ path: "phone", message: "Phone must contain between 7 and 12 digits" });
  }

  const city = collapseWhitespace(input.city);
  if (city.length < 2) {
    issues.push({ path: "city", message: "City is required" });
  }

  const instagram = normalizeInstagram(input.instagram);
  if (input.instagram !== undefined && input.instagram.length > 0 && instagram === undefined) {
    issues.push({ path: "instagram", message: "Instagram handle is not valid" });
  }

  if (!input.consents.dataProcessing) {
    issues.push({
      path: "consents.dataProcessing",
      message: "Consent to personal data processing is required to buy a ticket",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      firstName,
      lastName,
      nationalId,
      email,
      phone,
      city,
      instagram,
      consents: input.consents,
    },
  };
}

/** Full display name, as used in emails and operator views. */
export function formatFullName(
  participant: Pick<NormalizedParticipant, "firstName" | "lastName">,
): string {
  return `${participant.firstName} ${participant.lastName}`.trim();
}
