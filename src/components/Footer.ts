/**
 * Footer Component (Phase 6A, real links in Phase 6C)
 *
 * Legal links carry the client's documents: the three that have a `tab` open the legal dialog
 * (participants, refunds, privacy) instead of pointing at a non-existent page.
 */

import type { EventLandingConfig } from "../types/content.ts";
import { escapeHtml } from "../utils/dom.ts";

export function renderFooter(config: EventLandingConfig): string {
  const { footer, branding } = config;

  const linksHtml = footer.legalLinks
    .map((link) => {
      const dataAttribute = link.tab === undefined ? "" : ` data-legal-tab="${link.tab}"`;
      return `
        <a href="${escapeHtml(link.href)}" class="footer-link"${dataAttribute}>
          ${escapeHtml(link.label)}
        </a>
      `;
    })
    .join("");

  return `
    <footer class="site-footer" role="contentinfo">
      <div class="container footer-inner">
        <div class="footer-brand">
          <img
            class="footer-logo"
            src="${escapeHtml(branding.logoFullSrc)}"
            alt="${escapeHtml(branding.logoAlt)}"
            width="${branding.logoFullWidth}"
            height="${branding.logoFullHeight}"
            loading="lazy"
            decoding="async"
          />
          <span class="footer-brand-line">
            <strong>${escapeHtml(branding.brandName)}</strong> · ${escapeHtml(branding.eventName)} ${escapeHtml(branding.edition)}
          </span>
        </div>

        <nav class="footer-links" aria-label="Enlaces legales y de soporte">
          ${linksHtml}
        </nav>

        <p class="footer-copyright">
          ${escapeHtml(footer.copyrightText)}
        </p>
      </div>
    </footer>
  `;
}
