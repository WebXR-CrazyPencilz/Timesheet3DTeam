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
// Detail drill-down ("View Details") is a separate, later addition —
// not built here.
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

      const tsPanel  = document.getElementById('empTabTimesheet');
      const projPanel = document.getElementById('empTabProjects');
      if (tsPanel)   tsPanel.style.display   = tab === 'timesheet' ? '' : 'none';
      if (projPanel) projPanel.style.display = tab === 'projects'  ? '' : 'none';

      if (tab === 'projects') loadMyProjectsTab();
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
// employee's own day-by-day notes and a month-by-month summary for
// one project, plus two report downloads (This Month / Overall),
// same print-to-PDF pattern used on the Manager/TL side — no PDF
// library, just a clean printable HTML page and the browser's own
// Print -> Save as PDF.
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
    if (e.project !== projectName || e.status === 'Leave' || !e.date) return;
    if (!byDate[e.date]) byDate[e.date] = { hours: 0, notes: [] };
    byDate[e.date].hours += Number(e.hours) || 0;
    if (e.notes && e.notes.trim()) byDate[e.date].notes.push(e.notes.trim());
  });
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a)); // most recent first
  return { byDate, dates };
}

function getMyProjectMonthlySummary(byDate, dates) {
  const byMonth = {};
  dates.forEach(date => {
    const m = date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + byDate[date].hours;
  });
  return Object.keys(byMonth).sort().reverse().map(m => ({ month: m, hours: byMonth[m] }));
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

  const dailyRows = dates.length ? dates.map((date, i) => {
    const d = byDate[date];
    const isLast = i === dates.length - 1;
    return `
      <div style="padding:8px 0;${isLast ? '' : 'border-bottom:1px solid var(--border);'}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;gap:8px;">
          <span style="font-size:12px;font-weight:700;color:var(--txt1);">${esc(fmtMyProjDate(date))}</span>
          <span style="font-size:12px;font-weight:700;color:var(--a1);white-space:nowrap;">${esc(fmtMyProjHours(d.hours))}</span>
        </div>
        <div style="font-size:11.5px;color:var(--txt2);">${esc(d.notes.join(' · ') || 'No notes')}</div>
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
  const totalDays   = rangeDates.length;
  const empName     = (typeof USER !== 'undefined' && USER?.name) || '';

  const logRows = rangeDates.length ? rangeDates.map(d => `
    <tr>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;white-space:nowrap;">${esc(fmtMyProjDate(d))}</td>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;text-align:right;white-space:nowrap;">${esc(fmtMyProjHours(byDate[d].hours))}</td>
      <td style="padding:6px 9px;border:1px solid #e2e8f0;">${esc(byDate[d].notes.join(' · ') || '—')}</td>
    </tr>`).join('') : `<tr><td colspan="3" style="padding:10px;color:#64748b;">No activity logged during this period.</td></tr>`;

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

    <h2>Daily Log</h2>
    <table>
      <thead>
        <tr style="background:#eef2ff;">
          <th style="text-align:left;padding:7px 9px;border:1px solid #dbeafe;color:#334155;">Date</th>
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