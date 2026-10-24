/**
 * H7: ePayco transaction states 6-11 through the real `confirm_payment` (migration
 * 20261023130000), run on PGlite with every migration applied.
 *
 *   6  Reversada  -> voided; after an approval: refunded + RECONCILIATION_REQUIRED, order and
 *                    tickets untouched (manual review)
 *   7  Retenida, 8 Iniciada -> pending (no tickets)
 *   9  Expirada, 10 Abandonada, 11 Cancelada -> declined (order FAILED; never downgrades an
 *                    approval)
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "./helpers.ts";

const EVENT = "EPAYCO-H7";

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

type Confirmation = {
  result: string;
  reason: string;
  orderStatus: string;
  paymentStatus: string;
  ticketsIssued: number;
  reconciliationRequired: boolean;
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await db.exec(`
    do $$
    declare v_event uuid; v_tt uuid;
    begin
      insert into public.events (code, name, starts_at, status, capacity, venue_name, city)
        values ('${EVENT}', 'Evento H7', now() + interval '60 days', 'PUBLISHED', 50,
                'Teatro', 'Bogotá')
        returning id into v_event;
      insert into public.ticket_types (event_id, code, name, min_per_order, max_per_order)
        values (v_event, 'GENERAL', 'Entrada general', 1, 10) returning id into v_tt;
      insert into public.pricing_tiers
        (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
        values (v_tt, 'Única', 1, 1000000, 20, now() - interval '1 day');
    end $$;
  `);
}, 30_000);

beforeEach(async () => {
  await db.exec(`
    delete from public.attendance;
    delete from public.email_deliveries;
    delete from public.tickets;
    delete from public.consents;
    delete from public.participants;
    delete from public.discount_redemptions;
    delete from public.payment_events;
    delete from public.payments;
    delete from public.order_items;
    delete from public.orders;
    update public.pricing_tiers set quantity_reserved = 0, quantity_sold = 0;
  `);
});

afterAll(async () => {
  await db.close();
});

async function createOrder(quantity = 2): Promise<OrderResult> {
  const result = await db.query<{ o: OrderResult }>(
    `select public.create_order(
       '${EVENT}','GENERAL',${String(quantity)},15,
       'buyer@example.com','Comprador','3001234567','${PARTICIPANT}'::jsonb,
       null,null,'181.10.20.30','vitest/1.0') as o`,
  );
  const order = result.rows[0]?.o;
  if (order === undefined) {
    throw new Error("create_order returned no row");
  }
  return order;
}

/** Confirms through the real function; `provider` null omits `p_provider` (its default). */
async function confirm(
  order: OrderResult,
  status: string,
  provider: "epayco" | "wompi" | null = "epayco",
): Promise<Confirmation> {
  const providerArg = provider === null ? "" : `, p_provider => '${provider}'`;
  const result = await db.query<{ r: Confirmation }>(
    `select public.confirm_payment(
       p_order_reference => '${order.reference}',
       p_wompi_reference => '${order.wompiReference}',
       p_wompi_transaction_id => 'ref-payco-1',
       p_wompi_status => '${status}',
       p_amount_cents => ${String(order.totalInCents)},
       p_currency => 'COP'${providerArg}
     ) as r`,
  );
  const row = result.rows[0]?.r;
  if (row === undefined) {
    throw new Error("confirm_payment returned no row");
  }
  return row;
}

async function snapshot(order: OrderResult) {
  const result = await db.query<{
    payment_status: string;
    order_status: string;
    active_tickets: number;
    tickets: number;
    reserved: number;
    sold: number;
    message: string | null;
  }>(
    `select p.status::text as payment_status,
            o.status::text as order_status,
            (select count(*)::int from public.tickets t where t.order_id = o.id and t.status = 'ACTIVE') as active_tickets,
            (select count(*)::int from public.tickets t where t.order_id = o.id) as tickets,
            pt.quantity_reserved as reserved,
            pt.quantity_sold as sold,
            p.status_message as message
       from public.orders o
       join public.payments p on p.order_id = o.id
       join public.pricing_tiers pt on pt.name = 'Única'
      where o.id = '${order.orderId}'`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("no snapshot");
  }
  return row;
}

