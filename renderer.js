// ── Account label overrides ────────────────────────────────────────────────
// Keyed by render prefix. Codex and Claude Desktop are fixed; one key per
// Claude Code account is added by buildClaudeCodeCards.
const accountOverrides = { codex: '', claude: '' };

function applyAccountLabel(key, autoValue) {
  const override = accountOverrides[key];
  const label = override || autoValue || '';
  // Every card — static or cloned — names its label element <prefix>-account.
  const el = document.getElementById(key + '-account');
  if (el && label) el.textContent = label;

  // Claude Code headings ride the same call, so a heading can never disagree
  // with the label beneath the card title. Only an email is remembered as the
  // account's identity: this function is also fed the rate-limit tier string
  // ("max 20x"), which is identical on every card and distinguishes nothing.
  const acct = claudeAccounts.find(a => a.id === key);
  if (!acct) return;
  if (autoValue && autoValue.includes('@')) acct.label = autoValue;
  applyAccountHeadings(acct);
}

document.getElementById('btn-settings').addEventListener('click', () => {
  window.electronAPI.openSettings();
});


// ── Theme ─────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  document.getElementById('btn-theme').textContent = theme === 'light' ? '🌙' : '☀';
}
document.getElementById('btn-theme').addEventListener('click', () => {
  const next = document.body.classList.contains('light') ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
});
applyTheme(localStorage.getItem('theme') || 'dark');

// ── Constants ──────────────────────────────────────────────────────────────
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// ── State ──────────────────────────────────────────────────────────────────
let claudeEntries = [];
let isCompact = false;
let claudeRetryTimer  = null;
let codexRetryTimer   = null;
let refreshIntervalIds = [];
let refreshSeconds = 120;

// Track whether each account has ever returned real data
const hasData = { codex: false, claude: false };

// Last-known cache (shown immediately on startup while live fetch runs)
const cachedData = { codex: null, claude: null };
function saveCachedData(key, parsed) {
  cachedData[key] = parsed;
  window.electronAPI.saveSettings({ lastKnown: { ...cachedData } });
}

// ── Claude Code accounts ───────────────────────────────────────────────────
// Descriptors from the main process: { id, kind, configDir, configDirs,
// logKey, label }. Empty until buildClaudeCodeCards() has run.
let claudeAccounts = [];
const claudeRetryTimers = {};   // account id -> retry timer

// Every render prefix currently on screen. Codex and Claude Desktop are always
// present; the Claude Code half is however many accounts were discovered.
function accountPrefixes() {
  return ['codex', 'claude', ...claudeAccounts.map(a => a.id)];
}

// ── Trend history ──────────────────────────────────────────────────────────
// Two series per prefix. Claude Code accounts add theirs in buildClaudeCodeCards.
const trendHistory = {
  'codex-5h':   [],
  'codex-wk':   [],
  'claude-5h':  [],
  'claude-wk':  [],
};

function pushTrend(key, value) {
  if (value == null) return;
  const arr  = trendHistory[key];
  const prev = arr.length ? arr[arr.length - 1] : null;
  arr.push(value);
  if (arr.length > 10) arr.shift();
  applyTrendDisplay(key, prev != null ? value - prev : null);
}

function applyTrendDisplay(key, delta) {
  let symbol = '', cls = 'trend-flat';
  if (delta != null) {
    if (delta > 2)       { symbol = '↑'; cls = 'trend-up'; }
    else if (delta < -2) { symbol = '↓'; cls = 'trend-down'; }
    else                 { symbol = '→'; }
  }

  for (const prefix of ['', 'c-']) {
    const el = document.getElementById(prefix + key + '-trend');
    if (el) { el.textContent = symbol; el.className = 'trend ' + cls; }
  }

  const deltaEl = document.getElementById(key + '-delta');
  if (deltaEl) {
    if (delta == null) {
      deltaEl.textContent = 'first reading';
      deltaEl.style.color = '';
    } else {
      deltaEl.textContent = (delta >= 0 ? '+' : '') + delta + '%';
      deltaEl.style.color = delta > 2 ? '#34d399' : delta < -2 ? '#f87171' : '';
    }
  }
}

// ── Analytics / sparkline ──────────────────────────────────────────────────
// Render prefix -> usage-log account key. Claude Code accounts are added from
// their descriptors' logKey in buildClaudeCodeCards.
const LOG_ACCOUNT = { codex: 'codex', claude: 'claude-desktop' };

let budgetInfo = {};
let budgetTargets = { window: 10, day: 20 };
const lastPct5h = { codex: null, claude: null };

// Accounts whose PLAN has no 5-hour window at all — as opposed to a meter that
// failed to arrive this poll. OpenAI removed the Codex 5-hour window on
// 2026-07-11; Anthropic still reports both. Rewritten on every fetch, so a
// window that comes back clears the flag on its own.
const noFiveHourWindow = new Set();

// Per-account session tracking, keyed by usage-log account key. sessionStart
// persists in each log entry so analytics can group entries by session even
// after an app restart. Claude Code keys are added in buildClaudeCodeCards.
const _ss = {
  'claude-desktop': { start: null, lastPct: null },
  'codex':          { start: null, lastPct: null },
};

// Update session state for scraped accounts (Codex, Claude Desktop).
// Returns the current sessionStart ISO string.
function trackSession(account, pct5h) {
  const s = _ss[account];
  if (s.lastPct !== null && pct5h != null && pct5h - s.lastPct > 15) {
    s.start = new Date().toISOString(); // quota jumped up → new 5H window
  }
  if (!s.start && pct5h != null) s.start = new Date().toISOString(); // first observation
  s.lastPct = pct5h ?? s.lastPct;
  return s.start;
}

// ── RESET PARSING ──
// Parse reset strings from scrapers into epoch ms.
// Handles: absolute dates ("Jun 25, 2026 8:14 AM"), day-time ("Sat 4:59 PM"),
// relative ("in 5d", "5 days").
function parseResetToMs(str) {
  if (!str) return 0;
  // Direct date parse (works for "Jun 25, 2026 8:14 AM")
  const d = new Date(str);
  if (!isNaN(d.getTime()) && d.getTime() > Date.now() - 86_400_000) return d.getTime();
  // "Sat 4:59 PM" / "Mon 10:30 AM"
  const dayTime = str.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d+):(\d+)\s*(AM|PM)$/i);
  if (dayTime) {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const target = days.findIndex(x => x.toLowerCase() === dayTime[1].toLowerCase());
    const now = new Date();
    let diff = (target - now.getDay() + 7) % 7 || 7;
    const r = new Date(now);
    r.setDate(now.getDate() + diff);
    let h = parseInt(dayTime[2]);
    const m = parseInt(dayTime[3]);
    if (dayTime[4].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (dayTime[4].toLowerCase() === 'am' && h === 12) h = 0;
    r.setHours(h, m, 0, 0);
    return r.getTime();
  }
  // Relative: "in 3 hours", "2h 30m", "in 45 minutes", "in 1 hour 15 min"
  const relH = str.match(/(\d+)\s*(?:hours?|hrs?|h)\b/i);
  const relM = str.match(/(\d+)\s*(?:minutes?|mins?|m)\b/i);
  if (relH || relM) {
    const h = relH ? parseInt(relH[1], 10) : 0;
    const m = relM ? parseInt(relM[1], 10) : 0;
    return Date.now() + h * 3_600_000 + m * 60_000;
  }
  // "in 5d" / "5 days"
  const days = str.match(/(\d+)\s*d/i);
  if (days) return Date.now() + parseInt(days[1]) * 86_400_000;
  // "at 8:14 PM" — next occurrence of that clock time
  const at = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (at) {
    let h = parseInt(at[1], 10);
    const m = parseInt(at[2], 10);
    const ap = at[3] ? at[3].toLowerCase() : null;
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const r = new Date();
    r.setHours(h, m, 0, 0);
    if (r.getTime() <= Date.now()) r.setDate(r.getDate() + 1);
    return r.getTime();
  }
  return 0;
}
// ── RESET PARSING END ──

