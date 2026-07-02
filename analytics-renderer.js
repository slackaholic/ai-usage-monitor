'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const VALID_ACCOUNTS = ['codex', 'claude-desktop', 'claude-vscode'];
const ACCOUNT_LABELS = { codex: 'Codex', 'claude-desktop': 'Claude Desktop', 'claude-vscode': 'Claude Code' };
const initialAccount = new URLSearchParams(window.location.search).get('account');
let currentAccount = VALID_ACCOUNTS.includes(initialAccount) ? initialAccount : 'codex';
let windowHours    = 24;
let rowLimit       = 200;
let monthEntries = [];
let displayYear = null;
let displayMonth = null;
let curSymbol = '£';
let usdRate = 0.79;

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

function fmtRunwayDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleDateString([], { weekday: 'short' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtGap(ms) {
  if (ms == null) return '-';
  const label = fmtDuration(Math.abs(ms));
  return ms > 0 ? `${label} short` : `${label} buffer`;
}

function fmtEvidenceSpan(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return 'short sample';
  const minutes = Math.max(1, Math.round(n / 60_000));
  if (minutes < 60) return `${minutes}m sample`;
  const hours = n / 3_600_000;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h sample`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d sample`;
}
function fmtMultiplier(v) {
  const n = Number(v);
  if (v == null || !isFinite(n)) return '-';
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '') + 'x';
}

function planMultiplierFor(settings, account) {
  const configured = Number(settings && settings.planMultipliers && settings.planMultipliers[account]);
  if (configured > 0 && isFinite(configured)) return configured;
  if (account === 'codex') return 5;
  // Plan CAPACITY defaults to base (1x) when unset — deliberately decoupled from
  // PLAN_MULTIPLIERS (token-consumption burn rate). Set per account in Settings.
  return 1;
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function fmtMoney(v) { return curSymbol + (v || 0).toFixed(2); }          // value already in display currency
function fmtMoneyUsd(usd) { return curSymbol + ((usd || 0) * usdRate).toFixed(2); } // convert USD → display
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n || 0);
}
function windowCutoffMs() { return windowHours > 0 ? Date.now() - windowHours * 3_600_000 : null; }
function windowLabel() {
  if (windowHours === 0) return 'all time';
  if (windowHours % 24 === 0) return `last ${windowHours / 24}d`;
  return `last ${windowHours}h`;
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

  // Session burn rate: only intervals where 5h was actively dropping AND poll gap < 15min.
  // Excludes idle time so the rate reflects actual usage intensity, not diluted averages.
  let sessionDrop = 0, sessionMs = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt  = new Date(pts[i].ts).getTime() - new Date(pts[i - 1].ts).getTime();
    const d5h = pts[i - 1]['5h'] - pts[i]['5h'];
    if (d5h > 0 && dt < 15 * 60_000) {
      sessionDrop += d5h;
      sessionMs   += dt;
    }
  }
  const rateSession = sessionMs > 0 ? sessionDrop / (sessionMs / 3_600_000) : 0;

  // Depletion: prefer rateNow → rateSession → rateAll (most to least real-time)
  const effectiveRate = rateNow > 0 ? rateNow : rateSession > 0 ? rateSession : rateAll;
  const ratePerMs     = effectiveRate / 3_600_000;
  let depletesAt = null;
  if (effectiveRate > 0 && last['5h'] > 0) {
    depletesAt = new Date(new Date(last.ts).getTime() + last['5h'] / ratePerMs);
  }

  // Weekly depletion — use session-only rate for weekly too (same idle-exclusion logic)
  const wkPts = entries.filter(e => e['wk'] != null);
  let depleteWkAt = null, rateSessionWk = 0, sessionMsWk = 0;
  if (wkPts.length >= 2) {
    let wkDrop = 0;
    for (let i = 1; i < wkPts.length; i++) {
      const dt  = new Date(wkPts[i].ts).getTime() - new Date(wkPts[i - 1].ts).getTime();
      const dwk = wkPts[i - 1]['wk'] - wkPts[i]['wk'];
      if (dwk > 0 && dt < 15 * 60_000) { wkDrop += dwk; sessionMsWk += dt; }
    }
    rateSessionWk = sessionMsWk > 0 ? wkDrop / (sessionMsWk / 3_600_000) : 0;
    const wkLast = wkPts[wkPts.length - 1];
    // Fall back to overall avg if no active drops detected (very slow-draining weekly)
    if (rateSessionWk === 0) {
      const wkFirst = wkPts[0];
      const wkSpanMs = new Date(wkLast.ts) - new Date(wkFirst.ts);
      const totalDrop = wkFirst['wk'] - wkLast['wk'];
      rateSessionWk = wkSpanMs > 0 && totalDrop > 0 ? totalDrop / (wkSpanMs / 3_600_000) : 0;
    }
    if (rateSessionWk > 0 && wkLast['wk'] > 0) {
      depleteWkAt = new Date(new Date(wkLast.ts).getTime() + (wkLast['wk'] / rateSessionWk) * 3_600_000);
    }
  }

  return { rateAll, rateNow, ratePeak, rateSession, sessionMs, ratePerMs, depletesAt, depleteWkAt, sessions, lastResetAt, nextResetEst };
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
function renderStats(entries, container, settings = {}) {
  if (!entries.length) {
    container.innerHTML = '<div class="empty">No data in this window.</div>';
    return;
  }

  const last   = entries[entries.length - 1];
  const burn   = computeBurnStats(entries);
  const dep5h  = countDepletionEvents(entries, '5h');
  const depWk  = countDepletionEvents(entries, 'wk');
  // Count distinct sessions from logged sessionStart field (falls back to computed jump count)
  const loggedSessions = new Set(entries.map(e => e.sessionStart).filter(Boolean)).size;
  const sessionCount   = loggedSessions || burn.sessions;
  const spanMs = new Date(last.ts) - new Date(entries[0].ts);
  const mult   = PLAN_MULTIPLIERS[currentAccount] ?? 1;
  const configuredPlanMultiplier = planMultiplierFor(settings, currentAccount);
  const runway = weeklyRunway(entries, configuredPlanMultiplier);
  const runwayCls = runway.confidence === 'none' || runway.gapMs == null ? 'dim'
    : runway.gapMs > 0 ? 'red'
    : runway.gapMs > -12 * 3_600_000 ? 'amber'
    : 'green';
  const runwayHasProjection = runway.confidence !== 'none' && runway.gapMs != null;
  const runwayEvidence = fmtEvidenceSpan(runway.evidenceMs);
  const runwayPace = runway.evidenceMs > 0 && runway.evidenceMs < 12 * 3_600_000 ? 'early pace' : 'current pace';
  const runwayCards = !runwayHasProjection ? [
    { label: 'Weekly Runway', value: '-', sub: runway.confidence === 'limited' ? `${runwayEvidence} so far` : 'need weekly movement', cls: 'dim' },
    { label: 'Reset Gap', value: '-', sub: 'vs weekly reset', cls: 'dim' },
    { label: 'Plan Fit', value: `${fmtMultiplier(configuredPlanMultiplier)} -> -`, sub: runway.confidence === 'limited' ? 'waiting for steadier sample' : 'current plan - pace check', cls: 'dim' },
    { label: 'At Reset', value: '-', sub: 'projected weekly headroom', cls: 'dim' },
  ] : [
    {
      label: 'Weekly Runway',
      value: runway.gapMs > 0 ? fmtRunwayDate(runway.projectedDepleteTs) : 'Lasts to reset',
      sub: `based on ${runwayPace} - ${runwayEvidence}`,
      cls: runwayCls,
    },
    { label: 'Reset Gap', value: fmtGap(runway.gapMs), sub: 'vs weekly reset', cls: runwayCls },
    {
      label: 'Plan Fit',
      value: `${fmtMultiplier(runway.currentPlanMultiplier)} -> ~${fmtMultiplier(runway.requiredPlanMultiplier)}`,
      sub: `if ${runwayPace} holds`,
      cls: runwayCls,
    },
    {
      label: 'At Reset',
      value: Math.round(runway.projectedHeadroomAtResetPct) + '%',
      sub: `if ${runwayPace} holds`,
      cls: runwayCls,
    },
  ];
  const fmtDepleteTime = (d) => d
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (d - Date.now() < 0 ? ' (past)' : '')
    : null;

  const deplete5hStr = fmtDepleteTime(burn.depletesAt) ?? (burn.rateAll === 0 ? 'stable' : '—');
  const depleteWkStr = fmtDepleteTime(burn.depleteWkAt);
  const depleteWkFull = burn.depleteWkAt
    ? burn.depleteWkAt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      + ' ' + burn.depleteWkAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  // Show the sooner constraint as the primary value
  const depleteSooner = burn.depletesAt && burn.depleteWkAt
    ? (burn.depletesAt <= burn.depleteWkAt ? burn.depletesAt : burn.depleteWkAt)
    : (burn.depletesAt ?? burn.depleteWkAt);
  const depleteStr  = depleteSooner
    ? depleteSooner.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (depleteSooner - Date.now() < 0 ? ' (past)' : '')
    : burn.rateAll === 0 ? 'stable' : '—';
  const depleteWhich = depleteSooner === burn.depleteWkAt && depleteSooner !== burn.depletesAt ? 'wk' : '5h';
  const depleteSub = dep5h || depWk
    ? `${dep5h}×5h ${depWk}×wk depletions`
    : depleteStr === 'stable' ? 'no measurable drain'
    : depleteWhich === 'wk'
      ? `wk limit · 5h: ${deplete5hStr}`
      : depleteWkFull
        ? `5h limit · wk: ${depleteWkFull}`
        : '5h limit · at current rate';


  const used5h = last['5h'] != null ? (100 - last['5h']) + '%' : '—';
  const used5hCls = last['5h'] != null ? (last['5h'] < 20 ? 'red' : last['5h'] < 50 ? 'amber' : '') : '';

  // 5H reset — prefer exact API timestamp, fall back to log-jump estimate
  const apiReset5h = [...entries].reverse().find(e => e.reset5hTs > 0)?.reset5hTs ?? null;
  let next5hStr = '—', next5hSub = '—';
  if (apiReset5h) {
    const msUntil = apiReset5h - Date.now();
    const timeStr = new Date(apiReset5h).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    next5hStr = timeStr;
    next5hSub = msUntil > 0 ? `in ${fmtDuration(msUntil)} · from API` : 'reset passed — refresh';
  } else if (burn.nextResetEst) {
    const msUntil = burn.nextResetEst - Date.now();
    if (msUntil > 0 && msUntil < 5.5 * 3_600_000) {
      next5hStr = burn.nextResetEst.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      next5hSub = `in ${fmtDuration(msUntil)} · est.`;
    }
  }

  // Weekly reset — from logged reset7dTs (all accounts)
  const apiReset7d = [...entries].reverse().find(e => e.reset7dTs > 0)?.reset7dTs ?? null;
  let next7dStr = '—', next7dSub = 'will appear after next poll';
  if (apiReset7d) {
    const msUntil = apiReset7d - Date.now();
    const d = new Date(apiReset7d);
    const dateStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    next7dStr = dateStr;
    next7dSub = msUntil > 0 ? `${timeStr} · in ${fmtDuration(msUntil)}` : 'reset passed — refresh';
  }

  // ── Weekly window analysis ────────────────────────────────────────────────
  // Derive weekly period start from the logged reset timestamp — no calendar assumptions.
  // Works correctly regardless of when the subscription started or was renewed.
  const lastWeeklyResetMs = apiReset7d ? apiReset7d - 7 * 86_400_000 : null;

  const thisWeekEntries = lastWeeklyResetMs
    ? entries.filter(e => new Date(e.ts).getTime() >= lastWeeklyResetMs)
    : entries;

  const logCoversWeekStart = !!(lastWeeklyResetMs &&
    entries.length > 0 && new Date(entries[0].ts).getTime() <= lastWeeklyResetMs);

  // Count 5H windows elapsed this weekly period via log-detected >15pp upward jumps
  const twPts = thisWeekEntries.filter(e => e['5h'] != null);
  let windowsElapsed = twPts.length > 0 ? 1 : 0; // current partial window counts as 1
  for (let i = 1; i < twPts.length; i++) {
    if (twPts[i]['5h'] - twPts[i - 1]['5h'] > 15) windowsElapsed++;
  }

  // Weekly % consumed since start of period
  const twFirstWk  = thisWeekEntries.find(e => e['wk'] != null)?.['wk'] ?? null;
  const wkConsumed = twFirstWk != null && last['wk'] != null && twFirstWk > last['wk']
    ? twFirstWk - last['wk'] : null;

  // Average % cost per 5H window — requires ≥2 windows to be meaningful
  const wkPerWindow = wkConsumed > 0 && windowsElapsed >= 2
    ? wkConsumed / windowsElapsed : null;

  // Projected windows remaining at current per-window pace
  const windowsRemaining = wkPerWindow > 0 && last['wk'] != null
    ? last['wk'] / wkPerWindow : null;

  // When multiplier > 1, show effective token burn in sub-text for burn cards
  const effSub = (rate, baseSub) => {
    if (mult === 1 || rate <= 0) return baseSub;
    return `${baseSub} · ${(rate * mult).toFixed(1)}%/hr equiv.`;
  };

  // Best available 5H reset reference: exact API timestamp → log-jump estimate → null
  const reset5hRef = apiReset5h ?? burn.nextResetEst?.getTime() ?? null;

  // Reset-aware color: green = will last to reset, amber = 30-90min early, red = >90min early
  const gapColor = (depleteMs, resetMs, fallback = '') => {
    if (!depleteMs || !resetMs) return fallback;
    const gap = resetMs - depleteMs;
    if (gap <= 30 * 60_000) return 'green';
    if (gap <  90 * 60_000) return 'amber';
    return 'red';
  };
  // Hypothetical depletion time for a given %/hr burn rate against current 5H remaining
  const burnDeplete5hMs = (rate) =>
    rate > 0 && last['5h'] > 0
      ? new Date(last.ts).getTime() + (last['5h'] / rate) * 3_600_000
      : null;
  // Burn rate color: reset-aware when possible, rate-threshold fallback otherwise
  const burnCls = (rate) => {
    const cls = gapColor(burnDeplete5hMs(rate), reset5hRef);
    if (cls) return cls;
    if (rate <= 0) return '';
    return rate < 15 ? 'green' : rate < 40 ? 'amber' : 'red';
  };

  const cards = [
    // Row 1 — what you have
    { label: '5H Remaining',
      value: last['5h'] != null ? last['5h'] + '%' : '—',
      sub: 'current',
      cls: gapColor(burn.depletesAt?.getTime(), reset5hRef, last['5h'] < 20 ? 'red' : last['5h'] < 50 ? 'amber' : 'green') },
    { label: 'Wk Windows Left',
      value: windowsRemaining != null ? windowsRemaining.toFixed(1) : '—',
      sub: wkPerWindow != null
        ? `~${wkPerWindow.toFixed(1)}% wk/window · ${windowsElapsed} elapsed${logCoversWeekStart ? '' : ' · partial data'}`
        : windowsElapsed >= 2
          ? `${windowsElapsed} windows counted · insufficient wk change`
          : 'need ≥2 windows to estimate',
      cls: windowsRemaining == null ? '' : windowsRemaining >= 6 ? 'green' : windowsRemaining >= 3 ? 'amber' : 'red' },
    { label: 'Weekly Remaining',
      value: last['wk'] != null ? last['wk'] + '%' : '—',
      sub: wkPerWindow != null
        ? `~${wkPerWindow.toFixed(1)}% per window · ${windowsElapsed} elapsed`
        : 'current',
      cls: gapColor(burn.depleteWkAt?.getTime(), apiReset7d, last['wk'] < 20 ? 'red' : last['wk'] < 50 ? 'amber' : 'green') },
    // Row 2 — how fast (burn rates; effective rate shown when multiplier >1)
    { label: 'Burn Now',     value: burn.rateNow     > 0 ? fmtRate(burn.rateNow)     : '—',
      sub: effSub(burn.rateNow, 'last 30 min'), cls: burnCls(burn.rateNow) },
    { label: 'Session Burn', value: burn.rateSession > 0 ? fmtRate(burn.rateSession) : '—',
      sub: burn.sessionMs > 0
        ? effSub(burn.rateSession, `${(burn.sessionMs / 3_600_000).toFixed(1)}h active · ${sessionCount} session${sessionCount !== 1 ? 's' : ''}`)
        : 'no active periods detected',
      cls: burnCls(burn.rateSession) },
    { label: 'Peak Burn',    value: burn.ratePeak    > 0 ? fmtRate(burn.ratePeak)    : '—',
      sub: effSub(burn.ratePeak, '10-min window · burst'), cls: burnCls(burn.ratePeak) },
    // Row 3 — what's next
    { label: 'Depletes At',       value: depleteStr, sub: depleteSub, cls: (() => {
        if (!depleteSooner || depleteStr === 'stable') return 'green';
        const resetRef = depleteWhich === 'wk' ? apiReset7d : reset5hRef;
        if (!resetRef) return depleteSooner - Date.now() < 3_600_000 ? 'red' : '';
        const gapMs = resetRef - depleteSooner.getTime();
        if (gapMs <= 30 * 60_000) return 'green';
        if (gapMs < 90 * 60_000) return 'amber';
        return 'red';
      })() },
    { label: 'Next 5H Reset ~',   value: next5hStr,  sub: next5hSub,  cls: '' },
    { label: 'Next Weekly Reset', value: next7dStr,  sub: next7dSub,  cls: apiReset7d && apiReset7d - Date.now() < 86_400_000 ? 'amber' : '' },
    ...runwayCards,
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

// ── Efficiency ─────────────────────────────────────────────────────────────
function buildEffWindow(entries, win) {
  const title = win === '5h' ? '5-Hour Window' : 'Weekly Window';
  const cycles = segmentCycles(entries, win);
  if (!cycles.length) {
    return `<div class="eff-sub">${title}</div><div class="empty">No data yet.</div>`;
  }

  const current = cycleStats(cycles[cycles.length - 1], win);
  const completedCycles = cycles.slice(0, -1);
  const completed = completedCycles.map(c => cycleStats(c, win));
  const lastDone = completed.length ? completed[completed.length - 1] : null;
  const sum = summarize(completed);

  // Confidence: gap between the last completed cycle's final poll and the reset
  // that ended it (≈ the current cycle's first poll).
  let confidenceMs = null;
  if (lastDone && completedCycles.length) {
    const lastEnd = completedCycles[completedCycles.length - 1].slice(-1)[0].ts;
    confidenceMs = new Date(cycles[cycles.length - 1][0].ts) - new Date(lastEnd);
  }

  const grid = cards => `<div class="stat-grid">${cards.map(c => `
    <div class="stat-card ${c.cls}"><div class="label">${c.label}</div>
      <div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>`).join('')}</div>`;

  const liveCards = [
    { label: 'Peak So Far', value: current.peakPct + '%', sub: 'this period',
      cls: current.peakPct >= 90 ? 'red' : current.peakPct >= 70 ? 'amber' : 'green' },
    { label: 'Headroom', value: current.headroomPct + '%', sub: 'unused so far', cls: '' },
    { label: 'Status', value: current.blocked ? 'Blocked' : 'Running',
      sub: current.blocked ? 'hit the limit' : 'within limit',
      cls: current.blocked ? 'red' : 'green' },
  ];

  const scoreCards = lastDone ? [
    { label: 'Last Peak', value: lastDone.peakPct + '%', sub: 'previous period', cls: '' },
    { label: 'Left at Reset', value: lastDone.headroomPct + '%', sub: 'headroom', cls: '' },
    { label: 'Blocked', value: lastDone.blocked ? 'Yes' : 'No',
      sub: lastDone.blocked ? fmtDuration(lastDone.blockedMs) + ' stuck' : 'never ran out',
      cls: lastDone.blocked ? 'red' : 'green' },
  ] : [];

  // "usage period" is neutral for both windows (the section header already names the
  // window) and honest about early resets, which make periods shorter than the label.
  const period = 'usage period';
  const periods = `${sum.count} past ${period}${sum.count !== 1 ? 's' : ''}`;
  const histLine = sum.count
    ? (sum.blockedCount === 0
        ? `${periods} · none hit the limit`
        : `${sum.blockedCount} of ${periods} hit the limit`
          + (sum.totalBlockedMs > 0 ? ` · ≈${fmtDuration(sum.totalBlockedMs)} blocked total` : ''))
    : `No completed ${period}s yet.`;

  const confLine = confidenceMs != null && confidenceMs > 0
    ? `<div class="eff-note">Scorecard based on a poll ${fmtDuration(confidenceMs)} before the next period began.</div>`
    : '';

  return `
    <div class="eff-sub">${title} — Now</div>
    ${grid(liveCards)}
    ${scoreCards.length ? `<div class="eff-sub">${title} — Last Completed Period</div>${grid(scoreCards)}${confLine}` : ''}
    <div class="eff-sub">${title} — History</div>
    <div class="eff-hist">${histLine}</div>
    <div id="eff-peaks-${win}" class="eff-peaks"></div>
    ${win === '5h' ? `<details class="eff-month"><summary>Burn by hour heatmap</summary><div id="eff-month-5h"></div></details>` : ''}
  `;
}

function renderEfficiency(entries, container) {
  container.innerHTML = `<div class="section-head">Efficiency</div>`
    + ['5h', 'wk'].map(win => buildEffWindow(entries, win)).join('')
    + `<div class="eff-sub">Time of Day — when you burn quota</div><div id="eff-hourofday" class="eff-heat"></div>`;

  ['5h', 'wk'].forEach(win => {
    const completed = segmentCycles(entries, win).slice(0, -1).map(c => cycleStats(c, win));
    renderPeakBars(container.querySelector(`#eff-peaks-${win}`), summarize(completed).peaks);
  });
  // One time-of-day heatmap from the 5h meter (finest resolution). The weekly
  // version was the same shape once normalized to a share, so it's shown once.
  renderHourHeatmap(container.querySelector('#eff-hourofday'), hourlyBurn(entries, '5h'));

  monthEntries = entries;
  const mpts = entries.filter(s => s && s['5h'] != null);
  if (mpts.length) {
    const last = new Date(mpts[mpts.length - 1].ts);
    displayYear = last.getFullYear();
    displayMonth = last.getMonth();
    renderMonthSection(container);
  } else {
    const monthEl = container.querySelector('#eff-month-5h');
    if (monthEl) monthEl.innerHTML = '<div class="empty">No data yet.</div>';
  }
}

function renderPeakBars(el, peaks) {
  if (!el) return;
  if (!peaks.length) { el.innerHTML = '<div class="empty">No completed usage periods yet.</div>'; return; }
  const shortDate = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const spanLabel = (p) => p.endTs ? `${shortDate(p.ts)}–${shortDate(p.endTs)}` : shortDate(p.ts);
  const bars = peaks.map(p => {
    const h = Math.max(2, Math.round(p.peakPct));
    const color = p.peakPct >= 90 ? 'var(--red)' : p.peakPct >= 70 ? 'var(--amber)' : 'var(--green)';
    return `<div class="peak-bar" title="${p.peakPct}% peak · ${spanLabel(p)}" style="height:${h}%;background:${color}"></div>`;
  }).join('');
  // Self-describing frame: 0–100% baseline, 70%/90% threshold lines, color legend.
  // Bar height = the cycle's peak % of the limit.
  const legend = `<div class="peak-legend">`
    + `<span><i class="sw green"></i>&lt;70%</span>`
    + `<span><i class="sw amber"></i>70–89%</span>`
    + `<span><i class="sw red"></i>≥90% ran out</span></div>`;
  const grids = `<div class="peak-grid" style="bottom:90%"><span>90</span></div>`
    + `<div class="peak-grid" style="bottom:70%"><span>70</span></div>`;
  // Few cycles that carry a date span (the weekly case) → label each bar with its
  // range; many bars (the 12-cycle 5-hour case) → a generic oldest→newest axis.
  const axis = (peaks.length <= 4 && peaks.every(p => p.endTs))
    ? `<div class="peak-dates">${peaks.map(p => `<span title="${spanLabel(p)}">${spanLabel(p)}</span>`).join('')}</div>`
    : `<div class="peak-axis"><span>oldest</span><span>newest</span></div>`;
  el.innerHTML = `<div class="eff-cap">Peak usage per period</div>${legend}`
    + `<div class="peak-chart">${grids}<div class="peak-bars">${bars}</div></div>${axis}`;
}

function renderHourHeatmap(el, hours) {
  if (!el) return;
  const max = Math.max(1, ...hours);
  const total = hours.reduce((a, b) => a + b, 0);
  // Each hour shows its SHARE of your total burn (sums to 100%, never exceeds it) —
  // the raw per-hour value is a running sum across all days/windows and can exceed
  // 100%, which is meaningless. Opacity stays value/max for the best visual contrast.
  const cells = hours.map((v, h) => {
    if (v <= 0) return `<div class="heat-cell empty" title="${h}:00 — no burn"></div>`;
    const a = (v / max).toFixed(2);
    const share = total > 0 ? Math.round((v / total) * 100) : 0;
    return `<div class="heat-cell" title="${h}:00 — ${share}% of your burn" style="background:rgba(168,85,247,${a})"></div>`;
  }).join('');
  // Hour labels live on their own axis row (0/6/12/18), aligned under the cells.
  const axis = hours.map((_, h) => `<span>${h % 6 === 0 ? h : ''}</span>`).join('');
  const legend = `<div class="heat-legend"><span>less</span><i class="grad"></i><span>more</span></div>`;
  el.innerHTML = `<div class="eff-cap">Share of your total burn per clock hour <span class="eff-subtle">(all days)</span></div>`
    + `<div class="heat-row">${cells}</div>`
    + `<div class="hour-axis">${axis}</div>${legend}`;
}

function fmtMonthDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function monthGridHtml(grid) {
  const max = Math.max(1, ...grid.flatMap(r => r.hours));

  const ruler = `<div class="month-row month-ruler"><span class="month-date"></span>${
    Array.from({ length: 24 }, (_, h) => `<span class="month-hcol">${h % 6 === 0 ? h : ''}</span>`).join('')
  }</div>`;

  const rows = grid.map(r => { // chronological: 1st of month at top, last at bottom
    const cells = r.hours.map((v, h) => {
      if (!r.hasData) return `<span class="heat-cell nodata" title="${fmtMonthDay(r.date)} — no data"></span>`;
      const a = (v / max).toFixed(2);
      return `<span class="heat-cell" title="${fmtMonthDay(r.date)} ${h}:00 — ${v.toFixed(0)}% burned" style="background:rgba(168,85,247,${a})"></span>`;
    }).join('');
    return `<div class="month-row${r.hasData ? '' : ' nodata-row'}"><span class="month-date">${fmtMonthDay(r.date)}</span>${cells}</div>`;
  }).join('');

  return `${ruler}${rows}`;
}

function stepMonth(delta) {
  const idx = displayYear * 12 + displayMonth + delta;
  displayYear = Math.floor(idx / 12);
  displayMonth = ((idx % 12) + 12) % 12;
  renderMonthSection();
}

function renderMonthSection(root = document) {
  const el = root.querySelector('#eff-month-5h');
  if (!el) return;

  const pts = monthEntries.filter(s => s && s['5h'] != null);
  if (!pts.length) { el.innerHTML = '<div class="empty">No data yet.</div>'; return; }

  const first = new Date(pts[0].ts), last = new Date(pts[pts.length - 1].ts);
  const earliestIdx = first.getFullYear() * 12 + first.getMonth();
  const latestIdx = last.getFullYear() * 12 + last.getMonth();
  const curIdx = displayYear * 12 + displayMonth;
  const canPrev = curIdx > earliestIdx;
  const canNext = curIdx < latestIdx;

  const label = new Date(displayYear, displayMonth, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const bar = `<div class="month-nav">
    <button class="month-btn month-prev"${canPrev ? '' : ' disabled'}>◀</button>
    <span class="month-label">${label}</span>
    <button class="month-btn month-next"${canNext ? '' : ' disabled'}>▶</button>
  </div>`;

  el.innerHTML = bar + monthGridHtml(monthBurnGrid(monthEntries, '5h', displayYear, displayMonth));

  const prev = el.querySelector('.month-prev');
  const next = el.querySelector('.month-next');
  if (prev) prev.addEventListener('click', () => stepMonth(-1));
  if (next) next.addEventListener('click', () => stepMonth(1));
}

// ── Cost (estimates) ───────────────────────────────────────────────────────
// Accounts with exact local token logs we can price.
const TOKEN_LOADERS = {
  'claude-vscode': () => window.electronAPI.readClaudeCodeUsage(),
  'codex':         () => window.electronAPI.readCodexUsage(),
};
const TOKEN_SOURCE_LABEL = {
  'claude-vscode': 'Claude Code token data',
  'codex':         'Codex token data',
};

// Per-day / per-month API-equivalent cost. Independent of the time-window
// dropdown (uses full history); figures labeled "last 30 days" / "this month".
function renderCostOverTime(el, entries) {
  if (!el) return;
  if (!entries || !entries.length) { el.innerHTML = ''; return; }

  const byDay = costByDay(entries);      // { 'YYYY-MM-DD': usd }
  const byMonth = costByMonth(entries);  // { 'YYYY-MM': usd }

  // Build the last 30 local calendar days, oldest → newest.
  const today = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ key, usd: byDay[key] || 0 });
  }
  const total30 = days.reduce((a, d) => a + d.usd, 0);
  const avgPerDay = total30 / 30;
  const projected = avgPerDay * 30;
  const maxUsd = Math.max(0, ...days.map(d => d.usd));

  const bars = days.map(d => {
    const h = maxUsd > 0 ? Math.max(2, Math.round((d.usd / maxUsd) * 100)) : 2;
    const isMax = maxUsd > 0 && d.usd === maxUsd;
    const color = isMax ? 'var(--amber)' : 'var(--green)';
    return `<div class="peak-bar" title="${esc(d.key)} · ${fmtMoneyUsd(d.usd)}" style="height:${h}%;background:${color}"></div>`;
  }).join('');

  // Last 3 local calendar months, oldest → newest; current month marked.
  const monthRows = [];
  const curMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  for (let i = 2; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleString(undefined, { month: 'short', year: 'numeric' });
    const suffix = key === curMonthKey ? ' (so far)' : '';
    monthRows.push(`<tr><td>${esc(label)}${suffix}</td><td>${fmtMoneyUsd(byMonth[key] || 0)}</td></tr>`);
  }

  el.innerHTML = `
    <div class="cost-rate">≈ ${fmtMoneyUsd(avgPerDay)}/day · ~${fmtMoneyUsd(projected)}/mo at this pace</div>
    <div class="cost-sub">estimate from the last 30 days of token usage</div>
    <div class="eff-cap">Cost per day · last 30 days</div>
    <div class="peak-bars">${bars}</div>
    <table class="cost-table"><thead><tr><th>Month</th><th>Cost</th></tr></thead><tbody>${monthRows.join('')}</tbody></table>
  `;
}

