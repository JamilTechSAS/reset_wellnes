/**
 * Post-purchase email outbox (migration 20261024210000).
 *
 * These tests run the real payment flow through the shipped SQL — `create_order` /
 * `create_bundle_order`, then `confirm_payment` — and assert what the trigger and the two RPCs
 * actually do:
 *
 *   - exactly one email intent per order, written inside the PAID transition;
 *   - nothing for a pending, declined or expired order;
 *   - a replay or a repeated PAID update adds no second job;
 *   - the claim leases a row once, a stale lease is recoverable, and only the current token
 *     can finish it;
 *   - the read model refuses an unpaid order or a changed recipient, and exposes only the
 *     buyer's own masked document plus admission counts.
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

type Order = {
  replayed: boolean;
  orderId: string;
  reference: string;
  status: string;
  quantity: number;
  totalInCents: number;
  pricingTierName: string;
};

type Delivery = {
  id: string;
  order_id: string;
  template: string;
  idempotency_key: string;
  recipient_email: string;
  status: string;
  attempt_count: number;
  claim_token: string | null;
  claim_expires_at: string | null;
  sent_at: string | null;
  last_error: string | null;
  next_attempt_at: string | null;
};

type Context = {
  deliveryId: string;
  recipientEmail: string;
  orderReference: string;
  quantity: number;
  registeredParticipants: number;
  unitPriceInCents: number;
  packageName: string | null;
  bundleCode: string | null;
  buyerFirstName: string | null;
  buyerLastName: string | null;
  buyerDocumentLast4: string | null;
  totalInCents: number;
  eventName: string;
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
    truncate table public.order_email_deliveries, public.orders, public.pricing_tiers,
                   public.ticket_bundles, public.ticket_types, public.events cascade;
  `);
  await db.exec(`
    insert into public.events (code, name, starts_at, status, currency, capacity)
    values ('${EVENT}', 'Evento de prueba', now() + interval '60 days', 'PUBLISHED', 'COP', 200);

    insert into public.ticket_types (event_id, code, name)
    select id, 'GENERAL', 'Entrada general' from public.events where code = '${EVENT}';

    insert into public.pricing_tiers
      (ticket_type_id, name, sequence, price_cents, quantity_limit, max_per_order, sales_starts_at)
    select id, 'Preventa', 1, 16000000, null, 1, now() - interval '1 day'
      from public.ticket_types where code = 'GENERAL';

    insert into public.pricing_tiers
      (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
    select id, 'General', 2, 20000000, null, now() - interval '1 day'
      from public.ticket_types where code = 'GENERAL';

    insert into public.ticket_bundles
      (event_id, ticket_type_id, pricing_tier_id, code, name, included_admissions, price_cents)
    select tt.event_id, tt.id, t.id, 'SHARE_EXPERIENCE', 'Comparte tu experiencia', 3, 50970000
      from public.ticket_types tt
      join public.pricing_tiers t on t.ticket_type_id = tt.id and t.sequence = 2
     where tt.code = 'GENERAL';
  `);
}

/** Ends Preventa's window so General (where the package lives) is the open stage. */
async function openGeneralStage(): Promise<void> {
  await db.exec(`
    update public.pricing_tiers set sales_ends_at = now() where sequence = 1;
    update public.pricing_tiers set sales_starts_at = now() - interval '1 minute' where sequence = 2;
  `);
}

async function createOrder(
  quantity: number,
  options: { readonly bundle?: boolean; readonly key?: string; readonly email?: string } = {},
): Promise<Order> {
  const email = options.email ?? "buyer@example.com";
  const key = options.key === undefined ? "null" : `'${options.key}'`;
  const sql = options.bundle
    ? `select public.create_bundle_order(
         '${EVENT}','GENERAL',${String(quantity)},15,
         '${email}','Comprador','3001234567','${PARTICIPANT}'::jsonb,
         'SHARE_EXPERIENCE',null,${key},'181.10.20.30','vitest/1.0','epayco') as o`
    : `select public.create_order(
         '${EVENT}','GENERAL',${String(quantity)},15,
         '${email}','Comprador','3001234567','${PARTICIPANT}'::jsonb,
         null,${key},'181.10.20.30','vitest/1.0','epayco') as o`;
  const result = await db.query<{ o: Order }>(sql);
  const row = result.rows[0]?.o;
  if (row === undefined) {
    throw new Error("create_order returned no row");
  }
  return row;
}

