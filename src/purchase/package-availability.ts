/**
 * The package product ("Comparte tu experiencia") — commercial facts and checkout availability.
 *
 * The package is THREE General admissions for COP 509.700 total (COP 169.900 each), sold only
 * while the General window is open. Migration 20261024230000 makes the backend model exactly
 * that: a `ticket_bundles` row with code `SHARE_EXPERIENCE`, `included_admissions = 3` and
 * `price_cents = 50970000`, on the General stage, reserving three admissions from the shared
 * pool of 100.
 *
 * `DOUBLE_EXPERIENCE` (the old two-admission package at COP 340.000) is retired for new
 * purchases: the migration deactivates its row and the request schema no longer accepts the
 * code. Historical orders keep their bundle id, frozen name and amount.
 *
 * Nothing here is a price the browser can charge: the amount always comes from the backend
 * quote, and `create_bundle_order` overwrites the order and payment totals from the catalogue
 * row inside its own transaction.
 */

export const PACKAGE_CODE = "SHARE_EXPERIENCE";
export type PackageCode = typeof PACKAGE_CODE;
export const PACKAGE_NAME = "Comparte tu experiencia";
export const PACKAGE_ADMISSIONS = 3;
/** COP 169.900 per admission in hundredths of a peso (the unit the API and the DB use). */
export const PACKAGE_UNIT_CENTS = 16_990_000;
/** COP 509.700 for the package, charged once per package — NOT per admission. */
export const PACKAGE_TOTAL_CENTS = 50_970_000;
/** COP 169.900 per admission, formatted as the site formats every price. */
export const PACKAGE_UNIT_PRICE_LABEL = "$169.900";
/** The package total, formatted for the card and the checkout summary. */
export const PACKAGE_TOTAL_PRICE_LABEL = "$509.700";

/** The backend prices and reserves the three-admission package, so the card may start a checkout. */
export const PACKAGE_CHECKOUT_ENABLED = true;

/** Copy shown under the package card while it is not on sale yet. */
export const PACKAGE_UNAVAILABLE_NOTE = "Disponible al iniciar la etapa general";

/** Whether the UI may start a checkout for the package at all (the stage still has to be open). */
export function packageCheckoutAvailable(): boolean {
  return PACKAGE_CHECKOUT_ENABLED;
}