// Compact "token mix" block: counts + thin proportion bar + takeaway. Returns
// '' when there are no tokens in the window.
function tokenMixHtml(entries) {
  const mix = tokenMix(entries);
  if (!mix.total) return '';
  const segs = [
    { label: 'fresh input', v: mix.input,      color: 'var(--green)' },
    { label: 'output',      v: mix.output,     color: 'var(--accent)' },
    { label: 'cache write', v: mix.cacheWrite, color: 'var(--amber)' },
    { label: 'cache read',  v: mix.cacheRead,  color: 'var(--text-mid)' },
  ];
  const pct = v => Math.round((v / mix.total) * 100);
  const bar = segs.filter(s => s.v > 0).map(s =>
    `<div class="token-mix-seg" title="${esc(s.label)}: ${fmtTokens(s.v)} (${pct(s.v)}%)" style="width:${(s.v / mix.total) * 100}%;background:${s.color}"></div>`
  ).join('');
  const takeaway = mix.cacheRead > 0
    ? `<div class="cost-sub">cache reads = ${pct(mix.cacheRead)}% of tokens but weigh ~10% — why heavy sessions barely move the limit.</div>`
    : '';
  return `
    <div class="eff-cap">Token mix · ${windowLabel()}</div>
    <div class="cost-sub">fresh input ${fmtTokens(mix.input)} · output ${fmtTokens(mix.output)} · cache write ${fmtTokens(mix.cacheWrite)} · cache read ${fmtTokens(mix.cacheRead)}</div>
    <div class="token-mix-bar">${bar}</div>
    ${takeaway}
  `;
}

