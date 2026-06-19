// ═══════════════════════════════════════════════════
// AUTH.JS — with temporary console debug logs
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// AUTH.JS — Employees sheet is mirrored live on every load
// No caching, no silent fallback to old hardcoded data.
// If the Sheet can't be reached, the user sees a clear
// error and a Retry button — never stale/wrong names.
// ═══════════════════════════════════════════════════

let USER = null;
let LIVE_EMPLOYEES = [];

async function initLogin() {
  console.log('[AUTH] initLogin | DEMO_MODE:', CONFIG.DEMO_MODE);
  console.log('[AUTH] SHEETS_URL:', CONFIG.SHEETS_URL);

  await loadEmployeesAndRenderLogin();

  // Restore session
  try {
    const s = sessionStorage.getItem(CONFIG.LS_SESSION);
    if (s) {
      const u = JSON.parse(s);
      console.log('[AUTH] Restoring session:', u);
      if (u?.id) loginAs(u, true);
    }
  } catch(e) {
    console.error('[AUTH] Session restore failed:', e.message);
  }
}

// ── LOAD EMPLOYEES FROM SHEET (always fresh, no cache) ───────
async function loadEmployeesAndRenderLogin() {
  const empSel = $('lemp');
  const tabs   = $('etabs');
  const errBox = $('empLoadErr');

  if (errBox) errBox.classList.remove('show');
  empSel.innerHTML = '<option value="">— Select your name —</option>';
  tabs.innerHTML = '';

  if (CONFIG.DEMO_MODE) {
    LIVE_EMPLOYEES = EMPLOYEES;
    console.log('[AUTH] DEMO_MODE — using data.js employees/clients/projects');
  } else {
    try {
      console.log('[AUTH] Fetching employees + clients + projects from Google Sheet...');
      const master   = await apiGetMasterData();
      LIVE_EMPLOYEES = master.employees || [];

      // Mirror Clients and Projects live too — overwrite the
      // Data.js fallback arrays so the rest of the app (Form.js
      // dropdowns) automatically sees fresh Sheet data.
      if (Array.isArray(master.clients) && master.clients.length > 0) {
        CLIENTS = master.clients;
        console.log('[AUTH] Sheet clients loaded:', CLIENTS.length);
      } else {
        console.warn('[AUTH] No clients returned from Sheet — keeping fallback list.');
      }

      if (Array.isArray(master.projects) && master.projects.length > 0) {
        PROJECTS = master.projects;
        console.log('[AUTH] Sheet projects loaded:', PROJECTS.length);
      } else {
        console.warn('[AUTH] No projects returned from Sheet — keeping fallback list.');
      }

      console.log('[AUTH] Sheet employees loaded:', LIVE_EMPLOYEES.length, LIVE_EMPLOYEES);

      if (LIVE_EMPLOYEES.length === 0) {
        throw new Error('Employees sheet returned 0 rows.');
      }
    } catch(e) {
      console.error('[AUTH] Failed to load from Sheet:', e.message);
      LIVE_EMPLOYEES = [];
      showEmployeeLoadError(e.message);
      return; // do NOT fall back to stale Data.js — show error instead
    }
  }

  renderEmployeeDropdown();
}

// ── ERROR STATE — loud, with retry, never silent fallback ────
function showEmployeeLoadError(msg) {
  const errBox = $('empLoadErr');
  if (errBox) {
    errBox.classList.add('show');
    errBox.innerHTML = `
      <span>⚠️ Couldn't load employee list from Sheet: ${esc(msg)}</span>
      <button type="button" class="btn bghost" id="empRetryBtn" style="margin-top:.5rem">
        ↻ Retry
      </button>`;
    $('empRetryBtn').onclick = () => loadEmployeesAndRenderLogin();
  }
  toast('e', 'Could not load employees', msg, 8000);
}

