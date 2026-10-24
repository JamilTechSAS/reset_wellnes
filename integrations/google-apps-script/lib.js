/* global Utilities, module */
/**
 * Pure helpers for the Reset Wellness Google Sheets Apps Script connector.
 *
 * Apps Script loads every `.js`/`.gs` file in the project into one global scope, so these
 * functions are available to `Code.gs`. The guarded CommonJS export at the bottom is inert
 * inside Apps Script and lets the local Node test runner exercise the same verifier and
 * sanitizer used in production.
 *
 * No function in this file reads a spreadsheet or logs a request. `Code.gs` owns the
 * spreadsheet operations and the response envelope.
 */

var RW_REQUEST_VERSION = 1;
var RW_MAX_CLOCK_SKEW_SECONDS = 300;
var RW_NONCE_TTL_SECONDS = 600;
var RW_MAX_PAYLOAD_CHARS = 8 * 1024 * 1024;
var RW_MAX_BODY_CHARS = RW_MAX_PAYLOAD_CHARS + 1024 * 1024;
var RW_MAX_DATA_ROWS = 5001; // header + 5,000 participants
var RW_MAX_DATA_COLUMNS = 22;
var RW_MAX_STATUS_ROWS = 20;
var RW_MAX_STATUS_COLUMNS = 2;
var RW_MAX_CELL_CHARS = 10000;
var RW_MIN_SECRET_CHARS = 32;
var RW_MAX_SECRET_CHARS = 512;

