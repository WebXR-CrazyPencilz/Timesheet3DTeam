// ═══════════════════════════════════════════════════
// TEAMLEADER.JS — Team Leader Portal
// Tabs: Employees | Projects
// Access: All employees, force leave, project hours + resources
// No financial data (that's manager only)
// ═══════════════════════════════════════════════════

// ── STATE ─────────────────────────────────────────
let TL_DATA        = [];
let TL_EMPLOYEES   = [];
let TL_CLIENTS     = [];
let TL_PROJECTS    = [];

let TL_TAB         = 'employees';   // employees | projects
let TL_RANGE       = 'week';
let TL_DAY_OFFSET  = 0;
let TL_MONTH       = '';

const TL_PALETTE = [
  '#4f8ef7','#7c5cfc','#34d399','#fbbf24',
  '#f87171','#22d3ee','#fb923c','#a78bfa',
  '#f472b6','#84cc16','#38bdf8','#4ade80',
];

// ── INIT ──────────────────────────────────────────
async function initTeamLeader() {
  TL_MONTH = todayStr().slice(0,7);
  const container = $('tlApp');
  if (!container) return;

  const av = $('tlAv');
  if (av) av.textContent = 'TL';

  container.innerHTML = `<div class="mgr-loading">
    <div class="slot-spinner"></div>
    <span>Loading team data…</span>
  </div>`;

  try {
    const master = await apiGetMasterData();
    TL_EMPLOYEES = master.employees || [];
    TL_CLIENTS   = master.clients   || [];
    TL_PROJECTS  = master.projects  || [];

    const results = await Promise.all(
      TL_EMPLOYEES.map(emp =>
        apiGetAllHistory(emp.id)
          .then(entries => entries.map(e => ({ ...e, empId: emp.id, empName: emp.name, empTeam: emp.team })))
          .catch(() => [])
      )
    );
    TL_DATA = results.flat();

    renderTLPortal();
  } catch(err) {
    container.innerHTML = `<div class="slot-error">Failed to load: ${err.message}</div>`;
  }
}

// ── RENDER PORTAL SHELL ───────────────────────────
function renderTLPortal() {
  const container = $('tlApp');
  if (!container) return;

  container.innerHTML = `
    <!-- Top nav tabs -->
    <div style="display:flex;gap:4px;margin-bottom:1.5rem;border-bottom:1px solid var(--border);padding-bottom:0;">
      ${[
        { id:'employees', icon:'👥', label:'Employees' },
        { id:'projects',  icon:'📁', label:'Projects'  },
      ].map(t => `
        <button class="tl-tab${TL_TAB===t.id?' active':''}" data-tab="${t.id}" style="
          padding:8px 16px;border:none;background:none;cursor:pointer;
          font-size:13px;font-weight:600;
          color:${TL_TAB===t.id?'var(--a1)':'var(--txt2)'};
          border-bottom:2px solid ${TL_TAB===t.id?'var(--a1)':'transparent'};
          margin-bottom:-1px;transition:all .2s;
        ">${t.icon} ${t.label}</button>
      `).join('')}
    </div>
    <div id="tlTabContent"></div>
  `;

  container.querySelectorAll('.tl-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      TL_TAB = btn.dataset.tab;
      container.querySelectorAll('.tl-tab').forEach(b => {
        const active = b === btn;
        b.style.color        = active ? 'var(--a1)' : 'var(--txt2)';
        b.style.borderBottom = active ? '2px solid var(--a1)' : '2px solid transparent';
      });
      renderTLTab();
    });
  });

  renderTLTab();
}

// ── ROUTE TO TAB ──────────────────────────────────
function renderTLTab() {
  const content = $('tlTabContent');
  if (!content) return;
  if (TL_TAB === 'employees') renderTLEmployeesTab(content);
  if (TL_TAB === 'projects')  renderTLProjectsTab(content);
}

