// @vitest-environment happy-dom
/**
 * Legal content and dialog tests (Phase 6C)
 *
 * The client's three legal documents are published verbatim, and the fields they left as
 * `(pendiente)` must stay visible instead of being quietly filled in. These tests pin both
 * properties: the text is the client's (only escaped, never rewritten) and the unresolved
 * values are rendered as explicit pending chips.
 */

import { describe, expect, it } from "vitest";
import {
  LEGAL_DOCUMENTS,
  LEGAL_PENDING_FIELDS,
  LEGAL_REVIEW_NOTES,
} from "../../src/config/legal-content.ts";
import { mountLegalDialog, renderLegalText } from "../../src/components/LegalDialog.ts";

/** Every `{{token}}` that appears in the published documents (comments excluded). */
function tokensInDocuments(): string[] {
  const found: string[] = [];
  const collect = (value: string): void => {
    for (const match of value.matchAll(/\{\{([a-zA-Z]+)\}\}/g)) {
      const token = match[1];
      if (token !== undefined) {
        found.push(token);
      }
    }
  };

  for (const document of LEGAL_DOCUMENTS) {
    collect(document.title);
    collect(document.tabLabel);
    collect(document.brandLine);
    for (const section of document.sections) {
      collect(section.heading);
      section.paragraphs.forEach(collect);
      section.bullets?.forEach(collect);
    }
  }
  return found;
}

