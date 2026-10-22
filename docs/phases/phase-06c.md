# Phase 6C — Real client content integration (Reset Wellness Club)

**STATUS: PASS WITH CONDITIONS.**

The landing page, the legal documents, the ticket display and the contact surface now carry the
client's real material for **Reset Wellness Club — Re set Sunset Vol. 1** (Montería, Córdoba,
Colombia). No placeholder/demo content from Phases 6A–6B survives in production-facing copy, no
missing business value was invented, and no backend code was changed.

The conditions are the values only the client can supply (inventory, sales-stage windows, capacity,
street address, legal entity data, fonts) — listed in §5 and §12.

---

## 1. Scope and non-goals

**In scope:** replace demo event content with the delivered client material; retheme the design
system to the client's palette; publish the client's own legal documents; show the real ticket
products; show only the real partner logo; update SEO metadata; update the frontend tests.

**Out of scope (unchanged):** Wompi architecture, Supabase schema/migrations, payment
confirmation, ticket issuance, QR generation, idempotency, reconciliation, RLS, rate limiting,
check-in, Google Sheets. **No backend source file was modified in this phase** (§11).

---

## 2. Source of truth

The client handover ZIP (`Reset-web-para-programador-…zip`) was read directly, not summarised:
`reset-web/index.html`, `entradas.html`, `eventos.html`, `marca-y-colaboracion.html`,
`preguntas-frecuentes.html`, `terminos-y-condiciones.html`, `css/reset.css`,
`js/entradas-config.js`, the three logo PNGs, and the brand manual board under `referencias/`.

Where the ZIP disagreed with itself or left a field empty, the project followed the rule of the
phase: **publish what the client confirmed, mark the rest as pending, invent nothing.**

Two files in `public/assets/reset/` were verified byte-identical to the ZIP originals
(sha256) before being wired into the page.

---

## 3. Client content integrated

| Area          | Published value                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand         | Reset Wellness Club (Montería, Córdoba, Colombia)                                                                                                                                |
| Event         | Re set Sunset — Vol. 1                                                                                                                                                           |
| Date and time | Domingo 15 de noviembre de 2026, 1:00 p.m. – 7:00 p.m. (America/Bogota)                                                                                                          |
| Venue         | Terraza del hotel GHL, Montería (street address not supplied)                                                                                                                    |
| Sales phase   | Preventa (open)                                                                                                                                                                  |
| Prices        | Preventa `$160.000` · Comparte esta experiencia (2) `$340.000` (`$170.000` per person) · General `$200.000` — **displayed only**; the payable amount is always the backend quote |
| Experiences   | Pilates, Yoga, Spinning, Inmersión en hielo, Quiropráctica, Sueroterapia, Bronceo                                                                                                |
| Inclusive     | The client's sentence verbatim: "Todas las experiencias del día, activaciones de marcas, kit de bienvenida y espacios para compartir y conectar."                                |
| What to bring | Vestido de baño, toalla, bloqueador, documento de identidad                                                                                                                      |
| Dress code    | `Sport + [color por confirmar]` — the colour is explicitly pending                                                                                                               |
| Contact       | WhatsApp 313 334 0844 (`https://wa.me/573133340844`), reset.wellness@gmail.com, Instagram @reset.wll                                                                             |
| Allies        | GHL Hoteles only, with the delivered `logo-ghl.png` (linking to ghlhoteles.com)                                                                                                  |
| Legal         | The client's three documents, verbatim, with their `(pendiente)` fields rendered as visible pending chips                                                                        |
| FAQ           | 12 answers built only from client statements; 2 are flagged "Confirmación pendiente"                                                                                             |
| Logos         | `logo-reset.png` (full lockup, ≥640px), `logo-reset-corto.png` (phones, and the favicon), `logo-ghl.png` for the ally                                                            |
| Palette       | `#513229` Mother Earth, `#F4F1E2` Lucky Dice, `#D7D4B1` Vinnie, `#FCE6B7` Bay                                                                                                    |
| Typography    | Fraunces (display) + Questrial (body) — the two substitutes the client's own stylesheet declares, with system fonts behind them; official faces NOT delivered                    |
| SEO           | Real `<title>`, description, OG/Twitter text, `theme-color #513229`, canonical on a reserved `.example` domain marked pending                                                    |

**Photography:** the ZIP contains no event photography, only a walkthrough video of the old site.
The hero is therefore a branded, photo-free lockup that states the official photography is still
pending; the video and any screenshot of the old site were **not** used as hero media.

