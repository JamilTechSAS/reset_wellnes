/**
 * Sales schedule — frontend-only presentation gate (America/Bogota, 2026).
 *
 * Colombia (America/Bogota) is a fixed UTC-5 offset with no daylight saving, so every instant
 * below is unambiguous when written with its explicit offset.
 *
 *   10:00 a. m. · 25 oct  →  11:59 p. m. · 28 oct   Preventa  $159.900
 *   12:01 a. m. · 29 oct  →  11:59 p. m. · 13 nov   General   $199.900
 *
 * There is exactly ONE minute with no sales in between (00:00 a. m. to 00:01 a. m. on 29 oct),
 * which the labels keep explicit on purpose.
 *
 * The package ("Comparte tu experiencia", 3 admissions at $179.900 per person) opens with the
 * General stage, and the backend cannot sell it yet — see `src/purchase/package-availability.ts`.
 *
 * These constants only decide *when* an option becomes selectable and what the page says. Whether
 * a stage is actually buyable still comes from the backend quote/availability response; nothing
 * here invents stock, price or state.
 */

/** Preventa opening instant. */
export const PRESALE_OPENS_AT_ISO = "2026-10-25T10:00:00-05:00";
/** First instant after Preventa ("hasta el 28 de octubre, 11:59 p. m.", exclusive end). */
export const PRESALE_ENDS_AT_ISO = "2026-10-29T00:00:00-05:00";
/** First instant of the General stage ("desde el 29 de octubre, 12:01 a. m."). */
export const GENERAL_OPENS_AT_ISO = "2026-10-29T00:01:00-05:00";
/** First instant after General ("hasta el 13 de noviembre, 11:59 p. m.", exclusive end). */
export const GENERAL_ENDS_AT_ISO = "2026-11-14T00:00:00-05:00";

export const PRESALE_OPENS_AT = new Date(PRESALE_OPENS_AT_ISO);
export const PRESALE_ENDS_AT = new Date(PRESALE_ENDS_AT_ISO);
export const GENERAL_OPENS_AT = new Date(GENERAL_OPENS_AT_ISO);
export const GENERAL_ENDS_AT = new Date(GENERAL_ENDS_AT_ISO);

/**
 * Copy shown under the Preventa option: the whole window as one friendly sentence.
 *
 * The exact instants stay in the constants above; this string only restates them for the buyer and
 * is asserted against `PRESALE_OPENS_AT` / `PRESALE_ENDS_AT` by the schedule tests.
 */
export const PRESALE_WINDOW_LABEL =
  "Aprovecha la preventa del 25 de octubre a las 10:00 a. m. al 28 de octubre a las 11:59 p. m.";

/** Copy shown under the Preventa option once its window has closed. */
export const PRESALE_CLOSED_NOTE = "Preventa finalizada.";

/** Copy shown under the General option while the stage is still closed: availability only, no dates. */
export const GENERAL_WINDOW_LABEL = "Disponible al iniciar la etapa general";

/** Copy shown under the General option once the stage is on sale, so the card never announces it as upcoming. */
export const GENERAL_OPEN_LABEL = "Etapa activa.";

// The package card's line lives with the package facts (`PACKAGE_UNAVAILABLE_NOTE`), which is the
// only place that copy is written; this module owns when each stage opens, not the package's text.

/**
 * Copy shown under the Preventa option (and as the buy-button help while it is locked): the whole
 * window, so the closing date is visible and the gap before General is explicit.
 */
export const PRESALE_SCHEDULE_NOTE = PRESALE_WINDOW_LABEL;

function toMillis(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/** True once the presale opening instant has been reached (inclusive). */
export function isPresaleOpen(now: Date | number = Date.now()): boolean {
  return toMillis(now) >= PRESALE_OPENS_AT.getTime();
}

/**
 * True from the closing instant onwards. The window is half-open (`ends_at` is exclusive), so
 * at exactly 2026-10-29T05:00:00Z — 00:00 Bogotá — Preventa is over and may no longer be
 * selected, quoted or ordered.
 */
export function isPresaleClosed(now: Date | number = Date.now()): boolean {
  return toMillis(now) >= PRESALE_ENDS_AT.getTime();
}

/** Milliseconds remaining until the presale opens; 0 once open (never negative). */
export function msUntilPresaleOpens(now: Date | number = Date.now()): number {
  return Math.max(0, PRESALE_OPENS_AT.getTime() - toMillis(now));
}

/** Milliseconds remaining until the presale closes; 0 once closed (never negative). */
export function msUntilPresaleCloses(now: Date | number = Date.now()): number {
  return Math.max(0, PRESALE_ENDS_AT.getTime() - toMillis(now));
}

/**
 * Difference between the backend clock and this device, in milliseconds.
 *
 * The catalog response carries `serverTime`, so a device whose clock is wrong still schedules
 * its timers against the same instant the database enforces. A missing or unparseable value
 * yields 0 (the local clock), which only costs precision in the timer — never authority: every
 * purchase is re-validated against `now()` inside the order transaction.
 */
export function clockSkewMs(serverTime: string | undefined, receivedAt = Date.now()): number {
  if (serverTime === undefined) {
    return 0;
  }
  const parsed = Date.parse(serverTime);
  return Number.isNaN(parsed) ? 0 : parsed - receivedAt;
}

/** The backend's current instant, derived from a `serverTime` reading and its skew. */
export function serverNow(skew: number, at = Date.now()): number {
  return at + skew;
}

/** True while the General stage is inside its window (and the package may be offered). */
export function isGeneralWindowOpen(now: Date | number = Date.now()): boolean {
  const at = toMillis(now);
  return at >= GENERAL_OPENS_AT.getTime() && at < GENERAL_ENDS_AT.getTime();
}
