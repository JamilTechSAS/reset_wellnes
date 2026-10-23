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
import { PRESALE_SCHEDULE_NOTE } from "../../src/purchase/presale-schedule.ts";

const OPEN_UTC = Date.UTC(2026, 9, 24, 15, 0, 0); // 2026-10-24 10:00 Colombia (UTC-5)

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
    <button class="comprar" id="comprar" type="button" aria-disabled="true">
      Comprar entrada · <span id="comprar-precio">$160.000</span>
    </button>
    <p class="comprar-ayuda" id="comprar-ayuda"></p>
  `;
}

function preventaCard(): HTMLElement {
  return document.querySelector<HTMLElement>('.tipo[data-tipo="preventa"]')!;
}
function preventaRadio(): HTMLInputElement {
  return preventaCard().querySelector<HTMLInputElement>("input")!;
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

  it("enables presale automatically at the scheduled time without a reload", () => {
    vi.setSystemTime(OPEN_UTC - 30_000);
    cleanup = initClientInteractions({ openPurchase });
    expect(preventaRadio().disabled).toBe(true);

    vi.advanceTimersByTime(30_050);

    expect(preventaCard().classList.contains("is-off")).toBe(false);
    expect(preventaRadio().disabled).toBe(false);
    expect(preventaCard().querySelector("[data-nota]")?.textContent).toBe("");
  });
});
