// ═══════════════════════════════════════════════════
// MANAGER.JS — Manager Portal shell
// Tabs: Project | Employees | Salary | Client
//
// This file is ONLY a loading/navigation platform. It owns the
// Employee module (timesheet data, employee cards, Employee Detail
// hook) and the top-level tab shell — it never calculates or renders
// Client or Project data itself. The Client and Project tabs simply
// hand their content container to client-project.js:
//
//   Project   → client-project.js (renderProjectTab)  ← default tab
//   Employees → this file (renderEmployeesTab)
//   Salary    → salary.js (renderSalaryTab)
//   Client    → client-project.js (renderClientTab)
//
// Master data (employees/clients/projects) is fetched once here and
// the clients/projects portion is handed off to client-project.js via
// ClientProjectAPI.ingestMasterData(), so there's a single shared
// fetch instead of client-project.js re-requesting the same data.
//
// Desktop-only layout: no mobile breakpoints/media queries are used
// anywhere in this file — grids are fixed-column, sized for a PC
// screen.
// ═══════════════════════════════════════════════════

// ── STATE ─────────────────────────────────────────
let MGR_DATA           = [];
let MGR_EMPLOYEES      = [];

let MGR_TAB            = 'project';    // project|client|employees|salary — Project is the default landing tab
let MGR_RANGE          = 'week';
let MGR_DAY_OFFSET     = 0;
let MGR_SELECTED_MONTH = '';

const MGR_PALETTE = [
  '#4f8ef7','#7c5cfc','#34d399','#fbbf24',
  '#f87171','#22d3ee','#fb923c','#a78bfa',
  '#f472b6','#84cc16','#38bdf8','#4ade80',
];

// ── INIT ──────────────────────────────────────────
async function initManager() {
  MGR_SELECTED_MONTH = todayStr().slice(0,7);
  const container = $('mgrApp');
  if (!container) return;

  const av = $('mgrAv');
  if (av) av.textContent = 'M';

  container.innerHTML = `<div class="mgr-loading">
    <div class="slot-spinner"></div>
    <span>Loading all data…</span>
  </div>`;

  try {
    // Load master data once. Only the employees portion is this
    // file's concern — clients/projects are handed off wholesale to
    // client-project.js, which owns everything about them.
    const master = await apiGetMasterData();
    MGR_EMPLOYEES = master.employees || [];

    if (typeof ClientProjectAPI !== 'undefined' && typeof ClientProjectAPI.ingestMasterData === 'function') {
      ClientProjectAPI.ingestMasterData(master);
    }

    // Load all employee entries in parallel
    const results = await Promise.all(
      MGR_EMPLOYEES.map(emp =>
        apiGetAllHistory(emp.id)
          .then(entries => entries.map(e => ({ ...e, empId: emp.id, empName: emp.name, empTeam: emp.team })))
          .catch(() => [])
      )
    );
    MGR_DATA = results.flat();

    if (typeof ClientProjectAPI !== 'undefined' && typeof ClientProjectAPI.ingestTimesheetData === 'function') {
      ClientProjectAPI.ingestTimesheetData(MGR_DATA);
    }

    renderManagerPortal();
  } catch(err) {
    container.innerHTML = `<div class="slot-error">Failed to load: ${err.message}</div>`;
  }
}

