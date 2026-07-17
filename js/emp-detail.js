// ═══════════════════════════════════════════════════════════════
// EMP-DETAIL.JS — Employee Detail Page (Manager Portal)
// Priority order on page: Identity → Summary → Attendance &
// Activity (merged daily timeline + resolution) → Monthly Project
// Contribution. (Complete Work History has been removed.)
//
// Data flow, APIs, auth, and Google Sheets integration are
// UNCHANGED — this file only reuses the existing getEmployeeDetail
// endpoint and the existing generic apiSaveSlot() write path.
// ═══════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────
let EMP_DETAIL_DATA   = null;
let EMP_DETAIL_EMP    = null;

let DETAIL_MONTH        = '';  // 'YYYY-MM' currently shown in Monthly Contribution
let DETAIL_MONTH_CACHE  = {};  // monthKey -> entries[] (avoids refetching)

const DETAIL_PALETTE = [
  '#4f8ef7','#7c5cfc','#34d399','#fbbf24',
  '#f87171','#22d3ee','#fb923c','#a78bfa',
  '#f472b6','#84cc16','#38bdf8','#4ade80',
];

// Deterministic project → color mapping so a given project always
// renders in the same color everywhere on this page.
const PROJECT_COLOR_CACHE = {};
function getProjectColor(name) {
  const key = name || 'Unassigned';
  if (PROJECT_COLOR_CACHE[key]) return PROJECT_COLOR_CACHE[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const color = DETAIL_PALETTE[hash % DETAIL_PALETTE.length];
  PROJECT_COLOR_CACHE[key] = color;
  return color;
}

// Attendance status → visual style
const STATUS_META = {
  worked:      { icon: '🟢', label: 'Worked',      fg: '#34d399', bg: 'rgba(52,211,153,0.10)'  },
  leave:       { icon: '🟡', label: 'Leave',       fg: '#fbbf24', bg: 'rgba(251,191,36,0.10)'  },
  holiday:     { icon: '⚫', label: 'Holiday',     fg: '#9ca3af', bg: 'rgba(156,163,175,0.10)' },
  not_logged:  { icon: '🔴', label: 'Not Logged',  fg: '#f87171', bg: 'rgba(248,113,113,0.10)' },
  force_leave: { icon: '🟠', label: 'Force Leave', fg: '#fb923c', bg: 'rgba(251,146,60,0.10)'  },
  force_entry: { icon: '🟣', label: 'Force Entry', fg: '#a78bfa', bg: 'rgba(167,139,250,0.10)' },
  upcoming:    { icon: '⚪', label: 'Upcoming',     fg: 'var(--txt2)', bg: 'var(--surface2)'    },
};

// This page is shared by both the Manager and Team Leader portals —
// each has its own container div and its own "go back to the tab
// shell" renderer. Derived from the same MANAGER_MODE/TL_MODE
// session globals auth.js already maintains, no new auth logic.
function getEmpDetailContainer() {
  if (typeof TL_MODE !== 'undefined' && TL_MODE) return $('tlApp');
  return $('mgrApp');
}
function returnToPortalHome() {
  if (typeof TL_MODE !== 'undefined' && TL_MODE && typeof renderTLPortal === 'function') { renderTLPortal(); return; }
  if (typeof renderManagerPortal === 'function') renderManagerPortal();
}

// ── Open Employee Detail Page ──────────────────────────────────
async function openEmpDetail(empId, empName) {
  EMP_DETAIL_EMP     = { id: empId, name: empName };
  DETAIL_MONTH       = todayStr().slice(0, 7);
  DETAIL_MONTH_CACHE = {};

  // Calculate default date range: last 30 days
  const today = new Date();
  const from  = new Date(); from.setDate(today.getDate() - 29);
  const toStr   = today.toISOString().slice(0, 10);
  const fromStr = from.toISOString().slice(0, 10);

  const container = getEmpDetailContainer();
  if (!container) return;

  container.innerHTML = `
    <div id="empDetailPage" style="animation: fadeIn .25s ease;">
      <!-- Back button -->
      <div style="margin-bottom:1rem;">
        <button id="empDetailBack" style="
          display:flex;align-items:center;gap:6px;
          padding:7px 14px;border-radius:8px;
          border:1px solid var(--border-md);background:var(--elevated);
          color:var(--txt2);font-size:13px;font-weight:600;cursor:pointer;
          transition:all .16s ease;
        ">← Back</button>
      </div>

      <!-- Identity -->
      <div style="margin-bottom:1.1rem;">
        <div style="font-size:20px;font-weight:800;color:var(--txt1);">${esc(empName)}</div>
        <div style="font-size:12.5px;color:var(--txt2);font-family:var(--fm);">${esc(empId)}</div>
      </div>

      <!-- Date range picker -->
      <div style="
        display:flex;align-items:center;gap:10px;flex-wrap:wrap;
        background:var(--surface1);border:1px solid var(--border);
        border-radius:10px;padding:10px 14px;margin-bottom:1.1rem;
      ">
        <span style="font-size:12px;color:var(--txt2);font-weight:600;">Date Range:</span>

        <div style="display:flex;gap:6px;flex-wrap:wrap;" id="quickRanges">
          <button class="qr-btn active" data-days="30">Last 30 Days</button>
          <button class="qr-btn" data-days="0">All Time</button>
        </div>

        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--txt2);">From</span>
            <input type="date" id="empDetailFrom" value="${fromStr}"
              style="background:var(--surface2);border:1px solid var(--border);
              border-radius:6px;color:var(--txt1);font-size:12px;padding:5px 8px;cursor:pointer;"/>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--txt2);">To</span>
            <input type="date" id="empDetailTo" value="${toStr}"
              style="background:var(--surface2);border:1px solid var(--border);
              border-radius:6px;color:var(--txt1);font-size:12px;padding:5px 8px;cursor:pointer;"/>
          </div>
          <button id="empDetailApply" style="
            background:var(--a1);color:#fff;border:none;
            border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;
          ">Apply</button>
        </div>
      </div>

      <!-- Content area -->
      <div id="empDetailContent">
        <div class="mgr-loading">
          <div class="slot-spinner"></div>
          <span>Loading employee data…</span>
        </div>
      </div>
    </div>

    <style>
      @keyframes fadeIn { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:none} }
      .qr-btn {
        padding:4px 12px;border-radius:20px;border:1px solid var(--border);
        background:var(--surface2);color:var(--txt2);font-size:11px;
        cursor:pointer;transition:all .16s ease;white-space:nowrap;
      }
      .qr-btn:hover { border-color:var(--a1);color:var(--a1); }
      .qr-btn.active { background:var(--a1);border-color:var(--a1);color:#fff; }
      .det-stat-card {
        background:var(--surface1);border:1px solid var(--border);
        border-radius:12px;padding:.9rem 1rem;text-align:center;
      }
      #empDetailBack:hover { color:var(--txt1);background:var(--hover); }

      /* ── Attendance & Activity (merged) ── */
      .tl-nav-btn {
        width:30px;height:30px;border-radius:50%;border:1px solid var(--border-md);
        background:var(--elevated);color:var(--txt1);font-size:13px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;flex-shrink:0;
      }
      .tl-nav-btn:disabled { opacity:.3;cursor:default; }
      .tl-resbtn {
        border:none;border-radius:6px;padding:4px 8px;font-size:9.5px;font-weight:700;
        cursor:pointer;color:#fff;white-space:nowrap;
      }
      .act-row {
        display:flex;align-items:center;gap:10px;padding:9px 10px;
        border-bottom:1px solid var(--border);flex-wrap:wrap;
      }
      .act-row:last-child { border-bottom:none; }
      .act-date-pill {
        flex-shrink:0;font-size:11px;font-weight:700;color:#38bdf8;
        background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.3);
        border-radius:8px;padding:3px 9px;white-space:nowrap;min-width:64px;text-align:center;
      }
      .act-status-pill {
        flex-shrink:0;display:inline-flex;align-items:center;gap:4px;
        font-size:10.5px;font-weight:700;border-radius:20px;padding:3px 10px;white-space:nowrap;
      }
      .act-bar { flex:1;display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--surface2);min-width:60px; }
      .act-total { font-size:11.5px;font-weight:700;color:var(--txt1);white-space:nowrap;min-width:56px;text-align:right;flex-shrink:0; }
      .act-row-clickable { cursor:pointer; }
      .act-row-clickable:hover { background:var(--hover); }

      /* ── Modal ── */
      .det-modal-overlay {
        position:fixed;inset:0;background:rgba(0,0,0,.55);
        display:flex;align-items:center;justify-content:center;z-index:9999;
        animation:fadeIn .15s ease;
      }
      .det-modal {
        background:var(--surface1);border:1px solid var(--border-md);
        border-radius:14px;padding:1.25rem;width:380px;max-width:92vw;
        max-height:85vh;overflow-y:auto;
      }
      .det-modal label { font-size:11px;color:var(--txt2);font-weight:600;display:block;margin:10px 0 4px; }
      .det-modal input, .det-modal select, .det-modal textarea {
        width:100%;background:var(--surface2);border:1px solid var(--border);
        border-radius:7px;color:var(--txt1);font-size:12.5px;padding:7px 9px;
        box-sizing:border-box;font-family:inherit;
      }
      .det-modal textarea { resize:vertical;min-height:64px; }
    </style>
  `;

  // Bind back button
  $('empDetailBack').addEventListener('click', () => {
    EMP_DETAIL_DATA = null;
    EMP_DETAIL_EMP  = null;
    returnToPortalHome();
  });

  // Bind quick range pills
  $('quickRanges').querySelectorAll('.qr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('quickRanges').querySelectorAll('.qr-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const days = parseInt(btn.dataset.days);
      const tod  = new Date();
      $('empDetailTo').value = tod.toISOString().slice(0, 10);
      if (days === 0) {
        $('empDetailFrom').value = '2020-01-01'; // all time
      } else {
        const f = new Date(); f.setDate(tod.getDate() - (days - 1));
        $('empDetailFrom').value = f.toISOString().slice(0, 10);
      }
      loadEmpDetail($('empDetailFrom').value, $('empDetailTo').value);
    });
  });

  // Bind apply button
  $('empDetailApply').addEventListener('click', () => {
    $('quickRanges').querySelectorAll('.qr-btn').forEach(b => b.classList.remove('active'));
    loadEmpDetail($('empDetailFrom').value, $('empDetailTo').value);
  });

  await loadEmpDetail(fromStr, toStr);
}

