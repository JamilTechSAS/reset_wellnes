/**
 * Presale (Preventa) opening schedule — frontend-only gate.
 *
 * Re set Sunset's presale opens on 2026-10-24 at 10:00 a. m. Colombia time.
 * Colombia (America/Bogota) is a fixed UTC-5 offset with no daylight saving, so
 * the opening instant is unambiguous: 2026-10-24T10:00:00-05:00 == 2026-10-24T15:00:00Z.
 *
 * This only decides *when* the presale option becomes selectable. Whether presale
 * is actually buyable still depends on the backend availability/inventory response
 * (presale stays open until stock runs out); nothing here invents stock or state.
 */

/** Fixed Colombia-time opening instant, expressed with its explicit UTC offset. */
export const PRESALE_OPENS_AT_ISO = "2026-10-24T10:00:00-05:00";

/** The opening instant as an absolute Date (timezone-independent). */
export const PRESALE_OPENS_AT = new Date(PRESALE_OPENS_AT_ISO);

/** Copy shown under the presale option while it is still time-locked. */
export const PRESALE_SCHEDULE_NOTE = "Inicia el 24 de octubre a las 10:00 a. m.";

function toMillis(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/** True once the presale opening instant has been reached (inclusive). */
export function isPresaleOpen(now: Date | number = Date.now()): boolean {
  return toMillis(now) >= PRESALE_OPENS_AT.getTime();
}

/** Milliseconds remaining until the presale opens; 0 once open (never negative). */
export function msUntilPresaleOpens(now: Date | number = Date.now()): number {
  return Math.max(0, PRESALE_OPENS_AT.getTime() - toMillis(now));
}