function fmtDuration(ms) {
  if (ms < 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Shared reset-label formatters so every card displays resets identically:
// 5h window as a countdown ("Resets in 2h 41m"), weekly as a date
// ("Resets Tue, 30 Jun 12:00"). Both take an absolute reset timestamp (ms).
function fmtResetIn(ms) {
  if (!ms || ms <= Date.now()) return '';
  return 'Resets in ' + fmtDuration(ms - Date.now());
}
function fmtResetOn(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const dateStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Resets ${dateStr} ${timeStr}`;
}

function fmtAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return 'just now';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h/24)}d ago`;
  return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
}

function renderSparkline(svgEl, entries, ratePerMs = 0) {
  svgEl.innerHTML = '';
  if (entries.length < 2) return;

  const W = parseInt(svgEl.getAttribute('width') || '260', 10);
  const H = parseInt(svgEl.getAttribute('height') || '40', 10);
  const PAD = 2;
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };

  const ts0 = new Date(entries[0].ts).getTime();
  const ts1 = new Date(entries[entries.length - 1].ts).getTime();
  const tRange = ts1 - ts0 || 1;
  const toX = t  => PAD + ((new Date(t).getTime() - ts0) / tRange) * (W - PAD * 2);
  const toY = v  => PAD + (1 - v / 100) * (H - PAD * 2);

  // Grid lines at 25 / 50 / 75 %
  for (const lvl of [25, 50, 75]) {
    svgEl.appendChild(mk('line', {
      x1: PAD, x2: W - PAD, y1: toY(lvl), y2: toY(lvl),
      stroke: 'rgba(255,255,255,0.06)', 'stroke-dasharray': '3,3',
    }));
  }

  // Session-reset markers — 5h jumps up > 15 pp between consecutive readings
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i-1]['5h'], b = entries[i]['5h'];
    if (a != null && b != null && b - a > 15) {
      const x = toX(entries[i].ts).toFixed(1);
      svgEl.appendChild(mk('line', {
        x1: x, x2: x, y1: PAD, y2: H - PAD,
        stroke: 'rgba(168,85,247,0.45)', 'stroke-dasharray': '2,2', 'stroke-width': '1',
      }));
    }
  }

  // Data lines
  const mkLine = (field, color) => {
    const pts = entries.filter(e => e[field] != null);
    if (pts.length < 2) return pts;
    const d = pts.map((e, i) =>
      `${i === 0 ? 'M' : 'L'}${toX(e.ts).toFixed(1)},${toY(e[field]).toFixed(1)}`
    ).join(' ');
    svgEl.appendChild(mk('path', {
      d, stroke: color, 'stroke-width': '1.5', fill: 'none', 'stroke-linejoin': 'round',
    }));
    return pts;
  };

  const pts5h = mkLine('5h', 'var(--accent)');
  mkLine('wk', '#34d399');

  // Burn-rate projection for 5h (dashed line from last point toward 0%)
  if (ratePerMs > 0 && pts5h.length >= 2) {
    const last = pts5h[pts5h.length - 1];
    if (last['5h'] > 0) {
      const startX = toX(last.ts);
      const startY = toY(last['5h']);
      const endY   = H - PAD; // toY(0)
      // Slope in chart coords: dY per dX = ratePerMs × (H-PAD×2)/100 ÷ (W-PAD×2)/tRange
      const slope  = ratePerMs * tRange * (H - PAD * 2) / (100 * (W - PAD * 2));
      const deltaX = (endY - startY) / slope;
      const clampX = Math.min(W - PAD, startX + deltaX);
      const clampY = startY + slope * (clampX - startX);
      svgEl.appendChild(mk('line', {
        x1: startX.toFixed(1), y1: startY.toFixed(1),
        x2: clampX.toFixed(1), y2: clampY.toFixed(1),
        stroke: 'var(--accent)', 'stroke-opacity': '0.35',
        'stroke-dasharray': '4,3', 'stroke-width': '1.5',
      }));
    }
  }

  // Endpoint dot — current 5h value
  if (pts5h.length > 0) {
    const last = pts5h[pts5h.length - 1];
    svgEl.appendChild(mk('circle', {
      cx: toX(last.ts).toFixed(1), cy: toY(last['5h']).toFixed(1),
      r: '3', fill: 'var(--accent)',
    }));
  }

  // Depletion markers (red dots at the bottom)
  for (const e of entries) {
    if (!e.depleted) continue;
    const x = toX(e.ts);
    for (const _field of e.depleted) {
      svgEl.appendChild(mk('circle', {
        cx: x.toFixed(1), cy: (H - PAD).toFixed(1),
        r: '2.5', fill: '#f87171',
      }));
    }
  }
}

function computeBurnStats(entries) {
  // Returns { rateAll, rateNow, ratePeak, ratePerMs, depletesAt, sessions }
  const pts = entries.filter(e => e['5h'] != null);
  if (pts.length < 2) return { rateAll: 0, rateNow: 0, ratePeak: 0, ratePerMs: 0, depletesAt: null, sessions: 0 };

  const first = pts[0], last = pts[pts.length - 1];
  const spanMs = new Date(last.ts) - new Date(first.ts);

  // All-time avg rate
  const dropAll = first['5h'] - last['5h'];
  const rateAll = spanMs > 0 && dropAll > 0 ? dropAll / (spanMs / 3_600_000) : 0;

  // Recent rate — last 30 min
  const cutoff30 = new Date(last.ts).getTime() - 30 * 60_000;
  const recent   = pts.filter(e => new Date(e.ts).getTime() >= cutoff30);
  let rateNow = 0;
  if (recent.length >= 2) {
    const rSpan = new Date(recent[recent.length-1].ts) - new Date(recent[0].ts);
    const rDrop = recent[0]['5h'] - recent[recent.length-1]['5h'];
    if (rSpan > 0 && rDrop > 0) rateNow = rDrop / (rSpan / 3_600_000);
  }

  // Peak rate — sliding 10-min windows
  let ratePeak = 0;
  const WIN = 10 * 60_000;
  for (let i = 0; i < pts.length - 1; i++) {
    const t0 = new Date(pts[i].ts).getTime();
    const window = pts.filter(e => {
      const t = new Date(e.ts).getTime(); return t >= t0 && t <= t0 + WIN;
    });
    if (window.length >= 2) {
      const wMs   = new Date(window[window.length-1].ts) - new Date(window[0].ts);
      const wDrop = window[0]['5h'] - window[window.length-1]['5h'];
      if (wMs > 0 && wDrop > 0) ratePeak = Math.max(ratePeak, wDrop / (wMs / 3_600_000));
    }
  }

  // Session resets — 5h jumps up > 15 pp
  let sessions = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]['5h'] - pts[i-1]['5h'] > 15) sessions++;
  }

  // Estimated depletion using the more-recent rate (or fall back to avg)
  const effectiveRate = rateNow > 0 ? rateNow : rateAll;
  const ratePerMs     = effectiveRate / 3_600_000;
  let depletesAt = null;
  if (effectiveRate > 0 && last['5h'] > 0) {
    const msLeft = last['5h'] / ratePerMs;
    depletesAt = new Date(new Date(last.ts).getTime() + msLeft);
  }

  return { rateAll, rateNow, ratePeak, ratePerMs, depletesAt, sessions };
}

function renderTrendAnalytics(id, entries) {
  if (!entries.length) return;

  const set = (elId, val, color) => {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = val ?? '—';
    if (color !== undefined) el.style.color = color;
  };

  // ── Row 1: delta stats ──────────────────────────────────────────────────
  const last = entries[entries.length - 1];
  const prev = entries.length > 1 ? entries[entries.length - 2] : null;
  const d5h  = prev != null ? last['5h'] - prev['5h'] : null;
  const dwk  = prev != null ? last['wk'] - prev['wk'] : null;
  const fmtDelta  = v => v == null ? '—' : (v >= 0 ? '+' : '') + v + '%';
  const deltaColor = v => v == null ? '' : v > 0 ? '#34d399' : v < 0 ? '#f87171' : '';
  set(id + '-5h-delta', fmtDelta(d5h), deltaColor(d5h));
  set(id + '-wk-delta', fmtDelta(dwk), deltaColor(dwk));

  // ── Burn stats ──────────────────────────────────────────────────────────
  const { rateAll, rateNow, ratePeak, ratePerMs, depletesAt, sessions } = computeBurnStats(entries);
  const fmtRate = r => r > 0.05 ? r.toFixed(1) + '%/hr' : '0%/hr';

  // Burn: "now 31.5%/hr · avg 29.2%/hr"
  const burnParts = [];
  if (rateNow > 0)  burnParts.push(`now ${fmtRate(rateNow)}`);
  if (rateAll > 0)  burnParts.push(`avg ${fmtRate(rateAll)}`);
  set(id + '-burn', burnParts.length ? burnParts.join(' · ') : '—');

  // Depletions
  const dep5h  = entries.filter(e => e.depleted?.includes('5h')).length;
  const depWk  = entries.filter(e => e.depleted?.includes('wk')).length;
  const depText = dep5h || depWk
    ? [dep5h && `5h×${dep5h}`, depWk && `wk×${depWk}`].filter(Boolean).join(' ')
    : '0';
  set(id + '-depletions', depText, (dep5h || depWk) ? '#f87171' : '#34d399');

  // ── Sparkline ───────────────────────────────────────────────────────────
  const svg = document.getElementById(id + '-spark');
  if (svg) renderSparkline(svg, entries, ratePerMs);

  // Time labels
  set(id + '-spark-start', fmtAgo(entries[0].ts));
}