// ── Load data from API ─────────────────────────────────────────
async function loadEmpDetail(fromDate, toDate) {
  const content = $('empDetailContent');
  if (!content) return;

  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading…</span></div>`;

  try {
    const data = await sheetGET({
      action: 'getEmployeeDetail',
      uid:    EMP_DETAIL_EMP.id,
      from:   fromDate,
      to:     toDate,
    });
    EMP_DETAIL_DATA = data;
    renderEmpDetail(data);
  } catch(err) {
    content.innerHTML = `<div class="slot-error">Failed to load: ${esc(err.message)}</div>`;
  }
}

// ── Render detail content ──────────────────────────────────────
function renderEmpDetail(data) {
  const content = $('empDetailContent');
  if (!content) return;

  const s        = data.summary;
  const fromDate = $('empDetailFrom')?.value || todayStr();
  const toDate   = $('empDetailTo')?.value   || todayStr();
  // ── 4 summary cards ──────────────────────────────────────────
  const statsHtml = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:.9rem;margin-bottom:1.1rem;">
      <div class="det-stat-card">
        <div style="font-size:10px;color:var(--txt2);margin-bottom:4px;">⏱ Total Hours</div>
        <div style="font-size:21px;font-weight:800;background:var(--grad);
          -webkit-background-clip:text;-webkit-text-fill-color:transparent;">${s.totalHours}</div>
      </div>
      <div class="det-stat-card">
        <div style="font-size:10px;color:var(--txt2);margin-bottom:4px;">📅 Working Days</div>
        <div style="font-size:21px;font-weight:800;color:var(--txt1);">${s.totalDays}</div>
      </div>
      <div class="det-stat-card">
        <div style="font-size:10px;color:var(--txt2);margin-bottom:4px;">🏖 Leaves</div>
        <div style="font-size:21px;font-weight:800;color:#fbbf24;">${s.totalLeaves}</div>
      </div>
      <div class="det-stat-card">
        <div style="font-size:10px;color:var(--txt2);margin-bottom:4px;">📆 Current Month Hours</div>
        <div style="font-size:21px;font-weight:800;color:var(--a1);">${s.monthHours}</div>
      </div>
    </div>`;

  content.innerHTML = `
    ${statsHtml}

    <!-- Attendance & Activity (merged: daily status + hours breakdown + resolution) -->
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;
      padding:1rem 1.1rem;margin-bottom:1.1rem;">
      <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.6rem;">📆 Attendance &amp; Activity</div>
      ${buildAttendanceActivityHtml(data, fromDate, toDate)}
    </div>

    <!-- Monthly Project Contribution -->
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;
      padding:1rem 1.1rem;">
      <div style="font-weight:700;font-size:14px;color:var(--txt1);margin-bottom:.6rem;">📁 Monthly Project Contribution</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:.75rem;">
        <button id="monthPrevBtn" class="tl-nav-btn">◀</button>
        <span id="monthLabel" style="font-size:13px;font-weight:700;color:var(--txt1);min-width:150px;text-align:center;"></span>
        <button id="monthNextBtn" class="tl-nav-btn">▶</button>
      </div>
      <div id="monthlyContribBody"></div>
    </div>
  `;

  // ── Monthly contribution bindings ─────────────────────────────
  $('monthPrevBtn').addEventListener('click', () => { DETAIL_MONTH = shiftMonth(DETAIL_MONTH, -1); renderMonthlyContrib(); });
  $('monthNextBtn').addEventListener('click', () => {
    if (DETAIL_MONTH < todayStr().slice(0, 7)) { DETAIL_MONTH = shiftMonth(DETAIL_MONTH, 1); renderMonthlyContrib(); }
  });
  renderMonthlyContrib();

  // ── Resolution buttons — delegated so timeline re-renders keep working ──
  content.addEventListener('click', e => {
    const empId   = data.emp.id   || EMP_DETAIL_EMP?.id;
    const empName = data.emp.name || EMP_DETAIL_EMP?.name;

    const btn = e.target.closest('.det-resolve-btn');
    if (btn) {
      if (btn.dataset.action === 'force_entry') {
        if (typeof openForceEntry === 'function') {
          openForceEntry(empId, empName, btn.dataset.date, () => openEmpDetail(empId, empName));
        } else {
          toast?.('e', 'Force Entry unavailable', 'forceentry.js is not loaded on this page.');
        }
      } else {
        openResolutionModal(btn.dataset.action, empId, empName, btn.dataset.date);
      }
      return;
    }

    // Clicking a 🟣 Force Entry row (outside its buttons) shows the audit trail
    const auditRow = e.target.closest('.act-row-clickable');
    if (auditRow) openForceEntryAuditView(auditRow.dataset.auditDate);
  });
}

