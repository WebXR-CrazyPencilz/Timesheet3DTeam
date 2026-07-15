// ═══════════════════════════════════════════════════
// CHART.JS — Hours by Project pie chart
//
// Reads from the same ENTRIES array used by table.js / stats.
// Three ranges: Today / This Week / This Month.
// Pure SVG, no external library, uses existing CSS tokens.
// ═══════════════════════════════════════════════════

let CHART_RANGE = 'today';

const CHART_PALETTE = [
  '#4f8ef7', '#7c5cfc', '#34d399', '#fbbf24',
  '#f87171', '#22d3ee', '#fb923c', '#a78bfa',
  '#f472b6', '#84cc16',
];

// ── INIT ──────────────────────────────────────────
function initChart() {
  const rangeBox = $('chartRange');
  if (!rangeBox) return;
  rangeBox.addEventListener('click', e => {
    const btn = e.target.closest('.rbtn');
    if (!btn) return;
    CHART_RANGE = btn.dataset.range;
    rangeBox.querySelectorAll('.rbtn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    refreshChart();
  });
}

// ── DATE RANGE FILTER ─────────────────────────────
function getChartEntries() {
  const tod = todayStr();
  const ws  = weekStart();
  const mo  = todayStr().slice(0, 7);

  return (ENTRIES || []).filter(e => {
    if (e.status === 'Leave') return false;
    if (CHART_RANGE === 'today') return e.date === tod;
    if (CHART_RANGE === 'week')  return e.date >= ws;
    if (CHART_RANGE === 'month') return e.date.startsWith(mo);
    return false;
  });
}

// ── AGGREGATE BY PROJECT ───────────────────────────
function aggregateByProject(entries) {
  const map = {};
  entries.forEach(e => {
    const key = e.project || 'Unassigned';
    if (!map[key]) map[key] = 0;
    map[key] += Number(e.hours || 0);
  });
  return Object.entries(map)
    .map(([name, hours]) => ({ name, hours }))
    .filter(d => d.hours > 0)
    .sort((a, b) => b.hours - a.hours);
}

// ── REFRESH / RENDER ───────────────────────────────
function refreshChart() {
  const body = $('chartBody');
  if (!body) return;

  const entries = getChartEntries();
  const data    = aggregateByProject(entries);
  const total   = data.reduce((s, d) => s + d.hours, 0);

  if (!data.length) {
    body.innerHTML = `
      <div class="chart-empty">No hours logged ${rangeLabel()} yet.</div>
      ${buildLast5DaysSection()}
    `;
    wireChartDatePicker();
    return;
  }

  const svg    = buildPieSVG(data, total);
  const legend = buildLegend(data, total);

  body.innerHTML = `
    <div class="chart-svg-wrap">
      ${svg}
      <div class="chart-center">
        <div class="chart-center-val">${fmtHours(total)}</div>
        <div class="chart-center-lbl">${rangeLabel()}</div>
      </div>
    </div>
    <div class="chart-legend">${legend}</div>
    ${buildLast5DaysSection()}
  `;
  wireChartDatePicker();
}

function wireChartDatePicker() {
  const picker = $('chartDatePicker');
  if (!picker) return;
  picker.addEventListener('change', () => onChartDatePicked(picker.value));
}

function rangeLabel() {
  return CHART_RANGE === 'today' ? 'Today'
       : CHART_RANGE === 'week'  ? 'This Week'
       : 'This Month';
}

function fmtHours(h) {
  if (!h || h <= 0) return '0h';
  const totalMins = Math.round(h * 60);
  const hrs  = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs === 0)  return mins + 'm';
  if (mins === 0) return hrs + 'h';
  return hrs + 'h ' + mins + 'm';
}

// ══════════════════════════════════════════════════
// LAST 5 DAYS — per-day worked duration, plus a segmented bar (same
// visual language as the "Team Hours" bar on Project cards) showing
// which projects made up that day, colored per project. A date
// picker lets you look up any specific day, not just the default 5.
//
// ENTRIES only holds the 10 most recent active dates (Code.gs's
// getHistory scopes it that way) — the default 5-day view is always
// inside that window, so it's instant. A custom picked date OUTSIDE
// that window triggers one on-demand fetch of the employee's full
// history (apiGetAllHistory), cached after the first lookup so
// picking around doesn't refetch every time.
// ══════════════════════════════════════════════════
let CHART_ALL_HISTORY_CACHE = null;

function buildDaySegmentBar(projects, totalHours) {
  if (!projects.length) {
    return `<div style="font-size:11px;color:var(--muted);padding:2px 2px 0;">No entries</div>`;
  }
  const segments = projects.map(([proj, hrs], i) => {
    const pct = Math.max((hrs / totalHours) * 100, 2);
    return `<div style="width:${pct}%;height:100%;background:${CHART_PALETTE[i % CHART_PALETTE.length]};"
      title="${esc(proj)}: ${fmtHours(hrs)}"></div>`;
  }).join('');

  const legend = projects.map(([proj, hrs], i) => `
    <div style="display:flex;align-items:center;gap:5px;">
      <span style="width:7px;height:7px;border-radius:50%;background:${CHART_PALETTE[i % CHART_PALETTE.length]};flex-shrink:0;"></span>
      <span style="font-size:10.5px;color:var(--txt1);font-weight:600;max-width:120px;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;" title="${esc(proj)}">${esc(proj)}</span>
      <span style="font-size:10.5px;color:var(--muted);">${fmtHours(hrs)}</span>
    </div>`).join('');

  return `
    <div style="display:flex;border-radius:6px;overflow:hidden;height:12px;margin-bottom:6px;">${segments}</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px 12px;">${legend}</div>`;
}

