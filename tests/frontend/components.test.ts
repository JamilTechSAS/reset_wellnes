// @vitest-environment happy-dom
/**
 * Component Rendering and Semantic Structure Tests (Phase 6A structure, Phase 6C real content)
 *
 * Each test renders the component with the REAL `EVENT_CONTENT_CONFIG` and reads the DOM the
 * buyer gets. Beyond structure, they pin the Phase 6C rules: the client's own logo files are
 * used, unresolved data renders as "por confirmar" instead of an invented value, and no
 * placeholder content survives in the composed page.
 */

import { describe, expect, it } from "vitest";
import { EVENT_CONTENT_CONFIG } from "../../src/config/event-content.ts";
import { LEGAL_DOCUMENTS } from "../../src/config/legal-content.ts";
import { renderNavbar } from "../../src/components/Navbar.ts";
import { renderHero } from "../../src/components/Hero.ts";
import { renderExperience } from "../../src/components/Experience.ts";
import { renderWhatIsIncluded } from "../../src/components/WhatIsIncluded.ts";
import { renderAlliedBrands } from "../../src/components/AlliedBrands.ts";
import { renderEventDetails } from "../../src/components/EventDetails.ts";
import { renderFaq } from "../../src/components/Faq.ts";
import { renderContact } from "../../src/components/Contact.ts";
import { renderFinalCta } from "../../src/components/FinalCta.ts";
import { renderStickyBar } from "../../src/components/StickyBar.ts";
import { renderFooter } from "../../src/components/Footer.ts";
import { renderApp } from "../../src/main.ts";