// ══════════════════════════════════════════════════════════════
// ATTENDANCE & ACTIVITY — merged daily timeline
// One row per day: date, status, and (when logged) a compact
// color-coded project bar + total hours. Not-logged rows show the
// three resolution actions inline instead of a bar.
// ══════════════════════════════════════════════════════════════

function buildActivityRow(day) {
  const meta = STATUS_META[day.statusKey];

  if (day.statusKey === 'not_logged') {
    return `
      <div class="act-row">
        <span class="act-date-pill">${day.dateLabel}</span>
        <span class="act-status-pill" style="background:${meta.bg};color:${meta.fg};">${meta.icon} ${meta.label}</span>
        <div style="flex:1;"></div>
        <div style="display:flex;gap:4px;">
          <button class="tl-resbtn det-resolve-btn" data-action="holiday" data-date="${day.dateStr}" style="background:#6b7280;">Holiday</button>
          <button class="tl-resbtn det-resolve-btn" data-action="force_leave" data-date="${day.dateStr}" style="background:#fb923c;">Force Leave</button>
          <button class="tl-resbtn det-resolve-btn" data-action="force_entry" data-date="${day.dateStr}" style="background:#a78bfa;">Force Entry</button>
        </div>
      </div>`;
  }

  const barHtml = day.totalHours > 0
    ? `<div class="act-bar">${day.projects.map(([proj, hrs]) =>
        `<div style="width:${(hrs / day.totalHours) * 100}%;background:${getProjectColor(proj)};" title="${esc(proj)}: ${fmtH(hrs)}"></div>`
      ).join('')}</div>`
    : `<div class="act-bar"></div>`;

  const checkTimesHtml = (day.checkIn || day.checkOut)
    ? `<span class="act-checktimes" style="font-size:11px;color:var(--txt2);white-space:nowrap;">
         <b style="color:var(--txt1);">${fmt12Time(day.checkIn)}</b> → <b style="color:var(--txt1);">${fmt12Time(day.checkOut)}</b>
       </span>`
    : '';

  const isForceEntry = day.statusKey === 'force_entry';
  const rowClass = isForceEntry ? 'act-row act-row-clickable' : 'act-row';
  // .act-row is display:flex (shared with the not-logged row above,
  // which is a single flat horizontal row of pills+buttons). This
  // row now has TWO stacked children (the content row + a notes
  // line beneath it), so it needs flex-direction:column here
  // specifically — done via inline style rather than touching the
  // shared class, so the not-logged row's layout is untouched.
  const rowStyle = [
    'flex-direction:column;align-items:stretch;',
    day.isToday ? 'background:rgba(79,142,247,.05);' : '',
  ].join('');
  const rowAttrs = [
    isForceEntry ? `data-audit-date="${day.dateStr}"` : '',
    `style="${rowStyle}"`,
  ].filter(Boolean).join(' ');
  const infoIcon = isForceEntry ? ` <span title="Tap to view audit trail" style="opacity:.7;">ℹ️</span>` : '';

  return `
    <div class="${rowClass}" ${rowAttrs}>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="act-date-pill">${day.dateLabel}</span>
        <span class="act-status-pill" style="background:${meta.bg};color:${meta.fg};">${meta.icon} ${meta.label}${infoIcon}</span>
        ${checkTimesHtml}
        ${barHtml}
        <span class="act-total">${day.totalHours > 0 ? fmtH(day.totalHours) : '—'}</span>
      </div>
      ${day.notes ? `<div style="font-size:11px;color:var(--txt2);margin-top:4px;padding-left:2px;">📝 ${esc(day.notes)}</div>` : ''}
    </div>`;
}

