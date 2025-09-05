// Content script: scrapes Blue Yonder Accepted Loads table

function byJsn(row, jsn) {
  return row.querySelector(`[jsn="${jsn}"]`) || null;
}

function textFrom(el) {
  if (!el) return "";
  // Prefer inner text of links/spans
  const t = el.textContent || "";
  return t.replace(/\u00A0/g, ' ').trim();
}

function parseNumber(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDate(str) {
  if (!str) return null;
  // Expect formats like 08/29/2025 10:24 AM or mm/dd/yyyy
  const d = new Date(str);
  if (isNaN(d)) return null;
  // Return yyyy-mm-dd for Apps Script date-local handling
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function mapStatus(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('rejected')) return 'Lost';
  if (s.includes('awarded')) return 'Won';
  if (s.includes('removed')) return 'Ended';
  if (s.includes('pending')) return 'Pending';
  if (s.includes('submitted')) return 'Pending';
  return 'Pending';
}

function normalizeEquipment(raw) {
  const s = (raw || '').toLowerCase();
  // Drop trailing size, e.g., " - 53 FT"
  const base = s.replace(/\s*-\s*\d+\s*ft\b/g, '').trim();
  if (/dry\s*van|van/.test(base)) return 'Dry Van';
  if (/curtain|curtainside|conestoga/.test(base)) return 'Conestoga';
  if (/step\s*deck/.test(base)) return 'Step Deck';
  if (/flatbed/.test(base)) return 'Flatbed';
  if (/reefer|refrigerated/.test(base)) return 'Reefer';
  if (/rgn|double\s*drop|dd\b/.test(base)) return 'RGN/DD';
  // Treat "Oversized Equipment" (or similar) as "Oversized"
  if (/oversized(\s+equipment)?/.test(base)) return 'Oversized';
  return 'Other';
}

function findAcceptedRows(root) {
  // Strategy 1: rows with specific data path for AcceptedLoads
  let rows = Array.from(root.querySelectorAll('tr[path*="/DATA/AcceptedLoads/FreightAuctionCarrierBid"]'));
  if (rows.length) return rows;

  // Strategy 2: any tr with class containing 'row' under elements with id beginning acceptedLoadsTable
  const container = root.querySelector('#acceptedLoadsTable') || root.querySelector('[id^="acceptedLoadsTable"]');
  if (container) {
    rows = Array.from(container.querySelectorAll('tr.row, tr[class*="row"]'));
    if (rows.length) return rows;
  }

  // Strategy 3: find any cell whose id starts with acceptedLoadsTable_ and walk up to table
  const anyCell = root.querySelector('[id^="acceptedLoadsTable_"]');
  if (anyCell) {
    const tbl = anyCell.closest('table') || root;
    rows = Array.from(tbl.querySelectorAll('tr[path*="AcceptedLoads"], tr.row, tr[class*="row"]'));
    if (rows.length) return rows;
  }

  return [];
}

function scrapeAcceptedLoads() {
  const rows = findAcceptedRows(document);
  const loads = [];

  for (const row of rows) {
    // Skip rows without an ExternalLoadID
    const loadIdEl = byJsn(row, 'ExternalLoadID') || row.querySelector('#ExternalLoadID');
    const loadId = textFrom(loadIdEl);
    if (!loadId) continue;

    const rate = parseNumber(textFrom(byJsn(row, 'RateAdjustmentAmount')));
    const actionTsText = textFrom(byJsn(row, 'BidActionDateTime'));
    const date = parseDate(actionTsText);
    const status = mapStatus(textFrom(byJsn(row, 'BidResponseEnumVal')) || textFrom(byJsn(row, 'BidActionEnumVal')));
    const pickupDate = parseDate(textFrom(byJsn(row, 'ScheduledPickupDateTime')));
    const equipment = normalizeEquipment(textFrom(byJsn(row, 'EquipmentTypeDescription')));
    const weight = parseNumber(textFrom(byJsn(row, 'TotalScaledWeight')));
    const miles = parseNumber(textFrom(byJsn(row, 'TotalDistance')));
    const inTransitStops = parseNumber(textFrom(byJsn(row, 'InTransitStops')));
    const stops = Number.isFinite(inTransitStops) ? (Math.round(inTransitStops) + 2) : null;
    const originCity = textFrom(byJsn(row, 'OriginCityName'));
    const originState = textFrom(byJsn(row, 'OriginStateCode'));
    const destCity = textFrom(byJsn(row, 'DestinationCityName'));
    const destState = textFrom(byJsn(row, 'DestinationStateCode'));
    const deliveryDate = parseDate(textFrom(byJsn(row, 'LoadEndDateTime')));

    loads.push({
      LoadID: loadId,
      Rate: rate,
      Date: date,
      Timestamp: actionTsText,
      Status: status,
      PickupDate: pickupDate,
      DeliveryDate: deliveryDate,
      EquipmentType: equipment,
      Weight: weight,
      Miles: miles,
      Stops: stops,
      OriginCity: originCity,
      OriginState: originState,
      DestinationCity: destCity,
      DestinationState: destState
    });
  }

  return loads;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'SCRAPE_BLUE_YONDER') {
    try {
      const data = scrapeAcceptedLoads();
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    // Indicate async response not needed
    return true;
  }
});
