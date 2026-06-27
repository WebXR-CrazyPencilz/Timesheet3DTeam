// ═══════════════════════════════════════════════════
// API.JS — optimized for Apps Script cold starts
// ═══════════════════════════════════════════════════

const LS_E = 'tt_entries';

// ── SHARED GET HELPER (with timeout + retry) ───────
async function sheetGET(params, attempt = 1) {
  const url = new URL(CONFIG.SHEETS_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log('[API] GET →', params.action, attempt > 1 ? `(retry #${attempt})` : '');

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 15000);

  try {
    const res  = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    const json = await res.json();
    console.log('[API] ←', params.action, '| status:', json.status);
    if (json.status !== 'ok') throw new Error(json.message || 'Request failed');
    return json.data;
  } catch(err) {
    clearTimeout(timeout);
    if (attempt === 1 && (err.name === 'AbortError' || err.message.includes('fetch'))) {
      console.warn('[API] Timeout/network error on', params.action, '— retrying...');
      return sheetGET(params, 2);
    }
    throw err;
  }
}

// ── MASTER DATA ───────────────────────────────────
async function apiGetMasterData() {
  if (CONFIG.DEMO_MODE) {
    return { employees: EMPLOYEES, clients: CLIENTS, projects: PROJECTS };
  }
  return sheetGET({ action: 'getMasterData' });
}

// ── AUTH ──────────────────────────────────────────
async function apiLogin(employeeId, password) {
  if (CONFIG.DEMO_MODE) {
    const emp = EMPLOYEES.find(e => e.id === employeeId);
    if (!emp)                throw new Error('Employee not found.');
    if (emp.pw !== password) throw new Error('Wrong password.');
    return { id: emp.id, name: emp.name, team: emp.team };
  }
  return sheetGET({ action: 'login', uid: employeeId, pw: password });
}

// ── GET DAY SLOTS ─────────────────────────────────
async function apiGetDaySlots(uid, date) {
  if (CONFIG.DEMO_MODE) {
    const all     = JSON.parse(localStorage.getItem(LS_E) || '[]');
    const entries = all.filter(e => e.uid === uid && e.date === date);
    return {
      date,
      slots: {
        morning:   { label: 'Morning',   defaultIn: '09:30', defaultOut: '13:00' },
        afternoon: { label: 'Afternoon', defaultIn: '13:45', defaultOut: '19:30' },
        extended:  { label: 'Extended',  defaultIn: '19:30', defaultOut: '22:00' },
      },
      entries,
    };
  }
  return sheetGET({ action: 'getDaySlots', uid, date });
}

// ── SAVE SLOT ─────────────────────────────────────
async function apiSaveSlot(entry) {
  if (CONFIG.DEMO_MODE) {
    const all      = JSON.parse(localStorage.getItem(LS_E) || '[]');
    const filtered = all.filter(e =>
      !(e.uid === entry.uid && e.date === entry.date &&
        e.slot === entry.slot && e.entryNum === entry.entryNum)
    );
    filtered.unshift(entry);
    localStorage.setItem(LS_E, JSON.stringify(filtered.slice(0, 5000)));
    return { saved: true, history: null };
  }
  const result = await sheetGET({
    action: 'saveSlot',
    data:   encodeURIComponent(JSON.stringify(entry)),
  });
  return { saved: result.saved, history: null };
}

// ── GET HISTORY (own entries — employee portal) ───
async function apiGetHistory(uid) {
  function safeSort(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    return arr.sort((a, b) => {
      const ad = (a && a.date) ? a.date : '';
      const bd = (b && b.date) ? b.date : '';
      const as = (a && a.slot) ? a.slot : '';
      const bs = (b && b.slot) ? b.slot : '';
      if (bd !== ad) return bd.localeCompare(ad);
      return as.localeCompare(bs);
    });
  }

  if (CONFIG.DEMO_MODE) {
    const all   = JSON.parse(localStorage.getItem(LS_E) || '[]');
    const mine  = all.filter(e => e.uid === uid);
    const dates = [...new Set(mine.map(e => e.date).filter(Boolean))].sort().reverse().slice(0, 10);
    const dateSet = new Set(dates);
    return safeSort(mine.filter(e => dateSet.has(e.date)));
  }

  const data = await sheetGET({ action: 'getHistory', uid });
  return safeSort(Array.isArray(data) ? data : []);
}

// ── GET ALL HISTORY (manager portal — all entries) ─
async function apiGetAllHistory(uid) {
  if (CONFIG.DEMO_MODE) {
    const all = JSON.parse(localStorage.getItem(LS_E) || '[]');
    return all.filter(e => e.uid === uid);
  }
  const data = await sheetGET({ action: 'getAllHistory', uid });
  return Array.isArray(data) ? data : [];
}

// ── LEGACY COMPAT ─────────────────────────────────
async function apiLoadEntries(uid) {
  return apiGetHistory(uid);
}