function buildAttendanceActivityHtml(data, fromDate, toDate) {
  const cappedTo = toDate > todayStr() ? todayStr() : toDate;
  const CAP   = 60; // keep it compact and fast even for "All Time"
  const start = new Date(fromDate + 'T00:00:00');
  const end   = new Date(cappedTo + 'T00:00:00');
  const totalDays   = Math.round((end - start) / 86400000) + 1;
  const renderStart = totalDays > CAP ? new Date(end.getTime() - (CAP - 1) * 86400000) : start;

  const rows = [];
  for (let d = new Date(end); d >= renderStart; d.setDate(d.getDate() - 1)) {
    const dateStr    = d.toISOString().slice(0, 10);
    const dayEntries = data.entries.filter(e => e.date === dateStr);
    const worked     = dayEntries.filter(e => e.status !== 'Leave' && e.status !== 'Holiday');
    const totalHours = worked.reduce((sum, e) => sum + (parseFloat(e.hours) || 0), 0);

    const projMap = {};
    worked.forEach(e => {
      if (!e.project) return;
      projMap[e.project] = (projMap[e.project] || 0) + (parseFloat(e.hours) || 0);
    });
    const projects = Object.entries(projMap).sort((a, b) => b[1] - a[1]);

    // Earliest logged Time In / latest logged Time Out for the day —
    // same check-in/check-out data now shown on the employee card's
    // Attendance widget, surfaced here too so it's visible in both
    // places, not just the card.
    const timesIn  = worked.map(e => e.timeIn).filter(Boolean).sort();
    const timesOut = worked.map(e => e.timeOut).filter(Boolean).sort();
    const checkIn   = timesIn[0] || null;
    const checkOut  = timesOut[timesOut.length - 1] || null;

    // Notes from every worked entry that day — what the employee
    // actually wrote about what they did, not just the hours.
    const notes = [...new Set(worked.map(e => (e.notes || '').trim()).filter(Boolean))].join(' · ');

    rows.push(buildActivityRow({
      dateStr,
      dateLabel: new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
      isToday:   dateStr === todayStr(),
      statusKey: getDayStatus(dateStr, dayEntries),
      totalHours,
      projects,
      checkIn,
      checkOut,
      notes,
    }));
  }

  const truncNote = totalDays > CAP
    ? `<div style="font-size:10px;color:var(--txt2);text-align:center;padding:6px 0 0;">Showing most recent ${CAP} of ${totalDays} days in range</div>`
    : '';

  return `<div style="max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;">${rows.join('')}</div>${truncNote}`;
}

