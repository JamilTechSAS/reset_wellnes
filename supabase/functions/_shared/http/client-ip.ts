/**
 * Client IP resolution for Edge Functions.
 *
 * WHY NOT THE FIRST `x-forwarded-for` ENTRY
 * A client can send its own `x-forwarded-for`; the platform does not replace it, it APPENDS
 * the real address (observed on Supabase: `x-forwarded-for: <spoofed>,<real>`, see
 * github.com/orgs/supabase/discussions/34647). Reading the FIRST entry would therefore let a
 * caller choose its own rate-limit bucket — and poison the order's fraud field — by rotating
 * the header on every request. Resolution order:
 *
 *   1. `cf-connecting-ip` — set (and overwritten) by Cloudflare in front of Supabase, so it
 *      is not client-controlled;
 *   2. the LAST valid `x-forwarded-for` entry — the address the closest trusted proxy
 *      appended after any caller-supplied entries;
 *   3. `x-real-ip` — fallback for other proxies.
 *
 * A value that is empty, too long or not shaped like an IP address is ignored entirely. The
 * caller then cannot be keyed, and every consumer handles that explicitly: the rate-limit
 * guard fails open instead of sharing a bucket, and `orders.ip_address` stays empty rather
 * than recording attacker-chosen text. The value is never logged raw and never returned in a
 * response.
 *
 * On a local runtime (`supabase functions serve`) none of these headers exist and the
 * result is `undefined`; the behaviour above is then visible as "no IP-based limit",
 * which is the documented development mode.
 */

/** Longest IPv6 textual form is 45 characters; 64 leaves margin without unbounded input. */
const MAX_IP_LENGTH = 64;

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function normalizeIpv4(value: string): string | undefined {
  if (!IPV4_PATTERN.test(value)) {
    return undefined;
  }
  // Octets are re-checked: `999.1.2.3` is not an address and must not become a bucket.
  return value.split(".").every((octet) => Number(octet) <= 255) ? value : undefined;
}

/**
 * IPv6 textual forms (compressed, mapped, loopback) contain hex digits and at least two
 * colons. A single colon is the `ip:port` form of an IPv4 address, which is handled
 * separately, so it is never accepted as an address here.
 */
function looksLikeIpv6(value: string): boolean {
  return /^[0-9a-fA-F:]+$/.test(value) && (value.match(/:/g)?.length ?? 0) >= 2;
}

/**
 * Normalizes one candidate header value into a bare address, or undefined.
 *
 * Ports are STRIPPED, never kept: some proxies append `ip:port`, and the ephemeral source
 * port changes on every connection, so keeping it would give one client a fresh rate-limit
 * bucket per request. The address is the stable identity; the port is not.
 */
function normalizeCandidate(raw: string | null | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0 || value.length > MAX_IP_LENGTH) {
    return undefined;
  }

  // `[2001:db8::1]:443` -> `2001:db8::1`
  const bracketed = /^\[([0-9a-fA-F:]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed?.[1] !== undefined) {
    return bracketed[1];
  }

  // `203.0.113.9:443` -> `203.0.113.9`
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (ipv4WithPort?.[1] !== undefined) {
    return normalizeIpv4(ipv4WithPort[1]);
  }

  const ipv4 = normalizeIpv4(value);
  if (ipv4 !== undefined) {
    return ipv4;
  }

  return looksLikeIpv6(value) ? value : undefined;
}

export function resolveClientIp(request: Request): string | undefined {
  const connecting = normalizeCandidate(request.headers.get("cf-connecting-ip"));
  if (connecting !== undefined) {
    return connecting;
  }

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const entries = forwarded.split(",");
    // The trusted proxy appends the real address AFTER any client-supplied entries, so the
    // last valid entry is the closest thing to the source address we can trust.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const candidate = normalizeCandidate(entries[index]);
      if (candidate !== undefined) {
        return candidate;
      }
    }
  }

  return normalizeCandidate(request.headers.get("x-real-ip"));
}
