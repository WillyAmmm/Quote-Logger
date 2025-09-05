function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('QuoteLog');
  if (!sheet) {
    sheet = ss.getSheets()[0];
  }

  // Delete a single row by LoadID (and optional Timestamp)
  if (data && data.action === 'delete' && data.LoadID) {
    return deleteQuote(sheet, data);
  }

  // Batch upsert support: [{...}, {...}] or { rows: [...] }
  if (data && (Array.isArray(data) || (data.rows && Array.isArray(data.rows)))) {
    var rows = Array.isArray(data) ? data : data.rows;

    // Local helpers mirroring single-row logic
    function cleanCity(city) { return String(city || '').replace(/,\s*$/, ''); }
    function splitCityState(value) {
      if (!value) { return { city: '', state: '' }; }
      var raw = String(value).trim();
      var match = raw.match(/^(.*?)(?:,\s*|\s+)([A-Z]{2})\b/i);
      if (match) { return { city: match[1].trim(), state: match[2].trim().toUpperCase() }; }
      return { city: raw.replace(/,\s*$/, ''), state: '' };
    }
    function cleanInt(val) { if (val !== undefined && val !== '') { var num = parseInt(val, 10); return isNaN(num) ? null : num; } return null; }
    function toDate(value) {
      if (!value) return null;
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        var parts = value.split('-');
        return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      }
      var d = new Date(value);
      if (isNaN(d)) return null;
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    function toDateTime(value) {
      if (!value) return null;
      if (typeof value === 'string') {
        var m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (m) {
          var month = Number(m[1]) - 1, day = Number(m[2]), year = Number(m[3]);
          var hour = Number(m[4]), minute = Number(m[5]);
          var ampm = m[6].toUpperCase();
          if (ampm === 'PM' && hour < 12) hour += 12;
          if (ampm === 'AM' && hour === 12) hour = 0;
          return new Date(year, month, day, hour, minute, 0);
        }
        var dIso = new Date(value); if (!isNaN(dIso)) return dIso;
      }
      var d = new Date(value); return isNaN(d) ? null : d;
    }

    // Column indices (1-based)
    var COL_LOAD_ID = 4, COL_STATUS = 18, COL_RATE = 15, COL_TIMESTAMP = 19;
    var COL_EQUIPMENT = 9, COL_NOTES = 16;

    // Build index of existing LoadIDs
    var lastRow = sheet.getLastRow();
    var idMap = {};
    var rowCount = Math.max(0, lastRow - 1);
    var current = [];
    if (rowCount > 0) {
      // Read entire table once to avoid per-cell calls
      current = sheet.getRange(2, 1, rowCount, 19).getValues();
      var ids = current.map(function(r){ return r[COL_LOAD_ID - 1]; });
      for (var i = 0; i < ids.length; i++) {
        var id = String(ids[i] || '');
        if (id) idMap[id] = i + 2; // sheet row number (2-based)
      }
    }

    // Column snapshots we can mutate, then write back in one call per column
    var statusCol = rowCount > 0 ? current.map(function(r){ return r[COL_STATUS - 1]; }) : [];
    var rateCol   = rowCount > 0 ? current.map(function(r){ return r[COL_RATE - 1]; })   : [];
    var notesCol  = rowCount > 0 ? current.map(function(r){ return r[COL_NOTES - 1]; })  : [];
    var equipCol  = rowCount > 0 ? current.map(function(r){ return r[COL_EQUIPMENT - 1]; }): [];
    var tsCol     = rowCount > 0 ? current.map(function(r){ return r[COL_TIMESTAMP - 1]; }): [];

    var added = 0, statusUpdates = 0, rateChanges = 0;
    var toAppend = [];
    var touchedStatus = false, touchedRate = false, touchedNotes = false, touchedEquip = false, touchedTs = false;

    for (var r = 0; r < rows.length; r++) {
      var rec = rows[r] || {};
      if (!rec.LoadID) continue;

      // Derive city/state from old fields if needed
      if ((!rec["Origin City"] || !rec["Origin State"]) && rec.Origin) {
        var os = splitCityState(rec.Origin);
        rec["Origin City"] = rec["Origin City"] || os.city;
        rec["Origin State"] = rec["Origin State"] || os.state;
      }
      if ((!rec["Destination City"] || !rec["Destination State"]) && rec.Destination) {
        var ds = splitCityState(rec.Destination);
        rec["Destination City"] = rec["Destination City"] || ds.city;
        rec["Destination State"] = rec["Destination State"] || ds.state;
      }
      rec["Origin City"] = cleanCity(rec["Origin City"]);
      rec["Destination City"] = cleanCity(rec["Destination City"]);

      var rowNum = idMap[String(rec.LoadID)];
      if (rowNum) {
        // Update existing row (mutate column arrays only when field provided and changed)
        var idx0 = rowNum - 2; // zero-based index into arrays
        if (rec.Status !== undefined) {
          if (String(statusCol[idx0]) !== String(rec.Status)) {
            statusCol[idx0] = rec.Status;
            statusUpdates++;
            touchedStatus = true;
          }
        }
        if (rec.Rate !== undefined && rec.Rate !== '') {
          var cleanedRate = cleanCurrency(rec.Rate);
          if (cleanedRate !== null) {
            var prevRate = cleanCurrency(rateCol[idx0]);
            if (cleanedRate !== prevRate) {
              rateCol[idx0] = cleanedRate;
              rateChanges++;
              touchedRate = true;
            }
          }
        }
        if (rec.Notes !== undefined) {
          if (String(notesCol[idx0] || '') !== String(rec.Notes || '')) {
            notesCol[idx0] = rec.Notes;
            touchedNotes = true;
          }
        }
        if (rec["Equipment Type"] !== undefined) {
          if (String(equipCol[idx0] || '') !== String(rec["Equipment Type"] || '')) {
            equipCol[idx0] = rec["Equipment Type"];
            touchedEquip = true;
          }
        }
        if (rec.Timestamp) {
          var ts = toDateTime(rec.Timestamp);
          if (ts) {
            var prevTs = tsCol[idx0];
            var prevMs = (prevTs instanceof Date) ? prevTs.getTime() : null;
            if (prevMs !== ts.getTime()) {
              tsCol[idx0] = ts;
              touchedTs = true;
            }
          }
        }
      } else {
        // Prepare new row for batch append
        var milesValue = cleanInt(rec.Miles);
        var rateValue = cleanCurrency(rec.Rate);
        var stopsValue = cleanInt(rec.Stops);
        var weightValue = cleanCurrency(rec.Weight);
        var dateValue = toDate(rec.Date);
        var pickupDateValue = toDate(rec["Pickup Date"]);
        var deliveryDateValue = toDate(rec["Delivery Date"]);
        var timestampValue = toDateTime(rec.Timestamp || rec.BidActionDateTime || rec.ActionTimestamp);

        toAppend.push([
          dateValue,
          rec.Team,
          rec.Customer,
          rec.LoadID,
          rec["Origin City"],
          rec["Origin State"],
          rec["Destination City"],
          rec["Destination State"],
          rec["Equipment Type"],
          stopsValue,
          milesValue,
          weightValue,
          pickupDateValue,
          deliveryDateValue,
          rateValue,
          rec.Notes,
          rec["Submitted By"],
          rec.Status,
          timestampValue || new Date()
        ]);
        added++;
      }
    }

    // Persist column updates in bulk to avoid per-cell calls
    if (rowCount > 0) {
      if (touchedStatus) sheet.getRange(2, COL_STATUS, rowCount, 1).setValues(statusCol.map(function(v){ return [v]; }));
      if (touchedRate)   sheet.getRange(2, COL_RATE,   rowCount, 1).setValues(rateCol.map(function(v){ return [v]; }));
      if (touchedNotes)  sheet.getRange(2, COL_NOTES,  rowCount, 1).setValues(notesCol.map(function(v){ return [v]; }));
      if (touchedEquip)  sheet.getRange(2, COL_EQUIPMENT, rowCount, 1).setValues(equipCol.map(function(v){ return [v]; }));
      if (touchedTs)     sheet.getRange(2, COL_TIMESTAMP, rowCount, 1).setValues(tsCol.map(function(v){ return [v]; }));
    }

    // Batch append new rows
    if (toAppend.length > 0) {
      sheet.getRange(lastRow + 1, 1, toAppend.length, 19).setValues(toAppend);
    }

    return ContentService.createTextOutput(JSON.stringify({
      result: 'success',
      added: added,
      statusUpdates: statusUpdates,
      rateChanges: rateChanges
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // If only LoadID and Status (and optional Rate) provided, treat as status update
  if (data && data.LoadID && data.Status && Object.keys(data).length <= 3) {
    return updateStatus(sheet, data.LoadID, data.Status, data.Rate);
  }

  // Derive city/state from old fields if new ones missing
  if ((!data["Origin City"] || !data["Origin State"]) && data.Origin) {
    var os = splitCityState(data.Origin);
    data["Origin City"] = data["Origin City"] || os.city;
    data["Origin State"] = data["Origin State"] || os.state;
  }
  if ((!data["Destination City"] || !data["Destination State"]) && data.Destination) {
    var ds = splitCityState(data.Destination);
    data["Destination City"] = data["Destination City"] || ds.city;
    data["Destination State"] = data["Destination State"] || ds.state;
  }

  function cleanCity(city) {
    return String(city || '').replace(/,\s*$/, '');
  }

  data["Origin City"] = cleanCity(data["Origin City"]);
  data["Destination City"] = cleanCity(data["Destination City"]);

  function splitCityState(value) {
    if (!value) {
      return { city: '', state: '' };
    }
    var raw = String(value).trim();
    var match = raw.match(/^(.*?)(?:,\s*|\s+)([A-Z]{2})\b/i);
    if (match) {
      return { city: match[1].trim(), state: match[2].trim().toUpperCase() };
    }
    return { city: raw.replace(/,\s*$/, ''), state: '' };
  }

  // Clean numeric fields
  var milesValue = cleanInt(data.Miles);
  var rateValue = cleanCurrency(data.Rate);
  var stopsValue = cleanInt(data.Stops);
  var weightValue = cleanCurrency(data.Weight);

  function cleanInt(val) {
    if (val !== undefined && val !== '') {
      var num = parseInt(val, 10);
      return isNaN(num) ? null : num;
    }
    return null;
  }

  // Date cleaner (strip time)
  function toDate(value) {
    if (!value) return null;
    // Treat ISO dates (yyyy-mm-dd) as local to avoid timezone shift
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      var parts = value.split('-');
      return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }
    var d = new Date(value);
    if (isNaN(d)) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // DateTime parser preserving time where possible
  function toDateTime(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      // Try US format: MM/DD/YYYY HH:MM AM/PM
      var m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (m) {
        var month = Number(m[1]) - 1;
        var day = Number(m[2]);
        var year = Number(m[3]);
        var hour = Number(m[4]);
        var minute = Number(m[5]);
        var ampm = m[6].toUpperCase();
        if (ampm === 'PM' && hour < 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
        return new Date(year, month, day, hour, minute, 0);
      }
      // Try ISO-like formats
      var dIso = new Date(value);
      if (!isNaN(dIso)) return dIso;
    }
    var d = new Date(value);
    return isNaN(d) ? null : d;
  }

  var dateValue = toDate(data.Date);
  var pickupDateValue = toDate(data["Pickup Date"]);
  var deliveryDateValue = toDate(data["Delivery Date"]);

  // Write data row
  var timestampValue = toDateTime(data.Timestamp || data.BidActionDateTime || data.ActionTimestamp);
  sheet.appendRow([
    dateValue,
    data.Team,
    data.Customer,
    data.LoadID,
    data["Origin City"],
    data["Origin State"],
    data["Destination City"],
    data["Destination State"],
    data["Equipment Type"],
    stopsValue,
    milesValue,
    weightValue,
    pickupDateValue,
    deliveryDateValue,
    rateValue,
    data.Notes,
    data["Submitted By"],
    data.Status,
    timestampValue || new Date()  // Use provided BidActionDateTime if available
  ]);

  return ContentService.createTextOutput(JSON.stringify({ result: 'success', action: 'append' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var team = params.team || '';
  var limit = params.limit ? parseInt(params.limit, 10) : 10;
  if (!limit || limit < 1) limit = 10;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('QuoteLog');
  if (!sheet) sheet = ss.getSheets()[0];

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return ContentService.createTextOutput(JSON.stringify({ rows: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Read all rows needed
  var range = sheet.getRange(2, 1, lastRow - 1, 19);
  var values = range.getValues();

  // Build records with known column order
  var records = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (team && String(v[1]) !== String(team)) continue; // Team column B index 1
    records.push({
      Date: v[0],
      Team: v[1],
      Customer: v[2],
      LoadID: String(v[3] || ''),
      "Origin City": v[4],
      "Origin State": v[5],
      "Destination City": v[6],
      "Destination State": v[7],
      "Equipment Type": v[8],
      Stops: v[9],
      Miles: v[10],
      Weight: v[11],
      "Pickup Date": v[12],
      "Delivery Date": v[13],
      Rate: v[14],
      Notes: v[15],
      "Submitted By": v[16],
      Status: v[17],
      Timestamp: v[18]
    });
  }

  // Sort by Timestamp desc, fallback to Date desc
  records.sort(function(a, b) {
    var ta = a.Timestamp instanceof Date ? a.Timestamp.getTime() : (a.Date instanceof Date ? a.Date.getTime() : 0);
    var tb = b.Timestamp instanceof Date ? b.Timestamp.getTime() : (b.Date instanceof Date ? b.Date.getTime() : 0);
    return tb - ta;
  });

  var out = records.slice(0, limit);
  return ContentService.createTextOutput(JSON.stringify({ rows: out }))
    .setMimeType(ContentService.MimeType.JSON);
}

function updateStatus(sheet, loadId, status, rate) {
  var loadIdCol = 4;    // column D
  var statusCol = 18;   // column R
  var rateCol = 15;     // column O
  var lastRow = sheet.getLastRow();
  var ids = sheet.getRange(2, loadIdCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(loadId)) {
      var statusChanged = false;
      var rateChanged = false;
      if (rate !== undefined) {
        var cleanedRate = cleanCurrency(rate);
        if (cleanedRate !== null) {
          var existing = sheet.getRange(i + 2, rateCol).getValue();
          if (cleanedRate !== cleanCurrency(existing)) {
            sheet.getRange(i + 2, rateCol).setValue(cleanedRate);
            rateChanged = true;
          }
        }
      }
      var existingStatus = sheet.getRange(i + 2, statusCol).getValue();
      if (String(existingStatus) !== String(status)) {
        statusChanged = true;
      }
      sheet.getRange(i + 2, statusCol).setValue(status);
      return ContentService.createTextOutput(JSON.stringify({ result: 'success', statusChanged: statusChanged, rateChanged: rateChanged }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ result: 'not_found' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function cleanCurrency(val) {
  if (val !== undefined && val !== '') {
    var num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    return isNaN(num) ? null : num;
  }
  return null;
}

// Delete helper
function deleteQuote(sheet, data) {
  var COL_LOAD_ID = 4;
  var COL_TIMESTAMP = 19;
  var loadId = String(data.LoadID);
  var ts = null;
  if (data.Timestamp) {
    ts = (function(v){
      if (typeof v === 'string') {
        var m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (m) {
          var month = Number(m[1]) - 1, day = Number(m[2]), year = Number(m[3]);
          var hour = Number(m[4]), minute = Number(m[5]);
          var ampm = m[6].toUpperCase();
          if (ampm === 'PM' && hour < 12) hour += 12;
          if (ampm === 'AM' && hour === 12) hour = 0;
          return new Date(year, month, day, hour, minute, 0);
        }
      }
      var d = new Date(v);
      return isNaN(d) ? null : d;
    })(data.Timestamp);
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return ContentService.createTextOutput(JSON.stringify({ result: 'not_found' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var ids = sheet.getRange(2, COL_LOAD_ID, lastRow - 1, 1).getValues();
  var tss = sheet.getRange(2, COL_TIMESTAMP, lastRow - 1, 1).getValues();

  var targetRow = -1;
  for (var i = ids.length - 1; i >= 0; i--) { // search bottom-up (most recent first)
    if (String(ids[i][0]) === loadId) {
      if (ts) {
        var cellTs = tss[i][0];
        if (cellTs instanceof Date && ts instanceof Date && cellTs.getTime() === ts.getTime()) {
          targetRow = i + 2; // account for header
          break;
        }
      } else {
        targetRow = i + 2;
        break;
      }
    }
  }

  if (targetRow > 0) {
    sheet.deleteRow(targetRow);
    return ContentService.createTextOutput(JSON.stringify({ result: 'deleted' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ result: 'not_found' }))
    .setMimeType(ContentService.MimeType.JSON);
}
