/**
 * Reset Wellness — Google Sheets connector (standalone Apps Script web app).
 *
 * POST only. Every request is a signed envelope verified by `lib.js` before any spreadsheet
 * access. The script runs as its owner and can only address the spreadsheet and tabs stored in
 * Script Properties:
 *
 *   SPREADSHEET_ID  required
 *   HMAC_SECRET     required, at least 32 characters, no whitespace
 *   DATA_TAB        optional, default "Datos"
 *   STATUS_TAB      optional, default "Estado"
 *
 * Operations:
 *   health     — configuration, spreadsheet access and required tabs
 *   self_test  — temporary tab write/read/delete; never touches participant or status data
 *   sync       — writes the complete supplied grid to the fixed data or status tab
 *
 * There is no general-purpose read/write API and no request field can choose a spreadsheet,
 * tab or arbitrary range. Responses always use `{ ok, data | error }`; Content Service cannot
 * set an HTTP status, so callers MUST inspect `ok` rather than only the transport status.
 */

function doGet() {
  return rwJson_(rwFail_("METHOD_NOT_ALLOWED", "Método no permitido.", false));
}

function doPost(event) {
  try {
    if (!event || !event.postData || typeof event.postData.contents !== "string") {
      return rwJson_(rwFail_("BAD_REQUEST", "El cuerpo de la solicitud no es válido.", false));
    }
    if (event.postData.contents.length > RW_MAX_BODY_CHARS) {
      return rwJson_(rwFail_("BAD_REQUEST", "La solicitud excede el tamaño permitido.", false));
    }

    var envelope;
    try {
      envelope = JSON.parse(event.postData.contents);
    } catch (error) {
      return rwJson_(rwFail_("BAD_REQUEST", "El cuerpo de la solicitud no es válido.", false));
    }

    var config = rwReadConfig_(PropertiesService.getScriptProperties());
    if (!config.ok) {
      return rwJson_(config);
    }

    var verified = rwVerifyEnvelope_(envelope, config.hmacSecret, Math.floor(Date.now() / 1000));
    if (!verified.ok) {
      return rwJson_(verified);
    }

    var nonceResult = rwConsumeNonce_(
      envelope.nonce,
      CacheService.getScriptCache(),
      LockService.getScriptLock(),
    );
    if (!nonceResult.ok) {
      return rwJson_(nonceResult);
    }

    var payload;
    try {
      payload = JSON.parse(verified.payloadJson);
    } catch (error) {
      return rwJson_(rwFail_("BAD_REQUEST", "El payload no es válido.", false));
    }

    var operation = rwValidateOperation_(payload);
    if (!operation.ok) {
      return rwJson_(operation);
    }

    var opened = rwOpenSpreadsheet_(config);
    if (!opened.ok) {
      return rwJson_(opened);
    }

    if (operation.operation === "health") {
      return rwJson_(rwHealth_(opened.spreadsheet, config));
    }
    if (operation.operation === "self_test") {
      return rwJson_(rwSelfTest_(opened.spreadsheet, config));
    }
    return rwJson_(rwSync_(opened.spreadsheet, config, operation));
  } catch (error) {
    // Never log the request body, participant data, signature or secret.
    console.error("rw-sheets-connector: internal error");
    return rwJson_(rwFail_("INTERNAL_ERROR", "No se pudo procesar la solicitud.", true));
  }
}

function rwJson_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function rwOpenSpreadsheet_(config) {
  try {
    return { ok: true, spreadsheet: SpreadsheetApp.openById(config.spreadsheetId) };
  } catch (error) {
    return rwFail_(
      "SPREADSHEET_ACCESS",
      "No se pudo abrir la hoja configurada. Compártela con la cuenta propietaria del script.",
      false,
    );
  }
}

function rwRequireTabs_(spreadsheet, config) {
  var dataSheet = spreadsheet.getSheetByName(config.dataTab);
  var statusSheet = spreadsheet.getSheetByName(config.statusTab);
  if (!dataSheet || !statusSheet) {
    return rwFail_(
      "MISSING_TAB",
      "Crea las pestañas configuradas (DATA_TAB y STATUS_TAB) antes de sincronizar.",
      false,
    );
  }
  return { ok: true, dataSheet: dataSheet, statusSheet: statusSheet };
}

function rwHealth_(spreadsheet, config) {
  var tabs = rwRequireTabs_(spreadsheet, config);
  if (!tabs.ok) {
    return tabs;
  }
  return {
    ok: true,
    data: {
      operation: "health",
      spreadsheetAccessible: true,
      dataTab: true,
      statusTab: true,
      timeZone: spreadsheet.getSpreadsheetTimeZone(),
    },
  };
}

function rwSelfTest_(spreadsheet, config) {
  var tabs = rwRequireTabs_(spreadsheet, config);
  if (!tabs.ok) {
    return tabs;
  }

  var name = "__rw_self_test_" + Utilities.getUuid().replace(/-/g, "").slice(0, 12);
  var token = "rw-self-test-" + Utilities.getUuid();
  var temp = null;

  try {
    temp = spreadsheet.insertSheet(name);
    temp.getRange(1, 1).setValue(token);
    SpreadsheetApp.flush();
    var readBack = temp.getRange(1, 1).getValue();
    if (readBack !== token) {
      throw new Error("self-test readback mismatch");
    }
    spreadsheet.deleteSheet(temp);
    temp = null;
    SpreadsheetApp.flush();
    return {
      ok: true,
      data: {
        operation: "self_test",
        spreadsheetAccessible: true,
        dataTab: true,
        statusTab: true,
        writeReadDelete: true,
        cleanedUp: true,
      },
    };
  } catch (error) {
    if (temp !== null) {
      try {
        spreadsheet.deleteSheet(temp);
      } catch (cleanupError) {
        // A failed cleanup leaves a visible temporary tab; report the self-test failure.
      }
    }
    return rwFail_("SELF_TEST_FAILED", "La prueba temporal de la hoja falló.", false);
  }
}

function rwSync_(spreadsheet, config, operation) {
  var tabs = rwRequireTabs_(spreadsheet, config);
  if (!tabs.ok) {
    return tabs;
  }

  var sheet = operation.grid === "data" ? tabs.dataSheet : tabs.statusSheet;
  var values = rwSanitizeGrid_(operation.values);
  try {
    sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
    SpreadsheetApp.flush();
  } catch (error) {
    return rwFail_("WRITE_FAILED", "No se pudo escribir la hoja configurada.", true);
  }

  return {
    ok: true,
    data: {
      operation: "sync",
      grid: operation.grid,
      written: true,
      // The data grid includes its header; the status grid does not.
      rowsWritten: operation.grid === "data" ? Math.max(0, values.length - 1) : values.length,
      updatedRanges: 1,
      updatedCells: values.length * values[0].length,
    },
  };
}
