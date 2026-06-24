// ═══════════════════════════════════════════════════
// FORM.JS — Slot-based day entry form
//
// Architecture (v4 — Sheet as single source of truth):
//   • NO local cache. Every date load fetches fresh from Sheet.
//   • Saved entries are EDITABLE — user can change and re-save.
//     Apps Script upserts (overwrites in place) by uid+date+slot+entryNum.
//   • Max 4 entries per slot enforced on both client and server.
//   • Duplicate prevention: same slot+entryNum = overwrite, never append.
//
// Slots:
//   🌅 Morning   09:30 → 13:00  (up to 4 sub-entries)
//   🍽️ Lunch     13:00 → 13:45  (display only)
//   ☀️ Afternoon 13:45 → 19:30  (up to 4 sub-entries)
//   🌙 Extended  19:30 → 22:00  (optional)
// ═══════════════════════════════════════════════════

let ENTRIES      = [];   // full history for table.js / chart.js
let DAY_ENTRIES  = {};   // { morning:[], afternoon:[], extended:[] } — current date only
let CURRENT_DATE = '';   // YYYY-MM-DD

const MAX_ENTRIES_PER_SLOT = 4;

const SLOT_META = {
  morning:   { label: 'Morning',   icon: '🌅', defaultIn: '09:30', defaultOut: '13:00', minTime: '08:30', maxTime: '13:00', displayMin: '09:30', color: '#f59e0b' },
  afternoon: { label: 'Afternoon', icon: '☀️',  defaultIn: '13:45', defaultOut: '19:30', minTime: '13:30', maxTime: '20:00', displayMin: '13:45', color: '#3b82f6' },
  extended:  { label: 'Extended',  icon: '🌙', defaultIn: '19:30', defaultOut: '22:00', minTime: '19:00', maxTime: '23:59', displayMin: '19:30', color: '#8b5cf6' },
};

// ── INIT ──────────────────────────────────────────
function initForm() {
  CURRENT_DATE = todayStr();
  renderDateNav();
  loadAndRenderDay(CURRENT_DATE);
}

// ── DATE NAVIGATION ───────────────────────────────
// Maximum days back from today that can be logged/edited.
// 0 = today, 1 = yesterday, 2 = day before yesterday.
const MAX_DAYS_BACK = 2;

