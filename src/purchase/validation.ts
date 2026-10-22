/**
 * Participant/buyer form validation (Phase 6B).
 *
 * These rules MIRROR the backend (`app_private.normalize_order_input` and
 * `supabase/functions/_shared/domain/participant.ts`) so the buyer gets immediate, field-level
 * feedback in Spanish. They are a convenience only: the backend re-validates everything inside
 * the order transaction and remains the single source of truth. When the backend rejects a
 * field it returns `details.issues[]`, and the UI maps those back onto the same fields.
 */

export type ParticipantFormValues = {
  readonly firstName: string;
  readonly lastName: string;
  readonly nationalId: string;
  readonly email: string;
  readonly phone: string;
  readonly city: string;
  readonly instagram: string;
  readonly dataProcessing: boolean;
  readonly futureEvents: boolean;
};

export type ParticipantField = keyof ParticipantFormValues;

export type FieldIssue = {
  readonly field: ParticipantField;
  readonly message: string;
};

export const EMPTY_PARTICIPANT_FORM: ParticipantFormValues = {
  firstName: "",
  lastName: "",
  nationalId: "",
  email: "",
  phone: "",
  city: "",
  instagram: "",
  dataProcessing: false,
  futureEvents: false,
};

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NATIONAL_ID_PATTERN = /^[0-9]{6,12}$/;
const PHONE_PATTERN = /^[0-9]{7,15}$/;
const INSTAGRAM_PATTERN = /^[a-z0-9._]{1,30}$/;
const DIGITS_ONLY = /[^0-9]/g;

/** Digits only, matching the backend normalization for cédula and phone. */
export function digitsOnly(value: string): string {
  return value.replace(DIGITS_ONLY, "");
}

/** Lowercase handle without the leading `@`, matching the backend normalization. */
export function normalizeInstagram(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Validates the form and returns every problem at once, so the buyer fixes everything in
 * one pass. An empty array means the backend will accept these values.
 */
export function validateParticipantForm(values: ParticipantFormValues): readonly FieldIssue[] {
  const issues: FieldIssue[] = [];
  const firstName = values.firstName.trim();
  const lastName = values.lastName.trim();
  const nationalId = digitsOnly(values.nationalId);
  const email = values.email.trim();
  const phone = digitsOnly(values.phone);
  const city = values.city.trim();
  const instagram = normalizeInstagram(values.instagram);

  if (firstName.length === 0) {
    issues.push({ field: "firstName", message: "Escribe tu nombre." });
  } else if (firstName.length > 80) {
    issues.push({ field: "firstName", message: "El nombre no puede superar 80 caracteres." });
  }

  if (lastName.length === 0) {
    issues.push({ field: "lastName", message: "Escribe tu apellido." });
  } else if (lastName.length > 80) {
    issues.push({ field: "lastName", message: "El apellido no puede superar 80 caracteres." });
  }

  if (!NATIONAL_ID_PATTERN.test(nationalId)) {
    issues.push({
      field: "nationalId",
      message: "La cédula debe tener entre 6 y 12 dígitos.",
    });
  }

  if (email.length === 0 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    issues.push({ field: "email", message: "Escribe un correo electrónico válido." });
  }

  if (!PHONE_PATTERN.test(phone)) {
    issues.push({
      field: "phone",
      message: "El celular debe tener entre 7 y 15 dígitos.",
    });
  }

  if (city.length < 2 || city.length > 80) {
    issues.push({ field: "city", message: "Escribe la ciudad donde resides." });
  }

  if (instagram.length > 0 && !INSTAGRAM_PATTERN.test(instagram)) {
    issues.push({
      field: "instagram",
      message: "El usuario de Instagram solo admite letras, números, punto y guion bajo.",
    });
  }

  if (!values.dataProcessing) {
    issues.push({
      field: "dataProcessing",
      message: "Debes autorizar el tratamiento de tus datos para continuar.",
    });
  }

  return issues;
}

export function issuesForField(
  issues: readonly FieldIssue[],
  field: ParticipantField,
): readonly string[] {
  return issues.filter((issue) => issue.field === field).map((issue) => issue.message);
}

/** Maps a backend field path (e.g. `nationalId`, `consents.dataProcessing`) to a form field. */
export function backendPathToField(path: string): ParticipantField | undefined {
  const normalized = path.trim();
  switch (normalized) {
    case "firstName":
      return "firstName";
    case "lastName":
      return "lastName";
    case "nationalId":
      return "nationalId";
    case "email":
      return "email";
    case "phone":
      return "phone";
    case "city":
      return "city";
    case "instagram":
      return "instagram";
    case "consents.dataProcessing":
    case "dataProcessing":
      return "dataProcessing";
    case "consents.futureEvents":
    case "futureEvents":
      return "futureEvents";
    default:
      return undefined;
  }
}
