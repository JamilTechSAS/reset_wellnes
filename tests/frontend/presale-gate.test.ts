// @vitest-environment happy-dom
/**
 * Presale time-gate behavior on the entradas ticket section.
 *
 * Before the scheduled opening the presale option is disabled, labelled with its start time, and
 * cannot start checkout. At the scheduled instant it enables itself without a page reload. The
 * gate is frontend-only; backend availability is not exercised here (no salesConfig is passed).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { initClientInteractions } from "../../src/utils/client-interactions.ts";
import {
  GENERAL_OPEN_LABEL,
  GENERAL_WINDOW_LABEL,
  PRESALE_CLOSED_NOTE,
  PRESALE_SCHEDULE_NOTE,
  PRESALE_WINDOW_LABEL,
} from "../../src/purchase/presale-schedule.ts";

const OPEN_UTC = Date.UTC(2026, 9, 25, 15, 0, 0); // 2026-10-25 10:00 Colombia (UTC-5)
const CLOSE_UTC = Date.UTC(2026, 9, 29, 5, 0, 0); // 2026-10-29 00:00 Colombia — Preventa closed
const GENERAL_UTC = Date.UTC(2026, 9, 29, 5, 1, 0); // 2026-10-29 00:01 Colombia — General open

/** What the backend publishes while General is the open stage. */
function generalCatalog(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        found: true,
        sales: {
          currency: "COP",
          salesOpen: true,
          serverTime: new Date().toISOString(),
          ticketTypes: [
            {
              code: "GENERAL",
              name: "Entrada general",
              salesOpen: true,
              availability: "AVAILABLE",
              currentTier: { name: "General", sequence: 2, priceInCents: 19_990_000 },
              salesWindow: { startsAt: "2026-10-29T05:01:00Z", endsAt: "2026-11-14T05:00:00Z" },
            },
          ],
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** What the backend publishes while Preventa is the open stage, with the window it enforces. */
function preventaCatalog(startsAt: string): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        found: true,
        sales: {
          currency: "COP",
          salesOpen: true,
          serverTime: new Date().toISOString(),
          ticketTypes: [
            {
              code: "GENERAL",
              name: "Entrada general",
              salesOpen: true,
              availability: "AVAILABLE",
              currentTier: { name: "Preventa", sequence: 1, priceInCents: 15_990_000 },
              salesWindow: { startsAt, endsAt: "2026-10-29T05:00:00Z" },
            },
          ],
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mountTicketSection(): void {
  document.body.innerHTML = `
    <fieldset class="tipos">
      <label class="tipo" data-tipo="preventa">
        <input type="radio" name="tipo" value="preventa" checked />
        <span class="tipo-nombre">Preventa</span>
        <span class="tipo-precio">$160.000</span>
        <span class="tipo-nota" data-nota></span>
      </label>
      <label class="tipo" data-tipo="duo">
        <input type="radio" name="tipo" value="duo" />
        <span class="tipo-nota" data-nota></span>
      </label>
      <label class="tipo" data-tipo="general">
        <input type="radio" name="tipo" value="general" />
        <span class="tipo-nota" data-nota></span>
      </label>
    </fieldset>
    <input type="checkbox" id="acepto-terminos" />
    <button class="comprar" id="comprar" type="button" aria-disabled="true">Paga aquí</button>
    <p class="comprar-ayuda" id="comprar-ayuda"></p>
  `;
}

function preventaCard(): HTMLElement {
  return document.querySelector<HTMLElement>('.tipo[data-tipo="preventa"]')!;
}
function preventaRadio(): HTMLInputElement {
  return preventaCard().querySelector<HTMLInputElement>("input")!;
}
function tierCard(tier: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.tipo[data-tipo="${tier}"]`)!;
}
function tierRadio(tier: string): HTMLInputElement {
  return tierCard(tier).querySelector<HTMLInputElement>("input")!;
}
function clickBuy(): void {
  (document.getElementById("acepto-terminos") as HTMLInputElement).checked = true;
  document.getElementById("comprar")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("presale time gate", () => {
  let openPurchase: Mock;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    openPurchase = vi.fn();
    mountTicketSection();
  });

  afterEach(() => {
    cleanup?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("disables presale and shows its start time before opening", () => {
    vi.setSystemTime(OPEN_UTC - 60_000);
    cleanup = initClientInteractions({ openPurchase });

    expect(preventaCard().classList.contains("is-off")).toBe(true);
    expect(preventaRadio().disabled).toBe(true);
    expect(preventaCard().querySelector("[data-nota]")?.textContent).toBe(PRESALE_SCHEDULE_NOTE);
  });

  it("blocks checkout with presale pricing before opening", () => {
    vi.setSystemTime(OPEN_UTC - 60_000);
    cleanup = initClientInteractions({ openPurchase });

    (document.getElementById("acepto-terminos") as HTMLInputElement).checked = true;
    document.getElementById("comprar")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(openPurchase).not.toHaveBeenCalled();
    expect(document.getElementById("comprar-ayuda")?.textContent).toBe(PRESALE_SCHEDULE_NOTE);
  });

  it("allows presale checkout once the opening instant has passed", () => {
    vi.setSystemTime(OPEN_UTC);
    cleanup = initClientInteractions({ openPurchase });

    expect(preventaCard().classList.contains("is-off")).toBe(false);
    expect(preventaRadio().disabled).toBe(false);

    (document.getElementById("acepto-terminos") as HTMLInputElement).checked = true;
    document.getElementById("comprar")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(openPurchase).toHaveBeenCalledTimes(1);
    expect(openPurchase).toHaveBeenCalledWith(
      "ticket-section",
      expect.objectContaining({ tier: "preventa", quantity: 1, acceptedTerms: true }),
    );
  });

  it("sells an already-open Preventa before the published hour, on the backend's window", async () => {
    // 08:30 Bogotá: the published schedule still says 10:00 a. m., but the database opened the
    // stage at 06:01. The catalog is the authority, so the card sells now.
    vi.setSystemTime(OPEN_UTC - 90 * 60_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => preventaCatalog("2026-10-25T11:01:48Z")),
    );
    cleanup = initClientInteractions({
      openPurchase,
      salesConfig: { apiBaseUrl: "http://api.test", eventCode: "RESET", ticketTypeCode: "GENERAL" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(preventaCard().classList.contains("is-off")).toBe(false);
    expect(preventaRadio().disabled).toBe(false);
    // The card that just became buyable is selected for the buyer, so the button works as-is.
    expect(preventaRadio().checked).toBe(true);

    clickBuy();
    expect(openPurchase).toHaveBeenCalledWith(
      "ticket-section",
      expect.objectContaining({ tier: "preventa", quantity: 1, acceptedTerms: true }),
    );
  });

  it("keeps Preventa locked when the backend window has not started yet", async () => {
    vi.setSystemTime(OPEN_UTC - 90 * 60_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => preventaCatalog("2026-10-25T15:00:00Z")),
    );
    cleanup = initClientInteractions({
      openPurchase,
      salesConfig: { apiBaseUrl: "http://api.test", eventCode: "RESET", ticketTypeCode: "GENERAL" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(preventaRadio().disabled).toBe(true);
    clickBuy();
    expect(openPurchase).not.toHaveBeenCalled();
  });

  it("enables presale automatically at the scheduled time without a reload", () => {
    vi.setSystemTime(OPEN_UTC - 30_000);
    cleanup = initClientInteractions({ openPurchase });
    expect(preventaRadio().disabled).toBe(true);

    vi.advanceTimersByTime(30_050);

    expect(preventaCard().classList.contains("is-off")).toBe(false);
    expect(preventaRadio().disabled).toBe(false);
    // The window stays visible once open, so the closing date is never hidden.
    expect(preventaCard().querySelector("[data-nota]")?.textContent).toBe(PRESALE_WINDOW_LABEL);
  });

  it("closes Preventa at 00:00 on 29 October, even on a page left open", () => {
    vi.setSystemTime(CLOSE_UTC - 30_000); // 23:59:30 — still inside the last valid minute
    cleanup = initClientInteractions({ openPurchase });
    expect(preventaRadio().checked).toBe(true);
    expect(preventaRadio().disabled).toBe(false);

    vi.advanceTimersByTime(30_100);

    // The selection is dropped, the card says the stage is over and the buy action is dead.
    expect(preventaRadio().disabled).toBe(true);
    expect(preventaRadio().checked).toBe(false);
    expect(preventaCard().querySelector("[data-nota]")?.textContent).toBe(PRESALE_CLOSED_NOTE);
    clickBuy();
    expect(openPurchase).not.toHaveBeenCalled();
  });

  it("keeps the gap closed even if the catalog still says General", async () => {
    // A cached/stale catalog answer must not sell during the one minute with no sales.
    vi.setSystemTime(CLOSE_UTC + 20_000); // 00:00:20
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => generalCatalog()),
    );
    cleanup = initClientInteractions({
      openPurchase,
      salesConfig: { apiBaseUrl: "http://api.test", eventCode: "RESET", ticketTypeCode: "GENERAL" },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(tierRadio("general").disabled).toBe(true);
    expect(tierRadio("duo").disabled).toBe(true);
    clickBuy();
    expect(openPurchase).not.toHaveBeenCalled();
  });

  it("unlocks General and the package at 00:01 without a reload", async () => {
    vi.setSystemTime(GENERAL_UTC - 30_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => generalCatalog()),
    );
    cleanup = initClientInteractions({
      openPurchase,
      salesConfig: { apiBaseUrl: "http://api.test", eventCode: "RESET", ticketTypeCode: "GENERAL" },
    });
    await vi.advanceTimersByTimeAsync(0);
    // Before the opening instant the stale General answer is not enough, and the card still
    // announces the stage as upcoming.
    expect(tierRadio("general").disabled).toBe(true);
    expect(tierRadio("duo").disabled).toBe(true);
    expect(tierCard("general").querySelector("[data-nota]")?.textContent).toBe(
      GENERAL_WINDOW_LABEL,
    );

    await vi.advanceTimersByTimeAsync(30_100);

    expect(tierRadio("general").disabled).toBe(false);
    expect(tierCard("duo").classList.contains("is-off")).toBe(false);
    expect(tierRadio("duo").disabled).toBe(false);
    // Once General is on sale the card must not keep promising it will start later.
    expect(tierCard("general").querySelector("[data-nota]")?.textContent).toBe(GENERAL_OPEN_LABEL);

    tierRadio("general").checked = true;
    clickBuy();
    expect(openPurchase).toHaveBeenCalledWith(
      "ticket-section",
      expect.objectContaining({ tier: "general", quantity: 1, acceptedTerms: true }),
    );
  });
});
