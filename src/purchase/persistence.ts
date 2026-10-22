/**
 * Purchase persistence (Phase 6B).
 *
 * Three small jobs, all browser-local:
 *
 *   1. Generate the `Idempotency-Key` used on `POST /orders`. The backend stores a partial
 *      unique index on it, so the SAME key + the same buyer can only ever create ONE order:
 *      a double click, a network retry or a component re-render can not duplicate a purchase.
 *      We keep the key stable for the whole lifetime of one submission and rotate it only
 *      when the buyer intentionally starts a new attempt.
 *
 *   2. Remember the order that was created (`reference` + buyer email) so the return page,
 *      a refresh, or reopening the URL can find the authoritative state again. That is the
 *      correlation the confirmation screen needs; it is NOT proof of payment. The entry is
 *      kept after a confirmed payment on purpose: reopening the return URL or refreshing the
 *      page then shows the same ticket again (re-read from the backend) instead of an empty
 *      form. A later purchase simply overwrites it.
 *
 *   3. Remember the in-progress form values, so a validation or network failure (and even a
 *      reload) does not force the buyer to retype everything. Consent checkboxes are
 *      deliberately NOT restored checked.
 *
 * `sessionStorage` is used (not `localStorage`): the correlation belongs to this browsing
 * session, and it survives a refresh or a navigation to Wompi and back.
 */

import type { ParticipantFormValues } from "./validation.ts";

const PENDING_ORDER_KEY = "ticket:pending-order:v1";
const DRAFT_KEY = "ticket:purchase-draft:v1";

export type PendingOrder = {
  readonly reference: string;
  readonly buyerEmail: string;
  readonly attempt: number;
  readonly createdAt: string;
};

export type PurchaseDraft = {
  readonly quantity: number;
  readonly discountCode: string;
  readonly participant: Omit<ParticipantFormValues, "dataProcessing" | "futureEvents">;
};

/** Minimal storage surface, so tests can pass a fake without a DOM. */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/* v8 ignore start -- the fallback store is only used when sessionStorage is unavailable. */
function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}
/* v8 ignore stop */

let fallbackStore: KeyValueStore | undefined;

/** Returns `sessionStorage` when available, otherwise an in-memory stand-in. */
export function defaultStore(): KeyValueStore {
  try {
    if (typeof sessionStorage !== "undefined") {
      return sessionStorage;
    }
  } catch {
    // Access can throw in privacy modes; fall through to memory.
  }
  fallbackStore ??= memoryStore();
  return fallbackStore;
}

/**
 * Generates an idempotency key that satisfies the backend contract
 * (16–128 printable ASCII characters).
 */
export function generateIdempotencyKey(
  randomUuid: () => string = () => crypto.randomUUID(),
): string {
  return `order-${randomUuid()}`;
}

/**
 * Reads, parses and validates one stored value. Anything unreadable (corrupt JSON, or a
 * value that no longer has the expected shape after an app update) is discarded on the spot
 * so the buyer starts from a clean state rather than a half-restored one.
 */
function readStored<T>(
  store: KeyValueStore,
  key: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  const raw = store.getItem(key);
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    store.removeItem(key);
    return undefined;
  }
  const value = parse(parsed);
  if (value === undefined) {
    store.removeItem(key);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asPendingOrder(value: unknown): PendingOrder | undefined {
  const record = asRecord(value);
  const reference = asString(record?.reference);
  const buyerEmail = asString(record?.buyerEmail);
  if (record === undefined || reference === undefined || buyerEmail === undefined) {
    return undefined;
  }
  return {
    reference,
    buyerEmail,
    attempt: typeof record.attempt === "number" ? record.attempt : 1,
    createdAt: asString(record.createdAt) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Pending order correlation
// ---------------------------------------------------------------------------

export function savePendingOrder(store: KeyValueStore, order: PendingOrder): void {
  store.setItem(PENDING_ORDER_KEY, JSON.stringify(order));
}

export function loadPendingOrder(store: KeyValueStore): PendingOrder | undefined {
  return readStored(store, PENDING_ORDER_KEY, asPendingOrder);
}

// ---------------------------------------------------------------------------
// Draft (form values, consent NOT restored)
// ---------------------------------------------------------------------------

export function saveDraft(store: KeyValueStore, draft: PurchaseDraft): void {
  store.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function loadDraft(store: KeyValueStore): PurchaseDraft | undefined {
  return readStored(store, DRAFT_KEY, (value) => {
    const record = asRecord(value);
    if (record === undefined || typeof record.quantity !== "number") {
      return undefined;
    }
    return {
      quantity: record.quantity,
      discountCode: asString(record.discountCode) ?? "",
      participant: participantFields(record.participant),
    };
  });
}

/** Only the fields the buyer typed are restored; the consents are never part of a draft. */
function participantFields(value: unknown): PurchaseDraft["participant"] {
  const record = asRecord(value);
  return {
    firstName: asString(record?.firstName) ?? "",
    lastName: asString(record?.lastName) ?? "",
    nationalId: asString(record?.nationalId) ?? "",
    email: asString(record?.email) ?? "",
    phone: asString(record?.phone) ?? "",
    city: asString(record?.city) ?? "",
    instagram: asString(record?.instagram) ?? "",
  };
}

/**
 * Restores form values from a saved draft. The consent checkboxes are always returned
 * unchecked: consent must be a fresh, deliberate action by the buyer.
 */
export function participantFromDraft(
  draft: PurchaseDraft | undefined,
  blank: ParticipantFormValues,
): ParticipantFormValues {
  if (draft === undefined) {
    return blank;
  }
  return {
    ...blank,
    ...draft.participant,
    dataProcessing: false,
    futureEvents: false,
  };
}
