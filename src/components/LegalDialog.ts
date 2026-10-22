/**
 * Legal Dialog (Phase 6C)
 *
 * Publishes the client's three legal documents — participants' terms, refund policy and
 * personal-data policy — exactly as supplied, in an accessible modal with tabbed documents.
 *
 * Two deliberate behaviours:
 *   * Fields the client left pending are rendered as visible chips, and a summary banner lists
 *     them, so a document with unresolved identity/date data cannot go unnoticed.
 *   * The text is never rewritten here: escaping is the only transformation applied.
 */

import {
  LEGAL_DOCUMENTS,
  LEGAL_PENDING_FIELDS,
  type LegalSection,
} from "../config/legal-content.ts";
import type { LegalTabId } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

/**
 * Record view of the pending labels. The extra indirection is deliberate: it makes an
 * undeclared token observably `undefined`, so the text keeps `{{token}}` visible instead of
 * rendering the word "undefined" inside a legal document.
 */
const PENDING_LABELS: Record<string, string> = LEGAL_PENDING_FIELDS;

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Escapes a client paragraph and turns `{{field}}` tokens into visible pending chips. */
export function renderLegalText(text: string): string {
  const parts = text.split(/\{\{([a-zA-Z]+)\}\}/g);
  return parts
    .map((part, index) => {
      // Odd indices are the captured token names, because of the capturing split.
      if (index % 2 === 1) {
        const label = PENDING_LABELS[part];
        return label === undefined
          ? escapeHtml(`{{${part}}}`)
          : `<span class="legal-pending" title="Campo pendiente de confirmación">(pendiente: ${escapeHtml(label)})</span>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

function renderSection(section: LegalSection): string {
  const paragraphs = section.paragraphs
    .map((paragraph) => `<p>${renderLegalText(paragraph)}</p>`)
    .join("");
  const bullets =
    section.bullets === undefined
      ? ""
      : `<ul class="legal-list">${section.bullets
          .map((bullet) => `<li>${renderLegalText(bullet)}</li>`)
          .join("")}</ul>`;

  return `
    <section class="legal-section" aria-labelledby="legal-${section.id}">
      <h4 class="legal-section-title" id="legal-${section.id}">${escapeHtml(section.heading)}</h4>
      ${paragraphs}
      ${bullets}
    </section>
  `;
}

function renderPanel(tab: LegalTabId): string {
  const document = LEGAL_DOCUMENTS.find((candidate) => candidate.id === tab);
  if (document === undefined) {
    return "";
  }

  const pendingChips = Object.values(LEGAL_PENDING_FIELDS)
    .map((label) => `<span class="legal-pending">(pendiente: ${escapeHtml(label)})</span>`)
    .join(" ");

  return `
    <section
      class="legal-panel"
      id="legal-panel-${document.id}"
      role="tabpanel"
      aria-labelledby="legal-tab-${document.id}"
      tabindex="0"
    >
      <h3 class="legal-panel-title">${escapeHtml(document.title)}</h3>
      <p class="legal-panel-brand">${escapeHtml(document.brandLine)}</p>

      <p class="legal-pending-banner">
        ${renderIcon("alert")}
        <span>
          Documento con campos pendientes de confirmación por parte de la organización:
          ${pendingChips}
        </span>
      </p>

      ${document.sections.map(renderSection).join("")}
    </section>
  `;
}

export type LegalDialogOptions = {
  /** Initial tab when opened without a specific request. */
  readonly initialTab?: LegalTabId;
};

export type LegalDialog = {
  readonly open: (tab?: LegalTabId) => void;
  readonly close: () => void;
  readonly dispose: () => void;
};

export function mountLegalDialog(options: LegalDialogOptions = {}): LegalDialog {
  const root = document.createElement("div");
  root.className = "legal-dialog";
  root.hidden = true;
  root.innerHTML = `
    <div class="legal-overlay" data-legal-close></div>
    <div
      class="legal-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-dialog-title"
    >
      <header class="legal-head">
        <h2 class="legal-title" id="legal-dialog-title">Términos y políticas</h2>
        <button type="button" class="legal-close" data-legal-close aria-label="Cerrar términos y políticas">
          ${renderIcon("close")}
        </button>
      </header>

      <div class="legal-tabs" role="tablist" aria-label="Documentos legales">
        ${LEGAL_DOCUMENTS.map(
          (document) => `
            <button
              type="button"
              class="legal-tab"
              role="tab"
              id="legal-tab-${document.id}"
              aria-controls="legal-panel-${document.id}"
              aria-selected="false"
              tabindex="-1"
              data-legal-tab-button="${document.id}"
            >
              ${escapeHtml(document.tabLabel)}
            </button>
          `,
        ).join("")}
      </div>

      <div class="legal-body" data-legal-body></div>
    </div>
  `;
  document.body.appendChild(root);

  const card = root.querySelector<HTMLElement>(".legal-card");
  const body = root.querySelector<HTMLElement>("[data-legal-body]");
  const tabButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-legal-tab-button]"),
  );
  let activeTab: LegalTabId = options.initialTab ?? "participantes";
  let previouslyFocused: HTMLElement | null = null;

  function showTab(tab: LegalTabId): void {
    activeTab = tab;
    if (body !== null) {
      body.innerHTML = renderPanel(tab);
      body.scrollTop = 0;
    }
    for (const button of tabButtons) {
      const isActive = button.getAttribute("data-legal-tab-button") === tab;
      button.setAttribute("aria-selected", String(isActive));
      button.tabIndex = isActive ? 0 : -1;
      button.classList.toggle("is-active", isActive);
    }
  }

  function open(tab?: LegalTabId): void {
    previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    showTab(tab ?? activeTab);
    root.hidden = false;
    card?.classList.add("is-open");
    document.body.classList.add("has-overlay");
    const firstFocusable = root.querySelector<HTMLElement>(FOCUSABLE);
    firstFocusable?.focus({ preventScroll: true });
  }

  function close(): void {
    root.hidden = true;
    card?.classList.remove("is-open");
    document.body.classList.remove("has-overlay");
    previouslyFocused?.focus({ preventScroll: true });
  }

  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target === null) {
      return;
    }
    if (target.closest("[data-legal-close]") !== null) {
      event.preventDefault();
      close();
      return;
    }
    const tabTarget = target.closest<HTMLElement>("[data-legal-tab-button]");
    if (tabTarget !== null) {
      const tab = tabTarget.getAttribute("data-legal-tab-button") as LegalTabId | null;
      if (tab !== null) {
        showTab(tab);
      }
    }
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (root.hidden) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab" || card === null) {
      return;
    }
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  function onTabKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const currentIndex = tabButtons.findIndex(
      (button) => button.getAttribute("data-legal-tab-button") === activeTab,
    );
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + delta + tabButtons.length) % tabButtons.length;
    const next = tabButtons[nextIndex];
    if (next === undefined) {
      return;
    }
    showTab(next.getAttribute("data-legal-tab-button") as LegalTabId);
    next.focus();
  }

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeydown);
  for (const button of tabButtons) {
    button.addEventListener("keydown", onTabKeydown);
  }

  showTab(activeTab);

  return {
    open,
    close,
    dispose: () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeydown);
      for (const button of tabButtons) {
        button.removeEventListener("keydown", onTabKeydown);
      }
      root.remove();
    },
  };
}
