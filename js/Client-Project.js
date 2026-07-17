// ═══════════════════════════════════════════════════════════════
// CLIENT-PROJECT.JS — Client + Project business module
//
// This is the single source of truth for everything Client- and
// Project-related. manager.js AND teamleader.js only hand this
// module a content container to render into (renderClientTab /
// renderProjectTab) plus their fetched master/timesheet data — this
// module never asks either portal file to calculate anything itself.
//
// This is NOT a task assignment system, NOT a Kanban board, and NOT
// a project management tool. Employees keep submitting work through
// the existing Timesheet; nothing here assigns work to anyone.
//
// Sheets reused (no new sheets created):
//   • 'Clients'  — already has Client Name (col A) / Client ID (col B).
//     New clients get an auto-generated ID and are colored green so
//     they immediately show up in every existing dropdown that relies
//     on getMasterData()'s green-row convention.
//   • 'Projects' — already has Client ID / Project ID / Project Name
//     (cols A/B/C). This module EXTENDS it with Project Constant,
//     Project Value, Views Planned/Completed/Delivered, Status,
//     Created/Updated Date (cols D–K) rather than creating a second
//     project sheet. Pre-existing rows read back with sensible
//     defaults for the new columns — no migration needed.
//
// Permissions are enforced on the backend (Code.gs), not just in this
// UI — a Team Leader's save request literally cannot alter financial
// fields, a Manager's save request literally cannot alter progress
// fields, and Project Constant/Value are stripped out of the list
// response entirely for a TL request (never transmitted).
//
// Cost/Profit calculation (Manager view only, since it depends on
// Project Constant/Value which Team Leaders never see) is fully
// automatic, reusing data other modules already own:
//   • Timesheet hours  → CP_TIMESHEET_DATA (forwarded by whichever portal is active)
//   • Monthly Points    → salary.js's getEffectiveSalary(empId, month)
//   • Project Constant  → this module's own project record
// No manual entry, no duplicated math.
//
// UI: Client and Project tabs are card grids (not tables/lists),
// matching the Employee tab's card style. Clicking a client card
// opens a Client Detail page showing that client's own projects as
// a scoped card grid; clicking a project card (from either the main
// Project tab or a Client Detail page) opens the existing role-aware
// detail/edit form — that form, the Team & Hours section, and the
// Cost/Profit section are unchanged by this.
//
// Future-ready: window.ClientProjectAPI exposes read access for
// later modules (profit dashboard, invoicing, revenue tracking, etc.)
// without them needing to know this file's internal variable names.
// ═══════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────
let CP_ROLE           = null;   // 'manager' | 'tl' | null
let CP_CLIENTS        = [];     // [{ id, name }]
let CP_PROJECTS       = [];     // full project records (fields depend on role — see backend)
let CP_EMPLOYEES      = [];     // [{ id, name, team }] — forwarded by whichever portal is active
let CP_TIMESHEET_DATA = [];     // all employee timesheet entries — forwarded by whichever portal is active
let CP_MASTER_LOADED  = false;  // did the active portal already forward master data to us?

const CP_STATUSES = ['In Progress', 'Completed', 'On Hold'];

// Manager Notes / Team Leader Notes are capped at this length (both
// via the textarea's maxlength attribute and the live counter next
// to it) — short, at-a-glance remarks, not a full activity log.
const CP_NOTES_MAX_LENGTH = 200;

const CP_STATUS_META = {
  'In Progress': { bg: 'rgba(79,142,247,0.12)',  fg: '#4f8ef7' },
  'Completed':   { bg: 'rgba(52,211,153,0.12)',  fg: '#34d399' },
  'On Hold':     { bg: 'rgba(251,191,36,0.12)',  fg: '#fbbf24' },
};

// ── AUTOMATIC PROJECT COLORS ─────────────────────────────────
// Every project gets a color automatically — no manual color field,
// nothing to set or maintain. The color is derived from a hash of
// the Project ID, so it's deterministic: the same project always
// gets the same color on every render/reload, and different
// projects spread across the palette without collisions being
// likely for a normal-sized project list.
const CP_PROJECT_PALETTE = [
  '#4f8ef7', '#7c5cfc', '#34d399', '#fbbf24', '#f87171', '#22d3ee',
  '#fb923c', '#a78bfa', '#f472b6', '#84cc16', '#38bdf8', '#4ade80',
  '#facc15', '#fb7185', '#818cf8', '#2dd4bf',
];