// ══════════════════════════════════════════════════════════════
// MONTHLY PROJECT CONTRIBUTION — month picker + list/slider
// ══════════════════════════════════════════════════════════════

function shiftMonth(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.toISOString().slice(0, 7);
}

// Fetch (or reuse already-loaded) entries for a given month, without
// requiring any new backend endpoint — reuses getEmployeeDetail.
async function getMonthEntries(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const from   = `${monthKey}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  let to = `${monthKey}-${String(lastDay).padStart(2, '0')}`;
  if (to > todayStr()) to = todayStr();

  const curFrom = $('empDetailFrom')?.value;
  const curTo   = $('empDetailTo')?.value;
  if (EMP_DETAIL_DATA && curFrom && curTo && curFrom <= from && to <= curTo) {
    return EMP_DETAIL_DATA.entries.filter(e => e.date && e.date.startsWith(monthKey));
  }

  if (DETAIL_MONTH_CACHE[monthKey]) return DETAIL_MONTH_CACHE[monthKey];

  const data = await sheetGET({ action: 'getEmployeeDetail', uid: EMP_DETAIL_EMP.id, from, to });
  DETAIL_MONTH_CACHE[monthKey] = data.entries || [];
  return DETAIL_MONTH_CACHE[monthKey];
}

async function renderMonthlyContrib() {
  const label = $('monthLabel');
  if (label) label.textContent = new Date(DETAIL_MONTH + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const nextBtn = $('monthNextBtn');
  if (nextBtn) nextBtn.disabled = DETAIL_MONTH >= todayStr().slice(0, 7);

  const body = $('monthlyContribBody');
  if (!body) return;
  body.innerHTML = `<div class="mgr-loading" style="padding:1rem 0;"><div class="slot-spinner"></div></div>`;

  let entries = [];
  try {
    entries = await getMonthEntries(DETAIL_MONTH);
  } catch(err) {
    body.innerHTML = `<div class="slot-error">Failed to load month: ${esc(err.message)}</div>`;
    return;
  }

  const projMap = {};
  entries.filter(e => e.status !== 'Leave' && e.status !== 'Holiday').forEach(e => {
    if (!e.project) return;
    projMap[e.project] = (projMap[e.project] || 0) + (parseFloat(e.hours) || 0);
  });
  const rows = Object.entries(projMap).sort((a, b) => b[1] - a[1]);

  if (!rows.length) {
    body.innerHTML = `<div style="text-align:center;color:var(--txt2);font-size:12px;padding:.75rem 0;">No projects logged this month.</div>`;
    return;
  }

  if (rows.length <= 6) {
    body.innerHTML = `<div style="display:flex;flex-direction:column;gap:9px;">
      ${rows.map(([proj, hrs]) => {
        const color = getProjectColor(proj);
        return `<div style="display:flex;align-items:center;gap:8px;">
          <span style="width:9px;height:9px;border-radius:2px;background:${color};flex-shrink:0;"></span>
          <span style="font-size:12.5px;color:var(--txt1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;" title="${esc(proj)}">${esc(proj)}</span>
          <span style="flex:1;border-bottom:1px dotted var(--border);height:0;align-self:center;margin:0 2px;"></span>
          <span style="font-size:13px;font-weight:800;color:var(--txt1);white-space:nowrap;">${fmtH(hrs)}</span>
        </div>`;
      }).join('')}
    </div>`;
  } else {
    body.innerHTML = `<div style="display:flex;gap:8px;overflow-x:auto;padding:2px 2px 6px;">
      ${rows.map(([proj, hrs]) => {
        const color = getProjectColor(proj);
        return `<div style="flex-shrink:0;min-width:120px;background:var(--surface2);border:1px solid var(--border);
          border-radius:12px;padding:8px 12px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></span>
            <span style="font-size:11px;color:var(--txt1);font-weight:600;white-space:nowrap;overflow:hidden;
              text-overflow:ellipsis;max-width:90px;" title="${esc(proj)}">${esc(proj)}</span>
          </div>
          <div style="font-size:13px;font-weight:800;color:var(--txt1);">${fmtH(hrs)}</div>
        </div>`;
      }).join('')}
    </div>`;
  }
}

// ══════════════════════════════════════════════════════════════
// ATTENDANCE RESOLUTION — vertical timeline
// ══════════════════════════════════════════════════════════════

// Detect a manager-driven manual action from an entry's notes tag.
// Tags are written by openResolutionModal() below as a prefix like
// "[FORCE_ENTRY by Manager · 4 Jul 2026, 03:15:00 pm] <notes>".
function detectManualTag(entry) {
  const n = (entry.notes || '');
  if (n.startsWith('[FORCE_ENTRY')) return 'force_entry';
  if (n.startsWith('[HOLIDAY'))     return 'holiday';
  if (n.startsWith('[FORCE_LEAVE')) return 'force_leave';
  return null;
}

// Force Entry notes are written by forceentry.js as:
// "[FORCE_ENTRY by NAME (ROLE) · TIMESTAMP] Reason: R | Manager Notes: MN | Employee notes: EN"
// Parse that back out for the audit-trail popup below.
function parseForceEntryTag(notes) {
  const m = (notes || '').match(
    /^\[FORCE_ENTRY by (.+?) \((.+?)\)\s*·\s*(.+?)\]\s*Reason:\s*(.*?)\s*\|\s*Manager Notes:\s*(.*?)\s*\|\s*Employee notes:\s*(.*)$/
  );
  if (!m) return null;
  return { enteredBy: m[1], role: m[2], timestamp: m[3], reason: m[4], managerNotes: m[5], employeeNotes: m[6] };
}

// Shows the permanent audit record for a 🟣 Force Entry day — Entered By,
// Date & Time, Reason, and Manager Notes — read-only, per the requirement
// that this information must remain visible as part of the audit history.
function openForceEntryAuditView(dateStr) {
  if (!EMP_DETAIL_DATA || !dateStr) return;
  const feEntry = EMP_DETAIL_DATA.entries.find(e => e.date === dateStr && detectManualTag(e) === 'force_entry');
  if (!feEntry) return;
  const parsed = parseForceEntryTag(feEntry.notes) || {};

  const overlay = document.createElement('div');
  overlay.className = 'det-modal-overlay';
  overlay.innerHTML = `
    <div class="det-modal">
      <div style="font-weight:700;font-size:15px;color:var(--txt1);margin-bottom:2px;">🟣 Force Entry — ${fmtDetailDate(dateStr)}</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:14px;">Permanent audit record for this manual entry</div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div>
          <div style="font-size:10.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.05em;">Entered By</div>
          <div style="font-size:13px;color:var(--txt1);font-weight:600;">${esc(parsed.enteredBy || '—')} (${esc(parsed.role || '—')})</div>
        </div>
        <div>
          <div style="font-size:10.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.05em;">Date &amp; Time</div>
          <div style="font-size:13px;color:var(--txt1);">${esc(parsed.timestamp || feEntry.savedAt || '—')}</div>
        </div>
        <div>
          <div style="font-size:10.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.05em;">Reason</div>
          <div style="font-size:13px;color:var(--txt1);">${esc(parsed.reason || '—')}</div>
        </div>
        <div>
          <div style="font-size:10.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.05em;">Manager Notes</div>
          <div style="font-size:13px;color:var(--txt1);">${esc(parsed.managerNotes || '—')}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px;">
        <button id="feAuditClose" style="background:none;border:1px solid var(--border-md);
          color:var(--txt2);border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#feAuditClose').addEventListener('click', () => overlay.remove());
}

