/**
 * Tooling guardrails.
 *
 * Two easy-to-miss failure modes this test prevents:
 *
 * 1. Version drift. The shared core is tested with the npm packages installed by
 *    `package.json`, but it RUNS inside Edge Functions with the versions pinned in each
 *    `deno.json`. If those disagree, tests validate a different library version than the
 *    one that handles real money.
 * 2. Missing import mappings. The Supabase deployer resolves bare specifiers from the
 *    FUNCTION's own `deno.json`, so a dependency used inside `_shared` but missing there
 *    would only fail at deploy time.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FUNCTIONS_DIR = path.join(ROOT, "supabase", "functions");
const SHARED_DIR = path.join(FUNCTIONS_DIR, "_shared");
const SHARED_DENO_JSON = path.join(SHARED_DIR, "deno.json");

type DenoConfig = {
  imports?: Record<string, string>;
  compilerOptions?: Record<string, unknown>;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

/** `npm:zod@4.6.5` -> `{ name: "zod", version: "4.6.5" }` */
function parseNpmSpecifier(specifier: string): { name: string; version: string } | undefined {
  const match = /^npm:(@?[^@]+)@(.+)$/.exec(specifier);
  if (match === null) {
    return undefined;
  }
  const [, name, version] = match;
  return name === undefined || version === undefined ? undefined : { name, version };
}

function functionDirectories(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();
}

/** Strips a `^`/`~` range to a concrete version for comparison. */
function concreteVersion(range: string): string {
  return range.replace(/^[\^~>=<]+/, "");
}

const packageJson = readJson<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}>(path.join(ROOT, "package.json"));

const sharedDenoJson = readJson<DenoConfig>(SHARED_DENO_JSON);

describe("dependency parity", () => {
  it("pins the same npm versions in package.json and in the Deno configs", () => {
    for (const [name, specifier] of Object.entries(sharedDenoJson.imports ?? {})) {
      const parsed = parseNpmSpecifier(specifier);
      expect(parsed, `${name} must be an npm: specifier`).toBeDefined();
      if (parsed === undefined) {
        continue;
      }
      const declared =
        packageJson.dependencies?.[parsed.name] ?? packageJson.devDependencies?.[parsed.name];
      expect(declared, `${parsed.name} must be a dependency in package.json`).toBeDefined();
      expect(
        concreteVersion(declared ?? ""),
        `${parsed.name} must use the same version in package.json and in the Deno configs`,
      ).toBe(parsed.version);
    }
  });

  it("maps every bare specifier used by the shared core", () => {
    const mapped = new Set(Object.keys(sharedDenoJson.imports ?? {}));
    const bareSpecifiers = new Set<string>();

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name === "database.types.ts") {
          continue;
        }
        const source = readFileSync(entryPath, "utf8");
        for (const match of source.matchAll(/from\s+"([^".][^"]*)"/g)) {
          const specifier = match[1];
          if (specifier !== undefined && !specifier.startsWith("node:")) {
            bareSpecifiers.add(specifier);
          }
        }
      }
    };
    walk(SHARED_DIR);

    expect(bareSpecifiers.size).toBeGreaterThan(0);
    for (const specifier of bareSpecifiers) {
      expect(
        mapped.has(specifier),
        `${specifier} must be mapped in supabase/functions/_shared/deno.json`,
      ).toBe(true);
    }
  });

  it("keeps every function's Deno config in sync with the shared one", () => {
    const directories = functionDirectories();
    expect(directories.length).toBeGreaterThan(0);

    for (const directory of directories) {
      const configPath = path.join(FUNCTIONS_DIR, directory, "deno.json");
      expect(existsSync(configPath), `${directory} must have its own deno.json`).toBe(true);
      const config = readJson<DenoConfig>(configPath);

      expect(
        config.imports,
        `${directory}/deno.json must map exactly the same dependencies as _shared/deno.json`,
      ).toEqual(sharedDenoJson.imports);
      expect(
        config.compilerOptions,
        `${directory}/deno.json must use the same compiler options as _shared/deno.json`,
      ).toEqual(sharedDenoJson.compilerOptions);
    }
  });

  it("runs on a runtime the project targets (Node 24+, Deno 2)", () => {
    const engines = readJson<{ engines?: { node?: string } }>(
      path.join(ROOT, "package.json"),
    ).engines;
    expect(engines?.node).toBe(">=24");
    for (const directory of functionDirectories()) {
      // Supabase's own edge runtime is pinned in supabase/config.toml.
      expect(existsSync(path.join(FUNCTIONS_DIR, directory, "index.ts"))).toBe(true);
    }
  });
});
