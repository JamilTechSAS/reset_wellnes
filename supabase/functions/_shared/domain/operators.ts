/**
 * Operator identity and authorization vocabulary.
 *
 * Authentication is Supabase Auth (a real `auth.users` account with an email and a password
 * or magic link); this module only describes the AUTHORIZATION layer on top of it, which
 * lives in `public.operators` (user id, display name, role, active flag).
 *
 * Why this shape:
 *   * no custom username/password system and no shared permanent operator secret — the
 *     Phase 4 `CHECKIN_API_TOKEN` idea was replaced before it ever shipped;
 *   * roles are a stable, small vocabulary so financial/administrative capabilities can be
 *     separated later without changing the authentication mechanism;
 *   * `FORBIDDEN` (authenticated but not an operator) and `UNAUTHORIZED` (not
 *     authenticated) are different answers, which makes the two failure modes testable and
 *     gives operators a precise error when their account was deactivated.
 */

export const OPERATOR_ROLES = ["OPERATOR", "ADMIN"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export function isOperatorRole(value: unknown): value is OperatorRole {
  return typeof value === "string" && (OPERATOR_ROLES as readonly string[]).includes(value);
}

export type OperatorIdentity = {
  /** `auth.users.id` — the same value stored in `public.operators.user_id`. */
  readonly userId: string;
  /** Verified by Supabase Auth; used for logs/support, never returned to the browser. */
  readonly email: string | undefined;
  /** Human-readable label recorded on every admission the operator performs. */
  readonly displayName: string;
  readonly role: OperatorRole;
};

/** Mirrors the `attendance.checked_in_by` column bound (1..120, no control characters). */
export const OPERATOR_LABEL_MAX_LENGTH = 120;

/**
 * Roles that may admit tickets. An explicit allow-list, not `role !== something`: a future
 * FINANCE/VIEWER role must be a deliberate addition here, and anything unknown stays out.
 */
export const ADMISSION_ROLES: readonly OperatorRole[] = ["OPERATOR", "ADMIN"];

export function canAdmitTickets(role: OperatorRole): boolean {
  return (ADMISSION_ROLES as readonly string[]).includes(role);
}

/** Bounded, control-character-free label for the attendance row. */
export function operatorAttendanceLabel(identity: OperatorIdentity): string {
  return identity.displayName
    .replace(/[\n\r\t]+/g, " ")
    .trim()
    .slice(0, OPERATOR_LABEL_MAX_LENGTH);
}
