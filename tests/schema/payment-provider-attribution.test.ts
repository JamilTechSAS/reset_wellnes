/**
 * H15: payment-provider attribution (migration 20261023140000), on PGlite.
 *
 * confirm_payment, claim_webhook_event and record_webhook_rejection used to default the
 * provider to 'epayco', so Wompi confirmations were recorded as ePayco and the provider-aware
 * sweep would have sent them to ePayco. The provider is now mandatory, and rows that our own
 * Wompi code path demonstrably wrote are re-attributed; ambiguous rows are left alone.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, migrationFiles } from "./helpers.ts";

const EVENT = "H15-ATTR";
const REPAIR = "20261023140000_explicit_payment_provider.sql";
const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

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
};

async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    do $$
    declare v_event uuid; v_tt uuid;
    begin
      insert into public.events (code, name, starts_at, status, capacity, venue_name, city)
        values ('${EVENT}', 'Evento H15', now() + interval '60 days', 'PUBLISHED', 50,
                'Teatro', 'Bogotá')
        returning id into v_event;
      insert into public.ticket_types (event_id, code, name, min_per_order, max_per_order)
        values (v_event, 'GENERAL', 'Entrada general', 1, 10) returning id into v_tt;
      insert into public.pricing_tiers
        (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
        values (v_tt, 'Única', 1, 1000000, 40, now() - interval '1 day');
    end $$;
  `);
}

async function createOrder(db: PGlite): Promise<OrderResult> {
  const result = await db.query<{ o: OrderResult }>(
    `select public.create_order(
       '${EVENT}','GENERAL',1,15,'buyer@example.com','Comprador','3001234567',
       '${PARTICIPANT}'::jsonb,null,null,'181.10.20.30','vitest/1.0') as o`,
  );
  const order = result.rows[0]?.o;
  if (order === undefined) {
    throw new Error("create_order returned no row");
  }
  return order;
}

async function providerOf(db: PGlite, orderId: string): Promise<string | undefined> {
  const result = await db.query<{ p: string }>(
    `select payment_provider as p from public.payments where order_id = '${orderId}'`,
  );
  return result.rows[0]?.p;
}

describe("explicit provider (migrations applied)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await seed(db);
  }, 30_000);

  beforeEach(async () => {
    await db.exec(`
      delete from public.email_deliveries; delete from public.tickets;
      delete from public.consents; delete from public.participants;
      delete from public.payment_events; delete from public.payments;
      delete from public.order_items; delete from public.orders;
      update public.pricing_tiers set quantity_reserved = 0, quantity_sold = 0;
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  function confirmSql(order: OrderResult, status: string, provider: string | null): string {
    return `select public.confirm_payment(
      '${order.reference}','${order.wompiReference}','tx-h15-1','${status}',
      ${String(order.totalInCents)},'COP',null,null,null
      ${provider === null ? "" : `,'${provider}'`}) as r`;
  }

  it.each([
    ["omitted", null],
    ["empty", ""],
    ["unknown", "stripe"],
  ])(
    "refuses a confirmation whose provider is %s instead of guessing",
    async (_label, provider) => {
      const order = await createOrder(db);
      await expect(db.query(confirmSql(order, "APPROVED", provider))).rejects.toThrow(
        /INVALID_PROVIDER|Payment provider must be/,
      );
      // Nothing moved: no ticket, no payment status change, inventory still reserved.
      const state = await db.query<{ tickets: number; status: string; reserved: number }>(
        `select (select count(*)::int from public.tickets where order_id = o.id) as tickets,
              o.status::text as status,
              (select quantity_reserved from public.pricing_tiers where name = 'Única') as reserved
         from public.orders o where o.id = '${order.orderId}'`,
      );
      expect(state.rows[0]).toEqual({ tickets: 0, status: "PENDING", reserved: 1 });
    },
  );

  it.each([
    ["wompi", "APPROVED", "wompi"],
    ["WOMPI", "APPROVED", "wompi"],
    ["epayco", "1", "epayco"],
    [" ePayco ", "1", "epayco"],
  ])("records the provider it was given (%j)", async (provider, status, stored) => {
    const order = await createOrder(db);
    const result = await db.query<{ r: { orderStatus: string; ticketsIssued: number } }>(
      confirmSql(order, status, provider),
    );
    expect(result.rows[0]?.r.orderStatus).toBe("PAID");
    expect(result.rows[0]?.r.ticketsIssued).toBe(1);
    expect(await providerOf(db, order.orderId)).toBe(stored);
  });

  it("routes a pending Wompi attempt to the Wompi sweep, never to ePayco", async () => {
    const order = await createOrder(db);
    await db.query(confirmSql(order, "PENDING", "wompi"));
    await db.query(
      `update public.payments set next_reconciliation_at = now() - interval '1 minute'
        where order_id = '${order.orderId}'`,
    );
    const claimed = await db.query<{ provider: string }>(
      `select value->>'paymentProvider' as provider
         from public.claim_payment_reconciliations(10, 8, now()) as value`,
    );
    expect(claimed.rows).toEqual([{ provider: "wompi" }]);
  });

  it.each([
    [
      "claim_webhook_event",
      `select public.claim_webhook_event('${"c".repeat(40)}','transaction.updated','tx',true`,
    ],
    [
      "record_webhook_rejection",
      `select public.record_webhook_rejection('${"r".repeat(40)}','transaction.updated',401,'CHECKSUM_MISMATCH'`,
    ],
  ])("makes %s name its provider too", async (_name, prefix) => {
    await expect(db.query(`${prefix}) as v`)).rejects.toThrow(/INVALID_PROVIDER|Payment provider/);
    await db.query(`${prefix},'wompi') as v`);
    const ledger = await db.query<{ provider: string }>(
      "select payment_provider as provider from public.payment_events",
    );
    expect(ledger.rows).toEqual([{ provider: "wompi" }]);
  });
});

describe("repair of rows written before the fix", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // Everything up to (not including) the H15 migration: the old defaults are live.
    for (const file of migrationFiles().filter((name) => name < REPAIR)) {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    }
    await seed(db);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("re-attributes only rows with unambiguous Wompi evidence", async () => {
    const wompiByWebhook = await createOrder(db);
    const epaycoByWebhook = await createOrder(db);
    const wompiByHint = await createOrder(db);

    // The bug as it happened: the Wompi webhook called without a provider.
    await db.query(
      `select public.confirm_payment('${wompiByWebhook.reference}','${wompiByWebhook.wompiReference}',
         '1292-1602113476-10985','APPROVED',${String(wompiByWebhook.totalInCents)},'COP','CARD',null,
         '{"id":"1292-1602113476-10985","reference":"${wompiByWebhook.wompiReference}","status":"APPROVED","amount_in_cents":${String(wompiByWebhook.totalInCents)},"currency":"COP","payment_method_type":"CARD"}'::jsonb)`,
    );
    // A genuine ePayco confirmation (its own x_* payload, numeric code).
    await db.query(
      `select public.confirm_payment('${epaycoByWebhook.reference}','${epaycoByWebhook.wompiReference}',
         '987654321','1',${String(epaycoByWebhook.totalInCents)},'COP',null,null,
         '{"x_ref_payco":"987654321","x_cod_response":"1"}'::jsonb,'epayco')`,
    );
    // A Wompi confirmation whose payload is not our builder's (e.g. the raw API response):
    // the evidence is not conclusive, so it must be left alone.
    await db.query(
      `select public.confirm_payment('${wompiByHint.reference}','${wompiByHint.wompiReference}',
         '1292-1602113476-10986','APPROVED',${String(wompiByHint.totalInCents)},'COP',null,null,
         '{"data":{"id":"1292-1602113476-10986"}}'::jsonb)`,
    );
    // Ledger rows written by the Wompi webhook and by the ePayco webhook.
    await db.query(
      `select public.claim_webhook_event('${"w".repeat(40)}','transaction.updated','1292-1',true)`,
    );
    await db.query(
      `select public.claim_webhook_event('${"e".repeat(40)}','epayco.confirmation','987654321',true,'epayco')`,
    );

    // Before the repair, all three payments and both ledger rows claim to be ePayco.
    for (const order of [wompiByWebhook, epaycoByWebhook, wompiByHint]) {
      expect(await providerOf(db, order.orderId)).toBe("epayco");
    }

    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, REPAIR), "utf8"));

    expect(await providerOf(db, wompiByWebhook.orderId)).toBe("wompi");
    expect(await providerOf(db, epaycoByWebhook.orderId)).toBe("epayco");
    expect(await providerOf(db, wompiByHint.orderId)).toBe("epayco");

    const ledger = await db.query<{ name: string; provider: string }>(
      `select coalesce(provider_event_name, wompi_event_name) as name, payment_provider as provider
         from public.payment_events order by 1`,
    );
    expect(ledger.rows).toEqual([
      { name: "epayco.confirmation", provider: "epayco" },
      { name: "transaction.updated", provider: "wompi" },
    ]);

    // Only the provider column changed: tickets and inventory are exactly as before.
    const totals = await db.query<{ tickets: number; sold: number }>(
      `select (select count(*)::int from public.tickets) as tickets,
              (select quantity_sold from public.pricing_tiers where name = 'Única') as sold`,
    );
    expect(totals.rows[0]).toEqual({ tickets: 3, sold: 3 });
  });
});
