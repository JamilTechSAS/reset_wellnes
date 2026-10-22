/**
 * FAQ Accordion Component (Phase 6A)
 *
 * Implements accessible, keyboard-friendly accordion according to
 * WAI-ARIA 1.2 Accordion Pattern:
 * - Proper aria-expanded, aria-controls, aria-labelledby, role="region"
 * - Keyboard navigation (Enter, Space, Arrow Up, Arrow Down, Home, End)
 * - Smooth CSS transitions without performance overhead
 */

import type { EventLandingConfig } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

export function renderFaq(config: EventLandingConfig): string {
  const { faq } = config;

  const itemsHtml = faq.items
    .map(
      (item) => `
        <div class="faq-item" id="faq-item-${item.id}">
          <button
            type="button"
            class="faq-button"
            id="faq-btn-${item.id}"
            aria-expanded="false"
            aria-controls="faq-panel-${item.id}"
          >
            <span>${escapeHtml(item.question)}</span>
            ${item.isPending === true ? '<span class="faq-pending">Confirmación pendiente</span>' : ""}
            ${renderIcon("chevron-down", "faq-chevron")}
          </button>
          <div
            class="faq-panel"
            id="faq-panel-${item.id}"
            role="region"
            aria-labelledby="faq-btn-${item.id}"
            aria-hidden="true"
          >
            <div class="faq-panel-content">
              <div class="faq-answer-inner">
                ${escapeHtml(item.answer)}
              </div>
            </div>
          </div>
        </div>
      `,
    )
    .join("");

  return `
    <section class="section" id="preguntas" aria-labelledby="faq-heading">
      <div class="container">
        <header class="section-header">
          <div class="eyebrow-badge accent">
            ${renderIcon("sparkle")}
            <span>${escapeHtml(faq.sectionEyebrow)}</span>
          </div>
          <h2 id="faq-heading">${escapeHtml(faq.sectionTitle)}</h2>
          <p class="section-description">${escapeHtml(faq.sectionDescription)}</p>
        </header>

        <div class="faq-container">
          <div class="faq-list" role="presentation">
            ${itemsHtml}
          </div>
        </div>
      </div>
    </section>
  `;
}

/**
 * Attaches accessible interaction handlers to FAQ accordion elements.
 *
 * @param container Element containing the FAQ list (defaults to document)
 */
export function initFaqAccordion(container: Document | HTMLElement = document): () => void {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".faq-button"));

  const toggleItem = (button: HTMLButtonElement): void => {
    const isCurrentlyExpanded = button.getAttribute("aria-expanded") === "true";
    const controlsId = button.getAttribute("aria-controls");
    const panel = controlsId ? container.querySelector<HTMLElement>(`#${controlsId}`) : null;
    const itemWrapper = button.closest(".faq-item");

    const willExpand = !isCurrentlyExpanded;

    button.setAttribute("aria-expanded", String(willExpand));
    if (panel) {
      panel.setAttribute("aria-hidden", String(!willExpand));
    }
    if (itemWrapper) {
      itemWrapper.classList.toggle("is-open", willExpand);
    }
  };

  const clickHandlers: { button: HTMLButtonElement; handler: (e: MouseEvent) => void }[] = [];
  const keyHandlers: { button: HTMLButtonElement; handler: (e: KeyboardEvent) => void }[] = [];

  buttons.forEach((button, index) => {
    const onClick = (e: MouseEvent): void => {
      e.preventDefault();
      toggleItem(button);
    };

    const onKeydown = (e: KeyboardEvent): void => {
      let targetIndex: number | null = null;

      if (e.key === "ArrowDown") {
        targetIndex = (index + 1) % buttons.length;
      } else if (e.key === "ArrowUp") {
        targetIndex = (index - 1 + buttons.length) % buttons.length;
      } else if (e.key === "Home") {
        targetIndex = 0;
      } else if (e.key === "End") {
        targetIndex = buttons.length - 1;
      }

      if (targetIndex !== null) {
        e.preventDefault();
        buttons[targetIndex]?.focus();
      }
    };

    button.addEventListener("click", onClick);
    button.addEventListener("keydown", onKeydown);

    clickHandlers.push({ button, handler: onClick });
    keyHandlers.push({ button, handler: onKeydown });
  });

  return () => {
    clickHandlers.forEach(({ button, handler }) => {
      button.removeEventListener("click", handler);
    });
    keyHandlers.forEach(({ button, handler }) => {
      button.removeEventListener("keydown", handler);
    });
  };
}
