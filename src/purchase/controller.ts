/**
 * Purchase flow controller (Phase 6B).
 *
 * Owns the entire buyer journey as one state machine, so the UI only renders it and the
 * tests can drive it with a fake API. It is deliberately the ONLY place that sequences
 * network calls, and it never invents business truth:
 *
 *   loading ──► closed (venta cerrada / no encontrado)
 *      │
 *      └──► form ──quote──► review ──create──► submitting ──► verifying ──poll──► confirmed
 *             ▲               │                                 │                │
 *             └── issues ◄────┘                                 ├──► pending     └──► (tickets)
 *                                                               └──► problem ──retry──► submitting
 *
 * Payment truth ALWAYS comes from `GET /orders/{reference}` (or the same data re-read after a
 * payment hint). A return from Wompi only tells us *which* order to ask about; it never proves
 * anything.
 */

import {
  AbortError,
  ApiError,
  NetworkError,
  createApiClient,
  type ApiClient,
} from "../api/client.ts";
import { createTicketingApi, type TicketingApi } from "../api/ticketing.ts";
import type {
  AvailabilityLabel,
  OrderStatus,
  PaymentCheckout,
  PublicEvent,
  Quote,
} from "../api/types.ts";
import type { FrontendConfig } from "../config/env.ts";
import { selectTicketType } from "./ticket-selection.ts";
import {
  availabilityIsPurchasable,
  isDeclinedPaymentStatus,
  isUnrecoverableOrderStatus,
} from "./format.ts";
import {
  defaultStore,
  generateIdempotencyKey,
  loadDraft,
  loadPendingOrder,
  participantFromDraft,
  saveDraft,
  savePendingOrder,
  type KeyValueStore,
} from "./persistence.ts";
import {
  EMPTY_PARTICIPANT_FORM,
  backendPathToField,
  validateParticipantForm,
  type FieldIssue,
  type ParticipantField,
  type ParticipantFormValues,
} from "./validation.ts";

export type PurchaseStep =
  | "loading"
  | "closed"
  | "form"
  | "review"
  | "submitting"
  | "verifying"
  | "confirmed"
  | "pending"
  | "problem";

export type PurchaseProblem = {
  readonly kind:
    | "sold_out"
    | "sales_closed"
    | "declined"
    | "expired"
    | "validation"
    | "not_found"
    | "network"
    | "upstream"
    | "server"
    | "unknown";
  readonly title: string;
  readonly message: string;
  readonly canRetry: boolean;
  readonly canRetryPayment: boolean;
  readonly canEditForm: boolean;
};

export type PurchaseState = {
  readonly step: PurchaseStep;
  readonly busy: boolean;
  readonly event: PublicEvent | null;
  readonly availability: AvailabilityLabel;
  readonly quantity: number;
  readonly discountCode: string;
  readonly participant: ParticipantFormValues;
  readonly issues: readonly FieldIssue[];
  readonly quote: Quote | null;
  readonly reference: string | null;
  readonly buyerEmail: string | null;
  readonly checkout: PaymentCheckout | null;
  readonly status: OrderStatus | null;
  readonly problem: PurchaseProblem | null;
  readonly verificationAttempts: number;
  readonly verificationStartedAt: number | null;
  /** Set when a payment hint was sent, so the UI can explain the acceleration. */
  readonly hintOutcome: string | null;
};

/**
 * Which step asked for the network call. It only changes how an ambiguous refusal is
 * explained: a `CONFLICT` while creating an order means the last tickets went to someone
 * else, while the same code during a payment retry means the reservation is no longer
 * retryable — two very different sentences for the buyer.
 */
export type ErrorContext = "order" | "payment";

export type PurchaseControllerOptions = {
  readonly config: FrontendConfig;
  readonly api?: TicketingApi;
  readonly client?: ApiClient;
  readonly store?: KeyValueStore;
  readonly now?: () => number;
  /** Opens the checkout (ePayco Smart Checkout V2 or Wompi). */
  readonly onCheckout: (checkout: PaymentCheckout, reference: string) => void;
  readonly polling?: { readonly intervalMs?: number; readonly maxDurationMs?: number };
};

