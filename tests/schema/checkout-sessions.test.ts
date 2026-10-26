/**
 * Checkout-session pinning (migration 20261024170000) on PGlite.
 *
 * The defect these functions close: a repeated `POST /orders` (same idempotency key) returned
 * the same order and minted a SECOND ePayco session for the same reference, so ePayco could
 * approve a transaction the payment row did not record (staging, EVT-2026-000009).
 *
 * Asserted here, against the shipped SQL:
 *   - one live session per attempt, and REUSE while it is valid;
 *   - a short lease serializes creation, and only the lease holder can record the session;
 *   - a stale generation can never overwrite a newer session;
 *   - an elapsed session is superseded explicitly, and a new attempt supersedes its sibling's;
 *   - an attempt that can no longer be paid answers RETRY_REQUIRED instead of a new session;
 *   - one invoice reaches the provider at most once: an unresolved call (a lease outlived by
 *     the provider call, or a timeout/5xx) blocks a second session until a new attempt;
 *   - nothing touches the order, the payment status or inventory.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, createFixture, type Fixture } from "./helpers.ts";

let db: PGlite;
let fixture: Fixture;

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  fixture = await createFixture(db);
}, 30_000);

beforeEach(async () => {
  await db.exec(`
    delete from public.checkout_sessions;
    delete from public.payments where order_id <> '${fixture.orderId}';
    delete from public.orders where id <> '${fixture.orderId}';
  `);
});

afterAll(async () => {
  await db.close();
});

let sequence = 0;

type Attempt = {
  readonly orderId: string;
  readonly reference: string;
  readonly paymentId: string;
};

/** A pending epayco attempt with an open reservation — the payable baseline. */
async function pendingAttempt(
  options: {
    readonly status?: string;
    readonly reservation?: string;
    readonly provider?: string;
    readonly transactionId?: string | null;
    readonly attempt?: number;
  } = {},
): Promise<Attempt> {
  sequence += 1;
  const reference = `EVT-2026-${String(900000 + sequence)}`;
  const order = await db.query<{ id: string }>(
    `insert into public.orders
       (reference, event_id, status, buyer_email, buyer_name, subtotal_cents, total_cents,
        reservation_expires_at)
     values ($1, $2, $3, 'buyer@example.com', 'Comprador', 9500000, 9500000,
             coalesce($4::timestamptz, now() + interval '15 minutes'))
     returning id`,
    [reference, fixture.eventId, options.status ?? "PENDING", options.reservation ?? null],
  );
  const orderId = order.rows[0]?.id;
  if (orderId === undefined) {
    throw new Error("order insert returned no id");
  }

  const payment = await db.query<{ id: string }>(
    `insert into public.payments
       (order_id, attempt, wompi_reference, status, amount_cents, payment_provider,
        wompi_transaction_id)
     values ($1, $2, $3, 'pending', 9500000, $4, $5)
     returning id`,
    [
      orderId,
      options.attempt ?? 1,
      reference,
      options.provider ?? "epayco",
      options.transactionId ?? null,
    ],
  );
  const paymentId = payment.rows[0]?.id;
  if (paymentId === undefined) {
    throw new Error("payment insert returned no id");
  }
  return { orderId, reference, paymentId };
}

type Plan = {
  state: string;
  paymentId?: string;
  paymentReference?: string;
  paymentAttempt?: number;
  generation?: number;
  sessionId?: string;
  sessionExpiresAt?: string;
  reason?: string;
};

async function begin(reference: string, leaseSeconds = 30, now?: string): Promise<Plan> {
  const result = await db.query<{ p: Plan }>(
    now === undefined
      ? "select public.begin_checkout_session($1, $2) as p"
      : "select public.begin_checkout_session($1, $2, $3::timestamptz) as p",
    now === undefined ? [reference, leaseSeconds] : [reference, leaseSeconds, now],
  );
  const plan = result.rows[0]?.p;
  if (plan === undefined) {
    throw new Error("begin_checkout_session returned no row");
  }
  return plan;
}

type Completed = { created: boolean; sessionId?: string; reason?: string };

