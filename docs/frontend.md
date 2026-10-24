# Frontend (buyer journey)

## 1. Status

The Spanish site carries the **real client content** for Reset Wellness Club — Re set Sunset Vol. 1
(Montería, 15 November 2026) in the client's palette, logos, and three legal documents published in
a tabbed dialog (see [phases/phase-06c.md](phases/phase-06c.md)). The pages are the client-delivered
static HTML files (`index.html`, `entradas.html`, …), and `src/main.ts` wires the purchase dialog,
the legal dialog and the sales-stage behaviour into them.

Tickets are discontinued. No ticket, QR code, ticket token, ticket lookup or ticket email is issued
or rendered by this frontend. A `PAID` order **is** the confirmation, and a two-admission purchase is
complete once the companion is attached as a participant of that order:

```
landing → buy → quantity + holder data → server quote → order (+ ePayco session)
        → ePayco Smart Checkout → return → status polling → PAID confirmation
        → companion form (two-admission purchases) → POST …/participants
```

Verified locally (unit/integration suites with documented response shapes, plus a `vite dev` smoke
test of the rendered pages). **Not verified live:** ePayco sandbox, hosted Supabase and the Google
Sheets projection, because no live credentials and no hosted project exist in this repository.

## 2. Where the code lives

| Path                               | Responsibility                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `entradas.html`, …   | The client's static pages (SEO/OG, theme colour, fonts, favicon) and the `data-buy-source` purchase CTAs                                                               |
| `vite.config.ts`                   | Dev/build config (every HTML page is a build input, port 3000, `dist/` out)                                                                                            |
| `src/main.ts`                      | `initApp` (content-driven landing) and `bootstrap` (controller + dialogs + ePayco checkout + return-route wiring)                                                      |
| `src/config/env.ts`                | The **only** place `import.meta.env` is read; resolves `FRONTEND_CONFIG`                                                                                               |
| `src/config/event-content.ts`      | Landing-page copy (Spanish), from the client handover. Values the client did not supply stay `null`/pending. The purchase dialog never depends on it for business data |
| `src/config/legal-content.ts`      | The client's three legal documents, verbatim, with `{{token}}` pending fields and the review notes                                                                     |
| `src/types/content.ts`             | The landing-page content contract (every pending field is typed nullable/optional)                                                                                     |
| `public/assets/reset/`             | The client's logo PNGs, byte-identical to the delivered files                                                                                                          |
| `src/utils/client-interactions.ts` | The static pages' behaviour: menu, community modal, reveal, newsletter form and the sales stage (`#comprar`, ticket radios, sold-out copy)                             |
| `src/purchase/ticket-selection.ts` | Resolves the ticket type this page sells (`VITE_TICKET_TYPE_CODE`) instead of assuming the first row                                                                   |
| `src/api/client.ts`                | HTTP + the `{ ok, data }` / `{ ok: false, error }` envelope, timeout, caller abort                                                                                     |
| `src/api/ticketing.ts`             | One function per backend route; adds `Idempotency-Key` / `X-Buyer-Email` where the contract requires                                                                   |
| `src/api/types.ts`                 | Response shapes mirrored from `docs/api.md`, including `EpaycoCheckout`                                                                                                |
| `src/purchase/controller.ts`       | The state machine: the only module that sequences network calls                                                                                                        |
| `src/purchase/validation.ts`       | Field rules that mirror the backend, for immediate Spanish feedback                                                                                                    |
| `src/purchase/persistence.ts`      | `sessionStorage`: the idempotency key, the pending-order correlation, the form draft                                                                                   |
| `src/purchase/format.ts`           | Money/date/availability presentation. No business rule lives here                                                                                                      |
| `src/purchase/return-route.ts`     | Parses the return URL (`?ref_payco=`, legacy `?id=`; hint only, never proof)                                                                                           |
| `src/purchase/epayco.ts`           | Loads ePayco Smart Checkout V2 and opens the backend's session. Never holds a key                                                                                      |
| `src/components/PurchaseDialog.ts` | The single UI surface (bottom sheet on mobile, centred card on desktop) with the a11y contract                                                                         |
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