export type PurchaseController = {
  getState(): PurchaseState;
  subscribe(listener: (state: PurchaseState) => void): () => void;
  start(): Promise<void>;
  setQuantity(quantity: number): void;
  setDiscountCode(value: string): void;
  setField(field: ParticipantField, value: string | boolean): void;
  requestQuote(): Promise<void>;
  backToForm(): void;
  submit(): Promise<void>;
  resumeReturn(options: { readonly transactionId?: string | undefined }): Promise<void>;
  refreshStatus(): Promise<void>;
  retryPayment(): Promise<void>;
  recoverOrder(reference: string, buyerEmail: string): Promise<void>;
  cancel(): void;
  dispose(): void;
};

const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_POLL_MAX_MS = 90_000;
const MAX_QUANTITY_FALLBACK = 4;

function initialState(): PurchaseState {
  return {
    step: "form",
    busy: false,
    event: null,
    availability: "AVAILABLE",
    quantity: 1,
    discountCode: "",
    participant: EMPTY_PARTICIPANT_FORM,
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
  };
}

/** Spanish, action-oriented explanation for every failure the buyer can hit. */
function describeError(error: unknown, context: ErrorContext = "order"): PurchaseProblem {
  if (error instanceof NetworkError) {
    return {
      kind: "network",
      title: "Problema de conexión",
      message: error.timedOut
        ? "La operación tardó demasiado. Revisa tu conexión e intenta de nuevo."
        : "No pudimos comunicarnos con el sistema. Revisa tu conexión e intenta de nuevo.",
      canRetry: true,
      canRetryPayment: false,
      canEditForm: true,
    };
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "VALIDATION_ERROR":
        return {
          kind: "validation",
          title: "Revisa tus datos",
          message: "Algunos datos no son válidos. Corrígelos para continuar.",
          canRetry: false,
          canRetryPayment: false,
          canEditForm: true,
        };
      case "NOT_FOUND":
        return {
          kind: "not_found",
          title: "No encontramos esa compra",
          message:
            "Verifica la referencia de la orden y el correo con el que compraste. Si el problema continúa, escríbenos.",
          canRetry: false,
          canRetryPayment: false,
          canEditForm: false,
        };
      case "CONFLICT":
        // The envelope deliberately does not expose the raw reason (the SQLSTATE detail is
        // never surfaced), so the sentence depends on what was being attempted.
        if (context === "payment") {
          return {
            kind: "expired",
            title: "No pudimos iniciar un nuevo intento",
            message:
              "Esta compra ya no admite un nuevo intento de pago. Escríbenos y lo revisamos contigo.",
            canRetry: false,
            canRetryPayment: false,
            canEditForm: false,
          };
        }
        // Creating an order is the one place where a conflict is overwhelmingly the last
        // tickets going to someone else between quoting and paying.
        return {
          kind: "sold_out",
          title: "Los cupos se agotaron",
          message:
            "Mientras completabas tu compra, los cupos disponibles se agotaron. No se realizó ningún cobro.",
          canRetry: true,
          canRetryPayment: false,
          canEditForm: false,
        };
      case "RATE_LIMITED":
        return {
          kind: "server",
          title: "Demasiados intentos",
          message: "Espera unos segundos y vuelve a intentarlo.",
          canRetry: true,
          canRetryPayment: false,
          canEditForm: false,
        };
      case "UPSTREAM_ERROR":
        return {
          kind: "upstream",
          title: "La pasarela de pagos no respondió",
          message:
            "No pudimos verificar el pago en este momento. Intenta de nuevo en unos minutos.",
          canRetry: true,
          canRetryPayment: false,
          canEditForm: false,
        };
      default:
        return {
          kind: "server",
          title: "Algo salió mal",
          message: "Ocurrió un error inesperado. Intenta de nuevo en unos minutos.",
          canRetry: true,
          canRetryPayment: false,
          canEditForm: false,
        };
    }
  }
  return {
    kind: "unknown",
    title: "Algo salió mal",
    message: "Ocurrió un error inesperado. Intenta de nuevo en unos minutos.",
    canRetry: true,
    canRetryPayment: false,
    canEditForm: false,
  };
}