// ══════════════════════════════════════════════════
// TAB 1: EMPLOYEES
// ══════════════════════════════════════════════════
function renderTLEmployeesTab(content) {
  const filtered = getTLFiltered();
  const worked   = filtered.filter(e => e.status !== 'Leave');
  const totHours = tlCalcHours(worked);

  content.innerHTML = `
    <!-- Summary strip -->
    <div class="strip" style="margin-bottom:1.25rem">
      <div class="sitem"><span class="slbl">Total Hours</span><span class="sval hi" id="tlTot">${fh(totHours)}</span></div>
      <div class="sitem"><span class="slbl">Employees</span><span class="sval" id="tlEmpCnt">${new Set(filtered.map(e=>e.empId)).size}</span></div>
      <div class="sitem"><span class="slbl">Active Projects</span><span class="sval" id="tlProjCnt">${new Set(worked.filter(e=>e.project).map(e=>e.project)).size}</span></div>
      <div class="sitem"><span class="slbl">Clients</span><span class="sval" id="tlCliCnt">${new Set(worked.filter(e=>e.client&&e.client!=='Leave').map(e=>e.client)).size}</span></div>
    </div>

    <!-- Range controls -->
    <div class="mgr-controls">
      <div class="chart-range" id="tlRange">
        <button class="rbtn${TL_RANGE==='day15'?' active':''}"  data-range="day15">15 Days</button>
        <button class="rbtn${TL_RANGE==='week'?' active':''}"   data-range="week">This Week</button>
        <button class="rbtn${TL_RANGE==='month'?' active':''}"  data-range="month">This Month</button>
        <button class="rbtn${TL_RANGE==='all'?' active':''}"    data-range="all">All Time</button>
      </div>
    </div>

    <!-- 15-day scroll -->
    <div id="tlDayScroll" style="display:${TL_RANGE==='day15'?'flex':'none'};
      gap:6px;margin-bottom:1rem;overflow-x:auto;padding-bottom:4px;"></div>

    <!-- Month picker -->
    <div id="tlMonthPicker" style="display:${TL_RANGE==='month'?'flex':'none'};
      gap:8px;margin-bottom:1rem;overflow-x:auto;padding-bottom:4px;"></div>

    <!-- Employee cards -->
    <div id="tlEmpCards"></div>
  `;

  $('tlRange').addEventListener('click', e => {
    const btn = e.target.closest('.rbtn');
    if (!btn) return;
    TL_RANGE = btn.dataset.range;
    TL_DAY_OFFSET = 0;
    $('tlRange').querySelectorAll('.rbtn').forEach(b => b.classList.toggle('active', b===btn));
    $('tlDayScroll').style.display   = TL_RANGE==='day15' ? 'flex' : 'none';
    $('tlMonthPicker').style.display = TL_RANGE==='month' ? 'flex' : 'none';
    if (TL_RANGE==='day15') buildTLDayScroll();
    if (TL_RANGE==='month') buildTLMonthPicker();
    renderTLEmpCards();
  });

  if (TL_RANGE==='day15') buildTLDayScroll();
  if (TL_RANGE==='month') buildTLMonthPicker();
  renderTLEmpCards();
}