describe("ePayco codes 6-11 on an unpaid order", () => {
  it.each([
    ["6", "voided", "FAILED"],
    ["REVERSADA", "voided", "FAILED"],
    ["7", "pending", "PENDING"],
    ["RETENIDA", "pending", "PENDING"],
    ["8", "pending", "PENDING"],
    ["INICIADA", "pending", "PENDING"],
    ["9", "declined", "FAILED"],
    ["CADUCADA", "declined", "FAILED"],
    ["EXPIRADA", "declined", "FAILED"],
    ["10", "declined", "FAILED"],
    ["ABANDONADA", "declined", "FAILED"],
    ["11", "declined", "FAILED"],
    ["CANCELADA", "declined", "FAILED"],
  ])("maps %s to %s, order %s, and never issues tickets", async (code, payment, order) => {
    const created = await createOrder();
    const result = await confirm(created, code);
    const state = await snapshot(created);

    expect(result.paymentStatus).toBe(payment);
    expect(result.orderStatus).toBe(order);
    expect(result.ticketsIssued).toBe(0);
    expect(state.tickets).toBe(0);
    // Reservation untouched (released only by expiry); nothing sold.
    expect(state.reserved).toBe(2);
    expect(state.sold).toBe(0);
  });

  it.each(["5", "12", "99", "RARO"])(
    "keeps the unknown code %s as unknown and pending",
    async (code) => {
      const created = await createOrder();
      const result = await confirm(created, code);

      expect(result.paymentStatus).toBe("pending");
      expect(result.reason).toBe("UNKNOWN_PROVIDER_STATUS");
      expect(result.orderStatus).toBe("PENDING");
      expect(result.ticketsIssued).toBe(0);
    },
  );

  it("is idempotent for a repeated expiry notification", async () => {
    const created = await createOrder();
    expect((await confirm(created, "9")).result).toBe("APPLIED");
    const again = await confirm(created, "9");
    expect(again.result).toBe("DUPLICATE");
    expect(again.paymentStatus).toBe("declined");
  });

  it("still pays the order when a held transaction is later approved", async () => {
    const created = await createOrder();
    await confirm(created, "7");
    const approved = await confirm(created, "1");
    const state = await snapshot(created);

    expect(approved.orderStatus).toBe("PAID");
    // Tickets are discontinued: no ticket rows, but inventory still moves reserved -> sold.
    expect(state.active_tickets).toBe(0);
    expect(state.reserved).toBe(0);
    expect(state.sold).toBe(2);
  });
});

describe("ePayco codes after the order was paid", () => {
  async function paidOrder() {
    const created = await createOrder();
    const approved = await confirm(created, "1");
    expect(approved.orderStatus).toBe("PAID");
    expect(approved.ticketsIssued).toBe(0);
    return created;
  }

  it.each(["7", "8", "9", "10", "11"])(
    "never downgrades an approval on %s, and issues no extra tickets",
    async (code) => {
      const created = await paidOrder();
      const result = await confirm(created, code);
      const state = await snapshot(created);

      expect(result.paymentStatus).toBe("approved");
      expect(result.orderStatus).toBe("PAID");
      expect(result.ticketsIssued).toBe(0);
      expect(state.tickets).toBe(0);
      expect(state.active_tickets).toBe(0);
      expect(state.sold).toBe(2);
      expect(state.reserved).toBe(0);
    },
  );

  it("records a reversal as refunded and asks for manual review, touching nothing else", async () => {
    const created = await paidOrder();
    const reversal = await confirm(created, "6");
    const state = await snapshot(created);

    expect(reversal.result).toBe("RECONCILIATION_REQUIRED");
    expect(reversal.reason).toBe("PAYMENT_REVERSED_AFTER_APPROVAL");
    expect(reversal.reconciliationRequired).toBe(true);
    expect(reversal.paymentStatus).toBe("refunded");
    // No automatic refund, ticket void or stock release: those are business decisions.
    expect(state.order_status).toBe("PAID");
    expect(state.active_tickets).toBe(0);
    expect(state.sold).toBe(2);
    expect(state.message).toMatch(/manual review required/);
  });

  it("reports a repeated reversal as a duplicate without flagging it again", async () => {
    const created = await paidOrder();
    await confirm(created, "6");
    const again = await confirm(created, "6");

    expect(again.result).toBe("DUPLICATE");
    expect(again.reconciliationRequired).toBe(false);
    expect(again.paymentStatus).toBe("refunded");
  });

  it("does not re-approve or re-issue after a reversal", async () => {
    const created = await paidOrder();
    await confirm(created, "6");
    const late = await confirm(created, "1");
    const state = await snapshot(created);

    expect(late.paymentStatus).toBe("refunded");
    expect(state.tickets).toBe(0);
    expect(state.sold).toBe(2);
  });
});

describe("Wompi semantics are unchanged", () => {
  it("keeps the old result for VOIDED after APPROVED from the Wompi provider", async () => {
    const created = await createOrder();
    await confirm(created, "APPROVED", "wompi");
    const voided = await confirm(created, "VOIDED", "wompi");

    expect(voided.result).toBe("APPLIED");
    expect(voided.reason).toBe("PAYMENT_REFUNDED");
    expect(voided.reconciliationRequired).toBe(false);
    expect(voided.paymentStatus).toBe("refunded");
    expect(voided.orderStatus).toBe("PAID");
  });

  it("refuses a confirmation that does not name its provider (H15)", async () => {
    const created = await createOrder();
    await expect(confirm(created, "APPROVED", null)).rejects.toThrow(/INVALID_PROVIDER|provider/i);
  });
});
