const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzOtthSSdysfjgwHhMwbaCi6d-G5L8gdH4tUq5RdS-fE3UvB9kjbMTA4vYNN9V2MA/exec';
const DEFAULTS = { team: 'UNO', theme: 'light' };

function qsa(sel){ return Array.from(document.querySelectorAll(sel)); }
function el(id){ return document.getElementById(id); }
function setStatus(msg, cls=''){ const s=el('status'); s.textContent = msg; s.className = `status ${cls}`.trim(); }

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

function renderRecent(rows){
  const host = el('recentList'); host.innerHTML='';
  const frag = document.createDocumentFragment();
  rows.forEach((r, idx) => {
    const div = document.createElement('div');
    div.className = 'row';
    div.dataset.idx = String(idx);
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
  setStatus('Loading…');
  const url = `${APPS_SCRIPT_URL}?team=${encodeURIComponent(team)}&limit=10`;
  const res = await getJson(url);
  if (res.ok && res.data && Array.isArray(res.data.rows)){
    const rows = res.data.rows;
    window.__recentOriginal = rows.map(r=>({...r}));
    renderRecent(rows);
    setStatus('');
  } else {
    setStatus('Failed to load recent', 'err');
  }
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
  setStatus('Saving…');
  const res = await postJson(APPS_SCRIPT_URL, { rows: changes });
  if (res.ok && res.data && res.data.result==='success'){
    setStatus('Saved', 'ok');
    await loadRecent(team);
  } else {
    setStatus('Save failed', 'err');
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
  radios.forEach(r => r.addEventListener('change', () => { setConfig({team:r.value}); loadRecent(r.value); }));
  await loadRecent(cfg.team);
  el('btnSave').addEventListener('click', async () => {
    const cfg2 = await getConfig();
    saveChanges(cfg2.team);
  });
});
