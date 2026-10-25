/**
 * Demo page markup — pure render functions, no state and no side effects.
 *
 * The same functions build the page the visitor sees and the markup the tests inspect, so the copy,
 * the prices and the totals can only be written once. Every interpolated value comes from the
 * `catalog.ts` constants or from formatted integers: no user input reaches these strings.
 */

import { formatCopCents } from "../purchase/format.ts";
import {
  DEMO_TIERS,
  demoTotals,
  type DemoCart,
  type DemoLine,
  type DemoTier,
  type DemoTotals,
} from "./catalog.ts";

/** The one sentence every demo surface repeats, so the demo can never be mistaken for a sale. */
export const DEMO_NOTICE =
  "Esta es una demostración: no se reserva ningún cupo, no se crea un pedido y no se procesa ningún pago.";

const ADD_LABEL: Record<DemoTier["code"], string> = {
  preventa: "Agregar una entrada de Preventa",
  general: "Agregar una entrada General",
  paquete: "Agregar el paquete Comparte tu experiencia de 3 entradas",
};

const REMOVE_LABEL: Record<DemoTier["code"], string> = {
  preventa: "Quitar la entrada de Preventa",
  general: "Quitar una entrada General",
  paquete: "Quitar el paquete Comparte tu experiencia",
};

/** The word under a stepper's number: "entrada(s)" or "paquete(s)". */
export function quantityLabel(noun: DemoTier["unitNoun"], quantity: number): string {
  if (noun === "paquete") {
    return quantity === 1 ? "paquete" : "paquetes";
  }
  return quantity === 1 ? "entrada" : "entradas";
}

function renderPriceBlock(tier: DemoTier): string {
  // The price vocabulary is the site's own (`precio-desc`, `precio-antes`, `precio-ahora`,
  // `precio-unidad`, in `reset.css`), so the demo cards match `/entradas` exactly.
  const badge = tier.badge === null ? "" : `<span class="precio-desc">${tier.badge}</span>`;
  const reference =
    tier.referenceCents === null
      ? ""
      : `<span class="precio-antes">${formatCopCents(tier.referenceCents)}</span>`;
  const caption =
    tier.unitCaption === null ? "" : `<span class="precio-unidad">${tier.unitCaption}</span>`;
  return `<p class="demo-tipo-price">
    ${badge}
    ${reference}
    <span class="precio-ahora">${formatCopCents(tier.unitCents)}</span>
    ${caption}
  </p>`;
}

/**
 * One ticket option: name, prices, the real sales window for context, and a quantity stepper.
 *
 * The stepper mirrors the commercial rules the demo is presenting (Preventa caps at one, the
 * package is a single three-admission unit) but never the sales calendar: no control here is
 * disabled because of a stage or a date.
 */
export function renderDemoTierCard(tier: DemoTier, quantity: number): string {
  const selected = quantity > 0;
  const atCap = quantity >= tier.maxQuantity;
  const lineTotal = selected
    ? `<p class="demo-line-total" data-demo-line-total="${tier.code}">${formatCopCents(quantity * tier.unitCents)}</p>`
    : `<p class="demo-line-total" data-demo-line-total="${tier.code}" aria-hidden="true"></p>`;
  const chip =
    tier.admissionsPerUnit === 1
      ? ""
      : `<span class="demo-chip">${tier.admissionsPerUnit} entradas</span>`;

  return `<li class="demo-tipo${selected ? " is-selected" : ""}" data-demo-tier="${tier.code}">
    <div class="demo-tipo-head">
      <h3 class="demo-tipo-name">${tier.name}${chip}</h3>
      ${renderPriceBlock(tier)}
    </div>
    <p class="demo-tipo-note">${tier.note}</p>
    <p class="demo-tipo-window">Venta real: ${tier.scheduleLabel}</p>
    <div class="demo-tipo-foot">
      <div class="qty-stepper demo-stepper" role="group" aria-label="Cantidad de ${tier.name}">
        <button class="qty-btn" type="button" data-demo-step="-1"
          aria-label="${REMOVE_LABEL[tier.code]}"${quantity === 0 ? " disabled" : ""}>−</button>
        <span class="qty-value">
          <output class="qty-value-number" data-demo-quantity="${tier.code}">${quantity}</output>
          <span class="qty-value-label" data-demo-quantity-label="${tier.code}">${quantityLabel(
            tier.unitNoun,
            quantity,
          )}</span>
        </span>
        <button class="qty-btn" type="button" data-demo-step="1"
          aria-label="${ADD_LABEL[tier.code]}"${atCap ? " disabled" : ""}>+</button>
      </div>
      ${lineTotal}
    </div>
  </li>`;
}

export function renderDemoTiers(cart: DemoCart): string {
  const cards = DEMO_TIERS.map((tier) => renderDemoTierCard(tier, cart[tier.code])).join("");
  return `<ul class="demo-tipos" data-demo-tiers aria-label="Entradas disponibles">${cards}</ul>`;
}

