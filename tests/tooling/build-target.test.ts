/**
 * Build targets: which pages a given build may ship.
 *
 * `/demo-entradas` is a client presentation page. It may live on the QA deployment, but the real
 * production artifact must not contain it — not the HTML, not its entry bundles, and no link
 * pointing at it. These tests pin the rule where it is decided (`scripts/build-target.ts` and the
 * Vite registry), and the artifact itself is checked by `npm run build` in each mode.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SITE_TARGET,
  QA_ONLY_PAGES,
  SITE_TARGET_ENV,
  includesPage,
  isQaOnlyPage,
  parseSiteTarget,
} from "../../scripts/build-target.ts";

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

/** Every `.ts` under `src/`, excluding the demo's own directory. */
function sourceFilesExceptDemo(): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(ROOT, relative))) {
      const child = path.posix.join(relative, entry);
      if (statSync(path.join(ROOT, child)).isDirectory()) {
        if (child !== "src/demo") {
          walk(child);
        }
        continue;
      }
      if (entry.endsWith(".ts")) {
        found.push(child);
      }
    }
  };
  walk("src");
  return found;
}

describe("build target", () => {
  it("defaults to production when SITE_TARGET is unset or empty", () => {
    expect(SITE_TARGET_ENV).toBe("SITE_TARGET");
    expect(DEFAULT_SITE_TARGET).toBe("production");
    expect(parseSiteTarget(undefined)).toBe("production");
    expect(parseSiteTarget("")).toBe("production");
    expect(parseSiteTarget("   ")).toBe("production");
  });

  it("accepts qa and production, case-insensitively", () => {
    expect(parseSiteTarget("qa")).toBe("qa");
    expect(parseSiteTarget(" QA ")).toBe("qa");
    expect(parseSiteTarget("Production")).toBe("production");
  });

  it("refuses an unrecognised target instead of guessing what to ship", () => {
    expect(() => parseSiteTarget("staging")).toThrow(/SITE_TARGET/);
    expect(() => parseSiteTarget("prod")).toThrow(/SITE_TARGET/);
    expect(() => parseSiteTarget("demo")).toThrow(/SITE_TARGET/);
  });

  it("excludes both QA-only pages from production and includes them in qa", () => {
    expect(QA_ONLY_PAGES).toEqual(["demo-entradas.html", "epayco-staging-smoke.html"]);
    expect(isQaOnlyPage("demo-entradas.html")).toBe(true);
    expect(isQaOnlyPage("epayco-staging-smoke.html")).toBe(true);
    expect(isQaOnlyPage("entradas.html")).toBe(false);

    for (const page of QA_ONLY_PAGES) {
      expect(includesPage("production", page), page).toBe(false);
      expect(includesPage("qa", page), page).toBe(true);
    }
  });

  it("keeps the staging smoke page out of public/ so no build copies it verbatim", () => {
    // A file under `public/` is copied into every artifact; the QA-only page must therefore be a
    // gated Vite entry at the repository root instead.
    expect(existsSync(path.join(ROOT, "public", "epayco-staging-smoke.html"))).toBe(false);
    expect(existsSync(path.join(ROOT, "epayco-staging-smoke.html"))).toBe(true);
    expect(read("vite.config.ts")).toContain('epaycoSmoke: "epayco-staging-smoke.html"');
  });

  it("keeps every public page in both targets", () => {
    const publicPages = [
      "index.html",
      "nosotros.html",
      "entradas.html",
      "eventos.html",
      "marca-y-colaboracion.html",
      "preguntas-frecuentes.html",
      "terminos-y-condiciones.html",
      "gracias.html",
    ];
    for (const page of publicPages) {
      expect(includesPage("production", page), page).toBe(true);
      expect(includesPage("qa", page), page).toBe(true);
    }
  });

  it("filters the Vite page registry through the target", () => {
    const config = read("vite.config.ts");
    expect(config).toContain(SITE_TARGET_ENV);
    expect(config).toContain("parseSiteTarget");
    expect(config).toContain("includesPage");
    expect(config).toContain('demoEntradas: "demo-entradas.html"');
    expect(config).toContain("rollupOptions");
    // The input must be the filtered registry, never the unfiltered object.
    expect(config).toMatch(/filter\(\(\[, page\]\) => includesPage\(target, page\)\)/);
  });

  it("registers every page file that exists on disk", () => {
    const config = read("vite.config.ts");
    const htmlFiles = readdirSync(ROOT).filter((name) => name.endsWith(".html"));
    expect(htmlFiles).toContain("demo-entradas.html");
    for (const file of htmlFiles) {
      expect(config, `${file} must be a build input`).toContain(`"${file}"`);
    }
  });

  it("leaves the QA-only pages unlinked from every public page and module", () => {
    const htmlFiles = readdirSync(ROOT).filter(
      (name) => name.endsWith(".html") && !isQaOnlyPage(name),
    );
    for (const file of htmlFiles) {
      const source = read(file);
      expect(source, file).not.toContain("demo-entradas");
      expect(source, file).not.toContain("epayco-staging-smoke");
      expect(source, file).not.toContain("/src/demo/");
    }

    for (const file of sourceFilesExceptDemo()) {
      const source = read(file);
      expect(source, file).not.toContain("/demo-entradas");
      expect(source, file).not.toContain("src/demo/");
    }

    expect(read("vercel.json")).not.toContain("demo");
  });

  it("keeps the demo entry out of the shared application entrypoint", () => {
    // The demo must stay a separate entry: if it were imported from `main.ts` it would ship to
    // production inside the real bundle even when its own HTML page is excluded.
    const main = read("src/main.ts");
    expect(main).not.toContain("demo");
    const demoEntry = read("src/demo/demo-entradas.ts");
    expect(demoEntry).toContain('from "./page.ts"');
    expect(demoEntry).toContain("mountDemoPage");
  });
});
