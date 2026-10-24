// @vitest-environment happy-dom
/**
 * Thank-you page (`gracias.html`) — robots/canonical metadata, markup, and the payment-integrity
 * decision. The page must never claim a confirmed payment from the URL alone: only a backend
 * order status of PAID reveals the confirmed message.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveGraciasView } from "../../src/gracias.ts";
import type { OrderStatus } from "../../src/api/types.ts";
import type { PendingOrder } from "../../src/purchase/persistence.ts";

const ROOT = path.resolve(__dirname, "../..");
const HTML = readFileSync(path.join(ROOT, "gracias.html"), "utf8");

const PENDING: PendingOrder = {
  reference: "EVT-2026-000123",
  buyerEmail: "ana@example.com",
  attempt: 1,
  createdAt: "2026-10-24T15:00:00.000Z",
};

function makeStatus(status: string): OrderStatus {
  return {
    reference: PENDING.reference,
    status,
    quantity: 1,
    totalInCents: 16_000_000,
    currency: "COP",
    createdAt: "2026-10-24T15:00:00.000Z",
    paidAt: status === "PAID" ? "2026-10-24T15:05:00.000Z" : null,
    reservationExpiresAt: null,
    payment: null,
    paymentAttempts: [],
    admissions: { quantity: 1, assigned: 0, remainingUnassigned: 1 },
    participants: [],
  };
}

describe("gracias.html metadata and markup", () => {
  it("is excluded from search engines with noindex, nofollow", () => {
    expect(HTML).toMatch(/<meta\s+name="robots"\s+content="noindex,\s*nofollow"\s*\/>/);
  });

  it("declares the canonical thank-you URL", () => {
    expect(HTML).toContain(
      '<link rel="canonical" href="https://www.resetwellness.com.co/gracias.html" />',
    );
  });

  it("loads its own entry module, not the main purchase app", () => {
    expect(HTML).toContain('src="/src/gracias.ts"');
    expect(HTML).not.toContain('src="/src/main.ts"');
  });

  it("reuses the existing entradas asset", () => {
    expect(HTML).toContain("/assets/img/entradas.webp");
    expect(HTML).toContain("/assets/img/entradas.jpg");
  });

  it("shows the verifying state by default and keeps the confirmed state hidden", () => {
    document.documentElement.innerHTML = HTML;
    const pendingEl = document.querySelector<HTMLElement>("[data-gracias-pending]");
    const confirmedEl = document.querySelector<HTMLElement>("[data-gracias-confirmed]");
    expect(pendingEl?.hidden).toBe(false);
    expect(confirmedEl?.hidden).toBe(true);
  });

  it("is not linked from any other page's navigation or footer", () => {
    const pages = [
      "index.html",
      "nosotros.html",
      "entradas.html",
      "eventos.html",
      "marca-y-colaboracion.html",
      "preguntas-frecuentes.html",
      "terminos-y-condiciones.html",
    ];
    for (const page of pages) {
      const html = readFileSync(path.join(ROOT, page), "utf8");
      expect(html, `${page} should not link gracias`).not.toMatch(/href="[^"]*gracias\.html/);
    }
  });

  it("does not link to itself from its own nav or footer", () => {
    document.documentElement.innerHTML = HTML;
    const links = Array.from(document.querySelectorAll("header a, footer a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links.some((href) => href?.includes("gracias"))).toBe(false);
  });
});

describe("resolveGraciasView payment integrity", () => {
  it("confirms only when the backend reports PAID", async () => {
    const api = {
      getOrderStatus: vi.fn().mockResolvedValue(makeStatus("PAID")),
      sendPaymentHint: vi.fn().mockResolvedValue({ outcome: "APPROVED_APPLIED" }),
    };
    const view = await resolveGraciasView({
      pending: PENDING,
      transactionId: "ref_payco_123",
      api,
    });
    expect(view).toBe("confirmed");
    expect(api.getOrderStatus).toHaveBeenCalledWith(PENDING.reference, PENDING.buyerEmail);
  });

  it("stays pending when the order is not PAID", async () => {
    const api = {
      getOrderStatus: vi.fn().mockResolvedValue(makeStatus("PENDING")),
      sendPaymentHint: vi.fn().mockResolvedValue({ outcome: "STILL_PENDING" }),
    };
    const view = await resolveGraciasView({
      pending: PENDING,
      transactionId: undefined,
      api,
    });
    expect(view).toBe("pending");
  });

  it("never confirms without a correlated order (URL alone is not proof)", async () => {
    const api = {
      getOrderStatus: vi.fn(),
      sendPaymentHint: vi.fn(),
    };
    const view = await resolveGraciasView({
      pending: undefined,
      transactionId: "ref_payco_fromurl",
      api,
    });
    expect(view).toBe("pending");
    expect(api.getOrderStatus).not.toHaveBeenCalled();
  });

  it("stays pending when the status lookup fails", async () => {
    const api = {
      getOrderStatus: vi.fn().mockRejectedValue(new Error("network")),
      sendPaymentHint: vi.fn().mockResolvedValue({ outcome: "ERROR" }),
    };
    const view = await resolveGraciasView({
      pending: PENDING,
      transactionId: "ref_payco_123",
      api,
    });
    expect(view).toBe("pending");
  });

  it("still confirms a PAID order even if the hint nudge throws", async () => {
    const api = {
      getOrderStatus: vi.fn().mockResolvedValue(makeStatus("PAID")),
      sendPaymentHint: vi.fn().mockRejectedValue(new Error("hint failed")),
    };
    const view = await resolveGraciasView({
      pending: PENDING,
      transactionId: "ref_payco_123",
      api,
    });
    expect(view).toBe("confirmed");
  });
});
