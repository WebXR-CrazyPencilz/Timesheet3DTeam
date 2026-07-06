// ═══════════════════════════════════════════════════════════════
// SALARY.JS — Master Salary Database (Manager Portal only)
//
// Single source of truth for employee salary configuration:
//   LPA · Monthly Salary · Working Hours/Day · Hourly Rate · Points (X)
//
// Auto-calculation (still manually overridable per field):
//   Monthly Salary = LPA ÷ 12
//   Hourly Rate    = (Monthly Salary ÷ 30) ÷ Working Hours/Day
// Working Hours/Day is stored per employee per month since it varies
// person to person (8h, 9h, 10h, etc.) and can change over time.
// stored MONTH-WISE with automatic carry-forward — a month with no
// explicit edit simply inherits the most recent earlier month's
// values, live, at read time. Nothing is ever duplicated or
// overwritten: only the month the Manager actually edits gets a
// stored row; every later month is computed on the fly.
//
// This is a completely new, self-contained module:
//   • manager.js is NOT modified. It already calls a global
//     renderSalaryTab(content) function when the Salary tab is
//     opened — this file defines that same function name, and
//     because browsers execute <script> tags in document order,
//     loading this file AFTER manager.js's <script> tag makes this
//     definition the one that runs. (IMPORTANT: add
//     <script src="salary.js"></script> after manager.js in the
//     page's script list for this to take effect.)
//   • The Employee Portal and Team Leader Portal are untouched —
//     this module is never referenced from either.
//   • No project/client cost calculations happen here — this file
//     only stores and serves salary configuration. project-client.js
//     (future) will read SAL_RECORDS / getEffectiveSalary() to do
//     that math.
//
// Backend note: the existing 'Salaries' sheet/action only stores one
// flat current value per employee — it has no concept of "month" or
// history, so it cannot represent carry-forward. This module talks
// to two NEW, additive Code.gs actions instead: 'getSalaryHistory'
// and 'saveSalaryMonth', backed by a new 'SalaryHistory' sheet. See
// the accompanying Code.gs snippet — nothing existing is changed,
// only added.
// ═══════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────
let SAL_LOADED   = false;
let SAL_RECORDS  = [];               // sparse: [{empId, empName, month:'YYYY-MM', lpa, monthly, hourly, points, updatedAt}]
let SAL_SELECTED = null;             // empId currently shown in the timeline
let SAL_YEAR     = new Date().getFullYear();

// ── ENTRY POINT (called by manager.js when MGR_TAB === 'salary') ──
async function renderSalaryTab(content) {
  // Only the Manager may view/edit this module.
  if (typeof MANAGER_MODE !== 'undefined' && !MANAGER_MODE) {
    content.innerHTML = `<div class="chart-empty">Salary data is only accessible to the Manager.</div>`;
    return;
  }

  content.innerHTML = `<div class="mgr-loading"><div class="slot-spinner"></div><span>Loading salary data…</span></div>`;

  try {
    await loadSalaryData();
  } catch(err) {
    content.innerHTML = `<div class="slot-error">Failed to load salary data: ${esc(err.message)}</div>`;
    return;
  }

  if (!SAL_SELECTED && typeof MGR_EMPLOYEES !== 'undefined' && MGR_EMPLOYEES.length) {
    SAL_SELECTED = MGR_EMPLOYEES[0].id;
  }

  renderSalaryLayout(content);
}

async function loadSalaryData() {
  SAL_RECORDS = await sheetGET({ action: 'getSalaryHistory' });
  SAL_LOADED  = true;
}

