// ═══════════════════════════════════════════════════════════════
// FORCEENTRY.JS — Force Entry page (Manager / Team Leader only)
//
// Used only when an employee forgot to submit their timesheet.
// Mirrors form.js's UI/validation for Morning + Afternoon sessions
// (Extended Hours is intentionally not offered here), but is saved
// by a Manager/Team Leader on the employee's behalf, with a
// permanent audit trail (Entered By, Role, Reason, Manager Notes).
//
// This is a completely separate module:
//   • form.js is NOT modified.
//   • The employee portal is NOT affected.
//   • No existing API is changed — this reuses the same
//     apiSaveSlot() write path that form.js already uses.
//
// Access flow:
//   Manager Portal → Employee Detail → a "Not Logged" day →
//   "Force Entry" button → openForceEntry() (this file) →
//   Save Force Entry → back to Employee Detail.
// ═══════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────
let FE_EMP         = null;   // { id, name }
let FE_DATE        = '';     // YYYY-MM-DD — the Not Logged day being resolved
let FE_RETURN_TO   = null;   // callback invoked after a successful save (or Back)

const FE_MAX_ENTRIES_PER_SLOT = 4;
const FE_MIN_NOTES_LENGTH     = 25;

// Only Morning + Afternoon — Extended Hours is deliberately excluded
// from Force Entry per spec.
const FE_SLOT_META = {
  morning:   { label: 'Morning',   icon: '🌅', defaultIn: '09:30', defaultOut: '13:00', minTime: '08:30', maxTime: '13:00', displayMin: '09:30' },
  afternoon: { label: 'Afternoon', icon: '☀️',  defaultIn: '13:45', defaultOut: '19:30', minTime: '13:30', maxTime: '20:00', displayMin: '13:45' },
};

const FE_TASKS = ['Pre-Work','Modelling & Texturing','lighting & Rendering','Web Development','Editing & Greeding','Unreal Engine','Training R&D'];

// Who is entering this — Manager or Team Leader — derived from the
// same session globals auth.js already maintains. No new auth logic.
function getEnteredByInfo() {
  if (typeof MANAGER_MODE !== 'undefined' && MANAGER_MODE) {
    return { name: (typeof USER !== 'undefined' && USER?.name) || 'Manager', role: 'Manager' };
  }
  if (typeof TL_MODE !== 'undefined' && TL_MODE) {
    return { name: (typeof USER !== 'undefined' && USER?.name) || 'Team Leader', role: 'Team Leader' };
  }
  return { name: (typeof USER !== 'undefined' && USER?.name) || 'Manager', role: 'Manager' };
}

