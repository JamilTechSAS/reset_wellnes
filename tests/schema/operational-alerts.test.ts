/**
 * H8: operational alert ledger (migration 20261023150000) on PGlite.
 * Deduplication, the unresolved-payment scan, the bounded digest claim and the data guards.
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
  await db.exec("delete from public.operational_alerts");
});

afterAll(async () => {
  await db.close();
});

type Recorded = { alertId: string; created: boolean; occurrences: number };

async function record(
  key: string,
  kind = "RECONCILIATION_MISMATCH",
  detail: string | null = "MISMATCH",
) {
  const result = await db.query<{ r: Recorded }>(
    `select public.record_operational_alert($1, $2, 'warning', 'EVT-2026-000001', null, 'epayco', $3) as r`,
    [key, kind, detail],
  );
  const row = result.rows[0]?.r;
  if (row === undefined) {
    throw new Error("no row");
  }
  return row;
}

async function count(): Promise<number> {
  const result = await db.query<{ n: number }>(
    "select count(*)::int as n from public.operational_alerts",
  );
  return result.rows[0]?.n ?? -1;
}

describe("record_operational_alert", () => {
  it("creates an alert once and counts repeats as occurrences", async () => {
    const first = await record("recon-mismatch:p1");
    const second = await record("recon-mismatch:p1");
    const third = await record("recon-mismatch:p1");

    expect(first).toMatchObject({ created: true, occurrences: 1 });
    expect(second).toMatchObject({ created: false, occurrences: 2, alertId: first.alertId });
    expect(third.occurrences).toBe(3);
    expect(await count()).toBe(1);
  });

  it.each([
    ["an unknown kind", "NOT_A_KIND", "MISMATCH"],
    ["free text that could carry personal data", "RECONCILIATION_MISMATCH", "ana@example.com"],
    ["a detail with newlines", "RECONCILIATION_MISMATCH", "line1\nline2"],
  ])("refuses %s", async (_label, kind, detail) => {
    await expect(record("bad-alert:1", kind, detail)).rejects.toThrow(/check constraint/i);
    expect(await count()).toBe(0);
  });
});

describe("raise_unresolved_payment_alerts", () => {
  async function setAttempt(attempts: number, orderStatus = "PENDING") {
    await db.query(
      `update public.payments
          set status = 'pending', approved_at = null, finalized_at = null,
              wompi_transaction_id = '987654321',
              reconciliation_attempts = $2
        where id = $1`,
      [fixture.paymentId, attempts],
    );
    await db.query("update public.orders set status = $2 where id = $1", [
      fixture.orderId,
      orderStatus,
    ]);
  }

  it("alerts once for an attempt whose reconciliation budget is spent", async () => {
    await setAttempt(8);
    const first = await db.query<{ n: number }>(
      "select public.raise_unresolved_payment_alerts(8, now()) as n",
    );
    const second = await db.query<{ n: number }>(
      "select public.raise_unresolved_payment_alerts(8, now()) as n",
    );

    expect(first.rows[0]?.n).toBe(1);
    expect(second.rows[0]?.n).toBe(0);
    const alert = await db.query<{ kind: string; detail: string; payment_id: string }>(
      "select kind, detail, payment_id from public.operational_alerts",
    );
    expect(alert.rows).toEqual([
      {
        kind: "UNRESOLVED_PAYMENT",
        detail: "status pending, attempts 8",
        payment_id: fixture.paymentId,
      },
    ]);
  });

  it("does not alert while the budget is not spent, or for a paid order", async () => {
    await setAttempt(7);
    expect(
      (await db.query<{ n: number }>("select public.raise_unresolved_payment_alerts(8) as n"))
        .rows[0]?.n,
    ).toBe(0);
    await setAttempt(8, "PAID");
    expect(
      (await db.query<{ n: number }>("select public.raise_unresolved_payment_alerts(8) as n"))
        .rows[0]?.n,
    ).toBe(0);
  });
});

describe("claim_alert_notifications / finish_alert_notifications", () => {
  type Claimed = { alertId: string; kind: string; severity: string };

  async function claim(limit = 10, maxAttempts = 5): Promise<Claimed[]> {
    const result = await db.query<{ value: Claimed }>(
      "select value from public.claim_alert_notifications($1, $2, now()) as value",
      [limit, maxAttempts],
    );
    return result.rows.map((row) => row.value);
  }

  it("claims unsent alerts once, critical first, and backs off before a retry", async () => {
    await record("recon-mismatch:p1");
    await db.query(
      `select public.record_operational_alert('reversal:p2', 'PAYMENT_REVERSED_AFTER_APPROVAL', 'critical')`,
    );

    const claimed = await claim();
    expect(claimed.map((alert) => alert.kind)).toEqual([
      "PAYMENT_REVERSED_AFTER_APPROVAL",
      "RECONCILIATION_MISMATCH",
    ]);
    // Not sent yet, but the backoff keeps a second run from claiming them again right away.
    expect(await claim()).toEqual([]);
  });

  it("never claims a notified alert again", async () => {
    const created = await record("recon-mismatch:p1");
    await claim();
    const finished = await db.query<{ n: number }>(
      "select public.finish_alert_notifications($1::uuid[]) as n",
      [[created.alertId]],
    );
    expect(finished.rows[0]?.n).toBe(1);

    await db.query(
      "update public.operational_alerts set next_notify_at = now() - interval '1 hour'",
    );
    expect(await claim()).toEqual([]);
    // A repeat after notification only counts; it is not sent again.
    expect((await record("recon-mismatch:p1")).created).toBe(false);
    expect(await claim()).toEqual([]);
  });

  it("backs off 5, 10, 20, 40 and 80 minutes between failed deliveries, then stops", async () => {
    await record("recon-mismatch:p1");
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const claimed = await db.query<{ n: number }>(
        "select count(*)::int as n from public.claim_alert_notifications(10, 5, $1::timestamptz)",
        ["2030-01-01T00:00:00Z"],
      );
      if (claimed.rows[0]?.n === 0) {
        break;
      }
      const next = await db.query<{ minutes: number }>(
        `select round(extract(epoch from next_notify_at - '2030-01-01T00:00:00Z'::timestamptz) / 60)::int as minutes
           from public.operational_alerts`,
      );
      delays.push(next.rows[0]?.minutes ?? -1);
      // Simulate the backoff elapsing without a successful send.
      await db.query(
        "update public.operational_alerts set next_notify_at = '2030-01-01T00:00:00Z'::timestamptz",
      );
    }
    expect(delays).toEqual([5, 10, 20, 40, 80]);
    const final = await db.query<{ attempts: number; notified: boolean }>(
      "select notify_attempts as attempts, notified_at is not null as notified from public.operational_alerts",
    );
    expect(final.rows[0]).toEqual({ attempts: 5, notified: false });
  });

  it("never hands one alert to two overlapping claims", async () => {
    await record("recon-mismatch:p1");
    await record("recon-mismatch:p2");
    const first = await claim(1);
    const second = await claim(1);
    const third = await claim(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.alertId).not.toBe(first[0]?.alertId);
    expect(third).toEqual([]);
  });

  it("stops retrying after the attempt cap", async () => {
    await record("recon-mismatch:p1");
    await db.query(
      "update public.operational_alerts set notify_attempts = 5, next_notify_at = now() - interval '1 hour'",
    );
    expect(await claim(10, 5)).toEqual([]);
  });
});
