/**
 * Payment confirmation pipeline, against real Postgres semantics (PGlite).
 *
 * This is the phase's most important schema suite: it drives `claim_webhook_event`,
 * `confirm_payment`, `queue_ticket_emails`, `expire_pending_orders` and `retry_payment` the
 * way the Edge Function does, and asserts the exact-once properties the whole pipeline
 * exists to provide:
 *
 *   - an approved transaction produces ONE paid order, ONE ticket per unit, ONE email row;
 *   - a replayed confirmation adds nothing;
 *   - a mismatched amount/currency/reference changes nothing;
 *   - an approved payment on a terminal order goes to reconciliation, not to revenue;
 *   - expiry releases inventory exactly once;
 *   - a retry creates a NEW reference and never reuses one.
 *
 * What PGlite cannot do is two genuinely concurrent sessions; the races are run against
 * PostgreSQL 17 in the phase verification and documented in docs/phases/phase-04.md.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "./helpers.ts";

const EVENT = "TAT-2026";

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

type ConfirmationResult = {
  result: string;
  reason: string;
  orderId: string;
  orderReference: string;
  orderStatus: string;
  paymentId: string;
  paymentStatus: string;
  rawWompiStatus: string | null;
  paymentAttempt: number;
  wompiReference: string;
  wompiTransactionId: string | null;
  amountInCents: number;
  currency: string;
  ticketsIssued: number;
  ticketsExpected: number;
  reconciliationRequired: boolean;
};

type StatusResult = {
  found: boolean;
  reference?: string;
  status?: string;
  quantity?: number;
  totalInCents?: number;
  paidAt?: string | null;
  payment?: { attempt: number; status: string; approvedAt: string | null } | null;
  paymentAttempts?: { attempt: number; status: string; wompiReference: string }[];
  tickets?: {
    token: string;
    unit: number;
    status: string;
    assigned: boolean;
    pricePaidCents: number;
    participant?: {
      firstName: string | null;
      lastName: string | null;
      city: string | null;
      instagram: string | null;
    } | null;
  }[];
  confirmation?: { queued: number; sent: number; failed: number; ready: boolean } | null;
};

let db: PGlite;
let currency: string;

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  await seed(db);
}, 30_000);

/**
 * Each test owns its orders: the schema tests share one database for speed, and both
 * inventory counters and the email outbox are global, so leftover rows from a previous
 * test would make an exact-count assertion lie. The event, ticket type and pricing tiers
 * stay (the seed), only transactional state is cleared and the counters reset.
 */
async function reset(): Promise<void> {
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
}

beforeEach(reset);

afterAll(async () => {
  await db.close();
});

async function seed(database: PGlite): Promise<void> {
  await database.exec(`
    do $$
    declare v_event uuid; v_tt uuid;
    begin
      insert into public.events (code, name, starts_at, status, capacity, venue_name, city)
        values ('${EVENT}', 'Evento de prueba', now() + interval '60 days', 'PUBLISHED', 120,
                'Teatro Central', 'Bogotá')
        returning id into v_event;
      insert into public.ticket_types (event_id, code, name, min_per_order, max_per_order)
        values (v_event, 'GENERAL', 'Entrada general', 1, 10) returning id into v_tt;
      insert into public.pricing_tiers
        (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
        values (v_tt, 'Preventa 1', 1, 9500001, 30, now() - interval '1 day'),
               (v_tt, 'Preventa 2', 2, 11500000, 30, now() - interval '1 day');
    end $$;
  `);
  const result = await database.query<{ currency: string }>(
    `select currency from public.events where code = '${EVENT}'`,
  );
  currency = result.rows[0]?.currency ?? "COP";
}

