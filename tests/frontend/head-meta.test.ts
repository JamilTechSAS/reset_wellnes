/**
 * Head metadata guardrails: every page points at the Reset favicon, public pages declare a
 * clean canonical URL, and internal navigation uses extensionless (clean) URLs.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

const ALL_PAGES = [
  "index.html",
  "nosotros.html",
  "entradas.html",
  "eventos.html",
  "marca-y-colaboracion.html",
  "preguntas-frecuentes.html",
  "terminos-y-condiciones.html",
  "gracias.html",
];

const CANONICAL: Record<string, string> = {
  "index.html": "https://www.resetwellness.com.co/",
  "nosotros.html": "https://www.resetwellness.com.co/nosotros",
  "entradas.html": "https://www.resetwellness.com.co/entradas",
  "marca-y-colaboracion.html": "https://www.resetwellness.com.co/marca-y-colaboracion",
  "preguntas-frecuentes.html": "https://www.resetwellness.com.co/preguntas-frecuentes",
  "terminos-y-condiciones.html": "https://www.resetwellness.com.co/terminos-y-condiciones",
  "gracias.html": "https://www.resetwellness.com.co/gracias",
};

function read(page: string): string {
  return readFileSync(path.join(ROOT, page), "utf8");
}

describe("favicon", () => {
  it("ships a favicon at the web root", () => {
    expect(existsSync(path.join(ROOT, "public", "favicon.ico"))).toBe(true);
  });

  it.each(ALL_PAGES)("%s references /favicon.ico", (page) => {
    expect(read(page)).toContain('<link rel="icon" href="/favicon.ico" sizes="any" />');
  });
});

describe("canonical URLs", () => {
  it.each(Object.entries(CANONICAL))("%s declares the clean canonical %s", (page, url) => {
    expect(read(page)).toContain(`<link rel="canonical" href="${url}" />`);
  });

  it("no canonical still points at a .html URL", () => {
    for (const page of ALL_PAGES) {
      const canonicals = [...read(page).matchAll(/<link rel="canonical" href="([^"]+)"/g)];
      for (const match of canonicals) {
        expect((match[1] ?? "").endsWith(".html")).toBe(false);
      }
    }
  });
});

describe("internal links use clean URLs", () => {
  it.each(ALL_PAGES)("%s has no extensionful internal page links", (page) => {
    const html = read(page);
    // Active href attributes should not point at a local *.html file anymore.
    const matches = [...html.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1] ?? "")
      .filter((href) => /^[a-z0-9/.#-]+\.html(#|$|\/)/i.test(href) && !href.startsWith("http"));
    expect(matches).toEqual([]);
  });
});
