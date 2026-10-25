/**
 * Rerun safety of `20261024170000_checkout_session_pinning.sql`.
 *
 * The migration can partially apply (a failed `db push`, or a manual SQL-editor run followed by
 * the CLI). Every object is therefore created with an idempotent guard, but the guards are not
 * allowed to adopt an incompatible schema silently: the migration validates the shape and aborts
 * with a typed detail instead.
 *
 * Asserted here, against the shipped SQL:
 *   - applying the file again (twice) changes no object, no data and no grant;
 *   - the one-live-session invariant still holds after the rerun;
 *   - a pre-existing table with the right name but the wrong shape aborts the migration.
 */

import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations, createFixture, MIGRATIONS_DIR, type Fixture } from "./helpers.ts";

const MIGRATION_SQL = readFileSync(
  path.join(MIGRATIONS_DIR, "20261024170000_checkout_session_pinning.sql"),
  "utf8",
);

let db: PGlite;
let fixture: Fixture;

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  fixture = await createFixture(db);
}, 30_000);

afterAll(async () => {
  await db.close();
});

type ObjectCounts = {
  tables: number;
  sessions: number;
  indexes: number;
  triggers: number;
  functions: number;
  leaseColumns: number;
  sessionChecks: number;
  leaseCheck: number;
};

async function objectCounts(): Promise<ObjectCounts> {
  const result = await db.query<{ c: ObjectCounts }>(
    `select jsonb_build_object(
       'tables', (select count(*)::int from information_schema.tables
                   where table_schema = 'public' and table_name = 'checkout_sessions'),
       'sessions', (select count(*)::int from public.checkout_sessions),
       'indexes', (select count(*)::int from pg_class
                    where relnamespace = 'public'::regnamespace
                      and relname in ('checkout_sessions_live_idx',
                                      'checkout_sessions_payment_id_idx')),
       'triggers', (select count(*)::int from pg_trigger
                     where tgname = 'payments_supersede_checkout_sessions' and not tgisinternal),
       'functions', (select count(*)::int from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('begin_checkout_session',
                                         'complete_checkout_session',
                                         'abandon_checkout_session')),
       'leaseColumns', (select count(*)::int from information_schema.columns
                         where table_schema = 'public' and table_name = 'payments'
                           and column_name like 'checkout_lease%'),
       'sessionChecks', (select count(*)::int from pg_constraint
                          where conrelid = 'public.checkout_sessions'::regclass
                            and conname in ('checkout_sessions_window',
                                            'checkout_sessions_supersede_pair')),
       'leaseCheck', (select count(*)::int from pg_constraint
                       where conname = 'payments_checkout_lease_generation_check')
     ) as c`,
  );
  const counts = result.rows[0]?.c;
  if (counts === undefined) {
    throw new Error("object count query returned no row");
  }
  return counts;
}

describe("checkout-session migration rerun", () => {
  it("reapplies twice without duplicating objects, touching data or weakening the invariant", async () => {
    await db.query(
      `insert into public.checkout_sessions
         (payment_id, payment_reference, session_id, expires_at)
       values ($1, 'EVT-2026-000001', 'sess_before_rerun', now() + interval '15 minutes')`,
      [fixture.paymentId],
    );

    const before = await objectCounts();
    expect(before).toEqual({
      tables: 1,
      sessions: 1,
      indexes: 2,
      triggers: 1,
      functions: 3,
      leaseColumns: 2,
      sessionChecks: 2,
      leaseCheck: 1,
    });

    await db.exec(MIGRATION_SQL);
    await db.exec(MIGRATION_SQL);

    // Same objects, same row: no duplicate trigger/index/constraint, no data rewritten.
    expect(await objectCounts()).toEqual(before);
    const row = await db.query<{ session_id: string; superseded_reason: string | null }>(
      "select session_id, superseded_reason from public.checkout_sessions",
    );
    expect(row.rows).toEqual([{ session_id: "sess_before_rerun", superseded_reason: null }]);

    // The live-session index is still the one the pinning relies on.
    await expect(
      db.query(
        `insert into public.checkout_sessions
           (payment_id, payment_reference, session_id, expires_at)
         values ($1, 'EVT-2026-000001', 'sess_second_live', now() + interval '15 minutes')`,
        [fixture.paymentId],
      ),
    ).rejects.toThrow(/checkout_sessions_live_idx/);
  });

  it("aborts instead of adopting an existing table with an incompatible shape", async () => {
    // Simulates a partial/foreign version of the table: right name, wrong nullability.
    await db.exec("alter table public.checkout_sessions alter column expires_at drop not null");
    try {
      await expect(db.exec(MIGRATION_SQL)).rejects.toThrow(
        /does not match the expected shape: expires_at/,
      );
    } finally {
      await db.exec("alter table public.checkout_sessions alter column expires_at set not null");
    }
  });
});