async function renderCost(container) {
  let partA = '';
  let overTimeEntries = null; // full (unfiltered) entries for the over-time block
  const loader = TOKEN_LOADERS[currentAccount];

  if (loader) {
    const res = await loader();
    if (!res || res.error) {
      partA = `<div class="cost-sub">Could not read ${esc(TOKEN_SOURCE_LABEL[currentAccount])}: ${esc((res && res.error) || 'unknown error')}</div>`;
    } else {
      const all = res.entries || [];
      overTimeEntries = all;
      const cutoff = windowCutoffMs();
      const toks = all.filter(e => cutoff == null || new Date(e.timestamp).getTime() >= cutoff);
      const c = summarizeCost(toks);
      const rows = Object.keys(FAMILY_PRICES).filter(fam => c.byModel[fam]).map(fam => {
        const v = c.byModel[fam];
        return `<tr><td>${fam}</td><td>${fmtTokens(v.tokens)}</td><td>${fmtMoneyUsd(v.cost)}</td></tr>`;
      }).join('');
      partA = `
        <div class="cost-headline">≈ ${fmtMoneyUsd(c.total)} of API usage · ${windowLabel()}</div>
        <div class="cost-sub">estimate — what this usage would cost on the pay-as-you-go API</div>
        ${rows ? `<table class="cost-table"><thead><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No token data in this window.</div>'}
        ${rows ? tokenMixHtml(toks) : ''}
        ${c.cacheSavings > 0 ? `<div class="cost-sub">cache reads saved ≈ ${fmtMoneyUsd(c.cacheSavings)} vs uncached</div>` : ''}
        ${c.unpriced ? `<div class="cost-sub">unpriced: ${c.unpriced} turns (unknown model)</div>` : ''}
      `;
    }
  } else {
    partA = `<div class="cost-sub">Token-level cost isn't available for this account — Claude Desktop exposes only rate-limit %.</div>`;
  }

  container.innerHTML = `<div class="section-head">Cost (estimates)</div>${partA}<div id="cost-over-time"></div><div id="cost-compare"></div>`;
  renderCostOverTime(container.querySelector('#cost-over-time'), overTimeEntries);
  await renderCostCompare(container.querySelector('#cost-compare'));
}

async function renderCostCompare(el) {
  if (!el) return;

  const settings = await window.electronAPI.getSettings();
  const planPrices = (settings && settings.planPrices) || {};
  const cutoff = windowCutoffMs();

  // Per-account subscription value over the selected window.
  const rows = [];
  for (const acct of VALID_ACCOUNTS) {
    let snaps = await window.electronAPI.readUsageLog(acct, 0);
    if (cutoff != null) snaps = snaps.filter(s => new Date(s.ts).getTime() >= cutoff);
    const price = planPrices[acct]; // stored in USD
    const priceDisp = price != null ? price * usdRate : price; // → display currency
    rows.push({ acct, price, sv: subscriptionValue(snaps, priceDisp, '5h') });
  }

  // Best (lowest) value in each money column, among rows that have it.
  const bestOf = (key) => {
    const vals = rows.map(r => r.sv && r.sv[key]).filter(v => v != null && v > 0);
    return vals.length ? Math.min(...vals) : null;
  };
  const bestHr = bestOf('perActiveHour');
  const bestWin = bestOf('perWindow');
  const cell = (v, best) => v == null ? '—'
    : `<span class="${best != null && v === best ? 'best-value' : ''}">${fmtMoney(v)}</span>`;

  const tbody = rows.map(r => {
    const sv = r.sv;
    return `<tr>
      <td>${ACCOUNT_LABELS[r.acct]}</td>
      <td>${r.price != null ? fmtMoneyUsd(r.price) + '/mo' : '—'}</td>
      <td>${sv ? sv.activeHours.toFixed(1) + 'h' : '—'}</td>
      <td>${sv ? sv.windows : '—'}</td>
      <td>${sv ? cell(sv.perActiveHour, bestHr) : '—'}</td>
      <td>${sv ? cell(sv.perWindow, bestWin) : '—'}</td>
    </tr>`;
  }).join('');

  // Claude Code value ratio: API-equivalent $ ÷ attributed subscription cost.
  let ratioLine = '';
  const cc = rows.find(r => r.acct === 'claude-vscode');
  if (cc && cc.sv && cc.sv.attributedCost > 0) {
    const res = await window.electronAPI.readClaudeCodeUsage();
    const toks = (res && res.entries || []).filter(e =>
      cutoff == null || new Date(e.timestamp).getTime() >= cutoff);
    const total = summarizeCost(toks).total * usdRate;
    if (total > 0) {
      const ratio = total / cc.sv.attributedCost;
      ratioLine = `<div class="cost-headline">≈ ${ratio.toFixed(1)}× the subscription's worth in API-equivalent value <span class="cost-sub">(Claude Code)</span></div>`;
    }
  }

  el.innerHTML = `
    <div class="eff-sub">Subscription value — ${windowLabel()}</div>
    ${ratioLine}
    <table class="cost-table">
      <thead><tr><th>Account</th><th>Plan</th><th>Active</th><th>Windows</th><th>${curSymbol}/active-hr</th><th>${curSymbol}/window</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <div class="cost-sub">Plan prices are entered in USD (Settings ⚙) and shown here in your currency. Subscription cost is prorated over the data span (price × span ÷ 30 days). Figures are estimates and get noisier with little history.</div>
  `;
}

// ── Main render ────────────────────────────────────────────────────────────
async function renderAll() {
  const body = document.getElementById('body');
  const prevScroll = body.scrollTop;
  // Only flash "Loading…" on the very first render; on refresh keep the current
  // content visible until the rebuilt sections swap in (avoids flash + jump).
  if (!body.firstChild) body.innerHTML = '<div class="empty">Loading…</div>';
  const _cur = (await window.electronAPI.getSettings()) || {};
  curSymbol = _cur.currencySymbol || '£';
  usdRate = _cur.usdRate != null ? _cur.usdRate : 0.79;

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
    const sc = new Set(entries.map(e => e.sessionStart).filter(Boolean)).size;
    const sessionMeta = sc > 0 ? ` · ${sc} session${sc !== 1 ? 's' : ''}` : '';
    meta.textContent = `${entries.length} entries · ${fmtDuration(span)} window${sessionMeta} · last: ${fmtAgo(entries[entries.length - 1].ts)}`;
  } else {
    meta.textContent = 'No data';
  }

  if (!entries.length) {
    body.innerHTML = '<div class="empty">No log entries found for this account and time window.</div>';
    return;
  }

  // Build sections OFF-DOM. The previous content stays visible in `body` the
  // whole time we fetch data and populate these detached elements, so the page
  // never goes blank mid-rebuild (that blank interval was the flash).
  const statsEl = document.createElement('div');
  const effEl   = document.createElement('div');
  const costEl  = document.createElement('div');
  const chartEl = document.createElement('div');
  const tableEl = document.createElement('div');

  // Efficiency reads the FULL log (all cycles), independent of the time-window filter.
  const allEntries = await window.electronAPI.readUsageLog(currentAccount, 0);

  renderStats(entries, statsEl, _cur);
  renderEfficiency(allEntries, effEl);
  await renderCost(costEl);
  renderChart(entries, chartEl);
  renderTable(entries, tableEl);

  // Single atomic swap — every section is fully built above, so the visible
  // content changes in one step with no empty frame in between.
  body.replaceChildren(statsEl, effEl, costEl, chartEl, tableEl);
  body.scrollTop = prevScroll; // keep the reader's place across refreshes
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
window.electronAPI.onSettingsChanged(() => renderAll());

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
