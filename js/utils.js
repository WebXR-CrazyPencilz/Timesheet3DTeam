// ═══════════════════════════════════════════════════
// UTILS.JS — shared helpers used by all modules
// ═══════════════════════════════════════════════════

function $(id) { return document.getElementById(id); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function weekStart() {
  const d = new Date();
  const dy = d.getDay();
  d.setDate(d.getDate() + (dy === 0 ? -6 : 1 - dy));
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function fmtDate(s) {
  if (!s) return '—';
  return new Date(s + 'T00:00:00').toLocaleDateString('en-IN',
    { day:'numeric', month:'short', year:'numeric' });
}

function fh(h) { return `${h}h`; }

function esc(s) {
  return String(s || '—')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── TOAST ─────────────────────────────────────────
function toast(type, title, msg = '', ms) {
  const dur = ms || (type==='s' ? 4000 : type==='e' ? 6000 : 4000);
  const ic = {
    s: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><polyline points="20 6 9 17 4 12"/></svg>',
    e: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    i: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="ttico">${ic[type]||ic.i}</div><div style="flex:1"><div class="ttit">${esc(title)}</div>${msg ? `<div class="tmsg">${esc(msg)}</div>` : ''}</div>`;
  $('tbox').appendChild(el);
  const t = setTimeout(() => rmToast(el), dur);
  el.onclick = () => { clearTimeout(t); rmToast(el); };
}
function rmToast(el) { el.classList.add('out'); setTimeout(() => el.remove(), 200); }

// ── THEME ──────────────────────────────────────────
function getTheme() { return localStorage.getItem(CONFIG.LS_THEME) || 'dark'; }
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(CONFIG.LS_THEME, t);
  const dark = t === 'dark';
  $('lsun').style.display  = dark ? 'block' : 'none';
  $('lmoon').style.display = dark ? 'none'  : 'block';
  $('asun').style.display  = dark ? 'block' : 'none';
  $('amoon').style.display = dark ? 'none'  : 'block';
}
function togTheme() { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); }