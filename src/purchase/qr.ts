/**
 * Ticket QR rendering (Phase 6B).
 *
 * The QR encodes ONLY the opaque ticket token issued by the backend (`TKT_…`, 100 bits of
 * entropy). It never contains a cédula, email, phone, order id or URL: a screenshot of the
 * code reveals nothing about the holder, and the token is the exact value the operator's
 * scanner reads at the door (see `docs/api.md` → `POST /check-in`).
 *
 * `qrcode-generator` (MIT, zero runtime dependencies) produces an SVG string, so the code
 * is crisp at any size, prints correctly, and needs no canvas or network call.
 */

import qrcode from "qrcode-generator";

/** Error correction level M: ~15% recovery, the usual choice for screen/print tickets. */
const ERROR_CORRECTION = "M";

export type QrSvgOptions = {
  readonly cellSize?: number;
  readonly margin?: number;
};

/**
 * Renders `value` as a scalable SVG QR code.
 *
 * @param value the backend ticket token (any UTF-8 string; encoded in Byte mode so the
 *   `TKT_` prefix and underscore are preserved exactly).
 */
export function renderTicketQrSvg(value: string, options: QrSvgOptions = {}): string {
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({
    cellSize: options.cellSize ?? 5,
    margin: options.margin ?? 2,
    scalable: true,
  });
}
