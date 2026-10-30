/**
 * Hero Section Component (Phase 6A, real content in Phase 6C)
 *
 * The client delivered NO event photography, so this hero is deliberately photographic-free:
 * it is built from the real logo lockup, the brand palette and verified facts (date, duration,
 * venue). Nothing here implies a photo exists, and no stock image stands in for the event.
 * `hero.imagePendingNote` records what is still owed by the client.
 */

import type { EventLandingConfig } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

export function renderHero(config: EventLandingConfig): string {
  const { hero, branding } = config;

  const factsHtml = hero.facts
    .map(
      (fact) => `
        <li class="hero-fact">
          <span class="hero-fact-value">${escapeHtml(fact.value)}</span>
          <span class="hero-fact-label">${escapeHtml(fact.label)}</span>
        </li>
      `,
    )
    .join("");

  return `
    <section class="hero-section" id="inicio" aria-labelledby="hero-heading">
      <div class="container hero-content">
        <div class="hero-meta-bar" aria-label="Fecha, hora y lugar del evento">
          <span class="hero-meta-item">
            ${renderIcon("calendar")}
            <span>${escapeHtml(hero.dateLabel)}</span>
          </span>
          <span aria-hidden="true" class="hero-meta-sep">·</span>
          <span class="hero-meta-item">
            ${renderIcon("clock")}
            <span>${escapeHtml(hero.timeLabel)}</span>
          </span>
          <span aria-hidden="true" class="hero-meta-sep">·</span>
          <span class="hero-meta-item">
            ${renderIcon("map-pin")}
            <span>${escapeHtml(hero.locationLabel)}</span>
          </span>
        </div>

        <div class="hero-lockup">
          <img
            class="hero-logo"
            src="${escapeHtml(branding.logoFullSrc)}"
            alt="${escapeHtml(branding.logoAlt)}"
            width="${branding.logoFullWidth}"
            height="${branding.logoFullHeight}"
            fetchpriority="high"
          />
          <p class="hero-lockup-line">
            <span class="hero-lockup-event">${escapeHtml(branding.eventName)}</span>
            <span class="hero-lockup-edition">${escapeHtml(branding.edition)}</span>
          </p>
        </div>

        <div class="eyebrow-badge">
          ${renderIcon("sparkle")}
          <span>${escapeHtml(hero.eyebrow)}</span>
        </div>

        <h1 class="hero-title" id="hero-heading">
          ${escapeHtml(hero.headline)}
          <span class="text-gradient">${escapeHtml(hero.highlightPhrase)}</span>
        </h1>

        <p class="hero-tagline">${escapeHtml(hero.tagline)}</p>

        <ul class="hero-facts" aria-label="Datos confirmados del evento">
          ${factsHtml}
        </ul>

        <div class="hero-actions">
          <button type="button" class="btn btn-primary btn-lg" id="hero-buy-btn" data-buy-source="hero">
            <span>${escapeHtml(hero.primaryCtaText)}</span>
            ${renderIcon("arrow-right")}
          </button>
          <a href="#experiencia" class="btn btn-secondary btn-lg">
            <span>${escapeHtml(hero.secondaryCtaText)}</span>
          </a>
        </div>

        <p class="hero-media-pending">
          ${renderIcon("alert")}
          <span>${escapeHtml(hero.imagePendingNote)}</span>
        </p>
      </div>
    </section>
  `;
}