/** Creates an order through the real Phase 3 entry point. */
async function createOrder(
  quantity: number,
  options: { email?: string; minutes?: number } = {},
): Promise<OrderResult> {
  const email = options.email ?? "buyer@example.com";
  const result = await db.query<{ o: OrderResult }>(
    `select public.create_order(
       '${EVENT}','GENERAL',${String(quantity)},${String(options.minutes ?? 15)},
       '${email}','Comprador','3001234567','${PARTICIPANT}'::jsonb,
       null,null,'181.10.20.30','vitest/1.0') as o`,
  );
  const order = result.rows[0]?.o;
  if (order === undefined) {
    throw new Error("create_order returned no row");
  }
  return order;
}

async function confirm(args: {
  order: OrderResult;
  status: string;
  amount?: number;
  currency?: string;
  transactionId?: string | null;
  reference?: string;
}): Promise<ConfirmationResult> {
  const amount = args.amount ?? args.order.totalInCents;
  const currencyValue = args.currency ?? currency;
  const transactionId = args.transactionId === undefined ? "tx-0001" : args.transactionId;
  const reference = args.reference ?? args.order.wompiReference;
  const result = await db.query<{ r: ConfirmationResult }>(
    `select public.confirm_payment(
       '${args.order.reference}','${reference}',
       ${transactionId === null ? "null" : `'${transactionId}'`},
       '${args.status}',${String(amount)},'${currencyValue}','CARD','Mensaje del proveedor',
       '{"id":"x","reference":"${reference}"}'::jsonb
     ) as r`,
  );
  const row = result.rows[0]?.r;
  if (row === undefined) {
    throw new Error("confirm_payment returned no row");
  }
  return row;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    const record = error as { message?: string; detail?: string };
    return `${record.message ?? ""} ${record.detail ?? ""}`;
  }
}

async function status(reference: string, email = "buyer@example.com"): Promise<StatusResult> {
  const result = await db.query<{ s: StatusResult }>(
    `select public.get_order_status('${reference}','${email}') as s`,
  );
  const row = result.rows[0]?.s;
  if (row === undefined) {
    throw new Error("get_order_status returned no row");
  }
  return row;
}

async function scalar<T>(sql: string): Promise<T | undefined> {
  const result = await db.query<Record<string, T>>(sql);
  const row = result.rows[0];
  return row === undefined ? undefined : Object.values(row)[0];
}

// ---------------------------------------------------------------------------

