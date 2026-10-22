/**
 * Contact Section Component (Phase 6A, real channels in Phase 6C)
 *
 * Renders the client's actual channels: WhatsApp (the number their own site uses), the shared
 * inbox and the Instagram handle. Every card is a real, working link with an explicit label —
 * no invented opening hours, no placeholder address.
 */

import type { EventLandingConfig, SocialLink } from "../types/content.ts";
import { escapeHtml, renderIcon, type IconName } from "../utils/dom.ts";

function channelIcon(platform: SocialLink["platform"]): IconName {
  switch (platform) {
    case "whatsapp":
      return "whatsapp";
    case "email":
      return "mail";
    case "instagram":
      return "instagram";
    case "website":
      return "arrow-right";
  }
}

function renderChannel(channel: SocialLink, index: number): string {
  const isExternal = channel.platform !== "email";

  return `
    <article class="contact-card" aria-labelledby="contact-channel-${index}">
      <div class="contact-icon">
        ${renderIcon(channelIcon(channel.platform))}
      </div>
      <h3 class="contact-title" id="contact-channel-${index}">${escapeHtml(channel.label)}</h3>
      <p class="contact-label">${escapeHtml(channel.description)}</p>
      <a
        href="${escapeHtml(channel.url)}"
        class="contact-link"
        ${isExternal ? 'target="_blank" rel="noopener noreferrer"' : ""}
        aria-label="${escapeHtml(`${channel.label}: ${channel.handle}`)}${isExternal ? " (abre en una pestaña nueva)" : ""}"
      >
        <span>${escapeHtml(channel.handle)}</span>
        ${renderIcon("arrow-right")}
      </a>
    </article>
  `;
}

export function renderContact(config: EventLandingConfig): string {
  const { contact } = config;

  return `
    <section class="section" id="contacto" aria-labelledby="contact-heading">
      <div class="container">
        <header class="section-header">
          <div class="eyebrow-badge">
            ${renderIcon("mail")}
            <span>${escapeHtml(contact.sectionEyebrow)}</span>
          </div>
          <h2 id="contact-heading">${escapeHtml(contact.sectionTitle)}</h2>
          <p class="section-description">${escapeHtml(contact.sectionDescription)}</p>
        </header>

        <div class="contact-grid">
          ${contact.channels.map(renderChannel).join("")}
        </div>

        <p class="brands-disclaimer contact-support-note">
          ${escapeHtml(contact.supportNote)}
        </p>
      </div>
    </section>
  `;
}
