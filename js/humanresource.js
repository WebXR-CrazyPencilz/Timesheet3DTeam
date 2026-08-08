// ═══════════════════════════════════════════════════
// HUMANRESOURCE.JS — HR Portal shell
// Tabs: Attendance | Project Contribution | Add Employee
//
// Same "this file is only a loading/navigation platform" convention
// as manager.js/teamleader.js:
//   Attendance          → client-project.js (renderAttendanceTab) —
//                          the exact same widget Manager/TL use, no
//                          second implementation. CP_ROLE === 'hr' is
//                          read-only there since the Manager/TL-only
//                          edit buttons all gate on isManager/CP_ROLE
//                          === 'tl' specifically.
//   Project Contribution → this file, built straight from CP_TIMESHEET_DATA
//                          + CP_EMPLOYEES (same data Attendance already
//                          loads) — no new fetch, no financial figures
//                          (₹ cost/constant intentionally never shown
//                          here, this is a hours/contribution view only).
//   Add Employee         → this file, calls a new 'createEmployee'
//                          backend action (see note at bottom of this
//                          file — Code.gs needs this action added).
//
// Desktop-only layout, matching manager.js/teamleader.js.
// ═══════════════════════════════════════════════════

// ── STATE ─────────────────────────────────────────
let HR_DATA      = [];
let HR_EMPLOYEES = [];
let HR_TAB       = 'dashboard'; // dashboard|attendance|contribution|addEmployee — Dashboard is the default landing tab

// ── INIT ──────────────────────────────────────────
async function initHR() {
  const container = $('hrApp');
  if (!container) return;

  container.innerHTML = `<div class="mgr-loading">
    <div class="slot-spinner"></div>
    <span>Loading all data…</span>
  </div>`;

  try {
    const master = await apiGetMasterData();
    HR_EMPLOYEES = master.employees || [];

    if (typeof ClientProjectAPI !== 'undefined' && typeof ClientProjectAPI.ingestMasterData === 'function') {
      ClientProjectAPI.ingestMasterData(master);
    }

    const results = await Promise.all(
      HR_EMPLOYEES.map(emp =>
        apiGetAllHistory(emp.id)
          .then(entries => entries.map(e => ({ ...e, empId: emp.id, empName: emp.name, empTeam: emp.team })))
          .catch(() => [])
      )
    );
    HR_DATA = results.flat();

    if (typeof ClientProjectAPI !== 'undefined' && typeof ClientProjectAPI.ingestTimesheetData === 'function') {
      ClientProjectAPI.ingestTimesheetData(HR_DATA);
    }

    renderHRPortal();
  } catch(err) {
    container.innerHTML = `<div class="slot-error">Failed to load: ${err.message}</div>`;
  }
}