// ── OPEN PAGE ─────────────────────────────────────────────────
// empId/empName: the employee this entry is being logged for.
// dateStr: the Not Logged day being resolved.
// onDone: optional callback to return to (defaults to reopening Employee Detail).
function openForceEntry(empId, empName, dateStr, onDone) {
  FE_EMP       = { id: empId, name: empName };
  FE_DATE      = dateStr;
  FE_RETURN_TO = typeof onDone === 'function' ? onDone : null;

  // Shared with emp-detail.js: this page is used from both the
  // Manager and Team Leader portals, each with its own container.
  const container = (typeof TL_MODE !== 'undefined' && TL_MODE) ? $('tlApp') : $('mgrApp');
  if (!container) return;

  const enteredBy = getEnteredByInfo();
  const dateLabel = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN',
    { day: 'numeric', month: 'short', year: 'numeric' });

  container.innerHTML = `
    <div id="forceEntryPage" style="animation: feFadeIn .2s ease;">
      <!-- Back -->
      <div style="margin-bottom:1rem;">
        <button id="feBack" style="
          display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;
          border:1px solid var(--border-md);background:var(--elevated);
          color:var(--txt2);font-size:13px;font-weight:600;cursor:pointer;">← Back</button>
      </div>

      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:1.1rem;">
        <span style="font-size:22px;">🟣</span>
        <div>
          <div style="font-size:20px;font-weight:800;color:var(--txt1);">Force Entry</div>
          <div style="font-size:12px;color:var(--txt2);">Submitting a timesheet on behalf of an employee</div>
        </div>
      </div>

      <!-- Identity strip -->
      <div class="fe-info-grid">
        <div class="fe-info-item"><span>Employee</span><strong>${esc(empName)}</strong></div>
        <div class="fe-info-item"><span>Employee ID</span><strong>${esc(empId)}</strong></div>
        <div class="fe-info-item"><span>Date</span><strong>${dateLabel}</strong></div>
        <div class="fe-info-item"><span>Entered By</span><strong>${esc(enteredBy.role)}</strong></div>
      </div>

      <!-- Morning / Afternoon sessions -->
      <div id="feSlotsContainer"></div>

      <!-- Force Entry Information (audit fields) -->
      <div class="fe-audit-block">
        <div class="fe-audit-title">🛠 Force Entry Information</div>

        <div class="fg">
          <label class="flabel">Entered By</label>
          <input class="fc" id="feEnteredByName" value="${esc(enteredBy.name)}" readonly />
        </div>
        <div class="fg" style="margin-top:.6rem;">
          <label class="flabel">Role</label>
          <input class="fc" id="feEnteredByRole" value="${esc(enteredBy.role)}" readonly />
        </div>
        <div class="fg" style="margin-top:.6rem;">
          <label class="flabel">Reason <span class="req">*</span></label>
          <textarea class="fc ta" id="feReason" rows="2" maxlength="200"
            placeholder="Why is this being entered manually? e.g. Employee forgot to submit timesheet."></textarea>
        </div>
        <div class="fg" style="margin-top:.6rem;">
          <label class="flabel">Manager Notes <span class="req">*</span></label>
          <textarea class="fc ta" id="feManagerNotes" rows="2" maxlength="300"
            placeholder="Any additional context for the audit trail…"></textarea>
        </div>
      </div>

      <!-- Save -->
      <div style="display:flex;justify-content:flex-end;margin-top:1rem;">
        <button class="btn bpri save-btn" id="feSaveAllBtn" onclick="saveForceEntryAll()">
          <span class="bl">Save Force Entry</span>
          <svg class="bi" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          <div class="bspin"></div>
        </button>
      </div>
    </div>

    <style>
      @keyframes feFadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:none} }
      .fe-info-grid { display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;margin-bottom:1.1rem; }
      .fe-info-item {
        background:var(--surface1);border:1px solid var(--border);border-radius:10px;
        padding:.7rem .9rem;display:flex;flex-direction:column;gap:2px;
      }
      .fe-info-item span { font-size:10px;color:var(--txt2);text-transform:uppercase;letter-spacing:.05em; }
      .fe-info-item strong { font-size:13.5px;color:var(--txt1); }
      .fe-audit-block {
        background:var(--surface1);border:1px solid rgba(167,139,250,0.35);
        border-radius:12px;padding:1.1rem;margin-top:1.1rem;
      }
      .fe-audit-title { font-weight:700;font-size:14px;color:#a78bfa;margin-bottom:.6rem; }
      .fe-audit-block input[readonly] { opacity:.75;cursor:default; }
      #feBack:hover { color:var(--txt1);background:var(--hover); }
    </style>
  `;

  $('feBack').addEventListener('click', () => {
    if (FE_RETURN_TO) FE_RETURN_TO();
    else if (typeof openEmpDetail === 'function') openEmpDetail(empId, empName);
  });

  renderForceEntrySlots();
}

// ── SLOTS (Morning + Afternoon only — no Extended) ─────────────
function renderForceEntrySlots() {
  const container = $('feSlotsContainer');
  if (!container) return;
  container.innerHTML = `
    ${renderFeSlotBlock('morning')}
    ${renderFeLunchBlock()}
    ${renderFeSlotBlock('afternoon')}
  `;
}

function renderFeSlotBlock(slotKey) {
  const meta = FE_SLOT_META[slotKey];
  return `
  <div class="slot-block" id="feSlot-${slotKey}">
    <div class="slot-header">
      <div class="slot-title">
        <span class="slot-icon">${meta.icon}</span>
        <span class="slot-label">${meta.label}</span>
        <span class="slot-time-range">${meta.defaultIn} – ${meta.defaultOut}</span>
      </div>
      <button class="add-entry-btn" onclick="addFeEntry('${slotKey}')" title="Add another project in this slot">
        + Add Project
      </button>
    </div>
    <div class="slot-entries" id="feEntries-${slotKey}">
      ${renderFeEntryRow(slotKey, 1)}
    </div>
  </div>`;
}

function renderFeLunchBlock() {
  return `
  <div class="lunch-block">
    <span>🍽️</span>
    <span class="lunch-label">Lunch Break</span>
    <span class="lunch-time">1:00 PM – 1:45 PM</span>
    <span class="lunch-badge">45 min</span>
  </div>`;
}

