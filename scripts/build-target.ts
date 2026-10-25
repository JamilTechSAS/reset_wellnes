/**
 * Build targets for the static site.
 *
 * The same repository builds two different artifacts, and the difference must be explicit and
 * inspectable because one of them is the public site and the other is a client demo:
 *
 *   production (default) — every public page. `/demo-entradas` is NOT built at all.
 *   qa                   — the public pages plus the presentation-only demo page.
 *
 * The target comes from `SITE_TARGET`, a build-time variable that is deliberately NOT
 * `VITE_`-prefixed: it must never be inlined into a browser bundle. An unset or empty value means
 * production, so a build that forgets to configure anything can never ship the demo to the real
 * site; an unrecognised value fails the build instead of guessing.
 */

export type SiteTarget = "qa" | "production";

export const SITE_TARGET_ENV = "SITE_TARGET";
export const DEFAULT_SITE_TARGET: SiteTarget = "production";

/**
 * Pages only the QA deployment serves.
 *
 * Keep this list in sync with the `PAGES` registry in `vite.config.ts`; the build then filters that
 * registry through `includesPage`, so adding a page here removes it from production builds and
 * nothing else has to change.
 *
 * `epayco-staging-smoke.html` used to live in `public/` (copied into every build, including the real
 * site). It is a QA-only technical page that opens a sandbox checkout, so it is now a gated entry
 * like the demo: same QA URL, never in the production artifact.
 */
export const QA_ONLY_PAGES = ["demo-entradas.html", "epayco-staging-smoke.html"] as const;

export type QaOnlyPage = (typeof QA_ONLY_PAGES)[number];

export function isQaOnlyPage(page: string): page is QaOnlyPage {
  return (QA_ONLY_PAGES as readonly string[]).includes(page);
}

function isSiteTarget(value: string): value is SiteTarget {
  return value === "qa" || value === "production";
}

export function parseSiteTarget(value: string | undefined): SiteTarget {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) {
    return DEFAULT_SITE_TARGET;
  }
  if (!isSiteTarget(normalized)) {
    throw new Error(
      `${SITE_TARGET_ENV} must be "qa" or "production" (received "${String(value)}"): refusing to guess which pages to ship.`,
    );
  }
  return normalized;
}

/** Whether a build for `target` may include `page`. Public pages always ship. */
export function includesPage(target: SiteTarget, page: string): boolean {
  return isQaOnlyPage(page) ? target === "qa" : true;
}
