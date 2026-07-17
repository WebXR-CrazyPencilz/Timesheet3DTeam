// ═══════════════════════════════════════════════════
// HISTORICAL-IMPORT.JS — "Historical Import" tab, Team Leader only.
//
// Manual register-entry workflow — NOT a file upload. A Team Leader
// picks Client + Project + a month range, gets one page with a
// collapsible section per month, and types Employee/Total Hours
// rows directly (employee picked from a dropdown, hours typed as
// HH:MM). No Excel, no template, no file parsing anywhere in here.
//
// Completely isolated from the existing daily timesheet system: its
// own backend sheet ('HistoricalTimesheet' in Code.gs), its own
// actions. Never touches saveEntry, saveSlot, getHistory, Force
// Entry, Force Leave, or the Employees timesheet tabs. Only ever
// stores ONE total-hours number per employee per month per project —
// no daily entries, time in/out, tasks, or notes are ever generated
// from this.
//
// Deliberately NOT built here (same as before): wiring these
// imported hours into the existing Manager/TL dashboard totals,
// Project/Client cards, or reports — that's a distinct, later
// integration step once this entry workflow itself is settled.
// ═══════════════════════════════════════════════════

const HIST_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// The currently open register, or null while on the landing screen.
// { clientId, clientName, projectId, projectName, isFinal,
//   months: [ { month, year, collapsed, records: [{employeeId, employeeName, hours, remarks}] } ] }
let HIST_CURRENT = null;

// ── TAB ENTRY POINT (called from teamleader.js's tab router) ─────
function renderHistoricalImportTab(content) {
  if (typeof TL_MODE === 'undefined' || !TL_MODE) {
    content.innerHTML = `<div class="chart-empty">Historical Import is only available to Team Leaders.</div>`;
    return;
  }
  if (typeof ensureCPStyles === 'function') ensureCPStyles(); // reuses client-project.js's .cp-card/.cp-form-* styles

  HIST_CURRENT = null;
  renderHistoricalLanding(content);
}