// ── ONE ENTRY ROW (same fields/validations as form.js, minus per-row Save/Leave) ──
function renderFeEntryRow(slotKey, entryNum) {
  const meta = FE_SLOT_META[slotKey];
  const id   = `fe-${slotKey}-${entryNum}`;

  return `
  <div class="entry-row" id="feEntry-${id}" data-slot="${slotKey}" data-num="${entryNum}">
    <div class="entry-row-header">
      <span class="entry-num">Entry ${entryNum}</span>
      ${entryNum > 1
        ? `<button class="remove-entry-btn" onclick="removeFeEntry('${slotKey}', ${entryNum})" title="Remove">✕</button>`
        : ''}
    </div>

    <div class="entry-times">
      <div class="fg">
        <label class="flabel">Time In</label>
        <input type="time" class="fc time-inp" id="fetin-${id}" value="${meta.defaultIn}"
          min="${meta.displayMin}" max="${meta.maxTime}" onchange="calcFeHours('${id}')" />
      </div>
      <div class="time-arrow">→</div>
      <div class="fg">
        <label class="flabel">Time Out</label>
        <input type="time" class="fc time-inp" id="fetout-${id}" value="${meta.defaultOut}"
          min="${meta.displayMin}" max="${meta.maxTime}" onchange="calcFeHours('${id}')" />
      </div>
      <div class="fg hours-display">
        <label class="flabel">Hours</label>
        <div class="hours-badge" id="fehrs-${id}">—</div>
      </div>
    </div>
    <div class="slot-time-hint">Allowed range: ${meta.displayMin} – ${meta.maxTime}</div>

    <div class="frow">
      <div class="fg">
        <label class="flabel">Client <span class="req">*</span></label>
        <div class="swrap">
          <select class="fc client-sel" id="fecsel-${id}" onchange="onFeClientChange('${id}')">
            <option value="">— Client —</option>
            ${CLIENTS.map(c => `<option value="${c.id}" data-n="${c.name}">${c.name}</option>`).join('')}
          </select>
          <svg class="sarr" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="fg">
        <label class="flabel">Project <span class="req">*</span></label>
        <div class="swrap">
          <select class="fc project-sel" id="fepsel-${id}" disabled>
            <option value="">— Select client first —</option>
          </select>
          <svg class="sarr" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="fg">
        <label class="flabel">Task <span class="req">*</span></label>
        <div class="swrap">
          <select class="fc" id="fetsel-${id}">
            <option value="">— Task —</option>
            ${FE_TASKS.map(t => `<option>${t}</option>`).join('')}
          </select>
          <svg class="sarr" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
    </div>

    <div class="fg" style="margin-top:.6rem">
      <label class="flabel">Notes <span class="req">*</span></label>
      <textarea class="fc ta" id="fenotes-${id}" rows="2"
        placeholder="What did the employee work on? (min ${FE_MIN_NOTES_LENGTH} characters)" maxlength="300"
        oninput="updateFeNotesCount('${id}')"></textarea>
      <div class="tafoot"><span class="cc" id="fecc-${id}">0/${FE_MIN_NOTES_LENGTH} minimum</span></div>
    </div>
  </div>`;
}

// ── ADD / REMOVE ENTRY ROW (mirrors form.js) ───────────────────
function addFeEntry(slotKey) {
  const container = $(`feEntries-${slotKey}`);
  if (!container) return;
  const domRows = container.querySelectorAll('.entry-row');
  if (domRows.length >= FE_MAX_ENTRIES_PER_SLOT) {
    toast?.('i', 'Max 4 entries per slot');
    return;
  }
  const newNum = domRows.length + 1;
  const div = document.createElement('div');
  div.innerHTML = renderFeEntryRow(slotKey, newNum);
  container.appendChild(div.firstElementChild);

  const addBtn = document.querySelector(`#feSlot-${slotKey} .add-entry-btn`);
  if (addBtn && (domRows.length + 1) >= FE_MAX_ENTRIES_PER_SLOT) addBtn.style.display = 'none';
}

function removeFeEntry(slotKey, entryNum) {
  const el = $(`feEntry-fe-${slotKey}-${entryNum}`);
  if (el) el.remove();
  const addBtn = document.querySelector(`#feSlot-${slotKey} .add-entry-btn`);
  if (addBtn) addBtn.style.display = '';
}

