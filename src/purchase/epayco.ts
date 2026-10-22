/**
 * ePayco Smart Checkout V2 client integration (Phase 7 - Main Website).
 *
 * Sequence:
 *   1. The backend authenticates via Apify and creates a Smart Checkout session.
 *   2. The frontend receives the secret-free `EpaycoCheckout` payload containing `sessionId`.
 *   3. This module loads `https://checkout.epayco.co/checkout-v2.js` dynamically on demand.
 *   4. It initializes the checkout with `type: "onpage"`, matching test mode, and the backend sessionId.
 *   5. It binds lifecycle hooks (`onCreated`, `onResponse`, `onClosed`, `onErrors`) and calls `open()`.
 *
 * Security rules:
 *   - NEVER accepts, handles, or requests private keys (P_KEY, PRIVATE_KEY).
 *   - Uses ONLY the server-generated `sessionId`.
 *   - Never marks an order as paid in the browser; payment confirmation is driven by the backend webhook.
 */

import type { EpaycoCheckout } from "../api/types.ts";

export const DEFAULT_EPAYCO_SCRIPT_URL = "https://checkout.epayco.co/checkout-v2.js";

export type EpaycoCheckoutHooks = {
  readonly onCreated?: (data: unknown) => void;
  readonly onResponse?: (data: unknown) => void;
  readonly onClosed?: () => void;
  readonly onErrors?: (error: unknown) => void;
};

export type EpaycoConfigureOptions = {
  readonly sessionId: string;
  readonly type: "onpage" | "standard";
  readonly test: boolean;
};

export type EpaycoCheckoutInstance = {
  open(): void;
  setHooks?: (hooks: EpaycoCheckoutHooks) => void;
};

export type EpaycoGlobal = {
  checkout: {
    configure(options: EpaycoConfigureOptions): EpaycoCheckoutInstance;
  };
};

declare global {
  interface Window {
    ePayco?: EpaycoGlobal | undefined;
  }
}

let scriptLoadingPromise: Promise<void> | null = null;

export function defaultScriptLoader(scriptUrl: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${scriptUrl}"]`);
    if (existing !== null) {
      if (window.ePayco !== undefined) {
        resolve();
        return;
      }
      existing.addEventListener(
        "load",
        () => {
          resolve();
        },
        { once: true },
      );
      existing.addEventListener(
        "error",
        () => {
          reject(new Error(`Failed to load ePayco script: ${scriptUrl}`));
        },
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.crossOrigin = "anonymous";

    script.onload = () => {
      resolve();
    };

    script.onerror = () => {
      script.remove();
      reject(new Error(`No se pudo cargar la pasarela de pagos ePayco desde ${scriptUrl}`));
    };

    document.head.appendChild(script);
  });
}

/**
 * Loads the official ePayco Checkout V2 script dynamically.
 * Reuses the pending promise or existing window.ePayco if already loaded.
 */
export function loadEpaycoScript(
  scriptUrl: string = DEFAULT_EPAYCO_SCRIPT_URL,
  loader: (url: string) => Promise<void> = defaultScriptLoader,
): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.resolve();
  }

  if (window.ePayco !== undefined) {
    return Promise.resolve();
  }

  if (scriptLoadingPromise !== null) {
    return scriptLoadingPromise;
  }

  scriptLoadingPromise = loader(scriptUrl).catch((err: unknown) => {
    scriptLoadingPromise = null;
    throw err;
  });

  return scriptLoadingPromise;
}

export type OpenEpaycoCheckoutOptions = {
  readonly checkout: EpaycoCheckout;
  readonly scriptUrl?: string | undefined;
  readonly type?: "onpage" | "standard" | undefined;
  readonly loader?: ((url: string) => Promise<void>) | undefined;
  readonly onCreated?: (data: unknown) => void;
  readonly onResponse?: (data: unknown) => void;
  readonly onClosed?: () => void;
  readonly onError?: (error: Error) => void;
};

/**
 * Initializes and displays the ePayco Smart Checkout V2 modal.
 */
export async function openEpaycoCheckout(
  options: OpenEpaycoCheckoutOptions,
): Promise<EpaycoCheckoutInstance> {
  const {
    checkout,
    scriptUrl,
    type = "onpage",
    loader,
    onCreated,
    onResponse,
    onClosed,
    onError,
  } = options;

  const sessionId = checkout.sessionId?.trim();
  if (!sessionId) {
    const error = new Error(
      "No se pudo iniciar el checkout de ePayco: falta el identificador de sesión (sessionId).",
    );
    onError?.(error);
    throw error;
  }

  try {
    await loadEpaycoScript(scriptUrl, loader);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    onError?.(error);
    throw error;
  }

  if (!window.ePayco) {
    const error = new Error(
      "El SDK de ePayco Smart Checkout V2 no inicializó correctamente en el navegador.",
    );
    onError?.(error);
    throw error;
  }

  const handler = window.ePayco.checkout.configure({
    sessionId,
    type,
    test: checkout.test,
  });

  if (typeof handler.setHooks === "function") {
    handler.setHooks({
      onCreated: (data) => {
        onCreated?.(data);
      },
      onResponse: (data) => {
        onResponse?.(data);
      },
      onClosed: () => {
        onClosed?.();
      },
      onErrors: (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.(error);
      },
    });
  }

  handler.open();
  return handler;
}

/** Resets cached loader state for test isolation */
export function resetEpaycoLoaderForTesting(): void {
  scriptLoadingPromise = null;
}
