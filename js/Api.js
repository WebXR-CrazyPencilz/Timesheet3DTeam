// ═══════════════════════════════════════════════════
// API.JS — with temporary console debug logs
// Remove the console.log lines once everything works
// ═══════════════════════════════════════════════════

const LS_E = 'tt_entries';

// ── SHARED GET HELPER ─────────────────────────────
async function sheetGET(params) {
  const url = new URL(CONFIG.SHEETS_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log('[API] GET →', params.action, '| URL:', url.toString());

  const res  = await fetch(url.toString());
  const json = await res.json();

  console.log('[API] ←', params.action, '| response:', json);

  if (json.status !== 'ok') throw new Error(json.message || 'Request failed');
  return json.data;
}

// ── MASTER DATA ───────────────────────────────────
async function apiGetMasterData() {
  console.log('[API] apiGetMasterData | DEMO_MODE:', CONFIG.DEMO_MODE);

  if (CONFIG.DEMO_MODE) {
    console.log('[API] Using data.js — employees:', EMPLOYEES.length);
    return { employees: EMPLOYEES, clients: CLIENTS, projects: PROJECTS };
  }

  const data = await sheetGET({ action: 'getMasterData' });
  console.log('[API] Sheet employees:', data.employees?.length,
              '| clients:', data.clients?.length,
              '| projects:', data.projects?.length);
  return data;
}

// ── AUTH ──────────────────────────────────────────
async function apiLogin(employeeId, password) {
  console.log('[API] apiLogin | id:', employeeId, '| DEMO_MODE:', CONFIG.DEMO_MODE);

  if (CONFIG.DEMO_MODE) {
    const emp = EMPLOYEES.find(e => e.id === employeeId);
    if (!emp)                throw new Error('Employee not found.');
    if (emp.pw !== password) throw new Error('Wrong password.');
    console.log('[API] Demo login OK:', emp.name);
    return { id: emp.id, name: emp.name, team: emp.team };
  }

  const data = await sheetGET({ action: 'login', uid: employeeId, pw: password });
  console.log('[API] Sheet login OK:', data);
  return data;
}

// ── GET DAY SLOTS ─────────────────────────────────
async function apiGetDaySlots(uid, date) {
  console.log('[API] apiGetDaySlots | uid:', uid, '| date:', date);

  if (CONFIG.DEMO_MODE) {
    const all     = JSON.parse(localStorage.getItem(LS_E) || '[]');
    const entries = all.filter(e => e.uid === uid && e.date === date);
    console.log('[API] Demo slots found:', entries.length);
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
  console.log('[API] apiSaveSlot | slot:', entry.slot,
              '| entry#:', entry.entryNum,
              '| date:', entry.date,
              '| DEMO_MODE:', CONFIG.DEMO_MODE);

  if (CONFIG.DEMO_MODE) {
    const all      = JSON.parse(localStorage.getItem(LS_E) || '[]');
    const filtered = all.filter(e =>
      !(e.uid === entry.uid && e.date === entry.date &&
        e.slot === entry.slot && e.entryNum === entry.entryNum)
    );
    filtered.unshift(entry);
    localStorage.setItem(LS_E, JSON.stringify(filtered.slice(0, 5000)));
    console.log('[API] Demo save OK — localStorage entries:', filtered.length);
    return { ok: true };
  }

  const result = await sheetGET({
    action: 'saveSlot',
    data:   encodeURIComponent(JSON.stringify(entry)),
  });
  console.log('[API] Sheet save result:', result);
  return result;
}

// ── GET HISTORY ───────────────────────────────────
async function apiGetHistory(uid) {
  console.log('[API] apiGetHistory | uid:', uid);

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
    const all     = JSON.parse(localStorage.getItem(LS_E) || '[]');
    const mine    = all.filter(e => e.uid === uid);
    const dates   = [...new Set(mine.map(e => e.date).filter(Boolean))].sort().reverse().slice(0, 10);
    const dateSet = new Set(dates);
    const result  = safeSort(mine.filter(e => dateSet.has(e.date)));
    console.log('[API] Demo history — entries:', result.length);
    return result;
  }

  const data = await sheetGET({ action: 'getHistory', uid });
  const result = safeSort(Array.isArray(data) ? data : []);
  console.log('[API] Sheet history — entries:', result.length);
  return result;
}

// ── LEGACY COMPAT ─────────────────────────────────
async function apiLoadEntries(uid) {
  return apiGetHistory(uid);
}