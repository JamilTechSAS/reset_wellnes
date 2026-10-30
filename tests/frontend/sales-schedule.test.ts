/**
 * Commercial sales schedule (America/Bogota, 2026): Preventa, General, the one-minute gap between
 * them. The HTML labels are asserted against the same constants the UI uses, so a copy change
 * cannot drift from the gate.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PACKAGE_UNAVAILABLE_NOTE } from "../../src/purchase/package-availability.ts";
import {
  GENERAL_ENDS_AT,
  GENERAL_OPENS_AT,
  GENERAL_WINDOW_LABEL,
  PRESALE_ENDS_AT,
  PRESALE_OPENS_AT,
  PRESALE_WINDOW_LABEL,
  isGeneralWindowOpen,
  isPresaleOpen,
} from "../../src/purchase/presale-schedule.ts";

const ROOT = path.resolve(__dirname, "../..");
const HTML = readFileSync(path.join(ROOT, "entradas.html"), "utf8");
/** Same markup with collapsed whitespace, so prettier's line breaks cannot fail a copy test. */
const FLAT = HTML.replace(/\s+/g, " ");

/** One ticket card's markup, whitespace-collapsed: `data-tipo="…"` up to its closing label. */
function cardText(tier: string): string {
  const start = HTML.indexOf(`data-tipo="${tier}"`);
  const end = HTML.indexOf("</label>", start);
  return HTML.slice(start, end).replace(/\s+/g, " ");
}

describe("sales windows", () => {
  it("opens Preventa on 25 October at 10:00 a. m. Colombia time", () => {
    expect(PRESALE_OPENS_AT.toISOString()).toBe("2026-10-25T15:00:00.000Z");
    expect(isPresaleOpen(Date.parse("2026-10-25T14:59:59Z"))).toBe(false);
    expect(isPresaleOpen(Date.parse("2026-10-25T15:00:00Z"))).toBe(true);
  });

  it("closes Preventa at the end of 28 October and opens General on 29 October at 12:01 a. m.", () => {
    // 11:59 p. m. of 28 October means the stage ends when 29 October starts.
    expect(PRESALE_ENDS_AT.toISOString()).toBe("2026-10-29T05:00:00.000Z");
    expect(GENERAL_OPENS_AT.toISOString()).toBe("2026-10-29T05:01:00.000Z");
    expect(GENERAL_ENDS_AT.toISOString()).toBe("2026-11-14T05:00:00.000Z");
  });

  it("keeps exactly one minute without sales between the two stages", () => {
    expect(GENERAL_OPENS_AT.getTime() - PRESALE_ENDS_AT.getTime()).toBe(60_000);
  });

  it("treats only the General window as General time", () => {
    expect(isGeneralWindowOpen(Date.parse("2026-10-29T05:00:59Z"))).toBe(false);
    expect(isGeneralWindowOpen(Date.parse("2026-10-29T05:01:00Z"))).toBe(true);
    expect(isGeneralWindowOpen(Date.parse("2026-11-14T04:59:59Z"))).toBe(true);
    expect(isGeneralWindowOpen(Date.parse("2026-11-14T05:00:00Z"))).toBe(false);
  });
});

describe("tickets page copy", () => {
  it("states the Preventa window as one friendly sentence with both dates and times", () => {
    expect(FLAT).toContain(PRESALE_WINDOW_LABEL);
    expect(PRESALE_WINDOW_LABEL).toContain("25 de octubre a las 10:00 a. m.");
    expect(PRESALE_WINDOW_LABEL).toContain("28 de octubre a las 11:59 p. m.");
  });

  it("shows only availability on the General card, without the date range", () => {
    // The instants stay pinned by the window tests above; the card deliberately prints no dates.
    expect(FLAT).toContain(GENERAL_WINDOW_LABEL);
    const general = cardText("general");
    expect(general).toContain(GENERAL_WINDOW_LABEL);
    expect(general).not.toMatch(/de (octubre|noviembre)/);
    expect(general).not.toContain("12:01");
    expect(general).not.toContain("11:59");
  });

  it("offers the package only during the General stage", () => {
    expect(PACKAGE_UNAVAILABLE_NOTE).toContain("etapa general");
    expect(cardText("duo")).toContain(PACKAGE_UNAVAILABLE_NOTE);
    expect(HTML).not.toContain("$170.000");
  });

  it("no longer states an event-capacity figure and keeps no per-stage quotas", () => {
    expect(FLAT).not.toMatch(/100\s+boletas/i);
    expect(HTML).not.toMatch(/\b(30|70)\s*(boletas|entradas|cupos)/i);
    expect(HTML).not.toMatch(/cupos? (de|por) (preventa|general)/i);
  });
});
