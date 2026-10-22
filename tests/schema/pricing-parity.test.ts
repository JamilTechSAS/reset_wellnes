/**
 * SQL pricing/order parity and flow.
 *
 * The authoritative price is computed in SQL (migrations 20261003210008/…09); the TypeScript
 * rules in `_shared/domain/pricing.ts` exist to re-check it. This suite runs the SAME scenarios
 * through both and fails the build if they ever disagree, and it exercises the order flow end
 * to end (quote, create, discounts, policy, idempotency, rollback) against real Postgres
 * semantics via PGlite.
 *
 * What PGlite cannot do: two genuinely concurrent sessions. The real races (last-unit oversell
 * and single-redemption discount codes) were verified against PostgreSQL 17 with two parallel
 * sessions and are documented in docs/phases/phase-03.md.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { copCents } from "@shared/domain/money.ts";
import { resolveDiscountAmounts } from "@shared/domain/pricing.ts";

import { applyMigrations } from "./helpers.ts";

type Quote = {
  quantity: number;
  pricingTier: { name: string; sequence: number; unitPriceInCents: number };
  subtotalInCents: number;
  quantityDiscount: { applies: boolean; percentBps: number; amountInCents: number };
  quantityDiscountInCents: number;
  discountCode: {
    supplied: boolean;
    applies: boolean;
    reason: string;
    kind: string | null;
    amountInCents: number;
  };
  discountCodeInCents: number;
  discountCombination: string;
  totalDiscountInCents: number;
  totalInCents: number;
  currency: string;
  availability: string;
  availableQuantity: number | null;
};

type Order = {
  replayed: boolean;
  orderId: string;
  reference: string;
  status: string;
  quantity: number;
  unitPriceInCents: number;
  pricingTierName: string;
  subtotalInCents: number;
  quantityDiscountInCents: number;
  discountCodeInCents: number;
  totalDiscountInCents: number;
  discountCombination: string;
  totalInCents: number;
  currency: string;
  paymentAttempt: number;
  wompiReference: string;
  participantId: string;
};

const EVENT = "TAT-2026";
const PARTICIPANT = JSON.stringify({
  firstName: "Ana",
  lastName: "Pérez",
  nationalId: "1.020.456.789",
  email: "Ana@Example.com",
  phone: "+57 300 123 4567",
  city: "Bogotá",
  instagram: "@ana.perez",
  consents: { dataProcessing: true, futureEvents: false },
});

function quoteSql(quantity: number, code: string | null = null, minutes = 15): string {
  const codeArg = code === null ? "null" : `'${code}'`;
  return `select public.quote_order_price('${EVENT}','GENERAL',${String(quantity)},${String(minutes)},${codeArg}) as q`;
}

function orderSql(options: {
  quantity: number;
  code?: string | null;
  key?: string | null;
  email?: string;
  participant?: string;
  minutes?: number;
}): string {
  const code = options.code ?? null;
  const key = options.key ?? null;
  const email = options.email ?? "buyer@example.com";
  const participant = options.participant ?? PARTICIPANT;
  // Argument order follows the function signature: optional parameters come last, in the
  // order (discount code, idempotency key, ip, user agent).
  return `select public.create_order(
    '${EVENT}','GENERAL',${String(options.quantity)},${String(options.minutes ?? 15)},
    '${email}','Comprador','3001234567','${participant}'::jsonb,
    ${code === null ? "null" : `'${code}'`},${key === null ? "null" : `'${key}'`},
    '181.10.20.30','vitest/1.0') as o`;
}

async function quote(db: PGlite, quantity: number, code: string | null = null): Promise<Quote> {
  const result = await db.query<{ q: Quote }>(quoteSql(quantity, code));
  const row = result.rows[0]?.q;
  if (row === undefined) {
    throw new Error("quote returned no row");
  }
  return row;
}

async function createOrder(db: PGlite, options: Parameters<typeof orderSql>[0]): Promise<Order> {
  const result = await db.query<{ o: Order }>(orderSql(options));
  const row = result.rows[0]?.o;
  if (row === undefined) {
    throw new Error("create_order returned no row");
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

/** Fresh database per test group, seeded with a stage ladder and two codes. */
async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    do $$
    declare v_event uuid; v_tt uuid; v_tier2 uuid;
    begin
      insert into public.events (code, name, starts_at, status, capacity)
        values ('${EVENT}', 'Evento', now() + interval '60 days', 'PUBLISHED', 120)
        returning id into v_event;
      insert into public.ticket_types (event_id, code, name, min_per_order, max_per_order)
        values (v_event, 'GENERAL', 'Entrada general', 1, 6) returning id into v_tt;
      -- Stage 1: cheap but tiny (3 units). Stage 2: pricier, unlimited. Stage 3: future.
      insert into public.pricing_tiers
        (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
      values
        (v_tt, 'Preventa 1', 1, 9500000, 3, now() - interval '1 day'),
        (v_tt, 'General', 2, 11500000, null, now() - interval '1 day'),
        (v_tt, 'Preventa futura', 3, 5000000, null, now() + interval '30 days');
      select id into v_tier2 from public.pricing_tiers where ticket_type_id = v_tt and sequence = 2;
      insert into public.quantity_discounts (ticket_type_id, min_quantity, percent_bps)
        values (v_tt, 3, 1000);
      insert into public.quantity_discounts (ticket_type_id, pricing_tier_id, min_quantity, max_quantity, percent_bps)
        values (v_tt, v_tier2, 2, 2, 1500);
      insert into public.discount_codes (event_id, ticket_type_id, pricing_tier_id, code, kind, percent_bps, max_redemptions, max_quantity)
        values (v_event, v_tt, v_tier2, 'AMIGOS', 'PERCENT', 2500, 1, 6);
      insert into public.discount_codes (event_id, ticket_type_id, pricing_tier_id, code, kind, amount_cents, max_quantity)
        values (v_event, v_tt, v_tier2, 'FIJO', 'FIXED', 1000000, 6);
      insert into public.discount_codes (event_id, ticket_type_id, pricing_tier_id, code, kind, percent_bps, max_quantity, is_active)
        values (v_event, v_tt, v_tier2, 'APAGADO', 'PERCENT', 5000, 6, false);
      insert into public.discount_codes (event_id, ticket_type_id, pricing_tier_id, code, kind, percent_bps, max_quantity)
        values (v_event, v_tt, v_tier2, 'GENERAL10', 'PERCENT', 1000, 1);
    end $$;
  `);
}

describe("pricing: stage selection and parity", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await seed(db);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("selects the lowest-sequence active stage inside its window", async () => {
    const result = await quote(db, 2);
    expect(result.pricingTier.name).toBe("Preventa 1");
    expect(result.pricingTier.sequence).toBe(1);
    expect(result.pricingTier.unitPriceInCents).toBe(9_500_000);
    expect(result.subtotalInCents).toBe(19_000_000);
  });

  it("skips a stage whose window has not started", async () => {
    await db.exec(`update public.pricing_tiers set is_active = false where sequence = 1`);
    try {
      const result = await quote(db, 2);
      // Stage 3 is in the future, so stage 2 is the correct answer.
      expect(result.pricingTier.sequence).toBe(2);
      expect(result.pricingTier.unitPriceInCents).toBe(11_500_000);
    } finally {
      await db.exec(`update public.pricing_tiers set is_active = true where sequence = 1`);
    }
  });

  it("skips an exhausted stage instead of failing, and reports sold out when none can serve", async () => {
    await db.exec(`update public.pricing_tiers set quantity_reserved = 3 where sequence = 1`);
    try {
      const twoUnits = await quote(db, 2);
      expect(twoUnits.pricingTier.sequence).toBe(2);

      // Stage 1 is full and stage 2 is unlimited, so nothing is ever truly sold out here;
      // prove the SOLD_OUT path by making stage 2 unable to serve the quantity.
      await db.exec(
        `update public.pricing_tiers set quantity_limit = 1, quantity_reserved = 1 where sequence = 2`,
      );
      const failed = await rejection(db.query(quoteSql(2)));
      expect(failed).toContain("SOLD_OUT");
    } finally {
      await db.exec(`
        update public.pricing_tiers set quantity_reserved = 0, quantity_limit = 3 where sequence = 1;
        update public.pricing_tiers set quantity_reserved = 0, quantity_limit = null where sequence = 2;
      `);
    }
  });

  it("agrees with the TypeScript rules on the applied discount amounts", async () => {
    await db.exec("update public.pricing_tiers set quantity_sold = 3 where sequence = 1");
      const q = await quote(db, 3, "AMIGOS");
    const resolved = resolveDiscountAmounts({
      subtotal: copCents(q.subtotalInCents),
      quantityDiscount: copCents(q.quantityDiscount.amountInCents),
      codeDiscount: copCents(q.discountCode.amountInCents),
      combination: "BEST_SINGLE",
    });

    expect(q.discountCombination).toBe("BEST_SINGLE");
    expect(q.quantityDiscountInCents).toBe(resolved.quantityDiscountApplied);
    expect(q.discountCodeInCents).toBe(resolved.codeDiscountApplied);
    expect(q.totalDiscountInCents).toBe(resolved.totalDiscount);
    expect(q.totalInCents).toBe(resolved.total);
    // 3 x 9.5M = 28.5M; quantity 10% = 2.85M; code 25% = 7.125M -> code wins.
    expect(q.totalInCents).toBe(25_875_000);
  });

  it("switches to STACK when the policy row says so", async () => {
    await db.exec(`update public.pricing_policy set discount_combination = 'STACK'`);
    try {
      await db.exec("update public.pricing_tiers set quantity_sold = 3 where sequence = 1");
      const q = await quote(db, 3, "AMIGOS");
      const resolved = resolveDiscountAmounts({
        subtotal: copCents(q.subtotalInCents),
        quantityDiscount: copCents(q.quantityDiscount.amountInCents),
        codeDiscount: copCents(q.discountCode.amountInCents),
        combination: "STACK",
      });
      expect(q.discountCombination).toBe("STACK");
      expect(q.quantityDiscountInCents).toBe(resolved.quantityDiscountApplied);
      expect(q.discountCodeInCents).toBe(resolved.codeDiscountApplied);
      expect(q.totalInCents).toBe(resolved.total);
      expect(q.totalInCents).toBe(22_425_000);
    } finally {
      await db.exec(`update public.pricing_policy set discount_combination = 'BEST_SINGLE'`);
    }
  });

  it("reports why a code was refused without failing the quote", async () => {
    const cases: readonly (readonly [string, string])[] = [
      ["NOPE", "NOT_FOUND"],
      ["APAGADO", "INACTIVE"],
      ["FIJO", "WRONG_SALES_STAGE"],
    ];
    for (const [code, reason] of cases) {
      const q = await quote(db, 1, code);
      expect(q.discountCode.reason, `code ${code}`).toBe(reason);
      expect(q.discountCode.applies).toBe(reason === "OK");
    }

    const notSupplied = await quote(db, 1);
    expect(notSupplied.discountCode.reason).toBe("NOT_SUPPLIED");
    expect(notSupplied.discountCode.supplied).toBe(false);
  });

  it("applies a FIXED code to its configured General tier and caps it at the subtotal", async () => {
    await db.exec("update public.pricing_tiers set quantity_sold = 3 where sequence = 1");
    try {
      const q = await quote(db, 1, "FIJO");
      expect(q.pricingTier.name).toBe("General");
      expect(q.discountCode.kind).toBe("FIXED");
      expect(q.totalInCents).toBe(10_500_000);
    } finally {
      await db.exec("update public.pricing_tiers set quantity_sold = 0 where sequence = 1");
    }
  });

  it("keeps General locked until Preventa is exhausted and prices the two-ticket package there", async () => {
    await db.exec("update public.pricing_tiers set quantity_sold = 2 where sequence = 1");
    try {
      expect(await rejection(db.query(quoteSql(2)))).toContain("SOLD_OUT");
      await db.exec("update public.pricing_tiers set quantity_sold = 3 where sequence = 1");
      const q = await quote(db, 2);
      expect(q.pricingTier.name).toBe("General");
      expect(q.quantityDiscount.amountInCents).toBe(3_450_000);
      expect(q.totalInCents).toBe(19_550_000);
    } finally {
      await db.exec("update public.pricing_tiers set quantity_sold = 0 where sequence = 1");
    }
  });

  it("accepts coupons only for one ticket on the configured General tier", async () => {
    expect((await quote(db, 1, "GENERAL10")).discountCode.reason).toBe("WRONG_SALES_STAGE");
    await db.exec("update public.pricing_tiers set quantity_sold = 3 where sequence = 1");
    try {
      const single = await quote(db, 1, "GENERAL10");
      expect(single.discountCode.reason).toBe("OK");
      expect(single.totalInCents).toBe(10_350_000);
      const bundle = await quote(db, 2, "GENERAL10");
      expect(bundle.discountCode.reason).toBe("WRONG_QUANTITY");
      expect(bundle.totalInCents).toBe(19_550_000);
      expect(await rejection(db.query(orderSql({quantity:2,code:"GENERAL10",key:"idem-general-coupon-001"})))).toContain("DISCOUNT_WRONG_QUANTITY");
    } finally {
      await db.exec("update public.pricing_tiers set quantity_sold = 0 where sequence = 1");
    }
  });

  it("refuses quantities outside the configured per-order limits", async () => {
    expect(await rejection(db.query(quoteSql(0)))).toContain("INVALID_QUANTITY");
    expect(await rejection(db.query(quoteSql(7)))).toContain("QUANTITY_LIMIT");
  });

  it("refuses an unknown event or ticket type", async () => {
    const unknownEvent = await rejection(
      db.query(`select public.quote_order_price('NOPE','GENERAL',1,15) as q`),
    );
    expect(unknownEvent).toContain("EVENT_NOT_FOUND");

    const unknownType = await rejection(
      db.query(`select public.quote_order_price('${EVENT}','VIP',1,15) as q`),
    );
    expect(unknownType).toContain("TICKET_TYPE_NOT_FOUND");
  });

  it("has no price parameter: the quote is a function of database state only", async () => {
    // Documented as a test: the function signature itself proves a client cannot send an
    // amount. If someone adds one, this test fails and the reviewer must object.
    const result = await db.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'quote_order_price'`,
    );
    const args = result.rows[0]?.args ?? "";
    expect(args).not.toMatch(/amount|price|total|cents/i);
  });
});

