const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzOtthSSdysfjgwHhMwbaCi6d-G5L8gdH4tUq5RdS-fE3UvB9kjbMTA4vYNN9V2MA/exec';
const DEFAULTS = { team: 'UNO', theme: 'light' };
const ALL_ROWS_CACHE = {}; // team -> full rows
const SEARCH_INDEX = {};   // team -> { origins:[], dests:[], originToDest: Map }

function qsa(sel){ return Array.from(document.querySelectorAll(sel)); }
function el(id){ return document.getElementById(id); }
function setStatus(msg, cls=''){ const s=el('status'); if (!s) return; s.textContent = msg; s.className = `status ${cls}`.trim(); }

function showLoading(on, { wipe=false } = {}){
  const o = el('loading');
  if (o) o.hidden = !on;
  if (on && wipe){ const host = el('recentList'); if (host) host.innerHTML=''; }
}

function setButtonLoading(on){
  const b = el('btnSave');
  if (!b) return;
  b.disabled = !!on;
  b.classList.toggle('loading', !!on);
  b.setAttribute('aria-busy', on ? 'true' : 'false');
}

function setSaveMsg(msg, cls=''){ const s=el('saveMsg'); if (!s) return; s.textContent = msg; s.className = `status ${cls}`.trim(); }

async function getConfig(){ const res = await chrome.storage.sync.get(DEFAULTS); return { ...DEFAULTS, ...res }; }
async function setConfig(partial){ await chrome.storage.sync.set(partial); }

async function getJson(url){ const res = await fetch(url); const text = await res.text(); let data=null; try{data=JSON.parse(text);}catch{} return { ok:res.ok, status:res.status, data, text}; }
async function postJson(url, obj){ const res = await fetch(url,{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(obj)}); const text=await res.text(); let data=null; try{data=JSON.parse(text);}catch{} return { ok:res.ok, status:res.status, data, text}; }

