const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzOtthSSdysfjgwHhMwbaCi6d-G5L8gdH4tUq5RdS-fE3UvB9kjbMTA4vYNN9V2MA/exec';

const DEFAULTS = { team: 'UNO', customer: 'Boeing', theme: 'light' };

async function getConfig() {
  const res = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...res };
}

async function setConfig(partial) {
  await chrome.storage.sync.set(partial);
}

function el(id) { return document.getElementById(id); }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }

function setStatus(msg, cls = '') {
  const s = el('status');
  s.textContent = msg;
  s.className = `status ${cls}`.trim();
}

// ----- Theme -----
function applyTheme(theme) {
  const isDark = theme === 'dark';
  // Toggle class on <html> for CSS vars
  document.documentElement.classList.toggle('theme-dark', isDark);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = isDark ? '☀️' : '🌙';
    btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('title', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  }
}

async function scrapeCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab');

  // Inject a scraper function into all frames and aggregate results
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      function byJsn(row, jsn) { return row.querySelector(`[jsn="${jsn}"]`) || null; }
      function textFrom(el) { return (el && el.textContent ? el.textContent : '').replace(/\u00A0/g,' ').trim(); }
      function parseNumber(str) { if (!str) return null; const n = parseFloat(String(str).replace(/[^0-9.-]/g,'')); return Number.isFinite(n)?n:null; }
      function parseDate(str) { if (!str) return null; const d = new Date(str); if (isNaN(d)) return null; const yyyy=d.getFullYear(); const mm=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); return `${yyyy}-${mm}-${dd}`; }
      function mapStatus(raw){const s=(raw||'').toLowerCase(); if(s.includes('rejected'))return 'Lost'; if(s.includes('awarded'))return 'Won'; if(s.includes('removed'))return 'Ended'; if(s.includes('pending')||s.includes('submitted'))return 'Pending'; return 'Pending';}
      function normalizeEquipment(raw){
        const s=(raw||'').toLowerCase();
        const base=s.replace(/\s*-\s*\d+\s*ft\b/g,'').trim();
        if(/dry\s*van|van/.test(base))return 'Dry Van';
        if(/curtain|curtainside|conestoga/.test(base))return 'Conestoga';
        if(/step\s*deck/.test(base))return 'Step Deck';
        if(/flatbed/.test(base))return 'Flatbed';
        if(/reefer|refrigerated/.test(base))return 'Reefer';
        if(/rgn|double\s*drop|dd\b/.test(base))return 'RGN/DD';
        if(/oversized(\s+equipment)?/.test(base))return 'Oversized';
        return 'Other';
      }
      function findAcceptedRows(root){
        let rows=Array.from(root.querySelectorAll('tr[path*="/DATA/AcceptedLoads/FreightAuctionCarrierBid"]'));
        if(rows.length) return rows;
        const container=root.querySelector('#acceptedLoadsTable')||root.querySelector('[id^="acceptedLoadsTable"]');
        if(container){ rows=Array.from(container.querySelectorAll('tr.row, tr[class*="row"]')); if(rows.length) return rows; }
        const anyCell=root.querySelector('[id^="acceptedLoadsTable_"]');
        if(anyCell){ const tbl=anyCell.closest('table')||root; rows=Array.from(tbl.querySelectorAll('tr[path*="AcceptedLoads"], tr.row, tr[class*="row"]')); if(rows.length) return rows; }
        return [];
      }
      const rows = findAcceptedRows(document);
      const loads=[];
      for(const row of rows){
        const loadIdEl = byJsn(row,'ExternalLoadID') || row.querySelector('#ExternalLoadID');
        const loadId = textFrom(loadIdEl); if(!loadId) continue;
        const rate = parseNumber(textFrom(byJsn(row,'RateAdjustmentAmount')));
        const actionTsText = textFrom(byJsn(row,'BidActionDateTime'));
        const date = parseDate(actionTsText);
        const status = mapStatus(textFrom(byJsn(row,'BidResponseEnumVal')) || textFrom(byJsn(row,'BidActionEnumVal')));
        const pickupDate = parseDate(textFrom(byJsn(row,'ScheduledPickupDateTime')));
        const equipment = normalizeEquipment(textFrom(byJsn(row,'EquipmentTypeDescription')));
        const weight = parseNumber(textFrom(byJsn(row,'TotalScaledWeight')));
        const miles = parseNumber(textFrom(byJsn(row,'TotalDistance')));
        const inTransitStops = parseNumber(textFrom(byJsn(row,'InTransitStops')));
        const stops = Number.isFinite(inTransitStops) ? (Math.round(inTransitStops) + 2) : null;
        const originCity = textFrom(byJsn(row,'OriginCityName'));
        const originState = textFrom(byJsn(row,'OriginStateCode'));
        const destCity = textFrom(byJsn(row,'DestinationCityName'));
        const destState = textFrom(byJsn(row,'DestinationStateCode'));
        const deliveryDate = parseDate(textFrom(byJsn(row,'LoadEndDateTime')));
        loads.push({ LoadID: loadId, Rate: rate, Date: date, Timestamp: actionTsText, Status: status, PickupDate: pickupDate, DeliveryDate: deliveryDate, EquipmentType: equipment, Weight: weight, Miles: miles, Stops: stops, OriginCity: originCity, OriginState: originState, DestinationCity: destCity, DestinationState: destState });
      }
      return loads;
    }
  });

  // Aggregate results from frames and dedupe by LoadID
  const all = (results || []).flatMap(r => (Array.isArray(r.result) ? r.result : []));
  const byId = new Map();
  for (const l of all) {
    if (!l || !l.LoadID) continue;
    if (!byId.has(l.LoadID)) byId.set(l.LoadID, l);
  }
  return Array.from(byId.values());
}

