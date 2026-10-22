/**
 * Shared scaffolding for the schema tests.
 *
 * Every schema suite boots its own in-process Postgres (PGlite) and applies the real
 * migration files in order, so the tests exercise the shipped SQL and nothing else.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/** Supabase CLI migration naming convention: <YYYYMMDDHHMMSS>_<snake_case>.sql */
export const MIGRATION_FILE_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

/**
 * Every domain table the migrations must create (sorted, no views).
 * Phase 5 adds: `operators` (operator authorization), `rate_limit_counters`
 * (PostgreSQL fixed windows) and `sheets_projections` (Google Sheets outbox).
 */
export const DOMAIN_TABLES = [
  "attendance",
  "consents",
  "discount_codes",
  "discount_redemptions",
  "email_deliveries",
  "events",
  "operators",
  "order_items",
  "orders",
  "participants",
  "payment_events",
  "payments",
  "pricing_policy",
  "pricing_tiers",
  "quantity_discounts",
  "rate_limit_counters",
  "sheets_projections",
  "ticket_types",
  "tickets",
] as const;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export async function applyMigrations(db: PGlite): Promise<void> {
  for (const file of migrationFiles()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.exec(sql);
  }
}

/** Asserts that an operation is rejected and that the error matches `pattern`. */
export async function expectRejection(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(operation).rejects.toThrow(pattern);
}

export type Fixture = {
  readonly eventId: string;
  readonly ticketTypeId: string;
  readonly pricingTierId: string;
  readonly orderId: string;
  readonly orderItemId: string;
  readonly participantId: string;
  readonly ticketId: string;
  readonly paymentId: string;
};

/** Runs an `insert ... returning id` (or equivalent) and returns the single id. */
export async function queryId(
  db: PGlite,
  sql: string,
  params: readonly string[] = [],
): Promise<string> {
  const result = await db.query<{ id: string }>(sql, [...params]);
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error(`Query returned no id: ${sql}`);
  }
  return id;
}

/**
 * One consistent, complete slice of the domain: a published event with a ticket type and
 * one sales stage, a pending order for one unit, its participant, ticket and approved
 * payment. Individual tests add adversarial rows on top of it.
 */
export async function createFixture(db: PGlite): Promise<Fixture> {
  const eventId = await queryId(
    db,
    `insert into public.events (code, name, starts_at, status, capacity)
     values ($1, $2, now() + interval '60 days', 'PUBLISHED', 120)
     returning id`,
    ["TAT-2026", "Evento de prueba"],
  );

  const ticketTypeId = await queryId(
    db,
    `insert into public.ticket_types (event_id, code, name)
     values ($1, 'GENERAL', 'Entrada general')
     returning id`,
    [eventId],
  );

  const pricingTierId = await queryId(
    db,
    `insert into public.pricing_tiers (ticket_type_id, name, sequence, price_cents, quantity_limit, sales_starts_at)
     values ($1, 'Preventa 1', 1, 9500000, 120, now() - interval '1 day')
     returning id`,
    [ticketTypeId],
  );

  const orderId = await queryId(
    db,
    `insert into public.orders (reference, event_id, status, buyer_email, buyer_name, subtotal_cents, total_cents)
     values ('EVT-2026-000001', $1, 'PENDING', 'comprador@example.com', 'Comprador', 9500000, 9500000)
     returning id`,
    [eventId],
  );

  const orderItemId = await queryId(
    db,
    `insert into public.order_items (order_id, ticket_type_id, pricing_tier_id, quantity, unit_price_cents, line_total_cents, ticket_type_name, pricing_tier_name)
     values ($1, $2, $3, 1, 9500000, 9500000, 'Entrada general', 'Preventa 1')
     returning id`,
    [orderId, ticketTypeId, pricingTierId],
  );

  const participantId = await queryId(
    db,
    `insert into public.participants (event_id, order_id, order_item_id, first_name, last_name, national_id, email, phone, city)
     values ($1, $2, $3, 'Ana', 'Pérez', '1020456789', 'ana@example.com', '573001234567', 'Bogotá')
     returning id`,
    [eventId, orderId, orderItemId],
  );

  const ticketId = await queryId(
    db,
    `insert into public.tickets (event_id, order_id, order_item_id, participant_id, ticket_type_id, token, price_paid_cents)
     values ($1, $2, $3, $4, $5, 'TKT_0123456789ABCDEFGHJK', 9500000)
     returning id`,
    [eventId, orderId, orderItemId, participantId, ticketTypeId],
  );

  const paymentId = await queryId(
    db,
    `insert into public.payments (order_id, attempt, wompi_reference, status, raw_wompi_status, amount_cents, wompi_transaction_id, approved_at, finalized_at)
     values ($1, 1, 'EVT-2026-000001', 'approved', 'APPROVED', 9500000, 'wompi-tx-0001', now(), now())
     returning id`,
    [orderId],
  );

  return {
    eventId,
    ticketTypeId,
    pricingTierId,
    orderId,
    orderItemId,
    participantId,
    ticketId,
    paymentId,
  };
}
