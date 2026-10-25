/**
 * One inventory for the whole event and the exact sales windows (migrations 20261024230000 and
 * 20261024240000).
 *
 * Product rules under test (America/Bogota, 2026 — fixed UTC-5):
 *   * 100 admissions for the event, shared by Preventa, General and the package. No stage has
 *     its own allocation any more (`pricing_tiers.quantity_limit` is cleared).
 *   * Preventa COP 159.900 · 10:00 25 oct → 23:59 28 oct · half-open, so it is already closed
 *     at 00:00:00 on 29 oct.
 *   * NO SALES from 00:00:00 to 00:00:59.999 on 29 oct — General does not move to midnight.
 *   * General COP 199.900 · 00:01 29 oct → 23:59 13 nov · multi-admission.
 *   * "Comparte tu experiencia" (`SHARE_EXPERIENCE`) · 3 admissions · COP 509.700, sold only
 *     during the General window; the retired two-admission `DOUBLE_EXPERIENCE` stays readable
 *     but is inactive.
 *
 * Time is injected, never waited for: `app_private.active_pricing_tier_id` and
 * `app_private.event_sales_summary` both take the instant, and `expire_pending_orders` takes
 * `p_now`, so every boundary below is asserted at the exact millisecond.
 *
 * What PGlite cannot do: two genuinely concurrent sessions. Reservation serialization lives in
 * `app_private.reserve_pricing_tier`, which takes a row lock on the event before re-reading the
 * pool; the tests prove the single-statement outcomes (no oversell, package needs three) and
 * that the backstop trigger aborts an out-of-pool write from any other statement.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS_DIR, applyMigrations } from "./helpers.ts";

const EVENT = "RESET-SUNSET-2026";
const MIGRATIONS = [
  "20261024230000_global_inventory_share_experience.sql",
  "20261024240000_general_price_199900.sql",
] as const;

/** The shipped windows, written as the instants the database stores (UTC). */
const PRESALE_OPENS = "2026-10-25T15:00:00Z"; // 25 oct 10:00 Bogotá
const PRESALE_ENDS = "2026-10-29T05:00:00Z"; // 29 oct 00:00 Bogotá (exclusive)
const GENERAL_OPENS = "2026-10-29T05:01:00Z"; // 29 oct 00:01 Bogotá
const GENERAL_ENDS = "2026-11-14T05:00:00Z"; // 14 nov 00:00 Bogotá (exclusive)

const PARTICIPANT = JSON.stringify({
  firstName: "Ana",
  lastName: "Pérez",
  nationalId: "1.020.456.789",
  email: "ana@example.com",
  phone: "+57 300 123 4567",
  city: "Bogotá",
  consents: { dataProcessing: true, futureEvents: false },
});

type Quote = {
  quantity: number;
  pricingTier: { name: string; sequence: number; unitPriceInCents: number };
  subtotalInCents: number;
  totalInCents: number;
  bundleCode?: string;
};

type Order = {
  reference: string;
  quantity: number;
  totalInCents: number;
  pricingTierName: string;
};

type SalesSummary = {
  salesOpen: boolean;
  availability: string;
  serverTime: string;
  ticketTypes: {
    code: string;
    salesOpen: boolean;
    availability: string;
    maxPerOrder: number | null;
    currentTier: { name: string; maxPerOrder: number | null; priceInCents: number } | null;
    salesWindow: { startsAt: string | null; endsAt: string | null } | null;
  }[];
};

type Snapshot = {
  capacity: number | null;
  reserved: number;
  sold: number;
  remaining: number | null;
};

let db: PGlite;

