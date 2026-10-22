/**
 * Migration verification.
 *
 * Every migration is applied, in order, to a real Postgres instance running in-process
 * (PGlite: PostgreSQL compiled to WebAssembly). This runs in CI and on a laptop with no
 * Docker daemon, so "migrations are ready" is verified instead of claimed.
 *
 * What this covers: syntax, object creation, enum labels, table inventory and trigger
 * behavior (structure + `updated_at` on real tables).
 * What this does NOT cover (documented in docs/phases/phase-02.md):
 *   - Supabase-specific roles/policies (`anon`, `authenticated`, PostgREST exposure) are
 *     simulated in `rls.test.ts`; the real Supabase runtime is confirmed by `npm run db:reset`;
 *   - true parallel execution (PGlite is single-session). The check-in and inventory races
 *     are verified against a real PostgreSQL 17 instance and documented in the phase report.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EMAIL_DELIVERY_STATUSES } from "@shared/domain/email-delivery.ts";
import { ORDER_STATUSES } from "@shared/domain/order-state.ts";
import { INTERNAL_PAYMENT_STATUSES } from "@shared/domain/payment-status.ts";
import { SHEET_PROJECTION_STATUSES } from "@shared/domain/sheets.ts";
import { TICKET_STATUSES } from "@shared/domain/tickets.ts";

import {
  applyMigrations,
  DOMAIN_TABLES,
  MIGRATION_FILE_PATTERN,
  migrationFiles,
} from "./helpers.ts";

async function enumLabels(db: PGlite, typeName: string): Promise<string[]> {
  const result = await db.query<{ labels: string[] | null }>(
    `select array_agg(e.enumlabel order by e.enumsortorder) as labels
       from pg_type t
       join pg_enum e on e.enumtypid = t.oid
      where t.typname = $1`,
    [typeName],
  );
  return result.rows[0]?.labels ?? [];
}

describe("database migrations", () => {
  const files = migrationFiles();
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("names migration files with the Supabase CLI convention (timestamp_name.sql)", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file, `${file} must match <YYYYMMDDHHMMSS>_<snake_case>.sql`).toMatch(
        MIGRATION_FILE_PATTERN,
      );
    }
  });

  it("exposes the documented status enums with exactly the expected labels", async () => {
    await expect(enumLabels(db, "order_status")).resolves.toEqual([...ORDER_STATUSES]);
    await expect(enumLabels(db, "payment_status")).resolves.toEqual([...INTERNAL_PAYMENT_STATUSES]);
    await expect(enumLabels(db, "ticket_status")).resolves.toEqual([...TICKET_STATUSES]);
    await expect(enumLabels(db, "email_delivery_status")).resolves.toEqual([
      ...EMAIL_DELIVERY_STATUSES,
    ]);
  });

  it("exposes the Phase 2 enums with exactly the expected labels", async () => {
    await expect(enumLabels(db, "event_status")).resolves.toEqual(["DRAFT", "PUBLISHED", "CLOSED"]);
    await expect(enumLabels(db, "discount_kind")).resolves.toEqual(["PERCENT", "FIXED"]);
    await expect(enumLabels(db, "consent_kind")).resolves.toEqual([
      "DATA_PROCESSING",
      "FUTURE_EVENTS",
    ]);
    await expect(enumLabels(db, "payment_event_result")).resolves.toEqual([
      "APPLIED",
      "DUPLICATE",
      "REJECTED",
      "IGNORED",
    ]);
  });

  it("exposes the Phase 5 Sheets projection status enum exactly as the domain models it", async () => {
    await expect(enumLabels(db, "sheets_projection_status")).resolves.toEqual([
      ...SHEET_PROJECTION_STATUSES,
    ]);
  });

  it("creates the private helper schema, unreachable from the public API", async () => {
    const schemas = await db.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname in ('public', 'app_private', 'extensions')",
    );
    const names = schemas.rows.map((row) => row.nspname).sort();
    expect(names).toEqual(["app_private", "extensions", "public"]);
  });

  it("creates every documented domain table and nothing else", async () => {
    const tables = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([...DOMAIN_TABLES]);
  });

  it("stamps updated_at through app_private.set_updated_at()", async () => {
    await db.exec(`
      create table public._migration_probe (
        id bigserial primary key,
        value text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create trigger _migration_probe_set_updated_at
        before update on public._migration_probe
        for each row execute function app_private.set_updated_at();
    `);

    await db.exec("insert into public._migration_probe (value) values ('initial')");
    const before = await db.query<{ updated_at: string }>(
      "select updated_at from public._migration_probe",
    );

    // Force a visible difference regardless of clock resolution.
    await db.exec(
      "update public._migration_probe set value = 'changed', updated_at = now() - interval '1 hour'",
    );
    const afterOneHourAgo = await db.query<{ updated_at: string }>(
      "select updated_at from public._migration_probe",
    );
    await db.exec("update public._migration_probe set value = 'changed again'");
    const after = await db.query<{ updated_at: string }>(
      "select updated_at from public._migration_probe",
    );

    const initialStamp = before.rows[0]?.updated_at;
    const regressedStamp = afterOneHourAgo.rows[0]?.updated_at;
    const finalStamp = after.rows[0]?.updated_at;

    expect(initialStamp).toBeDefined();
    expect(finalStamp).toBeDefined();
    // The trigger overwrote the manually regressed value with "now()".
    expect(new Date(finalStamp!).getTime()).toBeGreaterThan(new Date(regressedStamp!).getTime());

    await db.exec("drop table public._migration_probe");
  });

  it("wires a set_updated_at trigger to every table that has an updated_at column", async () => {
    const untriggered = await db.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a
           on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
        where n.nspname = 'public'
          and c.relkind = 'r'
          and not exists (
            select 1
              from pg_trigger t
             where t.tgrelid = c.oid
               and not t.tgisinternal
               and t.tgenabled <> 'D'
               and pg_get_triggerdef(t.oid) ilike '%set_updated_at%'
          )
        order by c.relname`,
    );
    expect(untriggered.rows).toEqual([]);

    // Sanity check that the query above is not vacuous.
    const withUpdatedAt = await db.query<{ count: number }>(
      `select count(*)::int as count
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a
           on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    // 11 tables from Phase 2 + `pricing_policy` (Phase 3) + `operators` and
    // `sheets_projections` (Phase 5). The count is asserted so the query above cannot
    // silently become vacuous; update it when a table gains updated_at.
    expect(withUpdatedAt.rows[0]?.count).toBe(14);
  });

  it("actually bumps updated_at on a domain table", async () => {
    // The regressed value is set at INSERT time: the BEFORE UPDATE trigger deliberately
    // makes it impossible to write an old updated_at later.
    await db.exec(`
      insert into public.events (code, name, starts_at, updated_at)
      values ('UPD-TEST', 'Evento', now(), now() - interval '1 hour')
    `);
    const before = await db.query<{ updated_at: string }>(
      "select updated_at from public.events where code = 'UPD-TEST'",
    );
    await db.exec("update public.events set name = 'Evento renombrado' where code = 'UPD-TEST'");
    const after = await db.query<{ updated_at: string }>(
      "select updated_at from public.events where code = 'UPD-TEST'",
    );

    const beforeStamp = before.rows[0]?.updated_at;
    const afterStamp = after.rows[0]?.updated_at;
    expect(beforeStamp).toBeDefined();
    expect(afterStamp).toBeDefined();
    expect(new Date(afterStamp!).getTime()).toBeGreaterThan(new Date(beforeStamp!).getTime());
  });
});
