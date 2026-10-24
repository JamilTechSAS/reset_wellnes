/**
 * Participant assignment on a ticket-free purchase flow.
 *
 * Regression suite for the blocker that survived migration 20261024120000: `confirm_payment`
 * stopped issuing tickets, but `attach_participant` still claimed a row from `public.tickets`,
 * so the companion of a two-admission purchase could never be attached and never reached the
 * Google Sheets projection.
 *
 * These tests run the real journey against Postgres (PGlite): catalog -> create_order (or
 * create_bundle_order) -> confirm_payment to PAID -> attach_participant. They assert the
 * product prices stay $400,000 COP for two General tickets and $340,000 COP for the
 * "Comparte esta experiencia" / "Doble experiencia" bundle, that both reach exactly two
 * participants and two Sheets rows, that no ticket is ever created, and that capacity is
 * enforced per order and attributed to the right order line.
 *
 * What PGlite cannot do: two genuinely concurrent sessions. The order-row lock that makes
 * concurrent attachments safe is documented in docs/data-model.md.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations, expectRejection } from "./helpers.ts";

const EVENT = "PAS-2026";

const BUYER = JSON.stringify({
  firstName: "Ana",
  lastName: "Pérez",
  nationalId: "1.020.456.789",
  email: "ana@example.com",
  phone: "+57 300 123 4567",
  city: "Bogotá",
  consents: { dataProcessing: true, futureEvents: false },
});

const COMPANION = JSON.stringify({
  firstName: "Beto",
  lastName: "Gómez",
  nationalId: "98.765.432",
  email: "beto@example.com",
  phone: "3001112233",
  city: "Cali",
  consents: { dataProcessing: true, futureEvents: true },
});

const THIRD = JSON.stringify({
  firstName: "Carla",
  lastName: "Ruiz",
  nationalId: "1122334455",
  email: "carla@example.com",
  phone: "3009998877",
  city: "Medellín",
  consents: { dataProcessing: true, futureEvents: false },
});

type Order = {
  orderId: string;
  reference: string;
  wompiReference: string;
  quantity: number;
  unitPriceInCents: number;
  totalInCents: number;
  participantId: string;
};

type AttachResult = {
  found: boolean;
  orderReference?: string;
  unit?: number;
  participant?: { participantId: string; firstName: string; lastName: string };
  consentsAppended?: number;
  remainingUnassigned?: number;
};

async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    do $$
    declare v_event uuid; v_tt uuid; v_tier uuid;
    begin
      insert into public.events (code, name, starts_at, status, capacity)
        values ('${EVENT}', 'Evento', now() + interval '60 days', 'PUBLISHED', 120)
        returning id into v_event;
      insert into public.ticket_types (event_id, code, name, min_per_order, max_per_order)
        values (v_event, 'GENERAL', 'Entrada general', 1, 6)
        returning id into v_tt;
      -- $200,000 COP per General admission: two individual tickets are $400,000.
      insert into public.pricing_tiers
        (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
      values (v_tt, 'General', 1, 20000000, null, now() - interval '1 day')
        returning id into v_tier;
      insert into public.pricing_tiers
        (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
      values (v_tt, 'Etapa 2', 2, 22000000, null, now() - interval '1 day');
      -- "Comparte esta experiencia" / "Doble experiencia": two admissions for $340,000.
      insert into public.ticket_bundles
        (event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents)
      values (v_event, v_tt, v_tier, 'DOUBLE_EXPERIENCE', 'Doble experiencia', 2, 34000000);
    end $$;
  `);
}

async function createOrder(
  db: PGlite,
  options: {
    quantity: number;
    email: string;
    key: string;
    bundle?: boolean;
    participant?: string;
  },
): Promise<Order> {
  const participant = options.participant ?? BUYER;
  const sql = options.bundle
    ? `select public.create_bundle_order(
         '${EVENT}','GENERAL',${String(options.quantity)},15,
         '${options.email}','Comprador','3001234567','${participant}'::jsonb,
         'DOUBLE_EXPERIENCE',null,'${options.key}',
         '181.10.20.30','vitest/1.0','epayco') as o`
    : `select public.create_order(
         '${EVENT}','GENERAL',${String(options.quantity)},15,
         '${options.email}','Comprador','3001234567','${participant}'::jsonb,
         null,'${options.key}','181.10.20.30','vitest/1.0','epayco') as o`;

  const result = await db.query<{ o: Order }>(sql);
  const order = result.rows[0]?.o;
  if (order === undefined) {
    throw new Error("order creation returned no row");
  }
  return order;
}

/** The same authoritative confirmation path the ePayco webhook uses. */
async function confirmPayment(db: PGlite, order: Order, transactionId: string): Promise<void> {
  const result = await db.query<{
    summary: {
      result: string;
      orderStatus: string;
      ticketsIssued: number;
      ticketsExpected: number;
    };
  }>(
    `select public.confirm_payment(
       '${order.reference}','${order.wompiReference}','${transactionId}','ACEPTADA',
       ${String(order.totalInCents)},'COP','CARD','APROBADA',
       '{"id":"${transactionId}"}'::jsonb,'epayco') as summary`,
  );
  const summary = result.rows[0]?.summary;
  expect(summary?.result).toBe("APPLIED");
  expect(summary?.orderStatus).toBe("PAID");
  expect(summary?.ticketsIssued).toBe(0);
  expect(summary?.ticketsExpected).toBe(order.quantity);
}

