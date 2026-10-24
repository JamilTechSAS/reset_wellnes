/**
 * Constraint and integrity tests.
 *
 * These are behavioral: they insert rows and assert that the database rejects what it is
 * supposed to reject (and accepts what it is supposed to accept). Structural assertions
 * (foreign keys, named indexes) complement them.
 *
 * Concurrency note: PGlite is a single session, so two statements never truly run in
 * parallel here. The race-sensitive patterns (one check-in row per ticket, no oversell
 * under simultaneous reservations) were additionally verified against a real PostgreSQL 17
 * instance with two parallel sessions; see docs/phases/phase-02.md.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildEmailIdempotencyKey } from "@shared/domain/email-delivery.ts";

import {
  applyMigrations,
  createFixture,
  expectRejection,
  queryId,
  type Fixture,
} from "./helpers.ts";

/** Captures the message/detail of an expected rejection (see payment-confirmation tests). */
async function rejection(promise: Promise<unknown>): Promise<{ message: string; detail: string }> {
  try {
    await promise;
    return { message: "NO_ERROR", detail: "" };
  } catch (error) {
    const record = error as { message?: string; detail?: string };
    return { message: record.message ?? "", detail: record.detail ?? "" };
  }
}

describe("schema constraints", () => {
  let db: PGlite;
  let fixture: Fixture;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
    fixture = await createFixture(db);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("declares the expected foreign keys", async () => {
    const result = await db.query<{
      table_name: string;
      column_name: string;
      referenced_table: string;
    }>(
      `select t.relname as table_name,
              a.attname as column_name,
              rt.relname as referenced_table
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_class rt on rt.oid = c.confrelid
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f'
          and t.relnamespace = 'public'::regnamespace
        order by 1, 2`,
    );

    const actual = result.rows.map(
      (row) => `${row.table_name}.${row.column_name}->${row.referenced_table}`,
    );

    expect(actual).toEqual(
      [
        "attendance.event_id->events",
        "attendance.ticket_id->tickets",
        "consents.event_id->events",
        "consents.participant_id->participants",
        "discount_codes.event_id->events",
        "discount_codes.pricing_tier_id->pricing_tiers",
        "discount_codes.ticket_type_id->ticket_types",
        "discount_redemptions.discount_code_id->discount_codes",
        "discount_redemptions.order_id->orders",
        "email_deliveries.ticket_id->tickets",
        "operational_alerts.payment_id->payments",
        "order_items.bundle_id->ticket_bundles",
        "order_items.order_id->orders",
        "order_items.pricing_tier_id->pricing_tiers",
        "order_items.ticket_type_id->ticket_types",
        "orders.discount_code_id->discount_codes",
        "orders.event_id->events",
        "participants.event_id->events",
        "participants.order_id->orders",
        "participants.order_item_id->order_items",
        "payment_events.payment_id->payments",
        "payments.order_id->orders",
        "pricing_tiers.ticket_type_id->ticket_types",
        "quantity_discounts.pricing_tier_id->pricing_tiers",
        "quantity_discounts.ticket_type_id->ticket_types",
        // Participant outbox (tickets discontinued): one projection row per participant.
        "sheets_participant_projections.event_id->events",
        "sheets_participant_projections.participant_id->participants",
        // Phase 5 outbox: a projection row belongs to exactly one ticket and event.
        "sheets_projections.event_id->events",
        "sheets_projections.ticket_id->tickets",
        "ticket_bundles.event_id->events",
        "ticket_bundles.pricing_tier_id->pricing_tiers",
        "ticket_bundles.ticket_type_id->ticket_types",
        "ticket_types.event_id->events",
        "tickets.event_id->events",
        "tickets.order_id->orders",
        "tickets.order_item_id->order_items",
        "tickets.participant_id->participants",
        "tickets.ticket_type_id->ticket_types",
      ].sort(),
    );
  });

  it("declares the required named indexes", async () => {
    const result = await db.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public'",
    );
    const names = new Set(result.rows.map((row) => row.indexname));

    for (const required of [
      "pricing_tiers_active_lookup_idx",
      "orders_expiry_idx",
      "orders_event_status_idx",
      "payments_one_approved_per_order_idx",
      "participants_event_national_id_idx",
      "consents_participant_kind_idx",
      "email_deliveries_retry_idx",
      "attendance_ticket_id_key",
      "tickets_token_key",
      "tickets_participant_id_key",
      "payments_order_attempt_unique",
      "payments_wompi_reference_key",
      "payments_wompi_transaction_id_key",
      "payment_events_dedupe_key_key",
      "email_deliveries_idempotency_key_key",
      "discount_redemptions_unique_per_order",
    ]) {
      expect(names.has(required), `missing index/constraint: ${required}`).toBe(true);
    }
  });

  it("rejects a second approved payment for the same order with a typed conflict", async () => {
    // The `payments_guard_single_approved` trigger turns what used to be a raw 23505 unique
    // violation into the typed contract the payment pipeline uses, so the webhook can record a
    // durable REJECTED outcome instead of failing with a retryable 503. The partial unique index
    // `payments_one_approved_per_order_idx` stays as the hard backstop (asserted above).
    const failure = await rejection(
      db.query(
        `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents)
         values ($1, 2, 'EVT-2026-000001-2', 'approved', 9500000)`,
        [fixture.orderId],
      ),
    );
    expect(failure.message).toMatch(/Order already has an approved payment/);
    expect(failure.detail).toBe("DOUBLE_PAYMENT_CONFLICT");
  });

  it("rejects duplicate Wompi references and duplicate transaction ids", async () => {
    await expectRejection(
      db.query(
        `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents)
         values ($1, 2, 'EVT-2026-000001', 'declined', 9500000)`,
        [fixture.orderId],
      ),
      /payments_wompi_reference_key/,
    );

    await expectRejection(
      db.query(
        `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents, wompi_transaction_id)
         values ($1, 3, 'EVT-2026-000001-3', 'declined', 9500000, 'wompi-tx-0001')`,
        [fixture.orderId],
      ),
      /payments_wompi_transaction_id_key/,
    );
  });

  it("rejects duplicate webhook events through the dedupe key", async () => {
    await db.query(
      `insert into public.payment_events (dedupe_key, wompi_event_name, wompi_transaction_id, payment_id, checksum_valid, processed_at, result, http_status)
       values ($1, 'transaction.updated', 'wompi-tx-0001', $2, true, now(), 'APPLIED', 200)`,
      ["a".repeat(64), fixture.paymentId],
    );

    await expectRejection(
      db.query(
        `insert into public.payment_events (dedupe_key, wompi_event_name, checksum_valid)
         values ($1, 'transaction.updated', true)`,
        ["a".repeat(64)],
      ),
      /payment_events_dedupe_key_key/,
    );

    await expectRejection(
      db.query(
        `insert into public.payment_events (dedupe_key, wompi_event_name, checksum_valid, result)
         values ($1, 'transaction.updated', true, 'NOT_A_RESULT')`,
        ["b".repeat(64)],
      ),
      /payment_event_result/,
    );
  });

  it("rejects a second attendance row for one ticket (double check-in)", async () => {
    await db.query(
      `insert into public.attendance (ticket_id, event_id, checked_in_by, method)
       values ($1, $2, 'operador-1', 'QR_SCAN')`,
      [fixture.ticketId, fixture.eventId],
    );

    await expectRejection(
      db.query(
        `insert into public.attendance (ticket_id, event_id, checked_in_by, method)
         values ($1, $2, 'operador-2', 'MANUAL')`,
        [fixture.ticketId, fixture.eventId],
      ),
      /attendance_ticket_id_key/,
    );
  });

  it("rejects duplicate email deliveries and mis-derived idempotency keys", async () => {
    // The key comes from the Phase 1 domain function: if its format ever drifts from the
    // database CHECK constraint, this test fails.
    const idempotencyKey = buildEmailIdempotencyKey({
      ticketId: fixture.ticketId,
      template: "TICKET_CONFIRMATION",
    });

    await db.query(
      `insert into public.email_deliveries (ticket_id, template, idempotency_key, recipient_email, status, sent_at, attempt_count)
       values ($1, 'TICKET_CONFIRMATION', $2, 'ana@example.com', 'SENT', now(), 1)`,
      [fixture.ticketId, idempotencyKey],
    );

    await expectRejection(
      db.query(
        `insert into public.email_deliveries (ticket_id, template, idempotency_key, recipient_email)
         values ($1, 'TICKET_CONFIRMATION', $2, 'ana@example.com')`,
        [fixture.ticketId, idempotencyKey],
      ),
      /email_deliveries_idempotency_key_key/,
    );

    await expectRejection(
      db.query(
        `insert into public.email_deliveries (ticket_id, template, idempotency_key, recipient_email)
         values ($1, 'TICKET_CONFIRMATION', 'ticket:not-the-ticket:TICKET_CONFIRMATION', 'ana@example.com')`,
        [fixture.ticketId],
      ),
      /email_deliveries_key_derivation_check/,
    );
  });

  it("rejects a second ticket pointing at the same participant", async () => {
    await expectRejection(
      db.query(
        `insert into public.tickets (event_id, order_id, order_item_id, participant_id, ticket_type_id, token, price_paid_cents)
         values ($1, $2, $3, $4, $5, 'TKT_AAAAAAAAAAAAAAAAAAAA', 9500000)`,
        [
          fixture.eventId,
          fixture.orderId,
          fixture.orderItemId,
          fixture.participantId,
          fixture.ticketTypeId,
        ],
      ),
      /tickets_participant_id_key/,
    );
  });

  it("rejects impossible order and order-item values", async () => {
    const scratchOrderId = await queryId(
      db,
      `insert into public.orders (reference, event_id, buyer_email, subtotal_cents, total_cents)
       values ('EVT-2026-000002', $1, 'scratch@example.com', 200, 200)
       returning id`,
      [fixture.eventId],
    );

    await expectRejection(
      db.query(
        `insert into public.order_items (order_id, ticket_type_id, pricing_tier_id, quantity, unit_price_cents, line_total_cents, ticket_type_name, pricing_tier_name)
         values ($1, $2, $3, 0, 100, 0, 'Entrada general', 'Preventa 1')`,
        [scratchOrderId, fixture.ticketTypeId, fixture.pricingTierId],
      ),
      /order_items_quantity_check/,
    );

    await expectRejection(
      db.query(
        `insert into public.orders (reference, event_id, buyer_email, subtotal_cents, total_cents)
         values ('EVT-2026-000003', $1, 'negative@example.com', -1, 0)`,
        [fixture.eventId],
      ),
      /orders_subtotal_cents_check/,
    );

    await expectRejection(
      db.query(
        `insert into public.orders (reference, event_id, buyer_email, subtotal_cents, total_cents)
         values ('EVT-2026-000004', $1, 'mismatch@example.com', 100, 90)`,
        [fixture.eventId],
      ),
      /orders_total_check/,
    );

    await expectRejection(
      db.query(
        `insert into public.orders (reference, event_id, buyer_email, subtotal_cents, total_cents, paid_at)
         values ('EVT-2026-000005', $1, 'paid@example.com', 100, 100, now())`,
        [fixture.eventId],
      ),
      /orders_paid_at_check/,
    );
  });

  it("rejects impossible payment states and discount shapes", async () => {
    await expectRejection(
      db.query(
        `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents, approved_at)
         values ($1, 4, 'EVT-2026-000001-4', 'pending', 9500000, now())`,
        [fixture.orderId],
      ),
      /payments_approved_at_check/,
    );

    await expectRejection(
      db.query(
        `insert into public.discount_codes (event_id, code, kind, amount_cents)
         values ($1, 'BADSHAPE', 'PERCENT', 1000)`,
        [fixture.eventId],
      ),
      /discount_codes_shape_check/,
    );

    await expectRejection(
      db.query(
        `insert into public.discount_codes (event_id, code, kind, percent_bps)
         values ($1, 'BADSHAPE2', 'PERCENT', 10001)`,
        [fixture.eventId],
      ),
      /percent_bps/,
    );
  });

  it("rejects invalid participant data but deliberately allows a repeated cédula", async () => {
    await expectRejection(
      db.query(
        `insert into public.participants (event_id, order_id, order_item_id, first_name, last_name, national_id, email, phone, city)
         values ($1, $2, $3, 'Bad', 'Id', 'ABC123', 'bad@example.com', '573001234567', 'Cali')`,
        [fixture.eventId, fixture.orderId, fixture.orderItemId],
      ),
      /participants_national_id_check/,
    );

    await expectRejection(
      db.query(
        `insert into public.participants (event_id, order_id, order_item_id, first_name, last_name, national_id, email, phone, city)
         values ($1, $2, $3, 'Bad', 'Phone', '987654321', 'bad@example.com', 'not-a-phone', 'Cali')`,
        [fixture.eventId, fixture.orderId, fixture.orderItemId],
      ),
      /participants_phone_check/,
    );

    // Open decision (docs/data-model.md section 6.1): duplicate cédulas are NOT rejected
    // yet. This test documents the deliberate absence of the constraint.
    const duplicate = await db.query<{ id: string }>(
      `insert into public.participants (event_id, order_id, order_item_id, first_name, last_name, national_id, email, phone, city)
       values ($1, $2, $3, 'Ana', 'Pérez', '1020456789', 'ana2@example.com', '573001234567', 'Bogotá')
       returning id`,
      [fixture.eventId, fixture.orderId, fixture.orderItemId],
    );
    expect(duplicate.rows[0]?.id).toBeDefined();
  });

  it("rejects invalid consent kinds and forbids updating consent history", async () => {
    await db.query(
      `insert into public.consents (event_id, participant_id, kind, granted, policy_version)
       values ($1, $2, 'DATA_PROCESSING', true, 'v1')`,
      [fixture.eventId, fixture.participantId],
    );

    await expectRejection(
      db.query(
        `insert into public.consents (event_id, participant_id, kind, granted, policy_version)
         values ($1, $2, 'MARKETING', true, 'v1')`,
        [fixture.eventId, fixture.participantId],
      ),
      /consent_kind/,
    );

    await expectRejection(
      db.query(
        `update public.consents set granted = false where participant_id = $1 and kind = 'DATA_PROCESSING'`,
        [fixture.participantId],
      ),
      /append-only/,
    );

    // Withdrawal is a new row, and the effective decision is the latest one.
    await db.query(
      `insert into public.consents (event_id, participant_id, kind, granted, policy_version)
       values ($1, $2, 'DATA_PROCESSING', false, 'v2')`,
      [fixture.eventId, fixture.participantId],
    );
    const latest = await db.query<{ granted: boolean }>(
      `select granted from public.consents
        where participant_id = $1 and kind = 'DATA_PROCESSING'
        order by captured_at desc, id desc limit 1`,
      [fixture.participantId],
    );
    expect(latest.rows[0]?.granted).toBe(false);
  });

  it("prevents oversell through the check constraint and the conditional update pattern", async () => {
    await expectRejection(
      db.query(`update public.pricing_tiers set quantity_reserved = 121 where id = $1`, [
        fixture.pricingTierId,
      ]),
      /pricing_tiers_inventory_check/,
    );

    // A single-unit stage: the conditional UPDATE is the atomic reservation used by the
    // order transaction. The first claim succeeds, the second matches zero rows.
    const stageId = await queryId(
      db,
      `insert into public.pricing_tiers (ticket_type_id, name, sequence, price_cents, quantity_limit)
       values ($1, 'Etapa única', 2, 100, 1)
       returning id`,
      [fixture.ticketTypeId],
    );

    const claim = async (): Promise<number> =>
      db
        .query<{ id: string }>(
          `update public.pricing_tiers
              set quantity_reserved = quantity_reserved + 1
            where id = $1
              and (quantity_limit is null or quantity_reserved + quantity_sold + 1 <= quantity_limit)
            returning id`,
          [stageId],
        )
        .then((result) => result.rows.length);

    expect(await claim()).toBe(1);
    expect(await claim()).toBe(0);

    const stage = await db.query<{ quantity_reserved: number; quantity_limit: number }>(
      "select quantity_reserved, quantity_limit from public.pricing_tiers where id = $1",
      [stageId],
    );
    expect(stage.rows[0]?.quantity_reserved).toBe(1);
    expect(stage.rows[0]?.quantity_limit).toBe(1);
  });
});
