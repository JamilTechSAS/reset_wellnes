/**
 * Hosting guardrail for clean URLs and the checkout return path.
 *
 * Vite builds one HTML file per `rollupOptions.input` entry and Vercel serves `dist/` as static
 * files. With `cleanUrls: true`, Vercel serves each `foo.html` at `/foo` and 308-redirects the
 * old `/foo.html` to `/foo`. In particular `/gracias` is served by the real `gracias.html`
 * thank-you page (no rewrite to `index.html`), so the page runs its own authoritative payment
 * verification instead of resuming the purchase dialog.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

type VercelConfig = {
  cleanUrls?: boolean;
  rewrites?: { source: string; destination: string }[];
};

function readVercelConfig(): VercelConfig {
  return JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as VercelConfig;
}

describe("vercel.json clean URLs and return route", () => {
  it("enables clean URLs", () => {
    expect(readVercelConfig().cleanUrls).toBe(true);
  });

  it("serves /gracias from the real thank-you page, not a rewrite to index.html", () => {
    const rewrites = readVercelConfig().rewrites ?? [];
    expect(rewrites.find((r) => r.source === "/gracias")).toBeUndefined();
    expect(rewrites.find((r) => r.destination === "/index.html")).toBeUndefined();
    expect(existsSync(path.join(ROOT, "gracias.html"))).toBe(true);
  });

  it("builds gracias.html as its own Vite entry running the verification script", () => {
    const viteConfig = readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
    expect(viteConfig).toContain('resolve(__dirname, "gracias.html")');
    const gracias = readFileSync(path.join(ROOT, "gracias.html"), "utf8");
    expect(gracias).toContain('src="/src/gracias.ts"');
    expect(gracias).not.toContain('src="/src/main.ts"');
  });

  it("does not add a catch-all rewrite that would hide real 404s", () => {
    for (const { source } of readVercelConfig().rewrites ?? []) {
      expect(source).not.toMatch(/[*(:]/);
    }
  });
});
