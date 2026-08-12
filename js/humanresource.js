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
    // Reuses the master data auth.js ALREADY fetched once during
    // login (LIVE_EMPLOYEES/CLIENTS/PROJECTS) instead of calling
    // apiGetMasterData() again from scratch — same reasoning as
    // manager.js's/teamleader.js's identical fix: one fewer redundant
    // round-trip, one fewer chance to fail on a flaky connection.
    // Falls back to a real fetch only if those globals are somehow
    // still empty.
    const master = (typeof LIVE_EMPLOYEES !== 'undefined' && LIVE_EMPLOYEES.length)
      ? { employees: LIVE_EMPLOYEES, clients: (typeof CLIENTS !== 'undefined' ? CLIENTS : []), projects: (typeof PROJECTS !== 'undefined' ? PROJECTS : []) }
      : await apiGetMasterData();
    HR_EMPLOYEES = master.employees || [];

    if (typeof ClientProjectAPI !== 'undefined' && typeof ClientProjectAPI.ingestMasterData === 'function') {
      ClientProjectAPI.ingestMasterData(master);
    }

    // Each employee's history is fetched independently and tagged
    // with whether it actually succeeded — NOT silently swallowed to
    // an empty array on failure. See teamleader.js's identical fix
    // for the full reasoning: a single flaky request out of up to 19
    // firing in parallel used to make that employee's real timesheet
    // data vanish everywhere with no warning at all — indistinguishable
    // from them genuinely having no entries.
    const results = await Promise.all(
      HR_EMPLOYEES.map(emp =>
        apiGetAllHistory(emp.id)
          .then(entries => ({ ok: true, empName: emp.name, entries: entries.map(e => ({ ...e, empId: emp.id, empName: emp.name, empTeam: emp.team })) }))
          .catch(err => ({ ok: false, empName: emp.name, error: err.message, entries: [] }))
      )
    );
    const failed = results.filter(r => !r.ok);
    HR_DATA = results.flatMap(r => r.entries);

    if (failed.length) {
      toast?.('e', `Couldn't load ${failed.length} employee${failed.length > 1 ? "s'" : "'s"} timesheet data`,
        `${failed.map(f => f.empName).join(', ')} — their hours may show as missing below. Reload to retry.`, 12000);
    }

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
        { id:'manageEmployees', icon:'✏️', label:'Manage Employees' },
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
  if (HR_TAB === 'manageEmployees') { renderHRManageEmployeesTab(content); return; }
}

