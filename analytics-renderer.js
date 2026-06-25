'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const VALID_ACCOUNTS = ['codex', 'claude-desktop', 'claude-vscode'];
const initialAccount = new URLSearchParams(window.location.search).get('account');
let currentAccount = VALID_ACCOUNTS.includes(initialAccount) ? initialAccount : 'codex';
let windowHours    = 24;
let rowLimit       = 200;

// Token consumption multipliers relative to a 1× base (Sonnet-equivalent).
// Claude Code (VS Code) uses Opus-class models which burn the 5h quota 20× faster
// than Codex / Claude Desktop at equivalent wallclock usage.
const PLAN_MULTIPLIERS = {
  'codex':          1,
  'claude-desktop': 1,
  'claude-vscode':  20,
};

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtDuration(ms) {
  if (ms < 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return 'just now';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h ago`;
  return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtRate(r) {
  return r > 0.05 ? r.toFixed(1) + '%/hr' : '0%/hr';
}

// ── Burn stats ─────────────────────────────────────────────────────────────
function computeBurnStats(entries) {
  const pts = entries.filter(e => e['5h'] != null);
  if (pts.length < 2) return { rateAll: 0, rateNow: 0, ratePeak: 0, ratePerMs: 0, depletesAt: null, sessions: 0 };

  const first = pts[0], last = pts[pts.length - 1];
  const spanMs = new Date(last.ts) - new Date(first.ts);

  const dropAll = first['5h'] - last['5h'];
  const rateAll = spanMs > 0 && dropAll > 0 ? dropAll / (spanMs / 3_600_000) : 0;

  const cutoff30 = new Date(last.ts).getTime() - 30 * 60_000;
  const recent   = pts.filter(e => new Date(e.ts).getTime() >= cutoff30);
  let rateNow = 0;
  if (recent.length >= 2) {
    const rSpan = new Date(recent[recent.length - 1].ts) - new Date(recent[0].ts);
    const rDrop = recent[0]['5h'] - recent[recent.length - 1]['5h'];
    if (rSpan > 0 && rDrop > 0) rateNow = rDrop / (rSpan / 3_600_000);
  }

  let ratePeak = 0;
  const WIN = 10 * 60_000;
  for (let i = 0; i < pts.length - 1; i++) {
    const t0  = new Date(pts[i].ts).getTime();
    const win = pts.filter(e => { const t = new Date(e.ts).getTime(); return t >= t0 && t <= t0 + WIN; });
    if (win.length >= 2) {
      const wMs   = new Date(win[win.length - 1].ts) - new Date(win[0].ts);
      const wDrop = win[0]['5h'] - win[win.length - 1]['5h'];
      if (wMs > 0 && wDrop > 0) ratePeak = Math.max(ratePeak, wDrop / (wMs / 3_600_000));
    }
  }

  let sessions = 0;
  let lastResetAt = null;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]['5h'] - pts[i - 1]['5h'] > 15) {
      sessions++;
      lastResetAt = new Date(pts[i].ts);
    }
  }
  const nextResetEst = lastResetAt ? new Date(lastResetAt.getTime() + 5 * 3_600_000) : null;

  const effectiveRate = rateNow > 0 ? rateNow : rateAll;
  const ratePerMs     = effectiveRate / 3_600_000;
  let depletesAt = null;
  if (effectiveRate > 0 && last['5h'] > 0) {
    depletesAt = new Date(new Date(last.ts).getTime() + last['5h'] / ratePerMs);
  }

  return { rateAll, rateNow, ratePeak, ratePerMs, depletesAt, sessions, lastResetAt, nextResetEst };
}

// ── Sparkline ──────────────────────────────────────────────────────────────
function renderSparkline(svgEl, entries, ratePerMs) {
  svgEl.innerHTML = '';
  if (entries.length < 2) return;

  const W = 760, H = 120, PAD = 4;
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };

  const ts0    = new Date(entries[0].ts).getTime();
  const ts1    = new Date(entries[entries.length - 1].ts).getTime();
  const tRange = ts1 - ts0 || 1;
  const toX = t => PAD + ((new Date(t).getTime() - ts0) / tRange) * (W - PAD * 2);
  const toY = v => PAD + (1 - v / 100) * (H - PAD * 2);

  // Y-axis labels at 0 / 25 / 50 / 75 / 100%
  for (const lvl of [0, 25, 50, 75, 100]) {
    const y = toY(lvl).toFixed(1);
    svgEl.appendChild(mk('line', {
      x1: PAD, x2: W - PAD, y1: y, y2: y,
      stroke: lvl === 0 || lvl === 100 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.05)',
      'stroke-dasharray': lvl === 50 ? '4,3' : '2,4',
    }));
    const label = mk('text', {
      x: PAD + 2, y: (parseFloat(y) - 3).toFixed(1),
      fill: 'rgba(255,255,255,0.2)', 'font-size': '8',
    });
    label.textContent = lvl + '%';
    svgEl.appendChild(label);
  }

  // Session-reset markers
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i - 1]['5h'], b = entries[i]['5h'];
    if (a != null && b != null && b - a > 15) {
      const x = toX(entries[i].ts).toFixed(1);
      svgEl.appendChild(mk('line', {
        x1: x, x2: x, y1: PAD, y2: H - PAD,
        stroke: 'rgba(168,85,247,0.5)', 'stroke-dasharray': '3,3', 'stroke-width': '1.5',
      }));
      const lbl = mk('text', { x: (parseFloat(x) + 3).toFixed(1), y: (PAD + 10).toFixed(1), fill: 'rgba(168,85,247,0.7)', 'font-size': '8' });
      lbl.textContent = 'reset';
      svgEl.appendChild(lbl);
    }
  }

  // Data lines
  const mkLine = (field, color, width = '2') => {
    const pts = entries.filter(e => e[field] != null);
    if (pts.length < 2) return pts;
    const d = pts.map((e, i) =>
      `${i === 0 ? 'M' : 'L'}${toX(e.ts).toFixed(1)},${toY(e[field]).toFixed(1)}`
    ).join(' ');
    svgEl.appendChild(mk('path', { d, stroke: color, 'stroke-width': width, fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    return pts;
  };

  const pts5h = mkLine('5h', 'var(--accent)', '2');
  mkLine('wk', 'var(--green)', '2');

  // Projection line
  if (ratePerMs > 0 && pts5h.length >= 2) {
    const last = pts5h[pts5h.length - 1];
    if (last['5h'] > 0) {
      const startX = toX(last.ts);
      const startY = toY(last['5h']);
      const slope  = ratePerMs * tRange * (H - PAD * 2) / (100 * (W - PAD * 2));
      const deltaX = (H - PAD - startY) / slope;
      const clampX = Math.min(W - PAD, startX + deltaX);
      const clampY = startY + slope * (clampX - startX);
      svgEl.appendChild(mk('line', {
        x1: startX.toFixed(1), y1: startY.toFixed(1),
        x2: clampX.toFixed(1), y2: clampY.toFixed(1),
        stroke: 'var(--accent)', 'stroke-opacity': '0.3',
        'stroke-dasharray': '6,4', 'stroke-width': '2',
      }));
    }
  }

  // Endpoint dot
  if (pts5h.length > 0) {
    const last = pts5h[pts5h.length - 1];
    svgEl.appendChild(mk('circle', {
      cx: toX(last.ts).toFixed(1), cy: toY(last['5h']).toFixed(1),
      r: '4', fill: 'var(--accent)',
    }));
  }

  // Depletion dots
  for (const e of entries) {
    if (!e.depleted) continue;
    const x = toX(e.ts).toFixed(1);
    svgEl.appendChild(mk('circle', {
      cx: x, cy: (H - PAD).toFixed(1), r: '3.5', fill: 'var(--red)',
    }));
  }
}

// ── Stat cards ─────────────────────────────────────────────────────────────
function renderStats(entries, container) {
  if (!entries.length) {
    container.innerHTML = '<div class="empty">No data in this window.</div>';
    return;
  }

  const last   = entries[entries.length - 1];
  const burn   = computeBurnStats(entries);
  const dep5h  = entries.filter(e => e.depleted?.includes('5h')).length;
  const depWk  = entries.filter(e => e.depleted?.includes('wk')).length;
  const spanMs = new Date(last.ts) - new Date(entries[0].ts);
  const mult   = PLAN_MULTIPLIERS[currentAccount] ?? 1;

  const depleteStr = burn.depletesAt
    ? burn.depletesAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      + (burn.depletesAt - Date.now() < 0 ? ' (past)' : '')
    : burn.rateAll === 0 ? 'stable' : '—';

  const used5h = last['5h'] != null ? (100 - last['5h']) + '%' : '—';
  const used5hCls = last['5h'] != null ? (last['5h'] < 20 ? 'red' : last['5h'] < 50 ? 'amber' : '') : '';

  let nextResetStr = '—', nextResetSub = 'check VS Code for exact time';
  if (burn.nextResetEst) {
    const msUntil = burn.nextResetEst - Date.now();
    if (msUntil > 0 && msUntil < 5.5 * 3_600_000) {
      // Only show if it's in the future and within one plausible 5h window
      nextResetStr = burn.nextResetEst.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      nextResetSub = `in ${fmtDuration(msUntil)} · est. from last reset`;
    }
    // If stale (past) or >5.5h away the estimate is unreliable — leave as '—'
  }

  // When multiplier > 1, show effective token burn in sub-text for burn cards
  const effSub = (rate, baseSub) => {
    if (mult === 1 || rate <= 0) return baseSub;
    return `${baseSub} · ${(rate * mult).toFixed(1)}%/hr equiv.`;
  };

  const cards = [
    // Row 1 — what you have
    { label: '5H Remaining',     value: last['5h'] != null ? last['5h'] + '%' : '—', sub: 'current',               cls: last['5h'] < 20 ? 'red' : last['5h'] < 50 ? 'amber' : 'green' },
    { label: '5H Used',          value: used5h,                                        sub: 'consumed this window', cls: used5hCls },
    { label: 'Weekly Remaining', value: last['wk'] != null ? last['wk'] + '%' : '—',  sub: 'current',               cls: last['wk'] < 20 ? 'red' : last['wk'] < 50 ? 'amber' : 'green' },
    // Row 2 — how fast
    { label: 'Burn Now',  value: burn.rateNow  > 0 ? fmtRate(burn.rateNow)  : '—', sub: effSub(burn.rateNow,  'last 30 min'),              cls: '' },
    { label: 'Burn Avg',  value: burn.rateAll  > 0 ? fmtRate(burn.rateAll)  : '—', sub: effSub(burn.rateAll,  `over ${fmtDuration(spanMs)}`), cls: '' },
    { label: 'Peak Burn', value: burn.ratePeak > 0 ? fmtRate(burn.ratePeak) : '—', sub: effSub(burn.ratePeak, '10-min window'),             cls: '' },
    // Row 3 — what's next
    { label: 'Depletes At',    value: depleteStr,   sub: dep5h || depWk ? `${dep5h}×5h ${depWk}×wk depletions` : 'at current rate', cls: burn.depletesAt && burn.depletesAt - Date.now() < 3_600_000 ? 'red' : '' },
    { label: 'Next 5H Reset ~', value: nextResetStr, sub: nextResetSub,           cls: '' },
    { label: 'Usage Multiplier', value: `${mult}×`, sub: mult > 1 ? `${mult}× quota consumption vs 1× base` : '1× base quota rate', cls: mult > 1 ? 'amber' : 'dim' },
  ];

  container.innerHTML = `
    <div class="stat-grid">
      ${cards.map(c => `
        <div class="stat-card ${c.cls}">
          <div class="label">${c.label}</div>
          <div class="value">${c.value}</div>
          <div class="sub">${c.sub}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// ── Chart ──────────────────────────────────────────────────────────────────
function renderChart(entries, container) {
  const { ratePerMs } = computeBurnStats(entries);

  container.innerHTML = `
    <div class="section-head">Trend Chart</div>
    <div class="chart-wrap" style="margin-top:8px">
      <div class="chart-legend">
        <span><span class="legend-dot" style="background:var(--accent)"></span>5H Remaining</span>
        <span><span class="legend-dot" style="background:var(--green)"></span>Weekly Remaining</span>
        <span><span class="legend-dot" style="background:rgba(168,85,247,0.5);border-radius:0;width:12px;height:2px;display:inline-block;vertical-align:middle;margin-right:4px"></span>Session reset</span>
        <span><span class="legend-dot" style="background:var(--red)"></span>Depletion event</span>
      </div>
      <svg id="analytics-spark" width="100%" height="120" viewBox="0 0 760 120" preserveAspectRatio="none" style="display:block"></svg>
      <div class="chart-labels">
        <span id="chart-start">—</span>
        <span id="chart-end">now</span>
      </div>
    </div>
  `;

  if (entries.length >= 2) {
    const svg = container.querySelector('#analytics-spark');
    renderSparkline(svg, entries, ratePerMs);
    container.querySelector('#chart-start').textContent = fmtAgo(entries[0].ts);
  } else {
    container.querySelector('#analytics-spark').innerHTML = `<text x="380" y="65" text-anchor="middle" fill="rgba(255,255,255,0.2)" font-size="12">Not enough data</text>`;
  }
}

// ── Log table ──────────────────────────────────────────────────────────────
function renderTable(entries, container) {
  const rows = [...entries].reverse(); // newest first

  container.innerHTML = `
    <div class="section-head">Log — ${rows.length} entries (newest first)</div>
    <div class="log-table-wrap" style="margin-top:8px">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Ago</th>
            <th>5H %</th>
            <th>5H Δ</th>
            <th>Wk %</th>
            <th>Wk Δ</th>
            <th>Events</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((e, i) => {
            const next  = rows[i + 1]; // older entry
            const d5h   = next && e['5h'] != null && next['5h'] != null ? e['5h'] - next['5h'] : null;
            const dwk   = next && e['wk'] != null && next['wk'] != null ? e['wk'] - next['wk'] : null;
            const isDep = e.depleted && e.depleted.length > 0;
            const isReset5h = next && e['5h'] != null && next['5h'] != null && e['5h'] - next['5h'] > 15;
            const rowCls = isDep ? 'depleted' : '';
            const fmtD   = v => v == null ? '—' : (v >= 0 ? '+' : '') + v + '%';
            const dClass = v => v == null ? '' : v > 0 ? 'green' : v < 0 ? 'red' : '';
            const events = [];
            if (isDep) events.push(...(e.depleted.map(f => `<span style="color:var(--red)">depleted:${f}</span>`)));
            if (isReset5h) events.push(`<span style="color:var(--accent)">reset</span>`);
            return `<tr class="${rowCls}">
              <td class="mono">${fmtDate(e.ts)}</td>
              <td style="color:var(--text-mid);font-size:10px">${fmtAgo(e.ts)}</td>
              <td class="${e['5h'] != null ? 'accent' : ''}">${e['5h'] != null ? e['5h'] + '%' : '—'}</td>
              <td class="${dClass(d5h)}">${fmtD(d5h)}</td>
              <td class="${e['wk'] != null ? 'green' : ''}" style="color:${e['wk'] != null ? 'var(--green)' : ''}">${e['wk'] != null ? e['wk'] + '%' : '—'}</td>
              <td class="${dClass(dwk)}">${fmtD(dwk)}</td>
              <td style="font-size:10px">${events.join(' ') || ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Main render ────────────────────────────────────────────────────────────
async function renderAll() {
  const body = document.getElementById('body');
  body.innerHTML = '<div class="empty">Loading…</div>';

  const limit = rowLimit === 0 ? 5000 : rowLimit;
  let entries = await window.electronAPI.readUsageLog(currentAccount, limit);

  // Filter by time window
  if (windowHours > 0) {
    const cutoff = Date.now() - windowHours * 3_600_000;
    entries = entries.filter(e => new Date(e.ts).getTime() >= cutoff);
  }

  // Update header meta
  const meta = document.getElementById('header-meta');
  if (entries.length) {
    const span = new Date(entries[entries.length - 1].ts) - new Date(entries[0].ts);
    meta.textContent = `${entries.length} entries · ${fmtDuration(span)} window · last: ${fmtAgo(entries[entries.length - 1].ts)}`;
  } else {
    meta.textContent = 'No data';
  }

  if (!entries.length) {
    body.innerHTML = '<div class="empty">No log entries found for this account and time window.</div>';
    return;
  }

  // Build sections
  const statsEl = document.createElement('div');
  const chartEl = document.createElement('div');
  const tableEl = document.createElement('div');

  body.innerHTML = '';
  body.appendChild(statsEl);
  body.appendChild(chartEl);
  body.appendChild(tableEl);

  renderStats(entries, statsEl);
  renderChart(entries, chartEl);
  renderTable(entries, tableEl);
}

// ── Switch tab helper ──────────────────────────────────────────────────────
function switchTab(account) {
  if (!VALID_ACCOUNTS.includes(account)) return;
  currentAccount = account;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.account === account);
  });
  renderAll();
}

// ── Wire up controls ───────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.account));
});

// Listen for tab-switch messages from main process (when window is already open)
window.electronAPI.onSwitchAnalyticsTab(switchTab);

document.getElementById('window-select').addEventListener('change', e => {
  windowHours = parseInt(e.target.value, 10);
  renderAll();
});

document.getElementById('rows-select').addEventListener('change', e => {
  rowLimit = parseInt(e.target.value, 10);
  renderAll();
});

document.getElementById('refresh-btn').addEventListener('click', renderAll);

// Initial load — activate the correct tab before first render
document.querySelectorAll('.tab').forEach(t => {
  t.classList.toggle('active', t.dataset.account === currentAccount);
});
renderAll();