function getColorForKey(key) {
  const str = String(key || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return CP_PROJECT_PALETTE[hash % CP_PROJECT_PALETTE.length];
}

// Every project gets its own color (card avatar). Every employee also
// gets their own color, used in the Team Hours bar on each project
// card — the same employee gets the same color on every project's
// bar, so it stays recognizable across cards.
function getProjectColor(projectId)  { return getColorForKey('proj:' + projectId); }
function getEmployeeColor(empId)     { return getColorForKey('emp:'  + empId); }

// ── RECENCY HELPERS ──────────────────────────────────────────
// Code.gs writes Created/Updated Date as e.g. "07 Jul 2026, 03:15:00 PM"
// (Utilities.formatDate with 'dd MMM yyyy, hh:mm:ss a') — not directly
// sortable as a string and not reliably parsed by `new Date(str)`
// across browsers, so this parses that exact format explicitly.
// Returns 0 for blank/unrecognized values (legacy rows that predate
// these columns), which naturally sorts them last.
const CP_MONTH_ABBR = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseAppTimestamp(str) {
  if (!str) return 0;
  const m = /^(\d{1,2})\s+(\w{3})\s+(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(String(str).trim());
  if (!m) return 0;
  const mon = CP_MONTH_ABBR[m[2].toLowerCase()];
  if (mon === undefined) return 0;
  let hour = parseInt(m[4], 10) % 12;
  if (/pm/i.test(m[7])) hour += 12;
  return new Date(parseInt(m[3], 10), mon, parseInt(m[1], 10), hour, parseInt(m[5], 10), parseInt(m[6], 10)).getTime();
}

// Projects sorted by REAL activity first — when they were last
// actually worked on, per the Timesheet — not by Project Master
// metadata alone. Most existing projects are legacy rows created
// before "Created/Updated Date" existed as columns, so those are
// blank for them; sorting on that alone left every legacy project
// with an identical score of 0, which is a no-op sort (exactly what
// the screenshot showed — original sheet order, untouched). Timesheet
// activity is real signal that already exists for every project
// with any hours logged, so that's the primary signal now, with the
// Project Master timestamp only as a fallback for a brand-new
// project that has no hours logged against it yet.
function getProjectLastActivity(project) {
  let latest = Math.max(parseAppTimestamp(project.updatedDate), parseAppTimestamp(project.createdDate));

  if (typeof CP_TIMESHEET_DATA !== 'undefined' && CP_TIMESHEET_DATA.length) {
    CP_TIMESHEET_DATA.forEach(e => {
      if (e.project !== project.projectName || e.status === 'Leave' || !e.date) return;
      const t = new Date(e.date + 'T00:00:00').getTime();
      if (t > latest) latest = t;
    });
  }

  return latest;
}

function sortProjectsByRecency(projects) {
  return projects.slice().sort((a, b) => getProjectLastActivity(b) - getProjectLastActivity(a));
}

// "Last entered first" — primarily ordered by Created Date (when the
// project was actually added to Project Master). But most existing
// projects are legacy rows from before that column existed, so their
// createdDate is blank for all of them — comparing 0 to 0 is a no-op
// and silently falls back to whatever order the sheet already had,
// which is NOT "last entered first". Fix: any project with a real
// timestamp always outranks one without (it's provably more recent —
// the column didn't exist yet when the legacy rows were created), and
// among projects that both lack a timestamp, fall back to entryIndex
// (their row position in the Projects sheet, set in loadProjectData)
// — since new projects are always appended, the last row is the most
// recently entered one. Same fallback strategy used for Employees.
function sortProjectsByCreated(projects) {
  return projects.slice().sort((a, b) => {
    const ta = parseAppTimestamp(a.createdDate);
    const tb = parseAppTimestamp(b.createdDate);
    if (ta !== tb) return tb - ta;
    return (b.entryIndex || 0) - (a.entryIndex || 0);
  });
}

// A client's "last activity" is the most recent activity across any
// of its projects — a client with nothing happening on any project
// sorts to the end, one with a project that was worked on recently
// rises to the top.
function getClientLastActivity(clientId) {
  const projects = CP_PROJECTS.filter(p => p.clientId === clientId);
  if (!projects.length) return 0;
  return Math.max(...projects.map(getProjectLastActivity));
}

function clientHasActiveProject(clientId) {
  return CP_PROJECTS.some(p => p.clientId === clientId && p.status === 'In Progress');
}

function sortClientsByRecency(clients) {
  return clients.slice().sort((a, b) => getClientLastActivity(b.id) - getClientLastActivity(a.id));
}

// "Last entered first" — the standing ordering rule across this
// entire app (Projects, Clients, Employees all follow it, in both
// the Manager and Team Leader dashboards): whichever record was most
// recently added shows first, wherever it's listed. Clients (like
// Employees) have no Created Date column — the Clients sheet is just
// Name + ID — so entryIndex (row position, stamped in loadClientData)
// is the signal here: new clients are always appendRow()'d to the
// bottom in Code.gs, so the last row is the most recently added.
function sortClientsByEntry(clients) {
  return clients.slice().sort((a, b) => (b.entryIndex || 0) - (a.entryIndex || 0));
}

// Resolve the current portal role from the same session globals
// auth.js already maintains — no new auth logic introduced here.
function getCPRole() {
  if (typeof MANAGER_MODE !== 'undefined' && MANAGER_MODE) return 'manager';
  if (typeof TL_MODE !== 'undefined' && TL_MODE)          return 'tl';
  return null;
}

// ── PERSISTENT STYLES ─────────────────────────────────────────
// Injected once into <head> instead of embedded in a page's own
// innerHTML — a <style> tag inside content.innerHTML disappears the
// moment that content is replaced (e.g. navigating list → detail),
// which is why the detail form was rendering unstyled before. This
// survives every re-render of every CP page.
function ensureCPStyles() {
  if (document.getElementById('cp-global-styles')) return;
  const style = document.createElement('style');
  style.id = 'cp-global-styles';
  style.textContent = `
    .cp-modal-overlay {
      position:fixed;inset:0;background:rgba(0,0,0,.55);
      display:flex;align-items:center;justify-content:center;z-index:9999;
    }
    .cp-modal {
      background:var(--surface1);border:1px solid var(--border-md);
      border-radius:14px;padding:1.25rem;width:360px;max-width:92vw;max-height:85vh;overflow-y:auto;
    }
    .cp-flabel { font-size:11px;color:var(--txt2);font-weight:600;display:block;margin:0 0 5px; }
    .cp-finput {
      width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:7px;
      color:var(--txt1);font-size:12.5px;padding:8px 10px;box-sizing:border-box;font-family:inherit;
    }
    .cp-finput:disabled { opacity:.55;cursor:not-allowed; }
    .cp-finput:focus { outline:none;border-color:var(--a1); }
    .cp-btn-ghost {
      background:none;border:1px solid var(--border-md);color:var(--txt2);
      border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;
    }
    .cp-btn-primary {
      background:var(--a1);border:none;color:#fff;
      border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:700;cursor:pointer;
    }
    .cp-card {
      background:var(--surface1);border:1px solid var(--border);border-radius:14px;
      padding:1.25rem;width:100%;box-sizing:border-box;margin-bottom:1.25rem;
    }
    .cp-form-field { display:flex;flex-direction:column;gap:2px;margin-bottom:.9rem; }
    .cp-form-grid {
      display:grid;grid-template-columns:1fr 1fr;gap:0 14px;
    }
    .cp-form-grid .cp-form-field.cp-span2 { grid-column:1 / -1; }
    .cp-hint { font-size:10.5px;color:var(--txt2);font-weight:400; }
    .cp-pager-btn {
      padding:6px 12px;border-radius:7px;border:1px solid var(--border-md);
      background:var(--elevated);color:var(--txt2);font-size:11.5px;font-weight:600;cursor:pointer;
    }
    .cp-pager-btn:hover:not(:disabled) { color:var(--txt1);border-color:var(--a1); }
    .cp-pager-btn:disabled { opacity:.35;cursor:default; }
    .cp-pager-btn.active { background:var(--a1);color:#fff;border-color:var(--a1); }
    .cp-pager-num { min-width:30px;text-align:center; }

    /* ── Card grid (Client + Project tabs) ─────────────────────── */
    .cp-tab-header {
      display:flex;align-items:center;justify-content:space-between;
      margin-bottom:1.1rem;flex-wrap:wrap;gap:8px;
    }
    .cp-tab-title { font-size:16px;font-weight:700;color:var(--txt1); }
    .cp-tab-sub { font-size:12px;color:var(--txt2); }

    .cp-back-btn {
      display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;
      border:1px solid var(--border-md);background:var(--elevated);color:var(--txt2);
      font-size:13px;font-weight:600;cursor:pointer;
    }

    .cp-card-grid {
      display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));
      gap:1.5rem;margin-top:.5rem;
    }
    /* Main Project tab (the landing page) — one card per row, full
       width. Scoped to #cpProjectGrid only: a client's own scoped
       project grid on the Client Detail page keeps the denser
       auto-fill layout. */
    #cpProjectGrid {
      grid-template-columns:1fr;
    }
    /* Client grid — one client per row, full width, so there's room
       for the per-project performance candles inside each card. */
    #cpClientGrid {
      grid-template-columns:1fr;
    }

    .cp-entity-card {
      background:var(--surface1);border:1px solid var(--border);border-radius:16px;
      padding:1.5rem;display:flex;flex-direction:column;
    }
    .cp-entity-head { display:flex;align-items:center;gap:12px;margin-bottom:1.1rem; }
    .cp-entity-avatar {
      width:46px;height:46px;border-radius:50%;flex-shrink:0;
      background:linear-gradient(135deg,var(--a1),#7c5cfc);
      display:flex;align-items:center;justify-content:center;
      font-weight:700;font-size:15px;color:#fff;
    }
    .cp-entity-titles { flex:1;min-width:0; }
    .cp-entity-name {
      font-weight:700;font-size:16px;color:var(--txt1);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .cp-entity-id {
      font-size:12px;color:var(--txt2);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }

    .cp-icon-btn {
      flex-shrink:0;background:none;border:none;color:var(--txt2);cursor:pointer;
      font-size:14px;padding:5px 7px;border-radius:6px;
    }
    .cp-icon-btn:hover { background:var(--surface2); }

    .cp-status-pill {
      display:inline-flex;align-items:center;gap:5px;border-radius:20px;
      padding:5px 12px;font-size:11.5px;font-weight:700;
    }
    .cp-status-dot { width:6px;height:6px;border-radius:50%;flex-shrink:0; }

    .cp-entity-metrics {
      display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:1.1rem;
    }
    .cp-metric-box { background:var(--surface2);border-radius:10px;padding:10px 14px; }
    .cp-metric-label {
      font-size:10.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;
    }
    .cp-metric-val { font-size:18px;font-weight:800;color:var(--txt1); }

    .cp-view-btn {
      align-self:flex-start;margin-top:auto;background:var(--a1);color:#fff;border:none;
      border-radius:7px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;
    }
  `;
  document.head.appendChild(style);
}

// ══════════════════════════════════════════════════════════════
// MASTER DATA HAND-OFF — manager.js AND teamleader.js each call this
// once after their own apiGetMasterData() fetch, instead of this
// module re-requesting the same data. Also keeps window.MGR_CLIENTS /
// MGR_PROJECTS populated for other files (Force Entry's client/project
// dropdowns etc.) that already expect those globals from before this
// refactor.
// ══════════════════════════════════════════════════════════════
window.ClientProjectAPI = window.ClientProjectAPI || {};
ClientProjectAPI.ingestMasterData = function(master) {
  window.MGR_CLIENTS  = master.clients  || [];
  window.MGR_PROJECTS = master.projects || [];
  CP_EMPLOYEES     = master.employees || [];
  CP_MASTER_LOADED = true;
};

// TIMESHEET HAND-OFF — manager.js AND teamleader.js each call this
// once after fetching every employee's history, so Team & Hours and
// Cost/Profit work correctly no matter which portal is active. Reading
// the portal-specific MGR_DATA/TL_DATA globals directly would silently
// break for whichever portal didn't populate them.
ClientProjectAPI.ingestTimesheetData = function(entries) {
  CP_TIMESHEET_DATA = entries || [];
};

// ══════════════════════════════════════════════════════════════
// ENTRY POINTS — called by manager.js's and teamleader.js's tab routers.
// ══════════════════════════════════════════════════════════════
async function renderClientTab(content) {
  ensureCPStyles();
  CP_ROLE = getCPRole();
  if (!CP_ROLE) {
    content.innerHTML = `<div class="chart-empty">Client data is only accessible to the Manager or Team Leader.</div>`;
    return;
  }
  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading clients…</span></div>`;
  try {
    // Client cards need both clients (for the grid itself) and
    // projects (for the "project count" / "active" badge on each
    // card, and for the scoped grid on the Client Detail page).
    await Promise.all([loadClientData(), loadProjectData()]);
  } catch(err) {
    content.innerHTML = `<div class="slot-error">Failed to load clients: ${esc(err.message)}</div>`;
    return;
  }

  renderClientCards(content);
}

async function renderProjectTab(content) {
  ensureCPStyles();
  CP_ROLE = getCPRole();
  if (!CP_ROLE) {
    content.innerHTML = `<div class="chart-empty">Project data is only accessible to the Manager or Team Leader.</div>`;
    return;
  }
  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading projects…</span></div>`;
  try {
    await Promise.all([loadClientData(), loadProjectData()]);
  } catch(err) {
    content.innerHTML = `<div class="slot-error">Failed to load projects: ${esc(err.message)}</div>`;
    return;
  }
  renderProjectList(content);
}

async function loadClientData() {
  // getClientMasterList returns rows in sheet order (top to bottom),
  // and Code.gs's createClientMaster always appendRow()s new clients
  // to the bottom — so this index doubles as "how recently was this
  // client entered", the same signal used for Projects and Employees.
  const clients = await sheetGET({ action: 'getClientMasterList' });
  CP_CLIENTS = clients.map((c, idx) => ({ ...c, entryIndex: idx }));
  window.MGR_CLIENTS = CP_CLIENTS; // keep the compatibility shim fresh too
}

async function loadProjectData() {
  // getProjectMasterList returns rows in sheet order (top to bottom),
  // and Code.gs always appendRow()s new projects to the bottom — so
  // this index doubles as "how recently was this project entered",
  // used by sortProjectsByCreated as a fallback for legacy rows that
  // have no real Created Date.
  const projects = await sheetGET({ action: 'getProjectMasterList', role: CP_ROLE });
  CP_PROJECTS = projects.map((p, idx) => ({ ...p, entryIndex: idx }));
}

// ══════════════════════════════════════════════════════════════
// CLIENT — card grid + create (Client Name only; Client ID is
// auto-generated, read-only, shown as a live preview before saving).
// Clicking a card opens a Client Detail page (that client's own
// projects, scoped, as their own card grid).
// ══════════════════════════════════════════════════════════════
async function renderClientCards(content) {
  const isManager = CP_ROLE === 'manager';
  const sorted = sortClientsByRecency(CP_CLIENTS); // most recently active client first — corrected from entry-order, see sortClientsByRecency

  content.innerHTML = `
    <div class="cp-tab-header">
      <div>
        <div class="cp-tab-title">🏢 Clients</div>
        <div class="cp-tab-sub">${isManager ? 'Client ID is auto-generated and permanent once created.' : 'View each client\u2019s projects and progress.'}</div>
      </div>
      ${(isManager || CP_ROLE === 'tl') ? `<button id="cpNewClientBtn" class="cp-btn-primary" style="padding:8px 16px;font-size:13px;border-radius:8px;">+ New Client</button>` : ''}
    </div>

    ${sorted.length === 0
      ? `<div class="chart-empty">No clients yet.${isManager ? ' Click “+ New Client” to add one.' : ''}</div>`
      : `<div class="cp-card-grid" id="cpClientGrid">${sorted.map(c => buildClientCard(c, isManager, null)).join('')}</div>`}
  `;

  $('cpNewClientBtn')?.addEventListener('click', () =>
    openClientEditor(content, null, () => renderClientCards(content)));

  wireClientCardEvents(content);

  // Performance candles need each project's cost (Constant vs. actual
  // employee cost), which needs salary data — same two-phase pattern
  // used on the Project tab: render immediately with hours-only
  // candles, then fill in Constant/Value/Profit once salary data has
  // loaded, without blocking the initial view on that fetch.
  if (isManager && sorted.length) {
    await ensureSalaryDataLoaded();
    const grid = $('cpClientGrid');
    if (!grid || !document.body.contains(grid)) return; // navigated away while this was loading
    grid.innerHTML = sorted.map(c => buildClientCard(c, isManager, buildClientCostMap(c))).join('');
    wireClientCardEvents(content);
  }
}

function wireClientCardEvents(content) {
  content.querySelectorAll('.cp-client-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const client = CP_CLIENTS.find(c => c.id === btn.dataset.id);
      if (client) renderClientDetail(content, client);
    });
  });
  content.querySelectorAll('.cp-client-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const client = CP_CLIENTS.find(c => c.id === btn.dataset.id);
      if (client) openClientEditor(content, client, () => renderClientCards(content));
    });
  });
}

// Cost for every one of this client's projects, keyed by Project ID —
// computed once per client rather than inline per-candle, so
// buildClientCandleChart just does a lookup.
function buildClientCostMap(client) {
  const map = {};
  CP_PROJECTS.filter(p => p.clientId === client.id).forEach(p => {
    map[p.projectId] = calculateProjectCost(p);
  });
  return map;
}