// Work out the attendance status for one calendar day from its entries.
function getDayStatus(dateStr, dayEntries) {
  const dow    = new Date(dateStr + 'T00:00:00').getDay(); // 0 = Sun, 6 = Sat
  const future = dateStr > todayStr();

  if (dayEntries.length === 0) {
    if (future)               return 'upcoming';
    if (dow === 0 || dow===6) return 'holiday'; // weekly off, nothing to resolve
    return 'not_logged';
  }

  const tags = dayEntries.map(detectManualTag);
  if (tags.includes('force_entry')) return 'force_entry';
  if (tags.includes('holiday'))     return 'holiday';
  if (tags.includes('force_leave')) return 'force_leave';
  if (dayEntries.some(e => e.status === 'Leave'))   return 'leave';
  if (dayEntries.some(e => e.status === 'Holiday')) return 'holiday';
  return 'worked';
}

// ══════════════════════════════════════════════════════════════
// NOT-LOGGED RESOLUTION — modal + submit (reuses apiSaveSlot only,
// no backend/API changes — every action is a NEW traceable entry,
// never an overwrite of existing history)
// ══════════════════════════════════════════════════════════════

function openResolutionModal(action, empId, empName, dateStr) {
  const dateLabel = fmtDetailDate(dateStr);
  const titles = {
    holiday:     { icon: '⚫', title: 'Mark as Holiday' },
    force_leave: { icon: '🟠', title: 'Apply Force Leave' },
  };
  const t = titles[action];
  if (!t) return; // force_entry is handled by openForceEntry() instead

  const overlay = document.createElement('div');
  overlay.className = 'det-modal-overlay';
  overlay.innerHTML = `
    <div class="det-modal">
      <div style="font-weight:700;font-size:15px;color:var(--txt1);margin-bottom:2px;">${t.icon} ${t.title}</div>
      <div style="font-size:12px;color:var(--txt2);">${esc(empName)} · ${dateLabel}</div>
      <label>Notes <span style="color:#f87171;">(required)</span></label>
      <textarea id="detModalNotes" placeholder="Reason for this manual action…"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="detModalCancel" style="background:none;border:1px solid var(--border-md);
          color:var(--txt2);border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">Cancel</button>
        <button id="detModalSubmit" style="background:var(--a1);border:none;
          color:#fff;border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:700;cursor:pointer;">Submit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#detModalCancel').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#detModalSubmit').addEventListener('click', async () => {
    const notes = overlay.querySelector('#detModalNotes').value.trim();
    if (!notes) {
      overlay.querySelector('#detModalNotes').style.borderColor = '#f87171';
      return;
    }

    const fields = action === 'holiday'
      ? { slot: 'extended', client: 'Holiday', clientId: '', project: 'Holiday', projectId: '', task: 'Holiday', hours: 0, status: 'Holiday', tag: 'HOLIDAY' }
      : { slot: 'extended', client: 'Leave', clientId: '', project: 'Leave', projectId: '', task: 'Leave', hours: 0, status: 'Leave', tag: 'FORCE_LEAVE' };

    const submitBtn = overlay.querySelector('#detModalSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      const entry = buildManagerEntry(empId, empName, dateStr, fields, notes);
      await apiSaveSlot(entry);
      toast?.('s', 'Recorded', `${t.title} saved for ${fmtDetailDate(dateStr)}.`);
      overlay.remove();
      await loadEmpDetail($('empDetailFrom').value, $('empDetailTo').value);
    } catch(err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
      toast?.('e', 'Failed to save', err.message);
    }
  });
}

// Build a manager-authored entry using the exact same shape the
// employee-facing form already writes via apiSaveSlot — no backend
// or schema changes required. Traceability (who / when / why) is
// embedded as a tag prefix inside the notes field, and the action
// always creates a brand-new entry rather than editing history.
function buildManagerEntry(empId, empName, dateStr, fields, userNotes) {
  const now = new Date();
  const savedAt = now.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
  const enteredBy   = (typeof getEnteredByInfo === 'function') ? getEnteredByInfo() : { name: (typeof USER !== 'undefined' && USER?.name) || 'Manager' };
  const entryNum     = Date.now() % 1000000;
  const tag          = `[${fields.tag} by ${enteredBy.name} · ${savedAt}]`;

  return {
    id:      `${empId}-${dateStr}-${fields.slot}-${entryNum}`,
    uid:     empId,
    empName: empName,
    date:    dateStr,
    day:     new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' }),
    slot:    fields.slot,
    entryNum,
    timeIn:  fields.timeIn  || '',
    timeOut: fields.timeOut || '',
    client:    fields.client,
    clientId:  fields.clientId,
    project:   fields.project,
    projectId: fields.projectId,
    task:      fields.task,
    hours:     fields.hours,
    notes:     `${tag} ${userNotes || ''}`.trim(),
    status:    fields.status,
    savedAt,
  };
}

// ── Helpers ────────────────────────────────────────────────────
function fmtDetailDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN',
    { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtH(h) {
  const mins = Math.round(Number(h) * 60);
  const hr   = Math.floor(mins / 60);
  const mn   = mins % 60;
  if (hr === 0) return `${mn}m`;
  if (mn === 0) return `${hr}h`;
  return `${hr}h ${mn}m`;
}

// Self-contained on purpose — this page is shared by both Manager
// and Team Leader (see getEmpDetailContainer/returnToPortalHome
// above), so it shouldn't depend on either portal's own fmt12/
// tlFmt12 helper.
function fmt12Time(t) {
  if (!t) return '--:--';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}