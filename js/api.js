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
// works fine. Capping actual in-flight requests and queuing the rest
// fixes this at the one shared choke point (sheetGET) instead of
// having to coordinate every caller across the app.
//
// Was briefly dropped to 1 + a mandatory 400ms gap between requests,
// to test whether the failures were a rate-limit rather than pure
// overlap — but that made every page load noticeably slower for
// everyone, and the rate-limit hypothesis was never actually
// confirmed (unlike the burst/redirect-token cause above, which the
// Executions log did confirm — zero matching doGet failures logged,
// meaning those specific requests never reached Code.gs at all).
// Back to 2 with no artificial gap: keeps the confirmed fix, drops
// the speculative, costly one.
//
// Raised from 2 to 4 — with 19 employees, Manager/TL/HR portals each
// fire 19 parallel apiGetAllHistory() calls on load, and at
// concurrency 2 that's ~10 sequential rounds through the queue,
// which is most of what was making "Loading team data..." feel
// endless. This is now safe to widen back up because failed
// individual requests are no longer silently swallowed into missing
// data (see manager.js/teamleader.js/humanresource.js's
// results.filter(r => !r.ok) fix) — a failure now surfaces as a
// visible warning instead of corrupting what's shown, so trading
// back toward speed doesn't reintroduce the data-loss risk, just a
// (now-visible) higher chance any one request needs its retry.
const SHEET_MAX_CONCURRENT = 6;
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
  // Per-action timeout — NOT one blanket value for every request.
  // getTLData does fundamentally more work server-side than any other
  // action: it loops EVERY employee's own sheet in a single Apps
  // Script execution (this replaced the old architecture of 19
  // separate, individually-fast getAllHistory() requests — see
  // teamleader.js's initTeamLeader()). That consolidation was the
  // right fix for the browser-side request-burst problem, but it
  // means this one request can legitimately take much longer to
  // finish executing than a normal single-employee call, with zero
  // network issues involved at all. Giving it the same 12s as every
  // lightweight action was the bug — the 12s reasoning below was
  // written for "many small competing requests," which no longer
  // describes this action after the getTLData consolidation.
  const TIMEOUT_MS_BY_ACTION = {
    getTLData: 60000, // loops every employee's sheet in one execution — needs real headroom
    default:   12000,
  };
  const timeoutMs = TIMEOUT_MS_BY_ACTION[params.action] || TIMEOUT_MS_BY_ACTION.default;
  // 3 attempts x 25s (up to 75s worst case) was too slow in practice
  // — a genuine failure meant sitting through more than a minute
  // before finding out. Balanced back down: 18s per attempt, 2
  // attempts (one retry), 36s worst case — still noticeably more
  // forgiving than the original 15s/1-retry, without being painfully
  // slow on a real failure.
  //
  // Further cut to 12s per attempt (24s worst case) for the general
  // case — with up to 19 small requests firing per portal load
  // (before the getTLData consolidation), a single slow request
  // holding a slot for 18-36s was itself a bottleneck for everyone
  // queued behind it. Failures are visible now (see the
  // concurrency-limiter comment above), so failing faster and
  // reporting it is a better trade than waiting longer per attempt —
  // for everything EXCEPT the one action that genuinely needs more
  // time, which now gets its own value above instead.
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // getTLData gets 3 attempts instead of 2 — after consolidating 19
  // separate requests into this one (see the timeout comment above),
  // it became a single point of failure for the ENTIRE Team Leader
  // portal: before, one employee's data failing left everyone else
  // fine; now, if this one request fails twice, nothing loads at
  // all. That trade-off earns it real retry headroom the way a
  // lightweight per-slot action doesn't need.
  const MAX_ATTEMPTS_BY_ACTION = {
    getTLData: 3,
    default:   2,
  };
  const MAX_ATTEMPTS = MAX_ATTEMPTS_BY_ACTION[params.action] || MAX_ATTEMPTS_BY_ACTION.default;

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

// ── MASTER DATA (cached) ───────────────────────────
// Employees/clients/projects rarely change during a day, but every
// portal (Employee, Manager, TL, HR) independently called
// getMasterData() on its own load — with ~24 accounts (20 employees
// + HR + Manager + 2 TLs), that's a wave of identical, redundant
// requests hitting Apps Script's shared execution slot pool at the
// same moments (e.g. morning clock-in), on top of everything else
// each portal needs. A simple sessionStorage cache removes that
// duplication with no new moving parts — no timers, no background
// refresh, just "check cache, else fetch and store."
const MASTER_DATA_CACHE_KEY = 'timesheet_master_data_v1';
const MASTER_DATA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function apiGetMasterData() {
  if (CONFIG.DEMO_MODE) {
    return { employees: EMPLOYEES, clients: CLIENTS, projects: PROJECTS };
  }

  const cached = readMasterDataCache();
  if (cached) return cached;

  const data = await sheetGET({ action: 'getMasterData' });
  writeMasterDataCache(data);
  return data;
}

function readMasterDataCache() {
  try {
    const raw = sessionStorage.getItem(MASTER_DATA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data || typeof parsed.timestamp !== 'number') return null;
    if (Date.now() - parsed.timestamp >= MASTER_DATA_CACHE_TTL_MS) {
      sessionStorage.removeItem(MASTER_DATA_CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch(e) {
    return null;
  }
}

function writeMasterDataCache(data) {
  try {
    sessionStorage.setItem(MASTER_DATA_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data }));
  } catch(e) {
    // sessionStorage unavailable/full — not fatal, just means no caching this time
  }
}

// Called after any action that changes employees/clients/projects
// (createEmployee, updateEmployeeRecord, client/project master
// create-update-delete) — NOT after normal timesheet entry saves,
// which don't touch this data at all.
function clearMasterDataCache() {
  try { sessionStorage.removeItem(MASTER_DATA_CACHE_KEY); } catch(e) {}
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