// ═══════════════════════════════════════════════════════════════
// Client-Project-Attendance.js — Attendance grid, Public Holiday
// push, Biometric Punch, and the old read-only Historical Projects
// tab. Split out of Client-Project.js purely because that file had
// grown too large -- this is not a separate module conceptually, it
// shares globals (CP_EMPLOYEES, CP_TIMESHEET_DATA, esc, fh, fmt12,
// getCPRole, toast, etc.) that Client-Project.js and manager.js/
// teamleader.js declare. Load BOTH this file and Client-Project.js's
// <script> tag in index.html -- order between the two doesn't
// matter, but both must be present.
//
// Shared by Manager AND Team Leader AND HR -- lives here (not in
// manager.js/teamleader.js/humanresource.js) specifically so there's
// one implementation instead of three: every portal already feeds
// this module identical data via ClientProjectAPI.ingestMasterData()
// / ingestTimesheetData() (see the top of Client-Project.js), so this
// reads CP_EMPLOYEES / CP_TIMESHEET_DATA rather than any portal's own
// MGR_*/TL_*/HR_* globals directly, and every portal calls the exact
// same renderAttendanceTab(content) / renderOldProjectsTab(content)
// from its own tab router.
// ═══════════════════════════════════════════════════════════════

let CP_ATTEND_MODE  = 'last15'; // 'last15' | 'custom' | 'month'
let CP_ATTEND_FROM  = '';
let CP_ATTEND_TO    = '';
let CP_ATTEND_MONTH = ''; // 'YYYY-MM', used when CP_ATTEND_MODE === 'month'
let CP_ATTEND_HR_DEFAULTED = false; // one-time guard — see renderAttendanceTab

const CP_ATTEND_MONTH_FLOOR = '2026-07'; // earliest month offered in the dropdown

function renderAttendanceTab(content) {
  if (typeof ensureCPStyles === 'function') ensureCPStyles();
  const tod = todayStr();
  if (!CP_ATTEND_TO)   CP_ATTEND_TO = tod;
  if (!CP_ATTEND_FROM) {
    const f = new Date(); f.setDate(f.getDate() - 14);
    CP_ATTEND_FROM = toLocalDateStr(f);
  }
  if (!CP_ATTEND_MONTH) CP_ATTEND_MONTH = tod.slice(0, 7) < CP_ATTEND_MONTH_FLOOR ? CP_ATTEND_MONTH_FLOOR : tod.slice(0, 7);

  // HR's main use for this tab is checking whether something (like a
  // pushed public holiday) landed on the right date, which needs the
  // WHOLE month visible, not just the trailing 15-day window Manager/
  // TL default to. Default HR straight into Month Wise / current
  // month the first time this tab opens — only once per session
  // (CP_ATTEND_HR_DEFAULTED guards it) so switching to Last 15 Days
  // manually afterward isn't fought on every re-render.
  if (getCPRole() === 'hr' && !CP_ATTEND_HR_DEFAULTED) {
    CP_ATTEND_HR_DEFAULTED = true;
    CP_ATTEND_MODE = 'month';
    applyAttendMonth(CP_ATTEND_MONTH);
  }

  // Months from the floor up through the current month, newest first.
  const monthOptions = [];
  {
    const [fy, fm] = CP_ATTEND_MONTH_FLOOR.split('-').map(Number);
    const [ty, tm] = tod.slice(0, 7).split('-').map(Number);
    const cur = new Date(ty, tm - 1, 1);
    const floor = new Date(fy, fm - 1, 1);
    while (cur >= floor) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
      monthOptions.push({ key, label: cur.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) });
      cur.setMonth(cur.getMonth() - 1);
    }
  }

  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem;flex-wrap:wrap;gap:10px;">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--txt1);">🕒 Attendance</div>
        <div style="font-size:12px;color:var(--txt2);">Daily check-in / check-out and hours per employee.</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <div class="chart-range" id="attendModeBtns">
          <button class="rbtn${CP_ATTEND_MODE==='last15'?' active':''}" data-mode="last15">Last 15 Days</button>
          <button class="rbtn${CP_ATTEND_MODE==='month'?' active':''}" data-mode="month">Month Wise</button>
          <button class="rbtn${CP_ATTEND_MODE==='custom'?' active':''}" data-mode="custom">Start → End</button>
        </div>
        <div id="attendMonthPicker" style="display:${CP_ATTEND_MODE==='month'?'flex':'none'};align-items:center;gap:6px;">
          <select id="attendMonthSelect" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
            color:var(--txt1);font-size:12px;padding:6px 8px;cursor:pointer;">
            ${monthOptions.map(m => `<option value="${m.key}" ${m.key === CP_ATTEND_MONTH ? 'selected' : ''}>${m.label}</option>`).join('')}
          </select>
        </div>
        <div id="attendCustomRange" style="display:${CP_ATTEND_MODE==='custom'?'flex':'none'};align-items:center;gap:6px;">
          <input type="date" id="attendFrom" value="${CP_ATTEND_FROM}" max="${tod}"
            style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
            color:var(--txt1);font-size:12px;padding:5px 8px;cursor:pointer;"/>
          <span style="color:var(--txt2);font-size:11px;">to</span>
          <input type="date" id="attendTo" value="${CP_ATTEND_TO}" max="${tod}"
            style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
            color:var(--txt1);font-size:12px;padding:5px 8px;cursor:pointer;"/>
          <button id="attendApplyRange" style="background:var(--a1);color:#fff;border:none;border-radius:6px;
            padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;">Apply</button>
        </div>
        <button id="attendExportPdf" style="background:var(--elevated);color:var(--txt1);border:1px solid var(--border-md);
          border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;">
          ⬇ Export PDF
        </button>
        ${getCPRole() === 'hr' ? `
        <button id="attendPushHoliday" style="background:#fbbf24;color:#1a1a2e;border:none;
          border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;">
          📅 Push Public Holiday
        </button>` : ''}
      </div>
    </div>
    <div id="attendGridWrap"></div>
    <div style="margin-top:8px;font-size:11px;color:var(--txt2);display:flex;gap:14px;flex-wrap:wrap;">
      <span><span style="color:#34d399;font-weight:700;">Hours</span> = worked that day</span>
      <span><span style="color:#fbbf24;font-weight:700;">🏖 Leave</span> = approved leave (full day)</span>
      <span>Hours <span style="color:#fbbf24;">🏖</span> = worked part of the day, also had a half-day leave entry that date</span>
      <span><span style="color:#9ca3af;font-weight:700;">⚫ [Name]</span> = public holiday (name shown is what HR entered when pushing it)</span>
      <span><span style="color:#f87171;font-weight:700;">✕ No Entry</span> = working day, nothing logged</span>
      <span><span style="color:var(--txt2);">—</span> = weekend</span>
      <span><span style="color:#a78bfa;font-weight:700;">Permission Hrs</span> = shortfall below a ${9}h full day, on days actually worked</span>
    </div>
  `;

  $('attendModeBtns').addEventListener('click', e => {
    const btn = e.target.closest('.rbtn');
    if (!btn) return;
    CP_ATTEND_MODE = btn.dataset.mode;
    $('attendModeBtns').querySelectorAll('.rbtn').forEach(b => b.classList.toggle('active', b === btn));
    $('attendCustomRange').style.display = CP_ATTEND_MODE === 'custom' ? 'flex' : 'none';
    $('attendMonthPicker').style.display = CP_ATTEND_MODE === 'month'  ? 'flex' : 'none';
    if (CP_ATTEND_MODE === 'last15') {
      CP_ATTEND_TO = todayStr();
      const f = new Date(); f.setDate(f.getDate() - 14);
      CP_ATTEND_FROM = toLocalDateStr(f);
    } else if (CP_ATTEND_MODE === 'month') {
      applyAttendMonth(CP_ATTEND_MONTH);
    }
    renderAttendanceGrid();
  });

  $('attendMonthSelect').addEventListener('change', e => {
    applyAttendMonth(e.target.value);
    renderAttendanceGrid();
  });

  $('attendApplyRange').addEventListener('click', () => {
    const from = $('attendFrom').value;
    const to   = $('attendTo').value;
    if (!from || !to || from > to) { toast?.('e', 'Invalid range', 'Pick a valid Start and End date.'); return; }
    CP_ATTEND_FROM = from;
    CP_ATTEND_TO   = to;
    renderAttendanceGrid();
  });

  $('attendExportPdf').addEventListener('click', () => exportAttendanceToPDF());
  $('attendPushHoliday')?.addEventListener('click', () => openBulkHolidayModal());

  renderAttendanceGrid();
}

// Sets the From/To range to the full calendar month for the given
// 'YYYY-MM' key — capped at today if that month is the current one,
// so it doesn't extend into the future (renderAttendanceGrid also
// caps this independently, but keeping CP_ATTEND_TO itself sane
// avoids the picker's own max attribute clamping oddly).
function applyAttendMonth(monthKey) {
  CP_ATTEND_MONTH = monthKey;
  const [y, m] = monthKey.split('-').map(Number);
  const lastDayOfMonth = toLocalDateStr(new Date(y, m, 0));
  CP_ATTEND_FROM = `${monthKey}-01`;
  // Used to truncate CP_ATTEND_TO to today here, before
  // renderAttendanceGrid's own (now mode-aware) cap ever got a
  // chance to run — so "Month Wise" was silently just as blind to
  // future dates as "Last 15 Days", even though only the latter is
  // supposed to be. A pushed-in-advance public holiday later in the
  // month would never show. Always use the real last day of the
  // month here; renderAttendanceGrid decides per-mode whether to cap.
  CP_ATTEND_TO = lastDayOfMonth;
}

// Exports exactly what's currently rendered in the grid — whichever
// mode (Last 15 Days / Month Wise / Start → End) and whatever range
// is active — as a PDF, via the browser's own print-to-PDF rather
// than pulling in a PDF-generation library (this app has no build
// tooling and no external dependencies elsewhere, so this keeps that
// consistent). Opens a plain, light-themed print view in a new tab
// with the same table data, then triggers the browser's print
// dialog, where "Save as PDF" is a built-in destination in every
// major browser.
function getAttendRangeLabel() {
  if (CP_ATTEND_MODE === 'month') {
    return new Date(CP_ATTEND_MONTH + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }
  const fromLabel = new Date(CP_ATTEND_FROM + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const toLabel   = new Date(CP_ATTEND_TO + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${fromLabel} – ${toLabel}`;
}

