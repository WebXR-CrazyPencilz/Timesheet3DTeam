// ═══════════════════════════════════════════════════════════════
// GANTT.JS — Project Timeline (Gantt Chart), Manager-only.
//
// Completely standalone. Does NOT modify form.js, table.js, chart.js,
// stats.js, salary.js, or Client-Project.js — only reads from what
// those already expose: window.ClientProjectAPI, CP_PROJECTS,
// CP_CLIENTS, CP_EMPLOYEES, CP_TIMESHEET_DATA. Where those globals
// aren't populated yet (e.g. this is opened before the Client/Project
// tabs have ever been visited this session), this file fetches the
// same underlying data itself via the same existing backend actions
// Client-Project.js already uses (getClientMasterList /
// getProjectMasterList) — no new backend action, no duplicated data
// model, just a fallback so this page works standalone regardless of
// what's been visited already.
//
// Purpose is intentionally narrow: "when did this project exist and
// when was it active" — one bar per project, nothing else. Not a
// task tracker, not a contribution/cost report (those live on the
// Project Detail page this reuses on click), not a management board.
// ═══════════════════════════════════════════════════════════════

// ── STATE ─────────────────────────────────────────────────────
let GANTT_CONTAINER   = null;  // the content element passed to initGantt
let GANTT_CLIENTS     = [];
let GANTT_PROJECTS    = [];    // enriched: { ...project, clientName, startDate, lastActivity, totalHours, employeeCount, barColor }
let GANTT_ALL_ENTRIES = [];    // CP_TIMESHEET_DATA snapshot at load time

let GANTT_FILTER_CLIENT   = '';
let GANTT_FILTER_PROJECT  = '';
let GANTT_FILTER_EMPLOYEE = '';

let GANTT_TIMELINE    = null;  // { months: [{year,month,key,label}], startKey, endKey }
let GANTT_MONTH_WIDTH = 34;    // px per month, zoomable
const GANTT_MONTH_WIDTH_MIN = 14;     // floor for manual Zoom In/Out — keeps interactive zoom readable
const GANTT_MONTH_WIDTH_FIT_MIN = 3;  // floor for Fit All ONLY — showing the complete history takes priority over readability here
const GANTT_MONTH_WIDTH_MAX = 90;
const GANTT_ROW_HEIGHT       = 40;   // px, one project's bar row — tightened; label lines below use exact matching line-heights so nothing overlaps
const GANTT_LABEL_WIDTH      = 240;  // px, sticky left panel width
const GANTT_HEADER_HEIGHT    = 44;   // px, year+month header combined

const GANTT_COST_CACHE = {}; // projectId -> computed cost (lazy, filled on first hover)

// Injected once into <head>, not into any page's own innerHTML — same
// reasoning as Client-Project.js's ensureCPStyles: a <style> tag
// embedded in content.innerHTML disappears the moment that content is
// replaced (e.g. re-rendering on zoom/filter change), which would
// silently strip the bar's hover animation on every redraw.
function ensureGanttStyles() {
  if (document.getElementById('gantt-global-styles')) return;
  const style = document.createElement('style');
  style.id = 'gantt-global-styles';
  style.textContent = `
    .gantt-bar {
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,.35);
      transition: all .2s ease;
      cursor: pointer;
    }
    .gantt-bar:hover {
      filter: brightness(1.18);
      box-shadow: 0 4px 14px rgba(0,0,0,.5), 0 0 10px var(--gantt-glow, rgba(255,255,255,.3));
      transform: scaleY(1.08);
    }
  `;
  document.head.appendChild(style);
}

// Status now only ever drives the tooltip label + a tiny row dot —
// never bar length, never bar color (see loadProjects/drawProjectBars).
// Self-contained business/professional color palette for project
// bars — deliberately its own set, not Client-Project.js's
// CP_PROJECT_PALETTE (that one is bright/saturated by design, for
// card avatars elsewhere — exactly what was reading as "gamified"
// here). Same deterministic approach (hash the Project ID against a
// fixed list, never random, never stored in Sheets), just a muted
// "600–800" tone range instead. No red — reserved for loss/error
// indicators only, never used decoratively.
const GANTT_PROJECT_PALETTE = [
  '#2563eb', '#0891b2', '#059669', '#7c3aed', '#b45309', '#4338ca',
  '#0f766e', '#6d28d9', '#1d4ed8', '#15803d', '#a16207', '#0369a1',
  '#6b21a8', '#0e7490', '#475569', '#92400e',
];