async function rejection(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    const record = error as { message?: string; detail?: string };
    return `${record.message ?? ""} ${record.detail ?? ""}`;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

/**
 * The catalog as it looked BEFORE this migration: a 30/70 stage split, a COP 160.000 Preventa
 * with no explicit windows, and the retired two-admission package. Re-applying the real
 * migration file on top is what the assertions below then read.
 */
async function seedLegacyCatalog(): Promise<void> {
  await db.exec(`
    truncate table public.orders, public.pricing_tiers, public.ticket_bundles,
                   public.ticket_types, public.events cascade;

    insert into public.events (code, name, starts_at, status, currency, capacity)
    values ('${EVENT}', 'Re set Sunset — Vol. 1', timestamptz '2026-11-15 20:00:00+00',
            'PUBLISHED', 'COP', 120);

    insert into public.ticket_types (event_id, code, name)
    select id, 'GENERAL', 'Entrada general' from public.events where code = '${EVENT}';

    insert into public.pricing_tiers
      (ticket_type_id, name, sequence, price_cents, quantity_limit, max_per_order,
       sales_starts_at, sales_ends_at, is_active)
    select id, 'Preventa', 1, 16000000, 30, 1, null, null, true
      from public.ticket_types where code = 'GENERAL';

    insert into public.pricing_tiers
      (ticket_type_id, name, sequence, price_cents, quantity_limit, max_per_order,
       sales_starts_at, sales_ends_at, is_active)
    select id, 'General', 2, 20000000, 70, null, null, null, true
      from public.ticket_types where code = 'GENERAL';

    insert into public.ticket_bundles
      (event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents)
    select tt.event_id, tt.id, t.id, 'DOUBLE_EXPERIENCE', 'Doble experiencia', 2, 34000000
      from public.ticket_types tt
      join public.pricing_tiers t on t.ticket_type_id = tt.id and t.sequence = 2
     where tt.code = 'GENERAL';
  `);
  // The migrations under test, applied in order to a catalog that already exists (staging's shape).
  for (const migration of MIGRATIONS) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, migration), "utf8"));
  }
}

/**
 * Puts the stage under test inside its window around the real clock, so `now()` — which is what
 * every purchase function reads — lands where the test needs it. The shipped instants themselves
 * are asserted above, against `active_pricing_tier_id`, with an injected clock.
 */
async function openPreventaStage(): Promise<void> {
  await db.exec(`
    update public.pricing_tiers
       set sales_starts_at = now() - interval '1 day', sales_ends_at = now() + interval '1 day'
     where sequence = 1;
    update public.pricing_tiers
       set sales_starts_at = now() + interval '2 days', sales_ends_at = now() + interval '30 days'
     where sequence = 2;
  `);
}

async function openGeneralStage(): Promise<void> {
  await db.exec(`
    update public.pricing_tiers
       set sales_starts_at = now() - interval '2 days', sales_ends_at = now() where sequence = 1;
    update public.pricing_tiers
       set sales_starts_at = now() - interval '1 minute', sales_ends_at = now() + interval '30 days'
     where sequence = 2;
  `);
}

/** Closes every window, the way the catalog looks during the gap and after the campaign. */
async function closeAllStages(): Promise<void> {
  await db.exec(`
    update public.pricing_tiers
       set sales_starts_at = now() - interval '2 days', sales_ends_at = now() where sequence = 1;
    update public.pricing_tiers
       set sales_starts_at = now() + interval '1 minute' where sequence = 2;
  `);
}

async function stageAt(instant: string): Promise<string | null> {
  const result = await db.query<{ id: string | null }>(
    `select app_private.active_pricing_tier_id(
              (select id from public.ticket_types where code = 'GENERAL'),
              '${instant}'::timestamptz, 1) as id`,
  );
  return result.rows[0]?.id ?? null;
}

async function stageNameAt(instant: string): Promise<string | null> {
  const id = await stageAt(instant);
  if (id === null) {
    return null;
  }
  const result = await db.query<{ name: string }>(
    `select name from public.pricing_tiers where id = '${id}'`,
  );
  return result.rows[0]?.name ?? null;
}

