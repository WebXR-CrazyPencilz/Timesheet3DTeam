// ═══════════════════════════════════════════════════════════════
// DASHBOARD.JS — Manager Dashboard, Manager-only, read-only.
//
// This is a PURE ADDITION. It does not modify manager.js's existing
// modules, Client-Project.js, salary.js, or gantt.js — it only reads
// what they already expose: CP_TIMESHEET_DATA / CP_EMPLOYEES
// (populated once by manager.js's initManager() before any tab
// renders) and CP_PROJECTS / CP_HISTORICAL_DATA (populated by
// Client-Project.js's own loadProjectData()/loadHistoricalData() —
// called here exactly the way the Project tab already calls them,
// not reimplemented). No new Sheet, no new backend action, no
// parallel data array — every number below comes from those five
// existing sources.
//
// Business logic ownership is unchanged: Project/Client/Timesheet
// calculations still live in Client-Project.js. This file adds one
// NEW aggregation — company-wide hours bucketed by year/quarter/month
// — because nothing existing produces that shape (Client-Project.js's
// own helpers are per-project or per-client, never company-wide
// across every project at once). It reuses parseH, isWorkedEntry, and
// Client-Project.js's HIST_MONTH_NUM directly rather than redefining
// any of them.
// ═══════════════════════════════════════════════════════════════

// ── STATE ─────────────────────────────────────────────────────
let DASH_CONTAINER    = null;
let DASH_CACHE        = null;  // built once by buildTeamPerformanceCache(), reused across every drill-down click
let DASH_FINGERPRINT  = '';    // signature of the data DASH_CACHE was built from — only rebuilds when this changes

let DASH_LEVEL   = 'all';  // 'all' | 'year' | 'quarter'
let DASH_YEAR    = null;
let DASH_QUARTER = null;   // 'Q1'..'Q4'

const DASH_QUARTER_MONTHS = {
  Q1: [1, 2, 3], Q2: [4, 5, 6], Q3: [7, 8, 9], Q4: [10, 11, 12],
};
const DASH_MONTH_NAME = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function ensureDashStyles() {
  if (document.getElementById('dash-global-styles')) return;
  const style = document.createElement('style');
  style.id = 'dash-global-styles';
  style.textContent = `
    .dash-candle { cursor:pointer; transition:filter .15s ease, transform .15s ease; border-radius:4px 4px 2px 2px; }
    .dash-candle:hover { filter:brightness(1.2); transform:scaleY(1.02); }
    .dash-candle-disabled { cursor:default; }
    .dash-fade-in { animation:dashFadeIn .25s ease; }
    @keyframes dashFadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
    .dash-crumb { cursor:pointer; color:var(--a1); }
    .dash-crumb:hover { text-decoration:underline; }
    .dash-kpi-card:hover { transform:translateY(-3px); box-shadow:0 14px 34px rgba(0,0,0,.10); }
  `;
  document.head.appendChild(style);
}