// ── RENDER PORTAL SHELL ───────────────────────────
function renderHRPortal() {
  const container = $('hrApp');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex;gap:4px;margin-bottom:1.5rem;border-bottom:1px solid var(--border);padding-bottom:0;">
      ${[
        { id:'dashboard',    icon:'🏠', label:'Dashboard' },
        { id:'attendance',   icon:'🕒', label:'Attendance' },
        { id:'contribution', icon:'📊', label:'Project Contribution' },
        { id:'addEmployee',  icon:'➕', label:'Add Employee' },
      ].map(t => `
        <button class="hr-tab${HR_TAB===t.id?' active':''}" data-tab="${t.id}" style="
          padding:8px 16px;border:none;background:none;cursor:pointer;
          font-size:13px;font-weight:600;
          color:${HR_TAB===t.id ? 'var(--a1)' : 'var(--txt2)'};
          border-bottom:2px solid ${HR_TAB===t.id ? 'var(--a1)' : 'transparent'};
          margin-bottom:-1px;transition:all .2s;
        ">${t.icon} ${t.label}</button>
      `).join('')}
    </div>
    <div id="hrTabContent"></div>
  `;

  container.querySelectorAll('.hr-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      HR_TAB = btn.dataset.tab;
      container.querySelectorAll('.hr-tab').forEach(b => {
        const active = b === btn;
        b.style.color        = active ? 'var(--a1)' : 'var(--txt2)';
        b.style.borderBottom = active ? '2px solid var(--a1)' : '2px solid transparent';
      });
      renderHRTab();
    });
  });

  renderHRTab();
}

// ── ROUTE TO TAB ──────────────────────────────────
function renderHRTab() {
  const content = $('hrTabContent');
  if (!content) return;

  if (HR_TAB === 'dashboard') {
    if (typeof renderHRDashboard === 'function') renderHRDashboard(content);
    else content.innerHTML = `<div class="chart-empty">Dashboard module (dashboard.js) is not loaded.</div>`;
    return;
  }
  if (HR_TAB === 'attendance') {
    if (typeof renderAttendanceTab === 'function') renderAttendanceTab(content);
    else content.innerHTML = `<div class="chart-empty">Attendance module (client-project.js) is not loaded.</div>`;
    return;
  }
  if (HR_TAB === 'contribution') { renderHRContributionTab(content); return; }
  if (HR_TAB === 'addEmployee')  { renderHRAddEmployeeTab(content);  return; }
}

// ══════════════════════════════════════════════════
// DASHBOARD — reuses dashboard.js's Not Logged In panel and Team
// Performance chart as-is (both are pure hours/attendance data, no
// financials — the same reasoning Project Contribution above
// follows). No new fetch beyond what initHR() already loaded, plus
// the same loadProjectData/loadHistoricalData calls
// renderManagerDashboard makes, so the Team Performance chart's
// drill-down and per-project attribution work identically to the
// Manager's. Clients Overview and the KPI cards are intentionally
// left out — they're financial/placeholder widgets outside HR's
// scope. The employee headcount card below is this file's own,
// built from CP_EMPLOYEES the way Add Employee's team list already
// is.
// ══════════════════════════════════════════════════
async function renderHRDashboard(content) {
  if (typeof ensureDashStyles === 'function') ensureDashStyles();

  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading dashboard…</span></div>`;

  try {
    if (typeof loadProjectData === 'function')    await loadProjectData();
    if (typeof loadHistoricalData === 'function') await loadHistoricalData();
    if (typeof loadProjects === 'function' && (typeof GANTT_PROJECTS === 'undefined' || !GANTT_PROJECTS.length)) {
      await loadProjects();
    }
  } catch (err) {
    // Team Performance chart still works off CP_TIMESHEET_DATA alone
    // if these fail — Views-per-candle just won't show, same
    // graceful fallback dashboard.js already has.
    console.warn('[HR dashboard] optional project data failed to load:', err.message);
  }

  if (typeof buildTeamPerformanceCache === 'function') buildTeamPerformanceCache();

  content.innerHTML = `
    <div id="hrHeadcountWrap" style="margin-bottom:22px;"></div>
    <div style="display:flex;gap:10px;align-items:stretch;">
      <div style="flex:0 0 330px;" id="hrNotLoggedWrap"></div>
      <div style="flex:1;min-width:280px;" id="hrTeamPerfWrap"></div>
    </div>`;

  renderHRHeadcountRow($('hrHeadcountWrap'));
  if (typeof renderDashboardNotLoggedPanel === 'function') renderDashboardNotLoggedPanel($('hrNotLoggedWrap'));
  if (typeof renderDashboardShell === 'function') renderDashboardShell($('hrTeamPerfWrap'));
}

