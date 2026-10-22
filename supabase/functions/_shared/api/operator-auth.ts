/**
 * Operator authentication and authorization.
 *
 * Two independent checks, in this order:
 *
 *   1. AUTHENTICATION — the request must carry a Supabase Auth access token as
 *      `Authorization: Bearer <jwt>`, verified by Supabase Auth itself (`auth.getUser`,
 *      injected here as `getUserByToken`). This is a real user account; there is no custom
 *      username/password system and no shared operator secret anywhere in the backend or
 *      the future frontend.
 *   2. AUTHORIZATION — the authenticated user must have a row in `public.operators` with a
 *      valid role, and it must be active. `FORBIDDEN` (authenticated but not an operator)
 *      is distinct from `UNAUTHORIZED` (not authenticated), which makes "your account was
 *      deactivated" diagnosable without exposing any other user's data.
 *
 * The verified identity travels to the check-in SQL as the operator label + user id, never
 * from the request body, so an admission can always be attributed to the account that
 * performed it.
 */

import { AppError, forbiddenError, unauthorizedError } from "../domain/errors.ts";
import {
  canAdmitTickets,
  isOperatorRole,
  operatorAttendanceLabel,
  type OperatorIdentity,
} from "../domain/operators.ts";
import type { Logger } from "../logging/logger.ts";
import type { OperatorGateway } from "../db/operators.ts";

/** Result of verifying a Supabase Auth token; `undefined` means invalid/expired. */
export type VerifiedAuthUser = {
  readonly userId: string;
  readonly email: string | undefined;
};

export type OperatorAuthenticator = {
  authenticate(authorizationHeader: string | null): Promise<OperatorIdentity>;
};

export type OperatorAuthenticatorOptions = {
  readonly getUserByToken: (token: string) => Promise<VerifiedAuthUser | undefined>;
  readonly operators: OperatorGateway;
  readonly logger: Logger;
};

/** `Bearer <token>` -> `<token>`; anything else is missing. */
export function parseBearerToken(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

export function createOperatorAuthenticator(
  options: OperatorAuthenticatorOptions,
): OperatorAuthenticator {
  return {
    async authenticate(authorizationHeader): Promise<OperatorIdentity> {
      const token = parseBearerToken(authorizationHeader);
      if (token === undefined) {
        throw unauthorizedError("Operator request without a bearer token", {
          context: { surface: "operator-auth" },
        });
      }

      const user = await options.getUserByToken(token);
      if (user === undefined) {
        // An expired token and an invalid one are the same answer: "not authenticated".
        throw unauthorizedError("Operator token could not be verified", {
          context: { surface: "operator-auth" },
        });
      }

      const operator = await options.operators.findOperatorByUserId(user.userId);
      if (!operator?.isActive) {
        options.logger.warn("authenticated user is not an active operator", {
          userId: user.userId,
        });
        throw forbiddenError("The account is not an active operator", {
          context: { surface: "operator-auth" },
        });
      }
      if (!isOperatorRole(operator.role)) {
        // Defense in depth: the gateway already fails closed on an unknown role.
        throw forbiddenError("The account has no admission role", {
          context: { surface: "operator-auth" },
        });
      }
      if (!canAdmitTickets(operator.role)) {
        throw forbiddenError("The account may not admit tickets", {
          context: { surface: "operator-auth" },
        });
      }

      const identity: OperatorIdentity = {
        userId: operator.userId,
        email: user.email,
        displayName: operator.displayName,
        role: operator.role,
      };
      const label = operatorAttendanceLabel(identity);
      if (label.length === 0) {
        throw new AppError("INTERNAL_ERROR", "Operator display name is empty");
      }
      return identity;
    },
  };
}
