// ═══════════════════════════════════════════════════
// AUTH.JS — Employee + Manager login support
// ═══════════════════════════════════════════════════

let USER           = null;
let LIVE_EMPLOYEES = [];
let MANAGER_MODE   = false;

async function initLogin() {
  console.log('[AUTH] initLogin | DEMO_MODE:', CONFIG.DEMO_MODE);
  await loadEmployeesAndRenderLogin();

  // Restore session
  try {
    const s = sessionStorage.getItem(CONFIG.LS_SESSION);
    if (s) {
      const u = JSON.parse(s);
      if (u?.id) {
        if (u.role === 'manager') loginAsManager(u, true);
        else loginAs(u, true);
      }
    }
  } catch(e) {
    console.error('[AUTH] Session restore failed:', e.message);
  }
}

async function loadEmployeesAndRenderLogin() {
  const empSel = $('lemp');
  const tabs   = $('etabs');
  const errBox = $('empLoadErr');

  if (errBox) errBox.classList.remove('show');
  empSel.innerHTML = '<option value="">— Select your name —</option>';
  tabs.innerHTML   = '';

  if (CONFIG.DEMO_MODE) {
    LIVE_EMPLOYEES = EMPLOYEES;
  } else {
    try {
      const master   = await apiGetMasterData();
      LIVE_EMPLOYEES = master.employees || [];
      if (Array.isArray(master.clients)  && master.clients.length  > 0) CLIENTS  = master.clients;
      if (Array.isArray(master.projects) && master.projects.length > 0) PROJECTS = master.projects;
      if (LIVE_EMPLOYEES.length === 0) throw new Error('Employees sheet returned 0 rows.');
    } catch(e) {
      console.error('[AUTH] Failed to load from Sheet:', e.message);
      LIVE_EMPLOYEES = [];
      showEmployeeLoadError(e.message);
      return;
    }
  }

  renderEmployeeDropdown();
}

function showEmployeeLoadError(msg) {
  const errBox = $('empLoadErr');
  if (errBox) {
    errBox.classList.add('show');
    errBox.innerHTML = `
      <span>⚠️ Couldn't load employee list: ${esc(msg)}</span>
      <button type="button" class="btn bghost" id="empRetryBtn" style="margin-top:.5rem">↻ Retry</button>`;
    $('empRetryBtn').onclick = () => loadEmployeesAndRenderLogin();
  }
  toast('e', 'Could not load employees', msg, 8000);
}

function renderEmployeeDropdown() {
  const empSel = $('lemp');
  const tabs   = $('etabs');

  // Add Manager option at top
  const mgrOpt = document.createElement('option');
  mgrOpt.value       = CONFIG.MANAGER_ID || 'MGR';
  mgrOpt.textContent = '🔑 Manager';
  empSel.appendChild(mgrOpt);

  LIVE_EMPLOYEES.forEach(e => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.name;
    empSel.appendChild(o);
  });

  // Quick tabs (first 5 employees)
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

  empSel.onchange = () => {
    const id  = empSel.value;
    const emp = LIVE_EMPLOYEES.find(e => e.id === id);
    const pill = $('idpill'), txt = $('idtxt');
    if (id === (CONFIG.MANAGER_ID || 'MGR')) {
      txt.textContent = 'Manager Access';
      pill.classList.add('show');
    } else if (emp) {
      txt.textContent = `${emp.id} · ${emp.team}`;
      pill.classList.add('show');
    } else {
      pill.classList.remove('show');
    }
    tabs.querySelectorAll('.etab').forEach(b => b.classList.toggle('on', b.dataset.id === id));
    $('lerr').classList.remove('show');
  };

  $('pwt').onclick = () => {
    const pw = $('lpw'), s = pw.type === 'text';
    pw.type = s ? 'password' : 'text';
    $('eshow').style.display = s ? 'block' : 'none';
    $('ehide').style.display = s ? 'none'  : 'block';
  };

  $('lform').onsubmit = async ev => {
    ev.preventDefault();
    const id  = empSel.value;
    const pw  = $('lpw').value;
    const err = $('lerr'), msg = $('lerrmsg'), btn = $('lbtn');
    err.classList.remove('show');

    if (!id) { msg.textContent = 'Please select your name.'; err.classList.add('show'); return; }
    if (!pw) { msg.textContent = 'Please enter your password.'; err.classList.add('show'); return; }

    btn.classList.add('ld'); btn.disabled = true;
    try {
      // Manager login check
      if (id === (CONFIG.MANAGER_ID || 'MGR')) {
        if (pw !== CONFIG.MANAGER_PW) throw new Error('Wrong manager password.');
        loginAsManager({ id: 'MGR', name: 'Manager', team: 'Management', role: 'manager' });
        return;
      }
      const user = await apiLogin(id, pw);
      loginAs(user);
    } catch(e) {
      msg.textContent = e.message || 'Login failed.';
      err.classList.add('show');
      $('lpw').value = ''; $('lpw').focus();
    } finally {
      btn.classList.remove('ld'); btn.disabled = false;
    }
  };
}

// ── EMPLOYEE LOGIN ────────────────────────────────
async function loginAs(emp, silent = false) {
  MANAGER_MODE = false;
  USER = emp;
  sessionStorage.setItem(CONFIG.LS_SESSION, JSON.stringify(emp));

  const av = $('av'), wn = $('wn'), wt = $('wt');
  if (av) av.textContent = emp.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  if (wn) wn.textContent = emp.name;
  if (wt) wt.textContent = `${emp.team} · ${emp.id}`;

  $('login').classList.add('gone');
  $('mgrPortal').classList.remove('on');
  $('app').classList.add('on');

  ENTRIES = await apiLoadEntries(emp.id);
  initForm();
  refreshStats();
  refreshFilters();
  refreshTable();
  refreshChart();

  if (!silent) toast('s', `Welcome back, ${emp.name.split(' ')[0]}! 👋`, emp.team);
}

// ── MANAGER LOGIN ─────────────────────────────────
async function loginAsManager(emp, silent = false) {
  MANAGER_MODE = true;
  USER = emp;
  sessionStorage.setItem(CONFIG.LS_SESSION, JSON.stringify({ ...emp, role: 'manager' }));

  const av = $('mgrAv');
  if (av) av.textContent = 'M';
  const mn = $('mgrName');
  if (mn) mn.textContent = emp.name;
  const mt = $('mgrTeam');
  if (mt) mt.textContent = 'Manager Portal';

  $('login').classList.add('gone');
  $('app').classList.remove('on');
  $('mgrPortal').classList.add('on');

  if (!silent) toast('s', `Welcome, Manager! 👋`, 'Manager Portal');
  initManager();
}

// ── LOGOUT ───────────────────────────────────────
function logout() {
  sessionStorage.removeItem(CONFIG.LS_SESSION);
  USER = null; ENTRIES = []; MANAGER_MODE = false;

  $('app').classList.remove('on');
  $('mgrPortal').classList.remove('on');
  $('login').classList.remove('gone');
  $('lemp').value = ''; $('lpw').value = '';
  $('idpill').classList.remove('show');
  $('lerr').classList.remove('show');
  $('etabs').querySelectorAll('.etab').forEach(b => b.classList.remove('on'));
}