function exportAttendanceToPDF() {
  const table = document.querySelector('#attendGridWrap table');
  if (!table) { toast?.('e', 'Nothing to export', 'The grid has not finished loading yet.'); return; }

  const rangeLabel = getAttendRangeLabel();
  const printWindow = window.open('', '_blank');
  if (!printWindow) { toast?.('e', 'Could not open print preview', 'Your browser may have blocked the pop-up.'); return; }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Attendance — ${esc(rangeLabel)}</title>
      <style>
        @page { size: landscape; margin: 10mm; }
        * { box-sizing: border-box; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 16px; }
        h1 { font-size: 16px; margin: 0 0 2px; }
        .sub { font-size: 11px; color: #555; margin-bottom: 14px; }
        table { border-collapse: collapse; width: 100%; font-size: 9px; }
        th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: center; white-space: nowrap; }
        th { background: #f0f0f0; text-transform: uppercase; font-size: 8px; color: #333; }
        td:first-child, th:first-child { text-align: left; font-weight: bold; position: static !important; }
        td, th { position: static !important; background: #fff !important; color: #111 !important; }
        th { background: #f0f0f0 !important; }
      </style>
    </head>
    <body>
      <h1>Attendance Report</h1>
      <div class="sub">${esc(rangeLabel)} · Generated ${new Date().toLocaleString('en-IN')}</div>
      ${table.outerHTML}
    </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.onload = () => printWindow.print();
  setTimeout(() => { if (!printWindow.closed) printWindow.print(); }, 400); // fallback in case onload doesn't fire in time
}

// Distinguishes WHY a day has no worked hours — Leave and Holiday are
// legitimate, approved statuses and shouldn't look like a missed day.
// getEmpDayAttendance() only reports worked hours/check-in-out, so
// this checks CP_TIMESHEET_DATA directly for the day's status, same filter
// pattern already used everywhere else in this file.
// Check-in / check-out / worked-duration for one employee on one day,
// from CP_TIMESHEET_DATA (fed by whichever portal — Manager or Team
// Leader — is currently active). Reuses isWorkedEntry/parseH, which
// are portal-agnostic globals already defined in manager.js/
// teamleader.js and loaded on every page regardless of portal.
function cpGetEmpDayAttendance(empId, date) {
  const entries = CP_TIMESHEET_DATA.filter(e => e.empId === empId && e.date === date).filter(isWorkedEntry);
  if (!entries.length) return { hasEntry: false, checkIn: null, checkOut: null, hours: 0 };
  const timesIn  = entries.map(e => e.timeIn).filter(Boolean).sort();
  const timesOut = entries.map(e => e.timeOut).filter(Boolean).sort();
  const hours    = entries.reduce((s, e) => s + parseH(e.hours), 0);
  return { hasEntry: true, checkIn: timesIn[0] || null, checkOut: timesOut[timesOut.length - 1] || null, hours };
}

function getEmpDayStatus(empId, date) {
  const rec = cpGetEmpDayAttendance(empId, date);
  const dayEntries = CP_TIMESHEET_DATA.filter(e => e.empId === empId && e.date === date);
  const hasLeave   = dayEntries.some(e => e.status === 'Leave');
  const hasHoliday   = dayEntries.some(e => e.status === 'Holiday');
  const holidayEntry = dayEntries.find(e => e.status === 'Holiday');
  const holidayName  = holidayEntry ? (holidayEntry.task || 'Holiday') : '';

  // Biometric punch (HR-only, see openBiometricPunchModal) is
  // reference data, independent of whatever the employee self-logged
  // — it's surfaced alongside the primary kind below (worked/leave/
  // holiday/not_logged), never as a replacement for it, since a day
  // can have both a self-reported entry AND a biometric record that
  // may or may not agree with it.
  const biometricEntry = dayEntries.find(e => e.status === 'BiometricPunch');
  const biometric = biometricEntry ? { in: biometricEntry.timeIn || '', out: biometricEntry.timeOut || '' } : null;

  // A day can be BOTH worked and Leave — a half-day leave (e.g. leave
  // in the morning, worked the afternoon). The old version checked
  // worked-hours first and returned immediately, which silently
  // dropped that day's Leave entry from every count entirely (it
  // never even reached the Leave check below). hasLeave is now
  // reported alongside 'worked' instead of being hidden by it.
  if (rec.hasEntry) return { kind: 'worked', hasLeave, hasHoliday, biometric, ...rec };
  if (hasLeave)   return { kind: 'leave', hasLeave: true, biometric };
  if (hasHoliday) return { kind: 'holiday', holidayName, biometric };
  return { kind: 'not_logged', biometric };
}

function renderAttendanceGrid() {
  const wrap = $('attendGridWrap');
  if (!wrap) return;

  const tod      = todayStr();
  const isHR     = getCPRole() === 'hr';
  // Sticky right-edge offsets for the summary columns, indexed left
  // to right (Leave Days, Permission Hrs, Working Days, Total Hours,
  // Overtime, [Biometric Hours if HR]). HR gets one extra column, so
  // every offset before it needs to shift by 100px to make room.
  const off = isHR ? [500, 400, 300, 200, 100, 0] : [400, 300, 200, 100, 0];
  // "Last 15 Days" is inherently a trailing window ending today by
  // construction, so capping it at today is a no-op there. But
  // "Month Wise" / "Start → End" are explicit choices — if HR is
  // looking at a month that includes future dates (e.g. viewing
  // August while a public holiday was already pushed for Aug 15, a
  // few days ahead), those future columns need to actually render so
  // the holiday is visible. The existing `d > tod` branch below
  // already shows a neutral "·" placeholder for ordinary future days
  // with nothing on them — it just never used to be reachable because
  // this cap excluded those dates from `days` entirely before it got
  // that far.
  const cappedTo = CP_ATTEND_MODE === 'last15' && CP_ATTEND_TO > tod ? tod : CP_ATTEND_TO;
  const CAP = 60; // keep the grid usable even for a very wide custom range
  const startDate   = new Date(CP_ATTEND_FROM + 'T00:00:00');
  const endDate     = new Date(cappedTo + 'T00:00:00');
  const totalDaysInRange = Math.max(1, Math.round((endDate - startDate) / 86400000) + 1);
  const renderStart = totalDaysInRange > CAP ? new Date(endDate.getTime() - (CAP - 1) * 86400000) : startDate;

  const days = [];
  for (let d = new Date(renderStart); d <= endDate; d.setDate(d.getDate() + 1)) {
    days.push(toLocalDateStr(d));
  }

  const truncNote = totalDaysInRange > CAP
    ? `<div style="font-size:10px;color:var(--txt2);margin-bottom:8px;">Showing most recent ${CAP} of ${totalDaysInRange} days in range</div>`
    : '';

  wrap.innerHTML = `
    ${truncNote}
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;overflow-x:auto;">
      <table style="width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:9px 12px;background:var(--surface2);color:var(--txt2);
              font-size:10.5px;text-transform:uppercase;white-space:nowrap;position:sticky;left:0;z-index:1;">Employee</th>
            ${days.map(d => `<th style="text-align:center;padding:9px 8px;background:var(--surface2);color:var(--txt2);
              font-size:10px;white-space:nowrap;">${new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</th>`).join('')}
            <th style="text-align:center;padding:9px 6px;background:var(--surface2);color:var(--txt2);
              font-size:10px;text-transform:uppercase;white-space:nowrap;border-left:2px solid var(--border);
              position:sticky;right:${off[0]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;z-index:1;">Leave<br/>Days</th>
            <th style="text-align:center;padding:9px 6px;background:var(--surface2);color:var(--txt2);
              font-size:10px;text-transform:uppercase;white-space:nowrap;
              position:sticky;right:${off[1]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;z-index:1;">Permission<br/>Hrs</th>
            <th style="text-align:center;padding:9px 6px;background:var(--surface2);color:var(--txt2);
              font-size:10px;text-transform:uppercase;white-space:nowrap;
              position:sticky;right:${off[2]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;z-index:1;">Working<br/>Days</th>
            <th style="text-align:center;padding:9px 6px;background:var(--surface2);color:var(--txt2);
              font-size:10px;text-transform:uppercase;white-space:nowrap;
              position:sticky;right:${off[3]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;z-index:1;">Total<br/>Hours</th>
            <th style="text-align:center;padding:9px 6px;background:var(--surface2);color:var(--txt2);
              font-size:10px;text-transform:uppercase;white-space:nowrap;
              position:sticky;right:${off[4]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;z-index:1;">Overtime</th>
            ${isHR ? `<th style="text-align:center;padding:9px 6px;background:var(--surface2);color:var(--txt2);
              font-size:10px;text-transform:uppercase;white-space:nowrap;
              position:sticky;right:${off[5]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;z-index:1;" title="Total hours computed from recorded biometric punch times, not self-logged hours.">Biometric<br/>Hours</th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${(() => {
            // Inactive employees are excluded entirely here — their
            // past hours still flow into cost calculations elsewhere
            // (client-project.js reads CP_TIMESHEET_DATA regardless of this
            // filter), this only affects what shows in this grid.
            const activeEmployees = (CP_EMPLOYEES || []).filter(emp => emp.active !== false);
            if (!activeEmployees.length) {
              return `<tr><td colspan="${isHR ? 10 : 9}" style="text-align:center;padding:2rem;color:var(--txt2);">No employees found.</td></tr>`;
            }
            const FULL_DAY_HOURS = 9; // baseline used for "Permission Hours" and "Overtime" — adjust if your actual full working day differs
            return activeEmployees.map(emp => {
              let leaveDays = 0, workingDays = 0, totalHours = 0, permissionHours = 0, overtimeHours = 0, biometricHours = 0;

              const dayCellsHtml = days.map(d => {
                const dow = new Date(d + 'T00:00:00').getDay();
                const isWeekend = dow === 0 || dow === 6;
                const status = getEmpDayStatus(emp.id, d);
                let cell, clickable = false;
                if (status.kind === 'worked') {
                  const halfDayLeave = status.hasLeave;
                  const timesLine = (status.checkIn || status.checkOut)
                    ? `<br/><span style="font-size:9px;color:var(--txt2);font-weight:500;">${status.checkIn ? fmt12(status.checkIn) : '—'} → ${status.checkOut ? fmt12(status.checkOut) : '—'}</span>`
                    : '';
                  cell = `<span style="color:#34d399;font-weight:700;" title="In ${fmt12(status.checkIn)} → Out ${fmt12(status.checkOut)}${halfDayLeave ? ' (half-day leave also recorded this date)' : ''}">${fh(status.hours)}${halfDayLeave ? ' <span style="color:#fbbf24;" title="Half-day leave">🏖</span>' : ''}${timesLine}</span>`;
                  workingDays++;
                  totalHours += status.hours;
                  if (status.hours < FULL_DAY_HOURS) permissionHours += (FULL_DAY_HOURS - status.hours);
                  if (status.hours > FULL_DAY_HOURS) overtimeHours   += (status.hours - FULL_DAY_HOURS);
                  if (halfDayLeave) leaveDays++;
                } else if (status.kind === 'leave') {
                  cell = `<span style="color:#fbbf24;font-weight:700;" title="On approved leave">🏖 Leave</span>`;
                  leaveDays++;
                } else if (status.kind === 'holiday') {
                  cell = `<span style="color:#9ca3af;font-weight:700;" title="Public Holiday: ${esc(status.holidayName)}">⚫ ${esc(status.holidayName)}</span>`;
                } else if (isWeekend) {
                  cell = `<span style="color:var(--txt2);">—</span>`;
                } else if (d > tod) {
                  cell = `<span style="color:var(--txt2);">·</span>`;
                } else {
                  cell = `<span style="color:#f87171;font-weight:700;">✕ No Entry</span>`;
                  clickable = true;
                }

                // Biometric reference line — visible to everyone
                // whenever HR has recorded one for this date,
                // regardless of what the employee self-logged (or
                // didn't). Purely informational except in HR Portal,
                // where the whole cell becomes clickable to add/edit it.
                if (status.biometric) {
                  let bioDurationText = '';
                  let bioMins = 0;
                  if (status.biometric.in && status.biometric.out) {
                    const [inH, inM]   = status.biometric.in.split(':').map(Number);
                    const [outH, outM] = status.biometric.out.split(':').map(Number);
                    bioMins = (outH * 60 + outM) - (inH * 60 + inM);
                    if (bioMins > 0) bioDurationText = ` (${fh(bioMins / 60)})`;
                  }
                  cell += `<br/><span style="font-size:9px;color:#818cf8;font-weight:600;" title="Biometric punch (HR-recorded reference, not counted toward Total Hours above)">🔒 ${status.biometric.in ? fmt12(status.biometric.in) : '—'} → ${status.biometric.out ? fmt12(status.biometric.out) : '—'}${bioDurationText}</span>`;
                  // Duration purely from the recorded punch times —
                  // independent of whatever hours the employee self-
                  // logged (or didn't).
                  if (bioMins > 0) biometricHours += bioMins / 60;
                }

                if (isHR) {
                  return `<td class="attend-biometric-cell" data-emp-id="${esc(emp.id)}" data-emp-name="${esc(emp.name)}" data-date="${d}"
                      data-bio-in="${esc(status.biometric?.in || '')}" data-bio-out="${esc(status.biometric?.out || '')}"
                      style="padding:8px;text-align:center;white-space:nowrap;cursor:pointer;" title="Click to record/edit biometric punch">${cell}</td>`;
                }
                return clickable
                  ? `<td class="attend-no-entry-cell" data-emp-id="${esc(emp.id)}" data-emp-name="${esc(emp.name)}" data-date="${d}"
                      style="padding:8px;text-align:center;white-space:nowrap;cursor:pointer;" title="Click to Force Entry or Force Leave">${cell}</td>`
                  : `<td style="padding:8px;text-align:center;white-space:nowrap;">${cell}</td>`;
              }).join('');

              return `
              <tr style="border-top:1px solid var(--border);">
                <td class="attend-emp-cell" data-emp-id="${esc(emp.id)}" data-emp-name="${esc(emp.name)}"
                  style="padding:8px 12px;color:var(--txt1);font-weight:600;white-space:nowrap;cursor:pointer;
                  position:sticky;left:0;background:var(--surface1);" title="Click to view ${esc(emp.name)}'s details">
                  ${esc(emp.name)}<br/><span style="font-size:10px;color:var(--txt2);font-weight:500;">${esc(emp.id)}</span>
                </td>
                ${dayCellsHtml}
                <td style="padding:8px 6px;text-align:center;color:${leaveDays > 0 ? '#fbbf24' : 'var(--txt2)'};font-weight:700;
                  border-left:2px solid var(--border);position:sticky;right:${off[0]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;background:var(--surface1);">${leaveDays}</td>
                <td style="padding:8px 6px;text-align:center;color:${permissionHours > 0 ? '#a78bfa' : 'var(--txt2)'};font-weight:700;
                  position:sticky;right:${off[1]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;background:var(--surface1);">${permissionHours > 0 ? fh(permissionHours) : '—'}</td>
                <td style="padding:8px 6px;text-align:center;color:var(--txt1);font-weight:700;
                  position:sticky;right:${off[2]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;background:var(--surface1);">${workingDays}</td>
                <td style="padding:8px 6px;text-align:center;color:var(--a1);font-weight:700;
                  position:sticky;right:${off[3]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;background:var(--surface1);">${fh(totalHours)}</td>
                <td style="padding:8px 6px;text-align:center;color:${overtimeHours > 0 ? '#f87171' : 'var(--txt2)'};font-weight:700;
                  position:sticky;right:${off[4]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;background:var(--surface1);">${overtimeHours > 0 ? fh(overtimeHours) : '—'}</td>
                ${isHR ? `<td style="padding:8px 6px;text-align:center;color:${biometricHours > 0 ? '#818cf8' : 'var(--txt2)'};font-weight:700;
                  position:sticky;right:${off[5]}px;width:100px;min-width:100px;max-width:100px;box-sizing:border-box;background:var(--surface1);">${biometricHours > 0 ? fh(biometricHours) : '—'}</td>` : ''}
              </tr>`;
            }).join('');
          })()}
        </tbody>
      </table>
    </div>`;

  wrap.querySelectorAll('.attend-no-entry-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      openAttendanceCellMenu(cell, cell.dataset.empId, cell.dataset.empName, cell.dataset.date);
    });
  });

  wrap.querySelectorAll('.attend-biometric-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      openHRCellMenu(cell, cell.dataset.empId, cell.dataset.empName, cell.dataset.date, cell.dataset.bioIn, cell.dataset.bioOut);
    });
  });

  // Employee name column is clickable too — opens that employee's
  // individual data. Reuses openEmpDetail() from emp-detail.js exactly
  // as-is (same page the Employees tab already opens), not a new view.
  wrap.querySelectorAll('.attend-emp-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      if (typeof openEmpDetail === 'function') openEmpDetail(cell.dataset.empId, cell.dataset.empName);
    });
  });
}

// ── FORCE ENTRY / FORCE LEAVE FROM THE ATTENDANCE GRID ────────────
// A small action menu on any "✕ No Entry" cell. Force Entry reuses
// openForceEntry() from forceentry.js exactly as-is (it's already
// portal/container-aware). Force Leave can't reuse emp-detail.js's
// openResolutionModal() directly — its submit handler hardcodes a
// refresh call to the Employee Detail page's own DOM elements, which
// don't exist here — so this builds its own small modal, but still
// reuses the actual save logic (buildManagerEntry + apiSaveSlot) from
// emp-detail.js rather than duplicating it.
function closeAttendanceCellMenu() {
  document.getElementById('attendCellMenu')?.remove();
  document.removeEventListener('click', closeAttendanceCellMenuOnOutsideClick, true);
}

function closeAttendanceCellMenuOnOutsideClick(e) {
  const menu = document.getElementById('attendCellMenu');
  if (menu && !menu.contains(e.target)) closeAttendanceCellMenu();
}

function openAttendanceCellMenu(cellEl, empId, empName, date) {
  closeAttendanceCellMenu();

  const rect = cellEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'attendCellMenu';
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:10000;
    background:var(--surface1);border:1px solid var(--border-md);border-radius:10px;
    box-shadow:0 8px 24px rgba(0,0,0,.4);padding:6px;display:flex;flex-direction:column;gap:2px;min-width:150px;`;
  menu.innerHTML = `
    <button id="attendMenuForceEntry" style="text-align:left;background:none;border:none;color:var(--txt1);
      padding:8px 10px;border-radius:7px;font-size:12.5px;cursor:pointer;">⚡ Force Entry</button>
    <button id="attendMenuForceLeave" style="text-align:left;background:none;border:none;color:var(--txt1);
      padding:8px 10px;border-radius:7px;font-size:12.5px;cursor:pointer;">🟠 Force Leave</button>
  `;
  document.body.appendChild(menu);
  menu.querySelectorAll('button').forEach(b => {
    b.addEventListener('mouseenter', () => b.style.background = 'var(--surface2)');
    b.addEventListener('mouseleave', () => b.style.background = 'none');
  });

  menu.querySelector('#attendMenuForceEntry').addEventListener('click', () => {
    closeAttendanceCellMenu();
    if (typeof openForceEntry !== 'function') { toast?.('e', 'Force Entry module not loaded'); return; }
    // Derive which portal's containers to use from the cell that was
    // clicked, rather than hardcoding Manager's — this same module is
    // shared with Team Leader's Attendance tab too.
    const portalRoot = cellEl.closest('#mgrApp, #tlApp');
    const portalId   = portalRoot ? portalRoot.id : 'mgrApp';
    // NOT captured as a stale element reference — openForceEntry()
    // replaces the ENTIRE #mgrApp/#tlApp container's innerHTML (tab
    // bar included, not just the content area) to take over the
    // screen, so a `tabContent` element captured here-and-now would
    // point to a node that's already been destroyed by the time this
    // callback actually runs (Back click, or after a successful
    // save). Calling renderMgrTab()/renderTLTab() alone isn't enough
    // either — those only render INTO #mgrTabContent/#tlTabContent,
    // which openForceEntry() also destroyed along with everything
    // else in the container, so they'd hit their own "if (!content)
    // return" guard and silently no-op. renderManagerPortal()/
    // renderTLPortal() rebuild the tab bar AND recreate that content
    // div from scratch (the same thing that runs on first login),
    // which is what's actually needed here.
    openForceEntry(empId, empName, date, () => {
      if (portalId === 'tlApp' && typeof renderTLPortal === 'function') renderTLPortal();
      else if (typeof renderManagerPortal === 'function') renderManagerPortal();
    }, portalId);
  });

  menu.querySelector('#attendMenuForceLeave').addEventListener('click', () => {
    closeAttendanceCellMenu();
    openAttendanceForceLeaveModal(empId, empName, date);
  });

  // Defer binding the outside-click listener one tick so the click
  // that opened this menu doesn't immediately close it again.
  setTimeout(() => document.addEventListener('click', closeAttendanceCellMenuOnOutsideClick, true), 0);
}

// HR's version of the menu above — clicking ANY day cell (not just
// "No Entry" ones, since Force Holiday and Biometric Punch both make
// sense on a day that already has data too) offers Force Holiday
// (per employee, per date — unlike Push Public Holiday which applies
// to every active employee at once) and Biometric Punch.
function openHRCellMenu(cellEl, empId, empName, date, bioIn, bioOut) {
  closeAttendanceCellMenu();

  const rect = cellEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'attendCellMenu';
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:10000;
    background:var(--surface1);border:1px solid var(--border-md);border-radius:10px;
    box-shadow:0 8px 24px rgba(0,0,0,.4);padding:6px;display:flex;flex-direction:column;gap:2px;min-width:170px;`;
  menu.innerHTML = `
    <button id="attendMenuForceEntryHR" style="text-align:left;background:none;border:none;color:var(--txt1);
      padding:8px 10px;border-radius:7px;font-size:12.5px;cursor:pointer;">⚡ Force Entry</button>
    <button id="attendMenuForceLeaveHR" style="text-align:left;background:none;border:none;color:var(--txt1);
      padding:8px 10px;border-radius:7px;font-size:12.5px;cursor:pointer;">🟠 Force Leave</button>
    <button id="attendMenuForceHoliday" style="text-align:left;background:none;border:none;color:var(--txt1);
      padding:8px 10px;border-radius:7px;font-size:12.5px;cursor:pointer;">🎉 Force Holiday</button>
    <button id="attendMenuBiometric" style="text-align:left;background:none;border:none;color:var(--txt1);
      padding:8px 10px;border-radius:7px;font-size:12.5px;cursor:pointer;">🔒 Biometric Punch</button>
  `;
  document.body.appendChild(menu);
  menu.querySelectorAll('button').forEach(b => {
    b.addEventListener('mouseenter', () => b.style.background = 'var(--surface2)');
    b.addEventListener('mouseleave', () => b.style.background = 'none');
  });

  // Same Force Entry / Force Leave Manager and Team Leader already
  // get from openAttendanceCellMenu — HR gets full parity here, not
  // a reduced menu, plus the two HR-specific actions below.
  menu.querySelector('#attendMenuForceEntryHR').addEventListener('click', () => {
    closeAttendanceCellMenu();
    if (typeof openForceEntry !== 'function') { toast?.('e', 'Force Entry module not loaded'); return; }
    openForceEntry(empId, empName, date, () => {
      if (typeof renderHRPortal === 'function') renderHRPortal();
    }, 'hrApp');
  });

  menu.querySelector('#attendMenuForceLeaveHR').addEventListener('click', () => {
    closeAttendanceCellMenu();
    openAttendanceForceLeaveModal(empId, empName, date);
  });

  menu.querySelector('#attendMenuForceHoliday').addEventListener('click', () => {
    closeAttendanceCellMenu();
    openForceHolidayModal(empId, empName, date);
  });

  menu.querySelector('#attendMenuBiometric').addEventListener('click', () => {
    closeAttendanceCellMenu();
    openBiometricPunchModal(empId, empName, date, bioIn, bioOut);
  });

  setTimeout(() => document.addEventListener('click', closeAttendanceCellMenuOnOutsideClick, true), 0);
}

// Force Holiday — HR only, ONE employee on ONE date, unlike Push
// Public Holiday (openBulkHolidayModal) which applies to every active
// employee at once. Reuses the exact same write shape (status:
// 'Holiday', slot:'extended') so getEmpDayStatus/the grid/the
// Public Holiday backend lock in saveSlot all treat it identically —
// this is just a narrower-scoped entry point into the same feature,
// not a second implementation. Unlike the bulk version, this
// explicitly OVERWRITES whatever was there before (that's the point
// of "force") rather than skipping employees who already have an
// entry that day.
function openForceHolidayModal(empId, empName, date) {
  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);
    display:flex;align-items:center;justify-content:center;z-index:9999;`;
  overlay.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border-md);border-radius:14px;padding:1.25rem;width:360px;max-width:92vw;">
      <div style="font-weight:700;font-size:15px;color:var(--txt1);margin-bottom:2px;">🎉 Force Holiday</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:12px;">${esc(empName)} · ${dateLabel}. Only this employee, only this date — overwrites whatever's already logged that day.</div>
      <label style="font-size:11px;color:var(--txt2);font-weight:600;display:block;margin-bottom:4px;">
        Holiday Name <span style="color:#f87171;">(required)</span>
      </label>
      <input type="text" id="fhName" placeholder="e.g. Approved festival leave" style="width:100%;box-sizing:border-box;
        background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--txt1);
        font-size:12.5px;padding:8px 10px;"/>
      <div id="fhErr" style="display:none;font-size:11.5px;color:#f87171;margin-top:8px;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="fhCancel" style="background:none;border:1px solid var(--border-md);
          color:var(--txt2);border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">Cancel</button>
        <button id="fhSubmit" style="background:#fbbf24;border:none;
          color:#1a1a2e;border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:700;cursor:pointer;">Apply Holiday</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#fhCancel').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#fhSubmit').addEventListener('click', async () => {
    const name  = overlay.querySelector('#fhName').value.trim();
    const errEl = overlay.querySelector('#fhErr');
    errEl.style.display = 'none';

    if (!name) { errEl.textContent = 'Holiday name is required.'; errEl.style.display = 'block'; return; }
    if (typeof buildManagerEntry !== 'function' || typeof apiSaveSlot !== 'function') {
      toast?.('e', 'Required module not loaded');
      return;
    }

    const submitBtn = overlay.querySelector('#fhSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Applying…';

    try {
      const fields = { slot: 'extended', client: 'Holiday', clientId: '', project: 'Holiday', projectId: '', task: name, hours: 0, status: 'Holiday', tag: 'FORCE_HOLIDAY' };
      const entry  = buildManagerEntry(empId, empName, date, fields, name);
      await apiSaveSlot(entry);

      for (let i = CP_TIMESHEET_DATA.length - 1; i >= 0; i--) {
        const e = CP_TIMESHEET_DATA[i];
        if (e.empId === empId && e.date === date) CP_TIMESHEET_DATA.splice(i, 1);
      }
      CP_TIMESHEET_DATA.push({ ...entry, empId, empName, status: 'Holiday', date, hours: '0h' });

      toast?.('s', 'Holiday applied', `${empName} · ${dateLabel}`);
      overlay.remove();
      renderAttendanceGrid();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Apply Holiday';
      toast?.('e', 'Failed to save', err.message);
    }
  });
}

function openAttendanceForceLeaveModal(empId, empName, date) {
  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);
    display:flex;align-items:center;justify-content:center;z-index:9999;`;
  overlay.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border-md);border-radius:14px;padding:1.25rem;width:360px;max-width:92vw;">
      <div style="font-weight:700;font-size:15px;color:var(--txt1);margin-bottom:2px;">🟠 Apply Force Leave</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:10px;">${esc(empName)} · ${dateLabel}</div>
      <label style="font-size:11px;color:var(--txt2);font-weight:600;display:block;margin-bottom:4px;">
        Notes <span style="color:#f87171;">(required)</span>
      </label>
      <textarea id="attendForceLeaveNotes" placeholder="Reason for this manual action…" style="width:100%;min-height:64px;
        background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--txt1);
        font-size:12.5px;padding:8px 10px;box-sizing:border-box;font-family:inherit;resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="attendForceLeaveCancel" style="background:none;border:1px solid var(--border-md);
          color:var(--txt2);border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">Cancel</button>
        <button id="attendForceLeaveSubmit" style="background:var(--a1);border:none;
          color:#fff;border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:700;cursor:pointer;">Submit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#attendForceLeaveCancel').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#attendForceLeaveSubmit').addEventListener('click', async () => {
    const notes = overlay.querySelector('#attendForceLeaveNotes').value.trim();
    if (!notes) { overlay.querySelector('#attendForceLeaveNotes').style.borderColor = '#f87171'; return; }

    if (typeof buildManagerEntry !== 'function' || typeof apiSaveSlot !== 'function') {
      toast?.('e', 'Employee Detail module not loaded');
      return;
    }

    const submitBtn = overlay.querySelector('#attendForceLeaveSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      const fields = { slot: 'extended', client: 'Leave', clientId: '', project: 'Leave', projectId: '', task: 'Leave', hours: 0, status: 'Leave', tag: 'FORCE_LEAVE' };
      const entry  = buildManagerEntry(empId, empName, date, fields, notes);
      await apiSaveSlot(entry);

      // Reflect it locally so the grid updates immediately without a
      // full reload — same append-to-CP_TIMESHEET_DATA pattern used elsewhere.
      CP_TIMESHEET_DATA.push({ ...entry, empId, empName, status: 'Leave', date, hours: '0h' });

      toast?.('s', 'Force Leave recorded', `${dateLabel} for ${empName}`);
      overlay.remove();
      renderAttendanceGrid();
    } catch(err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
      toast?.('e', 'Failed to save', err.message);
    }
  });
}

