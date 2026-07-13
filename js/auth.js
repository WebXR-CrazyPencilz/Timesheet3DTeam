// ═══════════════════════════════════════════════════
// AUTH.JS — Employee + Manager + Team Leader login
// ═══════════════════════════════════════════════════

let USER           = null;
let LIVE_EMPLOYEES = [];
let MANAGER_MODE   = false;
let TL_MODE        = false;

async function initLogin() {
  console.log('[AUTH] initLogin | DEMO_MODE:', CONFIG.DEMO_MODE);
  await loadEmployeesAndRenderLogin();

  // Restore session
  try {
    const s = sessionStorage.getItem(CONFIG.LS_SESSION);
    if (s) {
      const u = JSON.parse(s);
      if (u?.id) {
        if (u.role === 'manager')    loginAsManager(u, true);
        else if (u.role === 'tl')    loginAsTL(u, true);
        else                         loginAs(u, true);
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

// Every configured Team Leader account, e.g.
// [{id:'TL1',pw:'...',name:'Team Leader 1'}, {id:'TL2',...}].
// Centralized here so the dropdown, the quick-tabs, and the login
// submit handler all read from the same single list — add or remove
// a Team Leader in CONFIG.TEAM_LEADERS and every part of the login
// screen picks it up automatically, nothing else needs editing.
function getTeamLeaderAccounts() {
  return Array.isArray(CONFIG.TEAM_LEADERS) && CONFIG.TEAM_LEADERS.length
    ? CONFIG.TEAM_LEADERS
    : [{ id: CONFIG.TL_ID || 'TL', pw: CONFIG.TL_PW || 'teamlead123', name: 'Team Leader' }]; // fallback for old single-TL config
}

function renderEmployeeDropdown() {
  const empSel = $('lemp');
  const tabs   = $('etabs');

  // Add Manager option at top
  const mgrOpt = document.createElement('option');
  mgrOpt.value = CONFIG.MANAGER_ID || 'MGR';
  mgrOpt.textContent = '🔑 Manager';
  empSel.appendChild(mgrOpt);

  // Add one option per configured Team Leader account
  getTeamLeaderAccounts().forEach(tl => {
    const tlOpt = document.createElement('option');
    tlOpt.value = tl.id;
    tlOpt.textContent = `👥 ${tl.name}`;
    empSel.appendChild(tlOpt);
  });

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
    const tl  = getTeamLeaderAccounts().find(t => t.id === id);
    const pill = $('idpill'), txt = $('idtxt');
    if (id === (CONFIG.MANAGER_ID || 'MGR')) {
      txt.textContent = 'Manager Access';
      pill.classList.add('show');
    } else if (tl) {
      txt.textContent = `${tl.name} Access`;
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
      // Manager login
      if (id === (CONFIG.MANAGER_ID || 'MGR')) {
        if (pw !== CONFIG.MANAGER_PW) throw new Error('Wrong manager password.');
        loginAsManager({ id: 'MGR', name: 'Manager', team: 'Management', role: 'manager' });
        return;
      }
      // Team Leader login — matched by whichever configured account
      // this dropdown selection corresponds to.
      const tlAccount = getTeamLeaderAccounts().find(t => t.id === id);
      if (tlAccount) {
        if (pw !== tlAccount.pw) throw new Error('Wrong team leader password.');
        loginAsTL({ id: tlAccount.id, name: tlAccount.name, team: 'All Teams', role: 'tl' });
        return;
      }
      // Employee login
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
  TL_MODE      = false;
  USER = emp;
  sessionStorage.setItem(CONFIG.LS_SESSION, JSON.stringify(emp));

  const av = $('av'), wn = $('wn'), wt = $('wt');
  if (av) av.textContent = emp.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  if (wn) wn.textContent = emp.name;
  if (wt) wt.textContent = `${emp.team} · ${emp.id}`;

  $('login').classList.add('gone');
  $('mgrPortal').classList.remove('on');
  $('tlPortal')?.classList.remove('on');
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
  TL_MODE      = false;
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
  $('tlPortal')?.classList.remove('on');
  $('mgrPortal').classList.add('on');

  if (!silent) toast('s', `Welcome, Manager! 👋`, 'Manager Portal');
  initManager();
}

// ── TEAM LEADER LOGIN ─────────────────────────────
async function loginAsTL(emp, silent = false) {
  MANAGER_MODE = false;
  TL_MODE      = true;
  USER = emp;
  sessionStorage.setItem(CONFIG.LS_SESSION, JSON.stringify({ ...emp, role: 'tl' }));

  // Initials from the Team Leader's actual configured name (e.g.
  // "Team Leader 1" -> "TL", or a real name like "Priya Kumar" -> "PK")
  // instead of a hardcoded "TL" — so two different Team Leaders show
  // distinct avatars if given real names in CONFIG.TEAM_LEADERS.
  const initials = emp.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'TL';

  const av = $('tlAv');
  if (av) av.textContent = initials;
  const tn = $('tlName');
  if (tn) tn.textContent = emp.name;
  const tt = $('tlTeam');
  if (tt) tt.textContent = 'Team Leader Portal';

  $('login').classList.add('gone');
  $('app').classList.remove('on');
  $('mgrPortal').classList.remove('on');
  $('tlPortal').classList.add('on');

  if (!silent) toast('s', `Welcome, ${emp.name}! 👋`, 'Team Leader Portal');
  initTeamLeader();
}

// ── LOGOUT ────────────────────────────────────────
function logout() {
  sessionStorage.removeItem(CONFIG.LS_SESSION);
  USER = null; ENTRIES = []; MANAGER_MODE = false; TL_MODE = false;

  $('app').classList.remove('on');
  $('mgrPortal').classList.remove('on');
  $('tlPortal')?.classList.remove('on');
  $('login').classList.remove('gone');
  $('lemp').value = ''; $('lpw').value = '';
  $('idpill').classList.remove('show');
  $('lerr').classList.remove('show');
  $('etabs').querySelectorAll('.etab').forEach(b => b.classList.remove('on'));
}