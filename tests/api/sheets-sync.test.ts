import { describe, expect, it, vi } from "vitest";

import { runSheetsSync } from "@shared/api/sheets-sync.ts";
import {
  SHEETS_CLAIM_BATCH_SIZE,
  SHEETS_MAX_ATTEMPTS,
  type OperationalExportRow,
} from "@shared/domain/sheets.ts";
import type { ClaimedSheetProjection, SheetsGateway } from "@shared/db/sheets.ts";
import type { SheetsClient, SheetsWriteResult } from "@shared/integrations/google/sheets-client.ts";
import { createLogger } from "@shared/logging/logger.ts";

const logger = createLogger({
  service: "test",
  environment: "development",
  level: "error",
  sink: () => undefined,
});

const NOW = new Date("2026-11-15T01:00:00.000Z");

function claimedProjection(
  overrides: Partial<ClaimedSheetProjection> = {},
): ClaimedSheetProjection {
  return {
    participantId: "11111111-1111-4111-8111-111111111111",
    eventId: "22222222-2222-4222-8222-222222222222",
    status: "SYNCING",
    attemptCount: 1,
    nextAttemptAt: null,
    ...overrides,
  };
}

function exportRow(): OperationalExportRow {
  return {
    Evento: "Concierto",
    "Código de entrada": "TKT_0123456789ABCDEFGHJK",
    Nombre: "Ana",
    Apellido: "Pérez",
    Cédula: "1020456789",
    Correo: "ana@example.com",
    Teléfono: "573001234567",
    Ciudad: "Bogotá",
    Instagram: null,
    "Tipo de entrada": "General",
    "Etapa de venta": "Preventa 1",
    "Precio centavos": 9_500_000,
    Moneda: "COP",
    "Referencia de la orden": "EVT-2026-000001",
    "Estado de la orden": "PAID",
    "Estado del pago": "approved",
    "Estado Wompi": "APPROVED",
    "Estado de la entrada": "ACTIVE",
    Ingreso: false,
    "Fecha de ingreso": null,
    "Autorización de datos": true,
    "Autorización de datos versión": "v1",
    "Autorización de datos fecha": "2026-10-01T15:30:00.000Z",
    "Autorización próximos eventos": false,
    Creada: "2026-10-01T14:00:00.000Z",
  };
}

function setup(options: {
  readonly claims?: readonly ClaimedSheetProjection[];
  readonly write?: SheetsWriteResult;
  readonly statusWrite?: SheetsWriteResult;
  readonly updatedCount?: number;
}) {
  const claimProjections = vi
    .fn<SheetsGateway["claimProjections"]>()
    .mockResolvedValue(options.claims ?? [claimedProjection()]);
  const finishProjections = vi.fn<SheetsGateway["finishProjections"]>().mockResolvedValue({
    updatedCount: options.updatedCount ?? (options.claims ?? [claimedProjection()]).length,
  });
  const stats = vi.fn<SheetsGateway["stats"]>().mockResolvedValue({
    queued: 0,
    syncing: 0,
    synced: 1,
    failed: 0,
    total: 1,
    lastSyncedAt: null,
    oldestPendingAt: null,
  });
  const listExportRows = vi.fn<SheetsGateway["listExportRows"]>().mockResolvedValue([exportRow()]);
  const sheets: SheetsGateway = { claimProjections, finishProjections, stats, listExportRows };

  const writeProjection = vi
    .fn<SheetsClient["writeProjection"]>()
    .mockResolvedValueOnce(
      options.write ?? {
        ok: true,
        grid: "data",
        written: true,
        rowsWritten: 1,
        updatedRanges: 1,
        updatedCells: 22,
      },
    )
    .mockResolvedValueOnce(
      options.statusWrite ?? {
        ok: true,
        grid: "status",
        written: true,
        rowsWritten: 7,
        updatedRanges: 1,
        updatedCells: 14,
      },
    );
  const client: SheetsClient = {
    writeProjection,
    health: vi.fn(),
    selfTest: vi.fn(),
  };

  return {
    sheets,
    client,
    claimProjections,
    finishProjections,
    stats,
    listExportRows,
    writeProjection,
  };
}

