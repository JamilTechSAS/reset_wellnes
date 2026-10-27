/**
 * Purchase rules per sales stage (migrations 20261024190000 and 20261024230000).
 *
 * The client's product rules are:
 *   * Preventa  — exactly one admission per payment/order, even for a client that skips the UI.
 *   * General   — multiple admissions per order, bounded only by the SHARED event pool.
 *   * Comparte tu experiencia (SHARE_EXPERIENCE) — one package of THREE General admissions for
 *     COP 539,700; two packages in one payment must be impossible at every layer.
 *
 * Stage selection is time-based (`sales_starts_at <= at < sales_ends_at`) and inventory is one
 * pool for the whole event, so these tests move the windows and the capacity — never a per-stage
 * quota, which no longer exists. They also prove the multi-admission order keeps exactly one
 * attendee record per admission and one Sheets projection per registered attendee — never "all
 * attendees registered" because only the buyer exists.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "./helpers.ts";

const EVENT = "TAT-2026";

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
  pricingTier: {
    name: string;
    sequence: number;
    unitPriceInCents: number;
    maxPerOrder: number | null;
  };
  subtotalInCents: number;
  totalInCents: number;
  bundleCode?: string;
  availability: string;
};

type Order = {
  replayed: boolean;
  reference: string;
  status: string;
  quantity: number;
  totalInCents: number;
  pricingTierName: string;
};

type Status = {
  status: string;
  admissions: { quantity: number; assigned: number; remainingUnassigned: number };
  participants: { unit: number; firstName: string; lastName: string }[];
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

async function seed(): Promise<void> {
  await db.exec(`
    truncate table public.orders, public.pricing_tiers, public.ticket_bundles,
                   public.ticket_types, public.events cascade;
  `);
  await db.exec(`
    insert into public.events (code, name, starts_at, status, currency, capacity)
    values ('${EVENT}', 'Evento de prueba', now() + interval '60 days', 'PUBLISHED', 'COP', 200);

    insert into public.ticket_types (event_id, code, name)
    select id, 'GENERAL', 'Entrada general' from public.events where code = '${EVENT}';

    -- Preventa carries the per-order cap: one admission per order, no stage quota of its own.
    insert into public.pricing_tiers
      (ticket_type_id, name, sequence, price_cents, quantity_limit, max_per_order, sales_starts_at)
    select id, 'Preventa', 1, 16000000, null, 1, now() - interval '1 day'
      from public.ticket_types where code = 'GENERAL';

    insert into public.pricing_tiers
      (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
    select id, 'General', 2, 19990000, null, now() - interval '1 day'
      from public.ticket_types where code = 'GENERAL';

    insert into public.ticket_bundles
      (event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents)
    select tt.event_id, tt.id, t.id, 'SHARE_EXPERIENCE', 'Comparte tu experiencia', 3, 53970000
      from public.ticket_types tt
      join public.pricing_tiers t on t.ticket_type_id = tt.id and t.sequence = 2
     where tt.code = 'GENERAL';
  `);
}

/**
 * Ends Preventa's window and opens General, the way the campaign actually advances. A stage is
 * selected by TIME now: an exhausted quota no longer moves anyone to the next stage.
 */
async function openGeneralStage(): Promise<void> {
  await db.exec(`
    update public.pricing_tiers set sales_ends_at = now() where sequence = 1;
    update public.pricing_tiers set sales_starts_at = now() - interval '1 minute' where sequence = 2;
  `);
}