// Simple headcount strip — active vs inactive, and a per-team count.
// Built straight from CP_EMPLOYEES (already loaded), nothing new
// fetched.
function renderHRHeadcountRow(wrap) {
  if (!wrap) return;
  const employees = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES);
  const active   = employees.filter(e => e.active !== false).length;
  const inactive = employees.length - active;

  const byTeam = {};
  employees.forEach(e => {
    if (e.active === false) return;
    const t = e.team || 'Unassigned';
    byTeam[t] = (byTeam[t] || 0) + 1;
  });
  const teamRows = Object.entries(byTeam).sort((a, b) => b[1] - a[1]);

  wrap.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1rem 1.4rem;min-width:140px;">
        <div style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;">Active Employees</div>
        <div style="font-size:22px;font-weight:700;color:var(--txt1);margin-top:2px;">${active}</div>
      </div>
      <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1rem 1.4rem;min-width:140px;">
        <div style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;">Inactive</div>
        <div style="font-size:22px;font-weight:700;color:var(--txt1);margin-top:2px;">${inactive}</div>
      </div>
      <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1rem 1.4rem;flex:1;min-width:260px;">
        <div style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px;">By Team</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          ${teamRows.map(([team, count]) => `
            <div style="display:flex;align-items:baseline;gap:6px;">
              <span style="font-size:14px;font-weight:700;color:var(--a1);">${count}</span>
              <span style="font-size:11.5px;color:var(--txt2);">${esc(team)}</span>
            </div>`).join('') || '<span style="font-size:11.5px;color:var(--txt2);">No employees yet.</span>'}
        </div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════
// PROJECT CONTRIBUTION — per employee, hours spent per project.
// Built straight from CP_TIMESHEET_DATA (already loaded for
// Attendance above) + CP_EMPLOYEES — no financial figures, no new
// fetch. Search + sort, expand a row to see that employee's
// project-by-project hours breakdown (most-hours-first).
// ══════════════════════════════════════════════════
let HR_CONTRIB_SEARCH   = '';
let HR_CONTRIB_SORT     = 'hours'; // 'hours' | 'name'
let HR_CONTRIB_EXPANDED = new Set();

function buildHRContributionRows() {
  const employees = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES);
  const entries    = (typeof CP_TIMESHEET_DATA !== 'undefined' ? CP_TIMESHEET_DATA : HR_DATA)
    .filter(e => e.status !== 'Leave' && e.project);

  return employees.map(emp => {
    const empEntries = entries.filter(e => e.empId === emp.id);
    const byProject = {};
    empEntries.forEach(e => {
      byProject[e.project] = (byProject[e.project] || 0) + (parseFloat(e.hours) || 0);
    });
    const projects = Object.entries(byProject)
      .map(([project, hours]) => ({ project, hours }))
      .sort((a, b) => b.hours - a.hours);
    const totalHours = projects.reduce((s, p) => s + p.hours, 0);
    return { emp, projects, totalHours };
  });
}

function renderHRContributionTab(content) {
  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem;flex-wrap:wrap;gap:10px;">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--txt1);">📊 Project Contribution</div>
        <div style="font-size:12px;color:var(--txt2);">Hours each employee has logged, broken down by project.</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <input id="hrContribSearch" type="text" placeholder="🔍 Search employee…" value="${esc(HR_CONTRIB_SEARCH)}" style="
          background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);
          font-size:12px;padding:6px 10px;min-width:200px;"/>
        <div class="chart-range" id="hrContribSortBtns">
          <button class="rbtn${HR_CONTRIB_SORT==='hours'?' active':''}" data-sort="hours">Most Hours</button>
          <button class="rbtn${HR_CONTRIB_SORT==='name'?' active':''}" data-sort="name">Name A→Z</button>
        </div>
      </div>
    </div>
    <div id="hrContribList"></div>
  `;

  $('hrContribSearch').addEventListener('input', e => {
    HR_CONTRIB_SEARCH = e.target.value;
    renderHRContribList();
  });
  $('hrContribSortBtns').addEventListener('click', e => {
    const btn = e.target.closest('.rbtn');
    if (!btn) return;
    HR_CONTRIB_SORT = btn.dataset.sort;
    $('hrContribSortBtns').querySelectorAll('.rbtn').forEach(b => b.classList.toggle('active', b === btn));
    renderHRContribList();
  });

  renderHRContribList();
}

