// ═══════════════════════════════════════════════════
// CELEBRATION.JS — lightweight daily 9-hour celebration
//
// Fully self-contained and additive:
//   • Reads the existing global ENTRIES array and todayStr()/USER
//     that form.js/table.js already maintain — no new calculation
//     logic is introduced anywhere else, and nothing here writes
//     to Sheets, calls an API, or touches saveEntry/markLeave.
//   • The only integration point is a single observer call added to
//     the END of table.js's refreshStats() (which already runs after
//     every save and every date load) — refreshStats' own logic is
//     untouched, this just also asks "should we celebrate now?"
//     after it finishes.
//   • Triggers at most once per employee per calendar day per
//     browser session (sessionStorage-backed), so editing entries
//     after the celebration has already fired never replays it —
//     the guard is checked and set BEFORE any animation work starts.
// ═══════════════════════════════════════════════════

const CELEBRATION_THRESHOLD_HOURS = 9;
const CELEBRATION_SESSION_PREFIX  = 'tt_celebration_shown_';

// Call this after anything that might change today's total hours.
// Currently wired from table.js's refreshStats() only — see the
// single added line there. Safe to call as often as needed; it's a
// cheap read-only check.
function checkDailyCelebration() {
  if (typeof USER === 'undefined' || !USER || !USER.id) return;
  if (typeof ENTRIES === 'undefined' || !Array.isArray(ENTRIES)) return;
  if (typeof todayStr !== 'function') return;

  const today      = todayStr();
  const sessionKey = CELEBRATION_SESSION_PREFIX + USER.id + '_' + today;

  // Already celebrated today in this browser session — never
  // replay, including after later edits to already-saved entries.
  if (sessionStorage.getItem(sessionKey)) return;

  const todayHours = ENTRIES
    .filter(e => e.date === today && e.status !== 'Leave')
    .reduce((sum, e) => sum + (Number(e.hours) || 0), 0);

  if (todayHours >= CELEBRATION_THRESHOLD_HOURS) {
    // Mark as shown BEFORE animating, so a rapid double-call (e.g.
    // two quick saves) can never both pass the guard.
    sessionStorage.setItem(sessionKey, '1');
    showCelebrationOverlay();
  }
}

// ── OVERLAY ────────────────────────────────────────
function showCelebrationOverlay() {
  const DURATION   = 4500; // ms the overlay stays fully visible
  const FADE_MS    = 550;

  const overlay = document.createElement('div');
  overlay.id = 'celebrationOverlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    display:flex;align-items:center;justify-content:center;
    background:radial-gradient(circle at 50% 40%, rgba(24,24,40,.55), rgba(6,6,12,.78));
    backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);
    opacity:0;transition:opacity ${FADE_MS}ms ease;
    pointer-events:none;
  `;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  overlay.appendChild(canvas);

  const card = document.createElement('div');
  card.style.cssText = `
    position:relative;text-align:center;padding:30px 46px;
    background:linear-gradient(135deg, rgba(32,32,50,.92), rgba(18,18,32,.92));
    border:1px solid rgba(255,255,255,.10);
    border-radius:18px;
    box-shadow:0 24px 70px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03) inset;
    transform:scale(.86) translateY(12px);
    opacity:0;
    transition:transform .65s cubic-bezier(.16,1,.3,1), opacity .55s ease;
  `;
  card.innerHTML = `
    <div style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:.2px;margin-bottom:10px;
      text-shadow:0 2px 12px rgba(0,0,0,.35);">
      🎉 +100 XP Earned
    </div>
    <div style="font-size:15px;font-weight:600;color:#ffb454;letter-spacing:.2px;
      text-shadow:0 2px 10px rgba(0,0,0,.3);">
      🔥 Daily Streak Continues
    </div>
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    requestAnimationFrame(() => {
      card.style.opacity   = '1';
      card.style.transform = 'scale(1) translateY(0)';
    });
  });

  // ── Canvas: falling petals + firework bursts ──────
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let cw = 0, ch = 0;

  function resize() {
    cw = overlay.clientWidth;
    ch = overlay.clientHeight;
    canvas.width  = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width  = cw + 'px';
    canvas.style.height = ch + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  const PETAL_COLORS = ['#ff8fab', '#ffd166', '#a78bfa', '#4f8ef7', '#34d399', '#fb923c'];
  const BURST_COLORS = ['#ffd166', '#ff6b6b', '#4f8ef7', '#a78bfa', '#34d399', '#f472b6'];

  function makePetal() {
    return {
      x: Math.random() * cw,
      y: -20 - Math.random() * 220,
      size: 6 + Math.random() * 7,
      color: PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)],
      speedY: 1 + Math.random() * 1.6,
      speedX: (Math.random() - 0.5) * 1.2,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.06,
      sway: Math.random() * Math.PI * 2,
      opacity: 0.8 + Math.random() * 0.2,
    };
  }

  const petals = [];
  for (let i = 0; i < 26; i++) petals.push(makePetal());

  const bursts = [];
  function spawnBurst(x, y) {
    const count = 22;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.25;
      const speed = 2 + Math.random() * 3.5;
      bursts.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.012 + Math.random() * 0.01,
        size: 2 + Math.random() * 2,
        color: BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)],
      });
    }
  }

  const burstTimers = [300, 900, 1600, 2300].map(delay => setTimeout(() => {
    spawnBurst(cw * (0.25 + Math.random() * 0.5), ch * (0.25 + Math.random() * 0.35));
  }, delay));

  let rafId;
  function tick() {
    ctx.clearRect(0, 0, cw, ch);

    petals.forEach(p => {
      p.y += p.speedY;
      p.sway += 0.03;
      p.x += p.speedX + Math.sin(p.sway) * 0.6;
      p.rot += p.rotSpeed;
      if (p.y > ch + 20) Object.assign(p, makePetal(), { y: -20 });

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size, p.size * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.x += b.vx;
      b.y += b.vy;
      b.vy += 0.05; // gravity
      b.life -= b.decay;
      if (b.life <= 0) { bursts.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(b.life, 0);
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    rafId = requestAnimationFrame(tick);
  }
  tick();

  // ── Auto-dismiss & cleanup ────────────────────────
  setTimeout(() => {
    overlay.style.opacity = '0';
    card.style.opacity    = '0';
    setTimeout(() => {
      cancelAnimationFrame(rafId);
      burstTimers.forEach(clearTimeout);
      window.removeEventListener('resize', resize);
      overlay.remove();
    }, FADE_MS);
  }, DURATION);
}