/** Maps the backend's `details.issues[]` onto form fields. */
function issuesFromError(error: ApiError): readonly FieldIssue[] {
  return error.issues.flatMap((issue) => {
    const field = backendPathToField(issue.path);
    return field === undefined ? [] : [{ field, message: issue.message }];
  });
}

export function createPurchaseController(options: PurchaseControllerOptions): PurchaseController {
  const { config } = options;
  const client = options.client ?? createApiClient({ baseUrl: config.apiBaseUrl });
  const api = options.api ?? createTicketingApi(client);
  const store = options.store ?? defaultStore();
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = options.polling?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollMaxMs = options.polling?.maxDurationMs ?? DEFAULT_POLL_MAX_MS;

  let state = initialState();
  const listeners = new Set<(state: PurchaseState) => void>();
  let inFlight: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let idempotencyKey: string | undefined;
  // Invalidates any polling loop that is still awaiting a response, so a double "consultar de
  // nuevo" can never leave two loops running in parallel.
  let pollGeneration = 0;

  function emit(patch: Partial<PurchaseState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  }

  function abortInFlight(): void {
    inFlight?.abort();
    inFlight = undefined;
  }

  function stopPolling(): void {
    pollGeneration += 1;
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  }

  function newSignal(): AbortSignal {
    abortInFlight();
    inFlight = new AbortController();
    return inFlight.signal;
  }

  function persistDraft(): void {
    saveDraft(store, {
      quantity: state.quantity,
      discountCode: state.discountCode,
      participant: {
        firstName: state.participant.firstName,
        lastName: state.participant.lastName,
        nationalId: state.participant.nationalId,
        email: state.participant.email,
        phone: state.participant.phone,
        city: state.participant.city,
        instagram: state.participant.instagram,
      },
    });
  }

  function maxQuantity(): number {
    const ticketType = selectTicketType(state.event, config.ticketTypeCode);
    if (ticketType === undefined) {
      return MAX_QUANTITY_FALLBACK;
    }
    const limit = ticketType.maxPerOrder ?? MAX_QUANTITY_FALLBACK;
    return Math.max(1, Math.min(limit, 10));
  }

  function minQuantity(): number {
    return Math.max(1, selectTicketType(state.event, config.ticketTypeCode)?.minPerOrder ?? 1);
  }

  function eligibleDiscountCode(): string | undefined {
    const ticketType = selectTicketType(state.event, config.ticketTypeCode);
    if (state.quantity !== 1 || ticketType?.currentTier?.name !== "General") return undefined;
    return state.discountCode.length === 0 ? undefined : state.discountCode;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async function start(): Promise<void> {
    const draft = loadDraft(store);
    const quantity = clamp(draft?.quantity ?? state.quantity, 1, MAX_QUANTITY_FALLBACK);
    const savedDiscountCode = quantity === 1 ? (draft?.discountCode ?? state.discountCode) : "";
    const participant = {
      ...participantFromDraft(draft, state.participant),
      ...(state.participant.dataProcessing ? { dataProcessing: true } : {}),
      ...(state.participant.futureEvents ? { futureEvents: true } : {}),
    };

    // Immediately present the form to the buyer without blocking
    emit({
      step: "form",
      busy: false,
      problem: null,
      quantity,
      discountCode: savedDiscountCode,
      participant,
    });

    const signal = newSignal();
    try {
      const event = await api.getEvent(config.eventCode, signal);
      const ticketType = selectTicketType(event, config.ticketTypeCode);
      const availability = ticketType?.availability ?? event.sales.availability;
      const discountCode =
        quantity === 1 && ticketType?.currentTier?.name === "General" ? savedDiscountCode : "";
      const purchasable =
        event.sales.salesOpen &&
        ticketType !== undefined &&
        ticketType.salesOpen &&
        availabilityIsPurchasable(availability);

      emit({
        event,
        availability,
        quantity,
        discountCode,
        participant,
        busy: false,
        step: purchasable ? "form" : "closed",
        problem: purchasable
          ? null
          : {
              kind: availability === "SOLD_OUT" ? "sold_out" : "sales_closed",
              title: availability === "SOLD_OUT" ? "Entradas agotadas" : "Venta no disponible",
              message:
                availability === "SOLD_OUT"
                  ? "Se agotaron las entradas para este evento."
                  : "La venta de entradas todavía no está abierta.",
              canRetry: false,
              canRetryPayment: false,
              canEditForm: false,
            },
      });
    } catch (error) {
      if (error instanceof AbortError) {
        return;
      }
      const problem = describeError(error);
      // A missing event is not an error the buyer can fix: show the friendly closed state.
      const closed = error instanceof ApiError && error.code === "NOT_FOUND";
      if (closed) {
        emit({
          busy: false,
          step: "closed",
          problem: {
            ...problem,
            title: "Venta no disponible",
            message:
              "El evento aún no está disponible para compra. Escríbenos y te avisamos cuando las ventas abran.",
          },
        });
        return;
      }

      // If the API fails or responds with network/transient error, keep the form
      // visible and accessible to the buyer, displaying the problem as a clear notice
      // without collapsing or hiding the buyer fields.
      emit({
        busy: false,
        step: "form",
        problem,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Form
  // -------------------------------------------------------------------------

  function setQuantity(quantity: number): void {
    const next = clamp(Math.trunc(quantity) || minQuantity(), minQuantity(), maxQuantity());
    emit({ quantity: next, quote: null, discountCode: next === 1 ? state.discountCode : "" });
    persistDraft();
  }

  function setDiscountCode(value: string): void {
    emit({ discountCode: value.trim().toUpperCase(), quote: null });
    persistDraft();
  }

  function setField(field: ParticipantField, value: string | boolean): void {
    emit({
      participant: { ...state.participant, [field]: value },
      issues: state.issues.filter((issue) => issue.field !== field),
    });
    persistDraft();
  }

  async function requestQuote(): Promise<void> {
    const issues = validateParticipantForm(state.participant);
    if (issues.length > 0) {
      emit({ issues, step: "form", problem: null });
      return;
    }
    emit({ issues: [], busy: true, step: "review", problem: null, quote: null });
    const signal = newSignal();
    try {
      const quote = await api.quote(
        {
          eventCode: config.eventCode,
          ticketTypeCode: config.ticketTypeCode,
          quantity: state.quantity,
          ...(eligibleDiscountCode() === undefined ? {} : { discountCode: eligibleDiscountCode() }),
        },
        signal,
      );
      if (quote.availability === "SOLD_OUT") {
        emit({
          busy: false,
          step: "problem",
          problem: {
            kind: "sold_out",
            title: "Entradas agotadas",
            message: "Se agotaron las entradas para este evento.",
            canRetry: false,
            canRetryPayment: false,
            canEditForm: true,
          },
        });
        return;
      }
      emit({ quote, busy: false });
    } catch (error) {
      if (error instanceof AbortError) {
        return;
      }
      emit({ busy: false, step: "form", problem: describeError(error), issues: [] });
    }
  }

  function backToForm(): void {
    abortInFlight();
    stopPolling();
    // Going back to edit invalidates the quote: the price shown on the review step must always
    // belong to the basket that produced it, so the next step re-quotes from scratch.
    emit({ step: "form", problem: null, issues: [], quote: null });
  }

  // -------------------------------------------------------------------------
  // Order creation + checkout handoff
  // -------------------------------------------------------------------------

  async function submit(): Promise<void> {
    // One intentional attempt, one order: a second click while the handoff is in flight, or
    // after it already happened, must never reach the backend again.
    if (state.step === "submitting" || state.step === "verifying" || state.step === "confirmed") {
      return;
    }
    if (state.quote === null) {
      await requestQuote();
      return;
    }
    idempotencyKey ??= generateIdempotencyKey();
    emit({ step: "submitting", busy: true, problem: null });
    const signal = newSignal();
    const buyerEmail = state.participant.email.trim().toLowerCase();
    try {
      const order = await api.createOrder(
        {
          eventCode: config.eventCode,
          ticketTypeCode: config.ticketTypeCode,
          quantity: state.quantity,
          ...(eligibleDiscountCode() === undefined ? {} : { discountCode: eligibleDiscountCode() }),
          buyer: {
            email: buyerEmail,
            fullName: `${state.participant.firstName} ${state.participant.lastName}`.trim(),
            phone: state.participant.phone,
          },
          participant: {
            firstName: state.participant.firstName.trim(),
            lastName: state.participant.lastName.trim(),
            nationalId: state.participant.nationalId,
            email: buyerEmail,
            phone: state.participant.phone,
            city: state.participant.city.trim(),
            ...(state.participant.instagram.trim().length === 0
              ? {}
              : { instagram: state.participant.instagram.trim() }),
            consents: {
              dataProcessing: state.participant.dataProcessing,
              futureEvents: state.participant.futureEvents,
            },
          },
          idempotencyKey,
        },
        signal,
      );

      // The order exists and is now correlated with this session for the return page.
      savePendingOrder(store, {
        reference: order.reference,
        buyerEmail,
        attempt: order.paymentAttempt,
        createdAt: new Date(now()).toISOString(),
      });
      // This attempt is settled, so the next purchase in this session must get its own key:
      // reusing it would make the backend replay THIS order instead of creating a new one.
      // (An attempt whose outcome is unknown keeps its key, so reopening and paying again
      // can never produce a second order for the same intent.)
      idempotencyKey = undefined;
      emit({
        busy: false,
        reference: order.reference,
        buyerEmail,
        checkout: order.checkout,
        step: "verifying",
        verificationAttempts: 0,
        verificationStartedAt: null,
      });
      options.onCheckout(order.checkout, order.reference);
      // Handing off to Wompi is not the end of this page's job: if the navigation is blocked
      // (or Wompi opens elsewhere) the buyer would otherwise sit on "verificando" forever.
      // The loop stops by itself the moment the tab unloads for the real checkout.
      void runPolling();
    } catch (error) {
      if (error instanceof AbortError) {
        return;
      }
      const problem = describeError(error);
      const issues = error instanceof ApiError ? issuesFromError(error) : [];
      emit({
        busy: false,
        step: issues.length > 0 ? "form" : "problem",
        problem: issues.length > 0 ? null : problem,
        issues,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Return + polling
  // -------------------------------------------------------------------------

  function adopt(order: { reference: string; buyerEmail: string }): void {
    emit({ reference: order.reference, buyerEmail: order.buyerEmail });
  }

  async function resumeReturn(returnOptions: {
    readonly transactionId?: string | undefined;
  }): Promise<void> {
    const pending = loadPendingOrder(store);
    if (pending === undefined) {
      emit({
        step: "problem",
        busy: false,
        problem: {
          kind: "not_found",
          title: "No pudimos ubicar tu compra en este navegador",
          message:
            "Usa la referencia de tu orden y el correo con el que compraste para consultar el estado de tu entrada.",
          canRetry: false,
          canRetryPayment: false,
          canEditForm: false,
        },
      });
      return;
    }
    adopt(pending);
    emit({ step: "verifying", busy: false, problem: null });
    await ensureEvent();
    // A payment hint only accelerates what the webhook would do anyway; it is never trusted.
    if (returnOptions.transactionId !== undefined && returnOptions.transactionId.length > 0) {
      await sendHint(returnOptions.transactionId);
    }
    await runPolling();
  }

  /**
   * Loads the public event when the flow did not start from the landing page.
   *
   * A resumed return has an order but no event, and the order status does not carry the event's
   * name, date or venue — so without this the ticket would show the landing copy, which can
   * disagree with the event the backend is actually selling. Best-effort: the ticket is issued by
   * the backend either way, so a failure here only costs the header.
   */
  async function ensureEvent(): Promise<void> {
    if (state.event !== null) {
      return;
    }
    const signal = newSignal();
    try {
      const event = await api.getEvent(config.eventCode, signal);
      emit({
        event,
        availability:
          selectTicketType(event, config.ticketTypeCode)?.availability ?? event.sales.availability,
      });
    } catch {
      // Keep the landing-page fallback; the ticket itself is unaffected.
    }
  }

  async function sendHint(transactionId: string): Promise<void> {
    const { reference, buyerEmail } = state;
    if (reference === null || buyerEmail === null) {
      return;
    }
    try {
      const hint = await api.sendPaymentHint(reference, buyerEmail, transactionId);
      emit({ hintOutcome: hint.outcome });
    } catch (error) {
      // A failed hint is not a failed payment: the webhook and the sweep still apply.
      if (!(error instanceof AbortError)) {
        emit({ hintOutcome: "HINT_FAILED" });
      }
    }
  }

  async function fetchStatus(signal: AbortSignal): Promise<OrderStatus> {
    if (state.reference === null || state.buyerEmail === null) {
      throw new NetworkError("No hay una orden activa para consultar.");
    }
    return api.getOrderStatus(state.reference, state.buyerEmail, signal);
  }

  function applyStatus(status: OrderStatus): void {
    const paymentStatus = status.payment?.status;
    if (status.status === "PAID") {
      // The session correlation is deliberately kept: a refresh or a reopened return URL must
      // be able to show the same ticket again (the backend re-answers the same order).
      emit({ step: "confirmed", busy: false, status, problem: null });
      return;
    }
    if (status.status === "FAILED") {
      emit({
        step: "problem",
        busy: false,
        status,
        problem: {
          kind: "declined",
          title: "El pago no fue aprobado",
          message:
            "Tu pago no fue aprobado y no se realizó ningún cobro. Puedes intentar con otro medio de pago.",
          canRetry: false,
          canRetryPayment: true,
          canEditForm: false,
        },
      });
      return;
    }
    if (isUnrecoverableOrderStatus(status.status)) {
      emit({
        step: "problem",
        busy: false,
        status,
        problem: {
          kind: "expired",
          title: "La reserva expiró",
          message:
            "El tiempo para completar el pago terminó y los cupos volvieron a estar disponibles. Puedes intentarlo de nuevo.",
          canRetry: false,
          canRetryPayment: true,
          canEditForm: false,
        },
      });
      return;
    }
    if (isDeclinedPaymentStatus(paymentStatus)) {
      emit({
        step: "problem",
        busy: false,
        status,
        problem: {
          kind: "declined",
          title: "El pago no fue aprobado",
          message:
            "Tu pago no fue aprobado y no se realizó ningún cobro. Puedes intentar con otro medio de pago.",
          canRetry: false,
          canRetryPayment: true,
          canEditForm: false,
        },
      });
    }
  }

  async function runPolling(): Promise<void> {
    stopPolling();
    const generation = pollGeneration;
    if (state.verificationStartedAt === null) {
      emit({ verificationStartedAt: now(), verificationAttempts: 0 });
    }
    await pollOnce(generation);
  }

  /** Runs one poll and schedules the next; a superseded generation stops silently. */
  async function pollOnce(generation: number): Promise<void> {
    if (disposed || generation !== pollGeneration) {
      return;
    }
    const signal = newSignal();
    try {
      const status = await fetchStatus(signal);
      // A superseded generation covers every way the loop can be retired meanwhile (dispose,
      // cancel, a newer refresh), so this single check is the whole guard.
      if (generation !== pollGeneration) {
        return;
      }
      const attempts = state.verificationAttempts + 1;
      applyStatus(status);
      if (state.step === "confirmed" || state.step === "problem") {
        return;
      }
      const elapsed = now() - (state.verificationStartedAt ?? now());
      if (elapsed >= pollMaxMs) {
        emit({ step: "pending", busy: false, status, verificationAttempts: attempts });
        return;
      }
      emit({ status, verificationAttempts: attempts, busy: false });
      pollTimer = setTimeout(() => void pollOnce(generation), pollIntervalMs);
    } catch (error) {
      if (error instanceof AbortError || generation !== pollGeneration) {
        return;
      }
      const problem = describeError(error);
      if (problem.kind === "not_found") {
        emit({ step: "problem", busy: false, problem });
        return;
      }
      // A transient failure while polling should not alarm the buyer: keep the verifying
      // screen and retry until the bounded window closes.
      const elapsed = now() - (state.verificationStartedAt ?? now());
      if (elapsed >= pollMaxMs) {
        emit({ step: "pending", busy: false, problem: null });
        return;
      }
      pollTimer = setTimeout(() => void pollOnce(generation), pollIntervalMs);
    }
  }

  async function refreshStatus(): Promise<void> {
    emit({
      step: "verifying",
      busy: true,
      problem: null,
      verificationStartedAt: now(),
      verificationAttempts: 0,
    });
    await runPolling();
  }

  async function retryPayment(): Promise<void> {
    const { reference, buyerEmail } = state;
    if (reference === null || buyerEmail === null) {
      return;
    }
    emit({ step: "submitting", busy: true, problem: null });
    const signal = newSignal();
    try {
      const retry = await api.retryPayment(reference, buyerEmail, signal);
      idempotencyKey = undefined;
      savePendingOrder(store, {
        reference: retry.reference,
        buyerEmail,
        attempt: retry.paymentAttempt,
        createdAt: new Date(now()).toISOString(),
      });
      emit({
        busy: false,
        checkout: retry.checkout,
        step: "verifying",
        verificationAttempts: 0,
        verificationStartedAt: null,
      });
      options.onCheckout(retry.checkout, retry.reference);
      void runPolling();
    } catch (error) {
      if (error instanceof AbortError) {
        return;
      }
      emit({ busy: false, step: "problem", problem: describeError(error, "payment") });
    }
  }

  async function recoverOrder(reference: string, buyerEmail: string): Promise<void> {
    const trimmedReference = reference.trim().toUpperCase();
    const normalizedEmail = buyerEmail.trim().toLowerCase();
    if (trimmedReference.length === 0 || normalizedEmail.length === 0) {
      emit({
        step: "problem",
        busy: false,
        problem: {
          kind: "not_found",
          title: "Completa los datos",
          message: "Escribe la referencia de tu orden y el correo con el que compraste.",
          canRetry: false,
          canRetryPayment: false,
          canEditForm: false,
        },
      });
      return;
    }
    idempotencyKey = undefined;
    adopt({ reference: trimmedReference, buyerEmail: normalizedEmail });
    savePendingOrder(store, {
      reference: trimmedReference,
      buyerEmail: normalizedEmail,
      attempt: 1,
      createdAt: new Date(now()).toISOString(),
    });
    emit({
      step: "verifying",
      busy: true,
      problem: null,
      verificationStartedAt: now(),
      verificationAttempts: 0,
    });
    await ensureEvent();
    await runPolling();
  }

  function cancel(): void {
    abortInFlight();
    stopPolling();
    emit({ busy: false });
  }

  function dispose(): void {
    disposed = true;
    abortInFlight();
    stopPolling();
    listeners.clear();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    setQuantity,
    setDiscountCode,
    setField,
    requestQuote,
    backToForm,
    submit,
    resumeReturn,
    refreshStatus,
    retryPayment,
    recoverOrder,
    cancel,
    dispose,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
