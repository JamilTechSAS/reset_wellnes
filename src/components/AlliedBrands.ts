/**
 * Allied Brands Section Component (Phase 6A, real logos in Phase 6C)
 *
 * Only brands the client actually delivered are rendered, each with its own logo file.
 * A brand without a logo asset is never drawn as an empty slot: the section says how many
 * partners are still being confirmed instead.
 */

import type { AlliedBrandItem, EventLandingConfig } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

function renderBrandCard(brand: AlliedBrandItem): string {
  const hasLogo = brand.logoSrc !== undefined;

  const inner = hasLogo
    ? `<img
         class="brand-logo"
         src="${escapeHtml(brand.logoSrc ?? "")}"
         alt="${escapeHtml(brand.logoAlt ?? brand.name)}"
         ${brand.logoWidth === undefined ? "" : `width="${brand.logoWidth}"`}
         ${brand.logoHeight === undefined ? "" : `height="${brand.logoHeight}"`}
         loading="lazy"
         decoding="async"
       />`
    : `<span class="brand-logo-placeholder">${escapeHtml(brand.placeholderLabel ?? brand.name)}</span>`;

  const name = hasLogo
    ? `<span class="brand-name sr-only">${escapeHtml(brand.name)}</span>`
    : `<span class="brand-name">${escapeHtml(brand.name)}</span>`;

  const card = `
    <div class="brand-card${hasLogo ? " has-logo" : ""}">
      ${inner}
      ${name}
      <span class="brand-category">${escapeHtml(brand.category)}</span>
    </div>
  `;

  if (brand.websiteUrl === undefined) {
    return card;
  }

  return `
    <a
      class="brand-card-link"
      href="${escapeHtml(brand.websiteUrl)}"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="${escapeHtml(brand.name)} (abre su página oficial en una pestaña nueva)"
    >
      ${card}
    </a>
  `;
}

export function renderAlliedBrands(config: EventLandingConfig): string {
  const { alliedBrands } = config;

  return `
    <section class="section brands-section" id="marcas" aria-labelledby="brands-heading">
      <div class="container">
        <header class="section-header">
          <div class="eyebrow-badge accent">
            ${renderIcon("sparkle")}
            <span>${escapeHtml(alliedBrands.sectionEyebrow)}</span>
          </div>
          <h2 id="brands-heading">${escapeHtml(alliedBrands.sectionTitle)}</h2>
          <p class="section-description">${escapeHtml(alliedBrands.sectionDescription)}</p>
        </header>

        <div class="brands-grid">
          ${alliedBrands.items.map(renderBrandCard).join("")}
        </div>

        <p class="brands-disclaimer">
          ${escapeHtml(alliedBrands.disclaimer)}
        </p>
      </div>
    </section>
  `;
}
