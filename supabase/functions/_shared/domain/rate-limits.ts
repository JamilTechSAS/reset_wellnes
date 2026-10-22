/**
 * Rate-limit policy: scopes, keys and the documented limits.
 *
 * Abuse control for a one-page event (~120 buyers). The goal is stopping scripted abuse,
 * token guessing and enumeration — NOT throttling legitimate attendees, so every limit is
 * deliberately generous. Counters live in PostgreSQL (migration 20261003210014); there is
 * no Redis in this architecture.
 *
 * Key choice matters more than the numbers:
 *   * `ip`       — per source address, for endpoints where one abusive client must be
 *                  slowed without touching anyone else. The venue's shared network can put
 *                  many attendees behind one address, so IP limits are the loosest.
 *   * `reference` — per order reference, so polling or retrying one order cannot exhaust an
 *                  IP shared by a whole venue, and a guessed reference cannot be probed at
 *                  speed.
 *   * `operator` — per authenticated operator identity (check-in is a rapid, legitimate
 *                  loop at the door).
 *
 * A wrong email / unknown reference lookup is deliberately NOT a key: the response is
 * identical for both cases, and keying by reference keeps the anti-enumeration property
 * while still bounding attempts on a single reference.
 */

export const RATE_LIMIT_SCOPES = [
  "events:read",
  "orders:quote",
  "orders:create",
  "orders:retry",
  "orders:status",
  "orders:participants",
  "orders:hint",
  "tickets:lookup",
  "checkin:attempt",
  "checkin:operator",
] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export type RateLimitKeyKind = "ip" | "reference" | "token" | "operator";

export type RateLimitRule = {
  /** Maximum requests inside one fixed window. */
  readonly limit: number;
  readonly windowSeconds: number;
  readonly keyKind: RateLimitKeyKind;
};

/**
 * Documented limits (docs/api.md mirrors this table).
 *
 * Rationale per scope:
 *   events:read       — a landing page fetching at most a few times per visit; 240/min is
 *                       far above real traffic and still stops scraping loops.
 *   orders:quote      — the checkout may quote while typing; 120/min per IP.
 *   orders:create     — an order reserves inventory; 20/h per IP is generous for a buyer
 *                       fixing mistakes and hostile to scripted stock reservation.
 *   orders:retry      — a new payment attempt changes real money state; 20/h per ORDER.
 *   orders:status     — polling once per second while PENDING; 300/5 min per order.
 *   orders:participants — assigning N−1 units; 60/h per order (max_per_order is single
 *                       digits today).
 *   orders:hint       — the buyer posts the transaction id Wompi returned; 30/h per order
 *                       covers a buyer retrying the return page.
 *   tickets:lookup    — a ticket page refresh; 120/min per IP, tokens have 100 bits of
 *                       entropy so guessing is already infeasible.
 *   checkin:attempt   — consumed only when a request arrives WITHOUT a valid Supabase Auth
 *                       token (or with an invalid one): bounds credential stuffing without
 *                       ever throttling a real operator, which matters because the whole
 *                       venue may share one NAT address.
 *   checkin:operator  — 600 admission checks per minute per operator: far above the ~120
 *                       attendees of the whole event.
 */
export const RATE_LIMIT_RULES: Record<RateLimitScope, RateLimitRule> = {
  "events:read": { limit: 240, windowSeconds: 60, keyKind: "ip" },
  "orders:quote": { limit: 120, windowSeconds: 60, keyKind: "ip" },
  "orders:create": { limit: 20, windowSeconds: 3600, keyKind: "ip" },
  "orders:retry": { limit: 20, windowSeconds: 3600, keyKind: "reference" },
  "orders:status": { limit: 300, windowSeconds: 300, keyKind: "reference" },
  "orders:participants": { limit: 60, windowSeconds: 3600, keyKind: "reference" },
  "orders:hint": { limit: 30, windowSeconds: 3600, keyKind: "reference" },
  "tickets:lookup": { limit: 120, windowSeconds: 60, keyKind: "ip" },
  "checkin:attempt": { limit: 120, windowSeconds: 60, keyKind: "ip" },
  "checkin:operator": { limit: 600, windowSeconds: 60, keyKind: "operator" },
};

export function isRateLimitScope(value: string): value is RateLimitScope {
  return (RATE_LIMIT_SCOPES as readonly string[]).includes(value);
}

/** Prefixes keep a key space collision-free: an IP string can never look like a reference. */
const KEY_PREFIXES: Record<RateLimitKeyKind, string> = {
  ip: "ip",
  reference: "ref",
  token: "tkt",
  operator: "op",
};

export const RATE_LIMIT_MAX_KEY_LENGTH = 300;

/**
 * Builds the namespaced key the database hashes with md5. Returns `undefined` for an empty
 * or oversized identifier: a request that cannot be keyed must not silently share (or
 * poison) another bucket, so callers treat it as "not rate limited yet".
 */
export function rateLimitKey(kind: RateLimitKeyKind, identifier: string): string | undefined {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const key = `${KEY_PREFIXES[kind]}:${trimmed}`;
  if (key.length > RATE_LIMIT_MAX_KEY_LENGTH) {
    return undefined;
  }
  return key;
}

/**
 * Counters older than this are deleted by the maintenance run. Two hours covers the
 * largest window (1 h) with a wide margin.
 */
export const RATE_LIMIT_CLEANUP_HORIZON_SECONDS = 7200;