// ── ENTRY POINT (called by manager.js when MGR_TAB === 'dashboard') ──
async function renderManagerDashboard(content) {
  DASH_CONTAINER = content;
  ensureDashStyles();

  if (typeof MANAGER_MODE !== 'undefined' && !MANAGER_MODE) {
    content.innerHTML = `<div class="chart-empty">The Dashboard is only available to the Manager.</div>`;
    return;
  }

  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading dashboard…</span></div>`;

  try {
    // Same loaders the Project tab already calls on open — Dashboard
    // is now the landing tab, so it needs CP_PROJECTS/CP_HISTORICAL_DATA
    // ready too. CP_TIMESHEET_DATA/CP_EMPLOYEES are already populated
    // by initManager() before renderManagerPortal() ever runs, so
    // nothing extra is needed for those.
    if (typeof loadProjectData === 'function')    await loadProjectData();
    if (typeof loadClientData === 'function')      await loadClientData();
    if (typeof loadHistoricalData === 'function')  await loadHistoricalData();
    if (typeof ensureSalaryDataLoaded === 'function') await ensureSalaryDataLoaded();

    // Total Views (shown on each candle) reuses gantt.js's own
    // per-project monthly aggregation and Views Delivered formula
    // (GANTT_PROJECTS / getMonthlyViewsDelivered) rather than
    // recomputing it here — same reasoning as above, this is a pure
    // reuse of an existing calculation, not a second one.
    if (typeof loadProjects === 'function' && (typeof GANTT_PROJECTS === 'undefined' || !GANTT_PROJECTS.length)) {
      await loadProjects();
    }
  } catch (err) {
    content.innerHTML = `<div class="slot-error">Failed to load: ${esc(err.message)}</div>`;
    return;
  }

  buildTeamPerformanceCache();
  // Default landing view is the current year (Level 2 — months), not
  // All Time — quicker for the common case of "how are we doing
  // lately", while "All Time" stays one breadcrumb click away if the
  // Manager wants to see every year. Falls back to All Time only if
  // the current year genuinely has no data in the cache at all.
  const currentYear = String(new Date().getFullYear());
  if (DASH_CACHE.years[currentYear]) {
    DASH_LEVEL = 'year'; DASH_YEAR = currentYear; DASH_QUARTER = null;
  } else {
    DASH_LEVEL = 'all'; DASH_YEAR = null; DASH_QUARTER = null;
  }

  // Top section (KPI cards / Not Logged In / Candle Teams Performance)
  // lives in its own container above the existing Team Performance
  // widget — renderDashboardShell below is completely untouched, it
  // just now renders into a sub-container instead of `content`
  // directly.
  content.innerHTML = `
    <div id="dashKpiWrap" style="margin-bottom:22px;"></div>
    <div style="display:flex;gap:10px;align-items:stretch;">
      <div style="flex:0 0 330px;" id="dashNotLoggedWrap"></div>
      <div style="flex:0 0 600px;" id="dashTeamPerfWrap"></div>
      <div style="flex:1;min-width:280px;" id="dashClientRollupWrap"></div>
    </div>`;
  renderDashboardKpiRow($('dashKpiWrap'));
  renderDashboardNotLoggedPanel($('dashNotLoggedWrap'));
  renderDashboardShell($('dashTeamPerfWrap'));
  renderDashboardClientRollup($('dashClientRollupWrap'));
}

function buildTeamPerformanceCache(force = false) {
  const fingerprint = [
    (typeof CP_TIMESHEET_DATA !== 'undefined' ? CP_TIMESHEET_DATA.length : 0),
    (typeof CP_HISTORICAL_DATA !== 'undefined' ? CP_HISTORICAL_DATA.length : 0),
    (typeof CP_PROJECTS !== 'undefined' ? CP_PROJECTS.length : 0),
    (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES.length : 0),
  ].join(':');

  if (!force && fingerprint === DASH_FINGERPRINT && DASH_CACHE) return; // nothing changed — reuse the existing cache

  // Live entries use project NAME; Historical Import records use
  // Project ID. Normalized to Project ID here (once) so a project
  // worked on both before and after the live timesheet system started
  // is counted as ONE project, not two.
  const projectIdByName = {};
  (typeof CP_PROJECTS !== 'undefined' ? CP_PROJECTS : []).forEach(p => { projectIdByName[p.projectName] = p.projectId; });

  const years = {};
  function bucket(dateYear, monthNum, hours, empId, projectKey) {
    if (!dateYear || !monthNum) return;
    const quarterKey = 'Q' + Math.ceil(monthNum / 3);
    const monthKey = `${dateYear}-${String(monthNum).padStart(2, '0')}`;

    if (!years[dateYear]) years[dateYear] = { hours: 0, employees: new Set(), projects: new Set(), quarters: {} };
    const y = years[dateYear];
    y.hours += hours; if (empId) y.employees.add(empId); if (projectKey) y.projects.add(projectKey);

    if (!y.quarters[quarterKey]) y.quarters[quarterKey] = { hours: 0, employees: new Set(), projects: new Set(), months: {} };
    const q = y.quarters[quarterKey];
    q.hours += hours; if (empId) q.employees.add(empId); if (projectKey) q.projects.add(projectKey);

    if (!q.months[monthKey]) q.months[monthKey] = { hours: 0, employees: new Set(), projects: new Set(), monthNum };
    const m = q.months[monthKey];
    m.hours += hours; if (empId) m.employees.add(empId); if (projectKey) m.projects.add(projectKey);
  }

  (typeof CP_TIMESHEET_DATA !== 'undefined' ? CP_TIMESHEET_DATA : [])
    .filter(e => typeof isWorkedEntry !== 'function' || isWorkedEntry(e))
    .forEach(e => {
      if (!e.date) return;
      const [y, m] = e.date.split('-').map(Number);
      const hours = typeof parseH === 'function' ? parseH(e.hours) : (Number(e.hours) || 0);
      const projectKey = projectIdByName[e.project] || e.project;
      bucket(y, m, hours, e.empId, projectKey);
    });

  (typeof CP_HISTORICAL_DATA !== 'undefined' ? CP_HISTORICAL_DATA : []).forEach(r => {
    const monthNum = (typeof HIST_MONTH_NUM !== 'undefined' ? HIST_MONTH_NUM[r.month] : null);
    if (!monthNum || !r.year) return;
    bucket(parseInt(r.year, 10), monthNum, parseFloat(r.totalHours) || 0, r.employeeId, r.projectId);
  });

  DASH_CACHE = { years };
  DASH_FINGERPRINT = fingerprint;
}

// ── TOTAL VIEWS (reuses gantt.js's per-project Views Delivered) ──
// Sums getMonthlyViewsDelivered(p, monthKey).views across every
// project in GANTT_PROJECTS, for every month key given. A year-level
// candle passes all 12 of that year's month keys; a month-level
// candle passes just its own. The underlying formula (Completed
// Views × effort-weighted month hours) is entirely gantt.js's —
// this only adds the numbers up.
function dashTotalViews(monthKeys) {
  if (typeof GANTT_PROJECTS === 'undefined' || typeof getMonthlyViewsDelivered !== 'function') return null;
  let total = 0;
  GANTT_PROJECTS.forEach(p => {
    monthKeys.forEach(mk => { total += getMonthlyViewsDelivered(p, mk).views; });
  });
  return total;
}

// ── STAT HELPERS (read-only lookups against the cache) ──────────
function dashStatsFor(bucket) {
  if (!bucket) return { hours: 0, employees: 0, projects: 0, avgPerEmployee: 0 };
  const employees = bucket.employees.size;
  return {
    hours: bucket.hours,
    employees,
    projects: bucket.projects.size,
    avgPerEmployee: employees > 0 ? bucket.hours / employees : 0,
  };
}

// ── SHELL ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
// TOP SECTION — KPI cards / Not Logged In / Candle Teams Performance.
// Added above the existing Team Performance widget (renderDashboardShell,
// below) — that widget is completely untouched.
// ══════════════════════════════════════════════════════════════

const DASH_KPI_CARDS = [
  // PLACEHOLDER DATA — projects don't have a category field (3D /
  // Unreal Engine / Web) in CP_PROJECTS today. These three numbers
  // are NOT computed from real data yet. Wire this to a real project
  // category field once one exists, then replace this block with an
  // actual CP_PROJECTS aggregation — do not treat these as real.
  { label: 'Active Projects in 3D',           count: 24, deltaPct: 12, color: '#4f8ef7', bg: 'rgba(79,142,247,.12)', icon: '📦' },
  { label: 'Active Projects in Unreal Engine', count: 16, deltaPct: 8,  color: '#7c5cfc', bg: 'rgba(124,92,252,.12)', icon: '🎮' },
  { label: 'Active Projects in the Web',       count: 32, deltaPct: 15, color: '#34d399', bg: 'rgba(52,211,153,.12)', icon: '🌐' },
];

function renderDashboardKpiRow(wrap) {
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:22px;">
      ${DASH_KPI_CARDS.map(dashBuildKpiCard).join('')}
    </div>`;
}