// ── RENDER PORTAL SHELL ───────────────────────────
function renderManagerPortal() {
  const container = $('mgrApp');
  if (!container) return;

  container.innerHTML = `
    <!-- Top nav tabs -->
    <div style="display:flex;gap:4px;margin-bottom:1.5rem;border-bottom:1px solid var(--border);padding-bottom:0;">
      ${[
        { id:'project',   icon:'📁', label:'Project'   },
        { id:'client',    icon:'🏢', label:'Client'    },
        { id:'employees', icon:'👥', label:'Employees' },
        { id:'salary',    icon:'💼', label:'Salary'    },
      ].map(t => `
        <button class="mgr-tab${MGR_TAB===t.id?' active':''}" data-tab="${t.id}" style="
          padding:8px 16px;border:none;background:none;cursor:pointer;
          font-size:13px;font-weight:600;
          color:${MGR_TAB===t.id ? 'var(--a1)' : 'var(--txt2)'};
          border-bottom:2px solid ${MGR_TAB===t.id ? 'var(--a1)' : 'transparent'};
          margin-bottom:-1px;transition:all .2s;
        ">${t.icon} ${t.label}</button>
      `).join('')}
    </div>
    <div id="mgrTabContent"></div>
  `;

  container.querySelectorAll('.mgr-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      MGR_TAB = btn.dataset.tab;
      container.querySelectorAll('.mgr-tab').forEach(b => {
        const active = b === btn;
        b.style.color       = active ? 'var(--a1)' : 'var(--txt2)';
        b.style.borderBottom= active ? '2px solid var(--a1)' : '2px solid transparent';
      });
      renderMgrTab();
    });
  });

  renderMgrTab();
}

// ── ROUTE TO TAB ──────────────────────────────────
// Each non-Employees tab is a pure hand-off to the module that owns
// it. If that module's script hasn't loaded, show a plain message
// instead of throwing — manager.js never substitutes its own logic.
function renderMgrTab() {
  const content = $('mgrTabContent');
  if (!content) return;

  if (MGR_TAB === 'project') {
    if (typeof renderProjectTab === 'function') renderProjectTab(content);
    else content.innerHTML = `<div class="chart-empty">Project module (client-project.js) is not loaded.</div>`;
    return;
  }

  if (MGR_TAB === 'employees') { renderEmployeesTab(content); return; }

  if (MGR_TAB === 'salary') {
    if (typeof renderSalaryTab === 'function') renderSalaryTab(content);
    else content.innerHTML = `<div class="chart-empty">Salary module (salary.js) is not loaded.</div>`;
    return;
  }

  if (MGR_TAB === 'client') {
    if (typeof renderClientTab === 'function') renderClientTab(content);
    else content.innerHTML = `<div class="chart-empty">Client module (client-project.js) is not loaded.</div>`;
    return;
  }
}

// ══════════════════════════════════════════════════
// EMPLOYEES MODULE — timesheet data, employee cards,
// day/week/month/all-time filtering, Employee Detail hook.
// ══════════════════════════════════════════════════
function renderEmployeesTab(content) {
  const filtered = getMgrFiltered();
  const worked   = filtered.filter(isWorkedEntry);
  const totHours = calcHours(worked);

  content.innerHTML = `
    <!-- Summary strip -->
    <div class="strip" style="margin-bottom:1.25rem">
      <div class="sitem"><span class="slbl">Total Hours</span><span class="sval hi" id="mTot">${fh(totHours)}</span></div>
      <div class="sitem"><span class="slbl">Employees</span><span class="sval" id="mEmpCnt">${new Set(filtered.map(e=>e.empId)).size}</span></div>
      <div class="sitem"><span class="slbl">Active Projects</span><span class="sval" id="mProjCnt">${new Set(worked.filter(e=>e.project).map(e=>e.project)).size}</span></div>
      <div class="sitem"><span class="slbl">Clients</span><span class="sval" id="mCliCnt">${new Set(worked.filter(e=>e.client&&e.client!=='Leave').map(e=>e.client)).size}</span></div>
    </div>

    <!-- Range controls -->
    <div class="mgr-controls">
      <div class="chart-range" id="mgrRange">
        <button class="rbtn${MGR_RANGE==='day15'?' active':''}"  data-range="day15">15 Days</button>
        <button class="rbtn${MGR_RANGE==='week'?' active':''}"   data-range="week">This Week</button>
        <button class="rbtn${MGR_RANGE==='month'?' active':''}"  data-range="month">This Month</button>
        <button class="rbtn${MGR_RANGE==='all'?' active':''}"    data-range="all">All Time</button>
      </div>
    </div>

    <!-- 15-day scroll -->
    <div id="mgrDayScroll" style="display:${MGR_RANGE==='day15'?'flex':'none'};
      gap:6px;margin-bottom:1rem;overflow-x:auto;padding-bottom:4px;"></div>

    <!-- Month picker -->
    <div id="mgrMonthPicker" style="display:${MGR_RANGE==='month'?'flex':'none'};
      gap:8px;margin-bottom:1rem;overflow-x:auto;padding-bottom:4px;"></div>

    <div id="mgrEmpContent"></div>
  `;

  // Range buttons
  $('mgrRange').addEventListener('click', e => {
    const btn = e.target.closest('.rbtn');
    if (!btn) return;
    MGR_RANGE = btn.dataset.range;
    MGR_DAY_OFFSET = 0;
    $('mgrRange').querySelectorAll('.rbtn').forEach(b => b.classList.toggle('active', b===btn));
    $('mgrDayScroll').style.display   = MGR_RANGE === 'day15'  ? 'flex' : 'none';
    $('mgrMonthPicker').style.display = MGR_RANGE === 'month'  ? 'flex' : 'none';
    if (MGR_RANGE === 'day15')  buildDayScrollBar();
    if (MGR_RANGE === 'month')  buildMonthPicker();
    renderEmpContent();
  });

  if (MGR_RANGE === 'day15') buildDayScrollBar();
  if (MGR_RANGE === 'month') buildMonthPicker();
  renderEmpContent();
}