async function complete(
  reference: string,
  generation: number,
  sessionId = "sess_abc123",
  now?: string,
): Promise<Completed> {
  const result = await db.query<{ p: Completed }>(
    now === undefined
      ? "select public.complete_checkout_session($1, $2, $3) as p"
      : "select public.complete_checkout_session($1, $2, $3, $4::timestamptz) as p",
    now === undefined
      ? [reference, generation, sessionId]
      : [reference, generation, sessionId, now],
  );
  const completed = result.rows[0]?.p;
  if (completed === undefined) {
    throw new Error("complete_checkout_session returned no row");
  }
  return completed;
}

/** Defaults to UNKNOWN, the safe answer: the invoice must not be sent to ePayco again. */
async function abandon(
  reference: string,
  generation: number,
  providerOutcome: "NOT_CREATED" | "UNKNOWN" = "UNKNOWN",
): Promise<boolean> {
  const result = await db.query<{ released: boolean }>(
    "select (public.abandon_checkout_session($1, $2, $3) ->> 'released')::boolean as released",
    [reference, generation, providerOutcome],
  );
  return result.rows[0]?.released === true;
}

/** The unresolved-call marker of an attempt, as stored. */
async function unresolved(paymentId: string): Promise<boolean | undefined> {
  const result = await db.query<{ flag: boolean }>(
    "select checkout_call_unresolved as flag from public.payments where id = $1",
    [paymentId],
  );
  return result.rows[0]?.flag;
}

async function scalar<T>(sql: string): Promise<T | undefined> {
  const result = await db.query<Record<string, T>>(sql);
  const row = result.rows[0];
  return row === undefined ? undefined : Object.values(row)[0];
}

