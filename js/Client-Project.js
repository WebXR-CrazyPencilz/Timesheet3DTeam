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

// Projects sorted most-recently-updated first (falls back to Created
// Date, then leaves untouched legacy rows — with neither — at the end).
function sortProjectsByRecency(projects) {
  return projects.slice().sort((a, b) => {
    const at = parseAppTimestamp(a.updatedDate) || parseAppTimestamp(a.createdDate);
    const bt = parseAppTimestamp(b.updatedDate) || parseAppTimestamp(b.createdDate);
    return bt - at;
  });
}

// A client's "last activity" is the most recent update across any of
// its projects — a client with nothing happening on any project sorts
// to the end, one with a just-updated project rises to the top.
function getClientLastActivity(clientId) {
  const projects = CP_PROJECTS.filter(p => p.clientId === clientId);
  if (!projects.length) return 0;
  return Math.max(...projects.map(p => parseAppTimestamp(p.updatedDate) || parseAppTimestamp(p.createdDate)));
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
    // The dashboard needs both clients (for the tree) and projects
    // (for the bars) — Team Leader's plain list only needs clients,
    // but loading both here keeps this one code path simple.
    await Promise.all([loadClientData(), loadProjectData()]);
  } catch(err) {
    content.innerHTML = `<div class="slot-error">Failed to load clients: ${esc(err.message)}</div>`;
    return;
  }

  if (CP_ROLE === 'manager') renderClientPerformanceDashboard(content);
  else renderClientList(content); // TL: read-only, no bars — those reveal Project Constant/Employee Cost
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
// CLIENT — list + create (Client Name only; Client ID is
// auto-generated, read-only, shown as a live preview before saving).
// ══════════════════════════════════════════════════════════════
function renderClientList(content) {
  const isManager = CP_ROLE === 'manager';

  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--txt1);">🏢 Clients</div>
        <div style="font-size:12px;color:var(--txt2);">Client ID is auto-generated and permanent once created.</div>
      </div>
      ${isManager ? `<button id="cpNewClientBtn" style="background:var(--a1);color:#fff;border:none;
        border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">+ New Client</button>` : ''}
    </div>

    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:9px 12px;background:var(--surface2);color:var(--txt2);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;">Client ID</th>
            <th style="text-align:left;padding:9px 12px;background:var(--surface2);color:var(--txt2);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;">Client Name</th>
            ${isManager ? `<th style="width:1%;background:var(--surface2);"></th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${CP_CLIENTS.length === 0
            ? `<tr><td colspan="3" style="text-align:center;padding:2rem;color:var(--txt2);">No clients yet.${isManager ? ' Click “+ New Client” to add one.' : ''}</td></tr>`
            : sortClientsByRecency(CP_CLIENTS).map(c => buildClientRow(c, isManager)).join('')}
        </tbody>
      </table>
    </div>
  `;

  $('cpNewClientBtn')?.addEventListener('click', () => openClientEditor(content));
  content.querySelectorAll('.cp-client-edit').forEach(btn => {
    btn.addEventListener('click', () => openClientEditor(content, CP_CLIENTS.find(c => c.id === btn.dataset.id)));
  });
}

