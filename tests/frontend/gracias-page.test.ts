// @vitest-environment happy-dom
/**
 * Thank-you page (`gracias.html`) — robots/canonical metadata, markup, and the payment-integrity
 * decision. The page must never claim a confirmed payment from the URL alone: only a backend
 * order status of PAID reveals the confirmed message.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyView, lookupOrder, resolveGraciasView } from "../../src/gracias.ts";
import { ApiError } from "../../src/api/client.ts";
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
      '<link rel="canonical" href="https://www.resetwellness.com.co/gracias" />',
    );
  });

  it("loads its own entry module, not the main purchase app", () => {
    expect(HTML).toContain('src="/src/gracias.ts"');
    expect(HTML).not.toContain('src="/src/main.ts"');
  });

  it("offers a recovery form that carries the reference and asks for the email", () => {
    document.documentElement.innerHTML = HTML;
    expect(document.querySelector("[data-gracias-reference]")).not.toBeNull();
    expect(document.querySelector("[data-gracias-email]")).not.toBeNull();
    expect(document.querySelector("[data-gracias-submit]")).not.toBeNull();
    expect(document.querySelector("[data-gracias-message]")).not.toBeNull();
    // The email is never part of the URL, so the copy must not promise it is prefilled.
    expect(HTML).toContain("correo con el que compraste");
  });

  it("no longer promises a QR code the backend does not issue", () => {
    expect(HTML).not.toMatch(/c[oó]digo QR/i);
    expect(HTML).toContain("documento de identidad");
  });

  it("reuses the existing entradas asset", () => {
    expect(HTML).toContain("/assets/img/entradas.webp");
    expect(HTML).toContain("/assets/img/entradas.jpg");
  });

  it("shows the verifying state by default and keeps every outcome hidden", () => {
    document.documentElement.innerHTML = HTML;
    const verifying = document.querySelector<HTMLElement>("[data-gracias-verifying]");
    const confirmedEl = document.querySelector<HTMLElement>("[data-gracias-confirmed]");
    const pendingEl = document.querySelector<HTMLElement>("[data-gracias-pending]");
    const recoverEl = document.querySelector<HTMLElement>("[data-gracias-recover]");
    expect(verifying?.hidden).toBe(false);
    expect(confirmedEl?.hidden).toBe(true);
    expect(pendingEl?.hidden).toBe(true);
    expect(recoverEl?.hidden).toBe(true);
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
    // Nothing to look up on its own: the page asks for the details instead of waiting forever.
    expect(view).toBe("recover");
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

describe("return reference without the buyer's tab", () => {
  it("resolves the reference from the return URL even with no stored session", async () => {
    const api = { getOrderStatus: vi.fn(), sendPaymentHint: vi.fn() };
    const view = await resolveGraciasView({
      pending: undefined,
      reference: "EVT-2026-000123",
      transactionId: "ref_payco_123",
      api,
    });
    // A reference alone is not proof and cannot carry the email: the page asks for it.
    expect(view).toBe("recover");
    expect(api.getOrderStatus).not.toHaveBeenCalled();
    expect(api.sendPaymentHint).not.toHaveBeenCalled();
  });

  it("uses the stored email when the URL names the same order", async () => {
    const api = {
      getOrderStatus: vi.fn().mockResolvedValue(makeStatus("PAID")),
      sendPaymentHint: vi.fn().mockResolvedValue({ outcome: "APPROVED_APPLIED" }),
    };
    const view = await resolveGraciasView({
      pending: PENDING,
      reference: "EVT-2026-000123",
      transactionId: "ref_payco_123",
      api,
    });
    expect(view).toBe("confirmed");
    expect(api.getOrderStatus).toHaveBeenCalledWith(PENDING.reference, PENDING.buyerEmail);
  });

  it("does not reuse the stored email for a different order named by the URL", async () => {
    const api = { getOrderStatus: vi.fn(), sendPaymentHint: vi.fn() };
    const view = await resolveGraciasView({
      pending: PENDING,
      reference: "EVT-2026-000999",
      transactionId: undefined,
      api,
    });
    expect(view).toBe("recover");
    expect(api.getOrderStatus).not.toHaveBeenCalled();
  });

  it("confirms a retry invoice by asking about its order", async () => {
    const api = {
      getOrderStatus: vi.fn().mockResolvedValue(makeStatus("PAID")),
      sendPaymentHint: vi.fn(),
    };
    const view = await resolveGraciasView({
      pending: PENDING,
      reference: "EVT-2026-000123-2",
      transactionId: undefined,
      api,
    });
    expect(view).toBe("confirmed");
    expect(api.getOrderStatus).toHaveBeenCalledWith("EVT-2026-000123", PENDING.buyerEmail);
  });
});

describe("lookupOrder recovery outcomes", () => {
  it("confirms only a PAID order", async () => {
    const api = {
      getOrderStatus: vi.fn().mockResolvedValue(makeStatus("PAID")),
      sendPaymentHint: vi.fn(),
    };
    await expect(
      lookupOrder({ reference: "EVT-2026-000123", buyerEmail: "Ana@Example.com ", api }),
    ).resolves.toBe("confirmed");
    // The email is normalized before it travels; the backend lowercases it as well.
    expect(api.getOrderStatus).toHaveBeenCalledWith("EVT-2026-000123", "ana@example.com");
  });

  it("reports a non-PAID order as pending instead of success", async () => {
    const api = {
      getOrderStatus: vi.fn().mockResolvedValue(makeStatus("PENDING")),
      sendPaymentHint: vi.fn(),
    };
    await expect(
      lookupOrder({ reference: "EVT-2026-000123", buyerEmail: "ana@example.com", api }),
    ).resolves.toBe("pending");
  });

  it("treats a refused lookup as not found, exactly like the backend does", async () => {
    const api = {
      getOrderStatus: vi
        .fn()
        .mockRejectedValue(
          new ApiError({ code: "NOT_FOUND", status: 404, message: "Order reference is unknown" }),
        ),
      sendPaymentHint: vi.fn(),
    };
    await expect(
      lookupOrder({ reference: "EVT-2026-000123", buyerEmail: "wrong@example.com", api }),
    ).resolves.toBe("not_found");
  });

  it("distinguishes a failed lookup from a refused one", async () => {
    const api = {
      getOrderStatus: vi.fn().mockRejectedValue(new Error("network")),
      sendPaymentHint: vi.fn(),
    };
    await expect(
      lookupOrder({ reference: "EVT-2026-000123", buyerEmail: "ana@example.com", api }),
    ).resolves.toBe("error");
  });

  it("asks for the missing email instead of querying without it", async () => {
    const api = { getOrderStatus: vi.fn(), sendPaymentHint: vi.fn() };
    await expect(
      lookupOrder({ reference: "EVT-2026-000123", buyerEmail: "   ", api }),
    ).resolves.toBe("not_found");
    expect(api.getOrderStatus).not.toHaveBeenCalled();
  });

  it("rejects a reference that is not one of ours", async () => {
    const api = { getOrderStatus: vi.fn(), sendPaymentHint: vi.fn() };
    await expect(
      lookupOrder({ reference: "HOLA", buyerEmail: "ana@example.com", api }),
    ).resolves.toBe("not_found");
    expect(api.getOrderStatus).not.toHaveBeenCalled();
  });
});

describe("applyView", () => {
  it("shows exactly one outcome block at a time", () => {
    document.documentElement.innerHTML = HTML;
    const ids = ["verifying", "confirmed", "pending", "recover"] as const;
    for (const view of ids) {
      applyView(view);
      const hidden = ids.filter((id) => {
        const el = document.querySelector<HTMLElement>(`[data-gracias-${id}]`);
        return el === null || el.hidden;
      });
      expect(hidden).toHaveLength(ids.length - 1);
    }
  });
});