/** Puts Preventa back as the open stage (used to prove a replay survives the stage moving back). */
async function reopenPreventaStage(): Promise<void> {
  await db.exec(`
    update public.pricing_tiers set sales_ends_at = null where sequence = 1;
    update public.pricing_tiers set sales_starts_at = now() + interval '1 day' where sequence = 2;
  `);
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
  options: { readonly email?: string; readonly idempotencyKey?: string } = {},
): Promise<Order> {
  const email = options.email ?? "buyer@example.com";
  const key = options.idempotencyKey === undefined ? "null" : `'${options.idempotencyKey}'`;
  const sql =
    bundleCode === null
      ? `select public.create_order(
           '${EVENT}','GENERAL',${String(quantity)},15,
           '${email}','Comprador','3001234567','${PARTICIPANT}'::jsonb,
           null,${key},'181.10.20.30','vitest/1.0','epayco') as o`
      : `select public.create_bundle_order(
           '${EVENT}','GENERAL',${String(quantity)},15,
           '${email}','Comprador','3001234567','${PARTICIPANT}'::jsonb,
           '${bundleCode}',null,${key},'181.10.20.30','vitest/1.0','epayco') as o`;
  const result = await db.query<{ o: Order }>(sql);
  const row = result.rows[0]?.o;
  if (row === undefined) {
    throw new Error("create_order returned no row");
  }
  return row;
}

async function orderStatus(reference: string, email = "buyer@example.com"): Promise<Status> {
  const result = await db.query<{ s: Status }>(
    `select public.get_order_status('${reference}','${email}') as s`,
  );
  const row = result.rows[0]?.s;
  if (row === undefined) {
    throw new Error("get_order_status returned no row");
  }
  return row;
}

async function count(sql: string): Promise<number> {
  const result = await db.query<{ n: number }>(sql);
  return result.rows[0]?.n ?? -1;
}

async function paidOrder(quantity: number): Promise<Order> {
  const order = await createOrder(quantity);
  await db.query(
    `select public.confirm_payment(
       '${order.reference}','${order.reference}','tx-${order.reference}','ACEPTADA',
       ${String(order.totalInCents)},'COP','CARD','APROBADA',
       '{"id":"tx-${order.reference}"}'::jsonb,'epayco') as r`,
  );
  return order;
}

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
}, 120_000);

beforeEach(async () => {
  await seed();
});

afterAll(async () => {
  await db.close();
});

describe("Preventa purchase limit", () => {
  it("quotes and creates exactly one admission per order", async () => {
    const q = await quote(1);
    expect(q.pricingTier.name).toBe("Preventa");
    expect(q.pricingTier.maxPerOrder).toBe(1);
    expect(q.quantity).toBe(1);
    expect(q.totalInCents).toBe(16_000_000);

    const order = await createOrder(1);
    expect(order.quantity).toBe(1);
    expect(order.pricingTierName).toBe("Preventa");
    expect(order.totalInCents).toBe(16_000_000);

    expect(
      await count(
        "select count(*) as n from public.pricing_tiers where sequence = 1 and quantity_reserved = 1",
      ),
    ).toBe(1);
  });

  it("refuses quantity 2 at the quote layer", async () => {
    expect(
      await rejection(
        db.query(`select public.quote_order_price('${EVENT}','GENERAL',2,15,null) as q`),
      ),
    ).toContain("QUANTITY_LIMIT");
  });

  it("refuses quantity 2 at order creation without creating an order or reserving stock", async () => {
    const message = await rejection(
      db.query(
        `select public.create_order(
         '${EVENT}','GENERAL',2,15,'buyer@example.com','Comprador','3001234567',
         '${PARTICIPANT}'::jsonb,null,null,'181.10.20.30','vitest/1.0','epayco') as o`,
      ),
    );
    expect(message).toContain("QUANTITY_LIMIT");
    expect(await count("select count(*) as n from public.orders")).toBe(0);
    expect(await count("select count(*) as n from public.payments")).toBe(0);
    expect(await count("select count(*) as n from public.participants")).toBe(0);
    expect(
      await count("select coalesce(sum(quantity_reserved), 0)::int as n from public.pricing_tiers"),
    ).toBe(0);
  });

  it("keeps the bundle unavailable while Preventa is the active stage", async () => {
    expect(
      await rejection(
        db.query(
          `select public.quote_bundle_order_price('${EVENT}','GENERAL',3,15,'SHARE_EXPERIENCE',null) as q`,
        ),
      ),
    ).toContain("BUNDLE_NOT_AVAILABLE");

    // Creation answers with the SAME code as the quote (migration 20261024200000): the stage
    // guard runs before the delegation, so the single-ticket cap is never what the buyer sees.
    const message = await rejection(
      db.query(
        `select public.create_bundle_order(
         '${EVENT}','GENERAL',3,15,'buyer@example.com','Comprador','3001234567',
         '${PARTICIPANT}'::jsonb,'SHARE_EXPERIENCE',null,null,
         '181.10.20.30','vitest/1.0','epayco') as o`,
      ),
    );
    expect(message).toContain("BUNDLE_NOT_AVAILABLE");
    expect(message).not.toContain("QUANTITY_LIMIT");
    expect(await count("select count(*) as n from public.orders")).toBe(0);
    expect(await count("select count(*) as n from public.payments")).toBe(0);
    expect(
      await count("select coalesce(sum(quantity_reserved), 0)::int as n from public.pricing_tiers"),
    ).toBe(0);
  });
});