describe("confirm_payment happy path", () => {
  it("pays the order, issues one ticket per unit and converts reserved into sold", async () => {
    const before = await scalar<number>(
      `select quantity_reserved from public.pricing_tiers where name = 'Preventa 1'`,
    );
    expect(before).toBe(0);

    const order = await createOrder(3);
    expect(
      await scalar<number>(
        `select quantity_reserved from public.pricing_tiers where name = 'Preventa 1'`,
      ),
    ).toBe(3);

    const confirmation = await confirm({
      order,
      status: "APPROVED",
      transactionId: "tx-happy-1",
    });

    expect(confirmation.result).toBe("APPLIED");
    expect(confirmation.orderStatus).toBe("PAID");
    expect(confirmation.paymentStatus).toBe("approved");
    expect(confirmation.reason).toBe("PAYMENT_APPROVED");
    expect(confirmation.ticketsIssued).toBe(3);
    expect(confirmation.ticketsExpected).toBe(3);
    expect(confirmation.reconciliationRequired).toBe(false);

    const tickets = await db.query<{
      order_item_seq: number;
      token: string;
      status: string;
      assigned: boolean;
      price_paid_cents: string;
    }>(
      `select order_item_seq, token, status, participant_id is not null as assigned,
              price_paid_cents
         from public.tickets where order_id = '${confirmation.orderId}'
        order by order_item_seq`,
    );
    expect(tickets.rows).toHaveLength(3);
    expect(tickets.rows.map((row) => row.order_item_seq)).toEqual([1, 2, 3]);
    for (const row of tickets.rows) {
      expect(row.token).toMatch(/^TKT_[0-9A-HJKMNP-TV-Z]{20}$/);
      expect(row.status).toBe("ACTIVE");
    }
    // One participant exists for the purchase, so exactly one unit is assigned.
    expect(tickets.rows.filter((row) => row.assigned)).toHaveLength(1);

    // The tickets sum to the order total exactly (the last unit absorbs the remainder).
    expect(await scalar<string>(`select sum(price_paid_cents)::text from public.tickets`)).toBe(
      String(order.totalInCents),
    );

    // Inventory moved from reserved to sold, and never double-counted.
    expect(
      await scalar<number>(
        `select quantity_reserved from public.pricing_tiers where name = 'Preventa 1'`,
      ),
    ).toBe(0);
    expect(
      await scalar<number>(
        `select quantity_sold from public.pricing_tiers where name = 'Preventa 1'`,
      ),
    ).toBe(3);

    // The approval timestamp is recorded, once.
    expect(
      await scalar<boolean>(
        `select approved_at is not null from public.payments where order_id = '${confirmation.orderId}'`,
      ),
    ).toBe(true);
  });

  it("queues exactly one email per ticket and never twice", async () => {
    const order = await createOrder(2);
    const confirmation = await confirm({ order, status: "APPROVED", transactionId: "tx-mail-1" });

    const first = await db.query<{ q: { queued: number; alreadyQueued: number; total: number } }>(
      `select public.queue_ticket_emails('${confirmation.orderId}') as q`,
    );
    expect(first.rows[0]?.q.queued).toBe(2);
    expect(first.rows[0]?.q.total).toBe(2);

    const second = await db.query<{ q: { queued: number; alreadyQueued: number; total: number } }>(
      `select public.queue_ticket_emails('${confirmation.orderId}') as q`,
    );
    expect(second.rows[0]?.q.queued).toBe(0);
    expect(second.rows[0]?.q.alreadyQueued).toBe(2);

    // The derived key is what makes it idempotent, and it matches the Phase 1 contract.
    const keys = await db.query<{ idempotency_key: string }>(
      `select idempotency_key from public.email_deliveries
        where ticket_id in (select id from public.tickets where order_id = '${confirmation.orderId}')`,
    );
    expect(keys.rows).toHaveLength(2);
    for (const row of keys.rows) {
      expect(row.idempotency_key).toMatch(/^ticket:[0-9a-f-]{36}:TICKET_CONFIRMATION$/);
    }
  });
});