async function confirm(
  order: Order,
  status = "ACEPTADA",
  transactionId = `tx-${order.reference}`,
): Promise<string> {
  const result = await db.query<{ r: { result: string; orderStatus: string } }>(
    `select public.confirm_payment(
       '${order.reference}','${order.reference}','${transactionId}','${status}',
       ${String(order.totalInCents)},'COP','CARD','Mensaje',
       '{"id":"${transactionId}"}'::jsonb,'epayco') as r`,
  );
  return result.rows[0]?.r.result ?? "NO_RESULT";
}

async function deliveries(): Promise<Delivery[]> {
  const result = await db.query<Delivery>(
    "select * from public.order_email_deliveries order by created_at",
  );
  return result.rows;
}

async function claim(
  now: string = new Date().toISOString(),
  leaseSeconds = 60,
): Promise<Delivery[]> {
  const result = await db.query<Delivery>(
    `select * from public.claim_order_email_deliveries(10, '${now}'::timestamptz, ${String(
      leaseSeconds,
    )}, 5)`,
  );
  return result.rows;
}

async function finish(input: {
  readonly deliveryId: string;
  readonly token: string;
  readonly status: "SENT" | "FAILED" | "CANCELLED";
  readonly error?: string;
  readonly nextAttemptAt?: string;
  readonly messageId?: string;
}): Promise<number> {
  const result = await db.query<{ r: { updatedCount: number } }>(
    `select public.finish_order_email_delivery(
       '${input.deliveryId}','${input.token}','${input.status}',
       ${input.messageId === undefined ? "null" : `'${input.messageId}'`},
       ${input.error === undefined ? "null" : `'${input.error}'`},
       ${input.nextAttemptAt === undefined ? "null" : `'${input.nextAttemptAt}'::timestamptz`}) as r`,
  );
  return result.rows[0]?.r.updatedCount ?? -1;
}

async function context(deliveryId: string): Promise<Context | null> {
  const result = await db.query<{ c: Context | null }>(
    `select public.get_post_purchase_email_context('${deliveryId}') as c`,
  );
  return result.rows[0]?.c ?? null;
}

async function count(sql: string): Promise<number> {
  const result = await db.query<{ n: number }>(sql);
  return result.rows[0]?.n ?? -1;
}