// ── RENDER DROPDOWN + QUICK TABS ──────────────────────────────
function renderEmployeeDropdown() {
  const empSel = $('lemp');
  const tabs   = $('etabs');

  LIVE_EMPLOYEES.forEach(e => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.name;
    empSel.appendChild(o);
  });

  // Quick tabs (first 5)
  LIVE_EMPLOYEES.slice(0, 5).forEach(e => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'etab'; b.dataset.id = e.id;
    b.textContent = e.name.split(' ')[0];
    b.onclick = () => {
      empSel.value = e.id;
      empSel.dispatchEvent(new Event('change'));
      $('lpw').focus();
    };
    tabs.appendChild(b);
  });
  if (LIVE_EMPLOYEES.length > 5) {
    const m = document.createElement('button');
    m.type = 'button'; m.className = 'etab'; m.textContent = 'More ▾';
    m.onclick = () => empSel.focus();
    tabs.appendChild(m);
  }

  // Employee select → show ID pill
  empSel.onchange = () => {
    const id  = empSel.value;
    const emp = LIVE_EMPLOYEES.find(e => e.id === id);
    console.log('[AUTH] Selected employee:', emp);
    const pill = $('idpill'), txt = $('idtxt');
    if (emp) {
      txt.textContent = `${emp.id} · ${emp.team}`;
      pill.classList.add('show');
    } else {
      pill.classList.remove('show');
    }
    tabs.querySelectorAll('.etab').forEach(b => b.classList.toggle('on', b.dataset.id === id));
    $('lerr').classList.remove('show');
  };

  // Password show/hide
  $('pwt').onclick = () => {
    const pw = $('lpw'), s = pw.type === 'text';
    pw.type = s ? 'password' : 'text';
    $('eshow').style.display = s ? 'block' : 'none';
    $('ehide').style.display = s ? 'none'  : 'block';
  };

  // Form submit
  $('lform').onsubmit = async ev => {
    ev.preventDefault();
    const id  = empSel.value;
    const pw  = $('lpw').value;
    const err = $('lerr'), msg = $('lerrmsg'), btn = $('lbtn');
    err.classList.remove('show');

    console.log('[AUTH] Login attempt | id:', id, '| pw length:', pw.length);

    if (!id) { msg.textContent = 'Please select your name.'; err.classList.add('show'); return; }
    if (!pw) { msg.textContent = 'Please enter your password.'; err.classList.add('show'); return; }

    btn.classList.add('ld'); btn.disabled = true;
    try {
      const user = await apiLogin(id, pw);
      console.log('[AUTH] Login success:', user);
      loginAs(user);
    } catch(e) {
      console.error('[AUTH] Login failed:', e.message);
      msg.textContent = e.message || 'Login failed.';
      err.classList.add('show');
      $('lpw').value = ''; $('lpw').focus();
    } finally {
      btn.classList.remove('ld'); btn.disabled = false;
    }
  };
}

async function loginAs(emp, silent = false) {
  console.log('[AUTH] loginAs:', emp);
  USER = emp;
  sessionStorage.setItem(CONFIG.LS_SESSION, JSON.stringify(emp));

  const av = $('av'), wn = $('wn'), wt = $('wt');
  if (av) av.textContent = emp.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  if (wn) wn.textContent = emp.name;
  if (wt) wt.textContent = `${emp.team} · ${emp.id}`;

  $('login').classList.add('gone');
  $('app').classList.add('on');

  console.log('[AUTH] Loading entries for:', emp.id);
  ENTRIES = await apiLoadEntries(emp.id);
  console.log('[AUTH] Entries loaded:', ENTRIES.length);

  initForm();
  refreshStats();
  refreshFilters();
  refreshTable();
  refreshChart();

  if (!silent) toast('s', `Welcome back, ${emp.name.split(' ')[0]}! 👋`, emp.team);
}

function logout() {
  console.log('[AUTH] logout');
  sessionStorage.removeItem(CONFIG.LS_SESSION);
  USER = null; ENTRIES = [];
  $('app').classList.remove('on');
  $('login').classList.remove('gone');
  $('lemp').value = ''; $('lpw').value = '';
  $('idpill').classList.remove('show');
  $('lerr').classList.remove('show');
  $('etabs').querySelectorAll('.etab').forEach(b => b.classList.remove('on'));
}