// ── Trend panel toggle (called from inline onclick) ────────────────────────
const openPanels = new Set();
window.toggleTrend = function(id) {
  const panel = document.getElementById(id + '-trend-panel');
  const btn   = document.getElementById(id + '-trend-toggle');
  if (!panel) return;
  const nowOpen = !openPanels.has(id);
  panel.classList.toggle('open', nowOpen);
  btn.textContent = nowOpen ? 'Trend ▴' : 'Trend ▾';

  if (nowOpen) {
    openPanels.add(id);
    // Load data and resize after transition completes — one RAF after transitionend
    // ensures both the panel height and rendered data are in the layout
    const account = LOG_ACCOUNT[id];
    Promise.all([
      window.electronAPI.readUsageLog(account, 200),
      new Promise(res => panel.addEventListener('transitionend', res, { once: true })),
    ]).then(([entries]) => {
      renderTrendAnalytics(id, entries);
      resizeToFit();
    });
  } else {
    openPanels.delete(id);
    panel.addEventListener('transitionend', resizeToFit, { once: true });
  }
  resizeToFit(); // immediate resize to start window growing/shrinking
};

// ── Section / compact-stat visibility ─────────────────────────────────────
const hiddenSections = new Set();

function saveHiddenSections() {
  window.electronAPI.saveSettings({ hiddenSections: [...hiddenSections] });
}

function updateShowHiddenRow() {
  const n = hiddenSections.size;
  document.getElementById('show-hidden-row').style.display = n > 0 ? 'block' : 'none';
  document.getElementById('hidden-count').textContent = n;
  resizeToFit();
}

function hideSection(id) {
  hiddenSections.add(id);
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
  refreshCompactStatsForSection(id); // keep compact view in sync
  saveHiddenSections();
  updateShowHiddenRow();
}

// Re-applies the hidden set to the DOM, seeding it from settings the first
// time. Used at startup AND after a Claude Code card rebuild: the rebuilt cards
// are fresh clones with no display style, so without this a rebuild resurrects
// every section the user had hidden.
//
// Deliberately not a loop over hideSection(): that would re-persist and
// re-broadcast an unchanged hidden list on every rebuild (and on every startup,
// as it used to).
function applyHiddenSections(settings) {
  if (Array.isArray(settings.hiddenSections)) {
    settings.hiddenSections.forEach(id => hiddenSections.add(id));
  }
  for (const id of hiddenSections) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
    refreshCompactStatsForSection(id);
  }
  updateShowHiddenRow();
}

function showSection(id, visible) {
  if (hiddenSections.has(id)) return; // respect manual hide
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

// Data-driven desired visibility of each compact stat (ignoring hidden state)
const compactStatData = {};

function applyCompactStat(id) {
  const sectionId = id.replace(/-(5h|wk)$/, '') + '-section';
  const show = !!compactStatData[id] && !hiddenSections.has(sectionId);
  const el = document.getElementById('cs-' + id);
  if (el) el.style.display = show ? '' : 'none';
}

function refreshCompactStatsForSection(sectionId) {
  const prefix = sectionId.replace(/-section$/, '');
  ['5h', 'wk'].forEach(s => applyCompactStat(prefix + '-' + s));
}

function showCompactStat(id, visible) {
  compactStatData[id] = visible;
  applyCompactStat(id); // honors hiddenSections
}

// Section hide buttons
document.querySelectorAll('.section-hide-btn').forEach(btn => {
  btn.addEventListener('click', () => hideSection(btn.dataset.section));
});

// Show all hidden sections
document.getElementById('show-all-btn').addEventListener('click', () => {
  [...hiddenSections].forEach(id => {
    hiddenSections.delete(id);
    const el = document.getElementById(id);
    if (el) el.style.display = '';
    refreshCompactStatsForSection(id); // restore compact stats (data-driven)
  });
  saveHiddenSections();
  updateShowHiddenRow();
});

// ── Compact view ───────────────────────────────────────────────────────────
function setCompact(val) {
  isCompact = val;
  document.getElementById('full-view').style.display    = val ? 'none'  : '';
  document.getElementById('compact-view').style.display = val ? 'block' : 'none';
  const btn = document.getElementById('btn-compact');
  btn.classList.toggle('active', val);
  btn.title       = val ? 'Expand view'   : 'Compact view';
  btn.textContent = val ? '⊞' : '⊟';
  window.electronAPI.saveSettings({ compact: val });
  requestAnimationFrame(resizeToFit);
}
document.getElementById('btn-compact').addEventListener('click', () => setCompact(!isCompact));


// ── Utilities ──────────────────────────────────────────────────────────────
function pctColor(pct) {
  if (pct == null) return '';
  if (pct >= 50) return '#34d399';
  if (pct >= 20) return '#f59e0b';
  return '#f87171';
}

function barGradient(pct) {
  if (pct == null) return 'var(--border)';
  if (pct >= 50) return 'linear-gradient(90deg,#059669,#34d399)';
  if (pct >= 20) return 'linear-gradient(90deg,#92400e,#fbbf24)';
  return 'linear-gradient(90deg,#7f1d1d,#f87171)';
}

// `placeholder` is what shows in place of a missing percentage. The default
// — means "a number that belongs here is momentarily absent"; callers pass
// 'n/a' for a meter the plan does not have at all.
function setPct(id, pct, placeholder = '—') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = pct != null ? pct + '%' : placeholder;
  el.style.color = pctColor(pct);
}

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 5000);
}

function setBadge(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'badge ' + (cls || '');
}

// Set an element's text, falling back to an em-dash for null/undefined.
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}

// Size + colour a progress bar from a remaining-percentage (no-op when null).
function setBar(id, pct) {
  const el = document.getElementById(id);
  if (el && pct != null) { el.style.width = pct + '%'; el.style.background = barGradient(pct); }
}

// Render one usage stat (5h or weekly) across the full card, its bar, and the
// compact view in one call. prefix: 'codex' | 'claude' | a Claude Code account
// id (see accountPrefixes); win: '5h' | 'wk'.
function renderStat(prefix, win, pct, placeholder) {
  setPct(`${prefix}-${win}-pct`, pct, placeholder);
  setBar(`${prefix}-${win}-bar`, pct);
  setPct(`c-${prefix}-${win}`, pct, placeholder);
  // Keep the compact card in place; its value element already shows "—" for a
  // null meter (setPct). A fully-absent/errored account never reaches renderStat
  // (both-null / error early-returns in the fetchers), so no phantom cards.
  showCompactStat(`${prefix}-${win}`, true);
}

// Budget marker + note for one account. `pct5h` is the current 5h REMAINING %.
function renderBudget(prefix, pct5h) {
  if (pct5h != null) lastPct5h[prefix] = pct5h;
  const pct    = lastPct5h[prefix];
  const marker = document.getElementById(prefix + '-5h-budget');
  const note   = document.getElementById(prefix + '-budget-note');
  const info   = budgetInfo[LOG_ACCOUNT[prefix]] || {};
  const ratio  = info.ratio;
  const allowance = fiveHourAllowancePct(budgetTargets.window, ratio);

  // Nothing to mark on a bar that measures a window the plan does not have.
  const no5h = noFiveHourWindow.has(prefix);

  if (marker) {
    if (allowance != null && !no5h) {
      marker.style.left = (100 - allowance) + '%';
      marker.style.display = '';
    } else {
      marker.style.display = 'none';
    }
  }
  if (!note) return;
  // "need more history" would be a lie here: the ratio is 5h-burn per
  // weekly-burn, and with no 5h window no amount of waiting can measure it.
  if (no5h) {
    note.textContent = 'budget: plan has no 5h window — weekly only';
    note.className = 'budget-note';
    return;
  }
  if (!(ratio > 0) || pct == null) {
    note.textContent = info.tierChangedAt
      ? 'budget: need more history since tier change'
      : 'budget: need more history';
    note.className = 'budget-note';
    return;
  }
  const wkEquiv = (100 - pct) * ratio;
  const day     = info.dayWeeklyBurnPct || 0;
  const level   = (v, t) => (v <= t ? 0 : v <= t * 1.5 ? 1 : 2);
  const worst   = Math.max(level(wkEquiv, budgetTargets.window), level(day, budgetTargets.day));
  // Positive confirmation that a declared tier change is in effect. Without it
  // a valid date is invisible whenever there IS enough post-cutoff data, so
  // there's no way to tell whether the cutoff applied.
  const scope = info.tierChangedAt
    ? ' · ratio since ' + new Date(info.tierChangedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })
    : '';
  note.textContent = `${wkEquiv.toFixed(1)}% / ${budgetTargets.window}% wk this window · today ${day.toFixed(1)}% / ${budgetTargets.day}%${scope}`;
  note.className = 'budget-note' + (worst === 1 ? ' over' : worst === 2 ? ' wayover' : '');
}

