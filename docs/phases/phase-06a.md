# Phase 6A — Frontend Foundation and Spanish Event Landing Page

**Status: COMPLETE.** (2026-10-04)
**Backend Status: FROZEN.** (No backend changes made; all 439 existing backend tests remain green).

This phase establishes the frontend foundation, the design system, and the public Spanish landing page (`es-CO`) for the one-time event (~120 attendees) in Medellín, Colombia.

---

## 1. Frontend Technology Stack & Rationale

| Layer                  | Technology                            | Decision Rationale                                                                                                                                                |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bundler / Dev Tool** | Vite 8.3.2                            | Minimal footprint, sub-second HMR and production builds (181ms), zero configuration bloat, native Vercel deployment compatibility.                                |
| **Language**           | TypeScript 6.0+                       | Strict type checking (`strict: true`, `noUncheckedIndexedAccess: true`), type-safe content contracts.                                                             |
| **Markup & Semantics** | Semantic HTML5                        | Accessible landmarks (`<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<footer>`, `<aside>`), heading hierarchy (`h1` → `h2` → `h3`), ARIA 1.2 patterns. |
| **Styling**            | Vanilla CSS with Design System Tokens | Maximum control, zero runtime CSS overhead, easily rebrandable via CSS custom properties (`--color-*`, `--space-*`, `--radius-*`), no Tailwind dependency.        |
| **Icons**              | Inlined Accessible SVGs               | Zero external icon font/CDN requests, zero layout shift (CLS: 0), scalable, customizable with CSS `currentColor`.                                                 |
| **Testing**            | Vitest 5.0.3 + Happy-DOM              | Co-located unit and DOM integration tests (`tests/frontend/`), runs within the existing test runner.                                                              |

Total production bundle: **~15 kB gzipped** (HTML + CSS + JS).

---

## 2. Component Architecture

The frontend application follows a decoupled component architecture under `src/components/`:

```
src/
├── config/
│   └── event-content.ts       # Single source of truth for text, dates, placeholders (es-CO)
├── types/
│   └── content.ts             # TypeScript definitions for event config & CTA events
├── styles/
│   ├── variables.css          # Design system tokens (colors, typography, spacing, radii)
│   ├── base.css               # Reset, typography scale, container, accessibility focus
│   ├── components.css         # Responsive component styling
│   └── main.css               # Unified style bundle
├── components/
│   ├── Navbar.ts              # Fixed header, brand badge, section links, quick CTA
│   ├── Hero.ts                # Date/time/venue pills, fluid h1, primary CTA, visual showcase
│   ├── Experience.ts          # 4 curated experience cards with icon containers and tags
│   ├── WhatIsIncluded.ts      # 5 feature cards with checkmarks/badges
│   ├── AlliedBrands.ts        # Flexible responsive grid supporting 3, 5, 8+ partner placeholders
│   ├── EventDetails.ts        # Date & schedule, venue address, Google Maps directions button
│   ├── Faq.ts                 # Accessible accordion with keyboard navigation & ARIA 1.2
│   ├── Contact.ts             # Organizer details, email link, Instagram card
│   ├── FinalCta.ts            # High-conversion closing card with trust badges & purchase CTA
│   ├── StickyBar.ts           # Mobile bottom floating bar for thumb-friendly checkout trigger
│   ├── Footer.ts              # Legal link placeholders, organizer attribution, copyright
│   └── NoticeModal.ts         # Accessible modal informing users of upcoming Phase 6B checkout
├── utils/
│   ├── dom.ts                 # HTML escaping and accessible inline SVG icons
│   └── events.ts              # Custom event bus (dispatchBuyTicket / onBuyTicket)
└── main.ts                    # App assembly, interaction initialization, mount lifecycle
```

---

## 3. Design System & Tokens

All visual attributes are parameterized in `src/styles/variables.css`:

- **Theme**: Luxury Event Dark (`--color-bg-base: #0A0E17`, `--color-bg-surface: #111827`, elevated cards `#1A2234`).
- **Primary Accent**: Warm Glowing Amber (`--color-primary: #F59E0B`, hover `#D97706`, active `#B45309`).
- **Secondary Accent**: Vibrant Indigo (`--color-accent: #6366F1`, soft `#A5B4FC`).
- **Trust Accent**: Emerald Green (`--color-success: #10B981`) for capacity badges and trust badges.
- **Typography Scale**: Fluid `clamp()` for `h1` display headings, `Outfit` font stack with sans-serif system fallbacks.
- **Spacing Scale**: 4px grid (`--space-1` to `--space-24`).
- **Radius**: `--radius-sm` (8px), `--radius-md` (14px), `--radius-lg` (22px), `--radius-full` (9999px).
- **Elevation**: Layered dark shadows (`--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-glow`).