async function salesSummaryAt(instant: string): Promise<SalesSummary> {
  const result = await db.query<{ s: SalesSummary }>(
    `select app_private.event_sales_summary(e, '${instant}'::timestamptz) as s
       from public.events e where e.code = '${EVENT}'`,
  );
  const row = result.rows[0]?.s;
  if (row === undefined) {
    throw new Error("event_sales_summary returned no row");
  }
  return row;
}

async function snapshot(): Promise<Snapshot> {
  const result = await db.query<{ s: Snapshot }>(
    `select app_private.event_inventory_snapshot(
              (select id from public.events where code = '${EVENT}')) as s`,
  );
  const row = result.rows[0]?.s;
  if (row === undefined) {
    throw new Error("event_inventory_snapshot returned no row");
  }
  return row;
}

async function quote(quantity: number, bundleCode: string | null = null): Promise<Quote> {
  const sql =
    bundleCode === null
      ? `select public.quote_order_price('${EVENT}','GENERAL',${String(quantity)},15,null) as q`
      : `select public.quote_bundle_order_price('${EVENT}','GENERAL',${String(quantity)},15,'${bundleCode}',null) as q`;
  const result = await db.query<{ q: Quote }>(sql);
  const row = result.rows[0]?.q;
  if (row === undefined) {
    throw new Error("quote returned no row");
  }
  return row;
}

async function createOrder(
  quantity: number,
  bundleCode: string | null = null,
  email = "buyer@example.com",
): Promise<Order> {
  const sql =
    bundleCode === null
      ? `select public.create_order(
           '${EVENT}','GENERAL',${String(quantity)},15,
           '${email}','Comprador','3001234567','${PARTICIPANT}'::jsonb,
           null,null,'181.10.20.30','vitest/1.0','epayco') as o`
      : `select public.create_bundle_order(
           '${EVENT}','GENERAL',${String(quantity)},15,
           '${email}','Comprador','3001234567','${PARTICIPANT}'::jsonb,
           '${bundleCode}',null,null,'181.10.20.30','vitest/1.0','epayco') as o`;
  const result = await db.query<{ o: Order }>(sql);
  const row = result.rows[0]?.o;
  if (row === undefined) {
    throw new Error("order creation returned no row");
  }
  return row;
}

/** Front-loads the pool so the next request sees `remaining` admissions left. */
async function consume(admissions: number): Promise<void> {
  await db.exec(`
    update public.pricing_tiers set quantity_sold = ${String(admissions)} where sequence = 2;
  `);
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
}, 120_000);

beforeEach(async () => {
  await seedLegacyCatalog();
});

afterAll(async () => {
  await db.close();
});