| Step         | What the buyer sees                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `loading`    | "Cargando disponibilidad" — the event, its availability and its current tier are requested                     |
| `closed`     | "Venta no disponible" / "Entradas agotadas" with the contact link. Not an error, a state                       |
| `form`       | Quantity stepper, 7 participant fields, 2 consents, discount code, **estimated** price                         |
| `review`     | The backend quote: event, ticket type, quantity, holder, subtotal, discounts, **Total**                        |
| `submitting` | "Preparando tu pago" — the pay button is gone and the dialog refuses to close                                  |
| `verifying`  | "Verificando tu pago" — explicit that confirmation comes from ePayco and the backend, not from the return page |
| `confirmed`  | Branded thank-you, reference, holder, quantity and total from the **PAID** order, plus day-of instructions     |
| `pending`    | "Tu pago sigue en proceso" with the order reference and a "Consultar de nuevo" action                          |
| `problem`    | One Spanish explanation per failure kind, each with the actions that can actually help                         |

The **companion section lives inside `confirmed`**: a two-admission purchase shows a form for the
second person, which posts to `POST /orders/{reference}/participants`. A saved companion is replaced
by a confirmation note; a `CONFLICT` (already fully assigned) is shown as such, without inventing a
retry.

### Two-admission purchases

| Product                     | How the browser asks for it                         | Total    |
| --------------------------- | --------------------------------------------------- | -------- |
| Two General admissions      | `quantity: 2`, `ticketTypeCode: GENERAL`, no bundle | $400.000 |
| "Comparte esta experiencia" | `quantity: 2`, `bundleCode: DOUBLE_EXPERIENCE`      | $340.000 |

The bundle is a fixed-price product: the dialog shows its fixed total and does not offer a discount
code (the backend rejects a code on the bundle). The holder occupies the first admission; the
companion is attached after payment.

### Consents

Two checkboxes, **never pre-checked** — not even when a draft is restored, so consent is always a
deliberate act:

- **Tratamiento de datos personales** — mandatory (the backend rejects the order without it).
- **Próximos eventos** — optional; the order is accepted unchecked.

### Authoritative pricing