async function paidOrder(
  quantity = 1,
  options: { readonly bundle?: boolean } = {},
): Promise<{ order: Order; delivery: Delivery }> {
  const order = await createOrder(quantity, options);
  await confirm(order);
  const [delivery] = await deliveries();
  if (delivery === undefined) {
    throw new Error("no delivery was queued");
  }
  return { order, delivery };
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

describe("enqueue on the PAID transition", () => {
  it("writes exactly one email intent when a verified approval pays the order", async () => {
    const order = await createOrder(1);
    expect(await deliveries()).toHaveLength(0);

    expect(await confirm(order)).toBe("APPLIED");
    expect(
      await count(`select status as n from public.orders where reference = '${order.reference}'`),
    ).toBe("PAID");

    const queued = await deliveries();
    expect(queued).toHaveLength(1);
    const delivery = queued[0]!;
    expect(delivery.order_id).toBe(order.orderId);
    expect(delivery.template).toBe("POST_PURCHASE");
    expect(delivery.status).toBe("QUEUED");
    expect(delivery.attempt_count).toBe(0);
    expect(delivery.recipient_email).toBe("buyer@example.com");
    expect(delivery.idempotency_key).toBe(`order:${order.orderId}:POST_PURCHASE`);
    expect(delivery.claim_token).toBeNull();
  });

  it("adds no job for a replayed approval or a repeated PAID update", async () => {
    const order = await createOrder(1);
    await confirm(order);
    // Same transaction delivered again: the confirmation is a DUPLICATE and the order is
    // already PAID, so the trigger's transition guard skips it.
    expect(await confirm(order)).toBe("DUPLICATE");
    await db.exec(
      `update public.orders set status = 'PAID' where reference = '${order.reference}'`,
    );

    expect(await deliveries()).toHaveLength(1);
    expect(await count("select count(*) as n from public.orders")).toBe(1);
  });

  it("queues nothing for a declined transaction", async () => {
    const order = await createOrder(1);
    await confirm(order, "RECHAZADA");

    expect(await deliveries()).toHaveLength(0);
    expect(
      await count(
        `select status::text as n from public.orders where reference = '${order.reference}'`,
      ),
    ).not.toBe("PAID");
  });

  it("queues nothing when the reservation expires instead of being paid", async () => {
    const order = await createOrder(1);
    await db.exec(
      `update public.orders set status = 'EXPIRED' where reference = '${order.reference}'`,
    );
    expect(await deliveries()).toHaveLength(0);
  });

  it("never claims a row whose order is not PAID", async () => {
    const order = await createOrder(1);
    // A row can only appear through the trigger, which requires PAID; insert one by hand to
    // prove the claim itself refuses an unpaid order too.
    await db.exec(`
      insert into public.order_email_deliveries (order_id, template, recipient_email, idempotency_key)
      values ('${order.orderId}', 'POST_PURCHASE', 'buyer@example.com',
              'order:${order.orderId}:POST_PURCHASE');
    `);
    expect(await deliveries()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);
    expect(await context((await deliveries())[0]!.id)).toBeNull();
  });

  it("enforces one row per order and the derived key", async () => {
    const { order } = await paidOrder();
    expect(
      await rejection(
        db.query(`
          insert into public.order_email_deliveries (order_id, template, recipient_email, idempotency_key)
          values ('${order.orderId}', 'POST_PURCHASE', 'buyer@example.com',
                  'order:${order.orderId}:POST_PURCHASE');
        `),
      ),
    ).toMatch(/order_email_deliveries_order_template_unique|duplicate key/);

    const another = await createOrder(1, { email: "otro@example.com" });
    expect(
      await rejection(
        db.query(`
          insert into public.order_email_deliveries (order_id, template, recipient_email, idempotency_key)
          values ('${another.orderId}', 'POST_PURCHASE', 'otro@example.com', 'order:wrong:key');
        `),
      ),
    ).toMatch(/order_email_deliveries_key_derivation_check|check constraint/);
  });

  it("requires a lease token while a row is SENDING", async () => {
    const { order } = await paidOrder();
    expect(
      await rejection(
        db.query(`
          update public.order_email_deliveries
             set status = 'SENDING'
           where order_id = '${order.orderId}';
        `),
      ),
    ).toMatch(/order_email_deliveries_lease_check|check constraint/);
  });
});

describe("claim, lease and finish", () => {
  it("leases the row once and only the current token can finish it", async () => {
    const { delivery } = await paidOrder();

    const [first] = await claim();
    expect(first?.id).toBe(delivery.id);
    expect(first?.status).toBe("SENDING");
    expect(first?.attempt_count).toBe(1);
    expect(first?.claim_token).not.toBeNull();
    expect(first?.claim_expires_at).not.toBeNull();

    // A second worker at the same instant gets nothing: the row is leased.
    expect(await claim()).toHaveLength(0);

    // A token that does not own the lease cannot finish (or mark!) the row.
    expect(
      await finish({
        deliveryId: delivery.id,
        token: "99999999-9999-4999-8999-999999999999",
        status: "SENT",
      }),
    ).toBe(0);

    const token = first!.claim_token!;
    expect(
      await finish({ deliveryId: delivery.id, token, status: "SENT", messageId: "re_1" }),
    ).toBe(1);

    const [sent] = await deliveries();
    expect(sent?.status).toBe("SENT");
    expect(sent?.sent_at).not.toBeNull();
    expect(sent?.claim_token).toBeNull();
    expect(sent?.claim_expires_at).toBeNull();

    // SENT is final: it is never claimed again, so it can never be resent automatically.
    expect(await claim()).toHaveLength(0);
  });

  it("recovers a stale lease and the old worker cannot overwrite the new attempt", async () => {
    const { delivery } = await paidOrder();
    // A minute after the row was queued, so "due" is unambiguous.
    const t0 = new Date(Date.now() + 60_000);
    const [first] = await claim(t0.toISOString(), 60);

    const later = new Date(t0.getTime() + 61_000);
    const [second] = await claim(later.toISOString(), 60);
    expect(second?.id).toBe(delivery.id);
    expect(second?.attempt_count).toBe(2);
    expect(second?.claim_token).not.toBe(first?.claim_token);

    // The expired worker returns: its finish is a no-op, so it cannot mark the row SENT.
    expect(
      await finish({
        deliveryId: delivery.id,
        token: first!.claim_token!,
        status: "SENT",
        messageId: "re_old",
      }),
    ).toBe(0);
    expect((await deliveries())[0]?.status).toBe("SENDING");

    expect(
      await finish({
        deliveryId: delivery.id,
        token: second!.claim_token!,
        status: "SENT",
        messageId: "re_new",
      }),
    ).toBe(1);
    expect((await deliveries())[0]?.status).toBe("SENT");
  });

  it("waits for the scheduled retry instant after a retryable failure", async () => {
    const { delivery } = await paidOrder();
    const t0 = new Date(Date.now() + 60_000);
    const [first] = await claim(t0.toISOString());

    const nextAttempt = new Date(t0.getTime() + 5 * 60_000);
    expect(
      await finish({
        deliveryId: delivery.id,
        token: first!.claim_token!,
        status: "FAILED",
        error: "provider returned HTTP 503",
        nextAttemptAt: nextAttempt.toISOString(),
      }),
    ).toBe(1);

    const [failed] = await deliveries();
    expect(failed?.status).toBe("FAILED");
    expect(failed?.last_error).toBe("provider returned HTTP 503");
    expect(failed?.claim_token).toBeNull();

    // Before the instant: nothing. At the instant: the next attempt is leased.
    expect(await claim(new Date(t0.getTime() + 60_000).toISOString())).toHaveLength(0);
    const [retried] = await claim(nextAttempt.toISOString());
    expect(retried?.id).toBe(delivery.id);
    expect(retried?.attempt_count).toBe(2);
  });

  it("rejects a retryable failure with no next attempt and an unknown status", async () => {
    const { delivery } = await paidOrder();
    const [first] = await claim();

    expect(
      await rejection(
        db.query(
          `select public.finish_order_email_delivery('${delivery.id}','${first!.claim_token!}','FAILED')`,
        ),
      ),
    ).toMatch(/INVALID_RETRY_SCHEDULE/);

    expect(
      await rejection(
        db.query(
          `select public.finish_order_email_delivery('${delivery.id}','${first!.claim_token!}','QUEUED')`,
        ),
      ),
    ).toMatch(/INVALID_EMAIL_STATUS/);
  });
});

describe("read model", () => {
  it("refuses a recipient that is no longer the order's buyer email", async () => {
    const { delivery } = await paidOrder();
    expect((await context(delivery.id))?.recipientEmail).toBe("buyer@example.com");

    await db.exec(
      `update public.order_email_deliveries set recipient_email = 'intruso@example.com' where id = '${delivery.id}'`,
    );
    expect(await context(delivery.id)).toBeNull();
  });

  it("exposes the buyer's masked document and the real admission counts only", async () => {
    await openGeneralStage();
    const { order, delivery } = await paidOrder(3);
    const first = await context(delivery.id);
    expect(first).not.toBeNull();
    expect(first?.orderReference).toBe(order.reference);
    expect(first?.quantity).toBe(3);
    expect(first?.registeredParticipants).toBe(1);
    expect(first?.buyerFirstName).toBe("Ana");
    expect(first?.buyerDocumentLast4).toBe("6789");
    expect(first?.eventName).toBe("Evento de prueba");

    // The full document (and any column beyond the display fields) is never part of the model.
    const raw = JSON.stringify(first);
    expect(raw).not.toContain("1020456789");
    expect(raw).not.toContain("1.020.456.789");
    expect(raw).not.toContain("national_id");
    expect(raw).not.toContain("ana@example.com");

    // Registering the two companions updates the count the email reports.
    for (const [firstName, id] of [
      ["Luis", "1.020.456.790"],
      ["Marta", "1.020.456.791"],
    ] as const) {
      await db.query(
        `select public.attach_participant('${order.reference}','buyer@example.com',
           '{"firstName":"${firstName}","lastName":"Ríos","nationalId":"${id}",
             "email":"${firstName.toLowerCase()}@example.com","phone":"+57 300 123 4568",
             "city":"Montería","consents":{"dataProcessing":true,"futureEvents":false}}'::jsonb) as a`,
      );
    }
    expect((await context(delivery.id))?.registeredParticipants).toBe(3);
  });

  it("reports the package, its three admissions and the fixed price", async () => {
    await openGeneralStage();
    const { delivery } = await paidOrder(3, { bundle: true });
    const bundle = await context(delivery.id);

    expect(bundle?.bundleCode).toBe("SHARE_EXPERIENCE");
    expect(bundle?.packageName).toBe("Comparte tu experiencia");
    expect(bundle?.quantity).toBe(3);
    expect(bundle?.registeredParticipants).toBe(1);
    expect(bundle?.unitPriceInCents).toBe(16_990_000);
    expect(bundle?.totalInCents).toBe(50_970_000);
  });
});
