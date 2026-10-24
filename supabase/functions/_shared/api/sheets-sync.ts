/**
 * Google Sheets projection worker.
 *
 * Runs inside the maintenance invocation, AFTER all payment and participant work is committed,
 * and writes the client's operational spreadsheet from `public.operational_export`. It is an
 * outbox drain, not a checkout dependency: a Google outage delays the sheet and nothing else.
 * Payments, participant assignment and check-in never call Google.
 *
 * Semantics:
 *   * One sync always writes the COMPLETE grid (header + every participant row), so the sheet
 *     is a snapshot of PostgreSQL, not a delta log. A row missed by an earlier failure is
 *     healed by the next successful sync.
 *   * Claimed queue rows are marked SYNCED only for rows still SYNCING after the write;
 *     a participant that changed mid-write was re-queued by its trigger and stays pending.
 *   * On failure the claimed rows go back to FAILED with a backoff, except those that have
 *     spent the attempt budget: they stay FAILED and visible until new data re-queues them.
 *   * The worker never throws: it reports a summary. Maintenance must keep running even
 *     when Google is down.
 */

import {
  buildProjectionGrid,
  buildStatusRows,
  SHEETS_CLAIM_BATCH_SIZE,
  SHEETS_MAX_ATTEMPTS,
  SHEETS_MAX_ROWS,
  sheetsRetryDelaySeconds,
} from "../domain/sheets.ts";
import { toAppError } from "../domain/errors.ts";
import type { Logger } from "../logging/logger.ts";
import type { SheetsGateway } from "../db/sheets.ts";
import type { SheetsClient, SheetsWriteResult } from "../integrations/google/sheets-client.ts";

export type SheetsSyncSummary = {
  /** True when the projection is not configured (no credentials or disabled by config). */
  readonly skipped: boolean;
  readonly configured: boolean;
  readonly claimed: number;
  readonly syncedTickets: number;
  readonly failedTickets: number;
  /** Rows that spent the attempt budget; they stay FAILED until new data arrives. */
  readonly exhaustedTickets: number;
  /** Participant rows acknowledged by the connector (excludes the header). */
  readonly rowsWritten: number;
  readonly statusTabWritten: boolean;
  /** Bounded, non-secret failure description; `null` on success. */
  readonly error: string | null;
};

export type RunSheetsSyncInput = {
  readonly sheets: SheetsGateway;
  /** `undefined` when the Apps Script connector is not configured; the projection is skipped. */
  readonly client: SheetsClient | undefined;
  readonly timezone: string;
  readonly logger: Logger;
  readonly now?: () => Date;
};

function emptySummary(skipped: boolean, configured: boolean): SheetsSyncSummary {
  return {
    skipped,
    configured,
    claimed: 0,
    syncedTickets: 0,
    failedTickets: 0,
    exhaustedTickets: 0,
    rowsWritten: 0,
    statusTabWritten: false,
    error: null,
  };
}

export async function runSheetsSync(input: RunSheetsSyncInput): Promise<SheetsSyncSummary> {
  const { logger } = input;
  const client = input.client;
  if (client === undefined) {
    return emptySummary(true, false);
  }
  const now = input.now ?? (() => new Date());

  const claimed = await input.sheets.claimProjections({
    limit: SHEETS_CLAIM_BATCH_SIZE,
    maxAttempts: SHEETS_MAX_ATTEMPTS,
  });
  if (claimed.length === 0) {
    return emptySummary(false, true);
  }

  const rows = await input.sheets.listExportRows();
  if (rows.length > SHEETS_MAX_ROWS) {
    // The projection is documented as bounded; more rows means the sheet would be truncated
    // silently. Report it loudly instead of writing a partial operational view.
    logger.error("operational export exceeds the documented sheet bound", {
      rows: rows.length,
      maxRows: SHEETS_MAX_ROWS,
    });
  }
  const bounded = rows.slice(0, SHEETS_MAX_ROWS);
  const grid = buildProjectionGrid(bounded, { timezone: input.timezone });

  let write: SheetsWriteResult;
  try {
    write = await client.writeProjection({
      grid: "data",
      values: [grid.header, ...grid.rows],
    });
  } catch (error) {
    // The worker must never throw: a connector client that throws would leave the claimed
    // projections SYNCING until stale recovery instead of recording a normal retryable failure.
    logger.error("google sheets connector call threw", { error: toAppError(error).code });
    write = {
      ok: false,
      retryable: true,
      error: "the Apps Script connector call failed",
      httpStatus: undefined,
    };
  }
  if (!write.ok) {
    const retryable = write.retryable;
    const retryAt = new Date(
      now().getTime() +
        sheetsRetryDelaySeconds(Math.max(...claimed.map((row) => row.attemptCount))) * 1000,
    ).toISOString();
    const budgetSpent = claimed.filter((row) => row.attemptCount >= SHEETS_MAX_ATTEMPTS);
    const remaining = claimed.filter((row) => row.attemptCount < SHEETS_MAX_ATTEMPTS);

    let failedTickets = 0;
    if (remaining.length > 0) {
      const finished = await input.sheets.finishProjections({
        participantIds: remaining.map((row) => row.participantId),
        status: "FAILED",
        error: write.error,
        // Only a retryable failure earns a retry time; anything else still gets one because
        // the next maintenance run is the only other trigger, and the attempt budget bounds
        // it. A permanently failing row stops at the ceiling either way.
        nextAttemptAt: retryAt,
      });
      failedTickets += finished.updatedCount;
    }
    if (budgetSpent.length > 0) {
      const finished = await input.sheets.finishProjections({
        participantIds: budgetSpent.map((row) => row.participantId),
        status: "FAILED",
        error: write.error,
      });
      failedTickets += finished.updatedCount;
    }

    logger.error("google sheets projection failed", {
      claimed: claimed.length,
      failedTickets,
      exhaustedTickets: budgetSpent.length,
      retryable,
      httpStatus: write.httpStatus ?? null,
      error: write.error,
    });

    return {
      skipped: false,
      configured: true,
      claimed: claimed.length,
      syncedTickets: 0,
      failedTickets,
      exhaustedTickets: budgetSpent.length,
      rowsWritten: 0,
      statusTabWritten: false,
      error: write.error,
    };
  }

  const finished = await input.sheets.finishProjections({
    participantIds: claimed.map((row) => row.participantId),
    status: "SYNCED",
  });

  // Status tab is informational; a failure here must not affect the projection itself.
  let statusTabWritten = false;
  try {
    const stats = await input.sheets.stats();
    const statusGrid = buildStatusRows({
      syncedAt: now().toISOString(),
      stats,
      timezone: input.timezone,
      note: "Proyección operativa de solo lectura.",
    });
    const statusWrite = await client.writeProjection({
      grid: "status",
      values: statusGrid,
    });
    statusTabWritten = statusWrite.ok;
    if (!statusWrite.ok) {
      logger.warn("google sheets status tab could not be written", { error: statusWrite.error });
    }
  } catch (error) {
    logger.warn("google sheets status tab failed", { error: toAppError(error).code });
  }

  logger.info("google sheets projection synced", {
    claimed: claimed.length,
    syncedTickets: finished.updatedCount,
    rowsWritten: grid.rows.length,
  });

  return {
    skipped: false,
    configured: true,
    claimed: claimed.length,
    syncedTickets: finished.updatedCount,
    failedTickets: 0,
    exhaustedTickets: 0,
    rowsWritten: write.rowsWritten,
    statusTabWritten,
    error: null,
  };
}