function rwIsRecord_(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rwFail_(code, message, retryable) {
  return {
    ok: false,
    error: {
      code: code,
      message: message,
      retryable: retryable === true,
    },
  };
}

/** Canonical message shared with `_shared/integrations/google/sheets-client.ts`. */
function rwCanonicalMessage_(timestamp, nonce, payloadJson) {
  return "v1\n" + String(timestamp) + "\n" + nonce + "\n" + payloadJson;
}

function rwBytesToBase64Url_(bytes) {
  var encoded = Utilities.base64EncodeWebSafe(bytes);
  return String(encoded).replace(/=+$/, "");
}

function rwHmacBase64Url_(message, secret) {
  return rwBytesToBase64Url_(Utilities.computeHmacSha256Signature(message, secret));
}

/** Length-independent comparison for the base64url HMAC strings. */
function rwConstantTimeEqual_(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  var difference = a.length ^ b.length;
  var max = Math.max(a.length, b.length);
  for (var index = 0; index < max; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * Verifies the outer signed envelope. The payload is NOT parsed here and the nonce is not
 * consumed here: callers must consume the nonce through `rwConsumeNonce_` before touching
 * spreadsheet data.
 */
function rwVerifyEnvelope_(envelope, secret, nowSeconds) {
  if (typeof secret !== "string" || secret.length < RW_MIN_SECRET_CHARS) {
    return rwFail_("CONFIGURATION", "El secreto HMAC no está configurado.", false);
  }
  if (!rwIsRecord_(envelope)) {
    return rwFail_("BAD_REQUEST", "El cuerpo de la solicitud no es válido.", false);
  }
  if (envelope.version !== RW_REQUEST_VERSION) {
    return rwFail_("UNSUPPORTED_VERSION", "La versión de la solicitud no es compatible.", false);
  }
  if (!Number.isInteger(envelope.timestamp)) {
    return rwFail_("BAD_REQUEST", "La marca de tiempo no es válida.", false);
  }
  if (!Number.isInteger(nowSeconds)) {
    return rwFail_("INTERNAL_ERROR", "No se pudo validar la marca de tiempo.", true);
  }

  var age = nowSeconds - envelope.timestamp;
  if (age > RW_MAX_CLOCK_SKEW_SECONDS) {
    return rwFail_("EXPIRED_REQUEST", "La solicitud expiró.", false);
  }
  if (age < -RW_MAX_CLOCK_SKEW_SECONDS) {
    return rwFail_("FUTURE_REQUEST", "La solicitud tiene una fecha futura.", false);
  }

  if (typeof envelope.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(envelope.nonce)) {
    return rwFail_("BAD_REQUEST", "El nonce no es válido.", false);
  }
  if (
    typeof envelope.payload !== "string" ||
    envelope.payload.length === 0 ||
    envelope.payload.length > RW_MAX_PAYLOAD_CHARS
  ) {
    return rwFail_("BAD_REQUEST", "El payload no es válido.", false);
  }
  if (
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{40,64}$/.test(envelope.signature)
  ) {
    return rwFail_("BAD_REQUEST", "La firma no es válida.", false);
  }

  var expected = rwHmacBase64Url_(
    rwCanonicalMessage_(envelope.timestamp, envelope.nonce, envelope.payload),
    secret,
  );
  if (!rwConstantTimeEqual_(expected, envelope.signature)) {
    return rwFail_("UNAUTHORIZED", "La firma no es válida.", false);
  }
  return { ok: true, payloadJson: envelope.payload };
}

/**
 * Replay protection: a script lock makes check-and-set atomic and the script cache holds the
 * nonce for longer than the permitted clock skew. The cache is best-effort storage, so the
 * timestamp window remains the hard freshness boundary.
 */
function rwConsumeNonce_(nonce, cache, lock) {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return rwFail_("BAD_REQUEST", "El nonce no es válido.", false);
  }
  if (!cache || typeof cache.get !== "function" || typeof cache.put !== "function") {
    return rwFail_("NONCE_STORE_UNAVAILABLE", "No se pudo verificar el nonce.", true);
  }
  if (!lock || typeof lock.tryLock !== "function" || typeof lock.releaseLock !== "function") {
    return rwFail_("NONCE_STORE_UNAVAILABLE", "No se pudo verificar el nonce.", true);
  }

  var locked = false;
  try {
    locked = lock.tryLock(5000) === true;
    if (!locked) {
      return rwFail_("BUSY", "La solicitud coincide con otra en curso.", true);
    }
    var key = "rw-nonce:" + nonce;
    if (cache.get(key) !== null) {
      return rwFail_("REPLAY", "La solicitud ya fue procesada.", false);
    }
    cache.put(key, "1", RW_NONCE_TTL_SECONDS);
    return { ok: true };
  } catch {
    return rwFail_("NONCE_STORE_UNAVAILABLE", "No se pudo verificar el nonce.", true);
  } finally {
    if (locked) {
      try {
        lock.releaseLock();
      } catch {
        // The lock expires on its own; never mask the verification result.
      }
    }
  }
}

/**
 * Google Sheets interprets a cell string beginning with `=` as a formula. `setValues` has no
 * RAW mode, so formula-leading text is prefixed with the Sheets text marker (`'`). The marker
 * is a UI/storage convention, not part of the displayed value.
 */
function rwSanitizeCellValue_(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  var first = value.charAt(0);
  if (
    first === "=" ||
    first === "+" ||
    first === "-" ||
    first === "@" ||
    first === "\t" ||
    first === "\r" ||
    first === "\n"
  ) {
    return "'" + value;
  }
  return value;
}

function rwSanitizeGrid_(values) {
  var sanitized = [];
  for (var rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    var row = values[rowIndex];
    var nextRow = [];
    for (var columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      nextRow.push(rwSanitizeCellValue_(row[columnIndex]));
    }
    sanitized.push(nextRow);
  }
  return sanitized;
}

function rwValidateGrid_(values, maxRows, maxColumns) {
  if (!Array.isArray(values) || values.length === 0) {
    return rwFail_("BAD_REQUEST", "La cuadrícula no contiene filas.", false);
  }
  if (values.length > maxRows) {
    return rwFail_("BAD_REQUEST", "La cuadrícula excede el máximo de filas.", false);
  }

  var width = -1;
  for (var rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    var row = values[rowIndex];
    if (!Array.isArray(row) || row.length === 0) {
      return rwFail_("BAD_REQUEST", "Una fila de la cuadrícula no es válida.", false);
    }
    if (width === -1) {
      width = row.length;
      if (width > maxColumns) {
        return rwFail_("BAD_REQUEST", "La cuadrícula excede el máximo de columnas.", false);
      }
    } else if (row.length !== width) {
      return rwFail_("BAD_REQUEST", "La cuadrícula tiene filas de distinto ancho.", false);
    }

    for (var columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      var cell = row[columnIndex];
      if (typeof cell === "string") {
        if (cell.length > RW_MAX_CELL_CHARS) {
          return rwFail_("BAD_REQUEST", "Una celda excede el máximo de caracteres.", false);
        }
      } else if (typeof cell === "number") {
        if (!isFinite(cell)) {
          return rwFail_("BAD_REQUEST", "Una celda numérica no es válida.", false);
        }
      } else if (typeof cell !== "boolean") {
        return rwFail_("BAD_REQUEST", "Una celda contiene un tipo no admitido.", false);
      }
    }
  }
  return { ok: true, values: values };
}

function rwValidateSyncPayload_(payload) {
  if (!rwIsRecord_(payload) || payload.operation !== "sync") {
    return rwFail_("BAD_REQUEST", "La operación sync no es válida.", false);
  }
  if (payload.grid !== "data" && payload.grid !== "status") {
    return rwFail_("BAD_REQUEST", "La cuadrícula solicitada no es válida.", false);
  }

  var maxRows = payload.grid === "data" ? RW_MAX_DATA_ROWS : RW_MAX_STATUS_ROWS;
  var maxColumns = payload.grid === "data" ? RW_MAX_DATA_COLUMNS : RW_MAX_STATUS_COLUMNS;
  var grid = rwValidateGrid_(payload.values, maxRows, maxColumns);
  if (!grid.ok) {
    return grid;
  }
  return { ok: true, operation: "sync", grid: payload.grid, values: grid.values };
}

function rwValidateOperation_(payload) {
  if (!rwIsRecord_(payload) || typeof payload.operation !== "string") {
    return rwFail_("BAD_REQUEST", "La operación no es válida.", false);
  }
  if (payload.operation === "health" || payload.operation === "self_test") {
    return { ok: true, operation: payload.operation };
  }
  if (payload.operation === "sync") {
    return rwValidateSyncPayload_(payload);
  }
  return rwFail_("UNKNOWN_OPERATION", "La operación no está permitida.", false);
}

/**
 * Reads only the four allowed Script Properties. The spreadsheet ID and tab names are never
 * accepted from the request or from the environment of the caller.
 */
function rwReadConfig_(properties) {
  if (!properties || typeof properties.getProperty !== "function") {
    return rwFail_("CONFIGURATION", "Las propiedades del script no están disponibles.", false);
  }

  var spreadsheetId = properties.getProperty("SPREADSHEET_ID");
  var hmacSecret = properties.getProperty("HMAC_SECRET");
  var dataTab = properties.getProperty("DATA_TAB") || "Datos";
  var statusTab = properties.getProperty("STATUS_TAB") || "Estado";

  if (typeof spreadsheetId !== "string" || !/^[A-Za-z0-9_-]{10,120}$/.test(spreadsheetId)) {
    return rwFail_("CONFIGURATION", "SPREADSHEET_ID no está configurado correctamente.", false);
  }
  if (
    typeof hmacSecret !== "string" ||
    hmacSecret.length < RW_MIN_SECRET_CHARS ||
    hmacSecret.length > RW_MAX_SECRET_CHARS ||
    /\s/.test(hmacSecret)
  ) {
    return rwFail_("CONFIGURATION", "HMAC_SECRET no está configurado correctamente.", false);
  }

  dataTab = String(dataTab).trim();
  statusTab = String(statusTab).trim();
  if (
    dataTab.length === 0 ||
    statusTab.length === 0 ||
    dataTab.length > 100 ||
    statusTab.length > 100
  ) {
    return rwFail_("CONFIGURATION", "Los nombres de pestaña no son válidos.", false);
  }
  if (dataTab === statusTab) {
    return rwFail_("CONFIGURATION", "DATA_TAB y STATUS_TAB deben ser distintos.", false);
  }

  return {
    ok: true,
    spreadsheetId: spreadsheetId,
    hmacSecret: hmacSecret,
    dataTab: dataTab,
    statusTab: statusTab,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RW_REQUEST_VERSION: RW_REQUEST_VERSION,
    RW_MAX_CLOCK_SKEW_SECONDS: RW_MAX_CLOCK_SKEW_SECONDS,
    RW_NONCE_TTL_SECONDS: RW_NONCE_TTL_SECONDS,
    RW_MAX_PAYLOAD_CHARS: RW_MAX_PAYLOAD_CHARS,
    RW_MAX_BODY_CHARS: RW_MAX_BODY_CHARS,
    RW_MAX_DATA_ROWS: RW_MAX_DATA_ROWS,
    RW_MAX_DATA_COLUMNS: RW_MAX_DATA_COLUMNS,
    RW_MAX_STATUS_ROWS: RW_MAX_STATUS_ROWS,
    RW_MAX_STATUS_COLUMNS: RW_MAX_STATUS_COLUMNS,
    rwCanonicalMessage_: rwCanonicalMessage_,
    rwBytesToBase64Url_: rwBytesToBase64Url_,
    rwHmacBase64Url_: rwHmacBase64Url_,
    rwConstantTimeEqual_: rwConstantTimeEqual_,
    rwVerifyEnvelope_: rwVerifyEnvelope_,
    rwConsumeNonce_: rwConsumeNonce_,
    rwSanitizeCellValue_: rwSanitizeCellValue_,
    rwSanitizeGrid_: rwSanitizeGrid_,
    rwValidateGrid_: rwValidateGrid_,
    rwValidateSyncPayload_: rwValidateSyncPayload_,
    rwValidateOperation_: rwValidateOperation_,
    rwReadConfig_: rwReadConfig_,
  };
}