function renderTLEmpCards() {
  const content  = $('tlEmpCards');
  if (!content) return;
  const filtered = getTLFiltered();
  const worked   = filtered.filter(e => e.status !== 'Leave');

  // Update summary strip
  const tlTot     = $('tlTot');     if (tlTot)     tlTot.textContent     = fh(tlCalcHours(worked));
  const tlEmpCnt  = $('tlEmpCnt');  if (tlEmpCnt)  tlEmpCnt.textContent  = new Set(filtered.map(e=>e.empId)).size;
  const tlProjCnt = $('tlProjCnt'); if (tlProjCnt) tlProjCnt.textContent = new Set(worked.filter(e=>e.project).map(e=>e.project)).size;
  const tlCliCnt  = $('tlCliCnt');  if (tlCliCnt)  tlCliCnt.textContent  = new Set(worked.filter(e=>e.client&&e.client!=='Leave').map(e=>e.client)).size;

  // Build employee map
  const empMap = {};
  TL_EMPLOYEES.forEach(emp => {
    empMap[emp.id] = {
      id: emp.id, name: emp.name, team: emp.team,
      hours: 0, days: new Set(), leaves: 0,
      projectMap: {}, missedDays: [],
      monthHours: 0, monthDays: 0, monthLeaves: 0,
    };
  });

  worked.forEach(e => {
    if (!empMap[e.empId]) return;
    const h = tlParseH(e.hours);
    empMap[e.empId].hours += h;
    empMap[e.empId].days.add(e.date);
    if (e.project) empMap[e.empId].projectMap[e.project] = (empMap[e.empId].projectMap[e.project]||0) + h;
  });

  filtered.filter(e=>e.status==='Leave').forEach(e => {
    if (empMap[e.empId]) { empMap[e.empId].leaves++; empMap[e.empId].days.add(e.date); }
  });

  // Missed working days
  const rangeDates = getTLWorkingDays();
  Object.values(empMap).forEach(emp => {
    emp.missedDays = rangeDates.filter(d => !emp.days.has(d));
  });

  // Monthly summary
  const curMonth = todayStr().slice(0,7);
  Object.values(empMap).forEach(emp => {
    const me = TL_DATA.filter(e => e.empId===emp.id && e.date.startsWith(curMonth));
    const mw = me.filter(e => e.status!=='Leave');
    emp.monthHours  = mw.reduce((s,e) => s+tlParseH(e.hours), 0);
    emp.monthDays   = new Set(mw.map(e=>e.date)).size;
    emp.monthLeaves = me.filter(e=>e.status==='Leave').length;
  });

  const rows = Object.values(empMap).sort((a,b) => b.hours-a.hours);
  if (!rows.length) { content.innerHTML = `<div class="chart-empty">No employees found.</div>`; return; }

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-top:.5rem;">
      ${rows.map(emp => buildTLEmpCard(emp)).join('')}
    </div>`;

  content.querySelectorAll('.tl-leave-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await applyTLLeave(btn, btn.dataset.empId, btn.dataset.date, btn.dataset.empName);
    });
  });
}

// ── EMPLOYEE CARD ─────────────────────────────────
function buildTLEmpCard(emp) {
  const projects   = Object.entries(emp.projectMap).sort((a,b)=>b[1]-a[1]);
  const totalHours = emp.hours;
  const hasMissed  = emp.missedDays.length > 0;
  const initials   = emp.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
  const rangeLabel = getTLRangeLabel();
  const curMonth   = new Date(todayStr().slice(0,7)+'-01')
    .toLocaleDateString('en-IN',{month:'long',year:'numeric'});

  // Legend
  const legendHtml = projects.length === 0
    ? `<div style="font-size:12px;color:var(--txt2);">No projects logged</div>`
    : projects.slice(0,5).map(([proj,hrs],i) => `
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${TL_PALETTE[i%TL_PALETTE.length]};flex-shrink:0;"></span>
          <span style="font-size:11px;color:var(--txt2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(proj)}">${esc(proj)}</span>
          <span style="font-size:11px;color:var(--txt1);font-weight:600;">${fh(hrs)}</span>
        </div>`).join('') +
      (projects.length>5?`<div style="font-size:10px;color:var(--txt2);">+${projects.length-5} more</div>`:'');

  // Monthly strip
  const monthStrip = `
    <div style="margin-top:10px;padding:8px 12px;background:var(--surface2);border-radius:8px;
      display:flex;align-items:center;border:1px solid var(--border);">
      <span style="font-size:11px;color:var(--txt2);font-weight:600;margin-right:10px;white-space:nowrap;">📅 ${curMonth}</span>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:4px;">
          <span style="font-size:11px;color:var(--txt2);">Worked</span>
          <span style="font-size:12px;font-weight:700;color:var(--a1);">${fh(emp.monthHours)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <span style="font-size:11px;color:var(--txt2);">Days</span>
          <span style="font-size:12px;font-weight:700;color:var(--txt1);">${emp.monthDays}</span>
        </div>
        ${emp.monthLeaves>0?`
        <div style="display:flex;align-items:center;gap:4px;">
          <span style="font-size:11px;color:var(--txt2);">Leaves</span>
          <span style="font-size:12px;font-weight:700;color:#fbbf24;">${emp.monthLeaves}</span>
        </div>`:''}
      </div>
    </div>`;

  // Missed days
  const missedSection = hasMissed ? `
    <div class="missed-section" style="margin-top:10px;border-top:1px solid rgba(239,68,68,0.25);padding-top:10px;">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:7px;">
        <span>⚠️</span>
        <span class="tl-missed-count" style="color:#ef4444;font-size:11px;font-weight:600;">
          ${emp.missedDays.length} day${emp.missedDays.length>1?'s':''} not logged
        </span>
      </div>
      ${emp.missedDays.map(date=>`
        <div class="tl-missed-row" style="display:flex;align-items:center;justify-content:space-between;
          padding:5px 10px;margin-bottom:5px;background:rgba(239,68,68,0.07);
          border:1px solid rgba(239,68,68,0.2);border-radius:7px;gap:8px;">
          <span style="font-size:11px;color:var(--txt1);white-space:nowrap;">${tlFmtDate(date)}</span>
          <button class="tl-leave-btn"
            data-emp-id="${emp.id}" data-emp-name="${esc(emp.name)}" data-date="${date}"
            style="background:#ef4444;color:#fff;border:none;border-radius:5px;
              padding:4px 12px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;">
            Force Leave</button>
        </div>`).join('')}
    </div>` : '';

  // Day view: check-in/out
  const isDayView = TL_RANGE === 'day15';
  let dayInfoHtml = '';
  if (isDayView && totalHours > 0) {
    const selDate  = getTL15Days()[TL_DAY_OFFSET];
    const dayEnts  = TL_DATA.filter(e=>e.empId===emp.id&&e.date===selDate&&e.status!=='Leave');
    const timesIn  = dayEnts.map(e=>e.timeIn).filter(Boolean).sort();
    const timesOut = dayEnts.map(e=>e.timeOut).filter(Boolean).sort();
    const tIn      = timesIn[0] || null;
    const tOut     = timesOut[timesOut.length-1] || null;
    const outMins  = tOut ? tlToMins(tOut) : 0;
    const isExt    = outMins > tlToMins('19:30');
    const extH     = isExt ? (outMins - tlToMins('19:30'))/60 : 0;

    dayInfoHtml = `
      <div style="margin-top:10px;padding:10px 12px;background:var(--surface2);border-radius:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span>🕘</span>
            <span style="font-size:11px;color:var(--txt2);">Check In</span>
            <span style="font-size:12px;font-weight:700;color:var(--txt1);">${tlFmt12(tIn)}</span>
          </div>
          <span style="font-size:11px;color:var(--txt2);">→</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span>🕔</span>
            <span style="font-size:11px;color:var(--txt2);">Check Out</span>
            <span style="font-size:12px;font-weight:700;color:var(--txt1);">${tlFmt12(tOut)}</span>
          </div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:8px;display:flex;gap:14px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:4px;">
            <span>🍽</span><span style="font-size:11px;color:var(--txt2);">Lunch</span>
            <span style="font-size:12px;font-weight:700;color:var(--txt1);">45m</span>
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <span>⏱</span><span style="font-size:11px;color:var(--txt2);">Worked</span>
            <span style="font-size:12px;font-weight:700;color:var(--txt1);">${fh(totalHours)}</span>
          </div>
          ${isExt?`<div style="display:flex;align-items:center;gap:4px;">
            <span>🌙</span><span style="font-size:11px;color:var(--txt2);">Extended</span>
            <span style="font-size:12px;font-weight:700;color:#a78bfa;">${fh(extH)}</span>
          </div>`:''}
        </div>
        ${isExt?`<div style="margin-top:6px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);
          border-radius:6px;padding:4px 8px;font-size:10px;color:#a78bfa;font-weight:600;">
          🌙 Extended: stayed until ${tlFmt12(tOut)}</div>`:''}
      </div>`;
  }

  const donutSvg = buildTLDonut(projects, totalHours);

  return `
    <div class="emp-card" style="background:var(--surface1);
      border:1px solid ${hasMissed?'rgba(239,68,68,0.4)':'var(--border)'};border-radius:14px;padding:1.2rem;">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem;">
        <div style="width:36px;height:36px;border-radius:50%;
          background:linear-gradient(135deg,var(--a1),#7c5cfc);
          display:flex;align-items:center;justify-content:center;
          font-weight:700;font-size:13px;color:#fff;flex-shrink:0;">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;color:var(--txt1);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(emp.name)}</div>
          <div style="font-size:11px;color:var(--txt2);">${esc(emp.team)}</div>
        </div>
        ${emp.leaves>0?`<span style="background:rgba(251,191,36,0.15);color:#fbbf24;
          border-radius:5px;padding:2px 8px;font-size:10px;font-weight:600;">${emp.leaves}L</span>`:''}
      </div>

      <!-- Donut LEFT + Legend RIGHT -->
      <div style="display:flex;align-items:center;gap:1.2rem;">
        <div style="position:relative;width:160px;height:160px;flex-shrink:0;">
          ${donutSvg}
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;
            align-items:center;justify-content:center;pointer-events:none;">
            <span style="font-size:18px;font-weight:800;color:var(--txt1);line-height:1.1;">${fh(totalHours)}</span>
            <span style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.6px;margin-top:3px;">${rangeLabel}</span>
          </div>
        </div>
        <div style="flex:1;min-width:0;">${legendHtml}</div>
      </div>

      ${monthStrip}
      ${dayInfoHtml}
      ${missedSection}
    </div>`;
}

// ══════════════════════════════════════════════════
// TAB 2: PROJECTS
// ══════════════════════════════════════════════════
function renderTLProjectsTab(content) {
  // Aggregate all project data from entries
  const projMap = {};
  TL_DATA.filter(e=>e.status!=='Leave'&&e.project).forEach(e => {
    const key = e.projectId || e.project;
    if (!projMap[key]) {
      projMap[key] = {
        id: e.projectId||'', name: e.project,
        clientId: e.clientId||'', client: e.client||'—',
        hours: 0, employees: new Set(), tasks: new Set(),
        weekHours: 0, monthHours: 0,
      };
    }
    const h    = tlParseH(e.hours);
    const isWk = e.date >= weekStart() && e.date <= todayStr();
    const isMo = e.date.startsWith(todayStr().slice(0,7));
    projMap[key].hours += h;
    if (isWk) projMap[key].weekHours  += h;
    if (isMo) projMap[key].monthHours += h;
    projMap[key].employees.add(e.empId);
    if (e.task) projMap[key].tasks.add(e.task);
  });

  const rows  = Object.values(projMap).sort((a,b)=>b.hours-a.hours);
  const total = rows.reduce((s,r)=>s+r.hours,0);

  content.innerHTML = `
    <div style="font-size:16px;font-weight:700;color:var(--txt1);margin-bottom:1.25rem;">
      Project Overview
      <span style="font-size:12px;font-weight:400;color:var(--txt2);margin-left:8px;">${rows.length} active project${rows.length!==1?'s':''}</span>
    </div>

    <!-- Project cards -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;">
      ${rows.length === 0
        ? `<div style="grid-column:span 2;text-align:center;padding:2rem;color:var(--txt2);">No project data found.</div>`
        : rows.map((proj,idx) => buildTLProjCard(proj, idx, total)).join('')}
    </div>`;
}

function buildTLProjCard(proj, idx, total) {
  const color    = TL_PALETTE[idx % TL_PALETTE.length];
  const pct      = total > 0 ? Math.round((proj.hours/total)*100) : 0;
  const resources = [...proj.employees].map(eid => {
    const emp   = TL_EMPLOYEES.find(e=>e.id===eid);
    const empH  = tlCalcHours(TL_DATA.filter(e=>e.empId===eid&&e.project===proj.name&&e.status!=='Leave'));
    return { name: emp?.name||eid, hours: empH };
  }).sort((a,b)=>b.hours-a.hours);

  return `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:14px;padding:1.2rem;">
      <!-- Project header -->
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:1rem;">
        <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0;margin-top:3px;"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:14px;color:var(--txt1);
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(proj.name)}">${esc(proj.name)}</div>
          <div style="font-size:11px;color:var(--txt2);margin-top:2px;">${esc(proj.client)}</div>
        </div>
      </div>

      <!-- Hours stats -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:1rem;">
        <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center;">
          <div style="font-size:10px;color:var(--txt2);">Total</div>
          <div style="font-size:14px;font-weight:700;color:var(--a1);">${fh(proj.hours)}</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center;">
          <div style="font-size:10px;color:var(--txt2);">This Week</div>
          <div style="font-size:14px;font-weight:700;color:var(--txt1);">${fh(proj.weekHours)}</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center;">
          <div style="font-size:10px;color:var(--txt2);">This Month</div>
          <div style="font-size:14px;font-weight:700;color:var(--txt1);">${fh(proj.monthHours)}</div>
        </div>
      </div>

      <!-- Share bar -->
      <div style="margin-bottom:1rem;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:11px;color:var(--txt2);">Share of total hours</span>
          <span style="font-size:11px;font-weight:600;color:var(--txt1);">${pct}%</span>
        </div>
        <div style="background:var(--surface2);border-radius:4px;height:6px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width .5s;"></div>
        </div>
      </div>

      <!-- Resources -->
      <div>
        <div style="font-size:10px;color:var(--txt2);margin-bottom:6px;
          text-transform:uppercase;letter-spacing:.5px;">
          Team (${resources.length} member${resources.length!==1?'s':''})
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${resources.slice(0,5).map(r => `
            <div style="display:flex;align-items:center;justify-content:space-between;
              padding:4px 8px;background:var(--surface2);border-radius:6px;">
              <span style="font-size:11px;color:var(--txt1);">${esc(r.name)}</span>
              <span style="font-size:11px;font-weight:600;color:var(--a1);">${fh(r.hours)}</span>
            </div>`).join('')}
          ${resources.length>5?`<div style="font-size:10px;color:var(--txt2);padding:2px 8px;">+${resources.length-5} more</div>`:''}
        </div>
      </div>

      <!-- Tasks -->
      ${proj.tasks.size>0?`
      <div style="margin-top:10px;">
        <div style="font-size:10px;color:var(--txt2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px;">Tasks</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
          ${[...proj.tasks].map(t=>`<span style="background:var(--surface2);border:1px solid var(--border);
            border-radius:5px;padding:2px 8px;font-size:10px;color:var(--txt2);">${esc(t)}</span>`).join('')}
        </div>
      </div>`:''}
    </div>`;
}

// ── FORCE LEAVE ───────────────────────────────────
async function applyTLLeave(btn, empId, date, empName) {
  btn.disabled=true; btn.textContent='…';
  try {
    await sheetGET({ action:'forceLeave', data: encodeURIComponent(JSON.stringify({ uid:empId, date })) });
    const row=btn.closest('.tl-missed-row');
    if(row){ row.style.opacity='.4'; btn.textContent='✓ Done'; btn.style.background='#34d399'; }
    TL_DATA.push({empId,date,status:'Leave',hours:'0h',empName,empTeam:''});
    const card=btn.closest('.emp-card');
    if(card){
      const rem=card.querySelectorAll('.tl-leave-btn:not([disabled])').length-1;
      const badge=card.querySelector('.tl-missed-count');
      if(badge){
        if(rem<=0){ card.querySelector('.missed-section')?.remove(); card.style.borderColor='var(--border)'; }
        else badge.textContent=`${rem} day${rem>1?'s':''} not logged`;
      }
    }
    tlToast(`✅ Leave applied — ${empName} on ${tlFmtDate(date)}`);
  } catch(err) {
    btn.disabled=false; btn.textContent='Force Leave';
    tlToast(`❌ Failed: ${err.message}`, true);
  }
}

// ── DAY SCROLL ────────────────────────────────────
function buildTLDayScroll() {
  const bar = $('tlDayScroll'); if (!bar) return;
  const days = getTL15Days();
  bar.innerHTML = days.map((d,i) => {
    const isActive  = i===TL_DAY_OFFSET;
    const isWeekend = new Date(d+'T00:00:00').getDay()%6===0;
    return `<button data-offset="${i}" style="flex-shrink:0;padding:5px 14px;border-radius:20px;
      border:1px solid ${isActive?'var(--a1)':'var(--border)'};
      background:${isActive?'var(--a1)':'var(--surface2)'};
      color:${isActive?'#fff':isWeekend?'#a78bfa':'var(--txt1)'};
      font-size:11px;cursor:pointer;white-space:nowrap;">${tlFmtDate(d)}</button>`;
  }).join('');
  bar.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click',()=>{ TL_DAY_OFFSET=parseInt(btn.dataset.offset); buildTLDayScroll(); renderTLEmpCards(); });
  });
}