describe("LEGAL_DOCUMENTS", () => {
  it("carries the client's three documents in the order their site presents them", () => {
    expect(LEGAL_DOCUMENTS.map((document) => document.id)).toEqual([
      "participantes",
      "reembolsos",
      "privacidad",
    ]);
    for (const document of LEGAL_DOCUMENTS) {
      expect(document.tabLabel.length).toBeGreaterThan(3);
      expect(document.title.length).toBeGreaterThan(3);
      expect(document.brandLine).toContain("Reset Wellness Club");
      expect(document.sections.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("publishes sections with real text, never an empty placeholder document", () => {
    for (const document of LEGAL_DOCUMENTS) {
      let length = 0;
      for (const section of document.sections) {
        expect(section.id).toBeTruthy();
        expect(section.heading.length).toBeGreaterThan(3);
        // A section carries prose, bullets or both; a short lead-in line ("No debes:") is the
        // client's own wording and is kept as supplied.
        const body = [...section.paragraphs, ...(section.bullets ?? [])];
        expect(body.length).toBeGreaterThan(0);
        for (const text of body) {
          expect(text.trim().length).toBeGreaterThan(0);
          length += text.length;
        }
      }
      expect(length).toBeGreaterThan(1_000);
    }
  });

  it("keeps the client's own wording for the points a buyer must be able to read", () => {
    const texto = JSON.stringify(LEGAL_DOCUMENTS);

    // Participants' terms: the waiver and the risk assumption are the client's, untouched.
    expect(texto).toContain("Asunción de riesgos");
    expect(texto).toContain("asumo voluntariamente");
    // Refund policy: the 7-day window from their own text.
    expect(texto).toContain("7 días");
    // Data policy: Colombian law 1581 of 2012 is named by the client.
    expect(texto).toContain("Ley 1581 de 2012");
    // Reset Wellness Club is the data controller's contact in the document.
    expect(texto).toContain("reset.wellness@gmail.com");
  });

  it("renders every pending client field as a token that is declared in LEGAL_PENDING_FIELDS", () => {
    const declared = Object.keys(LEGAL_PENDING_FIELDS);
    const used = tokensInDocuments();

    expect(used.length).toBeGreaterThan(0);
    for (const token of used) {
      expect(declared).toContain(token);
    }
    // Each declared field is actually needed by the text: none is dead weight.
    for (const key of declared) {
      expect(used).toContain(key);
    }
  });

  it("records the review notes the client must sign off before publication", () => {
    expect(LEGAL_REVIEW_NOTES.length).toBeGreaterThanOrEqual(5);
    const notes = LEGAL_REVIEW_NOTES.join(" ");
    // The refund inconsistency and the third-party-processor mismatch are both documented.
    expect(notes).toContain("48 horas");
    expect(notes).toContain("FormSubmit");
    expect(notes).toContain("NIT");
  });
});

describe("renderLegalText", () => {
  it("escapes HTML in the client's text", () => {
    const html = renderLegalText("<script>alert(1)</script> & <b>texto</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("turns a pending field into a visible chip with its human label", () => {
    const html = renderLegalText("El sitio está en {{webDomain}} y sigue pendiente.");
    expect(html).not.toContain("{{webDomain}}");
    expect(html).toContain("legal-pending");
    expect(html).toContain("dominio del sitio web");
    expect(html).toContain("sigue pendiente");
  });

  it("leaves an unknown token visible instead of silently dropping it", () => {
    const html = renderLegalText("Valor: {{algoNoDeclarado}}");
    expect(html).toContain("algoNoDeclarado");
  });
});

describe("legal dialog", () => {
  it("stays hidden until opened and publishes one panel per document", () => {
    const dialog = mountLegalDialog();
    const root = document.querySelector<HTMLElement>(".legal-dialog");
    expect(root?.hidden).toBe(true);

    const tabs = root?.querySelectorAll(".legal-tab");
    expect(tabs).toHaveLength(LEGAL_DOCUMENTS.length);

    dialog.dispose();
    expect(document.querySelector(".legal-dialog")).toBeNull();
  });

  it("opens on the requested document and switches tabs", () => {
    const dialog = mountLegalDialog();
    dialog.open("reembolsos");

    const root = document.querySelector<HTMLElement>(".legal-dialog");
    expect(root?.hidden).toBe(false);
    expect(document.body.classList.contains("has-overlay")).toBe(true);

    const selected = root?.querySelector(".legal-tab[aria-selected='true']");
    expect(selected?.getAttribute("data-legal-tab-button")).toBe("reembolsos");
    expect(root?.querySelector("#legal-panel-reembolsos")).not.toBeNull();
    expect(root?.querySelector("#legal-panel-reembolsos h3")?.textContent).toContain(
      LEGAL_DOCUMENTS.find((document) => document.id === "reembolsos")?.title ?? "",
    );

    root
      ?.querySelector<HTMLElement>("[data-legal-tab-button='privacidad']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root?.querySelector(".legal-tab[aria-selected='true']")?.textContent).toContain(
      "privacidad",
    );

    dialog.dispose();
  });

  it("lists every unresolved field in the pending banner", () => {
    const dialog = mountLegalDialog();
    dialog.open("participantes");

    const banner = document.querySelector(".legal-pending-banner");
    expect(banner).not.toBeNull();
    for (const label of Object.values(LEGAL_PENDING_FIELDS)) {
      expect(banner?.textContent).toContain(label);
    }
    expect(banner?.textContent).toContain("pendientes de confirmación");

    dialog.dispose();
  });

  it("closes on Escape, on the backdrop and on the close button, restoring focus", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    const dialog = mountLegalDialog();

    for (const closeBy of ["escape", "backdrop", "button"] as const) {
      opener.focus();
      dialog.open("reembolsos");
      const root = document.querySelector<HTMLElement>(".legal-dialog");
      expect(root?.hidden).toBe(false);

      if (closeBy === "escape") {
        root?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else if (closeBy === "backdrop") {
        root
          ?.querySelector<HTMLElement>(".legal-overlay")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } else {
        root
          ?.querySelector<HTMLElement>(".legal-close")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }

      expect(root?.hidden).toBe(true);
      expect(document.activeElement).toBe(opener);
    }

    dialog.dispose();
    opener.remove();
  });

  it("moves between documents with the arrow keys", () => {
    const dialog = mountLegalDialog();
    dialog.open("participantes");

    const root = document.querySelector<HTMLElement>(".legal-dialog");
    const firstTab = root?.querySelector<HTMLElement>("[data-legal-tab-button='participantes']");
    firstTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(
      root
        ?.querySelector(".legal-tab[aria-selected='true']")
        ?.getAttribute("data-legal-tab-button"),
    ).toBe("reembolsos");

    dialog.dispose();
  });
});
