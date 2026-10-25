/**
 * Final Purchase CTA Section Component (Phase 6A, real ticket products in Phase 6C)
 *
 * The three products are the client's own (Preventa / Comparte tu experiencia / General) with
 * the prices their material states, and the current sales phase is marked as such. These rows
 * are INFORMATION about the products: the payable amount is always the one the backend returns
 * when the buyer starts a purchase, so no price is ever hardcoded into the payment path.
 */

import type { EventLandingConfig, TicketOption } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

function renderTicketOption(option: TicketOption): string {
  const isCurrent = option.status === "current";

  return `
    <li class="ticket-option${isCurrent ? " is-current" : ""}">
      <div class="ticket-option-head">
        <span class="ticket-option-name">${escapeHtml(option.name)}</span>
        <span class="ticket-option-price">${escapeHtml(option.priceLabel)}</span>
      </div>
      <p class="ticket-option-detail">${escapeHtml(option.detail)}</p>
      ${
        isCurrent
          ? '<span class="ticket-option-flag">Fase actual</span>'
          : '<span class="ticket-option-flag is-upcoming">Próximamente</span>'
      }
    </li>
  `;
}

export function renderFinalCta(config: EventLandingConfig): string {
  const { finalCta } = config;

  const badgesHtml = finalCta.trustBadges
    .map(
      (badge) => `
        <span class="trust-badge-item">
          ${renderIcon("shield-check")}
          <span>${escapeHtml(badge)}</span>
        </span>
      `,
    )
    .join("");

  return `
    <section class="section final-cta-section" id="comprar" aria-labelledby="final-cta-heading">
      <div class="container">
        <div class="final-cta-card">
          <div class="eyebrow-badge">
            ${renderIcon("sparkle")}
            <span>${escapeHtml(finalCta.eyebrow)}</span>
          </div>

          <h2 class="final-cta-title" id="final-cta-heading">
            ${escapeHtml(finalCta.title)}
          </h2>

          <p class="final-cta-description">
            ${escapeHtml(finalCta.description)}
          </p>

          <div class="ticket-options" aria-labelledby="ticket-options-title">
            <h3 class="ticket-options-title" id="ticket-options-title">
              ${escapeHtml(finalCta.ticketOptionsTitle)}
            </h3>
            <ul class="ticket-options-list">
              ${finalCta.ticketOptions.map(renderTicketOption).join("")}
            </ul>
            <p class="ticket-options-caption">${escapeHtml(finalCta.ticketOptionsCaption)}</p>
          </div>

          <div class="final-cta-actions">
            <button type="button" class="btn btn-primary btn-lg" id="final-buy-btn" data-buy-source="final-cta">
              <span>${escapeHtml(finalCta.buttonText)}</span>
              ${renderIcon("arrow-right")}
            </button>
          </div>

          <div class="trust-badges-row">
            ${badgesHtml}
          </div>
        </div>
      </div>
    </section>
  `;
}