// ── LAYOUT: employee list (left) + monthly timeline (right) ────
function renderSalaryLayout(content) {
  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.1rem;">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--txt1);">💼 Master Salary Database</div>
        <div style="font-size:12px;color:var(--txt2);">Month-wise · carries forward automatically until changed</div>
      </div>
    </div>

    <div style="display:flex;gap:1.25rem;align-items:flex-start;">
      <!-- Employee list -->
      <div style="width:230px;flex-shrink:0;background:var(--surface1);border:1px solid var(--border);
        border-radius:12px;padding:.8rem;">
        <div style="font-weight:700;font-size:12.5px;color:var(--txt1);margin-bottom:.6rem;">Employees</div>
        <input type="search" id="salEmpSearch" placeholder="Search…" style="width:100%;margin-bottom:.6rem;
          padding:6px 9px;background:var(--surface2);border:1px solid var(--border);border-radius:7px;
          color:var(--txt1);font-size:12px;box-sizing:border-box;"/>
        <div id="salEmpList" style="display:flex;flex-direction:column;gap:4px;max-height:520px;overflow-y:auto;"></div>
      </div>

      <!-- Timeline -->
      <div style="flex:1;min-width:0;" id="salTimelinePanel"></div>
    </div>

    <style>
      .sal-emp-btn:hover { background:var(--hover) !important; }
      .sal-nav-btn {
        width:28px;height:28px;border-radius:50%;border:1px solid var(--border-md);
        background:var(--elevated);color:var(--txt1);font-size:12px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;flex-shrink:0;
      }
      .sal-field-label { font-size:9.5px;color:var(--txt2);text-transform:uppercase;letter-spacing:.04em; }
      .sal-field-val   { font-size:13px;font-weight:700;color:var(--txt1); }
      .sal-edit-btn:hover { border-color:var(--a1) !important;color:var(--a1) !important; }

      .sal-modal-overlay {
        position:fixed;inset:0;background:rgba(0,0,0,.55);
        display:flex;align-items:center;justify-content:center;z-index:9999;
      }
      .sal-modal {
        background:var(--surface1);border:1px solid var(--border-md);
        border-radius:14px;padding:1.25rem;width:360px;max-width:92vw;
      }
      .sal-flabel { font-size:11px;color:var(--txt2);font-weight:600;display:block;margin:10px 0 4px; }
      .sal-finput {
        width:100%;background:var(--surface2);border:1px solid var(--border);
        border-radius:7px;color:var(--txt1);font-size:12.5px;padding:7px 9px;
        box-sizing:border-box;font-family:inherit;
      }
      .sal-btn-ghost {
        background:none;border:1px solid var(--border-md);color:var(--txt2);
        border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;
      }
      .sal-btn-primary {
        background:var(--a1);border:none;color:#fff;
        border-radius:7px;padding:7px 14px;font-size:12.5px;font-weight:700;cursor:pointer;
      }
    </style>
  `;

  renderSalEmpList(content);
  renderSalTimeline(content);

  $('salEmpSearch').addEventListener('input', e => renderSalEmpList(content, e.target.value.toLowerCase().trim()));
}

function renderSalEmpList(content, query = '') {
  const list = $('salEmpList');
  if (!list) return;
  const emps = (MGR_EMPLOYEES || []).filter(e =>
    !query || e.name.toLowerCase().includes(query) || e.id.toLowerCase().includes(query)
  );

  list.innerHTML = emps.map(e => `
    <button class="sal-emp-btn" data-emp-id="${e.id}" style="
      display:flex;flex-direction:column;align-items:flex-start;gap:1px;
      text-align:left;padding:7px 10px;border-radius:8px;border:none;
      background:${e.id === SAL_SELECTED ? 'var(--a1)' : 'transparent'};
      color:${e.id === SAL_SELECTED ? '#fff' : 'var(--txt1)'};cursor:pointer;">
      <span style="font-size:12.5px;font-weight:600;">${esc(e.name)}</span>
      <span style="font-size:10.5px;opacity:.8;">${esc(e.id)}</span>
    </button>`).join('') || `<div style="font-size:11.5px;color:var(--txt2);padding:.5rem;">No matches.</div>`;

  list.querySelectorAll('.sal-emp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      SAL_SELECTED = btn.dataset.empId;
      renderSalEmpList(content, query);
      renderSalTimeline(content);
    });
  });
}

// ── TIMELINE: selected employee's 12-month grid for SAL_YEAR ───
function renderSalTimeline(content) {
  const panel = $('salTimelinePanel');
  if (!panel) return;

  const emp = (MGR_EMPLOYEES || []).find(e => e.id === SAL_SELECTED);
  if (!emp) { panel.innerHTML = `<div class="chart-empty">Select an employee to view their salary timeline.</div>`; return; }

  const monthKeys = [];
  for (let m = 1; m <= 12; m++) monthKeys.push(`${SAL_YEAR}-${String(m).padStart(2, '0')}`);

  const cards = monthKeys.map(mk => buildSalMonthCard(emp, mk)).join('');

  panel.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:1rem 1.1rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.9rem;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-weight:700;font-size:15px;color:var(--txt1);">${esc(emp.name)}</div>
          <div style="font-size:11.5px;color:var(--txt2);">${esc(emp.id)} · Salary Timeline</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <button id="salYearPrev" class="sal-nav-btn">◀</button>
          <span style="font-size:13px;font-weight:700;color:var(--txt1);min-width:50px;text-align:center;">${SAL_YEAR}</span>
          <button id="salYearNext" class="sal-nav-btn">▶</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.85rem;">
        ${cards}
      </div>
    </div>
  `;

  $('salYearPrev').addEventListener('click', () => { SAL_YEAR--; renderSalTimeline(content); });
  $('salYearNext').addEventListener('click', () => { SAL_YEAR++; renderSalTimeline(content); });

  panel.querySelectorAll('.sal-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openSalaryEditor(content, emp, btn.dataset.month));
  });
}