function getGanttProjectColor(projectId) {
  const str = 'gantt-proj:' + String(projectId || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return GANTT_PROJECT_PALETTE[hash % GANTT_PROJECT_PALETTE.length];
}

const GANTT_STATUS_COLOR = {
  'In Progress': { bg: '#34d399', label: 'Active',    dot: '🟢' },
  'Completed':   { bg: '#4f8ef7', label: 'Completed', dot: '🔵' },
  'On Hold':     { bg: '#fb923c', label: 'On Hold',   dot: '🟠' },
};

// ── ENTRY POINT ───────────────────────────────────────────────
async function initGantt(content) {
  GANTT_CONTAINER = content;
  ensureGanttStyles();

  if (typeof MANAGER_MODE !== 'undefined' && !MANAGER_MODE) {
    content.innerHTML = `<div class="chart-empty">Project Timeline is only available to the Manager.</div>`;
    return;
  }

  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading project timeline…</span></div>`;

  try {
    await loadProjects();
  } catch (err) {
    content.innerHTML = `<div class="slot-error">Failed to load timeline: ${esc(err.message)}</div>`;
    return;
  }

  if (!GANTT_PROJECTS.length) {
    content.innerHTML = `
      <div style="font-size:16px;font-weight:700;color:var(--txt1);margin-bottom:.3rem;">📊 Project Timeline</div>
      <div class="chart-empty">No projects with timesheet activity yet.</div>`;
    return;
  }

  calculateTimeline();
  renderGanttShell(content);
}

// ── LOAD DATA ─────────────────────────────────────────────────
// Prefers the already-forwarded globals (no duplicate fetch) but
// falls back to fetching directly if this page is opened before the
// Client/Project tabs have populated them this session.
// Month-name → number, for converting Historical Import's records
// ('January'..'December' + a separate year field) into real dates.
// Self-contained on purpose — gantt.js doesn't modify or depend on
// load order with Client-Project.js's own copy of this mapping.
const GANTT_HIST_MONTH_NUM = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

function histMonthToDateRange(monthName, year) {
  const monthNum = GANTT_HIST_MONTH_NUM[monthName];
  if (!monthNum || !year) return null;
  const y = parseInt(year, 10);
  const lastDay = new Date(y, monthNum, 0).getDate();
  return {
    start: `${y}-${String(monthNum).padStart(2, '0')}-01`,
    end:   `${y}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

async function loadProjects() {
  let clients  = (typeof CP_CLIENTS !== 'undefined' && CP_CLIENTS.length) ? CP_CLIENTS : null;
  let projects = (typeof CP_PROJECTS !== 'undefined' && CP_PROJECTS.length) ? CP_PROJECTS : null;

  if (!clients)  clients  = await sheetGET({ action: 'getClientMasterList' });
  if (!projects) {
    const role = (typeof MANAGER_MODE !== 'undefined' && MANAGER_MODE) ? 'manager' : 'tl';
    projects = await sheetGET({ action: 'getProjectMasterList', role });
  }

  GANTT_CLIENTS     = clients || [];
  GANTT_ALL_ENTRIES = (typeof CP_TIMESHEET_DATA !== 'undefined') ? CP_TIMESHEET_DATA : [];

  // Pull in ALL historical hours from Historical Import, ONCE, for
  // every project at once — this is what lets the timeline and each
  // project's bar reflect its full real lifetime (e.g. back to 2020),
  // not just what's been logged since the live timesheet system
  // started. One network call regardless of how many projects exist;
  // no per-project fetch, no cap on how far back it goes.
  let histRows = [];
  try {
    histRows = await sheetGET({ action: 'getHistoricalRecords', filters: encodeURIComponent(JSON.stringify({})) });
  } catch (ex) {
    // Historical data genuinely unavailable — timeline falls back to
    // live-entry dates only rather than failing to load at all.
  }
  const histByProject = {};
  (histRows || []).forEach(r => {
    if (!histByProject[r.projectId]) histByProject[r.projectId] = [];
    histByProject[r.projectId].push(r);
  });

  const clientNameById = {};
  GANTT_CLIENTS.forEach(c => { clientNameById[c.id] = c.name; });

  GANTT_PROJECTS = (projects || [])
    .map(p => {
      const entries     = GANTT_ALL_ENTRIES.filter(e => e.project === p.projectName && e.status !== 'Leave');
      const histRecords  = histByProject[p.projectId] || [];
      const histRanges   = histRecords.map(r => histMonthToDateRange(r.month, r.year)).filter(Boolean);

      const liveDates       = entries.map(e => e.date).filter(Boolean);
      const startCandidates = [...liveDates, ...histRanges.map(r => r.start)];
      const endCandidates   = [...liveDates, ...histRanges.map(r => r.end)];

      if (!startCandidates.length && !p.createdDate) return null; // nothing to place on a timeline at all

      const startDate    = startCandidates.length ? startCandidates.slice().sort()[0] : toLocalDateStr(new Date(p.createdDate || Date.now()));
      const lastActivity = endCandidates.length   ? endCandidates.slice().sort().slice(-1)[0] : startDate;

      // Exactly which months this project actually has SOME hours in —
      // live or historical. A project can have a real gap in the
      // middle (e.g. worked Jan–Mar, idle Apr–Aug, resumed for
      // corrections Sep–Nov) — the bar should only fill months that
      // genuinely have activity, not every month between the first
      // and last regardless of what happened in between.
      //
      // monthlyHours extends this SAME scan (not a second pass) to
      // also total actual hours per month — needed for Views
      // Delivered below (effort-weighted, never equal/calendar
      // distribution). activeMonths itself is unchanged.
      const activeMonths = new Set();
      const monthlyHours = {}; // { 'YYYY-MM': hours }
      entries.forEach(e => {
        if (!e.date) return;
        const key = e.date.slice(0, 7);
        activeMonths.add(key);
        monthlyHours[key] = (monthlyHours[key] || 0) + parseH(e.hours);
      });
      histRecords.forEach(r => {
        const mn = GANTT_HIST_MONTH_NUM[r.month];
        if (!mn || !r.year) return;
        const key = `${r.year}-${String(mn).padStart(2, '0')}`;
        activeMonths.add(key);
        monthlyHours[key] = (monthlyHours[key] || 0) + (parseFloat(r.totalHours) || 0);
      });

      const liveHours = entries.reduce((s, e) => s + parseH(e.hours), 0);
      const histHours = histRecords.reduce((s, r) => s + (parseFloat(r.totalHours) || 0), 0);
      const totalHours = liveHours + histHours;

      const employeeCount = new Set([...entries.map(e => e.empId), ...histRecords.map(r => r.employeeId)]).size;

      // Bar color: every project gets its own PERMANENT color, same
      // on every reload, via getGanttProjectColor's deterministic
      // hash against GANTT_PROJECT_PALETTE (self-contained business
      // palette — see top of file) — never random, never stored in
      // Sheets. Status no longer determines bar color at all; it
      // only carries a label + dot color for the tooltip/row dot.
      const barColor = getGanttProjectColor(p.projectId);
      const statusMeta = GANTT_STATUS_COLOR[p.status] || GANTT_STATUS_COLOR['In Progress'];

      return {
        ...p,
        clientName: clientNameById[p.clientId] || p.clientId || '—',
        startDate, lastActivity, totalHours, employeeCount, activeMonths, monthlyHours,
        barColor, statusLabel: statusMeta.label, statusDotColor: statusMeta.bg, statusDot: statusMeta.dot,
      };
    })
    .filter(Boolean);
}

// ── VIEWS DELIVERED (effort-weighted, never equal/calendar split) ──
// Month Weight = Month Hours / Total Project Hours
// Views Delivered = Completed Views × Month Weight
// Reuses p.totalHours and p.monthlyHours (both already computed by
// loadProjects() above) and p.completedViews (already a field on the
// project record from Client-Project.js's Project Editor — nothing
// new to load). No new calculation engine: this is one formula
// applied to numbers that already exist.
function getMonthlyViewsDelivered(p, monthKey) {
  const hours = p.monthlyHours?.[monthKey] || 0;
  const totalHours = p.totalHours || 0;
  const completedViews = parseFloat(p.completedViews) || 0;
  if (hours <= 0 || totalHours <= 0 || completedViews <= 0) return { hours, weight: 0, views: 0 };
  const weight = hours / totalHours;
  return { hours, weight, views: completedViews * weight };
}

// ── TIMELINE RANGE ────────────────────────────────────────────
function findEarliestProject() {
  return GANTT_PROJECTS.reduce((min, p) => (!min || p.startDate < min) ? p.startDate : min, null);
}

function findLatestActivity() {
  return GANTT_PROJECTS.reduce((max, p) => (!max || p.lastActivity > max) ? p.lastActivity : max, null);
}

// Timeline never starts later than this year, regardless of what the
// earliest detected project data actually is — a fixed floor, same
// pattern as the Attendance tab's MGR_ATTEND_MONTH_FLOOR elsewhere in
// this app. If real data goes back further than this, the real data
// still wins (see calculateTimeline below) — this only forces the
// timeline to START by this year at the latest, showing empty years
// before any project existed rather than cropping the view to
// whatever happens to be the earliest logged entry.
const GANTT_TIMELINE_FLOOR_YEAR = 2020;

function calculateTimeline() {
  const earliest = findEarliestProject();
  const tod = todayStr();

  // Timeline always runs Earliest Project Start → Current Month, full
  // stop — not "whichever is later between last activity and today."
  // Managers should always be able to see where "today" sits relative
  // to every project, even ones that finished long ago (their bars
  // still correctly stop at their own last activity — see
  // drawProjectBars — only the overall grid extends to the present).
  const latest = tod;

  // Pad the start back to January of the earliest project's year (so
  // the first year row is always a complete Jan–Dec block, never a
  // partial year), then clamp it to never start LATER than the fixed
  // floor year above — whichever is earlier wins, so genuinely older
  // data is never cropped, but the timeline also never starts more
  // recently than the floor even if all detected data is newer.
  const earliestYear = Math.min(parseInt(earliest.slice(0, 4), 10), GANTT_TIMELINE_FLOOR_YEAR);
  const paddedStart = `${earliestYear}-01-01`;

  GANTT_TIMELINE = { months: buildMonthHeaders(paddedStart, latest), startKey: paddedStart.slice(0, 7), endKey: latest.slice(0, 7) };
}

// Every month between start and end, inclusive — never skips a month
// even if nothing happened during it.
function buildMonthHeaders(startDateStr, endDateStr) {
  const months = [];
  const [sy, sm] = startDateStr.slice(0, 7).split('-').map(Number);
  const [ey, em] = endDateStr.slice(0, 7).split('-').map(Number);
  let y = sy, m = sm;
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 1200) {
    const key   = `${y}-${String(m).padStart(2, '0')}`;
    const label = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
    months.push({ year: y, month: m, key, label });
    m++; if (m > 12) { m = 1; y++; }
    guard++;
  }
  return months;
}

function monthIndexOf(monthKey) {
  return GANTT_TIMELINE.months.findIndex(m => m.key === monthKey);
}

// ── FILTERED PROJECT LIST ─────────────────────────────────────
function getFilteredGanttProjects() {
  return GANTT_PROJECTS.filter(p => {
    if (GANTT_FILTER_CLIENT && p.clientId !== GANTT_FILTER_CLIENT) return false;
    if (GANTT_FILTER_PROJECT && p.projectId !== GANTT_FILTER_PROJECT) return false;
    if (GANTT_FILTER_EMPLOYEE) {
      const worked = GANTT_ALL_ENTRIES.some(e => e.project === p.projectName && e.empId === GANTT_FILTER_EMPLOYEE && e.status !== 'Leave');
      if (!worked) return false;
    }
    return true;
  }).reverse(); // row order reversed, per request — whatever was first is now last
}

// ── SHELL: filters + scroll area ──────────────────────────────
function renderGanttShell(content) {
  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;flex-wrap:wrap;gap:10px;">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--txt1);">📊 Project Timeline</div>
        <div style="font-size:12px;color:var(--txt2);">When each project existed and was active — click a bar for full details.</div>
      </div>
      <div id="ganttTotalViewsBadge" style="background:var(--elevated);border:1px solid var(--border-md);border-radius:8px;
        padding:6px 14px;text-align:center;">
        <div style="font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;">Total Number of Views</div>
        <div style="font-size:16px;font-weight:800;color:var(--a1);">0</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <button id="ganttZoomOut" class="cp-nav-btn" title="Zoom out">−</button>
        <button id="ganttZoomIn"  class="cp-nav-btn" title="Zoom in">+</button>
        <button id="ganttFitAll"  style="background:var(--elevated);color:var(--txt1);border:1px solid var(--border-md);
          border-radius:6px;padding:6px 12px;font-size:11.5px;font-weight:600;cursor:pointer;">Fit All</button>
        <button id="ganttToday"   style="background:var(--elevated);color:var(--txt1);border:1px solid var(--border-md);
          border-radius:6px;padding:6px 12px;font-size:11.5px;font-weight:600;cursor:pointer;">Today</button>
      </div>
    </div>

    <div id="ganttFilterWrap">${renderFilters()}</div>

    <div id="ganttBodyWrap" style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;
      overflow:hidden;position:relative;"></div>

    <div style="margin-top:8px;font-size:11px;color:var(--txt2);display:flex;gap:14px;flex-wrap:wrap;align-items:center;">
      <span>🎨 <b style="color:var(--txt1);">Project Colors</b> — each bar color represents an individual project (hover a project for full details)</span>
      <span>📐 Each month block shows effort-weighted <b style="color:var(--txt1);">Views Delivered</b> — hover a block for the full monthly breakdown</span>
      <span>🟢 Active · 🔵 Completed · 🟠 On Hold</span>
      <span><span style="display:inline-block;width:2px;height:9px;background:#f87171;margin-right:5px;"></span>Today</span>
    </div>
  `;

  wireFilters(content);
  $('ganttZoomOut').addEventListener('click', () => zoomOut());
  $('ganttZoomIn').addEventListener('click', () => zoomIn());
  $('ganttFitAll').addEventListener('click', () => fitAll());
  $('ganttToday').addEventListener('click', () => scrollToToday());

  renderTimeline();
  // Land on a sensible default view immediately, rather than opening
  // on the empty padded start of the timeline (e.g. 2020) and making
  // the user manually click Fit All every time just to see their
  // actual projects.
  requestAnimationFrame(() => fitAll());
}

// ── FILTER BAR ────────────────────────────────────────────────
function renderFilters() {
  const clientProjects = GANTT_FILTER_CLIENT
    ? GANTT_PROJECTS.filter(p => p.clientId === GANTT_FILTER_CLIENT)
    : GANTT_PROJECTS;

  const employeesWithActivity = (typeof CP_EMPLOYEES !== 'undefined' ? CP_EMPLOYEES : [])
    .filter(e => GANTT_ALL_ENTRIES.some(en => en.empId === e.id && en.status !== 'Leave'));

  return `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:.6rem;">
      <select id="ganttFilterClient" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
        color:var(--txt1);font-size:12px;padding:6px 8px;cursor:pointer;">
        <option value="">All Clients</option>
        ${GANTT_CLIENTS.map(c => `<option value="${esc(c.id)}" ${c.id === GANTT_FILTER_CLIENT ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <select id="ganttFilterProject" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
        color:var(--txt1);font-size:12px;padding:6px 8px;cursor:pointer;">
        <option value="">All Projects</option>
        ${clientProjects.map(p => `<option value="${esc(p.projectId)}" ${p.projectId === GANTT_FILTER_PROJECT ? 'selected' : ''}>${esc(p.projectName)}</option>`).join('')}
      </select>
      <select id="ganttFilterEmployee" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
        color:var(--txt1);font-size:12px;padding:6px 8px;cursor:pointer;">
        <option value="">All Employees</option>
        ${employeesWithActivity.map(e => `<option value="${esc(e.id)}" ${e.id === GANTT_FILTER_EMPLOYEE ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
      </select>
    </div>
  `;
}

function wireFilters(content) {
  content.querySelector('#ganttFilterClient').addEventListener('change', e => filterByClient(e.target.value));
  content.querySelector('#ganttFilterProject').addEventListener('change', e => filterByProject(e.target.value));
  content.querySelector('#ganttFilterEmployee').addEventListener('change', e => filterByEmployee(e.target.value));
}

function filterByClient(clientId) {
  GANTT_FILTER_CLIENT  = clientId;
  GANTT_FILTER_PROJECT = ''; // project choice no longer valid once client changes
  refreshGantt();
}
function filterByProject(projectId) {
  GANTT_FILTER_PROJECT = projectId;
  refreshGantt();
}
function filterByEmployee(empId) {
  GANTT_FILTER_EMPLOYEE = empId;
  refreshGantt();
}

// Re-renders the filter bar (so Project's options reflect the chosen
// Client) and the timeline body, without re-fetching any data.
//
// BUG FIX: this used to find '.cp-form-grid' and replace its
// PARENT's outerHTML with renderFilters()'s output. renderFilters()
// returns a single un-wrapped .cp-form-grid div, and that div sits
// directly inside the content container in renderGanttShell's
// template — so ".parentElement" resolved to the CONTENT CONTAINER
// ITSELF. Setting outerHTML on it replaced the entire container
// (title, zoom/Fit All/Today buttons, and the whole timeline body)
// with nothing but the bare filter dropdowns, and left GANTT_CONTAINER
// pointing at a now-detached, removed element — which is exactly why
// changing a filter made everything else vanish and never come back.
// Fixed by giving the filter block one stable, real ID and only ever
// touching its innerHTML.
function refreshGantt() {
  if (!GANTT_CONTAINER) return;
  const filterHost = $('ganttFilterWrap');
  if (filterHost) {
    filterHost.innerHTML = renderFilters();
    wireFilters(GANTT_CONTAINER);
  }
  renderTimeline();
}

// ── TIMELINE BODY ─────────────────────────────────────────────
function renderTimeline() {
  const wrap = $('ganttBodyWrap');
  if (!wrap || !GANTT_TIMELINE) return;

  const projects = getFilteredGanttProjects();
  const months = GANTT_TIMELINE.months;
  const totalWidth = months.length * GANTT_MONTH_WIDTH;
  const bodyHeight = Math.min(projects.length * GANTT_ROW_HEIGHT, 560);

  // Year groups for the sticky year header row (merged span per year).
  const yearGroups = [];
  months.forEach((m, i) => {
    const last = yearGroups[yearGroups.length - 1];
    if (last && last.year === m.year) last.count++;
    else yearGroups.push({ year: m.year, count: 1 });
  });

  // Column totals — sum of Views Delivered across every visible
  // project, for each month currently on the timeline. Reuses
  // getMonthlyViewsDelivered() per project/month, same formula as
  // every individual block — just summed across the filtered set.
  const monthTotals = months.map(m =>
    projects.reduce((s, p) => s + getMonthlyViewsDelivered(p, m.key).views, 0)
  );
  const TOTAL_ROW_HEIGHT = 26;

  // Grand total — sum of every visible project's Completed Views.
  // Mathematically identical to summing monthTotals above (each
  // project's monthly weights always sum to 1), shown once in the
  // header badge rather than recomputed a second way.
  const grandTotal = projects.reduce((s, p) => s + (parseFloat(p.completedViews) || 0), 0);
  const badgeVal = document.querySelector('#ganttTotalViewsBadge > div:last-child');
  if (badgeVal) badgeVal.textContent = grandTotal.toLocaleString('en-IN', { maximumFractionDigits: 1 });

  wrap.innerHTML = `
    <div id="ganttScroll" style="overflow:auto;max-height:${bodyHeight + GANTT_HEADER_HEIGHT + TOTAL_ROW_HEIGHT}px;position:relative;">
      <div style="width:${GANTT_LABEL_WIDTH + totalWidth}px;">

        <!-- Header: corner + year row + month row -->
        <div style="display:flex;position:sticky;top:0;z-index:3;">
          <div style="position:sticky;left:0;top:0;width:${GANTT_LABEL_WIDTH}px;flex-shrink:0;height:${GANTT_HEADER_HEIGHT}px;
            background:var(--surface2);border-right:1px solid var(--border);border-bottom:1px solid var(--border);z-index:4;
            display:flex;align-items:center;padding:0 12px;font-size:10.5px;color:var(--txt2);text-transform:uppercase;
            letter-spacing:.04em;">Client / Project</div>
          <div>
            <div style="display:flex;height:20px;">
              ${yearGroups.map(g => `<div style="width:${g.count * GANTT_MONTH_WIDTH}px;flex-shrink:0;background:var(--surface2);
                border-right:1px solid var(--border);border-bottom:1px solid var(--border);display:flex;align-items:center;
                justify-content:center;font-size:10px;font-weight:700;color:var(--txt1);">${g.year}</div>`).join('')}
            </div>
            <div style="display:flex;height:${GANTT_HEADER_HEIGHT - 20}px;">
              ${months.map(m => `<div style="width:${GANTT_MONTH_WIDTH}px;flex-shrink:0;background:var(--surface2);
                border-right:1px solid var(--border);border-bottom:1px solid var(--border);display:flex;align-items:center;
                justify-content:center;font-size:9px;color:var(--txt2);white-space:nowrap;overflow:hidden;">${GANTT_MONTH_WIDTH > 20 ? m.label : ''}</div>`).join('')}
            </div>
          </div>
        </div>

        <!-- Total row — sum of Views Delivered per month, across
             every currently-visible project. Sticky just below the
             header so it stays visible while scrolling down through
             many project rows. -->
        <div style="display:flex;position:sticky;top:${GANTT_HEADER_HEIGHT}px;z-index:3;">
          <div style="position:sticky;left:0;width:${GANTT_LABEL_WIDTH}px;flex-shrink:0;height:${TOTAL_ROW_HEIGHT}px;
            background:var(--surface2);border-right:1px solid var(--border);border-bottom:2px solid var(--border-md);z-index:4;
            display:flex;align-items:center;padding:0 12px;font-size:10.5px;font-weight:700;color:var(--txt1);">Total</div>
          <div style="display:flex;">
            ${months.map((m, i) => `<div style="width:${GANTT_MONTH_WIDTH}px;flex-shrink:0;height:${TOTAL_ROW_HEIGHT}px;
              background:var(--surface2);border-right:1px solid var(--border);border-bottom:2px solid var(--border-md);
              display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:700;color:var(--a1);
              white-space:nowrap;overflow:hidden;">${monthTotals[i] > 0 && GANTT_MONTH_WIDTH >= 26 ? monthTotals[i].toFixed(1) : ''}</div>`).join('')}
          </div>
        </div>

        <!-- Rows -->
        <div id="ganttRows" style="position:relative;">
          ${projects.length === 0
            ? `<div style="padding:2rem;text-align:center;color:var(--txt2);font-size:12.5px;">No projects match these filters.</div>`
            : projects.map(p => buildGanttRow(p)).join('')}
          ${drawTodayMarker(projects.length)}
        </div>
      </div>
    </div>
  `;

  drawProjectBars(projects);
  wireGanttRows(projects);
  wireGanttPanAndWheel();
}

function buildGanttRow(p) {
  // Repeating vertical line every GANTT_MONTH_WIDTH px — draws real
  // per-month grid lines through the bar area (not just the header)
  // as a single background-image instead of one DOM element per
  // month per row, so this stays cheap even with many rows/months.
  const monthGridBg = `repeating-linear-gradient(to right, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${GANTT_MONTH_WIDTH}px)`;
  return `
    <div class="gantt-row" data-project-id="${esc(p.projectId)}" style="display:flex;height:${GANTT_ROW_HEIGHT}px;
      border-bottom:1px solid var(--border);cursor:pointer;">
      <div style="position:sticky;left:0;width:${GANTT_LABEL_WIDTH}px;flex-shrink:0;background:var(--surface1);
        border-right:1px solid var(--border);z-index:2;padding:2px 12px;display:flex;flex-direction:column;
        justify-content:center;overflow:hidden;">
        <div style="font-size:10px;line-height:11px;color:var(--txt2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.clientName)}</div>
        <div style="font-size:11px;line-height:12px;font-weight:700;color:var(--txt1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${esc(p.projectName)} <span style="font-size:7px;" title="${esc(p.statusLabel)}">${p.statusDot}</span>
        </div>
        <div style="font-size:8.5px;line-height:10px;color:var(--txt2);font-family:var(--fm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.projectId)}</div>
      </div>
      <div class="gantt-row-bar-track" style="position:relative;flex:1;background-image:${monthGridBg};"></div>
    </div>`;
}

// Segmented "box|box|box" style — one small rounded box per month
// within the project's active span, with a small gap between adjacent
// segments so each month's boundary stays visible even where the
// project was active, instead of one solid bar covering the grid
// lines underneath it. Hover/click are still bound at the ROW level
// (see wireGanttRows), so interaction is unaffected by how many
// segments a given project's bar is split into.
function drawProjectBars(projects) {
  const rows = document.querySelectorAll('#ganttRows .gantt-row');
  const GAP = 3; // px between adjacent month segments
  // Minimum segment width for the two-line Hours/Views label to
  // actually be readable — below this, the segment still renders
  // (real activity, real gap behavior unchanged), just without text.
  const MIN_WIDTH_FOR_LABEL = 30;

  rows.forEach(row => {
    const projectId = row.dataset.projectId;
    const p = projects.find(x => x.projectId === projectId);
    if (!p) return;
    const track = row.querySelector('.gantt-row-bar-track');
    if (!track) return;

    const startKey = p.startDate.slice(0, 7);
    const endKey   = p.lastActivity.slice(0, 7);

    const startIdx = monthIndexOf(startKey);
    const endIdx   = monthIndexOf(endKey);
    if (startIdx === -1 || endIdx === -1) return;

    for (let i = startIdx; i <= endIdx; i++) {
      const monthKey = GANTT_TIMELINE.months[i]?.key;
      if (!monthKey || !p.activeMonths || !p.activeMonths.has(monthKey)) continue; // genuine gap — leave it empty, no artificial fill

      const left  = i * GANTT_MONTH_WIDTH + GAP / 2;
      const width = Math.max(GANTT_MONTH_WIDTH - GAP, 4);

      const { hours, views } = getMonthlyViewsDelivered(p, monthKey);
      const showLabel = width >= MIN_WIDTH_FOR_LABEL && hours > 0;

      const seg = document.createElement('div');
      seg.className = 'gantt-bar';
      seg.dataset.projectId = p.projectId;
      seg.dataset.monthKey = monthKey;
      seg.style.cssText = `position:absolute;left:${left}px;top:8px;width:${width}px;height:${GANTT_ROW_HEIGHT - 16}px;
        background:${p.barColor};--gantt-glow:${p.barColor};display:flex;flex-direction:column;align-items:center;
        justify-content:center;overflow:hidden;line-height:1.1;`;
      if (showLabel) {
        seg.innerHTML = `
          <span style="font-size:10px;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.4);white-space:nowrap;pointer-events:none;">${views.toFixed(1)} Views</span>`;
      }
      track.appendChild(seg);
    }
  });
}

function drawTodayMarker(projectCount) {
  const tod = todayStr().slice(0, 7);
  const idx = monthIndexOf(tod);
  if (idx === -1) return '';
  const left = GANTT_LABEL_WIDTH + idx * GANTT_MONTH_WIDTH + GANTT_MONTH_WIDTH / 2;
  const height = Math.max(projectCount * GANTT_ROW_HEIGHT, GANTT_ROW_HEIGHT);
  return `
    <div style="position:absolute;left:${left}px;top:0;width:2px;height:${height}px;background:#f87171;z-index:1;pointer-events:none;">
      <div style="position:absolute;top:-2px;left:4px;font-size:9px;font-weight:700;color:#f87171;white-space:nowrap;">TODAY</div>
    </div>`;
}

// ── HOVER + CLICK ──────────────────────────────────────────────
function wireGanttRows(projects) {
  document.querySelectorAll('#ganttRows .gantt-row').forEach(row => {
    const p = projects.find(x => x.projectId === row.dataset.projectId);
    if (!p) return;

    row.addEventListener('mouseenter', e => showGanttTooltip(e, p));
    row.addEventListener('mousemove', e => positionGanttTooltip(e));
    row.addEventListener('mouseleave', hideGanttTooltip);
    row.addEventListener('click', () => openGanttProjectDetail(p.projectId));

    // Per-segment hover shows the monthly Hours/Views Delivered
    // breakdown instead of the row's aggregate tooltip — swapped in
    // on entering a specific month's block, and the aggregate
    // tooltip resumes on leaving it (still within the row). Row-level
    // click still opens Project Detail regardless of which segment
    // was clicked — unchanged.
    row.querySelectorAll('.gantt-bar').forEach(seg => {
      seg.addEventListener('mouseenter', e => { e.stopPropagation(); showGanttSegmentTooltip(e, p, seg.dataset.monthKey); });
      seg.addEventListener('mousemove', e => { e.stopPropagation(); positionGanttTooltip(e); });
      seg.addEventListener('mouseleave', e => { e.stopPropagation(); showGanttTooltip(e, p); });
    });
  });
}

// Month-specific tooltip — Hours Worked, Views Delivered, Contribution
// %, per the effort-weighted formula above. Reuses the same
// #ganttTooltip element/positioning/dismiss functions as the
// aggregate tooltip (showGanttTooltip/positionGanttTooltip/
// hideGanttTooltip) so both behave identically, just with different
// content — no separate tooltip system introduced.
function showGanttSegmentTooltip(evt, p, monthKey) {
  hideGanttTooltip();
  const { hours, weight, views } = getMonthlyViewsDelivered(p, monthKey);
  const monthLabel = new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const tip = document.createElement('div');
  tip.id = 'ganttTooltip';
  tip.style.cssText = `position:fixed;z-index:10001;background:var(--surface1);border:1px solid var(--border-md);
    border-radius:10px;padding:10px 12px;font-size:11.5px;color:var(--txt1);box-shadow:0 8px 24px rgba(0,0,0,.4);
    max-width:260px;pointer-events:none;`;
  tip.innerHTML = `
    <div style="font-weight:700;margin-bottom:4px;">${esc(p.projectName)}</div>
    <div style="color:var(--txt2);margin-bottom:6px;">${esc(monthLabel)}</div>
    <div>Views Delivered: <b>${views.toFixed(1)}</b></div>
    <div>Contribution: <b>${(weight * 100).toFixed(1)}%</b></div>
  `;
  document.body.appendChild(tip);
  positionGanttTooltip(evt);
}

async function showGanttTooltip(evt, p) {
  hideGanttTooltip();
  const tip = document.createElement('div');
  tip.id = 'ganttTooltip';
  tip.style.cssText = `position:fixed;z-index:10001;background:var(--surface1);border:1px solid var(--border-md);
    border-radius:10px;padding:10px 12px;font-size:11.5px;color:var(--txt1);box-shadow:0 8px 24px rgba(0,0,0,.4);
    max-width:260px;pointer-events:none;`;
  tip.innerHTML = `
    <div style="font-weight:700;margin-bottom:4px;">${esc(p.projectName)} <span style="font-size:9px;">${p.statusDot}</span></div>
    <div style="color:var(--txt2);margin-bottom:6px;">${esc(p.clientName)} · ${esc(p.projectId)} · ${esc(p.statusLabel)}</div>
    <div>Start: <b>${esc(fmtGanttDate(p.startDate))}</b></div>
    <div>Latest Activity: <b>${esc(fmtGanttDate(p.lastActivity))}</b></div>
    <div>Total Hours: <b>${p.totalHours.toFixed(1)}h</b></div>
    <div>Total Employees: <b>${p.employeeCount}</b></div>
    <div id="ganttTipCost">Cost/Profit: <b>Loading…</b></div>
  `;
  document.body.appendChild(tip);
  positionGanttTooltip(evt);

  // Lazy + cached — cost calc can involve a network call (historical
  // data), so this is only ever computed once per project, on first
  // hover, not up front for every project on the timeline.
  if (GANTT_COST_CACHE[p.projectId] === undefined) {
    try {
      GANTT_COST_CACHE[p.projectId] = await ClientProjectAPI.computeProjectCost(p.projectId);
    } catch (e) {
      GANTT_COST_CACHE[p.projectId] = null;
    }
  }
  const costEl = document.getElementById('ganttTipCost');
  if (!costEl) return; // tooltip already dismissed by the time this resolved
  const cost = GANTT_COST_CACHE[p.projectId];
  if (!cost) { costEl.innerHTML = `Cost/Profit: <b>—</b>`; return; }
  const isProfit = cost.profit >= 0;
  costEl.innerHTML = `Cost: <b>${cost.totalCost.toFixed(1)}</b> · ${isProfit ? 'Profit' : 'Loss'}: 
    <b style="color:${isProfit ? '#34d399' : '#f87171'};">${isProfit ? '+' : '-'}${Math.abs(cost.profit).toFixed(1)}</b>`;
}

function positionGanttTooltip(evt) {
  const tip = document.getElementById('ganttTooltip');
  if (!tip) return;
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + 260 > window.innerWidth) x = evt.clientX - 260 - pad;
  if (y + 140 > window.innerHeight) y = evt.clientY - 140 - pad;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}

function hideGanttTooltip() {
  document.getElementById('ganttTooltip')?.remove();
}

function fmtGanttDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Reuses the existing Project Detail page entirely — never
// reimplemented here. Detects which portal container is active the
// same way the Attendance grid's Force Entry hand-off does, so this
// works correctly regardless of which portal opened it.
function openGanttProjectDetail(projectId) {
  const portalRoot = GANTT_CONTAINER.closest('#mgrApp, #tlApp');
  const portalId    = portalRoot ? portalRoot.id : 'mgrApp';
  const tabContent  = portalRoot ? portalRoot.querySelector('#mgrTabContent, #tlTabContent') : GANTT_CONTAINER;
  if (typeof openProjectDetail !== 'function') { toast?.('e', 'Project Detail module not loaded'); return; }
  openProjectDetail(tabContent, projectId, {
    containerId: portalId,
    onBack: () => initGantt(tabContent),
  });
}

// ── ZOOM / PAN / NAVIGATE ──────────────────────────────────────
function zoomIn()  { setGanttMonthWidth(GANTT_MONTH_WIDTH + 8); }
function zoomOut() { setGanttMonthWidth(GANTT_MONTH_WIDTH - 8); }

function setGanttMonthWidth(px) {
  GANTT_MONTH_WIDTH = Math.max(GANTT_MONTH_WIDTH_MIN, Math.min(GANTT_MONTH_WIDTH_MAX, px));
  renderTimeline();
}

// Fit All ONLY changes the zoom level — it must never touch scroll
// position, filters, the selected project, or the underlying timeline
// data (renderTimeline() below reads whatever filters/state already
// exist, it doesn't reset anything). Unlike manual Zoom In/Out (which
// respects GANTT_MONTH_WIDTH_MIN for readability), this prioritizes
// showing the ENTIRE history without requiring scroll — so it clamps
// to the much smaller GANTT_MONTH_WIDTH_FIT_MIN instead, and never
// stops shrinking just because that's below the normal interactive
// minimum.
// Fit All zooms to the range that ACTUALLY has project activity
// (earliest real project → today), not the full padded timeline
// (which can include years of deliberately-empty space from the
// fixed floor year — see GANTT_TIMELINE_FLOOR_YEAR). Fitting to the
// padded range would spread the zoom across mostly-empty years,
// squeezing real bars into an unreadable sliver — the opposite of
// what Fit All is for. The full padded grid still exists and is
// reachable by scrolling left manually; this only controls what Fit
// All optimizes for and where it lands you.
function fitAll() {
  const scrollEl = $('ganttBodyWrap');
  if (!scrollEl || !GANTT_TIMELINE) return;
  const availableWidth = Math.max(scrollEl.clientWidth - GANTT_LABEL_WIDTH, 100);

  const realEarliest  = findEarliestProject();
  const realStartIdx  = realEarliest ? monthIndexOf(realEarliest.slice(0, 7)) : -1;
  const todayIdx      = monthIndexOf(todayStr().slice(0, 7));
  const hasRealRange  = realStartIdx !== -1 && todayIdx !== -1 && todayIdx >= realStartIdx;

  const monthCount = hasRealRange
    ? Math.max(todayIdx - realStartIdx + 1, 1)
    : Math.max(GANTT_TIMELINE.months.length, 1); // fallback: no detectable project data at all

  const idealWidth = Math.floor(availableWidth / monthCount);
  GANTT_MONTH_WIDTH = Math.max(GANTT_MONTH_WIDTH_FIT_MIN, Math.min(GANTT_MONTH_WIDTH_MAX, idealWidth));
  renderTimeline();

  // A bigger zoom alone doesn't fix the wasted-space problem if the
  // view is still sitting at the empty start of the grid — bring the
  // real data into view too, so Fit All actually lands you looking
  // at your projects instead of blank years.
  if (hasRealRange) {
    requestAnimationFrame(() => {
      const scroller = $('ganttScroll');
      if (scroller) scroller.scrollLeft = Math.max(realStartIdx * GANTT_MONTH_WIDTH - 20, 0);
    });
  }
}

function scrollToToday() {
  const scroller = $('ganttScroll');
  if (!scroller || !GANTT_TIMELINE) return;
  const idx = monthIndexOf(todayStr().slice(0, 7));
  if (idx === -1) return;
  const targetLeft = idx * GANTT_MONTH_WIDTH - (scroller.clientWidth - GANTT_LABEL_WIDTH) / 2;
  requestAnimationFrame(() => { scroller.scrollLeft = Math.max(targetLeft, 0); });
}

// Click-and-drag panning + mouse-wheel-as-horizontal-scroll. Bound
// fresh on every renderTimeline() call since #ganttScroll is rebuilt
// each time; harmless to rebind, no listeners accumulate since the
// old element (and its listeners) is discarded with it.
function wireGanttPanAndWheel() {
  const scroller = $('ganttScroll');
  if (!scroller) return;

  let isDragging = false, startX = 0, startY = 0, startScrollLeft = 0, startScrollTop = 0;

  scroller.addEventListener('mousedown', e => {
    if (e.target.closest('.gantt-bar') || e.target.closest('select')) return; // don't hijack bar clicks or filter dropdowns
    isDragging = true;
    startX = e.clientX; startY = e.clientY;
    startScrollLeft = scroller.scrollLeft; startScrollTop = scroller.scrollTop;
    scroller.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    requestAnimationFrame(() => {
      scroller.scrollLeft = startScrollLeft - (e.clientX - startX);
      scroller.scrollTop  = startScrollTop  - (e.clientY - startY);
    });
  });
  window.addEventListener('mouseup', () => { isDragging = false; scroller.style.cursor = ''; });

  scroller.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      scroller.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
}