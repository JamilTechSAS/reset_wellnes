/**
 * Regression tests for client IP resolution.
 *
 * The security property under test: a caller that supplies its own `x-forwarded-for` must
 * NOT be able to choose the value used for rate-limit buckets (or the order's fraud field).
 * Supabase/Cloudflare appends the real address after caller-supplied entries, and
 * `cf-connecting-ip` carries the non-forgeable value, so the resolver must prefer those —
 * never the first `x-forwarded-for` entry.
 */

import { describe, expect, it } from "vitest";

import { resolveClientIp } from "@shared/http/client-ip.ts";

function request(headers: Record<string, string>): Request {
  return new Request("https://api.example.test/orders", { headers });
}

describe("client IP resolution", () => {
  it("prefers cf-connecting-ip over anything a client sends", () => {
    expect(
      resolveClientIp(
        request({
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "1.2.3.4, 198.51.100.7",
          "x-real-ip": "192.0.2.1",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("takes the LAST x-forwarded-for entry, never the caller-supplied first one", () => {
    // Cloudflare appends the real address after the spoofed prefix.
    expect(
      resolveClientIp(
        request({
          "x-forwarded-for": "spoofed-by-the-client, 203.0.113.9",
        }),
      ),
    ).toBe("203.0.113.9");

    expect(
      resolveClientIp(
        request({
          "x-forwarded-for": "evil-one, evil-two, 203.0.113.9",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("accepts a single well-formed entry and trims whitespace", () => {
    expect(
      resolveClientIp(
        request({
          "x-forwarded-for": "  203.0.113.9  ",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("accepts IPv6 forms, including bracketed ones with a port", () => {
    expect(resolveClientIp(request({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(resolveClientIp(request({ "x-forwarded-for": "[2001:db8::1]:443" }))).toBe(
      "2001:db8::1",
    );
    expect(resolveClientIp(request({ "x-forwarded-for": "::1" }))).toBe("::1");
  });

  it("strips an IPv4 port so one client cannot rotate buckets per connection", () => {
    // A proxy that appends `ip:port` must not give every connection its own bucket: the
    // address is the identity, the ephemeral source port is not.
    expect(resolveClientIp(request({ "x-forwarded-for": "203.0.113.9:443" }))).toBe("203.0.113.9");
    expect(resolveClientIp(request({ "x-forwarded-for": "203.0.113.9:51234" }))).toBe(
      "203.0.113.9",
    );
  });

  it("rejects address-shaped values that are not addresses", () => {
    // Out-of-range octets and a lone `a:b` pair are not addresses; they must not become
    // bucket keys.
    expect(resolveClientIp(request({ "x-forwarded-for": "999.1.2.3" }))).toBeUndefined();
    expect(resolveClientIp(request({ "x-forwarded-for": "1:2" }))).toBeUndefined();
    expect(
      resolveClientIp(request({ "cf-connecting-ip": "999.1.2.3", "x-real-ip": "203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  it("rejects a non-address spoof instead of using it as a bucket key", () => {
    // A client that sends only `x-forwarded-for: spoofed` must not be keyed by that text.
    expect(resolveClientIp(request({ "x-forwarded-for": "spoofed" }))).toBeUndefined();
    expect(
      resolveClientIp(request({ "x-forwarded-for": "not an address at all" })),
    ).toBeUndefined();
    // ...but a valid entry appended by the proxy is still found.
    expect(resolveClientIp(request({ "x-forwarded-for": "spoofed, 203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
    // A spoofed cf-connecting-ip (only possible when not behind the proxy) is ignored too.
    expect(
      resolveClientIp(request({ "cf-connecting-ip": "spoofed", "x-real-ip": "203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip when the forwarded header carries nothing usable", () => {
    expect(
      resolveClientIp(request({ "x-forwarded-for": "spoofed", "x-real-ip": "203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  it("ignores oversized values", () => {
    const tooLong = `${"1.".repeat(40)}1`; // 81 characters
    expect(resolveClientIp(request({ "cf-connecting-ip": tooLong }))).toBeUndefined();
    expect(resolveClientIp(request({ "x-forwarded-for": `spoofed, ${tooLong}` }))).toBeUndefined();
  });

  it("returns undefined when no trusted header is present (local/dev mode)", () => {
    expect(resolveClientIp(request({}))).toBeUndefined();
  });
});
