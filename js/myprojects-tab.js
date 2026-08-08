// ═══════════════════════════════════════════════════
// MYPROJECTS-TAB.JS — "My Projects" tab, employee's own portal.
//
// Cards only, per spec — one card per project this employee has
// worked on, showing:
//   1. Project Name and ID
//   2. Start Date / End Date
//   3. Manager Note / Team Leader Note
//   4. This employee's own Days worked / Hours worked on it
//
// Detail drill-down ("View Details") shows day-by-day notes, a
// month-by-month summary, a task-by-task time breakdown, and two
// report downloads (This Month / Overall).
//
// Data sources:
//   - Project master fields (Name/ID/dates/notes) via the existing
//     'getProjectMasterList' action, called with role:'employee' —
//     Code.gs now strips Project Constant/Value for any role other
//     than 'manager' (deny-by-default), so this is safe to call from
//     here without any risk of leaking financial data.
//   - This employee's own all-time history via apiGetAllHistory,
//     reusing chart.js's MY_PROJECTS_CACHE if it's already been
//     populated (avoids a duplicate fetch).
// ═══════════════════════════════════════════════════

let MYPROJ_MASTER_CACHE = null;

function initMyProjectsTab() {
  const tabsBar = document.getElementById('empTabs');
  if (!tabsBar) return;

  tabsBar.querySelectorAll('.emp-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.empTab;

      tabsBar.querySelectorAll('.emp-tab-btn').forEach(b => {
        const active = b === btn;
        b.style.color        = active ? 'var(--a1)' : 'var(--muted)';
        b.style.borderBottom = active ? '2px solid var(--a1)' : '2px solid transparent';
      });

      const tsPanel    = document.getElementById('empTabTimesheet');
      const projPanel  = document.getElementById('empTabProjects');
      const attPanel   = document.getElementById('empTabAttendance');
      if (tsPanel)   tsPanel.style.display   = tab === 'timesheet'   ? '' : 'none';
      if (projPanel) projPanel.style.display = tab === 'projects'    ? '' : 'none';
      if (attPanel)  attPanel.style.display  = tab === 'attendance'  ? '' : 'none';

      if (tab === 'projects')    loadMyProjectsTab();
      if (tab === 'attendance')  loadMyAttendanceTab();
    });
  });
}

async function loadMyProjectsTab() {
  const container = document.getElementById('myProjCardsContainer');
  if (!container) return;

  container.innerHTML = `<div class="slot-loading"><div class="slot-spinner"></div><span>Loading…</span></div>`;

  try {
    const [master, history] = await Promise.all([
      MYPROJ_MASTER_CACHE ? Promise.resolve(MYPROJ_MASTER_CACHE)
        : sheetGET({ action: 'getProjectMasterList', role: 'employee' }),
      (typeof MY_PROJECTS_CACHE !== 'undefined' && MY_PROJECTS_CACHE) ? Promise.resolve(MY_PROJECTS_CACHE)
        : apiGetAllHistory(USER.id),
    ]);
    MYPROJ_MASTER_CACHE = master;
    if (typeof MY_PROJECTS_CACHE !== 'undefined') MY_PROJECTS_CACHE = history; // keep chart.js's cache in sync too

    renderMyProjectCards(container, master, history);
  } catch (err) {
    container.innerHTML = `<div class="slot-error">Failed to load: ${err.message}</div>`;
  }
}

function renderMyProjectCards(container, master, history) {
  const worked = (history || []).filter(e => e.status !== 'Leave' && e.project);
  if (!worked.length) {
    container.innerHTML = `<div class="chart-empty">You haven't logged hours against any project yet.</div>`;
    return;
  }

  const byProjectName = {};
  worked.forEach(e => {
    if (!byProjectName[e.project]) byProjectName[e.project] = { hours: 0, days: new Set() };
    byProjectName[e.project].hours += Number(e.hours) || 0;
    byProjectName[e.project].days.add(e.date);
  });

  const projectNames = Object.keys(byProjectName)
    .sort((a, b) => byProjectName[b].hours - byProjectName[a].hours);

  const blocksHtml = projectNames.map(name => {
    const stats = byProjectName[name];
    const proj  = (master || []).find(p => p.projectName === name);
    return buildMyProjectCard(name, proj, stats);
  }).join('');

  // Single column, full-width blocks — not a card grid.
  container.innerHTML = `<div>${blocksHtml}</div>`;

  container.querySelectorAll('.myproj-view-btn').forEach(btn => {
    btn.addEventListener('click', () => openMyProjectDetail(btn.dataset.project));
  });
}

