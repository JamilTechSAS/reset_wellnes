/**
 * Event Details Section Component (Phase 6A, real content in Phase 6C)
 *
 * The client confirmed the date, the time, the venue and the city — but not the street address
 * and not a Google Maps link. Both stay unresolved in the UI ("por confirmar") rather than
 * being invented; the map button is simply not rendered while the link does not exist.
 */

import type { EventLandingConfig } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

export function renderEventDetails(config: EventLandingConfig): string {
  const { details } = config;

  const locationLine =
    details.venueAddress === null
      ? `<span class="detail-pending">${escapeHtml(details.mapPendingLabel)}</span>`
      : `${escapeHtml(details.venueAddress)} · ${escapeHtml(details.city)}`;

  const mapButton =
    details.mapUrl === null
      ? ""
      : `
        <div class="details-card-footer">
          <a
            href="${escapeHtml(details.mapUrl)}"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-secondary btn-sm"
            aria-label="${escapeHtml(details.mapButtonText)} (abre en una pestaña nueva)"
          >
            <span>${escapeHtml(details.mapButtonText)}</span>
            ${renderIcon("arrow-right")}
          </a>
        </div>
      `;

  const whatToBringHtml = details.whatToBring
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");

  return `
    <section class="section" id="detalles" aria-labelledby="details-heading">
      <div class="container">
        <header class="section-header">
          <div class="eyebrow-badge">
            ${renderIcon("calendar")}
            <span>${escapeHtml(details.sectionEyebrow)}</span>
          </div>
          <h2 id="details-heading">${escapeHtml(details.sectionTitle)}</h2>
        </header>

        <div class="details-grid">
          <article class="details-card" aria-labelledby="details-time-title">
            <div class="details-card-header">
              <div class="details-icon-pill">
                ${renderIcon("clock")}
              </div>
              <h3 class="details-card-title" id="details-time-title">Fecha y horario</h3>
            </div>
            <div class="details-card-body">
              <p class="details-main-info">${escapeHtml(details.dateFull)}</p>
              <p class="details-sub-info">${escapeHtml(details.schedule)}</p>
            </div>
          </article>

          <article class="details-card" aria-labelledby="details-venue-title">
            <div class="details-card-header">
              <div class="details-icon-pill">
                ${renderIcon("map-pin")}
              </div>
              <h3 class="details-card-title" id="details-venue-title">Recinto y dirección</h3>
            </div>
            <div class="details-card-body">
              <p class="details-main-info">${escapeHtml(details.venueName)}</p>
              <p class="details-sub-info">${locationLine}</p>
              <p class="details-sub-info">${escapeHtml(details.city)} · ${escapeHtml(details.country)}</p>
            </div>
            ${mapButton}
          </article>

          <article class="details-card" aria-labelledby="details-access-title">
            <div class="details-card-header">
              <div class="details-icon-pill">
                ${renderIcon("shield-check")}
              </div>
              <h3 class="details-card-title" id="details-access-title">Qué llevar</h3>
            </div>
            <div class="details-card-body">
              <ul class="details-list">
                ${whatToBringHtml}
              </ul>
              <p class="details-sub-info">
                Código de vestuario: <strong>${escapeHtml(details.dressCode)}</strong>
              </p>
              <p class="details-sub-info">${escapeHtml(details.accessNote)}</p>
            </div>
          </article>
        </div>
      </div>
    </section>
  `;
}
