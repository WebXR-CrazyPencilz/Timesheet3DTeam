// ═══════════════════════════════════════════════════════════════
// PORTAL-DATA.JS — Master data layer for all portals
// Used by: manager.js, teamleader.js, humanresource.js
// Single source of truth — all API calls go through here
// ═══════════════════════════════════════════════════════════════

const PORTAL_DATA = {
  // ── Raw data from Sheets ──────────────────────────────────
  employees:      [],   // [{ id, name, team }]
  clients:        [],   // [{ id, name }]
  projects:       [],   // [{ id, cid, name }]
  entries:        [],   // all time entries across all employees
  clientFinance:  [],   // [{ clientId, estimateCost, receivedAmount, ... }]
  projectDetails: [],   // [{ projectId, estimateHours, estimateCost, ... }]
  salaries:       [],   // [{ empId, type, amount }]

  // ── Load state ────────────────────────────────────────────
  loaded:  false,
  loading: false,
};

// ── LOAD ALL DATA ─────────────────────────────────────────────
async function loadPortalData(onProgress) {
  if (PORTAL_DATA.loading) return;
  PORTAL_DATA.loading = true;

  try {
    onProgress?.('Loading master data…');

    // 1. Master data (employees, clients, projects)
    const master = await apiGetMasterData();
    PORTAL_DATA.employees = master.employees || [];
    PORTAL_DATA.clients   = master.clients   || [];
    PORTAL_DATA.projects  = master.projects  || [];

    // 2. All employee time entries in parallel
    onProgress?.('Loading employee timesheets…');
    const results = await Promise.all(
      PORTAL_DATA.employees.map(emp =>
        apiGetAllHistory(emp.id)
          .then(entries => entries.map(e => ({
            ...e,
            empId:   emp.id,
            empName: emp.name,
            empTeam: emp.team,
          })))
          .catch(() => [])
      )
    );
    PORTAL_DATA.entries = results.flat();

    // 3. Finance data (client costs, project details, salaries)
    onProgress?.('Loading financial data…');
    try {
      const finance = await sheetGET({ action: 'getFinanceData' });
      PORTAL_DATA.clientFinance  = finance.clientFinance  || [];
      PORTAL_DATA.projectDetails = finance.projectDetails || [];
      PORTAL_DATA.salaries       = finance.salaries       || [];
    } catch(e) {
      console.warn('[PortalData] Finance data not available yet:', e.message);
    }

    PORTAL_DATA.loaded  = true;
    PORTAL_DATA.loading = false;
    onProgress?.('Ready');
    return true;

  } catch(err) {
    PORTAL_DATA.loading = false;
    throw err;
  }
}

// ── RELOAD ────────────────────────────────────────────────────
async function reloadPortalData(onProgress) {
  PORTAL_DATA.loaded = false;
  return loadPortalData(onProgress);
}

// ── QUERY HELPERS (used by all portals) ──────────────────────

// Get entries filtered by date range
function getEntriesByRange(range, selectedMonth, dayOffset) {
  const tod = todayStr();
  const ws  = weekStart();

  if (range === 'day15') {
    const d = new Date();
    d.setDate(d.getDate() - (dayOffset || 0));
    const selected = d.toISOString().slice(0, 10);
    return PORTAL_DATA.entries.filter(e => e.date === selected);
  }
  if (range === 'week')  return PORTAL_DATA.entries.filter(e => e.date >= ws && e.date <= tod);
  if (range === 'month') return PORTAL_DATA.entries.filter(e => e.date.startsWith(selectedMonth || tod.slice(0,7)));
  return PORTAL_DATA.entries; // all time
}

// Get entries for a specific employee
function getEmpEntries(empId, range, selectedMonth, dayOffset) {
  return getEntriesByRange(range, selectedMonth, dayOffset)
    .filter(e => e.empId === empId);
}

// Get entries for a specific project
function getProjEntries(projectName, range, selectedMonth, dayOffset) {
  return getEntriesByRange(range, selectedMonth, dayOffset)
    .filter(e => e.project === projectName && e.status !== 'Leave');
}

// Get salary for an employee
function getEmpSalary(empId) {
  const key = String(empId).trim();
  return PORTAL_DATA.salaries.find(s => String(s['Employee ID']).trim() === key) || null;
}