// ══════════════════════════════════════════════════
// LANDING SCREEN — start a new register, or resume/search existing ones
// ══════════════════════════════════════════════════
function renderHistoricalLanding(content) {
  content.innerHTML = `
    <div style="font-weight:700;font-size:16px;color:var(--txt1);margin-bottom:.2rem;">📜 Historical Timesheet Import</div>
    <div style="font-size:12px;color:var(--txt2);margin-bottom:1.25rem;">
      Enter old monthly total hours from before this system existed — a quick register, not a file import.
      Only one total-hours number per employee per month is stored; no daily entries are ever created.
    </div>

    <div class="cp-card" style="margin-bottom:1.25rem;max-width:640px;">
      <div style="font-weight:700;font-size:13px;color:var(--txt1);margin-bottom:.9rem;">Start a New Register</div>
      <div class="cp-form-grid">
        <div class="cp-form-field">
          <label class="cp-flabel">Client</label>
          <select class="cp-finput" id="histNewClient">
            <option value="">— Select client —</option>
            ${(TL_CLIENTS || []).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="cp-form-field">
          <label class="cp-flabel">Project</label>
          <select class="cp-finput" id="histNewProject" disabled>
            <option value="">— Select client first —</option>
          </select>
        </div>
        <div class="cp-form-field">
          <label class="cp-flabel">Start Month</label>
          <input class="cp-finput" type="month" id="histNewStart"/>
        </div>
        <div class="cp-form-field">
          <label class="cp-flabel">End Month</label>
          <input class="cp-finput" type="month" id="histNewEnd"/>
        </div>
      </div>
      <button id="histCreateBtn" class="cp-btn-primary" style="margin-top:.4rem;">Create Historical Sheet →</button>
    </div>

    <div class="cp-card" style="margin-bottom:1.25rem;">
      <div style="font-weight:700;font-size:13px;color:var(--txt1);margin-bottom:.9rem;">Continue an Existing Register</div>
      <div id="histExistingList"><div style="font-size:12px;color:var(--txt2);">Loading…</div></div>
    </div>

    <div class="cp-card">
      <div style="font-weight:700;font-size:13px;color:var(--txt1);margin-bottom:.9rem;">🔍 Search Historical Records</div>
      <div class="cp-form-grid">
        <div class="cp-form-field">
          <label class="cp-flabel">Month</label>
          <select class="cp-finput" id="histSearchMonth">
            <option value="">All months</option>
            ${HIST_MONTHS.map(m => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
        <div class="cp-form-field">
          <label class="cp-flabel">Client</label>
          <select class="cp-finput" id="histSearchClient">
            <option value="">All clients</option>
            ${(TL_CLIENTS || []).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="cp-form-field">
          <label class="cp-flabel">Employee</label>
          <select class="cp-finput" id="histSearchEmployee">
            <option value="">All employees</option>
            ${(TL_EMPLOYEES || []).map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <button id="histSearchBtn" class="cp-btn-ghost" style="margin-top:.8rem;">Search</button>
      <div id="histSearchResults" style="margin-top:1rem;"></div>
    </div>
  `;

  content.querySelector('#histNewClient').addEventListener('change', e => {
    const clientId = e.target.value;
    const projSel = content.querySelector('#histNewProject');
    const projects = (TL_PROJECTS || []).filter(p => p.cid === clientId);
    if (!clientId) {
      projSel.innerHTML = `<option value="">— Select client first —</option>`;
      projSel.disabled = true;
    } else {
      projSel.innerHTML = `<option value="">— Select project —</option>` +
        projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      projSel.disabled = false;
    }
  });

  content.querySelector('#histCreateBtn').addEventListener('click', createHistoricalSheet);
  content.querySelector('#histSearchBtn').addEventListener('click', runHistoricalSearch);

  loadHistoricalExistingList();
}

