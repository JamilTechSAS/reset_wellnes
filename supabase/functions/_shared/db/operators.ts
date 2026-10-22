/**
 * Operator authorization gateway.
 *
 * Reads `public.operators` (authorization data only — authentication is Supabase Auth).
 * The table is unreadable through the Data API (RLS, no policies); the service-role client
 * inside the Edge Function is the only reader.
 */

import { mapSqlErrorToAppError } from "./orders.ts";
import { isOperatorRole, type OperatorRole } from "../domain/operators.ts";
import type { DbClient } from "./client.ts";

export type OperatorRecord = {
  readonly userId: string;
  readonly displayName: string;
  readonly role: OperatorRole;
  readonly isActive: boolean;
};

export type OperatorGateway = {
  findOperatorByUserId(userId: string): Promise<OperatorRecord | undefined>;
};

type OperatorRow = {
  readonly user_id: string;
  readonly display_name: string;
  readonly role: string;
  readonly is_active: boolean;
};

export function createOperatorGateway(client: DbClient): OperatorGateway {
  return {
    async findOperatorByUserId(userId) {
      if (userId.trim().length === 0) {
        return undefined;
      }
      const { data, error } = await client
        .from("operators")
        .select("user_id, display_name, role, is_active")
        .eq("user_id", userId)
        .maybeSingle();
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      if (data === null) {
        return undefined;
      }
      const row = data as unknown as OperatorRow;
      // A role value outside the vocabulary is treated as "no operator": authorization
      // fails closed, and a bad row can never grant access.
      if (!isOperatorRole(row.role)) {
        return undefined;
      }
      return {
        userId: row.user_id,
        displayName: row.display_name,
        role: row.role,
        isActive: row.is_active,
      };
    },
  };
}
