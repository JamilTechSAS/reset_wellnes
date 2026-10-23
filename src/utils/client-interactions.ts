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
          submitBtn.textContent = "Enviandoâ€¦";
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
                "Listo, ya estÃ¡s dentro. Te escribiremos antes que a nadie.";
            }
            setTimeout(closeCommunityModal, 3200);
          })
          .catch(() => {
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = "Continuar";
            }
            if (communityMsg) {
              communityMsg.textContent = "No se pudo enviar. IntÃ©ntalo de nuevo en un momento.";
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
      navToggle.textContent = isOpen ? "Cerrar" : "MenÃº";
    };
    navToggle.addEventListener("click", handleToggleClick);
    disposers.push(() => {
      navToggle.removeEventListener("click", handleToggleClick);
    });

    const menuLinks = navMenu.querySelectorAll("a");
    const handleMenuLinkClick = (): void => {
      navMenu.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.textContent = "MenÃº";
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
  // 5. Marca y ColaboraciÃ³n Form
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
          marcaMsg.textContent = "Completa tu nombre, un correo vÃ¡lido y tu mensaje.";
        }
        return;
      }

      const submitBtn = marcaForm.querySelector("button");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Enviandoâ€¦";
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
          _subject: "Nueva solicitud de marca Â· Reset",
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
              "No se pudo enviar. IntÃ©ntalo de nuevo o escrÃ­benos a reset.wellness@gmail.com.";
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
  const buyPriceSpan = document.getElementById("comprar-precio");
  const buyHelpText = document.getElementById("comprar-ayuda");

  if (buyButton) {
    const defaultTier = "preventa";
    const tierPrices: Record<string, string> = {
      preventa: "$160.000",
      duo: "$340.000",
      general: "$200.000",
    };

    // General and Doble experiencia stay disabled until the public catalog confirms General is active.
    const disabledTiers = ["general", "duo"];

    disabledTiers.forEach((tier) => {
      const tierCard = document.querySelector(`.tipo[data-tipo="${tier}"]`);
      if (tierCard) {
        tierCard.classList.add("is-off");
        const radio = tierCard.querySelector<HTMLInputElement>("input");
        if (radio) radio.disabled = true;
        const note = tierCard.querySelector("[data-nota]");
        if (note) {
          note.textContent = "Disponible al iniciar la etapa General";
        }
      }
    });

    const updateTicketState = (): void => {
      const selectedRadio = document.querySelector<HTMLInputElement>(".tipo input:checked");
      const tier = selectedRadio?.value ?? defaultTier;
      if (buyPriceSpan) {
        buyPriceSpan.textContent = tierPrices[tier] ?? "$160.000";
      }

      if (termsCheckbox?.checked) {
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
          buyHelpText.textContent = "Primero acepta los tÃ©rminos y condiciones.";
        }
        return;
      }

      const selectedRadio = document.querySelector<HTMLInputElement>(".tipo input:checked");
      const tier = selectedRadio?.value ?? defaultTier;
      const quantity = tier === "duo" ? 2 : 1;

      // Enter the approved real backend purchase flow
      options.openPurchase?.("ticket-section", {
        quantity,
        tier,
        acceptedTerms: true,
      });
    };

    buyButton.addEventListener("click", handleBuyClick);
    disposers.push(() => {
      buyButton.removeEventListener("click", handleBuyClick);
    });

    updateTicketState();

    if (options.salesConfig !== undefined) {
      const { apiBaseUrl, eventCode, ticketTypeCode } = options.salesConfig;
      const endpoint = `${apiBaseUrl.replace(/\/+$/, "")}/events/${encodeURIComponent(eventCode)}`;
      void fetch(endpoint)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Public event lookup failed: ${response.status}`);
          }
          const envelope = (await response.json()) as {
            readonly ok?: boolean;
            readonly data?: {
              readonly found?: boolean;
              readonly sales?: {
                readonly salesOpen?: boolean;
                readonly ticketTypes?: readonly {
                  readonly code: string;
                  readonly salesOpen: boolean;
                  readonly availability: string;
                  readonly currentTier: { readonly name: string } | null;
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

          const preventaOpen =
            sales.salesOpen === true &&
            ticketType.salesOpen &&
            ticketType.currentTier?.name === "Preventa" &&
            ticketType.availability !== "SOLD_OUT";
          const generalOpen =
            sales.salesOpen === true &&
            ticketType.salesOpen &&
            ticketType.currentTier?.name === "General" &&
            ticketType.availability !== "SOLD_OUT";

          const enabledByTier: Record<string, boolean> = {
            preventa: preventaOpen,
            general: generalOpen,
            duo: generalOpen,
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
              if (!enabled && (tier === "general" || tier === "duo")) {
                note.textContent = "Disponible al iniciar la etapa General";
              } else if (!enabled && tier === "preventa") {
                note.textContent = "Preventa no disponible";
              } else if (tier === "duo") {
                note.textContent = "$170.000 por persona";
              } else {
                note.textContent = "";
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
          updateTicketState();
        })
        .catch(() => {
          // General and Doble experiencia remain unavailable without a confirmed public sales stage.
        });
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
