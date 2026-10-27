/**
 * Content Configuration Tests (Phase 6A contract, Phase 6C real client content)
 *
 * These tests pin the material the client actually delivered for `Re set Sunset Vol. 1` and ÔÇö
 * just as important ÔÇö pin the ABSENCE of the placeholder/demo data of the earlier phases. A
 * change that reintroduces "Medell├¡n", a 120-person capacity, an invented Maps link or a fake
 * contact address fails here, before it can reach the published page.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENT_CONTENT_CONFIG } from "../../src/config/event-content.ts";

/** The whole configuration as text: the cheapest way to prove a string is nowhere in the UI. */
const CONFIG_TEXT = JSON.stringify(EVENT_CONTENT_CONFIG);

/** The client's palette as published in the handover (`css/reset.css`). */
const BRAND_COLOURS = ["#513229", "#f4f1e2", "#d7d4b1", "#fce6b7"] as const;

/** Demo values from earlier phases that must never come back into production copy. */
const REMOVED_PLACEHOLDERS = [
  "Medell├¡n",
  "El Poblado",
  "21 de noviembre",
  "Experiencia Exclusiva",
  "Tatiana en Concierto",
  "contacto@evento.ejemplo.co",
  "evento.ejemplo",
  "@evento_oficial_2026",
  "evento_oficial_2026",
] as const;

