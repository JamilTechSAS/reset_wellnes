# Phase 6D — Real frontend ↔ hosted Supabase backend integration

**Status: PASS WITH CONDITIONS.** The frontend now targets the hosted project and the whole buyer
journey was executed end to end against the frozen backend. The hosted deployment itself cannot
serve a single buyer request yet: **none of the application secrets are configured on
`pzogdjjdkgolybfcegcs`**, so every endpoint answers `500 INTERNAL_ERROR` ("La configuración del
backend está incompleta."). That is an operator/credential dependency, not a code defect, and §7
lists it exactly. One real backend defect was found by running the flow (§5).

Date: 2026-10-07. Backend source: **not modified** (§10).

## 1. Objective and outcome

| Goal                                          | Outcome                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Frontend uses the hosted Functions URL        | Done — production builds default to it; one constant, one file (§3)           |
| Canonical event code, no `TAT-2026`           | Done — `RESET-SUNSET-2026` everywhere production-facing, enforced by a test   |
| `GET /events/{code}` against hosted           | **Blocked**: hosted answers `500` (configuration incomplete)                  |
| Quote → order → Wompi handoff against hosted  | **Blocked** for the same reason                                               |
| Same journey against the frozen backend, real | Done locally: `200` → `204/200` → `204/201` → Wompi URL from the backend (§4) |
| Event data inserted into hosted               | Not inserted — inventory and sales windows are still missing (§6)             |
| No browser database access, no secrets        | Verified: only the four public `VITE_*` variables reach the bundle (§3, §9)   |

## 2. Hosted project and recorded endpoint responses

Project ref `pzogdjjdkgolybfcegcs`, base URL `https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1`.
`npx supabase migration list` shows the local 22 migrations 1:1 with the remote ones, and
`npx supabase secrets list` shows **only** the platform-reserved names (`SUPABASE_ANON_KEY`,
`SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`) — no application secret is set.

Every call below was made against the live deployment (2026-10-07, curl, real responses):

| Request                                         | HTTP | Body                                                          |
| ----------------------------------------------- | ---- | ------------------------------------------------------------- |
| `GET /health`                                   | 500  | `INTERNAL_ERROR` + `details.issues` naming the 7 missing vars |
| `GET /events/RESET-SUNSET-2026`                 | 500  | `{"ok":false,"error":{"code":"INTERNAL_ERROR", …}}`           |
| `GET /events/RESET-SUNSET-2026/availability`    | 500  | same                                                          |
| `OPTIONS /events/X` (preflight, `Origin` = dev) | 500  | **no `access-control-allow-origin` header**                   |
| `POST /orders/quote`                            | 500  | same                                                          |
| `POST /orders` (with `Idempotency-Key`)         | 500  | same                                                          |
| `GET /orders/ORD-X` (`X-Buyer-Email`)           | 500  | same                                                          |
| `POST /orders/ORD-X/retry`                      | 500  | same                                                          |
| `POST /orders/ORD-X/payment-hint`               | 500  | same                                                          |

Missing on the hosted project, exactly as reported by `/health`:

```
SUPABASE_SECRET_KEY, WOMPI_PUBLIC_KEY, WOMPI_PRIVATE_KEY, WOMPI_INTEGRITY_SECRET,
WOMPI_EVENTS_SECRET, PUBLIC_WEB_BASE_URL, API_BASE_URL
```

(`CORS_ALLOWED_ORIGINS`, `MAINTENANCE_API_TOKEN` and `RESEND_*` are required too once `APP_ENV` is
`sandbox`/`production`, which is the intended setting for this deployment.)

The responses are the backend's own fail-fast validation working as designed: it refuses to start
with an incomplete environment and names **variables only**, never values. Nothing was weakened to
make the frontend "work".

## 3. Frontend configuration (the change this phase makes)

`src/config/env.ts` is the single place a backend URL can come from:

- `LOCAL_API_BASE_URL` = `http://127.0.0.1:54321/functions/v1` (dev default, unchanged)
- `HOSTED_API_BASE_URL` = `https://pzogdjjdkgolybfcegcs.supabase.co/functions/v1` (**new**: the
  default for a production build, so `npm run build` with no environment variables reaches the real
  project instead of a developer's laptop)
- `DEFAULT_EVENT_CODE` = `RESET-SUNSET-2026` (replaces the placeholder event's code)
- `DEFAULT_TICKET_TYPE_CODE` = `GENERAL` (unchanged; operator data either way)

`loadFrontendConfig(env)` takes an explicit record; `FRONTEND_CONFIG` lists the four `VITE_*`
values plus Vite's own `PROD` flag, so the bundle can only ever read a shortest-possible list.

Verification: `tests/frontend/hosted-config.test.ts` (9 tests) asserts the hosted/dev defaults, the
canonical code and its database-check shape, code normalization, the Wompi URL, that the project ref
appears in **exactly one** file, that the only `VITE_*` names in the config are the four documented
in this repository's frontend docs, and that no production-facing file (`src/**`, `public/**`,
`index.html`) contains `TAT-2026`, `Medellín`, `El Poblado`, `21 de noviembre`, `evento.ejemplo`,
`evento_oficial_2026` or `Experiencia Exclusiva`. The production bundle was inspected: it contains
the hosted URL and `RESET-SUNSET-2026`.

## 4. End-to-end verification against the frozen backend

The hosted project cannot answer a buyer request, so the same journey was executed against the
**frozen backend code** (unmodified Edge Functions) over the local stack, with the client's real
event values in the local database.

**A tooling blocker had to be worked around first.** `supabase functions serve --env-file .env.local`
cannot boot this backend under Supabase CLI 2.119:

```
Env name cannot start with SUPABASE_, skipping: SUPABASE_URL
Env name cannot start with SUPABASE_, skipping: SUPABASE_SECRET_KEY
```

The CLI strips `SUPABASE_*` names from the env file, and the frozen backend requires the exact name
`SUPABASE_SECRET_KEY`; the result is `/health` answering `500` even locally. The verification
therefore ran each function with plain Deno (no such restriction) behind a small local router that
maps `/functions/v1/<name>/…` to the function's port. That harness is **not** part of the delivered
project; making it a first-class `scripts/` launcher is listed in §11.

Recorded responses (real HTTP, through the same paths the browser uses):

| Step                                         | Result                                                                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                | `200` — `environment: development`, `wompiEnvironment: sandbox`                                                                                                                                     |
| `GET /events/RESET-SUNSET-2026`              | `200` — name, `venue.city` Montería, `venue.name` Terraza del hotel GHL, `venue.address` null, `startsAt 2026-11-15T18:00:00Z`, `endsAt 2026-11-16T00:00:00Z`, `America/Bogota`, `COP`, `PUBLISHED` |
| `GET /events/…/availability`                 | `200` — `AVAILABLE`                                                                                                                                                                                 |
| `POST /orders/quote` (GENERAL × 1)           | `200` — tier `Preventa`, unit/total **16000000** centavos                                                                                                                                           |
| `POST /orders/quote` (COMPARTE × 2)          | `200` — unit **17000000**, total **34000000** centavos                                                                                                                                              |
| `POST /orders`                               | `201` — reference `EVT-2026-000013`, `PENDING`, checkout `amountInCents 16000000`, integrity signature present, `redirectUrl http://localhost:3000/gracias`                                         |
| `GET /orders/{ref}` (`X-Buyer-Email`)        | `200` — `PENDING`, 0 tickets (nothing is issued before payment)                                                                                                                                     |
| `GET /orders/{ref}` (wrong email)            | `404 NOT_FOUND` — order-scoped access holds                                                                                                                                                         |
| `POST /orders/{ref}/retry`                   | `409 CONFLICT` (`ORDER_NOT_RETRYABLE`) while the first attempt is still pending                                                                                                                     |
| `POST /orders/{ref}/payment-hint` (bogus id) | `200` — outcome `TRANSACTION_NOT_FOUND`, order still `PENDING`                                                                                                                                      |

The **browser** then ran the same journey through the real UI (dev server pointed at the local
verification backend, 1280×900):

```
GET  /events/RESET-SUNSET-2026            → 200
OPTIONS + POST /orders/quote              → 204 / 200
OPTIONS + POST /orders                    → 204 / 201
GET  /orders/EVT-2026-000013              → 200
GET  https://checkout.wompi.co/p/?public-key=…&amount-in-cents=16000000
      &reference=EVT-2026-000013&signature:integrity=…                → 403 (dev placeholder key)
```

The dialog showed the backend's numbers (`$160.000`, "Entrada general · Preventa"), the reservation
deadline from the quote, and the Wompi URL carried the backend's `amount-in-cents` and
`signature:integrity` **verbatim** — the browser computed nothing. The `403` is expected: the local
keys are development placeholders, so no payment was attempted and no credential exists in the
bundle.

The `/gracias` return flow was exercised too (`/gracias?id=…`): it resumed the order from local
storage, called `payment-hint`, polled `GET /orders/{ref}`, and stated _"Confirmamos tu compra
directamente con Wompi, no con la página de regreso"_ while continuing to show `PENDING`. It never
claimed a payment (§14 of the brief).

## 5. Defect found by running the flow (reported, not patched)

**`POST /orders` with a repeated `Idempotency-Key` answers `500 INTERNAL_ERROR`.**

```
attempt 1: HTTP 201 {"reference":"EVT-2026-000011","replayed":false, …}
attempt 2: HTTP 500 {"ok":false,"error":{"code":"INTERNAL_ERROR", …}}
```

Cause, with evidence:

- `public.create_order` returns two different payloads. Fresh creation includes
  `totalDiscountInCents` and `discountCombination`; the **replay** branch
  (`supabase/migrations/20261003210009_order_creation.sql`, the `replayed = true`
  `jsonb_build_object`) omits both keys. Calling the RPC directly confirms it:
  `fresh -> …,totalDiscountInCents,totalInCents,…` vs
  `replay -> …,no totalDiscountInCents, no discountCombination…`.
- `handleCreateOrder` (`supabase/functions/_shared/api/orders-handler.ts`) passes
  `totalDiscountInCents` into `verifyNumbers(...)` on **every** request, fresh or replayed, which
  runs `copCents(undefined)` and throws → the `INTERNAL_ERROR` logged as
  `order request rejected … code: INTERNAL_ERROR … detail: null`.
- The replay payload is never covered by the handler tests (they use a gateway double with the full
  shape), which is why 439 backend tests stay green while the path is broken.

Why it matters for the buyer journey: the frontend reuses its idempotency key when it retries an
order creation (the exact scenario the header exists for). A buyer whose first `POST /orders`
response is lost — flaky connection, tab closed at the wrong moment — gets a `500` from every retry
instead of the replayed order, even though the order was created and its inventory is reserved.

Smallest possible fix (deliberately **not** applied — the backend is frozen):

```sql
-- in the `replayed = true` jsonb_build_object of public.create_order
'totalDiscountInCents', v_existing.total_discount_cents,
'discountCombination',  v_existing.discount_combination,
```

plus one handler/schema test that asserts the replay payload carries the same keys as creation.

## 6. Event data: what was and was not inserted

**Nothing was inserted into the hosted project.** No migration was added, no row was written, no
documentation-only seed was executed against it.

Reasoning (brief §8/§9): the schema happily allows a `PUBLISHED` event with `capacity = null` and
tiers with `quantity_limit = null` and no sales window — but that publishes a catalogue where all
three products sell **simultaneously and without any inventory bound**. The client has still not
supplied capacity, per-tier inventory, or stage dates, so that configuration would be a business
decision made on the client's behalf. The safest supported configuration for data that is complete
enough to be true but not complete enough to sell is: leave the hosted database untouched and keep
the operator checklist in `supabase/seed.sql`.

Product modelling was settled as far as the schema allows, with evidence:

- The client's own `entradas-config.js` states the stage model: `fase: "preventa"` → _"se vende la
  preventa; la general aparece como 'próximamente'"_, and `fase: "general"` → _"la preventa aparece
  como 'agotada' y se vende la general"_. Two strategies of one ticket type (`Preventa` seq 1 →
  `General` seq 2) express exactly that; the page copy added in 6C is faithful to it.
- `Comparte esta experiencia (2)` is priced at `$340.000` = `$170.000` per person, and the backend
  has no bundle/pack concept: `unit_price × quantity = line_total` and one ticket per unit. It is
  therefore either **its own ticket type** at `17000000` centavos with `min_per_order = 2`
  (recommended: it needs no new concept and gives the product its own inventory), or a
  `quantity_discounts` row of 15 % on `General` at quantity ≥ 2 (which produces exactly `$340.000`
  from `2 × $200.000`). The client's material never calls it a discount, and whether it is on sale
  during preventa is not stated — the same file gives it its own payment link but only models two
  stages. **Client confirmation required**; nothing was written on the strength of an inference.

Local verification used the first option (its own ticket type, `GENERAL` with a `Preventa` tier at
`16000000` and a `General` tier at `20000000`) with `capacity`, `quantity_limit`, sales windows and
`venue_address` all `NULL`, no discounts, and a `PUBLISHED` status that is appropriate for a local
fixture only. That fixture lives in the local Docker database, not in the repository.

## 7. Conditions

Blocking the hosted buyer journey (operator actions, no code change involved):

1. Set the seven missing hosted secrets (`docs/environments.md` §2, `npx supabase secrets set
--env-file .env.sandbox --project-ref pzogdjjdkgolybfcegcs`), including the Wompi **sandbox**
   keys and `CORS_ALLOWED_ORIGINS` for the real site origin.
2. Insert the event once the client confirms capacity, per-tier inventory and stage dates — and
   decide the `Comparte esta experiencia` model above (§6).
3. Live Wompi sandbox payment, live Resend sender identity, Google Sheets credentials, published
   domain: unchanged pre-launch dependencies.

Also unresolved from 6C and still unresolved here: exact street address/map link, dress-code colour,
legal entity name/NIT/cédula, policy date, event photography (and raster OG image), additional ally
logos with publication permission, payment methods to advertise, official font files.

## 8. Browser QA (real viewports, measured)

| Viewport     | Result                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1280×900** | Full logo lockup; purchase dialog ran the whole journey (event → quote → order → Wompi handoff); `scrollWidth 1263 < 1280`; one `<h1>`; 5 `<img>` (all sized, GHL lazy); zero banned placeholders         |
| **390×844**  | Short logo only, full lockup hidden; `scrollWidth 373 < 390`; 6 nav links; sticky bar hidden at the top and `is-visible` after the hero scrolls past (bar settles at `top 857` inside an 844 px viewport) |
| **820×1180** | Full logo lockup; `scrollWidth 803 < 820`; 6 nav links; sticky bar `is-visible` when scrolled                                                                                                             |

No console errors; the only failed request in the whole session was the Wompi `403` caused by the
development placeholder public key (§4).

## 9. Tests

| Check                     | Result                                           |
| ------------------------- | ------------------------------------------------ |
| `npm run typecheck`       | 0 errors                                         |
| `npm run lint`            | 0 problems                                       |
| `npm run format:check`    | clean                                            |
| `npm run functions:check` | 0                                                |
| `npm run test`            | **665 tests in 53 files passing** (was 656/52)   |
| — backend                 | 439 tests / 43 files (unchanged)                 |
| — frontend                | 226 tests / 10 files (was 217/9)                 |
| `npm run build`           | OK — 3.64 kB HTML, 45.19 kB CSS, 131.55 kB JS    |
| Browser QA                | 3 viewports + the full purchase journey (§4, §8) |

Frontend changes: `tests/frontend/hosted-config.test.ts` (new, 9 tests); the shared fixtures now
speak the real event (`RESET-SUNSET-2026`, `Re set Sunset — Vol. 1`, `Terraza del hotel GHL`,
Montería, `Preventa` at `16000000`) instead of the placeholder event, with `purchase-api`,
`purchase-flow`, `purchase-helpers` and `purchase-ui` updated accordingly. The not-found copy for a
missing event now reads _"El evento aún no está disponible para compra. Escríbenos y te avisamos
cuando las ventas abran."_ (brief §23), rendered with the real support email/WhatsApp.

## 10. Backend

**No backend source code was modified.** No migration, no Edge Function, no RLS policy, no pricing,
payment, ticket, QR, rate-limit, check-in, outbox or Sheets change. The actions taken against
databases were: inserts into the **local** Docker database (fixture, §6) and read-only inspection of
the hosted project (HTTP calls, `supabase secrets list`, `supabase migration list`).

The defect in §5 is reported with its evidence and its smallest fix rather than patched, per the
phase's change policy.

## 11. Recommended follow-ups

1. Apply the §5 one-line SQL fix and add the replay-payload test (backend, small, high value).
2. Make the local backend runnable again: either pin a Supabase CLI whose `functions serve` passes
   `SUPABASE_*` names, or turn the verification harness of §4 into a documented `scripts/` launcher
   (router + port shim + `npm run functions:serve:deno`).
3. Seed the hosted event the moment inventory and stage dates arrive, then repeat §4 against the
   hosted URL with sandbox Wompi keys; the maintained operator checklist is `supabase/seed.sql`.
4. Confirm the `Comparte esta experiencia` model and its availability during preventa (§6).
