// ═══════════════════════════════════════════════════
// TABLE.JS — history table (slot-based, last 10 days)
// Columns: Date, Slot, Time In, Time Out, Client,
//          Project, Task, Hours, Notes
// ═══════════════════════════════════════════════════

let tData = [], tSort = { col:'date', dir:-1 }, tPage = 1;
const PAGE = CONFIG.PAGE_SIZE;

// Converts decimal hours to "1h 6m" display format
function fmtHrsMin(h) {
  const totalMins = Math.round(Number(h) * 60);
  const hrs  = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs === 0)  return `${mins}m`;
  if (mins === 0) return `${hrs}h`;
  return `${hrs}h ${mins}m`;
}

// ── STATS ─────────────────────────────────────────
function refreshStats() {
  const tod = todayStr(), ws = weekStart(), mo = todayStr().slice(0,7);
  const sum = arr => arr.reduce((s,e) => s + Number(e.hours||0), 0);
  const worked = ENTRIES.filter(e => e.status !== 'Leave');
  $('s0').textContent = fh(sum(worked.filter(e => e.date === tod)));
  $('s1').textContent = fh(sum(worked.filter(e => e.date >= ws)));
  $('s2').textContent = fh(sum(worked.filter(e => e.date.startsWith(mo))));
  $('s3').textContent = [...new Set(ENTRIES.map(e => e.date))].length + ' days';
}

// ── FILTERS ───────────────────────────────────────
function refreshFilters() {
  const mon = $('fmon'), cur = mon?.value;
  if (!mon) return;
  const months = [...new Set(ENTRIES.map(e => e.date.slice(0,7)))].sort().reverse();
  mon.innerHTML = '<option value="">All months</option>';
  months.forEach(m => {
    const lbl = new Date(`${m}-01`).toLocaleDateString('en-IN',{month:'long',year:'numeric'});
    const o = document.createElement('option'); o.value=m; o.textContent=lbl;
    mon.appendChild(o);
  });
  if (cur) mon.value = cur;
}

function getFiltered() {
  const q   = $('srch')?.value.toLowerCase().trim() || '';
  const mon = $('fmon')?.value || '';
  const cli = $('fcli2')?.value || '';
  const slt = $('fslt')?.value || '';
  return ENTRIES.filter(e => {
    if (mon && !e.date.startsWith(mon)) return false;
    if (cli && e.clientId !== cli)      return false;
    if (slt && e.slot !== slt)          return false;
    if (q && ![e.client,e.project,e.task,e.notes,e.date,e.slot]
      .some(v => v?.toLowerCase().includes(q))) return false;
    return true;
  });
}

// ── TABLE ─────────────────────────────────────────
function refreshTable() {
  let rows = getFiltered();
  rows.sort((a,b) => {
    const av = a[tSort.col] ?? '', bv = b[tSort.col] ?? '';
    if (tSort.col === 'hours') return (Number(av)-Number(bv)) * tSort.dir;
    return (av < bv ? -1 : av > bv ? 1 : 0) * tSort.dir;
  });
  tData = rows; tPage = 1; renderPage();
}

