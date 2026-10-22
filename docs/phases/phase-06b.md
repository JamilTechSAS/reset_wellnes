# Phase 6B — Frontend Purchase Flow (buyer journey to digital ticket)

**Status: COMPLETE.** (2026-10-05)
**Backend Status: FROZEN.** (No backend change was needed; the contract in
[docs/api.md](../api.md) was sufficient for the whole journey.)

Phase 6B takes the Phase 6A Spanish landing page and wires it to the frozen backend so a buyer can
complete one unbroken journey:

```
landing → buy → quantity + participant data → server quote → order → Wompi checkout
        → payment → return → status polling → confirmation → ticket + QR → email status
```

The detailed, page-by-page reference for the frontend lives in [docs/frontend.md](../frontend.md).
This phase log records what was built, the endpoints integrated, the verification that was actually
performed, and what remains unverified.

---

## 1. Scope and non-goals

**In scope**

- Connect the existing CTAs to a real purchase dialog (quantity, participant data, consents).
- Server-side quote via `POST /orders/quote`; order creation via `POST /orders`.
- Wompi Web Checkout handoff built only from the backend's signed checkout payload.
- Return handling, status polling, refresh recovery, and repeated visits.
- Confirmation screen with the backend-issued digital ticket and QR.
- Honest email status, honest failure states, and no false confirmation.

**Out of scope (enforced)**

- No backend redesign; no new business rules; no browser-side pricing.
- The browser never touches PostgreSQL, PostgREST or GraphQL.
- No WhatsApp, no operator dashboard, no check-in/admin UI.
- No faked payment success and no treating a redirect as proof of payment.

**Backend boundary.** No Edge Function, migration or SQL function was modified in this phase. The
only backend interaction during verification was calling the **existing** service-role function
`public.confirm_payment(...)` by hand to drive the paid half of the journey locally (see §8).

---

## 2. What was built

| Area            | Files                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Config          | `src/config/env.ts` — the **only** reader of `import.meta.env`; resolves `FRONTEND_CONFIG`          |
| HTTP + contract | `src/api/client.ts`, `src/api/ticketing.ts`, `src/api/types.ts`                                     |
| Purchase logic  | `src/purchase/controller.ts` (state machine, the only module sequencing network calls)              |
| Pure helpers    | `src/purchase/format.ts`, `validation.ts`, `persistence.ts`, `wompi.ts`, `return-route.ts`, `qr.ts` |
| UI              | `src/components/PurchaseDialog.ts`, `src/components/TicketCard.ts`                                  |
| Styles          | `src/styles/purchase.css` (bottom sheet < 720px, centred card ≥ 720px) + `main.css` import          |
| Fix             | `src/styles/base.css` — see §9                                                                      |

Architectural rule: **logic is separated from rendering.** The controller owns state and policy;
the dialog renders whatever the state says and translates user intent into controller calls. Every
behaviour below is therefore unit-tested without a DOM.

---

## 3. Buyer journey (state machine)

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

- `closed` is a **state, not an error** (sold out / not on sale) and offers the contact link.
- `review` shows the backend quote only; the form shows an explicit **estimate** from the public
  event tier and labels it as such.
- `verifying` states that confirmation comes from Wompi, not the redirect.
- `confirmed` shows the backend ticket(s) + QR; `pending` offers "Consultar de nuevo".

### Consents

Two checkboxes, **never pre-checked** — including when a draft is restored, so consent is always a
deliberate act. "Tratamiento de datos personales" is mandatory; "Próximos eventos" is optional.

---

## 4. Backend endpoints integrated

