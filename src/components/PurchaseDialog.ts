/**
 * Purchase dialog (Phase 6B).
 *
 * The single UI surface of the buyer journey: quantity, participant data, server quote,
 * order creation, Wompi handoff, payment return, confirmation and the digital ticket.
 *
 * It is a pure render of the controller state — every number shown comes from a backend
 * response, every state comes from the state machine. The one exception is the price
 * *preview* on the form step, which is labelled as a preview and is replaced by the
 * authoritative quote on the next step.
 *
 * Accessibility: a real modal dialog (`role="dialog"`, `aria-modal`), a focus trap, Escape to
 * close, labels bound to inputs, field errors wired through `aria-describedby`, and a polite
 * live region announcing step changes. It is a bottom sheet on mobile and a centred card on
 * desktop, and the primary action never scrolls out of reach.
 */

import type { AvailabilityLabel, OrderStatus, PublicEvent, Quote } from "../api/types.ts";
import type { FrontendConfig } from "../config/env.ts";
import type { LegalTabId } from "../types/content.ts";
import type { PurchaseController, PurchaseProblem, PurchaseState } from "../purchase/controller.ts";
import {
  formatEventDate,
  formatEventTime,
  formatCopCents,
  availabilityLabel,
  describeEmailStatus,
} from "../purchase/format.ts";
import { issuesForField, type ParticipantField } from "../purchase/validation.ts";
import { selectTicketType } from "../purchase/ticket-selection.ts";
import { renderTicketCard, type TicketCardEvent } from "./TicketCard.ts";
import { escapeHtml, renderIcon } from "../utils/dom.ts";
import { dispatchOpenLegal } from "../utils/events.ts";

export type PurchaseDialogContext = {
  readonly config: FrontendConfig;
  /** Landing-page copy, so the dialog looks right even before the API answers. */
  readonly fallbackEvent: TicketCardEvent;
  readonly contactHref: string;
  readonly contactLabel: string;
};

export type OpenPurchaseOptions = {
  /**
   * Resume a checkout return instead of starting a fresh purchase. `transactionId` is the
   * `?id=` Wompi appended (a hint only). With no stored order this shows the recovery form,
   * which is also what the "consultar mi compra" entry point uses.
   */
  readonly resume?: { readonly transactionId?: string | undefined } | undefined;
  readonly quantity?: number | undefined;
  readonly acceptedTerms?: boolean | undefined;
  readonly tier?: string | undefined;
  readonly source?: string | undefined;
};

