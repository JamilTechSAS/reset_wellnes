/**
 * `/eventos` — the event archive.
 *
 * The page ships before the photos exist, so its markup used to carry internal captions like
 * "(foto del evento 1)" and a gallery that announced "Así se vivió" for an event that had not
 * happened yet. Those strings are editor instructions, not copy: this test keeps them out of
 * the visitor's page.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HTML = readFileSync(new URL("../../eventos.html", import.meta.url), "utf8");

/** What a visitor actually reads: comments and tags stripped. */
const VISIBLE_TEXT = HTML.replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

describe("eventos archive page", () => {
  it("never shows an internal placeholder caption", () => {
    expect(VISIBLE_TEXT).not.toMatch(/\(foto/i);
    expect(VISIBLE_TEXT).not.toMatch(/foto del evento/i);
    expect(VISIBLE_TEXT).not.toMatch(/fotos pendientes/i);
    expect(VISIBLE_TEXT).not.toMatch(/reemplaza/i);
  });

  it("does not announce a gallery for an event that has not happened", () => {
    expect(HTML).not.toContain('id="galeria-sunset-vol1"');
    expect(VISIBLE_TEXT).not.toMatch(/Así se vivió/i);
    expect(VISIBLE_TEXT).not.toMatch(/Ver fotos/i);
  });

  it("keeps the event identity visible while there is no photo", () => {
    expect(VISIBLE_TEXT).toContain("15.11.2026");
    expect(VISIBLE_TEXT).toContain("Terraza del hotel GHL");
    expect(VISIBLE_TEXT).toContain("Re set Sunset");
  });
});