function renderEmpContent() {
  const content = $('mgrEmpContent');
  if (!content) return;
  const filtered = getMgrFiltered();
  const worked   = filtered.filter(isWorkedEntry);

  const mTot = $('mTot'); if (mTot) mTot.textContent = fh(calcHours(worked));
  const mEmpCnt  = $('mEmpCnt');  if (mEmpCnt)  mEmpCnt.textContent  = new Set(filtered.map(e=>e.empId)).size;
  const mProjCnt = $('mProjCnt'); if (mProjCnt) mProjCnt.textContent = new Set(worked.filter(e=>e.project).map(e=>e.project)).size;
  const mCliCnt  = $('mCliCnt');  if (mCliCnt)  mCliCnt.textContent  = new Set(worked.filter(e=>e.client&&e.client!=='Leave').map(e=>e.client)).size;

  renderEmpCards(content, worked, filtered);
}

// ── EMPLOYEE CARDS ────────────────────────────────
function renderEmpCards(content, worked, all) {
  const empMap = {};
  MGR_EMPLOYEES.forEach((emp, idx) => {
    empMap[emp.id] = {
      id: emp.id, name: emp.name, team: emp.team, entryIndex: idx,
      hours: 0, days: new Set(), leaves: 0,
      projectMap: {}, missedDays: [],
      monthHours: 0, monthDays: 0, monthLeaves: 0, monthNotLogged: 0,
      monthProjectMap: {}, todayHours: 0, todayStatus: 'Working', lastActivityDate: '',
    };
  });

  worked.forEach(e => {
    if (!empMap[e.empId]) return;
    const h = parseH(e.hours);
    empMap[e.empId].hours += h;
    empMap[e.empId].days.add(e.date);
    if (e.project) empMap[e.empId].projectMap[e.project] = (empMap[e.empId].projectMap[e.project]||0) + h;
  });

  all.filter(e => e.status==='Leave').forEach(e => {
    if (empMap[e.empId]) { empMap[e.empId].leaves++; empMap[e.empId].days.add(e.date); }
  });

  // Missed days
  const rangeDates = getWorkingDaysInRange();
  Object.values(empMap).forEach(emp => {
    emp.missedDays = rangeDates.filter(d => !emp.days.has(d));
  });

  // Monthly summary + current-month project breakdown + today's status —
  // always computed from full MGR_DATA, independent of the active range filter.
  const curMonth  = todayStr().slice(0,7);
  const tod       = todayStr();
  const todayDow  = new Date().getDay(); // 0 = Sun, 6 = Sat
  const last5Dates = [];
  for (let i = 1; i <= 5; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last5Dates.push(toLocalDateStr(d));
  }

  const monthWorkingDaysSoFar = (() => {
    const [y, m] = curMonth.split('-').map(Number);
    const days = [];
    for (let d = 1; d <= new Date().getDate(); d++) {
      const dt = new Date(y, m - 1, d);
      const dow = dt.getDay();
      if (dow === 0 || dow === 6) continue;
      days.push(toLocalDateStr(dt));
    }
    return days;
  })();

  Object.values(empMap).forEach(emp => {
    const me = MGR_DATA.filter(e => e.empId === emp.id && e.date && e.date.startsWith(curMonth));
    const mw = me.filter(isWorkedEntry);
    emp.monthHours  = mw.reduce((s,e) => s + parseH(e.hours), 0);
    emp.monthDays   = new Set(mw.map(e => e.date)).size;
    emp.monthLeaves = me.filter(e => e.status === 'Leave').length;

    mw.forEach(e => {
      if (e.project) emp.monthProjectMap[e.project] = (emp.monthProjectMap[e.project]||0) + parseH(e.hours);
    });

    const loggedDatesThisMonth = new Set(me.map(e => e.date));
    emp.monthNotLogged = monthWorkingDaysSoFar.filter(d => !loggedDatesThisMonth.has(d)).length;

    const todayEntries = MGR_DATA.filter(e => e.empId === emp.id && e.date === tod);
    const todayLeave    = todayEntries.some(e => e.status === 'Leave');
    const todayWorked   = todayEntries.filter(isWorkedEntry);
    emp.todayHours = todayWorked.reduce((s,e) => s + parseH(e.hours), 0);

    if (todayLeave)                              emp.todayStatus = 'Leave';
    else if (todayDow === 0 || todayDow === 6)   emp.todayStatus = 'Weekend';
    else                                          emp.todayStatus = 'Working';

    // Attendance for the past 5 days — always shown regardless of
    // whatever range filter (Week/Month/etc.) is currently active,
    // same as Today already is. Each day's check-in/check-out/
    // duration is computed via getEmpDayAttendance, reused below for
    // the date picker so a custom date uses the exact same logic.
    emp.attendance5 = last5Dates.map(d => ({ date: d, ...getEmpDayAttendance(emp.id, d) }));

    // "Last entered" means last TIMESHEET ACTIVITY — whoever most
    // recently logged an actual entry — not when their employee
    // record was added to the sheet. entryIndex (row position) was
    // the wrong signal: it put employees at the top just because
    // they were added recently, even with zero recent activity.
    emp.lastActivityDate = MGR_DATA
      .filter(e => e.empId === emp.id)
      .reduce((max, e) => (e.date > max ? e.date : max), '');
  });

  // Most recently active employee first — whoever has the most
  // recent logged entry (of any kind) shows first; someone with no
  // recent activity sorts toward the end regardless of when they
  // were hired. Ties broken by total hours in the current range.
  const rows = Object.values(empMap).sort((a, b) => {
    if (a.lastActivityDate !== b.lastActivityDate) return b.lastActivityDate.localeCompare(a.lastActivityDate);
    return b.hours - a.hours;
  });
  if (!rows.length) { content.innerHTML = `<div class="chart-empty">No employees found.</div>`; return; }

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:1.25rem;margin-top:.5rem;">
      ${rows.map(emp => buildEmpCard(emp)).join('')}
    </div>`;

  content.querySelectorAll('.view-emp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openEmpDetail(btn.dataset.empId, btn.dataset.empName);
    });
  });

  content.querySelectorAll('.att-date-picker').forEach(inp => {
    inp.addEventListener('change', () => {
      const empId  = inp.dataset.empId;
      const picked = inp.value;
      const listEl = $(`attList-${empId}`);
      if (!picked || !listEl) return;

      const rec = getEmpDayAttendance(empId, picked);
      listEl.innerHTML = `
        ${buildAttendanceRows([{ ...rec, label: fmtDateShort(picked) }])}
        <button class="att-reset-btn" style="margin-top:6px;background:none;border:none;
          color:var(--a1);font-size:10.5px;font-weight:600;cursor:pointer;padding:0;">← Back to Last 5 Days</button>`;

      listEl.querySelector('.att-reset-btn')?.addEventListener('click', () => {
        const emp = rows.find(e => e.id === empId);
        if (emp) listEl.innerHTML = buildAttendanceRows(emp.attendance5.map(a => ({ ...a, label: fmtDateShort(a.date) })));
        inp.value = '';
      });
    });
  });
}