**Legal:** `src/config/legal-content.ts` reproduces the client's texts unchanged (only escaped).
`LEGAL_PENDING_FIELDS` carries the four unresolved values (web domain, legal entity name, NIT or
cédula, policy publication date) and `LEGAL_REVIEW_NOTES` records five open points for client/legal
sign-off — including the client's own refund inconsistency (7-day right vs. the 48-hour exclusion
vs. the discounted-ticket exclusions) and the fact that their privacy text names **FormSubmit**,
which this platform does not use (payments are Wompi, storage is Supabase, mail goes through the
configured provider).

---

## 4. Visual integration

- `src/styles/variables.css` was rewritten to the client palette, with the contrast ratio of every
  text/background pair recorded next to the token (brown on beige 10.1:1, secondary 6.9:1, muted
  5.5:1, beige on brown 10.1:1, brown on vinnie 7.4:1). The manual's fifth swatch (light blue) has
  no name and no hex in the client material, so no token was invented for it.
- `base.css`, `components.css` and `purchase.css` were rethemed to the warm daylight palette, so the
  landing page and the checkout dialog are one surface. `#ffffff` is deliberately kept where it is
  functional (the QR must stay dark-on-light to scan).
- New components: the legal dialog (tabbed modal) and the ticket-options list in the final CTA.

---

## 5. Supabase / data

**No real event data was inserted — locally or in the hosted project**, and no migration was added.
The values a working sale needs are exactly the ones the client did not supply; inserting the
confirmed values alone would have required inventing inventory and sales windows. Nothing was
written to the hosted project (that is a production data change, outside this phase's authority).

`supabase/seed.sql` (still inert — it inserts nothing) now records:

- the **confirmed** event facts (name, date/time in UTC, venue, currency, phase, the three prices in
  centavos);
- the **missing** values, field by field;
- a commented insert template that is valid SQL with the real prices, with an explicit warning that
  applying it as-is would make all three products sellable at once with unbounded inventory. The
  template is disabled and must be completed by the operator once the client confirms the gaps.

`events.capacity`, `pricing_tiers.quantity_limit` and `pricing_tiers.sales_starts_at/sales_ends_at`
are all nullable, so a published event without a capacity is technically possible; the project chose
**not** to publish a sale that the client has not defined.

Operational consequence: `VITE_EVENT_CODE` / `VITE_TICKET_TYPE_CODE` must be set to whatever the
operator inserts. The frontend defaults (`TAT-2026`, `GENERAL`) remain development-safe defaults,
not production data.

---

## 6. Placeholders removed from production-facing content

`Experiencia Exclusiva 2026`, `Espacio Cultural El Poblado, Calle 10A # 34-45`, `Medellín`,
`21 de noviembre de 2026`, "120 cupos/asistentes", `contacto@evento.ejemplo.co`,
`@evento_oficial_2026`, the 12-slot ally grid with fake partner cards, the fake map link, the
`og-image` claim of a photographic asset, the `#0D1117` dark theme, the placeholder footer legal
links (`#terminos`, `#privacidad`) and the Phase 6A "notice modal" copy.

Two deliberate exceptions:

- `docs/phases/phase-06a.md` §10 keeps its placeholder list as the historical record of that phase;
  it now carries a pointer to this report.
- A comment inside `supabase/migrations/20261003210001_catalog.sql` still says "≈120 for the current
  event". That file is an already-applied migration: editing it would create needless drift between
  the hosted project and the repository, and the text is neither data nor published content. It is
  recorded here instead of changed.

The old placeholder strings are also asserted **absent** by tests, so they cannot silently return
(§9).

---

## 7. Bugs found by browser QA (and fixed)

1. **Both logo lockups rendered at every width.** `.brand-logo img { display: block }` (specificity
   0,1,1) outranked `.brand-logo-short { display: none }` (0,1,0), so the full and the short lockup
   appeared side by side in the header. Removed the `display` from the compound selector; verified
   `none`/`block` at 1280px, 820px and 390px.
2. **The WhatsApp number wrapped onto three lines.** The unsized arrow SVG inside `.contact-link`
   defaulted to a 300×150 box and squeezed the phone number. The icon now has an explicit box and
   the handle is `nowrap`; all three contact links are single-line (22px tall).
3. **The sticky mobile bar never appeared.** Its reveal depended on an `IntersectionObserver` that
   never delivered in this layout. The reveal is now driven by scroll/resize listeners (capture
   phase, coalesced into one animation frame), which does not depend on which element scrolls.
4. **The FAQ pending chip crushed the question** on a 390px screen ("¿Cómo y / cuándo / recibo / mi
   / entrada?"). Below 560px the question owns the first row, the chevron is pinned to its corner and
   the chip wraps to its own row.

---

## 8. Accessibility and responsive QA

- One `<h1>`; landmarks (`header`/`main`/`footer`), `aria-labelledby` on every section, labelled
  dialog roles, `aria-expanded`/`aria-controls` on the FAQ, `role="tablist"` on the legal tabs.
- Keyboard: Escape closes the purchase dialog and the legal dialog and returns focus to the opener;
  the legal tabs move with ArrowLeft/ArrowRight; the FAQ keeps arrow/Home/End navigation.
- Contact links carry explicit accessible names including the handle and "(abre en una pestaña
  nueva)" for external targets.
- Contrast: the palette's ratios are recorded in `variables.css` (all ≥ 4.5:1 for text, most ≥ 7:1).
- Viewports checked: **1280×900**, **820×1180**, **390×844** — no horizontal overflow at any of the
  three (measured `scrollWidth <= innerWidth`).

---

## 9. Test coverage and results

`npm run check` is green after Phase 6C: **656 tests in 52 files** (was 631 in 51).

- **typecheck** (`tsc --noEmit`) 0 errors, **lint** (ESLint typed) 0 problems, **format:check**
  clean, **functions:check** (Deno) 0 errors, **build** (Vite) successful, **656/656 tests** pass.
- Backend: 439 tests in 43 files — untouched and unchanged.
- Frontend: 217 tests in 9 files (was 192 in 8).
  - `content-config.test.ts` (18): real metadata/prices/date/venue/contact, the client's inclusion
    sentence verbatim, the single real ally, `venueAddress`/`mapUrl` null, the pending dress code,
    the three products with Preventa as the current phase — plus the negative assertions: none of the
    removed placeholders, no `\b120\b`, no discount code, no percentage claim, no invented extra
    benefit (parqueadero, almuerzo, DJ, masaje), and the palette present in `variables.css`.
  - `components.test.ts` (17): the rendered DOM of every section, the real logo `src`s, no `<img>`
    pretending to be event photography, the absence of a map link, the ally's real logo (and no
    placeholder card), the pending FAQ chips, the `$160.000/$340.000/$200.000` rows, and a
    whole-page assertion that no placeholder text survives.
  - `legal-content.test.ts` (13, new): the three documents, the token/pending-field invariant
    (every `{{token}}` is declared, every declared field is used), the client's own wording for the
    waiver/7-day/Ley 1581 clauses, the review notes, HTML escaping, and the dialog's tabs, pending
    banner, Escape/backdrop/close-button behaviour and arrow-key navigation.

