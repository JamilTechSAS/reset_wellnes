/**
 * Frontend Content and Configuration Types (Phase 6A, extended in Phase 6C)
 *
 * Defines the contract for all landing page content, design tokens,
 * and section data structures. All customer-facing text is in Spanish (es-CO),
 * while types and internal identifiers are in English.
 *
 * Phase 6C note: fields are either supplied by the client material
 * (`Re set Sunset Vol. 1` handover) or explicitly marked as pending. A field that the client
 * has not confirmed is typed as `null`/optional and the UI renders a "por confirmar" state —
 * never an invented value.
 */

import type { IconName } from "../utils/dom.ts";

export type EventExperienceItem = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tag: string;
  readonly iconName: IconName;
};

export type EventIncludedItem = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly badge?: string;
  readonly iconName: IconName;
};

export type AlliedBrandItem = {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  /** Shown only while no real logo asset exists for the brand. */
  readonly placeholderLabel?: string;
  readonly websiteUrl?: string;
  readonly logoSrc?: string;
  readonly logoAlt?: string;
  readonly logoWidth?: number;
  readonly logoHeight?: number;
};

export type FaqItem = {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  /** True when the answer needs a client confirmation before it can be final. */
  readonly isPending?: boolean;
};

export type SocialLink = {
  readonly platform: "instagram" | "whatsapp" | "email" | "website";
  readonly label: string;
  readonly handle: string;
  readonly url: string;
  readonly description: string;
};

export type LegalTabId = "participantes" | "reembolsos" | "privacidad";

export type LegalLink = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /** When present, the link opens the legal dialog on that tab. */
  readonly tab?: LegalTabId;
};

/** A single ticket product shown next to the purchase CTA. */
export type TicketOption = {
  readonly id: string;
  readonly name: string;
  readonly priceLabel: string;
  readonly detail: string;
  readonly status: "current" | "upcoming";
};

export type HeroFact = {
  readonly id: string;
  readonly value: string;
  readonly label: string;
};

export type EventLandingConfig = {
  readonly meta: {
    readonly title: string;
    readonly description: string;
    /** Canonical URL. The client domain is still pending, so this is a documented placeholder. */
    readonly canonicalUrl: string;
    readonly locale: string;
    readonly siteName: string;
    readonly themeColor: string;
    /**
     * Social-sharing image. Genuinely absent from the client material: the file referenced here
     * is a branded card built from the real logo and palette, and `ogImagePendingRaster` records
     * that a photographic 1200×630 raster is still owed by the client.
     */
    readonly ogImageUrl: string;
    readonly ogImagePendingRaster: boolean;
  };
  readonly branding: {
    readonly brandName: string;
    readonly eventName: string;
    readonly edition: string;
    readonly organizer: string;
    readonly badgeText: string;
    readonly logoFullSrc: string;
    readonly logoShortSrc: string;
    readonly logoAlt: string;
    readonly logoFullWidth: number;
    readonly logoFullHeight: number;
  };
  readonly hero: {
    readonly eyebrow: string;
    readonly headline: string;
    readonly highlightPhrase: string;
    readonly tagline: string;
    readonly dateLabel: string;
    readonly timeLabel: string;
    readonly locationLabel: string;
    readonly primaryCtaText: string;
    readonly secondaryCtaText: string;
    readonly capacityNotice: string;
    /** Verified facts only: no capacity, no invented statistics. */
    readonly facts: readonly HeroFact[];
    /** The client delivered no photography; this text records what is still missing. */
    readonly imagePendingNote: string;
  };
  readonly experiences: {
    readonly sectionEyebrow: string;
    readonly sectionTitle: string;
    readonly sectionDescription: string;
    readonly items: readonly EventExperienceItem[];
  };
  readonly included: {
    readonly sectionEyebrow: string;
    readonly sectionTitle: string;
    readonly sectionDescription: string;
    readonly items: readonly EventIncludedItem[];
  };
  readonly alliedBrands: {
    readonly sectionEyebrow: string;
    readonly sectionTitle: string;
    readonly sectionDescription: string;
    readonly disclaimer: string;
    readonly items: readonly AlliedBrandItem[];
  };
  readonly details: {
    readonly sectionEyebrow: string;
    readonly sectionTitle: string;
    readonly dateFull: string;
    readonly schedule: string;
    readonly venueName: string;
    readonly city: string;
    readonly country: string;
    /** `null` until the client confirms the street address. */
    readonly venueAddress: string | null;
    /** `null` while no verified Google Maps link exists — a fabricated one is never used. */
    readonly mapUrl: string | null;
    readonly mapButtonText: string;
    readonly mapPendingLabel: string;
    readonly dressCode: string;
    readonly whatToBring: readonly string[];
    readonly accessNote: string;
  };

  readonly faq: {
    readonly sectionEyebrow: string;
    readonly sectionTitle: string;
    readonly sectionDescription: string;
    readonly items: readonly FaqItem[];
  };
  readonly contact: {
    readonly sectionEyebrow: string;
    readonly sectionTitle: string;
    readonly sectionDescription: string;
    readonly organizerName: string;
    readonly email: string;
    readonly supportNote: string;
    readonly channels: readonly SocialLink[];
  };
  readonly finalCta: {
    readonly eyebrow: string;
    readonly title: string;
    readonly description: string;
    readonly buttonText: string;
    readonly trustBadges: readonly string[];
    readonly ticketOptionsTitle: string;
    readonly ticketOptions: readonly TicketOption[];
    readonly ticketOptionsCaption: string;
  };
  readonly footer: {
    readonly copyrightText: string;
    readonly legalLinks: readonly LegalLink[];
  };
};

export type BuyTicketEventDetail = {
  readonly source: "hero" | "navbar" | "final-cta" | "sticky-bar";
  readonly timestamp: number;
};

export type OpenLegalEventDetail = {
  readonly tab: LegalTabId;
  readonly timestamp: number;
};