function buildClientRow(client, isManager) {
  const isActive = clientHasActiveProject(client.id);
  return `
    <tr style="border-top:1px solid var(--border);">
      <td style="padding:9px 12px;color:var(--txt2);font-family:var(--fm);">${esc(client.id)}</td>
      <td style="padding:9px 12px;color:var(--txt1);font-weight:600;">
        ${isActive ? `<span title="Has an active project" style="display:inline-block;width:7px;height:7px;
          border-radius:50%;background:#34d399;margin-right:6px;"></span>` : ''}${esc(client.name)}
      </td>
      ${isManager ? `<td style="padding:9px 12px;text-align:right;">
        <button class="cp-client-edit" data-id="${esc(client.id)}" style="background:none;border:1px solid var(--border-md);
          color:var(--txt2);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;">✏️ Edit</button>
      </td>` : ''}
    </tr>`;
}

// Create (no client passed) or rename (client passed) — Manager only,
// re-checked server-side too on delete.
function openClientEditor(content, client = null, onDone = null) {
  if (CP_ROLE !== 'manager') return;
  const isNew = !client;
  const refresh = onDone || (() => renderClientList(content));

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
// CLIENT PERFORMANCE DASHBOARD (Manager only) — a tree of Clients →
// Projects on the left. Selecting a project shows three horizontal
// bars scaled against each other for instant profitability
// comparison:
//   Project Constant  → the project's allocated budget
//   Employee Efforts  → Hours × Monthly Points, summed across every
//                        month the project has activity (same math
//                        as the Cost/Profit section in the detail
//                        page — never calculated twice, just reused)
//   Hours Worked      → raw hours logged, for context
// Recomputed live from Timesheet + Salary data every time a project
// is selected — nothing here is entered or stored manually.
// ══════════════════════════════════════════════════════════════

let CP_DASH_EXPANDED         = new Set(); // client IDs currently expanded in the tree
let CP_DASH_SELECTED_PROJECT = null;      // currently selected project ID

function renderClientPerformanceDashboard(content) {
  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--txt1);">🏢 Client Performance Dashboard</div>
        <div style="font-size:12px;color:var(--txt2);">Compare each project's budget, employee effort, and hours — updates automatically as timesheets and salaries change.</div>
      </div>
      <button id="cpNewClientBtn2" style="background:var(--a1);color:#fff;border:none;
        border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">+ New Client</button>
    </div>

    <div style="display:flex;gap:1.25rem;align-items:flex-start;">
      <div style="width:260px;flex-shrink:0;background:var(--surface1);border:1px solid var(--border);
        border-radius:12px;padding:.8rem;max-height:640px;overflow-y:auto;">
        <div id="cpClientTree"></div>
      </div>
      <div style="flex:1;min-width:0;" id="cpDashPanel"></div>
    </div>
  `;

  $('cpNewClientBtn2').addEventListener('click', () =>
    openClientEditor(content, null, () => renderClientPerformanceDashboard(content)));

  renderClientTree(content);
  renderDashPanel(content);
}

function renderClientTree(content) {
  const tree = $('cpClientTree');
  if (!tree) return;

  if (!CP_CLIENTS.length) {
    tree.innerHTML = `<div style="font-size:12px;color:var(--txt2);padding:.5rem;">No clients yet.</div>`;
    return;
  }

  const sortedClients = sortClientsByRecency(CP_CLIENTS);

  tree.innerHTML = sortedClients.map(c => {
    const projects = sortProjectsByRecency(CP_PROJECTS.filter(p => p.clientId === c.id));
    const isOpen   = CP_DASH_EXPANDED.has(c.id);
    const isActive = clientHasActiveProject(c.id);
    return `
      <div style="margin-bottom:4px;">
        <div style="display:flex;align-items:center;">
          <button class="cp-tree-client" data-id="${esc(c.id)}" style="flex:1;display:flex;align-items:center;gap:6px;
            background:none;border:none;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer;color:var(--txt1);">
            <span style="font-size:10px;color:var(--txt2);width:10px;flex-shrink:0;">${isOpen ? '▾' : '▸'}</span>
            ${isActive ? `<span title="Has an active project" style="width:7px;height:7px;border-radius:50%;
              background:#34d399;flex-shrink:0;"></span>` : ''}
            <span style="font-size:12.5px;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(c.name)}</span>
            <span style="font-size:10px;color:var(--txt2);flex-shrink:0;">${projects.length}</span>
          </button>
          <button class="cp-tree-client-edit" data-id="${esc(c.id)}" title="Edit client" style="flex-shrink:0;
            background:none;border:none;color:var(--txt2);cursor:pointer;font-size:11px;padding:4px 6px;">✏️</button>
        </div>
        ${isOpen ? `
          <div style="padding-left:20px;display:flex;flex-direction:column;gap:2px;margin-top:2px;margin-bottom:4px;">
            ${projects.length === 0
              ? `<div style="font-size:11px;color:var(--txt2);padding:4px 8px;">No projects yet.</div>`
              : projects.map(p => `
                <button class="cp-tree-project" data-project-id="${esc(p.projectId)}" style="text-align:left;
                  background:${CP_DASH_SELECTED_PROJECT === p.projectId ? 'var(--a1)' : 'none'};
                  color:${CP_DASH_SELECTED_PROJECT === p.projectId ? '#fff' : 'var(--txt2)'};
                  border:none;border-radius:7px;padding:6px 8px;font-size:11.5px;cursor:pointer;
                  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(p.projectName)}">${esc(p.projectName)}</button>`).join('')}
            <button class="cp-tree-addproj" data-client-id="${esc(c.id)}" style="text-align:left;background:none;
              border:none;color:var(--a1);font-size:11px;padding:6px 8px;cursor:pointer;">+ Add Project</button>
          </div>` : ''}
      </div>`;
  }).join('');

  tree.querySelectorAll('.cp-tree-client').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (CP_DASH_EXPANDED.has(id)) CP_DASH_EXPANDED.delete(id); else CP_DASH_EXPANDED.add(id);
      renderClientTree(content);
    });
  });
  tree.querySelectorAll('.cp-tree-client-edit').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const client = CP_CLIENTS.find(c => c.id === btn.dataset.id);
      openClientEditor(content, client, () => renderClientPerformanceDashboard(content));
    });
  });
  tree.querySelectorAll('.cp-tree-project').forEach(btn => {
    btn.addEventListener('click', () => {
      CP_DASH_SELECTED_PROJECT = btn.dataset.projectId;
      renderClientTree(content); // refresh highlight
      renderDashPanel(content);
    });
  });
  tree.querySelectorAll('.cp-tree-addproj').forEach(btn => {
    btn.addEventListener('click', () => {
      CP_DASH_EXPANDED.add(btn.dataset.clientId);
      openProjectDetail(content, null, {
        onBack: () => renderClientPerformanceDashboard(content),
        presetClientId: btn.dataset.clientId,
      });
    });
  });
}