describe("EVENT_CONTENT_CONFIG", () => {
  it("defines complete metadata in Spanish (es-CO) for the real event", () => {
    expect(EVENT_CONTENT_CONFIG.meta.locale).toBe("es_CO");
    expect(EVENT_CONTENT_CONFIG.meta.siteName).toBe("Reset Wellness Club");
    expect(EVENT_CONTENT_CONFIG.meta.title).toContain("Re set Sunset");
    expect(EVENT_CONTENT_CONFIG.meta.title).toContain("Montería");
    expect(EVENT_CONTENT_CONFIG.meta.description).toContain("15 de noviembre de 2026");
    expect(EVENT_CONTENT_CONFIG.meta.description).toContain("GHL");
    expect(EVENT_CONTENT_CONFIG.meta.canonicalUrl).toMatch(/^https:\/\//);
  });

  it("uses the client's brown for the theme colour and their palette in the design tokens", () => {
    expect(EVENT_CONTENT_CONFIG.meta.themeColor).toBe("#513229");

    const tokens = readFileSync(
      new URL("../../src/styles/variables.css", import.meta.url),
      "utf8",
    ).toLowerCase();
    for (const colour of BRAND_COLOURS) {
      expect(tokens).toContain(colour);
    }
    // The manual's light-blue swatch has no official hex and no name: no blue token is invented.
    expect(tokens).not.toMatch(/--color-[a-z-]*blue[a-z-]*:/);
  });

  it("keeps an OG image documented as a pending raster instead of a fake photo", () => {
    expect(EVENT_CONTENT_CONFIG.meta.ogImageUrl).toMatch(/^\/.*\.(svg|png|jpg)$/);
    expect(EVENT_CONTENT_CONFIG.meta.ogImagePendingRaster).toBe(true);
  });

  it("brands the page with the real logo files and no invented capacity", () => {
    const { branding } = EVENT_CONTENT_CONFIG;
    expect(branding.brandName).toBe("Reset Wellness Club");
    expect(branding.eventName).toBe("Re set Sunset");
    expect(branding.edition).toContain("Vol. 1");
    expect(branding.logoFullSrc).toBe("/assets/reset/logo-reset.png");
    expect(branding.logoShortSrc).toBe("/assets/reset/logo-reset-corto.png");
    expect(branding.logoAlt).toBe("Reset Wellness Club");
    expect(branding.logoFullWidth).toBeGreaterThan(0);
    expect(branding.logoFullHeight).toBeGreaterThan(0);

    // "100 boletas en total" is the client's own wording; they never published a number.
    expect(branding.badgeText).toBe("100 boletas en total");
    expect(branding.badgeText).toContain("100 boletas en total");
  });

  it("defines the hero with the confirmed date, schedule and venue", () => {
    const { hero } = EVENT_CONTENT_CONFIG;
    expect(hero.primaryCtaText).toBe("COMPRAR ENTRADA");
    expect(hero.headline.length).toBeGreaterThan(10);
    expect(hero.dateLabel).toContain("15");
    expect(hero.dateLabel).toContain("Nov");
    expect(hero.timeLabel).toContain("1:00 p.m.");
    expect(hero.timeLabel).toContain("7:00 p.m.");
    expect(hero.locationLabel).toContain("GHL");
    expect(hero.locationLabel).toContain("Montería");
    expect(hero.imagePendingNote).toBeTruthy();
  });

  it("publishes only verified hero facts ÔÇö never a capacity figure", () => {
    expect(EVENT_CONTENT_CONFIG.hero.facts.length).toBeGreaterThanOrEqual(3);
    for (const fact of EVENT_CONTENT_CONFIG.hero.facts) {
      expect(fact.id).toBeTruthy();
      expect(fact.value).toBeTruthy();
      expect(fact.label).toBeTruthy();
      expect(`${fact.value} ${fact.label}`).not.toMatch(/\d{2,4}\s*(cupos|asistentes|personas)/i);
    }
  });

  it("lists exactly the experiences the client described", () => {
    const titles = EVENT_CONTENT_CONFIG.experiences.items.map((item) => item.title);
    expect(titles).toEqual([
      "Pilates",
      "Yoga",
      "Spinning",
      "Inmersión en hielo",
      "Quiropráctica",
      "Chocolaterapia",
      "Medicina Estética",
    ]);
    for (const item of EVENT_CONTENT_CONFIG.experiences.items) {
      expect(item.id).toBeTruthy();
      expect(item.description.length).toBeGreaterThan(20);
      expect(item.tag).toBeTruthy();
      expect(item.iconName).toBeTruthy();
    }
  });

  it("quotes the client's inclusion sentence and never invents extra benefits", () => {
    expect(EVENT_CONTENT_CONFIG.included.sectionDescription).toBe(
      "Todas las experiencias del día, activaciones de marcas, kit de bienvenida y espacios para compartir y conectar.",
    );
    expect(EVENT_CONTENT_CONFIG.included.items.length).toBeGreaterThanOrEqual(4);
    for (const item of EVENT_CONTENT_CONFIG.included.items) {
      expect(item.title).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(item.iconName).toBeTruthy();
    }
    expect(CONFIG_TEXT).not.toMatch(
      /parqueadero|estacionamiento|almuerzo incluido|open bar|bebidas incluidas|\bdj\b|masaje/i,
    );
  });

  it("shows the one real ally with its own logo and no empty partner slots", () => {
    const { alliedBrands } = EVENT_CONTENT_CONFIG;
    expect(alliedBrands.disclaimer).toBeTruthy();
    expect(alliedBrands.items).toHaveLength(1);

    const [ally] = alliedBrands.items;
    expect(ally?.name).toBe("GHL Hoteles");
    expect(ally?.logoSrc).toBe("/assets/reset/logo-ghl.png");
    expect(ally?.websiteUrl).toBe("https://www.ghlhoteles.com/es/");
    expect(ally?.logoWidth).toBeGreaterThan(0);
    expect(ally?.logoHeight).toBeGreaterThan(0);
    // A brand with a real logo is never rendered through the placeholder branch.
    expect(ally?.placeholderLabel).toBeUndefined();
  });

  it("states the real date and venue, and leaves the address and the map unresolved", () => {
    const { details } = EVENT_CONTENT_CONFIG;
    expect(details.dateFull).toBe("Domingo, 15 de noviembre de 2026");
    expect(details.schedule).toContain("1:00 p.m.");
    expect(details.schedule).toContain("7:00 p.m.");
    expect(details.venueName).toContain("GHL");
    expect(details.city).toBe("Montería, Córdoba");
    expect(details.country).toBe("Colombia");

    // The client supplied neither a street address nor a verified Maps link.
    expect(details.venueAddress).toBeNull();
    expect(details.mapUrl).toBeNull();
    expect(details.mapPendingLabel).toContain("por confirmar");
    expect(CONFIG_TEXT).not.toContain("maps.google");
    expect(CONFIG_TEXT).not.toContain("goo.gl/maps");
  });

  it("keeps the dress code colour unresolved and lists only the items to bring", () => {
    const { details } = EVENT_CONTENT_CONFIG;
    expect(details.dressCode).toContain("Sport +");
    expect(details.dressCode).toContain("por confirmar");
    expect(details.whatToBring).toEqual([
      "Vestido de baño",
      "Toalla",
      "Bloqueador",
      "Tu documento de identidad",
    ]);
    expect(details.accessNote).toBeTruthy();
  });

  it("answers the buyer's real questions and flags the ones still pending", () => {
    const { faq } = EVENT_CONTENT_CONFIG;
    expect(faq.items.length).toBeGreaterThanOrEqual(10);
    for (const item of faq.items) {
      expect(item.id).toBeTruthy();
      expect(item.question.endsWith("?")).toBe(true);
      expect(item.answer.length).toBeGreaterThan(10);
    }
    const includes = faq.items.find((item) => item.id === "faq-incluye");
    expect(includes?.answer).toBe(
      "Todas las experiencias del día, activaciones de marcas, kit de bienvenida y espacios para compartir y conectar.",
    );
    // Only the payment methods are still waiting on the organiser's confirmation.
    const pending = faq.items.filter((item) => item.isPending === true);
    expect(pending.map((item) => item.id)).toEqual(["faq-pagos"]);

    // Entry is no longer a digital ticket: the purchase is registered against the holder and
    // the day of the event only requires an identity document.
    const delivery = faq.items.find((item) => item.id === "faq-entrega");
    expect(delivery?.isPending).toBeUndefined();
    expect(delivery?.answer).toContain("documento de identidad");
    expect(delivery?.answer).not.toMatch(/env[i├¡]a al correo/i);
    expect(delivery?.answer).not.toMatch(/se genera tu entrada/i);
  });

  it("gives the buyer the client's real contact channels", () => {
    const { contact } = EVENT_CONTENT_CONFIG;
    expect(contact.organizerName).toBe("Reset Wellness Club");
    expect(contact.email).toBe("reset.wellness@gmail.com");
    expect(contact.supportNote).toBeTruthy();

    const whatsapp = contact.channels.find((channel) => channel.platform === "whatsapp");
    expect(whatsapp?.url).toBe("https://wa.me/573133340844");
    expect(whatsapp?.handle).toBe("313 334 0844");

    const email = contact.channels.find((channel) => channel.platform === "email");
    expect(email?.url).toBe("mailto:reset.wellness@gmail.com");

    const instagram = contact.channels.find((channel) => channel.platform === "instagram");
    expect(instagram?.handle).toBe("@reset.wll");
    expect(instagram?.url).toBe("https://instagram.com/reset.wll");
  });

  it("shows the client's three ticket products with the preventa marked as the current phase", () => {
    const { finalCta } = EVENT_CONTENT_CONFIG;
    expect(finalCta.buttonText).toBe("COMPRAR MI ENTRADA");
    expect(finalCta.trustBadges.length).toBeGreaterThanOrEqual(2);
    expect(finalCta.trustBadges.join(" ")).not.toMatch(/QR|entrada digital/i);
    expect(finalCta.ticketOptionsTitle).toBeTruthy();
    expect(finalCta.ticketOptionsCaption).toContain("COP");

    expect(finalCta.ticketOptions.map((option) => [option.name, option.priceLabel])).toEqual([
      ["Preventa", "$159.900"],
      ["Comparte tu experiencia", "$539.700"],
      ["General", "$199.900"],
    ]);

    const current = finalCta.ticketOptions.filter((option) => option.status === "current");
    expect(current).toHaveLength(1);
    expect(current[0]?.name).toBe("Preventa");
    // The 3-ticket bundle is $179.900 per person; that arithmetic is the client's, not ours.
    expect(finalCta.ticketOptions[1]?.detail).toContain("$179.900");
    // The other two products keep their published prices.
    expect(finalCta.ticketOptions[0]?.priceLabel).toBe("$159.900");
    expect(finalCta.ticketOptions[2]?.priceLabel).toBe("$199.900");
  });

  it("never carries a discount code or a percentage claim", () => {
    expect(CONFIG_TEXT).not.toContain("discountCodes");
    expect(CONFIG_TEXT).not.toMatch(/descuento\s+[A-Z]{2,}[0-9]{2,}/i);
    expect(CONFIG_TEXT).not.toMatch(/[0-9]+\s*%\s*(de\s*)?(descuento|dcto)/i);
  });

  it("points the footer at the real documents and keeps the lookup entry point", () => {
    expect(EVENT_CONTENT_CONFIG.footer.copyrightText).toContain("2026");
    expect(EVENT_CONTENT_CONFIG.footer.copyrightText).toContain("Reset Wellness Club");

    const tabs = EVENT_CONTENT_CONFIG.footer.legalLinks
      .map((link) => link.tab)
      .filter((tab) => tab !== undefined);
    expect(tabs).toEqual(["participantes", "reembolsos", "privacidad"]);
    expect(EVENT_CONTENT_CONFIG.footer.legalLinks.some((link) => link.href === "#consultar")).toBe(
      true,
    );
  });

  it("contains none of the removed placeholder content", () => {
    for (const placeholder of REMOVED_PLACEHOLDERS) {
      expect(CONFIG_TEXT).not.toContain(placeholder);
    }
    expect(CONFIG_TEXT).not.toMatch(/\b120\b/);
    expect(CONFIG_TEXT).not.toMatch(/#0d1117/i);
  });

  it("keeps the canonical URL on a reserved, non-routable domain while the client's domain is pending", () => {
    // `.example` can never resolve to a third-party site, so a forgotten placeholder is
    // obvious in review instead of silently sending traffic somewhere unrelated.
    expect(EVENT_CONTENT_CONFIG.meta.canonicalUrl).toMatch(/^https:\/\/[a-z0-9-]+\.example$/);
    expect(CONFIG_TEXT).not.toContain("resetwellnessclub.com");
  });
});