describe("catalog after the migration", () => {
  it("keeps one capacity of 100 for the whole event and no per-stage quota", async () => {
    const result = await db.query<{ capacity: number }>(
      `select capacity from public.events where code = '${EVENT}'`,
    );
    expect(result.rows[0]?.capacity).toBe(100);

    const quotas = await db.query<{ sequence: number; quantity_limit: number | null }>(
      `select sequence, quantity_limit from public.pricing_tiers order by sequence`,
    );
    expect(quotas.rows).toEqual([
      { sequence: 1, quantity_limit: null },
      { sequence: 2, quantity_limit: null },
    ]);
  });

  it("prices Preventa at COP 159.900 with the one-admission-per-order rule", async () => {
    const result = await db.query<{
      name: string;
      price_cents: number;
      max_per_order: number | null;
      sales_starts_at: string;
      sales_ends_at: string;
    }>(
      `select name, price_cents, max_per_order, sales_starts_at, sales_ends_at
         from public.pricing_tiers where sequence = 1`,
    );
    expect(result.rows[0]).toMatchObject({
      name: "Preventa",
      price_cents: 15_990_000,
      max_per_order: 1,
    });
    expect(Date.parse(String(result.rows[0]?.sales_starts_at))).toBe(Date.parse(PRESALE_OPENS));
    expect(Date.parse(String(result.rows[0]?.sales_ends_at))).toBe(Date.parse(PRESALE_ENDS));
  });

  it("prices General at COP 199.900 with a one-minute gap after Preventa", async () => {
    const result = await db.query<{
      name: string;
      price_cents: number;
      max_per_order: number | null;
      sales_starts_at: string;
      sales_ends_at: string;
    }>(
      `select name, price_cents, max_per_order, sales_starts_at, sales_ends_at
         from public.pricing_tiers where sequence = 2`,
    );
    expect(result.rows[0]).toMatchObject({
      name: "General",
      price_cents: 19_990_000,
      max_per_order: null,
    });
    expect(Date.parse(String(result.rows[0]?.sales_starts_at))).toBe(Date.parse(GENERAL_OPENS));
    expect(Date.parse(String(result.rows[0]?.sales_ends_at))).toBe(Date.parse(GENERAL_ENDS));
    // The gap is real: General opens 60 seconds after Preventa's exclusive end.
    expect(Date.parse(GENERAL_OPENS) - Date.parse(PRESALE_ENDS)).toBe(60_000);
  });

  it("sells the three-admission package for COP 509.700 during General only", async () => {
    const result = await db.query<{
      code: string;
      name: string;
      included_admissions: number;
      price_cents: number;
      is_active: boolean;
      tier_sequence: number;
    }>(
      `select b.code, b.name, b.included_admissions, b.price_cents, b.is_active,
              t.sequence as tier_sequence
         from public.ticket_bundles b
         join public.pricing_tiers t on t.id = b.pricing_tier_id
        order by b.code`,
    );
    expect(result.rows).toEqual([
      {
        code: "DOUBLE_EXPERIENCE",
        name: "Doble experiencia",
        included_admissions: 2,
        price_cents: 34_000_000,
        is_active: false,
        tier_sequence: 2,
      },
      {
        code: "SHARE_EXPERIENCE",
        name: "Comparte tu experiencia",
        included_admissions: 3,
        price_cents: 50_970_000,
        is_active: true,
        tier_sequence: 2,
      },
    ]);
  });
});

describe("published prices", () => {
  it("quotes one General admission at COP 199.900", async () => {
    await openGeneralStage();
    expect(await quote(1)).toMatchObject({
      pricingTier: { name: "General", unitPriceInCents: 19_990_000 },
      subtotalInCents: 19_990_000,
      totalInCents: 19_990_000,
    });
  });

  it("quotes three individual General admissions at COP 599.700 with no quantity discount", async () => {
    await openGeneralStage();
    expect(await quote(3)).toMatchObject({
      pricingTier: { name: "General", unitPriceInCents: 19_990_000 },
      subtotalInCents: 59_970_000,
      totalInCents: 59_970_000,
    });
  });

  it("keeps one Preventa admission at COP 159.900 and still refuses two", async () => {
    await openPreventaStage();
    expect(await quote(1)).toMatchObject({
      pricingTier: { name: "Preventa", unitPriceInCents: 15_990_000 },
      totalInCents: 15_990_000,
    });
    const two = await rejection(
      db.query(`select public.quote_order_price('${EVENT}','GENERAL',2,15,null)`),
    );
    expect(two).toContain("QUANTITY_LIMIT");
  });

  it("keeps the package at COP 509.700 for its three admissions", async () => {
    await openGeneralStage();
    expect(await quote(3, "SHARE_EXPERIENCE")).toMatchObject({
      quantity: 3,
      bundleCode: "SHARE_EXPERIENCE",
      subtotalInCents: 50_970_000,
      totalInCents: 50_970_000,
    });
  });
});

