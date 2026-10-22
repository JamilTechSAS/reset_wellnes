/**
 * Navbar Component (Phase 6A, real branding in Phase 6C)
 *
 * The logo is the client's actual PNG lockup, never recreated with text. The full lockup
 * (mark + "wellness club" descriptor) is used from tablet up; the short lockup is used on
 * phones, where the descriptor would be illegible. Both files are the client's originals.
 */

import type { EventLandingConfig } from "../types/content.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";

export function renderNavbar(config: EventLandingConfig): string {
  const { branding } = config;

  return `
    <header class="site-header" role="banner">
      <div class="container nav-container">
        <a href="#inicio" class="brand-logo">
          <img
            class="brand-logo-full"
            src="${escapeHtml(branding.logoFullSrc)}"
            alt=""
            width="${branding.logoFullWidth}"
            height="${branding.logoFullHeight}"
            decoding="async"
          />
          <img
            class="brand-logo-short"
            src="${escapeHtml(branding.logoShortSrc)}"
            alt=""
            width="828"
            height="609"
            decoding="async"
          />
          <span class="sr-only">${escapeHtml(branding.brandName)} · ${escapeHtml(branding.eventName)} ${escapeHtml(branding.edition)} — Inicio</span>
        </a>

        <nav class="nav-links" aria-label="Navegación principal">
          <a href="#experiencia" class="nav-link">Experiencia</a>
          <a href="#incluye" class="nav-link">Incluye</a>
          <a href="#marcas" class="nav-link">Marcas</a>
          <a href="#detalles" class="nav-link">Ubicación</a>
          <a href="#preguntas" class="nav-link">Preguntas</a>
          <a href="#contacto" class="nav-link">Contacto</a>
        </nav>

        <div class="nav-actions">
          <button type="button" class="btn btn-primary btn-sm" id="nav-buy-btn" data-buy-source="navbar">
            <span>Comprar entrada</span>
            ${renderIcon("arrow-right")}
          </button>
        </div>
      </div>
    </header>
  `;
}