// ----- Theme -----
function applyTheme(theme){
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('theme-dark', isDark);
  const btn = document.getElementById('themeToggle');
  if (btn){
    btn.textContent = isDark ? '☀️' : '🌙';
    btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('title', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  }
}

const STATUS_OPTIONS = ['Pending','Won','Lost','Ended'];
function fmtCityState(c,s){ return [c,s].filter(Boolean).join(', '); }

function renderRecent(rows, opts={}){
  const host = el('recentList'); host.innerHTML='';
  const baseRows = opts.baseRows || rows;
  const idxMap = opts.idxMap || null; // if provided, maps render index -> baseRows index
  // Ensure save/edit maps to the right underlying list
  window.__recentOriginal = baseRows;
  const frag = document.createDocumentFragment();
  rows.forEach((r, idx) => {
    const div = document.createElement('div');
    div.className = 'row';
    const baseIdx = idxMap ? idxMap[idx] : idx;
    div.dataset.idx = String(baseIdx);
    const dt = r.Timestamp || r.Date;
    let dateStr = '';
    try { dateStr = new Date(dt).toLocaleString(); } catch { dateStr = String(dt || ''); }
    div.innerHTML = `
      <div>
        <div class="meta">${dateStr}</div>
        <div class="meta">Load ${r.LoadID}</div>
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
      </div>
      <div class="full">
        <input class="fld-notes" type="text" placeholder="Notes" value="${r.Notes || ''}" />
      </div>
    `;
    frag.appendChild(div);
  });
  host.appendChild(frag);
}

async function loadRecent(team){
  setStatus('');
  showLoading(true, { wipe: true });
  const url = `${APPS_SCRIPT_URL}?team=${encodeURIComponent(team)}&limit=10`;
  const res = await getJson(url);
  if (res.ok && res.data && Array.isArray(res.data.rows)){
    const rows = res.data.rows;
    renderRecent(rows, { baseRows: rows, idxMap: rows.map((_,i)=>i) });
    setStatus('');
  } else {
    setStatus('Failed to load recent', 'err');
  }
  showLoading(false);
}

async function loadAll(team){
  // Cache full dataset per team for searching
  if (ALL_ROWS_CACHE[team]) return ALL_ROWS_CACHE[team];
  // Load in background; keep status minimal to avoid flicker
  const url = `${APPS_SCRIPT_URL}?team=${encodeURIComponent(team)}&limit=100000`; // fetch effectively "all"
  const res = await getJson(url);
  if (res.ok && res.data && Array.isArray(res.data.rows)){
    const rows = res.data.rows;
    ALL_ROWS_CACHE[team] = rows;
    SEARCH_INDEX[team] = buildSearchIndex(rows);
    return rows;
  } else {
    // Soft-fail; search will try again on demand
    return [];
  }
}

function uniqueSorted(arr){
  return Array.from(new Set(arr.filter(Boolean))).sort((a,b)=>String(a).localeCompare(String(b)));
}

function buildSearchIndex(rows){
  const originsSet = new Set();
  const destsSet = new Set();
  const originToDest = new Map();
  rows.forEach(r => {
    const o = r['Origin State'];
    const d = r['Destination State'];
    if (o) originsSet.add(o);
    if (d) destsSet.add(d);
    if (o && d){
      if (!originToDest.has(o)) originToDest.set(o, new Set());
      originToDest.get(o).add(d);
    }
  });
  return {
    origins: uniqueSorted(Array.from(originsSet)),
    dests: uniqueSorted(Array.from(destsSet)),
    originToDest,
  };
}

function parseDate(dt){
  try { return new Date(dt).getTime() || 0; } catch { return 0; }
}

function populateFilters(team, rows){
  const fCust = el('fltCustomer');
  const fOri = el('fltOrigin');
  const fDst = el('fltDest');
  const fEqp = el('fltEquip');
  if (!fCust || !fOri || !fDst || !fEqp) return;
  const custs = uniqueSorted(rows.map(r=>r.Customer));
  const idx = SEARCH_INDEX[team] || buildSearchIndex(rows);
  const equip = uniqueSorted(rows.map(r=>r['Equipment Type']));
  function setOptions(sel, items, placeholder){
    const v = sel.value; // attempt to preserve
    sel.innerHTML = '';
    const opt0 = document.createElement('option'); opt0.value=''; opt0.textContent = placeholder; sel.appendChild(opt0);
    items.forEach(it=>{ const o=document.createElement('option'); o.value=String(it); o.textContent=String(it); sel.appendChild(o); });
    // restore if exists
    if ([...sel.options].some(o=>o.value===v)) sel.value = v; else sel.value='';
  }
  setOptions(fCust, custs, 'Customer');
  setOptions(fOri, idx.origins, 'Origin State');
  // Destination depends on selected origin if any
  const selectedOrigin = fOri.value || '';
  let destList = idx.dests;
  if (selectedOrigin && idx.originToDest.has(selectedOrigin)){
    destList = uniqueSorted(Array.from(idx.originToDest.get(selectedOrigin)));
  }
  setOptions(fDst, destList, 'Destination State');
  setOptions(fEqp, equip, 'Equipment');
}

function filterRows(rows, filters){
  return rows.filter(r => {
    if (filters.customer && String(r.Customer) !== String(filters.customer)) return false;
    if (filters.origin && String(r['Origin State']) !== String(filters.origin)) return false;
    if (filters.dest && String(r['Destination State']) !== String(filters.dest)) return false;
    if (filters.equip && String(r['Equipment Type']) !== String(filters.equip)) return false;
    return true;
  });
}

function sortByDateDesc(rows){
  return rows.slice().sort((a,b)=>parseDate(b.Timestamp||b.Date) - parseDate(a.Timestamp||a.Date));
}

function computeWinRates(rows){
  const now = Date.now();
  const THIRTY_DAYS = 30*24*60*60*1000;
  let won=0, lost=0, won30=0, lost30=0;
  rows.forEach(r => {
    const s = String(r.Status||'');
    if (s !== 'Won' && s !== 'Lost') return;
    const t = parseDate(r.Timestamp||r.Date);
    if (s==='Won') won++; else if (s==='Lost') lost++;
    if (now - t <= THIRTY_DAYS){ if (s==='Won') won30++; else if (s==='Lost') lost30++; }
  });
  const pct = (won+lost)>0 ? Math.round((won/(won+lost))*100) : 0;
  const pct30 = (won30+lost30)>0 ? Math.round((won30/(won30+lost30))*100) : 0;
  return { pct, pct30, won, lost, won30, lost30 };
}

function updateWinrateDisplay(rows){
  const elw = el('winrate'); if (!elw) return;
  const { pct, pct30 } = computeWinRates(rows||[]);
  elw.innerHTML = `<span class="label">Total Win Rate:</span> <span class="val">${pct}%</span> <span class="sep">•</span> <span class="label">Last 30 Days:</span> <span class="val">${pct30}%</span>`;
}

async function applySearch(team){
  showLoading(true, { wipe: true });
  const all = await loadAll(team);
  populateFilters(team, all);
  const filters = {
    customer: el('fltCustomer')?.value || '',
    origin: el('fltOrigin')?.value || '',
    dest: el('fltDest')?.value || '',
    equip: el('fltEquip')?.value || ''
  };
  const filtered = filterRows(all, filters);
  updateWinrateDisplay(filtered);
  const sorted = sortByDateDesc(filtered);
  const top10 = sorted.slice(0, 10);
  // Map displayed rows back to their indices in the full array, so edits map correctly
  const idxMap = top10.map(row => all.indexOf(row));
  renderRecent(top10, { baseRows: all, idxMap });
  showLoading(false);
}

function openSearchPanel(open){
  const wrap = document.getElementById('search');
  const btn = document.getElementById('btnSearch');
  const panel = document.getElementById('searchPanel');
  if (!wrap || !btn || !panel) return;
  const willOpen = open ?? wrap.getAttribute('data-open') !== '1';
  wrap.setAttribute('data-open', willOpen ? '1' : '0');
  btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  panel.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
  if (willOpen){
    // focus first interactive filter if available
    setTimeout(()=>{ el('fltCustomer')?.focus(); }, 0);
  }
}

function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

async function clearFiltersAndApply(){
  ['fltCustomer','fltOrigin','fltDest','fltEquip'].forEach(id => { const s=el(id); if (s) s.value=''; });
  const c = await getConfig();
  await applySearch(c.team);
}

function collectChanges(){
  const host = el('recentList');
  const items = Array.from(host.querySelectorAll('.row'));
  const orig = window.__recentOriginal || [];
  const changes = [];
  items.forEach(rowEl => {
    const idx = Number(rowEl.dataset.idx);
    const r0 = orig[idx]; if (!r0) return;
    const status = rowEl.querySelector('.fld-status').value;
    const rateRaw = rowEl.querySelector('.fld-rate').value;
    const notes = rowEl.querySelector('.fld-notes').value;
    const patch = { LoadID: r0.LoadID, Team: r0.Team, Customer: r0.Customer };
    let dirty = false;
    if (status !== r0.Status) { patch.Status = status; dirty = true; }
    if (rateRaw !== String(r0.Rate || '')) { patch.Rate = rateRaw; dirty = true; }
    if ((notes||'') !== String(r0.Notes || '')) { patch.Notes = notes; dirty = true; }
    if (dirty) changes.push(patch);
  });
  return changes;
}

async function saveChanges(team){
  const changes = collectChanges();
  if (!changes.length){ setStatus('No changes to save'); return; }
  setStatus('');
  setButtonLoading(true);
  setSaveMsg('');
  const res = await postJson(APPS_SCRIPT_URL, { rows: changes });
  if (res.ok && res.data && res.data.result==='success'){
    await loadRecent(team);
    setSaveMsg('Saved!', 'ok');
    setButtonLoading(false);
  } else {
    setSaveMsg('Save failed', 'err');
    setButtonLoading(false);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await getConfig();
  // Theme init and toggle
  applyTheme(cfg.theme || 'light');
  const tbtn = document.getElementById('themeToggle');
  if (tbtn){
    tbtn.addEventListener('click', async () => {
      const isDark = document.documentElement.classList.contains('theme-dark');
      const next = isDark ? 'light' : 'dark';
      await setConfig({ theme: next });
      applyTheme(next);
    });
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.theme) applyTheme(changes.theme.newValue || 'light');
    });
  } catch {}
  // Init team radios
  const radios = qsa('input[name="team"]');
  (radios.find(r=>r.value===cfg.team) || radios[0]).checked = true;
  radios.forEach(r => r.addEventListener('change', async () => {
    await setConfig({team:r.value});
    // If search panel is open, refresh all + filters + results; else load recent 10
    const isSearchOpen = document.getElementById('search')?.getAttribute('data-open')==='1';
    // Show loading immediately and clear existing rows so the message is readable
    showLoading(true, { wipe: true });
    if (isSearchOpen){ await applySearch(r.value); }
    else { await loadRecent(r.value); }
    // Background warm the full dataset for this team to avoid later lag
    loadAll(r.value).then(rows=>{ updateWinrateDisplay(rows||[]); }).catch(()=>{});
  }));
  await loadRecent(cfg.team);
  // Warm current team full dataset to avoid wait when opening search
  loadAll(cfg.team).then(rows => { updateWinrateDisplay(rows||[]); }).catch(()=>{});
  el('btnSave').addEventListener('click', async () => {
    const cfg2 = await getConfig();
    saveChanges(cfg2.team);
  });

  // Search UI wiring
  const btnSearch = el('btnSearch');
  const btnClear = el('btnClearFilters');
  const btnClose = el('btnCloseSearch');
  const onFilterChange = debounce(async () => { const c = await getConfig(); await applySearch(c.team); }, 150);
  function getCurrentTeam(){ const r = document.querySelector('input[name="team"]:checked'); return r?.value || 'UNO'; }
  if (btnSearch){
    btnSearch.addEventListener('click', async () => {
      const wasOpen = document.getElementById('search')?.getAttribute('data-open')==='1';
      openSearchPanel(!wasOpen);
      if (!wasOpen){ const c = await getConfig(); await applySearch(c.team); }
    });
  }
  if (btnClear){ btnClear.addEventListener('click', clearFiltersAndApply); }
  if (btnClose){ btnClose.addEventListener('click', async () => { await clearFiltersAndApply(); openSearchPanel(false); }); }
  ['fltCustomer','fltOrigin','fltDest','fltEquip'].forEach(id => {
    const s = el(id); if (!s) return;
    if (id === 'fltOrigin'){
      s.addEventListener('change', () => {
        const team = getCurrentTeam();
        const all = ALL_ROWS_CACHE[team];
        if (all){ populateFilters(team, all); }
        onFilterChange();
      });
    } else {
      s.addEventListener('change', onFilterChange);
    }
  });
});