describe("exact stage boundaries", () => {
  it("keeps Preventa closed before 10:00 on 25 October", async () => {
    expect(await stageNameAt("2026-10-25T14:59:59.999Z")).toBeNull();
    expect(await stageNameAt(PRESALE_OPENS)).toBe("Preventa");
  });

  it("keeps Preventa open through its last valid minute", async () => {
    expect(await stageNameAt("2026-10-29T04:59:59.999Z")).toBe("Preventa");
  });

  it("closes Preventa at exactly 00:00 on 29 October", async () => {
    expect(await stageNameAt(PRESALE_ENDS)).toBeNull();
    // The closed stage cannot be quoted either: no stage is open at that instant.
    expect(await salesSummaryAt(PRESALE_ENDS)).toMatchObject({
      salesOpen: false,
      availability: "NOT_STARTED",
    });
  });

  it("leaves one minute with no sales at all", async () => {
    expect(await stageNameAt("2026-10-29T05:00:00Z")).toBeNull();
    expect(await stageNameAt("2026-10-29T05:00:30Z")).toBeNull();
    expect(await stageNameAt("2026-10-29T05:00:59.999Z")).toBeNull();
  });

  it("opens General and the package at exactly 00:01 on 29 October", async () => {
    expect(await stageNameAt(GENERAL_OPENS)).toBe("General");
    const summary = await salesSummaryAt(GENERAL_OPENS);
    expect(summary.salesOpen).toBe(true);
    const ticketType = summary.ticketTypes[0];
    expect(ticketType).toMatchObject({
      salesOpen: true,
      maxPerOrder: null,
      currentTier: { name: "General", priceInCents: 19_990_000, maxPerOrder: null },
    });
    expect(Date.parse(String(ticketType?.salesWindow?.startsAt))).toBe(Date.parse(GENERAL_OPENS));
    expect(Date.parse(String(ticketType?.salesWindow?.endsAt))).toBe(Date.parse(GENERAL_ENDS));
  });

  it("closes General at the end of 13 November", async () => {
    expect(await stageNameAt("2026-11-14T04:59:59.999Z")).toBe("General");
    expect(await stageNameAt(GENERAL_ENDS)).toBeNull();
  });

  it("publishes the server clock, not the device clock", async () => {
    const summary = await salesSummaryAt(PRESALE_OPENS);
    expect(Date.parse(summary.serverTime)).toBe(Date.parse(PRESALE_OPENS));
    // The storefront is told which stage is open and how to cap its own selector.
    expect(summary.ticketTypes[0]?.currentTier).toMatchObject({
      name: "Preventa",
      priceInCents: 15_990_000,
      maxPerOrder: 1,
    });
  });

  it("publishes a catalog with no open stage instead of failing", async () => {
    // Regression: the between-stages branch used to assign NULL to a `record`, which aborted the
    // whole public projection exactly when the storefront needs it most (the one-minute gap).
    await closeAllStages();
    const result = await db.query<{ e: { found: boolean; sales: SalesSummary } }>(
      `select public.get_public_event('${EVENT}') as e`,
    );
    const payload = result.rows[0]?.e;
    expect(payload?.found).toBe(true);
    expect(payload?.sales).toMatchObject({ salesOpen: false, availability: "NOT_STARTED" });
    expect(payload?.sales.ticketTypes[0]).toMatchObject({
      salesOpen: false,
      currentTier: null,
      salesWindow: null,
    });

    // Nothing is quotable in that minute either — Preventa included.
    const refused = await rejection(
      db.query(`select public.quote_order_price('${EVENT}','GENERAL',1,15,null)`),
    );
    expect(refused).toContain("SOLD_OUT");
  });

  it("does not offer Preventa once its window has closed", async () => {
    // Past the end of the campaign nothing is on sale, and no stage is left to fall back to.
    const summary = await salesSummaryAt("2026-11-14T05:00:01Z");
    expect(summary.salesOpen).toBe(false);
    expect(summary.ticketTypes[0]?.currentTier).toBeNull();
  });
});