// ══════════════════════════════════════════════════
// PUSH PUBLIC HOLIDAY — HR only. Unlike Force Leave/Force Entry
// above (which act on ONE employee/ONE date, clicked from a specific
// "No Entry" cell), this opens a plain date picker with no range
// restriction — any date, any month, not limited to whatever window
// the Attendance grid currently happens to be showing — and applies
// it to every active employee at once. Reuses the exact same
// buildManagerEntry + apiSaveSlot write path Force Leave already
// uses, just looped across CP_EMPLOYEES instead of a single emp, and
// writes status:'Holiday' (the status getEmpDayStatus/the grid's ⚫
// Holiday cell already recognize) instead of 'Leave'. Employees who
// already have a real entry that date (worked, leave, or already
// holiday) are skipped rather than overwritten.
// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// BIOMETRIC PUNCH (HR only) — records the real biometric in/out time
// for a single employee/date, separate from whatever they self-
// logged in the app. Every day cell in HR's Attendance grid is
// clickable (not just "No Entry" ones — a biometric record can
// coexist with a self-logged entry, e.g. to flag a mismatch), pre-
// filling existing values if one was already recorded for that date.
// ══════════════════════════════════════════════════
function openBiometricPunchModal(empId, empName, date, existingIn, existingOut) {
  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);
    display:flex;align-items:center;justify-content:center;z-index:9999;`;
  overlay.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border-md);border-radius:14px;padding:1.25rem;width:360px;max-width:92vw;">
      <div style="font-weight:700;font-size:15px;color:var(--txt1);margin-bottom:2px;">🔒 Biometric Punch</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:12px;">${esc(empName)} · ${dateLabel}. Reference only — doesn't affect hours, leave, or overtime.</div>
      <div style="display:flex;gap:10px;">
        <div style="flex:1;">
          <label style="font-size:11px;color:var(--txt2);font-weight:600;display:block;margin-bottom:4px;">In</label>
          <input type="time" id="bioInTime" value="${esc(existingIn || '')}" style="width:100%;box-sizing:border-box;
            background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--txt1);
            font-size:12.5px;padding:8px 10px;"/>
        </div>
        <div style="flex:1;">
          <label style="font-size:11px;color:var(--txt2);font-weight:600;display:block;margin-bottom:4px;">Out</label>
          <input type="time" id="bioOutTime" value="${esc(existingOut || '')}" style="width:100%;box-sizing:border-box;
            background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--txt1);
            font-size:12.5px;padding:8px 10px;"/>
        </div>
      </div>
      <div id="bioErr" style="display:none;font-size:11.5px;color:#f87171;margin-top:8px;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="bioCancel" style="background:none;border:1px solid var(--border-md);
          color:var(--txt2);border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">Cancel</button>
        <button id="bioSubmit" style="background:#818cf8;border:none;
          color:#fff;border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:700;cursor:pointer;">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#bioCancel').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#bioSubmit').addEventListener('click', async () => {
    const bioIn  = overlay.querySelector('#bioInTime').value;
    const bioOut = overlay.querySelector('#bioOutTime').value;
    const errEl  = overlay.querySelector('#bioErr');
    errEl.style.display = 'none';

    if (!bioIn && !bioOut) { errEl.textContent = 'Enter at least one time.'; errEl.style.display = 'block'; return; }
    if (typeof apiSaveBiometricPunch !== 'function') { toast?.('e', 'Required module not loaded'); return; }

    const submitBtn = overlay.querySelector('#bioSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      await apiSaveBiometricPunch({
        role: 'hr', uid: empId, date, bioIn, bioOut,
        enteredByName: (typeof USER !== 'undefined' && USER?.name) || 'HR',
      });

      // Reflect locally without a full reload — remove any stale
      // BiometricPunch row for this date first (upsert semantics
      // mirrored client-side), then push the fresh one.
      for (let i = CP_TIMESHEET_DATA.length - 1; i >= 0; i--) {
        const e = CP_TIMESHEET_DATA[i];
        if (e.empId === empId && e.date === date && e.status === 'BiometricPunch') CP_TIMESHEET_DATA.splice(i, 1);
      }
      CP_TIMESHEET_DATA.push({ empId, empName, date, status: 'BiometricPunch', timeIn: bioIn, timeOut: bioOut, hours: '0h', slot: 'biometric' });

      toast?.('s', 'Biometric punch saved', `${empName} · ${dateLabel}`);
      overlay.remove();
      renderAttendanceGrid();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save';
      toast?.('e', 'Failed to save', err.message);
    }
  });
}


function openBulkHolidayModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);
    display:flex;align-items:center;justify-content:center;z-index:9999;`;
  overlay.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border-md);border-radius:14px;padding:1.25rem;width:380px;max-width:92vw;">
      <div style="font-weight:700;font-size:15px;color:var(--txt1);margin-bottom:2px;">📅 Push Public Holiday</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:12px;">Applies to every active employee. Pick any date — not limited to the range currently shown.</div>
      <label style="font-size:11px;color:var(--txt2);font-weight:600;display:block;margin-bottom:4px;">Date</label>
      <input type="date" id="holidayDate" style="width:100%;box-sizing:border-box;margin-bottom:10px;
        background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--txt1);
        font-size:12.5px;padding:8px 10px;"/>
      <label style="font-size:11px;color:var(--txt2);font-weight:600;display:block;margin-bottom:4px;">
        Holiday Name <span style="color:#f87171;">(required)</span>
      </label>
      <input type="text" id="holidayName" placeholder="e.g. Independence Day" style="width:100%;box-sizing:border-box;
        background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--txt1);
        font-size:12.5px;padding:8px 10px;"/>
      <div id="holidayErr" style="display:none;font-size:11.5px;color:#f87171;margin-top:6px;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="holidayCancel" style="background:none;border:1px solid var(--border-md);
          color:var(--txt2);border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">Cancel</button>
        <button id="holidaySubmit" style="background:#fbbf24;border:none;
          color:#1a1a2e;border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:700;cursor:pointer;">Push to All</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#holidayCancel').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#holidaySubmit').addEventListener('click', async () => {
    const date = overlay.querySelector('#holidayDate').value;
    const name = overlay.querySelector('#holidayName').value.trim();
    const errEl = overlay.querySelector('#holidayErr');
    errEl.style.display = 'none';

    if (!date) { errEl.textContent = 'Pick a date.'; errEl.style.display = 'block'; return; }
    if (!name) { errEl.textContent = 'Holiday name is required.'; errEl.style.display = 'block'; return; }
    if (typeof buildManagerEntry !== 'function' || typeof apiSaveSlot !== 'function') {
      toast?.('e', 'Required module not loaded');
      return;
    }

    const submitBtn = overlay.querySelector('#holidaySubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Pushing…';

    // Wraps the ENTIRE push, not just the per-employee apiSaveSlot
    // call — getEmpDayStatus() below was previously called outside
    // any try/catch. If it (or anything else in this block) threw
    // for any reason, the async handler died as an unhandled
    // rejection with the button permanently stuck on "Pushing…" and
    // no toast at all — indistinguishable from "the button just
    // didn't respond". This outer catch guarantees the button always
    // resets and a real error message is always shown, no matter
    // what fails or where.
    try {
      const activeEmployees = (CP_EMPLOYEES || []).filter(emp => emp.active !== false);
      if (!activeEmployees.length) {
        errEl.textContent = 'No active employees loaded — try reopening the Attendance tab first.';
        errEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Push to All';
        return;
      }

      let applied = 0, skipped = 0;
      const errors = []; // { empName, message } — surfaced below instead of only console.warn,
                          // since a silent per-employee failure with no visible feedback was
                          // indistinguishable from "nothing happened at all" from the UI.

      for (const emp of activeEmployees) {
        let status;
        try {
          status = getEmpDayStatus(emp.id, date);
        } catch (statusErr) {
          errors.push({ empName: emp.name, message: 'Status check failed: ' + statusErr.message });
          continue;
        }
        // getEmpDayStatus's "no entry logged" value is 'not_logged',
        // not 'none' — this check was comparing against the wrong
        // string, so it was true for literally every employee
        // regardless of what was actually in their sheet, and every
        // push silently skipped everyone. This is the actual bug
        // behind every "Nothing to push" result so far.
        if (status.kind !== 'not_logged') { skipped++; continue; } // already worked/leave/holiday that day — don't overwrite

        try {
          const fields = { slot: 'extended', client: 'Holiday', clientId: '', project: 'Holiday', projectId: '', task: name, hours: 0, status: 'Holiday', tag: 'PUBLIC_HOLIDAY' };
          const entry  = buildManagerEntry(emp.id, emp.name, date, fields, name);
          await apiSaveSlot(entry);
          CP_TIMESHEET_DATA.push({ ...entry, empId: emp.id, empName: emp.name, status: 'Holiday', date, hours: '0h' });
          applied++;
        } catch (err) {
          console.warn('[Bulk Holiday] failed for', emp.id, err.message);
          errors.push({ empName: emp.name, message: err.message });
        }
      }

      const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

      if (applied === 0 && errors.length) {
        // Every write failed — this is a real backend error, not just
        // "everyone already had an entry that day". Show the actual
        // error message so it's diagnosable instead of a generic
        // success-shaped toast that hides the failure.
        errEl.innerHTML = `Failed for all ${errors.length} employee${errors.length === 1 ? '' : 's'}. First error (${esc(errors[0].empName)}): ${esc(errors[0].message)}`;
        errEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Push to All';
        toast?.('e', 'Push failed', errors[0].message);
        return;
      }

      if (applied === 0 && skipped === activeEmployees.length) {
        toast?.('i', 'Nothing to push', `Every active employee already has an entry on ${dateLabel} — none were overwritten.`);
        overlay.remove();
        renderAttendanceGrid();
        return;
      }

      toast?.('s', 'Public Holiday pushed', `${dateLabel} — applied to ${applied} employee${applied === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} with existing entries` : ''}${errors.length ? `, ${errors.length} failed` : ''}.`);
      overlay.remove();
      renderAttendanceGrid();
    } catch (outerErr) {
      // Catches anything unexpected that escaped all the handling
      // above — guarantees the button never gets stuck and something
      // is always shown, instead of a silent dead click.
      console.error('[Bulk Holiday] unexpected failure:', outerErr);
      errEl.textContent = 'Unexpected error: ' + outerErr.message;
      errEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Push to All';
      toast?.('e', 'Push failed', outerErr.message);
    }
  });
}

// ══════════════════════════════════════════════════
// OLD PROJECTS TAB — read-only Manager view of the registers Team
// Leaders enter via historical-import.js. Reuses the EXACT same
// backend action (getHistoricalProjectsSummary) that file already
// calls for its own landing-screen list — no new backend endpoint,
// no duplicated summary logic. Manager can view but not edit/resume
// a register here (that stays Team-Leader-only, in Historical Import).
// ══════════════════════════════════════════════════
async function renderOldProjectsTab(content) {
  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading historical projects…</span></div>`;

  let projects;
  try {
    projects = await sheetGET({ action: 'getHistoricalProjectsSummary' });
  } catch(err) {
    content.innerHTML = `<div class="slot-error">Failed to load historical projects: ${esc(err.message)}</div>`;
    return;
  }

  content.innerHTML = `
    <div style="margin-bottom:1.1rem;">
      <div style="font-size:16px;font-weight:700;color:var(--txt1);">📜 OLD Projects</div>
      <div style="font-size:12px;color:var(--txt2);">
        Legacy projects entered by Team Leaders via Historical Import — total hours per employee per month only, no daily entries. View only here.
      </div>
    </div>
    ${!projects.length
      ? `<div class="chart-empty">No historical registers have been entered yet.</div>`
      : `<div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
            <thead>
              <tr>
                ${['Client → Project', 'Months', 'Employees', 'Total Hours', 'Status'].map(h =>
                  `<th style="text-align:${['Months','Employees','Total Hours'].includes(h) ? 'right' : 'left'};padding:9px 12px;
                    background:var(--surface2);color:var(--txt2);font-size:10.5px;text-transform:uppercase;
                    letter-spacing:.04em;white-space:nowrap;">${h}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${projects.map(p => `
                <tr style="border-top:1px solid var(--border);">
                  <td style="padding:9px 12px;color:var(--txt1);font-weight:600;white-space:nowrap;">${esc(p.clientName)} → ${esc(p.projectName)}</td>
                  <td style="padding:9px 12px;text-align:right;color:var(--txt1);">${p.monthCount}</td>
                  <td style="padding:9px 12px;text-align:right;color:var(--txt1);">${p.employeeCount}</td>
                  <td style="padding:9px 12px;text-align:right;color:var(--a1);font-weight:700;">${fmtOldProjHours(p.totalHours)}</td>
                  <td style="padding:9px 12px;white-space:nowrap;">
                    ${p.isFinal
                      ? `<span style="background:rgba(52,211,153,.12);color:#34d399;border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;">Final</span>`
                      : `<span style="background:rgba(251,191,36,.12);color:#fbbf24;border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;">Draft</span>`}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`}
  `;
}

function fmtOldProjHours(h) {
  const n = parseFloat(h) || 0;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 1 }) + 'h';
}

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
  computeProjectCost:  async (projectId) => {
    const project = CP_PROJECTS.find(p => p.projectId === projectId);
    return project ? await calculateProjectCost(project) : null;
  },
  getProjectTeamActivity: (projectId) => {
    const project = CP_PROJECTS.find(p => p.projectId === projectId);
    return project ? getProjectTeamActivity(project) : null;
  },
  reloadClients: loadClientData,
  reloadProjects: loadProjectData,
});