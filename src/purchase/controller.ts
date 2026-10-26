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
 *             └── issues ◄────┘                                 ├──► pending     └──► companion
 *                                                               └──► problem ──retry──► submitting
 *
 * Payment truth ALWAYS comes from `GET /orders/{reference}` (or the same data re-read after a
 * payment hint). A return from ePayco only tells us *which* order to ask about; it never
 * proves anything. Tickets are discontinued: the confirmation is the PAID order itself, and
 * the second person of a two-admission purchase is attached through the participant endpoint.
 */

import {
  AbortError,
  ApiError,
  NetworkError,
  createApiClient,
  type ApiClient,
} from "../api/client.ts";
import { createTicketingApi, type TicketingApi } from "../api/ticketing.ts";
import {
  isEpaycoCheckout,
  type AvailabilityLabel,
  type EpaycoCheckout,
  type OrderStatus,
  type PublicEvent,
  type Quote,
} from "../api/types.ts";

/** One assigned person of the paid order, as projected by `GET /orders/{reference}`. */
export type OrderParticipant = OrderStatus["participants"][number];
import type { FrontendConfig } from "../config/env.ts";
import { PACKAGE_ADMISSIONS, type PackageCode } from "./package-availability.ts";
import { normalizeReturnedReference } from "./return-route.ts";
import { effectiveMaxQuantity, selectTicketType } from "./ticket-selection.ts";
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

export type CompanionStatus = "idle" | "submitting" | "saved" | "unavailable" | "error";

export type PurchaseState = {
  readonly step: PurchaseStep;
  readonly busy: boolean;
  readonly event: PublicEvent | null;
  readonly availability: AvailabilityLabel;
  readonly quantity: number;
  readonly bundleCode: PackageCode | null;
  readonly discountCode: string;
  readonly participant: ParticipantFormValues;
  readonly issues: readonly FieldIssue[];
  readonly quote: Quote | null;
  readonly reference: string | null;
  readonly buyerEmail: string | null;
  readonly checkout: EpaycoCheckout | null;
  readonly status: OrderStatus | null;
  readonly problem: PurchaseProblem | null;
  readonly verificationAttempts: number;
  readonly verificationStartedAt: number | null;
  /** Set when a payment hint was sent, so the UI can explain the acceleration. */
  readonly hintOutcome: string | null;
  /**
   * Values for the "consultar mi compra" form when a return could not resolve itself.
   *
   * The return URL names the order (`?ref=EVT-…`), so a buyer whose browser lost the session
   * (another tab, a cleared session, another device) never has to retype what the link said.
   */
  readonly recoveryPrefill: { readonly reference: string; readonly email: string } | null;
  /** Second person of a two-admission purchase; never persisted to storage. */
  readonly companion: ParticipantFormValues;
  readonly companionIssues: readonly FieldIssue[];
  readonly companionStatus: CompanionStatus;
  readonly companionError: string | null;
  readonly companionName: string | null;
  /** Admissions still free in the order, as reported by the backend. */
  readonly remainingAdmissions: number | null;
  /**
   * People the backend says are assigned to this order (unit 1 is the holder). It is the
   * refresh-proof source of the confirmation: a saved companion survives a reload even
   * though the companion form itself is never persisted.
   */
  readonly participants: readonly OrderParticipant[];
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
  /** Opens the ePayco Smart Checkout V2 session. It is the only payment provider. */
  readonly onCheckout: (checkout: EpaycoCheckout, reference: string) => void;
  readonly polling?: { readonly intervalMs?: number; readonly maxDurationMs?: number };
};