describe("Comparte tu experiencia package", () => {
  beforeEach(async () => {
    await openGeneralStage();
  });

  it("prices one package of three General admissions at the fixed COP 539,700", async () => {
    const q = await quote(3, "SHARE_EXPERIENCE");
    expect(q.pricingTier.name).toBe("General");
    expect(q.quantity).toBe(3);
    expect(q.subtotalInCents).toBe(53_970_000);
    expect(q.totalInCents).toBe(53_970_000);
    expect(q.bundleCode).toBe("SHARE_EXPERIENCE");

    const order = await createOrder(3, "SHARE_EXPERIENCE");
    expect(order.quantity).toBe(3);
    expect(order.totalInCents).toBe(53_970_000);
    expect(await count("select quantity as n from public.order_items order by created_at")).toBe(3);
    // One package reserves exactly the three admissions it includes.
    expect(
      await count("select quantity_reserved as n from public.pricing_tiers where sequence = 2"),
    ).toBe(3);
  });

  it("answers an idempotency replay instead of refusing after the stage moves back", async () => {
    const key = "qa-bundle-replay-0001";
    const order = await createOrder(3, "SHARE_EXPERIENCE", { idempotencyKey: key });
    expect(order.replayed).toBe(false);

    // Preventa is the open stage again. The buyer's retry must still receive the order this key
    // already created, not a stage refusal.
    await reopenPreventaStage();

    const replay = await createOrder(3, "SHARE_EXPERIENCE", { idempotencyKey: key });
    expect(replay.replayed).toBe(true);
    expect(replay.reference).toBe(order.reference);
    expect(replay.totalInCents).toBe(53_970_000);
    expect(await count("select count(*) as n from public.orders")).toBe(1);
    expect(await count("select count(*) as n from public.payments")).toBe(1);
    expect(await count("select count(*) as n from public.participants")).toBe(1);
  });

  it("refuses two packages in one payment at both layers", async () => {
    expect(
      await rejection(
        db.query(
          `select public.quote_bundle_order_price('${EVENT}','GENERAL',6,15,'SHARE_EXPERIENCE',null) as q`,
        ),
      ),
    ).toContain("BUNDLE_QUANTITY_INVALID");

    expect(
      await rejection(
        db.query(
          `select public.create_bundle_order(
         '${EVENT}','GENERAL',6,15,'buyer@example.com','Comprador','3001234567',
         '${PARTICIPANT}'::jsonb,'SHARE_EXPERIENCE',null,null,
         '181.10.20.30','vitest/1.0','epayco') as o`,
        ),
      ),
    ).toContain("BUNDLE_QUANTITY_INVALID");
    expect(await count("select count(*) as n from public.orders")).toBe(0);
  });

  it("keeps the historical two-admission package out of new purchases", async () => {
    // The migration deactivates the old row for the real catalog; this event never seeds it, so
    // the answer is the same one a buyer gets: the product does not exist any more.
    expect(
      await rejection(
        db.query(
          `select public.quote_bundle_order_price('${EVENT}','GENERAL',2,15,'DOUBLE_EXPERIENCE',null) as q`,
        ),
      ),
    ).toContain("BUNDLE_NOT_FOUND");
  });
});