function renderPage() {
  const tbody = $('tbody'), tfoot = $('tfoot'), pager = $('pager');
  if (!tbody) return;
  const total = tData.length, pages = Math.max(1, Math.ceil(total/PAGE));
  if (tPage > pages) tPage = pages;
  const cnt = $('cnt');
  if (cnt) cnt.textContent = `${total} entr${total===1?'y':'ies'}`;

  const slice      = tData.slice((tPage-1)*PAGE, tPage*PAGE);
  const totalHours = tData.filter(e=>e.status!=='Leave').reduce((s,e)=>s+Number(e.hours||0),0);
  const pageHours  = slice.filter(e=>e.status!=='Leave').reduce((s,e)=>s+Number(e.hours||0),0);

  if (!slice.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">
      <div class="estat">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <p>${ENTRIES.length===0?'No entries yet. Start logging above.':'No entries match your filters.'}</p>
      </div></td></tr>`;
    if (tfoot) tfoot.innerHTML = '';
    if (pager) pager.innerHTML = '';
    return;
  }

  // Slot icons
  const slotIcon = { morning:'🌅', afternoon:'☀️', extended:'🌙' };
  const slotLabel = { morning:'Morning', afternoon:'Afternoon', extended:'Extended' };

  tbody.innerHTML = slice.map((e,i) => {
    const isLeave = e.status === 'Leave';
    return `<tr class="${isLeave?'leave-row':''}">
      <td class="rn">${(tPage-1)*PAGE+i+1}</td>
      <td class="dcell">${fmtDate(e.date)}<br><span style="font-size:.6rem;color:var(--muted)">${e.day||''}</span>${e.savedAt ? `<br><span style="font-size:.58rem;color:var(--muted);font-style:italic" title="Saved at ${e.savedAt}">🕐 ${e.savedAt}</span>` : ''}</td>
      <td><span class="slot-pill slot-${e.slot}">${slotIcon[e.slot]||''} ${slotLabel[e.slot]||e.slot} #${e.entryNum}</span></td>
      <td class="dcell">${e.timeIn||'—'}</td>
      <td class="dcell">${e.timeOut||'—'}</td>
      <td>${isLeave ? '<span class="leave-badge-sm">🏖️ Leave</span>' : esc(e.client)}</td>
      <td>${isLeave ? '—' : esc(e.project)}</td>
      <td>${isLeave ? '—' : `<span class="tpill">${esc(e.task)}</span>`}</td>
      <td class="hcell">${isLeave ? '—' : (e.hours ? fmtHrsMin(e.hours) : '—')}</td>
      <td class="ncell" title="${esc(e.notes)}">${isLeave ? '—' : esc(e.notes)}</td>
    </tr>`;
  }).join('');

  // Totals row
  if (tfoot) {
    tfoot.innerHTML = `<tr class="totrow">
      <td class="rn"></td>
      <td colspan="7" style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">
        Page / All filtered (worked hours only)
      </td>
      <td class="hcell">${fmtHrsMin(pageHours)} / ${fmtHrsMin(totalHours)}</td>
      <td></td>
    </tr>`;
  }

  // Sort arrows
  document.querySelectorAll('th[data-col]').forEach(th => {
    const arr = th.querySelector('.sort-arr');
    th.classList.toggle('sorted', th.dataset.col === tSort.col);
    if (arr) arr.textContent = th.dataset.col === tSort.col
      ? (tSort.dir === -1 ? ' ↓' : ' ↑') : ' ↕';
  });

  // Pagination
  if (!pager) return;
  if (pages <= 1) { pager.innerHTML = ''; return; }
  const nums = [];
  for (let p=1; p<=pages; p++) {
    if (p===1||p===pages||Math.abs(p-tPage)<=1) nums.push(p);
    else if (nums[nums.length-1] !== '…') nums.push('…');
  }
  pager.innerHTML = `
    <span style="color:var(--muted)">${(tPage-1)*PAGE+1}–${Math.min(tPage*PAGE,total)} of ${total}</span>
    <div class="pager-btns">
      <button class="pbtn" id="pprev" ${tPage===1?'disabled':''}>‹ Prev</button>
      ${nums.map(n => n==='…'
        ? `<span style="padding:.2rem .4rem;color:var(--muted)">…</span>`
        : `<button class="pbtn${n===tPage?' cur':''}" data-p="${n}">${n}</button>`
      ).join('')}
      <button class="pbtn" id="pnext" ${tPage===pages?'disabled':''}>Next ›</button>
    </div>`;
}

// ── EVENT BINDINGS ────────────────────────────────
function initTable() {
  // Sort columns
  const thead = document.querySelector('#htbl thead');
  if (thead) {
    thead.addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      const col = th.dataset.col;
      tSort = { col, dir: tSort.col===col ? tSort.dir*-1 : -1 };
      refreshTable();
    });
  }

  // Pagination
  const pager = $('pager');
  if (pager) {
    pager.addEventListener('click', e => {
      if (e.target.id==='pprev') tPage--;
      else if (e.target.id==='pnext') tPage++;
      else if (e.target.dataset.p) tPage = parseInt(e.target.dataset.p);
      else return;
      renderPage();
      document.querySelector('.thdr')?.scrollIntoView({behavior:'smooth',block:'start'});
    });
  }

  // Filters
  $('srch')?.addEventListener('input',  () => refreshTable());
  $('fmon')?.addEventListener('change', () => refreshTable());
  $('fcli2')?.addEventListener('change',() => refreshTable());
  $('fslt')?.addEventListener('change', () => refreshTable());

  // CSV Export
  $('xbtn')?.addEventListener('click', () => {
    const rows = getFiltered().slice().sort((a,b) => b.date.localeCompare(a.date));
    const hdr  = ['Date','Day','Slot','Entry#','Time In','Time Out','Hours',
                  'Client','Project','Task','Notes','Status','Saved At'];
    const lines = rows.map(e => [
      e.date, e.day||'', e.slot, e.entryNum,
      e.timeIn, e.timeOut, e.hours,
      `"${(e.client||'').replace(/"/g,'""')}"`,
      `"${(e.project||'').replace(/"/g,'""')}"`,
      e.task,
      `"${(e.notes||'').replace(/"/g,'""')}"`,
      e.status,
      `"${(e.savedAt||'').replace(/"/g,'""')}"`,
    ].join(','));
    const csv = [hdr, ...lines].join('\n');
    const a   = document.createElement('a');
    a.href    = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = `timesheet_${USER.id}_${todayStr()}.csv`;
    a.click();
    toast('s', 'CSV downloaded', `${rows.length} rows`);
  });
}