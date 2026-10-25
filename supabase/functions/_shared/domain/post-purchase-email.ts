/**
 * Post-purchase email content.
 *
 * Port of the client's design (`Correo postcompra/correo/correo.html`): the same palette,
 * table layout, header image, buttons and footer copy. Pure functions — data in, subject /
 * html / text out — so the exact message a buyer receives is asserted in a unit test and the
 * dispatcher never builds markup.
 *
 * What changed from the supplied design, and why:
 *
 *   - The per-buyer ticket image (`{{URL_ENTRADA}}`, a Playwright render of a ticket with its
 *     own QR) is NOT included. Tickets, tokens and QR codes were discontinued in migration
 *     20261024120000: the backend no longer issues them, so there is nothing truthful to
 *     render and this module must not invent a code or a QR. The email instead states what
 *     the database actually holds: how many admissions were paid and how many participants
 *     are registered.
 *   - The QR paragraph ("muestra el código QR de tu entrada") and the preheader sentence that
 *     mentions a QR were rewritten for the same reason. Claiming a QR exists when it does not
 *     would send buyers to the door looking for something they cannot show.
 *   - `{{CODIGO}}` (RST-000123, the ticket code) becomes the order reference, labelled
 *     "N.º de pedido". The document line keeps the supplied half-mask (•••• 1234) and uses the
 *     buyer's own last four digits only.
 *   - `{{URL_IMAGENES}}` comes from configuration (`EMAIL_ASSETS_BASE_URL`, defaulting to the
 *     public site's `/correo/img`), because the Desktop folder does not exist at runtime.
 *
 * Security rules: every interpolated value is HTML-escaped; the message contains only the
 * buyer's own name, their document's last four digits, order/event data and admission counts.
 * No other attendee's data, no full document, no payment payload, no secret.
 */

import { formatCopCents, copCents } from "./money.ts";
import { escapeHtml } from "./email-content.ts";

export const POST_PURCHASE_TEMPLATE = "POST_PURCHASE";

/** Supplied subject line, unchanged. */
export const POST_PURCHASE_EMAIL_SUBJECT = "Tu entrada para Re set Sunset está lista";

/** Order + buyer context, as returned by `get_post_purchase_email_context()`. */
export type PostPurchaseEmailContext = {
  readonly deliveryId: string;
  readonly template: string;
  readonly attemptCount: number;
  readonly recipientEmail: string;
  readonly orderReference: string;
  readonly currency: string;
  readonly totalInCents: number;
  readonly quantity: number;
  readonly registeredParticipants: number;
  readonly unitPriceInCents: number;
  readonly packageName: string | null;
  readonly pricingTierName: string | null;
  readonly bundleCode: string | null;
  readonly eventCode: string;
  readonly eventName: string;
  readonly eventStartsAt: string;
  readonly eventTimezone: string;
  readonly venueName: string | null;
  readonly venueAddress: string | null;
  readonly city: string | null;
  readonly buyerFirstName: string | null;
  readonly buyerLastName: string | null;
  readonly buyerDocumentLast4: string | null;
};

export type PostPurchaseEmailMessage = {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

export type BuildPostPurchaseEmailInput = {
  readonly context: PostPurchaseEmailContext;
  /** Public directory that holds `encabezado.jpg` and `logo-beige.png` (no trailing slash). */
  readonly assetsBaseUrl: string;
  /** Public site base URL, used for the terms link (no trailing slash). */
  readonly publicWebBaseUrl: string;
};

/** Resend idempotency key for the one logical email of an order. */
export function buildPostPurchaseIdempotencyKey(orderId: string): string {
  return `order:${orderId}:${POST_PURCHASE_TEMPLATE}`;
}

/** "Ana Pérez" / "Ana" / "" — never a placeholder the buyer could mistake for data. */
function displayName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(" ");
}

/** "Domingo 15 de noviembre de 2026", from the event's own instant and timezone. */
function formatDateOnly(startsAt: string, timezone: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) {
    return startsAt;
  }
  try {
    return new Intl.DateTimeFormat("es-CO", {
      dateStyle: "full",
      timeZone: timezone,
    }).format(date);
  } catch {
    return startsAt;
  }
}

/** "1:00 p.m. a 7:00 p.m." — the event runs from `startsAt` for six hours (supplied copy). */
function formatTimeRange(startsAt: string, timezone: string): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) {
    return "";
  }
  const formatter = new Intl.DateTimeFormat("es-CO", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  });
  const end = new Date(start.getTime() + 6 * 60 * 60 * 1000);
  try {
    return `${formatter.format(start)} a ${formatter.format(end)}`;
  } catch {
    return "";
  }
}

function formatPlace(context: PostPurchaseEmailContext): string {
  return [context.venueName, context.venueAddress, context.city]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(", ");
}

/**
 * What the buyer actually holds: admissions paid vs participants registered.
 *
 * It never says "all attendees are registered" unless the counts match. A three-admission
 * order with only the buyer's data says so, and tells the buyer how to complete the rest.
 */
