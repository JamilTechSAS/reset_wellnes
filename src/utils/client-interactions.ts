/**
 * Client website interactions (Phase 6E).
 *
 * Implements the exact interactions from the client-delivered website:
 * - Community modal popup with localStorage 7-day dismissal and 1500ms delay
 * - Mobile navigation menu toggle and responsive handling
 * - Scrolled header background transition
 * - Manifesto text reveal on scroll
 * - Brand collaboration form with character counter
 * - Legal tabs navigation and hash routing (#reembolsos, #privacidad)
 * - Ticket tier selection, terms acceptance validation, and purchase trigger
 * - Purchase CTA hooks wired to the approved purchase controller
 */

import {
  GENERAL_ENDS_AT,
  GENERAL_OPEN_LABEL,
  GENERAL_OPENS_AT,
  GENERAL_WINDOW_LABEL,
  PRESALE_CLOSED_NOTE,
  PRESALE_ENDS_AT,
  PRESALE_OPENS_AT,
  PRESALE_SCHEDULE_NOTE,
  PRESALE_WINDOW_LABEL,
  clockSkewMs,
  isGeneralWindowOpen,
  isPresaleClosed,
  isPresaleOpen,
} from "../purchase/presale-schedule.ts";
import {
  PACKAGE_ADMISSIONS,
  PACKAGE_UNAVAILABLE_NOTE,
  packageCheckoutAvailable,
} from "../purchase/package-availability.ts";

export type ClientInteractionsOptions = {
  readonly openPurchase?: (
    source: string,
    details?: {
      readonly quantity?: number;
      readonly tier?: string;
      readonly acceptedTerms?: boolean;
    },
  ) => void;
  readonly openLookup?: () => void;
  readonly openLegal?: (tab: string) => void;
  readonly salesConfig?: {
    readonly apiBaseUrl: string;
    readonly eventCode: string;
    readonly ticketTypeCode: string;
  };
};

const COMMUNITY_STORAGE_KEY = "reset-comunidad";
const COMMUNITY_CONFIG = {
  endpoint: "https://formsubmit.co/ajax/reset.wellness@gmail.com",
  retrasoMs: 1500,
  noMostrarPorDias: 7,
};

function hasSeenCommunityModal(): boolean {
  try {
    const value = localStorage.getItem(COMMUNITY_STORAGE_KEY);
    if (!value) return false;
    if (value === "registrado") return true;
    const time = Number(value);
    if (Number.isNaN(time)) return false;
    return Date.now() - time < COMMUNITY_CONFIG.noMostrarPorDias * 86_400_000;
  } catch {
    return false;
  }
}

function saveCommunityModalStatus(value: string): void {
  try {
    localStorage.setItem(COMMUNITY_STORAGE_KEY, value);
  } catch {
    // Ignore localStorage errors in private browsing
  }
}

