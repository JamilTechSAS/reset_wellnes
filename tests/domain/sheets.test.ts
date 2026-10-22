import { describe, expect, it } from "vitest";

import {
  buildProjectionGrid,
  buildStatusRows,
  formatTimestampInZone,
  SHEET_PROJECTION_STATUSES,
  SHEETS_COLUMN_HEADERS_ES,
  SHEETS_DEFAULT_DATA_SHEET,
  SHEETS_DEFAULT_STATUS_SHEET,
  SHEETS_MAX_ATTEMPTS,
  SHEETS_MAX_ROWS,
  sheetsRetryDelaySeconds,
  type OperationalExportRow,
} from "@shared/domain/sheets.ts";

function row(overrides: Partial<OperationalExportRow> = {}): OperationalExportRow {
  return {
    Evento: "Concierto Tatiana",
    "Código de entrada": "TKT_0123456789ABCDEFGHJK",
    Nombre: "Ana",
    Apellido: "Pérez",
    Cédula: "1020456789",
    Correo: "ana@example.com",
    Teléfono: "573001234567",
    Ciudad: "Bogotá",
    Instagram: "ana.perez",
    "Tipo de entrada": "Entrada general",
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
    ...overrides,
  };
}

describe("Google Sheets projection domain", () => {
  it("keeps the status vocabulary in the enum order the database declares", () => {
    expect([...SHEET_PROJECTION_STATUSES]).toEqual(["QUEUED", "SYNCING", "SYNCED", "FAILED"]);
  });

  it("documents the Spanish operational columns, including both consents", () => {
    expect(SHEETS_COLUMN_HEADERS_ES.length).toBe(22);
    const headers = [...SHEETS_COLUMN_HEADERS_ES];
    // Requirement: the sheet must be usable at the door and for reconciliation.
    for (const required of [
      "Código de entrada",
      "Nombre",
      "Apellido",
      "Cédula",
      "Correo",
      "Teléfono",
      "Ciudad",
      "Instagram",
      "Tipo de entrada",
      "Precio",
      "Estado del pago",
      "Ingreso",
      "Fecha de ingreso",
      "Autorización de datos",
      "Autorización próximos eventos",
    ]) {
      expect(headers, `missing column ${required}`).toContain(required);
    }
    expect(SHEETS_DEFAULT_DATA_SHEET).toBe("Datos");
    expect(SHEETS_DEFAULT_STATUS_SHEET).toBe("Estado");
  });

  it("builds one grid row per ticket with money, labels and timestamps in the event zone", () => {
    const grid = buildProjectionGrid([row()], { timezone: "America/Bogota" });

    expect(grid.header).toEqual(SHEETS_COLUMN_HEADERS_ES);
    expect(grid.rows).toHaveLength(1);
    const cells = grid.rows[0]!;
    expect(cells[0]).toBe("Concierto Tatiana");
    expect(cells[1]).toBe("TKT_0123456789ABCDEFGHJK");
    expect(cells[4]).toBe("1020456789");
    expect(cells[11]).toBe("$95.000");
    expect(cells[12]).toBe("COP");
    expect(cells[14]).toBe("Pagada");
    // The raw Wompi status travels next to the translated one so an operator can triage.
    expect(cells[15]).toBe("Aprobado (APPROVED)");
    expect(cells[16]).toBe("Válida");
    expect(cells[17]).toBe("No");
    expect(cells[18]).toBe("");
    expect(cells[19]).toBe("Sí (v1, 2026-10-01 10:30)");
    expect(cells[20]).toBe("No");
    expect(cells[21]).toBe("2026-10-01 09:00");
  });

  it("shows an admitted attendee with the check-in timestamp", () => {
    const grid = buildProjectionGrid(
      [row({ Ingreso: true, "Fecha de ingreso": "2026-11-15T01:05:00.000Z" })],
      { timezone: "America/Bogota" },
    );
    const cells = grid.rows[0]!;
    expect(cells[17]).toBe("Sí");
    expect(cells[18]).toBe("2026-11-14 20:05");
  });

  it("renders a missing participant and missing consents as empty/neutral cells, never as null text", () => {
    const grid = buildProjectionGrid(
      [
        row({
          Nombre: null,
          Apellido: null,
          Cédula: null,
          Correo: null,
          Teléfono: null,
          Ciudad: null,
          Instagram: null,
          "Precio centavos": null,
          Ingreso: null,
          "Autorización de datos": null,
          "Autorización de datos versión": null,
          "Autorización de datos fecha": null,
          "Autorización próximos eventos": null,
        }),
      ],
      { timezone: "America/Bogota" },
    );
    const cells = grid.rows[0]!;
    for (const cell of cells) {
      expect(String(cell)).not.toContain("null");
    }
    expect(cells[2]).toBe("");
    expect(cells[19]).toBe("Sin registro");
    expect(cells[20]).toBe("Sin registro");
  });

  it("shows an unknown status raw instead of hiding it", () => {
    const grid = buildProjectionGrid([row({ "Estado de la orden": "SOMETHING_NEW" })], {
      timezone: "America/Bogota",
    });
    expect(grid.rows[0]![14]).toBe("SOMETHING_NEW");
  });

  it("formats timestamps as an empty string when absent or unparsable", () => {
    expect(formatTimestampInZone(null, "America/Bogota")).toBe("");
    expect(formatTimestampInZone("", "America/Bogota")).toBe("");
    expect(formatTimestampInZone("not-a-date", "America/Bogota")).toBe("");
  });

  it("backs off with a bounded schedule and a documented attempt ceiling", () => {
    expect(SHEETS_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(SHEETS_MAX_ATTEMPTS).toBeLessThanOrEqual(20);
    expect(SHEETS_MAX_ROWS).toBeGreaterThanOrEqual(1000);
    expect(sheetsRetryDelaySeconds(1)).toBe(60);
    expect(sheetsRetryDelaySeconds(2)).toBe(300);
    expect(sheetsRetryDelaySeconds(5)).toBe(21600);
    expect(sheetsRetryDelaySeconds(0)).toBe(60);
    expect(sheetsRetryDelaySeconds(6)).toBe(21600);
    expect(sheetsRetryDelaySeconds(99)).toBe(21600);
  });

  it("summarizes the run in the status tab", () => {
    const rows = buildStatusRows({
      syncedAt: "2026-11-15T01:05:00.000Z",
      stats: { queued: 2, syncing: 1, synced: 120, failed: 1, total: 124 },
      timezone: "America/Bogota",
      note: "Proyección operativa de solo lectura.",
    });
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain("2026-11-14 20:05");
    expect(serialized).toContain("124");
    expect(serialized).toContain("120");
    expect(serialized).toContain("Los cambios manuales");
  });
});