function buildDayRow(dateStr, label, dayEntries) {
  const totalHours = dayEntries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
  const projMap = {};
  dayEntries.forEach(e => {
    if (!e.project) return;
    projMap[e.project] = (projMap[e.project] || 0) + (Number(e.hours) || 0);
  });
  const projects = Object.entries(projMap).sort((a, b) => b[1] - a[1]);

  return `
    <div style="padding:8px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <span style="font-size:12px;color:var(--txt1);font-weight:600;">${label}</span>
        <span style="font-size:12px;color:var(--a1);font-weight:700;">${totalHours > 0 ? fmtHours(totalHours) : '—'}</span>
      </div>
      ${buildDaySegmentBar(projects, totalHours)}
    </div>`;
}

function buildLast5DaysRows() {
  const days = [];
  for (let i = 1; i <= 5; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days.map(dateStr => {
    const dayEntries = (ENTRIES || []).filter(e => e.date === dateStr && e.status !== 'Leave');
    const label = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    return buildDayRow(dateStr, label, dayEntries);
  }).join('');
}

function buildLast5DaysSection() {
  return `
    <div style="margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--border);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px;">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Last 5 Days</div>
        <input type="date" id="chartDatePicker" max="${todayStr()}"
          style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;
          color:var(--txt1);font-size:10.5px;padding:3px 6px;cursor:pointer;"/>
      </div>
      <div id="chartLast5List">${buildLast5DaysRows()}</div>
    </div>`;
}

// Looks up one specific date's entries — from ENTRIES if it's within
// the already-loaded 10-day window, otherwise fetches (and caches)
// the employee's full history once.
async function getDayEntriesForChart(dateStr) {
  const inRecentWindow = (ENTRIES || []).some(e => e.date === dateStr);
  if (inRecentWindow && !CHART_ALL_HISTORY_CACHE) {
    return (ENTRIES || []).filter(e => e.date === dateStr && e.status !== 'Leave');
  }
  if (!CHART_ALL_HISTORY_CACHE) {
    try { CHART_ALL_HISTORY_CACHE = await apiGetAllHistory(USER.id); }
    catch(e) { CHART_ALL_HISTORY_CACHE = []; }
  }
  return CHART_ALL_HISTORY_CACHE.filter(e => e.date === dateStr && e.status !== 'Leave');
}

async function onChartDatePicked(dateStr) {
  const listEl = $('chartLast5List');
  if (!listEl || !dateStr) return;

  listEl.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:10px 0;">Loading…</div>`;
  const dayEntries = await getDayEntriesForChart(dateStr);
  const label = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

  listEl.innerHTML = `
    ${buildDayRow(dateStr, label, dayEntries)}
    <button id="chartDateReset" style="margin-top:8px;background:none;border:none;color:var(--a1);
      font-size:10.5px;font-weight:600;cursor:pointer;padding:0;">← Back to Last 5 Days</button>`;

  $('chartDateReset')?.addEventListener('click', () => {
    const picker = $('chartDatePicker');
    if (picker) picker.value = '';
    listEl.innerHTML = buildLast5DaysRows();
  });
}

// ── BUILD SVG DONUT ────────────────────────────────
function buildPieSVG(data, total) {
  const cx = 85, cy = 85, r = 70, innerR = 44;
  let angleStart = -90; // start at top

  const slices = data.map((d, i) => {
    const pct      = d.hours / total;
    const angleEnd = angleStart + pct * 360;
    const path     = donutSlicePath(cx, cy, r, innerR, angleStart, angleEnd);
    const color    = CHART_PALETTE[i % CHART_PALETTE.length];
    angleStart = angleEnd;
    return `<path class="chart-slice" d="${path}" fill="${color}">
      <title>${escSvg(d.name)}: ${fmtHours(d.hours)}</title>
    </path>`;
  }).join('');

  return `<svg viewBox="0 0 170 170" xmlns="http://www.w3.org/2000/svg">${slices}</svg>`;
}

// Build an SVG path for one donut slice between two angles (degrees)
function donutSlicePath(cx, cy, rOuter, rInner, startDeg, endDeg) {
  // Avoid a 360-degree slice rendering as nothing — clamp slightly
  const span = endDeg - startDeg;
  if (span >= 359.999) endDeg = startDeg + 359.999;

  const sOuter = polarPoint(cx, cy, rOuter, startDeg);
  const eOuter = polarPoint(cx, cy, rOuter, endDeg);
  const sInner = polarPoint(cx, cy, rInner, endDeg);
  const eInner = polarPoint(cx, cy, rInner, startDeg);
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
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// ── BUILD LEGEND ───────────────────────────────────
function buildLegend(data, total) {
  return data.map((d, i) => {
    const color = CHART_PALETTE[i % CHART_PALETTE.length];
    const pct   = Math.round((d.hours / total) * 100);
    return `<div class="leg-row">
      <span class="leg-dot" style="background:${color}"></span>
      <span class="leg-name" title="${esc(d.name)}">${esc(d.name)}</span>
      <span class="leg-hrs">${fmtHours(d.hours)}</span>
      <span class="leg-pct">${pct}%</span>
    </div>`;
  }).join('');
}

function escSvg(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}