// Renders one row per attendance record — used both for the default
// past-5-days list and the date picker's single custom-date result.
function buildAttendanceRows(records) {
  if (!records.length) return `<div style="font-size:11px;color:var(--txt2);">No data</div>`;
  return records.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;
      border-bottom:1px solid var(--border);gap:8px;flex-wrap:wrap;">
      <span style="font-size:10.5px;color:var(--txt2);min-width:64px;flex-shrink:0;">${esc(r.label)}</span>
      ${r.hasEntry ? `
        <span style="font-size:11px;color:var(--txt1);white-space:nowrap;">
          <b>In</b> ${fmt12(r.checkIn)} <span style="color:var(--txt2);">→</span> <b>Out</b> ${fmt12(r.checkOut)}
        </span>
        <span style="font-size:11px;font-weight:700;color:var(--a1);white-space:nowrap;">${fh(r.hours)}</span>`
        : `<span style="font-size:11px;color:var(--txt2);">No entry</span>`}
    </div>`).join('');
}

function buildEmpCard(emp) {
  const initials      = emp.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
  const monthProjects = Object.entries(emp.monthProjectMap).sort((a,b) => b[1]-a[1]);
  const curMonthLabel = new Date(todayStr().slice(0,7)+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'});

  const STATUS_STYLE = {
    Working: { bg:'rgba(52,211,153,0.12)',  fg:'#34d399', label:'Working'  },
    Leave:   { bg:'rgba(251,191,36,0.12)',  fg:'#fbbf24', label:'On Leave' },
    Weekend: { bg:'rgba(124,92,252,0.12)',  fg:'#a78bfa', label:'Weekend'  },
  };
  const st = STATUS_STYLE[emp.todayStatus] || STATUS_STYLE.Working;

  const sliderHtml = monthProjects.length === 0
    ? `<div style="font-size:11px;color:var(--txt2);padding:6px 2px;">No projects logged this month</div>`
    : `<div style="display:flex;gap:8px;overflow-x:auto;padding:2px 2px 6px;-webkit-overflow-scrolling:touch;scrollbar-width:thin;">
        ${monthProjects.map(([proj,hrs],i) => `
          <div style="flex-shrink:0;display:flex;align-items:center;gap:6px;
            background:var(--surface2);border:1px solid var(--border);border-radius:20px;
            padding:6px 12px;white-space:nowrap;">
            <span style="width:7px;height:7px;border-radius:50%;background:${MGR_PALETTE[i%MGR_PALETTE.length]};flex-shrink:0;"></span>
            <span style="font-size:11px;color:var(--txt1);font-weight:600;max-width:130px;
              overflow:hidden;text-overflow:ellipsis;" title="${esc(proj)}">${esc(proj)}</span>
            <span style="font-size:11px;color:var(--txt2);">— ${fh(hrs)}</span>
          </div>`).join('')}
      </div>`;

  return `
    <div class="emp-card" style="background:var(--surface1);
      border:1px solid var(--border);border-radius:14px;padding:1.1rem;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:.9rem;">
        <div style="width:38px;height:38px;border-radius:50%;
          background:linear-gradient(135deg,var(--a1),#7c5cfc);
          display:flex;align-items:center;justify-content:center;
          font-weight:700;font-size:13px;color:#fff;flex-shrink:0;">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;color:var(--txt1);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(emp.name)}</div>
          <div style="font-size:11px;color:var(--txt2);">${esc(emp.id)}</div>
        </div>
        <button class="view-emp-btn" data-emp-id="${emp.id}" data-emp-name="${esc(emp.name)}"
          style="background:var(--a1);color:#fff;border:none;border-radius:6px;
            padding:5px 12px;font-size:10px;font-weight:600;cursor:pointer;
            white-space:nowrap;flex-shrink:0;">
          View Details →
        </button>
      </div>

      <div style="margin-bottom:.9rem;">
        <span style="display:inline-flex;align-items:center;gap:5px;background:${st.bg};color:${st.fg};
          border-radius:20px;padding:4px 10px;font-size:11px;font-weight:700;">
          <span style="width:6px;height:6px;border-radius:50%;background:${st.fg};"></span>${st.label}
        </span>
      </div>

      <div class="att-widget" style="margin-bottom:.9rem;padding:8px 12px;background:var(--surface2);border-radius:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;flex-wrap:wrap;gap:6px;">
          <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;">Attendance</div>
          <input type="date" class="att-date-picker" data-emp-id="${emp.id}" max="${todayStr()}"
            style="background:var(--surface1);border:1px solid var(--border);border-radius:6px;
            color:var(--txt1);font-size:10.5px;padding:3px 6px;cursor:pointer;"/>
        </div>
        <div class="att-list" id="attList-${emp.id}">
          ${buildAttendanceRows(emp.attendance5.map(a => ({ ...a, label: fmtDateShort(a.date) })))}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:.9rem;">
        <div style="background:var(--surface2);border-radius:10px;padding:8px 12px;">
          <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;">Today</div>
          <div style="font-size:16px;font-weight:800;color:var(--txt1);">${fh(emp.todayHours)}</div>
        </div>
        <div style="background:var(--surface2);border-radius:10px;padding:8px 12px;">
          <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;">This Month</div>
          <div style="font-size:16px;font-weight:800;color:var(--a1);">${fh(emp.monthHours)}</div>
        </div>
        <div style="background:var(--surface2);border-radius:10px;padding:8px 12px;">
          <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;">Leaves</div>
          <div style="font-size:16px;font-weight:800;color:#fbbf24;">${emp.monthLeaves}</div>
        </div>
        <div style="background:var(--surface2);border-radius:10px;padding:8px 12px;">
          <div style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;">Not Logged</div>
          <div style="font-size:16px;font-weight:800;color:${emp.monthNotLogged > 0 ? '#f87171' : 'var(--txt1)'};">${emp.monthNotLogged}</div>
        </div>
      </div>

      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;">Projects · ${esc(curMonthLabel)}</span>
          <span style="font-size:10px;color:var(--txt1);font-weight:700;background:var(--surface2);
            border-radius:10px;padding:2px 8px;">${monthProjects.length} total</span>
        </div>
        ${sliderHtml}
      </div>
    </div>`;
}

// ══════════════════════════════════════════════════
// RANGE / SCROLL / PICKER HELPERS
// ══════════════════════════════════════════════════
function buildDayScrollBar() {
  const bar = $('mgrDayScroll'); if (!bar) return;
  const days = getLast15Days();
  bar.innerHTML = days.map((d,i) => {
    const isActive  = i===MGR_DAY_OFFSET;
    const isWeekend = new Date(d+'T00:00:00').getDay()%6===0;
    return `<button data-offset="${i}" style="flex-shrink:0;padding:5px 14px;border-radius:20px;
      border:1px solid ${isActive?'var(--a1)':'var(--border)'};
      background:${isActive?'var(--a1)':'var(--surface2)'};
      color:${isActive?'#fff':isWeekend?'#a78bfa':'var(--txt1)'};
      font-size:11px;cursor:pointer;white-space:nowrap;">${fmtDateShort(d)}</button>`;
  }).join('');
  bar.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', ()=>{ MGR_DAY_OFFSET=parseInt(btn.dataset.offset); buildDayScrollBar(); renderEmpContent(); });
  });
}