function renderDashboardNotLoggedPanel(wrap) {
  if (!wrap) return;
  wrap.innerHTML = dashBuildNotLoggedInCard();
  wireDashNotLoggedIn(wrap);
}

// ── KPI CARD (placeholder data — see DASH_KPI_CARDS comment above) ──
function dashBuildKpiCard(card) {
  const up = card.deltaPct >= 0;
  // Small inline sparkline — deterministic fake wiggle seeded off the
  // label, not random, so it doesn't jump around on re-render. Purely
  // decorative until there's a real daily series to plot.
  const points = Array.from({ length: 12 }, (_, i) => {
    const seed = (card.label.length * 7 + i * 13) % 10;
    return 18 - seed * 1.4 + (i > 6 ? (i - 6) * 2.2 : 0);
  });
  const pathD = points.map((y, i) => `${i === 0 ? 'M' : 'L'} ${i * 8} ${20 - y}`).join(' ');

  return `
    <div class="dash-kpi-card" style="background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.06);
      padding:24px;transition:transform .18s ease, box-shadow .18s ease;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;">
        <div style="width:44px;height:44px;border-radius:12px;background:${card.bg};display:flex;align-items:center;
          justify-content:center;font-size:20px;">${card.icon}</div>
      </div>
      <div style="margin-top:14px;font-size:13px;font-weight:600;color:var(--txt2);">${esc(card.label)}</div>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-top:2px;">
        <div>
          <div style="font-size:30px;font-weight:800;color:${card.color};line-height:1.1;">${card.count}</div>
          <div style="font-size:12px;font-weight:600;color:${up ? '#34d399' : '#f87171'};margin-top:4px;">
            ${up ? '↑' : '↓'} ${Math.abs(card.deltaPct)}% vs last month
          </div>
        </div>
        <svg width="96" height="32" viewBox="0 0 96 32" style="overflow:visible;">
          <path d="${pathD}" fill="none" stroke="${card.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
        </svg>
      </div>
    </div>`;
}