async function renderDashPanel(content) {
  const panel = $('cpDashPanel');
  if (!panel) return;

  if (!CP_DASH_SELECTED_PROJECT) {
    panel.innerHTML = `<div class="chart-empty" style="margin-top:2rem;">Select a project on the left to see its performance.</div>`;
    return;
  }

  const project = CP_PROJECTS.find(p => p.projectId === CP_DASH_SELECTED_PROJECT);
  if (!project) {
    panel.innerHTML = `<div class="chart-empty">Project not found.</div>`;
    return;
  }

  panel.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Calculating…</span></div>`;
  await ensureSalaryDataLoaded();

  const result   = calculateProjectCost(project);
  const budget   = result ? result.projectBudget : (parseFloat(project.projectConstant) || 0);
  const efforts  = result ? result.totalCost : 0;
  const hours    = result ? result.totalHours : 0;
  const maxVal   = Math.max(budget, efforts, hours, 0.01);
  const profit   = budget - efforts;
  const isHealthy = profit >= 0;

  const bar = (label, value, color, unit) => `
    <div style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px;">
        <span style="color:var(--txt1);font-weight:600;">${label}</span>
        <span style="color:var(--txt2);font-weight:600;">${value.toLocaleString('en-IN', { maximumFractionDigits: 1 })}${unit}</span>
      </div>
      <div style="background:var(--surface2);border-radius:7px;height:16px;overflow:hidden;">
        <div style="height:100%;width:${Math.max((value / maxVal) * 100, value > 0 ? 2 : 0)}%;background:${color};border-radius:7px;transition:width .3s;"></div>
      </div>
    </div>`;

  panel.innerHTML = `
    <div class="cp-card" style="max-width:640px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.2rem;flex-wrap:wrap;gap:8px;">
        <div style="font-weight:700;font-size:16px;color:var(--txt1);">📁 ${esc(project.projectName)}</div>
        <button id="cpDashEditBtn" style="background:none;border:1px solid var(--border-md);color:var(--txt2);
          border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer;">✏️ Edit</button>
      </div>
      <div style="font-size:11.5px;color:var(--txt2);margin-bottom:1.3rem;">${esc(project.projectId)} · ${esc(project.status)}</div>

      ${bar('Project Constant', budget, '#4f8ef7', '')}
      ${bar('Employee Efforts', efforts, '#fbbf24', '')}
      ${bar('Hours Worked', hours, '#34d399', 'h')}

      <div style="margin-top:4px;background:${isHealthy ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)'};
        border:1px solid ${isHealthy ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'};
        border-radius:10px;padding:10px 12px;text-align:center;">
        <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;">${isHealthy ? '📈 Healthy Margin' : '📉 Over Budget'}</div>
        <div style="font-size:16px;font-weight:800;color:${isHealthy ? '#34d399' : '#f87171'};">
          ${isHealthy ? '+' : '-'}${fmtCPRupees(Math.abs(profit))}</div>
      </div>
    </div>`;

  $('cpDashEditBtn').addEventListener('click', () => {
    openProjectDetail(content, project.projectId, { onBack: () => renderClientPerformanceDashboard(content) });
  });
}

// ══════════════════════════════════════════════════════════════
// PROJECT — list + role-aware detail/edit.
// ══════════════════════════════════════════════════════════════
function renderProjectList(content) {
  const isManager = CP_ROLE === 'manager';
  const sortedProjects = sortProjectsByRecency(CP_PROJECTS);

  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--txt1);">📁 Projects</div>
        <div style="font-size:12px;color:var(--txt2);">Projects received from clients — status and view progress. Not a task board.</div>
      </div>
      ${isManager ? `<button id="cpNewProjectBtn" style="background:var(--a1);color:#fff;border:none;
        border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;">+ New Project</button>` : ''}
    </div>

    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead>
            <tr>
              ${['Project Name','Project ID','Client','Status','Planned','Completed','Delivered'].map(h =>
                `<th style="text-align:${['Planned','Completed','Delivered'].includes(h)?'right':'left'};padding:9px 12px;
                  background:var(--surface2);color:var(--txt2);font-size:10.5px;text-transform:uppercase;
                  letter-spacing:.04em;white-space:nowrap;">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${CP_PROJECTS.length === 0
              ? `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--txt2);">No projects yet.${isManager ? ' Click “+ New Project” to add one.' : ''}</td></tr>`
              : sortedProjects.map(p => buildProjectRow(p)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  content.querySelectorAll('.cp-project-row').forEach(row => {
    row.addEventListener('click', () => openProjectDetail(content, row.dataset.projectId));
  });
  $('cpNewProjectBtn')?.addEventListener('click', () => openProjectDetail(content, null));
}

function buildProjectRow(p) {
  const client = CP_CLIENTS.find(c => c.id === p.clientId);
  const meta   = CP_STATUS_META[p.status] || CP_STATUS_META['In Progress'];
  return `
    <tr class="cp-project-row" data-project-id="${esc(p.projectId)}" style="cursor:pointer;border-top:1px solid var(--border);">
      <td style="padding:9px 12px;color:var(--txt1);font-weight:600;max-width:220px;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;" title="${esc(p.projectName)}">${esc(p.projectName)}</td>
      <td style="padding:9px 12px;color:var(--txt2);font-family:var(--fm);white-space:nowrap;">${esc(p.projectId)}</td>
      <td style="padding:9px 12px;color:var(--txt2);white-space:nowrap;">${esc(client?.name || p.clientId || '—')}</td>
      <td style="padding:9px 12px;white-space:nowrap;">
        <span style="background:${meta.bg};color:${meta.fg};border-radius:20px;padding:2px 10px;font-size:10.5px;font-weight:700;">${esc(p.status)}</span>
      </td>
      <td style="padding:9px 12px;text-align:right;color:var(--txt1);">${p.plannedViews || 0}</td>
      <td style="padding:9px 12px;text-align:right;color:var(--txt1);">${p.completedViews || 0}</td>
      <td style="padding:9px 12px;text-align:right;color:var(--txt1);">${p.deliveredViews || 0}</td>
    </tr>`;
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
      <button id="cpProjBack" style="display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;
        border:1px solid var(--border-md);background:var(--elevated);color:var(--txt2);font-size:13px;
        font-weight:600;cursor:pointer;">← Back</button>
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
    CP_DASH_SELECTED_PROJECT = payload.projectId || originalProject.projectId;
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
    if (CP_DASH_SELECTED_PROJECT === project.projectId) CP_DASH_SELECTED_PROJECT = null;
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