// Pull fresh budget info + targets, then repaint every account's budget UI.
async function refreshBudget() {
  try {
    budgetInfo = (await window.electronAPI.getBudgetInfo()) || {};
  } catch { /* leave previous value */ }
  try {
    const s = (await window.electronAPI.getSettings()) || {};
    const bt = s.budgetTargets || {};
    budgetTargets = {
      window: (bt.window > 0) ? bt.window : 10,
      day:    (bt.day    > 0) ? bt.day    : 20,
    };
  } catch { /* leave previous value */ }
  accountPrefixes().forEach(p => renderBudget(p, null));
}

// Build a usage-log entry with depletion flags + reset timestamps.
// Callers attach an account-specific sessionStart before appending.
function buildUsageEntry(account, p5h, pwk, reset5hMs, reset7dMs) {
  const entry = { ts: new Date().toISOString(), account, '5h': p5h, wk: pwk };
  const dep = [p5h === 0 && '5h', pwk === 0 && 'wk'].filter(Boolean);
  if (dep.length) entry.depleted = dep;
  if (reset5hMs > 0) entry.reset5hTs = reset5hMs;
  if (reset7dMs > 0) entry.reset7dTs = reset7dMs;
  return entry;
}

function markUpdated() {
  document.getElementById('last-updated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
}

// Badge "Loading…" + spinner state shared by the async fetch functions.
// Null-guarded like setBadge/setPct: a fetch or a retry can outlive the card it
// started on (an account dropped by a rescan), and an unguarded call would
// throw inside an async function nothing awaits — visible only as an unhandled
// rejection.
function fetchStart(prefix) {
  setBadge(prefix + '-badge', 'Loading…', 'warn');
  document.getElementById(prefix + '-badge')?.classList.add('pulsing');
  document.getElementById(prefix + '-refresh')?.classList.add('spinning');
}
function fetchStop(prefix) {
  document.getElementById(prefix + '-badge')?.classList.remove('pulsing');
  document.getElementById(prefix + '-refresh')?.classList.remove('spinning');
}

// A little headroom on the fitted height, so sub-pixel rounding or a few px of
// measurement drift can't leave the content one notch too tall for its window
// and put the scrollbar back. Constant, so the window height stays stable
// instead of oscillating between two fits.
const FIT_SLACK_PX = 10;

function resizeToFit() {
  requestAnimationFrame(() => {
    const titlebar = document.querySelector('.titlebar');
    const content  = document.querySelector('.content');
    if (!content) return;

    // Measure natural content height by finding the lowest visible child bottom.
    // getBoundingClientRect() works correctly whether content overflows (elements
    // below fold have bottom > window height) or underflows (compact mode).
    // Adding scrollTop corrects for any scroll offset inside the content area.
    const cTop = content.getBoundingClientRect().top;
    let maxBottom = 0;
    for (const child of content.children) {
      if (getComputedStyle(child).display === 'none') continue;
      const bottom = child.getBoundingClientRect().bottom - cTop + content.scrollTop;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    const padBot = parseFloat(getComputedStyle(content).paddingBottom) || 10;
    const contentH = maxBottom + padBot;

    const titlebarH = titlebar ? titlebar.offsetHeight : 36;
    window.electronAPI.resizeToFit(Math.ceil(contentH + titlebarH + FIT_SLACK_PX));
  });
}

// ── Claude Code — local JSONL ──────────────────────────────────────────────
async function loadClaudeData() {
  setBadge('claude-badge', 'Reading…', 'warn');
  const result = await window.electronAPI.readClaudeCodeUsage();
  if (result.error) {
    setBadge('claude-badge', 'Error', 'error');
    showToast('Could not read Claude data: ' + result.error);
    return;
  }
  claudeEntries = (result.entries || []).map(e => ({ ...e, ts: new Date(e.timestamp).getTime() }));
  setBadge('claude-badge', claudeEntries.length + ' turns', 'ok');
  renderClaudeTokens();
  markUpdated();
  resizeToFit();
}

function aggregateEntries(entries) {
  return entries.reduce(
    (acc, e) => { acc.input += e.input_tokens; acc.output += e.output_tokens; acc.cacheRead += e.cache_read; acc.cacheWrite += e.cache_creation; acc.count++; return acc; },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, count: 0 }
  );
}

function renderClaudeTokens() {
  const in5h = claudeEntries.filter(e => e.ts >= Date.now() - FIVE_HOURS_MS);
  const agg  = aggregateEntries(in5h);
  document.getElementById('5h-input').textContent  = fmt(agg.input);
  document.getElementById('5h-output').textContent = fmt(agg.output);
  document.getElementById('5h-msgs').textContent   = agg.count;
}

// ── READING SHAPE ──
// One shape for every provider. Three providers previously invented their own
// names for the same four numbers — shared5h / sessionUsed / pct5h, two of them
// polarity-inverted — which is why three render functions existed to perform
// the same ten steps. Every parse function converts to this shape; nothing
// above the render layer ever sees a provider's own vocabulary again.
//
// pct* are REMAINING percentages, always. A source reporting "used" converts
// here, at the parse boundary, and never downstream.
//
// has5h / hasWk default TRUE: a window exists unless a parser positively knows
// it does not. That keeps "momentarily missing" (renders —) distinct from "the
// plan has no such window" (renders n/a), a distinction a null percentage alone
// cannot carry.
function makeReading(p = {}) {
  return {
    pct5h:     p.pct5h     ?? null,
    pctWk:     p.pctWk     ?? null,
    reset5hMs: p.reset5hMs ?? 0,
    resetWkMs: p.resetWkMs ?? 0,
    has5h:     p.has5h     ?? true,
    hasWk:     p.hasWk     ?? true,
    label:     p.label     ?? null,
    extra:     p.extra     ?? null,
  };
}

// Claude Code arrives already shaped by main.js (pct5h / pct7d from the
// anthropic-ratelimit-unified-* headers). Only the names differ.
function normaliseClaudeCodeReading(data) {
  return makeReading({
    pct5h:     data.pct5h,
    pctWk:     data.pct7d,
    reset5hMs: data.reset5hMs,
    resetWkMs: data.reset7dMs,
    has5h:     data.has5h,
    hasWk:     data.hasWk,
    label:     data.account,
  });
}
// ── READING SHAPE END ──

// ── CLAUDE PARSERS ──
// ── Claude org usage API parser ────────────────────────────────────────────
// Parses the /api/organizations/{orgId}/usage JSON response.
// five_hour.utilization and seven_day.utilization are % USED (not remaining);
// they are converted to remaining here, at the parse boundary.
function parseClaudeOrgUsage(data) {
  const fh = data?.five_hour;
  const sd = data?.seven_day;
  const ms = (iso) => (iso && !isNaN(new Date(iso))) ? new Date(iso).getTime() : 0;
  // Deliberately unclamped: over-quota (utilization > 100) is a real reading and
  // stays negative in the data. metrics.js clamps to [0,100] for display.
  const remain = (u) => (typeof u === 'number') ? 100 - u : null;
  return makeReading({
    pct5h:     remain(fh?.utilization),
    pctWk:     remain(sd?.utilization),
    reset5hMs: ms(fh?.resets_at),
    resetWkMs: ms(sd?.resets_at),
  });
}

// ── Claude web usage parser (shared) ──────────────────────────────────────
function parseClaudeWebText(text) {
  function pctUsed(pattern) {
    const m = text.match(new RegExp(pattern + '[\\s\\S]{0,500}?(\\d+)%\\s*used', 'i'));
    return m ? parseInt(m[1], 10) : null;
  }
  function pctRemaining(pattern) {
    const m = text.match(new RegExp(pattern + '[\\s\\S]{0,500}?(\\d+)%\\s*remaining', 'i'));
    return m ? parseInt(m[1], 10) : null;
  }
  const SESSION_RE = '(?:Current session|5[\\s-]hour)';
  const WEEKLY_RE  = '(?:All models|[Ww]eekly|per week)';

  const sessionUsed      = pctUsed(SESSION_RE);
  const sessionRemaining = pctRemaining(SESSION_RE);
  const weeklyUsed       = pctUsed(WEEKLY_RE);
  const weeklyRemaining  = pctRemaining(WEEKLY_RE);

  // The scrape path has no timestamps, only prose ("Resets in 3 hr 20 min").
  // parseResetToMs turns that into epoch ms because the render layer's reset
  // fallback reads it: dropping it would blank the "Resets ..." label and stop
  // the reset timestamp reaching usage-log.jsonl. An earlier pass dropped these
  // fields on the assumption that only Codex's text path needed them; the
  // Claude scrape path needed them too.
  const sessionResetStr = (text.match(/[Rr]esets in ([^\n\r]+)/i) || [])[1]?.trim() ?? null;
  const weeklyResetStr  = (text.match(/(?:All models|[Ww]eekly)[\s\S]{0,500}?[Rr]esets?\s+([^\n\r]+)/i) || [])[1]?.trim() ?? null;

  const used = (u, r) => (u != null ? u : (r != null ? 100 - r : null));
  // Unclamped for the same reason as parseClaudeOrgUsage: raw over-quota stays
  // negative; only display and metrics clamp.
  const remain = (v) => (v != null ? 100 - v : null);
  return makeReading({
    pct5h:     remain(used(sessionUsed, sessionRemaining)),
    pctWk:     remain(used(weeklyUsed, weeklyRemaining)),
    reset5hMs: parseResetToMs(sessionResetStr),
    resetWkMs: parseResetToMs(weeklyResetStr),
  });
}
// ── CLAUDE PARSERS END ──

// ── Claude Desktop ─────────────────────────────────────────────────────────
function renderClaudeWebData(parsed, stale = false) {
  const remaining5h = parsed.sessionUsed != null ? 100 - parsed.sessionUsed : null;
  const remainingWk = parsed.weeklyUsed  != null ? 100 - parsed.weeklyUsed  : null;
  if (!stale) applyAccountLabel('claude', parsed.email);

  renderStat('claude', '5h', remaining5h);
  renderStat('claude', 'wk', remainingWk);
  renderBudget('claude', remaining5h);
  setText('claude-5h-reset', parsed.sessionResetMs ? fmtResetIn(parsed.sessionResetMs) : (parsed.sessionReset ? 'Resets in ' + parsed.sessionReset : ''));
  setText('claude-wk-reset', parsed.weeklyResetMs  ? fmtResetOn(parsed.weeklyResetMs)  : (parsed.weeklyReset  ? 'Resets ' + parsed.weeklyReset : ''));

  if (!stale) {
    pushTrend('claude-5h', remaining5h);
    pushTrend('claude-wk', remainingWk);
    saveCachedData('claude', parsed);
    // Prefer exact timestamps from org API; fall back to parsed reset strings
    const reset5h = parsed.sessionResetMs || 0;
    const reset7d = parsed.weeklyResetMs  || parseResetToMs(parsed.weeklyReset);
    const entry = buildUsageEntry('claude-desktop', remaining5h, remainingWk, reset5h, reset7d);
    const cdSession = trackSession('claude-desktop', remaining5h);
    if (cdSession) entry.sessionStart = cdSession;
    window.electronAPI.appendUsageLog(entry);
  }

  document.getElementById('claude-login-prompt').style.display = 'none';
  document.getElementById('claude-data').style.display = 'block';
  showSection('claude-section', true);
  resizeToFit();
}

async function fetchClaudeWebUsage() {
  clearTimeout(claudeRetryTimer); claudeRetryTimer = null;
  fetchStart('claude');

  const result = await window.electronAPI.fetchClaudeWebUsage();
  fetchStop('claude');

  if (result.error === 'session-expired') {
    setBadge('claude-badge', 'Sign In', 'warn');
    document.getElementById('claude-data').style.display = 'none';
    document.getElementById('claude-login-prompt').style.display = 'block';
    showToast('Claude Desktop session expired — click "Open Login Window" to reconnect.');
    return;
  }
  if (result.error === 'cookie-consent-required') {
    setBadge('claude-badge', 'Action needed', 'warn');
    showToast('Accept cookies in the Claude window that just opened, then click ↻');
    return;
  }
  if (result.error === 'window-in-use') {
    claudeRetryTimer = setTimeout(fetchClaudeWebUsage, 30_000);
    return;
  }
  if (result.error) {
    setBadge('claude-badge', 'Error', 'error');
    showToast('Claude fetch error — retrying in 45s: ' + result.error);
    claudeRetryTimer = setTimeout(fetchClaudeWebUsage, 45_000);
    return;
  }

  // Prefer structured API data (org usage endpoint) over text scraping
  const parsed = result.apiData
    ? parseClaudeOrgUsage(result.apiData)
    : parseClaudeWebText(result.text || '');

  if (parsed.sessionUsed === null && parsed.weeklyUsed === null) {
    setBadge('claude-badge', 'No data', 'warn');
    const diagUrl  = result.url ? result.url.replace('https://', '') : '?';
    const diagText = (result.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    showToast(`[${diagUrl}] ${diagText || 'No usage data found'}`);
    claudeRetryTimer = setTimeout(fetchClaudeWebUsage, 45_000);
    return;
  }

  if (result.email) parsed.email = result.email;
  hasData.claude = true;
  renderClaudeWebData(parsed);
  renderClaudeTokens();
  setBadge('claude-badge', 'Live', 'ok');
  markUpdated();
  if (openPanels.has('claude')) { window.electronAPI.readUsageLog('claude-desktop', 200).then(e => renderTrendAnalytics('claude', e)); }
}

// ── Claude Code (VS Code / CLI) — direct API per account config directory ──
// Rewrites every data-id in a freshly cloned card into an id namespaced by the
// account, so two accounts' cards never share an element id. The attribute is
// dropped afterwards: a stamped card is stamped once.
function stampCardIds(root, prefix) {
  for (const el of root.querySelectorAll('[data-id]')) {
    el.id = prefix + '-' + el.dataset.id;
    el.removeAttribute('data-id');
  }
}

// A compact stat needs two id namespaces: cs-<id>-<win> on the container that
// gets shown/hidden, c-<id>-<win> on the value and trend spans inside it. One
// prefix cannot produce both, so data-id carries the c- half (stamped above)
// and data-cs the container half. Unlike data-id it is left in place: it is
// also the selector that removes only these rows from a grid shared with Codex
// and Claude Desktop.
function stampCompactIds(root, accountId) {
  for (const el of root.querySelectorAll('[data-cs]')) {
    el.id = 'cs-' + accountId + '-' + el.dataset.cs;
  }
}

// What distinguishes one Claude Code card from another in its headings. Empty
// for a lone account — the single-account screen keeps the plain headings the
// template ships with, unchanged.
function accountSuffix(acct) {
  if (claudeAccounts.length < 2) return '';
  const override = accountOverrides[acct.id];
  if (override) return override;
  const label = acct.label || '';
  if (label.includes('@')) return label.slice(0, label.indexOf('@'));
  if (label) return label;
  // No email resolved yet — the directory it came from is at least stable.
  return (acct.configDir || '').split(/[\\/]/).filter(Boolean).pop() || acct.id;
}

// Appends (or removes) a heading's account suffix, working off the template's
// own text so repeated updates never stack onto an already-suffixed heading.
// A heading that has never been suffixed and needs no suffix is left untouched
// — not even rewritten with an identical string.
function setHeadingSuffix(el, suffix) {
  if (!el || !el.firstChild) return;
  if (!suffix && el.dataset.base === undefined) return;
  if (el.dataset.base === undefined) el.dataset.base = el.firstChild.nodeValue;
  el.firstChild.nodeValue = suffix ? el.dataset.base + ' — ' + suffix : el.dataset.base;
}

// The card heading and both compact labels, kept in step with the -account
// element by being driven from applyAccountLabel — the email resolves well
// after the card is cloned.
function applyAccountHeadings(acct) {
  const suffix  = accountSuffix(acct);
  const section = document.getElementById(acct.id + '-section');
  if (section) setHeadingSuffix(section.querySelector('.section-label'), suffix);
  for (const win of ['5h', 'wk']) {
    const stat = document.getElementById('cs-' + acct.id + '-' + win);
    if (stat) setHeadingSuffix(stat.querySelector('.compact-label'), suffix);
  }
}

// Clones one card (and one compact-stat pair) per discovered account, and seeds
// the per-account state the render helpers key off. Safe to run again after a
// rescan: pending retries are cancelled, both hosts are cleared of Claude Code
// entries, and existing state for a surviving account is kept rather than reset.
async function buildClaudeCodeCards() {
  // Before anything else: a retry pending for an account that is about to
  // vanish would fire into a card that no longer exists.
  for (const id of Object.keys(claudeRetryTimers)) {
    clearTimeout(claudeRetryTimers[id]);
    delete claudeRetryTimers[id];
  }
  const found = await window.electronAPI.getClaudeAccounts();
  // A malformed reply must not leave claudeAccounts non-iterable: the catch in
  // init() would swallow the throw here and every later accountPrefixes() call
  // would fail instead.
  claudeAccounts = Array.isArray(found) ? found : [];
  const host        = document.getElementById('claude-code-cards');
  const cardTpl     = document.getElementById('tpl-claude-code-card');
  const compactTpl  = document.getElementById('tpl-claude-code-compact');
  const compactHost = document.querySelector('#compact-view .compact-grid');
  host.replaceChildren();
  // The compact grid is shared with Codex and Claude Desktop, whose stats are
  // static markup — clear only the rows this function put there.
  compactHost.querySelectorAll('[data-cs]').forEach(el => el.remove());

  for (const acct of claudeAccounts) {
    const card = cardTpl.content.cloneNode(true);
    stampCardIds(card, acct.id);
    host.appendChild(card);

    const compact = compactTpl.content.cloneNode(true);
    stampCardIds(compact, 'c-' + acct.id);   // value + trend spans
    stampCompactIds(compact, acct.id);       // stat containers
    compactHost.appendChild(compact);

    if (!(acct.id in hasData))         hasData[acct.id] = false;
    if (!(acct.id in cachedData))      cachedData[acct.id] = null;
    if (!(acct.id in lastPct5h))       lastPct5h[acct.id] = null;
    if (!(acct.id in accountOverrides)) accountOverrides[acct.id] = '';
    LOG_ACCOUNT[acct.id] = acct.logKey;
    trendHistory[acct.id + '-5h'] = trendHistory[acct.id + '-5h'] || [];
    trendHistory[acct.id + '-wk'] = trendHistory[acct.id + '-wk'] || [];
    _ss[acct.logKey] = _ss[acct.logKey] || { start: null, lastPct: null };

    // Handlers the template cannot carry, because each needs its own account.
    const section = document.getElementById(acct.id + '-section');
    document.getElementById(acct.id + '-refresh')
      .addEventListener('click', () => fetchClaudeCodeUsage(acct));
    document.getElementById(acct.id + '-trend-toggle')
      .addEventListener('click', () => toggleTrend(acct.id));
    document.getElementById(acct.id + '-analytics-btn')
      .addEventListener('click', () => window.electronAPI.openAnalytics(acct.logKey));
    // data-section mirrors the static cards, so the button is self-describing
    // even though its handler is wired here rather than by the load-time sweep.
    const hideBtn = section.querySelector('.section-hide-btn');
    hideBtn.dataset.section = acct.id + '-section';
    hideBtn.addEventListener('click', () => hideSection(hideBtn.dataset.section));
    section.querySelectorAll('.card-title.clickable').forEach(el => {
      el.addEventListener('click', () => window.electronAPI.openExternal(el.dataset.url));
    });
    // The credentials path is this account's own, not always ~/.claude.
    const sep = acct.configDir.includes('\\') ? '\\' : '/';
    document.getElementById(acct.id + '-cred-path').textContent =
      acct.configDir + sep + '.credentials.json';

    // One funnel: paints the label when the registry already knows it, and the
    // headings either way.
    applyAccountLabel(acct.id, acct.label);
  }
}

function renderClaudeCodeApiData(acct, data, stale = false) {
  const id = acct.id;
  if (!stale) applyAccountLabel(id, data.account);

  renderStat(id, '5h', data.pct5h);
  renderStat(id, 'wk', data.pct7d);
  renderBudget(id, data.pct5h);
  setText(id + '-5h-reset', data.reset5hMs > 0 ? fmtResetIn(data.reset5hMs) : (data.reset5h ? 'Resets in ' + data.reset5h : ''));
  setText(id + '-wk-reset', data.reset7dMs > 0 ? fmtResetOn(data.reset7dMs) : (data.reset7d ? 'Resets in ' + data.reset7d : ''));

  if (!stale) {
    pushTrend(id + '-5h', data.pct5h);
    pushTrend(id + '-wk', data.pct7d);
    // Cache in a format compatible with loadCachedClaudeCodeData (this account's slot)
    const cacheObj = { sessionUsed: data.pct5h != null ? 100 - data.pct5h : null, weeklyUsed: data.pct7d != null ? 100 - data.pct7d : null, sessionReset: data.reset5h, weeklyReset: data.reset7d, account: data.account };
    saveCachedData(id, cacheObj);
    const entry = buildUsageEntry(acct.logKey, data.pct5h, data.pct7d, data.reset5hMs || 0, data.reset7dMs || 0);
    // Claude Code: exact session start derived from API reset header (5h before next reset)
    if (data.reset5hMs > 0) {
      const vsSession = new Date(data.reset5hMs - 5 * 3_600_000).toISOString();
      entry.sessionStart = vsSession;
      _ss[acct.logKey].start   = vsSession;
      _ss[acct.logKey].lastPct = data.pct5h;
    } else {
      const vsSession = trackSession(acct.logKey, data.pct5h);
      if (vsSession) entry.sessionStart = vsSession;
    }
    window.electronAPI.appendUsageLog(entry);
  }

  // `?.` can't sit on an assignment's left-hand side (that's a SyntaxError),
  // so the guard here is a plain null check — same intent as the `?.` used
  // above for fetchStart/fetchStop/setBadge/setPct: a successful fetch that
  // resolves after a rebuild dropped this account must not throw on `null`.
  const loginPromptEl = document.getElementById(id + '-login-prompt');
  if (loginPromptEl) loginPromptEl.style.display = 'none';
  const dataEl = document.getElementById(id + '-data');
  if (dataEl) dataEl.style.display = 'block';
  showSection(id + '-section', true);
  resizeToFit();
}

// ── Claude Code account email ──────────────────────────────────────────────
// The cache exists only to paint a label instantly at startup — it is never
// authoritative. A fresh `claude login` swaps the account under a running app,
// so every poll re-resolves the email from the live credentials; a write-once
// cache would keep showing the previous account's address forever.
function claudeEmailCacheKey(acct) {
  // Keyed by logKey, not by email: the label may change under us, the key must not.
  return 'claude-code-email:' + acct.logKey;
}

function readClaudeCodeEmailCache(acct) {
  const key = claudeEmailCacheKey(acct);
  try {
    const own = JSON.parse(localStorage.getItem(key) || 'null');
    if (own) return own;
    // One-time carry-over so the existing card keeps its label on first run.
    if (acct.logKey === 'claude-vscode') {
      const legacy = JSON.parse(localStorage.getItem('claude2-email-v2') || 'null');
      if (legacy) { localStorage.setItem(key, JSON.stringify(legacy)); return legacy; }
    }
    return null;
  } catch { return null; }
}

async function refreshClaudeCodeEmail(acct) {
  const cached = readClaudeCodeEmailCache(acct);
  if (cached) applyAccountLabel(acct.id, cached);
  const email = await window.electronAPI.fetchClaudeCodeEmail(acct.configDir);
  // Empty means the lookup failed (offline, no credentials) — keep showing the
  // cached label rather than blanking it.
  if (!email || email === cached) return cached;
  localStorage.setItem(claudeEmailCacheKey(acct), JSON.stringify(email));
  applyAccountLabel(acct.id, email);
  return email;
}

async function fetchClaudeCodeUsage(acct) {
  clearTimeout(claudeRetryTimers[acct.id]); claudeRetryTimers[acct.id] = null;
  fetchStart(acct.id);

  const result = await window.electronAPI.fetchClaudeCodeApiUsage(acct.configDir);
  fetchStop(acct.id);

  // Toasts name the account: with several cards up, an unattributed error is
  // one you cannot act on.
  const who = acct.label || acct.configDir;
  if (result.error === 'no-credentials') {
    setBadge(acct.id + '-badge', 'No credentials', 'error');
    showToast(`Claude Code credentials not found (${who}) — run "claude login" to authenticate.`);
    // Show the prompt, not just the badge. It carries the `claude login` hint
    // and THIS account's credentials path (painted in buildClaudeCodeCards) —
    // the only place the user is told which directory is actually missing a
    // login. Without this the block is markup nothing ever displays, and the
    // toast has faded five seconds later.
    const promptEl = document.getElementById(acct.id + '-login-prompt');
    if (promptEl) promptEl.style.display = '';
    const dataEl = document.getElementById(acct.id + '-data');
    if (dataEl) dataEl.style.display = 'none';
    showSection(acct.id + '-section', true);
    resizeToFit();
    return;
  }
  if (result.error) {
    setBadge(acct.id + '-badge', 'Error', 'error');
    showToast(`Claude Code API error (${who}) — retrying in 45s: ` + result.error);
    claudeRetryTimers[acct.id] = setTimeout(() => fetchClaudeCodeUsage(acct), 45_000);
    return;
  }

  hasData[acct.id] = true;
  renderClaudeCodeApiData(acct, result);
  setBadge(acct.id + '-badge', 'Live', 'ok');
  if (openPanels.has(acct.id)) { window.electronAPI.readUsageLog(acct.logKey, 200).then(e => renderTrendAnalytics(acct.id, e)); }
  markUpdated();

  refreshClaudeCodeEmail(acct).catch(e => console.error('claude code email refresh:', e));
}

// ── Codex ──────────────────────────────────────────────────────────────────
// ── CODEX PARSERS ──
// OpenAI reports each rate-limit window's own length in `limit_window_seconds`
// (18000 = 5 hours, 604800 = weekly). Split at a day: shorter is a session
// window, longer is a weekly one.
//
// Matching on the declared length rather than on the window's POSITION in the
// response is what keeps this honest. When OpenAI dropped the Codex 5-hour
// window on 2026-07-11, the weekly window moved into `primary_window` and
// `secondary_window` vanished — and the old position-based parse relabelled six
// weeks of weekly figures as 5-hour ones without a single error.
const CODEX_WINDOW_SPLIT_SECONDS = 24 * 3600;
// Slack for the reset-distance fallback: a 5-hour window cannot reset more than
// 5 hours out, but the server's clock and ours are not the same clock.
const CODEX_5H_RESET_SLACK_MS = 6 * 3_600_000;
// The page's own 5-hour heading. Its absence is the scraped equivalent of a
// missing 5h window, and is why `has5h` can be answered from text too.
const CODEX_5H_LABEL = '5 hour usage limit';

// Which slot a rate-limit window belongs in: '5h', 'wk', or null when the
// window declares nothing we can judge it by. `now` is a parameter so this
// never reads the clock behind a test's back.
function classifyCodexWindow(w, now) {
  if (!w || typeof w !== 'object') return null;
  const secs = w.limit_window_seconds;
  if (typeof secs === 'number' && secs > 0) {
    return secs <= CODEX_WINDOW_SPLIT_SECONDS ? '5h' : 'wk';
  }
  // Undeclared length — judge it by how far away the reset is instead.
  if (typeof w.reset_at === 'number' && Number.isFinite(now)) {
    return (w.reset_at * 1000 - now) <= CODEX_5H_RESET_SLACK_MS ? '5h' : 'wk';
  }
  return null;
}

function parseCodexText(text) {
  function pct(label) {
    const m = text.match(new RegExp(label + '[\\s\\S]{0,300}?(\\d+)%\\s*remaining', 'i'));
    return m ? parseInt(m[1], 10) : null;
  }
  function resetTime(label) {
    const m = text.match(new RegExp(label + '[\\s\\S]{0,500}?[Rr]esets?\\s+([^\\n\\r]+)', 'i'));
    return m ? m[1].trim() : null;
  }
  const creditsM = text.match(/credits remaining[\s\S]{0,100}?(\d[\d,]*)/i);
  // Like the Claude scrape, the Codex page gives prose ("Resets in 2 hr 10 min"),
  // not timestamps. parseResetToMs converts it to epoch ms because the render
  // layer's reset fallback reads it: dropping it would blank the "Resets ..."
  // label and stop the reset timestamps reaching usage-log.jsonl. A page with no
  // such section yields null, which parseResetToMs maps to 0: the shape's
  // "unknown".
  return makeReading({
    pct5h:     pct(CODEX_5H_LABEL),
    pctWk:     pct('Weekly usage limit'),
    reset5hMs: parseResetToMs(resetTime(CODEX_5H_LABEL)),
    resetWkMs: parseResetToMs(resetTime('Weekly usage limit')),
    // Agrees with the API path so a fallback poll can't flip the 5h tile
    // between 'n/a' and '—'. An empty page claims nothing, and the both-null
    // guard in fetchCodexUsage stops it reaching the render.
    has5h:     new RegExp(CODEX_5H_LABEL, 'i').test(text),
    extra:     creditsM ? { credits: creditsM[1] } : null,
  });
}

// Structured Codex usage from /backend-api/codex/usage. `used_percent` is
// % USED; `reset_at` is Unix seconds. At most two windows arrive, keyed by
// position — classifyCodexWindow decides what each one actually is, and the
// historic position is used only for a window that declares neither a length
// nor a reset.
function parseCodexApiUsage(data, now = Date.now()) {
  const rl = data && data.rate_limit;
  if (!rl) return null;

  const slot = { '5h': null, wk: null };
  for (const [position, w] of [['5h', rl.primary_window], ['wk', rl.secondary_window]]) {
    if (!w || typeof w !== 'object') continue;
    const target = classifyCodexWindow(w, now) || position;
    // First window to claim a slot keeps it: a response that somehow yields two
    // windows of the same length loses the second rather than overwriting a
    // reading that is already good.
    if (!slot[target]) slot[target] = w;
  }

  const remain  = (w) => (w && typeof w.used_percent === 'number') ? Math.max(0, 100 - w.used_percent) : null;
  const resetMs = (w) => (w && w.reset_at) ? w.reset_at * 1000 : 0;
  return makeReading({
    pct5h:     remain(slot['5h']),
    pctWk:     remain(slot.wk),
    reset5hMs: resetMs(slot['5h']),
    resetWkMs: resetMs(slot.wk),
    // Whether the plan HAS a 5-hour window at all — something `pct5h === null`
    // cannot express. "No such window" and "momentarily missing" render
    // differently ('n/a' vs '—').
    has5h:     slot['5h'] !== null,
    hasWk:     slot.wk !== null,
    label:     data.email || null,
    extra:     (data.credits && data.credits.balance != null)
      ? { credits: data.credits.balance } : null,
  });
}
// ── CODEX PARSERS END ──

function renderCodexData(parsed, stale = false) {
  if (!stale) applyAccountLabel('codex', parsed.email);

  // A plan with no 5-hour window reads 'n/a', not —: the tile is not waiting
  // for a number, there is no such number. A cache written before this flag
  // existed has has5h undefined, so only an explicit false counts — the next
  // live poll settles it either way.
  const no5h = parsed.has5h === false;
  if (no5h) noFiveHourWindow.add('codex'); else noFiveHourWindow.delete('codex');

  renderStat('codex', '5h', parsed.shared5h, no5h ? 'n/a' : undefined);
  renderStat('codex', 'wk', parsed.sharedWeek);
  renderBudget('codex', parsed.shared5h);
  setText('codex-5h-reset', no5h ? '' : (parsed.reset5hMs > 0 ? fmtResetIn(parsed.reset5hMs) : (parsed.shared5hReset ? 'Resets ' + parsed.shared5hReset : '')));
  setText('codex-wk-reset', parsed.reset7dMs > 0 ? fmtResetOn(parsed.reset7dMs) : (parsed.sharedWeekReset ? 'Resets ' + parsed.sharedWeekReset : ''));
  setText('codex-credits', parsed.credits);

  if (!stale) {
    pushTrend('codex-5h', parsed.shared5h);
    pushTrend('codex-wk', parsed.sharedWeek);
    saveCachedData('codex', parsed);
    const fhReset = parsed.reset5hMs > 0 ? parsed.reset5hMs : parseResetToMs(parsed.shared5hReset);
    const wkReset = parsed.reset7dMs > 0 ? parsed.reset7dMs : parseResetToMs(parsed.sharedWeekReset);
    const entry = buildUsageEntry('codex', parsed.shared5h, parsed.sharedWeek, fhReset, wkReset);
    // A "session" IS a 5-hour window. With no such window there is nothing to
    // track, and carrying the last one forward would freeze the session count
    // at whatever it happened to be the day the window disappeared.
    const cxSession = no5h ? null : trackSession('codex', parsed.shared5h);
    if (cxSession) entry.sessionStart = cxSession;
    window.electronAPI.appendUsageLog(entry);
  }

  document.getElementById('codex-login-prompt').style.display = 'none';
  document.getElementById('codex-data').style.display = 'block';
  showSection('codex-section', true);
  resizeToFit();
}

async function fetchCodexUsage() {
  clearTimeout(codexRetryTimer); codexRetryTimer = null;
  fetchStart('codex');

  const result = await window.electronAPI.fetchCodexUsage();
  fetchStop('codex');

  if (result.error) {
    if (result.error === 'window-closed' || result.error === 'Login timeout — please log in and try again') {
      setBadge('codex-badge', 'Login needed', 'warn');
      return;
    }
    setBadge('codex-badge', 'Error', 'error');
    showToast('Codex error — retrying in 45s: ' + result.error);
    codexRetryTimer = setTimeout(fetchCodexUsage, 45_000);
    return;
  }

  // Prefer structured API data (/backend-api/codex/usage) over text scraping
  const apiParsed = result.apiData ? parseCodexApiUsage(result.apiData) : null;
  const parsed = (apiParsed && (apiParsed.shared5h !== null || apiParsed.sharedWeek !== null))
    ? apiParsed
    : parseCodexText(result.text || '');
  if (parsed.shared5h === null && parsed.sharedWeek === null) {
    setBadge('codex-badge', 'No data', 'warn');
    showToast('Could not find usage data — try opening the login window.');
    codexRetryTimer = setTimeout(fetchCodexUsage, 45_000);
    return;
  }

  if (!parsed.email && result.email) parsed.email = result.email;
  hasData.codex = true;
  renderCodexData(parsed);
  setBadge('codex-badge', 'Live', 'ok');
  markUpdated();
  if (openPanels.has('codex')) { window.electronAPI.readUsageLog('codex', 200).then(e => renderTrendAnalytics('codex', e)); }
}

// ── Cached data (stale display on startup) ────────────────────────────────
// Split in two on purpose: a Claude Code card rebuild re-clones only those
// cards, so repainting Codex and Claude Desktop from cache — and stamping them
// 'Cached' — would flip two live cards back to stale for a whole poll.
function loadCachedStaticData(settings) {
  const kn = settings.lastKnown;
  if (!kn) return;
  if (kn.codex)   { renderCodexData(kn.codex, true);       setBadge('codex-badge',  'Cached', 'stale'); }
  if (kn.claude)  { renderClaudeWebData(kn.claude, true);  setBadge('claude-badge', 'Cached', 'stale'); }
}

function loadCachedClaudeCodeData(settings) {
  const kn = settings.lastKnown;
  if (!kn) return;
  // Seeds cachedData from the persisted slots. buildClaudeCodeCards resets the
  // slot of every account it clones, and the next saveCachedData persists the
  // whole map — an un-restored slot would write null over a good cached value.
  Object.assign(cachedData, kn);
  // One slot per Claude Code account, keyed by descriptor id. A slot left over
  // from an account that is no longer discovered simply has no card to paint.
  for (const acct of claudeAccounts) {
    const c = kn[acct.id];
    if (!c) continue;
    // Cache stored as {sessionUsed, weeklyUsed, ...} — convert to API format
    const pct5h = c.sessionUsed != null ? 100 - c.sessionUsed : c.pct5h ?? null;
    const pct7d = c.weeklyUsed  != null ? 100 - c.weeklyUsed  : c.pct7d  ?? null;
    renderClaudeCodeApiData(acct, { pct5h, pct7d, reset5h: c.sessionReset ?? c.reset5h, reset7d: c.weeklyReset ?? c.reset7d, account: c.account }, true);
    setBadge(acct.id + '-badge', 'Cached', 'stale');
    const e = readClaudeCodeEmailCache(acct); if (e) applyAccountLabel(acct.id, e);
  }
}

// ── Refresh interval ───────────────────────────────────────────────────────
function setRefreshInterval(seconds) {
  refreshSeconds = seconds;
  refreshIntervalIds.forEach(clearInterval);
  // One timer fanning out over every account, so all readings in a round come
  // from the same instant — and so an account discovered later is picked up
  // without re-timing anything. Budget info refreshes on the same tick:
  // otherwise the day figure never grows, never resets at midnight, and a
  // fresh install stays on "need more history".
  refreshIntervalIds = [setInterval(() => {
    fetchClaudeWebUsage();
    fetchCodexUsage();
    claudeAccounts.forEach(acct => fetchClaudeCodeUsage(acct));
    refreshBudget();
  }, seconds * 1000)];
  window.electronAPI.saveSettings({ refreshInterval: seconds });
}


// ── UI wiring ──────────────────────────────────────────────────────────────
document.getElementById('codex-load-btn').addEventListener('click', fetchCodexUsage);
document.getElementById('codex-refresh').addEventListener('click', fetchCodexUsage);
document.getElementById('codex-login-btn').addEventListener('click', () => {
  showSection('codex-section', true);
  window.electronAPI.showCodexWindow();
  showToast('Log in, then click ↻ Refresh Codex.');
});

document.getElementById('claude-login-btn').addEventListener('click', () => {
  window.electronAPI.showClaudeWebWindow();
  showToast('Log in to claude.ai, then click ↻ to refresh.');
});
async function borrowClaudeDesktopSession() {
  showToast('Importing Claude Desktop session…');
  const result = await window.electronAPI.borrowClaudeDesktopSession();
  if (result.ok) {
    showToast(`Imported ${result.imported} cookies — loading usage…`);
    hasData.claude = false;
    fetchClaudeWebUsage();
  } else {
    showToast('Import failed: ' + (result.reason || 'unknown — is the Claude Desktop app installed & signed in?'));
  }
}
document.getElementById('btn-borrow-claude-session')?.addEventListener('click', borrowClaudeDesktopSession);
document.getElementById('claude-load-btn').addEventListener('click', fetchClaudeWebUsage);
document.getElementById('claude-refresh').addEventListener('click', fetchClaudeWebUsage);
async function logoffClaudeDesktop() {
  showToast('Logging off Claude Desktop…');
  await window.electronAPI.resetClaudeSession('desktop');
  hasData.claude = false;
  document.getElementById('claude-data').style.display = 'none';
  document.getElementById('claude-login-prompt').style.display = '';
  setBadge('claude-badge', '–', '');
  showToast('Logged off Claude Desktop — import or sign in to connect an account.');
}
document.getElementById('claude-signout-btn')?.addEventListener('click', logoffClaudeDesktop);

// Claude Code refresh buttons are wired per clone in buildClaudeCodeCards —
// no card exists yet at this point in the script.

// Card title → open in browser (static cards; cloned ones wire their own)
document.querySelectorAll('.card-title.clickable').forEach(el => {
  el.addEventListener('click', () => window.electronAPI.openExternal(el.dataset.url));
});

document.getElementById('btn-pin').addEventListener('click', () => window.electronAPI.toggleAlwaysOnTop());
document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimizeWindow());
document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.closeWindow());