function buildClientCard(client, isManager, costMap) {
  const initials = client.name.split(' ').map(w => w[0]).filter(Boolean).join('').toUpperCase().slice(0, 2) || '?';
  const isActive = clientHasActiveProject(client.id);
  const clientProjects = CP_PROJECTS.filter(p => p.clientId === client.id);
  const totalHours = clientProjects.reduce((s, p) => s + getProjectTeamActivity(p).totalHours, 0);

  const st = isActive
    ? { bg: 'rgba(52,211,153,0.12)', fg: '#34d399', label: 'Active Project' }
    : { bg: 'rgba(148,163,184,0.12)', fg: '#94a3b8', label: 'No Active Project' };

  return `
    <div class="cp-entity-card">
      <div class="cp-entity-head">
        <div class="cp-entity-avatar">${esc(initials)}</div>
        <div class="cp-entity-titles">
          <div class="cp-entity-name" title="${esc(client.name)}">${esc(client.name)}</div>
          <div class="cp-entity-id">${esc(client.id)}</div>
        </div>
        ${isManager ? `<button class="cp-icon-btn cp-client-edit-btn" data-id="${esc(client.id)}" title="Edit client">✏️</button>` : ''}
      </div>

      <div style="margin-bottom:.9rem;">
        <span class="cp-status-pill" style="background:${st.bg};color:${st.fg};">
          <span class="cp-status-dot" style="background:${st.fg};"></span>${st.label}
        </span>
      </div>

      <div class="cp-entity-metrics" style="grid-template-columns:1fr 1fr;max-width:400px;">
        <div class="cp-metric-box">
          <div class="cp-metric-label">Projects</div>
          <div class="cp-metric-val">${clientProjects.length}</div>
        </div>
        <div class="cp-metric-box">
          <div class="cp-metric-label">Total Hours</div>
          <div class="cp-metric-val">${totalHours.toFixed(1)}h</div>
        </div>
      </div>

      <div style="margin:1rem 0;">
        <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Project Performance</div>
        ${buildClientCandleChart(client, clientProjects, isManager, costMap)}
      </div>

      <button class="cp-view-btn cp-client-view-btn" data-id="${esc(client.id)}">View Projects →</button>
    </div>`;
}

// One "candle" per project: a vertical stacked bar whose fill height
// (relative to the client's own busiest project) represents total
// hours logged, and whose segments — one color per employee, reusing
// the same getEmployeeColor used on Project cards' Team Hours bar —
// show who contributed how much. Below each candle: the project's
// Constant, Value, and Profit/Loss (Manager only — Team Leaders still
// see the hours candle itself, just not the money figures, same
// boundary enforced everywhere else Project Constant/Value appears).
function buildClientCandleChart(client, projects, isManager, costMap) {
  if (!projects.length) {
    return `<div style="font-size:11px;color:var(--txt2);">No projects yet for this client.</div>`;
  }

  const perProject = projects.map(p => {
    const totals = getProjectEmployeeTotals(p);
    const totalHours = totals.reduce((s, t) => s + t.hours, 0);
    const constant = parseFloat(p.projectConstant) || 0;
    return { project: p, totals, totalHours, constant };
  });

  const maxHours    = Math.max(...perProject.map(x => x.totalHours), 0.01);
  const maxConstant = Math.max(...perProject.map(x => x.constant), 0.01);

  const rows = perProject.map(({ project: p, totals, totalHours, constant }, i) => {
    const cost   = isManager ? (costMap ? costMap[p.projectId] : null) : null;
    const isLast = i === perProject.length - 1;
    return buildProjectPerfRow(p, totals, totalHours, maxHours, constant, maxConstant, isManager, cost, isLast);
  }).join('');

  return `<div>${rows}</div>`;
}

// One project's performance, as two horizontal bars instead of a
// vertical candle: Time (segmented by employee, length relative to
// this client's busiest project) and Constant (length relative to
// this client's highest Constant) — Manager only sees the Constant
// bar and the Value/Profit line beneath it, same permission boundary
// as before.
function buildProjectPerfRow(project, totals, totalHours, maxHours, constant, maxConstant, showMoney, cost, isLast) {
  const hasHours = totalHours > 0;
  const timeFillPct = hasHours ? Math.max((totalHours / maxHours) * 100, 3) : 100;
  const timeSegments = hasHours
    ? totals.map(t => {
        const segPct = (t.hours / totalHours) * 100;
        return `<div style="width:${segPct}%;height:100%;background:${getEmployeeColor(t.empId)};"
          title="${esc(t.name)}: ${fmtHM(t.hours)}"></div>`;
      }).join('')
    : `<div style="width:100%;height:100%;background:var(--border-md);" title="No hours logged yet"></div>`;

  let moneyHtml = '';
  if (showMoney) {
    const hasConstant  = constant > 0;
    const constFillPct = hasConstant ? Math.max((constant / maxConstant) * 100, 3) : 100;
    const value = parseFloat(project.projectValue) || 0;

    const perfHtml = cost
      ? (() => {
          const isProfit = cost.profit >= 0;
          return `<span style="font-weight:700;color:${isProfit ? '#34d399' : '#f87171'};">${isProfit ? '+' : '-'}${fmtCPRupees(Math.abs(cost.profit))}</span>`;
        })()
      : `<span style="color:var(--txt2);">Calculating…</span>`;

    moneyHtml = `
      <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
        <span style="flex:0 0 62px;font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;">Constant</span>
        <div style="flex:1;height:10px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;overflow:hidden;">
          <div style="width:${constFillPct}%;height:100%;background:${hasConstant ? '#f59e0b' : 'var(--border-md)'};"></div>
        </div>
        <span style="flex:0 0 74px;text-align:right;font-size:10px;color:var(--txt1);font-weight:700;white-space:nowrap;">${fmtCPRupees(constant)}</span>
      </div>
      <div style="font-size:9.5px;color:var(--txt2);margin-top:4px;padding-left:72px;">
        Value: ${fmtCPRupees(value)} · ${perfHtml}
      </div>`;
  }

  return `
    <div style="${isLast ? '' : 'margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
        <span style="font-size:11.5px;font-weight:700;color:var(--txt1);" title="${esc(project.projectName || project.projectId)}">${esc(project.projectId)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="flex:0 0 62px;font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;">Time</span>
        <div style="flex:1;height:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;overflow:hidden;">
          <div style="width:${timeFillPct}%;height:100%;display:flex;">${timeSegments}</div>
        </div>
        <span style="flex:0 0 74px;text-align:right;font-size:10px;color:var(--txt1);font-weight:700;white-space:nowrap;">${fmtHM(totalHours)}</span>
      </div>
      ${moneyHtml}
    </div>`;
}

// Create (no client passed) or rename (client passed) — Manager only,
// re-checked server-side too on delete.
function openClientEditor(content, client = null, onDone = null) {
  const isNew = !client;
  // Creating is now Manager OR Team Leader; renaming an existing
  // client (isNew === false) stays Manager-only — this function is
  // never even opened in the rename path for a Team Leader, since
  // buildClientCard only renders the edit pencil for isManager.
  if (!isNew && CP_ROLE !== 'manager') return;
  if (isNew && CP_ROLE !== 'manager' && CP_ROLE !== 'tl') return;

  const refresh = onDone || (() => renderClientCards(content));

  const overlay = document.createElement('div');
  overlay.className = 'cp-modal-overlay';
  overlay.innerHTML = `
    <div class="cp-modal">
      <div style="font-weight:700;font-size:15px;color:var(--txt1);margin-bottom:12px;">${isNew ? '🏢 New Client' : '✏️ Rename Client'}</div>

      <label class="cp-flabel">Client Name</label>
      <input class="cp-finput" id="cpClientName" value="${isNew ? '' : esc(client.name)}" placeholder="e.g. Brigade Group"/>

      <label class="cp-flabel">Client ID</label>
      <input class="cp-finput" id="cpClientIdPreview" value="${isNew ? 'Generating…' : esc(client.id)}" disabled/>

      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:16px;">
        ${(!isNew) ? `<button id="cpClientDelete" style="background:none;border:1px solid rgba(248,113,113,0.4);
          color:#f87171;border-radius:7px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;">🗑 Delete</button>` : `<span></span>`}
        <div style="display:flex;gap:8px;">
          <button id="cpClientCancel" class="cp-btn-ghost">Cancel</button>
          <button id="cpClientSave" class="cp-btn-primary">${isNew ? 'Create' : 'Save'}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  if (isNew) {
    sheetGET({ action: 'getNextClientId' })
      .then(id => { const el = overlay.querySelector('#cpClientIdPreview'); if (el) el.value = id; })
      .catch(() => { const el = overlay.querySelector('#cpClientIdPreview'); if (el) el.value = '—'; });
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#cpClientCancel').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#cpClientSave').addEventListener('click', async () => {
    const name = overlay.querySelector('#cpClientName').value.trim();
    if (!name) { toast?.('e', 'Client name is required'); return; }

    const btn = overlay.querySelector('#cpClientSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (isNew) {
        await sheetGET({ action: 'createClientMaster', data: encodeURIComponent(JSON.stringify({ role: CP_ROLE, name })) });
        toast?.('s', 'Client created', name);
      } else {
        await sheetGET({ action: 'updateClientMaster', data: encodeURIComponent(JSON.stringify({ role: CP_ROLE, id: client.id, name })) });
        toast?.('s', 'Client updated', name);
      }
      overlay.remove();
      await loadClientData();
      refresh();
    } catch(err) {
      btn.disabled = false; btn.textContent = isNew ? 'Create' : 'Save';
      toast?.('e', 'Save failed', err.message);
    }
  });

  overlay.querySelector('#cpClientDelete')?.addEventListener('click', async () => {
    if (!confirm(`Delete client "${client.name}" (${client.id})? This cannot be undone.`)) return;
    try {
      await sheetGET({ action: 'deleteClientMaster', data: encodeURIComponent(JSON.stringify({ role: CP_ROLE, id: client.id })) });
      toast?.('s', 'Client deleted', client.name);
      overlay.remove();
      await loadClientData();
      refresh();
    } catch(err) {
      toast?.('e', 'Delete failed', err.message);
    }
  });
}

// ══════════════════════════════════════════════════════════════
// CLIENT DETAIL — a single client's own projects as a scoped card
// grid, reusing the exact same buildProjectCard/renderProjectCardsInto
// used by the main Project tab. "+ Add Project" is preset to this
// client (same mechanism the old tree's "+ Add Project" used).
// ══════════════════════════════════════════════════════════════
function renderClientDetail(content, client) {
  const isManager = CP_ROLE === 'manager';
  const projects = sortProjectsByRecency(CP_PROJECTS.filter(p => p.clientId === client.id)); // most recently active project first

  content.innerHTML = `
    <div style="margin-bottom:1rem;">
      <button id="cpClientBack" class="cp-back-btn">← Back to Clients</button>
    </div>

    <div class="cp-tab-header">
      <div>
        <div class="cp-tab-title">🏢 ${esc(client.name)}</div>
        <div class="cp-tab-sub">${esc(client.id)} · ${projects.length} project${projects.length !== 1 ? 's' : ''}</div>
      </div>
      <div style="display:flex;gap:8px;">
        ${isManager ? `<button id="cpClientDetailEdit" class="cp-btn-ghost">✏️ Edit Client</button>` : ''}
        ${(isManager || CP_ROLE === 'tl') ? `<button id="cpClientAddProject" class="cp-btn-primary" style="padding:8px 16px;font-size:13px;border-radius:8px;">+ Add Project</button>` : ''}
      </div>
    </div>

    ${projects.length === 0
      ? `<div class="chart-empty">No projects yet for this client.${isManager ? ' Click “+ Add Project” to add one.' : ''}</div>`
      : `<div class="cp-card-grid" id="cpClientProjectGrid"></div>`}
  `;

  $('cpClientBack').addEventListener('click', () => renderClientCards(content));
  $('cpClientDetailEdit')?.addEventListener('click', () =>
    openClientEditor(content, client, () => renderClientDetail(content, client)));
  $('cpClientAddProject')?.addEventListener('click', () =>
    openProjectDetail(content, null, { onBack: () => renderClientDetail(content, client), presetClientId: client.id }));

  if (projects.length) {
    renderProjectCardsInto(content, $('cpClientProjectGrid'), projects, () => renderClientDetail(content, client));
  }
}

