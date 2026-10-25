/**
 * Phase 6D: the frontend must consume the HOSTED backend, through the existing configuration
 * module — and only through it.
 *
 * These assertions are about wiring, not about content: which backend a given build talks to,
 * which event code it sells, and the fact that no production-facing file carries a placeholder
 * value or a credential-shaped variable. A silent regression here is invisible in a screenshot:
 * the page renders perfectly and talks to the wrong (or a dead) backend.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_CODE,
  DEFAULT_TICKET_TYPE_CODE,
  HOSTED_API_BASE_URL,
  LOCAL_API_BASE_URL,
  loadFrontendConfig,
} from "../../src/config/env.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG_MODULE = path.join("src", "config", "env.ts");

/** Values that belonged to the placeholder event and must never reach a production-facing file. */
const BANNED_VALUES = [
  "TAT-2026",
  "Medellín",
  "El Poblado",
  "21 de noviembre",
  "evento.ejemplo",
  "evento_oficial_2026",
  "Experiencia Exclusiva",
];

const TEXT_EXTENSIONS = new Set([".ts", ".js", ".css", ".html", ".json", ".svg", ".txt", ".md"]);

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "supabase"]);

function walk(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      found.push(...walk(path.join(directory, entry.name)));
      continue;
    }
    if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(path.join(directory, entry.name));
    }
  }
  return found;
}

/** Every production-facing file: the bundle's sources, its HTML shell and its static assets. */
function productionFacingFiles(): readonly string[] {
  const roots = ["src", "public"].map((directory) => path.join(ROOT, directory));
  return [...roots.flatMap((directory) => walk(directory)), path.join(ROOT, "index.html")].filter(
    (file) => statSync(file).isFile(),
  );
}

describe("backend target", () => {
  it("points a production build at the hosted project and a dev build at the local stack", () => {
    expect(HOSTED_API_BASE_URL).toBe("https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1");
    expect(HOSTED_API_BASE_URL.startsWith("https://")).toBe(true);
    expect(HOSTED_API_BASE_URL.endsWith("/functions/v1")).toBe(true);
    expect(LOCAL_API_BASE_URL).toBe("http://127.0.0.1:54321/functions/v1");

    expect(loadFrontendConfig({}).apiBaseUrl).toBe(LOCAL_API_BASE_URL);
    expect(loadFrontendConfig({ PROD: true }).apiBaseUrl).toBe(HOSTED_API_BASE_URL);
    expect(loadFrontendConfig({ PROD: false }).apiBaseUrl).toBe(LOCAL_API_BASE_URL);
  });

  it("never lets an explicit base URL keep a trailing slash", () => {
    expect(
      loadFrontendConfig({ VITE_API_BASE_URL: "https://example.test/functions/v1/" }).apiBaseUrl,
    ).toBe("https://example.test/functions/v1");
    expect(
      loadFrontendConfig({ VITE_API_BASE_URL: "  https://example.test/functions/v1  " }).apiBaseUrl,
    ).toBe("https://example.test/functions/v1");
    expect(loadFrontendConfig({ VITE_API_BASE_URL: "   " }).apiBaseUrl).toBe(LOCAL_API_BASE_URL);
    expect(
      loadFrontendConfig({ PROD: true, VITE_API_BASE_URL: "http://127.0.0.1:9/v1" }).apiBaseUrl,
    ).toBe("http://127.0.0.1:9/v1");
  });

  it("keeps the project reference in exactly one file", () => {
    const projectRef = "pzogdjjdkgolybfcegcs";
    const carrying = walk(path.join(ROOT, "src")).filter((file) =>
      readFileSync(file, "utf8").includes(projectRef),
    );
    expect(carrying.map((file) => path.relative(ROOT, file))).toEqual([CONFIG_MODULE]);
  });
});

describe("event and ticket identifiers", () => {
  it("sells the real event by default", () => {
    expect(DEFAULT_EVENT_CODE).toBe("RESET-SUNSET-2026");
    expect(loadFrontendConfig({}).eventCode).toBe(DEFAULT_EVENT_CODE);
    expect(loadFrontendConfig({}).eventCode).not.toMatch(/TAT/);
    // The database check is `^[A-Z0-9][A-Z0-9_-]{1,31}$`.
    expect(DEFAULT_EVENT_CODE).toMatch(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);
  });

  it("normalizes an operator-supplied code instead of trusting its case", () => {
    expect(loadFrontendConfig({ VITE_EVENT_CODE: " reset-sunset-2026 " }).eventCode).toBe(
      "RESET-SUNSET-2026",
    );
    expect(loadFrontendConfig({ VITE_EVENT_CODE: "preventa-2027" }).eventCode).toBe(
      "PREVENTA-2027",
    );
  });

  it("keeps a documented ticket-type default and normalizes it too", () => {
    expect(DEFAULT_TICKET_TYPE_CODE).toBe("GENERAL");
    expect(loadFrontendConfig({}).ticketTypeCode).toBe("GENERAL");
    expect(loadFrontendConfig({ VITE_TICKET_TYPE_CODE: "comparte" }).ticketTypeCode).toBe(
      "COMPARTE",
    );
  });

  it("exposes no second payment provider: ePayco is the only checkout", () => {
    expect(loadFrontendConfig({})).not.toHaveProperty("wompiCheckoutUrl");
  });
});

describe("production-facing hygiene", () => {
  it("reads only the public VITE_ variables documented for the frontend", () => {
    const source = readFileSync(path.join(ROOT, CONFIG_MODULE), "utf8");
    const names = [...new Set(source.match(/VITE_[A-Z0-9_]+/g) ?? [])].sort();
    expect(names).toEqual([
      "VITE_API_BASE_URL",
      "VITE_CHECKOUT_ENABLED",
      "VITE_EVENT_CODE",
      "VITE_TICKET_TYPE_CODE",
    ]);

    const docs = readFileSync(path.join(ROOT, "docs", "frontend.md"), "utf8");
    for (const name of names) {
      expect(docs.includes(name), `${name} is not documented in docs/frontend.md`).toBe(true);
    }
  });

  it("ships no placeholder event value in any production-facing file", () => {
    for (const file of productionFacingFiles()) {
      const content = readFileSync(file, "utf8");
      for (const banned of BANNED_VALUES) {
        expect(
          content.includes(banned),
          `${path.relative(ROOT, file)} still contains "${banned}"`,
        ).toBe(false);
      }
    }
  });
});
