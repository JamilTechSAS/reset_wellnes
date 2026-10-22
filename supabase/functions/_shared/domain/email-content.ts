/**
 * Confirmation email content.
 *
 * Pure functions: data in, subject/html/text out. No I/O, no provider details, so the
 * exact message a buyer receives can be asserted in a unit test.
 *
 * Security rules encoded here:
 * - The QR payload is the ticket TOKEN, exactly as the Phase 1 domain defines it. The
 *   email never contains a cédula, a phone number, an internal database id or a payment
 *   secret. A forwarded email therefore leaks nothing beyond the admission itself.
 * - Spanish is the product language (the buyers are Colombian); identifiers and code stay
 *   English.
 * - The ticket link is built from `TICKET_BASE_URL` when configured. It points at a page
 *   that does not exist yet (the public ticket page is Phase 6 work), so the link is
 *   OPTIONAL and the token is always shown as text. A confirmation that depends on a
 *   not-yet-built page would be worse than one that does not.
 * - The visual design is deliberately minimal: this phase is about reliable delivery, and
 *   the final template is a design task with the client.
 */

import { formatCopCents, copCents } from "./money.ts";
import type { EmailContext } from "../db/payments.ts";

export type EmailMessage = {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

/** HTML-escapes text that is interpolated into the message. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Formats the event date in the event's own timezone.
 * Falls back to the raw ISO instant if the stored timezone is not usable, so a bad row
 * degrades the greeting instead of failing the send.
 */
export function formatEventDate(startsAt: string, timezone: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) {
    return startsAt;
  }
  try {
    return new Intl.DateTimeFormat("es-CO", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export type BuildConfirmationEmailInput = {
  readonly context: EmailContext;
  /** Optional base URL for the future public ticket page; omitted when not configured. */
  readonly ticketBaseUrl: string | undefined;
};

/**
 * `TICKET_CONFIRMATION` for one ticket.
 *
 * One email per ticket on purpose: each ticket carries its own token and its own QR, so a
 * buyer with three admissions receives three messages they can forward individually. The
 * number of admissions is stated so the buyer can check nothing is missing.
 */
export function buildTicketConfirmationEmail(input: BuildConfirmationEmailInput): EmailMessage {
  const { context } = input;
  const when = formatEventDate(context.eventStartsAt, context.eventTimezone);
  const where = [context.venueName, context.venueAddress, context.city]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(", ");
  const participant =
    [context.participantFirstName, context.participantLastName]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join(" ")
      .trim() || null;
  const price = formatCopCents(copCents(context.pricePaidCents));

  const subject = `Tu entrada para ${context.eventName} está confirmada 🎟️`;

  const textLines = [
    participant === null ? "¡Tu pago fue aprobado!" : `¡Hola ${participant}!`,
    "",
    `Tu entrada para ${context.eventName} está confirmada.`,
    "",
    `Fecha: ${when}`,
    ...(where.length > 0 ? [`Lugar: ${where}`] : []),
    `Código de entrada: ${context.ticketToken}`,
    `Valor: ${price}`,
    `Referencia de compra: ${context.orderReference}`,
    "",
    "Presenta este código en la entrada. Es personal e intransferible en caso de que el",
    "aforo esté completo; si otra persona va a usarlo, comparte este mismo correo.",
    "",
    "Recomendaciones: llega con anticipación, lleva un documento de identidad y ten en",
    "cuenta el clima de la ciudad para elegir tu ropa.",
    ...(input.ticketBaseUrl === undefined
      ? []
      : [
          "",
          `Ver tu entrada: ${input.ticketBaseUrl.replace(/\/+$/, "")}/t/${context.ticketToken}`,
        ]),
    "",
    "Si tienes dudas, responde a este correo.",
  ];

  const html = [
    "<!doctype html>",
    '<html lang="es">',
    '<body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;">',
    participant === null
      ? '<p style="margin:0 0 12px;">¡Tu pago fue aprobado!</p>'
      : `<p style="margin:0 0 12px;">¡Hola ${escapeHtml(participant)}!</p>`,
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">Tu entrada para ${escapeHtml(
      context.eventName,
    )} está confirmada</h1>`,
    `<p style="margin:0 0 6px;"><strong>Fecha:</strong> ${escapeHtml(when)}</p>`,
    ...(where.length > 0
      ? [`<p style="margin:0 0 6px;"><strong>Lugar:</strong> ${escapeHtml(where)}</p>`]
      : []),
    `<p style="margin:0 0 6px;"><strong>Valor:</strong> ${escapeHtml(price)}</p>`,
    `<p style="margin:0 0 6px;"><strong>Referencia:</strong> ${escapeHtml(
      context.orderReference,
    )}</p>`,
    '<p style="margin:20px 0 6px;"><strong>Tu código de entrada</strong></p>',
    `<p style="margin:0 0 8px;padding:14px;background:#f1f5f9;border-radius:8px;font-family:'Courier New',monospace;font-size:18px;letter-spacing:1px;text-align:center;">${escapeHtml(
      context.ticketToken,
    )}</p>`,
    '<p style="margin:0 0 16px;color:#555;font-size:14px;">Presenta este código en la entrada. Guárdalo: es tu comprobante de acceso.</p>',
    ...(input.ticketBaseUrl === undefined
      ? []
      : [
          `<p style="margin:0 0 16px;"><a href="${escapeHtml(
            `${input.ticketBaseUrl.replace(/\/+$/, "")}/t/${context.ticketToken}`,
          )}" style="color:#0f766e;">Ver tu entrada en línea</a></p>`,
        ]),
    '<p style="margin:0;color:#555;font-size:14px;">Recomendaciones: llega con anticipación, lleva un documento de identidad y ten en cuenta el clima de la ciudad para elegir tu ropa.</p>',
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");

  return { subject, html, text: textLines.join("\n") };
}

/**
 * Subject used when a permanent delivery failure is recorded for an operator to see.
 * Kept here so the wording lives with the rest of the copy.
 */
export const EMAIL_ERROR_PREFIX = "TICKET_CONFIRMATION";