// ── MONTH PICKER ──────────────────────────────────
function buildTLMonthPicker() {
  const picker = $('tlMonthPicker'); if (!picker) return;
  const months=[];
  const now=new Date();
  for(let i=0;i<12;i++){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    months.push({val:d.toISOString().slice(0,7),label:d.toLocaleDateString('en-IN',{month:'short',year:'numeric'})});
  }
  picker.innerHTML=months.map(m=>`<button data-month="${m.val}" style="flex-shrink:0;padding:5px 14px;border-radius:20px;
    border:1px solid ${m.val===TL_MONTH?'var(--a1)':'var(--border)'};
    background:${m.val===TL_MONTH?'var(--a1)':'var(--surface2)'};
    color:${m.val===TL_MONTH?'#fff':'var(--txt1)'};
    font-size:11px;cursor:pointer;white-space:nowrap;">${m.label}</button>`).join('');
  picker.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click',()=>{ TL_MONTH=btn.dataset.month; buildTLMonthPicker(); renderTLEmpCards(); });
  });
}

// ── FILTER + RANGE HELPERS ────────────────────────
function getTLFiltered() {
  const tod=todayStr(), ws=weekStart();
  if (TL_RANGE==='day15') { const s=getTL15Days()[TL_DAY_OFFSET]; return TL_DATA.filter(e=>e.date===s); }
  if (TL_RANGE==='week')  return TL_DATA.filter(e=>e.date>=ws&&e.date<=tod);
  if (TL_RANGE==='month') return TL_DATA.filter(e=>e.date.startsWith(TL_MONTH));
  return TL_DATA;
}

