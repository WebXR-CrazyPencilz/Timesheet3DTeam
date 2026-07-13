// ═══════════════════════════════════════════════════
// CONFIG.JS — toggle between demo and live Google Sheets
// ═══════════════════════════════════════════════════

const CONFIG = {
  SHEETS_URL: 'https://script.google.com/macros/s/AKfycbxD_sPwoF0A8GEzDtRPTxKHAKfW3Exrfkc-8R3URf8qBHT_QrncXAjqnEtxDTUwOE6iVQ/exec',

  DEMO_MODE: false,

  DEMO_PW:   'pass123',
  LS_THEME:  'tt_thm',
  LS_SESSION:'tt_sess',
  PAGE_SIZE: 20,

  // ── Role credentials ──────────────────────────
  MANAGER_ID: 'MGR',
  MANAGER_PW: 'lkjhgfdsa',

  // Two Team Leader accounts — each is its own login ID/password/
  // display name, since there are 2 people acting as Team Leader.
  // Add, remove, or edit entries here directly (same pattern as
  // MANAGER_ID/MANAGER_PW above — there's no sheet-backed account
  // system for these two roles, just constants here).
  TEAM_LEADERS: [
    { id: 'TL1', pw: 'teamlead123', name: 'Team Leader 1' },
    { id: 'TL2', pw: 'teamlead456', name: 'Team Leader 2' },
  ],

  // ── App settings ──────────────────────────────
  CURRENCY:        '₹',
  OFFICE_START:    '09:30',
  LUNCH_MINS:      45,
  EXTENDED_START:  '19:30',
};