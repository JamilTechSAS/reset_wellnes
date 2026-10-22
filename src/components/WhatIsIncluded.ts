/**
 * What's Included Section Component (Phase 6A)
 */

import type { EventLandingConfig } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

export function renderWhatIsIncluded(config: EventLandingConfig): string {
  const { included } = config;

  const itemsHtml = included.items
    .map(
      (item) => `
        <div class="included-card">
          <div class="included-icon-box">
            ${renderIcon(item.iconName)}
          </div>
          <div class="included-content">
            ${item.badge !== undefined ? `<span class="included-badge">${escapeHtml(item.badge)}</span>` : ""}
            <h3 class="included-title">${escapeHtml(item.title)}</h3>
            <p class="included-description">${escapeHtml(item.description)}</p>
          </div>
        </div>
      `,
    )
    .join("");

  return `
    <section class="section" id="incluye" aria-labelledby="inc-heading">
      <div class="container">
        <header class="section-header">
          <div class="eyebrow-badge">
            ${renderIcon("check")}
            <span>${escapeHtml(included.sectionEyebrow)}</span>
          </div>
          <h2 id="inc-heading">${escapeHtml(included.sectionTitle)}</h2>
          <p class="section-description">${escapeHtml(included.sectionDescription)}</p>
        </header>

        <div class="included-grid">
          ${itemsHtml}
        </div>
      </div>
    </section>
  `;
}