export type PurchaseDialog = {
  open(options?: OpenPurchaseOptions): void;
  close(): void;
  dispose(): void;
  readonly element: HTMLElement;
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function toTicketEvent(state: PurchaseState, fallback: TicketCardEvent): TicketCardEvent {
  const event = state.event;
  if (event === null) {
    return fallback;
  }
  return {
    eventName: event.event.name,
    dateLabel: formatEventDate(event.event.startsAt, event.event.timezone),
    timeLabel: formatEventTime(event.event.startsAt, event.event.timezone),
    venueLabel: [event.event.venue.name, event.event.venue.city].filter(Boolean).join(" · "),
  };
}

/** The price the backend currently advertises for the ticket type this page sells. */
function previewUnitPrice(event: PublicEvent | null, ticketTypeCode: string): number | null {
  const tier = selectTicketType(event, ticketTypeCode)?.currentTier;
  return tier === null || tier === undefined ? null : tier.priceInCents;
}

function availabilityTone(availability: AvailabilityLabel): string {
  if (availability === "AVAILABLE") return "positive";
  if (availability === "LOW") return "warning";
  return "negative";
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function field(args: {
  readonly id: string;
  readonly field: ParticipantField;
  readonly label: string;
  readonly value: string;
  readonly type?: string;
  readonly inputmode?: string;
  readonly autocomplete?: string;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly issues: readonly { readonly field: ParticipantField; readonly message: string }[];
  readonly required?: boolean;
  readonly maxlength?: number;
}): string {
  const messages = issuesForField(args.issues, args.field);
  const describedBy = [
    args.hint === undefined ? undefined : `${args.id}-hint`,
    messages.length === 0 ? undefined : `${args.id}-error`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  return `
    <div class="field${messages.length > 0 ? " has-error" : ""}">
      <label class="field-label" for="${args.id}">
        ${escapeHtml(args.label)}${args.required === true ? ' <span aria-hidden="true">*</span>' : ""}
      </label>
      <input
        class="field-input"
        id="${args.id}"
        name="${args.field}"
        data-field="${args.field}"
        type="${args.type ?? "text"}"
        ${args.inputmode === undefined ? "" : `inputmode="${args.inputmode}"`}
        ${args.autocomplete === undefined ? "" : `autocomplete="${args.autocomplete}"`}
        ${args.placeholder === undefined ? "" : `placeholder="${escapeHtml(args.placeholder)}"`}
        ${args.maxlength === undefined ? "" : `maxlength="${args.maxlength}"`}
        value="${escapeHtml(args.value)}"
        ${messages.length > 0 ? 'aria-invalid="true"' : ""}
        ${describedBy.length === 0 ? "" : `aria-describedby="${describedBy}"`}
      />
      ${
        args.hint === undefined
          ? ""
          : `<p class="field-hint" id="${args.id}-hint">${escapeHtml(args.hint)}</p>`
      }
      ${
        messages.length === 0
          ? ""
          : `<p class="field-error" id="${args.id}-error">${renderIcon("alert")}<span>${escapeHtml(messages.join(" "))}</span></p>`
      }
    </div>
  `;
}

function summaryRow(
  label: string,
  amountInCents: number,
  options: { readonly strong?: boolean; readonly muted?: boolean } = {},
): string {
  return `
    <div class="summary-row${options.strong === true ? " is-total" : ""}${options.muted === true ? " is-muted" : ""}">
      <span>${escapeHtml(label)}</span>
      <span>${escapeHtml(formatCopCents(amountInCents))}</span>
    </div>
  `;
}

function quoteSummary(quote: Quote): string {
  // The product name comes from the backend quote, never from a hardcoded label: the event
  // sells three products and only the server knows which one priced this order.
  const rows = [
    summaryRow(`${quote.ticketType.name} × ${quote.quantity}`, quote.subtotalInCents),
    quote.quantityDiscountInCents > 0
      ? summaryRow("Descuento por cantidad", -quote.quantityDiscountInCents, { muted: true })
      : "",
    quote.discountCodeInCents > 0
      ? summaryRow(`Código ${quote.discountCode.code ?? ""}`.trim(), -quote.discountCodeInCents, {
          muted: true,
        })
      : "",
    summaryRow("Total", quote.totalInCents, { strong: true }),
  ];
  return `<div class="summary">${rows.join("")}</div>`;
}

function discountNotice(quote: Quote): string {
  const { discountCode } = quote;
  if (!discountCode.supplied) {
    return "";
  }
  if (discountCode.applies) {
    return `<p class="inline-note tone-positive">${renderIcon("check")}<span>Aplicamos el descuento ${escapeHtml(
      discountCode.code ?? "",
    )}.</span></p>`;
  }
  const reasonCopy: Record<string, string> = {
    NOT_FOUND: "No encontramos ese código. Puedes continuar sin él.",
    INACTIVE: "Ese código ya no está activo. Puedes continuar sin él.",
    NOT_STARTED: "Ese código aún no está vigente. Puedes continuar sin él.",
    EXPIRED: "Ese código venció. Puedes continuar sin él.",
    EXHAUSTED: "Ese código alcanzó su límite de usos. Puedes continuar sin él.",
    WRONG_TICKET_TYPE: "Ese código no aplica a esta entrada. Puedes continuar sin él.",
    MIN_QUANTITY: "Ese código requiere una cantidad mayor de entradas.",
    NOT_SUPPLIED: "",
  };
  const message = reasonCopy[discountCode.reason] ?? "Ese código no se pudo aplicar.";
  return message.length === 0
    ? ""
    : `<p class="inline-note tone-warning">${renderIcon("alert")}<span>${escapeHtml(message)}</span></p>`;
}

function verificationNote(state: PurchaseState): string {
  if (state.hintOutcome === "APPROVED_APPLIED" || state.hintOutcome === "APPROVED_DUPLICATE") {
    return `<p class="inline-note tone-positive">${renderIcon("check")}<span>Encontramos tu pago aprobado.</span></p>`;
  }
  if (state.hintOutcome === "MISMATCH") {
    return `<p class="inline-note tone-warning">${renderIcon("alert")}<span>Estamos validando tu pago con la pasarela.</span></p>`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function renderLoading(fallback: TicketCardEvent): string {
  return `
    <div class="purchase-state" role="status">
      <span class="purchase-state-icon">${renderIcon("loader")}</span>
      <h3 class="purchase-state-title">Cargando disponibilidad</h3>
      <p class="purchase-state-text">Consultando las entradas de ${escapeHtml(fallback.eventName)}…</p>
    </div>
  `;
}

function renderClosed(problem: PurchaseProblem | null, ctx: PurchaseDialogContext): string {
  const title = problem?.title ?? "Venta no disponible";
  const message = problem?.message ?? "La venta de entradas todavía no está abierta.";
  return `
    <div class="purchase-state" role="status">
      <span class="purchase-state-icon tone-warning">${renderIcon("hourglass")}</span>
      <h3 class="purchase-state-title">${escapeHtml(title)}</h3>
      <p class="purchase-state-text">${escapeHtml(message)}</p>
      <a class="btn btn-secondary btn-block" href="${escapeHtml(ctx.contactHref)}">
        ${escapeHtml(ctx.contactLabel)}
      </a>
    </div>
  `;
}

function renderForm(state: PurchaseState, ctx: PurchaseDialogContext, showProblem = true): string {
  const event = state.event;
  const ticketType = selectTicketType(event, ctx.config.ticketTypeCode);
  const unit = previewUnitPrice(event, ctx.config.ticketTypeCode);
  const previewTotal = unit === null ? null : unit * state.quantity;
  const max = Math.max(1, Math.min(ticketType?.maxPerOrder ?? 4, 10));
  const p = state.participant;

  return `
    ${
      !showProblem || state.problem === null
        ? ""
        : `<div class="inline-note tone-warning" role="alert" style="margin-bottom: 1rem;">
             ${renderIcon("alert")}
             <span><strong>${escapeHtml(state.problem.title)}:</strong> ${escapeHtml(state.problem.message)}</span>
           </div>`
    }
    ${
      event === null
        ? ""
        : `<div class="purchase-availability tone-${availabilityTone(state.availability)}">
             <span class="dot" aria-hidden="true"></span>
             <span>${escapeHtml(availabilityLabel(state.availability))}</span>
           </div>`
    }

    <section class="purchase-section" aria-labelledby="purchase-qty-title">
      <h3 class="purchase-section-title" id="purchase-qty-title">Cantidad de entradas</h3>
      <div class="qty-stepper" role="group" aria-labelledby="purchase-qty-title">
        <button type="button" class="qty-btn" data-action="qty-dec" ${
          state.quantity <= 1 ? "disabled" : ""
        } aria-label="Quitar una entrada">${renderIcon("minus")}</button>
        <span class="qty-value" aria-live="off">
          <span class="qty-value-number">${state.quantity}</span>
          <span class="qty-value-label">${state.quantity === 1 ? "entrada" : "entradas"}</span>
        </span>
        <button type="button" class="qty-btn" data-action="qty-inc" ${
          state.quantity >= max ? "disabled" : ""
        } aria-label="Agregar una entrada">${renderIcon("plus")}</button>
      </div>
      ${
        unit === null
          ? ""
          : `<p class="qty-unit">${ticketType === undefined ? "" : `${escapeHtml(ticketType.name)} · `}${escapeHtml(formatCopCents(unit))} por entrada${
              ticketType?.currentTier === null || ticketType?.currentTier === undefined
                ? ""
                : ` · ${escapeHtml(ticketType.currentTier.name)}`
            }</p>`
      }
    </section>

    <section class="purchase-section" aria-labelledby="purchase-data-title">
      <h3 class="purchase-section-title" id="purchase-data-title">Tus datos</h3>
      <p class="purchase-section-note">
        Los usamos para emitir tu entrada y verificarte en la entrada del evento.
      </p>
      <div class="field-grid">
        ${field({ id: "pf-first-name", field: "firstName", label: "Nombre", value: p.firstName, autocomplete: "given-name", issues: state.issues, required: true, maxlength: 80 })}
        ${field({ id: "pf-last-name", field: "lastName", label: "Apellido", value: p.lastName, autocomplete: "family-name", issues: state.issues, required: true, maxlength: 80 })}
        ${field({ id: "pf-national-id", field: "nationalId", label: "Cédula", value: p.nationalId, inputmode: "numeric", autocomplete: "off", hint: "6 a 12 dígitos", issues: state.issues, required: true, maxlength: 12 })}
        ${field({ id: "pf-email", field: "email", label: "Correo electrónico", value: p.email, type: "email", inputmode: "email", autocomplete: "email", hint: "Aquí recibirás tu entrada", issues: state.issues, required: true, maxlength: 254 })}
        ${field({ id: "pf-phone", field: "phone", label: "Celular", value: p.phone, inputmode: "tel", autocomplete: "tel", issues: state.issues, required: true, maxlength: 15 })}
        ${field({ id: "pf-city", field: "city", label: "Ciudad", value: p.city, autocomplete: "address-level2", issues: state.issues, required: true, maxlength: 80 })}
        ${field({ id: "pf-instagram", field: "instagram", label: "Usuario Instagram", value: p.instagram, autocomplete: "off", placeholder: "@reset.wll", issues: state.issues, maxlength: 30 })}
      </div>

      <div class="consent-list">
        <div class="consent-row">
          <input type="checkbox" id="pf-consent-data" data-field="dataProcessing" ${
            p.dataProcessing ? "checked" : ""
          } />
          <span class="consent-text">
            <label for="pf-consent-data">Acepto los </label><a href="terminos-y-condiciones.html" target="_blank" rel="noopener noreferrer" data-legal-tab="participantes">términos y condiciones</a><label for="pf-consent-data"> y autorizo el </label><a href="terminos-y-condiciones.html#privacidad" target="_blank" rel="noopener noreferrer" data-legal-tab="privacidad">tratamiento de mis datos personales</a><label for="pf-consent-data"> conforme a la </label><a href="terminos-y-condiciones.html#privacidad" target="_blank" rel="noopener noreferrer" data-legal-tab="privacidad">política de privacidad</a><label for="pf-consent-data">, para gestionar mi compra y mi ingreso al evento. <em>(Obligatorio)</em></label>
          </span>
        </div>
        ${
          issuesForField(state.issues, "dataProcessing").length === 0
            ? ""
            : `<p class="field-error" id="pf-consent-data-error">${renderIcon("alert")}<span>${escapeHtml(issuesForField(state.issues, "dataProcessing").join(" "))}</span></p>`
        }
        <div class="consent-row">
          <input type="checkbox" id="pf-consent-future" data-field="futureEvents" ${
            p.futureEvents ? "checked" : ""
          } />
          <span class="consent-text">
            <label for="pf-consent-future">Quiero recibir información sobre <strong>próximos eventos</strong> y novedades conforme a la </label><a href="terminos-y-condiciones.html#privacidad" target="_blank" rel="noopener noreferrer" data-legal-tab="privacidad">política de privacidad</a><label for="pf-consent-future">. <em>(Opcional)</em></label>
          </span>
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="pf-discount">Código de descuento</label>
        <input
          class="field-input"
          id="pf-discount"
          name="discountCode"
          data-discount="true"
          autocapitalize="characters"
          autocomplete="off"
          maxlength="64"
          value="${escapeHtml(state.discountCode)}"
          placeholder="Opcional"
        />
      </div>
    </section>

    ${
      previewTotal === null
        ? ""
        : `<div class="summary preview">
             ${summaryRow(`${state.quantity} × ${formatCopCents(unit ?? 0)}`, previewTotal, { strong: true })}
             <p class="summary-caption">Precio estimado. El valor definitivo se confirma al continuar.</p>
           </div>`
    }
  `;
}

function renderFormFooter(state: PurchaseState): string {
  const isWompi = state.checkout !== null && !("provider" in state.checkout);
  const providerLabel = isWompi ? "Wompi" : "ePayco";
  return `
    <div class="purchase-foot-inner">
      <button type="button" class="btn btn-primary btn-block btn-lg" data-action="quote" ${
        state.busy ? "disabled" : ""
      }>
        <span>${state.busy ? "Calculando…" : "Continuar"}</span>
        ${state.busy ? renderIcon("loader") : renderIcon("arrow-right")}
      </button>
      <p class="purchase-trust">${renderIcon("lock")}<span>Pago procesado de forma segura por ${providerLabel}</span></p>
    </div>
  `;
}

function renderReview(state: PurchaseState, ctx: PurchaseDialogContext): string {
  const quote = state.quote;
  if (quote === null) {
    return `
      <div class="purchase-state" role="status">
        <span class="purchase-state-icon">${renderIcon("loader")}</span>
        <h3 class="purchase-state-title">Calculando el total</h3>
        <p class="purchase-state-text">Estamos confirmando el precio y los cupos disponibles.</p>
      </div>
    `;
  }
  const ticketType = selectTicketType(state.event, ctx.config.ticketTypeCode);
  // The reservation's end is a real clock time the backend chose; showing it is more useful
  // than a vague promise that the seats are held "while you finish".
  const expiresTime = formatEventTime(
    quote.expiresAt,
    state.event?.event.timezone ?? "America/Bogota",
  );
  const reservationCopy =
    expiresTime.length === 0
      ? "Guardamos tus cupos mientras completas el pago."
      : `Guardamos tus cupos hasta las ${expiresTime}.`;
  return `
    ${discountNotice(quote)}
    <section class="purchase-section">
      <h3 class="purchase-section-title">Resumen de tu compra</h3>
      <div class="review-lines">
        <div class="review-line"><span>Evento</span><strong>${escapeHtml(quote.event.name)}</strong></div>
        <div class="review-line"><span>Entrada</span><strong>${escapeHtml(quote.ticketType.name)}${ticketType?.currentTier === null || ticketType?.currentTier === undefined ? "" : ` · ${escapeHtml(ticketType.currentTier.name)}`}</strong></div>
        <div class="review-line"><span>Cantidad</span><strong>${quote.quantity}</strong></div>
        <div class="review-line"><span>Titular</span><strong>${escapeHtml(`${state.participant.firstName} ${state.participant.lastName}`.trim())}</strong></div>
      </div>
      ${quoteSummary(quote)}
      <p class="reservation-note">${renderIcon("hourglass")}<span>${escapeHtml(reservationCopy)}</span></p>
    </section>
  `;
}

function renderReviewFooter(state: PurchaseState): string {
  const total = state.quote?.totalInCents ?? 0;
  return `
    <div class="purchase-foot-inner">
      <button type="button" class="btn btn-primary btn-block btn-lg" data-action="submit" ${
        state.busy ? "disabled" : ""
      }>
        <span>${state.busy ? "Creando tu reserva…" : `Pagar ${formatCopCents(total)}`}</span>
        ${state.busy ? renderIcon("loader") : renderIcon("lock")}
      </button>
      <button type="button" class="btn-link" data-action="back">Volver a mis datos</button>
    </div>
  `;
}

function renderBusy(title: string, message: string): string {
  return `
    <div class="purchase-state" role="status">
      <span class="purchase-state-icon">${renderIcon("loader")}</span>
      <h3 class="purchase-state-title">${escapeHtml(title)}</h3>
      <p class="purchase-state-text">${escapeHtml(message)}</p>
    </div>
  `;
}

function renderVerifying(state: PurchaseState, ctx: PurchaseDialogContext): string {
  const isEpayco = state.checkout !== null && "provider" in state.checkout;
  const providerLabel = isEpayco ? "ePayco" : "Wompi";
  const checkoutNote =
    state.checkout === null
      ? ""
      : isEpayco
        ? `<p class="purchase-state-text">Completa tu pago seguro en la ventana de ePayco.</p>`
        : `<p class="purchase-state-text">Cuando termines en Wompi volverás aquí automáticamente.</p>`;
  return `
    <div class="purchase-state" role="status">
      <span class="purchase-state-icon">${renderIcon("hourglass")}</span>
      <h3 class="purchase-state-title">Verificando tu pago</h3>
      <p class="purchase-state-text">
        Esto puede tardar unos segundos. Confirmamos tu compra directamente con ${providerLabel}, no con la
        página de regreso.
      </p>
      ${checkoutNote}
      ${verificationNote(state)}
    </div>
    <p class="purchase-foot-note">
      ¿Tienes dudas? ${escapeHtml(ctx.contactLabel)}:
      <a href="${escapeHtml(ctx.contactHref)}">${escapeHtml(ctx.contactHref.replace("mailto:", ""))}</a>
    </p>
  `;
}

function renderPending(state: PurchaseState, ctx: PurchaseDialogContext): string {
  const isEpayco = state.checkout !== null && "provider" in state.checkout;
  const providerLabel = isEpayco ? "ePayco" : "Wompi";
  return `
    <div class="purchase-state">
      <span class="purchase-state-icon tone-warning">${renderIcon("hourglass")}</span>
      <h3 class="purchase-state-title">Tu pago sigue en proceso</h3>
      <p class="purchase-state-text">
        Aún no tenemos confirmación de ${providerLabel}. Si ya pagaste, la confirmación llega en unos
        minutos y te enviaremos la entrada por correo. Puedes consultar de nuevo cuando quieras.
      </p>
      ${
        state.reference === null
          ? ""
          : `<p class="purchase-reference">Referencia: <strong>${escapeHtml(state.reference)}</strong></p>`
      }
      <p class="purchase-state-text">${escapeHtml(ctx.contactLabel)}: <a href="${escapeHtml(ctx.contactHref)}">${escapeHtml(ctx.contactHref.replace("mailto:", ""))}</a></p>
    </div>
  `;
}

function renderPendingFooter(): string {
  return `
    <div class="purchase-foot-inner">
      <button type="button" class="btn btn-primary btn-block" data-action="refresh">
        <span>Consultar de nuevo</span>
        ${renderIcon("arrow-right")}
      </button>
      <button type="button" class="btn-link" data-action="close">Cerrar</button>
    </div>
  `;
}

/** Maps the honest email status onto the note colours. */
function emailTone(kind: string): string {
  if (kind === "sent") return "positive";
  if (kind === "failed") return "negative";
  return "neutral";
}

function renderConfirmed(state: PurchaseState, ctx: PurchaseDialogContext): string {
  const status: OrderStatus | null = state.status;
  const tickets = status?.tickets ?? [];
  const event = toTicketEvent(state, ctx.fallbackEvent);
  const email = describeEmailStatus(status?.confirmation ?? null, status?.quantity ?? 0);
  return `
    <div class="purchase-state tone-positive">
      <span class="purchase-state-icon tone-positive">${renderIcon("check")}</span>
      <h3 class="purchase-state-title">¡Tu pago fue confirmado!</h3>
      <p class="purchase-state-text">${escapeHtml(event.eventName)} · ${escapeHtml(event.dateLabel)}</p>
    </div>

    <p class="inline-note tone-${emailTone(email.kind)}">${renderIcon(email.kind === "failed" ? "alert" : "mail")}<span>${escapeHtml(email.message)}</span></p>

    ${
      status === null
        ? ""
        : `<p class="purchase-reference">Referencia de tu compra: <strong>${escapeHtml(status.reference)}</strong></p>`
    }

    <div class="ticket-stack">
      ${tickets
        .map((ticket) =>
          renderTicketCard(
            event,
            {
              token: ticket.token,
              unit: ticket.unit,
              quantity: status?.quantity ?? tickets.length,
              status: ticket.status,
              assigned: ticket.assigned,
              participantName: ticket.participantName,
            },
            { labelledById: `ticket-${ticket.unit}-label` },
          ),
        )
        .join("")}
    </div>

    <section class="purchase-section purchase-instructions">
      <h3 class="purchase-section-title">Para el día del evento</h3>
      <ul>
        <li>Presenta el código QR de cada entrada desde tu teléfono o impreso.</li>
        <li>Lleva tu documento de identidad original.</li>
        <li>Llega 20 minutos antes; el registro abre a las 2:30 p. m.</li>
      </ul>
    </section>
  `;
}

function renderConfirmedFooter(): string {
  return `
    <div class="purchase-foot-inner">
      <button type="button" class="btn btn-secondary btn-block" data-action="close">
        <span>Cerrar</span>
      </button>
    </div>
  `;
}

function renderProblem(state: PurchaseState, ctx: PurchaseDialogContext): string {
  const problem = state.problem;
  const canRecover = problem?.kind === "not_found";
  return `
    <div class="purchase-state">
      <span class="purchase-state-icon tone-negative">${renderIcon("alert")}</span>
      <h3 class="purchase-state-title">${escapeHtml(problem?.title ?? "Algo salió mal")}</h3>
      <p class="purchase-state-text">${escapeHtml(problem?.message ?? "Intenta de nuevo en unos minutos.")}</p>
    </div>
    ${
      canRecover
        ? `<section class="purchase-section" aria-labelledby="recover-title">
             <h3 class="purchase-section-title" id="recover-title">Consultar mi compra</h3>
             <div class="field">
               <label class="field-label" for="recover-reference">Referencia de la orden</label>
               <input class="field-input" id="recover-reference" data-recover="reference" autocomplete="off" placeholder="EVT-2026-000001" />
             </div>
             <div class="field">
               <label class="field-label" for="recover-email">Correo con el que compraste</label>
               <input class="field-input" id="recover-email" data-recover="email" type="email" inputmode="email" autocomplete="email" />
             </div>
           </section>`
        : ""
    }
    <p class="purchase-state-text">${escapeHtml(ctx.contactLabel)}: <a href="${escapeHtml(ctx.contactHref)}">${escapeHtml(ctx.contactHref.replace("mailto:", ""))}</a></p>
  `;
}

function renderProblemFooter(state: PurchaseState): string {
  const problem = state.problem;
  if (problem?.kind === "not_found") {
    return `
      <div class="purchase-foot-inner">
        <button type="button" class="btn btn-primary btn-block" data-action="recover">
          <span>Consultar mi compra</span>
          ${renderIcon("arrow-right")}
        </button>
      </div>
    `;
  }
  const buttons: string[] = [];
  if (problem?.canRetryPayment === true) {
    buttons.push(
      `<button type="button" class="btn btn-primary btn-block" data-action="retry-payment" ${
        state.busy ? "disabled" : ""
      }><span>Intentar pagar de nuevo</span>${renderIcon("arrow-right")}</button>`,
    );
  } else if (problem?.canRetry === true) {
    buttons.push(
      `<button type="button" class="btn btn-primary btn-block" data-action="retry" ${
        state.busy ? "disabled" : ""
      }><span>Intentar de nuevo</span>${renderIcon("arrow-right")}</button>`,
    );
  }
  if (problem?.canEditForm === true) {
    buttons.push(
      `<button type="button" class="btn-link" data-action="edit">Editar mis datos</button>`,
    );
  }
  buttons.push(`<button type="button" class="btn-link" data-action="close">Cerrar</button>`);
  return `<div class="purchase-foot-inner">${buttons.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Step → (title, body, footer)
// ---------------------------------------------------------------------------

type RenderedStep = {
  readonly title: string;
  readonly body: string;
  readonly foot: string;
  readonly closable: boolean;
};

export function renderPurchaseStep(
  state: PurchaseState,
  ctx: PurchaseDialogContext,
  options: { readonly showFormProblem?: boolean } = {},
): RenderedStep {
  switch (state.step) {
    case "loading":
      return {
        title: "Comprar entrada",
        body: renderLoading(ctx.fallbackEvent),
        foot: "",
        closable: true,
      };
    case "closed":
      return {
        title: "Venta de entradas",
        body: renderClosed(state.problem, ctx),
        foot: "",
        closable: true,
      };
    case "form":
      return {
        title: "Comprar entrada",
        body: renderForm(state, ctx, options.showFormProblem ?? true),
        foot: renderFormFooter(state),
        closable: true,
      };
    case "review":
      return {
        title: "Confirma y paga",
        body: renderReview(state, ctx),
        foot: renderReviewFooter(state),
        closable: true,
      };
    case "submitting":
      return {
        title: "Confirma y paga",
        body: renderBusy(
          "Preparando tu pago",
          "Estamos reservando tus cupos y abriendo la pasarela de pago seguro.",
        ),
        foot: "",
        closable: false,
      };
    case "verifying":
      return {
        title: "Verificando tu pago",
        body: renderVerifying(state, ctx),
        foot: "",
        closable: true,
      };
    case "pending":
      return {
        title: "Pago en proceso",
        body: renderPending(state, ctx),
        foot: renderPendingFooter(),
        closable: true,
      };
    case "confirmed":
      return {
        title: "Tu entrada está lista",
        body: renderConfirmed(state, ctx),
        foot: renderConfirmedFooter(),
        closable: true,
      };
    case "problem":
      return {
        title: state.problem?.title ?? "No pudimos completar tu compra",
        body: renderProblem(state, ctx),
        foot: renderProblemFooter(state),
        closable: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export function mountPurchaseDialog(options: {
  readonly controller: PurchaseController;
  readonly context: PurchaseDialogContext;
  readonly mountTo?: HTMLElement;
}): PurchaseDialog {
  const { controller, context } = options;
  const host = options.mountTo ?? document.body;

  const overlay = document.createElement("div");
  overlay.className = "purchase-overlay";
  overlay.id = "purchase-flow";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="purchase-panel" role="dialog" aria-modal="true" aria-labelledby="purchase-title" aria-describedby="purchase-live">
      <header class="purchase-head">
        <div class="purchase-head-text">
          <p class="purchase-eyebrow">${renderIcon("lock")}<span>Compra segura</span></p>
          <h2 class="purchase-title" id="purchase-title" tabindex="-1">Comprar entrada</h2>
        </div>
        <button type="button" class="purchase-close" data-action="close" aria-label="Cerrar la compra">${renderIcon("close")}</button>
      </header>
      <div class="purchase-body" id="purchase-body"></div>
      <footer class="purchase-foot" id="purchase-foot"></footer>
      <p class="sr-only" role="status" aria-live="polite" id="purchase-live"></p>
    </div>
  `;
  host.appendChild(overlay);

  const panel = overlay.querySelector<HTMLElement>(".purchase-panel");
  const titleEl = overlay.querySelector<HTMLElement>("#purchase-title");
  const bodyEl = overlay.querySelector<HTMLElement>("#purchase-body");
  const footEl = overlay.querySelector<HTMLElement>("#purchase-foot");
  const liveEl = overlay.querySelector<HTMLElement>("#purchase-live");
  const closeBtn = overlay.querySelector<HTMLButtonElement>(".purchase-close");

  let isOpen = false;
  let previousActive: HTMLElement | null = null;
  let lastStep = "";
  let hasAttemptedQuote = false;
  let isHandlingInput = false;
  // The step decides whether the buyer may leave right now; one flag, checked by every exit.
  let closable = true;

  /**
   * Where the caret is right now, so a keystroke-driven re-render can put it back.
   *
   * The body is replaced wholesale on every state change, which would otherwise blur the field
   * the buyer is typing in after a single character. `selectionStart` throws for input types
   * that do not support the selection API (email, number), hence the guard.
   */
  function captureFocus(): { selector: string; start: number | null; end: number | null } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !overlay.contains(active) || active === titleEl) {
      return null;
    }
    if (active.id.length === 0) {
      return null;
    }
    let start: number | null = null;
    let end: number | null = null;
    try {
      const input = active as HTMLInputElement;
      start = typeof input.selectionStart === "number" ? input.selectionStart : null;
      end = typeof input.selectionEnd === "number" ? input.selectionEnd : null;
    } catch {
      // Not a text-like input: focus alone is enough.
    }
    return { selector: `#${CSS.escape(active.id)}`, start, end };
  }

  function restoreFocus(
    saved: { selector: string; start: number | null; end: number | null } | null,
  ): void {
    if (saved === null) {
      return;
    }
    const next = overlay.querySelector<HTMLElement>(saved.selector);
    if (next === null) {
      return;
    }
    next.focus();
    if (saved.start === null || !(next instanceof HTMLInputElement)) {
      return;
    }
    try {
      next.setSelectionRange(saved.start, saved.end ?? saved.start);
    } catch {
      // Same guard as captureFocus: the control simply has no text selection.
    }
  }

  function render(state: PurchaseState): void {
    const isEditingForm =
      isHandlingInput &&
      isOpen &&
      state.step === "form" &&
      lastStep === "form" &&
      document.activeElement instanceof HTMLInputElement &&
      bodyEl?.contains(document.activeElement) === true;

    if (isEditingForm) {
      // User is actively typing or interacting with a form control.
      // Do NOT destroy the DOM with innerHTML: doing so blows away the native input node,
      // which resets cursor/caret position (especially in <input type="email"> where selectionStart
      // is not supported) and disrupts mobile keyboards/IME.
      const activeInput = document.activeElement as HTMLInputElement;
      const fieldName = activeInput.dataset.field as ParticipantField | undefined;
      if (fieldName !== undefined) {
        const fieldEl = activeInput.closest(".field") ?? activeInput.closest(".consent-list");
        if (fieldEl !== null && !state.issues.some((i) => i.field === fieldName)) {
          fieldEl.classList.remove("has-error");
          activeInput.removeAttribute("aria-invalid");
          fieldEl.querySelector(".field-error")?.remove();
        }
      }
      return;
    }

    const step = renderPurchaseStep(state, context, { showFormProblem: hasAttemptedQuote });
    const focus = state.step === lastStep ? captureFocus() : null;
    closable = step.closable;
    if (closeBtn !== null) closeBtn.disabled = !closable;
    if (titleEl !== null) titleEl.textContent = step.title;
    if (bodyEl !== null) bodyEl.innerHTML = step.body;
    if (footEl !== null) {
      footEl.innerHTML = step.foot;
      footEl.hidden = step.foot.length === 0;
    }
    if (liveEl !== null) {
      liveEl.textContent = `${step.title}. ${stepMessage(state)}`;
    }
    if (isOpen && state.step !== lastStep) {
      lastStep = state.step;
      titleEl?.focus();
      return;
    }
    if (state.issues.length > 0 && bodyEl !== null) {
      const firstInvalid = bodyEl.querySelector<HTMLElement>(
        ".has-error .field-input, .consent-row input[aria-invalid='true'], .has-error input",
      );
      firstInvalid?.focus();
      return;
    }
    restoreFocus(focus);
  }

  function stepMessage(state: PurchaseState): string {
    switch (state.step) {
      case "form":
        return "Completa tus datos para continuar.";
      case "review":
        return "Revisa el total y confirma el pago.";
      case "verifying":
        return "Estamos verificando tu pago.";
      case "confirmed":
        return "Tu pago fue confirmado.";
      case "problem":
        return state.problem?.message ?? "Ocurrió un problema.";
      default:
        return "";
    }
  }

  function open(openOptions: OpenPurchaseOptions = {}): void {
    if (isOpen) {
      return;
    }
    isOpen = true;
    hasAttemptedQuote = false;
    previousActive = document.activeElement as HTMLElement | null;
    overlay.hidden = false;
    overlay.classList.add("is-open");
    document.body.style.overflow = "hidden";

    if (openOptions.quantity !== undefined) {
      controller.setQuantity(openOptions.quantity);
    }
    if (openOptions.acceptedTerms === true) {
      controller.setField("dataProcessing", true);
    }

    render(controller.getState());
    const target = overlay.querySelector<HTMLElement>(FOCUSABLE);
    (titleEl ?? target)?.focus();
    if (openOptions.resume !== undefined) {
      const resume = openOptions.resume;
      void controller.resumeReturn(
        resume.transactionId === undefined ? {} : { transactionId: resume.transactionId },
      );
    } else {
      void controller.start();
    }
  }

  /** Honours the current step's closability; every exit path goes through here. */
  function requestClose(): void {
    if (closable) {
      close();
    }
  }

  function close(): void {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    overlay.classList.remove("is-open");
    overlay.hidden = true;
    document.body.style.overflow = "";
    controller.cancel();
    previousActive?.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!isOpen) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key === "Tab" && panel !== null) {
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target === overlay) {
      requestClose();
      return;
    }
    const legalAnchor = target?.closest<HTMLAnchorElement>(".consent-row a");
    if (legalAnchor) {
      event.preventDefault();
      event.stopPropagation();
      const tab = legalAnchor.getAttribute("data-legal-tab") as LegalTabId | null;
      if (tab !== null) {
        dispatchOpenLegal(tab);
      }
      return;
    }
    const consentRow = target?.closest<HTMLElement>(".consent-row");
    if (
      consentRow &&
      !target?.closest("a") &&
      !target?.closest("input") &&
      !target?.closest("label")
    ) {
      const checkbox = consentRow.querySelector<HTMLInputElement>("input[type='checkbox']");
      checkbox?.click();
      return;
    }
    const actionEl = target?.closest<HTMLElement>("[data-action]");
    const action = actionEl?.dataset.action;
    switch (action) {
      case "close":
        requestClose();
        break;
      case "qty-inc":
        controller.setQuantity(controller.getState().quantity + 1);
        break;
      case "qty-dec":
        controller.setQuantity(controller.getState().quantity - 1);
        break;
      case "quote":
        hasAttemptedQuote = true;
        void controller.requestQuote();
        break;
      case "back":
      case "edit":
        controller.backToForm();
        break;
      case "submit":
        void controller.submit();
        break;
      case "refresh":
        void controller.refreshStatus();
        break;
      case "retry":
        hasAttemptedQuote = true;
        void controller.requestQuote();
        break;
      case "retry-payment":
        void controller.retryPayment();
        break;
      case "recover": {
        const reference = overlay.querySelector<HTMLInputElement>("[data-recover='reference']");
        const email = overlay.querySelector<HTMLInputElement>("[data-recover='email']");
        void controller.recoverOrder(reference?.value ?? "", email?.value ?? "");
        break;
      }
      default:
        break;
    }
  }

  function onInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    if (target === null) {
      return;
    }
    const fieldName = target.dataset.field as ParticipantField | undefined;
    if (fieldName !== undefined) {
      isHandlingInput = true;
      try {
        controller.setField(fieldName, target.type === "checkbox" ? target.checked : target.value);
      } finally {
        isHandlingInput = false;
      }
      return;
    }
    if (target.dataset.discount === "true") {
      isHandlingInput = true;
      try {
        controller.setDiscountCode(target.value);
      } finally {
        isHandlingInput = false;
      }
    }
  }

  overlay.addEventListener("click", onClick);
  overlay.addEventListener("input", onInput);
  overlay.addEventListener("change", onInput);
  window.addEventListener("keydown", onKeydown);
  const unsubscribe = controller.subscribe(render);

  return {
    open,
    close,
    element: overlay,
    dispose() {
      unsubscribe();
      overlay.removeEventListener("click", onClick);
      overlay.removeEventListener("input", onInput);
      overlay.removeEventListener("change", onInput);
      window.removeEventListener("keydown", onKeydown);
      document.body.style.overflow = "";
      overlay.remove();
    },
  };
}
