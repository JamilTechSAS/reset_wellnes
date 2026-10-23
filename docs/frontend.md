# Frontend (buyer journey)

## 1. Status

Phase 6C. The Spanish landing page carries the **real client content** for Reset Wellness Club —
Re set Sunset Vol. 1 (Montería, 15 November 2026) in the client's own palette and logos, with their
three legal documents published in a tabbed dialog (see
[phases/phase-06c.md](phases/phase-06c.md)). The Phase 6A landing page is wired to the frozen
backend, so a buyer can go from the landing page to a paid order and a digital ticket:

```
landing → buy → quantity + participant data → server quote → order → Wompi checkout
        → payment → return → status polling → confirmation → ticket + QR → email status
```

Verified locally end-to-end against the real backend (see [phases/phase-06b.md](phases/phase-06b.md)).
**Not verified live:** Wompi sandbox, Resend delivery, hosted Supabase and the Google Sheets
projection, because no live credentials and no hosted project exist in this repository.

## 2. Where the code lives

| Path                               | Responsibility                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `vite.config.ts`     | Entry document (SEO/OG, theme colour, substitute fonts, favicon) and the dev/build config (port 3000, `dist/` out)                                                     |
| `src/main.ts`                      | `initApp` (landing page + CTA wiring) and `bootstrap` (controller + dialog + checkout return)                                                                          |
| `src/config/env.ts`                | The **only** place `import.meta.env` is read; resolves `FRONTEND_CONFIG`                                                                                               |
| `src/config/event-content.ts`      | Landing-page copy (Spanish), from the client handover. Values the client did not supply stay `null`/pending. The purchase dialog never depends on it for business data |
| `src/config/legal-content.ts`      | The client's three legal documents, verbatim, with `{{token}}` pending fields and the review notes                                                                     |
| `src/types/content.ts`             | The landing-page content contract (every pending field is typed nullable/optional)                                                                                     |
| `public/assets/reset/`             | The client's logo PNGs, byte-identical to the delivered files (full lockup, short lockup, GHL)                                                                         |
| `src/components/LegalDialog.ts`    | The tabbed legal modal (three client documents, pending chips, tab/focus/Escape behaviour)                                                                             |
| `src/purchase/ticket-selection.ts` | Resolves the ticket type this page sells (`VITE_TICKET_TYPE_CODE`) instead of assuming the first row                                                                   |
| `src/api/client.ts`                | HTTP + the `{ ok, data }` / `{ ok: false, error }` envelope, timeout, caller abort                                                                                     |
| `src/api/ticketing.ts`             | One function per backend route; adds `Idempotency-Key` / `X-Buyer-Email` where the contract requires                                                                   |
| `src/api/types.ts`                 | Response shapes mirrored from `docs/api.md`                                                                                                                            |
| `src/purchase/controller.ts`       | The state machine: the only module that sequences network calls                                                                                                        |
| `src/purchase/validation.ts`       | Field rules that mirror the backend, for immediate Spanish feedback                                                                                                    |
| `src/purchase/persistence.ts`      | `sessionStorage`: the idempotency key, the pending-order correlation, the form draft                                                                                   |
| `src/purchase/format.ts`           | Money/date/availability/email-status presentation. No business rule lives here                                                                                         |
| `src/purchase/return-route.ts`     | Parses the Wompi return URL (hint only, never proof)                                                                                                                   |
| `src/purchase/wompi.ts`            | Turns the backend-signed checkout payload into the Wompi URL. Never recomputes a signature                                                                             |
| `src/purchase/qr.ts`               | Renders the ticket token as a QR SVG                                                                                                                                   |
| `src/components/PurchaseDialog.ts` | The single UI surface (bottom sheet on mobile, centred card on desktop) with the a11y contract                                                                         |
| `src/components/TicketCard.ts`     | The digital ticket card (perforated receipt + QR)                                                                                                                      |
| `src/styles/purchase.css`          | The checkout surface's styles, layered on the Phase 6A tokens in `variables.css`                                                                                       |

Structure rule: **logic is separated from rendering.** The controller owns state and policy; the
dialog renders whatever the controller's state says and translates user intent into controller
calls. That is why every behaviour below is unit-tested without a DOM.

## 3. The buyer journey (state machine)

