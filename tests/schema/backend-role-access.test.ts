/**
 * The backend's SQL entry points, executed as the backend's own role.
 *
 * Every function in `public` is SECURITY INVOKER, so privileges are checked as the caller —
 * and the Edge Functions call them as `service_role` (the secret key). A missing USAGE on
 * `app_private`, a missing EXECUTE on an internal helper, or a missing table privilege fails
 * in production but passes for the function owner, which is what every other schema suite
 * (and every `has_function_privilege` probe) runs as.
 *
 * This suite therefore recreates the STRICT Supabase baseline (platform roles, no automatic
 * grants), applies the migrations, and then *invokes* the functions as `service_role`: the
 * catalog reads, the buyer journey through payment and check-in, the participant update, and
 * the sheets/reconciliation claims. It is the test that catches both privilege-assumption
 * defects found before the frontend: `permission denied for schema app_private` (the audit)
 * and `permission denied for table orders` once the platform stops granting `service_role`
 * automatically (the closure phase). As the owner, nothing of this is visible.
 *
 * What it still cannot prove: PostgREST's own behaviour with a publishable key, and the exact
 * Supabase role configuration. That belongs to a real project environment.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "./helpers.ts";

const EVENT = "RLA-2026";
const PARTICIPANT = JSON.stringify({
  firstName: "Ana",
  lastName: "Pérez",
  nationalId: "1020456789",
  email: "ana@example.com",
  phone: "3001234567",
  city: "Bogotá",
  consents: { dataProcessing: true, futureEvents: false },
});

type OrderResult = {
  orderId: string;
  reference: string;
  wompiReference: string;
  totalInCents: number;
  quantity: number;
};

describe("backend role access", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // STRICT platform baseline: the roles exist but receive NO automatic grants (the
    // `auto_expose_new_tables = false` mode, which Supabase documents as the direction of
    // the platform default). The migrations must therefore be self-sufficient: `service_role`
    // needs its table/sequence privileges granted explicitly, or every gateway call fails
    // with `permission denied for table ...` while the suite as the owner stays green.
    await db.exec(`
      create role anon nologin noinherit;
      create role authenticated nologin noinherit;
      create role service_role nologin noinherit bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
    `);
    await applyMigrations(db);
    await db.exec(`
      insert into public.events (code, name, starts_at, status, capacity, venue_name, city)
        values ('${EVENT}', 'Evento de prueba', now() + interval '60 days', 'PUBLISHED', 120,
                'Teatro Central', 'Bogotá');
      insert into public.ticket_types (event_id, code, name, min_per_order, max_per_order)
        select id, 'GENERAL', 'Entrada general', 1, 10 from public.events where code = '${EVENT}';
      insert into public.pricing_tiers
        (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
        select id, 'Preventa 1', 1, 9500001, 30, now() - interval '1 day'
          from public.ticket_types where code = 'GENERAL';
    `);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  async function asServiceRole<T>(run: () => Promise<T>): Promise<T> {
    await db.exec("set role service_role");
    try {
      return await run();
    } finally {
      await db.exec("reset role");
    }
  }

  async function createOrder(
    quantity: number,
    email: string,
    idempotencyKey: string,
  ): Promise<OrderResult> {
    return asServiceRole(async () => {
      const result = await db.query<{ o: OrderResult }>(
        `select public.create_order(
           '${EVENT}','GENERAL',${String(quantity)},15,'${email}','Comprador','3001234567',
           '${PARTICIPANT}'::jsonb,null,'${idempotencyKey}','181.10.20.30','vitest/1.0') as o`,
      );
      const order = result.rows[0]?.o;
      if (order === undefined) {
        throw new Error("create_order returned no row");
      }
      return order;
    });
  }

  it("lets the backend role read the catalog and price an order", async () => {
    await asServiceRole(async () => {
      const event = await db.query<{ found: string }>(
        `select public.get_public_event('${EVENT}') ->> 'found' as found`,
      );
      expect(event.rows[0]?.found).toBe("true");

      const availability = await db.query<{ availability: string }>(
        `select public.get_public_availability('${EVENT}')::text as availability`,
      );
      expect(availability.rows[0]?.availability).not.toBe("");

      const quote = await db.query<{ quote: string }>(
        `select public.quote_order_price('${EVENT}','GENERAL',2,15,null)::text as quote`,
      );
      expect(quote.rows[0]?.quote).toBeTruthy();

      const rate = await db.query<{ rate: string }>(
        `select public.consume_rate_limit('orders:create','181.10.20.30',20,3600,now())::text as rate`,
      );
      expect(rate.rows[0]?.rate).toBeTruthy();
    });
  });

  it("lets the backend role run the buyer journey through payment and participant sheet sync", async () => {
    const order = await createOrder(1, "rla-buyer@example.com", "rla-idem-buyer-0001");
    expect(order.quantity).toBe(1);

    const { paymentId, orderId } = await asServiceRole(async () => {
      const confirmation = await db.query<{
        summary: {
          result: string;
          paymentId: string;
          orderId: string;
          ticketsIssued: number;
        };
      }>(
        `select public.confirm_payment(
           '${order.reference}','${order.wompiReference}','tx-rla-1','APPROVED',
           ${String(order.totalInCents)},'COP','CARD','APROBADA','{"id":"tx-rla-1"}'::jsonb,'wompi') as summary`,
      );
      const summary = confirmation.rows[0]?.summary;
      expect(summary?.result).toBe("APPLIED");
      // Tickets are discontinued: approval issues none.
      expect(summary?.ticketsIssued).toBe(0);
      if (summary === undefined) {
        throw new Error("confirm_payment returned no row");
      }

      // The PAID transition enqueued the buyer's participant to the Sheets outbox. The
      // backend role can drive the whole participant projection pipeline.
      const claimed = await db.query<{ participant_id: string }>(
        "select participant_id from public.claim_participant_sheet_projections(50, now(), 900, 6)",
      );
      expect(claimed.rows.length).toBeGreaterThan(0);
      const ids = claimed.rows.map((row) => `'${row.participant_id}'::uuid`).join(",");
      const finished = await db.query<{ ok: boolean }>(
        `select (public.finish_participant_sheet_projections(array[${ids}],'SYNCED',null,null,now())) is not null as ok`,
      );
      expect(finished.rows[0]?.ok).toBe(true);

      return { paymentId: summary.paymentId, orderId: summary.orderId };
    });

    expect(paymentId).toBeTruthy();
    expect(orderId).toBeTruthy();
  });

  it("lets the backend role update a participant and sync the sheets projections", async () => {
    const order = await createOrder(
      2,
      "rla-participants@example.com",
      "rla-idem-participants-0002",
    );

    await asServiceRole(async () => {
      // Pay first: the PAID transition enqueues the buyer's participant to the Sheets outbox.
      // (Tickets are discontinued, so the ticket-based attach_participant flow is retired; the
      // backend role updates the buyer's own participant instead.)
      const confirmation = await db.query<{ result: string }>(
        `select public.confirm_payment(
           '${order.reference}','${order.wompiReference}','tx-rla-2','APPROVED',
           ${String(order.totalInCents)},'COP','CARD','APROBADA','{"id":"tx-rla-2"}'::jsonb,'wompi') ->> 'result' as result`,
      );
      expect(confirmation.rows[0]?.result).toBe("APPLIED");

      const participant = await db.query<{ id: string; email: string }>(
        `select id, email from public.participants where order_id = '${order.orderId}'::uuid limit 1`,
      );
      const participantId = participant.rows[0]?.id;
      const participantEmail = participant.rows[0]?.email;
      expect(participantId).toBeTruthy();

      const updated = await db.query<{ updated: string }>(
        `select public.update_participant(
           '${order.reference}','rla-participants@example.com','${String(participantId)}'::uuid,
           ('{"firstName":"Comprador","lastName":"Gómez","nationalId":"1098765432",
             "email":"' || '${String(participantEmail)}' || '","phone":"3009876543","city":"Cali",
             "consents":{"dataProcessing":true,"futureEvents":false}}')::jsonb,
           'v1')::text as updated`,
      );
      expect(updated.rows[0]?.updated).toBeTruthy();

      const stats = await db.query<{ stats: string }>(
        "select public.participant_sheet_projection_stats()::text as stats",
      );
      expect(stats.rows[0]?.stats).toBeTruthy();

      const claimed = await db.query<{ participant_id: string }>(
        "select participant_id from public.claim_participant_sheet_projections(50, now(), 900, 6)",
      );
      expect(claimed.rows.length).toBeGreaterThan(0);
      const ids = claimed.rows.map((row) => `'${row.participant_id}'::uuid`).join(",");
      const finished = await db.query<{ ok: boolean }>(
        `select (public.finish_participant_sheet_projections(array[${ids}],'SYNCED',null,null,now())) is not null as ok`,
      );
      expect(finished.rows[0]?.ok).toBe(true);

      const cleanup = await db.query<{ cleanup: string }>(
        "select public.cleanup_rate_limit_counters(7200, now())::text as cleanup",
      );
      expect(cleanup.rows[0]?.cleanup).toBeTruthy();
    });
  });
});