// ══════════════════════════════════════════════════════════════
// PROJECT — card grid + role-aware detail/edit. Shared by the main
// Project tab (all projects) and Client Detail (scoped to one client)
// via renderProjectCardsInto, so there is one project-card
// implementation, not two.
// ══════════════════════════════════════════════════════════════
function renderProjectList(content) {
  const isManager = CP_ROLE === 'manager';
  const sortedProjects = sortProjectsByRecency(CP_PROJECTS); // most recently active project first — corrected from creation-order

  content.innerHTML = `
    <div class="cp-tab-header">
      <div>
        <div class="cp-tab-title">📁 Projects</div>
        <div class="cp-tab-sub">Projects received from clients — status and view progress. Not a task board.</div>
      </div>
      ${(isManager || CP_ROLE === 'tl') ? `<button id="cpNewProjectBtn" class="cp-btn-primary" style="padding:8px 16px;font-size:13px;border-radius:8px;">+ New Project</button>` : ''}
    </div>

    ${sortedProjects.length === 0
      ? `<div class="chart-empty">No projects yet.${isManager ? ' Click “+ New Project” to add one.' : ''}</div>`
      : `<div class="cp-card-grid" id="cpProjectGrid"></div>`}
  `;

  $('cpNewProjectBtn')?.addEventListener('click', () => openProjectDetail(content, null));

  if (sortedProjects.length) {
    renderProjectCardsInto(content, $('cpProjectGrid'), sortedProjects, () => renderProjectList(content));
  }
}

// Renders a set of project cards into a given grid element. Renders
// immediately without the Profit/Loss chip (so the grid isn't
// blocked waiting on the salary fetch), then — for Manager only —
// loads salary data once and re-renders with the chip filled in.
// Team Leaders never see this chip at all (same permission boundary
// as the rest of this module: they never receive Project
// Constant/Value, so there's nothing to compute a profit chip from).
async function renderProjectCardsInto(content, gridEl, projects, onBack) {
  if (!gridEl) return;
  const isManager = CP_ROLE === 'manager';

  gridEl.innerHTML = projects.map(p => buildProjectCard(p, isManager, null)).join('');
  wireProjectCards(content, gridEl, projects, onBack);

  if (isManager) {
    await ensureSalaryDataLoaded();
    if (!document.body.contains(gridEl)) return; // user navigated away while this was loading
    gridEl.innerHTML = projects.map(p => buildProjectCard(p, isManager, calculateProjectCost(p))).join('');
    wireProjectCards(content, gridEl, projects, onBack);
  }
}

function wireProjectCards(content, gridEl, projects, onBack) {
  gridEl.querySelectorAll('.cp-project-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const project = projects.find(p => p.projectId === btn.dataset.id);
      if (project) openProjectDetail(content, project.projectId, { onBack });
    });
  });
}

function buildProjectCard(p, isManager, costResult) {
  const client = CP_CLIENTS.find(c => c.id === p.clientId);
  const meta   = CP_STATUS_META[p.status] || CP_STATUS_META['In Progress'];
  const initials = (p.projectName || p.projectId || '?').trim().slice(0, 2).toUpperCase();
  const color  = getProjectColor(p.projectId);

  let profitBox = '';
  if (isManager) {
    if (costResult) {
      const isProfit = costResult.profit >= 0;
      profitBox = `
        <div class="cp-metric-box">
          <div class="cp-metric-label">${isProfit ? 'Profit' : 'Loss'}</div>
          <div class="cp-metric-val" style="color:${isProfit ? '#34d399' : '#f87171'};">${isProfit ? '+' : '-'}${fmtCPRupees(Math.abs(costResult.profit))}</div>
        </div>`;
    } else {
      profitBox = `
        <div class="cp-metric-box">
          <div class="cp-metric-label">Profit</div>
          <div class="cp-metric-val" style="color:var(--txt2);font-size:11px;font-weight:600;">Calculating…</div>
        </div>`;
    }
  }

  // Basic details only, by design — Team Hours, Timeline, Notes, and
  // the full Cost breakdown all live one click away on the Project
  // Detail page. This card is a scan-list entry, not a dashboard.
  return `
    <div class="cp-entity-card">
      <div class="cp-entity-head">
        <div class="cp-entity-avatar" style="background:${color};">${esc(initials)}</div>
        <div class="cp-entity-titles">
          <div class="cp-entity-name" title="${esc(p.projectName)}">${esc(p.projectName || p.projectId)}</div>
          <div class="cp-entity-id" title="${esc(client?.name || p.clientId || '')}">${esc(p.projectId)} · ${esc(client?.name || p.clientId || '—')}</div>
        </div>
      </div>

      <div style="margin-bottom:.9rem;">
        <span class="cp-status-pill" style="background:${meta.bg};color:${meta.fg};">${esc(p.status)}</span>
      </div>

      <div class="cp-entity-metrics">
        <div class="cp-metric-box">
          <div class="cp-metric-label">Planned</div>
          <div class="cp-metric-val">${p.plannedViews || 0}</div>
        </div>
        <div class="cp-metric-box">
          <div class="cp-metric-label">Completed</div>
          <div class="cp-metric-val">${p.completedViews || 0}</div>
        </div>
        <div class="cp-metric-box">
          <div class="cp-metric-label">Start Date</div>
          <div class="cp-metric-val" style="font-size:14px;">${fmtCPDateShort(p.startDate)}</div>
        </div>
        ${profitBox}
      </div>

      <button class="cp-view-btn cp-project-view-btn" data-id="${esc(p.projectId)}">View Details →</button>
    </div>`;
}

// Two separate notes fields, each owned by its own role (Manager
// writes Manager Notes, Team Leader writes Team Leader Notes — see
// Code.gs's saveProjectMaster). Both are shown to both roles here —
// they aren't financial data like Project Constant/Value, so there's
// no reason to hide either one — but each is only ever EDITED by its
// owner, via the Project Detail form. A note that hasn't been written
// yet shows an explicit "No notes yet" placeholder rather than being
// left blank, so it's clear the field exists and simply hasn't been
// filled in.
function buildProjectNotesPreview(p) {
  const mgrNote = (p.managerNotes || '').trim();
  const tlNote  = (p.teamLeaderNotes || '').trim();

  const box = (label, text) => `
    <div class="cp-metric-box">
      <div class="cp-metric-label">${label}</div>
      <div style="font-size:11.5px;color:${text ? 'var(--txt1)' : 'var(--txt2)'};font-style:${text ? 'normal' : 'italic'};
        overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;margin-top:2px;"
        title="${esc(text)}">${esc(text || 'No notes yet')}</div>
    </div>`;

  return `
    <div style="margin-bottom:.9rem;">
      <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Notes</div>
      <div class="cp-entity-metrics" style="margin-bottom:0;">
        ${box('Manager', mgrNote)}
        ${box('Team Leader', tlNote)}
      </div>
    </div>`;
}