| Buyer action               | Request                                 | Notes                                                                    |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| Open the purchase dialog   | `GET /events/{code}`                    | Landing content + availability + current tier                            |
| "Continuar al pago"        | `POST /orders/quote`                    | `{eventCode, ticketTypeCode, quantity, discountCode?}`; reserves nothing |
| "Pagar …"                  | `POST /orders`                          | + header `Idempotency-Key` (16–128 printable ASCII)                      |
| Handoff to Wompi           | _(browser navigation)_                  | `checkout.wompi.co/p/?…` built only from the order response              |
| Return (`/gracias?id=…`)   | `POST /orders/{reference}/payment-hint` | Body `{transactionId}`, header `X-Buyer-Email`                           |
| Return / pending / refresh | `GET /orders/{reference}`               | Header `X-Buyer-Email`; **the only source of payment truth**             |
| "Intentar pagar de nuevo"  | `POST /orders/{reference}/retry`        | Body + header email; fresh checkout for a new attempt                    |
| "Consultar mi compra"      | `GET /orders/{reference}`               | Reference + email typed by the buyer                                     |

**Never used by the frontend:** `POST /check-in`, `GET /check-in/{token}`, `POST /webhooks/wompi`,
`POST /orders-maintenance`, `POST/PUT /orders/{reference}/participants` (operator/Phase-5 surfaces).

### Documented contract limitation (no backend change requested)

The error envelope is `{ ok: false, error: { code, message, details? } }`, and the backend
deliberately **never surfaces the raw SQLSTATE reason**. A `409` on `POST /orders` therefore cannot
be distinguished between "sold out", "invalid discount code" and "idempotency conflict". The
frontend explains the overwhelmingly likely cause for that step (the last tickets went to someone
else) and says explicitly that no charge was made. The rich `discountCode.reason` and
`availability` are consumed from the **quote** response, i.e. before the money path, so a bad or
exhausted code never breaks a purchase. This is a knowing product decision, not a silent gap.

---

## 5. Authoritative pricing

No price, discount, tax or total is computed in the browser, and `POST /orders` is never sent a
price. Every figure on `review` and `confirmed` is the backend's own number rendered by
`formatCopCents`. The Wompi URL is serialized from the backend payload only; the integrity
signature is never recomputed (it covers `reference + amount-in-cents + currency (+ expiration)`,
so any edit would be rejected — or charge a different amount).

---

## 6. Idempotency, refresh and duplicate protection

- `generateIdempotencyKey()` → `order-<uuid v4>` **once per intentional purchase**, reused across
  retries of the same attempt, so a double click, a network retry or a re-render resolve to one order.
- The key rotates only for a **new** intentional attempt (`POST /orders/{reference}/retry`, full
  lookup/recovery). After a successful `createOrder` it is reset, so a **second** purchase in the
  same session gets a fresh key — an attempt whose outcome is unknown keeps its key.
- `submit()` is guarded three ways: it ignores a second call while `submitting`, ignores it after the
  handoff (`verifying`/`confirmed`), and the pay button is removed from the DOM when the request starts.
- The session correlation (reference + buyer email) is **kept after a confirmed payment** so a
  refresh or a re-opened `/gracias` re-reads the same order and shows the same ticket. It cannot
  re-create an order, and a `PAID` order can only ever produce its original tickets (the backend's
  `unique (order_item_id, order_item_seq)` is the guarantee).
- Polling runs every **4 s** for at most **90 s**, stops on a terminal state or unmount/close, and a
  generation counter guarantees only one loop can run across a superseded refresh.

---

## 7. Wompi handoff (client-safe payload only)

The backend returns exactly what the browser is allowed to hold — `publicKey`, `currency`,
`amountInCents`, `reference`, `integritySignature`, `expirationTime`, `redirectUrl`,
`customerData`. `buildWompiCheckoutUrl` serializes those into Wompi Web Checkout and nothing more.

**The redirect is a hint, never proof.** On return, the transaction id is forwarded to
`payment-hint` (which re-reads the transaction from Wompi with the private key) and the only payment
truth is a subsequent `GET /orders/{reference}`. If the hint fails, the flow continues unchanged;
the webhook and the reconciliation sweep still apply.

---

## 8. Ticket and QR

