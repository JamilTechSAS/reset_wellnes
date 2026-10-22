import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "./helpers.ts";

const EVENT = "TAT-2026";
const PARTICIPANT = JSON.stringify({
  firstName: "Carlos",
  lastName: "Gómez",
  nationalId: "1030456789",
  email: "carlos@example.com",
  phone: "3007654321",
  city: "Medellín",
  consents: { dataProcessing: true, futureEvents: false },
});

describe("ePayco database migration & backward compatibility", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);

    // Seed minimal data required for an order
    await db.exec(`
      insert into public.events (code, name, status, starts_at, ends_at, currency)
      values ('${EVENT}', 'Reset Sunset', 'PUBLISHED', now() + interval '10 days', now() + interval '11 days', 'COP');

      insert into public.ticket_types (event_id, code, name, min_per_order, max_per_order)
      select id, 'GENERAL', 'Entrada General', 1, 5 from public.events where code = '${EVENT}';

      insert into public.pricing_tiers (ticket_type_id, sequence, name, price_cents, quantity_limit, is_active)
      select id, 1, 'Early Bird', 9500000, 100, true from public.ticket_types where code = 'GENERAL';
    `);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("verifies provider-neutral columns exist on payments and payment_events", async () => {
    const paymentsCols = await db.query<{ column_name: string }>(`
      select column_name
        from information_schema.columns
       where table_schema = 'public' and table_name = 'payments'
         and column_name in ('payment_provider', 'provider_reference', 'provider_transaction_id', 'raw_provider_status')
       order by column_name;
    `);

    expect(paymentsCols.rows.map((r) => r.column_name)).toEqual([
      "payment_provider",
      "provider_reference",
      "provider_transaction_id",
      "raw_provider_status",
    ]);

    const eventsCols = await db.query<{ column_name: string }>(`
      select column_name
        from information_schema.columns
       where table_schema = 'public' and table_name = 'payment_events'
         and column_name in ('payment_provider', 'provider_event_name', 'provider_transaction_id')
       order by column_name;
    `);

    expect(eventsCols.rows.map((r) => r.column_name)).toEqual([
      "payment_provider",
      "provider_event_name",
      "provider_transaction_id",
    ]);
  });

  type TestOrder = {
    reference: string;
    totalInCents: number;
    orderId: string;
  };

  type TestConfirmResult = {
    result: string;
    orderStatus: string;
    paymentStatus: string;
    paymentProvider: string;
    ticketsIssued: number;
  };

  type TestOrderStatus = {
    found: boolean;
    status: string;
    payment: {
      provider: string;
    };
    tickets: unknown[];
  };

  it("confirms an order via ePayco payment and issues tickets", async () => {
    // 1. Create order
    const orderRes = await db.query<{ o: TestOrder }>(`
      select public.create_order(
        '${EVENT}', 'GENERAL', 2, 15,
        'carlos@example.com', 'Carlos Gómez', '3007654321', '${PARTICIPANT}'::jsonb,
        null, null, '181.10.20.30', 'vitest'
      ) as o;
    `);
    const order = orderRes.rows[0]?.o;
    expect(order?.reference).toMatch(/^EVT-/);
    expect(order?.totalInCents).toBe(19000000); // 95,000 COP * 2

    // 2. Confirm payment using ePayco provider
    const confirmRes = await db.query<{ r: TestConfirmResult }>(`
      select public.confirm_payment(
        '${order?.reference ?? ""}',
        '${order?.reference ?? ""}',
        'epayco-ref-998877',
        '1', -- ePayco approved code
        19000000,
        'COP',
        'VISA',
        'Aprobada',
        '{"x_ref_payco": "epayco-ref-998877"}'::jsonb,
        'epayco'
      ) as r;
    `);

    const result = confirmRes.rows[0]?.r;
    expect(result?.result).toBe("APPLIED");
    expect(result?.orderStatus).toBe("PAID");
    expect(result?.paymentStatus).toBe("approved");
    expect(result?.paymentProvider).toBe("epayco");
    expect(result?.ticketsIssued).toBe(2);

    // 3. Verify tickets exist in database
    const ticketsRes = await db.query<{ count: string }>(`
      select count(*) as count from public.tickets where order_id = '${order?.orderId ?? ""}';
    `);
    expect(Number(ticketsRes.rows[0]?.count)).toBe(2);

    // 4. Verify get_order_status projection includes provider
    const statusRes = await db.query<{ s: TestOrderStatus }>(`
      select public.get_order_status('${order?.reference ?? ""}', 'carlos@example.com') as s;
    `);
    const status = statusRes.rows[0]?.s;
    expect(status?.found).toBe(true);
    expect(status?.status).toBe("PAID");
    expect(status?.payment.provider).toBe("epayco");
    expect(status?.tickets).toHaveLength(2);
  });

  it("preserves historical Wompi payments compatibility", async () => {
    // 1. Create order
    const orderRes = await db.query<{ o: TestOrder }>(`
      select public.create_order(
        '${EVENT}', 'GENERAL', 1, 15,
        'wompi.buyer@example.com', 'Comprador Wompi', '3001112233', '${PARTICIPANT}'::jsonb,
        null, null, '181.10.20.30', 'vitest'
      ) as o;
    `);
    const order = orderRes.rows[0]?.o;

    // 2. Confirm payment using legacy Wompi status string
    const confirmRes = await db.query<{ r: TestConfirmResult }>(`
      select public.confirm_payment(
        '${order?.reference ?? ""}',
        '${order?.reference ?? ""}',
        'wompi-tx-001',
        'APPROVED',
        9500000,
        'COP',
        'NEQUI',
        'Transacción aprobada',
        '{"id": "wompi-tx-001"}'::jsonb,
        'wompi'
      ) as r;
    `);

    const result = confirmRes.rows[0]?.r;
    expect(result?.result).toBe("APPLIED");
    expect(result?.orderStatus).toBe("PAID");
    expect(result?.paymentStatus).toBe("approved");
    expect(result?.paymentProvider).toBe("wompi");
    expect(result?.ticketsIssued).toBe(1);
  });
});
