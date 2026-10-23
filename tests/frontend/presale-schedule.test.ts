import { describe, expect, it } from "vitest";
import {
  PRESALE_OPENS_AT,
  PRESALE_OPENS_AT_ISO,
  PRESALE_SCHEDULE_NOTE,
  isPresaleOpen,
  msUntilPresaleOpens,
} from "../../src/purchase/presale-schedule.ts";

describe("presale schedule", () => {
  // 2026-10-24 10:00 Colombia (UTC-5) == 2026-10-24 15:00:00 UTC.
  const OPEN_UTC = Date.UTC(2026, 9, 24, 15, 0, 0);

  it("pins the opening instant to 10:00 Colombia time (UTC-5)", () => {
    expect(PRESALE_OPENS_AT_ISO).toBe("2026-10-24T10:00:00-05:00");
    expect(PRESALE_OPENS_AT.getTime()).toBe(OPEN_UTC);
    expect(PRESALE_SCHEDULE_NOTE).toBe("Inicia el 24 de octubre a las 10:00 a. m.");
  });

  it("is closed one millisecond before the opening instant", () => {
    expect(isPresaleOpen(OPEN_UTC - 1)).toBe(false);
  });

  it("is open exactly at the opening instant (inclusive boundary)", () => {
    expect(isPresaleOpen(OPEN_UTC)).toBe(true);
  });

  it("is open one millisecond after the opening instant", () => {
    expect(isPresaleOpen(OPEN_UTC + 1)).toBe(true);
  });

  it("accepts a Date as well as an epoch number", () => {
    expect(isPresaleOpen(new Date(OPEN_UTC))).toBe(true);
    expect(isPresaleOpen(new Date(OPEN_UTC - 1000))).toBe(false);
  });

  it("reports the remaining time, clamped at zero once open", () => {
    expect(msUntilPresaleOpens(OPEN_UTC - 5000)).toBe(5000);
    expect(msUntilPresaleOpens(OPEN_UTC)).toBe(0);
    expect(msUntilPresaleOpens(OPEN_UTC + 5000)).toBe(0);
  });
});