The form shows a price only as an explicit **estimate** ("Precio estimado. El valor definitivo se
confirma al continuar."), derived from the public `GET /events/{code}` tier. Every figure on the
`review` and `confirmed` steps is the backend's own number, formatted by `formatCopCents`. No price,
discount, tax or total is ever computed in the browser, and `POST /orders` is never sent a price.

## 4. Frontend action → backend endpoint

| Buyer action                    | Request                                 | Notes                                                                                          |
| ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Open the purchase dialog        | `GET /events/{code}`                    | Landing content + availability + current tier. `eventCode` from `VITE_EVENT_CODE`              |
| "Continuar al pago"             | `POST /orders/quote`                    | `{eventCode, ticketTypeCode, quantity, bundleCode?, discountCode?}`. Reserves nothing          |
| "Pagar …"                       | `POST /orders`                          | + header `Idempotency-Key`. Prices come back from the database, with the ePayco session        |
| ePayco handoff                  | _(browser, ePayco SDK)_                 | `checkout.epayco.co/checkout-v2.js` configured with the backend's `sessionId` and `test` flag  |
| Return (`/gracias?ref_payco=…`) | `POST /orders/{reference}/payment-hint` | Body `{transactionId}`, header `X-Buyer-Email`. Accelerates the webhook only                   |     | Return / pending / refresh | `GET /orders/{reference}` | Header `X-Buyer-Email`. **The only source of payment truth**, and the admission roster |
| "Intentar pagar de nuevo"       | `POST /orders/{reference}/retry`        | Body + header email; returns a fresh ePayco session for a new attempt                          |
| "Guardar acompañante"           | `POST /orders/{reference}/participants` | Body `{participant}`, header `X-Buyer-Email`. Only offered after the order is `PAID`           |
| "Consultar mi compra"           | `GET /orders/{reference}`               | Reference + email typed by the buyer; a wrong email is indistinguishable from an unknown order |

Never used by the frontend: `POST /check-in`, `GET /check-in/{token}`, `POST /webhooks-epayco`,
`POST /orders-maintenance`. The browser never talks to PostgreSQL, PostgREST or GraphQL.

### Error envelope

`{ ok: false, error: { code, message, details? } }` → `ApiError` with the documented code
(`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`,
`UPSTREAM_ERROR`, `INTERNAL_ERROR`) and the mapped `details.issues[]`, which the form shows against
the offending field.

**Documented limitation:** the backend deliberately does not surface the raw SQLSTATE reason, so a
`409` on `POST /orders` cannot be distinguished from the envelope (sold out vs. invalid code vs.
idempotency conflict). The frontend explains the overwhelmingly likely cause for that step — the
last admissions went to someone else — and says explicitly that no charge was made. The rich
`discountCode.reason` and `availability` are used from the **quote** response, before the money
path, so a bad or exhausted code never breaks the purchase.

## 5. Returning from ePayco, polling, refresh

1. `parseReturnContext(window.location)` reads `?ref_payco=` (ePayco), the legacy
   `?id=` / `?transaction-id=` params, an optional `?ref=`, and treats the `/gracias` path itself as
   a return. `/gracias` has no HTML file: `vercel.json` rewrites it to `index.html`. The return URL
   itself is the backend's `PAYMENT_RETURN_URL`, which is what the ePayco session carries as its
   `response`.
2. **Nothing in the URL is proof of payment.** The transaction id is forwarded to the payment-hint
   endpoint, which re-reads the transaction from ePayco before anything else happens. If the hint
   fails, the flow continues unchanged (the webhook still applies).
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
and shows the same PAID confirmation again. It never re-creates an order, because a re-render or
reload cannot change the `Idempotency-Key` of an attempt that already exists; the backend's partial
unique index is the guarantee, not the frontend.

The confirmation is rebuilt from the order projection, not from the form draft: `admissions`
carries `quantity`, `assigned` and `remainingUnassigned`, and `participants` lists the assigned
people in attachment order (unit 1 is the holder, names only). A reload therefore knows whether
the companion is already registered and hides the form when `remainingUnassigned` is `0`; the
stored companion data itself is deliberately never persisted in the browser.

## 6. Idempotency and duplicate protection

- `generateIdempotencyKey()` produces `order-<uuid v4>` (16–128 printable ASCII, the contract's
  range) **once per intentional purchase** and reuses it across retries of the same attempt, so a
  double click, a network retry and a component re-render all resolve to the same order.
- The key is rotated only when a **new** attempt is intentional: `POST /orders/{reference}/retry`
  and a full lookup/recovery.
- `submit()` is guarded three ways: it ignores a second call while `submitting`, ignores it after
  the handoff (`verifying`/`confirmed`), and the pay button is removed from the DOM the moment the
  request starts.

## 7. ePayco Smart Checkout V2

The backend creates the checkout session and returns the secret-free material the browser may hold:

```json
{
  "provider": "epayco",
  "sessionId": "…",
  "publicKey": "…",
  "test": true,
  "reference": "EVT-2026-000009",
  "amountInCents": 34000000,
  "currency": "COP",
  "redirectUrl": "https://…/gracias",
  "confirmationUrl": "https://…/functions/v1/webhooks-epayco"
}
```

`openEpaycoCheckout` loads `https://checkout.epayco.co/checkout-v2.js` on demand, calls
`ePayco.checkout.configure({ sessionId, type: "onpage", test })`, binds the lifecycle hooks and opens
the modal. It never accepts a private key, never computes an amount and never marks an order paid:
confirmation is the backend's webhook and the authoritative `GET /orders/{reference}` answer. A
checkout whose `provider` is not `epayco` is refused (the Wompi handoff is gone from this app).

## 8. No ticket, no QR

The confirmation screen shows the PAID order itself: branded thank-you, reference, holder, quantity,
total, the companion form when an admission is unassigned, and day-of instructions. Entry requires
the holder's identity document; nothing is generated, looked up or forwarded by email. The screen
never displays the cédula, the email or the phone of any participant.

A buyer who comes back later uses "Consultar mi compra" (reference + email) to see the same order;
that lookup is order status, not a ticket lookup, and a wrong email is indistinguishable from an
unknown reference (no enumeration).

**Known gap (deliberately out of scope here):** no purchase welcome email is implemented yet.

## 9. Failure states

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
| Companion already attached (409)       | Confirmation note: the purchase already has all its participants                          |
| Unknown order / wrong email            | `problem/not_found`, identical for both (no order enumeration) + a lookup form            |
| Rate limited / upstream / 5xx          | Generic, actionable Spanish copy. Never a stack trace, SQLSTATE, id or provider message   |

## 10. Environment variables

Only `VITE_*` values reach the bundle, and only values that are safe in a browser:

| Variable                | Default                                                                                            | Purpose                 |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ----------------------- |
| `VITE_API_BASE_URL`     | local stack in `vite dev`; `https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1` in `vite build` | Edge Functions base URL |
| `VITE_EVENT_CODE`       | `RESET-SUNSET-2026`                                                                                | Event the page sells    |
| `VITE_TICKET_TYPE_CODE` | `GENERAL`                                                                                          | Ticket type sold        |

The hosted project is the production default (Phase 6D): a `vite build` with no environment
variables talks to the deployed Edge Functions, while `vite dev` keeps talking to the local stack.
`src/config/env.ts` is the only file that names the project ref, and
`tests/frontend/hosted-config.test.ts` fails if it spreads or if another `VITE_` variable appears.

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

Never `VITE_`-prefix, and never ship: `SUPABASE_SECRET_KEY` / service-role key,
`EPAYCO_PRIVATE_KEY`, `EPAYCO_P_KEY`, `EPAYCO_CUST_ID_CLIENTE`, `RESEND_API_KEY`,
`GOOGLE_APPS_SCRIPT_SECRET`, `MAINTENANCE_API_TOKEN`, the database URL. Nothing in `src/` reads
them: the only ePayco values the browser holds are the session id and the public flags of the
checkout payload the backend returns.

## 11. Local development

```bash
npx supabase start                 # Postgres/PostgREST/Kong on 54321, DB on 54322
cp .env.example .env.local         # then set SUPABASE_SECRET_KEY (and dev-shaped ePayco values)
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
  shows the not-available state. To exercise the flow, insert an event (`status = 'PUBLISHED'`), a
  ticket type and a pricing tier whose sales window is open — the codes must match
  `VITE_EVENT_CODE` / `VITE_TICKET_TYPE_CODE`.
- `entradas.html` keeps General and Doble experiencia disabled ("Disponible al iniciar la etapa
  General") and time-locks Preventa until 24 October 2026 at 10:00 a.m. (America/Bogota); whether
  Preventa is actually buyable once that instant passes still comes from the backend availability
  response. Overriding the system clock is not a supported way to test: insert a tier whose window
  is open.
- The ePayco modal is only opened with a `sessionId` the backend created, so a local run needs the
  backend's ePayco configuration. Completing a payment locally requires sandbox credentials or
  driving `public.confirm_payment(...)` directly as `service_role` (this is what the Phase 6B
  verification did, for the _backend_ half of the confirmation).

## 12. Testing

`npm test` (or `npm run check` for the full gate). Frontend suites live in `tests/frontend/`:

| File                                        | What it protects                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purchase-helpers.test.ts`                  | Money/date formatting, availability labels, field validation (including the consent asymmetry), draft/correlation persistence, return-URL parsing (`ref_payco` included)                                                                                                                                                                 |
| `purchase-api.test.ts`                      | The envelope (success, failure, unknown code, non-JSON, missing envelope), timeout vs. caller abort, and the exact headers/bodies each endpoint must send                                                                                                                                                                                |
| `purchase-flow.test.ts`                     | The state machine: quote, order creation with a stable idempotency key, double-click protection, no-price-from-the-browser, every payment outcome, bounded/stopped/single polling, refresh + repeated returns, no false confirmation, companion attach for two General admissions and for the bundle, refusal of any non-ePayco checkout |
| `purchase-ui.test.ts`                       | The rendered dialog (fields, consents, totals, PAID-only thank-you, companion form, no ticket/QR/token), the confirmation's refusal to leak personal data, and the modal behaviour (focus, Escape, disabled close while submitting, caret retention while typing)                                                                        |
| `components.test.ts`                        | The rendered DOM of every landing section with the real client content: logo files, hero facts, ticket rows, the ally's real logo, pending states, and the absence of placeholder copy in the composed page                                                                                                                              |
| `content-config.test.ts`                    | The content contract: real metadata/prices/date/venue/contact, the client's inclusive sentence, and the negative assertions (no removed placeholder, no invented capacity, no discount code, no extra benefits, palette present)                                                                                                         |
| `legal-content.test.ts`                     | The client's legal documents (token/pending-field invariant, verbatim clauses, review notes), `renderLegalText` escaping, and the tabbed dialog's behaviour                                                                                                                                                                              |
| `cta-hook.test.ts`, `faq-accordion.test.ts` | CTA routing into the purchase flow, and the FAQ's collapse/arrow-key behaviour                                                                                                                                                                                                                                                           |

Nothing mocks away the thing under test: the API doubles return real documented response shapes,
and the flow tests assert on observable behaviour (which endpoint was called with what, which step
the buyer is on) rather than on implementation details.