// ── CLIENT → PROJECT CASCADE (mirrors form.js) ─────────────────
function onFeClientChange(id) {
  const csel = $(`fecsel-${id}`);
  const psel = $(`fepsel-${id}`);
  if (!csel || !psel) return;
  const cid = csel.value;
  psel.innerHTML = '<option value="">— Project —</option>';
  if (cid) {
    PROJECTS.filter(p => p.cid === cid).forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name; o.dataset.n = p.name;
      psel.appendChild(o);
    });
    psel.disabled = false;
  } else {
    psel.innerHTML = '<option value="">— Select client first —</option>';
    psel.disabled = true;
  }
}

// ── HOURS AUTO-CALC (mirrors form.js) ──────────────────────────
function calcFeHours(id) {
  const tin   = $(`fetin-${id}`)?.value;
  const tout  = $(`fetout-${id}`)?.value;
  const hrsEl = $(`fehrs-${id}`);
  if (!tin || !tout || !hrsEl) return;
  const [ih, im] = tin.split(':').map(Number);
  const [oh, om] = tout.split(':').map(Number);
  const mins = (oh * 60 + om) - (ih * 60 + im);
  if (mins <= 0) { hrsEl.textContent = '—'; return; }
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  hrsEl.textContent = hh === 0 ? `${mm}m` : mm === 0 ? `${hh}h` : `${hh}h ${mm}m`;
}

// ── NOTES CHARACTER COUNT (mirrors form.js) ────────────────────
function updateFeNotesCount(id) {
  const ta = $(`fenotes-${id}`);
  const cc = $(`fecc-${id}`);
  if (!ta || !cc) return;
  const len = ta.value.trim().length;
  cc.textContent = len >= FE_MIN_NOTES_LENGTH ? `${len}/300` : `${len}/${FE_MIN_NOTES_LENGTH} minimum`;
  cc.style.color = len >= FE_MIN_NOTES_LENGTH ? 'var(--ok)' : 'var(--err)';
  ta.classList.remove('bad');
}