function toPayloadFull(l, cfg) {
  return {
    Date: l.Date || new Date().toISOString().slice(0, 10),
    Team: cfg.team,
    Customer: cfg.customer,
    LoadID: l.LoadID,
    Timestamp: l.Timestamp || '',
    "Origin City": l.OriginCity || '',
    "Origin State": l.OriginState || '',
    "Destination City": l.DestinationCity || '',
    "Destination State": l.DestinationState || '',
    "Equipment Type": l.EquipmentType || '',
    Stops: l.Stops ?? '',
    Miles: l.Miles ?? '',
    Weight: l.Weight ?? '',
    "Pickup Date": l.PickupDate || '',
    "Delivery Date": l.DeliveryDate || '',
    Rate: l.Rate ?? '',
    Notes: '',
    Status: l.Status || 'Pending'
  };
}

function toPayloadUpdate(l) {
  const p = { LoadID: l.LoadID, Status: l.Status || 'Pending' };
  if (l.Rate != null) p.Rate = l.Rate;
  return p;
}

async function postJson(url, obj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, data, text };
}

async function getJson(url) {
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, data, text };
}

async function runCapture() {
  const cfg = await getConfig();
  el('btnCapture').disabled = true;
  setStatus('Scraping page…');
  let loads = [];
  try {
    loads = await scrapeCurrentTab();
  } catch (e) {
    setStatus(String(e), 'err');
    el('btnCapture').disabled = false;
    return;
  }

  if (!loads.length) {
    setStatus('No loads found in Accepted Loads table.', 'err');
    el('btnCapture').disabled = false;
    return;
  }

  setStatus('Syncing to Quote Log…');
  const rows = loads.map(l => toPayloadFull(l, cfg));
  const resp = await postJson(APPS_SCRIPT_URL, { rows });
  let msg;
  if (resp.ok && resp.data && resp.data.result === 'success') {
    const added = resp.data.added || 0;
    const statusUpdates = resp.data.statusUpdates || 0;
    const rateChanges = resp.data.rateChanges || 0;
    msg = `Added: ${added} • Status updates: ${statusUpdates} • Rate changes: ${rateChanges}`;
  } else {
    msg = 'Sync failed';
  }
  setStatus(msg, 'ok');

  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon-128.png',
      title: 'Quote Logger',
      message: msg
    });
  } catch {}

  el('btnCapture').disabled = false;
}

// ----- Recent view -----
const STATUS_OPTIONS = ['Pending', 'Won', 'Lost', 'Ended'];

function fmtCityState(c, s) { return [c, s].filter(Boolean).join(', '); }

function renderRecent(rows) {
  const host = el('recentList');
  host.innerHTML = '';
  const frag = document.createDocumentFragment();
  rows.forEach((r, idx) => {
    const div = document.createElement('div');
    div.className = 'row';
    div.dataset.idx = String(idx);
    div.innerHTML = `
      <div>
        <div class="meta">${new Date(r.Timestamp || r.Date).toLocaleDateString()}</div>
        <div class="meta">${r.LoadID}</div>
      </div>
      <div>
        <div class="fromto">${fmtCityState(r['Origin City'], r['Origin State'])} → ${fmtCityState(r['Destination City'], r['Destination State'])}</div>
        <div class="meta">${r['Equipment Type'] || ''} • ${r.Miles || ''} mi • ${r.Stops || ''} stops</div>
      </div>
      <div>
        <select class="fld-status">${STATUS_OPTIONS.map(s=>`<option${s===r.Status?' selected':''}>${s}</option>`).join('')}</select>
      </div>
      <div>
        <input class="fld-rate" type="number" step="0.01" value="${r.Rate || ''}" />
        <input class="fld-notes" type="text" placeholder="Notes" value="${r.Notes || ''}" />
      </div>
    `;
    frag.appendChild(div);
  });
  host.appendChild(frag);
}

