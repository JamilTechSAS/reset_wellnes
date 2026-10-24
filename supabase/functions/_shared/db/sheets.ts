/**
 * Google Sheets projection gateway.
 *
 * Thin typed boundary over the Phase 5 SQL: claim due projection rows, finish them with the
 * sync outcome, read the status counters, and load the full operational export the worker
 * writes into the client's sheet. The export view is the ONLY source of projection data —
 * adding a column is a deliberate migration, not an accident of `select *`.
 */

import { AppError } from "../domain/errors.ts";
import { SHEETS_MAX_ROWS, type OperationalExportRow } from "../domain/sheets.ts";
import { mapSqlErrorToAppError } from "./orders.ts";
import type { DbClient } from "./client.ts";

export type ClaimedSheetProjection = {
  readonly participantId: string;
  readonly eventId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
};

export type SheetProjectionStats = {
  readonly queued: number;
  readonly syncing: number;
  readonly synced: number;
  readonly failed: number;
  readonly total: number;
  readonly lastSyncedAt: string | null;
  readonly oldestPendingAt: string | null;
};

export type SheetsGateway = {
  claimProjections(input: {
    readonly limit: number;
    readonly maxAttempts: number;
  }): Promise<readonly ClaimedSheetProjection[]>;
  finishProjections(input: {
    readonly participantIds: readonly string[];
    readonly status: "SYNCED" | "FAILED";
    readonly error?: string | undefined;
    readonly nextAttemptAt?: string | undefined;
  }): Promise<{ readonly updatedCount: number }>;
  stats(): Promise<SheetProjectionStats>;
  listExportRows(): Promise<readonly OperationalExportRow[]>;
};

function throwMapped(error: unknown): never {
  throw mapSqlErrorToAppError(error);
}

export function createSheetsGateway(client: DbClient): SheetsGateway {
  return {
    async claimProjections(input) {
      const { data, error } = await client.rpc("claim_participant_sheet_projections", {
        p_limit: input.limit,
        p_max_attempts: input.maxAttempts,
      });
      if (error !== null) {
        throwMapped(error);
      }
      // `claim_participant_sheet_projections` is `returns setof
      // sheets_participant_projections`: the array is empty, never null, when nothing is due.
      return data.map((row) => ({
        participantId: row.participant_id,
        eventId: row.event_id,
        status: row.status,
        attemptCount: row.attempt_count,
        nextAttemptAt: row.next_attempt_at,
      }));
    },

    async finishProjections(input) {
      if (input.participantIds.length === 0) {
        return { updatedCount: 0 };
      }
      const { data, error } = await client.rpc("finish_participant_sheet_projections", {
        p_participant_ids: [...input.participantIds],
        p_status: input.status,
        ...(input.error === undefined ? {} : { p_error: input.error }),
        ...(input.nextAttemptAt === undefined ? {} : { p_next_attempt_at: input.nextAttemptAt }),
      });
      if (error !== null) {
        throwMapped(error);
      }
      const value =
        typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
      return { updatedCount: typeof value.updatedCount === "number" ? value.updatedCount : 0 };
    },

    async stats() {
      const { data, error } = await client.rpc("participant_sheet_projection_stats");
      if (error !== null) {
        throwMapped(error);
      }
      if (typeof data !== "object" || data === null) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Sheet projection stats returned an unexpected payload",
        );
      }
      return data as unknown as SheetProjectionStats;
    },

    async listExportRows() {
      const { data, error } = await client
        .from("operational_export")
        .select("*")
        .order("Creada", { ascending: true })
        .limit(SHEETS_MAX_ROWS);
      if (error !== null) {
        throwMapped(error);
      }
      return data;
    },
  };
}