function buildMyProjectCard(projectName, proj, stats) {
  const initials  = (projectName || '?').trim().slice(0, 2).toUpperCase();
  const projectId = proj?.projectId || '—';
  const startDate = fmtMyProjDate(proj?.startDate);
  const endDate   = fmtMyProjDate(proj?.endDate);
  const mgrNote   = (proj?.managerNotes || '').trim()    || 'No notes yet';
  const tlNote    = (proj?.teamLeaderNotes || '').trim() || 'No notes yet';
  const days      = stats.days.size;
  const hours     = fmtMyProjHours(stats.hours);

  // One full-width horizontal block per project — everything on one
  // row (identity, dates, days/hours, View Details), notes as a
  // secondary row underneath. Replaces the earlier card grid.
  return `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;
      padding:1rem 1.2rem;margin-bottom:1rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;">
        <div style="display:flex;align-items:center;gap:10px;min-width:180px;flex:1 1 220px;">
          <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--a1),#7c5cfc);
            display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px;color:#fff;flex-shrink:0;">${esc(initials)}</div>
          <div style="min-width:0;">
            <div style="font-weight:700;font-size:14px;color:var(--txt1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(projectName)}">${esc(projectName)}</div>
            <div style="font-size:11px;color:var(--txt2);">${esc(projectId)}</div>
          </div>
        </div>

        <div style="display:flex;gap:22px;flex-wrap:wrap;">
          <div>
            <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">Start</div>
            <div style="font-size:12.5px;font-weight:700;color:var(--txt1);white-space:nowrap;">${esc(startDate)}</div>
          </div>
          <div>
            <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">End</div>
            <div style="font-size:12.5px;font-weight:700;color:var(--txt1);white-space:nowrap;">${esc(endDate)}</div>
          </div>
          <div>
            <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">Days</div>
            <div style="font-size:12.5px;font-weight:700;color:var(--txt1);">${days}</div>
          </div>
          <div>
            <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">Hours</div>
            <div style="font-size:12.5px;font-weight:700;color:var(--a1);white-space:nowrap;">${esc(hours)}</div>
          </div>
        </div>

        <button class="myproj-view-btn" data-project="${esc(projectName)}" style="background:var(--a1);color:#fff;border:none;
          border-radius:8px;padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">
          View Details →
        </button>
      </div>

      <div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:.85rem;padding-top:.75rem;border-top:1px solid var(--border);">
        <div style="flex:1 1 200px;min-width:180px;">
          <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">Manager Note</div>
          <div style="font-size:11.5px;color:var(--txt1);">${esc(mgrNote)}</div>
        </div>
        <div style="flex:1 1 200px;min-width:180px;">
          <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">Team Leader Note</div>
          <div style="font-size:11.5px;color:var(--txt1);">${esc(tlNote)}</div>
        </div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// PROJECT DETAIL — reached via "View Details" on a card. Shows this
// employee's own day-by-day notes, a month-by-month summary, a
// task-by-task time breakdown for one project, plus two report
// downloads (This Month / Overall), same print-to-PDF pattern used
// on the Manager/TL side — no PDF library, just a clean printable
// HTML page and the browser's own Print → Save as PDF.
// ══════════════════════════════════════════════════════════════

// This employee's own entries for one project, grouped by date —
// hours summed and notes collected per day. Independent of the
// per-project TOTALS already computed in renderMyProjectCards, since
// the detail page needs the full day-by-day breakdown, not just a
// grand total.
function getMyProjectDailyLog(projectName) {
  const history = (typeof MY_PROJECTS_CACHE !== 'undefined' && MY_PROJECTS_CACHE) || [];
  const byDate = {};
  history.forEach(e => {
    if (e.project !== projectName || !e.date) return;
    if (!byDate[e.date]) byDate[e.date] = { hours: 0, notes: [], timeIns: [], timeOuts: [], isLeave: false };

    if (e.status === 'Leave') {
      byDate[e.date].isLeave = true;
      return; // Leave entries carry no check-in/out or worked hours
    }
    byDate[e.date].hours += Number(e.hours) || 0;
    if (e.notes && e.notes.trim()) byDate[e.date].notes.push(e.notes.trim());
    if (e.timeIn)  byDate[e.date].timeIns.push(e.timeIn);
    if (e.timeOut) byDate[e.date].timeOuts.push(e.timeOut);
  });

  // Earliest Check-In / latest Check-Out per day — the exact same
  // convention already used by the Manager Attendance module
  // (cpGetEmpDayAttendance in Client-Project.js), just applied here
  // scoped to one project instead of an employee's whole day.
  Object.values(byDate).forEach(d => {
    d.checkIn  = d.timeIns.sort()[0] || null;
    d.checkOut = d.timeOuts.sort().pop() || null;
  });

  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a)); // most recent first
  return { byDate, dates };
}

function fmtMyProj12(t) {
  if (!t) return '--:--';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function getMyProjectMonthlySummary(byDate, dates) {
  const byMonth = {};
  dates.forEach(date => {
    const m = date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + byDate[date].hours;
  });
  return Object.keys(byMonth).sort().reverse().map(m => ({ month: m, hours: byMonth[m] }));
}

// How much time was spent on each distinct Task within this project.
// Optionally scoped to a date range (fromDate/toDate inclusive) — the
// on-screen detail view shows all-time (no range given), while the
// printable report scopes this to whatever period it's reporting on,
// same as the existing Daily Log does there.
function getMyProjectTaskBreakdown(projectName, fromDate, toDate) {
  const history = (typeof MY_PROJECTS_CACHE !== 'undefined' && MY_PROJECTS_CACHE) || [];
  const byTask = {}; // task -> { hours, byDate: { date: hours } }
  history.forEach(e => {
    if (e.project !== projectName || e.status === 'Leave' || !e.date) return;
    if (fromDate && e.date < fromDate) return;
    if (toDate && e.date > toDate) return;
    const task = (e.task && e.task.trim()) || 'Unspecified';
    const h = Number(e.hours) || 0;
    if (!byTask[task]) byTask[task] = { hours: 0, byDate: {} };
    byTask[task].hours += h;
    byTask[task].byDate[e.date] = (byTask[task].byDate[e.date] || 0) + h; // same task can span multiple dates (and multiple slots on one date) — summed per date here
  });
  return Object.entries(byTask)
    .map(([task, data]) => ({
      task, hours: data.hours,
      dateEntries: Object.entries(data.byDate)
        .map(([date, hours]) => ({ date, hours }))
        .sort((a, b) => b.date.localeCompare(a.date)), // most recent date first
    }))
    .sort((a, b) => b.hours - a.hours);
}

function fmtMyProjMonthLabel(monthKey) {
  return new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function openMyProjectDetail(projectName) {
  const container = document.getElementById('myProjCardsContainer');
  if (!container) return;

  const proj = (MYPROJ_MASTER_CACHE || []).find(p => p.projectName === projectName);
  const { byDate, dates } = getMyProjectDailyLog(projectName);
  const monthly = getMyProjectMonthlySummary(byDate, dates);
  const maxMonthHours = Math.max(...monthly.map(m => m.hours), 0.01);

  const taskBreakdown = getMyProjectTaskBreakdown(projectName); // all-time, on-screen view
  const maxTaskHours = Math.max(...taskBreakdown.map(t => t.hours), 0.01);

  const monthRows = monthly.length ? monthly.map((m, i) => {
    const pct = Math.max((m.hours / maxMonthHours) * 100, 2);
    const isLast = i === monthly.length - 1;
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:8px 0;${isLast ? '' : 'border-bottom:1px solid var(--border);'}">
        <span style="flex:0 0 92px;font-size:12px;font-weight:700;color:var(--txt1);">${esc(fmtMyProjMonthLabel(m.month))}</span>
        <div style="flex:1;height:11px;background:var(--surface2);border-radius:6px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:var(--a1);border-radius:6px;"></div>
        </div>
        <span style="flex:0 0 64px;text-align:right;font-size:12px;font-weight:700;color:var(--txt1);">${esc(fmtMyProjHours(m.hours))}</span>
      </div>`;
  }).join('') : `<div style="font-size:12px;color:var(--txt2);">No activity yet.</div>`;

  const taskRows = taskBreakdown.length ? taskBreakdown.map((t, i) => {
    const pct = Math.max((t.hours / maxTaskHours) * 100, 2);
    const isLast = i === taskBreakdown.length - 1;
    const dateRowsHtml = t.dateEntries.map(d => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0 5px 24px;font-size:11px;">
        <span style="color:var(--txt2);">📅 ${esc(fmtMyProjDate(d.date))}</span>
        <span style="font-weight:600;color:var(--txt1);">${esc(fmtMyProjHours(d.hours))}</span>
      </div>`).join('');
    // Visible proof, not just a claim: this re-sums the exact rows
    // shown above and displays it right here, so it can be checked by
    // eye against the task's header total (${esc(fmtMyProjHours(t.hours))}) without doing the math yourself.
    const dateSumCheck = t.dateEntries.reduce((s, d) => s + d.hours, 0);
    const sumRowHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0 2px 24px;
        margin-top:4px;border-top:1px dashed var(--border);font-size:11px;">
        <span style="color:var(--txt2);font-weight:600;">Total of dates above</span>
        <span style="font-weight:700;color:var(--a1);">${esc(fmtMyProjHours(dateSumCheck))}</span>
      </div>`;
    return `
      <details style="padding:8px 0;${isLast ? '' : 'border-bottom:1px solid var(--border);'}">
        <summary style="display:flex;align-items:center;gap:12px;cursor:pointer;">
          <span style="flex:0 0 14px;font-size:9px;color:var(--txt2);">▸</span>
          <span style="flex:0 0 130px;font-size:12px;font-weight:700;color:var(--txt1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(t.task)}">${esc(t.task)}</span>
          <div style="flex:1;height:11px;background:var(--surface2);border-radius:6px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:var(--a1);border-radius:6px;"></div>
          </div>
          <span style="flex:0 0 64px;text-align:right;font-size:12px;font-weight:700;color:var(--txt1);">${esc(fmtMyProjHours(t.hours))}</span>
          <span style="flex:0 0 50px;text-align:right;font-size:10px;color:var(--txt2);">${t.dateEntries.length} date${t.dateEntries.length !== 1 ? 's' : ''}</span>
        </summary>
        <div style="margin-top:2px;">${dateRowsHtml}${sumRowHtml}</div>
      </details>`;
  }).join('') : `<div style="font-size:12px;color:var(--txt2);">No activity yet.</div>`;

  const dailyRows = dates.length ? dates.map((date, i) => {
    const d = byDate[date];
    const isLast = i === dates.length - 1;

    const timeLine = d.isLeave
      ? `<span style="font-size:11px;font-weight:700;color:#fb923c;">🏖 Leave</span>`
      : (d.checkIn && d.checkOut)
        ? `<span style="font-size:11px;color:var(--txt2);">${esc(fmtMyProj12(d.checkIn))} → ${esc(fmtMyProj12(d.checkOut))}</span>`
        : `<span style="font-size:11px;color:var(--txt2);">—</span>`;

    const hoursLine = d.isLeave
      ? `<span style="font-size:12.5px;font-weight:800;color:#fb923c;">—</span>`
      : `<span style="font-size:12.5px;font-weight:800;color:#34d399;">${esc(fmtMyProjHours(d.hours))}</span>`;

    return `
      <div style="padding:8px 0;${isLast ? '' : 'border-bottom:1px solid var(--border);'}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;gap:8px;">
          <span style="font-size:12px;font-weight:700;color:var(--txt1);">${esc(fmtMyProjDate(date))}</span>
          ${hoursLine}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          ${timeLine}
          <div style="font-size:11px;color:var(--txt2);text-align:right;">${esc(d.notes.join(' · ') || (d.isLeave ? '' : 'No notes'))}</div>
        </div>
      </div>`;
  }).join('') : `<div style="font-size:12px;color:var(--txt2);">No entries yet.</div>`;

  const mgrNote = (proj?.managerNotes || '').trim();
  const tlNote  = (proj?.teamLeaderNotes || '').trim();

  container.innerHTML = `
    <button id="myProjBackBtn" class="cp-back-btn" style="margin-bottom:1rem;">← Back</button>

    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:14px;padding:1.2rem;margin-bottom:1.1rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:1rem;">
        <div>
          <div style="font-weight:700;font-size:17px;color:var(--txt1);">${esc(projectName)}</div>
          <div style="font-size:11.5px;color:var(--txt2);">${esc(proj?.projectId || '—')}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="myProjReportMonth" class="cp-btn-ghost">📥 This Month</button>
          <button id="myProjReportOverall" class="cp-btn-ghost">📥 Overall Report</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="background:var(--surface2);border-radius:8px;padding:8px 10px;">
          <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">Start Date</div>
          <div style="font-size:12.5px;font-weight:700;color:var(--txt1);">${esc(fmtMyProjDate(proj?.startDate))}</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:8px 10px;">
          <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">End Date</div>
          <div style="font-size:12.5px;font-weight:700;color:var(--txt1);">${esc(fmtMyProjDate(proj?.endDate))}</div>
        </div>
      </div>
    </div>

    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:14px;padding:1.2rem;margin-bottom:1.1rem;">
      <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.9rem;">🗒️ Notes</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;">Manager Notes</div>
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;
            font-size:12.5px;color:${mgrNote ? 'var(--txt1)' : 'var(--txt2)'};font-style:${mgrNote ? 'normal' : 'italic'};min-height:20px;">
            ${esc(mgrNote || 'No notes yet')}
          </div>
        </div>
        <div>
          <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;">Team Leader Notes</div>
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;
            font-size:12.5px;color:${tlNote ? 'var(--txt1)' : 'var(--txt2)'};font-style:${tlNote ? 'normal' : 'italic'};min-height:20px;">
            ${esc(tlNote || 'No notes yet')}
          </div>
        </div>
      </div>
    </div>

    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:14px;padding:1.2rem;margin-bottom:1.1rem;">
      <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.9rem;">📅 Monthly Summary</div>
      ${monthRows}
    </div>

    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:14px;padding:1.2rem;margin-bottom:1.1rem;">
      <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.9rem;">🧩 Task Breakdown</div>
      ${taskRows}
    </div>

    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:14px;padding:1.2rem;">
      <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.9rem;">📝 Daily Notes</div>
      ${dailyRows}
    </div>
  `;

  document.getElementById('myProjBackBtn').addEventListener('click', () => {
    renderMyProjectCards(container, MYPROJ_MASTER_CACHE, MY_PROJECTS_CACHE);
  });
  document.getElementById('myProjReportMonth').addEventListener('click', () => downloadMyProjectReport(projectName, proj, 'month'));
  document.getElementById('myProjReportOverall').addEventListener('click', () => downloadMyProjectReport(projectName, proj, 'overall'));
}