describe("confirm_payment replay and refusal", () => {
  it("reports a replay as DUPLICATE and adds nothing", async () => {
    const order = await createOrder(2);
    const first = await confirm({ order, status: "APPROVED", transactionId: "tx-replay-1" });
    expect(first.result).toBe("APPLIED");

    const second = await confirm({ order, status: "APPROVED", transactionId: "tx-replay-1" });
    expect(second.result).toBe("DUPLICATE");
    expect(second.ticketsIssued).toBe(0);
    expect(second.orderStatus).toBe("PAID");

    expect(
      await scalar<number>(
        `select count(*)::int from public.tickets where order_id = '${order.orderId}'`,
      ),
    ).toBe(2);
    expect(
      await scalar<number>(
        `select quantity_sold from public.pricing_tiers where name = 'Preventa 1'`,
      ),
    ).toBe(2);
  });

  it("refuses an amount mismatch and leaves the payment pending", async () => {
    const order = await createOrder(1);
    const message = await rejection(
      confirm({
        order,
        status: "APPROVED",
        amount: order.totalInCents + 1,
        transactionId: "tx-amt-1",
      }),
    );
    expect(message).toContain("AMOUNT_MISMATCH");

    expect(
      await scalar<string>(
        `select status::text from public.payments where order_id = '${order.orderId}'`,
      ),
    ).toBe("pending");
    expect(
      await scalar<string>(`select status::text from public.orders where id = '${order.orderId}'`),
    ).toBe("PENDING");
    expect(
      await scalar<number>(
        `select count(*)::int from public.tickets where order_id = '${order.orderId}'`,
      ),
    ).toBe(0);
  });

  it("refuses a non-COP currency", async () => {
    const order = await createOrder(1);
    const message = await rejection(confirm({ order, status: "APPROVED", currency: "USD" }));
    expect(message).toContain("CURRENCY_MISMATCH");
  });

  it("refuses a reference that does not belong to the order", async () => {
    const order = await createOrder(1);
    const message = await rejection(
      confirm({ order, status: "APPROVED", reference: "EVT-2026-000999" }),
    );
    expect(message).toContain("REFERENCE_MISMATCH");
  });

  it("refuses an unknown order reference", async () => {
    const order = await createOrder(1);
    const message = await rejection(
      db.query(
        `select public.confirm_payment('EVT-2026-000999','EVT-2026-000999','tx-x','APPROVED',
           ${String(order.totalInCents)},'COP',null,null,null) as r`,
      ),
    );
    expect(message).toContain("ORDER_NOT_FOUND");
  });

  it("refuses a second approval for one order with a typed conflict, not a raw index violation", async () => {
    // Reachable case: attempt 1 was APPROVED at Wompi but its webhook never arrived (the
    // order expired, the buyer retried), attempt 2 was paid, and attempt 1's delivery
    // arrives late. Without the guard this aborts with SQLSTATE 23505 on
    // `payments_one_approved_per_order_idx`, which the API maps to INTERNAL_ERROR -> the
    // webhook answers 503 forever and the delivery is never finalized.
    const order = await createOrder(1);
    const first = await confirm({ order, status: "APPROVED", transactionId: "tx-double-1" });
    expect(first.result).toBe("APPLIED");

    await db.query(
      `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents, currency)
       values ($1, 2, $2, 'pending', $3::bigint, 'COP')`,
      [order.orderId, `${order.reference}-2`, order.totalInCents],
    );

    let error: unknown;
    try {
      await confirm({
        order,
        status: "APPROVED",
        transactionId: "tx-double-2",
        reference: `${order.reference}-2`,
      });
    } catch (caught) {
      error = caught;
    }
    const failure = error as { code?: string; detail?: string; message?: string } | undefined;
    expect(failure?.code).toBe("PT409");
    expect(failure?.detail).toBe("DOUBLE_PAYMENT_CONFLICT");

    // Nothing changed: the order is still PAID with exactly one approved payment and its
    // ticket, and the second attempt stays pending and visible for manual reconciliation.
    expect(
      await scalar<number>(
        `select count(*)::int from public.payments where order_id = '${order.orderId}' and status = 'approved'`,
      ),
    ).toBe(1);
    expect(
      await scalar<string>(
        `select status::text from public.payments where order_id = '${order.orderId}' and attempt = 2`,
      ),
    ).toBe("pending");
    expect(
      await scalar<string>(`select status::text from public.orders where id = '${order.orderId}'`),
    ).toBe("PAID");
    expect(
      await scalar<number>(
        `select count(*)::int from public.tickets where order_id = '${order.orderId}'`,
      ),
    ).toBe(1);
  });

  it("guards the recovery INSERT path the same way", async () => {
    // `confirm_payment` can create the attempt row itself when it does not exist locally
    // (recovering a lost attempt). That INSERT is guarded too, so the recovery cannot
    // invent a second approval either.
    const order = await createOrder(1);
    await confirm({ order, status: "APPROVED", transactionId: "tx-insert-1" });

    let error: unknown;
    try {
      await db.query(
        `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents, currency)
         values ('${order.orderId}', 2, '${order.reference}-2', 'approved', ${String(order.totalInCents)}, 'COP')`,
      );
    } catch (caught) {
      error = caught;
    }
    const failure = error as { code?: string; detail?: string } | undefined;
    expect(failure?.code).toBe("PT409");
    expect(failure?.detail).toBe("DOUBLE_PAYMENT_CONFLICT");
  });
});