function getTLRangeLabel() {
  if (TL_RANGE==='day15') return tlFmtDate(getTL15Days()[TL_DAY_OFFSET]);
  if (TL_RANGE==='week')  return 'This Week';
  if (TL_RANGE==='month') {
    const [y,m]=TL_MONTH.split('-');
    return new Date(parseInt(y),parseInt(m)-1,1).toLocaleDateString('en-IN',{month:'short',year:'numeric'});
  }
  return 'All Time';
}

function getTLWorkingDays() {
  const tod=todayStr(); let start,end;
  if (TL_RANGE==='day15') return [getTL15Days()[TL_DAY_OFFSET]];
  if (TL_RANGE==='week')  { start=weekStart(); end=tod; }
  else if (TL_RANGE==='month') {
    const [y,m]=TL_MONTH.split('-').map(Number);
    start=TL_MONTH+'-01';
    end=TL_MONTH+'-'+String(new Date(y,m,0).getDate()).padStart(2,'0');
    if (end>tod) end=tod;
  } else { const d=new Date(); d.setDate(d.getDate()-90); start=d.toISOString().slice(0,10); end=tod; }
  const dates=[]; const cur=new Date(start+'T00:00:00'); const endDate=new Date(end+'T00:00:00');
  while(cur<=endDate){ const day=cur.getDay(); if(day!==0&&day!==6) dates.push(cur.toISOString().slice(0,10)); cur.setDate(cur.getDate()+1); }
  return dates;
}

