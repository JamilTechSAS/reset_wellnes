/**
 * Event Content Configuration (Phase 6C — real client content)
 *
 * Single source of truth for the Re set Sunset Vol. 1 landing page.
 *
 * Every value below comes from the client handover ZIP
 * (`Reset-web-para-programador-…zip`: reset-web/*.html, js/entradas-config.js,
 * LEEME-PROGRAMADOR.md and the brand manual board). Values the client has NOT supplied are
 * typed `null`/optional and rendered as "por confirmar" — no capacity, no discount code,
 * no sales-stage dates, no street address, no map link and no dress-code colour were invented.
 *
 * Kept out of this file on purpose: the legal documents live in `./legal-content.ts`
 * (they are quoted client text, not marketing copy).
 */

import type { EventLandingConfig } from "../types/content.ts";

export const EVENT_CONTENT_CONFIG: EventLandingConfig = {
  meta: {
    title: "Re set Sunset Vol. 1 · Reset Wellness Club | 15 de noviembre, Montería",
    description:
      "Re set Sunset Vol. 1: una tarde de bienestar en la terraza del hotel GHL, Montería. Pilates, yoga, spinning, inmersión en hielo, quiropráctica, sueroterapia, bronceo y activaciones de marcas. Domingo 15 de noviembre de 2026, 1:00 p.m. a 7:00 p.m.",
    // The client domain is still pending (their own terms say "ubicado en (pendiente: dominio)").
    // `.example` is the reserved, non-routable TLD, so this placeholder can never point at a
    // real third-party site by accident. Replace it with the production domain before launch.
    canonicalUrl: "https://dominio-pendiente.example",
    locale: "es_CO",
    siteName: "Reset Wellness Club",
    themeColor: "#513229",
    // No photographic OG asset was delivered. This file is a branded card built from the real
    // logo and palette; a photographic 1200×630 raster is still owed by the client.
    ogImageUrl: "/og-image.svg",
    ogImagePendingRaster: true,
  },

  branding: {
    brandName: "Reset Wellness Club",
    eventName: "Re set Sunset",
    edition: "Vol. 1 · Montería",
    organizer: "Reset Wellness Club",
    // The client states "Cupos limitados" but never a number: no capacity is shown.
    badgeText: "Cupos limitados",
    logoFullSrc: "/assets/reset/logo-reset.png",
    logoShortSrc: "/assets/reset/logo-reset-corto.png",
    logoAlt: "Reset Wellness Club",
    logoFullWidth: 1312,
    logoFullHeight: 609,
  },

  hero: {
    eyebrow: "MONTERÍA, CÓRDOBA · DOMINGO 15 DE NOVIEMBRE DE 2026",
    headline: "Una tarde de bienestar para moverte, cuidarte,",
    highlightPhrase: "conectar y hacer re set.",
    tagline:
      "Creamos espacios para detenerte, respirar, moverte, conectar y volver a ti. Experiencias que despiertan tus sentidos, reúnen personas y convierten el bienestar en una forma de vivir.",
    dateLabel: "15 Nov 2026",
    timeLabel: "1:00 p.m. – 7:00 p.m.",
    locationLabel: "Terraza del hotel GHL, Montería",
    primaryCtaText: "COMPRAR ENTRADA",
    secondaryCtaText: "Conoce la experiencia",
    capacityNotice:
      "Cupos limitados · La organización confirmará el aforo final antes de la apertura de ventas.",
    facts: [
      { id: "fact-date", value: "15 Nov 2026", label: "Domingo" },
      { id: "fact-hours", value: "6 horas", label: "De 1:00 p.m. a 7:00 p.m." },
      { id: "fact-venue", value: "Hotel GHL", label: "Terraza · Montería" },
    ],
    imagePendingNote:
      "Fotografía y video oficiales pendientes: el material entregado no incluye imágenes del evento.",
  },

  experiences: {
    sectionEyebrow: "LO QUE VIVIRÁS",
    sectionTitle: "Una tarde llena de experiencias",
    sectionDescription:
      "Durante Re set Sunset podrás disfrutar de diferentes experiencias diseñadas para moverte, cuidarte y sentirte bien.",
    items: [
      {
        id: "exp-pilates",
        title: "Pilates",
        description:
          "Movimiento consciente para activar el cuerpo, trabajar la respiración y la fuerza desde el centro.",
        tag: "Movimiento",
        iconName: "stretch",
      },
      {
        id: "exp-yoga",
        title: "Yoga",
        description:
          "Una práctica para bajar el ritmo, estirar y volver a la respiración en un espacio pensado para desconectar.",
        tag: "Movimiento",
        iconName: "lotus",
      },
      {
        id: "exp-spinning",
        title: "Spinning",
        description:
          "Energía, ritmo y música para subir la intensidad de la tarde y soltar lo que sobra.",
        tag: "Movimiento",
        iconName: "bike",
      },
      {
        id: "exp-hielo",
        title: "Inmersión en hielo",
        description:
          "Por primera vez en Montería, llevamos la inmersión en hielo a una experiencia de bienestar: un desafío para el cuerpo y la mente que te invita a controlar tu respiración, estar presente y descubrir de qué eres capaz.",
        tag: "El momento que lo cambia todo",
        iconName: "snowflake",
      },
      {
        id: "exp-quiro",
        title: "Quiropráctica",
        description:
          "Ajustes y acompañamiento profesional para aliviar tensión y mejorar la movilidad.",
        tag: "Cuidado personal",
        iconName: "activity",
      },
      {
        id: "exp-suero",
        title: "Sueroterapia",
        description:
          "Tratamiento intravenoso de hidratación y vitaminas, realizado por personal profesional durante el evento.",
        tag: "Cuidado personal",
        iconName: "droplet",
      },
      {
        id: "exp-bronceo",
        title: "Bronceo",
        description: "Un espacio de belleza para consentirte y salir con un glow natural.",
        tag: "Cuidado personal",
        iconName: "sun",
      },
    ],
  },

  included: {
    sectionEyebrow: "TODO INCLUIDO",
    sectionTitle: "¿Qué incluye tu entrada?",
    sectionDescription:
      "Todas las experiencias del día, activaciones de marcas, kit de bienvenida y espacios para compartir y conectar.",
    items: [
      {
        id: "inc-experiencias",
        title: "Todas las experiencias del día",
        description:
          "Acceso a las actividades programadas durante la tarde, incluidas la inmersión en hielo y las clases guiadas.",
        badge: "Experiencias",
        iconName: "check",
      },
      {
        id: "inc-marcas",
        title: "Activaciones de marcas",
        description:
          "Espacios donde las marcas aliadas se integran a la experiencia con producto y momentos para probar.",
        badge: "Marcas",
        iconName: "sparkle",
      },
      {
        id: "inc-kit",
        title: "Kit de bienvenida",
        description:
          "Kit de bienvenida de la experiencia. El detalle de su contenido está pendiente de confirmación por la organización.",
        badge: "Kit",
        iconName: "gift",
      },
      {
        id: "inc-espacios",
        title: "Espacios para compartir y conectar",
        description: "Zonas pensadas para quedarte, conocer personas y disfrutar la tarde.",
        badge: "Comunidad",
        iconName: "community",
      },
    ],
  },

  alliedBrands: {
    sectionEyebrow: "MARCAS & ALIANZAS",
    sectionTitle: "Las marcas que hacen parte de la experiencia",
    sectionDescription:
      "En Re set nos unimos a marcas que comparten nuestra forma de entender el bienestar: belleza, gastronomía saludable, movimiento, cuidado personal y lifestyle.",
    // The handover contained one (1) real partner logo. The remaining slots stay unpublished
    // until the client supplies each logo together with permission to publish it.
    disclaimer:
      "Estamos confirmando las marcas aliadas de esta edición. Publicamos un logo únicamente cuando la marca lo autoriza.",
    items: [
      {
        id: "brand-ghl",
        name: "GHL Hoteles",
        category: "Venue de la experiencia",
        websiteUrl: "https://www.ghlhoteles.com/es/",
        logoSrc: "/assets/reset/logo-ghl.png",
        logoAlt: "GHL Hoteles",
        logoWidth: 600,
        logoHeight: 234,
      },
    ],
  },

  details: {
    sectionEyebrow: "COORDENADAS",
    sectionTitle: "Fecha, hora y lugar",
    dateFull: "Domingo, 15 de noviembre de 2026",
    schedule: "1:00 p.m. – 7:00 p.m. · Montería, Córdoba",
    venueName: "Terraza del hotel GHL",
    city: "Montería, Córdoba",
    country: "Colombia",
    // The client supplied no street address, so none is shown.
    venueAddress: null,
    // No verified Maps link exists; the UI shows the pending state instead of a fake query.
    mapUrl: null,
    mapButtonText: "Ver ubicación en Google Maps",
    mapPendingLabel: "Dirección y mapa: por confirmar",
    dressCode: "Sport + [color por confirmar]",
    whatToBring: ["Vestido de baño", "Toalla", "Bloqueador", "Tu documento de identidad"],
    accessNote:
      "Cupos limitados. El evento se realiza en una terraza, así que te recomendamos confirmar el clima del día y llegar con tiempo antes del inicio de las actividades.",
  },

  faq: {
    sectionEyebrow: "RESOLVEMOS TUS DUDAS",
    sectionTitle: "Preguntas frecuentes",
    sectionDescription:
      "Estas son las respuestas que la organización confirmó para Re set Sunset Vol. 1. Si tu duda no está aquí, escríbenos por WhatsApp o correo.",
    items: [
      {
        id: "faq-incluye",
        question: "¿Qué incluye mi entrada?",
        answer:
          "Todas las experiencias del día, activaciones de marcas, kit de bienvenida y espacios para compartir y conectar.",
      },
      {
        id: "faq-nivel",
        question: "¿Puedo ir aunque nunca haya hecho estas actividades?",
        answer:
          "Sí. Re set es para todos los niveles; solo necesitas ganas de vivir la experiencia.",
      },
      {
        id: "faq-acompanante",
        question: "¿Puedo ir con alguien?",
        answer:
          "Sí. Después de la preventa estará disponible Comparte esta experiencia: dos entradas a un precio especial.",
      },
      {
        id: "faq-llevar",
        question: "¿Qué debo llevar?",
        answer:
          "Vestido de baño, toalla, bloqueador y tu documento de identidad. Código de vestuario: Sport + [color por confirmar].",
      },
      {
        id: "faq-hielo",
        question: "¿Cómo funciona la inmersión en hielo?",
        answer:
          "Es una experiencia de respiración y exposición breve al frío acompañada por el equipo del evento. La organización confirmará las recomendaciones previas y las condiciones de participación; si tienes alguna condición médica, escríbenos antes del evento.",
      },
      {
        id: "faq-que-es-reset",
        question: "¿Qué es Re set?",
        answer:
          "Una comunidad de bienestar que crea experiencias para moverse, cuidarse y conectar en Montería.",
      },
      {
        id: "faq-frecuencia",
        question: "¿Cada cuánto hay eventos?",
        answer:
          "Re set Sunset Vol. 1 es el primero de muchos. Vendrán nuevos eventos con distintas actividades y experiencias, y los anunciaremos con tiempo. Suscríbete para enterarte antes que nadie.",
      },
      {
        id: "faq-comunidad",
        question: "¿Cómo hago parte de la comunidad?",
        answer:
          "Síguenos en @reset.wll y escríbenos a reset.wellness@gmail.com para recibir el aviso de los próximos eventos antes que nadie.",
      },
      {
        id: "faq-marca",
        question: "¿Cómo puede participar mi marca?",
        answer:
          "Escríbenos a reset.wellness@gmail.com con el nombre de tu marca y contaremos cómo integrarla a la experiencia.",
      },
      {
        id: "faq-entrega",
        question: "¿Cómo y cuándo recibo mi entrada?",
        answer:
          "No hay boletas ni códigos QR: al confirmarse tu pago, tu compra queda registrada a nombre del titular y visible en esta página con su referencia. El día del evento solo necesitas tu documento de identidad.",
      },
      {
        id: "faq-pagos",
        question: "¿Qué medios de pago puedo usar?",
        answer:
          "Los medios de pago habilitados están pendientes de confirmación por parte de la organización. Si necesitas ayuda para completar tu compra, escríbenos a reset.wellness@gmail.com.",
        isPending: true,
      },
      {
        id: "faq-reembolsos",
        question: "¿Puedo pedir un reembolso?",
        answer:
          "Sí: la organización acepta cancelaciones dentro de los 7 días posteriores a la compra, según su política de reembolsos. Allí están las condiciones completas y las excepciones.",
      },
    ],
  },

  contact: {
    sectionEyebrow: "ESTAMOS PARA AYUDARTE",
    sectionTitle: "Contacto",
    sectionDescription:
      "¿Tienes dudas sobre el evento o necesitas ayuda con tu compra? Escríbenos directamente.",
    organizerName: "Reset Wellness Club",
    email: "reset.wellness@gmail.com",
    supportNote:
      "Atendemos por WhatsApp y correo electrónico. También puedes escribirnos por Instagram.",
    channels: [
      {
        platform: "whatsapp",
        label: "WhatsApp",
        handle: "313 334 0844",
        url: "https://wa.me/573133340844",
        description: "Atención directa para asistentes y consultas sobre la compra",
      },
      {
        platform: "email",
        label: "Correo electrónico",
        handle: "reset.wellness@gmail.com",
        url: "mailto:reset.wellness@gmail.com",
        description: "Reembolsos, alianzas de marca y consultas de datos personales",
      },
      {
        platform: "instagram",
        label: "Instagram",
        handle: "@reset.wll",
        url: "https://instagram.com/reset.wll",
        description: "Novedades, anuncios y contenido del evento",
      },
    ],
  },

  finalCta: {
    eyebrow: "ASEGURA TU LUGAR",
    title: "Vive Re set Sunset Vol. 1",
    description:
      "La preventa está abierta. Las entradas se confirman contra la disponibilidad real del sistema al momento de la compra.",
    buttonText: "COMPRAR MI ENTRADA",
    trustBadges: [
      "Pago procesado de forma segura por ePayco",
      "Compra registrada a nombre del titular, sin boletas físicas",
      "Confirmación de la orden con su referencia de compra",
    ],
    ticketOptionsTitle: "Entradas",
    ticketOptions: [
      {
        id: "ticket-preventa",
        name: "Preventa",
        priceLabel: "$160.000",
        detail: "Fase actual de venta",
        status: "current",
      },
      {
        id: "ticket-duo",
        name: "Comparte esta experiencia",
        priceLabel: "$340.000",
        detail: "2 entradas · $170.000 por persona · se habilita al terminar la preventa",
        status: "upcoming",
      },
      {
        id: "ticket-general",
        name: "General",
        priceLabel: "$200.000",
        detail: "Se habilita al terminar la preventa",
        status: "upcoming",
      },
    ],
    ticketOptionsCaption:
      "Precios en pesos colombianos (COP). La fase activa, la disponibilidad y el valor final los confirma el sistema al iniciar la compra.",
  },

  footer: {
    copyrightText: "© 2026 Reset Wellness Club. Todos los derechos reservados.",
    legalLinks: [
      {
        id: "terms",
        label: "Términos y condiciones",
        href: "#legal-participantes",
        tab: "participantes",
      },
      {
        id: "refunds",
        label: "Política de reembolsos",
        href: "#legal-reembolsos",
        tab: "reembolsos",
      },
      {
        id: "privacy",
        label: "Política de privacidad y tratamiento de datos",
        href: "#legal-privacidad",
        tab: "privacidad",
      },
      { id: "contact-link", label: "Contacto", href: "#contacto" },
      { id: "lookup-link", label: "Consultar mi compra", href: "#consultar" },
    ],
  },
};