// ── DETAIL / EDIT — role-based permissions applied automatically:
//   Manager: edit Name/ID/Client/Constant/Value/Planned/Status,
//            view-only on Completed/Delivered.
//   Team Leader: view-only on Name/ID/Planned/Status, edit
//            Completed/Delivered. Constant/Value never rendered
//            (and never even present in the data for a TL request).
async function openProjectDetail(content, projectId, opts = {}) {
  const goBack = opts.onBack || (() => renderProjectList(content));
  const presetClientId = opts.presetClientId || '';

  const isNew = !projectId;
  const project = isNew
    ? { projectId: '', projectName: '', clientId: presetClientId, projectConstant: '', projectValue: 0,
        plannedViews: 0, completedViews: 0, status: 'In Progress', managerNotes: '', teamLeaderNotes: '',
        startDate: '', endDate: '' }
    : CP_PROJECTS.find(p => p.projectId === projectId);

  if (!isNew && !project) { toast?.('e', 'Project not found', projectId); return; }

  const isManager = CP_ROLE === 'manager';
  const isTL      = CP_ROLE === 'tl';

  // Manager can always edit the core project fields. Team Leader can
  // ALSO edit them, but only while CREATING a new project — editing
  // an EXISTING project's Name/ID/Client/Planned/Status stays
  // Manager-only, same as before. Project Constant/Value are never
  // part of this — Team Leader never sees or sets those, even when
  // creating a project; they stay blank until a Manager fills them
  // in via edit.
  const canEditCore = isManager || (isNew && isTL);

  // Start Date/End Date are a deliberate exception to canEditCore:
  // Team Leader can edit these on an EXISTING project too, not just
  // at creation — everything else stays governed by canEditCore.
  const canEditDates = isManager || isTL;

  let suggestedId = '';
  if (isNew && isManager) {
    try { suggestedId = (await sheetGET({ action: 'getNextProjectId' })) || ''; } catch(e) { /* fine, manager types it manually */ }
  }

  const formCard = `
    <div class="cp-card">
      <div style="font-weight:700;font-size:16px;color:var(--txt1);margin-bottom:.2rem;">
        ${isNew ? '📁 New Project' : '📁 ' + esc(project.projectName || project.projectId)}
      </div>
      <div style="font-size:11.5px;color:var(--txt2);margin-bottom:1.1rem;">
        ${isNew && isTL ? 'You can create the project. Project Constant/Value are set later by the Manager.'
        : isManager ? 'You can edit project details, status, and view progress.'
                    : 'You can update Views Completed and Start/End Date. Other project details and status are view-only here — Manager updates those.'}
      </div>

      <div class="cp-form-grid">
        <div class="cp-form-field cp-span2">
          <label class="cp-flabel">Project Name</label>
          <input class="cp-finput" id="cpName" value="${esc(project.projectName)}" ${canEditCore ? '' : 'disabled'} placeholder="e.g. SPR Tower F&amp;G Floorplan"/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Project ID ${isNew && isManager ? '<span class="cp-hint">— suggested, editable</span>' : ''}</label>
          <input class="cp-finput" id="cpId" value="${esc(isNew ? suggestedId : project.projectId)}" ${canEditCore ? '' : 'disabled'} placeholder="e.g. EUZ-042"/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Client</label>
          <select class="cp-finput" id="cpClient" ${canEditCore ? '' : 'disabled'}>
            <option value="">— Select client —</option>
            ${CP_CLIENTS.map(c => `<option value="${esc(c.id)}" ${c.id === project.clientId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>

        ${isManager ? `
        <div class="cp-form-field">
          <label class="cp-flabel">Project Constant</label>
          <input class="cp-finput" id="cpConstant" value="${esc(project.projectConstant)}" placeholder="e.g. 1.5"/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Project Value (₹)</label>
          <input class="cp-finput" id="cpValue" type="number" min="0" value="${project.projectValue || ''}" placeholder="e.g. 8500"/>
        </div>` : ''}

        <div class="cp-form-field">
          <label class="cp-flabel">Views Planned</label>
          <input class="cp-finput" id="cpPlanned" type="number" min="0" value="${project.plannedViews || ''}" ${canEditCore ? '' : 'disabled'} placeholder="e.g. 20"/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Status</label>
          <select class="cp-finput" id="cpStatus" ${canEditCore ? '' : 'disabled'}>
            ${CP_STATUSES.map(s => `<option value="${s}" ${s === project.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Start Date</label>
          <input class="cp-finput" id="cpStartDate" type="date" value="${esc(project.startDate)}" ${canEditDates ? '' : 'disabled'}/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">End Date</label>
          <input class="cp-finput" id="cpEndDate" type="date" value="${esc(project.endDate)}" ${canEditDates ? '' : 'disabled'}/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Views Completed</label>
          <input class="cp-finput" id="cpCompleted" type="number" min="0" value="${project.completedViews || ''}" placeholder="0"/>
        </div>
      </div>

      <div class="cp-form-field" style="margin-top:.2rem;">
        <label class="cp-flabel">Manager Notes ${isManager ? '' : '<span class="cp-hint">— view only</span>'}</label>
        <textarea class="cp-finput" id="cpMgrNotes" rows="2" maxlength="${CP_NOTES_MAX_LENGTH}" ${isManager ? '' : 'disabled'}
          oninput="updateCPNotesCount('cpMgrNotes','cpMgrNotesCount')"
          placeholder="${isManager ? 'Notes only you can edit…' : ''}">${esc(project.managerNotes)}</textarea>
        ${isManager ? `<div id="cpMgrNotesCount" style="text-align:right;font-size:10px;color:var(--txt2);margin-top:2px;">${project.managerNotes.length}/${CP_NOTES_MAX_LENGTH}</div>` : ''}
      </div>

      <div class="cp-form-field">
        <label class="cp-flabel">Team Leader Notes ${isTL ? '' : '<span class="cp-hint">— view only</span>'}</label>
        <textarea class="cp-finput" id="cpTlNotes" rows="2" maxlength="${CP_NOTES_MAX_LENGTH}" ${isTL ? '' : 'disabled'}
          oninput="updateCPNotesCount('cpTlNotes','cpTlNotesCount')"
          placeholder="${isTL ? 'Notes only you can edit…' : ''}">${esc(project.teamLeaderNotes)}</textarea>
        ${isTL ? `<div id="cpTlNotesCount" style="text-align:right;font-size:10px;color:var(--txt2);margin-top:2px;">${project.teamLeaderNotes.length}/${CP_NOTES_MAX_LENGTH}</div>` : ''}
      </div>

      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:.4rem;">
        ${(!isNew && isManager)
          ? `<button id="cpDeleteBtn" style="background:none;border:1px solid rgba(248,113,113,0.4);
              color:#f87171;border-radius:8px;padding:8px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">🗑 Delete</button>`
          : `<span></span>`}
        <button id="cpSaveBtn" style="background:var(--a1);color:#fff;border:none;border-radius:8px;
          padding:8px 18px;font-size:12.5px;font-weight:700;cursor:pointer;">${isNew ? 'Create Project' : 'Save Changes'}</button>
      </div>
    </div>`;

  // Existing projects get a two-column layout: the form stays a fixed,
  // readable width on the left, and Timeline/Team Hours/Cost & Profit
  // stack in the remaining space on the right — instead of everything
  // stacking in one narrow centered column with the rest of a PC
  // screen sitting empty. A brand-new (not-yet-created) project has
  // none of those sections yet, so it just gets the form alone at a
  // sensible width.
  const bodyHtml = isNew
    ? `<div style="max-width:620px;margin:0 auto;">${formCard}</div>`
    : `
      <div style="max-width:1400px;margin:0 auto;display:grid;grid-template-columns:620px 1fr;gap:1.5rem;align-items:start;">
        <div>
          ${formCard}
          ${isManager ? `<div id="cpCostSection" style="margin-top:1.25rem;"></div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:1.25rem;">
          <div id="cpTimelineSection"></div>
          <div id="cpTeamSection"></div>
        </div>
      </div>`;

  content.innerHTML = `
    <div style="margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <button id="cpProjBack" class="cp-back-btn">← Back</button>
      ${!isNew ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="cpReportMonth" class="cp-btn-ghost">📥 This Month</button>
          <button id="cpReportOverall" class="cp-btn-ghost">📥 Overall Report</button>
        </div>` : ''}
    </div>
    ${bodyHtml}
  `;

  $('cpProjBack').addEventListener('click', goBack);
  $('cpSaveBtn').addEventListener('click', () => saveProjectFromForm(content, isNew, project, goBack));
  $('cpDeleteBtn')?.addEventListener('click', () => deleteProjectFromForm(content, project, goBack));
  $('cpReportMonth')?.addEventListener('click', () => openProjectReport(project, 'month'));
  $('cpReportOverall')?.addEventListener('click', () => openProjectReport(project, 'overall'));

  if (!isNew) renderProjectTimelineSection(project);
  if (!isNew) renderProjectTeamSection(project);
  if (!isNew && isManager) renderProjectCostSection(project);
}

async function saveProjectFromForm(content, isNew, originalProject, onDone) {
  const btn = $('cpSaveBtn');
  const isManager = CP_ROLE === 'manager';
  const isTL      = CP_ROLE === 'tl';
  const payload = { role: CP_ROLE };

  if (isManager) {
    const name     = $('cpName').value.trim();
    const id       = $('cpId').value.trim();
    const clientId = $('cpClient').value;
    if (!name) { toast?.('e', 'Project Name is required'); return; }
    if (!id)   { toast?.('e', 'Project ID is required');   return; }

    payload.projectId       = id;
    payload.projectName     = name;
    payload.clientId        = clientId;
    payload.projectConstant = $('cpConstant').value.trim();
    payload.projectValue    = parseFloat($('cpValue').value) || 0;
    payload.plannedViews    = parseFloat($('cpPlanned').value) || 0;
    payload.status          = $('cpStatus').value;
    payload.startDate       = $('cpStartDate').value;
    payload.endDate         = $('cpEndDate').value;
    payload.completedViews  = parseFloat($('cpCompleted').value) || 0;
    payload.managerNotes    = $('cpMgrNotes').value.trim();
    if (!isNew) payload.originalProjectId = originalProject.projectId;
  } else if (isTL && isNew) {
    // Team Leader creating a new project — same core fields a
    // Manager would set, but never Project Constant/Value (Team
    // Leader never sees those, even at creation — they stay blank
    // until a Manager fills them in via edit).
    const name     = $('cpName').value.trim();
    const id       = $('cpId').value.trim();
    const clientId = $('cpClient').value;
    if (!name) { toast?.('e', 'Project Name is required'); return; }
    if (!id)   { toast?.('e', 'Project ID is required');   return; }

    payload.projectId      = id;
    payload.projectName    = name;
    payload.clientId       = clientId;
    payload.plannedViews   = parseFloat($('cpPlanned').value) || 0;
    payload.status         = $('cpStatus').value;
    payload.startDate      = $('cpStartDate').value;
    payload.endDate        = $('cpEndDate').value;
    payload.teamLeaderNotes = $('cpTlNotes').value.trim();
  } else {
    // Team Leader editing an EXISTING project — Views Completed,
    // their own Notes, and now Start/End Date. Everything else
    // (Name/ID/Client/Constant/Value/Planned/Status) stays
    // Manager-only.
    payload.originalProjectId = originalProject.projectId;
    payload.completedViews    = parseFloat($('cpCompleted').value) || 0;
    payload.startDate         = $('cpStartDate').value;
    payload.endDate           = $('cpEndDate').value;
    payload.teamLeaderNotes   = $('cpTlNotes').value.trim();
  }

  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await sheetGET({ action: 'saveProjectMaster', data: encodeURIComponent(JSON.stringify(payload)) });
    toast?.('s', isNew ? 'Project created' : 'Project updated', payload.projectName || originalProject.projectName || originalProject.projectId);
    await loadProjectData();
    if (typeof onDone === 'function') onDone(); else renderProjectList(content);
  } catch(err) {
    btn.disabled = false; btn.textContent = isNew ? 'Create Project' : 'Save Changes';
    toast?.('e', 'Save failed', err.message);
  }
}

async function deleteProjectFromForm(content, project, onDone) {
  if (CP_ROLE !== 'manager') return;
  if (!confirm(`Delete project "${project.projectName || project.projectId}"? This cannot be undone.`)) return;
  try {
    await sheetGET({ action: 'deleteProjectMaster', data: encodeURIComponent(JSON.stringify({ role: CP_ROLE, projectId: project.projectId })) });
    toast?.('s', 'Project deleted', project.projectName || project.projectId);
    await loadProjectData();
    if (typeof onDone === 'function') onDone(); else renderProjectList(content);
  } catch(err) {
    toast?.('e', 'Delete failed', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// TEAM & HOURS — who worked on this project and how much, broken
// down by month, so a Manager or Team Leader can fine-tune planning
// month to month. Visible to BOTH roles (unlike Cost/Profit below)
// since headcount and hours aren't financial data. Purely a read-out
// of existing Timesheet data — this module never edits hours itself;
// employees keep logging time in the existing Timesheet as before.
// ══════════════════════════════════════════════════════════════
function getProjectTeamActivity(project) {
  const entries = CP_TIMESHEET_DATA.filter(e => e.project === project.projectName && e.status !== 'Leave');
  const byMonth = {}; // { 'YYYY-MM': { empId: hoursSum } }
  entries.forEach(e => {
    const month = (e.date || '').slice(0, 7);
    if (!month) return;
    if (!byMonth[month]) byMonth[month] = {};
    byMonth[month][e.empId] = (byMonth[month][e.empId] || 0) + parseH(e.hours);
  });

  const months = Object.keys(byMonth).sort();
  const allMembers = new Set();
  let totalHours = 0;

  const monthBreakdown = months.map(month => {
    let monthHours = 0;
    const members = Object.entries(byMonth[month])
      .map(([empId, hours]) => {
        monthHours += hours;
        allMembers.add(empId);
        const emp = CP_EMPLOYEES.find(e => e.id === empId);
        return { empId, name: emp ? emp.name : empId, hours };
      })
      .sort((a, b) => b.hours - a.hours);
    totalHours += monthHours;
    return { month, members, monthHours };
  });

  return { months: monthBreakdown, totalMembers: allMembers.size, totalHours };
}

// All-time total hours per employee on this project (not broken down
// by month — that's what the Team & Hours section on the detail page
// is for). This feeds the compact segmented bar shown directly on
// each project card.
function getProjectEmployeeTotals(project) {
  const entries = CP_TIMESHEET_DATA.filter(e => e.project === project.projectName && e.status !== 'Leave');
  const totals = {};
  entries.forEach(e => {
    totals[e.empId] = (totals[e.empId] || 0) + parseH(e.hours);
  });
  return Object.entries(totals)
    .map(([empId, hours]) => {
      const emp = CP_EMPLOYEES.find(x => x.id === empId);
      return { empId, name: emp ? emp.name : empId, hours };
    })
    .filter(t => t.hours > 0)
    .sort((a, b) => b.hours - a.hours);
}

// Hours → "Xh Ym" for the slider legend/tooltips.
function fmtHM(hours) {
  const totalMins = Math.round((hours || 0) * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// A stacked segmented bar — one colored segment per employee, width
// proportional to their share of total hours logged on this project.
// Hovering a segment shows a native tooltip with that employee's name
// and exact hours/minutes worked; a legend underneath makes the same
// numbers visible without needing to hover at all.
function buildProjectHoursBar(project) {
  const totals = getProjectEmployeeTotals(project);
  if (!totals.length) {
    return `<div style="font-size:11px;color:var(--txt2);padding:2px 2px 0;">No hours logged yet</div>`;
  }

  const totalHours = totals.reduce((s, t) => s + t.hours, 0) || 1;
  const segments = totals.map(t => {
    const pct = Math.max((t.hours / totalHours) * 100, 1.5);
    return `<div style="flex:0 0 ${pct}%;background:${getEmployeeColor(t.empId)};height:100%;"
      title="${esc(t.name)}: ${fmtHM(t.hours)}"></div>`;
  }).join('');

  const legend = totals.map(t => `
    <div style="display:flex;align-items:center;gap:5px;">
      <span style="width:7px;height:7px;border-radius:50%;background:${getEmployeeColor(t.empId)};flex-shrink:0;"></span>
      <span style="font-size:10.5px;color:var(--txt1);font-weight:600;max-width:90px;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;" title="${esc(t.name)}">${esc(t.name)}</span>
      <span style="font-size:10.5px;color:var(--txt2);">${fmtHM(t.hours)}</span>
    </div>`).join('');

  return `
    <div style="display:flex;border-radius:6px;overflow:hidden;height:14px;margin-bottom:8px;">${segments}</div>
    <div style="display:flex;flex-wrap:wrap;gap:7px 12px;">${legend}</div>`;
}

// ══════════════════════════════════════════════════════════════
// PROJECT TIMELINE — month-by-month activity from when the project
// actually started through the current month, including idle months
// with zero hours (so gaps in activity are visible, not hidden).
// Shown in TWO places: a compact sparkline on every project card
// (main Project tab AND Client Detail's scoped grid, since both
// reuse buildProjectCard), and a fuller strip on the Project Detail
// page. Visible to both roles — like Team & Hours, this is activity
// data, not financial data, so it isn't gated behind isManager.
// ══════════════════════════════════════════════════════════════

// Created Date -> 'YYYY-MM', using the same exact-format parser the
// rest of this file already relies on (parseAppTimestamp).
function monthFromAppTimestamp(str) {
  const ts = parseAppTimestamp(str);
  if (!ts) return null;
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// 'YYYY-MM' -> the following month, as 'YYYY-MM'.
function addOneMonthStr(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m, 1); // JS Date month is 0-based, so passing the 1-based `m` directly lands on the next month
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function fmtMonthShort(monthKey) {
  return new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

// Builds the full month range for a project — from its true starting
// point through the current month — with hours (and contributor
// count) for every month, including zeros for idle months.
//
// "Starting point" = the EARLIER of (a) the first month any hours
// were actually logged against it, and (b) its Created Date month —
// covering both the common case (work started when the project was
// created) and the edge case (a legacy project whose Created Date
// column was backfilled after work had already begun, or vice versa).
function getProjectMonthlyTimeline(project) {
  const entries = CP_TIMESHEET_DATA.filter(e => e.project === project.projectName && e.status !== 'Leave');

  let earliestMonth = null;
  entries.forEach(e => {
    const m = (e.date || '').slice(0, 7);
    if (m && (!earliestMonth || m < earliestMonth)) earliestMonth = m;
  });
  const createdMonth = monthFromAppTimestamp(project.createdDate);
  if (createdMonth && (!earliestMonth || createdMonth < earliestMonth)) earliestMonth = createdMonth;

  if (!earliestMonth) return { months: [], maxHours: 0 }; // no activity and no known creation date

  const nowMonth = todayStr().slice(0, 7);
  const byMonth = {}; // { 'YYYY-MM': { hours, members:Set } }
  entries.forEach(e => {
    const m = (e.date || '').slice(0, 7);
    if (!m) return;
    if (!byMonth[m]) byMonth[m] = { hours: 0, members: new Set() };
    byMonth[m].hours += parseH(e.hours);
    byMonth[m].members.add(e.empId);
  });

  const months = [];
  let cursor = earliestMonth;
  let guard = 0; // safety cap (20 years) against a corrupted date producing a runaway loop
  while (cursor <= nowMonth && guard < 240) {
    const bucket = byMonth[cursor];
    months.push({ month: cursor, hours: bucket ? bucket.hours : 0, memberCount: bucket ? bucket.members.size : 0 });
    cursor = addOneMonthStr(cursor);
    guard++;
  }

  const maxHours = Math.max(...months.map(m => m.hours), 0.01);
  return { months, maxHours };
}

// Compact sparkline for the project card — one thin bar per month,
// height proportional to that month's hours, idle months shown as
// bare stubs. Hover any bar for the exact month + hours/minutes.
function buildProjectTimelineMini(project) {
  const { months, maxHours } = getProjectMonthlyTimeline(project);
  if (!months.length) {
    return `<div style="font-size:11px;color:var(--txt2);padding:2px 2px 0;">No activity yet</div>`;
  }

  const bars = months.map(m => {
    const pct = m.hours > 0 ? Math.max((m.hours / maxHours) * 100, 10) : 6;
    return `
      <div style="flex:0 0 9px;display:flex;flex-direction:column;justify-content:flex-end;height:32px;"
        title="${esc(fmtMonthShort(m.month))}: ${fmtHM(m.hours)}">
        <div style="width:100%;height:${pct}%;border-radius:2px;
          background:${m.hours > 0 ? 'var(--a1)' : 'var(--border-md)'};"></div>
      </div>`;
  }).join('');

  return `<div style="display:flex;align-items:flex-end;gap:3px;overflow-x:auto;padding-bottom:2px;">${bars}</div>`;
}

// Fuller version for the Project Detail page — labeled month columns
// with a bar and the exact hours underneath, horizontally scrollable
// for projects with a long history. The current month is outlined so
// "where we are now" is obvious at a glance.
function renderProjectTimelineSection(project) {
  const el = $('cpTimelineSection');
  if (!el) return;

  const { months, maxHours } = getProjectMonthlyTimeline(project);
  if (!months.length) {
    el.innerHTML = `
      <div class="cp-card">
        <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.5rem;">📅 Project Timeline</div>
        <div style="font-size:12.5px;color:var(--txt2);">No activity logged yet, and no creation date on record to start a timeline from.</div>
      </div>`;
    return;
  }

  const nowMonth      = todayStr().slice(0, 7);
  const startLabel    = fmtCPMonthLabel(months[0].month);
  const totalHours    = months.reduce((s, m) => s + m.hours, 0);
  const activeMonths  = months.filter(m => m.hours > 0).length;

  // Horizontal bar per month (label left, bar middle, duration
  // right) — same visual language as the Attendance & Activity list
  // on the Employee Detail page, instead of the old vertical candles.
  const rows = months.map((m, i) => {
    const pct    = m.hours > 0 ? Math.max((m.hours / maxHours) * 100, 2) : 0;
    const isNow  = m.month === nowMonth;
    const isLast = i === months.length - 1;
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:8px 0;${isLast ? '' : 'border-bottom:1px solid var(--border);'}"
        title="${esc(fmtCPMonthLabel(m.month))}: ${fmtHM(m.hours)}${m.memberCount ? ' · ' + m.memberCount + ' member' + (m.memberCount !== 1 ? 's' : '') : ''}">
        <span style="flex:0 0 84px;font-size:12px;font-weight:700;color:${isNow ? 'var(--a1)' : 'var(--txt1)'};white-space:nowrap;">${esc(fmtMonthShort(m.month))}${isNow ? ' •' : ''}</span>
        <div style="flex:1;min-width:0;height:12px;background:var(--surface2);border-radius:6px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:var(--a1);border-radius:6px;"></div>
        </div>
        <span style="flex:0 0 68px;text-align:right;font-size:12px;font-weight:${m.hours > 0 ? '700' : '400'};color:${m.hours > 0 ? 'var(--txt1)' : 'var(--txt2)'};">${m.hours > 0 ? fmtHM(m.hours) : '—'}</span>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="cp-card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:6px;">
        <div style="font-weight:700;font-size:14px;color:var(--txt1);">📅 Project Timeline</div>
        <div style="font-size:11.5px;color:var(--txt2);">Since ${esc(startLabel)} · ${activeMonths}/${months.length} active month${months.length !== 1 ? 's' : ''} · ${fmtHM(totalHours)} total</div>
      </div>
      <div>${rows}</div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// TEAM PERFORMANCE — day-by-day activity log (was "Team & Hours").
// For each day this project had any activity: how many people
// worked, a segmented bar showing their relative hours that day (one
// color per employee, reusing getEmployeeColor so a person's color
// stays consistent everywhere), and each person's own hours + notes
// for that specific day underneath. Paginated 10 days per page, most
// recent first — getProjectTeamActivity (month-based) is still used
// elsewhere in this file (Client cards, the public API hook), so
// it's untouched; this is a separate, purpose-built aggregation.
// ══════════════════════════════════════════════════════════════
const CP_TEAM_PAGE_SIZE = 10;
let CP_TEAM_DAILY_DATES  = [];
let CP_TEAM_DAILY_BYDATE = {};
let CP_TEAM_PAGE         = 0;

// Groups this project's entries by date, then by employee within
// each date (one person can have multiple entries the same day
// across different slots — those are summed, and their notes joined
// together for that day).
function getProjectDailyActivity(project) {
  const byDate = {};
  CP_TIMESHEET_DATA.forEach(e => {
    if (e.project !== project.projectName || e.status === 'Leave' || !e.date) return;
    if (!byDate[e.date]) byDate[e.date] = {};
    if (!byDate[e.date][e.empId]) byDate[e.date][e.empId] = { hours: 0, notes: [] };
    byDate[e.date][e.empId].hours += parseH(e.hours);
    if (e.notes && e.notes.trim()) byDate[e.date][e.empId].notes.push(e.notes.trim());
  });

  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a)); // most recent first
  return { byDate, dates };
}

// ══════════════════════════════════════════════════════════════
// PROJECT REPORT — a properly formatted, printable report: a
// contribution pie chart, an hours-by-person bar chart, a detailed
// day-by-day log with everyone's notes, and an auto-written summary.
// Two modes:
//   'month'   — the current calendar month only
//   'overall' — from the project's Start Date (or its earliest
//               logged activity, whichever is earlier) through today
//
// No PDF library is used — this builds a clean, print-optimized HTML
// document in a new tab and triggers the browser's own Print dialog,
// where "Save as PDF" is a standard destination on every major
// browser. Keeps this dependency-free, consistent with the rest of
// the app.
// ══════════════════════════════════════════════════════════════
const CP_REPORT_PALETTE = ['#2563eb','#7c3aed','#059669','#d97706','#dc2626','#0891b2','#db2777','#65a30d'];

// Hours + notes contributed by each team member within [fromDate,
// toDate] (inclusive, 'YYYY-MM-DD' strings — safe to compare
// lexicographically). Independent of getProjectDailyActivity/
// getProjectMonthlyTimeline (which always cover ALL history) since
// a report needs an arbitrary bounded window.
function getProjectContribution(project, fromDate, toDate) {
  const entries = CP_TIMESHEET_DATA.filter(e =>
    e.project === project.projectName && e.status !== 'Leave' &&
    e.date && e.date >= fromDate && e.date <= toDate
  );

  const byEmp   = {};
  const allDays = new Set();
  entries.forEach(e => {
    allDays.add(e.date);
    if (!byEmp[e.empId]) byEmp[e.empId] = { hours: 0, days: new Set(), notes: [] };
    byEmp[e.empId].hours += parseH(e.hours);
    byEmp[e.empId].days.add(e.date);
    if (e.notes && e.notes.trim()) byEmp[e.empId].notes.push({ date: e.date, note: e.notes.trim(), hours: parseH(e.hours) });
  });

  const members = Object.entries(byEmp)
    .map(([empId, d]) => {
      const emp = CP_EMPLOYEES.find(x => x.id === empId);
      return { empId, name: emp ? emp.name : empId, hours: d.hours, days: d.days.size, notes: d.notes };
    })
    .sort((a, b) => b.hours - a.hours);

  return { members, totalHours: members.reduce((s, m) => s + m.hours, 0), totalDays: allDays.size, fromDate, toDate };
}

function buildReportDonutPath(cx, cy, rOuter, rInner, startDeg, endDeg) {
  if (endDeg - startDeg >= 359.999) endDeg = startDeg + 359.999;
  const pt = (r, deg) => { const rad = deg * Math.PI / 180; return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }; };
  const sO = pt(rOuter, startDeg), eO = pt(rOuter, endDeg), sI = pt(rInner, endDeg), eI = pt(rInner, startDeg);
  const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
  return [`M ${sO.x} ${sO.y}`, `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${eO.x} ${eO.y}`, `L ${sI.x} ${sI.y}`, `A ${rInner} ${rInner} 0 ${largeArc} 0 ${eI.x} ${eI.y}`, 'Z'].join(' ');
}

function buildReportPieSVG(members, totalHours) {
  if (!totalHours || !members.length) {
    return `<svg viewBox="0 0 200 200" width="180" height="180"><circle cx="100" cy="100" r="80" fill="none" stroke="#e2e8f0" stroke-width="26"/></svg>`;
  }
  let angle = -90;
  const slices = members.map((m, i) => {
    const end = angle + (m.hours / totalHours) * 360;
    const path = buildReportDonutPath(100, 100, 80, 46, angle, end);
    const color = CP_REPORT_PALETTE[i % CP_REPORT_PALETTE.length];
    angle = end;
    return `<path d="${path}" fill="${color}"/>`;
  }).join('');
  return `<svg viewBox="0 0 200 200" width="180" height="180" xmlns="http://www.w3.org/2000/svg">${slices}</svg>`;
}

function buildReportLegendHTML(members, totalHours) {
  if (!members.length) return `<div style="font-size:12px;color:#64748b;">No contributions recorded for this period.</div>`;
  return members.map((m, i) => {
    const pct = totalHours > 0 ? Math.round((m.hours / totalHours) * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:7px;margin-bottom:6px;font-size:12.5px;">
      <span style="width:10px;height:10px;border-radius:50%;background:${CP_REPORT_PALETTE[i % CP_REPORT_PALETTE.length]};flex-shrink:0;"></span>
      <span style="color:#1e293b;">${esc(m.name)} — <b>${fmtHM(m.hours)}</b> (${pct}%)</span>
    </div>`;
  }).join('');
}