function renderDateNav() {
  const nav = $('dateNav');
  if (!nav) return;

  const days = [];
  for (let i = MAX_DAYS_BACK; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(fmtDateObj(d));
  }

  nav.innerHTML = days.map(d => {
    const label    = new Date(d + 'T00:00:00').toLocaleDateString('en-IN',
      { weekday:'short', day:'numeric', month:'short' });
    const isActive = d === CURRENT_DATE;
    const isToday  = d === todayStr();
    return `<button class="daybtn${isActive?' active':''}${isToday?' today':''}"
      data-date="${d}" onclick="switchDay('${d}')">
      ${isToday ? '<span class="today-dot"></span>' : ''}
      ${label}
    </button>`;
  }).join('');

  const heading = $('dayHeading');
  if (heading) {
    const d = new Date(CURRENT_DATE + 'T00:00:00');
    heading.textContent = d.toLocaleDateString('en-IN',
      { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  }
}

function switchDay(date) {
  if (!isWithinEditableRange(date)) {
    toast('e', 'Date not editable', `You can only log entries for today and the past ${MAX_DAYS_BACK} days.`);
    return;
  }
  CURRENT_DATE = date;
  renderDateNav();
  loadAndRenderDay(date);   // always fetch fresh — no cache
}

// Returns true if `date` (YYYY-MM-DD) is within today..today-MAX_DAYS_BACK
function isWithinEditableRange(date) {
  const today    = new Date(todayStr() + 'T00:00:00');
  const target   = new Date(date + 'T00:00:00');
  const diffDays = Math.round((today - target) / 86400000);
  return diffDays >= 0 && diffDays <= MAX_DAYS_BACK;
}

// ── LOAD DAY (always fresh from Sheet) ────────────
async function loadAndRenderDay(date) {
  const container = $('slotsContainer');
  if (!container) return;

  container.innerHTML = `<div class="slot-loading">
    <div class="slot-spinner"></div>
    <span>Loading ${date}…</span>
  </div>`;

  try {
    const data = await apiGetDaySlots(USER.id, date);

    DAY_ENTRIES = { morning: [], afternoon: [], extended: [] };
    const seen  = {};

    (data.entries || []).forEach(e => {
      const key = `${e.slot}-${e.entryNum}`;
      seen[key] = e;
    });

    Object.values(seen).forEach(e => {
      if (DAY_ENTRIES[e.slot]) DAY_ENTRIES[e.slot].push(e);
    });

    Object.keys(DAY_ENTRIES).forEach(s =>
      DAY_ENTRIES[s].sort((a, b) => a.entryNum - b.entryNum)
    );

    console.log('[FORM] Loaded from Sheet for', date, ':',
      JSON.stringify(Object.fromEntries(
        Object.entries(DAY_ENTRIES).map(([k, v]) => [k, v.length])
      ))
    );

    renderSlots();
  } catch (err) {
    console.error('[FORM] loadAndRenderDay error:', err);
    container.innerHTML = `<div class="slot-error">Failed to load: ${err.message}</div>`;
  }
}

// ── RENDER ALL SLOTS ──────────────────────────────
function renderSlots() {
  const container = $('slotsContainer');
  if (!container) return;

  const hasExtended = DAY_ENTRIES.extended.length > 0;

  container.innerHTML = `
    ${renderSlotBlock('morning')}
    ${renderLunchBlock()}
    ${renderSlotBlock('afternoon')}
    ${renderExtendedToggle(hasExtended)}
    <div id="extendedBlock" style="${hasExtended ? '' : 'display:none'}">
      ${renderSlotBlock('extended')}
    </div>
  `;
}

// ── RENDER ONE SLOT BLOCK ─────────────────────────
function renderSlotBlock(slotKey) {
  const meta    = SLOT_META[slotKey];
  const entries = DAY_ENTRIES[slotKey] || [];
  const rows    = entries.length > 0 ? entries : [null];
  const total   = entries.length;

  return `
  <div class="slot-block" id="slot-${slotKey}">
    <div class="slot-header">
      <div class="slot-title">
        <span class="slot-icon">${meta.icon}</span>
        <span class="slot-label">${meta.label}</span>
        <span class="slot-time-range">${meta.defaultIn} – ${meta.defaultOut}</span>
        ${total > 0 ? `<span class="slot-saved-badge">✓ ${total} saved</span>` : ''}
      </div>
      ${total < MAX_ENTRIES_PER_SLOT ? `
        <button class="add-entry-btn" onclick="addEntry('${slotKey}')"
          title="Add another project in this slot">
          + Add Project
        </button>` : ''}
    </div>
    <div class="slot-entries" id="entries-${slotKey}">
      ${rows.map((e, i) => renderEntryRow(slotKey, i + 1, e)).join('')}
    </div>
  </div>`;
}

// ── RENDER ONE ENTRY ROW ──────────────────────────
function renderEntryRow(slotKey, entryNum, entry) {
  const meta     = SLOT_META[slotKey];
  const isLeave  = entry?.status === 'Leave';
  const isSaved  = !!entry;

  // Validate time format is HH:MM — if the Sheet ever returns a
  // corrupted value (e.g. a date string), fall back to slot defaults
  // instead of displaying garbage.
  const isValidTime = v => /^\d{1,2}:\d{2}$/.test(v || '');
  const timeIn    = isValidTime(entry?.timeIn)  ? entry.timeIn  : meta.defaultIn;
  const timeOut   = isValidTime(entry?.timeOut) ? entry.timeOut : meta.defaultOut;
  const clientId  = entry?.clientId  || '';
  const projectId = entry?.projectId || '';
  const task      = entry?.task      || '';
  const notes     = entry?.notes     || '';
  const hours     = entry?.hours     || '';

  const id = `${slotKey}-${entryNum}`;

  const projectOptions = clientId
    ? PROJECTS.filter(p => p.cid === clientId).map(p =>
        `<option value="${p.id}" data-n="${p.name}"${p.id === projectId ? ' selected' : ''}>${p.name}</option>`
      ).join('')
    : '';

  return `
  <div class="entry-row${isLeave ? ' on-leave' : ''}${isSaved ? ' is-saved' : ''}"
       id="entry-${id}" data-slot="${slotKey}" data-num="${entryNum}">

    <div class="entry-row-header">
      <span class="entry-num">Entry ${entryNum}</span>
      ${isSaved
        ? isLeave
          ? '<span class="leave-badge">🏖️ Leave</span>'
          : '<span class="saved-badge">✏️ Saved — editable</span>'
        : ''}
      ${entryNum > 1
        ? `<button class="remove-entry-btn" onclick="removeEntry('${slotKey}', ${entryNum})" title="Remove">✕</button>`
        : ''}
    </div>

    ${isLeave ? `
    <div class="leave-info">
      <span>Leave logged for ${meta.label} slot (${timeIn} – ${timeOut})</span>
      <button class="btn bghost" onclick="undoLeave('${id}', '${slotKey}', ${entryNum})" style="margin-left:1rem">
        ✕ Remove Leave
      </button>
    </div>` : `

    <!-- Time In / Time Out -->
    <div class="entry-times">
      <div class="fg">
        <label class="flabel">Time In</label>
        <input type="time" class="fc time-inp" id="tin-${id}" value="${timeIn}"
          min="${meta.displayMin}" max="${meta.maxTime}"
          onchange="calcHours('${id}')" />
      </div>
      <div class="time-arrow">→</div>
      <div class="fg">
        <label class="flabel">Time Out</label>
        <input type="time" class="fc time-inp" id="tout-${id}" value="${timeOut}"
          min="${meta.displayMin}" max="${meta.maxTime}"
          onchange="calcHours('${id}')" />
      </div>
      <div class="fg hours-display">
        <label class="flabel">Hours</label>
        <div class="hours-badge" id="hrs-${id}">${hours ? hours + 'h' : '—'}</div>
      </div>
    </div>
    <div class="slot-time-hint">Allowed range: ${meta.displayMin} – ${meta.maxTime}</div>

    <!-- Client / Project / Task -->
    <div class="frow">
      <div class="fg">
        <label class="flabel">Client <span class="req">*</span></label>
        <div class="swrap">
          <select class="fc client-sel" id="csel-${id}" onchange="onClientChange('${id}')">
            <option value="">— Client —</option>
            ${CLIENTS.map(c =>
              `<option value="${c.id}" data-n="${c.name}"${c.id === clientId ? ' selected' : ''}>${c.name}</option>`
            ).join('')}
          </select>
          <svg class="sarr" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="fg">
        <label class="flabel">Project <span class="req">*</span></label>
        <div class="swrap">
          <select class="fc project-sel" id="psel-${id}" ${clientId ? '' : 'disabled'}>
            <option value="">— ${clientId ? 'Project' : 'Select client first'} —</option>
            ${projectOptions}
          </select>
          <svg class="sarr" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="fg">
        <label class="flabel">Task <span class="req">*</span></label>
        <div class="swrap">
          <select class="fc" id="tsel-${id}">
            <option value="">— Task —</option>
            ${['Layout','Exterior','Interior'].map(t =>
              `<option${t === task ? ' selected' : ''}>${t}</option>`
            ).join('')}
          </select>
          <svg class="sarr" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
    </div>

    <!-- Notes -->
    <div class="fg" style="margin-top:.6rem">
      <label class="flabel">Notes <span class="req">*</span></label>
      <textarea class="fc ta" id="notes-${id}" rows="2"
        placeholder="What did you work on? (min ${MIN_NOTES_LENGTH} characters)" maxlength="300"
        oninput="updateNotesCount('${id}')">${notes}</textarea>
      <div class="tafoot">
        <span class="cc" id="cc-${id}">${notes.length >= MIN_NOTES_LENGTH ? `${notes.length}/300` : `${notes.length}/${MIN_NOTES_LENGTH} minimum`}</span>
      </div>
    </div>

    <!-- Actions -->
    <div class="entry-actions">
      <button class="btn bghost leave-btn"
        onclick="markLeave('${id}', '${slotKey}', ${entryNum})">
        🏖️ Mark Leave
      </button>
      <button class="btn bpri save-btn" id="savebtn-${id}"
        onclick="saveEntry('${id}', '${slotKey}', ${entryNum})">
        <span class="bl">${isSaved ? 'Update' : 'Save'}</span>
        <svg class="bi" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        <div class="bspin"></div>
      </button>
    </div>`}
  </div>`;
}

// ── LUNCH BLOCK ───────────────────────────────────
function renderLunchBlock() {
  return `
  <div class="lunch-block">
    <span>🍽️</span>
    <span class="lunch-label">Lunch Break</span>
    <span class="lunch-time">1:00 PM – 1:45 PM</span>
    <span class="lunch-badge">45 min</span>
  </div>`;
}

// ── EXTENDED TOGGLE ───────────────────────────────
function renderExtendedToggle(isOpen) {
  return `
  <button class="extended-toggle" id="extToggle"
    onclick="toggleExtended()" aria-expanded="${isOpen}">
    ${isOpen ? '▲ Hide Extended Hours' : '🌙 + Add Extended Hours (7:30 PM – 10:00 PM)'}
  </button>`;
}

function toggleExtended() {
  const block  = $('extendedBlock');
  const toggle = $('extToggle');
  if (!block) return;
  const isHidden = block.style.display === 'none';
  block.style.display = isHidden ? 'block' : 'none';
  toggle.setAttribute('aria-expanded', isHidden);
  toggle.textContent = isHidden
    ? '▲ Hide Extended Hours'
    : '🌙 + Add Extended Hours (7:30 PM – 10:00 PM)';
  if (isHidden && DAY_ENTRIES.extended.length === 0) {
    block.innerHTML = renderSlotBlock('extended');
  }
}

// ── ADD / REMOVE ENTRY ROW ────────────────────────
function addEntry(slotKey) {
  const current = DAY_ENTRIES[slotKey] || [];
  if (current.length >= MAX_ENTRIES_PER_SLOT) {
    toast('i', 'Max 4 entries per slot');
    return;
  }
  const maxSaved = current.reduce((m, e) => Math.max(m, e.entryNum), 0);
  const newNum   = maxSaved + 1;

  const container = $(`entries-${slotKey}`);
  if (!container) return;
  const div = document.createElement('div');
  div.innerHTML = renderEntryRow(slotKey, newNum, null);
  container.appendChild(div.firstElementChild);

  const addBtn = document.querySelector(`#slot-${slotKey} .add-entry-btn`);
  if (addBtn && (current.length + 1) >= MAX_ENTRIES_PER_SLOT) addBtn.style.display = 'none';
}

function removeEntry(slotKey, entryNum) {
  const el = $(`entry-${slotKey}-${entryNum}`);
  if (el) el.remove();
  DAY_ENTRIES[slotKey] = (DAY_ENTRIES[slotKey] || []).filter(e => e.entryNum !== entryNum);
  const addBtn = document.querySelector(`#slot-${slotKey} .add-entry-btn`);
  if (addBtn) addBtn.style.display = '';
}

// ── CLIENT → PROJECT CASCADE ──────────────────────
function onClientChange(id) {
  const csel = $(`csel-${id}`);
  const psel = $(`psel-${id}`);
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
    psel.disabled = true;
  }
}

// ── HOURS AUTO-CALC ───────────────────────────────
function calcHours(id) {
  const tin   = $(`tin-${id}`)?.value;
  const tout  = $(`tout-${id}`)?.value;
  const hrsEl = $(`hrs-${id}`);
  if (!tin || !tout || !hrsEl) return;
  const [ih, im] = tin.split(':').map(Number);
  const [oh, om] = tout.split(':').map(Number);
  const mins = (oh * 60 + om) - (ih * 60 + im);
  if (mins <= 0) { hrsEl.textContent = '—'; return; }
  const h = Math.round((mins / 60) * 100) / 100; // exact to 2 decimal places e.g. 3.47
  hrsEl.textContent = `${h}h`;
}

// ── NOTES CHARACTER COUNT ─────────────────────────
const MIN_NOTES_LENGTH = 25;

function updateNotesCount(id) {
  const ta  = $(`notes-${id}`);
  const cc  = $(`cc-${id}`);
  if (!ta || !cc) return;
  const len = ta.value.trim().length;
  cc.textContent = len >= MIN_NOTES_LENGTH
    ? `${len}/300`
    : `${len}/${MIN_NOTES_LENGTH} minimum`;
  cc.style.color = len >= MIN_NOTES_LENGTH ? 'var(--ok)' : 'var(--err)';
  ta.classList.toggle('bad', false); // clear red border while typing
}

// ── MARK LEAVE ────────────────────────────────────
async function markLeave(id, slotKey, entryNum) {
  const entry = {
    ...buildEntryBase(slotKey, entryNum),
    timeIn:    SLOT_META[slotKey].defaultIn,
    timeOut:   SLOT_META[slotKey].defaultOut,
    client:    'Leave', clientId:  '',
    project:   'Leave', projectId: '',
    task:      'Leave', notes:     '',
    hours:     0,
    status:    'Leave',
  };

  const btn = $(`savebtn-${id}`);
  if (btn) { btn.classList.add('ld'); btn.disabled = true; }
  toast('i', 'Marking Leave…', 'Please wait', 18000);

  try {
    const result = await apiSaveSlot(entry);

    // Update local DAY_ENTRIES state
    DAY_ENTRIES[slotKey] = DAY_ENTRIES[slotKey] || [];
    const idx = DAY_ENTRIES[slotKey].findIndex(e => e.entryNum === entryNum);
    if (idx >= 0) DAY_ENTRIES[slotKey][idx] = entry;
    else          DAY_ENTRIES[slotKey].push(entry);

    reRenderRow(id, slotKey, entryNum, entry);

    // Use history returned inline from saveAndHistory (one round-trip)
    // Fall back to separate fetch only in DEMO_MODE where result.history is null
    if (result.history) {
      ENTRIES = result.history;
    } else {
      ENTRIES = await apiGetHistory(USER.id);
    }

    refreshStats(); refreshFilters(); refreshTable(); refreshChart();
    toast('i', 'Marked as Leave', `${SLOT_META[slotKey].label} slot ${entryNum}`);
    toast('e', 'Failed', e.message);
  } finally {
    if (btn) { btn.classList.remove('ld'); btn.disabled = false; }
  }
}

// ── UNDO LEAVE ────────────────────────────────────
function undoLeave(id, slotKey, entryNum) {
  DAY_ENTRIES[slotKey] = (DAY_ENTRIES[slotKey] || []).filter(e => e.entryNum !== entryNum);
  reRenderRow(id, slotKey, entryNum, null);
}

// ── SAVE ENTRY ────────────────────────────────────
async function saveEntry(id, slotKey, entryNum) {
  const btn  = $(`savebtn-${id}`);
  const csel = $(`csel-${id}`);
  const psel = $(`psel-${id}`);
  const tsel = $(`tsel-${id}`);
  const tin  = $(`tin-${id}`);
  const tout = $(`tout-${id}`);

  if (!csel?.value) { toast('e', 'Select a client');  csel?.classList.add('bad'); return; }
  if (!psel?.value) { toast('e', 'Select a project'); psel?.classList.add('bad'); return; }
  if (!tsel?.value) { toast('e', 'Select a task');    tsel?.classList.add('bad'); return; }
  if (!tin?.value)  { toast('e', 'Enter time in');  return; }
  if (!tout?.value) { toast('e', 'Enter time out'); return; }

  // ── TIME RANGE VALIDATION ──────────────────────────────────
  const meta = SLOT_META[slotKey];
  const toMinutes = t => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const minM  = toMinutes(meta.minTime);
  const maxM  = toMinutes(meta.maxTime);
  const inM   = toMinutes(tin.value);
  const outM  = toMinutes(tout.value);

  if (inM < minM || inM > maxM) {
    toast('e', 'Time In out of range', `${meta.label} allows ${meta.displayMin}–${meta.maxTime}`);
    tin.classList.add('bad');
    return;
  }
  if (outM < minM || outM > maxM) {
    toast('e', 'Time Out out of range', `${meta.label} allows ${meta.displayMin}–${meta.maxTime}`);
    tout.classList.add('bad');
    return;
  }
  if (outM <= inM) {
    toast('e', 'Time Out must be after Time In');
    tout.classList.add('bad');
    return;
  }
  tin.classList.remove('bad'); tout.classList.remove('bad');

  // ── NOTES MIN LENGTH VALIDATION ────────────────────────────
  const notesEl  = $(`notes-${id}`);
  const notesVal = notesEl?.value.trim() || '';
  if (notesVal.length < MIN_NOTES_LENGTH) {
    toast('e', 'Notes too short', `Write at least ${MIN_NOTES_LENGTH} characters (currently ${notesVal.length})`);
    notesEl?.classList.add('bad');
    notesEl?.focus();
    return;
  }
  notesEl.classList.remove('bad');

  const slotEntries = DAY_ENTRIES[slotKey] || [];
  const isExisting  = slotEntries.some(e => e.entryNum === entryNum);
  if (!isExisting && slotEntries.length >= MAX_ENTRIES_PER_SLOT) {
    toast('e', 'Max 4 entries per slot');
    return;
  }

  csel.classList.remove('bad'); psel.classList.remove('bad'); tsel.classList.remove('bad');

  const entry = buildEntry(id, slotKey, entryNum, 'Worked');

  if (btn) { btn.classList.add('ld'); btn.disabled = true; }
  toast('i', 'Saving…', 'Please wait', 18000); // dismissed by success/error toast
  try {
    const result = await apiSaveSlot(entry);

    DAY_ENTRIES[slotKey] = DAY_ENTRIES[slotKey] || [];
    const idx = DAY_ENTRIES[slotKey].findIndex(e => e.entryNum === entryNum);
    if (idx >= 0) DAY_ENTRIES[slotKey][idx] = entry;
    else          DAY_ENTRIES[slotKey].push(entry);

    reRenderRow(id, slotKey, entryNum, entry);

    // Use history returned inline from saveAndHistory (one round-trip)
    // Fall back to separate fetch only in DEMO_MODE where result.history is null
    if (result.history) {
      ENTRIES = result.history;
    } else {
      ENTRIES = await apiGetHistory(USER.id);
    }

    refreshStats(); refreshFilters(); refreshTable(); refreshChart();
    toast('s', 'Saved!', `${SLOT_META[slotKey].label} entry ${entryNum}`);
  } catch(e) {
    toast('e', 'Save failed', e.message);
  } finally {
    if (btn) { btn.classList.remove('ld'); btn.disabled = false; }
  }
}

// ── RE-RENDER A SINGLE ROW IN PLACE ──────────────
function reRenderRow(id, slotKey, entryNum, entry) {
  const existing = $(`entry-${id}`);
  if (!existing) return;
  const div = document.createElement('div');
  div.innerHTML = renderEntryRow(slotKey, entryNum, entry);
  existing.replaceWith(div.firstElementChild);
}

// ── BUILD ENTRY OBJECT ────────────────────────────
function buildEntry(id, slotKey, entryNum, status) {
  const csel  = $(`csel-${id}`);
  const psel  = $(`psel-${id}`);
  const tsel  = $(`tsel-${id}`);
  const tin   = $(`tin-${id}`)?.value  || '';
  const tout  = $(`tout-${id}`)?.value || '';
  const notes = $(`notes-${id}`)?.value.trim() || '';

  let hours = 0;
  if (tin && tout) {
    const [ih, im] = tin.split(':').map(Number);
    const [oh, om] = tout.split(':').map(Number);
    const mins = (oh * 60 + om) - (ih * 60 + im);
    if (mins > 0) hours = Math.round((mins / 60) * 100) / 100;
  }

  const cOpt = csel?.options[csel.selectedIndex];
  const pOpt = psel?.options[psel.selectedIndex];

  return {
    ...buildEntryBase(slotKey, entryNum),
    timeIn:    tin,
    timeOut:   tout,
    hours,
    clientId:  csel?.value || '',
    client:    cOpt?.dataset?.n || cOpt?.text || '',
    projectId: psel?.value || '',
    project:   pOpt?.dataset?.n || pOpt?.text || '',
    task:      tsel?.value || '',
    notes,
    status,
  };
}

function buildEntryBase(slotKey, entryNum) {
  const d   = new Date(CURRENT_DATE + 'T00:00:00');
  const now = new Date();
  // savedAt: exact moment the user hit Save — stored as ISO string
  const savedAt = now.toLocaleString('en-IN', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true
  });
  return {
    id:      `${USER.id}-${CURRENT_DATE}-${slotKey}-${entryNum}`,
    uid:     USER.id,
    empName: USER.name,
    date:    CURRENT_DATE,
    day:     d.toLocaleDateString('en-IN', { weekday:'long' }),
    slot:    slotKey,
    entryNum,
    savedAt, // e.g. "23 Jun 2026, 04:15:32 pm"
  };
}

// ── HELPERS ───────────────────────────────────────
function fmtDateObj(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}