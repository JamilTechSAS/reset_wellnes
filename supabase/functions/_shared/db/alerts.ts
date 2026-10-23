/**
 * Data access for operational alerts (H8, migration 20261023150000). Every call goes through
 * a SECURITY INVOKER function with the service-role client; nothing here reads payloads.
 */

import { AppError } from "../domain/errors.ts";
import {
  ALERT_KINDS,
  ALERT_SEVERITY,
  type AlertInput,
  type ClaimedAlert,
} from "../domain/alerts.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";

export type AlertGateway = {
  recordAlert(
    input: AlertInput,
  ): Promise<{ readonly created: boolean; readonly occurrences: number }>;
  raiseUnresolvedPaymentAlerts(maxAttempts: number): Promise<number>;
  claimAlertNotifications(limit: number, maxAttempts: number): Promise<readonly ClaimedAlert[]>;
  finishAlertNotifications(alertIds: readonly string[]): Promise<number>;
};

function toClaimedAlert(row: unknown): ClaimedAlert {
  if (typeof row !== "object" || row === null) {
    throw new AppError("INTERNAL_ERROR", "Alert claim returned a malformed row");
  }
  const value = row as Record<string, unknown>;
  if (
    typeof value.alertId !== "string" ||
    typeof value.kind !== "string" ||
    !(ALERT_KINDS as readonly string[]).includes(value.kind) ||
    typeof value.occurrences !== "number"
  ) {
    throw new AppError("INTERNAL_ERROR", "Alert claim row is missing required fields");
  }
  return value as unknown as ClaimedAlert;
}

export function createAlertGateway(client: DbClient): AlertGateway {
  return {
    async recordAlert(input) {
      const { data, error } = await client.rpc("record_operational_alert", {
        p_dedupe_key: input.dedupeKey,
        p_kind: input.kind,
        p_severity: ALERT_SEVERITY[input.kind],
        ...(input.orderReference === undefined ? {} : { p_order_reference: input.orderReference }),
        ...(input.paymentId === undefined ? {} : { p_payment_id: input.paymentId }),
        ...(input.provider === undefined ? {} : { p_provider: input.provider }),
        ...(input.detail === undefined ? {} : { p_detail: input.detail }),
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      const result = data as { readonly created: boolean; readonly occurrences: number };
      return { created: result.created, occurrences: result.occurrences };
    },

    async raiseUnresolvedPaymentAlerts(maxAttempts) {
      const { data, error } = await client.rpc("raise_unresolved_payment_alerts", {
        p_max_attempts: maxAttempts,
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      return data;
    },

    async claimAlertNotifications(limit, maxAttempts) {
      const { data, error } = await client.rpc("claim_alert_notifications", {
        p_limit: limit,
        p_max_attempts: maxAttempts,
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      return data.map((row) => toClaimedAlert(row));
    },

    async finishAlertNotifications(alertIds) {
      const { data, error } = await client.rpc("finish_alert_notifications", {
        p_alert_ids: [...alertIds],
      });
      if (error !== null) {
        throw mapSqlErrorToAppError(error);
      }
      return data;
    },
  };
}