function buildSalMonthCard(emp, monthKey) {
  const effective  = getEffectiveSalary(emp.id, monthKey);
  const monthLabel = new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const monthShort = monthLabel.split(' ')[0];

  if (!effective) {
    return `
      <div style="background:var(--surface2);border:1px dashed var(--border);border-radius:12px;padding:.85rem;">
        <div style="font-size:11.5px;font-weight:700;color:var(--txt2);margin-bottom:.5rem;">${monthLabel}</div>
        <div style="font-size:11px;color:var(--txt2);margin-bottom:.6rem;">Not set</div>
        <button class="sal-edit-btn" data-month="${monthKey}" style="width:100%;padding:6px;
          background:var(--a1);color:#fff;border:none;border-radius:7px;font-size:11.5px;font-weight:600;cursor:pointer;">
          + Set Salary
        </button>
      </div>`;
  }

  const { record, inherited } = effective;
  return `
    <div style="background:var(--surface1);border:1px solid ${inherited ? 'var(--border)' : 'rgba(79,142,247,0.45)'};
      border-radius:12px;padding:.85rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.55rem;gap:6px;">
        <span style="font-size:11.5px;font-weight:700;color:var(--txt1);">${monthLabel}</span>
        ${inherited
          ? `<span style="font-size:9px;color:var(--txt2);background:var(--surface2);border-radius:10px;
              padding:1px 7px;white-space:nowrap;" title="Carried forward from ${fmtSalMonth(record.month)}">↳ inherited</span>`
          : `<span style="font-size:9px;color:var(--a1);background:rgba(79,142,247,0.12);border-radius:10px;
              padding:1px 7px;white-space:nowrap;">✏ set here</span>`}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:.65rem;">
        <div><div class="sal-field-label">LPA</div><div class="sal-field-val">${fmtRupeesSal(record.lpa)}</div></div>
        <div><div class="sal-field-label">Monthly</div><div class="sal-field-val">${fmtRupeesSal(record.monthly)}</div></div>
        <div>
          <div class="sal-field-label">Hourly</div>
          <div class="sal-field-val">${fmtRupeesSal(record.hourly)}</div>
          ${record.workHours ? `<div style="font-size:9px;color:var(--txt2);">@ ${record.workHours}h/day</div>` : ''}
        </div>
        <div><div class="sal-field-label">Points (X)</div><div class="sal-field-val">${record.points || record.points === 0 ? record.points : '—'}</div></div>
      </div>
      <button class="sal-edit-btn" data-month="${monthKey}" style="width:100%;padding:6px;
        background:none;border:1px solid var(--border-md);color:var(--txt2);border-radius:7px;
        font-size:11px;font-weight:600;cursor:pointer;">
        ✏️ Edit ${esc(monthShort)}
      </button>
    </div>`;
}

// ── CARRY-FORWARD RESOLUTION ────────────────────────────────────
// Returns { record, inherited } for the most recent explicit entry
// at or before monthKey, or null if nothing has ever been set for
// this employee up to that point. Nothing is stored for inherited
// months — this is computed fresh every time, so a later edit to an
// earlier month can never silently be undone by stale duplicate rows.
function getEffectiveSalary(empId, monthKey) {
  const recs = SAL_RECORDS
    .filter(r => r.empId === empId && r.month <= monthKey)
    .sort((a, b) => b.month.localeCompare(a.month));
  if (!recs.length) return null;
  const record = recs[0];
  // SalaryPivotView returns one record per month it has ever touched
  // (dense, carry-forward values already baked in), so "inherited"
  // now comes from the backend's explicit flag rather than a month
  // comparison — a record can be for the exact requested month and
  // still be inherited if that month was never itself edited.
  const inherited = record.month === monthKey ? !record.explicit : true;
  return { record, inherited };
}

// ── EDITOR MODAL ──────────────────────────────────────────────
function openSalaryEditor(content, emp, monthKey) {
  const effective  = getEffectiveSalary(emp.id, monthKey);
  const monthLabel = new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const cur = effective ? effective.record : { lpa: '', monthly: '', hourly: '', points: '', workHours: '' };

  const overlay = document.createElement('div');
  overlay.className = 'sal-modal-overlay';
  overlay.innerHTML = `
    <div class="sal-modal">
      <div style="font-weight:700;font-size:15px;color:var(--txt1);margin-bottom:2px;">💼 Set Salary — ${esc(emp.name)}</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:6px;">${monthLabel}</div>
      <div style="font-size:11px;color:var(--txt2);background:var(--surface2);border-radius:7px;padding:6px 9px;margin-bottom:6px;">
        This applies to ${monthLabel} and automatically carries forward to every month after it, until changed again. Earlier months are never affected.
      </div>

      <label class="sal-flabel">LPA (₹ / year)</label>
      <input class="sal-finput" id="salLpa" type="number" min="0" step="1000" value="${cur.lpa || ''}" placeholder="e.g. 900000"/>

      <label class="sal-flabel">Monthly Salary (₹) <span style="font-weight:400;color:var(--txt2);">— auto: LPA ÷ 12</span></label>
      <input class="sal-finput" id="salMonthly" type="number" min="0" step="100" value="${cur.monthly || ''}" placeholder="e.g. 75000"/>

      <label class="sal-flabel">Working Hours / Day</label>
      <input class="sal-finput" id="salWorkHours" type="number" min="1" max="24" step="0.5" value="${cur.workHours || ''}" placeholder="e.g. 8"/>
      <div style="font-size:10px;color:var(--txt2);margin-top:3px;">Varies per person — some work 8h, some 9h or 10h/day. Used to work out this person's hourly rate.</div>

      <label class="sal-flabel">Hourly Rate (₹) <span style="font-weight:400;color:var(--txt2);">— auto: Monthly ÷ 30 ÷ Hours/day</span></label>
      <input class="sal-finput" id="salHourly" type="number" min="0" step="1" value="${cur.hourly || ''}" placeholder="e.g. 277"/>

      <label class="sal-flabel">Points (X)</label>
      <input class="sal-finput" id="salPoints" type="number" min="0" step="0.1" value="${cur.points ?? ''}" placeholder="e.g. 1.2"/>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="salModalCancel" class="sal-btn-ghost">Cancel</button>
        <button id="salModalSave" class="sal-btn-primary">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const lpaEl       = overlay.querySelector('#salLpa');
  const monthlyEl   = overlay.querySelector('#salMonthly');
  const workHoursEl = overlay.querySelector('#salWorkHours');
  const hourlyEl    = overlay.querySelector('#salHourly');

  // Monthly = LPA ÷ 12, recomputed live whenever LPA changes.
  // Manually typing into Monthly still works — it just gets
  // recalculated again the next time LPA is edited.
  function recomputeMonthlyFromLpa() {
    const lpa = parseFloat(lpaEl.value);
    if (lpa > 0) monthlyEl.value = Math.round(lpa / 12);
    recomputeHourly();
  }

  // Hourly = (Monthly ÷ 30) ÷ Working Hours/Day — recomputed whenever
  // either Monthly or Working Hours/Day changes, since hours/day is
  // different per employee.
  function recomputeHourly() {
    const monthly   = parseFloat(monthlyEl.value);
    const workHours = parseFloat(workHoursEl.value);
    if (monthly > 0 && workHours > 0) {
      hourlyEl.value = Math.round((monthly / 30) / workHours);
    }
  }

  lpaEl.addEventListener('input', recomputeMonthlyFromLpa);
  monthlyEl.addEventListener('input', recomputeHourly);
  workHoursEl.addEventListener('input', recomputeHourly);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#salModalCancel').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#salModalSave').addEventListener('click', async () => {
    const lpa       = parseFloat(lpaEl.value)       || 0;
    const monthly   = parseFloat(monthlyEl.value)   || 0;
    const workHours = parseFloat(workHoursEl.value) || 0;
    const hourly    = parseFloat(hourlyEl.value)    || 0;
    const points    = parseFloat(overlay.querySelector('#salPoints').value) || 0;

    if (!lpa && !monthly && !hourly && !points) {
      toast?.('e', 'Nothing to save', 'Enter at least one value.');
      return;
    }

    const btn = overlay.querySelector('#salModalSave');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      await sheetGET({
        action: 'saveSalaryMonth',
        data: encodeURIComponent(JSON.stringify({
          empId: emp.id, empName: emp.name, month: monthKey,
          lpa, monthly, hourly, points, workHours,
        })),
      });

      // Upsert into the local cache so the grid updates immediately —
      // this month only; every later month recomputes via carry-forward.
      const idx = SAL_RECORDS.findIndex(r => r.empId === emp.id && r.month === monthKey);
      const newRec = { empId: emp.id, empName: emp.name, month: monthKey, lpa, monthly, hourly, points, workHours, updatedAt: new Date().toISOString() };
      if (idx >= 0) SAL_RECORDS[idx] = newRec; else SAL_RECORDS.push(newRec);

      toast?.('s', 'Salary saved', `${monthLabel} updated for ${emp.name} — carries forward automatically.`);
      overlay.remove();
      renderSalTimeline(content);
    } catch(err) {
      btn.disabled = false;
      btn.textContent = 'Save';
      toast?.('e', 'Save failed', err.message);
    }
  });
}

// ── HELPERS ───────────────────────────────────────────────────
function fmtRupeesSal(v) {
  const n = parseFloat(v) || 0;
  if (!n) return '—';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function fmtSalMonth(monthKey) {
  return new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

// ── DEFENSIVE OVERRIDE ──────────────────────────────────────────
// manager.js also defines its own (older, simpler) global
// renderSalaryTab(content). In plain <script> tags (no modules),
// whichever declaration executes LAST wins — so if salary.js
// happens to be included BEFORE manager.js in the page's script
// list, manager.js's version would silently take over and this
// entire file would appear to do nothing (exactly the symptom of
// "nothing changed in the Salary tab").
//
// This block removes that footgun: it captures THIS file's
// renderSalaryTab and re-installs it as window.renderSalaryTab
// once every <script> on the page has finished executing (on
// DOMContentLoaded), which happens after manager.js runs no matter
// which order the two <script> tags are in. If DOMContentLoaded has
// already fired by the time this file loads, it re-installs
// immediately instead.
(function forceSalaryTabOverride() {
  const thisRenderSalaryTab = renderSalaryTab;
  const install = () => {
    window.renderSalaryTab = thisRenderSalaryTab;
    console.log('[salary.js] renderSalaryTab override active — master salary database UI is live.');
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();