// ══════════════════════════════════════════════════
// DASHBOARD — reuses dashboard.js's Not Logged In panel as-is (pure
// attendance data, no financials). The employees-per-month chart and
// headcount card below are this file's own, built straight from
// CP_TIMESHEET_DATA/CP_EMPLOYEES (already loaded, no new fetch) —
// headcount rather than hours/views is a better fit for HR than
// reusing Manager's Team Performance chart. Clients Overview and the
// KPI cards are intentionally left out — financial/placeholder
// widgets outside HR's scope.
// ══════════════════════════════════════════════════
async function renderHRDashboard(content) {
  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading dashboard…</span></div>`;

  content.innerHTML = `
    <div id="hrEotmWrap" style="margin-bottom:22px;"></div>
    <div id="hrHeadcountWrap" style="margin-bottom:22px;"></div>
    <div style="display:flex;gap:10px;align-items:stretch;">
      <div style="flex:0 0 330px;" id="hrNotLoggedWrap"></div>
      <div style="flex:1;min-width:280px;" id="hrTeamPerfWrap"></div>
    </div>`;

  renderHREmployeeOfMonth($('hrEotmWrap'));
  renderHRHeadcountRow($('hrHeadcountWrap'));
  if (typeof renderDashboardNotLoggedPanel === 'function') renderDashboardNotLoggedPanel($('hrNotLoggedWrap'));
  renderHREmployeeCountChart($('hrTeamPerfWrap'));
}

// ── EMPLOYEE OF THE MONTH — HR-only ───────────────
// Scored on four criteria for the current calendar month, built
// straight from CP_TIMESHEET_DATA/CP_EMPLOYEES (already loaded, no
// new fetch):
//   1. Projects handled — distinct projects worked on (more = better)
//   2. Attendance — FULL working days logged, i.e. days that reach
//      at least HR_EOTM_FULL_DAY_THRESHOLD_HOURS (more = better).
//      A day with only a couple hours logged does NOT count as
//      attendance here — otherwise someone who logs short partial
//      days every day would score as "perfect attendance" purely for
//      showing up briefly, while also scoring "zero overtime" for
//      the same reason. Short days are tracked separately
//      (shortDays) and actively hurt the score below instead.
//   3. Overtime — days that crossed the 9h threshold (fewer = better,
//      same OVERTIME_THRESHOLD_HOURS table.js already uses for its OT
//      badge, so "overtime" means the same thing here as it does on
//      the employee's own timesheet)
//   4. Leaves — days marked Leave this month (fewer = better)
// Each metric is normalized 0–1 against the best value among that
// month's active employees, then averaged equally across all four —
// no single criterion can dominate the others. Only employees with
// at least one worked entry this month are eligible, so a totally
// inactive employee can't "win" by default through having zero
// overtime and zero leaves.
const HR_EOTM_OVERTIME_THRESHOLD_HOURS  = 9;
// A full day is exactly the standard 9h — below that is a short day
// (doesn't count toward attendance), above that is overtime (already
// penalized separately via overtimeDays). So a day under 9h and a
// day over 9h are both "problems" in different ways: short days lose
// attendance credit here, long days lose points via overtimeDays.
const HR_EOTM_FULL_DAY_THRESHOLD_HOURS = 9;

function buildHREotmStats(monthKey, onlyWithActivity = true) {
  const employees = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES).filter(e => e.active !== false);
  const entries = (typeof CP_TIMESHEET_DATA !== 'undefined' ? CP_TIMESHEET_DATA : HR_DATA)
    .filter(e => e.date && e.date.startsWith(monthKey));

  const stats = employees.map(emp => {
    const own = entries.filter(e => e.empId === emp.id);
    const worked = own.filter(e => e.status !== 'Leave');

    const projects = new Set(worked.map(e => e.project).filter(Boolean));
    const dayTotals = {};
    worked.forEach(e => { dayTotals[e.date] = (dayTotals[e.date] || 0) + (parseFloat(e.hours) || 0); });
    const dayHours = Object.values(dayTotals);
    const workingDays = dayHours.filter(h => h >= HR_EOTM_FULL_DAY_THRESHOLD_HOURS).length;
    const shortDays = dayHours.length - workingDays;
    const overtimeDays = dayHours.filter(h => h > HR_EOTM_OVERTIME_THRESHOLD_HOURS).length;
    const leaveDays = new Set(own.filter(e => e.status === 'Leave').map(e => e.date)).size;

    return { emp, projects: projects.size, workingDays, shortDays, overtimeDays, leaveDays };
  });

  return onlyWithActivity ? stats.filter(s => s.workingDays > 0) : stats;
}

// Scores every stat row that has activity (workingDays > 0) against
// the best values among that active subset — a zero-activity
// employee never gets scored (score: null), so it can't rank ahead
// of someone who actually worked just by having zero overtime/leaves
// by default. Zero-activity rows sort to the bottom.
function scoreHREotm(stats) {
  const active = stats.filter(s => s.workingDays > 0);
  const maxProjects = Math.max(1, ...active.map(s => s.projects));
  const maxDays      = Math.max(1, ...active.map(s => s.workingDays));
  const maxOvertime  = Math.max(1, ...active.map(s => s.overtimeDays));
  const maxLeaves    = Math.max(1, ...active.map(s => s.leaveDays));

  return stats.map(s => {
    if (s.workingDays === 0) return { ...s, score: null };
    const projectsScore = s.projects / maxProjects;
    const attendanceScore = s.workingDays / maxDays;
    const overtimeScore = 1 - (s.overtimeDays / maxOvertime);
    const leaveScore = 1 - (s.leaveDays / maxLeaves);
    const score = (projectsScore + attendanceScore + overtimeScore + leaveScore) / 4;
    return { ...s, score };
  }).sort((a, b) => {
    if (a.score === null && b.score === null) return (a.emp.name || '').localeCompare(b.emp.name || '');
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score || b.workingDays - a.workingDays;
  });
}

function renderHREmployeeOfMonth(wrap) {
  if (!wrap) return;
  const monthKey = todayStr().slice(0, 7);
  const monthLabel = new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const stats = buildHREotmStats(monthKey);
  const ranked = scoreHREotm(stats);

  if (!ranked.length) {
    wrap.innerHTML = `
      <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1.4rem;max-width:680px;">
        <div style="font-size:14px;font-weight:700;color:var(--txt1);">🏆 Employee of the Month — ${esc(monthLabel)}</div>
        <div style="font-size:12px;color:var(--txt2);margin-top:6px;">No logged hours yet this month.</div>
      </div>`;
    return;
  }

  const winner = ranked[0];
  const runnersUp = ranked.slice(1, 4);

  const metricChip = (label, value, good) => `
    <div style="text-align:center;">
      <div style="font-size:15px;font-weight:700;color:${good ? '#34d399' : 'var(--txt1)'};">${value}</div>
      <div style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;margin-top:1px;">${label}</div>
    </div>`;

  wrap.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1rem 1.2rem;max-width:680px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--txt1);">🏆 Employee of the Month — ${esc(monthLabel)}</div>
          <div style="font-size:11px;color:var(--txt2);margin-top:1px;">Scored on projects handled, attendance, overtime, and leaves.</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:10px;padding:10px 14px;
        background:var(--elevated);border-radius:10px;">
        <div style="display:flex;align-items:center;gap:10px;min-width:160px;">
          <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#fbbf24,#fb923c);
            display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;flex-shrink:0;">
            ${esc((winner.emp.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase())}
          </div>
          <div>
            <div style="font-size:13.5px;font-weight:700;color:var(--txt1);">${esc(winner.emp.name)}</div>
            <div style="font-size:10.5px;color:var(--txt2);">${esc(winner.emp.id)} · ${esc(winner.emp.team || '—')}</div>
          </div>
        </div>
        ${metricChip('Projects', winner.projects, true)}
        ${metricChip('Full Days', winner.workingDays, true)}
        ${metricChip('Overtime Days', winner.overtimeDays, winner.overtimeDays === 0)}
        ${metricChip('Leave Days', winner.leaveDays, winner.leaveDays === 0)}
      </div>
      <div style="font-size:10px;color:var(--txt2);margin-top:6px;">Full Day = ${HR_EOTM_FULL_DAY_THRESHOLD_HOURS}h logged that day. Under that doesn't count toward attendance; over that counts as overtime.</div>
      ${runnersUp.length ? `
        <div style="margin-top:10px;">
          <div style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px;">Runners-up</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${runnersUp.map((r, i) => `
              <div style="display:flex;align-items:center;gap:6px;background:var(--elevated);border-radius:8px;padding:4px 10px;">
                <span style="font-size:10.5px;color:var(--muted);font-weight:700;">#${i + 2}</span>
                <span style="font-size:11px;color:var(--txt1);font-weight:600;">${esc(r.emp.name)}</span>
                <span style="font-size:10px;color:var(--txt2);">${r.projects} proj · ${r.workingDays}d · ${r.overtimeDays} OT · ${r.leaveDays} leave</span>
              </div>`).join('')}
          </div>
        </div>` : ''}
    </div>`;
}

// ── EMPLOYEES-PER-MONTH CHART ─────────────────────
// HR's own version of the Team Performance chart — same card shell
// and bar-chart look, but plots distinct employees who logged any
// entry that month (current year) instead of hours/views. Built
// straight from CP_TIMESHEET_DATA (already loaded), no new fetch.
// ── EMPLOYEE LEADERBOARD (by month) ───────────────
// Lists every active employee for a chosen month, ranked by the same
// four-criteria score as Employee of the Month above (reuses
// buildHREotmStats/scoreHREotm directly — one scoring system, two
// views). Replaces the old "count of active employees per month" bar
// chart with something HR can actually act on: who's pulling their
// weight this month, and who isn't showing any activity at all.
let HR_LEADERBOARD_MONTH = todayStr().slice(0, 7);

function renderHREmployeeCountChart(wrap) {
  if (!wrap) return;
  const year = new Date().getFullYear();
  const monthOptions = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const label = new Date(key + '-01').toLocaleDateString('en-IN', { month: 'long' });
    return { key, label };
  });

  wrap.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1.4rem;height:100%;box-sizing:border-box;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:1.1rem;">
        <div>
          <div style="font-size:16px;font-weight:700;color:var(--txt1);">👥 Employee Leaderboard</div>
          <div style="font-size:12px;color:var(--txt2);">Ranked by projects handled, attendance, overtime, and leaves.</div>
        </div>
        <select id="hrLeaderboardMonth" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
          color:var(--txt1);font-size:12px;padding:6px 10px;cursor:pointer;">
          ${monthOptions.map(m => `<option value="${m.key}" ${m.key === HR_LEADERBOARD_MONTH ? 'selected' : ''}>${m.label} ${year}</option>`).join('')}
        </select>
      </div>
      <div id="hrLeaderboardChart"></div>
    </div>`;

  $('hrLeaderboardMonth').addEventListener('change', e => {
    HR_LEADERBOARD_MONTH = e.target.value;
    renderHRLeaderboardList();
  });

  renderHRLeaderboardList();
}