// Opens a new tab with a clean printable report and triggers the
// browser's own Print dialog — "Save as PDF" is a built-in
// destination on every major browser. Same approach as the Manager/
// TL Project Report, just scoped to this one employee's own entries.
function downloadMyProjectReport(projectName, proj, mode) {
  const win = window.open('', '_blank');
  if (!win) {
    toast?.('e', 'Popup blocked', 'Please allow popups for this site, then try again.');
    return;
  }
  win.document.open();
  win.document.write(buildMyProjectReportHTML(projectName, proj, mode));
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 400);
}

function buildMyProjectReportHTML(projectName, proj, mode) {
  const { byDate, dates } = getMyProjectDailyLog(projectName);
  const today = todayStr();

  let fromDate, toDate, periodLabel, reportTypeLabel;
  if (mode === 'month') {
    const m = today.slice(0, 7);
    fromDate = m + '-01';
    toDate   = today;
    periodLabel = fmtMyProjMonthLabel(m);
    reportTypeLabel = 'Monthly Report';
  } else {
    let earliest = dates.length ? dates[dates.length - 1] : null; // dates sorted desc -> last is earliest
    if (proj?.startDate && (!earliest || proj.startDate < earliest)) earliest = proj.startDate;
    fromDate = earliest || today;
    toDate   = today;
    periodLabel = `${fmtMyProjDate(fromDate)} – ${fmtMyProjDate(toDate)}`;
    reportTypeLabel = 'Overall Report';
  }

  const rangeDates  = dates.filter(d => d >= fromDate && d <= toDate).sort(); // chronological for the report
  const totalHours  = rangeDates.reduce((s, d) => s + byDate[d].hours, 0);
  const totalDays   = rangeDates.filter(d => !byDate[d].isLeave).length; // Leave dates are now included in byDate for the attendance display, so this must exclude them explicitly
  const empName     = (typeof USER !== 'undefined' && USER?.name) || '';

  // Same task-by-task breakdown as the on-screen detail view, but
  // scoped to this report's exact period rather than all-time.
  const taskBreakdown = getMyProjectTaskBreakdown(projectName, fromDate, toDate);

  const logRows = rangeDates.length ? rangeDates.map(d => {
    const rec = byDate[d];
    const timeCell = rec.isLeave ? 'Leave' : (rec.checkIn && rec.checkOut ? `${fmtMyProj12(rec.checkIn)} – ${fmtMyProj12(rec.checkOut)}` : '—');
    const hoursCell = rec.isLeave ? '—' : fmtMyProjHours(rec.hours);
    return `
    <tr>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;white-space:nowrap;">${esc(fmtMyProjDate(d))}</td>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;white-space:nowrap;">${esc(timeCell)}</td>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;text-align:right;white-space:nowrap;">${esc(hoursCell)}</td>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;">${esc(rec.notes.join(' · ') || '—')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="4" style="padding:10px;color:#64748b;">No activity logged during this period.</td></tr>`;

  const taskRowsPrint = taskBreakdown.length ? taskBreakdown.map(t => {
    const taskRow = `
    <tr>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;font-weight:700;">${esc(t.task)}</td>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;text-align:right;font-weight:700;white-space:nowrap;">${esc(fmtMyProjHours(t.hours))}</td>
    </tr>`;
    // A print report can't have click-to-expand, so the date-level
    // breakdown (the "multiple parts" that made up this task's total)
    // is shown directly as indented sub-rows instead.
    const dateSubRows = t.dateEntries.map(d => `
    <tr>
      <td style="padding:3px 9px 3px 24px;border:1px solid #e2e8f0;color:#64748b;font-size:10.5px;">${esc(fmtMyProjDate(d.date))}</td>
      <td style="padding:3px 9px;border:1px solid #e2e8f0;text-align:right;color:#64748b;font-size:10.5px;white-space:nowrap;">${esc(fmtMyProjHours(d.hours))}</td>
    </tr>`).join('');
    return taskRow + dateSubRows;
  }).join('') : `<tr><td colspan="2" style="padding:10px;color:#64748b;">No task data for this period.</td></tr>`;

  const summaryText = totalDays
    ? `Over this period, ${empName} logged ${fmtMyProjHours(totalHours)} across ${totalDays} day${totalDays !== 1 ? 's' : ''} on ${projectName}.`
    : `No activity was logged on ${projectName} during this period.`;

  const genStamp = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>${esc(projectName)} — ${esc(reportTypeLabel)}</title>
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
  table { border-collapse:collapse; width:100%; font-size:11.5px; }
  .footer { margin-top:30px; font-size:10.5px; color:#94a3b8; text-align:right; }
  @media print {
    body { background:#fff; padding:0; }
    .sheet { box-shadow:none; border-radius:0; max-width:100%; padding:0; }
  }
</style>
</head>
<body>
  <div class="sheet">
    <h1>${esc(projectName)}</h1>
    <div class="sub">${esc(reportTypeLabel)} · ${esc(proj?.projectId || '—')} · ${esc(empName)}</div>

    <div class="infobar">
      <div><b>Report Type</b>${esc(reportTypeLabel)}</div>
      <div><b>Period</b>${esc(periodLabel)}</div>
      <div><b>Total Hours</b>${esc(fmtMyProjHours(totalHours))}</div>
      <div><b>Days Worked</b>${totalDays}</div>
    </div>

    <h2>Task Breakdown</h2>
    <table>
      <thead>
        <tr style="background:#eef2ff;">
          <th style="text-align:left;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Task</th>
          <th style="text-align:right;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Hours</th>
        </tr>
      </thead>
      <tbody>${taskRowsPrint}</tbody>
    </table>

    <h2>Daily Log</h2>
    <table>
      <thead>
        <tr style="background:#eef2ff;">
          <th style="text-align:left;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Date</th>
          <th style="text-align:left;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Check-In → Check-Out</th>
          <th style="text-align:right;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Hours</th>
          <th style="text-align:left;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Notes</th>
        </tr>
      </thead>
      <tbody>${logRows}</tbody>
    </table>

    <h2>Summary</h2>
    <div style="font-size:12.5px;color:#334155;line-height:1.6;">${esc(summaryText)}</div>

    <div class="footer">Generated ${esc(genStamp)}</div>
  </div>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════
// MY ATTENDANCE — calendar-grid view (dates as columns), Employee
// portal's own version of the Manager Attendance grid.
//
// Status/permission logic is the SAME convention as the Manager
// grid (cpGetEmpDayAttendance / getEmpDayStatus in Client-Project.js
// — worked/leave/holiday/weekend/no-entry, FULL_DAY_HOURS = 9 for
// Permission Hours). It's re-expressed here rather than called
// directly because those functions read CP_TIMESHEET_DATA/
// CP_EMPLOYEES, which are Manager/Team-Leader-portal globals not
// populated on the Employee portal — this reads MY_PROJECTS_CACHE
// instead (this employee's own history, already fetched for the
// My Projects tab). Same rules, same FULL_DAY_HOURS baseline, no
// new calculation invented.
// ══════════════════════════════════════════════════════════════

const MYATT_FULL_DAY_HOURS = 9; // must match FULL_DAY_HOURS in Client-Project.js's renderAttendanceGrid()
// Same threshold/badge as the Timesheet table (table.js's
// OVERTIME_THRESHOLD_HOURS) — kept as its own constant here since
// this file doesn't share scope with table.js, but the value and
// meaning must stay identical: a day's worked hours (Leave excluded)
// past this counts as overtime.
const MYATT_OVERTIME_THRESHOLD_HOURS = 9;
const MYATT_MONTH_FLOOR = '2026-07'; // earliest month offered in the dropdown — matches CP_ATTEND_MONTH_FLOOR
let MYATT_RANGE_MODE  = '15days'; // '15days' | 'month'
let MYATT_MONTH       = '';       // 'YYYY-MM', used when MYATT_RANGE_MODE === 'month'

function loadMyAttendanceTab() {
  const bar = document.getElementById('myAttendRangeBar');
  const tod = todayStr();
  if (!MYATT_MONTH) MYATT_MONTH = tod.slice(0, 7) < MYATT_MONTH_FLOOR ? MYATT_MONTH_FLOOR : tod.slice(0, 7);

  if (bar && !bar.dataset.wired) {
    // Months from the floor up through the current month, newest
    // first — same convention as the Manager grid's Month Wise picker.
    const monthOptions = [];
    const [fy, fm] = MYATT_MONTH_FLOOR.split('-').map(Number);
    const [ty, tm] = tod.slice(0, 7).split('-').map(Number);
    const cur = new Date(ty, tm - 1, 1);
    const floor = new Date(fy, fm - 1, 1);
    while (cur >= floor) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
      monthOptions.push({ key, label: cur.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) });
      cur.setMonth(cur.getMonth() - 1);
    }

    bar.innerHTML = `
      <button id="myAttendR15" class="cp-btn-ghost">Last 15 Days</button>
      <button id="myAttendRMonth" class="cp-btn-ghost">Month Wise</button>
      <select id="myAttendMonthSelect" style="display:${MYATT_RANGE_MODE === 'month' ? '' : 'none'};
        background:var(--surface2);border:1px solid var(--border);border-radius:6px;
        color:var(--txt1);font-size:12px;padding:6px 8px;cursor:pointer;">
        ${monthOptions.map(m => `<option value="${m.key}" ${m.key === MYATT_MONTH ? 'selected' : ''}>${m.label}</option>`).join('')}
      </select>`;
    bar.dataset.wired = '1';
    bar.querySelector('#myAttendR15').addEventListener('click', () => {
      MYATT_RANGE_MODE = '15days';
      bar.querySelector('#myAttendMonthSelect').style.display = 'none';
      renderMyAttendanceGrid();
    });
    bar.querySelector('#myAttendRMonth').addEventListener('click', () => {
      MYATT_RANGE_MODE = 'month';
      bar.querySelector('#myAttendMonthSelect').style.display = '';
      renderMyAttendanceGrid();
    });
    bar.querySelector('#myAttendMonthSelect').addEventListener('change', e => {
      MYATT_MONTH = e.target.value;
      renderMyAttendanceGrid();
    });
  }

  // Ensure this employee's history is loaded — reuse the same cache
  // My Projects populates, so switching tabs never double-fetches.
  const haveCache = typeof MY_PROJECTS_CACHE !== 'undefined' && MY_PROJECTS_CACHE;
  if (haveCache) { renderMyAttendanceGrid(); return; }

  const wrap = document.getElementById('myAttendGridWrap');
  if (wrap) wrap.innerHTML = `<div class="slot-loading"><div class="slot-spinner"></div><span>Loading…</span></div>`;
  apiGetAllHistory(USER.id).then(history => {
    if (typeof MY_PROJECTS_CACHE !== 'undefined') MY_PROJECTS_CACHE = history;
    renderMyAttendanceGrid();
  }).catch(err => {
    if (wrap) wrap.innerHTML = `<div class="slot-error">Failed to load: ${err.message}</div>`;
  });
}

// Same convention as getEmpDayStatus() in Client-Project.js: worked
// takes priority, then Leave, then Holiday, then Weekend, then
// No Entry — applied here against this employee's own entries only.
function myAttendGetDayStatus(dateStr) {
  const history    = (typeof MY_PROJECTS_CACHE !== 'undefined' && MY_PROJECTS_CACHE) || [];
  const dayEntries = history.filter(e => e.date === dateStr);
  const dow        = new Date(dateStr + 'T00:00:00').getDay(); // 0 = Sun, 6 = Sat
  const isWeekend  = dow === 0 || dow === 6;
  const hasLeave   = dayEntries.some(e => e.status === 'Leave');
  const hasHoliday = dayEntries.some(e => e.status === 'Holiday');
  const worked     = dayEntries.filter(e => e.status !== 'Leave' && e.status !== 'Holiday');

  if (worked.length) {
    const timesIn  = worked.map(e => e.timeIn).filter(Boolean).sort();
    const timesOut = worked.map(e => e.timeOut).filter(Boolean).sort();
    const hours    = worked.reduce((s, e) => s + (Number(e.hours) || 0), 0);
    return {
      kind: 'worked', hasLeave,
      checkIn: timesIn[0] || null,
      checkOut: timesOut[timesOut.length - 1] || null,
      hours,
      permissionHours: hours < MYATT_FULL_DAY_HOURS ? (MYATT_FULL_DAY_HOURS - hours) : 0,
    };
  }
  if (hasLeave)   return { kind: 'leave' };
  if (hasHoliday) return { kind: 'holiday' };
  if (isWeekend)  return { kind: 'weekend' };
  if (dateStr > todayStr()) return { kind: 'upcoming' };
  return { kind: 'not_logged' };
}

function myAttendGetRangeDates() {
  const tod = todayStr();
  let from, to = tod;
  if (MYATT_RANGE_MODE === 'month') {
    const [y, m] = MYATT_MONTH.split('-').map(Number);
    const lastDayOfMonth = toLocalDateStr(new Date(y, m, 0));
    from = `${MYATT_MONTH}-01`;
    to   = lastDayOfMonth > tod ? tod : lastDayOfMonth;
  } else {
    const d = new Date(tod + 'T00:00:00'); d.setDate(d.getDate() - 14);
    from = toLocalDateStr(d);
  }
  const CAP = 31; // enough for a full month, still horizontally scrollable
  const start = new Date(from + 'T00:00:00');
  const end   = new Date(to + 'T00:00:00');
  const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const renderStart = totalDays > CAP ? new Date(end.getTime() - (CAP - 1) * 86400000) : start;

  const dates = [];
  for (let d = new Date(renderStart); d <= end; d.setDate(d.getDate() + 1)) dates.push(toLocalDateStr(d));
  return dates;
}

function myAttendBuildListRow(dateStr, status, isLast) {
  const dateLabel = esc(new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }));
  const rowStyle = `padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;${isLast ? '' : 'border-bottom:1px solid var(--border);'}`;

  if (status.kind === 'worked') {
    const timeLine = (status.checkIn && status.checkOut)
      ? `${esc(fmtMyProj12(status.checkIn))} → ${esc(fmtMyProj12(status.checkOut))}`
      : '—';
    const leaveTag = status.hasLeave ? ` 🏖` : '';
    const permHtml = status.permissionHours > 0
      ? `<span style="margin-left:10px;font-size:11px;font-weight:700;color:#a78bfa;">Permission ${esc(fmtMyProjHours(status.permissionHours))}</span>`
      : '';
    const otHtml = status.hours > MYATT_OVERTIME_THRESHOLD_HOURS
      ? ` <span title="Past ${esc(fmtMyProjHours(MYATT_OVERTIME_THRESHOLD_HOURS))}" style="display:inline-block;font-size:.62rem;font-weight:700;color:#92400e;background:#fde68a;border-radius:5px;padding:1px 5px;margin-left:4px;vertical-align:middle;">⚡ OT +${esc(fmtMyProjHours(status.hours - MYATT_OVERTIME_THRESHOLD_HOURS))}</span>`
      : '';
    return `
      <div style="${rowStyle}">
        <span style="flex:0 0 110px;font-size:12.5px;font-weight:700;color:var(--txt1);">${dateLabel}</span>
        <span style="flex:1;min-width:140px;font-size:12px;color:var(--txt2);">${timeLine}${leaveTag}</span>
        <span style="font-size:13px;font-weight:800;color:#34d399;white-space:nowrap;">${esc(fmtMyProjHours(status.hours))}${otHtml}${permHtml}</span>
      </div>`;
  }
  const STATUS_STYLE = {
    leave:      { label: 'Leave',    color: '#fbbf24' },
    holiday:    { label: 'Holiday',  color: '#60a5fa' },
    weekend:    { label: 'Weekend',  color: 'var(--txt2)' },
    not_logged: { label: 'No Entry', color: '#f87171' },
    upcoming:   { label: '·',        color: 'var(--txt2)' },
  };
  const s = STATUS_STYLE[status.kind] || STATUS_STYLE.not_logged;
  return `
    <div style="${rowStyle}">
      <span style="flex:0 0 110px;font-size:12.5px;font-weight:700;color:var(--txt1);">${dateLabel}</span>
      <span style="flex:1;min-width:140px;font-size:12px;color:${s.color};font-weight:700;">${esc(s.label)}</span>
      <span style="font-size:12px;color:${s.color};">—</span>
    </div>`;
}

function renderMyAttendanceGrid() {
  const wrap = document.getElementById('myAttendGridWrap');
  const bar  = document.getElementById('myAttendRangeBar');
  if (!wrap) return;

  if (bar) {
    bar.querySelector('#myAttendR15').style.cssText    = MYATT_RANGE_MODE === '15days' ? 'background:var(--a1);color:#fff;border-color:var(--a1);' : '';
    bar.querySelector('#myAttendRMonth').style.cssText = MYATT_RANGE_MODE === 'month'  ? 'background:var(--a1);color:#fff;border-color:var(--a1);' : '';
  }

  const dates = myAttendGetRangeDates();

  // Same totals the Manager Attendance grid keeps per employee
  // (leaveDays/workingDays/totalHours/permissionHours) — computed
  // here across the visible range so Leave days are visible even
  // when they don't happen to fall in view row-by-row.
  let leaveDays = 0, workingDays = 0, totalHours = 0, permissionHours = 0;
  const statuses = dates.map(d => ({ date: d, status: myAttendGetDayStatus(d) }));
  statuses.forEach(({ status }) => {
    if (status.kind === 'worked') {
      workingDays++;
      totalHours += status.hours;
      permissionHours += status.permissionHours || 0;
      if (status.hasLeave) leaveDays++;
    } else if (status.kind === 'leave') {
      leaveDays++;
    }
  });

  const summaryHtml = `
    <div style="display:flex;gap:22px;flex-wrap:wrap;background:var(--surface1);border:1px solid var(--border);
      border-radius:12px;padding:.9rem 1.1rem;margin-bottom:.9rem;">
      <div>
        <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">Leave Days</div>
        <div style="font-size:14px;font-weight:700;color:${leaveDays > 0 ? '#fbbf24' : 'var(--txt1)'};">${leaveDays}</div>
      </div>
      <div>
        <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">Permission Hrs</div>
        <div style="font-size:14px;font-weight:700;color:${permissionHours > 0 ? '#a78bfa' : 'var(--txt1)'};">${permissionHours > 0 ? esc(fmtMyProjHours(permissionHours)) : '—'}</div>
      </div>
      <div>
        <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">Working Days</div>
        <div style="font-size:14px;font-weight:700;color:var(--txt1);">${workingDays}</div>
      </div>
      <div>
        <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">Total Hours</div>
        <div style="font-size:14px;font-weight:700;color:var(--a1);">${esc(fmtMyProjHours(totalHours))}</div>
      </div>
    </div>`;

  // Most recent date first — same convention as the Daily Notes list
  // on the My Projects detail page.
  const rowsHtml = statuses.slice().reverse().map(({ date, status }, i) =>
    myAttendBuildListRow(date, status, i === statuses.length - 1)
  ).join('');
  wrap.innerHTML = `
    ${summaryHtml}
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:.4rem .4rem;">
      ${rowsHtml}
    </div>`;
}

function fmtMyProjDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtMyProjHours(h) {
  const totalMins = Math.round(Number(h) * 60);
  const hrs  = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs === 0)  return mins + 'm';
  if (mins === 0) return hrs + 'h';
  return hrs + 'h ' + mins + 'm';
}