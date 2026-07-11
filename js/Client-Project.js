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

const CP_STATUS_META = {
  'In Progress': { bg: 'rgba(79,142,247,0.12)',  fg: '#4f8ef7' },
  'Completed':   { bg: 'rgba(52,211,153,0.12)',  fg: '#34d399' },
  'On Hold':     { bg: 'rgba(251,191,36,0.12)',  fg: '#fbbf24' },
};

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
      padding:1.25rem;max-width:560px;margin-bottom:1.25rem;
    }
    .cp-form-field { display:flex;flex-direction:column;gap:2px;margin-bottom:.9rem; }
    .cp-form-grid {
      display:grid;grid-template-columns:1fr 1fr;gap:0 14px;
    }
    .cp-form-grid .cp-form-field.cp-span2 { grid-column:1 / -1; }
    .cp-hint { font-size:10.5px;color:var(--txt2);font-weight:400; }
    .cp-nav-btn {
      width:28px;height:28px;border-radius:50%;border:1px solid var(--border-md);
      background:var(--elevated);color:var(--txt1);font-size:12px;cursor:pointer;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;
    }
    .cp-nav-btn:disabled { opacity:.3;cursor:default; }
    .cp-bar-track { background:var(--surface2);border-radius:4px;height:6px;overflow:hidden; }
    .cp-bar-fill { height:100%;border-radius:4px;background:var(--a1); }

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
      display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
      gap:1.25rem;margin-top:.5rem;
    }

    .cp-entity-card {
      background:var(--surface1);border:1px solid var(--border);border-radius:14px;
      padding:1.1rem;display:flex;flex-direction:column;
    }
    .cp-entity-head { display:flex;align-items:center;gap:10px;margin-bottom:.9rem; }
    .cp-entity-avatar {
      width:38px;height:38px;border-radius:50%;flex-shrink:0;
      background:linear-gradient(135deg,var(--a1),#7c5cfc);
      display:flex;align-items:center;justify-content:center;
      font-weight:700;font-size:13px;color:#fff;
    }
    .cp-entity-titles { flex:1;min-width:0; }
    .cp-entity-name {
      font-weight:600;font-size:14px;color:var(--txt1);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .cp-entity-id {
      font-size:11px;color:var(--txt2);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }

    .cp-icon-btn {
      flex-shrink:0;background:none;border:none;color:var(--txt2);cursor:pointer;
      font-size:13px;padding:4px 6px;border-radius:6px;
    }
    .cp-icon-btn:hover { background:var(--surface2); }

    .cp-status-pill {
      display:inline-flex;align-items:center;gap:5px;border-radius:20px;
      padding:4px 10px;font-size:11px;font-weight:700;
    }
    .cp-status-dot { width:6px;height:6px;border-radius:50%;flex-shrink:0; }

    .cp-entity-metrics {
      display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:.9rem;
    }
    .cp-metric-box { background:var(--surface2);border-radius:10px;padding:8px 12px; }
    .cp-metric-label {
      font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;
    }
    .cp-metric-val { font-size:16px;font-weight:800;color:var(--txt1); }

    .cp-view-btn {
      align-self:flex-start;margin-top:auto;background:var(--a1);color:#fff;border:none;
      border-radius:6px;padding:6px 14px;font-size:11px;font-weight:600;cursor:pointer;
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
  CP_CLIENTS = await sheetGET({ action: 'getClientMasterList' });
  window.MGR_CLIENTS = CP_CLIENTS; // keep the compatibility shim fresh too
}

async function loadProjectData() {
  CP_PROJECTS = await sheetGET({ action: 'getProjectMasterList', role: CP_ROLE });
}

// ══════════════════════════════════════════════════════════════
// CLIENT — card grid + create (Client Name only; Client ID is
// auto-generated, read-only, shown as a live preview before saving).
// Clicking a card opens a Client Detail page (that client's own
// projects, scoped, as their own card grid).
// ══════════════════════════════════════════════════════════════
function renderClientCards(content) {
  const isManager = CP_ROLE === 'manager';
  const sorted = sortClientsByRecency(CP_CLIENTS);

  content.innerHTML = `
    <div class="cp-tab-header">
      <div>
        <div class="cp-tab-title">🏢 Clients</div>
        <div class="cp-tab-sub">${isManager ? 'Client ID is auto-generated and permanent once created.' : 'View each client\u2019s projects and progress.'}</div>
      </div>
      ${isManager ? `<button id="cpNewClientBtn" class="cp-btn-primary" style="padding:8px 16px;font-size:13px;border-radius:8px;">+ New Client</button>` : ''}
    </div>

    ${sorted.length === 0
      ? `<div class="chart-empty">No clients yet.${isManager ? ' Click “+ New Client” to add one.' : ''}</div>`
      : `<div class="cp-card-grid">${sorted.map(c => buildClientCard(c, isManager)).join('')}</div>`}
  `;

  $('cpNewClientBtn')?.addEventListener('click', () =>
    openClientEditor(content, null, () => renderClientCards(content)));

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

function buildClientCard(client, isManager) {
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

      <div class="cp-entity-metrics">
        <div class="cp-metric-box">
          <div class="cp-metric-label">Projects</div>
          <div class="cp-metric-val">${clientProjects.length}</div>
        </div>
        <div class="cp-metric-box">
          <div class="cp-metric-label">Total Hours</div>
          <div class="cp-metric-val">${totalHours.toFixed(1)}h</div>
        </div>
      </div>

      <button class="cp-view-btn cp-client-view-btn" data-id="${esc(client.id)}">View Projects →</button>
    </div>`;
}

// Create (no client passed) or rename (client passed) — Manager only,
// re-checked server-side too on delete.
function openClientEditor(content, client = null, onDone = null) {
  if (CP_ROLE !== 'manager') return;
  const isNew = !client;
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
        await sheetGET({ action: 'createClientMaster', data: encodeURIComponent(JSON.stringify({ name })) });
        toast?.('s', 'Client created', name);
      } else {
        await sheetGET({ action: 'updateClientMaster', data: encodeURIComponent(JSON.stringify({ id: client.id, name })) });
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
  const projects = sortProjectsByRecency(CP_PROJECTS.filter(p => p.clientId === client.id));

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
        ${isManager ? `<button id="cpClientAddProject" class="cp-btn-primary" style="padding:8px 16px;font-size:13px;border-radius:8px;">+ Add Project</button>` : ''}
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
  const sortedProjects = sortProjectsByRecency(CP_PROJECTS);

  content.innerHTML = `
    <div class="cp-tab-header">
      <div>
        <div class="cp-tab-title">📁 Projects</div>
        <div class="cp-tab-sub">Projects received from clients — status and view progress. Not a task board.</div>
      </div>
      ${isManager ? `<button id="cpNewProjectBtn" class="cp-btn-primary" style="padding:8px 16px;font-size:13px;border-radius:8px;">+ New Project</button>` : ''}
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

  return `
    <div class="cp-entity-card">
      <div class="cp-entity-head">
        <div class="cp-entity-avatar" style="background:linear-gradient(135deg,#fbbf24,#f97316);">${esc(initials)}</div>
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
          <div class="cp-metric-label">Delivered</div>
          <div class="cp-metric-val">${p.deliveredViews || 0}</div>
        </div>
        ${profitBox}
      </div>

      <button class="cp-view-btn cp-project-view-btn" data-id="${esc(p.projectId)}">View Details →</button>
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
        plannedViews: 0, completedViews: 0, deliveredViews: 0, status: 'In Progress' }
    : CP_PROJECTS.find(p => p.projectId === projectId);

  if (!isNew && !project) { toast?.('e', 'Project not found', projectId); return; }

  const isManager = CP_ROLE === 'manager';
  const isTL      = CP_ROLE === 'tl';

  let suggestedId = '';
  if (isNew && isManager) {
    try { suggestedId = (await sheetGET({ action: 'getNextProjectId' })) || ''; } catch(e) { /* fine, manager types it manually */ }
  }

  content.innerHTML = `
    <div style="margin-bottom:1rem;">
      <button id="cpProjBack" class="cp-back-btn">← Back</button>
    </div>

    <div class="cp-card">
      <div style="font-weight:700;font-size:16px;color:var(--txt1);margin-bottom:.2rem;">
        ${isNew ? '📁 New Project' : '📁 ' + esc(project.projectName || project.projectId)}
      </div>
      <div style="font-size:11.5px;color:var(--txt2);margin-bottom:1.1rem;">
        ${isManager ? 'You can edit project details and status. Progress fields are view-only here — Team Leader updates those.'
                    : 'You can update view progress. Project details and status are view-only here — Manager updates those.'}
      </div>

      <div class="cp-form-grid">
        <div class="cp-form-field cp-span2">
          <label class="cp-flabel">Project Name</label>
          <input class="cp-finput" id="cpName" value="${esc(project.projectName)}" ${isManager ? '' : 'disabled'} placeholder="e.g. SPR Tower F&amp;G Floorplan"/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Project ID ${isNew && isManager ? '<span class="cp-hint">— suggested, editable</span>' : ''}</label>
          <input class="cp-finput" id="cpId" value="${esc(isNew ? suggestedId : project.projectId)}" ${isManager ? '' : 'disabled'} placeholder="e.g. EUZ-042"/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Client</label>
          <select class="cp-finput" id="cpClient" ${isManager ? '' : 'disabled'}>
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
          <input class="cp-finput" id="cpPlanned" type="number" min="0" value="${project.plannedViews || ''}" ${isManager ? '' : 'disabled'} placeholder="e.g. 20"/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Status</label>
          <select class="cp-finput" id="cpStatus" ${isManager ? '' : 'disabled'}>
            ${CP_STATUSES.map(s => `<option value="${s}" ${s === project.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Views Completed ${isManager ? '<span class="cp-hint">— view only</span>' : ''}</label>
          <input class="cp-finput" id="cpCompleted" type="number" min="0" value="${project.completedViews || ''}" ${isTL ? '' : 'disabled'} placeholder="0"/>
        </div>

        <div class="cp-form-field">
          <label class="cp-flabel">Views Delivered ${isManager ? '<span class="cp-hint">— view only</span>' : ''}</label>
          <input class="cp-finput" id="cpDelivered" type="number" min="0" value="${project.deliveredViews || ''}" ${isTL ? '' : 'disabled'} placeholder="0"/>
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:.4rem;">
        ${(!isNew && isManager)
          ? `<button id="cpDeleteBtn" style="background:none;border:1px solid rgba(248,113,113,0.4);
              color:#f87171;border-radius:8px;padding:8px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">🗑 Delete</button>`
          : `<span></span>`}
        <button id="cpSaveBtn" style="background:var(--a1);color:#fff;border:none;border-radius:8px;
          padding:8px 18px;font-size:12.5px;font-weight:700;cursor:pointer;">${isNew ? 'Create Project' : 'Save Changes'}</button>
      </div>
    </div>

    ${!isNew ? `<div id="cpTeamSection"></div>` : ''}
    ${(!isNew && isManager) ? `<div id="cpCostSection"></div>` : ''}
  `;

  $('cpProjBack').addEventListener('click', goBack);
  $('cpSaveBtn').addEventListener('click', () => saveProjectFromForm(content, isNew, project, goBack));
  $('cpDeleteBtn')?.addEventListener('click', () => deleteProjectFromForm(content, project, goBack));

  if (!isNew) renderProjectTeamSection(project);
  if (!isNew && isManager) renderProjectCostSection(project);
}

async function saveProjectFromForm(content, isNew, originalProject, onDone) {
  const btn = $('cpSaveBtn');
  const isManager = CP_ROLE === 'manager';
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
    if (!isNew) payload.originalProjectId = originalProject.projectId;
  } else {
    payload.originalProjectId = originalProject.projectId;
    payload.completedViews    = parseFloat($('cpCompleted').value) || 0;
    payload.deliveredViews    = parseFloat($('cpDelivered').value) || 0;
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

// State for the currently-open project's Team & Hours slider. Reset
// each time renderProjectTeamSection runs (only one project detail
// page is ever open at once).
let CP_TEAM_MONTHS = [];
let CP_TEAM_IDX    = 0;

function renderProjectTeamSection(project) {
  const el = $('cpTeamSection');
  if (!el) return;

  const activity = getProjectTeamActivity(project);
  if (!activity || !activity.months.length) {
    el.innerHTML = `
      <div class="cp-card">
        <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.5rem;">👥 Team &amp; Hours</div>
        <div style="font-size:12.5px;color:var(--txt2);">No timesheet hours logged against this project yet.</div>
      </div>`;
    return;
  }

  CP_TEAM_MONTHS = activity.months;
  CP_TEAM_IDX    = CP_TEAM_MONTHS.length - 1; // default to the most recent month

  el.innerHTML = `
    <div class="cp-card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:6px;">
        <div style="font-weight:700;font-size:14px;color:var(--txt1);">👥 Team &amp; Hours</div>
        <div style="font-size:11.5px;color:var(--txt2);">${activity.totalMembers} member${activity.totalMembers !== 1 ? 's' : ''} · ${activity.totalHours.toFixed(1)}h total, all time</div>
      </div>

      <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:1rem;">
        <button id="cpTeamPrev" class="cp-nav-btn">◀</button>
        <span id="cpTeamMonthLabel" style="font-size:13px;font-weight:700;color:var(--txt1);min-width:150px;text-align:center;"></span>
        <button id="cpTeamNext" class="cp-nav-btn">▶</button>
      </div>

      <div id="cpTeamMonthBody"></div>
    </div>`;

  $('cpTeamPrev').addEventListener('click', () => { if (CP_TEAM_IDX > 0) { CP_TEAM_IDX--; renderCPTeamMonth(); } });
  $('cpTeamNext').addEventListener('click', () => { if (CP_TEAM_IDX < CP_TEAM_MONTHS.length - 1) { CP_TEAM_IDX++; renderCPTeamMonth(); } });
  renderCPTeamMonth();
}

function renderCPTeamMonth() {
  const m = CP_TEAM_MONTHS[CP_TEAM_IDX];
  if (!m) return;

  const label = $('cpTeamMonthLabel');
  if (label) label.textContent = fmtCPMonthLabel(m.month);
  $('cpTeamPrev').disabled = CP_TEAM_IDX === 0;
  $('cpTeamNext').disabled = CP_TEAM_IDX === CP_TEAM_MONTHS.length - 1;

  const body = $('cpTeamMonthBody');
  if (!body) return;

  const maxHours = Math.max(...m.members.map(x => x.hours), 0.01);

  body.innerHTML = `
    <div style="font-size:11px;color:var(--txt2);margin-bottom:10px;text-align:center;">
      ${m.members.length} member${m.members.length !== 1 ? 's' : ''} · ${m.monthHours.toFixed(1)}h this month
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${m.members.map(mem => `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px;">
            <span style="color:var(--txt1);font-weight:600;">${esc(mem.name)}</span>
            <span style="color:var(--txt2);font-weight:600;">${mem.hours.toFixed(1)}h</span>
          </div>
          <div class="cp-bar-track">
            <div class="cp-bar-fill" style="width:${(mem.hours / maxHours) * 100}%;"></div>
          </div>
        </div>`).join('')}
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

function fmtCPRupees(n) {
  const v = parseFloat(n) || 0;
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 1 });
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