function renderSummaryLine(line: DemoLine): string {
  const quantitySuffix = line.quantity > 1 ? ` × ${line.quantity}` : "";
  return `<div class="summary-row" data-demo-line="${line.code}">
    <span>${line.name}${quantitySuffix}</span>
    <span>${formatCopCents(line.subtotalCents)}</span>
  </div>`;
}

/** The live purchase summary. Its visible numbers are the only place the totals are printed. */
export function renderDemoSummary(totals: DemoTotals): string {
  if (totals.isEmpty) {
    return `<div class="summary demo-summary" data-demo-summary aria-live="polite">
      <p class="summary-caption">Todavía no has agregado entradas.</p>
      <p class="summary-caption">Aquí verás el resumen de tu compra de demostración.</p>
    </div>`;
  }

  const lines = totals.lines.map(renderSummaryLine).join("");
  return `<div class="summary demo-summary" data-demo-summary aria-live="polite">
    ${lines}
    <div class="summary-row is-muted" data-demo-admissions>
      <span>Entradas</span>
      <span>${totals.admissions}</span>
    </div>
    <div class="summary-row is-total" data-demo-total>
      <span>Total</span>
      <span>${formatCopCents(totals.totalCents)}</span>
    </div>
    <p class="summary-caption">Precios de demostración · no se genera ningún cobro.</p>
  </div>`;
}

/**
 * The whole selectable area: the three options, the summary and the demo call to action.
 *
 * `#demo-comprar` deliberately is not `#comprar`: the real page's buy button is wired by
 * `client-interactions.ts`, and this page never runs that module.
 */
export function renderDemoSection(cart: DemoCart): string {
  return `<div class="demo-grid">
    <div class="demo-selection">
      ${renderDemoTiers(cart)}
      <p class="demo-note">En esta demo las tres etapas están activas al mismo tiempo. En la venta
      real cada una abre y cierra en su fecha y hora de Colombia.</p>
    </div>
    <aside class="demo-aside" aria-labelledby="demo-resumen-titulo">
      <h2 class="demo-aside-title" id="demo-resumen-titulo">Tu selección</h2>
      <div data-demo-summary-slot>${renderDemoSummary(demoTotals(cart))}</div>
      <button class="comprar demo-comprar" id="demo-comprar" type="button" aria-disabled="true">
        <span>Continuar · demo</span>
        <span id="demo-comprar-total">$0</span>
      </button>
      <p class="comprar-ayuda" id="demo-comprar-ayuda">
        Agrega al menos una entrada para ver el resumen de la compra.
      </p>
      <p class="demo-assurance">La demo no solicita datos personales ni de pago y no puede abrir un
      checkout real de ePayco.</p>
      <ul class="demo-assurance-list">
        <li>No reserva cupos de las 100 boletas.</li>
        <li>No crea pedidos ni pagos.</li>
        <li>No envía correos.</li>
      </ul>
    </aside>
  </div>`;
}

function renderReviewLine(line: DemoLine): string {
  const quantity =
    line.quantity === 1 ? "" : ` · ${line.quantity} × ${formatCopCents(line.unitCents)}`;
  return `<div class="review-line" data-demo-review-line="${line.code}">
    <span>${line.name}${quantity}</span>
    <strong>${formatCopCents(line.subtotalCents)}</strong>
  </div>`;
}

/**
 * The demo checkout panel. It is a review screen and nothing else: no form, no field, no input —
 * there is nowhere here to type a name, an email or a card.
 */
export function renderDemoCheckoutPanel(totals: DemoTotals): string {
  const lines = totals.lines.map(renderReviewLine).join("");
  return `<div class="purchase-panel" role="dialog" aria-modal="true"
      aria-labelledby="demo-checkout-title" aria-describedby="demo-checkout-notice">
    <div class="purchase-head">
      <div class="purchase-head-text">
        <span class="purchase-eyebrow">Modo demostración</span>
        <h2 class="purchase-title" id="demo-checkout-title" tabindex="-1">Resumen de tu compra</h2>
      </div>
      <button class="purchase-close" type="button" data-demo-close
        aria-label="Cerrar la demostración">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
          aria-hidden="true" focusable="false"><path d="M5 5l14 14M19 5L5 19" /></svg>
      </button>
    </div>
    <div class="purchase-body">
      <p class="inline-note tone-warning" id="demo-checkout-notice">${DEMO_NOTICE}</p>
      <div class="review-lines">${lines}</div>
      <div class="summary">
        <div class="summary-row is-muted">
          <span>Entradas</span>
          <span>${totals.admissions}</span>
        </div>
        <div class="summary-row is-total">
          <span>Total</span>
          <span>${formatCopCents(totals.totalCents)}</span>
        </div>
      </div>
      <p class="summary-caption">En la compra real este paso continúa en el checkout seguro de
      ePayco. Aquí no se pide ningún dato y no se cobra nada.</p>
    </div>
    <div class="purchase-foot">
      <div class="purchase-foot-inner">
        <button class="btn btn-primary btn-block" type="button" data-demo-close>
          Volver a las entradas
        </button>
        <p class="purchase-foot-note">Ninguna acción de esta página ocupa cupos ni genera pagos.</p>
      </div>
    </div>
  </div>`;
}
