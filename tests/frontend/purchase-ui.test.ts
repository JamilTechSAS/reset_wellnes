// @vitest-environment happy-dom
/**
 * Phase 6B purchase UI: the rendered dialog, the digital ticket and the accessibility
 * contract.
 *
 * These tests read the DOM the buyer actually gets. They assert the properties the quality
 * gate names: the backend's numbers are what is shown, no personal data leaks into the
 * confirmation, the email wording never over-claims, and the dialog behaves as a real modal
 * (focus, Escape, hidden while a submission is in flight).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../../src/api/client.ts";
import { EVENT_CONTENT_CONFIG } from "../../src/config/event-content.ts";
import { loadFrontendConfig } from "../../src/config/env.ts";
import { mountPurchaseDialog, renderPurchaseStep } from "../../src/components/PurchaseDialog.ts";
import { renderTicketCard } from "../../src/components/TicketCard.ts";
import { createPurchaseController, type PurchaseState } from "../../src/purchase/controller.ts";
import { EMPTY_PARTICIPANT_FORM } from "../../src/purchase/validation.ts";
import {
  createFakeApi,
  createMemoryStore,
  draftEntry,
  makeCreatedOrder,
  makeEvent,
  makePaidOrderStatus,
  makeQuote,
  TEST_TICKET_TOKEN,
} from "./support/ticketing-fixtures.ts";
import type { CreatedOrder } from "../../src/api/types.ts";

const TEST_CONFIG = loadFrontendConfig({});

const TICKET_EVENT = {
  eventName: "Re set Sunset — Vol. 1",
  dateLabel: "21 de noviembre de 2026",
  timeLabel: "3:00 p. m.",
  venueLabel: "Teatro Mayor · Bogotá",
};

const CONTEXT = {
  config: TEST_CONFIG,
  fallbackEvent: TICKET_EVENT,
  contactHref: `mailto:${EVENT_CONTENT_CONFIG.contact.email}`,
  contactLabel: "Escríbenos",
};

const FILLED_PARTICIPANT = {
  ...EMPTY_PARTICIPANT_FORM,
  firstName: "Ana",
  lastName: "Pérez",
  nationalId: "1023456789",
  email: "ana@example.com",
  phone: "3001234567",
  city: "Bogotá",
  instagram: "anap",
  dataProcessing: true,
};

function makeState(overrides: Partial<PurchaseState> = {}): PurchaseState {
  return {
    step: "loading",
    busy: false,
    event: null,
    availability: "AVAILABLE",
    quantity: 1,
    bundleCode: null,
    discountCode: "",
    participant: FILLED_PARTICIPANT,
    issues: [],
    quote: null,
    reference: null,
    buyerEmail: null,
    checkout: null,
    status: null,
    problem: null,
    verificationAttempts: 0,
    verificationStartedAt: null,
    hintOutcome: null,
    ...overrides,
  };
}

/** Flushes the promise chain of a fire-and-forget controller call. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("purchase step rendering", () => {
  it("labels the loading state and never invents event data", () => {
    const step = renderPurchaseStep(makeState({ step: "loading" }), CONTEXT);
    expect(step.title).toBe("Comprar entrada");
    expect(step.body).toContain("Cargando disponibilidad");
    expect(step.body).toContain(TICKET_EVENT.eventName);
  });

  it("explains a closed sale with a way to get in touch", () => {
    const step = renderPurchaseStep(
      makeState({
        step: "closed",
        problem: {
          kind: "sales_closed",
          title: "Venta no disponible",
          message: "La venta de entradas todavía no está abierta.",
          canRetry: false,
          canRetryPayment: false,
          canEditForm: false,
        },
      }),
      CONTEXT,
    );
    expect(step.body).toContain("La venta de entradas todavía no está abierta.");
    expect(step.body).toContain(CONTEXT.contactHref);
  });

  it("renders the form with labelled fields, untouched consents and a clearly estimated price", () => {
    // A fresh visit with the event loaded: nothing typed, nothing consented.
    const step = renderPurchaseStep(
      makeState({
        step: "form",
        quantity: 2,
        event: makeEvent(),
        participant: EMPTY_PARTICIPANT_FORM,
      }),
      CONTEXT,
    );

    // Every input is bound to a label.
    for (const id of [
      "pf-first-name",
      "pf-last-name",
      "pf-national-id",
      "pf-email",
      "pf-phone",
      "pf-city",
      "pf-instagram",
    ]) {
      expect(step.body).toContain(`id="${id}"`);
      expect(step.body).toContain(`for="${id}"`);
    }

    // The two consents exist and are NOT pre-checked, so consent is always a deliberate act.
    expect(step.body).toContain('id="pf-consent-data"');
    expect(step.body).toContain('id="pf-consent-future"');
    expect(step.body).not.toContain("checked");
    expect(step.body).toContain("Obligatorio");
    expect(step.body).toContain("Opcional");

    // The estimate is derived from the public price the backend published, and is labelled.
    expect(step.body).toContain("$160.000 por entrada");
    expect(step.body).toContain("Precio estimado. El valor definitivo se confirma al continuar.");
    expect(step.foot).toContain("Continuar");
    expect(step.foot).toContain("ePayco");
    expect(step.closable).toBe(true);
  });

  it("shows coupons only for a single General ticket and keeps the named bundle separate", () => {
    const event = makeEvent();
    const generalEvent = {
      ...event,
      sales: {
        ...event.sales,
        ticketTypes: event.sales.ticketTypes.map((ticket) => ({
          ...ticket,
          currentTier: { name: "General", sequence: 2, priceInCents: 20_000_000 },
        })),
      },
    };
    const single = renderPurchaseStep(
      makeState({ step: "form", quantity: 1, event: generalEvent }),
      CONTEXT,
    );
    expect(single.body).toContain('id="pf-discount"');
    const bundle = renderPurchaseStep(
      makeState({ step: "form", quantity: 2, event: generalEvent }),
      CONTEXT,
    );
    expect(bundle.body).not.toContain('id="pf-discount"');
    expect(bundle.body).toContain("Comparte esta experiencia es un producto separado.");
  });

  it("shows the fixed Comparte esta experiencia total without a quantity discount", () => {
    const event = makeEvent();
    const generalEvent = {
      ...event,
      sales: {
        ...event.sales,
        ticketTypes: event.sales.ticketTypes.map((ticket) => ({
          ...ticket,
          currentTier: { name: "General", sequence: 2, priceInCents: 20_000_000 },
        })),
      },
    };
    const quote = makeQuote({
      quantity: 2,
      ticketType: { code: "GENERAL", name: "Entrada general" },
      pricingTier: { name: "General", sequence: 2, unitPriceInCents: 17_000_000 },
      subtotalInCents: 34_000_000,
      quantityDiscount: { applies: false, percentBps: 0, amountInCents: 0 },
      quantityDiscountInCents: 0,
      totalDiscountInCents: 0,
      totalInCents: 34_000_000,
    });
    const step = renderPurchaseStep(
      makeState({
        step: "review",
        event: generalEvent,
        quantity: 2,
        bundleCode: "DOUBLE_EXPERIENCE",
        quote,
      }),
      CONTEXT,
    );

    expect(step.body).toContain("Comparte esta experiencia");
    expect(step.body).toContain("$340.000");
    expect(step.body).not.toContain("Descuento por cantidad");
  });

  it("shows a field error against the field and wires it for assistive technology", () => {
    const step = renderPurchaseStep(
      makeState({
        step: "form",
        event: null,
        issues: [{ field: "nationalId", message: "La cédula debe tener entre 6 y 12 dígitos." }],
      }),
      CONTEXT,
    );

    expect(step.body).toContain('aria-invalid="true"');
    expect(step.body).toContain('aria-describedby="pf-national-id-hint pf-national-id-error"');
    expect(step.body).toContain('id="pf-national-id-error"');
    expect(step.body).toContain("La cédula debe tener entre 6 y 12 dígitos.");
    expect(step.body).toContain('class="field has-error"');
  });

  it("shows the backend's own totals and the discount verdict on the review step", () => {
    const quote = makeQuote({
      quantity: 2,
      subtotalInCents: 19_000_000,
      quantityDiscount: { applies: true, percentBps: 500, amountInCents: 950_000 },
      quantityDiscountInCents: 950_000,
      discountCode: {
        supplied: true,
        applies: false,
        reason: "EXHAUSTED",
        code: "VERANO",
        kind: "PERCENT",
        percentBps: 1000,
        amountInCents: 0,
        remainingRedemptions: 0,
      },
      totalDiscountInCents: 950_000,
      totalInCents: 18_050_000,
    });
    const step = renderPurchaseStep(makeState({ step: "review", quantity: 2, quote }), CONTEXT);

    expect(step.body).toContain("$190.000");
    expect(step.body).toContain("$180.500");
    expect(step.body).toContain("Descuento por cantidad");
    expect(step.body).toContain("alcanzó su límite de usos");
    expect(step.body).toContain("Entrada general");
    expect(step.body).toContain("Ana Pérez");
    expect(step.foot).toContain("Pagar $180.500");
    expect(step.body).toContain("Guardamos tus cupos hasta las");
  });

  it("announces an applied discount without pretending the buyer got one that failed", () => {
    const applied = renderPurchaseStep(
      makeState({
        step: "review",
        quote: makeQuote({
          discountCode: {
            supplied: true,
            applies: true,
            reason: "OK",
            code: "VERANO",
            kind: "PERCENT",
            percentBps: 1000,
            amountInCents: 950_000,
            remainingRedemptions: 5,
          },
          discountCodeInCents: 950_000,
          totalDiscountInCents: 950_000,
          totalInCents: 8_550_000,
        }),
      }),
      CONTEXT,
    );
    expect(applied.body).toContain("Aplicamos el descuento VERANO.");
    // An applied code is never also reported as a problem.
    expect(applied.body).not.toContain("No encontramos ese código");
  });

  it("verifies the payment without ever claiming it succeeded", () => {
    const step = renderPurchaseStep(makeState({ step: "verifying" }), CONTEXT);
    expect(step.title).toBe("Verificando tu pago");
    expect(step.body).toContain("Confirmamos tu compra directamente con Wompi");
    expect(step.body).not.toContain("pago fue confirmado");
    // While a submission is being verified the buyer may still close the dialog.
    expect(step.closable).toBe(true);
  });

  it("offers a way to re-check a payment that is still in process", () => {
    const step = renderPurchaseStep(
      makeState({ step: "pending", reference: "EVT-2026-000001" }),
      CONTEXT,
    );
    expect(step.body).toContain("Tu pago sigue en proceso");
    expect(step.body).toContain("EVT-2026-000001");
    expect(step.foot).toContain('data-action="refresh"');
    expect(step.body).not.toContain("pago fue confirmado");
  });

  it("renders the confirmed step with the ticket, the QR and honest email wording", () => {
    const status = makePaidOrderStatus();
    const step = renderPurchaseStep(
      makeState({ step: "confirmed", status, reference: status.reference }),
      CONTEXT,
    );

    expect(step.title).toBe("Tu entrada está lista");
    expect(step.body).toContain("¡Tu pago fue confirmado!");
    expect(step.body).toContain(TEST_TICKET_TOKEN);
    expect(step.body).toContain("<svg");
    expect(step.body).toContain("Ana Pérez");
    expect(step.body).toContain("1 de 1");
    expect(step.body).toContain("Para el día del evento");
    // The backend has queued but not sent the email: do not claim it was sent.
    expect(step.body).toContain("Estamos enviando una copia a tu correo electrónico.");
    expect(step.body).not.toContain("Enviamos tu entrada a tu correo electrónico.");
  });

  it("says the email was sent only when the backend reports every delivery sent", () => {
    const status = makePaidOrderStatus({
      confirmation: { queued: 0, sent: 1, failed: 0, ready: true },
    });
    const step = renderPurchaseStep(makeState({ step: "confirmed", status }), CONTEXT);
    expect(step.body).toContain("Enviamos tu entrada a tu correo electrónico.");
  });

  it("keeps the buyer calm and informed when an email could not be sent", () => {
    const status = makePaidOrderStatus({
      confirmation: { queued: 0, sent: 0, failed: 1, ready: true },
    });
    const step = renderPurchaseStep(makeState({ step: "confirmed", status }), CONTEXT);
    expect(step.body).toContain("No pudimos enviar el correo todavía. Tu entrada es válida");
    expect(step.body).not.toContain("Enviamos tu entrada");
  });

  it("never exposes the buyer's personal data on the confirmation screen", () => {
    const status = makePaidOrderStatus();
    const step = renderPurchaseStep(
      makeState({ step: "confirmed", status, participant: FILLED_PARTICIPANT }),
      CONTEXT,
    );
    for (const secret of ["1023456789", "ana@example.com", "3001234567", "1023456789"]) {
      expect(step.body).not.toContain(secret);
    }
  });

  it("asks for the reference and email when the purchase cannot be found", () => {
    const step = renderPurchaseStep(
      makeState({
        step: "problem",
        problem: {
          kind: "not_found",
          title: "No pudimos ubicar tu compra en este navegador",
          message: "Usa la referencia de tu orden y el correo con el que compraste.",
          canRetry: false,
          canRetryPayment: false,
          canEditForm: false,
        },
      }),
      CONTEXT,
    );
    expect(step.body).toContain('data-recover="reference"');
    expect(step.body).toContain('data-recover="email"');
    expect(step.foot).toContain('data-action="recover"');
  });

  it("offers the right actions for each kind of failure", () => {
    const declined = renderPurchaseStep(
      makeState({
        step: "problem",
        problem: {
          kind: "declined",
          title: "El pago no fue aprobado",
          message: "Tu pago no fue aprobado y no se realizó ningún cobro.",
          canRetry: false,
          canRetryPayment: true,
          canEditForm: false,
        },
      }),
      CONTEXT,
    );
    expect(declined.foot).toContain('data-action="retry-payment"');
    expect(declined.foot).not.toContain('data-action="recover"');

    const soldOut = renderPurchaseStep(
      makeState({
        step: "problem",
        problem: {
          kind: "sold_out",
          title: "Los cupos se agotaron",
          message: "No se realizó ningún cobro.",
          canRetry: true,
          canRetryPayment: false,
          canEditForm: false,
        },
      }),
      CONTEXT,
    );
    expect(soldOut.foot).toContain('data-action="retry"');
    expect(soldOut.body).not.toContain('data-recover="reference"');

    const validation = renderPurchaseStep(
      makeState({
        step: "problem",
        problem: {
          kind: "validation",
          title: "Revisa tus datos",
          message: "Algunos datos no son válidos.",
          canRetry: false,
          canRetryPayment: false,
          canEditForm: true,
        },
      }),
      CONTEXT,
    );
    expect(validation.foot).toContain('data-action="edit"');
  });

  it("never renders a stack trace, SQL text or an internal identifier", () => {
    const step = renderPurchaseStep(
      makeState({
        step: "problem",
        problem: {
          kind: "server",
          title: "Algo salió mal",
          message: "Ocurrió un error inesperado. Intenta de nuevo en unos minutos.",
          canRetry: true,
          canRetryPayment: false,
          canEditForm: false,
        },
      }),
      CONTEXT,
    );
    const html = step.body + step.foot;
    for (const forbidden of ["SQLSTATE", "stack", "supabase", "PGRST", "service_role"]) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("digital ticket card", () => {
  const ticket = {
    token: TEST_TICKET_TOKEN,
    unit: 2,
    quantity: 3,
    status: "ACTIVE",
    assigned: true,
    participantName: "Ana Pérez",
  };

  it("renders the event, the holder, the position and the code", () => {
    const html = renderTicketCard(TICKET_EVENT, ticket);
    expect(html).toContain("Re set Sunset — Vol. 1");
    expect(html).toContain("21 de noviembre de 2026");
    expect(html).toContain("Teatro Mayor · Bogotá");
    expect(html).toContain("Ana Pérez");
    expect(html).toContain("2 de 3");
    expect(html).toContain(TEST_TICKET_TOKEN);
    expect(html).toContain("Válida");
  });

  it("encodes the ticket token in the QR without printing it inside the SVG", () => {
    const html = renderTicketCard(TICKET_EVENT, ticket);
    const svg = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
    expect(svg).toContain("viewBox=");
    expect(svg).not.toContain(TEST_TICKET_TOKEN);
    expect(svg).not.toContain("1023456789");
  });

  it("labels an unassigned seat honestly instead of inventing a holder", () => {
    const html = renderTicketCard(TICKET_EVENT, {
      ...ticket,
      assigned: false,
      participantName: null,
    });
    expect(html).toContain("Pendiente de asignar");
    expect(html).not.toContain("Titular registrado");
  });

  it("shows a cancelled ticket as cancelled", () => {
    const html = renderTicketCard(TICKET_EVENT, { ...ticket, status: "CANCELLED" });
    expect(html).toContain("Anulada");
  });

  it("abstracts the raw token away from screen readers with a labelled article", () => {
    const html = renderTicketCard(TICKET_EVENT, ticket, { labelledById: "ticket-2-label" });
    expect(html).toContain('aria-labelledby="ticket-2-label"');
    expect(html).toContain('id="ticket-2-label"');
  });
});

describe("purchase dialog", () => {
  let container: HTMLDivElement;
  let api: ReturnType<typeof createFakeApi>;
  let store: ReturnType<typeof createMemoryStore>;
  let disposers: (() => void)[];
  /** Lets a test hold an order creation open for as long as it needs. */
  let resolveLaterOrder: ((order: CreatedOrder) => void) | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    api = createFakeApi();
    store = createMemoryStore();
    disposers = [];
    resolveLaterOrder = undefined;
  });

  afterEach(() => {
    for (const dispose of disposers) {
      dispose();
    }
    container.remove();
    document.body.style.overflow = "";
  });

  function openDialog(options: { readonly onCheckout?: () => void } = {}) {
    const controller = createPurchaseController({
      config: TEST_CONFIG,
      api,
      store,
      onCheckout: () => {
        options.onCheckout?.();
      },
      polling: { intervalMs: 5_000, maxDurationMs: 20_000 },
    });
    const dialog = mountPurchaseDialog({ controller, context: CONTEXT, mountTo: container });
    disposers.push(() => {
      dialog.dispose();
      controller.dispose();
    });
    return { controller, dialog };
  }

  it("mounts a real modal dialog that is hidden until opened", () => {
    const { dialog } = openDialog();
    const overlay = container.querySelector<HTMLElement>(".purchase-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.hidden).toBe(true);

    const panel = overlay?.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(panel?.getAttribute("aria-labelledby")).toBe("purchase-title");
    expect(panel?.getAttribute("aria-describedby")).toBe("purchase-live");
    expect(overlay?.querySelector("#purchase-live")?.getAttribute("aria-live")).toBe("polite");
    expect(dialog.element).toBe(overlay);
  });

  it("locks the page, moves focus and loads the event when opened", async () => {
    const { dialog } = openDialog();
    dialog.open();
    await flush();

    const overlay = container.querySelector<HTMLElement>(".purchase-overlay");
    expect(overlay?.hidden).toBe(false);
    expect(overlay?.classList.contains("is-open")).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement?.id).toBe("purchase-title");
    expect(api.getEvent).toHaveBeenCalled();
    expect(container.querySelector("#purchase-body")?.textContent).toContain(
      "Cantidad de entradas",
    );
    expect(container.querySelector("#purchase-live")?.textContent).toContain(
      "Completa tus datos para continuar.",
    );
  });

  it("closes on Escape, on the close button and on the backdrop, restoring focus", async () => {
    const { dialog } = openDialog();
    const opener = document.createElement("button");
    container.appendChild(opener);
    opener.focus();

    dialog.open();
    await flush();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(container.querySelector<HTMLElement>(".purchase-overlay")?.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);

    dialog.open();
    await flush();
    container.querySelector<HTMLElement>('[data-action="close"]')?.click();
    expect(container.querySelector<HTMLElement>(".purchase-overlay")?.hidden).toBe(true);

    dialog.open();
    await flush();
    container
      .querySelector<HTMLElement>(".purchase-overlay")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.querySelector<HTMLElement>(".purchase-overlay")?.hidden).toBe(true);
  });

  it("drives the controller from the form controls", async () => {
    store.setItem("ticket:purchase-draft:v1", Object.values(draftEntry(1))[0] ?? "");
    const { controller, dialog } = openDialog();
    dialog.open();
    await flush();

    container.querySelector<HTMLButtonElement>('[data-action="qty-inc"]')?.click();
    expect(controller.getState().quantity).toBe(2);

    const consent = container.querySelector<HTMLInputElement>("#pf-consent-data");
    expect(consent?.checked).toBe(false);
    if (consent !== null) {
      consent.checked = true;
      consent.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(controller.getState().participant.dataProcessing).toBe(true);

    // Coupons are hidden during Preventa.
    expect(container.querySelector<HTMLInputElement>("#pf-discount")).toBeNull();
    expect(controller.getState().discountCode).toBe("");
  });

  it("keeps the caret in the field while the buyer types", async () => {
    store.setItem("ticket:purchase-draft:v1", Object.values(draftEntry(1))[0] ?? "");
    const { controller, dialog } = openDialog();
    dialog.open();
    await flush();

    // Each keystroke re-renders the step, so the field must survive the swap focused.
    const type = (value: string): void => {
      const input = document.activeElement as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    container.querySelector<HTMLInputElement>("#pf-first-name")?.focus();
    type("A");
    expect(document.activeElement?.id).toBe("pf-first-name");
    type("An");
    expect(document.activeElement?.id).toBe("pf-first-name");
    type("Ana");

    expect(controller.getState().participant.firstName).toBe("Ana");
    expect(document.activeElement?.id).toBe("pf-first-name");
    expect(container.querySelector<HTMLInputElement>("#pf-first-name")?.value).toBe("Ana");
  });

  it("keeps the caret in a consent checkbox too", async () => {
    store.setItem("ticket:purchase-draft:v1", Object.values(draftEntry(1))[0] ?? "");
    const { controller, dialog } = openDialog();
    dialog.open();
    await flush();

    const consent = container.querySelector<HTMLInputElement>("#pf-consent-data");
    consent?.focus();
    if (consent !== null) {
      consent.checked = true;
      consent.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(controller.getState().participant.dataProcessing).toBe(true);
    expect(document.activeElement?.id).toBe("pf-consent-data");
  });

  it("reaches the review step and removes the pay button the instant payment starts", async () => {
    store.setItem("ticket:purchase-draft:v1", Object.values(draftEntry(1))[0] ?? "");
    const { controller, dialog } = openDialog();
    dialog.open();
    await flush();

    const consent = container.querySelector<HTMLInputElement>("#pf-consent-data");
    if (consent !== null) {
      consent.checked = true;
      consent.dispatchEvent(new Event("change", { bubbles: true }));
    }
    container.querySelector<HTMLButtonElement>('[data-action="quote"]')?.click();
    await flush();

    expect(controller.getState().step).toBe("review");
    expect(container.querySelector("#purchase-body")?.textContent).toContain(
      "Resumen de tu compra",
    );

    const payButton = container.querySelector<HTMLButtonElement>('[data-action="submit"]');
    expect(payButton?.textContent).toContain("Pagar");
    payButton?.click();
    await flush();

    // A double click cannot reach the backend: the button is gone, and the controller itself
    // ignores a second submission.
    expect(container.querySelector('[data-action="submit"]')).toBeNull();
    expect(api.createOrder).toHaveBeenCalledTimes(1);
    expect(controller.getState().step).toBe("verifying");
  });

  it("refuses to close on Escape while the order is being created", async () => {
    store.setItem("ticket:purchase-draft:v1", Object.values(draftEntry(1))[0] ?? "");
    // The order creation is still in flight for the whole test: nothing comes back yet.
    api.createOrder.mockImplementation(
      () =>
        new Promise<CreatedOrder>((resolve) => {
          resolveLaterOrder = resolve;
        }),
    );
    const { controller, dialog } = openDialog();
    dialog.open();
    await flush();

    const consent = container.querySelector<HTMLInputElement>("#pf-consent-data");
    if (consent !== null) {
      consent.checked = true;
      consent.dispatchEvent(new Event("change", { bubbles: true }));
    }
    container.querySelector<HTMLButtonElement>('[data-action="quote"]')?.click();
    await flush();
    container.querySelector<HTMLButtonElement>('[data-action="submit"]')?.click();

    expect(controller.getState().step).toBe("submitting");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(container.querySelector<HTMLElement>(".purchase-overlay")?.hidden).toBe(false);

    // The visible close affordance is disabled too, so mouse and keyboard agree.
    expect(container.querySelector<HTMLButtonElement>(".purchase-close")?.disabled).toBe(true);
    expect(container.querySelector(".purchase-overlay")?.classList.contains("is-open")).toBe(true);

    // Once the order exists the buyer may close again.
    resolveLaterOrder?.(makeCreatedOrder());
    await flush();
    expect(container.querySelector<HTMLButtonElement>(".purchase-close")?.disabled).toBe(false);
  });

  it("shows the ticket after a paid order and leaves nothing behind on dispose", async () => {
    store.setItem(
      "ticket:pending-order:v1",
      JSON.stringify({ reference: "EVT-2026-000001", buyerEmail: "ana@example.com" }),
    );
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const { dialog } = openDialog();

    dialog.open({ resume: {} });
    await flush();
    await flush();

    expect(container.querySelector("#purchase-body")?.textContent).toContain(
      "¡Tu pago fue confirmado!",
    );
    expect(container.querySelectorAll(".ticket-card")).toHaveLength(1);
    expect(container.querySelector(".ticket-card-qr svg")).not.toBeNull();

    const overlay = container.querySelector<HTMLElement>(".purchase-overlay");
    dialog.dispose();
    expect(overlay?.isConnected).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("does not throw when it is disposed while a request is in flight", async () => {
    const { dialog } = openDialog();
    dialog.open();
    dialog.dispose();
    await flush();
    expect(container.querySelector(".purchase-overlay")).toBeNull();
  });

  it("keeps a single dialog instance even if open is called twice", async () => {
    const { dialog } = openDialog();
    dialog.open();
    dialog.open();
    await flush();
    expect(container.querySelectorAll(".purchase-overlay")).toHaveLength(1);
  });

  it("wires a payment-hint id from the return URL into the lookup flow", async () => {
    store.setItem(
      "ticket:pending-order:v1",
      JSON.stringify({ reference: "EVT-2026-000001", buyerEmail: "ana@example.com" }),
    );
    api.getOrderStatus.mockResolvedValue(makePaidOrderStatus());
    const { dialog } = openDialog();

    dialog.open({ resume: { transactionId: "1234-5678-9012" } });
    await flush();
    await flush();

    expect(api.sendPaymentHint).toHaveBeenCalledWith(
      "EVT-2026-000001",
      "ana@example.com",
      "1234-5678-9012",
    );
    expect(vi.isMockFunction(api.getOrderStatus)).toBe(true);
  });

  it("opens the buyer form directly without a blocking loader even if participant data is empty", () => {
    const { dialog } = openDialog();
    dialog.open();

    const overlay = container.querySelector<HTMLElement>(".purchase-overlay");
    expect(overlay?.hidden).toBe(false);
    expect(container.querySelector("#pf-first-name")).not.toBeNull();
    expect(container.querySelector("#pf-last-name")).not.toBeNull();
    expect(container.querySelector("#pf-national-id")).not.toBeNull();
    expect(container.querySelector("#pf-email")).not.toBeNull();
    expect(container.querySelector("#pf-phone")).not.toBeNull();
    expect(container.querySelector("#pf-city")).not.toBeNull();
    expect(container.querySelector("#pf-consent-data")).not.toBeNull();
    expect(container.querySelector(".purchase-state-title")?.textContent).not.toBe(
      "Cargando disponibilidad",
    );
  });

  it("does not show an anticipatory error banner upon opening even if background getEvent fails, but shows it when continuing fails", async () => {
    api.getEvent.mockRejectedValue(new NetworkError("Failed to fetch"));
    api.quote.mockRejectedValue(new NetworkError("Backend unavailable"));
    const { dialog } = openDialog();
    dialog.open();
    await flush();

    // The form opens clean without an anticipatory error banner
    expect(container.querySelector("#pf-first-name")).not.toBeNull();
    expect(container.querySelector("#pf-email")).not.toBeNull();
    expect(container.querySelector('[data-action="edit"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // The user can type their information
    const firstNameInput = container.querySelector<HTMLInputElement>("#pf-first-name")!;
    firstNameInput.focus();
    firstNameInput.value = "Carlos";
    firstNameInput.dispatchEvent(new Event("input", { bubbles: true }));

    const lastNameInput = container.querySelector<HTMLInputElement>("#pf-last-name")!;
    lastNameInput.value = "Gómez";
    lastNameInput.dispatchEvent(new Event("input", { bubbles: true }));

    const idInput = container.querySelector<HTMLInputElement>("#pf-national-id")!;
    idInput.value = "1023456789";
    idInput.dispatchEvent(new Event("input", { bubbles: true }));

    const emailInput = container.querySelector<HTMLInputElement>("#pf-email")!;
    emailInput.value = "carlos@example.com";
    emailInput.dispatchEvent(new Event("input", { bubbles: true }));

    const phoneInput = container.querySelector<HTMLInputElement>("#pf-phone")!;
    phoneInput.value = "3001234567";
    phoneInput.dispatchEvent(new Event("input", { bubbles: true }));

    const cityInput = container.querySelector<HTMLInputElement>("#pf-city")!;
    cityInput.value = "Bogotá";
    cityInput.dispatchEvent(new Event("input", { bubbles: true }));

    const consent = container.querySelector<HTMLInputElement>("#pf-consent-data")!;
    consent.checked = true;
    consent.dispatchEvent(new Event("change", { bubbles: true }));

    // When the user clicks Continuar, quoting is attempted
    container.querySelector<HTMLButtonElement>('[data-action="quote"]')?.click();
    await flush();

    // The backend failure is reported at this necessary moment, clearly and visibly
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain("Problema de conexión");

    // All entered data is preserved
    expect(container.querySelector<HTMLInputElement>("#pf-first-name")?.value).toBe("Carlos");
    expect(container.querySelector<HTMLInputElement>("#pf-email")?.value).toBe(
      "carlos@example.com",
    );
    expect(container.querySelector<HTMLInputElement>("#pf-city")?.value).toBe("Bogotá");
  });

  it("renders validation errors and focuses first invalid field when continuing with missing fields", async () => {
    const { controller, dialog } = openDialog();
    dialog.open();
    await flush();

    // Click Continuar without filling anything
    container.querySelector<HTMLButtonElement>('[data-action="quote"]')?.click();
    await flush();

    // Errors are displayed on invalid fields
    expect(container.querySelectorAll(".field.has-error").length).toBeGreaterThan(0);
    expect(container.querySelector("#pf-first-name-error")).not.toBeNull();
    expect(container.querySelector("#pf-consent-data-error")).not.toBeNull();
    expect(document.activeElement?.id).toBe("pf-first-name");
    expect(controller.getState().step).toBe("form");
  });

  it("advances to review step when all mandatory fields are valid and consent is accepted", async () => {
    const { controller, dialog } = openDialog();
    dialog.open({ acceptedTerms: true });
    await flush();

    controller.setField("firstName", "Ana");
    controller.setField("lastName", "Pérez");
    controller.setField("nationalId", "1023456789");
    controller.setField("email", "ana@example.com");
    controller.setField("phone", "3001234567");
    controller.setField("city", "Bogotá");

    container.querySelector<HTMLButtonElement>('[data-action="quote"]')?.click();
    await flush();

    expect(controller.getState().step).toBe("review");
    expect(container.querySelector("#purchase-body")?.textContent).toContain(
      "Resumen de tu compra",
    );
    expect(container.querySelector('[data-action="submit"]')).not.toBeNull();
  });

  it("formats celular without hint and instagram with label 'Usuario Instagram' and placeholder '@reset.wll'", async () => {
    const { dialog } = openDialog();
    dialog.open();
    await flush();

    expect(container.querySelector("#pf-phone-hint")).toBeNull();

    const instagramLabel = container.querySelector('label[for="pf-instagram"]');
    expect(instagramLabel?.textContent).toContain("Usuario Instagram");

    const instagramInput = container.querySelector<HTMLInputElement>("#pf-instagram");
    expect(instagramInput?.placeholder).toBe("@reset.wll");
  });

  it("keeps consent checkbox independent from clicking its legal hyperlinks", async () => {
    const { controller, dialog } = openDialog();
    dialog.open();
    await flush();

    const consentInput = container.querySelector<HTMLInputElement>("#pf-consent-data")!;
    expect(consentInput.checked).toBe(false);

    const legalLink = container.querySelector<HTMLAnchorElement>(
      ".consent-row a[data-legal-tab='participantes']",
    )!;
    expect(legalLink).not.toBeNull();
    expect(legalLink.getAttribute("href")).toContain("terminos-y-condiciones.html");
    expect(legalLink.getAttribute("target")).toBe("_blank");

    // Clicking the link does NOT check the box
    legalLink.click();
    expect(consentInput.checked).toBe(false);
    expect(controller.getState().participant.dataProcessing).toBe(false);

    // Clicking the checkbox directly does toggle the box
    consentInput.click();
    expect(consentInput.checked).toBe(true);
    expect(controller.getState().participant.dataProcessing).toBe(true);
  });

  it("preserves the email input element, value and focus while typing in email and text fields", async () => {
    const { controller, dialog } = openDialog();
    dialog.open();
    await flush();

    const emailInput = container.querySelector<HTMLInputElement>("#pf-email")!;
    expect(emailInput).not.toBeNull();
    emailInput.focus();

    // Keystroke 1: "carlos@"
    emailInput.value = "carlos@";
    emailInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Element node identity is preserved (DOM not replaced via innerHTML)
    expect(container.querySelector("#pf-email")).toBe(emailInput);
    expect(document.activeElement).toBe(emailInput);
    expect(controller.getState().participant.email).toBe("carlos@");

    // Keystroke 2: "carlos@example.com"
    emailInput.value = "carlos@example.com";
    emailInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(container.querySelector("#pf-email")).toBe(emailInput);
    expect(document.activeElement).toBe(emailInput);
    expect(controller.getState().participant.email).toBe("carlos@example.com");
  });

  it("preserves quantity and terms acceptance passed into open() across operations and errors", async () => {
    api.quote.mockRejectedValue(new NetworkError("Timeout"));
    const { controller, dialog } = openDialog();
    dialog.open({ quantity: 2, acceptedTerms: true });
    await flush();

    expect(controller.getState().quantity).toBe(2);
    expect(controller.getState().participant.dataProcessing).toBe(true);

    const consentInput = container.querySelector<HTMLInputElement>("#pf-consent-data")!;
    expect(consentInput.checked).toBe(true);
    expect(container.querySelector(".qty-value-number")?.textContent).toBe("2");

    // When quote fails, form remains visible with quantity and consent preserved
    container.querySelector<HTMLButtonElement>('[data-action="quote"]')?.click();
    await flush();

    expect(controller.getState().quantity).toBe(2);
    expect(controller.getState().participant.dataProcessing).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#pf-consent-data")?.checked).toBe(true);
    expect(container.querySelector(".qty-value-number")?.textContent).toBe("2");
  });
});
