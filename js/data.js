// ═══════════════════════════════════════════════════
// DATA.JS — fallback / DEMO_MODE master data
//
// EMPLOYEES, CLIENTS, PROJECTS: only used in DEMO_MODE,
// or as a brief fallback before the live Sheet data arrives.
//
// In live mode (CONFIG.DEMO_MODE = false), all three lists
// are OVERWRITTEN at login time with fresh data fetched from
// the Employees / Clients / Projects sheets via apiGetMasterData().
// You do NOT need to keep these in sync with the Sheet —
// editing the Sheet is enough, the app mirrors it automatically.
//
// These arrays use `let` (not `const`) specifically so Auth.js
// can reassign them after fetching live data. Do not change
// them back to `const`.
// ═══════════════════════════════════════════════════

// ── EMPLOYEES (fallback only — Sheet is the source of truth) ──
let EMPLOYEES = [
  {id:'E01', name:'Amarnath',     team:'3D',                 pw:'pass123'},
  {id:'E02', name:'Joseph',       team:'Design',             pw:'pass124'},
  {id:'E03', name:'Madhumitha',   team:'3D',                 pw:'pass125'},
  {id:'E04', name:'Balaji',       team:'Development',        pw:'pass126'},
  {id:'E05', name:'Soloman',      team:'QA',                 pw:'pass127'},
  {id:'E06', name:'Imran',        team:'Project Management', pw:'pass128'},
  {id:'E07', name:'Shiju',        team:'Development',        pw:'pass129'},
  {id:'E08', name:'minmini',      team:'3D',                 pw:'pass130'},
  {id:'E09', name:'radhakrishna', team:'Design',             pw:'pass131'},
  {id:'E10', name:'VijayManoj',   team:'3D',                 pw:'pass132'},
];

// ── CLIENTS (fallback only — Sheet is the source of truth) ─────
let CLIENTS = [
  {id:'C01', name:'Brigade Group'},
  {id:'C02', name:'Prestige Estates'},
  {id:'C03', name:'Godrej Properties'},
  {id:'C04', name:'Sobha Developers'},
  {id:'C05', name:'Internal Projects'},
];

// ── PROJECTS (fallback only — Sheet is the source of truth) ────
// cid must match a Client ID above
let PROJECTS = [
  {id:'P01', cid:'C01', name:'Raptakose Luxury Residences'},
  {id:'P02', cid:'C01', name:'Brigade Stellar Phase 2'},
  {id:'P03', cid:'C01', name:'Brigade Northridge VR Tour'},
  {id:'P04', cid:'C02', name:'Prestige Meridian AR App'},
  {id:'P05', cid:'C02', name:'Prestige Shantiniketan Tour'},
  {id:'P06', cid:'C03', name:'Godrej Horizon 3D Render'},
  {id:'P07', cid:'C03', name:'Godrej E-City WebXR'},
  {id:'P08', cid:'C04', name:'Sobha Dream Acres Portal'},
  {id:'P09', cid:'C05', name:'Internal Tooling Suite'},
  {id:'P10', cid:'C05', name:'R&D WebXR Framework'},
];