// ── NOT LOGGED IN (real data: employees with no timesheet entry today) ──
function dashComputeNotLoggedIn() {
  const employees = typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : [];
  const entries   = typeof CP_TIMESHEET_DATA !== 'undefined' ? CP_TIMESHEET_DATA : [];
  const today = todayStr();

  const loggedTodayIds = new Set(entries.filter(e => e.date === today).map(e => e.empId));
  const lastActivityByEmp = {};
  entries.forEach(e => {
    if (!e.date) return;
    if (!lastActivityByEmp[e.empId] || e.date > lastActivityByEmp[e.empId]) lastActivityByEmp[e.empId] = e.date;
  });

  return employees
    .filter(emp => emp.active !== false) // inactive employees (active:false from the backend) don't belong on an "at-risk today" list — their history still counts fully in Team Performance/Old Projects, just not here
    .filter(emp => !loggedTodayIds.has(emp.id))
    .map(emp => ({ emp, lastActivity: lastActivityByEmp[emp.id] || null }))
    .sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || '')); // longest-absent first
}

function dashRelativeDays(dateStr) {
  if (!dateStr) return 'No activity logged';
  const today = new Date(todayStr() + 'T00:00:00');
  const then  = new Date(dateStr + 'T00:00:00');
  const days = Math.round((today - then) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

const DASH_AVATAR_COLORS = ['#fca5a5', '#fdba74', '#fcd34d', '#86efac', '#93c5fd', '#c4b5fd', '#f9a8d4'];
function dashAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return DASH_AVATAR_COLORS[hash % DASH_AVATAR_COLORS.length];
}

function dashBuildNotLoggedInCard() {
  const list = dashComputeNotLoggedIn();
  const shown = list.slice(0, 5);

  const rowsHtml = shown.length ? shown.map(({ emp, lastActivity }) => {
    const initials = emp.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="width:38px;height:38px;border-radius:50%;background:${dashAvatarColor(emp.name)};
          display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#3a2a1a;flex-shrink:0;">${esc(initials)}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--txt1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(emp.name)}</div>
          <div style="font-size:11.5px;color:var(--txt2);">${esc(emp.team || '—')}</div>
        </div>
        <div style="font-size:11.5px;font-weight:600;color:#f87171;white-space:nowrap;">${esc(dashRelativeDays(lastActivity))}</div>
      </div>`;
  }).join('') : `<div style="padding:20px 0;text-align:center;color:var(--txt2);font-size:12.5px;">Everyone has logged in today. 🎉</div>`;

  return `
    <div style="background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.06);padding:24px;
      height:100%;display:flex;flex-direction:column;box-sizing:border-box;">
      <div style="font-size:15px;font-weight:700;color:var(--txt1);margin-bottom:14px;">Not Logged In <span style="font-size:11px;color:var(--txt2);font-weight:500;">— no entry today</span></div>
      <div style="flex:1;overflow-y:auto;">${rowsHtml}</div>
      ${list.length > 5 ? `<button id="dashNotLoggedViewAll" style="margin-top:14px;width:100%;background:none;
        border:1px solid var(--border-md);border-radius:8px;padding:9px;font-size:12.5px;font-weight:700;
        color:var(--a1);cursor:pointer;">View all (${list.length})</button>` : ''}
    </div>`;
}

function wireDashNotLoggedIn(wrap) {
  wrap.querySelector('#dashNotLoggedViewAll')?.addEventListener('click', () => {
    // Reuses each portal's own existing Attendance tab rather than a
    // standalone modal. MGR_TAB/TL_TAB/HR_TAB are all declared as
    // globals by their respective portal files regardless of which
    // portal is actually active (manager.js/teamleader.js/
    // humanresource.js are all loaded together), so checking
    // `typeof MGR_TAB !== 'undefined'` alone isn't enough — it's true
    // even inside HR Portal, which has no #mgrTabContent to render
    // into, so the click silently did nothing there. Checking the
    // *_MODE flag first (set by auth.js at login, only one is ever
    // true) picks the right portal's own tab instead.
    if (typeof MANAGER_MODE !== 'undefined' && MANAGER_MODE && typeof MGR_TAB !== 'undefined' && typeof renderMgrTab === 'function') {
      MGR_TAB = 'attendance';
      document.querySelectorAll('.mgr-tab').forEach(b => {
        const active = b.dataset.tab === 'attendance';
        b.style.color        = active ? 'var(--a1)' : 'var(--txt2)';
        b.style.borderBottom = active ? '2px solid var(--a1)' : '2px solid transparent';
      });
      renderMgrTab();
    } else if (typeof HR_MODE !== 'undefined' && HR_MODE && typeof HR_TAB !== 'undefined' && typeof renderHRTab === 'function') {
      HR_TAB = 'attendance';
      document.querySelectorAll('.hr-tab').forEach(b => {
        const active = b.dataset.tab === 'attendance';
        b.style.color        = active ? 'var(--a1)' : 'var(--txt2)';
        b.style.borderBottom = active ? '2px solid var(--a1)' : '2px solid transparent';
      });
      renderHRTab();
    } else {
      dashOpenNotLoggedInAll(); // fallback if the active portal's tab router isn't available
    }
  });
}

function dashOpenNotLoggedInAll() {
  const list = dashComputeNotLoggedIn();
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;width:420px;max-width:92vw;max-height:80vh;overflow-y:auto;">
      <div style="font-size:15px;font-weight:700;color:var(--txt1);margin-bottom:14px;">Not Logged In Today (${list.length})</div>
      ${list.map(({ emp, lastActivity }) => {
        const initials = emp.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
            <div style="width:38px;height:38px;border-radius:50%;background:${dashAvatarColor(emp.name)};
              display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#3a2a1a;flex-shrink:0;">${esc(initials)}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:700;color:#1a1a2e;">${esc(emp.name)}</div>
              <div style="font-size:11.5px;color:#6b7280;">${esc(emp.team || '—')}</div>
            </div>
            <div style="font-size:11.5px;font-weight:600;color:#f87171;white-space:nowrap;">${esc(dashRelativeDays(lastActivity))}</div>
          </div>`;
      }).join('')}
      <div style="display:flex;justify-content:flex-end;margin-top:14px;">
        <button id="dashNotLoggedClose" style="background:none;border:1px solid var(--border-md);color:var(--txt2);
          border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#dashNotLoggedClose').addEventListener('click', () => overlay.remove());
}

