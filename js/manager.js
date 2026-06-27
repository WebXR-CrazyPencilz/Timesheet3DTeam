// ═══════════════════════════════════════════════════
// MANAGER.JS — Manager Portal
// Analytics: Employee hours, Client business, Project breakdown
// ═══════════════════════════════════════════════════

let MGR_DATA        = [];   // all entries from all employees
let MGR_RANGE       = 'month';
let MGR_VIEW        = 'employees'; // 'employees' | 'clients' | 'projects'
let MGR_EMPLOYEES   = [];
let MGR_CLIENTS     = [];
let MGR_PROJECTS    = [];

const MGR_PALETTE = [
  '#4f8ef7','#7c5cfc','#34d399','#fbbf24',
  '#f87171','#22d3ee','#fb923c','#a78bfa',
  '#f472b6','#84cc16','#38bdf8','#4ade80',
];

// ── INIT ──────────────────────────────────────────
async function initManager() {
  const container = $('mgrApp');
  if (!container) return;

  // Set avatar
  const av = $('mgrAv');
  if (av) av.textContent = 'M';

  // Render skeleton
  container.innerHTML = `<div class="mgr-loading">
    <div class="slot-spinner"></div>
    <span>Loading all employee data…</span>
  </div>`;

  try {
    // Load master data for employee/client/project lists
    const master = await apiGetMasterData();
    MGR_EMPLOYEES = master.employees || [];
    MGR_CLIENTS   = master.clients   || [];
    MGR_PROJECTS  = master.projects  || [];

    // Load all employee histories in parallel
    const results = await Promise.all(
      MGR_EMPLOYEES.map(emp =>
        apiGetAllHistory(emp.id).then(entries =>
          entries.map(e => ({ ...e, empId: emp.id, empName: emp.name, empTeam: emp.team }))
        ).catch(() => [])
      )
    );
    MGR_DATA = results.flat();

    renderManagerPortal();
  } catch(err) {
    container.innerHTML = `<div class="slot-error">Failed to load: ${err.message}</div>`;
  }
}

// ── RENDER PORTAL ─────────────────────────────────
function renderManagerPortal() {
  const container = $('mgrApp');
  if (!container) return;

  const filtered = getMgrFiltered();
  const totHours = sumHours(filtered.filter(e => e.status !== 'Leave'));

  container.innerHTML = `
    <!-- Summary Strip -->
    <div class="strip" style="margin-bottom:1.25rem">
      <div class="sitem">
        <span class="slbl">Total Hours</span>
        <span class="sval hi" id="mTot">${fh(totHours)}</span>
      </div>
      <div class="sitem">
        <span class="slbl">Employees</span>
        <span class="sval" id="mEmpCnt">${new Set(filtered.map(e=>e.empId)).size}</span>
      </div>
      <div class="sitem">
        <span class="slbl">Active Projects</span>
        <span class="sval" id="mProjCnt">${new Set(filtered.filter(e=>e.status!=='Leave'&&e.project).map(e=>e.project)).size}</span>
      </div>
      <div class="sitem">
        <span class="slbl">Clients</span>
        <span class="sval" id="mCliCnt">${new Set(filtered.filter(e=>e.status!=='Leave'&&e.client&&e.client!=='Leave').map(e=>e.client)).size}</span>
      </div>
    </div>

    <!-- Range + View Tabs -->
    <div class="mgr-controls">
      <div class="chart-range" id="mgrRange">
        <button class="rbtn${MGR_RANGE==='today'?' active':''}" data-range="today">Today</button>
        <button class="rbtn${MGR_RANGE==='week'?' active':''}"  data-range="week">This Week</button>
        <button class="rbtn${MGR_RANGE==='month'?' active':''}" data-range="month">This Month</button>
        <button class="rbtn${MGR_RANGE==='all'?' active':''}"   data-range="all">All Time</button>
      </div>
      <div class="mgr-view-tabs" id="mgrViewTabs">
        <button class="mvtab${MGR_VIEW==='employees'?' on':''}" data-view="employees">👥 Employees</button>
        <button class="mvtab${MGR_VIEW==='clients'?' on':''}"   data-view="clients">🏢 Clients</button>
        <button class="mvtab${MGR_VIEW==='projects'?' on':''}"  data-view="projects">📁 Projects</button>
      </div>
    </div>

    <!-- Charts + Table area -->
    <div id="mgrContent"></div>
  `;

  // Bind range buttons
  $('mgrRange').addEventListener('click', e => {
    const btn = e.target.closest('.rbtn');
    if (!btn) return;
    MGR_RANGE = btn.dataset.range;
    $('mgrRange').querySelectorAll('.rbtn').forEach(b => b.classList.toggle('active', b===btn));
    renderMgrContent();
  });

  // Bind view tabs
  $('mgrViewTabs').addEventListener('click', e => {
    const btn = e.target.closest('.mvtab');
    if (!btn) return;
    MGR_VIEW = btn.dataset.view;
    $('mgrViewTabs').querySelectorAll('.mvtab').forEach(b => b.classList.toggle('on', b===btn));
    renderMgrContent();
  });

  renderMgrContent();
}

