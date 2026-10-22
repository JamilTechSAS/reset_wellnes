/* RESET WELLNESS CLUB · interacción compartida */

  (function () {
    "use strict";

    /* ===== CONFIGURACIÓN ===== */
    var CONFIG = {
      // Correo donde llegan los registros (vía FormSubmit, gratis y sin cuenta)
      endpoint: "https://formsubmit.co/ajax/reset.wellness@gmail.com",
      retrasoMs: 1500,          // cuánto espera antes de aparecer
      noMostrarPorDias: 7       // si la persona lo cierra, no vuelve a salir en estos días
    };

    var modal = document.getElementById("community");
    var form = document.getElementById("community-form");
    var msg = document.getElementById("community-msg");
    var KEY = "reset-comunidad";
    var ultimoFoco = null;

    function guardar(valor) { try { localStorage.setItem(KEY, valor); } catch (e) {} }
    function yaVisto() {
      try {
        var v = localStorage.getItem(KEY);
        if (!v) return false;
        if (v === "registrado") return true;
        return Date.now() - Number(v) < CONFIG.noMostrarPorDias * 864e5;
      } catch (e) { return false; }
    }

    function abrir() {
      ultimoFoco = document.activeElement;
      modal.classList.add("is-open");
      document.body.style.overflow = "hidden";
      setTimeout(function () { document.getElementById("community-email").focus({ preventScroll: true }); }, 400);
    }
    function mostrarFlotante() {}
    function cerrar() {
      modal.classList.remove("is-open");
      document.body.style.overflow = "";
      if (!yaVisto()) guardar(String(Date.now()));
      if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
      mostrarFlotante();
    }

    modal.querySelectorAll("[data-close]").forEach(function (el) { el.addEventListener("click", cerrar); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal.classList.contains("is-open")) cerrar(); });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = form.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = "Revisa tu correo, parece que le falta algo."; form.email.focus(); return; }
      var btn = form.querySelector("button");
      btn.disabled = true; btn.textContent = "Enviando…"; msg.textContent = "";
      fetch(CONFIG.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ email: email, _subject: "Nuevo registro comunidad Reset", origen: "Pop-up web" })
      }).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        guardar("registrado");
        form.hidden = true;
        msg.textContent = "Listo, ya estás dentro. Te escribiremos antes que a nadie.";
        setTimeout(cerrar, 3200);
      }).catch(function () {
        btn.disabled = false; btn.textContent = "Continuar";
        msg.textContent = "No se pudo enviar. Inténtalo de nuevo en un momento.";
      });
    });

    // Agrega ?comunidad a la URL para verlo siempre (útil mientras diseñas)
    var forzar = location.search.indexOf("comunidad") > -1;
    var autoPopup = document.body.getAttribute("data-popup") !== "off";
    if (forzar || (autoPopup && !yaVisto())) setTimeout(abrir, forzar ? 0 : CONFIG.retrasoMs);
    else mostrarFlotante();

    /* ===== MENÚ EN CELULAR ===== */
    var toggle = document.getElementById("nav-toggle");
    var menu = document.getElementById("nav-menu");
    if (toggle && menu) {
      toggle.addEventListener("click", function () {
        var abierto = menu.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", abierto ? "true" : "false");
        toggle.textContent = abierto ? "Cerrar" : "Menú";
      });
      menu.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () {
        menu.classList.remove("is-open"); toggle.setAttribute("aria-expanded", "false"); toggle.textContent = "Menú";
      }); });
    }

    /* ===== BOTÓN FLOTANTE: COMUNIDAD ===== */
    var abrirComunidad = document.getElementById("community-open");
    if (abrirComunidad) abrirComunidad.addEventListener("click", function () { abrir(); });

    /* ===== PREGUNTAS FRECUENTES ===== */
    var faq = document.getElementById("faq");
    if (faq) {
    var faqFoco = null;
    function abrirFaq(e) {
      if (e) e.preventDefault();
      faqFoco = document.activeElement;
      if (menu && menu.classList.contains("is-open")) toggle.click();
      faq.classList.add("is-open");
      document.body.style.overflow = "hidden";
      setTimeout(function () { var c = faq.querySelector(".community-close"); if (c) c.focus({ preventScroll: true }); }, 350);
    }
    function cerrarFaq() {
      faq.classList.remove("is-open");
      document.body.style.overflow = "";
      if (faqFoco && faqFoco.focus) faqFoco.focus();
    }
    document.querySelectorAll("[data-open-faq]").forEach(function (b) { b.addEventListener("click", abrirFaq); });
    faq.querySelectorAll("[data-close-faq]").forEach(function (b) { b.addEventListener("click", cerrarFaq); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && faq.classList.contains("is-open")) cerrarFaq(); });
    }

    /* ===== TEXTO QUE SE ACLARA AL BAJAR ===== */
    var rev = document.querySelector("[data-reveal]");
    if (rev) {
      rev.querySelectorAll("p").forEach(function (par) {
        var texto = par.textContent.trim();
        par.setAttribute("aria-label", texto);
        par.innerHTML = texto.split(/[ \t\n\r]+/).map(function (w) { return '<span class="w" aria-hidden="true">' + w + '</span>'; }).join(" ");
      });
      var spans = rev.querySelectorAll(".w");
      var pinta = function () {
        var r = rev.getBoundingClientRect(), vh = window.innerHeight;
        // empieza cuando el texto entra por abajo y termina cuando va por la mitad de la pantalla
        var p = (vh * 0.95 - r.top) / (r.height + vh * 0.3);
        // si ya llegó al final de la página, se muestra completo
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) p = 1;
        p = Math.max(0, Math.min(1, p));
        var n = Math.round(p * spans.length);
        spans.forEach(function (sp, i) { sp.classList.toggle("is-on", i < n); });
      };
      window.addEventListener("scroll", pinta, { passive: true });
      window.addEventListener("resize", pinta);
      pinta();
      setTimeout(function () { if (!spans[0].classList.contains("is-on") && rev.getBoundingClientRect().top < 0) spans.forEach(function (sp) { sp.classList.add("is-on"); }); }, 6000);
    }

    /* ===== ENCABEZADO CON FONDO AL BAJAR ===== */
    var header = document.querySelector(".header");
    var heroEl = document.getElementById("inicio");
    var marcaHeader = function () { if (header && heroEl) header.classList.toggle("is-scrolled", heroEl.getBoundingClientRect().bottom < 90); };
    window.addEventListener("scroll", marcaHeader, { passive: true }); marcaHeader();

    /* ===== FORMULARIO DE MARCAS ===== */
    var fm = document.getElementById("marca-form");
    if (fm) {
      var txt = fm.querySelector("textarea"), cont = document.getElementById("contador"), fmsg = document.getElementById("marca-msg");
      var cuenta = function () { cont.textContent = txt.value.length + " / 2000"; };
      txt.addEventListener("input", cuenta); cuenta();
      fm.addEventListener("submit", function (e) {
        e.preventDefault();
        var d = { nombre: fm.nombre.value.trim(), marca: fm.marca.value.trim(), email: fm.email.value.trim(), mensaje: fm.mensaje.value.trim() };
        if (!d.nombre || !d.mensaje || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) { fmsg.textContent = "Completa tu nombre, un correo válido y tu mensaje."; return; }
        var b = fm.querySelector("button"); b.disabled = true; b.textContent = "Enviando…"; fmsg.textContent = "";
        d._subject = "Nueva solicitud de marca · Reset";
        fetch(CONFIG.endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(d) })
          .then(function (r) { if (!r.ok) throw 0; fm.reset(); cuenta(); b.textContent = "Enviado"; fmsg.textContent = "Gracias. Te escribiremos muy pronto."; })
          .catch(function () { b.disabled = false; b.textContent = "Enviar"; fmsg.textContent = "No se pudo enviar. Inténtalo de nuevo o escríbenos a reset.wellness@gmail.com."; });
      });
    }

    /* ===== MENÚ: EL CAFÉ MARCA LA SECCIÓN QUE SE ESTÁ VIENDO ===== */
    var enlaces = Array.prototype.filter.call(document.querySelectorAll(".nav-menu a[href^='#']"), function (a) {
      var id = a.getAttribute("href").slice(1); return id && document.getElementById(id) && !a.hasAttribute("data-open-faq");
    });
    if (enlaces.length) {
      var marcaActual = function () {
        var actual = null, vh = window.innerHeight;
        enlaces.forEach(function (a) {
          var r = document.getElementById(a.getAttribute("href").slice(1)).getBoundingClientRect();
          if (r.top <= vh * 0.4 && r.bottom > vh * 0.4) actual = a;
        });
        enlaces.forEach(function (a) { a.classList.toggle("is-actual", a === actual); if (a === actual) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
      };
      window.addEventListener("scroll", marcaActual, { passive: true }); marcaActual();
    }

    /* Enlaces pendientes: no llevan a ningún lado todavía */
    document.querySelectorAll("[data-pendiente]").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); }); });

    /* ===== PESTAÑAS (términos y condiciones) ===== */
    var tabs = document.querySelectorAll('.legal-tabs [role="tab"]');
    var activarTab = function (t) {
      tabs.forEach(function (o) {
        var activa = o === t;
        o.setAttribute("aria-selected", activa ? "true" : "false");
        o.tabIndex = activa ? 0 : -1;
        document.getElementById(o.getAttribute("aria-controls")).hidden = !activa;
      });
    };
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        activarTab(t);
        history.replaceState(null, "", t.id === "tab-participantes" ? location.pathname : "#" + t.id.replace("tab-", ""));
      });
    });
    // Desde el pie de página: #reembolsos o #privacidad abren esa pestaña
    var abrirDesdeHash = function () { var t = location.hash && document.getElementById("tab-" + location.hash.slice(1)); if (t && t.getAttribute("role") === "tab") activarTab(t); };
    abrirDesdeHash(); window.addEventListener("hashchange", abrirDesdeHash);
    document.querySelectorAll("[data-ir-tab]").forEach(function (a) {
      a.addEventListener("click", function (e) { var t = document.getElementById(a.getAttribute("data-ir-tab")); if (t) { e.preventDefault(); t.click(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
    });

    /* ===== ENTRADAS ===== */
    var comprar = document.getElementById("comprar");
    if (comprar) {
      var EC = window.RESET_ENTRADAS || { fase: "preventa", links: {}, whatsapp: "573133340844" };
      var precios = { preventa: "$160.000", duo: "$340.000", general: "$200.000" };
      var nombres = { preventa: "la entrada en preventa ($160.000)", duo: "el plan Comparte esta experiencia, 2 entradas ($340.000)", general: "la entrada general ($200.000)" };
      var acepto = document.getElementById("acepto-terminos");
      var ayuda = document.getElementById("comprar-ayuda");
      var fase = EC.fase === "general" ? "general" : "preventa";
      // En preventa solo se vende la preventa; el dúo y la general se habilitan después
      var apagadas = fase === "preventa" ? ["general", "duo"] : ["preventa"];
      apagadas.forEach(function (tipoOff) {
        var cardOff = document.querySelector('.tipo[data-tipo="' + tipoOff + '"]');
        if (!cardOff) return;
        cardOff.classList.add("is-off");
        cardOff.querySelector("input").disabled = true;
        var nota = cardOff.querySelector("[data-nota]");
        if (nota) nota.textContent = fase === "preventa" ? "Disponible cuando termine la preventa" : "Preventa agotada";
      });
      var primera = document.querySelector('.tipo input:not(:disabled)');
      if (primera) primera.checked = true;
      var link = function (tipo) {
        var u = EC.links && EC.links[tipo];
        if (u && u.trim()) return u.trim();
        return "https://wa.me/" + EC.whatsapp + "?text=" + encodeURIComponent("Hola Reset, quiero comprar " + nombres[tipo] + " para el 15 de noviembre.");
      };
      var actualiza = function () {
        var sel = document.querySelector('.tipo input:checked');
        var tipo = sel ? sel.value : fase;
        document.getElementById("comprar-precio").textContent = precios[tipo];
        if (acepto.checked) {
          comprar.setAttribute("aria-disabled", "false"); comprar.href = link(tipo); comprar.target = "_blank"; comprar.rel = "noopener";
          ayuda.textContent = "Serás redirigido a la pasarela de pago.";
        } else {
          comprar.setAttribute("aria-disabled", "true"); comprar.href = "#"; comprar.removeAttribute("target");
          ayuda.textContent = "Marca la casilla para continuar con el pago.";
        }
      };
      document.querySelectorAll('.tipo input, #acepto-terminos').forEach(function (i) { i.addEventListener("change", actualiza); });
      comprar.addEventListener("click", function (e) { if (comprar.getAttribute("aria-disabled") === "true") { e.preventDefault(); acepto.focus(); ayuda.textContent = "Primero acepta los términos y condiciones."; } });
      actualiza();
    }

    /* Enlaces que abren el pop-up de comunidad */
    document.querySelectorAll("[data-abrir-comunidad]").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); abrir(); }); });
  })();
