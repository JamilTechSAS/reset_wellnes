/**
 * Environment template and secret hygiene.
 *
 * Two guardrails:
 *  1. `.env.example` must document exactly the variables the configuration loader reads,
 *     so a new variable cannot be added without telling operators about it.
 *  2. No credential-shaped string may be committed anywhere in the repository. Values
 *     published in public provider documentation are allow-listed explicitly, and
 *     generated files (lockfiles) are skipped.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const ENV_LOADER = path.join(ROOT, "supabase", "functions", "_shared", "config", "env.ts");

/** Variables the loader reads, extracted from the single source of truth. */
function variablesReadByLoader(): Set<string> {
  const source = readFileSync(ENV_LOADER, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(
    /(?:readString|readBoolean|readEnum|requireValue)\(\s*env,\s*"([A-Z0-9_]+)"/g,
  )) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}

/** Active assignments only (a developer copying the file gets exactly these values). */
function assignedVariables(envFile: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      assignments.set(match[1], match[2] ?? "");
    }
  }
  return assignments;
}

/**
 * Every variable the template mentions, including ones documented as commented examples
 * (for example `WOMPI_BASE_URL`, which must never be active by default because it is
 * rejected outside development).
 */
function documentedVariables(envFile: string): Map<string, string> {
  const documented = new Map<string, string>();
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      documented.set(match[1], match[2] ?? "");
    }
  }
  return documented;
}

/**
 * Credential shapes that must never appear in the repository. The PEM pattern requires a
 * realistic key body (200+ base64 characters), so the bare headers used in the documentation
 * and in the env-validation tests are not false positives.
 */
const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "Wompi private key", pattern: /prv_(test|prod)_[A-Za-z0-9]{20,}/g },
  { name: "Wompi integrity secret", pattern: /(test|prod)_integrity_[A-Za-z0-9]{16,}/g },
  { name: "Wompi events secret", pattern: /(test|prod)_events_[A-Za-z0-9]{16,}/g },
  { name: "Supabase secret key", pattern: /sb_secret_[A-Za-z0-9_-]{20,}/g },
  { name: "Resend API key", pattern: /re_[A-Za-z0-9]{24,}/g },
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g },
  // A real PEM key (Google Sheets service account), not the bare header used as a placeholder.
  {
    name: "PEM private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,40}?[A-Za-z0-9+/]{200,}/g,
  },
  // A Google service-account file always carries both of these fields.
  {
    name: "Google service account",
    pattern: /"type"\s*:\s*"service_account"[\s\S]{0,400}?"private_key"/g,
  },
];

describe(".env.example", () => {
  it("documents every variable the configuration loader reads", () => {
    const documented = documentedVariables(ENV_EXAMPLE);
    for (const name of variablesReadByLoader()) {
      expect(documented.has(name), `${name} must appear in .env.example`).toBe(true);
    }
  });

  it("keeps the template keyed to the exact variable names used in code", () => {
    const loader = readFileSync(ENV_LOADER, "utf8");
    for (const name of assignedVariables(ENV_EXAMPLE).keys()) {
      expect(loader.includes(`"${name}"`), `${name} is not read by config/env.ts`).toBe(true);
    }
  });

  it("contains placeholders only, never real credentials", () => {
    for (const [name, value] of assignedVariables(ENV_EXAMPLE)) {
      if (/^(prv_|pub_|sb_secret_|sb_publishable_|re_)/.test(value)) {
        expect(
          /replace/i.test(value),
          `${name} must hold a REPLACE_ME style placeholder instead of a credential`,
        ).toBe(true);
      }
      expect(value.length, `${name} looks too long for a placeholder`).toBeLessThan(80);
    }
  });

  it("keeps .env files out of git while allowing the template", () => {
    const gitignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
  });
});

describe("repository secret hygiene", () => {
  const IGNORED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    ".freebuff",
    ".agents",
    "coverage",
    ".vitest",
  ]);
  const IGNORED_FILES = new Set(["package-lock.json", "deno.lock"]);
  const TEXT_EXTENSIONS = new Set([
    ".ts",
    ".js",
    ".json",
    ".sql",
    ".md",
    ".toml",
    ".yml",
    ".yaml",
    ".mjs",
    ".cjs",
    ".txt",
  ]);

  /**
   * Values that appear verbatim in public provider documentation. They are examples, not
   * credentials, and keeping them lets the tests and docs cite the documented vectors.
   */
  const ALLOWED_PUBLIC_EXAMPLES = new Set([
    // docs.wompi.co > Widget & Checkout Web (integrity signature example)
    "prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6",
    // docs.wompi.co > Events (event checksum example)
    "prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z",
  ]);

  function collectFiles(directory: string, collected: string[] = []): string[] {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".env")) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        collectFiles(entryPath, collected);
        continue;
      }
      if (IGNORED_FILES.has(entry.name)) {
        continue;
      }
      if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        collected.push(entryPath);
      }
    }
    return collected;
  }

  it("detects representative credentials and keeps the documented placeholders quiet", () => {
    const base64Body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ".repeat(6);
    const realisticPem = `-----BEGIN PRIVATE KEY-----\n${base64Body}\n-----END PRIVATE KEY-----`;
    const placeholderPem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----";
    const serviceAccount = JSON.stringify({
      type: "service_account",
      project_id: "evento",
      private_key: realisticPem,
    });

    const patternFor = (name: string): RegExp => {
      const entry = CREDENTIAL_PATTERNS.find((candidate) => candidate.name === name);
      expect(entry, `${name} must exist in the sweep`).toBeDefined();
      return new RegExp(entry?.pattern.source ?? "", entry?.pattern.flags ?? "");
    };

    expect(patternFor("PEM private key").test(realisticPem)).toBe(true);
    expect(patternFor("PEM private key").test(placeholderPem)).toBe(false);
    expect(patternFor("Google service account").test(serviceAccount)).toBe(true);
  });

  it("commits no credential-shaped strings", () => {
    const files = collectFiles(ROOT);
    expect(files.length).toBeGreaterThan(10);

    const findings: string[] = [];
    for (const file of files) {
      if (statSync(file).size > 500_000) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      for (const { name, pattern } of CREDENTIAL_PATTERNS) {
        for (const match of content.matchAll(pattern)) {
          const value = match[0];
          if (!ALLOWED_PUBLIC_EXAMPLES.has(value)) {
            findings.push(`${path.relative(ROOT, file)}: possible ${name}`);
          }
        }
      }
    }
    expect(findings).toEqual([]);
  });
});
