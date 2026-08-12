// ═══════════════════════════════════════════════════
// API.JS — optimized for Apps Script cold starts
// ═══════════════════════════════════════════════════

const LS_E = 'tt_entries';

// ── CONCURRENCY LIMITER ────────────────────────────
// Apps Script's /exec endpoint responds with a redirect to a
// short-lived script.googleusercontent.com URL. Under a burst of
// several requests firing at once (very common here — a page/day
// load often kicks off getMasterData + getHistory + getDaySlots +
// getAllHistory together, each from a different init function that
// has no idea the others exist), some of those redirect tokens seem
// to expire before the browser gets to use them, surfacing as a 404
// on that googleusercontent URL specifically — never on the /exec
// deployment URL itself, which is why hitting it directly always
// works fine. Capping actual in-flight requests to 2 and queuing the
// rest fixes this at the one shared choke point (sheetGET) instead
// of having to coordinate every caller across the app.
// Dropped from 2 to 1 — Apps Script's Executions log showed ZERO
// failed doGet runs matching the actual timeouts users hit, meaning
// those requests never reached Code.gs at all; the failure is
// happening between the browser and Apps Script starting execution,
// consistent with the redirect-token issue even at a concurrency of
// 2. Fully serializing (never more than 1 request in flight at a
// time) is the safest fix — page loads take a bit longer since
// nothing runs in parallel anymore, but this removes the burst
// entirely rather than just reducing it.
const SHEET_MAX_CONCURRENT = 1;
let sheetActiveCount = 0;
const sheetQueue = [];

function sheetAcquireSlot() {
  if (sheetActiveCount < SHEET_MAX_CONCURRENT) {
    sheetActiveCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => sheetQueue.push(resolve));
}

function sheetReleaseSlot() {
  const next = sheetQueue.shift();
  if (next) next(); // hand the slot straight to the next queued call
  else sheetActiveCount--;
}

// ── SHARED GET HELPER (with timeout + retry) ───────
async function sheetGET(params, attempt = 1) {
  await sheetAcquireSlot();
  try {
    return await sheetGETInner(params, attempt);
  } finally {
    sheetReleaseSlot();
  }
}

async function sheetGETInner(params, attempt = 1) {
  const url = new URL(CONFIG.SHEETS_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  console.log('[API] GET →', params.action, attempt > 1 ? `(retry #${attempt})` : '');

  const controller = new AbortController();
  // Apps Script cold starts / a busy spreadsheet can genuinely take
  // longer than a typical API call — 15s was tight enough that two
  // consecutive slow (but real) responses in a row could exhaust
  // both attempts and surface as a raw "signal is aborted without
  // reason" error to the person, which reads like a crash rather
  // than "the server was just slow, please wait." Timeout raised to
  // 25s, and MAX_ATTEMPTS raised from 2 to 3 (two retries instead of
  // one) — each attempt has a real chance to succeed instead of
  // giving up after a single retry.
  const timeout = setTimeout(() => controller.abort(), 25000);
  const MAX_ATTEMPTS = 3;

  try {
    const res  = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);

    let json;
    try {
      json = await res.json();
    } catch (parseErr) {
      // The response wasn't valid JSON at all — usually an HTML
      // error page (a 404/5xx from Apps Script's own infrastructure,
      // most often seen when several requests fire at once, e.g. a
      // page load kicking off getMasterData + getHistory + getDaySlots
      // together and one gets a transient rejection). This is a
      // server-side hiccup, not a real script error — treat it as
      // retryable the same as a timeout, rather than letting the
      // SyntaxError from a failed JSON.parse crash straight through
      // uncaught.
      throw new Error('Non-JSON response (HTTP ' + res.status + ') — likely a transient server error.');
    }

    console.log('[API] ←', params.action, '| status:', json.status);
    if (json.status !== 'ok') throw new Error(json.message || 'Request failed');
    return json.data;
  } catch(err) {
    clearTimeout(timeout);
    const isTimeoutOrNetwork = err.name === 'AbortError' || err.message.includes('fetch') || err.message.includes('Non-JSON response');
    if (attempt < MAX_ATTEMPTS && isTimeoutOrNetwork) {
      console.warn('[API] Timeout/network error on', params.action, '— retrying...');
      // Calls sheetGETInner directly, NOT the sheetGET wrapper above —
      // a retry must reuse the concurrency slot it's already holding,
      // not queue up for a second one while blocking release of the
      // first (which could deadlock once enough retries stack up).
      return sheetGETInner(params, attempt + 1);
    }
    // Replace the raw AbortError message ("signal is aborted without
    // reason") with something a person can actually act on, after
    // every attempt has been exhausted.
    if (isTimeoutOrNetwork) {
      throw new Error('The server took too long to respond. Please check your connection and try again.');
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