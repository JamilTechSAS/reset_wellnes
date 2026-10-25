/**
 * Post-purchase email assets.
 *
 * The email is rendered by the backend, but its images are served from the website origin
 * (`EMAIL_ASSETS_BASE_URL`, defaulting to `<PUBLIC_WEB_BASE_URL>/correo/img`), so they must ship as
 * static files under `public/`. Vite copies `public/` verbatim into `dist/`, which is what makes the
 * URLs work in production; the two supplied files must live there under exactly the names the
 * template interpolates. If one is missing, every buyer sees a broken image and nothing else fails.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const ASSETS = [
  { file: "public/correo/img/encabezado.jpg", url: "/correo/img/encabezado.jpg", kind: "jpeg" },
  { file: "public/correo/img/logo-beige.png", url: "/correo/img/logo-beige.png", kind: "png" },
] as const;

function bytes(relative: string): Buffer {
  return readFileSync(path.join(ROOT, relative));
}

describe("email assets", () => {
  it.each(ASSETS)("ships $file at the path the email uses", ({ file, url }) => {
    const stats = statSync(path.join(ROOT, file));
    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBeGreaterThan(1024);
    expect(url).toBe(`/${file.replace(/^public\//, "")}`);
  });

  it("keeps the JPEG signature so clients render it", () => {
    const data = bytes("public/correo/img/encabezado.jpg");
    // JPEG SOI marker: every real .jpg starts with FFD8FF.
    expect([data[0], data[1], data[2]]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("keeps the PNG signature so browsers render it inline", () => {
    const data = bytes("public/correo/img/logo-beige.png");
    expect([...data.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("matches the file names the email template interpolates", () => {
    const source = readFileSync(
      path.join(ROOT, "supabase", "functions", "_shared", "domain", "post-purchase-email.ts"),
      "utf8",
    );
    for (const { file } of ASSETS) {
      const name = path.basename(file);
      expect(source).toContain(`\${escapeHtml(assets)}/${name}`);
    }
  });

  it("is copied into the production build output", () => {
    for (const { file } of ASSETS) {
      const built = path.join(ROOT, "dist", file.replace(/^public\//, ""));
      if (!existsSync(path.join(ROOT, "dist", "index.html"))) {
        // No build on disk: the source assertions above are the guardrail in that case.
        continue;
      }
      expect(statSync(built).size).toBeGreaterThan(1024);
    }
  });
});
