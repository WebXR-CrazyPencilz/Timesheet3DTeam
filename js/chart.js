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
    body.innerHTML = `<div class="chart-empty">No hours logged ${rangeLabel()} yet.</div>`;
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
  `;
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