function renderDashboardShell(content) {
  content.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1.4rem;height:100%;box-sizing:border-box;">
      <div style="margin-bottom:1.2rem;">
        <div style="font-size:16px;font-weight:700;color:var(--txt1);">📊 Team Performance</div>
        <div style="font-size:12px;color:var(--txt2);">The complete productivity history of the company — click a bar to drill down.</div>
      </div>
      <div id="dashBreadcrumb" style="font-size:12.5px;color:var(--txt2);margin-bottom:1.1rem;"></div>
      <div id="dashChartArea"></div>
    </div>`;

  renderDashboardChart();
}

function dashBreadcrumbHtml() {
  const parts = [`<span class="${DASH_LEVEL === 'all' ? '' : 'dash-crumb'}" id="dashCrumbAll">All Time</span>`];
  if (DASH_YEAR) parts.push(`<span class="${DASH_LEVEL === 'year' ? '' : 'dash-crumb'}" id="dashCrumbYear">${DASH_YEAR}</span>`);
  if (DASH_QUARTER) parts.push(`<span>${esc(DASH_QUARTER)}</span>`);
  return parts.join(' <span style="color:var(--txt2);">›</span> ');
}

// ── CHART (Excel-style vertical bars — the drill-down navigation itself) ──
function renderDashboardChart() {
  const area = $('dashChartArea');
  const crumb = $('dashBreadcrumb');
  if (!area || !crumb) return;

  crumb.innerHTML = dashBreadcrumbHtml();
  $('dashCrumbAll')?.addEventListener('click', () => { DASH_LEVEL = 'all'; DASH_YEAR = null; DASH_QUARTER = null; renderDashboardChart(); });
  $('dashCrumbYear')?.addEventListener('click', () => { DASH_LEVEL = 'year'; DASH_QUARTER = null; renderDashboardChart(); });

  // Build the list of { key, label, bucket, clickable } bars for the
  // current level — every candidate period always appears (quarters
  // and months with zero hours render as an empty bar, never skipped).
  let bars = [];
  if (DASH_LEVEL === 'all') {
    const yearKeys = Object.keys(DASH_CACHE.years).sort();
    bars = yearKeys.map(y => {
      const yearMonthKeys = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
      return { key: y, label: y, bucket: DASH_CACHE.years[y], clickable: true, viewsTotal: dashTotalViews(yearMonthKeys) };
    });
  } else if (DASH_LEVEL === 'year') {
    const y = DASH_CACHE.years[DASH_YEAR];
    bars = Array.from({ length: 12 }, (_, i) => i + 1).map(mn => {
      const quarterKey = 'Q' + Math.ceil(mn / 3);
      const monthKey = `${DASH_YEAR}-${String(mn).padStart(2, '0')}`;
      const bucket = y?.quarters[quarterKey]?.months[monthKey] || null;
      // Clicking a month at this level drills into its QUARTER (not
      // the month itself) — the quarter view then shows that
      // quarter's own 3 months, same as before.
      return { key: monthKey, label: DASH_MONTH_NAME[mn].slice(0, 3), bucket, clickable: true, drillTo: quarterKey, viewsTotal: dashTotalViews([monthKey]) };
    });
  } else if (DASH_LEVEL === 'quarter') {
    const y = DASH_CACHE.years[DASH_YEAR];
    const q = y?.quarters[DASH_QUARTER];
    bars = (DASH_QUARTER_MONTHS[DASH_QUARTER] || []).map(mn => {
      const monthKey = `${DASH_YEAR}-${String(mn).padStart(2, '0')}`;
      return { key: monthKey, label: DASH_MONTH_NAME[mn].slice(0, 3), bucket: q?.months[monthKey] || null, clickable: false, viewsTotal: dashTotalViews([monthKey]) };
    });
  }

  if (!bars.length) {
    area.innerHTML = `<div class="chart-empty">No timesheet or historical activity yet.</div>`;
    return;
  }

  const maxHours = Math.max(...bars.map(b => b.bucket?.hours || 0), 0.01);
  const CHART_HEIGHT = 220;

  area.innerHTML = `
    <div class="dash-fade-in" style="display:grid;grid-template-columns:repeat(${bars.length}, 1fr);align-items:end;
      height:${CHART_HEIGHT + 34}px;padding-top:10px;">
      ${bars.map(b => {
        const h = b.bucket ? Math.max((b.bucket.hours / maxHours) * CHART_HEIGHT, b.bucket.hours > 0 ? 4 : 0) : 0;
        const isEmpty = !b.bucket || b.bucket.hours <= 0;
        const viewsLabel = b.viewsTotal !== null && b.viewsTotal !== undefined ? b.viewsTotal.toFixed(1) : null;
        return `
          <div style="display:flex;flex-direction:column;align-items:center;">
            <div style="height:${CHART_HEIGHT}px;width:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;">
              ${!isEmpty && viewsLabel !== null ? `<div style="font-size:11px;font-weight:700;color:var(--txt1);margin-bottom:5px;white-space:nowrap;">${esc(viewsLabel)}</div>` : ''}
              <div class="dash-candle ${b.clickable ? '' : 'dash-candle-disabled'}" data-key="${esc(b.key)}"
                style="width:70%;max-width:80px;height:${h}px;background:${isEmpty ? 'var(--border-md)' : 'var(--a1)'};"></div>
            </div>
            <div style="margin-top:8px;font-size:11.5px;font-weight:700;color:var(--txt1);">${esc(b.label)}</div>
          </div>`;
      }).join('')}
    </div>`;

  area.querySelectorAll('.dash-candle').forEach((el, i) => {
    const b = bars[i];
    el.addEventListener('mouseenter', e => showDashTooltip(e, b));
    el.addEventListener('mousemove', e => positionDashTooltip(e));
    el.addEventListener('mouseleave', hideDashTooltip);
    if (b.clickable) {
      el.addEventListener('click', () => {
        hideDashTooltip();
        if (DASH_LEVEL === 'all') { DASH_YEAR = b.key; DASH_LEVEL = 'year'; }
        else if (DASH_LEVEL === 'year') { DASH_QUARTER = b.drillTo; DASH_LEVEL = 'quarter'; }
        renderDashboardChart();
      });
    }
  });
}

// ── TOOLTIP ───────────────────────────────────────────────────
function dashPeriodLabel(bar) {
  if (DASH_LEVEL === 'all') return bar.key;
  return `${bar.label} ${DASH_YEAR}`;
}

function showDashTooltip(evt, bar) {
  hideDashTooltip();
  const stats = dashStatsFor(bar.bucket);
  const viewsLine = bar.viewsTotal !== null && bar.viewsTotal !== undefined
    ? `<div>Total Views: <b>${bar.viewsTotal.toFixed(1)}</b></div>` : '';
  const tip = document.createElement('div');
  tip.id = 'dashTooltip';
  tip.style.cssText = `position:fixed;z-index:10001;background:var(--surface1);border:1px solid var(--border-md);
    border-radius:10px;padding:10px 12px;font-size:11.5px;color:var(--txt1);box-shadow:0 8px 24px rgba(0,0,0,.4);
    max-width:240px;pointer-events:none;`;
  tip.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;">${esc(dashPeriodLabel(bar))}</div>
    <div>Total Team Hours: <b>${fh(stats.hours)}</b></div>
    ${viewsLine}
    <div>Active Employees: <b>${stats.employees}</b></div>
    <div>Projects Worked: <b>${stats.projects}</b></div>
    <div>Avg. Hours / Employee: <b>${fh(stats.avgPerEmployee)}</b></div>
  `;
  document.body.appendChild(tip);
  positionDashTooltip(evt);
}