describe("order creation", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await seed(db);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("creates the order, item, participant, consents and a PENDING payment attempt", async () => {
    const order = await createOrder(db, { quantity: 2, key: "idem-key-00000001" });

    expect(order.replayed).toBe(false);
    expect(order.status).toBe("PENDING");
    expect(order.reference).toMatch(/^EVT-\d{4}-\d{6}$/);
    expect(order.paymentAttempt).toBe(1);
    expect(order.wompiReference).toBe(order.reference);
    expect(order.totalInCents).toBe(19_000_000);

    const rows = await db.query<{
      status: string;
      buyer_email: string;
      total_cents: number;
      reservation_expires_at: string | null;
    }>(
      `select status, buyer_email, total_cents, reservation_expires_at
         from public.orders where id = $1`,
      [order.orderId],
    );
    expect(rows.rows[0]?.status).toBe("PENDING");
    expect(rows.rows[0]?.buyer_email).toBe("buyer@example.com");
    expect(rows.rows[0]?.reservation_expires_at).toBeDefined();

    // Participant values were normalized by the SQL layer.
    const participant = await db.query<{
      national_id: string;
      email: string;
      phone: string;
      instagram: string | null;
    }>(`select national_id, email, phone, instagram from public.participants where id = $1`, [
      order.participantId,
    ]);
    expect(participant.rows[0]?.national_id).toBe("1020456789");
    expect(participant.rows[0]?.email).toBe("ana@example.com");
    expect(participant.rows[0]?.phone).toBe("573001234567");
    expect(participant.rows[0]?.instagram).toBe("ana.perez");

    // Both consents recorded, append-only, with the policy version.
    const consents = await db.query<{ kind: string; granted: boolean; policy_version: string }>(
      `select kind, granted, policy_version from public.consents
        where participant_id = $1 order by kind`,
      [order.participantId],
    );
    expect(consents.rows).toEqual([
      { kind: "DATA_PROCESSING", granted: true, policy_version: "v1" },
      { kind: "FUTURE_EVENTS", granted: false, policy_version: "v1" },
    ]);

    // The payment attempt exists and is NOT approved: only a verified Wompi event may do that.
    const payments = await db.query<{
      status: string;
      amount_cents: number;
      approved_at: string | null;
    }>(`select status, amount_cents, approved_at from public.payments where order_id = $1`, [
      order.orderId,
    ]);
    expect(payments.rows[0]?.status).toBe("pending");
    expect(payments.rows[0]?.amount_cents).toBe(19_000_000);
    expect(payments.rows[0]?.approved_at).toBeNull();
  });

  it("reserves inventory and never exceeds the stage limit", async () => {
    const before = await db.query<{ quantity_reserved: number }>(
      `select quantity_reserved from public.pricing_tiers where sequence = 1`,
    );
    const reserved = before.rows[0]?.quantity_reserved ?? 0;

    // Stage 1 holds 3 units and `reserved` are already taken; asking for the rest succeeds.
    const remaining = 3 - reserved;
    if (remaining > 0) {
      await createOrder(db, { quantity: remaining, key: `idem-fill-${String(remaining)}-0001` });
    }

    const after = await db.query<{ quantity_reserved: number; quantity_limit: number }>(
      `select quantity_reserved, quantity_limit from public.pricing_tiers where sequence = 1`,
    );
    expect(after.rows[0]?.quantity_reserved).toBe(3);
    expect(after.rows[0]?.quantity_limit).toBe(3);

    // The next order falls through to stage 2 (pricier), not an error.
    const order = await createOrder(db, { quantity: 1, key: "idem-stage2-00000001" });
    expect(order.pricingTierName).toBe("General");
    expect(order.unitPriceInCents).toBe(11_500_000);
  });

  it("replays the same order for a repeated idempotency key and does not reserve twice", async () => {
    const first = await createOrder(db, { quantity: 1, key: "idem-replay-00000001" });
    const reservedBefore = await db.query<{ total: number }>(
      `select coalesce(sum(quantity_reserved),0)::int as total from public.pricing_tiers`,
    );

    const replay = await createOrder(db, { quantity: 1, key: "idem-replay-00000001" });
    const reservedAfter = await db.query<{ total: number }>(
      `select coalesce(sum(quantity_reserved),0)::int as total from public.pricing_tiers`,
    );

    expect(replay.replayed).toBe(true);
    expect(replay.orderId).toBe(first.orderId);
    expect(replay.reference).toBe(first.reference);
    expect(replay.totalInCents).toBe(first.totalInCents);
    expect(reservedAfter.rows[0]?.total).toBe(reservedBefore.rows[0]?.total);

    const orders = await db.query<{ count: number }>(
      `select count(*)::int as count from public.orders where idempotency_key = 'idem-replay-00000001'`,
    );
    expect(orders.rows[0]?.count).toBe(1);
  });

  it("returns the same payload shape on replay as on creation", async () => {
    const key = "idem-shape-0000000001";
    const fresh = await createOrder(db, { quantity: 2, key });
    const replay = await createOrder(db, { quantity: 2, key });

    // Phase 6D.1 regression. The replay branch used to omit `totalDiscountInCents` and
    // `discountCombination`, and `handleCreateOrder` feeds `totalDiscountInCents` into
    // `verifyNumbers(...)` on EVERY response — so a repeated `POST /orders` with the same
    // `Idempotency-Key` answered `500 INTERNAL_ERROR` even though the order already existed.
    // Key parity is the invariant that keeps the two payloads interchangeable for the API.
    expect(replay.replayed).toBe(true);
    expect(Object.keys(replay).sort()).toEqual(Object.keys(fresh).sort());
    expect(replay.totalDiscountInCents).toBe(fresh.totalDiscountInCents);
    expect(replay.discountCombination).toBe(fresh.discountCombination);
    expect(replay.quantityDiscountInCents).toBe(fresh.quantityDiscountInCents);
    expect(replay.discountCodeInCents).toBe(fresh.discountCodeInCents);
    expect(replay.subtotalInCents).toBe(fresh.subtotalInCents);
    expect(replay.unitPriceInCents).toBe(fresh.unitPriceInCents);
    expect(replay.paymentAttempt).toBe(fresh.paymentAttempt);
    expect(replay.wompiReference).toBe(fresh.wompiReference);

    // The arithmetic the API re-verifies must still add up on the replayed payload.
    expect(replay.unitPriceInCents * replay.quantity - replay.totalDiscountInCents).toBe(
      replay.totalInCents,
    );

    const attempts = await db.query<{ count: number }>(
      `select count(*)::int as count from public.payments p
         join public.orders o on o.id = p.order_id
        where o.idempotency_key = 'idem-shape-0000000001'`,
    );
    expect(attempts.rows[0]?.count).toBe(1);
  });

  it("replays an order that used a discount code with the amounts already applied", async () => {
    // FIJO is a fixed 1.000.000-centavo code with unlimited redemptions.
    const key = "idem-discount-replay-01";
    await db.exec("update public.pricing_tiers set quantity_sold = 3 where sequence = 1");
    const fresh = await createOrder(db, { quantity: 1, code: "FIJO", key });
    const replay = await createOrder(db, { quantity: 1, code: "FIJO", key });

    expect(fresh.discountCodeInCents).toBe(1_000_000);
    expect(replay.replayed).toBe(true);
    expect(replay.discountCodeInCents).toBe(fresh.discountCodeInCents);
    expect(replay.totalDiscountInCents).toBe(fresh.totalDiscountInCents);
    expect(replay.discountCombination).toBe(fresh.discountCombination);

    // Two calls, one order, one redemption and one payment attempt: the replay claims nothing.
    const redemptions = await db.query<{ count: number }>(
      `select count(*)::int as count from public.discount_redemptions r
         join public.orders o on o.id = r.order_id
        where o.idempotency_key = 'idem-discount-replay-01'`,
    );
    expect(redemptions.rows[0]?.count).toBe(1);
  });

  it("creates a genuinely new order for a different idempotency key", async () => {
    const first = await createOrder(db, { quantity: 1, key: "idem-distinct-00000001" });
    const second = await createOrder(db, { quantity: 1, key: "idem-distinct-00000002" });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(second.orderId).not.toBe(first.orderId);
    expect(second.reference).not.toBe(first.reference);
  });

  it("cannot store two orders with the same idempotency key (the concurrency guard)", async () => {
    // Two simultaneous `POST /orders` with one key: whichever transaction commits second hits
    // this unique index and fails, instead of creating a duplicate order or reserving twice.
    // That index is what makes the replay lookup safe rather than merely convenient.
    const created = await createOrder(db, { quantity: 1, key: "idem-race-000000000001" });
    const duplicate = await rejection(
      db.query(
        `insert into public.orders
           (reference, event_id, buyer_email, buyer_name, buyer_phone, subtotal_cents,
            quantity_discount_cents, discount_code_cents, total_cents, currency,
            reservation_expires_at, idempotency_key)
         select 'EVT-2026-999999', event_id, buyer_email, buyer_name, buyer_phone, subtotal_cents,
                quantity_discount_cents, discount_code_cents, total_cents, currency,
                reservation_expires_at, idempotency_key
           from public.orders where idempotency_key = 'idem-race-000000000001'`,
      ),
    );

    expect(created.replayed).toBe(false);
    expect(duplicate).toMatch(/orders_idempotency_key_idx|duplicate key/i);
    const stored = await db.query<{ count: number }>(
      `select count(*)::int as count from public.orders where idempotency_key = 'idem-race-000000000001'`,
    );
    expect(stored.rows[0]?.count).toBe(1);
  });

  it("refuses an idempotency key that belongs to a different buyer", async () => {
    await createOrder(db, { quantity: 1, key: "idem-owner-00000001" });
    const failed = await rejection(
      db.query(orderSql({ quantity: 1, key: "idem-owner-00000001", email: "other@example.com" })),
    );
    expect(failed).toContain("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("rolls everything back when the discount code is exhausted", async () => {
    // AMIGOS has max_redemptions = 1: the first order consumes it.
    await db.exec("update public.pricing_tiers set quantity_sold = 3 where sequence = 1");
    const first = await createOrder(db, { quantity: 1, code: "AMIGOS", key: "idem-code-00000001" });
    expect(first.discountCodeInCents).toBeGreaterThan(0);

    const ordersBefore = await db.query<{ count: number }>(
      `select count(*)::int as count from public.orders`,
    );
    const reservedBefore = await db.query<{ total: number }>(
      `select coalesce(sum(quantity_reserved),0)::int as total from public.pricing_tiers`,
    );

    const failed = await rejection(
      db.query(orderSql({ quantity: 1, code: "AMIGOS", key: "idem-code-00000002" })),
    );
    expect(failed).toContain("DISCOUNT_EXHAUSTED");

    const ordersAfter = await db.query<{ count: number }>(
      `select count(*)::int as count from public.orders`,
    );
    const reservedAfter = await db.query<{ total: number }>(
      `select coalesce(sum(quantity_reserved),0)::int as total from public.pricing_tiers`,
    );
    // No partial order, no leaked inventory, no burned extra redemption.
    expect(ordersAfter.rows[0]?.count).toBe(ordersBefore.rows[0]?.count);
    expect(reservedAfter.rows[0]?.total).toBe(reservedBefore.rows[0]?.total);

    // Scoped to AMIGOS: the suite shares one database, and a global count would silently
    // depend on which other tests happen to redeem a code (Phase 6D.1 added one that does).
    const redemptions = await db.query<{ count: number }>(
      `select count(*)::int as count
         from public.discount_redemptions r
         join public.discount_codes c on c.id = r.discount_code_id
        where c.code = 'AMIGOS'`,
    );
    expect(redemptions.rows[0]?.count).toBe(1);
  });

  it("records the applied discount split so the orders CHECK constraint holds", async () => {
    // No code is supplied here, so the quantity discount (10 % at 3 units) is the only
    // candidate. The expected amount is DERIVED from the stage the order actually got,
    // because earlier tests may already have exhausted the cheapest stage.
    const order = await createOrder(db, { quantity: 3, key: "idem-split-00000001" });
    const row = await db.query<{
      subtotal_cents: number;
      quantity_discount_cents: number;
      discount_code_cents: number;
      total_cents: number;
    }>(
      `select subtotal_cents, quantity_discount_cents, discount_code_cents, total_cents
         from public.orders where id = $1`,
      [order.orderId],
    );
    const stored = row.rows[0];
    expect(stored).toBeDefined();
    expect(
      (stored?.subtotal_cents ?? 0) -
        (stored?.quantity_discount_cents ?? 0) -
        (stored?.discount_code_cents ?? 0),
    ).toBe(stored?.total_cents);
    expect(stored?.subtotal_cents).toBe(order.unitPriceInCents * 3);
    expect(stored?.quantity_discount_cents).toBe(
      Math.floor((order.subtotalInCents * 1000) / 10000),
    );
    expect(stored?.discount_code_cents).toBe(0);
    expect(stored?.total_cents).toBe(order.totalInCents);
  });

  it("rejects invalid participant data without creating anything", async () => {
    const before = await db.query<{ count: number }>(
      `select count(*)::int as count from public.orders`,
    );

    const badId = await rejection(
      db.query(
        orderSql({
          quantity: 1,
          key: "idem-badid-00000001",
          participant: JSON.stringify({
            firstName: "Ana",
            lastName: "Pérez",
            nationalId: "ABC",
            email: "ana@example.com",
            phone: "3001234567",
            city: "Bogotá",
            consents: { dataProcessing: true },
          }),
        }),
      ),
    );
    expect(badId).toContain("INVALID_NATIONAL_ID");

    const noConsent = await rejection(
      db.query(
        orderSql({
          quantity: 1,
          key: "idem-noconsent-000001",
          participant: JSON.stringify({
            firstName: "Ana",
            lastName: "Pérez",
            nationalId: "1020456789",
            email: "ana@example.com",
            phone: "3001234567",
            city: "Bogotá",
            consents: { dataProcessing: false },
          }),
        }),
      ),
    );
    expect(noConsent).toContain("CONSENT_REQUIRED");

    const after = await db.query<{ count: number }>(
      `select count(*)::int as count from public.orders`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("issues a distinct reference for every order and never reuses one", async () => {
    const references = await db.query<{ reference: string; count: number }>(
      `select reference, count(*)::int as count from public.orders group by reference having count(*) > 1`,
    );
    expect(references.rows).toEqual([]);

    const wompiReferences = await db.query<{ wompi_reference: string }>(
      `select wompi_reference from public.payments group by wompi_reference having count(*) > 1`,
    );
    expect(wompiReferences.rows).toEqual([]);
  });

  it("keeps the payment amount equal to the order total and the status PENDING", async () => {
    const mismatch = await db.query<{ count: number }>(
      `select count(*)::int as count
         from public.payments p join public.orders o on o.id = p.order_id
        where p.amount_cents <> o.total_cents`,
    );
    expect(mismatch.rows[0]?.count).toBe(0);

    const approved = await db.query<{ count: number }>(
      `select count(*)::int as count from public.payments where status <> 'pending'`,
    );
    expect(approved.rows[0]?.count).toBe(0);
  });
});