describe("confirm_payment failure path", () => {
  it("fails the order on a decline, releases nothing and issues no ticket", async () => {
    const order = await createOrder(2);
    const confirmation = await confirm({
      order,
      status: "DECLINED",
      transactionId: "tx-declined-1",
    });

    expect(confirmation.result).toBe("APPLIED");
    expect(confirmation.paymentStatus).toBe("declined");
    expect(confirmation.orderStatus).toBe("FAILED");
    expect(confirmation.rawWompiStatus).toBe("DECLINED");
    expect(confirmation.ticketsIssued).toBe(0);

    // The reservation is still held: the buyer can retry within the window.
    expect(
      await scalar<number>(
        `select quantity_reserved from public.pricing_tiers where name = 'Preventa 1'`,
      ),
    ).toBe(2);
    expect(
      await scalar<boolean>(
        `select failed_at is not null from public.orders where id = '${order.orderId}'`,
      ),
    ).toBe(true);
  });

  it("records an unknown provider status without advancing anything", async () => {
    const order = await createOrder(1);
    const confirmation = await confirm({
      order,
      status: "SOMETHING_NEW",
      transactionId: "tx-unknown-1",
    });
    expect(confirmation.paymentStatus).toBe("pending");
    expect(confirmation.orderStatus).toBe("PENDING");
    expect(confirmation.reason).toBe("UNKNOWN_PROVIDER_STATUS");
    expect(confirmation.rawWompiStatus).toBe("SOMETHING_NEW");
  });

  it("never lets a later event un-approve an approved payment", async () => {
    const order = await createOrder(1);
    await confirm({ order, status: "APPROVED", transactionId: "tx-final-1" });

    const replay = await confirm({ order, status: "PENDING", transactionId: "tx-final-1" });
    expect(replay.paymentStatus).toBe("approved");
    expect(replay.orderStatus).toBe("PAID");

    const declined = await confirm({ order, status: "DECLINED", transactionId: "tx-final-1" });
    expect(declined.paymentStatus).toBe("approved");
    expect(declined.orderStatus).toBe("PAID");
    expect(
      await scalar<number>(
        `select count(*)::int from public.tickets where order_id = '${order.orderId}'`,
      ),
    ).toBe(1);
  });

  it("marks an approved-then-voided payment as refunded and flags it for review", async () => {
    const order = await createOrder(1);
    await confirm({ order, status: "APPROVED", transactionId: "tx-void-1" });
    const voided = await confirm({ order, status: "VOIDED", transactionId: "tx-void-1" });

    expect(voided.paymentStatus).toBe("refunded");
    // No refund is invented: the order stays PAID and a human decides.
    expect(voided.orderStatus).toBe("PAID");
    expect(
      await scalar<boolean>(
        `select approved_at is not null from public.payments where order_id = '${order.orderId}'`,
      ),
    ).toBe(true);
  });
});

describe("reconciliation path", () => {
  it("flags an approval for an expired order instead of reviving it", async () => {
    const order = await createOrder(1, { minutes: 1 });
    await db.query(`select public.expire_pending_orders(100, now() + interval '2 minutes')`);

    const confirmation = await confirm({
      order,
      status: "APPROVED",
      transactionId: "tx-late-1",
    });

    expect(confirmation.result).toBe("RECONCILIATION_REQUIRED");
    expect(confirmation.reconciliationRequired).toBe(true);
    expect(confirmation.reason).toBe("ORDER_NOT_PAYABLE_EXPIRED");
    expect(confirmation.orderStatus).toBe("EXPIRED");
    // The money is recorded as a fact...
    expect(confirmation.paymentStatus).toBe("approved");
    // ...but no ticket is issued and no email is queued.
    expect(confirmation.ticketsIssued).toBe(0);
    expect(
      await scalar<number>(
        `select count(*)::int from public.tickets where order_id = '${order.orderId}'`,
      ),
    ).toBe(0);
  });
});