/** Renders a component string into a detached container. */
function render(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("Component Rendering", () => {
  it("renders Navbar with the client's logo files, navigation and CTA button", () => {
    const container = render(renderNavbar(EVENT_CONTENT_CONFIG));

    const header = container.querySelector("header.site-header");
    expect(header).not.toBeNull();

    const nav = container.querySelector("nav[aria-label='Navegación principal']");
    expect(nav).not.toBeNull();

    // The real PNG lockups, never a recreated text logo.
    const full = container.querySelector<HTMLImageElement>("img.brand-logo-full");
    const short = container.querySelector<HTMLImageElement>("img.brand-logo-short");
    expect(full?.getAttribute("src")).toBe("/assets/reset/logo-reset.png");
    expect(short?.getAttribute("src")).toBe("/assets/reset/logo-reset-corto.png");
    // The decorative copies are hidden from assistive tech; the link carries the real name.
    expect(full?.getAttribute("alt")).toBe("");
    expect(container.querySelector(".brand-logo .sr-only")?.textContent).toContain(
      "Reset Wellness Club",
    );

    const buyBtn = container.querySelector("#nav-buy-btn");
    expect(buyBtn).not.toBeNull();
    expect(buyBtn?.getAttribute("data-buy-source")).toBe("navbar");
  });

  it("renders Hero with the real date, venue and CTA, and no invented capacity", () => {
    const container = render(renderHero(EVENT_CONTENT_CONFIG));

    const section = container.querySelector("section.hero-section");
    expect(section).not.toBeNull();

    const h1 = container.querySelector("h1#hero-heading");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toContain(EVENT_CONTENT_CONFIG.hero.headline);

    const heroBuyBtn = container.querySelector("#hero-buy-btn");
    expect(heroBuyBtn).not.toBeNull();
    expect(heroBuyBtn?.getAttribute("data-buy-source")).toBe("hero");
    expect(heroBuyBtn?.textContent).toContain("COMPRAR ENTRADA");

    // Verified facts only: the date, the schedule and the venue.
    const facts = container.querySelectorAll(".hero-fact-value");
    const factValues = Array.from(facts, (fact) => fact.textContent);
    expect(factValues.join(" ")).toContain("15 Nov 2026");
    expect(factValues.join(" ")).toContain("Hotel GHL");
    expect(factValues.join(" ")).not.toMatch(/\b\d{2,4}\s*(cupos|asistentes|personas)\b/i);

    // The client published no capacity figure, so the pill says exactly that.
    const capacityPill = container.querySelector(".hero-capacity-pill");
    expect(capacityPill?.textContent).toContain("Cupos limitados");
    expect(capacityPill?.textContent).not.toMatch(/\d{2,4}/);

    // No photography was delivered: the page says so instead of showing a stock image.
    expect(container.querySelector(".hero-media-pending")?.textContent).toContain(
      "no incluye imágenes del evento",
    );
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("/assets/reset/logo-reset.png");
  });

  it("renders Experience section with the client's seven experiences", () => {
    const container = render(renderExperience(EVENT_CONTENT_CONFIG));

    const section = container.querySelector("section#experiencia");
    expect(section).not.toBeNull();

    const h2 = container.querySelector("h2#exp-heading");
    expect(h2?.textContent).toBe(EVENT_CONTENT_CONFIG.experiences.sectionTitle);

    const cards = container.querySelectorAll(".experience-card");
    expect(cards.length).toBe(EVENT_CONTENT_CONFIG.experiences.items.length);

    const text = section?.textContent ?? "";
    for (const experience of [
      "Pilates",
      "Yoga",
      "Spinning",
      "Inmersión en hielo",
      "Quiropráctica",
      "Sueroterapia",
      "Bronceo",
    ]) {
      expect(text).toContain(experience);
    }
    // Cards are drawn, never photographed: no <img> pretends a photo of the activity exists.
    expect(section?.querySelectorAll("img").length).toBe(0);
  });

  it("renders WhatIsIncluded with the client's four inclusions", () => {
    const container = render(renderWhatIsIncluded(EVENT_CONTENT_CONFIG));

    const section = container.querySelector("section#incluye");
    expect(section).not.toBeNull();

    const cards = container.querySelectorAll(".included-card");
    expect(cards.length).toBe(EVENT_CONTENT_CONFIG.included.items.length);
    expect(section?.textContent).toContain("Todas las experiencias del día");
    expect(section?.textContent).toContain("Kit de bienvenida");
  });

  it("renders AlliedBrands with the real GHL logo and no empty partner slot", () => {
    const container = render(renderAlliedBrands(EVENT_CONTENT_CONFIG));

    const section = container.querySelector("section#marcas");
    expect(section).not.toBeNull();

    const brandCards = container.querySelectorAll(".brand-card");
    expect(brandCards.length).toBe(EVENT_CONTENT_CONFIG.alliedBrands.items.length);
    // One real ally, one real logo — and no dashed placeholder card next to it.
    expect(brandCards).toHaveLength(1);
    expect(container.querySelectorAll(".brand-logo-placeholder")).toHaveLength(0);

    const logo = container.querySelector<HTMLImageElement>(".brand-card img.brand-logo");
    expect(logo?.getAttribute("src")).toBe("/assets/reset/logo-ghl.png");
    expect(logo?.getAttribute("alt")).toBe("GHL Hoteles");

    const link = container.querySelector<HTMLAnchorElement>("a.brand-card-link");
    expect(link?.getAttribute("href")).toBe("https://www.ghlhoteles.com/es/");
    expect(link?.getAttribute("rel")).toContain("noopener");

    expect(container.querySelector(".brands-disclaimer")).not.toBeNull();
  });

  it("renders EventDetails with three cards and the address marked as pending", () => {
    const container = render(renderEventDetails(EVENT_CONTENT_CONFIG));

    const section = container.querySelector("section#detalles");
    expect(section).not.toBeNull();

    const cards = container.querySelectorAll(".details-card");
    expect(cards.length).toBe(3);

    const text = section?.textContent ?? "";
    expect(text).toContain("Domingo, 15 de noviembre de 2026");
    expect(text).toContain("Terraza del hotel GHL");
    expect(text).toContain("Vestido de baño");
    expect(text).toContain("Sport + [color por confirmar]");

    // No verified Maps link exists, so no map button is rendered at all.
    expect(container.querySelector("a[href*='maps.google']")).toBeNull();
    expect(container.querySelector(".detail-pending")?.textContent).toContain("por confirmar");
  });

  it("renders Faq with accordion buttons and flags the unanswered questions", () => {
    const container = render(renderFaq(EVENT_CONTENT_CONFIG));

    const section = container.querySelector("section#preguntas");
    expect(section).not.toBeNull();

    const buttons = container.querySelectorAll(".faq-button");
    expect(buttons.length).toBe(EVENT_CONTENT_CONFIG.faq.items.length);

    buttons.forEach((btn) => {
      expect(btn.getAttribute("aria-expanded")).toBe("false");
      const controlsId = btn.getAttribute("aria-controls");
      expect(controlsId).toBeTruthy();

      const panel = container.querySelector(`#${controlsId ?? ""}`);
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("role")).toBe("region");
      expect(panel?.getAttribute("aria-hidden")).toBe("true");
    });

    const pendingIds = EVENT_CONTENT_CONFIG.faq.items.filter((item) => item.isPending === true);
    expect(container.querySelectorAll(".faq-pending")).toHaveLength(pendingIds.length);
    expect(container.querySelector("#faq-btn-faq-pagos")?.textContent).toContain(
      "Confirmación pendiente",
    );
  });

  it("renders Contact with the client's WhatsApp, email and Instagram links", () => {
    const container = render(renderContact(EVENT_CONTENT_CONFIG));

    const section = container.querySelector("section#contacto");
    expect(section).not.toBeNull();

    const emailLink = container.querySelector<HTMLAnchorElement>(
      `a[href='mailto:${EVENT_CONTENT_CONFIG.contact.email}']`,
    );
    expect(emailLink).not.toBeNull();
    expect(emailLink?.textContent).toContain("reset.wellness@gmail.com");

    const whatsappLink = container.querySelector<HTMLAnchorElement>(
      "a[href='https://wa.me/573133340844']",
    );
    expect(whatsappLink).not.toBeNull();
    expect(whatsappLink?.textContent).toContain("313 334 0844");
    expect(whatsappLink?.getAttribute("target")).toBe("_blank");
    expect(whatsappLink?.getAttribute("aria-label")).toContain("313 334 0844");

    const instagramLink = container.querySelector<HTMLAnchorElement>(
      "a[href='https://instagram.com/reset.wll']",
    );
    expect(instagramLink).not.toBeNull();
    expect(instagramLink?.textContent).toContain("@reset.wll");
    expect(instagramLink?.getAttribute("rel")).toContain("noopener");
  });

  it("renders FinalCta with the real ticket products and a prominent button", () => {
    const container = render(renderFinalCta(EVENT_CONTENT_CONFIG));

    const section = container.querySelector("section#comprar");
    expect(section).not.toBeNull();

    const finalBuyBtn = container.querySelector("#final-buy-btn");
    expect(finalBuyBtn).not.toBeNull();
    expect(finalBuyBtn?.getAttribute("data-buy-source")).toBe("final-cta");
    expect(finalBuyBtn?.textContent).toContain("COMPRAR MI ENTRADA");

    const options = container.querySelectorAll(".ticket-option");
    expect(options).toHaveLength(EVENT_CONTENT_CONFIG.finalCta.ticketOptions.length);
    const text = section?.textContent ?? "";
    expect(text).toContain("Preventa");
    expect(text).toContain("$160.000");
    expect(text).toContain("Comparte esta experiencia");
    expect(text).toContain("$340.000");
    expect(text).toContain("General");
    expect(text).toContain("$200.000");

    const current = container.querySelectorAll(".ticket-option.is-current");
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Preventa");
    expect(current[0]?.textContent).toContain("Fase actual");

    const badges = container.querySelectorAll(".trust-badge-item");
    expect(badges.length).toBe(EVENT_CONTENT_CONFIG.finalCta.trustBadges.length);
  });

  it("renders StickyBar with the event name and a purchase button", () => {
    const container = render(renderStickyBar(EVENT_CONTENT_CONFIG));

    const stickyBar = container.querySelector("#sticky-bar");
    expect(stickyBar).not.toBeNull();
    expect(stickyBar?.textContent).toContain("Re set Sunset");
    expect(stickyBar?.textContent).not.toMatch(/\d+\s*cupos/i);

    const stickyBuyBtn = container.querySelector("#sticky-buy-btn");
    expect(stickyBuyBtn).not.toBeNull();
    expect(stickyBuyBtn?.getAttribute("data-buy-source")).toBe("sticky-bar");
  });

  it("renders Footer with the real logo, the legal documents and copyright", () => {
    const container = render(renderFooter(EVENT_CONTENT_CONFIG));

    const footer = container.querySelector("footer.site-footer");
    expect(footer).not.toBeNull();

    const links = container.querySelectorAll(".footer-link");
    expect(links.length).toBe(EVENT_CONTENT_CONFIG.footer.legalLinks.length);

    expect(container.querySelector<HTMLImageElement>(".footer-logo")?.getAttribute("src")).toBe(
      "/assets/reset/logo-reset.png",
    );
    expect(footer?.textContent).toContain(EVENT_CONTENT_CONFIG.footer.copyrightText);
  });

  it("wires the three legal documents into the footer and a link to look up a purchase", () => {
    const container = render(renderFooter(EVENT_CONTENT_CONFIG));

    const tabLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("[data-legal-tab]"),
      (link) => link.getAttribute("data-legal-tab"),
    );
    expect(tabLinks).toEqual(LEGAL_DOCUMENTS.map((document) => document.id));
    expect(container.querySelector('a[href="#consultar"]')).not.toBeNull();
  });

  it("composes the whole page without a single placeholder from the demo phases", () => {
    const container = render(renderApp());
    const text = container.textContent;

    for (const placeholder of [
      "Medellín",
      "El Poblado",
      "21 de noviembre",
      "Experiencia Exclusiva",
      "Tatiana en Concierto",
      "evento.ejemplo",
      "evento_oficial_2026",
    ]) {
      expect(text).not.toContain(placeholder);
    }
    expect(text).not.toMatch(/\b120\b/);

    // One page, one h1: the hero's.
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1#hero-heading")).not.toBeNull();

    // The composed page carries the real event in its own words.
    expect(text).toContain("Re set Sunset");
    expect(text).toContain("15 de noviembre de 2026");
    expect(text).toContain("Terraza del hotel GHL");
    expect(text).toContain("reset.wellness@gmail.com");
  });
});

