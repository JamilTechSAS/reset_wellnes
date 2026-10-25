/**
 * Post-purchase email content.
 *
 * The client's design is a fixed header image, a per-buyer ticket image with its own QR, and
 * the information block. Tickets/QR codes no longer exist, so these tests pin the two things
 * that matter: the message never claims a QR or a ticket code that the backend cannot produce,
 * and the admission counts are stated truthfully (paid vs. registered).
 */

import { describe, expect, it } from "vitest";

import {
  buildPostPurchaseEmail,
  buildPostPurchaseIdempotencyKey,
  POST_PURCHASE_EMAIL_SUBJECT,
  type PostPurchaseEmailContext,
} from "@shared/domain/post-purchase-email.ts";

const CONTEXT: PostPurchaseEmailContext = {
  deliveryId: "11111111-1111-4111-8111-111111111111",
  template: "POST_PURCHASE",
  attemptCount: 1,
  recipientEmail: "ana@example.com",
  orderReference: "EVT-2026-000012",
  currency: "COP",
  totalInCents: 34_000_000,
  quantity: 2,
  registeredParticipants: 1,
  unitPriceInCents: 17_000_000,
  packageName: "Comparte esta experiencia",
  pricingTierName: "General",
  bundleCode: "DOUBLE_EXPERIENCE",
  eventCode: "RESET-SUNSET-2026",
  eventName: "Re set Sunset — Vol. 1",
  eventStartsAt: "2026-11-15T18:00:00.000Z",
  eventTimezone: "America/Bogota",
  venueName: "Terraza del hotel GHL",
  venueAddress: null,
  city: "Montería",
  buyerFirstName: "Ana",
  buyerLastName: "Pérez",
  buyerDocumentLast4: "6789",
};

const INPUT = {
  context: CONTEXT,
  assetsBaseUrl: "https://evento.example/correo/img",
  publicWebBaseUrl: "https://evento.example",
};

describe("post-purchase email", () => {
  it("keeps the supplied subject and every supplied design asset", () => {
    const message = buildPostPurchaseEmail(INPUT);
    expect(message.subject).toBe("Tu entrada para Re set Sunset está lista");
    expect(message.subject).toBe(POST_PURCHASE_EMAIL_SUBJECT);
    expect(message.html).toContain("https://evento.example/correo/img/encabezado.jpg");
    expect(message.html).toContain("https://evento.example/correo/img/logo-beige.png");
    // The supplied palette and button destinations survive the port.
    expect(message.html).toContain("#513229");
    expect(message.html).toContain("calendar.google.com");
    expect(message.html).toContain("google.com/maps");
    expect(message.html).toContain("wa.me/573103533574");
    expect(message.html).toContain("https://evento.example/terminos-y-condiciones.html");
    // No template placeholder may ever reach a buyer.
    expect(message.html).not.toContain("{{");
  });

  it("never promises a QR, a ticket code or a digital ticket", () => {
    for (const message of [buildPostPurchaseEmail(INPUT)]) {
      const text = `${message.html}\n${message.text}`.toLowerCase();
      expect(text).not.toContain("código qr");
      expect(text).not.toContain("qr ");
      expect(text).not.toContain("rst-");
      expect(text).not.toContain("n.º de entrada");
    }
  });

  it("prints the verified order and buyer details instead", () => {
    const message = buildPostPurchaseEmail(INPUT);
    for (const value of [
      "Ana Pérez",
      "EVT-2026-000012",
      "•••• 6789",
      "Comparte esta experiencia",
      "$340.000",
      "Terraza del hotel GHL",
      "Montería",
    ]) {
      expect(message.text).toContain(value);
    }
    expect(message.html).toContain("N.º de pedido");
    expect(message.text).toContain("documento de identidad");
  });

  it("says how many admissions are registered and asks for the rest", () => {
    const bundle = buildPostPurchaseEmail(INPUT);
    // Two admissions bought, only the buyer registered: the copy must say so.
    expect(bundle.text).toContain("2 entradas");
    expect(bundle.text).toContain("Tenemos los datos de 1 persona");
    expect(bundle.text).toContain("tu acompañante");

    const three: PostPurchaseEmailContext = {
      ...CONTEXT,
      quantity: 3,
      registeredParticipants: 1,
      packageName: "Entrada general",
      bundleCode: null,
      totalInCents: 60_000_000,
      unitPriceInCents: 20_000_000,
    };
    const partial = buildPostPurchaseEmail({ ...INPUT, context: three });
    expect(partial.text).toContain("3 entradas");
    expect(partial.text).toContain("acompañantes");

    const complete = buildPostPurchaseEmail({
      ...INPUT,
      context: { ...three, registeredParticipants: 3 },
    });
    expect(complete.text).toContain("Registramos los datos de 3 personas");
    expect(complete.text).not.toContain("acompañantes");
  });

  it("escapes every interpolated value", () => {
    const message = buildPostPurchaseEmail({
      ...INPUT,
      context: {
        ...CONTEXT,
        buyerFirstName: '<script>alert("x")</script>',
        buyerLastName: "Pérez & Cía",
        orderReference: "EVT-2026-0000<script>",
        packageName: "<b>Entrada</b>",
      },
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("Pérez &amp; Cía");
    expect(message.html).toContain("&lt;b&gt;Entrada&lt;/b&gt;");
  });

  it("omits the product line and the document line when the data is absent", () => {
    const message = buildPostPurchaseEmail({
      ...INPUT,
      context: {
        ...CONTEXT,
        packageName: null,
        bundleCode: null,
        buyerDocumentLast4: null,
        buyerFirstName: null,
      },
    });
    expect(message.text).not.toContain("Producto:");
    expect(message.text).toContain("Documento: —");
    expect(message.text).toContain("Hola, bienvenido.");
  });

  it("derives the idempotency key from the order", () => {
    expect(buildPostPurchaseIdempotencyKey("11111111-1111-4111-8111-111111111111")).toBe(
      "order:11111111-1111-4111-8111-111111111111:POST_PURCHASE",
    );
  });
});