function buildReportLogTableHTML(members) {
  const rows = [];
  members.forEach(m => m.notes.forEach(n => rows.push({ ...n, name: m.name })));
  rows.sort((a, b) => a.date.localeCompare(b.date));

  if (!rows.length) return `<div style="font-size:12px;color:#64748b;">No notes recorded for this period.</div>`;

  return `
    <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
      <thead>
        <tr style="background:#eef2ff;">
          <th style="text-align:left;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Date</th>
          <th style="text-align:left;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Employee</th>
          <th style="text-align:right;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Hours</th>
          <th style="text-align:left;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Notes</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td style="padding:6px 9px;border:1px solid #e2e8f0;white-space:nowrap;">${esc(fmtCPDateShort(r.date))}</td>
            <td style="padding:6px 9px;border:1px solid #e2e8f0;white-space:nowrap;">${esc(r.name)}</td>
            <td style="padding:6px 9px;border:1px solid #e2e8f0;text-align:right;white-space:nowrap;">${fmtHM(r.hours)}</td>
            <td style="padding:6px 9px;border:1px solid #e2e8f0;">${esc(r.note)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// Joins a list of strings into natural English: "A", "A and B", or
// "A, B, and C" — used to fold everyone's contribution into one
// readable sentence instead of a chart.
function joinNaturalList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// Builds a ~150-200 word narrative paragraph directly from the real
// notes people wrote, grouped by employee. This is an EXTRACTIVE
// combination of actual note text — not AI-generated analysis. True
// language-model summarization would need a call to an external AI
// API, which isn't part of this app's architecture (no key, no
// backend support for it, and it would be a real external dependency
// the rest of this app has deliberately avoided). This instead
// stitches together what was actually written, so nothing in the
// report is invented or paraphrased beyond what the team recorded.
function buildWorkNarrativeText(contrib) {
  const byEmp = contrib.members
    .map(m => ({ name: m.name, notes: [...new Set(m.notes.map(n => n.note.trim()).filter(Boolean))] }))
    .filter(m => m.notes.length > 0);

  if (!byEmp.length) return '';

  const countWords = s => s.split(/\s+/).filter(Boolean).length;
  const render = cap => byEmp.map(m => {
    const notes = cap ? m.notes.slice(0, cap) : m.notes;
    return `${m.name} worked on ${joinNaturalList(notes)}.`;
  }).join(' ');

  // Start with everyone's full notes, then progressively cap how
  // many distinct notes each person contributes until the paragraph
  // fits the target range — keeps this close to 150-200 words
  // regardless of how many people/notes are in the period.
  let text = render(null);
  for (let cap = 3; cap >= 1 && countWords(text) > 200; cap--) {
    text = render(cap);
  }

  // Hard safety net: if it's still long even at one note per person
  // (e.g. many contributors with long notes), cut cleanly at ~200
  // words rather than letting it run on indefinitely.
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 210) text = words.slice(0, 200).join(' ') + '…';

  return text;
}

function buildReportSummaryText(project, contrib) {
  if (!contrib.members.length) {
    return `No activity was logged against ${project.projectName || project.projectId} during this period.`;
  }

  const total = contrib.totalHours || 1;
  const shares = contrib.members.map(m => `${m.name} (${fmtHM(m.hours)}, ${Math.round((m.hours / total) * 100)}%)`);

  const breakdown = contrib.members.length === 1
    ? `${shares[0]} was the sole contributor.`
    : `Contribution breakdown, from highest to lowest: ${joinNaturalList(shares)}.`;

  return `This report covers ${contrib.members.length} team member${contrib.members.length !== 1 ? 's' : ''} who together logged ${fmtHM(contrib.totalHours)} across ${contrib.totalDays} day${contrib.totalDays !== 1 ? 's' : ''}. ${breakdown}`;
}

function buildProjectReportHTML(project, mode) {
  const client = CP_CLIENTS.find(c => c.id === project.clientId);
  const today  = todayStr();

  let fromDate, toDate, periodLabel, reportTypeLabel;
  if (mode === 'month') {
    const m = today.slice(0, 7);
    fromDate = m + '-01';
    toDate   = today;
    periodLabel = fmtCPMonthLabel(m);
    reportTypeLabel = 'Monthly Report';
  } else {
    const entries  = CP_TIMESHEET_DATA.filter(e => e.project === project.projectName && e.status !== 'Leave' && e.date);
    let earliest   = entries.reduce((min, e) => (!min || e.date < min) ? e.date : min, null);
    if (project.startDate && (!earliest || project.startDate < earliest)) earliest = project.startDate;
    fromDate = earliest || today;
    toDate   = today;
    periodLabel = `${fmtCPDateShort(fromDate)} – ${fmtCPDateShort(toDate)}`;
    reportTypeLabel = 'Overall Report';
  }

  const contrib   = getProjectContribution(project, fromDate, toDate);
  const genStamp  = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const workNarrative = buildWorkNarrativeText(contrib);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>${esc(project.projectName || project.projectId)} — ${esc(reportTypeLabel)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin:0; padding:28px; background:#eef2ff; color:#1e293b; }
  .sheet { max-width:820px; margin:0 auto; background:#fff; border-radius:16px; padding:36px 42px 44px; box-shadow:0 4px 24px rgba(0,0,0,.06); }
  h1 { font-size:25px; color:#2563eb; margin:0 0 4px; font-weight:800; }
  .sub { font-size:12px; color:#64748b; margin-bottom:20px; }
  .infobar { display:flex; gap:28px; flex-wrap:wrap; padding:14px 0; border-top:1px solid #e2e8f0; border-bottom:1px solid #e2e8f0; margin-bottom:26px; }
  .infobar div { font-size:12.5px; }
  .infobar b { display:block; color:#2563eb; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px; font-weight:700; }
  h2 { font-size:14px; color:#2563eb; margin:26px 0 12px; font-weight:800; }
  .row { display:flex; gap:36px; align-items:center; flex-wrap:wrap; }
  .footer { margin-top:30px; font-size:10.5px; color:#94a3b8; text-align:right; }
  @media print {
    body { background:#fff; padding:0; }
    .sheet { box-shadow:none; border-radius:0; max-width:100%; padding:0; }
  }
</style>
</head>
<body>
  <div class="sheet">
    <h1>${esc(project.projectName || project.projectId)}</h1>
    <div class="sub">${esc(reportTypeLabel)} · ${esc(project.projectId)} · ${esc(client ? client.name : (project.clientId || '—'))}</div>

    <div class="infobar">
      <div><b>Report Type</b>${esc(reportTypeLabel)}</div>
      <div><b>Period</b>${esc(periodLabel)}</div>
      <div><b>Start Date</b>${esc(fmtCPDateShort(project.startDate))}</div>
      <div><b>End Date</b>${esc(fmtCPDateShort(project.endDate))}</div>
      <div><b>Status</b>${esc(project.status)}</div>
    </div>

    <h2>Contribution by Team Member</h2>
    <div class="row">
      <div>${buildReportPieSVG(contrib.members, contrib.totalHours)}</div>
      <div>${buildReportLegendHTML(contrib.members, contrib.totalHours)}</div>
    </div>

    <h2>Detailed Log</h2>
    ${buildReportLogTableHTML(contrib.members)}

    <h2>Summary</h2>
    <div style="font-size:12.5px;color:#334155;line-height:1.6;">
      <p style="margin:0 0 10px;">${esc(buildReportSummaryText(project, contrib))}</p>
      ${workNarrative ? `<p style="margin:0;">${esc(workNarrative)}</p>` : ''}
    </div>

    <div class="footer">Generated ${esc(genStamp)}</div>
  </div>
</body>
</html>`;
}