When the client provides their final visual identity (colors, logo, typography), updating `--color-primary`, `--font-family-display`, and related tokens immediately updates the entire site without component refactoring.

---

## 4. Content Configuration Layer

To prevent scattering hardcoded strings throughout components, all event copy resides in `src/config/event-content.ts` adhering to the strict `EventLandingConfig` interface (`src/types/content.ts`):

- `meta`: Titles, descriptions, canonical URL, theme color, Open Graph image URL.
- `branding`: Event title, edition, organizer name, logo text, capacity badge.
- `hero`: Eyebrow, headline, highlight phrase, tagline, date, time, location, CTA labels.
- `experiences`: 4 distinct experiential blocks (workshops, networking, wellness, inspiration).
- `included`: 5 inclusion items with badges.
- `alliedBrands`: Partner placeholders with categories and disclaimer.
- `details`: Date, schedule, venue name, address, city, country, Google Maps link, access note.
- `faq`: 6 comprehensive Spanish questions and answers regarding payments, ticket delivery, transfers, capacity, requirements, and dress code.
- `contact`: Email, Instagram handle, support availability.
- `finalCta`: Headline, description, CTA button label, 3 trust badges.
- `footer`: Legal links (Terms, Privacy Policy) and copyright.

---

## 5. Responsive Strategy (Mobile-First)

Given that the majority of traffic originates from social media (Instagram stories, bios) and QR codes printed on flyers, mobile ergonomics are prioritized:

- **Thumb-friendly touch targets**: All action buttons exceed 48px in height (`btn-lg`: 56px, `btn`: 48px).
- **Sticky Mobile Purchase Bar (`StickyBar.ts`)**: Appears fixed at the bottom of mobile screens (`<= 768px`) with safe-area padding for iPhone home indicators (`env(safe-area-inset-bottom)`).
- **Tested Breakpoints**:
  - `360px` (Compact mobile / Android)
  - `390px` (iPhone 12/13/14/15 standard)
  - `414px` (iPhone Plus/Max)
  - `768px` (iPad / tablet portrait)
  - `1024px` (Desktop / iPad landscape)
  - `1280px` (Standard desktop)
  - `1440px` (Wide desktop monitors)
- **Zero Horizontal Overflow**: Guaranteed via container max-width and `overflow-x: hidden` safeguards.

---

## 6. Accessibility (WCAG 2.1 AA)

- **Semantic Headings**: Strict hierarchy with exactly one `h1` (`#hero-heading`) and section-level `h2` elements.
- **Skip Link**: `<a href="#inicio" class="skip-link">Saltar al contenido principal</a>` for keyboard and screen reader users.
- **Visible Focus Indicator**: Uniform `:focus-visible` styling (`outline: 2px solid var(--color-focus); outline-offset: 3px;`).
- **Accessible Accordion**: FAQ buttons leverage `aria-expanded`, `aria-controls`, `aria-labelledby`, and `role="region"`.
- **Keyboard Navigation**:
  - FAQ headers support `ArrowDown`, `ArrowUp`, `Home`, and `End` navigation.
  - Enter and Space activate buttons natively.
  - Notice modal traps focus, handles `Escape` key, and restores focus to previous active element upon dismissal.
- **Reduced Motion Support**: `@media (prefers-reduced-motion: reduce)` disables smooth transitions and animated scrolling.
- **Contrast**: Body text (`#F8FAFC` on `#0A0E17`) exceeds 14:1 contrast ratio (far surpassing the 4.5:1 WCAG requirement).

---

## 7. Performance Decisions

- **No heavy frameworks**: Built with Vanilla TypeScript and semantic HTML components.
- **Zero external script dependencies**: No tracking, no heavy analytics, no bulky UI libraries.
- **Inlined SVG vectors**: Critical icons rendered inline, eliminating extra HTTP requests and icon-font FOIT/FOUT.
- **Font Optimization**: Google Fonts preconnected with `display=swap` to avoid blocking first paint.
- **Bundle Metrics**:
  - CSS: 23.28 kB (4.66 kB gzip)
  - JS: 34.59 kB (9.56 kB gzip)
  - HTML: 2.63 kB (1.03 kB gzip)
  - Total payload: < 16 kB gzipped.

