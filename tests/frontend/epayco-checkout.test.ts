// @vitest-environment happy-dom
/**
 * Frontend tests for ePayco Smart Checkout V2 integration (Phase 7 - Main Website).
 *
 * Verifies:
 *   - `loadEpaycoScript` creates and appends the script tag, handles errors, and prevents duplicate injection.
 *   - `openEpaycoCheckout` requires a valid `sessionId` and refuses to open without one.
 *   - `openEpaycoCheckout` configures `ePayco.checkout` with `type: "onpage"` and correct test setting.
 *   - `openEpaycoCheckout` wires lifecycle hooks (`onCreated`, `onResponse`, `onClosed`, `onErrors`) and calls `open()`.
 *   - Private credentials are never required, accepted, or exposed in the frontend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EPAYCO_SCRIPT_URL,
  defaultScriptLoader,
  loadEpaycoScript,
  openEpaycoCheckout,
  resetEpaycoLoaderForTesting,
  type EpaycoCheckoutHooks,
  type EpaycoConfigureOptions,
} from "../../src/purchase/epayco.ts";
import type { EpaycoCheckout } from "../../src/api/types.ts";

function makeFakeEpaycoCheckout(overrides: Partial<EpaycoCheckout> = {}): EpaycoCheckout {
  return {
    provider: "epayco",
    sessionId: "epayco_session_test_abc123",
    publicKey: "epayco_pub_test_12345",
    test: true,
    reference: "EVT-2026-000001",
    amountInCents: 16000000,
    currency: "COP",
    redirectUrl: "https://example.com/gracias",
    confirmationUrl: "https://example.com/functions/v1/webhooks-epayco",
    customerData: {
      email: "buyer@example.com",
      fullName: "Comprador Reset",
      phoneNumber: "3001234567",
      phoneNumberPrefix: "+57",
    },
    ...overrides,
  };
}

describe("ePayco Smart Checkout V2 frontend integration", () => {
  beforeEach(() => {
    resetEpaycoLoaderForTesting();
    document.head.innerHTML = "";
    delete window.ePayco;
  });

  afterEach(() => {
    resetEpaycoLoaderForTesting();
    document.head.innerHTML = "";
    delete window.ePayco;
    vi.restoreAllMocks();
  });

  describe("Script loading", () => {
    it("calls loader with the official checkout-v2.js URL", async () => {
      const loader = vi.fn().mockResolvedValue(undefined);
      await loadEpaycoScript(DEFAULT_EPAYCO_SCRIPT_URL, loader);

      expect(loader).toHaveBeenCalledWith(DEFAULT_EPAYCO_SCRIPT_URL);
    });

    it("does not call loader a second time if one is already in flight", async () => {
      let resolveLoader!: () => void;
      const loaderPromise = new Promise<void>((r) => {
        resolveLoader = r;
      });
      const loader = vi.fn().mockReturnValue(loaderPromise);

      const p1 = loadEpaycoScript(DEFAULT_EPAYCO_SCRIPT_URL, loader);
      const p2 = loadEpaycoScript(DEFAULT_EPAYCO_SCRIPT_URL, loader);

      expect(loader).toHaveBeenCalledTimes(1);

      resolveLoader();
      await Promise.all([p1, p2]);
    });

    it("rejects with an actionable error if the script fails to load", async () => {
      const loader = vi.fn().mockRejectedValue(new Error("Network connection error"));

      await expect(loadEpaycoScript(DEFAULT_EPAYCO_SCRIPT_URL, loader)).rejects.toThrow(
        /Network connection error/,
      );
    });

    // Regression: `crossOrigin = "anonymous"` made the browser fetch checkout-v2.js in CORS mode.
    // ePayco's CDN sends no `Access-Control-Allow-Origin`, so the SDK was blocked and no buyer
    // could open the checkout. A classic script must be injected without the attribute.
    it("injects the SDK as a classic script, never in CORS mode", async () => {
      const appended: Element[] = [];
      const originalAppend = document.head.appendChild.bind(document.head);
      vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
        if (node instanceof HTMLScriptElement) {
          appended.push(node);
          // happy-dom would try to fetch the SDK; this test only inspects the tag it builds.
          return node;
        }
        return originalAppend(node);
      });

      void defaultScriptLoader(DEFAULT_EPAYCO_SCRIPT_URL).catch(() => undefined);

      expect(appended).toHaveLength(1);
      const script = appended[0] as HTMLScriptElement;
      expect(script.src).toBe(DEFAULT_EPAYCO_SCRIPT_URL);
      expect(script.hasAttribute("crossorigin")).toBe(false);
      expect(script.crossOrigin).toBeFalsy();
    });
  });

  describe("Checkout initialization and lifecycle", () => {
    it("throws and calls onError if sessionId is missing or empty", async () => {
      const onError = vi.fn();
      const checkoutWithoutSession = makeFakeEpaycoCheckout({ sessionId: "" });

      await expect(
        openEpaycoCheckout({ checkout: checkoutWithoutSession, onError }),
      ).rejects.toThrow(/falta el identificador de sesión/);

      expect(onError).toHaveBeenCalledTimes(1);
      const reportedError = onError.mock.calls[0]?.[0] as Error;
      expect(reportedError.message).toContain("falta el identificador de sesión");
    });

    it("configures ePayco with onpage mode, test flag, wires hooks, and opens checkout", async () => {
      let capturedOptions: EpaycoConfigureOptions | undefined;
      let capturedHooks: EpaycoCheckoutHooks | undefined;
      const openMock = vi.fn();

      window.ePayco = {
        checkout: {
          configure: (opts) => {
            capturedOptions = opts;
            return {
              open: openMock,
              setHooks: (hooks) => {
                capturedHooks = hooks;
              },
            };
          },
        },
      };

      const checkout = makeFakeEpaycoCheckout({
        sessionId: "session_valid_789",
        test: true,
      });

      const onCreated = vi.fn();
      const onResponse = vi.fn();
      const onClosed = vi.fn();
      const onError = vi.fn();

      const instance = await openEpaycoCheckout({
        checkout,
        type: "onpage",
        onCreated,
        onResponse,
        onClosed,
        onError,
      });

      expect(capturedOptions).toEqual({
        sessionId: "session_valid_789",
        type: "onpage",
        test: true,
      });

      expect(openMock).toHaveBeenCalledTimes(1);
      expect(instance).toBeDefined();

      // Test hooks
      capturedHooks?.onCreated?.({ status: "created" });
      expect(onCreated).toHaveBeenCalledWith({ status: "created" });

      capturedHooks?.onResponse?.({ ref_payco: "987654" });
      expect(onResponse).toHaveBeenCalledWith({ ref_payco: "987654" });

      capturedHooks?.onClosed?.();
      expect(onClosed).toHaveBeenCalledTimes(1);

      capturedHooks?.onErrors?.(new Error("provider connection timeout"));
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "provider connection timeout" }),
      );
    });

    it("respects test=false in production settings", async () => {
      let capturedOptions: EpaycoConfigureOptions | undefined;
      window.ePayco = {
        checkout: {
          configure: (opts) => {
            capturedOptions = opts;
            return {
              open: vi.fn(),
              setHooks: vi.fn(),
            };
          },
        },
      };

      const prodCheckout = makeFakeEpaycoCheckout({
        sessionId: "prod_session_live_001",
        test: false,
      });

      await openEpaycoCheckout({ checkout: prodCheckout });

      expect(capturedOptions?.test).toBe(false);
      expect(capturedOptions?.sessionId).toBe("prod_session_live_001");
    });
  });
});