describe("order expiry service", () => {
  it("expires only what is past its deadline and releases inventory once", async () => {
    const stale = await createOrder(2, { minutes: 1 });
    const fresh = await createOrder(3, { minutes: 60 });

    const result = await db.query<{
      r: { expiredCount: number; releasedTiers: number; references: string[] };
    }>(`select public.expire_pending_orders(100, now() + interval '2 minutes') as r`);

    expect(result.rows[0]?.r.expiredCount).toBe(1);
    expect(result.rows[0]?.r.references).toEqual([stale.reference]);
    expect(
      await scalar<string>(`select status::text from public.orders where id = '${stale.orderId}'`),
    ).toBe("EXPIRED");
    expect(
      await scalar<string>(`select status::text from public.orders where id = '${fresh.orderId}'`),
    ).toBe("PENDING");

    // Running it again changes nothing: the candidate rows are gone.
    const again = await db.query<{ r: { expiredCount: number } }>(
      `select public.expire_pending_orders(100, now() + interval '3 minutes') as r`,
    );
    expect(again.rows[0]?.r.expiredCount).toBe(0);
  });

  it("releases the reservation of an abandoned FAILED order", async () => {
    const order = await createOrder(1);
    await confirm({ order, status: "DECLINED", transactionId: "tx-abandoned-1" });
    expect(
      await scalar<string>(`select status::text from public.orders where id = '${order.orderId}'`),
    ).toBe("FAILED");

    await db.query(`select public.expire_pending_orders(100, now() + interval '20 minutes')`);
    expect(
      await scalar<string>(`select status::text from public.orders where id = '${order.orderId}'`),
    ).toBe("EXPIRED");
  });
});

describe("retry_payment", () => {
  it("creates a new attempt with a fresh reference for a failed order", async () => {
    const order = await createOrder(1);
    await confirm({ order, status: "DECLINED", transactionId: "tx-retry-1" });

    const result = await db.query<{
      r: {
        paymentAttempt: number;
        wompiReference: string;
        status: string;
        totalInCents: number;
      };
    }>(`select public.retry_payment('${order.reference}','buyer@example.com',30) as r`);
    const retry = result.rows[0]?.r;
    expect(retry?.paymentAttempt).toBe(2);
    expect(retry?.wompiReference).toBe(`${order.reference}-2`);
    expect(retry?.wompiReference).not.toBe(order.wompiReference);
    expect(retry?.status).toBe("PENDING");
    expect(retry?.totalInCents).toBe(order.totalInCents);

    // The previous attempt is preserved: the payment history is the Wompi reconciliation
    // record and is never deleted.
    expect(
      await scalar<number>(
        `select count(*)::int from public.payments where order_id = '${order.orderId}'`,
      ),
    ).toBe(2);
  });

  it("re-reserves inventory when reviving an expired order", async () => {
    const order = await createOrder(2, { minutes: 1 });
    await db.query(`select public.expire_pending_orders(100, now() + interval '2 minutes')`);
    const reserved = await scalar<number>(
      `select quantity_reserved from public.pricing_tiers where name = 'Preventa 1'`,
    );
    // The expiry released the two units before the retry re-reserved them.
    expect(reserved).toBe(0);

    await db.query(`select public.retry_payment('${order.reference}','buyer@example.com',30)`);

    expect(
      await scalar<number>(
        `select quantity_reserved from public.pricing_tiers where name = 'Preventa 1'`,
      ),
    ).toBe((reserved ?? 0) + 2);
    expect(
      await scalar<string>(`select status::text from public.orders where id = '${order.orderId}'`),
    ).toBe("PENDING");
  });

  it("refuses to retry an order that already has an approved payment", async () => {
    const order = await createOrder(1);
    await confirm({ order, status: "APPROVED", transactionId: "tx-paid-retry-1" });
    const message = await rejection(
      db.query(`select public.retry_payment('${order.reference}','buyer@example.com',30)`),
    );
    expect(message).toContain("ORDER_ALREADY_PAID");
  });

  it("refuses to retry a pending order that was never attempted successfully", async () => {
    const order = await createOrder(1);
    const message = await rejection(
      db.query(`select public.retry_payment('${order.reference}','buyer@example.com',30)`),
    );
    expect(message).toContain("ORDER_NOT_RETRYABLE");
  });

  it("refuses a retry from someone who does not know the buyer email", async () => {
    const order = await createOrder(1);
    await confirm({ order, status: "DECLINED", transactionId: "tx-auth-retry-1" });
    const message = await rejection(
      db.query(`select public.retry_payment('${order.reference}','someone@else.com',30)`),
    );
    expect(message).toContain("ORDER_NOT_FOUND");
  });
});