function renderHRContribList() {
  const listEl = $('hrContribList');
  if (!listEl) return;

  let rows = buildHRContributionRows();
  const q = HR_CONTRIB_SEARCH.trim().toLowerCase();
  if (q) rows = rows.filter(r => (r.emp.name || '').toLowerCase().includes(q) || (r.emp.id || '').toLowerCase().includes(q));

  rows.sort((a, b) => HR_CONTRIB_SORT === 'name'
    ? (a.emp.name || '').localeCompare(b.emp.name || '')
    : b.totalHours - a.totalHours);

  if (!rows.length) {
    listEl.innerHTML = `<div class="chart-empty">No employees match.</div>`;
    return;
  }

  listEl.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
      ${rows.map((r, i) => {
        const expanded = HR_CONTRIB_EXPANDED.has(r.emp.id);
        return `
        <div class="hr-contrib-row" data-emp="${esc(r.emp.id)}" style="${i > 0 ? 'border-top:1px solid var(--border);' : ''}">
          <div class="hr-contrib-head" data-emp="${esc(r.emp.id)}" style="padding:12px 16px;cursor:pointer;
            display:flex;align-items:center;justify-content:space-between;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:12px;color:var(--txt2);width:14px;display:inline-block;">${expanded ? '▾' : '▸'}</span>
              <div>
                <div style="font-size:13px;font-weight:700;color:var(--txt1);">${esc(r.emp.name)}</div>
                <div style="font-size:10.5px;color:var(--txt2);">${esc(r.emp.id)} · ${esc(r.emp.team || '—')}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:16px;">
              <div style="font-size:10.5px;color:var(--txt2);">${r.projects.length} project${r.projects.length===1?'':'s'}</div>
              <div style="font-size:13px;font-weight:700;color:var(--a1);">${fh(r.totalHours)}</div>
            </div>
          </div>
          ${expanded ? `
            <div style="padding:0 16px 14px 40px;">
              ${r.projects.length ? r.projects.map(p => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-top:1px solid var(--border);">
                  <div style="font-size:12px;color:var(--txt1);">${esc(p.project)}</div>
                  <div style="font-size:12px;font-weight:600;color:var(--txt1);">${fh(p.hours)}</div>
                </div>`).join('') : `<div style="font-size:11.5px;color:var(--txt2);padding:6px 0;">No project hours logged yet.</div>`}
            </div>` : ''}
        </div>`;
      }).join('')}
    </div>`;

  listEl.querySelectorAll('.hr-contrib-head').forEach(head => {
    head.addEventListener('click', () => {
      const id = head.dataset.emp;
      if (HR_CONTRIB_EXPANDED.has(id)) HR_CONTRIB_EXPANDED.delete(id);
      else HR_CONTRIB_EXPANDED.add(id);
      renderHRContribList();
    });
  });
}

// ══════════════════════════════════════════════════
// ADD EMPLOYEE — new employee creation form.
//
// ⚠️ BACKEND REQUIRED: this calls a 'createEmployee' action that
// does not exist in Code.gs yet. See the comment block at the very
// end of this file for the exact Apps Script function to add.
// ══════════════════════════════════════════════════
function nextHREmployeeId() {
  const employees = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES);
  const nums = employees
    .map(e => (String(e.id || '').match(/^E(\d+)$/) || [])[1])
    .filter(Boolean)
    .map(Number);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return 'E' + String(next).padStart(2, '0');
}

function renderHRAddEmployeeTab(content) {
  const suggestedId = nextHREmployeeId();
  const teams = [...new Set((typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES).map(e => e.team).filter(Boolean))].sort();

  content.innerHTML = `
    <div style="max-width:480px;">
      <div style="font-size:16px;font-weight:700;color:var(--txt1);margin-bottom:2px;">➕ Add Employee</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:1.1rem;">Creates a new employee record and login for the timesheet portal.</div>

      <form id="hrAddEmpForm" style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--txt2);text-transform:uppercase;letter-spacing:.04em;">Employee ID</label>
          <input id="hrEmpId" type="text" value="${esc(suggestedId)}" style="width:100%;box-sizing:border-box;margin-top:4px;
            background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:13px;padding:8px 10px;"/>
          <div style="font-size:10px;color:var(--txt2);margin-top:3px;">Auto-suggested — change if this ID is already taken.</div>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--txt2);text-transform:uppercase;letter-spacing:.04em;">Full Name</label>
          <input id="hrEmpName" type="text" placeholder="e.g. Priya Kumar" style="width:100%;box-sizing:border-box;margin-top:4px;
            background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:13px;padding:8px 10px;"/>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--txt2);text-transform:uppercase;letter-spacing:.04em;">Team</label>
          <input id="hrEmpTeam" list="hrTeamOptions" type="text" placeholder="e.g. 3D, Design, Development…" style="width:100%;box-sizing:border-box;margin-top:4px;
            background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:13px;padding:8px 10px;"/>
          <datalist id="hrTeamOptions">${teams.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
        </div>
        <div>
          <label style="font-size:11px;font-weight:700;color:var(--txt2);text-transform:uppercase;letter-spacing:.04em;">Login Password</label>
          <input id="hrEmpPw" type="text" placeholder="e.g. pass133" style="width:100%;box-sizing:border-box;margin-top:4px;
            background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:13px;padding:8px 10px;"/>
        </div>
        <div id="hrAddEmpErr" style="display:none;font-size:12px;color:#f87171;"></div>
        <button type="submit" id="hrAddEmpBtn" style="background:var(--a1);color:#fff;border:none;border-radius:8px;
          padding:10px 16px;font-size:13px;font-weight:700;cursor:pointer;margin-top:4px;">Create Employee</button>
      </form>
    </div>
  `;

  $('hrAddEmpForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const id   = $('hrEmpId').value.trim();
    const name = $('hrEmpName').value.trim();
    const team = $('hrEmpTeam').value.trim();
    const pw   = $('hrEmpPw').value.trim();
    const err  = $('hrAddEmpErr'), btn = $('hrAddEmpBtn');
    err.style.display = 'none';

    if (!id || !name || !team || !pw) {
      err.textContent = 'Please fill in every field.';
      err.style.display = 'block';
      return;
    }
    const employees = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES);
    if (employees.some(e => e.id === id)) {
      err.textContent = `Employee ID "${id}" already exists.`;
      err.style.display = 'block';
      return;
    }

    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await sheetGET({
        action: 'createEmployee',
        data:   encodeURIComponent(JSON.stringify({ id, name, team, pw })),
      });

      const newEmp = { id, name, team, pw };
      HR_EMPLOYEES.push(newEmp);
      if (typeof CP_EMPLOYEES !== 'undefined') CP_EMPLOYEES.push(newEmp);

      toast('s', 'Employee created', `${name} (${id}) can now log in.`);
      renderHRAddEmployeeTab($('hrTabContent')); // reset form, next suggested ID
    } catch(e) {
      err.textContent = e.message || 'Failed to create employee.';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Create Employee';
    }
  });
}

// ══════════════════════════════════════════════════════════════
// ⚠️ BACKEND NOT YET WIRED — add this to Code.gs's action switch,
// alongside the existing createClientMaster/createProjectMaster
// handlers (Code.gs was not part of this session's uploads, so it
// could not be edited directly — paste this in manually):
//
//   } else if (action === 'createEmployee') {
//     var d = JSON.parse(e.parameter.data);
//     var sheet = ss.getSheetByName('Employees');
//     sheet.appendRow([d.id, d.name, d.team, d.pw]);
//     return jsonOk({ created: true });
//
// Also requires an <div id="hrPortal"> app shell (mirroring
// #mgrPortal / #tlPortal) in index.html, with #hrApp inside it and
// a topbar showing #hrAv/#hrName/#hrTeam — index.html was not part
// of this session's uploads either.
// ══════════════════════════════════════════════════════════════