async function attach(
  db: PGlite,
  reference: string,
  email: string,
  participant = COMPANION,
): Promise<AttachResult> {
  const result = await db.query<{ value: AttachResult }>(
    "select public.attach_participant($1, $2, $3::jsonb) as value",
    [reference, email, participant],
  );
  const value = result.rows[0]?.value;
  if (value === undefined) {
    throw new Error("attach_participant returned no row");
  }
  return value;
}

async function countRows(db: PGlite, sql: string, params: readonly string[]): Promise<number> {
  const result = await db.query<{ count: number }>(sql, [...params]);
  return result.rows[0]?.count ?? -1;
}

describe("participant assignment without tickets", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await seed(db);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("keeps exactly one attach_participant overload, with no ticket token", async () => {
    const signatures = await db.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p
        where p.proname = 'attach_participant'
          and p.pronamespace = 'public'::regnamespace`,
    );
    expect(signatures.rows).toHaveLength(1);
    expect(signatures.rows[0]?.args).not.toContain("p_ticket_token");
  });

  it("assigns the companion of two regular General tickets and syncs both participants", async () => {
    const order = await createOrder(db, {
      quantity: 2,
      email: "regular@example.com",
      key: "pas-regular-000001",
    });
    // Two individual General tickets stay $400,000 COP (2 x $200,000), never the bundle price.
    expect(order.totalInCents).toBe(40_000_000);
    expect(order.unitPriceInCents).toBe(20_000_000);

    const soldBefore = await countRows(
      db,
      "select quantity_sold as count from public.pricing_tiers where sequence = 1 and name = 'General'",
      [],
    );

    await confirmPayment(db, order, "tx-pas-regular-1");

    const attached = await attach(db, order.reference, "regular@example.com");
    expect(attached.found).toBe(true);
    expect(attached.unit).toBe(2);
    expect(attached.remainingUnassigned).toBe(0);
    expect(attached.consentsAppended).toBe(2);

    expect(
      await countRows(
        db,
        "select count(*)::int as count from public.participants where order_id = $1",
        [order.orderId],
      ),
    ).toBe(2);
    // No ticket, token or QR is issued anywhere in the purchase.
    expect(
      await countRows(db, "select count(*)::int as count from public.tickets where order_id = $1", [
        order.orderId,
      ]),
    ).toBe(0);
    // The PAID transition and the later attach both reached the participant outbox.
    expect(
      await countRows(
        db,
        `select count(*)::int as count
           from public.sheets_participant_projections sp
           join public.participants p on p.id = sp.participant_id
          where p.order_id = $1`,
        [order.orderId],
      ),
    ).toBe(2);

    const exported = await db.query<{
      name: string;
      price: number;
      status: string;
    }>(
      `select "Nombre" as name, "Precio centavos" as price, "Estado de la orden" as status
         from public.operational_export
        where "Referencia de la orden" = $1
        order by "Nombre"`,
      [order.reference],
    );
    expect(exported.rows).toHaveLength(2);
    expect(exported.rows.map((row) => row.name)).toEqual(["Ana", "Beto"]);
    expect(exported.rows.every((row) => row.price === 20_000_000)).toBe(true);
    expect(exported.rows.every((row) => row.status === "PAID")).toBe(true);

    // Inventory moved reserved -> sold for both admissions.
    expect(
      await countRows(
        db,
        "select quantity_sold as count from public.pricing_tiers where sequence = 1 and name = 'General'",
        [],
      ),
    ).toBe(soldBefore + 2);

    // Capacity is spent: a third person is refused, never silently overwritten.
    await expectRejection(
      db.query("select public.attach_participant($1, $2, $3::jsonb)", [
        order.reference,
        "regular@example.com",
        THIRD,
      ]),
      /NO_ASSIGNABLE_UNIT|no unassigned admission/,
    );
  });

  it("assigns the companion of the Doble experiencia bundle at its fixed $340,000 COP", async () => {
    const order = await createOrder(db, {
      quantity: 2,
      email: "bundle@example.com",
      key: "pas-bundle-000001",
      bundle: true,
    });
    expect(order.totalInCents).toBe(34_000_000);
    // $340,000 / 2 admissions, frozen on the order line.
    expect(order.unitPriceInCents).toBe(17_000_000);

    await confirmPayment(db, order, "tx-pas-bundle-1");

    const attached = await attach(db, order.reference, "bundle@example.com");
    expect(attached.found).toBe(true);
    expect(attached.unit).toBe(2);
    expect(attached.remainingUnassigned).toBe(0);

    expect(
      await countRows(
        db,
        "select count(*)::int as count from public.participants where order_id = $1",
        [order.orderId],
      ),
    ).toBe(2);
    expect(
      await countRows(db, "select count(*)::int as count from public.tickets where order_id = $1", [
        order.orderId,
      ]),
    ).toBe(0);
    expect(
      await countRows(
        db,
        `select count(*)::int as count
           from public.sheets_participant_projections sp
           join public.participants p on p.id = sp.participant_id
          where p.order_id = $1`,
        [order.orderId],
      ),
    ).toBe(2);

    const exported = await db.query<{ name: string; price: number }>(
      `select "Nombre" as name, "Precio centavos" as price
         from public.operational_export
        where "Referencia de la orden" = $1
        order by "Nombre"`,
      [order.reference],
    );
    expect(exported.rows).toHaveLength(2);
    expect(exported.rows.map((row) => row.name)).toEqual(["Ana", "Beto"]);
    expect(exported.rows.every((row) => row.price === 17_000_000)).toBe(true);

    // The bundle is a stored product on the line, not a quantity discount.
    const line = await db.query<{ bundle_id: string | null; quantity: number }>(
      "select bundle_id, quantity from public.order_items where order_id = $1",
      [order.orderId],
    );
    expect(line.rows).toHaveLength(1);
    expect(line.rows[0]?.bundle_id).not.toBeNull();
    expect(line.rows[0]?.quantity).toBe(2);
  });

  it("refuses a second companion when only one admission was bought", async () => {
    const order = await createOrder(db, {
      quantity: 1,
      email: "single@example.com",
      key: "pas-single-000001",
    });
    expect(order.totalInCents).toBe(20_000_000);

    await confirmPayment(db, order, "tx-pas-single-1");

    await expectRejection(
      db.query("select public.attach_participant($1, $2, $3::jsonb)", [
        order.reference,
        "single@example.com",
        COMPANION,
      ]),
      /NO_ASSIGNABLE_UNIT|no unassigned admission/,
    );
    expect(
      await countRows(
        db,
        "select count(*)::int as count from public.participants where order_id = $1",
        [order.orderId],
      ),
    ).toBe(1);
  });

  it("attributes each participant to the order line whose admission it takes", async () => {
    // Two one-admission lines on the same order (two sales stages), no participants yet:
    // assignment must fill the first line, then the second, never both on one line.
    const orderId = (
      await db.query<{ id: string }>(
        `insert into public.orders
           (reference, event_id, status, buyer_email, buyer_name, subtotal_cents, total_cents, paid_at)
         values ('EVT-2026-900001',
                 (select id from public.events where code = '${EVENT}'),
                 'PAID', 'lines@example.com', 'Compradora', 42000000, 42000000, now())
         returning id`,
      )
    ).rows[0]?.id;
    if (orderId === undefined) {
      throw new Error("order insert returned no id");
    }

    const tiers = await db.query<{ id: string }>(
      `select id from public.pricing_tiers
        where name in ('General', 'Etapa 2')
        order by sequence`,
    );
    const lineA = (
      await db.query<{ id: string }>(
        `insert into public.order_items
           (order_id, ticket_type_id, pricing_tier_id, quantity, unit_price_cents,
            line_total_cents, ticket_type_name, pricing_tier_name)
         select $1, tt.id, pt.id, 1, 20000000, 20000000, 'Entrada general', pt.name
           from public.pricing_tiers pt
           join public.ticket_types tt on tt.id = pt.ticket_type_id
          where pt.id = $2
         returning id`,
        [orderId, tiers.rows[0]?.id ?? ""],
      )
    ).rows[0]?.id;
    const lineB = (
      await db.query<{ id: string }>(
        `insert into public.order_items
           (order_id, ticket_type_id, pricing_tier_id, quantity, unit_price_cents,
            line_total_cents, ticket_type_name, pricing_tier_name)
         select $1, tt.id, pt.id, 1, 22000000, 22000000, 'Entrada general', pt.name
           from public.pricing_tiers pt
           join public.ticket_types tt on tt.id = pt.ticket_type_id
          where pt.id = $2
         returning id`,
        [orderId, tiers.rows[1]?.id ?? ""],
      )
    ).rows[0]?.id;

    const first = await attach(db, "EVT-2026-900001", "lines@example.com", COMPANION);
    const second = await attach(db, "EVT-2026-900001", "lines@example.com", THIRD);
    expect(first.unit).toBe(1);
    expect(second.unit).toBe(2);
    expect(second.remainingUnassigned).toBe(0);

    const assigned = await db.query<{ order_item_id: string | null }>(
      "select order_item_id from public.participants where order_id = $1 order by created_at, id",
      [orderId],
    );
    const assignedIds = assigned.rows.map((row) => row.order_item_id).sort();
    expect(assignedIds).toEqual([lineA, lineB].sort());
  });
});
