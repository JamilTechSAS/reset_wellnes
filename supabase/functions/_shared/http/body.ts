/**
 * Bounded JSON body reader shared by every Edge Function that accepts a body.
 *
 * Two failure modes are mapped to VALIDATION_ERROR (400), never INTERNAL_ERROR (500):
 * an oversized body and a malformed one. Both are caller mistakes, and answering 500 would
 * both mislead the client and hide the boundary from metrics. The size limit is checked
 * twice — on the declared content-length and on the text actually read — because a client
 * can lie about the header.
 */

import { validationError } from "../domain/errors.ts";

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw validationError("Request body is too large", {
        context: { surface: "body", detail: "BODY_TOO_LARGE" },
      });
    }
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw validationError("Request body is too large", {
      context: { surface: "body", detail: "BODY_TOO_LARGE" },
    });
  }
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw validationError("Request body must be valid JSON", {
      context: { surface: "body", detail: "INVALID_JSON" },
    });
  }
}