function admissionSummary(context: PostPurchaseEmailContext): string {
  const purchased = Math.max(context.quantity, 0);
  const registered = Math.max(Math.min(context.registeredParticipants, purchased), 0);
  const noun = purchased === 1 ? "entrada" : "entradas";
  if (registered >= purchased) {
    return `${purchased} ${noun}. Registramos los datos de ${purchased} ${
      purchased === 1 ? "persona" : "personas"
    } de la compra.`;
  }
  return `${purchased} ${noun}. Tenemos los datos de ${registered} ${
    registered === 1 ? "persona" : "personas"
  }. Escríbenos por WhatsApp para completar los datos de ${
    purchased - registered === 1 ? "tu acompañante" : "tus acompañantes"
  }.`;
}

export function buildPostPurchaseEmail(
  input: BuildPostPurchaseEmailInput,
): PostPurchaseEmailMessage {
  const { context } = input;
  const assets = input.assetsBaseUrl.replace(/\/+$/, "");
  const site = input.publicWebBaseUrl.replace(/\/+$/, "");
  const buyer = displayName(context.buyerFirstName, context.buyerLastName);
  const firstName = context.buyerFirstName?.trim();
  const greeting = firstName !== undefined && firstName.length > 0 ? firstName : "bienvenido";
  const date = formatDateOnly(context.eventStartsAt, context.eventTimezone);
  const time = formatTimeRange(context.eventStartsAt, context.eventTimezone);
  const place = formatPlace(context);
  const total = formatCopCents(copCents(context.totalInCents));
  const product = context.packageName?.trim();
  const admissions = admissionSummary(context);
  const documentLine =
    context.buyerDocumentLast4 === null || context.buyerDocumentLast4.trim().length === 0
      ? "—"
      : `C.C. •••• ${context.buyerDocumentLast4}`;

  // Supplied copy, minimally adapted: no QR, no ticket code, same voice and structure.
  const preheader =
    "Gracias por regalarte este momento. Aquí está el resumen de tu compra para el 15 de noviembre.";
  const leadParagraph =
    "El día del evento te esperamos con tu documento de identidad: tu compra queda registrada a tu nombre. Guarda este correo como comprobante.";

  const productRow = (label: string, value: string): string => `
                    <tr>
                      <td colspan="2" valign="top" style="padding: 0 0 18px 0">
                        <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #8A7A6E">${escapeHtml(label)}</p>
                        <p style="margin: 0; font-size: 16px; color: #2B201C">${escapeHtml(value)}</p>
                      </td>
                    </tr>`;

  const pair = (
    leftLabel: string,
    leftValue: string,
    rightLabel: string,
    rightValue: string,
  ): string => `
                    <tr>
                      <td class="col" width="50%" valign="top" style="padding: 0 12px 18px 0">
                        <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #8A7A6E">${escapeHtml(leftLabel)}</p>
                        <p style="margin: 0; font-size: 16px; color: #2B201C">${escapeHtml(leftValue)}</p>
                      </td>
                      <td class="col" width="50%" valign="top" style="padding: 0 0 18px 12px">
                        <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #8A7A6E">${escapeHtml(rightLabel)}</p>
                        <p style="margin: 0; font-size: 16px; color: #2B201C">${escapeHtml(rightValue)}</p>
                      </td>
                    </tr>`;

  const html = `<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(POST_PURCHASE_EMAIL_SUBJECT)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300&family=Questrial&display=swap" rel="stylesheet">
<style>
  body { margin: 0; padding: 0; background: #E9E5D6; }
  img { border: 0; display: block; outline: none; text-decoration: none; }
  a { color: #F4F1E2; }
  @media only screen and (max-width: 620px) {
    .contenedor { width: 100% !important; }
    .full { width: 100% !important; height: auto !important; }
    .pad { padding-left: 24px !important; padding-right: 24px !important; }
    .col { display: block !important; width: 100% !important; padding-left: 0 !important; padding-right: 0 !important; }
    .boton { display: block !important; width: 100% !important; margin-bottom: 10px !important; }
  }
</style>
</head>
<body style="margin: 0; padding: 0; background: #E9E5D6">
<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #E9E5D6">
  <tr>
    <td align="center" style="padding: 32px 12px">
      <table role="presentation" class="contenedor" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 600px; background: #513229; border-radius: 16px; overflow: hidden">
        <tr>
          <td style="padding: 0">
            <img class="full" src="${escapeHtml(assets)}/encabezado.jpg" width="600" height="780" alt="Gracias por creer en nuestro sueño y, sobre todo, por regalarte este momento para ti. Con amor, Re set" style="width: 600px; height: auto; border-top-left-radius: 16px; border-top-right-radius: 16px">
          </td>
        </tr>
        <tr><td style="height: 2px; line-height: 2px; font-size: 0; background: #E9E5D6">&nbsp;</td></tr>
        <tr>
          <td class="pad" style="padding: 40px 48px 0; font-family: 'Questrial', 'Helvetica Neue', Arial, sans-serif">
            <p style="margin: 0 0 14px; font-size: 12px; letter-spacing: 0.3em; text-transform: uppercase; color: #CDBFA8">Compra confirmada</p>
            <h1 style="margin: 0 0 14px; font-family: 'Fraunces', Georgia, 'Times New Roman', serif; font-weight: 300; font-size: 22px; line-height: 1.35; color: #F4F1E2">Hola, ${escapeHtml(greeting)}. Tu lugar en Re set Sunset está listo.</h1>
            <p style="margin: 0; font-size: 16px; line-height: 1.65; color: #E8DCC4">${escapeHtml(leadParagraph)}</p>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding: 28px 48px 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F4F1E2; border-radius: 14px">
              <tr>
                <td style="padding: 24px 28px 4px; font-family: 'Questrial', 'Helvetica Neue', Arial, sans-serif">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${pair("Fecha", date, "Hora", time)}
${pair("Lugar", place.length > 0 ? place : "Terraza del hotel GHL, Montería", "Titular", buyer.length > 0 ? buyer : "—")}
${pair("Documento", documentLine, "N.º de pedido", context.orderReference)}
${pair("Entradas", admissions, "Total pagado", total)}
${product === undefined || product.length === 0 ? "" : productRow("Producto", product)}
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding: 28px 48px 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="boton" width="50%" style="padding-right: 6px">
                  <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Re%20set%20Sunset%20Vol.%201&amp;dates=20261115T180000Z/20261116T000000Z&amp;location=Terraza%20hotel%20GHL%2C%20Monter%C3%ADa&amp;details=Lleva%20tu%20documento%20de%20identidad%20y%20este%20comprobante." target="_blank" style="display: block; padding: 14px 10px; border-radius: 999px; background: #F4F1E2; color: #513229; text-align: center; text-decoration: none; font-family: 'Questrial', 'Helvetica Neue', Arial, sans-serif; font-size: 15px">Agregar al calendario</a>
                </td>
                <td class="boton" width="50%" style="padding-left: 6px">
                  <a href="https://www.google.com/maps/search/?api=1&amp;query=Hotel%20GHL%20Monter%C3%ADa" target="_blank" style="display: block; padding: 12.5px 10px; border-radius: 999px; border: 1.5px solid #F4F1E2; color: #F4F1E2; text-align: center; text-decoration: none; font-family: 'Questrial', 'Helvetica Neue', Arial, sans-serif; font-size: 15px">Cómo llegar</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" align="center" style="padding: 40px 48px 40px; text-align: center; font-family: 'Questrial', 'Helvetica Neue', Arial, sans-serif">
            <img src="${escapeHtml(assets)}/logo-beige.png" width="110" alt="Re set Wellness Club" style="width: 110px; height: auto; margin: 0 auto 14px">
            <p style="margin: 0 0 14px; font-size: 14px; line-height: 1.6; color: #E8DCC4">¿Dudas? Escríbenos al WhatsApp <a href="https://wa.me/573103533574" style="color: #E8DCC4">310 353 3574</a> o a <a href="mailto:reset.wellness@gmail.com" style="color: #E8DCC4">reset.wellness@gmail.com</a></p>
            <p style="margin: 0 0 14px; font-size: 14px; color: #F4F1E2"><a href="https://instagram.com/reset.wll" style="color: #F4F1E2">Instagram @reset.wll</a> · <a href="https://www.tiktok.com/@reset.wellness.cl" style="color: #F4F1E2">TikTok @reset.wellness.cl</a></p>
            <p style="margin: 0; font-size: 12px; line-height: 1.6; color: #CDBFA8">Al usar esta entrada aceptas nuestros <a href="${escapeHtml(site)}/terminos-y-condiciones.html" style="color: #CDBFA8">términos y condiciones</a>.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    `Hola, ${greeting}. Tu lugar en Re set Sunset está listo.`,
    "",
    leadParagraph,
    "",
    `Fecha: ${date}`,
    ...(time.length > 0 ? [`Hora: ${time}`] : []),
    `Lugar: ${place.length > 0 ? place : "Terraza del hotel GHL, Montería"}`,
    `Titular: ${buyer.length > 0 ? buyer : "—"}`,
    `Documento: ${documentLine}`,
    `N.º de pedido: ${context.orderReference}`,
    `Entradas: ${admissions}`,
    `Total pagado: ${total}`,
    ...(product === undefined || product.length === 0 ? [] : [`Producto: ${product}`]),
    "",
    "Agregar al calendario: https://calendar.google.com/calendar/render?action=TEMPLATE&text=Re%20set%20Sunset%20Vol.%201&dates=20261115T180000Z/20261116T000000Z&location=Terraza%20hotel%20GHL%2C%20Monter%C3%ADa",
    "Cómo llegar: https://www.google.com/maps/search/?api=1&query=Hotel%20GHL%20Monter%C3%ADa",
    "",
    "¿Dudas? WhatsApp 310 353 3574 o reset.wellness@gmail.com",
    "Instagram @reset.wll · TikTok @reset.wellness.cl",
    `Términos y condiciones: ${site}/terminos-y-condiciones.html`,
  ].join("\n");

  return { subject: POST_PURCHASE_EMAIL_SUBJECT, html, text };
}