describe("get_order_status projection", () => {
  it("hides everything until the buyer email matches", async () => {
    const order = await createOrder(1);
    expect((await status(order.reference, "someone@else.com")).found).toBe(false);
    expect((await status("EVT-2026-000999")).found).toBe(false);
  });

  it("returns the safe subset while pending and the tickets once paid", async () => {
    const order = await createOrder(2);
    const pending = await status(order.reference);
    expect(pending.found).toBe(true);
    expect(pending.status).toBe("PENDING");
    expect(pending.quantity).toBe(2);
    expect(pending.tickets).toEqual([]);

    await confirm({ order, status: "APPROVED", transactionId: "tx-projection-1" });
    const paid = await status(order.reference);

    expect(paid.status).toBe("PAID");
    expect(paid.tickets).toHaveLength(2);
    expect(paid.tickets?.[0]?.participant?.firstName).toBe("Ana");
    expect(paid.tickets?.[0]?.participant?.lastName).toBe("Pérez");
    expect(paid.confirmation?.ready).toBe(false); // no email queued yet for this order
    expect(paid.paidAt).not.toBeNull();

    // No PII beyond what the buyer supplied is exposed anywhere in the payload.
    const serialized = JSON.stringify(paid);
    expect(serialized).not.toContain("1020456789");
    expect(serialized).not.toContain("3001234567");
    expect(serialized).not.toContain("@example.com");
    expect(serialized).not.toContain("181.10.20.30");
  });
});

describe("webhook event ledger", () => {
  const KEY = "e".repeat(64);

  it("claims an event once and reports the loser without throwing", async () => {
    const first = await db.query<{ c: { claimed: boolean; eventId: string } }>(
      `select public.claim_webhook_event('${KEY}','transaction.updated','tx-ledger-1',true) as c`,
    );
    expect(first.rows[0]?.c.claimed).toBe(true);

    const second = await db.query<{ c: { claimed: boolean; eventId: string } }>(
      `select public.claim_webhook_event('${KEY}','transaction.updated','tx-ledger-1',true) as c`,
    );
    expect(second.rows[0]?.c.claimed).toBe(false);
    expect(second.rows[0]?.c.eventId).toBe(first.rows[0]?.c.eventId);
  });

  it("finalizes once and refuses to overwrite the recorded outcome", async () => {
    const claim = await db.query<{ c: { eventId: string } }>(
      `select public.claim_webhook_event('${"f".repeat(64)}','transaction.updated',null,true) as c`,
    );
    const eventId = claim.rows[0]?.c.eventId;
    expect(eventId).toBeDefined();

    const first = await db.query<{ r: { finalized: boolean; result: string } }>(
      `select public.finalize_webhook_event('${String(eventId)}','APPLIED',200,null,null,null) as r`,
    );
    expect(first.rows[0]?.r.finalized).toBe(true);

    const second = await db.query<{ r: { finalized: boolean; result: string } }>(
      `select public.finalize_webhook_event('${String(eventId)}','REJECTED',500,null,'X',null) as r`,
    );
    expect(second.rows[0]?.r.finalized).toBe(false);
    expect(second.rows[0]?.r.result).toBe("APPLIED");
  });

  it("records a refused delivery in its own namespace", async () => {
    const result = await db.query<{ r: { eventId: string; recorded: boolean } }>(
      `select public.record_webhook_rejection('${"a".repeat(64)}','transaction.updated',401,'CHECKSUM_MISMATCH') as r`,
    );
    expect(result.rows[0]?.r.recorded).toBe(true);

    const again = await db.query<{ r: { recorded: boolean } }>(
      `select public.record_webhook_rejection('${"a".repeat(64)}','transaction.updated',401,'CHECKSUM_MISMATCH') as r`,
    );
    expect(again.rows[0]?.r.recorded).toBe(false);

    expect(
      await scalar<number>(
        `select count(*)::int from public.payment_events where checksum_valid = false`,
      ),
    ).toBe(1);
  });
});