// ══════════════════════════════════════════════════════════════
// SAVE FORCE ENTRY — validates every touched row (same rules as
// form.js's saveEntry), then writes each via the existing
// apiSaveSlot() API. No backend changes. Every save creates NEW
// entries — nothing here overwrites the employee's existing history.
// ══════════════════════════════════════════════════════════════
async function saveForceEntryAll() {
  const btn      = $('feSaveAllBtn');
  const reasonEl = $('feReason');
  const notesEl  = $('feManagerNotes');
  const reason   = reasonEl.value.trim();
  const managerNotes = notesEl.value.trim();

  if (!reason) {
    toast?.('e', 'Reason required', 'Explain why this entry is being force-entered.');
    reasonEl.classList.add('bad'); reasonEl.focus();
    return;
  }
  reasonEl.classList.remove('bad');

  if (!managerNotes) {
    toast?.('e', 'Manager notes required');
    notesEl.classList.add('bad'); notesEl.focus();
    return;
  }
  notesEl.classList.remove('bad');

  const toMinutes = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const collected = [];

  for (const slotKey of ['morning', 'afternoon']) {
    const rows = document.querySelectorAll(`#feEntries-${slotKey} .entry-row`);
    for (const row of rows) {
      const entryNum = parseInt(row.dataset.num, 10);
      const id    = `fe-${slotKey}-${entryNum}`;
      const csel  = $(`fecsel-${id}`), psel = $(`fepsel-${id}`), tsel = $(`fetsel-${id}`);
      const tin   = $(`fetin-${id}`),  tout = $(`fetout-${id}`), notesInp = $(`fenotes-${id}`);

      const touched = !!(csel.value || psel.value || tsel.value || notesInp.value.trim());
      if (!touched) continue; // this row was left blank — skip it entirely

      const label = FE_SLOT_META[slotKey].label;
      if (!csel.value)  { toast?.('e', `${label} #${entryNum}: select a client`);  csel.classList.add('bad'); return; }
      if (!psel.value)  { toast?.('e', `${label} #${entryNum}: select a project`); psel.classList.add('bad'); return; }
      if (!tsel.value)  { toast?.('e', `${label} #${entryNum}: select a task`);    tsel.classList.add('bad'); return; }
      if (!tin.value)   { toast?.('e', `${label} #${entryNum}: enter time in`);  return; }
      if (!tout.value)  { toast?.('e', `${label} #${entryNum}: enter time out`); return; }

      const meta = FE_SLOT_META[slotKey];
      const minM = toMinutes(meta.minTime), maxM = toMinutes(meta.maxTime);
      const inM  = toMinutes(tin.value),    outM = toMinutes(tout.value);

      if (inM < minM || inM > maxM) {
        toast?.('e', 'Time In out of range', `${label} allows ${meta.displayMin}–${meta.maxTime}`);
        tin.classList.add('bad'); return;
      }
      if (outM < minM || outM > maxM) {
        toast?.('e', 'Time Out out of range', `${label} allows ${meta.displayMin}–${meta.maxTime}`);
        tout.classList.add('bad'); return;
      }
      if (outM <= inM) {
        toast?.('e', 'Time Out must be after Time In');
        tout.classList.add('bad'); return;
      }
      tin.classList.remove('bad'); tout.classList.remove('bad');

      const notesVal = notesInp.value.trim();
      if (notesVal.length < FE_MIN_NOTES_LENGTH) {
        toast?.('e', 'Notes too short', `Write at least ${FE_MIN_NOTES_LENGTH} characters (currently ${notesVal.length})`);
        notesInp.classList.add('bad'); notesInp.focus();
        return;
      }
      notesInp.classList.remove('bad');
      csel.classList.remove('bad'); psel.classList.remove('bad'); tsel.classList.remove('bad');

      let hours = 0;
      const mins = outM - inM;
      if (mins > 0) hours = Math.round((mins / 60) * 100) / 100;

      const cOpt = csel.options[csel.selectedIndex];
      const pOpt = psel.options[psel.selectedIndex];

      collected.push(buildForceEntry(slotKey, entryNum, {
        timeIn: tin.value, timeOut: tout.value, hours,
        clientId:  csel.value, client:  cOpt?.dataset?.n || cOpt?.text || '',
        projectId: psel.value, project: pOpt?.dataset?.n || pOpt?.text || '',
        task: tsel.value, notes: notesVal,
      }, reason, managerNotes));
    }
  }

  if (!collected.length) {
    toast?.('e', 'Nothing to save', 'Fill in at least one Morning or Afternoon entry.');
    return;
  }

  if (btn) { btn.classList.add('ld'); btn.disabled = true; }
  toast?.('i', 'Saving force entry…', 'Please wait', 18000);

  try {
    for (const entry of collected) {
      await apiSaveSlot(entry);
    }
    toast?.('s', 'Force Entry saved', `${collected.length} session${collected.length > 1 ? 's' : ''} recorded for ${FE_EMP.name}.`);
    if (FE_RETURN_TO) FE_RETURN_TO();
    else if (typeof openEmpDetail === 'function') await openEmpDetail(FE_EMP.id, FE_EMP.name);
  } catch(err) {
    toast?.('e', 'Save failed', err.message);
  } finally {
    if (btn) { btn.classList.remove('ld'); btn.disabled = false; }
  }
}

// Build the saved entry using the exact same object shape form.js
// already writes via apiSaveSlot — no backend/schema changes needed.
// Audit fields (Employee ID/Name, Entry Date, Entered By, Role,
// Timestamp, Force Entry flag, Reason, Manager Notes) are attached
// directly on the entry AND embedded as a readable tag inside the
// notes field, so the audit trail survives even if the Sheet only
// keeps the columns it already has.
function buildForceEntry(slotKey, entryNum, fields, reason, managerNotes) {
  const enteredBy = getEnteredByInfo();
  const now = new Date();
  const savedAt = now.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });

  const tag = `[FORCE_ENTRY by ${enteredBy.name} (${enteredBy.role}) · ${savedAt}] `
    + `Reason: ${reason} | Manager Notes: ${managerNotes} | Employee notes: ${fields.notes}`;

  return {
    id:      `${FE_EMP.id}-${FE_DATE}-${slotKey}-${entryNum}`,
    uid:     FE_EMP.id,
    empName: FE_EMP.name,
    date:    FE_DATE,
    day:     new Date(FE_DATE + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' }),
    slot:    slotKey,
    entryNum,
    timeIn:  fields.timeIn,
    timeOut: fields.timeOut,
    hours:   fields.hours,
    clientId:  fields.clientId,
    client:    fields.client,
    projectId: fields.projectId,
    project:   fields.project,
    task:      fields.task,
    notes:     tag,
    status:    'Worked',
    savedAt,

    // ── Permanent audit trail — never removed on future saves ──
    forceEntry:     true,
    empId:          FE_EMP.id,
    enteredBy:      enteredBy.name,
    enteredByRole:  enteredBy.role,
    entryDate:      FE_DATE,
    timestamp:      savedAt,
    reason,
    managerNotes,
  };
}