```
                      ┌───────────────┐  event not on sale / not found
                      │    closed     │◄──────────────────────────────
                      └───────────────┘
   open ──► loading ──┤
                      └──► form ──quote──► review ──create──► submitting ──► verifying
                            ▲                 │                              │
                            │                 └── validation issues ◄─────────┤ (4 s poll, ≤ 90 s)
                            └── back/edit ◄──────────────── problem ◄─────────┤
                                                                  │           └──► confirmed
                                                                  └── pending ◄── window closed
```

| Step         | What the buyer sees                                                                        |
| ------------ | ------------------------------------------------------------------------------------------ |
| `loading`    | "Cargando disponibilidad" — the event, its availability and its current tier are requested |
| `closed`     | "Venta no disponible" / "Entradas agotadas" with the contact link. Not an error, a state   |
| `form`       | Quantity stepper, 7 participant fields, 2 consents, discount code, **estimated** price     |
| `review`     | The backend quote: event, ticket type, quantity, holder, subtotal, discounts, **Total**    |
| `submitting` | "Preparando tu pago" — the pay button is gone and the dialog refuses to close              |
| `verifying`  | "Verificando tu pago" — explicit that confirmation comes from Wompi, not from the redirect |
| `confirmed`  | Payment confirmed, the digital ticket(s) + QR, day-of instructions, honest email status    |
| `pending`    | "Tu pago sigue en proceso" with the order reference and a "Consultar de nuevo" action      |
| `problem`    | One Spanish explanation per failure kind, each with the actions that can actually help     |

### Consents

Two checkboxes, **never pre-checked** — not even when a draft is restored, so consent is always a
deliberate act:

- **Tratamiento de datos personales** — mandatory (the backend rejects the order without it).
- **Próximos eventos** — optional; the order is accepted unchecked.

### Authoritative pricing