The ticket is whatever `GET /orders/{reference}` returns; the frontend never mints a token. The QR
(`qrcode-generator`, EC level M) encodes **only** the opaque `TKT_` + 20 Crockford-base32 token
(≈100 bits) — no cédula, email, phone, order id or URL — so a screenshot is useful only at the door.
The SVG is scalable (`cellSize: 5`, `margin: 2`, no fixed pixel size) and dark-on-light, which is
what a scanner and a printer need. The confirmation screen never displays the cédula, email or phone.

---

## 9. Bugs found by real browser QA (and fixed)

These were **not** visible to the unit tests — only the browser run exposed them:

1. **Focus lost on every keystroke.** The dialog's wholesale `innerHTML` re-render dropped the
   caret. Fixed with `captureFocus()`/`restoreFocus()` (guarded `selectionStart`, `CSS.escape`).
2. **Confirmation had no event data on a direct `/gracias` resume.** `ensureEvent()` now loads the
   public event when it is still `null` (best-effort; failures ignored).
3. **Email "unknown" copy implied a send.** Replaced with an honest line that makes no claim.
4. **A second purchase reused the first order's idempotency key.** The key is now reset after a
   successful `createOrder`.
5. **Oversized eyebrow icons.** Every eyebrow-badge SVG rendered at the SVG default replaced-element
   size (166×166 on the hero) because no global `.icon` rule existed. Fixed in `base.css` with
   `.eyebrow-badge .icon { width: 1.15em; height: 1.15em; flex: 0 0 auto }`.

---

## 10. Accessibility and responsive QA

Performed in a real browser with measurement (not eyeballed):

- **1280 × 900 (desktop):** panel 552 px centred, radius 22 px, overlay `align-items: center`,
  field grid 2 columns.
- **390 × 844 (mobile):** no horizontal overflow (`documentElement.scrollWidth == innerWidth == 390`)
  and **zero** tap targets under 44 px inside the panel.
- **820 × 1180 (tablet):** panel 552 px, field grid `243px 243px`.

The dialog keeps a single `closable` flag (from the step) that disables `.purchase-close` and gates
Escape, backdrop and close; focus is restored on dismiss; `.sr-only` labels, an `.icon-spin` with a
`prefers-reduced-motion` opt-out, and a sticky footer are in place.

---

## 11. Test coverage and results

Frontend suites (`tests/frontend/`, 8 files, 192 tests):

| File                       | Tests | What it protects                                                                                                                                                                 |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purchase-helpers.test.ts` | 53    | Money/date formatting, availability labels, email-status honesty, validation, persistence, return-URL parsing, Wompi URL, QR                                                     |
| `purchase-api.test.ts`     | 22    | Envelope success/failure/unknown-code/non-JSON, timeout vs. caller abort, exact headers/bodies                                                                                   |
| `purchase-flow.test.ts`    | 52    | State machine: quote, stable idempotency key, double-click protection, no browser pricing, every payment outcome, bounded/stopped/single polling, refresh, no false confirmation |
| `purchase-ui.test.ts`      | 32    | Rendered dialog, ticket, QR, refusal to leak personal data or over-claim email, modal focus/Escape/close gating, caret retention                                                 |
| `content-config.test.ts`   | 11    | Phase 6A landing-page copy completeness and `es-CO` locale                                                                                                                       |
| `components.test.ts`       | 12    | Phase 6A semantic landmarks, headings, accessibility attributes (updated for the purchase flow)                                                                                  |
| `cta-hook.test.ts`         | 7     | CTA event dispatching and routing into the purchase dialog (rewritten for Phase 6B)                                                                                              |
| `faq-accordion.test.ts`    | 3     | Phase 6A FAQ collapse/toggle and keyboard navigation                                                                                                                             |

Fixtures (`support/ticketing-fixtures.ts`) return real documented response shapes; nothing mocks
away the thing under test. The **frontend total is 192 tests in 8 files**; the backend is unchanged
at 439 tests in 43 files.

**Full gate — `npm run check` → exit 0:**

| Check                               | Result                                                         |
| ----------------------------------- | -------------------------------------------------------------- |
| `typecheck` (`tsc --noEmit`)        | 0 errors                                                       |
| `lint` (ESLint `strictTypeChecked`) | 0 findings                                                     |
| `format:check` (Prettier)           | all files compliant                                            |
| `functions:check` (Deno)            | 0 errors                                                       |
| `test` (Vitest)                     | **631 tests in 51 files passing** (439 backend + 192 frontend) |

---

## 12. Real local end-to-end verification

The whole journey was driven in a real browser against the running local backend (Vite on
`http://localhost:3000`, Edge Functions on `127.0.0.1:54321`), with a synthetic event
(`TAT-2026` / `GENERAL` / tier "Fase 1" @ 9 500 000 centavos) inserted as `service_role`:

