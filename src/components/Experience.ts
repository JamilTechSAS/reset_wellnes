/**
 * Experience Section Component (Phase 6A)
 */

import type { EventLandingConfig } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

export function renderExperience(config: EventLandingConfig): string {
  const { experiences } = config;

  const cardsHtml = experiences.items
    .map(
      (item) => `
        <article class="experience-card" aria-labelledby="exp-title-${item.id}">
          <div class="experience-icon-wrapper">
            ${renderIcon(item.iconName)}
          </div>
          <span class="experience-tag">${escapeHtml(item.tag)}</span>
          <h3 class="experience-title" id="exp-title-${item.id}">${escapeHtml(item.title)}</h3>
          <p class="experience-description">${escapeHtml(item.description)}</p>
        </article>
      `,
    )
    .join("");

  return `
    <section class="section" id="experiencia" aria-labelledby="exp-heading">
      <div class="container">
        <header class="section-header">
          <div class="eyebrow-badge accent">
            ${renderIcon("sparkle")}
            <span>${escapeHtml(experiences.sectionEyebrow)}</span>
          </div>
          <h2 id="exp-heading">${escapeHtml(experiences.sectionTitle)}</h2>
          <p class="section-description">${escapeHtml(experiences.sectionDescription)}</p>
        </header>

        <div class="experiences-grid">
          ${cardsHtml}
        </div>
      </div>
    </section>
  `;
}