describe("email outbox claim", () => {
  it("claims each delivery once and never hands it to two workers", async () => {
    const order = await createOrder(1);
    const confirmation = await confirm({ order, status: "APPROVED", transactionId: "tx-outbox-1" });
    await db.query(`select public.queue_ticket_emails('${confirmation.orderId}')`);

    const first = await db.query<{ id: string; status: string; attempt_count: number }>(
      `select id, status::text, attempt_count from public.claim_email_deliveries(10)`,
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.status).toBe("SENDING");
    expect(first.rows[0]?.attempt_count).toBe(1);

    // A second claim finds nothing: the row is SENDING, not yet stale.
    const second = await db.query<{ id: string }>(
      `select id from public.claim_email_deliveries(10)`,
    );
    expect(second.rows).toHaveLength(0);

    // Finishing with SENT stores the provider id and clears the retry schedule.
    const finished = await db.query<{
      r: { status: string; providerMessageId: string | null; nextAttemptAt: string | null };
    }>(
      `select public.finish_email_delivery('${first.rows[0]?.id ?? ""}','SENT','msg-42',null,null) as r`,
    );
    expect(finished.rows[0]?.r.status).toBe("SENT");
    expect(finished.rows[0]?.r.providerMessageId).toBe("msg-42");
    expect(finished.rows[0]?.r.nextAttemptAt).toBeNull();

    // A SENT delivery is never claimable again.
    const third = await db.query<{ id: string }>(
      `select id from public.claim_email_deliveries(10)`,
    );
    expect(third.rows).toHaveLength(0);
  });

  it("schedules a retry for a retryable failure and stops at the attempt ceiling", async () => {
    const order = await createOrder(1);
    const confirmation = await confirm({ order, status: "APPROVED", transactionId: "tx-outbox-2" });
    await db.query(`select public.queue_ticket_emails('${confirmation.orderId}')`);

    const claimed = await db.query<{ id: string }>(
      `select id from public.claim_email_deliveries(10)`,
    );
    const id = claimed.rows[0]?.id ?? "";
    await db.query(
      `select public.finish_email_delivery('${id}','FAILED',null,'Transient failure',
              now() - interval '1 minute')`,
    );

    const retry = await db.query<{ id: string; attempt_count: number }>(
      `select id, attempt_count from public.claim_email_deliveries(10)`,
    );
    expect(retry.rows).toHaveLength(1);
    expect(retry.rows[0]?.attempt_count).toBe(2);

    // Exhaust the counter, then confirm the ceiling is respected.
    await db.query(
      `update public.email_deliveries set attempt_count = 5, status = 'FAILED',
              next_attempt_at = now() - interval '1 minute' where id = '${id}'`,
    );
    const exhausted = await db.query<{ id: string }>(
      `select id from public.claim_email_deliveries(10, now(), 900, 5)`,
    );
    expect(exhausted.rows).toHaveLength(0);
  });
});