function buildMonthPicker() {
  const picker = $('mgrMonthPicker'); if (!picker) return;
  const months = [];
  const now = new Date();
  for (let i=0;i<12;i++){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    months.push({val:toLocalDateStr(d).slice(0,7),label:d.toLocaleDateString('en-IN',{month:'short',year:'numeric'})});
  }
  picker.innerHTML = `
    <div style="display:flex;gap:6px;overflow-x:auto;flex:1;padding-bottom:2px;">
      ${months.map(m=>`<button data-month="${m.val}" style="flex-shrink:0;padding:5px 14px;border-radius:20px;
        border:1px solid ${m.val===MGR_SELECTED_MONTH?'var(--a1)':'var(--border)'};
        background:${m.val===MGR_SELECTED_MONTH?'var(--a1)':'var(--surface2)'};
        color:${m.val===MGR_SELECTED_MONTH?'#fff':'var(--txt1)'};
        font-size:11px;cursor:pointer;white-space:nowrap;">${m.label}</button>`).join('')}
    </div>
    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:8px;">
      <span style="font-size:11px;color:var(--txt2);white-space:nowrap;">Pick date:</span>
      <input type="date" id="mgrDatePicker" max="${todayStr()}" value="${MGR_SELECTED_MONTH+'-01'}"
        style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;
        color:var(--txt1);font-size:11px;padding:4px 8px;cursor:pointer;"/>
    </div>`;

  picker.querySelectorAll('button[data-month]').forEach(btn => {
    btn.addEventListener('click', ()=>{ MGR_SELECTED_MONTH=btn.dataset.month; buildMonthPicker(); renderEmpContent(); });
  });

  const dp = document.getElementById('mgrDatePicker');
  if (dp) {
    dp.addEventListener('change', ()=>{
      const picked = dp.value; if (!picked) return;
      MGR_RANGE='day15';
      $('mgrRange')?.querySelectorAll('.rbtn').forEach(b=>b.classList.toggle('active',b.dataset.range==='day15'));
      const diffDays=Math.round((new Date().setHours(0,0,0,0)-new Date(picked+'T00:00:00').getTime())/86400000);
      MGR_DAY_OFFSET=Math.max(0,Math.min(14,diffDays));
      $('mgrMonthPicker').style.display='none';
      $('mgrDayScroll').style.display='flex';
      buildDayScrollBar(); renderEmpContent();
    });
  }
}

function getMgrFiltered() {
  const tod=todayStr(), ws=weekStart();
  if (MGR_RANGE==='day15') { const s=getLast15Days()[MGR_DAY_OFFSET]; return MGR_DATA.filter(e=>e.date===s); }
  if (MGR_RANGE==='week')  return MGR_DATA.filter(e=>e.date>=ws&&e.date<=tod);
  if (MGR_RANGE==='month') return MGR_DATA.filter(e=>e.date.startsWith(MGR_SELECTED_MONTH));
  return MGR_DATA;
}

function getMgrRangeLabel() {
  if (MGR_RANGE==='day15') return fmtDateShort(getLast15Days()[MGR_DAY_OFFSET]);
  if (MGR_RANGE==='week')  return 'This Week';
  if (MGR_RANGE==='month') {
    const [y,m]=MGR_SELECTED_MONTH.split('-');
    return new Date(parseInt(y),parseInt(m)-1,1).toLocaleDateString('en-IN',{month:'short',year:'numeric'});
  }
  return 'All Time';
}

function getWorkingDaysInRange() {
  const tod=todayStr(); let start,end;
  if (MGR_RANGE==='day15') return [getLast15Days()[MGR_DAY_OFFSET]];
  if (MGR_RANGE==='week')  { start=weekStart(); end=tod; }
  else if (MGR_RANGE==='month') {
    const [y,m]=MGR_SELECTED_MONTH.split('-').map(Number);
    start=MGR_SELECTED_MONTH+'-01';
    end=MGR_SELECTED_MONTH+'-'+String(new Date(y,m,0).getDate()).padStart(2,'0');
    if (end>tod) end=tod;
  } else { const d=new Date(); d.setDate(d.getDate()-90); start=toLocalDateStr(d); end=tod; }
  const dates=[]; const cur=new Date(start+'T00:00:00'); const endDate=new Date(end+'T00:00:00');
  while(cur<=endDate){ const day=cur.getDay(); if(day!==0&&day!==6) dates.push(toLocalDateStr(cur)); cur.setDate(cur.getDate()+1); }
  return dates;
}

function getLast15Days() {
  const dates=[];
  for(let i=0;i<15;i++){ const d=new Date(); d.setDate(d.getDate()-i); dates.push(toLocalDateStr(d)); }
  return dates;
}

// Force Leave is handled in emp-detail.js

// ── GENERAL HELPERS ───────────────────────────────
// Timezone-safe 'YYYY-MM-DD' from a Date's LOCAL components. Every
// .toISOString().slice(0,N) call in this file was silently wrong in
// any UTC+ timezone (like IST): toISOString() always converts to
// UTC first, and a date built as local midnight (e.g. the 1st of a
// month) rolls back to the previous day/month once converted —
// exactly the "month picker shows Jul but loads Jun" bug. This uses
// the Date's own local getFullYear/getMonth/getDate instead, same
// safe approach utils.js's todayStr() already uses elsewhere.
function toLocalDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// An entry counts as "worked" only if it's neither a Leave nor a
// Holiday — both are non-working statuses. Every filter in this file
// that used to check `status !== 'Leave'` alone was letting Holiday
// entries slip through as if they were worked days (with 0 hours,
// but still counted toward "Days" totals) — Holiday needs the same
// exclusion Leave already gets, everywhere "worked" is computed.
function isWorkedEntry(e) { return e.status !== 'Leave' && e.status !== 'Holiday'; }

function calcHours(arr) { return arr.filter(isWorkedEntry).reduce((s,e)=>s+parseH(e.hours),0); }

// Check-in / check-out / worked-duration for one employee on one
// specific date. Earliest logged Time In and latest logged Time Out
// across that day's worked entries (Leave entries excluded, since
// there's no meaningful check-in/out on a day off). Used both for
// the default past-5-days list and the date picker's custom lookup —
// same logic either way.
function getEmpDayAttendance(empId, date) {
  const entries = MGR_DATA.filter(e => e.empId === empId && e.date === date).filter(isWorkedEntry);
  if (!entries.length) return { hasEntry: false, checkIn: null, checkOut: null, hours: 0 };
  const timesIn  = entries.map(e => e.timeIn).filter(Boolean).sort();
  const timesOut = entries.map(e => e.timeOut).filter(Boolean).sort();
  const hours    = entries.reduce((s, e) => s + parseH(e.hours), 0);
  return { hasEntry: true, checkIn: timesIn[0] || null, checkOut: timesOut[timesOut.length - 1] || null, hours };
}

function parseH(val) {
  if(!val) return 0;
  const s=String(val).trim();
  const h=(s.match(/(\d+)h/)||[])[1], m=(s.match(/(\d+)m/)||[])[1];
  if(!h&&!m) return parseFloat(s)||0;
  return (parseInt(h||0)*60+parseInt(m||0))/60;
}

function fmtDateShort(dateStr) {
  return new Date(dateStr+'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
}

function fmtNum(n) {
  return Number(n).toLocaleString('en-IN',{maximumFractionDigits:0});
}

function toMinutes(t) {
  if(!t) return 0;
  const [h,m]=t.split(':').map(Number);
  return h*60+m;
}

function fmt12(t) {
  if(!t) return '--:--';
  const [h,m]=t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
}