function positionDashTooltip(evt) {
  const tip = document.getElementById('dashTooltip');
  if (!tip) return;
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + 240 > window.innerWidth) x = evt.clientX - 240 - pad;
  if (y + 130 > window.innerHeight) y = evt.clientY - 130 - pad;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}

function hideDashTooltip() {
  document.getElementById('dashTooltip')?.remove();
}

// ══════════════════════════════════════════════════════════════
// CLIENT ROLLUP — per client, summed across every project that
// client has: total Project Constant, total Employee Points spent
// (Employee Cost — reuses calculateProjectCost() from
// Client-Project.js exactly as every other Cost/Profit display in
// this app does, not a new calculation), and total Completed Views.
// Five projects under one client just add together — this is that
// sum, grouped by client instead of shown per project.
// ══════════════════════════════════════════════════════════════

function renderDashboardClientRollup(wrap) {
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1rem;height:100%;box-sizing:border-box;display:flex;flex-direction:column;">
      <div style="font-size:14px;font-weight:700;color:var(--txt1);margin-bottom:2px;">🏢 Clients Overview</div>
      <div style="font-size:11px;color:var(--txt2);margin-bottom:12px;">Constant, Employee Points spent, and Completed Views — summed across each client's projects. Showing top 5 by Points Spent — scroll for more.</div>
      <div id="dashClientRollupList" style="max-height:365px;overflow-y:auto;"><div class="mgr-loading"><div class="slot-spinner"></div><span>Loading…</span></div></div>
    </div>`;

  (async () => {
    const clients  = (typeof CP_CLIENTS  !== 'undefined' ? CP_CLIENTS  : []);
    const projects = (typeof CP_PROJECTS !== 'undefined' ? CP_PROJECTS : []);
    const listEl = document.getElementById('dashClientRollupList');
    if (!listEl) return;

    if (!clients.length || !projects.length) {
      listEl.innerHTML = `<div class="chart-empty">No clients/projects yet.</div>`;
      return;
    }

    // One calculateProjectCost() call per project (same function every
    // project card already uses), then grouped and summed by client.
    let costs;
    try {
      costs = await Promise.all(projects.map(p => calculateProjectCost(p)));
    } catch (ex) {
      listEl.innerHTML = `<div class="slot-error">Failed to load: ${esc(ex.message)}</div>`;
      return;
    }
    if (!document.body.contains(listEl)) return; // navigated away while this was loading

    const rollup = {}; // clientId -> { constant, pointsSpent, completedViews, projectCount }
    projects.forEach((p, i) => {
      const cid = p.clientId;
      if (!rollup[cid]) rollup[cid] = { constant: 0, pointsSpent: 0, completedViews: 0, projectCount: 0 };
      rollup[cid].constant       += parseFloat(p.projectConstant) || 0;
      rollup[cid].pointsSpent    += costs[i]?.totalCost || 0;
      rollup[cid].completedViews += parseFloat(p.completedViews) || 0;
      rollup[cid].projectCount   += 1;
    });

    const rows = clients
      .map(c => ({ client: c, r: rollup[c.id] }))
      .filter(x => x.r) // only clients that actually have at least one project
      .sort((a, b) => b.r.pointsSpent - a.r.pointsSpent);

    if (!rows.length) {
      listEl.innerHTML = `<div class="chart-empty">No clients with projects yet.</div>`;
      return;
    }

    listEl.innerHTML = rows.map(({ client, r }) => `
      <div class="dash-client-rollup-row" data-client-id="${esc(client.id)}" style="padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer;border-radius:6px;transition:background .15s;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-size:12.5px;font-weight:700;color:var(--txt1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(client.name)}</div>
          <div style="font-size:10px;color:var(--txt2);flex-shrink:0;">${r.projectCount} project${r.projectCount === 1 ? '' : 's'}</div>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          <div>
            <div style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;">Constant</div>
            <div style="font-size:12px;font-weight:700;color:var(--txt1);">${esc(fmtCPConstant(r.constant))}</div>
          </div>
          <div>
            <div style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;">Points Spent</div>
            <div style="font-size:12px;font-weight:700;color:var(--a1);">${esc(fmtCPConstant(r.pointsSpent))}</div>
          </div>
          <div>
            <div style="font-size:9px;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;">Completed Views</div>
            <div style="font-size:12px;font-weight:700;color:#34d399;">${esc(r.completedViews.toFixed(1))}</div>
          </div>
        </div>
      </div>`).join('');

    // Each row is a button into the existing "Projects & Clients" tab,
    // pre-filtered to that client. Reuses the exact same CP_PC_CLIENT
    // state + renderProjectList() that the Clients sidebar there
    // already sets on click (see renderClientsSidebarInto in
    // Client-Project.js) — this is just a second entry point into that
    // same selection, not a new client-filtering implementation.
    listEl.querySelectorAll('.dash-client-rollup-row').forEach(row => {
      row.addEventListener('mouseenter', () => row.style.background = 'var(--elevated)');
      row.addEventListener('mouseleave', () => row.style.background = '');
      row.addEventListener('click', () => goToClientInProjectsTab(row.dataset.clientId));
    });
  })();
}

// Jumps to the Projects & Clients tab with a given client pre-selected.
// This widget currently only renders on the Manager Dashboard (Team
// Leader has no Dashboard tab), so only the Manager branch is live —
// the TL branch is kept so this keeps working unchanged if a Team
// Leader Dashboard is ever added, since both shells already share the
// same MGR_TAB/renderMgrTab vs TL_TAB/renderTLTab pattern.
function goToClientInProjectsTab(clientId) {
  CP_PC_CLIENT     = clientId || '';
  CP_PC_PROJECT_ID = '';

  if (typeof MANAGER_MODE !== 'undefined' && MANAGER_MODE && typeof MGR_TAB !== 'undefined') {
    MGR_TAB = 'project';
    const container = $('mgrApp');
    container?.querySelectorAll('.mgr-tab').forEach(b => {
      const active = b.dataset.tab === 'project';
      b.style.color        = active ? 'var(--a1)' : 'var(--txt2)';
      b.style.borderBottom = active ? '2px solid var(--a1)' : '2px solid transparent';
    });
    if (typeof renderMgrTab === 'function') renderMgrTab();
  } else if (typeof TL_MODE !== 'undefined' && TL_MODE && typeof TL_TAB !== 'undefined') {
    TL_TAB = 'project';
    const container = $('tlApp');
    container?.querySelectorAll('.tl-tab').forEach(b => {
      const active = b.dataset.tab === 'project';
      b.style.color        = active ? 'var(--a1)' : 'var(--txt2)';
      b.style.borderBottom = active ? '2px solid var(--a1)' : '2px solid transparent';
    });
    if (typeof renderTLTab === 'function') renderTLTab();
  }
}