function getTL15Days() {
  const dates=[];
  for(let i=0;i<15;i++){ const d=new Date(); d.setDate(d.getDate()-i); dates.push(d.toISOString().slice(0,10)); }
  return dates;
}

// ── SVG DONUT ─────────────────────────────────────
function buildTLDonut(projects, total) {
  const size=160, cx=80, cy=80, r=66, innerR=44;
  if (!total||!projects.length) return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface2,#2a2a3e)" stroke-width="18"/></svg>`;
  let a=-90;
  const slices=projects.map(([proj,hrs],i)=>{
    const end=a+(hrs/total)*360;
    const path=tlDonutPath(cx,cy,r,innerR,a,end);
    a=end;
    return `<path d="${path}" fill="${TL_PALETTE[i%TL_PALETTE.length]}" stroke="var(--surface1)" stroke-width="2"><title>${esc(proj)}: ${fh(hrs)}</title></path>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">${slices}</svg>`;
}

function tlDonutPath(cx,cy,ro,ri,s,e) {
  if((e-s)>=359.999) e=s+359.999;
  const sO=tlPt(cx,cy,ro,s),eO=tlPt(cx,cy,ro,e),sI=tlPt(cx,cy,ri,e),eI=tlPt(cx,cy,ri,s);
  const lg=(e-s)>180?1:0;
  return [`M ${sO.x} ${sO.y}`,`A ${ro} ${ro} 0 ${lg} 1 ${eO.x} ${eO.y}`,`L ${sI.x} ${sI.y}`,`A ${ri} ${ri} 0 ${lg} 0 ${eI.x} ${eI.y}`,'Z'].join(' ');
}
function tlPt(cx,cy,r,deg){ const rad=deg*Math.PI/180; return {x:+(cx+r*Math.cos(rad)).toFixed(3),y:+(cy+r*Math.sin(rad)).toFixed(3)}; }

// ── HELPERS ───────────────────────────────────────
function tlCalcHours(arr) { return arr.filter(e=>e.status!=='Leave').reduce((s,e)=>s+tlParseH(e.hours),0); }

function tlParseH(val) {
  if(!val) return 0;
  const s=String(val).trim();
  const h=(s.match(/(\d+)h/)||[])[1], m=(s.match(/(\d+)m/)||[])[1];
  if(!h&&!m) return parseFloat(s)||0;
  return (parseInt(h||0)*60+parseInt(m||0))/60;
}

function tlFmtDate(dateStr) {
  return new Date(dateStr+'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
}

function tlToMins(t) { if(!t) return 0; const [h,m]=t.split(':').map(Number); return h*60+m; }

function tlFmt12(t) {
  if(!t) return '--:--';
  const [h,m]=t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`;
}

function tlToast(msg, isError=false) {
  const t=document.createElement('div');
  t.textContent=msg;
  t.style.cssText=`position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:${isError?'#ef4444':'#1e293b'};color:#fff;padding:10px 20px;
    border-radius:8px;font-size:13px;z-index:99999;
    box-shadow:0 4px 20px rgba(0,0,0,.4);white-space:nowrap;`;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),3000);
}