describe("begin_checkout_session", () => {
  it("issues one session for a payable attempt and reuses it afterwards", async () => {
    const attempt = await pendingAttempt();

    const first = await begin(attempt.reference);
    expect(first).toMatchObject({
      state: "CREATE",
      paymentId: attempt.paymentId,
      paymentReference: attempt.reference,
      paymentAttempt: 1,
    });
    expect(first.generation).toBe(1);

    const recorded = await complete(attempt.reference, first.generation ?? -1, "sess_live_1");
    expect(recorded.created).toBe(true);

    expect(await begin(attempt.reference)).toMatchObject({
      state: "REUSE",
      sessionId: "sess_live_1",
    });
    // Exactly one session exists: a replay resumed it instead of minting another.
    expect(await scalar<number>("select count(*)::int from public.checkout_sessions")).toBe(1);
  });

  it("refuses to issue a session while another request holds the lease", async () => {
    const attempt = await pendingAttempt();
    expect((await begin(attempt.reference)).state).toBe("CREATE");
    expect(await begin(attempt.reference)).toMatchObject({ state: "LEASED" });
  });

  it("re-issues a session only after the provider proved it created nothing", async () => {
    const attempt = await pendingAttempt();
    const first = await begin(attempt.reference);
    expect(await unresolved(attempt.paymentId)).toBe(true);

    // 4xx validation/auth: ePayco rejected the request before transaction creation.
    expect(await abandon(attempt.reference, first.generation ?? -1, "NOT_CREATED")).toBe(true);
    expect(await unresolved(attempt.paymentId)).toBe(false);

    const second = await begin(attempt.reference);
    expect(second.state).toBe("CREATE");
    // A fresh claim bumps the generation, so the abandoned attempt cannot complete later.
    expect(second.generation).toBe((first.generation ?? 0) + 1);
    expect(await complete(attempt.reference, first.generation ?? -1)).toMatchObject({
      created: false,
      reason: "LEASE_LOST",
    });
  });

  it("never authorizes a second call when the provider call outlived its lease", async () => {
    const attempt = await pendingAttempt();
    // A long reservation, so the only thing that elapses in this test is the lease.
    await db.query(
      "update public.orders set reservation_expires_at = now() + interval '10 years' where id = $1",
      [attempt.orderId],
    );
    const t0 = await scalar<string>("select (now() + interval '1 hour')::text");
    const t1 = await scalar<string>("select (now() + interval '2 hours')::text");

    const first = await begin(attempt.reference, 30, t0);
    expect(first.state).toBe("CREATE");

    // 30 s later the lease is gone and no session was recorded: the provider may still have
    // registered this invoice, so the answer is a refusal, never a second CREATE.
    expect(await begin(attempt.reference, 30, t1)).toMatchObject({
      state: "RETRY_REQUIRED",
      reason: "SESSION_CALL_UNRESOLVED",
    });
    expect(await scalar<number>("select count(*)::int from public.checkout_sessions")).toBe(0);
  });

  it("keeps the attempt blocked when the provider outcome is unknown", async () => {
    const attempt = await pendingAttempt();
    const first = await begin(attempt.reference);

    // Timeout or 5xx: nothing proves the provider created nothing.
    expect(await abandon(attempt.reference, first.generation ?? -1, "UNKNOWN")).toBe(true);
    expect(await unresolved(attempt.paymentId)).toBe(true);
    expect(await begin(attempt.reference)).toMatchObject({
      state: "RETRY_REQUIRED",
      reason: "SESSION_CALL_UNRESOLVED",
    });

    // A stale abandon (older generation) cannot void the newer attempt's authorization.
    expect(await abandon(attempt.reference, (first.generation ?? 0) - 1, "NOT_CREATED")).toBe(
      false,
    );
    expect(await unresolved(attempt.paymentId)).toBe(true);
  });

  it("records the session of a provider call that answered after its lease", async () => {
    const attempt = await pendingAttempt();
    await db.query(
      "update public.orders set reservation_expires_at = now() + interval '10 years' where id = $1",
      [attempt.orderId],
    );
    const t0 = await scalar<string>("select (now() + interval '1 hour')::text");
    const t1 = await scalar<string>("select (now() + interval '2 hours')::text");

    const plan = await begin(attempt.reference, 30, t0);
    expect(plan.state).toBe("CREATE");

    // The generation is the ownership proof: no other request can claim a newer one while the
    // call is unresolved, so the late answer still pins its own session instead of being lost.
    expect(await complete(attempt.reference, plan.generation ?? -1, "sess_late", t1)).toMatchObject(
      {
        created: true,
        sessionId: "sess_late",
      },
    );
    expect(await unresolved(attempt.paymentId)).toBe(false);
    expect(await begin(attempt.reference, 30, t1)).toMatchObject({
      state: "REUSE",
      sessionId: "sess_late",
    });
  });

  it("supersedes an elapsed session explicitly before issuing a replacement", async () => {
    const attempt = await pendingAttempt();
    await db.query(
      `insert into public.checkout_sessions
         (payment_id, payment_reference, session_id, issued_at, expires_at)
       values ($1, $2, 'sess_elapsed', now() - interval '2 hours', now() - interval '1 hour')`,
      [attempt.paymentId, attempt.reference],
    );

    const plan = await begin(attempt.reference);
    expect(plan.state).toBe("CREATE");

    const rows = await db.query<{ session_id: string; superseded_reason: string | null }>(
      "select session_id, superseded_reason from public.checkout_sessions order by issued_at",
    );
    expect(rows.rows).toEqual([{ session_id: "sess_elapsed", superseded_reason: "EXPIRED" }]);
  });

  it("requires a new payment attempt once the order is not payable", async () => {
    const failed = await pendingAttempt({ status: "FAILED" });
    expect(await begin(failed.reference)).toMatchObject({
      state: "RETRY_REQUIRED",
      reason: "ORDER_NOT_PENDING",
    });

    const expired = await pendingAttempt({ reservation: "2026-01-01T00:00:00Z" });
    expect(await begin(expired.reference)).toMatchObject({
      state: "RETRY_REQUIRED",
      reason: "RESERVATION_EXPIRED",
    });

    // A transaction already recorded at the provider: another session would put a second
    // transaction under the same reference — the defect this migration exists to prevent.
    const captured = await pendingAttempt({ transactionId: "390996271" });
    expect(await begin(captured.reference)).toMatchObject({
      state: "RETRY_REQUIRED",
      reason: "TRANSACTION_RECORDED",
    });
    expect(await scalar<number>("select count(*)::int from public.checkout_sessions")).toBe(0);
  });

  it("refuses a Wompi attempt, which needs no server-side session", async () => {
    const wompi = await pendingAttempt({ provider: "wompi" });
    await expect(begin(wompi.reference)).rejects.toThrow(/only issued for ePayco/i);
  });

  it("refuses an unknown payment reference", async () => {
    await expect(begin("EVT-2026-999999")).rejects.toThrow(/unknown/i);
  });
});

