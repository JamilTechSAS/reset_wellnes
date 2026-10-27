/**
 * Repricing of "Comparte tu experiencia" to COP 539.700 (`20261027090000`).
 *
 * The package total the buyer is charged lives in `ticket_bundles.price_cents`, not in code, so
 * the migration that updates it is the only thing that makes the card, the quote and the amount
 * sent to ePayco agree. Asserted here, against the shipped SQL:
 *
 *   - the `RESET-SUNSET-2026` package becomes `53970000` (COP 539.700, COP 179.900 × 3) while
 *     keeping exactly three admissions, its General tier and its active flag;
 *   - Preventa (`15990000`) and General (`19990000`) are untouched;
 *   - a bundle belonging to another event is not repriced;
 *   - replaying the migration is a no-op: no second mutation and no duplicate row.
 */

import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations, createFixture, MIGRATIONS_DIR, type Fixture } from "./helpers.ts";

const MIGRATION_SQL = readFileSync(
  path.join(MIGRATIONS_DIR, "20261027090000_share_experience_price_179900.sql"),
  "utf8",
);

const EVENT_CODE = "RESET-SUNSET-2026";
const OLD_TOTAL_CENTS = 50_970_000;
const NEW_TOTAL_CENTS = 53_970_000;
const NEW_UNIT_CENTS = 17_990_000;

let db: PGlite;
let fixture: Fixture;
let generalTierId: string;
let preventaTierId: string;

async function queryId(sql: string, params: readonly string[] = []): Promise<string> {
  const result = await db.query<{ id: string }>(sql, [...params]);
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error(`Query returned no id: ${sql}`);
  }
  return id;
}

type BundleRow = {
  code: string;
  included_admissions: number;
  price_cents: number;
  is_active: boolean;
  pricing_tier_id: string;
};

async function bundleOf(eventId: string): Promise<BundleRow | undefined> {
  const result = await db.query<BundleRow>(
    `select code, included_admissions, price_cents, is_active, pricing_tier_id
       from public.ticket_bundles
      where event_id = $1 and code = 'SHARE_EXPERIENCE'`,
    [eventId],
  );
  return result.rows[0];
}

async function tierPrices(): Promise<Record<string, number>> {
  const result = await db.query<{ name: string; price_cents: number }>(
    `select name, price_cents
       from public.pricing_tiers
      where id = any($1::uuid[])`,
    [[preventaTierId, generalTierId]],
  );
  return Object.fromEntries(result.rows.map((row) => [row.name, row.price_cents]));
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  // The shared fixture is a different event (TAT-2026): its package must not be repriced.
  fixture = await createFixture(db);

  await db.exec(`
    insert into public.ticket_bundles (
      event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents, is_active
    ) values (
      '${fixture.eventId}', '${fixture.ticketTypeId}', '${fixture.pricingTierId}',
      'SHARE_EXPERIENCE', 'Comparte tu experiencia', 3, ${OLD_TOTAL_CENTS}, true
    );
  `);

  const eventId = await queryId(
    `insert into public.events (code, name, starts_at, status, capacity)
     values ($1, 'Re set Sunset Vol. 1', timestamptz '2026-11-15 18:00:00+00', 'PUBLISHED', 100)
     returning id`,
    [EVENT_CODE],
  );
  const ticketTypeId = await queryId(
    `insert into public.ticket_types (event_id, code, name)
     values ($1, 'GENERAL', 'Entrada general')
     returning id`,
    [eventId],
  );
  preventaTierId = await queryId(
    `insert into public.pricing_tiers (
       ticket_type_id, name, sequence, price_cents, sales_starts_at, sales_ends_at, is_active
     ) values ($1, 'Preventa', 1, 15990000,
               timestamptz '2026-10-25 15:00:00+00', timestamptz '2026-10-29 05:00:00+00', true)
     returning id`,
    [ticketTypeId],
  );
  generalTierId = await queryId(
    `insert into public.pricing_tiers (
       ticket_type_id, name, sequence, price_cents, sales_starts_at, sales_ends_at, is_active
     ) values ($1, 'General', 2, 19990000,
               timestamptz '2026-10-29 05:01:00+00', timestamptz '2026-11-14 05:00:00+00', true)
     returning id`,
    [ticketTypeId],
  );
  await db.query(
    `insert into public.ticket_bundles (
       event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents, is_active
     ) values ($1, $2, $3, 'SHARE_EXPERIENCE', 'Comparte tu experiencia', 3, $4, true)`,
    [eventId, ticketTypeId, generalTierId, OLD_TOTAL_CENTS],
  );
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe("share experience repricing migration", () => {
  it("moves the package to COP 539.700 without changing its commercials", async () => {
    const eventId = await queryId(`select id from public.events where code = $1`, [EVENT_CODE]);
    const before = await bundleOf(eventId);
    expect(before?.price_cents).toBe(OLD_TOTAL_CENTS);
    expect(before?.included_admissions).toBe(3);

    await db.exec(MIGRATION_SQL);

    const after = await bundleOf(eventId);
    expect(after?.price_cents).toBe(NEW_TOTAL_CENTS);
    // 3 admissions charged once: COP 179.900 per person, COP 539.700 per package.
    expect(after?.included_admissions).toBe(3);
    expect(NEW_TOTAL_CENTS).toBe(NEW_UNIT_CENTS * 3);
    expect(NEW_UNIT_CENTS * after!.included_admissions).toBe(NEW_TOTAL_CENTS);
    expect(after?.is_active).toBe(true);
    expect(after?.pricing_tier_id).toBe(generalTierId);
  });

  it("leaves the Preventa and General prices exactly as published", async () => {
    expect(await tierPrices()).toEqual({ Preventa: 15_990_000, General: 19_990_000 });
  });

  it("does not reprice a package that belongs to another event", async () => {
    const other = await bundleOf(fixture.eventId);
    expect(other?.price_cents).toBe(OLD_TOTAL_CENTS);
  });

  it("is idempotent: replaying it changes nothing and never duplicates the row", async () => {
    await db.exec(MIGRATION_SQL);
    await db.exec(MIGRATION_SQL);

    const eventId = await queryId(`select id from public.events where code = $1`, [EVENT_CODE]);
    const rows = await db.query<{ count: number }>(
      `select count(*)::int as count
         from public.ticket_bundles
        where event_id = $1 and code = 'SHARE_EXPERIENCE'`,
      [eventId],
    );
    expect(rows.rows[0]?.count).toBe(1);
    expect((await bundleOf(eventId))?.price_cents).toBe(NEW_TOTAL_CENTS);
    expect(await tierPrices()).toEqual({ Preventa: 15_990_000, General: 19_990_000 });
  });
});