export type PurchaseController = {
  getState(): PurchaseState;
  subscribe(listener: (state: PurchaseState) => void): () => void;
  start(): Promise<void>;
  setQuantity(quantity: number): void;
  setBundleCode(bundleCode: PackageCode | null): void;
  setDiscountCode(value: string): void;
  setField(field: ParticipantField, value: string | boolean): void;
  setCompanionField(field: ParticipantField, value: string | boolean): void;
  submitCompanion(): Promise<void>;
  requestQuote(): Promise<void>;
  backToForm(): void;
  submit(): Promise<void>;
  resumeReturn(options: {
    readonly reference?: string | undefined;
    readonly transactionId?: string | undefined;
  }): Promise<void>;
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
    bundleCode: null,
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
    recoveryPrefill: null,
    companion: EMPTY_PARTICIPANT_FORM,
    companionIssues: [],
    companionStatus: "idle",
    companionError: null,
    companionName: null,
    remainingAdmissions: null,
    participants: [],
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
        // A checkout-session refusal names its cause in `details.reason`. "No pudimos abrir el
        // pago" is the honest answer for an invoice ePayco may already hold: the reservation is
        // still valid and the fix is a new attempt, not a new ticket selection.
        if (error.reason === "SESSION_CALL_UNRESOLVED") {
          return {
            kind: "upstream",
            title: "No pudimos abrir el pago",
            message:
              "Tu reserva sigue activa, pero no logramos abrir una sesión de pago para este intento. No se realizó ningún cobro. Escríbenos y lo revisamos contigo.",
            canRetry: false,
            canRetryPayment: false,
            canEditForm: false,
          };
        }
        // The envelope does not expose any other raw reason (the SQLSTATE detail is never
        // surfaced), so the sentence depends on what was being attempted.
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

/**
 * A checkout payload that is not ePayco means the deployment is misconfigured, not that the
 * buyer did something wrong. Never open another gateway silently.
 */
function providerUnavailable(): PurchaseProblem {
  return {
    kind: "upstream",
    title: "Pasarela de pago no disponible",
    message:
      "El pago con ePayco no está disponible en este momento. Escríbenos y lo revisamos contigo.",
    canRetry: false,
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

  /** A new purchase starts with no companion data and no assumption about the order. */
  function resetCompanion(): void {
    emit({
      companion: EMPTY_PARTICIPANT_FORM,
      companionIssues: [],
      companionStatus: "idle",
      companionError: null,
      companionName: null,
      remainingAdmissions: null,
      participants: [],
    });
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
      quantity: state.bundleCode === null ? state.quantity : PACKAGE_ADMISSIONS,
      discountCode: state.bundleCode === null ? state.discountCode : "",
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
    return effectiveMaxQuantity(
      selectTicketType(state.event, config.ticketTypeCode),
      MAX_QUANTITY_FALLBACK,
    );
  }

  function minQuantity(): number {
    return Math.max(1, selectTicketType(state.event, config.ticketTypeCode)?.minPerOrder ?? 1);
  }

  function eligibleDiscountCode(): string | undefined {
    const ticketType = selectTicketType(state.event, config.ticketTypeCode);
    if (
      state.bundleCode !== null ||
      state.quantity !== 1 ||
      ticketType?.currentTier?.name !== "General"
    )
      return undefined;
    return state.discountCode.length === 0 ? undefined : state.discountCode;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async function start(): Promise<void> {
    const draft = loadDraft(store);
    const quantity =
      state.bundleCode !== null
        ? PACKAGE_ADMISSIONS
        : clamp(draft?.quantity ?? state.quantity, 1, MAX_QUANTITY_FALLBACK);
    const savedDiscountCode =
      state.bundleCode === null && quantity === 1
        ? (draft?.discountCode ?? state.discountCode)
        : "";
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
      companion: EMPTY_PARTICIPANT_FORM,
      companionIssues: [],
      companionStatus: "idle",
      companionError: null,
      companionName: null,
      remainingAdmissions: null,
      participants: [],
    });

    const signal = newSignal();
    try {
      const event = await api.getEvent(config.eventCode, signal);
      const ticketType = selectTicketType(event, config.ticketTypeCode);
      const availability = ticketType?.availability ?? event.sales.availability;
      // A draft saved during another stage (or before the stage cap existed) must not survive
      // into this one: Preventa sells one admission per payment, and anything larger would be
      // refused by the quote with QUANTITY_LIMIT.
      const max = effectiveMaxQuantity(ticketType, MAX_QUANTITY_FALLBACK);
      const min = Math.max(1, ticketType?.minPerOrder ?? 1);
      const restoredQuantity = state.bundleCode === null ? clamp(quantity, min, max) : quantity;
      const discountCode =
        restoredQuantity === 1 && ticketType?.currentTier?.name === "General"
          ? savedDiscountCode
          : "";
      const purchasable =
        event.sales.salesOpen &&
        ticketType !== undefined &&
        ticketType.salesOpen &&
        availabilityIsPurchasable(availability);

      emit({
        event,
        availability,
        quantity: restoredQuantity,
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
    if (state.bundleCode !== null) {
      return;
    }
    const next = clamp(Math.trunc(quantity) || minQuantity(), minQuantity(), maxQuantity());
    emit({ quantity: next, quote: null, discountCode: next === 1 ? state.discountCode : "" });
    persistDraft();
  }

  function setBundleCode(bundleCode: PackageCode | null): void {
    const leavingBundle = state.bundleCode !== null && bundleCode === null;
    const quantity = bundleCode !== null ? PACKAGE_ADMISSIONS : leavingBundle ? 1 : state.quantity;
    emit({
      bundleCode,
      quantity,
      discountCode: bundleCode !== null || leavingBundle ? "" : state.discountCode,
      quote: null,
    });
    if (leavingBundle) {
      persistDraft();
    }
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

  /**
   * Companion data is deliberately NOT persisted: it is personal data of a third party and
   * only needs to live for the attach request of this session.
   */
  function setCompanionField(field: ParticipantField, value: string | boolean): void {
    emit({
      companion: { ...state.companion, [field]: value },
      companionIssues: state.companionIssues.filter((issue) => issue.field !== field),
      ...(state.companionStatus === "error" ? { companionStatus: "idle" as const } : {}),
    });
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
          ...(state.bundleCode === null ? {} : { bundleCode: state.bundleCode }),
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
    resetCompanion();
    const signal = newSignal();
    const buyerEmail = state.participant.email.trim().toLowerCase();
    try {
      const order = await api.createOrder(
        {
          eventCode: config.eventCode,
          ticketTypeCode: config.ticketTypeCode,
          quantity: state.quantity,
          ...(state.bundleCode === null ? {} : { bundleCode: state.bundleCode }),
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
        checkout: isEpaycoCheckout(order.checkout) ? order.checkout : null,
        step: "verifying",
        verificationAttempts: 0,
        verificationStartedAt: null,
      });
      if (!isEpaycoCheckout(order.checkout)) {
        // ePayco is the only provider this site sells with. A different checkout payload is a
        // configuration error, never something to hand the buyer: say so instead of opening
        // an unconfigured gateway.
        emit({ step: "problem", busy: false, problem: providerUnavailable() });
        return;
      }
      options.onCheckout(order.checkout, order.reference);
      // Handing off to ePayco is not the end of this page's job: if the modal is blocked the
      // buyer would otherwise sit on "verificando" forever. The loop stops by itself the
      // moment the tab unloads for the real checkout.
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
  // Companion (second admission of a two-admission purchase)
  // -------------------------------------------------------------------------

  /**
   * Attaches the second person to a PAID order.
   *
   * No ticket is created: the backend uses the order's admissions and reports how many are
   * still free. The request needs the buyer email because the participant endpoint applies the
   * same reference+email possession rule as the status endpoint.
   */
  async function submitCompanion(): Promise<void> {
    const { reference, buyerEmail } = state;
    if (reference === null || buyerEmail === null) {
      return;
    }
    if (state.companionStatus === "submitting" || state.companionStatus === "saved") {
      return;
    }
    const quantity = state.status?.quantity ?? 0;
    if (quantity <= 1 || (state.remainingAdmissions ?? quantity - 1) <= 0) {
      emit({
        companionStatus: "unavailable",
        companionError: "Esta compra no tiene más participantes por registrar.",
      });
      return;
    }
    const issues = validateParticipantForm(state.companion);
    if (issues.length > 0) {
      emit({ companionIssues: issues, companionStatus: "idle", companionError: null });
      return;
    }
    emit({ companionIssues: [], companionStatus: "submitting", companionError: null });
    const signal = newSignal();
    try {
      const attached = await api.attachParticipant(
        reference,
        buyerEmail,
        {
          firstName: state.companion.firstName.trim(),
          lastName: state.companion.lastName.trim(),
          nationalId: state.companion.nationalId,
          email: state.companion.email.trim().toLowerCase(),
          phone: state.companion.phone,
          city: state.companion.city.trim(),
          ...(state.companion.instagram.trim().length === 0
            ? {}
            : { instagram: state.companion.instagram.trim() }),
          consents: {
            dataProcessing: state.companion.dataProcessing,
            futureEvents: state.companion.futureEvents,
          },
        },
        signal,
      );
      const attachedParticipant: OrderParticipant = {
        unit: attached.unit,
        firstName: attached.participant.firstName,
        lastName: attached.participant.lastName,
      };
      emit({
        companionStatus: "saved",
        companionName: `${attached.participant.firstName} ${attached.participant.lastName}`.trim(),
        remainingAdmissions: attached.remainingUnassigned,
        // Keep the roster in sync locally so the confirmation shows the new person without
        // waiting for another status round-trip. A unit can never appear twice.
        participants: [
          ...state.participants.filter((person) => person.unit !== attached.unit),
          attachedParticipant,
        ].sort((left, right) => left.unit - right.unit),
        companionIssues: [],
        companionError: null,
      });
    } catch (error) {
      if (error instanceof AbortError) {
        return;
      }
      if (error instanceof ApiError && error.code === "CONFLICT") {
        // The backend enforces capacity: the order is already fully assigned. This is also
        // what a buyer who reopened the confirmation and resubmitted sees.
        emit({
          companionStatus: "unavailable",
          companionError: "Esta compra ya tiene registrados todos sus participantes.",
        });
        return;
      }
      emit({ companionStatus: "error", companionError: describeError(error).message });
    }
  }

  // -------------------------------------------------------------------------
  // Return + polling
  // -------------------------------------------------------------------------

  function adopt(order: { reference: string; buyerEmail: string }): void {
    emit({ reference: order.reference, buyerEmail: order.buyerEmail });
  }

  async function resumeReturn(returnOptions: {
    readonly reference?: string | undefined;
    readonly transactionId?: string | undefined;
  }): Promise<void> {
    const pending = loadPendingOrder(store);
    // The provider's return URL names the order (`?ref=EVT-…`); sessionStorage is the fallback for
    // links that carry nothing. The reference only points at WHICH order to ask about — the buyer
    // email is still required, and the backend answers the same 404 for a wrong email as for an
    // unknown order, so naming an order reveals nothing.
    const returnedReference = normalizeReturnedReference(returnOptions.reference);
    const reference = returnedReference ?? pending?.reference;
    const storedEmail = pending?.reference === reference ? pending?.buyerEmail : undefined;

    if (reference === undefined || storedEmail === undefined) {
      emit({
        step: "problem",
        busy: false,
        problem:
          reference === undefined
            ? {
                kind: "not_found",
                title: "No pudimos ubicar tu compra en este navegador",
                message:
                  "Usa la referencia de tu orden y el correo con el que compraste para consultar el estado de tu compra.",
                canRetry: false,
                canRetryPayment: false,
                canEditForm: false,
              }
            : {
                kind: "not_found",
                title: "Confirma el correo de tu compra",
                message: `Encontramos la orden ${reference}. Escribe el correo con el que compraste para mostrarte el estado de tu compra.`,
                canRetry: false,
                canRetryPayment: false,
                canEditForm: false,
              },
        recoveryPrefill: { reference: reference ?? "", email: storedEmail ?? "" },
      });
      return;
    }
    adopt({ reference, buyerEmail: storedEmail });
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
   * name, date or venue — so without this the confirmation would show the landing copy, which
   * can disagree with the event the backend actually sold. Best-effort: the order is confirmed
   * either way, so a failure here only costs the header.
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
      // Keep the landing-page fallback; the confirmation itself is unaffected.
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
      // be able to show the same confirmed purchase again (the backend re-answers the same
      // order). The backend's roster, not local memory, decides whether the companion is
      // already registered — that is what makes a reload show the truth instead of the form.
      const participants = status.participants;
      const remaining = status.admissions.remainingUnassigned;
      const companions = participants.filter((person) => person.unit > 1);
      const lastCompanion = companions[companions.length - 1];
      const companionName =
        lastCompanion === undefined
          ? state.companionName
          : `${lastCompanion.firstName} ${lastCompanion.lastName}`.trim();
      // A submission in flight owns its status: a background refresh must not replace the
      // spinner with a form that would send the same person twice. Otherwise the roster is
      // the truth: a companion row means registered, no free admission means nothing left to
      // attach (a fully assigned order whose roster is not visible is never called "saved"
      // with an empty name).
      const companionStatus: CompanionStatus =
        state.companionStatus === "submitting"
          ? "submitting"
          : companions.length > 0
            ? "saved"
            : status.quantity > 1 && remaining <= 0
              ? "unavailable"
              : "idle";
      emit({
        step: "confirmed",
        busy: false,
        status,
        problem: null,
        remainingAdmissions: remaining,
        participants,
        companionStatus,
        companionName,
        ...(companionStatus === "idle" ? { companionError: null } : {}),
      });
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
        checkout: isEpaycoCheckout(retry.checkout) ? retry.checkout : null,
        step: "verifying",
        verificationAttempts: 0,
        verificationStartedAt: null,
      });
      if (!isEpaycoCheckout(retry.checkout)) {
        emit({ step: "problem", busy: false, problem: providerUnavailable() });
        return;
      }
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
    setBundleCode,
    setDiscountCode,
    setField,
    setCompanionField,
    submitCompanion,
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