async function loadRecent(team) {
  setStatus('Loading recent…');
  const url = `${APPS_SCRIPT_URL}?team=${encodeURIComponent(team)}&limit=10`;
  const res = await getJson(url);
  if (res.ok && res.data && Array.isArray(res.data.rows)) {
    const rows = res.data.rows;
    // Keep a copy for change detection
    window.__recentOriginal = rows.map(r => ({...r}));
    renderRecent(rows);
    setStatus('');
  } else {
    setStatus('Failed to load recent', 'err');
  }
}

function collectRecentChanges() {
  const host = el('recentList');
  const items = Array.from(host.querySelectorAll('.row'));
  const orig = window.__recentOriginal || [];
  const changes = [];
  items.forEach((rowEl) => {
    const idx = Number(rowEl.dataset.idx);
    const r0 = orig[idx]; if (!r0) return;
    const status = rowEl.querySelector('.fld-status').value;
    const rateRaw = rowEl.querySelector('.fld-rate').value;
    const notes = rowEl.querySelector('.fld-notes').value;
    const rate = rateRaw === '' ? '' : Number(rateRaw);

    const patch = { LoadID: r0.LoadID, Team: r0.Team, Customer: r0.Customer };
    let dirty = false;
    if (status !== r0.Status) { patch.Status = status; dirty = true; }
    if (rateRaw !== String(r0.Rate || '')) { patch.Rate = rateRaw; dirty = true; }
    if ((notes || '') !== String(r0.Notes || '')) { patch.Notes = notes; dirty = true; }
    if (dirty) changes.push(patch);
  });
  return changes;
}

async function saveRecentChanges(team) {
  const changes = collectRecentChanges();
  if (!changes.length) { setStatus('No changes to save'); return; }
  setStatus('Saving…');
  const res = await postJson(APPS_SCRIPT_URL, { rows: changes });
  if (res.ok && res.data && res.data.result === 'success') {
    setStatus('Saved', 'ok');
    // Reload recent to reflect any computed changes
    await loadRecent(team);
  } else {
    setStatus('Save failed', 'err');
  }
}

function setupTabs() {
  const tabCapture = el('tabCapture');
  const tabRecent = el('tabRecent');
  const panelCapture = el('panelCapture');
  const panelRecent = el('panelRecent');
  function activate(which) {
    const isCapture = which === 'capture';
    tabCapture.classList.toggle('active', isCapture);
    tabCapture.setAttribute('aria-selected', String(isCapture));
    tabRecent.classList.toggle('active', !isCapture);
    tabRecent.setAttribute('aria-selected', String(!isCapture));
    panelCapture.classList.toggle('active', isCapture);
    panelRecent.classList.toggle('active', !isCapture);
  }
  tabCapture.addEventListener('click', () => activate('capture'));
  tabRecent.addEventListener('click', async () => {
    activate('recent');
    const cfg = await getConfig();
    loadRecent(cfg.team);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await getConfig();
  // Apply theme and set up toggle
  applyTheme(cfg.theme || 'light');
  const tbtn = document.getElementById('themeToggle');
  if (tbtn) {
    tbtn.addEventListener('click', async () => {
      const isDark = document.documentElement.classList.contains('theme-dark');
      const next = isDark ? 'light' : 'dark';
      await setConfig({ theme: next });
      applyTheme(next);
    });
  }
  // React to external theme changes (e.g., from recent window)
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.theme) applyTheme(changes.theme.newValue || 'light');
    });
  } catch {}
  // Initialize team segmented radios
  const radios = qsa('input[name="team"]');
  const found = radios.find(r => r.value === cfg.team) || radios[0];
  if (found) found.checked = true;
  radios.forEach(r => r.addEventListener('change', () => setConfig({ team: r.value })));

  el('btnCapture').addEventListener('click', runCapture);
  el('btnOpenRecent').addEventListener('click', async () => {
    const url = chrome.runtime.getURL('recent.html');
    try {
      await chrome.windows.create({ url, type: 'popup', width: 900, height: 760 });
    } catch (e) {
      // Fallback: open in new tab
      chrome.tabs.create({ url });
    }
  });
});