The form shows a price only as an explicit **estimate** ("Precio estimado. El valor definitivo se
confirma al continuar."), derived from the public `GET /events/{code}` tier. Every figure on the
`review` and `confirmed` steps is the backend's own number, formatted by `formatCopCents`. No
price, discount, tax or total is ever computed in the browser, and `POST /orders` is never sent a
price.

## 4. Frontend action → backend endpoint

| Buyer action               | Request                                 | Notes                                                                                          |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Open the purchase dialog   | `GET /events/{code}`                    | Landing content + availability + current tier. `eventCode` from `VITE_EVENT_CODE`              |
| "Continuar al pago"        | `POST /orders/quote`                    | `{eventCode, ticketTypeCode, quantity, discountCode?}`. Reserves nothing                       |
| "Pagar …"                  | `POST /orders`                          | + header `Idempotency-Key`. Prices come back from the database                                 |
| Handoff to Wompi           | _(browser navigation)_                  | `checkout.wompi.co/p/?…` built only from the response above                                    |
| Return (`/gracias?id=…`)   | `POST /orders/{reference}/payment-hint` | Body `{transactionId}`, header `X-Buyer-Email`. Accelerates the webhook only                   |
| Return / pending / refresh | `GET /orders/{reference}`               | Header `X-Buyer-Email`. **The only source of payment truth**                                   |
| "Intentar pagar de nuevo"  | `POST /orders/{reference}/retry`        | Body + header email; returns a fresh checkout for a new attempt                                |
| "Consultar mi compra"      | `GET /orders/{reference}`               | Reference + email typed by the buyer; a wrong email is indistinguishable from an unknown order |

Never used by the frontend: `POST /check-in`, `GET /check-in/{token}`, `POST /webhooks/wompi`,
`POST /orders-maintenance`, `POST/PUT /orders/{reference}/participants` (operator/Phase-5 surfaces,
out of scope for 6B). The browser never talks to PostgreSQL, PostgREST or GraphQL.

### Error envelope

`{ ok: false, error: { code, message, details? } }` → `ApiError` with the documented code
(`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`,
`UPSTREAM_ERROR`, `INTERNAL_ERROR`) and the mapped `details.issues[]`, which the form shows against
the offending field.

**Documented limitation:** the backend deliberately does not surface the raw SQLSTATE reason, so a
`409` on `POST /orders` cannot be distinguished from the envelope (sold out vs. invalid code vs.
idempotency conflict). The frontend explains the overwhelmingly likely cause for that step — the
last tickets went to someone else — and says explicitly that no charge was made. The rich
`discountCode.reason` and `availability` are used from the **quote** response, before the money
path, so a bad or exhausted code never breaks the purchase.

## 5. Returning from Wompi, polling, refresh

1. `parseReturnContext(window.location)` reads `?id=` / `?transaction-id=` (Wompi's transaction id)
   or `?ref_payco=` (ePayco's), an optional `?ref=`, and treats the `/gracias` path itself as a
   return. `/gracias` has no HTML file: `vercel.json` rewrites it to `index.html`, so it also works
   when opened directly (the Vite dev server hides a missing rewrite by falling back for any path).
   The return URL is `PAYMENT_RETURN_URL` (legacy fallback `WOMPI_REDIRECT_URL`) for both
   providers: Wompi's `redirect-url` and ePayco's session `response`.
2. **Nothing in the URL is proof of payment.** The transaction id is forwarded to the payment-hint
   endpoint, which re-reads the transaction from the provider (Wompi with the private key, ePayco
   through its validation endpoint) before anything else happens. If the hint fails, the flow
   continues unchanged (the webhook still applies; the reconciliation sweep is Wompi-only).
3. The order to ask about comes from the session correlation written when the order was created
   (reference + buyer email). Without one, the dialog asks for the reference and the buyer email.
4. Polling: `GET /orders/{reference}` every **4 s**, for at most **90 s**. It stops on a terminal
   state (`PAID`, `EXPIRED`, `CANCELLED`, `FAILED`, or a declined/voided/refunded/error payment), on
   a superseded refresh (one loop only, enforced by a generation counter), and on unmount/close
   (`dispose`/`cancel` clear the timer and abort the in-flight request). When the window closes with
   no answer, the buyer gets the honest `pending` screen, not an error.
5. A transient poll failure never alarms the buyer: the verifying screen stays until the window ends.

**Refresh and repeated returns.** The session correlation is deliberately **kept after a confirmed
payment**, so refreshing the page or reopening `/gracias` re-reads the same order from the backend
and shows the same ticket again. It never re-creates an order, because a re-render or reload cannot
change the `Idempotency-Key` of an attempt that already exists — and a `PAID` order can only ever
produce its original tickets (the backend's `unique (order_item_id, order_item_seq)` is the
guarantee, not the frontend).

## 6. Idempotency and duplicate protection

- `generateIdempotencyKey()` produces `order-<uuid v4>` (16–128 printable ASCII, the contract's
  range) **once per intentional purchase** and reuses it across retries of the same attempt, so a
  double click, a network retry and a component re-render all resolve to the same order.
- The key is rotated only when a **new** attempt is intentional: `POST /orders/{reference}/retry`
  and a full lookup/recovery.
- `submit()` is guarded three ways: it ignores a second call while `submitting`, ignores it after
  the handoff (`verifying`/`confirmed`), and the pay button is removed from the DOM the moment the
  request starts.

## 7. Wompi browser integration

The backend returns exactly what the browser is allowed to hold:

```json
{
  "publicKey": "pub_test_…",
  "currency": "COP",
  "amountInCents": 9500000,
  "reference": "EVT-2026-000009",
  "integritySignature": "…",
  "expirationTime": "…",
  "redirectUrl": "https://…/gracias",
  "customerData": { "email": "…" }
}
```

`buildWompiCheckoutUrl` only serializes those values into Wompi Web Checkout
(`signature:integrity`, `amount-in-cents`, `reference`, `redirect-url`, `expiration-time`,
`customer-data:email`). The frontend **never** recomputes the signature, changes the amount, or
invents a reference: the signature covers `reference + amount-in-cents + currency (+ expiration)`,
so any edit would be rejected by Wompi — or worse, charge a different amount.

## 8. Digital ticket and QR

The ticket is whatever `GET /orders/{reference}` returns; the frontend never mints a token. The QR
encodes **only** the opaque `TKT_` + 20 Crockford base32 token (≈100 bits) — no cédula, email,
phone, order id or URL — so a screenshot of the code is useful only at the door. The `svg` is
scalable and dark-on-light (a white plate behind it), which is what a scanner and a printer need.
The confirmation screen never displays the cédula, the email or the phone.

## 9. Email status (never over-claimed)

| Backend `confirmation`     | What the buyer is told                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `sent >= expected`         | "Enviamos tu entrada a tu correo electrónico."                                  |
| some `sent`, some pending  | "Ya enviamos N de M. El resto está en camino."                                  |
| `queued > 0`, nothing sent | "Estamos enviando una copia a tu correo electrónico."                           |
| `failed > 0`               | "No pudimos enviar el correo todavía. Tu entrada es válida y puedes guardarla…" |
| no `confirmation` object   | "Podrás consultar el estado del correo más abajo." (no claim)                   |

`EMAIL_ENABLED=false` locally, so the outbox stays queued and the second row is what a local run
shows — which is itself the proof that the UI does not claim delivery it cannot observe.

## 10. Failure states

| Situation                              | UI                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sold out (availability)                | `closed`: "Entradas agotadas" + contact link                                              |
| Sold out between quote and order (409) | `problem/sold_out`: "Los cupos se agotaron… No se realizó ningún cobro."                  |
| Invalid / expired / exhausted code     | Inline note on the review step naming the reason; the purchase continues without the code |
| Order creation failure (network/5xx)   | `problem` with "Intentar de nuevo"; the same idempotency key is reused                    |
| Payment pending                        | `pending`: "Tu pago sigue en proceso" + reference + "Consultar de nuevo"                  |
| Payment declined / voided / refunded   | `problem/declined` + "Intentar pagar de nuevo" (or "Editar mis datos")                    |
| Order `FAILED`                         | Treated as declined (safe retry)                                                          |
| Reservation expired / cancelled        | `problem/expired` + retry with a fresh checkout                                           |
| Retry refused (409)                    | "No pudimos iniciar un nuevo intento" + contact — _not_ a sell-out message                |
| Unknown order / wrong email            | `problem/not_found`, identical for both (no order enumeration) + a lookup form            |
| Rate limited / upstream / 5xx          | Generic, actionable Spanish copy. Never a stack trace, SQLSTATE, id or provider message   |

## 11. Environment variables

Only `VITE_*` values reach the bundle, and only values that are safe in a browser:

| Variable                  | Default                                                                                            | Purpose                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `VITE_API_BASE_URL`       | local stack in `vite dev`; `https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1` in `vite build` | Edge Functions base URL                                          |
| `VITE_EVENT_CODE`         | `RESET-SUNSET-2026`                                                                                | Event the page sells                                             |
| `VITE_TICKET_TYPE_CODE`   | `GENERAL`                                                                                          | Ticket type sold                                                 |
| `VITE_WOMPI_CHECKOUT_URL` | `https://checkout.wompi.co/p/`                                                                     | Wompi Web Checkout endpoint (environment follows the public key) |

The hosted project is the production default (Phase 6D): a `vite build` with no environment
variables talks to the deployed Edge Functions, while `vite dev` keeps talking to the local stack.
`src/config/env.ts` is the only file that names the project ref, and
`tests/frontend/hosted-config.test.ts` fails if it spreads.

The event code is **operator data, not client content**: it must equal the `code` of the event row
the operator inserts, so the canonical value for this event is `RESET-SUNSET-2026`, and the
placeholder event's code must never come back. The ticket-type code stays operator data too — it
must match a `ticket_types.code` in the target project (see [phases/phase-06d.md](phases/phase-06d.md)
§6 for the two ways the client's three products can be modelled).

Every one has a development-safe default, so the app runs with zero configuration. They are **not**
listed in `.env.example`: that file is asserted by `tests/tooling/env-template.test.ts` to document
exactly the variables the **backend** loader reads, and adding frontend keys there would break that
guardrail. Set them in the deploy environment (Vercel → Environment Variables) or a Vite `.env`
file, which is git-ignored.

Never `VITE_`-prefix, and never ship: `SUPABASE_SECRET_KEY` / service-role key, `WOMPI_PRIVATE_KEY`,
`WOMPI_INTEGRITY_SECRET`, `WOMPI_EVENTS_SECRET`, `RESEND_API_KEY`, `GOOGLE_PRIVATE_KEY`,
`MAINTENANCE_API_TOKEN`, the database URL. Nothing in `src/` reads them; the only Supabase key the
browser ever sees is Wompi's **public** key, which the backend returns in the checkout payload.

## 12. Local development

```bash
npx supabase start                 # Postgres/PostgREST/Kong on 54321, DB on 54322
cp .env.example .env.local         # then set SUPABASE_SECRET_KEY (and dev-shaped Wompi values)
npm run functions:serve            # Edge Functions on http://127.0.0.1:54321/functions/v1
npm run dev                        # Vite on http://localhost:3000
```

- `CORS_ALLOWED_ORIGINS=http://localhost:3000` must list the dev origin exactly.
- **`npm run functions:serve` cannot boot this backend under Supabase CLI ≥ 2.119**: the CLI refuses
  `SUPABASE_*` names in an env file (`Env name cannot start with SUPABASE_, skipping`), and the
  backend requires exactly `SUPABASE_SECRET_KEY`, so `/health` answers `500` locally. Until that is
  resolved, either pin an older CLI or run the functions under plain Deno — the launcher used in
  Phase 6D is described in [phases/phase-06d.md](phases/phase-06d.md) §4.
- To point the dev server at another backend without touching the build defaults, create a
  git-ignored `.env.development.local` holding `VITE_API_BASE_URL` (Phase 6D used
  `http://127.0.0.1:54331/functions/v1` for its verification harness).
- The login is `EMAIL_ENABLED=false` / `SHEETS_ENABLED=false`: no provider is contacted, the email
  outbox stays queued.
- **Business data is required.** `supabase/seed.sql` inserts nothing (it documents the confirmed
  client facts, the missing ones and a disabled template), so with an empty database the dialog
  shows the not-available state. To exercise the flow, insert an
  event (`status = 'PUBLISHED'`), a ticket type and a pricing tier whose sales window is open — the
  codes must match `VITE_EVENT_CODE` / `VITE_TICKET_TYPE_CODE`.
- Wompi is not contacted until the buyer is redirected, so a dev-shaped `pub_test_…` key is enough
  to reach the handoff. Completing a payment locally requires either real sandbox credentials or
  driving `public.confirm_payment(...)` directly as `service_role` (this is what the Phase 6B
  verification did, for the _backend_ half of the confirmation).

## 13. Testing

`npm test` (or `npm run check` for the full gate). Frontend suites live in `tests/frontend/`:

| File                                        | What it protects                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purchase-helpers.test.ts`                  | Money/date formatting, availability labels, the email-status honesty rules, field validation (including the consent asymmetry), draft/correlation persistence, return-URL parsing, the Wompi URL, the QR                                 |
| `purchase-api.test.ts`                      | The envelope (success, failure, unknown code, non-JSON, missing envelope), timeout vs. caller abort, and the exact headers/bodies each endpoint must send                                                                                |
| `purchase-flow.test.ts`                     | The state machine: quote, order creation with a stable idempotency key, double-click protection, no-price-from-the-browser, every payment outcome, bounded/stopped/single polling, refresh + repeated returns, no false confirmation     |
| `purchase-ui.test.ts`                       | The rendered dialog (fields, consents, totals, ticket, QR), the confirmation's refusal to leak personal data or over-claim email, and the modal behaviour (focus, Escape, disabled close while submitting, caret retention while typing) |
| `components.test.ts`                        | The rendered DOM of every landing section with the real client content: logo files, hero facts, ticket rows, the ally's real logo, pending states, and the absence of placeholder copy in the composed page                              |
| `content-config.test.ts`                    | The content contract: real metadata/prices/date/venue/contact, the client's inclusive sentence, and the negative assertions (no removed placeholder, no invented capacity, no discount code, no extra benefits, palette present)         |
| `legal-content.test.ts`                     | The client's legal documents (token/pending-field invariant, verbatim clauses, review notes), `renderLegalText` escaping, and the tabbed dialog's behaviour                                                                              |
| `cta-hook.test.ts`, `faq-accordion.test.ts` | CTA routing into the purchase flow, and the FAQ's collapse/arrow-key behaviour                                                                                                                                                           |

Nothing mocks away the thing under test: the API doubles return real documented response shapes,
and the flow tests assert on observable behaviour (which endpoint was called with what, which step
the buyer is on) rather than on implementation details.