describe("shared inventory", () => {
  it("draws Preventa and General from the same pool", async () => {
    await openPreventaStage();
    const preventa = await createOrder(1, null, "preventa@example.com");
    expect(preventa).toMatchObject({ quantity: 1, totalInCents: 15_990_000 });
    expect(await snapshot()).toMatchObject({ reserved: 1, sold: 0, remaining: 99 });

    // General opens; the same pool keeps counting down, it is not reset per stage.
    await openGeneralStage();
    const general = await createOrder(3, null, "general@example.com");
    // Three individual General admissions: 3 x COP 199.900, no quantity discount.
    expect(general).toMatchObject({ quantity: 3, totalInCents: 59_970_000 });
    expect(await snapshot()).toMatchObject({ reserved: 4, remaining: 96 });
  });

  it("reserves three admissions for one package and charges COP 509.700 once", async () => {
    await openGeneralStage();
    const bundle = await createOrder(3, "SHARE_EXPERIENCE");
    expect(bundle).toMatchObject({
      quantity: 3,
      totalInCents: 50_970_000,
      pricingTierName: "General",
    });
    expect(await snapshot()).toMatchObject({ reserved: 3, remaining: 97 });
  });

  it("refuses the package when fewer than three admissions remain", async () => {
    await openGeneralStage();
    await consume(98);
    // Two left: not enough for a package of three, but two individual General admissions fit.
    const bundle = await rejection(
      db.query(
        `select public.quote_bundle_order_price('${EVENT}','GENERAL',3,15,'SHARE_EXPERIENCE',null)`,
      ),
    );
    expect(bundle).toContain("SOLD_OUT");
    expect(await quote(2)).toMatchObject({ totalInCents: 39_980_000 });
  });

  it("refuses any purchase when the pool is empty", async () => {
    await openGeneralStage();
    await consume(100);
    const single = await rejection(
      db.query(`select public.quote_order_price('${EVENT}','GENERAL',1,15,null)`),
    );
    expect(single).toContain("SOLD_OUT");
    const bundle = await rejection(
      db.query(
        `select public.quote_bundle_order_price('${EVENT}','GENERAL',3,15,'SHARE_EXPERIENCE',null)`,
      ),
    );
    expect(bundle).toContain("SOLD_OUT");
  });

  it("refuses order creation outside every window and writes nothing", async () => {
    await closeAllStages();
    const refused = await rejection(
      db.query(`select public.create_order(
        '${EVENT}','GENERAL',1,15,
        'closed@example.com','Comprador','3001234567','${PARTICIPANT}'::jsonb,
        null,null,'181.10.20.30','vitest/1.0','epayco')`),
    );
    expect(refused).toContain("SOLD_OUT");

    const orders = await db.query<{ n: number }>(
      `select count(*)::int as n from public.orders where buyer_email = 'closed@example.com'`,
    );
    expect(orders.rows[0]?.n).toBe(0);
    expect(await snapshot()).toMatchObject({ reserved: 0, sold: 0, remaining: 100 });
  });

  it("aborts any statement that would oversell the pool", async () => {
    const message = await rejection(
      db.query(`update public.pricing_tiers set quantity_sold = 101 where sequence = 2`),
    );
    expect(message).toContain("CAPACITY_EXCEEDED");
  });

  it("releases a reservation exactly once when the order expires", async () => {
    await openPreventaStage();
    const order = await createOrder(1, null, "expired@example.com");
    expect(await snapshot()).toMatchObject({ reserved: 1, sold: 0 });

    await db.query(`select public.expire_pending_orders(100, now() + interval '1 day') as r`);
    expect(await snapshot()).toMatchObject({ reserved: 0, sold: 0, remaining: 100 });

    // Running the maintenance job again must not release the same admissions twice.
    await db.query(`select public.expire_pending_orders(100, now() + interval '2 days') as r`);
    expect(await snapshot()).toMatchObject({ reserved: 0, sold: 0, remaining: 100 });

    // And the expired order is still there, untouched, with its recorded amount.
    const status = await db.query<{ status: string; total_cents: number }>(
      `select status, total_cents from public.orders where reference = '${order.reference}'`,
    );
    expect(status.rows[0]).toMatchObject({ status: "EXPIRED", total_cents: 15_990_000 });
  });
});