window.electronAPI.onAlwaysOnTopChanged((val) => {
  const btn = document.getElementById('btn-pin');
  btn.classList.toggle('active', val);
  btn.title = val ? 'Always on Top: ON' : 'Always on Top: OFF';
});

// ── Card rebuild ───────────────────────────────────────────────────────────
// Cloning the cards is only half the job. Hidden sections, label overrides and
// the cached values all address cards BY ID, so they have to be re-applied to
// the fresh clones — otherwise a rebuild resurrects sections the user hid and
// blanks the cards that already had data. init() and the accounts-changed
// handler share this so the two can never drift apart.
function applyClaudeCardSettings(settings) {
  applyHiddenSections(settings);
  if (settings.accountOverrides) {
    Object.assign(accountOverrides, settings.accountOverrides);
    accountPrefixes().forEach(p => applyAccountLabel(p, null));
  }
  loadCachedClaudeCodeData(settings);
}

// The set of accounts moved (a rescan found or lost a config directory, or a
// newly-resolved email collapsed two of them). Re-clone, re-apply everything
// that addresses a card by id, then fetch — a card that only appeared after the
// rebuild would otherwise sit blank until the next tick.
async function rebuildClaudeCodeCards() {
  await buildClaudeCodeCards();
  try {
    applyClaudeCardSettings((await window.electronAPI.getSettings()) || {});
  } catch (e) {
    console.error('rebuild settings apply:', e);
  }
  claudeAccounts.forEach(acct => fetchClaudeCodeUsage(acct));
  resizeToFit();
}