// ── RENDER CONTENT BY VIEW ────────────────────────
function renderMgrContent() {
  const content  = $('mgrContent');
  if (!content) return;

  const filtered = getMgrFiltered();
  const worked   = filtered.filter(e => e.status !== 'Leave');

  // Update summary strip
  const totHours = sumHours(worked);
  const mTot     = $('mTot');
  if (mTot) mTot.textContent = fh(totHours);
  const mEmpCnt  = $('mEmpCnt');
  if (mEmpCnt) mEmpCnt.textContent = new Set(filtered.map(e=>e.empId)).size;
  const mProjCnt = $('mProjCnt');
  if (mProjCnt) mProjCnt.textContent = new Set(worked.filter(e=>e.project).map(e=>e.project)).size;
  const mCliCnt  = $('mCliCnt');
  if (mCliCnt) mCliCnt.textContent = new Set(worked.filter(e=>e.client&&e.client!=='Leave').map(e=>e.client)).size;

  if (MGR_VIEW === 'employees') content.innerHTML = renderEmployeeView(worked, filtered);
  if (MGR_VIEW === 'clients')   content.innerHTML = renderClientView(worked);
  if (MGR_VIEW === 'projects')  content.innerHTML = renderProjectView(worked);
}

// ── EMPLOYEE VIEW ─────────────────────────────────
function renderEmployeeView(worked, all) {
  // Aggregate by employee
  const empMap = {};
  MGR_EMPLOYEES.forEach(emp => {
    empMap[emp.id] = { id: emp.id, name: emp.name, team: emp.team, hours: 0, days: new Set(), leaves: 0, entries: 0 };
  });
  worked.forEach(e => {
    if (!empMap[e.empId]) return;
    empMap[e.empId].hours += parseHoursStr(e.hours);
    empMap[e.empId].days.add(e.date);
    empMap[e.empId].entries++;
  });
  all.filter(e=>e.status==='Leave').forEach(e => {
    if (empMap[e.empId]) empMap[e.empId].leaves++;
  });

  const rows = Object.values(empMap).sort((a,b) => b.hours - a.hours);
  const total = rows.reduce((s,r) => s+r.hours, 0);

  if (total === 0) return `<div class="chart-empty" style="margin-top:1rem">No hours logged for this period.</div>`;

  const chartSvg = buildDonutSVG(
    rows.filter(r=>r.hours>0).map((r,i) => ({ name: r.name, hours: r.hours, color: MGR_PALETTE[i%MGR_PALETTE.length] })),
    total
  );

  const tableRows = rows.map((r,i) => {
    const pct   = total > 0 ? Math.round((r.hours/total)*100) : 0;
    const color = MGR_PALETTE[i%MGR_PALETTE.length];
    const avg   = r.days.size > 0 ? r.hours / r.days.size : 0;
    return `<tr>
      <td><span class="mgr-dot" style="background:${color}"></span>${esc(r.name)}</td>
      <td><span class="mgr-badge" style="background:rgba(79,142,247,.1);color:var(--a1)">${esc(r.team)}</span></td>
      <td class="hcell">${fh(r.hours)}</td>
      <td>
        <div class="mgr-bar-wrap">
          <div class="mgr-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="mgr-pct">${pct}%</span>
      </td>
      <td class="hcell">${r.days.size} days</td>
      <td class="hcell">${fh(avg)}/day</td>
      <td class="hcell">${r.leaves > 0 ? `<span style="color:var(--warn)">${r.leaves} leave</span>` : '—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card chart-card" style="margin-bottom:1.25rem">
      <div class="chart-hdr"><span class="ttitle">Employee Hours Distribution</span></div>
      <div class="chart-body">
        <div class="chart-svg-wrap">
          ${chartSvg}
          <div class="chart-center">
            <div class="chart-center-val">${fh(total)}</div>
            <div class="chart-center-lbl">${mgrRangeLabel()}</div>
          </div>
        </div>
        <div class="chart-legend">
          ${rows.filter(r=>r.hours>0).map((r,i) => `
            <div class="leg-row">
              <span class="leg-dot" style="background:${MGR_PALETTE[i%MGR_PALETTE.length]}"></span>
              <span class="leg-name">${esc(r.name)}</span>
              <span class="leg-hrs">${fh(r.hours)}</span>
              <span class="leg-pct">${total>0?Math.round((r.hours/total)*100):0}%</span>
            </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:1.25rem">
      <div class="thdr" style="padding:.9rem 1.1rem">
        <span class="ttitle">Employee Breakdown</span>
      </div>
      <div class="twrap">
        <table class="mgr-table">
          <thead><tr>
            <th>Employee</th><th>Team</th><th>Hours</th>
            <th style="min-width:140px">Share</th>
            <th>Days</th><th>Avg/Day</th><th>Leave</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── CLIENT VIEW ───────────────────────────────────
function renderClientView(worked) {
  const cliMap = {};
  worked.forEach(e => {
    if (!e.client || e.client === 'Leave') return;
    if (!cliMap[e.client]) cliMap[e.client] = { name: e.client, hours: 0, projects: new Set(), employees: new Set(), entries: 0 };
    cliMap[e.client].hours += parseHoursStr(e.hours);
    if (e.project) cliMap[e.client].projects.add(e.project);
    cliMap[e.client].employees.add(e.empId);
    cliMap[e.client].entries++;
  });

  const rows  = Object.values(cliMap).sort((a,b) => b.hours-a.hours);
  const total = rows.reduce((s,r) => s+r.hours, 0);

  if (total === 0) return `<div class="chart-empty" style="margin-top:1rem">No client hours for this period.</div>`;

  const chartSvg = buildDonutSVG(
    rows.map((r,i) => ({ name: r.name, hours: r.hours, color: MGR_PALETTE[i%MGR_PALETTE.length] })),
    total
  );

  const tableRows = rows.map((r,i) => {
    const pct   = total > 0 ? Math.round((r.hours/total)*100) : 0;
    const color = MGR_PALETTE[i%MGR_PALETTE.length];
    return `<tr>
      <td><span class="mgr-dot" style="background:${color}"></span>${esc(r.name)}</td>
      <td class="hcell">${fh(r.hours)}</td>
      <td>
        <div class="mgr-bar-wrap">
          <div class="mgr-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="mgr-pct">${pct}%</span>
      </td>
      <td class="hcell">${r.projects.size}</td>
      <td class="hcell">${r.employees.size}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card chart-card" style="margin-bottom:1.25rem">
      <div class="chart-hdr"><span class="ttitle">Client Business Distribution</span></div>
      <div class="chart-body">
        <div class="chart-svg-wrap">
          ${chartSvg}
          <div class="chart-center">
            <div class="chart-center-val">${fh(total)}</div>
            <div class="chart-center-lbl">${mgrRangeLabel()}</div>
          </div>
        </div>
        <div class="chart-legend">
          ${rows.map((r,i) => `
            <div class="leg-row">
              <span class="leg-dot" style="background:${MGR_PALETTE[i%MGR_PALETTE.length]}"></span>
              <span class="leg-name">${esc(r.name)}</span>
              <span class="leg-hrs">${fh(r.hours)}</span>
              <span class="leg-pct">${total>0?Math.round((r.hours/total)*100):0}%</span>
            </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:1.25rem">
      <div class="thdr" style="padding:.9rem 1.1rem">
        <span class="ttitle">Client Breakdown</span>
      </div>
      <div class="twrap">
        <table class="mgr-table">
          <thead><tr>
            <th>Client</th><th>Hours</th>
            <th style="min-width:140px">Share</th>
            <th>Projects</th><th>Employees</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── PROJECT VIEW ──────────────────────────────────
function renderProjectView(worked) {
  const projMap = {};
  worked.forEach(e => {
    if (!e.project || e.project === 'Leave') return;
    if (!projMap[e.project]) projMap[e.project] = { name: e.project, client: e.client || '—', hours: 0, employees: new Set(), tasks: new Set(), entries: 0 };
    projMap[e.project].hours += parseHoursStr(e.hours);
    projMap[e.project].employees.add(e.empId);
    if (e.task) projMap[e.project].tasks.add(e.task);
    projMap[e.project].entries++;
  });

  const rows  = Object.values(projMap).sort((a,b) => b.hours-a.hours);
  const total = rows.reduce((s,r) => s+r.hours, 0);

  if (total === 0) return `<div class="chart-empty" style="margin-top:1rem">No project hours for this period.</div>`;

  const chartSvg = buildDonutSVG(
    rows.slice(0,10).map((r,i) => ({ name: r.name, hours: r.hours, color: MGR_PALETTE[i%MGR_PALETTE.length] })),
    total
  );

  const tableRows = rows.map((r,i) => {
    const pct   = total > 0 ? Math.round((r.hours/total)*100) : 0;
    const color = MGR_PALETTE[i%MGR_PALETTE.length];
    return `<tr>
      <td><span class="mgr-dot" style="background:${color}"></span>${esc(r.name)}</td>
      <td>${esc(r.client)}</td>
      <td class="hcell">${fh(r.hours)}</td>
      <td>
        <div class="mgr-bar-wrap">
          <div class="mgr-bar" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="mgr-pct">${pct}%</span>
      </td>
      <td class="hcell">${r.employees.size}</td>
      <td style="font-size:.7rem;color:var(--txt2)">${[...r.tasks].join(', ') || '—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card chart-card" style="margin-bottom:1.25rem">
      <div class="chart-hdr"><span class="ttitle">Project Hours Distribution</span></div>
      <div class="chart-body">
        <div class="chart-svg-wrap">
          ${chartSvg}
          <div class="chart-center">
            <div class="chart-center-val">${fh(total)}</div>
            <div class="chart-center-lbl">${mgrRangeLabel()}</div>
          </div>
        </div>
        <div class="chart-legend">
          ${rows.slice(0,10).map((r,i) => `
            <div class="leg-row">
              <span class="leg-dot" style="background:${MGR_PALETTE[i%MGR_PALETTE.length]}"></span>
              <span class="leg-name" title="${esc(r.name)}">${esc(r.name)}</span>
              <span class="leg-hrs">${fh(r.hours)}</span>
              <span class="leg-pct">${total>0?Math.round((r.hours/total)*100):0}%</span>
            </div>`).join('')}
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:1.25rem">
      <div class="thdr" style="padding:.9rem 1.1rem">
        <span class="ttitle">Project Breakdown</span>
      </div>
      <div class="twrap">
        <table class="mgr-table">
          <thead><tr>
            <th>Project</th><th>Client</th><th>Hours</th>
            <th style="min-width:140px">Share</th>
            <th>Employees</th><th>Tasks</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── FILTER BY RANGE ───────────────────────────────
function getMgrFiltered() {
  const tod = todayStr();
  const ws  = weekStart();
  const mo  = todayStr().slice(0,7);

  return MGR_DATA.filter(e => {
    if (MGR_RANGE === 'today') return e.date === tod;
    if (MGR_RANGE === 'week')  return e.date >= ws;
    if (MGR_RANGE === 'month') return e.date.startsWith(mo);
    return true; // all
  });
}

function mgrRangeLabel() {
  if (MGR_RANGE === 'today') return 'Today';
  if (MGR_RANGE === 'week')  return 'This Week';
  if (MGR_RANGE === 'month') return 'This Month';
  return 'All Time';
}

// ── DONUT SVG ─────────────────────────────────────
function buildDonutSVG(data, total) {
  const cx = 85, cy = 85, r = 70, innerR = 44;
  let angleStart = -90;

  const slices = data.map(d => {
    const pct      = d.hours / total;
    const angleEnd = angleStart + pct * 360;
    const path     = donutSlicePath(cx, cy, r, innerR, angleStart, angleEnd);
    angleStart     = angleEnd;
    return `<path class="chart-slice" d="${path}" fill="${d.color}">
      <title>${escSvg(d.name)}: ${fh(d.hours)}</title>
    </path>`;
  }).join('');

  return `<svg viewBox="0 0 170 170" xmlns="http://www.w3.org/2000/svg">${slices}</svg>`;
}

function donutSlicePath(cx, cy, rOuter, rInner, startDeg, endDeg) {
  const span = endDeg - startDeg;
  if (span >= 359.999) endDeg = startDeg + 359.999;
  const sOuter   = polarPoint(cx, cy, rOuter, startDeg);
  const eOuter   = polarPoint(cx, cy, rOuter, endDeg);
  const sInner   = polarPoint(cx, cy, rInner, endDeg);
  const eInner   = polarPoint(cx, cy, rInner, startDeg);
  const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
  return [
    `M ${sOuter.x} ${sOuter.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${eOuter.x} ${eOuter.y}`,
    `L ${sInner.x} ${sInner.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${eInner.x} ${eInner.y}`,
    'Z'
  ].join(' ');
}

function polarPoint(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: +(cx + r * Math.cos(rad)).toFixed(3), y: +(cy + r * Math.sin(rad)).toFixed(3) };
}

// ── HELPERS ───────────────────────────────────────
function sumHours(arr) {
  return arr.reduce((s,e) => s + parseHoursStr(e.hours), 0);
}

// Parses "3h 30m", "45m", "3h", or decimal 3.5
function parseHoursStr(val) {
  if (!val) return 0;
  const s = String(val).trim();
  const hMatch = s.match(/(\d+)h/);
  const mMatch = s.match(/(\d+)m/);
  const h = hMatch ? parseInt(hMatch[1], 10) : 0;
  const m = mMatch ? parseInt(mMatch[1], 10) : 0;
  if (h === 0 && m === 0) return parseFloat(s) || 0;
  return Math.round(((h * 60 + m) / 60) * 100) / 100;
}

function escSvg(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}