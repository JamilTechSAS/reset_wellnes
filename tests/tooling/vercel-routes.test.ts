/**
 * Hosting guardrail for the checkout return path.
 *
 * Vite builds one HTML file per `rollupOptions.input` entry and Vercel serves `dist/` as static
 * files, so a path with no file of its own (like `/gracias`) is a 404 unless `vercel.json`
 * rewrites it. The dev server hides this: it falls back to `index.html` for any path.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

type VercelConfig = {
  rewrites?: { source: string; destination: string }[];
};

function readVercelConfig(): VercelConfig {
  return JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as VercelConfig;
}

describe("vercel.json checkout return route", () => {
  it("rewrites /gracias (with and without trailing slash) to a page", () => {
    const rewrites = readVercelConfig().rewrites ?? [];
    for (const source of ["/gracias", "/gracias/"]) {
      expect(rewrites.find((r) => r.source === source)?.destination).toBe("/index.html");
    }
  });

  it("only rewrites to HTML entries Vite actually builds and that boot the purchase flow", () => {
    const viteConfig = readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
    for (const { destination } of readVercelConfig().rewrites ?? []) {
      const file = destination.replace(/^\//, "");
      expect(existsSync(path.join(ROOT, file))).toBe(true);
      expect(viteConfig).toContain(`resolve(__dirname, "${file}")`);
      expect(readFileSync(path.join(ROOT, file), "utf8")).toContain('src="/src/main.ts"');
    }
  });

  it("does not add a catch-all that would hide real 404s", () => {
    for (const { source } of readVercelConfig().rewrites ?? []) {
      expect(source).not.toMatch(/[*(:]/);
    }
  });
});