// Serialises rebuilds. Main coalesces by registry shape, but two events can
// still land while one rebuild is mid-flight, and overlapping runs would clear
// the card hosts underneath each other. A queued flag rather than a plain drop,
// so the last event is never the one that gets lost.
let cardRebuildInFlight = null;
let cardRebuildQueued = false;
function requestCardRebuild() {
  if (cardRebuildInFlight) { cardRebuildQueued = true; return cardRebuildInFlight; }
  cardRebuildInFlight = (async () => {
    try { await rebuildClaudeCodeCards(); }
    catch (e) { console.error('claude accounts rebuild:', e); }
    finally {
      cardRebuildInFlight = null;
      if (cardRebuildQueued) { cardRebuildQueued = false; requestCardRebuild(); }
    }
  })();
  return cardRebuildInFlight;
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  const aot = await window.electronAPI.getAlwaysOnTop();
  document.getElementById('btn-pin').classList.toggle('active', aot);

  // Before anything settings-driven: restoring hidden sections, painting cached
  // values and applying label overrides all address these cards by id, so the
  // cards have to exist first.
  try { await buildClaudeCodeCards(); } catch (e) { console.error('buildClaudeCodeCards:', e); }

  let settings = {};
  try {
    settings = await window.electronAPI.getSettings();
    if (settings.compact) setCompact(true);
    if (settings.refreshInterval) refreshSeconds = settings.refreshInterval;
    // Show last known values immediately while live fetch runs. The Claude Code
    // half rides applyClaudeCardSettings, so a rebuild gets it too; the two
    // static cards are init-only, because a rebuild must not repaint them.
    applyClaudeCardSettings(settings);
    loadCachedStaticData(settings);
  } catch (e) {
    console.error('Settings load error:', e);
  }

  try { await loadClaudeData(); } catch (e) { console.error('loadClaudeData:', e); }

  // Fetch every account in parallel
  fetchClaudeWebUsage();
  claudeAccounts.forEach(acct => fetchClaudeCodeUsage(acct));
  fetchCodexUsage();
  refreshBudget();

  setRefreshInterval(refreshSeconds);

  // A rescan from Settings, or a same-account collapse, changes which cards
  // belong on screen — `settings-changed` cannot express that, so it has its
  // own channel.
  window.electronAPI.onClaudeAccountsChanged(() => { requestCardRebuild(); });

  window.electronAPI.onSettingsChanged(async () => {
    try {
      const s = await window.electronAPI.getSettings();
      if (s.accountOverrides) {
        Object.assign(accountOverrides, s.accountOverrides);
        accountPrefixes().forEach(p => applyAccountLabel(p, null));
      }
      if (s.refreshInterval && s.refreshInterval !== refreshSeconds) setRefreshInterval(s.refreshInterval);
      refreshBudget();
    } catch {}
  });
}

init();
