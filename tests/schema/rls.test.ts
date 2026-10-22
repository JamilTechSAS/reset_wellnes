/**
 * Row level security posture.
 *
 * The real Supabase runtime creates `anon`, `authenticated` and `service_role` and grants
 * new public objects to them by default (docs: "Securing your API" -> "Default privileges").
 * This suite recreates that baseline in PGlite before applying the migrations, then asserts
 * what the migrations leave behind: RLS on everywhere, no policies, and the browser-facing
 * roles with no privileges at all — including EXECUTE on functions, which needs a revoke
 * per role because a direct grant survives a `revoke ... from public`.
 *
 * What this still does not prove (documented in docs/phases/phase-02.md): PostgREST's own
 * behaviour with a publishable key and the exact Supabase role configuration. That final
 * check belongs to `npm run db:reset` against the local stack.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations, createFixture, DOMAIN_TABLES, expectRejection } from "./helpers.ts";

describe("row level security posture", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // Supabase-equivalent baseline: platform roles and their default grants.
    await db.exec(`
      create role anon nologin noinherit;
      create role authenticated nologin noinherit;
      create role service_role nologin noinherit bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    `);
    await applyMigrations(db);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("enables RLS on every domain table", async () => {
    const result = await db.query<{ total: number; enabled: number }>(
      `select count(*)::int as total,
              count(*) filter (where c.relrowsecurity)::int as enabled
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(result.rows[0]?.total).toBe(DOMAIN_TABLES.length);
    expect(result.rows[0]?.enabled).toBe(DOMAIN_TABLES.length);
  });

  it("creates no policies: access is denied by default, not by omission of a rule", async () => {
    const result = await db.query<{ count: number }>(
      "select count(*)::int as count from pg_policies where schemaname = 'public'",
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it("leaves the browser-facing roles without any table or sequence privileges", async () => {
    const tables = await db.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and (
            has_table_privilege('anon', c.oid, 'select')
            or has_table_privilege('anon', c.oid, 'insert')
            or has_table_privilege('anon', c.oid, 'update')
            or has_table_privilege('anon', c.oid, 'delete')
            or has_table_privilege('authenticated', c.oid, 'select')
            or has_table_privilege('authenticated', c.oid, 'insert')
            or has_table_privilege('authenticated', c.oid, 'update')
            or has_table_privilege('authenticated', c.oid, 'delete')
          )
        order by c.relname`,
    );
    expect(tables.rows).toEqual([]);

    const sequence = await db.query<{ anon_usage: boolean; auth_select: boolean }>(
      `select has_sequence_privilege('anon', 'public.order_reference_seq', 'usage') as anon_usage,
              has_sequence_privilege('authenticated', 'public.order_reference_seq', 'select') as auth_select`,
    );
    expect(sequence.rows[0]?.anon_usage).toBe(false);
    expect(sequence.rows[0]?.auth_select).toBe(false);
  });

  it("denies the browser-facing roles at runtime, including on the export view", async () => {
    try {
      await db.exec("set role anon");
      await expectRejection(db.query("select count(*) from public.tickets"), /permission denied/);
      await expectRejection(
        db.query(`insert into public.events (code, name, starts_at) values ('ANON', 'x', now())`),
        /permission denied/,
      );
      await expectRejection(
        db.query("select count(*) from public.operational_export"),
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
  });

  it("leaves the browser-facing roles without EXECUTE on any backend function", async () => {
    const result = await db.query<{ signature: string }>(
      `select p.oid::regprocedure::text as signature
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'app_private')
          and p.prokind = 'f'
          and (
            has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute')
          )
        order by 1`,
    );
    expect(result.rows).toEqual([]);
  });

  it("grants no privileges on future tables to the browser-facing roles", async () => {
    await db.exec("create table public._rls_probe (id bigint)");
    try {
      const result = await db.query<{
        anon_select: boolean;
        auth_insert: boolean;
        service_select: boolean;
      }>(
        `select has_table_privilege('anon', 'public._rls_probe', 'select') as anon_select,
                has_table_privilege('authenticated', 'public._rls_probe', 'insert') as auth_insert,
                has_table_privilege('service_role', 'public._rls_probe', 'select') as service_select`,
      );
      expect(result.rows[0]?.anon_select).toBe(false);
      expect(result.rows[0]?.auth_insert).toBe(false);
      expect(result.rows[0]?.service_select).toBe(true);
    } finally {
      await db.exec("drop table public._rls_probe");
    }
  });

  it("keeps the platform defaults from granting future functions and sequences to the API roles", async () => {
    // PostgreSQL keeps PUBLIC's built-in EXECUTE on every new function, and `alter default
    // privileges ... revoke ... from public` does not remove it (verified on PostgreSQL 17.11:
    // the new function's ACL still contains `=X/postgres`). What the migration can remove — and
    // does — is the direct grant to `anon`/`authenticated`. The test above is what forces every
    // future function to be revoked per object.
    const defaults = await db.query<{ defaclacl: string }>(
      `select d.defaclacl::text as defaclacl
         from pg_default_acl d
        where d.defaclobjtype = 'f'`,
    );
    for (const row of defaults.rows) {
      expect(row.defaclacl).not.toMatch(/anon|authenticated/);
    }

    await db.exec(`
      create function public._privilege_probe() returns integer language sql as 'select 1';
      create sequence public._privilege_probe_seq;
    `);
    try {
      const result = await db.query<{ anon_usage: boolean; auth_select: boolean }>(
        `select has_sequence_privilege('anon', 'public._privilege_probe_seq', 'usage') as anon_usage,
                has_sequence_privilege('authenticated', 'public._privilege_probe_seq', 'select') as auth_select`,
      );
      expect(result.rows[0]?.anon_usage).toBe(false);
      expect(result.rows[0]?.auth_select).toBe(false);
    } finally {
      await db.exec(
        "drop function public._privilege_probe(); drop sequence public._privilege_probe_seq;",
      );
    }
  });

  it("defines the export view with security_invoker and only the service role can read it", async () => {
    const view = await db.query<{ relkind: string; reloptions: string[] | null }>(
      `select c.relkind, c.reloptions
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'operational_export'`,
    );
    expect(view.rows[0]?.relkind).toBe("v");
    expect(view.rows[0]?.reloptions ?? []).toContain("security_invoker=true");

    await createFixture(db);

    try {
      await db.exec("set role service_role");
      const count = await db.query<{ count: number }>(
        "select count(*)::int as count from public.operational_export",
      );
      expect(count.rows[0]?.count).toBe(1);
    } finally {
      await db.exec("reset role");
    }
  });
});