// One bar per employee, height = that employee's score for the
// selected month (0 for "no activity" employees, same list the table
// below shows, same order — this is just the visual form of it).
function renderHRLeaderboardChart(ranked) {
  const chartEl = $('hrLeaderboardChart');
  if (!chartEl) return;

  if (!ranked.length) { chartEl.innerHTML = `<div class="chart-empty">No active employees.</div>`; return; }

  const top = ranked[0];
  const topJustification = top.score !== null
    ? `🏆 <b>${esc(top.emp.name)}</b> leads this month — ${top.projects} project${top.projects === 1 ? '' : 's'},
       ${top.workingDays} full day${top.workingDays === 1 ? '' : 's'} (9h+), ${top.overtimeDays} overtime day${top.overtimeDays === 1 ? '' : 's'},
       ${top.leaveDays} leave day${top.leaveDays === 1 ? '' : 's'}.`
    : '';

  chartEl.innerHTML = `
    ${topJustification ? `<div style="font-size:11.5px;color:var(--txt2);margin-bottom:14px;">${topJustification}</div>` : ''}
    <div style="display:flex;align-items:flex-end;justify-content:${ranked.length > 18 ? 'flex-start' : 'space-evenly'};
      gap:18px;height:280px;padding:12px 4px 0;${ranked.length > 18 ? 'overflow-x:auto;' : ''}">
      ${ranked.map((r, i) => {
        const pct = r.score !== null ? Math.round(r.score * 100) : 0;
        const barColor = i === 0 && r.score !== null ? '#fbbf24' : 'var(--a1)';
        const firstName = (r.emp.name || '').split(' ')[0];
        const tooltip = r.score !== null
          ? `${r.emp.name} — ${pct}% | ${r.projects} projects · ${r.workingDays} full days · ${r.overtimeDays} overtime · ${r.leaveDays} leaves`
          : `${r.emp.name} — no activity this month`;
        return `
          <div style="flex:1 1 0;min-width:22px;max-width:38px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;">
            <div style="font-size:10px;font-weight:700;color:var(--txt1);margin-bottom:4px;">${r.score !== null ? pct : '—'}</div>
            <div style="width:100%;background:${barColor};border-radius:3px 3px 1px 1px;
              height:${r.score !== null ? Math.max(3, pct * 2.2) : 2}px;transition:height .3s ease;"
              title="${esc(tooltip)}"></div>
            <div style="font-size:9.5px;color:var(--txt2);margin-top:6px;white-space:nowrap;overflow:hidden;
              text-overflow:ellipsis;max-width:38px;" title="${esc(tooltip)}">${esc(firstName)}</div>
          </div>`;
      }).join('')}
    </div>`;
}