describe("Icon rendering", () => {
  it("draws an inline SVG for every icon a section asks for", () => {
    const container = render(renderApp());
    const used = container.querySelectorAll(".experience-icon-wrapper svg, .included-icon-box svg");
    expect(used.length).toBe(
      EVENT_CONTENT_CONFIG.experiences.items.length + EVENT_CONTENT_CONFIG.included.items.length,
    );
    // No card falls back to raw text or an empty span where an icon belongs.
    container.querySelectorAll(".experience-icon-wrapper, .included-icon-box").forEach((icon) => {
      expect(icon.querySelector("svg")).not.toBeNull();
    });
  });

  it("does not embed remote images or scripts in the landing page", () => {
    const container = render(renderApp());
    const remote = Array.from(container.querySelectorAll("[src], [href]")).filter((el) => {
      const value = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
      return /^https?:\/\//.test(value) && !value.startsWith("https://wa.me");
    });
    // The only external links the page may carry are the documented ones (ally site, socials).
    for (const el of remote) {
      const value = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
      expect(value).toMatch(/^https:\/\/(www\.ghlhoteles\.com|instagram\.com)\//);
    }
    expect(container.querySelectorAll("script")).toHaveLength(0);
  });

  it("never embeds a third-party font, stock photo or placeholder image in the markup", () => {
    // `index.html` is the only place allowed to load a font (the substitute faces) — the markup
    // the components generate never reaches out to a font CDN, a stock-photo host or a
    // placeholder-image service.
    const html = renderApp();
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("unsplash");
    expect(html).not.toContain("placehold");
    expect(html).not.toContain("cloudinary");
  });

  it("keeps the CTA wiring intact for every purchase source", () => {
    const container = render(renderApp());
    const ctas = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-buy-source]"));
    expect(ctas.map((btn) => btn.getAttribute("data-buy-source"))).toEqual([
      "navbar",
      "hero",
      "final-cta",
      "sticky-bar",
    ]);
    // Each one is a real button with an accessible name, not a styled div.
    for (const button of ctas) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.textContent.trim().length).toBeGreaterThan(0);
      expect(button.id).not.toBe("");
    }
  });
});