describe("Google Sheets sync worker", () => {
  it("skips entirely when the projection is not configured", async () => {
    const { sheets } = setup({});
    const summary = await runSheetsSync({
      sheets,
      client: undefined,
      timezone: "America/Bogota",
      logger,
    });
    expect(summary.skipped).toBe(true);
    expect(summary.configured).toBe(false);
    expect(summary.claimed).toBe(0);
  });

  it("does nothing (and touches no Google API) when no projection is due", async () => {
    const { sheets, client, writeProjection } = setup({ claims: [] });
    const summary = await runSheetsSync({ sheets, client, timezone: "America/Bogota", logger });
    expect(summary.skipped).toBe(false);
    expect(summary.configured).toBe(true);
    expect(summary.claimed).toBe(0);
    expect(writeProjection).not.toHaveBeenCalled();
  });

  it("writes the full grid and marks only the claimed rows synced", async () => {
    const { sheets, client, claimProjections, finishProjections, writeProjection } = setup({
      updatedCount: 1,
    });
    const summary = await runSheetsSync({
      sheets,
      client,
      timezone: "America/Bogota",
      logger,
      now: () => NOW,
    });

    expect(claimProjections).toHaveBeenCalledWith({
      limit: SHEETS_CLAIM_BATCH_SIZE,
      maxAttempts: SHEETS_MAX_ATTEMPTS,
    });
    const firstWrite = writeProjection.mock.calls[0]?.[0];
    expect(firstWrite?.grid).toBe("data");
    expect(firstWrite?.values).toHaveLength(2); // header + one participant
    expect(firstWrite?.values[0]?.length).toBe(22);
    expect(finishProjections).toHaveBeenCalledWith({
      participantIds: [claimedProjection().participantId],
      status: "SYNCED",
    });
    expect(summary.syncedTickets).toBe(1);
    expect(summary.rowsWritten).toBe(1);
    expect(summary.statusTabWritten).toBe(true);
    const statusWrite = writeProjection.mock.calls[1]?.[0];
    expect(statusWrite?.grid).toBe("status");
  });

  it("keeps a row that changed mid-write queued instead of marking it synced", async () => {
    // finish only updates rows still SYNCING; the trigger re-queued the row during the
    // write, so updatedCount is 0 while the sync itself succeeded.
    const { sheets, client } = setup({ updatedCount: 0 });
    const summary = await runSheetsSync({ sheets, client, timezone: "America/Bogota", logger });
    expect(summary.syncedTickets).toBe(0);
    expect(summary.error).toBeNull();
  });

  it("records a failure instead of throwing when the connector client throws", async () => {
    const { sheets, client, finishProjections } = setup({});
    vi.mocked(client.writeProjection).mockReset();
    vi.mocked(client.writeProjection).mockRejectedValue(new Error("unexpected connector"));
    const summary = await runSheetsSync({
      sheets,
      client,
      timezone: "America/Bogota",
      logger,
      now: () => NOW,
    });

    expect(summary.skipped).toBe(false);
    expect(summary.claimed).toBe(1);
    expect(summary.failedTickets).toBe(1);
    expect(summary.syncedTickets).toBe(0);
    expect(summary.rowsWritten).toBe(0);
    expect(summary.error).toBe("the Apps Script connector call failed");
    expect(finishProjections).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED", error: "the Apps Script connector call failed" }),
    );
  });

  it("records a failure with a backoff and keeps the queue truthful", async () => {
    const { sheets, client, finishProjections } = setup({
      claims: [
        claimedProjection({ attemptCount: 2 }),
        claimedProjection({
          participantId: "33333333-3333-4333-8333-333333333333",
          attemptCount: 2,
        }),
      ],
      write: { ok: false, retryable: true, error: "sheets API returned HTTP 503", httpStatus: 503 },
    });
    const summary = await runSheetsSync({
      sheets,
      client,
      timezone: "America/Bogota",
      logger,
      now: () => NOW,
    });

    expect(summary.failedTickets).toBe(2);
    expect(summary.syncedTickets).toBe(0);
    expect(summary.error).toBe("sheets API returned HTTP 503");
    expect(finishProjections).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        error: "sheets API returned HTTP 503",
        nextAttemptAt: "2026-11-15T01:05:00.000Z", // attempt 2 -> 300 s
      }),
    );
    // The status tab is not refreshed on a failed sync.
    expect(summary.statusTabWritten).toBe(false);
  });

  it("stops retrying a projection that spent the attempt budget", async () => {
    const { sheets, client, finishProjections } = setup({
      claims: [claimedProjection({ attemptCount: SHEETS_MAX_ATTEMPTS })],
      write: { ok: false, retryable: true, error: "sheets API returned HTTP 500", httpStatus: 500 },
    });
    const summary = await runSheetsSync({
      sheets,
      client,
      timezone: "America/Bogota",
      logger,
      now: () => NOW,
    });
    expect(summary.exhaustedTickets).toBe(1);
    expect(summary.failedTickets).toBe(1);
    expect(finishProjections).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
    const calls = finishProjections.mock.calls;
    expect(calls[0]?.[0].nextAttemptAt).toBeUndefined();
  });

  it("does not fail the sync when only the informational status tab cannot be written", async () => {
    const { sheets, client } = setup({
      statusWrite: { ok: false, retryable: true, error: "quota", httpStatus: 429 },
    });
    const summary = await runSheetsSync({ sheets, client, timezone: "America/Bogota", logger });
    expect(summary.syncedTickets).toBe(1);
    expect(summary.statusTabWritten).toBe(false);
    expect(summary.error).toBeNull();
  });

  it("never throws: a stats failure is contained after the data was written", async () => {
    const { sheets, client, stats } = setup({});
    stats.mockRejectedValue(new Error("stats unavailable"));
    const summary = await runSheetsSync({ sheets, client, timezone: "America/Bogota", logger });
    expect(summary.syncedTickets).toBe(1);
    expect(summary.statusTabWritten).toBe(false);
    expect(summary.error).toBeNull();
  });
});