1. Landing → `#hero-buy-btn` → dialog form filled (Ana Pérez, cédula 1023456789,
   `ana.compradora@example.com`, +57 3001234567, Medellín) with the mandatory consent checked.
2. Quote `$190.000` → review → "Pagar $95.000".
3. **Browser navigated to**
   `https://checkout.wompi.co/p/?public-key=…&amount-in-cents=9500000&reference=EVT-2026-000009&signature:integrity=3c86d62a…&redirect-url=…`
4. **Database confirmed** one order `EVT-2026-000009 | PENDING | 9500000 | ana.compradora@example.com`
   plus one `pending` payment row — so the reference, the handoff and the idempotency key all came
   from the backend. Rate-limit counters confirmed the calls:
   `orders:create=1`, `orders:quote=1`, `events:read`, `orders:hint=1`, `orders:status=9`.
5. Navigating to `/gracias?id=1234-5678-9012` resumed correctly: the dialog showed the verifying
   screen, polled until the 90 s window closed, and then showed the honest **pending** screen — the
   correct behaviour for an order that is not yet paid (the redirect alone is not proof).
6. The paid half was then driven through the **real** backend function as `service_role`:
   `select public.confirm_payment('EVT-2026-000009', …, 'APPROVED', 9500000, 'COP', 'CARD', …)`
   → `APPLIED / PAID / 1 ticket issued`, token `TKT_99GDMPW9P133GNAF5AEH`. Clicking
   "Consultar de nuevo" showed the **confirmed** screen with the ticket card, the QR, and the honest
   queued-email sentence (the local `EMAIL_ENABLED=false` outbox state).
7. QA data was consequently truncated and the synthetic event removed; the database is empty again
   (`events=0 orders=0 tickets=0 payments=0 …`).

---

## 13. Not verified live (reported as conditions, not as passes)

- **Live Wompi sandbox payment** — no Wompi credentials in this repository. The handoff URL, the
  signature pass-through and the confirmation pipeline were verified locally, but no real charge,
  webhook or sandbox transaction was executed.
- **Live Resend delivery** — `EMAIL_ENABLED=false` locally; the outbox stays queued, which is a
  valid visible state, and the UI is written to say so rather than claim a send.
- **Hosted Supabase project** and **Google Sheets projection** — no hosted project exists here.

These are pre-sales gates, not code gaps: each is recorded in §5 of
[docs/testing.md](../testing.md) and the closure report.

---

## 14. Remaining conditions

1. Load real business data before launch: `supabase/seed.sql` is intentionally empty, so with an
   empty database the dialog correctly shows `closed`. An event with `status = 'PUBLISHED'`, a ticket
   type and an open pricing tier must be inserted, with codes matching `VITE_EVENT_CODE` /
   `VITE_TICKET_TYPE_CODE`.
2. Set the four `VITE_*` variables in the deploy environment (they are deliberately **not** in
   `.env.example`; see [docs/frontend.md §11](../frontend.md)).
3. Enable and verify Wompi sandbox plus Resend (and the Sheets projection) against the hosted project
   before the first sale.
4. The documented `409`-ambiguity limitation on `POST /orders` (see §4) is accepted as-is.