---

## 10. Not verified live (reported as conditions, not as passes)

- **Hosted Supabase**: no event/ticket/price rows exist yet, so no real purchase can be completed
  against production data.
- **Wompi sandbox / Resend / Google Sheets / published domain / font licences**: unchanged
  pre-launch blockers from Phases 5–6B.
- The purchase dialog was opened in the browser and renders the rethemed, honest failure state
  ("Problema de conexión" with the client's real support email) because no function server and no
  event row were available during this phase's QA. The happy path is the one verified in Phase 6B
  and is untouched by Phase 6C except for the ticket-type label, which is now backend-driven.

---

## 11. Backend

**No backend source file was changed in Phase 6C.** No Edge Function, migration, SQL function,
policy or grant was edited; the 22 migrations and 7 deployed functions are exactly as Phase 6B left
them. The only backend-adjacent file touched is `supabase/seed.sql`, which is inert documentation
and inserts nothing.

---

## 12. Remaining conditions (client input required)

1. **Capacity** — no number published anywhere.
2. **Per-tier inventory** (`quantity_limit`) and the **exact sales-stage windows**; also whether the
   2-ticket bundle runs alongside preventa or after it.
3. **Street address and a verified Google Maps link** (the UI shows "Dirección y mapa: por
   confirmar").
4. **Dress-code colour** (`Sport + [color por confirmar]`).
5. **Legal entity name, NIT/cédula, policy publication date and the final web domain**; plus legal
   review of the refund inconsistency and of the processor list (FormSubmit vs. Wompi/Supabase/mail).
6. **Event photography** (hero and social sharing) — the OG image is a branded card, not a photo.
7. **Official font files and their licences** (currently Fraunces + Questrial loaded as substitutes).
8. **Additional ally logos**, with the brand's permission to publish each one.
9. **Ticket email sender identity** and the **payment methods to advertise** (the email wording
   never claims a delivery that has not happened).
10. **Event and ticket-type codes** for `VITE_EVENT_CODE` / `VITE_TICKET_TYPE_CODE` once the data is
    inserted.