// Get finance record for a client
function getClientFinance(clientId) {
  return PORTAL_DATA.clientFinance.find(f => f['Client ID'] === clientId) || null;
}

// Get project details
function getProjectDetail(projectId) {
  return PORTAL_DATA.projectDetails.find(p => p['Project ID'] === projectId) || null;
}

// Calculate total hours from entries array
function calcTotalHours(entries) {
  return entries
    .filter(e => e.status !== 'Leave')
    .reduce((s, e) => s + parsePortalHours(e.hours), 0);
}

// Parse "3h 30m" or decimal → number
function parsePortalHours(val) {
  if (!val) return 0;
  const s = String(val).trim();
  const h = (s.match(/(\d+)h/) || [])[1];
  const m = (s.match(/(\d+)m/) || [])[1];
  if (!h && !m) return parseFloat(s) || 0;
  return ((parseInt(h||0) * 60 + parseInt(m||0)) / 60);
}

// Format hours number → "3h 30m"
function fmtPortalHours(h) {
  const mins = Math.round(Number(h) * 60);
  const hr   = Math.floor(mins / 60);
  const mn   = mins % 60;
  if (hr === 0) return `${mn}m`;
  if (mn === 0) return `${hr}h`;
  return `${hr}h ${mn}m`;
}

// Format currency ₹
function fmtRupees(amount) {
  const n = parseFloat(amount) || 0;
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// Profit/loss color
function profitColor(estimate, received) {
  const e = parseFloat(estimate) || 0;
  const r = parseFloat(received) || 0;
  if (r > e)  return { color: '#34d399', label: 'Profit',     icon: '📈' };
  if (r < e)  return { color: '#f87171', label: 'Loss',       icon: '📉' };
  return        { color: '#fbbf24', label: 'Break-even', icon: '➖' };
}

// ── SAVE HELPERS ──────────────────────────────────────────────

async function saveClientFinance(data) {
  const result = await sheetGET({
    action: 'saveClientFinance',
    data:   encodeURIComponent(JSON.stringify(data)),
  });
  // Update local cache
  const idx = PORTAL_DATA.clientFinance.findIndex(f => f['Client ID'] === data.clientId);
  const record = {
    'Client ID': data.clientId, 'Client Name': data.clientName,
    'Estimate Cost': data.estimateCost, 'Received Amount': data.receivedAmount,
    'Start Date': data.startDate, 'End Date': data.endDate, 'Notes': data.notes,
  };
  if (idx >= 0) PORTAL_DATA.clientFinance[idx] = record;
  else PORTAL_DATA.clientFinance.push(record);
  return result;
}

async function saveProjectDetails(data) {
  const result = await sheetGET({
    action: 'saveProjectDetails',
    data:   encodeURIComponent(JSON.stringify(data)),
  });
  const idx = PORTAL_DATA.projectDetails.findIndex(p => p['Project ID'] === data.projectId);
  const record = {
    'Project ID': data.projectId, 'Client ID': data.clientId,
    'Project Name': data.projectName, 'Estimate Hours': data.estimateHours,
    'Estimate Cost': data.estimateCost, 'Resources': data.resources, 'Notes': data.notes,
  };
  if (idx >= 0) PORTAL_DATA.projectDetails[idx] = record;
  else PORTAL_DATA.projectDetails.push(record);
  return result;
}

async function saveSalaryData(data) {
  const result = await sheetGET({
    action: 'saveSalary',
    data:   encodeURIComponent(JSON.stringify(data)),
  });
  const idx = PORTAL_DATA.salaries.findIndex(s => s['Employee ID'] === data.empId);
  const record = {
    'Employee ID': data.empId, 'Employee Name': data.empName,
    'Type': data.type, 'Amount': data.amount, 'Effective Date': data.effectiveDate,
  };
  if (idx >= 0) PORTAL_DATA.salaries[idx] = record;
  else PORTAL_DATA.salaries.push(record);
  return result;
}

async function applyForceLeave(empId, date) {
  return sheetGET({
    action: 'forceLeave',
    data:   encodeURIComponent(JSON.stringify({ uid: empId, date })),
  });
}