describe("complete_checkout_session", () => {
  it("records the session under the lease and clears it", async () => {
    const attempt = await pendingAttempt();
    const plan = await begin(attempt.reference);
    expect((await complete(attempt.reference, plan.generation ?? -1)).created).toBe(true);

    const lease = await db.query<{ lease: string | null }>(
      "select checkout_lease_until::text as lease from public.payments where id = $1",
      [attempt.paymentId],
    );
    expect(lease.rows[0]?.lease).toBeNull();

    // The lease is gone, so the same generation can no longer write another session.
    expect(await complete(attempt.reference, plan.generation ?? -1)).toMatchObject({
      created: false,
      reason: "LEASE_LOST",
    });
  });

  it("refuses the same provider session twice for one attempt", async () => {
    const attempt = await pendingAttempt();
    const plan = await begin(attempt.reference);
    await complete(attempt.reference, plan.generation ?? -1, "sess_dupe");
    await abandon(attempt.reference, plan.generation ?? -1);

    await db.query("update public.payments set checkout_lease_until = null where id = $1", [
      attempt.paymentId,
    ]);
    const second = await begin(attempt.reference);
    // The live session is resumed; nothing tries to record a duplicate id.
    expect(second.state).toBe("REUSE");
  });

  it("allows at most one live session per attempt", async () => {
    const attempt = await pendingAttempt();
    const plan = await begin(attempt.reference);
    await complete(attempt.reference, plan.generation ?? -1, "sess_first");

    await expect(
      db.query(
        `insert into public.checkout_sessions (payment_id, payment_reference, session_id, expires_at)
         values ($1, $2, 'sess_second', now() + interval '10 minutes')`,
        [attempt.paymentId, attempt.reference],
      ),
    ).rejects.toThrow(/checkout_sessions_live_idx/);
  });
});

describe("a new attempt supersedes the previous one", () => {
  it("closes the live session of the previous attempt with an auditable reason", async () => {
    const first = await pendingAttempt();
    const plan = await begin(first.reference);
    await complete(first.reference, plan.generation ?? -1, "sess_attempt_1");

    // `retry_payment` inserts attempt 2; the trigger is the audit point.
    await db.query(
      `insert into public.payments
         (order_id, attempt, wompi_reference, status, amount_cents, payment_provider)
       values ($1, 2, $2, 'pending', 9500000, 'epayco')`,
      [first.orderId, `${first.reference}-2`],
    );

    const session = await db.query<{ session_id: string; superseded_reason: string | null }>(
      "select session_id, superseded_reason from public.checkout_sessions",
    );
    expect(session.rows).toEqual([
      { session_id: "sess_attempt_1", superseded_reason: "NEW_ATTEMPT" },
    ]);

    // The new attempt is free to issue its own session, for its own reference.
    const second = await begin(`${first.reference}-2`);
    expect(second).toMatchObject({ state: "CREATE", paymentAttempt: 2 });
  });
});

describe("state is untouched by session bookkeeping", () => {
  it("never changes the order, its payment status or its reserved inventory", async () => {
    const attempt = await pendingAttempt();
    const snapshot = async () => {
      const result = await db.query<{
        status: string;
        payment_status: string;
        approved_at: string | null;
        finalized_at: string | null;
        transaction: string | null;
        reserved: number;
      }>(
        `select o.status::text as status, p.status::text as payment_status,
                p.approved_at::text as approved_at, p.finalized_at::text as finalized_at,
                p.wompi_transaction_id as transaction,
                (select t.quantity_reserved from public.pricing_tiers t
                  where t.id = $3) as reserved
           from public.orders o
           join public.payments p on p.order_id = o.id
          where o.id = $1 and p.id = $2`,
        [attempt.orderId, attempt.paymentId, fixture.pricingTierId],
      );
      return result.rows[0];
    };

    const before = await snapshot();
    expect(before).toBeDefined();

    const plan = await begin(attempt.reference);
    await complete(attempt.reference, plan.generation ?? -1);
    await abandon(attempt.reference, plan.generation ?? -1, "NOT_CREATED");

    // Session bookkeeping wrote only to `checkout_sessions` and the lease columns.
    expect(await snapshot()).toEqual(before);
    expect(before).toMatchObject({ status: "PENDING", approved_at: null, finalized_at: null });
  });
});