export function initClientInteractions(options: ClientInteractionsOptions = {}): () => void {
  const disposers: (() => void)[] = [];

  // ---------------------------------------------------------------------------
  // 1. Community Modal
  // ---------------------------------------------------------------------------
  const communityModal = document.getElementById("community");
  const communityForm = document.getElementById("community-form") as HTMLFormElement | null;
  const communityEmailInput = document.getElementById("community-email") as HTMLInputElement | null;
  const communityMsg = document.getElementById("community-msg");
  let previousActiveElement: HTMLElement | null = null;
  let popupTimeoutId: ReturnType<typeof setTimeout> | null = null;

  const openCommunityModal = (): void => {
    if (!communityModal) return;
    previousActiveElement = document.activeElement as HTMLElement | null;
    communityModal.classList.add("is-open");
    document.body.style.overflow = "hidden";
    setTimeout(() => {
      communityEmailInput?.focus({ preventScroll: true });
    }, 400);
  };

  const closeCommunityModal = (): void => {
    if (!communityModal) return;
    communityModal.classList.remove("is-open");
    document.body.style.overflow = "";
    if (!hasSeenCommunityModal()) {
      saveCommunityModalStatus(String(Date.now()));
    }
    if (previousActiveElement && typeof previousActiveElement.focus === "function") {
      previousActiveElement.focus();
    }
  };

  if (communityModal) {
    const closeButtons = communityModal.querySelectorAll("[data-close]");
    const handleCloseClick = (event: Event): void => {
      event.preventDefault();
      closeCommunityModal();
    };
    closeButtons.forEach((btn) => {
      btn.addEventListener("click", handleCloseClick);
      disposers.push(() => {
        btn.removeEventListener("click", handleCloseClick);
      });
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && communityModal.classList.contains("is-open")) {
        closeCommunityModal();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    disposers.push(() => {
      document.removeEventListener("keydown", handleKeyDown);
    });

    if (communityForm) {
      const handleCommunitySubmit = (event: Event): void => {
        event.preventDefault();
        const email = communityEmailInput?.value.trim() ?? "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          if (communityMsg) {
            communityMsg.textContent = "Revisa tu correo, parece que le falta algo.";
          }
          communityEmailInput?.focus();
          return;
        }

        const submitBtn = communityForm.querySelector("button");
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = "Enviando…";
        }
        if (communityMsg) communityMsg.textContent = "";

        fetch(COMMUNITY_CONFIG.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            email,
            _subject: "Nuevo registro comunidad Reset",
            origen: "Pop-up web",
          }),
        })
          .then((response) => {
            if (!response.ok) throw new Error(String(response.status));
            saveCommunityModalStatus("registrado");
            communityForm.hidden = true;
            if (communityMsg) {
              communityMsg.textContent =
                "Listo, ya estás dentro. Te escribiremos antes que a nadie.";
            }
            setTimeout(closeCommunityModal, 3200);
          })
          .catch(() => {
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = "Continuar";
            }
            if (communityMsg) {
              communityMsg.textContent = "No se pudo enviar. Inténtalo de nuevo en un momento.";
            }
          });
      };

      communityForm.addEventListener("submit", handleCommunitySubmit);
      disposers.push(() => {
        communityForm.removeEventListener("submit", handleCommunitySubmit);
      });
    }

    const forcePopup = window.location.search.includes("comunidad");
    const autoPopup = document.body.getAttribute("data-popup") !== "off";
    if (forcePopup || (autoPopup && !hasSeenCommunityModal())) {
      popupTimeoutId = setTimeout(openCommunityModal, forcePopup ? 0 : COMMUNITY_CONFIG.retrasoMs);
    }
  }

  // Floating button & community triggers
  const openButtons = document.querySelectorAll(
    "#community-open, [data-abrir-comunidad], [data-action='abrir-comunidad']",
  );
  const handleOpenCommunity = (event: Event): void => {
    event.preventDefault();
    openCommunityModal();
  };
  openButtons.forEach((btn) => {
    btn.addEventListener("click", handleOpenCommunity);
    disposers.push(() => {
      btn.removeEventListener("click", handleOpenCommunity);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Mobile Navigation Toggle
  // ---------------------------------------------------------------------------
  const navToggle = document.getElementById("nav-toggle");
  const navMenu = document.getElementById("nav-menu");
  if (navToggle && navMenu) {
    const handleToggleClick = (): void => {
      const isOpen = navMenu.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
      navToggle.textContent = isOpen ? "Cerrar" : "Menú";
    };
    navToggle.addEventListener("click", handleToggleClick);
    disposers.push(() => {
      navToggle.removeEventListener("click", handleToggleClick);
    });

    const menuLinks = navMenu.querySelectorAll("a");
    const handleMenuLinkClick = (): void => {
      navMenu.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.textContent = "Menú";
    };
    menuLinks.forEach((link) => {
      link.addEventListener("click", handleMenuLinkClick);
      disposers.push(() => {
        link.removeEventListener("click", handleMenuLinkClick);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Header Scrolled State
  // ---------------------------------------------------------------------------
  const header = document.querySelector(".header");
  const heroElement = document.getElementById("inicio");
  if (header && heroElement) {
    const handleHeaderScroll = (): void => {
      header.classList.toggle("is-scrolled", heroElement.getBoundingClientRect().bottom < 90);
    };
    window.addEventListener("scroll", handleHeaderScroll, { passive: true });
    handleHeaderScroll();
    disposers.push(() => {
      window.removeEventListener("scroll", handleHeaderScroll);
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Text Reveal Animation (Manifesto on index.html)
  // ---------------------------------------------------------------------------
  const revealContainer = document.querySelector<HTMLElement>("[data-reveal]");
  if (revealContainer) {
    revealContainer.querySelectorAll("p").forEach((paragraph) => {
      const text = paragraph.textContent.trim();
      paragraph.setAttribute("aria-label", text);
      paragraph.innerHTML = text
        .split(/[ \t\n\r]+/)
        .map((word) => `<span class="w" aria-hidden="true">${word}</span>`)
        .join(" ");
    });

    const wordSpans = Array.from(revealContainer.querySelectorAll(".w"));
    const updateReveal = (): void => {
      const rect = revealContainer.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      let progress = (viewportHeight * 0.95 - rect.top) / (rect.height + viewportHeight * 0.3);
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        progress = 1;
      }
      progress = Math.max(0, Math.min(1, progress));
      const activeCount = Math.round(progress * wordSpans.length);
      wordSpans.forEach((span, index) => {
        span.classList.toggle("is-on", index < activeCount);
      });
    };

    window.addEventListener("scroll", updateReveal, { passive: true });
    window.addEventListener("resize", updateReveal);
    updateReveal();
    disposers.push(() => {
      window.removeEventListener("scroll", updateReveal);
      window.removeEventListener("resize", updateReveal);
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Marca y Colaboración Form
  // ---------------------------------------------------------------------------
  const marcaForm = document.getElementById("marca-form") as HTMLFormElement | null;
  if (marcaForm) {
    const textarea = marcaForm.querySelector<HTMLTextAreaElement>("textarea");
    const counter = document.getElementById("contador");
    const marcaMsg = document.getElementById("marca-msg");

    const updateCounter = (): void => {
      if (counter && textarea) {
        counter.textContent = `${String(textarea.value.length)} / 2000`;
      }
    };
    if (textarea) {
      textarea.addEventListener("input", updateCounter);
      updateCounter();
      disposers.push(() => {
        textarea.removeEventListener("input", updateCounter);
      });
    }

    const handleMarcaSubmit = (event: Event): void => {
      event.preventDefault();
      const nameInput = marcaForm.querySelector<HTMLInputElement>("input[name='nombre']");
      const brandInput = marcaForm.querySelector<HTMLInputElement>("input[name='marca']");
      const emailInput = marcaForm.querySelector<HTMLInputElement>("input[name='email']");

      const nombre = nameInput?.value.trim() ?? "";
      const marca = brandInput?.value.trim() ?? "";
      const email = emailInput?.value.trim() ?? "";
      const mensaje = textarea?.value.trim() ?? "";

      if (!nombre || !mensaje || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (marcaMsg) {
          marcaMsg.textContent = "Completa tu nombre, un correo válido y tu mensaje.";
        }
        return;
      }

      const submitBtn = marcaForm.querySelector("button");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Enviando…";
      }
      if (marcaMsg) marcaMsg.textContent = "";

      fetch(COMMUNITY_CONFIG.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          nombre,
          marca,
          email,
          mensaje,
          _subject: "Nueva solicitud de marca · Reset",
        }),
      })
        .then((response) => {
          if (!response.ok) throw new Error(String(response.status));
          marcaForm.reset();
          updateCounter();
          if (submitBtn) {
            submitBtn.textContent = "Enviado";
          }
          if (marcaMsg) {
            marcaMsg.textContent = "Gracias. Te escribiremos muy pronto.";
          }
        })
        .catch(() => {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Enviar";
          }
          if (marcaMsg) {
            marcaMsg.textContent =
              "No se pudo enviar. Inténtalo de nuevo o escríbenos a reset.wellness@gmail.com.";
          }
        });
    };

    marcaForm.addEventListener("submit", handleMarcaSubmit);
    disposers.push(() => {
      marcaForm.removeEventListener("submit", handleMarcaSubmit);
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Legal Tabs (terminos-y-condiciones.html)
  // ---------------------------------------------------------------------------
  const legalTabs = document.querySelectorAll<HTMLButtonElement>('.legal-tabs [role="tab"]');
  if (legalTabs.length > 0) {
    const activateTab = (selectedTab: HTMLButtonElement): void => {
      legalTabs.forEach((tab) => {
        const isActive = tab === selectedTab;
        tab.setAttribute("aria-selected", String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
        const panelId = tab.getAttribute("aria-controls");
        if (panelId) {
          const panel = document.getElementById(panelId);
          if (panel) panel.hidden = !isActive;
        }
      });
    };

    legalTabs.forEach((tab) => {
      const handleTabClick = (): void => {
        activateTab(tab);
        const tabId = tab.id.replace("tab-", "");
        const newHash = tabId === "participantes" ? window.location.pathname : `#${tabId}`;
        window.history.replaceState(null, "", newHash);
      };
      tab.addEventListener("click", handleTabClick);
      disposers.push(() => {
        tab.removeEventListener("click", handleTabClick);
      });
    });

    const activateFromHash = (): void => {
      const hash = window.location.hash.slice(1);
      if (hash) {
        const tab = document.getElementById(`tab-${hash}`) as HTMLButtonElement | null;
        if (tab?.getAttribute("role") === "tab") {
          activateTab(tab);
        }
      }
    };
    activateFromHash();
    window.addEventListener("hashchange", activateFromHash);
    disposers.push(() => {
      window.removeEventListener("hashchange", activateFromHash);
    });

    const tabJumpLinks = document.querySelectorAll<HTMLAnchorElement>("[data-ir-tab]");
    tabJumpLinks.forEach((link) => {
      const handleJumpClick = (event: MouseEvent): void => {
        const targetTabId = link.getAttribute("data-ir-tab");
        if (targetTabId) {
          const tab = document.getElementById(targetTabId) as HTMLButtonElement | null;
          if (tab) {
            event.preventDefault();
            tab.click();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }
      };
      link.addEventListener("click", handleJumpClick);
      disposers.push(() => {
        link.removeEventListener("click", handleJumpClick);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 7. Entradas Ticket Presentation & Purchase Flow Trigger
  // ---------------------------------------------------------------------------
  const buyButton = document.getElementById("comprar");
  const termsCheckbox = document.getElementById("acepto-terminos") as HTMLInputElement | null;
  const buyHelpText = document.getElementById("comprar-ayuda");

  if (buyButton) {
    const defaultTier = "preventa";

    // General and the package stay disabled until the public catalog confirms the General stage
    // is the one on sale. The catalog carries the server clock, so a device with a wrong clock
    // still times its own boundary timers against the same instants the database enforces.
    const disabledTiers = ["general", "duo"];

    disabledTiers.forEach((tier) => {
      const tierCard = document.querySelector(`.tipo[data-tipo="${tier}"]`);
      if (tierCard) {
        tierCard.classList.add("is-off");
        const radio = tierCard.querySelector<HTMLInputElement>("input");
        if (radio) radio.disabled = true;
        const note = tierCard.querySelector("[data-nota]");
        if (note) {
          note.textContent = tier === "duo" ? PACKAGE_UNAVAILABLE_NOTE : GENERAL_WINDOW_LABEL;
        }
      }
    });

    // Presale is time-locked to its scheduled window (Colombia time); whether it is then actually
    // buyable still comes from the backend availability response below.
    const preventaCard = document.querySelector<HTMLElement>('.tipo[data-tipo="preventa"]');
    const preventaRadio = preventaCard?.querySelector<HTMLInputElement>("input") ?? null;
    const preventaNote = preventaCard?.querySelector<HTMLElement>("[data-nota]") ?? null;
    // Optimistic until the public catalog answers (matches the prior default where presale was open).
    let backendPreventaAllowed = true;
    // General (and the package, which rides on it) is never optimistic: the catalog has to say so.
    let backendGeneralAllowed = false;

    // Milliseconds this device's clock is ahead (+) or behind (-) the backend's. Zero until the
    // catalog answers; it only sharpens the timer, never authorizes a purchase.
    let clockSkew = 0;
    const nowMs = (): number => Date.now() + clockSkew;

    // The backend's own opening instant for the stage it has on sale (`salesWindow.startsAt`).
    // The published schedule in `presale-schedule.ts` is the fallback: the page must sell a stage
    // the database has already opened, instead of waiting for a hardcoded hour to arrive.
    let serverPreventaStartMs: number | null = null;
    const preventaTimeOpen = (at: number): boolean => {
      if (isPresaleClosed(at)) return false;
      if (isPresaleOpen(at)) return true;
      return serverPreventaStartMs !== null && at >= serverPreventaStartMs;
    };

    const updateTicketState = (): void => {
      const selectedRadio = document.querySelector<HTMLInputElement>(".tipo input:checked");
      const tier = selectedRadio?.value ?? defaultTier;

      const selectionUnavailable = selectedRadio?.disabled === true;
      if (selectionUnavailable) {
        buyButton.setAttribute("aria-disabled", "true");
        if (buyHelpText) {
          buyHelpText.textContent =
            tier === "preventa"
              ? preventaLockedCopy()
              : "Esta entrada no está disponible por ahora.";
        }
      } else if (termsCheckbox?.checked) {
        buyButton.setAttribute("aria-disabled", "false");
        if (buyHelpText) {
          buyHelpText.textContent = "Haz clic para continuar con la compra segura.";
        }
      } else {
        buyButton.setAttribute("aria-disabled", "true");
        if (buyHelpText) {
          buyHelpText.textContent = "Marca la casilla para continuar con el pago.";
        }
      }
    };

    /** What the Preventa card (and the locked buy button) says right now. */
    const preventaLockedCopy = (): string => {
      const at = nowMs();
      if (isPresaleClosed(at)) return PRESALE_CLOSED_NOTE;
      if (!isPresaleOpen(at)) return PRESALE_SCHEDULE_NOTE;
      return "Preventa no disponible";
    };

    // Applies the presale time gate combined with the last known backend verdict.
    const applyPreventaState = (): void => {
      const at = nowMs();
      const closed = isPresaleClosed(at);
      const timeOpen = preventaTimeOpen(at);
      const enabled = timeOpen && backendPreventaAllowed;
      preventaCard?.classList.toggle("is-off", !enabled);
      if (preventaRadio) preventaRadio.disabled = !enabled;
      if (preventaNote) {
        if (closed) {
          // The window is over: the card says so and can never be selected again.
          preventaNote.textContent = PRESALE_CLOSED_NOTE;
        } else if (!timeOpen) {
          preventaNote.textContent = PRESALE_SCHEDULE_NOTE;
        } else if (!backendPreventaAllowed) {
          preventaNote.textContent = "Preventa no disponible";
        } else {
          // The window stays visible while the stage is open, so the closing date is never hidden.
          preventaNote.textContent = PRESALE_WINDOW_LABEL;
        }
      }
      // If presale was selected but is now locked, move the selection off it. A closed stage
      // NEVER keeps a stale selection: checkout must not continue with Preventa.
      if (!enabled) {
        const selected = document.querySelector<HTMLInputElement>(".tipo input:checked");
        if (selected?.value === "preventa") {
          selected.checked = false;
          const fallback = document.querySelector<HTMLInputElement>(".tipo input:not(:disabled)");
          if (fallback) fallback.checked = true;
        }
      }
      updateTicketState();
    };

    /**
     * Schedules the next stage boundary (Preventa opening, Preventa closing) from the server
     * clock, so an open tab flips without a reload. Coming back to the tab always re-evaluates,
     * because a background tab may have slept through the timer.
     */
    const boundaryTimer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
    const scheduleStageBoundaries = (): void => {
      if (boundaryTimer.id !== undefined) {
        clearTimeout(boundaryTimer.id);
        boundaryTimer.id = undefined;
      }
      const at = nowMs();
      const next = [
        PRESALE_OPENS_AT.getTime(),
        PRESALE_ENDS_AT.getTime(),
        GENERAL_OPENS_AT.getTime(),
        GENERAL_ENDS_AT.getTime(),
      ].find((instant) => instant > at);
      if (next === undefined) return;
      const delay = next - at;
      const MAX_TIMEOUT = 2_147_483_647; // setTimeout's 32-bit ceiling (~24.8 days)
      if (delay > MAX_TIMEOUT) return; // too far out; a later load or focus re-evaluates
      boundaryTimer.id = setTimeout(() => {
        boundaryTimer.id = undefined;
        applyPreventaState();
        scheduleStageBoundaries();
        // A boundary that OPENS a stage needs a fresh catalog answer, otherwise General would
        // never unlock on a page the buyer left open. Closing needs nothing: the time gate is
        // already authoritative and the backend refuses the sale in any case.
        void refreshPublicSales();
      }, delay + 50);
    };

    const tierInputs = document.querySelectorAll(".tipo input");
    tierInputs.forEach((input) => {
      input.addEventListener("change", updateTicketState);
      disposers.push(() => {
        input.removeEventListener("change", updateTicketState);
      });
    });

    if (termsCheckbox) {
      termsCheckbox.addEventListener("change", updateTicketState);
      disposers.push(() => {
        termsCheckbox.removeEventListener("change", updateTicketState);
      });
    }

    const handleBuyClick = (event: MouseEvent): void => {
      event.preventDefault();
      if (!termsCheckbox?.checked) {
        termsCheckbox?.focus();
        if (buyHelpText) {
          buyHelpText.textContent = "Primero acepta los términos y condiciones.";
        }
        return;
      }

      const selectedRadio = document.querySelector<HTMLInputElement>(".tipo input:checked");
      // A locked Preventa selection is cleared by `applyPreventaState`, so the fallback tier is
      // what the buyer is looking at when nothing can be selected. Its own copy explains why.
      const tier = selectedRadio?.value ?? defaultTier;
      // Block checkout for a tier that is not currently purchasable (a closed or not-yet-open
      // stage, or a package whose stage is not on sale).
      if (!selectedRadio || selectedRadio.disabled) {
        if (buyHelpText) {
          buyHelpText.textContent =
            tier === "preventa"
              ? preventaLockedCopy()
              : "Esta entrada no está disponible por ahora.";
        }
        return;
      }

      // General and the package only exist inside the General window. A stale page can leave a
      // radio enabled, so the server-derived clock is checked again here; the quote and the
      // order transaction re-validate it in the backend regardless.
      if ((tier === "general" || tier === "duo") && !isGeneralWindowOpen(nowMs())) {
        if (buyHelpText) {
          buyHelpText.textContent = "Esta entrada no está disponible por ahora.";
        }
        return;
      }

      // Enter the approved real backend purchase flow. The package is one product of three
      // admissions, so the request carries that quantity; the backend re-prices and re-reserves it.
      options.openPurchase?.("ticket-section", {
        quantity: tier === "duo" ? PACKAGE_ADMISSIONS : 1,
        tier,
        acceptedTerms: true,
      });
    };

    buyButton.addEventListener("click", handleBuyClick);
    disposers.push(() => {
      buyButton.removeEventListener("click", handleBuyClick);
    });

    applyPreventaState();
    scheduleStageBoundaries();

    // A sleeping tab can miss a timer: re-evaluate whenever the buyer comes back to it. Both are
    // read-only checks; the backend still re-validates the stage on every purchase.
    const reevaluate = (): void => {
      applyPreventaState();
      scheduleStageBoundaries();
      // A background tab can sleep through a boundary timer; the catalog answer decides.
      void refreshPublicSales();
    };
    document.addEventListener("visibilitychange", reevaluate);
    window.addEventListener("focus", reevaluate);
    disposers.push(() => {
      document.removeEventListener("visibilitychange", reevaluate);
      window.removeEventListener("focus", reevaluate);
      if (boundaryTimer.id !== undefined) {
        clearTimeout(boundaryTimer.id);
      }
    });

    const salesConfig = options.salesConfig;
    const catalogEndpoint =
      salesConfig === undefined
        ? null
        : `${salesConfig.apiBaseUrl.replace(/\/+$/, "")}/events/${encodeURIComponent(salesConfig.eventCode)}`;
    const ticketTypeCode = salesConfig?.ticketTypeCode ?? "";
    let catalogInFlight = false;

    /**
     * Reads the public catalog — the backend's stage, price, per-order cap, server clock and
     * half-open window — and applies it to the cards. It runs on load, when a stage boundary
     * passes and when the buyer returns to the tab: a page left open across 00:01 on 29 October
     * has to unlock General and the package without a reload.
     */
    async function refreshPublicSales(): Promise<void> {
      if (salesConfig === undefined || catalogEndpoint === null || catalogInFlight) {
        return;
      }
      catalogInFlight = true;
      try {
        const response = await fetch(catalogEndpoint);
        {
          if (!response.ok) {
            throw new Error(`Public event lookup failed: ${response.status}`);
          }
          const envelope = (await response.json()) as {
            readonly ok?: boolean;
            readonly data?: {
              readonly found?: boolean;
              readonly sales?: {
                readonly salesOpen?: boolean;
                /** Backend clock when the projection was built (ISO UTC). */
                readonly serverTime?: string;
                readonly ticketTypes?: readonly {
                  readonly code: string;
                  readonly salesOpen: boolean;
                  readonly availability: string;
                  readonly currentTier: {
                    readonly name: string;
                    readonly maxPerOrder?: number | null;
                  } | null;
                  readonly salesWindow?: {
                    readonly startsAt: string | null;
                    readonly endsAt: string | null;
                  } | null;
                }[];
              };
            };
          };
          const sales = envelope.data?.sales;
          const ticketType = sales?.ticketTypes?.find(
            (candidate) => candidate.code === ticketTypeCode,
          );
          if (
            envelope.ok !== true ||
            envelope.data?.found !== true ||
            sales === undefined ||
            ticketType === undefined
          ) {
            throw new Error("Public event lookup returned no ticket type");
          }

          // Correct this device's clock against the server before any boundary decision.
          clockSkew = clockSkewMs(sales.serverTime, Date.now());

          // Backend's view of the presale stage (inventory/stage), independent of the time gate.
          const preventaStageOpen =
            sales.salesOpen === true &&
            ticketType.salesOpen &&
            ticketType.currentTier?.name === "Preventa" &&
            ticketType.availability !== "SOLD_OUT";
          const generalOpen =
            sales.salesOpen === true &&
            ticketType.salesOpen &&
            ticketType.currentTier?.name === "General" &&
            ticketType.availability !== "SOLD_OUT";

          backendPreventaAllowed = preventaStageOpen;
          // The database's window wins over the published hour: an opened Preventa sells now.
          const tierWindowStart = ticketType.salesWindow?.startsAt;
          if (
            ticketType.currentTier?.name === "Preventa" &&
            tierWindowStart !== null &&
            tierWindowStart !== undefined
          ) {
            const parsedStart = Date.parse(tierWindowStart);
            if (!Number.isNaN(parsedStart)) {
              serverPreventaStartMs = parsedStart;
            }
          }
          const at = nowMs();
          // A stage is buyable only when the backend says it is on sale AND the server-derived
          // clock sits inside its half-open window. A selected-but-closed stage is never left
          // purchasable, and the one-minute gap between stages stays closed.
          const preventaOpen = preventaStageOpen && preventaTimeOpen(at);
          const generalTimeOpen = isGeneralWindowOpen(at);
          backendGeneralAllowed = generalOpen && generalTimeOpen;

          const enabledByTier: Record<string, boolean> = {
            preventa: preventaOpen,
            general: backendGeneralAllowed,
            // The package is one product of the three-admission bundle the backend now prices;
            // it opens with General and is still refused if fewer than three admissions remain
            // (the quote answers SOLD_OUT, which the checkout shows honestly).
            duo: backendGeneralAllowed && packageCheckoutAvailable(),
          };
          Object.entries(enabledByTier).forEach(([tier, enabled]) => {
            const card = document.querySelector<HTMLElement>(`.tipo[data-tipo="${tier}"]`);
            const radio = card?.querySelector<HTMLInputElement>("input");
            const note = card?.querySelector<HTMLElement>("[data-nota]");
            if (card !== null) {
              card.classList.toggle("is-off", !enabled);
            }
            if (radio !== null && radio !== undefined) {
              radio.disabled = !enabled;
            }
            if (note !== null && note !== undefined) {
              if (tier === "duo") {
                // While the package is not on sale the card explains when it opens; once it is,
                // the availability line would be untrue, so it is removed (the price stays).
                note.textContent = enabled ? "" : PACKAGE_UNAVAILABLE_NOTE;
              } else if (tier === "general") {
                // Before opening, the card explains when the stage starts. Once it is on sale
                // that line would be false, so it states that the stage is live instead.
                note.textContent = enabled ? GENERAL_OPEN_LABEL : GENERAL_WINDOW_LABEL;
              } else if (!enabled) {
                note.textContent = preventaLockedCopy();
              } else {
                note.textContent = PRESALE_WINDOW_LABEL;
              }
            }
          });

          const selected = document.querySelector<HTMLInputElement>(".tipo input:checked");
          const selectedValue = selected?.value ?? defaultTier;
          if (enabledByTier[selectedValue] !== true) {
            const fallbackTier = generalOpen ? "general" : preventaOpen ? "preventa" : undefined;
            if (fallbackTier !== undefined) {
              const fallbackRadio = document.querySelector<HTMLInputElement>(
                `.tipo[data-tipo="${fallbackTier}"] input`,
              );
              if (fallbackRadio !== null) {
                fallbackRadio.checked = true;
              }
            }
          }
          // A card that just became buyable claims the selection: the markup ships Preventa
          // disabled, so the selection it carries is dropped before the catalog answers, and
          // leaving nothing selected would make the buy button refuse a stage that is on sale.
          if (document.querySelector<HTMLInputElement>(".tipo input:checked") === null) {
            const firstEnabled = document.querySelector<HTMLInputElement>(
              ".tipo input:not(:disabled)",
            );
            if (firstEnabled !== null) {
              firstEnabled.checked = true;
            }
          }
          applyPreventaState();
          scheduleStageBoundaries();
          updateTicketState();
        }
      } catch {
        // General and the package remain unavailable without a confirmed public sales stage.
      } finally {
        catalogInFlight = false;
      }
    }

    if (salesConfig !== undefined) {
      void refreshPublicSales();
    }
  }

  // ---------------------------------------------------------------------------
  // 8. General Purchase CTAs & Lookup Hooks
  // ---------------------------------------------------------------------------
  const ctaButtons = document.querySelectorAll<HTMLElement>(
    "[data-buy-source], #hero-buy-btn, #nav-buy-btn, #final-buy-btn, #sticky-buy-btn",
  );
  ctaButtons.forEach((btn) => {
    // Skip #comprar since it has its own terms-checking handler above
    if (btn.id === "comprar") return;

    // A CTA that is a link to a real page (e.g. the homepage hero → entradas.html) should just
    // navigate there, not open the purchase dialog. Only button CTAs open the dialog in place.
    const href = btn.getAttribute("href");
    if (btn.tagName === "A" && href !== null && href.length > 0 && !href.startsWith("#")) {
      return;
    }

    const source = btn.getAttribute("data-buy-source") ?? "cta";
    const handleCtaClick = (event: MouseEvent): void => {
      event.preventDefault();
      options.openPurchase?.(source);
    };
    btn.addEventListener("click", handleCtaClick);
    disposers.push(() => {
      btn.removeEventListener("click", handleCtaClick);
    });
  });

  const lookupLinks = document.querySelectorAll<HTMLAnchorElement>(
    'a[href="#consultar"], [data-action="lookup"]',
  );
  lookupLinks.forEach((link) => {
    const handleLookupClick = (event: MouseEvent): void => {
      event.preventDefault();
      options.openLookup?.();
    };
    link.addEventListener("click", handleLookupClick);
    disposers.push(() => {
      link.removeEventListener("click", handleLookupClick);
    });
  });

  const legalLinks = document.querySelectorAll<HTMLAnchorElement>("[data-legal-tab]");
  legalLinks.forEach((link) => {
    const handleLegalClick = (event: MouseEvent): void => {
      const tab = link.getAttribute("data-legal-tab");
      if (tab) {
        event.preventDefault();
        options.openLegal?.(tab);
      }
    };
    link.addEventListener("click", handleLegalClick);
    disposers.push(() => {
      link.removeEventListener("click", handleLegalClick);
    });
  });

  // Pending links prevent navigation
  const pendingLinks = document.querySelectorAll<HTMLAnchorElement>("[data-pendiente]");
  const handlePendingClick = (event: MouseEvent): void => {
    event.preventDefault();
  };
  pendingLinks.forEach((link) => {
    link.addEventListener("click", handlePendingClick);
    disposers.push(() => {
      link.removeEventListener("click", handlePendingClick);
    });
  });

  return () => {
    if (popupTimeoutId) clearTimeout(popupTimeoutId);
    disposers.forEach((dispose) => {
      dispose();
    });
  };
}