---

## 8. SEO & Social Metadata

Configured in `index.html` and `event-content.ts`:

- Language declared as `es-CO`.
- Open Graph tags (`og:title`, `og:description`, `og:image`, `og:url`, `og:locale="es_CO"`, `og:site_name`).
- Twitter Card tags (`twitter:card="summary_large_image"`).
- Dedicated social preview graphic: `public/og-image.svg` (1200x630).
- Dedicated vector favicon: `public/favicon.svg` (32x32).

---

## 9. Backend Boundary & CTA Architecture

- **Backend Frozen**: No Supabase Edge Functions or migrations were altered.
- **No Private Secrets**: Zero Supabase service secrets or backend keys are present in the frontend bundle.
- **No Authoritative Price Calculation**: The frontend does not calculate ticket prices or discounts.
- **No Direct Database Access**: Browser does not call `/rest/v1` or PostgreSQL.
- **CTA Decoupling**:
  - Purchase buttons (`#hero-buy-btn`, `#nav-buy-btn`, `#final-buy-btn`, `#sticky-buy-btn`) trigger `dispatchBuyTicket(source)`.
  - In Phase 6A, a default subscriber `onBuyTicket(...)` opens the accessible notice modal informing attendees that pre-sale checkout will open in Phase 6B.
  - Phase 6B will cleanly subscribe to `onBuyTicket(...)` to initiate the Wompi payment flow.

---

## 10. Known Placeholders for Client Replacement

> **Resolved in Phase 6C** (2026-10-07): the client delivered the real material and every item
> below was replaced — see [phase-06c.md](phase-06c.md) §3 and §6. The list is kept as the
> historical record of what this phase shipped; the placeholder values are no longer published
> anywhere and are asserted absent by `tests/frontend/content-config.test.ts`.

The following items are structured placeholders ready to be substituted once final client assets are delivered:

1. **Event Name & Branding**: `"Experiencia Exclusiva 2026"` → Final client event title and logo asset.
2. **Venue Details**: `"Espacio Cultural El Poblado, Calle 10A # 34-45"` → Exact venue name and address.
3. **Photography / Hero Asset**: Container in `Hero.ts` ready to receive the official event hero photo.
4. **Allied Brands**: 5 placeholder cards ready for official sponsor logos.
5. **Legal Links**: `#terminos` and `#privacidad` placeholders ready to link to official client documents.
6. **Contact Email & Social**: `contacto@evento.ejemplo.co` and `@evento_oficial_2026` placeholders.

---

## 11. Test Coverage & Results

All 47 test files (471 tests) pass green:

- **Backend Test Suite**: 43 test files, 439 tests (100% green, database parity, money, Wompi, etc.).
- **Frontend Test Suite**: 4 test files, 32 tests:
  - `tests/frontend/content-config.test.ts` (11 tests): Content completeness, es-CO locale, placeholders, capacity notices.
  - `tests/frontend/components.test.ts` (12 tests): Semantic HTML landmarks, headings, accessibility attributes, component rendering.
  - `tests/frontend/faq-accordion.test.ts` (3 tests): Initial collapse, click toggle, keyboard arrow navigation (`ArrowDown`, `ArrowUp`, `Home`, `End`).
  - `tests/frontend/cta-hook.test.ts` (6 tests): CTA event dispatching, source attribution, notice modal opening/closing.
- **Tooling Checks**:
  - `npm run typecheck` (TypeScript `tsc --noEmit`): 0 errors.
  - `npm run lint` (ESLint with strict type checking): 0 errors.
  - `npm run format:check` (Prettier): All files format compliant.
  - `npm run functions:check` (Deno check on 7 functions + shared core): 0 errors.
  - `npm run build` (Vite build): Successful production bundle in 181ms.

---

## 12. Next Phase (Phase 6B)

Phase 6B will implement the interactive checkout flow:

1. Connecting `onBuyTicket()` to the quotation API (`POST /orders/quote`).
2. Buyer data and participant consent collection forms.
3. Idempotent order creation (`POST /orders`).
4. Wompi Widget / Web Checkout integration using the backend-generated integrity signature.
5. Post-payment confirmation and digital ticket display.
