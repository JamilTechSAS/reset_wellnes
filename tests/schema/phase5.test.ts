/**
 * Phase 5 schema behavior on a real (in-process) PostgreSQL.
 *
 * Covers the SQL that the Phase 5 API depends on: reconciliation bookkeeping and the same
 * `confirm_payment` convergence, the PostgreSQL rate limiter, participant assignment
 * (ownership + auto unit selection + append-only consents), the check-in precedence, the
 * public/operator projections and the Google Sheets outbox triggers.
 *
 * Like the other schema suites, one database is shared for speed; each test starts from a
 * clean transactional slate and its own fixture (see `reset`).
 *
 * Concurrency is NOT covered here (PGlite is single-session); the race-sensitive patterns
 * are verified against a real PostgreSQL 17 instance with parallel sessions and documented
 * in docs/phases/phase-05.md.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RECONCILIATION_DELAY_SECONDS } from "@shared/domain/reconciliation.ts";

import {
  applyMigrations,
  createFixture,
  expectRejection,
  queryId,
  type Fixture,
} from "./helpers.ts";

const PARTICIPANT_PAYLOAD = {
  firstName: "Beto",
  lastName: "Gómez",
  nationalId: "987654321",
  email: "beto@example.com",
  phone: "573001112233",
  city: "Cali",
  consents: { dataProcessing: true, futureEvents: false },
} as const;

async function asJson(
  db: PGlite,
  sql: string,
  params: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const result = await db.query<{ value: Record<string, unknown> }>(sql, [...params]);
  const value = result.rows[0]?.value;
  if (value === undefined) {
    throw new Error(`No JSON returned for: ${sql}`);
  }
  return value;
}

describe("phase 5 schema", () => {
  let db: PGlite;
  let fixture: Fixture;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  /**
   * Each test owns its rows. The schema tests share one database for speed, and several
   * assertions here are exact (counts, claim results, projection rows), so leftover state
   * from a previous test would make them lie. Children are deleted before parents; the
   * order below respects every `on delete restrict` edge in the schema.
   */
  async function reset(): Promise<void> {
    await db.exec(`
      delete from public.attendance;
      delete from public.email_deliveries;
      delete from public.sheets_projections;
      delete from public.consents;
      delete from public.tickets;
      delete from public.participants;
      delete from public.payment_events;
      delete from public.payments;
      delete from public.discount_redemptions;
      delete from public.order_items;
      delete from public.orders;
      delete from public.pricing_tiers;
      delete from public.ticket_types;
      delete from public.events;
      delete from public.rate_limit_counters;
      delete from public.operators;
    `);
    fixture = await createFixture(db);
  }

  beforeEach(reset);

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  it("enforces the reconciliation result and failure vocabulary", async () => {
    for (const result of [
      "APPROVED_APPLIED",
      "APPROVED_DUPLICATE",
      "RECONCILIATION_REQUIRED",
      "STILL_PENDING",
      "DECLINED",
      "VOIDED",
      "ERROR",
      "UNKNOWN_STATUS",
      "MISMATCH",
      "NOT_FOUND_AT_PROVIDER",
      "UPSTREAM_ERROR",
    ]) {
      await db.query("update public.payments set last_reconciliation_result = $1 where id = $2", [
        result,
        fixture.paymentId,
      ]);
    }
    await expectRejection(
      db.query(
        "update public.payments set last_reconciliation_result = 'NOT_A_RESULT' where id = $1",
        [fixture.paymentId],
      ),
      /last_reconciliation_result/,
    );

    for (const failure of [
      "UPSTREAM_ERROR",
      "VALIDATION_MISMATCH",
      "PROVIDER_NOT_FOUND",
      "CONFIRMATION_FAILED",
    ]) {
      await db.query("update public.payments set last_reconciliation_failure = $1 where id = $2", [
        failure,
        fixture.paymentId,
      ]);
    }
    await expectRejection(
      db.query("update public.payments set last_reconciliation_failure = 'NOPE' where id = $1", [
        fixture.paymentId,
      ]),
      /last_reconciliation_failure/,
    );
  });

  it("keeps the SQL backoff in parity with the TypeScript schedule", async () => {
    for (const [index, expected] of RECONCILIATION_DELAY_SECONDS.entries()) {
      const result = await db.query<{ seconds: number }>(
        "select app_private.reconciliation_delay_seconds($1) as seconds",
        [index + 1],
      );
      expect(result.rows[0]?.seconds, `attempt ${String(index + 1)}`).toBe(expected);
    }
    const beyond = await db.query<{ seconds: number }>(
      "select app_private.reconciliation_delay_seconds(99) as seconds",
    );
    expect(beyond.rows[0]?.seconds).toBe(86_400);
  });

  it("schedules a new pending attempt and leaves a final one unscheduled", async () => {
    const pending = await db.query<{ next_at: string | null }>(
      `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents)
       values ($1, 9, 'EVT-2026-000001-9', 'pending', 9500000)
       returning app_private.iso_utc(next_reconciliation_at) as next_at`,
      [fixture.orderId],
    );
    expect(pending.rows[0]?.next_at).not.toBeNull();

    const declined = await db.query<{ next_at: string | null }>(
      `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents, finalized_at)
       values ($1, 10, 'EVT-2026-000001-10', 'declined', 9500000, now())
       returning app_private.iso_utc(next_reconciliation_at) as next_at`,
      [fixture.orderId],
    );
    expect(declined.rows[0]?.next_at).toBeNull();
  });

  it("claims due attempts once, only for non-paid orders, and records the outcome", async () => {
    // Due: pending attempt with a transaction id, order payable, schedule in the past.
    const dueId = await queryId(
      db,
      `insert into public.payments (order_id, attempt, wompi_reference, wompi_transaction_id, status, amount_cents, next_reconciliation_at)
       values ($1, 20, 'EVT-2026-000001-20', '1292-0000000000-00020', 'pending', 9500000, now() - interval '1 minute')
       returning id`,
      [fixture.orderId],
    );
    // Not due: scheduled far in the future.
    await db.query(
      `insert into public.payments (order_id, attempt, wompi_reference, wompi_transaction_id, status, amount_cents, next_reconciliation_at)
       values ($1, 21, 'EVT-2026-000001-21', '1292-0000000000-00021', 'pending', 9500000, now() + interval '1 hour')`,
      [fixture.orderId],
    );
    // Not eligible: no transaction id can never be queried at Wompi.
    await db.query(
      `insert into public.payments (order_id, attempt, wompi_reference, status, amount_cents, next_reconciliation_at)
       values ($1, 22, 'EVT-2026-000001-22', 'pending', 9500000, now() - interval '1 minute')`,
      [fixture.orderId],
    );

    const claimed = await db.query<{ paymentId: string }>(
      `select value->>'paymentId' as "paymentId" from public.claim_payment_reconciliations(10, 8, now()) as value`,
    );
    expect(claimed.rows.map((row) => row.paymentId)).toEqual([dueId]);

    // The claim consumed an attempt and advanced the schedule: a second claim finds nothing.
    const second = await db.query<{ paymentId: string }>(
      `select value->>'paymentId' as "paymentId" from public.claim_payment_reconciliations(10, 8, now()) as value`,
    );
    expect(second.rows).toEqual([]);

    // A retryable result keeps the schedule; a terminal one clears it.
    const retryable = await asJson(
      db,
      "select public.finish_payment_reconciliation($1, 'STILL_PENDING') as value",
      [dueId],
    );
    expect(retryable.nextReconciliationAt).not.toBeNull();

    const terminal = await asJson(
      db,
      "select public.finish_payment_reconciliation($1, 'APPROVED_APPLIED') as value",
      [dueId],
    );
    expect(terminal.nextReconciliationAt).toBeNull();
  });

  it("excludes PAID orders from the sweep and enforces the attempt budget", async () => {
    // A paid order whose earlier attempt is still pending: approving again would violate
    // payments_one_approved_per_order_idx, so the sweep must not touch it.
    await db.query("update public.orders set status = 'PAID', paid_at = now() where id = $1", [
      fixture.orderId,
    ]);
    await db.query(
      `insert into public.payments (order_id, attempt, wompi_reference, wompi_transaction_id, status, amount_cents, next_reconciliation_at)
       values ($1, 30, 'EVT-2026-000001-30', '1292-0000000000-00030', 'pending', 9500000, now() - interval '1 minute')`,
      [fixture.orderId],
    );
    const whilePaid = await db.query(
      "select 1 from public.claim_payment_reconciliations(10, 8, now()) as value",
    );
    expect(whilePaid.rows).toEqual([]);

    // Payable again, but with the attempt budget exhausted: the sweep must leave it for a
    // human instead of querying Wompi forever.
    await db.query("delete from public.payments where order_id = $1 and attempt = 30", [
      fixture.orderId,
    ]);
    await db.query("update public.orders set status = 'PENDING', paid_at = null where id = $1", [
      fixture.orderId,
    ]);
    await db.query(
      `insert into public.payments (order_id, attempt, wompi_reference, wompi_transaction_id, status, amount_cents, next_reconciliation_at, reconciliation_attempts)
       values ($1, 31, 'EVT-2026-000001-31', '1292-0000000000-00031', 'pending', 9500000, now() - interval '1 minute', 8)`,
      [fixture.orderId],
    );
    const exhausted = await db.query(
      "select 1 from public.claim_payment_reconciliations(10, 8, now()) as value",
    );
    expect(exhausted.rows).toEqual([]);
  });

  it("rejects an unknown result in finish_payment_reconciliation", async () => {
    await expectRejection(
      db.query("select public.finish_payment_reconciliation($1, 'NOPE')", [fixture.paymentId]),
      /not a recognized outcome/,
    );
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  it("consumes fixed-window slots atomically and cleans expired counters", async () => {
    const first = await asJson(
      db,
      "select public.consume_rate_limit('test:scope', 'key-a', 2, 60) as value",
    );
    expect(first).toMatchObject({ allowed: true, remaining: 1, limit: 2, windowSeconds: 60 });
    const second = await asJson(
      db,
      "select public.consume_rate_limit('test:scope', 'key-a', 2, 60) as value",
    );
    expect(second).toMatchObject({ allowed: true, remaining: 0 });
    const third = await asJson(
      db,
      "select public.consume_rate_limit('test:scope', 'key-a', 2, 60) as value",
    );
    expect(third).toMatchObject({ allowed: false, remaining: 0 });
    expect(typeof third.resetAt).toBe("string");

    // A different key has its own budget.
    const other = await asJson(
      db,
      "select public.consume_rate_limit('test:scope', 'key-b', 2, 60) as value",
    );
    expect(other).toMatchObject({ allowed: true });

    // A different scope cannot consume the same budget even with the same key.
    const otherScope = await asJson(
      db,
      "select public.consume_rate_limit('test:other', 'key-a', 2, 60) as value",
    );
    expect(otherScope).toMatchObject({ allowed: true, remaining: 1 });

    // Fresh windows are kept; a horizon below five minutes is rejected outright.
    const kept = await asJson(db, "select public.cleanup_rate_limit_counters(7200) as value");
    expect(kept).toMatchObject({ deleted: 0 });
    await expectRejection(
      db.query("select public.cleanup_rate_limit_counters(299)"),
      /at least 300/,
    );

    // Age the windows and clean them with the production horizon.
    await db.query(
      "update public.rate_limit_counters set window_start = now() - interval '2 hours'",
    );
    const deleted = await asJson(db, "select public.cleanup_rate_limit_counters(3600) as value");
    expect(Number(deleted.deleted)).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Participant assignment
  // -------------------------------------------------------------------------

  it("attaches participants to a paid order with ownership and appends consent history", async () => {
    const reference = "EVT-2026-000010";
    const orderId = await queryId(
      db,
      `insert into public.orders (reference, event_id, status, buyer_email, buyer_name, subtotal_cents, total_cents, paid_at)
       values ($1, $2, 'PAID', 'buyer2@example.com', 'Compradora', 19000000, 19000000, now())
       returning id`,
      [reference, fixture.eventId],
    );
    await db.query(
      `insert into public.order_items (order_id, ticket_type_id, pricing_tier_id, quantity, unit_price_cents, line_total_cents, ticket_type_name, pricing_tier_name)
       values ($1, $2, $3, 2, 9500000, 19000000, 'Entrada general', 'Preventa 1')`,
      [orderId, fixture.ticketTypeId, fixture.pricingTierId],
    );
    const itemId = await queryId(db, "select id from public.order_items where order_id = $1", [
      orderId,
    ]);
    for (const [unit, token] of [
      [1, "TKT_00000000000000000001"],
      [2, "TKT_00000000000000000002"],
    ] as const) {
      await db.query(
        `insert into public.tickets (event_id, order_id, order_item_id, order_item_seq, ticket_type_id, token, price_paid_cents)
         values ($1, $2, $3, $4, $5, $6, 9500000)`,
        [fixture.eventId, orderId, itemId, unit, fixture.ticketTypeId, token],
      );
    }

    // Wrong email and unknown reference are the same answer.
    const wrong = await asJson(
      db,
      "select public.attach_participant($1, 'nobody@example.com', $2::jsonb) as value",
      [reference, JSON.stringify(PARTICIPANT_PAYLOAD)],
    );
    expect(wrong).toEqual({ found: false });

    const first = await asJson(
      db,
      "select public.attach_participant($1, 'buyer2@example.com', $2::jsonb) as value",
      [reference, JSON.stringify(PARTICIPANT_PAYLOAD)],
    );
    expect(first.found).toBe(true);
    expect((first.ticket as { unit: number }).unit).toBe(1);
    expect(first.remainingUnassigned).toBe(1);
    expect(first.consentsAppended).toBe(2);

    const second = await asJson(
      db,
      "select public.attach_participant($1, 'buyer2@example.com', $2::jsonb) as value",
      [
        reference,
        JSON.stringify({
          ...PARTICIPANT_PAYLOAD,
          nationalId: "111222333",
          email: "otra@example.com",
        }),
      ],
    );
    expect((second.ticket as { unit: number }).unit).toBe(2);
    expect(second.remainingUnassigned).toBe(0);

    // No assignable unit left: a stable conflict, never a silent overwrite.
    await expectRejection(
      db.query("select public.attach_participant($1, 'buyer2@example.com', $2::jsonb)", [
        reference,
        JSON.stringify({
          ...PARTICIPANT_PAYLOAD,
          nationalId: "444555666",
          email: "tercera@example.com",
        }),
      ]),
      /TICKET_NOT_ASSIGNABLE|no unassigned/,
    );

    // Consent history is append-only: updating the same participant appends new rows, and
    // the earlier rows are untouched.
    const participantId = (first.participant as { participantId: string }).participantId;
    const updated = await asJson(
      db,
      "select public.update_participant($1, 'buyer2@example.com', $2, $3::jsonb) as value",
      [
        reference,
        participantId,
        JSON.stringify({
          ...PARTICIPANT_PAYLOAD,
          firstName: "Beto Jr.",
          consents: { dataProcessing: true, futureEvents: true },
        }),
      ],
    );
    expect(updated.found).toBe(true);
    expect(updated.consentsAppended).toBe(1);
    const history = await db.query<{ count: number }>(
      "select count(*)::int as count from public.consents where participant_id = $1",
      [participantId],
    );
    expect(history.rows[0]?.count).toBe(3);
  });

  it("rejects attaching to an unpaid order", async () => {
    await expectRejection(
      db.query("select public.attach_participant($1, 'comprador@example.com', $2::jsonb)", [
        "EVT-2026-000001",
        JSON.stringify(PARTICIPANT_PAYLOAD),
      ]),
      /ORDER_NOT_PAID|paid order/,
    );
  });

  // -------------------------------------------------------------------------
  // Check-in
  // -------------------------------------------------------------------------

  it("records the first valid check-in and never admits an unpaid, cancelled or replayed ticket", async () => {
    const token = "TKT_0123456789ABCDEFGHJK";

    const unpaid = await asJson(
      db,
      "select public.record_check_in($1, 'Operador 1', null, 'QR_SCAN') as value",
      [token],
    );
    expect(unpaid.outcome).toBe("NOT_PAID");

    await db.query("update public.orders set status = 'PAID', paid_at = now() where id = $1", [
      fixture.orderId,
    ]);

    const valid = await asJson(
      db,
      "select public.record_check_in($1, 'Operador 1', null, 'QR_SCAN') as value",
      [token],
    );
    expect(valid.outcome).toBe("VALID");
    expect(valid.participantName).toBe("Ana Pérez");

    const replay = await asJson(
      db,
      "select public.record_check_in($1, 'Operador 2', null, 'QR_SCAN') as value",
      [token],
    );
    expect(replay.outcome).toBe("ALREADY_USED");
    expect(typeof replay.checkedInAt).toBe("string");

    const unknown = await asJson(
      db,
      "select public.record_check_in('TKT_ZZZZZZZZZZZZZZZZZZZZ', 'Operador 1', null, 'QR_SCAN') as value",
    );
    expect(unknown.outcome).toBe("NOT_FOUND");

    // A cancelled ticket is refused with its own outcome even after a valid admission
    // would otherwise have applied.
    await db.query("update public.tickets set status = 'CANCELLED' where token = $1", [token]);
    const cancelled = await asJson(
      db,
      "select public.record_check_in($1, 'Operador 1', null, 'QR_SCAN') as value",
      [token],
    );
    expect(cancelled.outcome).toBe("CANCELLED");
  });

  // -------------------------------------------------------------------------
  // Public vs operator projections
  // -------------------------------------------------------------------------

  it("never exposes cédula, email or phone through the public projections", async () => {
    await db.query("update public.orders set status = 'PAID', paid_at = now() where id = $1", [
      fixture.orderId,
    ]);

    const publicTicket = await asJson(db, "select public.get_public_ticket($1) as value", [
      "TKT_0123456789ABCDEFGHJK",
    ]);
    expect(publicTicket.found).toBe(true);
    const serialized = JSON.stringify(publicTicket);
    expect(serialized).not.toContain("1020456789");
    expect(serialized).not.toContain("ana@example.com");
    expect(serialized).not.toContain("573001234567");

    const publicEvent = await asJson(db, "select public.get_public_event($1) as value", [
      "TAT-2026",
    ]);
    expect(publicEvent.found).toBe(true);
    const eventSerialized = JSON.stringify(publicEvent);
    expect(eventSerialized).not.toContain("capacity");
    expect(eventSerialized).not.toContain("quantity_reserved");
    expect(eventSerialized).not.toContain("quantity_sold");

    // An unpublished event is invisible, with the same shape as an unknown one.
    await db.query("update public.events set status = 'DRAFT' where id = $1", [fixture.eventId]);
    const hidden = await asJson(db, "select public.get_public_event($1) as value", ["TAT-2026"]);
    expect(hidden).toEqual({ found: false });

    // The operator view is the admission view: it includes the identity data the door needs.
    const operatorTicket = await asJson(db, "select public.get_operator_ticket($1) as value", [
      "TKT_0123456789ABCDEFGHJK",
    ]);
    expect(operatorTicket.found).toBe(true);
    expect(JSON.stringify(operatorTicket)).toContain("1020456789");
    const admission = operatorTicket.admission as { orderStatus: string; checkedIn: boolean };
    expect(admission.orderStatus).toBe("PAID");
    expect(admission.checkedIn).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Google Sheets outbox
  // -------------------------------------------------------------------------

  it("collapses every change to a ticket into one projection row and re-queues it", async () => {
    // The fixture's ticket insert fired the enqueue trigger.
    const initial = await db.query<{ status: string; attempt_count: number }>(
      "select status, attempt_count from public.sheets_projections where ticket_id = $1",
      [fixture.ticketId],
    );
    expect(initial.rows).toEqual([{ status: "QUEUED", attempt_count: 0 }]);

    // Updating the participant re-queues the same row instead of inserting another.
    await db.query("update public.participants set city = 'Medellín' where id = $1", [
      fixture.participantId,
    ]);
    const after = await db.query<{ count: number }>(
      "select count(*)::int as count from public.sheets_projections where ticket_id = $1",
      [fixture.ticketId],
    );
    expect(after.rows[0]?.count).toBe(1);

    // A claim takes the row; a mid-write change puts it back to QUEUED, so the optimistic
    // finish cannot mark the newer state as synced.
    const claimed = await db.query<{ ticket_id: string; status: string; attempt_count: number }>(
      "select ticket_id, status, attempt_count from public.claim_sheet_projections(50, now(), 900, 6)",
    );
    const ours = claimed.rows.find((row) => row.ticket_id === fixture.ticketId);
    expect(ours?.status).toBe("SYNCING");
    expect(ours?.attempt_count).toBe(1);

    await db.query("update public.participants set city = 'Cali' where id = $1", [
      fixture.participantId,
    ]);
    const finished = await asJson(
      db,
      "select public.finish_sheet_projections(array[$1]::uuid[], 'SYNCED') as value",
      [fixture.ticketId],
    );
    expect(finished.updatedCount).toBe(0);

    const requeued = await db.query<{ status: string; attempt_count: number }>(
      "select status, attempt_count from public.sheets_projections where ticket_id = $1",
      [fixture.ticketId],
    );
    expect(requeued.rows[0]?.status).toBe("QUEUED");
    expect(requeued.rows[0]?.attempt_count).toBe(0);

    // A second claim succeeds and the finish marks it synced this time.
    await db.query("select * from public.claim_sheet_projections(50, now(), 900, 6)");
    const done = await asJson(
      db,
      "select public.finish_sheet_projections(array[$1]::uuid[], 'SYNCED') as value",
      [fixture.ticketId],
    );
    expect(done.updatedCount).toBe(1);
    const stats = await asJson(db, "select public.sheet_projection_stats() as value");
    expect(stats.synced).toBeGreaterThanOrEqual(1);
  });

  it("stops claiming a projection after the attempt ceiling until new data arrives", async () => {
    await db.query(
      "update public.sheets_projections set attempt_count = 6, status = 'FAILED', next_attempt_at = now() - interval '1 hour' where ticket_id = $1",
      [fixture.ticketId],
    );
    const claimed = await db.query<{ ticket_id: string }>(
      "select ticket_id from public.claim_sheet_projections(200, now(), 900, 6) where ticket_id = $1",
      [fixture.ticketId],
    );
    expect(claimed.rows).toEqual([]);

    // New participant data resets the counter, so the projection is attempted again.
    await db.query("update public.participants set city = 'Barranquilla' where id = $1", [
      fixture.participantId,
    ]);
    const after = await db.query<{ status: string; attempt_count: number }>(
      "select status, attempt_count from public.sheets_projections where ticket_id = $1",
      [fixture.ticketId],
    );
    expect(after.rows[0]).toEqual({ status: "QUEUED", attempt_count: 0 });
  });
});