// Opens the report in a new tab and triggers the browser's own Print
// dialog — "Save as PDF" is a built-in destination on every major
// browser, so this is a real "Download PDF" without needing a PDF
// library. The short delay before print() gives the new tab time to
// actually render the content first.
function openProjectReport(project, mode) {
  const win = window.open('', '_blank');
  if (!win) {
    toast?.('e', 'Popup blocked', 'Please allow popups for this site, then try again.');
    return;
  }
  win.document.open();
  win.document.write(buildProjectReportHTML(project, mode));
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 400);
}

function renderProjectTeamSection(project) {
  const el = $('cpTeamSection');
  if (!el) return;

  const { byDate, dates } = getProjectDailyActivity(project);
  CP_TEAM_DAILY_BYDATE = byDate;
  CP_TEAM_DAILY_DATES  = dates;
  CP_TEAM_PAGE = 0;

  if (!dates.length) {
    el.innerHTML = `
      <div class="cp-card">
        <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.5rem;">👥 Team Performance</div>
        <div style="font-size:12.5px;color:var(--txt2);">No timesheet hours logged against this project yet.</div>
      </div>`;
    return;
  }

  const totalMembers = new Set(dates.flatMap(d => Object.keys(byDate[d]))).size;
  const totalHours   = dates.reduce((s, d) => s + Object.values(byDate[d]).reduce((s2, m) => s2 + m.hours, 0), 0);

  el.innerHTML = `
    <div class="cp-card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:6px;">
        <div style="font-weight:700;font-size:14px;color:var(--txt1);">👥 Team Performance</div>
        <div style="font-size:11.5px;color:var(--txt2);">${totalMembers} member${totalMembers !== 1 ? 's' : ''} · ${totalHours.toFixed(1)}h total, all time</div>
      </div>
      <div id="cpTeamDailyList"></div>
      <div id="cpTeamPager" style="margin-top:1rem;"></div>
    </div>`;

  renderCPTeamDailyPage();
}