describe("General purchase limit", () => {
  beforeEach(async () => {
    await openGeneralStage();
  });

  it("quotes one, two and three admissions at the General price", async () => {
    for (const [quantity, total] of [
      [1, 19_990_000],
      [2, 39_980_000],
      [3, 59_970_000],
    ] as const) {
      const q = await quote(quantity);
      expect(q.pricingTier.name, `quantity ${String(quantity)}`).toBe("General");
      expect(q.pricingTier.maxPerOrder).toBeNull();
      expect(q.quantity).toBe(quantity);
      expect(q.totalInCents).toBe(total);
    }
  });

  it("creates a three-admission order and reserves exactly three units", async () => {
    const order = await createOrder(3);
    expect(order.quantity).toBe(3);
    expect(order.totalInCents).toBe(59_970_000);
    expect(
      await count("select quantity_reserved as n from public.pricing_tiers where sequence = 2"),
    ).toBe(3);
  });

  it("still refuses an order above the remaining inventory", async () => {
    // The pool, not a stage quota, is what limits the sale.
    await db.exec(`update public.events set capacity = 2 where code = '${EVENT}'`);

    expect(
      await rejection(
        db.query(`select public.quote_order_price('${EVENT}','GENERAL',3,15,null) as q`),
      ),
    ).toContain("SOLD_OUT");

    expect(
      await rejection(
        db.query(
          `select public.create_order(
         '${EVENT}','GENERAL',3,15,'buyer@example.com','Comprador','3001234567',
         '${PARTICIPANT}'::jsonb,null,null,'181.10.20.30','vitest/1.0','epayco') as o`,
        ),
      ),
    ).toContain("SOLD_OUT");
    expect(await count("select count(*) as n from public.orders")).toBe(0);
  });

  it("keeps one attendee record and one Sheets projection per registered admission", async () => {
    const order = await paidOrder(3);

    const paid = await orderStatus(order.reference);
    expect(paid.status).toBe("PAID");
    // Three admissions bought, only the buyer registered: the roster must say so instead of
    // reporting the order as complete.
    expect(paid.admissions).toEqual({ quantity: 3, assigned: 1, remainingUnassigned: 2 });
    expect(paid.participants).toHaveLength(1);
    expect(await count("select count(*) as n from public.sheets_participant_projections")).toBe(1);

    await db.query(
      `select public.attach_participant('${order.reference}','buyer@example.com',
         '{"firstName":"Luis","lastName":"Gómez","nationalId":"1.020.456.790",
           "email":"luis@example.com","phone":"+57 300 123 4568","city":"Montería",
           "consents":{"dataProcessing":true,"futureEvents":false}}'::jsonb) as a`,
    );
    await db.query(
      `select public.attach_participant('${order.reference}','buyer@example.com',
         '{"firstName":"Marta","lastName":"Ríos","nationalId":"1.020.456.791",
           "email":"marta@example.com","phone":"+57 300 123 4569","city":"Montería",
           "consents":{"dataProcessing":true,"futureEvents":false}}'::jsonb) as a`,
    );

    const complete = await orderStatus(order.reference);
    expect(complete.admissions).toEqual({ quantity: 3, assigned: 3, remainingUnassigned: 0 });
    expect(complete.participants.map((participant) => participant.firstName)).toEqual([
      "Ana",
      "Luis",
      "Marta",
    ]);
    expect(await count("select count(*) as n from public.sheets_participant_projections")).toBe(3);

    // A fourth attendee cannot borrow a unit that was never bought.
    expect(
      await rejection(
        db.query(
          `select public.attach_participant('${order.reference}','buyer@example.com',
         '{"firstName":"Extra","lastName":"Ríos","nationalId":"1.020.456.792",
           "email":"extra@example.com","phone":"+57 300 123 4570","city":"Montería",
           "consents":{"dataProcessing":true,"futureEvents":false}}'::jsonb) as a`,
        ),
      ),
    ).toContain("NO_ASSIGNABLE_UNIT");
  });
});