async function loadHistoricalExistingList() {
  const el = $('histExistingList');
  if (!el) return;
  try {
    const projects = await sheetGET({ action: 'getHistoricalProjectsSummary' });
    if (!projects.length) {
      el.innerHTML = `<div style="font-size:12px;color:var(--txt2);">No historical registers started yet.</div>`;
      return;
    }
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
        <thead><tr style="background:var(--surface2);">
          <th style="text-align:left;padding:6px 9px;border:1px solid var(--border);">Client → Project</th>
          <th style="text-align:right;padding:6px 9px;border:1px solid var(--border);">Months</th>
          <th style="text-align:right;padding:6px 9px;border:1px solid var(--border);">Employees</th>
          <th style="text-align:right;padding:6px 9px;border:1px solid var(--border);">Total Hours</th>
          <th style="text-align:left;padding:6px 9px;border:1px solid var(--border);">Status</th>
          <th style="padding:6px 9px;border:1px solid var(--border);"></th>
        </tr></thead>
        <tbody>
          ${projects.map(p => `
            <tr>
              <td style="padding:6px 9px;border:1px solid var(--border);color:var(--txt1);">${esc(p.clientName)} → ${esc(p.projectName)}</td>
              <td style="padding:6px 9px;border:1px solid var(--border);text-align:right;color:var(--txt1);">${p.monthCount}</td>
              <td style="padding:6px 9px;border:1px solid var(--border);text-align:right;color:var(--txt1);">${p.employeeCount}</td>
              <td style="padding:6px 9px;border:1px solid var(--border);text-align:right;color:var(--a1);font-weight:600;">${esc(fmtHistHours(p.totalHours))}</td>
              <td style="padding:6px 9px;border:1px solid var(--border);">
                ${p.isFinal
                  ? `<span style="background:rgba(52,211,153,.12);color:#34d399;border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;">Final</span>`
                  : `<span style="background:rgba(251,191,36,.12);color:#fbbf24;border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;">Draft</span>`}
              </td>
              <td style="padding:6px 9px;border:1px solid var(--border);text-align:center;">
                <button class="hist-resume-btn" data-client-id="${esc(p.clientId)}" data-project-id="${esc(p.projectId)}"
                  style="background:var(--a1);color:#fff;border:none;border-radius:6px;padding:5px 12px;
                  font-size:10.5px;font-weight:700;cursor:pointer;">Open →</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('.hist-resume-btn').forEach(btn => {
      btn.addEventListener('click', () => resumeHistoricalSheet(btn.dataset.clientId, btn.dataset.projectId));
    });
  } catch (err) {
    el.innerHTML = `<div class="slot-error">Failed to load: ${esc(err.message)}</div>`;
  }
}

async function runHistoricalSearch() {
  const resultsEl = $('histSearchResults');
  if (!resultsEl) return;
  resultsEl.innerHTML = `<div style="font-size:12px;color:var(--txt2);">Searching…</div>`;

  const filters = {
    month:      $('histSearchMonth')?.value || '',
    clientId:   $('histSearchClient')?.value || '',
    employeeId: $('histSearchEmployee')?.value || '',
  };

  try {
    const records = await sheetGET({ action: 'getHistoricalRecords', filters: encodeURIComponent(JSON.stringify(filters)) });
    if (!records.length) {
      resultsEl.innerHTML = `<div style="font-size:12px;color:var(--txt2);">No matching records.</div>`;
      return;
    }
    resultsEl.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
        <thead><tr style="background:var(--surface2);">
          <th style="text-align:left;padding:6px 9px;border:1px solid var(--border);">Month</th>
          <th style="text-align:left;padding:6px 9px;border:1px solid var(--border);">Employee</th>
          <th style="text-align:left;padding:6px 9px;border:1px solid var(--border);">Project</th>
          <th style="text-align:right;padding:6px 9px;border:1px solid var(--border);">Hours</th>
        </tr></thead>
        <tbody>
          ${records.map(r => `
            <tr>
              <td style="padding:6px 9px;border:1px solid var(--border);color:var(--txt1);">${esc(r.month)} ${esc(r.year)}</td>
              <td style="padding:6px 9px;border:1px solid var(--border);color:var(--txt1);">${esc(r.employeeName)}</td>
              <td style="padding:6px 9px;border:1px solid var(--border);color:var(--txt1);">${esc(r.projectName)}</td>
              <td style="padding:6px 9px;border:1px solid var(--border);text-align:right;color:var(--a1);font-weight:600;">${esc(fmtHistHours(r.totalHours))}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    resultsEl.innerHTML = `<div class="slot-error">Search failed: ${esc(err.message)}</div>`;
  }
}

// ── BUILD MONTH RANGE from two <input type="month"> values ────────
function buildHistMonthRange(startVal, endVal) {
  const [sy, sm] = startVal.split('-').map(Number);
  const [ey, em] = endVal.split('-').map(Number);
  const months = [];
  let y = sy, m = sm;
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 120) {
    months.push({ month: HIST_MONTHS[m - 1], year: String(y), collapsed: false, records: [] });
    m++; if (m > 12) { m = 1; y++; }
    guard++;
  }
  return months;
}

// ── CREATE / RESUME ────────────────────────────────
async function createHistoricalSheet() {
  const clientId  = $('histNewClient')?.value;
  const projectId = $('histNewProject')?.value;
  const startVal  = $('histNewStart')?.value;
  const endVal    = $('histNewEnd')?.value;

  if (!clientId || !projectId) { toast?.('e', 'Select a Client and Project'); return; }
  if (!startVal || !endVal)    { toast?.('e', 'Select a Start Month and End Month'); return; }
  if (endVal < startVal)       { toast?.('e', 'End Month must be on or after Start Month'); return; }

  const client  = (TL_CLIENTS || []).find(c => c.id === clientId);
  const project = (TL_PROJECTS || []).find(p => p.id === projectId);

  const btn = $('histCreateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  try {
    // Pull in anything already saved for this project, so re-creating
    // a sheet over an existing range doesn't wipe prior work.
    const existing = await sheetGET({ action: 'getHistoricalSheetData', clientId, projectId });
    const wantedRange = buildHistMonthRange(startVal, endVal);

    const months = wantedRange.map(wm => {
      const found = existing.months.find(em => em.month === wm.month && em.year === wm.year);
      return found
        ? { month: wm.month, year: wm.year, collapsed: false, records: found.records.map(r => ({ ...r })) }
        : wm;
    });

    HIST_CURRENT = {
      clientId, clientName: client?.name || '',
      projectId, projectName: project?.name || '',
      isFinal: existing.isFinal,
      months,
    };

    renderHistoricalRegister($('tlTabContent'));
  } catch (err) {
    toast?.('e', 'Failed to create sheet', err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create Historical Sheet →'; }
  }
}

async function resumeHistoricalSheet(clientId, projectId) {
  const content = $('tlTabContent');
  content.innerHTML = `<div class="slot-loading"><div class="slot-spinner"></div><span>Loading…</span></div>`;

  try {
    const client  = (TL_CLIENTS || []).find(c => c.id === clientId);
    const project = (TL_PROJECTS || []).find(p => p.id === projectId);
    const existing = await sheetGET({ action: 'getHistoricalSheetData', clientId, projectId });

    if (!existing.months.length) {
      toast?.('e', 'No data found for this project');
      renderHistoricalLanding(content);
      return;
    }

    HIST_CURRENT = {
      clientId, clientName: client?.name || '',
      projectId, projectName: project?.name || '',
      isFinal: existing.isFinal,
      months: existing.months
        .slice()
        .sort((a, b) => (a.year + a.month).localeCompare(b.year + b.month))
        .map(m => ({ ...m, collapsed: false })),
    };

    renderHistoricalRegister(content);
  } catch (err) {
    toast?.('e', 'Failed to load', err.message);
    renderHistoricalLanding(content);
  }
}

// ══════════════════════════════════════════════════
// REGISTER SCREEN (Step 2) — one collapsible section per month
// ══════════════════════════════════════════════════
function renderHistoricalRegister(content) {
  if (!HIST_CURRENT) { renderHistoricalLanding(content); return; }
  const c = HIST_CURRENT;

  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:10px;">
      <div>
        <button id="histBackBtn" class="cp-back-btn" style="margin-bottom:6px;">← Back</button>
        <div style="font-weight:800;font-size:17px;color:var(--txt1);">${esc(c.clientName)} → ${esc(c.projectName)}</div>
        <div style="font-size:11.5px;color:var(--txt2);">
          ${c.isFinal
            ? `<span style="color:#34d399;font-weight:700;">✓ Finalized</span> — locked from further edits`
            : 'Draft — editable'}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${c.isFinal
          ? `<button id="histReopenBtn" class="cp-btn-ghost">🔓 Reopen for Editing</button>`
          : `<button id="histSaveDraftBtn" class="cp-btn-ghost">💾 Save Draft (all months)</button>
             <button id="histFinalSubmitBtn" class="cp-btn-primary" style="background:#34d399;">✓ Final Submit</button>`}
      </div>
    </div>

    <div id="histMonthsContainer"></div>
  `;

  content.querySelector('#histBackBtn').addEventListener('click', () => {
    HIST_CURRENT = null;
    renderHistoricalLanding(content);
  });
  content.querySelector('#histSaveDraftBtn')?.addEventListener('click', saveHistoricalDraftAll);
  content.querySelector('#histFinalSubmitBtn')?.addEventListener('click', finalSubmitHistoricalProject);
  content.querySelector('#histReopenBtn')?.addEventListener('click', reopenHistoricalProject);

  renderHistoricalMonths();
}

function renderHistoricalMonths() {
  const container = $('histMonthsContainer');
  if (!container || !HIST_CURRENT) return;

  container.innerHTML = HIST_CURRENT.months.map((m, i) => buildHistMonthCard(m, i)).join('');

  HIST_CURRENT.months.forEach((m, i) => wireHistMonthCard(i));
}

function buildHistMonthCard(m, index) {
  const totalHours = m.records.reduce((s, r) => s + (Number(r.hours) || 0), 0);
  const locked = HIST_CURRENT.isFinal;

  return `
    <details class="cp-card" style="margin-bottom:1rem;padding:0;" ${m.collapsed ? '' : 'open'} data-month-index="${index}">
      <summary style="cursor:pointer;list-style:none;padding:1rem 1.2rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-weight:700;font-size:14px;color:var(--txt1);">${esc(m.month)} ${esc(m.year)}</span>
          <span style="font-size:11px;color:var(--txt2);">${m.records.length} Employee${m.records.length !== 1 ? 's' : ''}</span>
          <span style="font-size:11px;color:var(--a1);font-weight:700;">${esc(fmtHistHours(totalHours))}</span>
        </div>
        ${!locked ? `<button class="hist-save-month-btn" data-month-index="${index}"
          style="background:var(--a1);color:#fff;border:none;border-radius:6px;padding:6px 14px;
          font-size:11px;font-weight:700;cursor:pointer;" onclick="event.preventDefault(); saveHistoricalMonth(${index});">💾 Save Month</button>` : ''}
      </summary>
      <div style="padding:0 1.2rem 1.2rem;">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:.8rem;">
          <thead><tr style="border-bottom:1px solid var(--border);">
            <th style="text-align:left;padding:6px 4px;color:var(--txt2);font-size:10.5px;text-transform:uppercase;">Employee</th>
            <th style="text-align:left;padding:6px 4px;color:var(--txt2);font-size:10.5px;text-transform:uppercase;width:140px;">Total Hours</th>
            <th style="width:40px;"></th>
          </tr></thead>
          <tbody id="histMonthRows-${index}">
            ${m.records.map((r, ri) => buildHistEmployeeRow(index, ri, r, locked)).join('')}
          </tbody>
        </table>
        ${!locked ? `<button class="hist-add-emp-btn" data-month-index="${index}"
          style="background:none;border:1px dashed var(--border-md);color:var(--a1);border-radius:8px;
          padding:7px 16px;font-size:11.5px;font-weight:600;cursor:pointer;width:100%;">+ Add Employee</button>` : ''}
      </div>
    </details>`;
}

function buildHistEmployeeRow(monthIndex, rowIndex, rec, locked) {
  const employees = TL_EMPLOYEES || [];
  return `
    <tr data-row-index="${rowIndex}">
      <td style="padding:5px 4px;">
        <select class="cp-finput hist-emp-select" data-month-index="${monthIndex}" data-row-index="${rowIndex}" ${locked ? 'disabled' : ''} style="font-size:12.5px;padding:6px 8px;">
          <option value="">— Employee —</option>
          ${employees.map(e => `<option value="${esc(e.id)}" ${e.id === rec.employeeId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
        </select>
      </td>
      <td style="padding:5px 4px;">
        <input class="cp-finput hist-hours-input" data-month-index="${monthIndex}" data-row-index="${rowIndex}"
          type="text" placeholder="HH:MM e.g. 81:05" value="${esc(fmtHistHoursColon(rec.hours))}" ${locked ? 'disabled' : ''}
          style="font-size:12.5px;padding:6px 8px;"/>
      </td>
      <td style="padding:5px 4px;text-align:center;">
        ${!locked ? `<button class="hist-del-row-btn" data-month-index="${monthIndex}" data-row-index="${rowIndex}"
          style="background:none;border:none;color:#f87171;cursor:pointer;font-size:15px;padding:2px 6px;" title="Delete row">🗑</button>` : ''}
      </td>
    </tr>`;
}

function fmtHistHoursColon(h) {
  if (h === undefined || h === null || h === '') return '';
  const totalMins = Math.round(Number(h) * 60);
  const hrs = Math.floor(totalMins / 60), mins = totalMins % 60;
  return hrs + ':' + String(mins).padStart(2, '0');
}

function wireHistMonthCard(index) {
  const container = $('histMonthsContainer');
  if (!container) return;

  container.querySelectorAll(`.hist-emp-select[data-month-index="${index}"]`).forEach(sel => {
    sel.addEventListener('change', e => {
      const ri = parseInt(e.target.dataset.rowIndex, 10);
      const emp = (TL_EMPLOYEES || []).find(x => x.id === e.target.value);
      HIST_CURRENT.months[index].records[ri].employeeId   = e.target.value;
      HIST_CURRENT.months[index].records[ri].employeeName = emp ? emp.name : '';
    });
  });

  container.querySelectorAll(`.hist-hours-input[data-month-index="${index}"]`).forEach(inp => {
    inp.addEventListener('input', e => {
      const ri = parseInt(e.target.dataset.rowIndex, 10);
      HIST_CURRENT.months[index].records[ri].hoursRaw = e.target.value;
    });
  });

  container.querySelectorAll(`.hist-del-row-btn[data-month-index="${index}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const ri = parseInt(btn.dataset.rowIndex, 10);
      HIST_CURRENT.months[index].records.splice(ri, 1);
      rerenderHistMonth(index);
    });
  });

  const addBtn = container.querySelector(`.hist-add-emp-btn[data-month-index="${index}"]`);
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      HIST_CURRENT.months[index].records.push({ employeeId: '', employeeName: '', hours: 0, remarks: '' });
      rerenderHistMonth(index);
    });
  }
}

function rerenderHistMonth(index) {
  const container = $('histMonthsContainer');
  const details = container.querySelector(`details[data-month-index="${index}"]`);
  const wasOpen = details ? details.open : true;
  const html = buildHistMonthCard(HIST_CURRENT.months[index], index);
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const newEl = temp.firstElementChild;
  newEl.open = wasOpen;
  details.replaceWith(newEl);
  wireHistMonthCard(index);
}

// ── VALIDATION (client-side, quick feedback before hitting the
// server — the server re-validates everything regardless) ────────
function validateHistMonthClientSide(monthIndex) {
  const m = HIST_CURRENT.months[monthIndex];
  const errors = [];
  const seen = {};

  m.records.forEach((r, i) => {
    const rowLabel = 'Row ' + (i + 1);
    if (!r.employeeId) { errors.push(rowLabel + ': select an employee.'); return; }
    if (seen[r.employeeId]) { errors.push(rowLabel + ': ' + r.employeeName + ' is already in this month.'); return; }
    seen[r.employeeId] = true;

    const raw = r.hoursRaw !== undefined ? r.hoursRaw : fmtHistHoursColon(r.hours);
    if (!/^\d+:[0-5]?\d$/.test(String(raw).trim())) {
      errors.push(rowLabel + ': hours must be HH:MM, e.g. 81:05.');
    }
  });

  return errors;
}

function histColonToDecimal(raw) {
  const m = /^(\d+):([0-5]?\d)$/.exec(String(raw).trim());
  if (!m) return null;
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
}

// ── SAVE ONE MONTH ─────────────────────────────────
async function saveHistoricalMonth(monthIndex) {
  const m = HIST_CURRENT.months[monthIndex];
  const errors = validateHistMonthClientSide(monthIndex);
  if (errors.length) {
    toast?.('e', 'Fix these before saving', errors.join(' '));
    return;
  }

  const records = m.records.map(r => ({
    employeeId: r.employeeId,
    hours: r.hoursRaw !== undefined ? histColonToDecimal(r.hoursRaw) : r.hours,
    remarks: r.remarks || '',
  }));

  try {
    await sheetGET({
      action: 'saveHistoricalMonth',
      data: encodeURIComponent(JSON.stringify({
        role: 'tl',
        importedByName: (typeof USER !== 'undefined' && USER?.name) || 'Team Leader',
        clientId: HIST_CURRENT.clientId, projectId: HIST_CURRENT.projectId,
        month: m.month, year: m.year, records,
      })),
    });
    toast?.('s', 'Saved', `${m.month} ${m.year} — ${records.length} record(s).`);
  } catch (err) {
    toast?.('e', 'Save failed', err.message);
  }
}

// ── SAVE DRAFT (all months) ────────────────────────
async function saveHistoricalDraftAll() {
  const allErrors = [];
  HIST_CURRENT.months.forEach((m, i) => {
    const errs = validateHistMonthClientSide(i);
    if (errs.length) allErrors.push(m.month + ' ' + m.year + ': ' + errs.join(' '));
  });
  if (allErrors.length) {
    toast?.('e', 'Fix these before saving', allErrors.join(' '));
    return;
  }

  const btn = $('histSaveDraftBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const months = HIST_CURRENT.months.map(m => ({
      month: m.month, year: m.year,
      records: m.records.map(r => ({
        employeeId: r.employeeId,
        hours: r.hoursRaw !== undefined ? histColonToDecimal(r.hoursRaw) : r.hours,
        remarks: r.remarks || '',
      })),
    }));

    await sheetGET({
      action: 'saveHistoricalDraft',
      data: encodeURIComponent(JSON.stringify({
        role: 'tl',
        importedByName: (typeof USER !== 'undefined' && USER?.name) || 'Team Leader',
        clientId: HIST_CURRENT.clientId, projectId: HIST_CURRENT.projectId,
        months,
      })),
    });
    toast?.('s', 'Draft saved', `${months.length} month(s) saved.`);
  } catch (err) {
    toast?.('e', 'Save failed', err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Draft (all months)'; }
  }
}

// ── FINAL SUBMIT ────────────────────────────────────
async function finalSubmitHistoricalProject() {
  if (!confirm('Final Submit locks every month for this project from further edits. Save any unsaved changes first — continue?')) return;

  const btn = $('histFinalSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Finalizing…'; }

  try {
    await sheetGET({
      action: 'finalizeHistoricalProject',
      data: encodeURIComponent(JSON.stringify({ role: 'tl', clientId: HIST_CURRENT.clientId, projectId: HIST_CURRENT.projectId })),
    });
    toast?.('s', 'Finalized', 'This project is now locked.');
    resumeHistoricalSheet(HIST_CURRENT.clientId, HIST_CURRENT.projectId);
  } catch (err) {
    toast?.('e', 'Finalize failed', err.message);
    if (btn) { btn.disabled = false; btn.textContent = '✓ Final Submit'; }
  }
}

async function reopenHistoricalProject() {
  if (!confirm('Reopen this project for editing?')) return;
  try {
    await sheetGET({
      action: 'reopenHistoricalProject',
      data: encodeURIComponent(JSON.stringify({ role: 'tl', clientId: HIST_CURRENT.clientId, projectId: HIST_CURRENT.projectId })),
    });
    toast?.('s', 'Reopened', 'This project is editable again.');
    resumeHistoricalSheet(HIST_CURRENT.clientId, HIST_CURRENT.projectId);
  } catch (err) {
    toast?.('e', 'Reopen failed', err.message);
  }
}

function fmtHistHours(h) {
  const totalMins = Math.round(Number(h) * 60);
  const hrs = Math.floor(totalMins / 60), mins = totalMins % 60;
  if (hrs === 0)  return mins + 'm';
  if (mins === 0) return hrs + 'h';
  return hrs + 'h ' + mins + 'm';
}