function renderCPTeamDailyPage() {
  const listEl  = $('cpTeamDailyList');
  const pagerEl = $('cpTeamPager');
  if (!listEl) return;

  const start     = CP_TEAM_PAGE * CP_TEAM_PAGE_SIZE;
  const pageDates = CP_TEAM_DAILY_DATES.slice(start, start + CP_TEAM_PAGE_SIZE);

  listEl.innerHTML = pageDates.map((date, i) =>
    buildTeamDailyRow(date, CP_TEAM_DAILY_BYDATE[date], i === pageDates.length - 1)
  ).join('');

  const totalPages = Math.max(1, Math.ceil(CP_TEAM_DAILY_DATES.length / CP_TEAM_PAGE_SIZE));
  if (!pagerEl) return;

  if (totalPages <= 1) { pagerEl.innerHTML = ''; return; }

  const pageNums = [];
  for (let p = 0; p < totalPages; p++) pageNums.push(p);

  pagerEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;">
      <button class="cp-pager-btn" id="cpTeamPagePrev" ${CP_TEAM_PAGE === 0 ? 'disabled' : ''}>‹ Prev</button>
      ${pageNums.map(p => `<button class="cp-pager-btn cp-pager-num${p === CP_TEAM_PAGE ? ' active' : ''}" data-page="${p}">${p + 1}</button>`).join('')}
      <button class="cp-pager-btn" id="cpTeamPageNext" ${CP_TEAM_PAGE === totalPages - 1 ? 'disabled' : ''}>Next ›</button>
    </div>`;

  $('cpTeamPagePrev')?.addEventListener('click', () => { if (CP_TEAM_PAGE > 0) { CP_TEAM_PAGE--; renderCPTeamDailyPage(); } });
  $('cpTeamPageNext')?.addEventListener('click', () => { if (CP_TEAM_PAGE < totalPages - 1) { CP_TEAM_PAGE++; renderCPTeamDailyPage(); } });
  pagerEl.querySelectorAll('.cp-pager-num').forEach(btn => {
    btn.addEventListener('click', () => { CP_TEAM_PAGE = parseInt(btn.dataset.page, 10); renderCPTeamDailyPage(); });
  });
}

// One day's row: date header + member count/total, a segmented bar
// (one colored slice per employee, sized by their share of that
// day's hours), then each employee's own hours and notes for that
// specific day listed underneath.
function buildTeamDailyRow(date, dayData, isLast) {
  const members = Object.entries(dayData)
    .map(([empId, d]) => {
      const emp = CP_EMPLOYEES.find(x => x.id === empId);
      return { empId, name: emp ? emp.name : empId, hours: d.hours, notes: d.notes.join(' · ') };
    })
    .sort((a, b) => b.hours - a.hours);

  const dayTotal = members.reduce((s, m) => s + m.hours, 0);
  const safeTotal = dayTotal || 0.01;

  const segments = members.map(m => {
    const pct = Math.max((m.hours / safeTotal) * 100, 3);
    return `<div style="width:${pct}%;height:100%;background:${getEmployeeColor(m.empId)};"
      title="${esc(m.name)}: ${fmtHM(m.hours)}"></div>`;
  }).join('');

  const memberRows = members.map(m => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
      <span style="width:8px;height:8px;border-radius:50%;background:${getEmployeeColor(m.empId)};flex-shrink:0;margin-top:4px;"></span>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span style="font-size:12px;font-weight:700;color:var(--txt1);">${esc(m.name)}</span>
          <span style="font-size:12px;font-weight:700;color:var(--a1);white-space:nowrap;">${fmtHM(m.hours)}</span>
        </div>
        <div style="font-size:11px;color:var(--txt2);margin-top:2px;">${esc(m.notes || 'No notes')}</div>
      </div>
    </div>`).join('');

  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  return `
    <div style="margin-bottom:${isLast ? '0' : '1.1rem'};padding-bottom:${isLast ? '0' : '1.1rem'};${isLast ? '' : 'border-bottom:1px solid var(--border-md);'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px;">
        <span style="font-size:13px;font-weight:700;color:var(--txt1);">${esc(dateLabel)}</span>
        <span style="font-size:11.5px;color:var(--txt2);">${members.length} member${members.length !== 1 ? 's' : ''} · ${fmtHM(dayTotal)}</span>
      </div>
      <div style="display:flex;border-radius:6px;overflow:hidden;height:14px;margin-bottom:4px;">${segments}</div>
      <div>${memberRows}</div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// COST / PROFIT CALCULATION — Manager view only (needs Project
// Constant/Value, which Team Leaders never see). Fully automatic:
//   For every month the project has logged hours →
//     for every employee who logged hours that month →
//       Employee Cost = Hours Worked × that employee's Points for
//       that specific month (via salary.js's getEffectiveSalary,
//       carry-forward aware)
//   Monthly Total = sum of Employee Cost across employees
//   Total Employee Cost = sum of Monthly Totals across every month
//   Profit = Project Constant − Total Employee Cost (negative = Loss)
// ══════════════════════════════════════════════════════════════
async function renderProjectCostSection(project) {
  const el = $('cpCostSection');
  if (!el) return;
  el.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Calculating project cost…</span></div>`;

  await ensureSalaryDataLoaded();

  const result = calculateProjectCost(project);
  if (!result) {
    el.innerHTML = `<div class="chart-empty">Timesheet or Salary data isn't available yet — cost can't be calculated.</div>`;
    return;
  }

  const isProfit = result.profit >= 0;
  el.innerHTML = `
    <div class="cp-card">
      <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.9rem;">💰 Project Cost &amp; Profit</div>

      ${result.months.length === 0
        ? `<div style="font-size:12.5px;color:var(--txt2);">No timesheet hours logged against this project yet.</div>`
        : `
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:1rem;">
          ${result.months.map(m => `
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;
              padding:6px 0;border-bottom:1px solid var(--border);">
              <span style="color:var(--txt2);">${esc(fmtCPMonthLabel(m.month))}</span>
              <span style="color:var(--txt2);">${m.hours.toFixed(1)}h</span>
              <span style="color:var(--txt1);font-weight:700;">${fmtCPRupees(m.cost)}</span>
            </div>`).join('')}
        </div>`}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;">
          <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;">Total Employee Cost</div>
          <div style="font-size:16px;font-weight:800;color:var(--txt1);">${fmtCPRupees(result.totalCost)}</div>
        </div>
        <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;">
          <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;">Project Constant</div>
          <div style="font-size:16px;font-weight:800;color:var(--txt1);">${fmtCPRupees(result.projectBudget)}</div>
        </div>
      </div>

      <div style="margin-top:8px;background:${isProfit ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)'};
        border:1px solid ${isProfit ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'};
        border-radius:10px;padding:10px 12px;text-align:center;">
        <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;">${isProfit ? '📈 Profit' : '📉 Loss'}</div>
        <div style="font-size:18px;font-weight:800;color:${isProfit ? '#34d399' : '#f87171'};">
          ${isProfit ? '+' : '-'}${fmtCPRupees(Math.abs(result.profit))}</div>
      </div>
    </div>`;
}

// Reuses salary.js's own fetch instead of duplicating it — if the
// Manager opens Project before ever visiting the Salary tab,
// SAL_RECORDS would otherwise be empty and every Points lookup would
// silently return 0.
async function ensureSalaryDataLoaded() {
  if (typeof SAL_RECORDS === 'undefined') return; // salary.js not loaded — cost calc will just show 0s
  if (SAL_RECORDS.length > 0) return;
  if (typeof loadSalaryData === 'function') {
    try { await loadSalaryData(); } catch(e) { /* leave SAL_RECORDS empty, calc below handles it gracefully */ }
  }
}

function calculateProjectCost(project) {
  const projectEntries = CP_TIMESHEET_DATA.filter(e => e.project === project.projectName && e.status !== 'Leave');

  const byMonth = {}; // { 'YYYY-MM': { empId: hoursSum } }
  projectEntries.forEach(e => {
    const month = (e.date || '').slice(0, 7);
    if (!month) return;
    if (!byMonth[month]) byMonth[month] = {};
    byMonth[month][e.empId] = (byMonth[month][e.empId] || 0) + parseH(e.hours);
  });

  const months = Object.keys(byMonth).sort();
  let totalCost = 0;
  const monthBreakdown = months.map(month => {
    let monthCost = 0;
    let monthHours = 0;
    Object.entries(byMonth[month]).forEach(([empId, hours]) => {
      monthHours += hours;
      const points = getMonthlyPointsForEmployee(empId, month);
      monthCost += hours * points;
    });
    totalCost += monthCost;
    return { month, hours: monthHours, cost: monthCost };
  });

  // Project Constant is the project's allocated budget/value — this
  // is what Profit is measured against (per the original spec's
  // example: 8500 − 7748.5 = 751.5 Profit). Project Value is a
  // separate field kept for reference but not used in this formula.
  const totalHours   = monthBreakdown.reduce((s, m) => s + m.hours, 0);
  const projectBudget = parseFloat(project.projectConstant) || 0;
  return { months: monthBreakdown, totalCost, totalHours, projectBudget, profit: projectBudget - totalCost };
}

// Looks up an employee's Points for one specific month via salary.js's
// own carry-forward logic — the exact same number the Salary tab
// itself would show for that employee that month.
function getMonthlyPointsForEmployee(empId, month) {
  if (typeof getEffectiveSalary !== 'function') return 0;
  const eff = getEffectiveSalary(empId, month);
  return eff && eff.record ? (parseFloat(eff.record.points) || 0) : 0;
}

function fmtCPMonthLabel(monthKey) {
  return new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function fmtCPDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtCPRupees(n) {
  const v = parseFloat(n) || 0;
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 1 });
}

// Updates the "X/200" counter under a notes textarea as the person
// types. maxlength on the textarea itself already prevents typing
// past the cap — this is just the visible readout.
function updateCPNotesCount(textareaId, counterId) {
  const ta = document.getElementById(textareaId);
  const el = document.getElementById(counterId);
  if (!ta || !el) return;
  el.textContent = `${ta.value.length}/${CP_NOTES_MAX_LENGTH}`;
}

// ══════════════════════════════════════════════════════════════
// FUTURE-MODULE HOOK — read-only surface for later modules (profit
// dashboard, client revenue, resource allocation, invoicing, billing,
// payment tracking, AI reports) to plug into without needing to know
// this file's internals. No new math is added here — computeProjectCost
// just exposes the same calculateProjectCost() this file already uses.
// ══════════════════════════════════════════════════════════════
Object.assign(window.ClientProjectAPI, {
  getAllClients:      () => CP_CLIENTS.slice(),
  getAllProjects:      () => CP_PROJECTS.slice(),
  getProjectById:      (projectId) => CP_PROJECTS.find(p => p.projectId === projectId) || null,
  computeProjectCost:  (projectId) => {
    const project = CP_PROJECTS.find(p => p.projectId === projectId);
    return project ? calculateProjectCost(project) : null;
  },
  getProjectTeamActivity: (projectId) => {
    const project = CP_PROJECTS.find(p => p.projectId === projectId);
    return project ? getProjectTeamActivity(project) : null;
  },
  reloadClients: loadClientData,
  reloadProjects: loadProjectData,
});