function renderHRLeaderboardList() {
  const stats = buildHREotmStats(HR_LEADERBOARD_MONTH, false); // false = include zero-activity employees too
  const ranked = scoreHREotm(stats);
  renderHRLeaderboardChart(ranked);
}

// Simple headcount strip — active vs inactive, and a per-team count.
// Built straight from CP_EMPLOYEES (already loaded), nothing new
// fetched.
function renderHRHeadcountRow(wrap) {
  if (!wrap) return;
  const employees = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES);
  const active   = employees.filter(e => e.active !== false).length;
  const inactive = employees.length - active;

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
      // Employees list just changed — clear the cached getMasterData
      // response so the next load (any portal) picks up the new
      // employee instead of serving a stale cached list.
      if (typeof clearMasterDataCache === 'function') clearMasterDataCache();

      toast('s', 'Employee created', `${name} (${id}) can now log in.`);
      renderHRAddEmployeeTab($('hrTabContent')); // reset form, next suggested ID
    } catch(e) {
      err.textContent = e.message || 'Failed to create employee.';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Create Employee';
    }
  });
}

// ══════════════════════════════════════════════════
// MANAGE EMPLOYEES — edit an existing employee's team, ID, password,
// and Active/In-Active status. Reuses the exact same lookup-by-name
// convention Code.gs's updateEmployeeRecord already enforces (see
// that function's comments) — this UI is just a form in front of it.
// The Employee ID field is pre-filled with the current ID (editable
// directly, e.g. to correct a typo) — only sent as a change if it
// actually differs from what it started as. Password is a separate
// opt-in "New Password" field (blank = keep existing); the backend
// only requires both to be non-blank when reactivating a legacy row
// that currently has no login credentials at all, and reports that
// as a normal error message if needed but left blank.
// ══════════════════════════════════════════════════
function renderHRManageEmployeesTab(content) {
  const employees = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES)
    .slice()
    .sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1) || (a.name || '').localeCompare(b.name || ''));

  content.innerHTML = `
    <div style="margin-bottom:1.1rem;">
      <div style="font-size:16px;font-weight:700;color:var(--txt1);">✏️ Manage Employees</div>
      <div style="font-size:12px;color:var(--txt2);">Edit team or toggle Active / In-Active. Reactivating a row with no Employee ID/Password on file will ask you to set one.</div>
    </div>
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
      ${employees.map((emp, i) => `
        <div class="hr-manage-row" data-name="${esc(emp.name)}" style="padding:12px 16px;${i > 0 ? 'border-top:1px solid var(--border);' : ''}
          display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
          <div style="min-width:160px;flex:1 1 160px;">
            <div style="font-size:13px;font-weight:700;color:var(--txt1);">${esc(emp.name)}</div>
            <div style="font-size:10.5px;color:var(--txt2);">${esc(emp.id)}</div>
          </div>
          <div style="flex:0 0 140px;">
            <label style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:3px;">Team</label>
            <input type="text" class="hr-manage-team" value="${esc(emp.team || '')}" style="width:100%;box-sizing:border-box;
              background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:12px;padding:6px 8px;"/>
          </div>
          <div style="flex:0 0 130px;">
            <label style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:3px;">Status</label>
            <select class="hr-manage-status" style="width:100%;box-sizing:border-box;
              background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:12px;padding:6px 8px;">
              <option value="Active" ${emp.active !== false ? 'selected' : ''}>Active</option>
              <option value="Inactive" ${emp.active === false ? 'selected' : ''}>In-Active</option>
            </select>
          </div>
          <div style="flex:0 0 120px;">
            <label style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:3px;">Employee ID</label>
            <input type="text" class="hr-manage-newid" value="${esc(emp.id && !String(emp.id).startsWith('INACTIVE-') ? emp.id : '')}" placeholder="required to activate" style="width:100%;box-sizing:border-box;
              background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:12px;padding:6px 8px;"/>
          </div>
          <div style="flex:0 0 100px;">
            <label style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:3px;" title="How many past days this employee can log/edit entries for. Default is 2 for everyone — raise it for someone who needs to catch up on a backlog.">Entry Window</label>
            <input type="number" min="1" max="60" class="hr-manage-daysback" value="${emp.extendedDaysBack ? emp.extendedDaysBack : ''}" placeholder="2 (default)" style="width:100%;box-sizing:border-box;
              background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:12px;padding:6px 8px;"/>
          </div>
          <div style="flex:0 0 120px;">
            <label style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;display:block;margin-bottom:3px;">New Password</label>
            <input type="text" class="hr-manage-newpw" placeholder="optional" style="width:100%;box-sizing:border-box;
              background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--txt1);font-size:12px;padding:6px 8px;"/>
          </div>
          <button class="hr-manage-save" style="background:var(--a1);color:#fff;border:none;border-radius:6px;
            padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;align-self:flex-end;">Save</button>
          <div class="hr-manage-err" style="display:none;font-size:11px;color:#f87171;flex-basis:100%;"></div>
        </div>`).join('')}
    </div>
  `;

  content.querySelectorAll('.hr-manage-row').forEach(row => {
    row.querySelector('.hr-manage-save').addEventListener('click', async () => {
      const originalName = row.dataset.name;
      const team   = row.querySelector('.hr-manage-team').value.trim();
      const status = row.querySelector('.hr-manage-status').value;
      const newId  = row.querySelector('.hr-manage-newid').value.trim();
      const newPw  = row.querySelector('.hr-manage-newpw').value.trim();
      const extendedDaysBack = row.querySelector('.hr-manage-daysback').value.trim();
      const errEl  = row.querySelector('.hr-manage-err');
      const btn    = row.querySelector('.hr-manage-save');
      errEl.style.display = 'none';

      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const result = await apiUpdateEmployeeRecord({
          role: 'hr', originalName, team, status, newId, newPw, extendedDaysBack,
        });

        // Reflect locally so the list doesn't need a full reload.
        const employees = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : HR_EMPLOYEES);
        const localEmp = employees.find(e => e.name === originalName);
        if (localEmp) {
          localEmp.team = team;
          localEmp.active = status === 'Active';
          localEmp.extendedDaysBack = parseInt(extendedDaysBack, 10) || 0;
          if (result.name) localEmp.name = result.name;
        }
        // Employee record just changed — clear the cached
        // getMasterData response, same reasoning as createEmployee.
        if (typeof clearMasterDataCache === 'function') clearMasterDataCache();

        toast('s', 'Employee updated', `${originalName} · ${status === 'Active' ? 'Active' : 'In-Active'}`);
        renderHRManageEmployeesTab($('hrTabContent'));
      } catch (e) {
        errEl.textContent = e.message || 'Failed to update.';
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Save';
      }
    });
  });
}