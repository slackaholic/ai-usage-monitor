'use strict';

// Tunable thresholds — calibrate once more data accumulates.
const RESET_JUMP_MIN = 15;            // upward % jump counted as a window reset
const RESET_ADVANCE_FRAC = 0.5;       // reset-ts must jump ≥ this fraction of the window
                                      // to count as a reset (a real reset advances ~1 window;
                                      // a partial re-anchor / plan change advances less)
const ACTIVE_GAP_MAX = 15 * 60_000;   // poll gap above this is idle, not consumption

const RESET_KEY  = { '5h': 'reset5hTs', wk: 'reset7dTs' };
const WINDOW_MS  = { '5h': 5 * 3_600_000, wk: 7 * 86_400_000 };

function isBoundary(prev, cur, win) {
  const jumped   = (cur[win] - prev[win]) > RESET_JUMP_MIN;
  const rk       = RESET_KEY[win];
  const resetAdvanced = prev[rk] > 0 && cur[rk] > 0
    && (cur[rk] - prev[rk]) >= WINDOW_MS[win] * RESET_ADVANCE_FRAC;
  const recoveredOrHeld = cur[win] >= prev[win];
  const stillFull = prev[win] === 100 && cur[win] === 100;
  const advanced = resetAdvanced && recoveredOrHeld && !stillFull;
  const gapped   = (new Date(cur.ts) - new Date(prev.ts)) > WINDOW_MS[win];
  return jumped || advanced || gapped;
}

function segmentCycles(snapshots, win) {
  const pts = snapshots.filter(s => s && s[win] != null);
  if (pts.length === 0) return [];
  const cycles = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (isBoundary(pts[i - 1], pts[i], win)) {
      cycles.push(cur);
      cur = [pts[i]];
    } else {
      cur.push(pts[i]);
    }
  }
  cycles.push(cur);
  return cycles;
}

function cycleStats(cycle, win) {
  const remaining = cycle.map(p => p[win]);
  const minRemaining = Math.min(...remaining);
  const firstZeroIdx = remaining.findIndex(r => r === 0);
  // Only count as blocked when at least one snapshot BEFORE the zero existed.
  // firstZeroIdx === 0 means the log started mid-depletion (left-censored); skip it.
  const blocked = firstZeroIdx > 0;
  let blockedMs = 0;
  if (blocked) {
    blockedMs = new Date(cycle[cycle.length - 1].ts) - new Date(cycle[firstZeroIdx].ts);
  }
  return {
    startTs: cycle[0].ts,
    endTs: cycle[cycle.length - 1].ts,
    peakPct: 100 - minRemaining,
    headroomPct: minRemaining,
    blocked,
    blockedMs,
  };
}

function summarize(stats) {
  const count = stats.length;
  const blocked = stats.filter(s => s.blocked);
  return {
    count,
    blockedCount: blocked.length,
    blockRate: count ? blocked.length / count : 0,
    totalBlockedMs: blocked.reduce((a, s) => a + s.blockedMs, 0),
    peaks: stats.map(s => ({ ts: s.startTs, endTs: s.endTs, peakPct: s.peakPct })),
  };
}

function countDepletionEvents(snapshots, win) {
  const pts = snapshots.filter(s => s && s[win] != null);
  let count = 0;
  let wasDepleted = false;
  for (const p of pts) {
    const isDepleted = !!(p.depleted && p.depleted.includes(win));
    if (isDepleted && !wasDepleted) count++;
    wasDepleted = isDepleted;
  }
  return count;
}

function latestResetTs(pts, key) {
  for (let i = pts.length - 1; i >= 0; i--) {
    if (Number.isFinite(pts[i][key]) && pts[i][key] > 0) return pts[i][key];
  }
  return null;
}

function currentPeriodPoints(pts, win, resetTs) {
  const cycles = segmentCycles(pts, win);
  const latestCycle = cycles.length ? cycles[cycles.length - 1] : pts;
  if (!Number.isFinite(resetTs)) return latestCycle;
  const periodStart = resetTs - WINDOW_MS[win];
  if (!Number.isFinite(periodStart)) return latestCycle;
  const scoped = latestCycle.filter(p => {
    const t = new Date(p.ts).getTime();
    return Number.isFinite(t) && t >= periodStart && t <= resetTs;
  });
  return scoped.length ? scoped : latestCycle;
}

function weeklyRunway(snapshots, currentPlanMultiplier) {
  const allPts = snapshots.filter(s => s && s.wk != null);
  const multiplier = Number.isFinite(currentPlanMultiplier) && currentPlanMultiplier > 0 ? currentPlanMultiplier : 1;
  const weeklyRemainingPct = allPts.length ? allPts[allPts.length - 1].wk : null;
  const weeklyResetTs = allPts.length ? latestResetTs(allPts, 'reset7dTs') : null;
  const pts = currentPeriodPoints(allPts, 'wk', weeklyResetTs);

  const emptyProjection = (weeklyBurnRatePctPerHour, confidence, evidence = {}) => ({
    currentPlanMultiplier: multiplier,
    weeklyRemainingPct,
    weeklyResetTs,
    weeklyBurnRatePctPerHour,
    evidenceMs: evidence.evidenceMs ?? 0,
    evidenceDropPct: evidence.evidenceDropPct ?? 0,
    activeDropCount: evidence.activeDropCount ?? 0,
    projectedDepleteTs: null,
    gapMs: null,
    projectedHeadroomAtResetPct: null,
    requiredPlanMultiplier: null,
    confidence,
  });

  if (pts.length < 2) return emptyProjection(0, 'none');

  const first = pts[0];
  const last = pts[pts.length - 1];
  let activeDrops = 0;

  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    const drop = pts[i - 1].wk - pts[i].wk;
    if (drop > 0 && dt > 0 && dt < ACTIVE_GAP_MAX) activeDrops++;
  }

  const spanMs = new Date(last.ts) - new Date(first.ts);
  const totalDrop = first.wk - last.wk;
  const evidence = {
    evidenceMs: spanMs > 0 ? spanMs : 0,
    evidenceDropPct: totalDrop > 0 ? totalDrop : 0,
    activeDropCount: activeDrops,
  };
  const weeklyBurnRatePctPerHour = spanMs > 0 && totalDrop > 0
    ? totalDrop / (spanMs / 3_600_000)
    : 0;
  const confidence = activeDrops >= 2 && spanMs >= 30 * 60_000 ? 'good'
    : totalDrop > 0 ? 'limited'
    : 'none';

  const lastTs = new Date(last.ts).getTime();
  if (confidence !== 'good' || !Number.isFinite(weeklyResetTs) || !Number.isFinite(lastTs) || weeklyResetTs <= lastTs || weeklyBurnRatePctPerHour <= 0 || last.wk <= 0) {
    return emptyProjection(weeklyBurnRatePctPerHour, confidence, evidence);
  }

  const hoursUntilReset = (weeklyResetTs - lastTs) / 3_600_000;
  const hoursUntilDepletion = last.wk / weeklyBurnRatePctPerHour;
  const projectedDepleteTs = lastTs + hoursUntilDepletion * 3_600_000;
  const projectedConsumptionByReset = weeklyBurnRatePctPerHour * hoursUntilReset;

  return {
    currentPlanMultiplier: multiplier,
    weeklyRemainingPct: last.wk,
    weeklyResetTs,
    weeklyBurnRatePctPerHour,
    ...evidence,
    projectedDepleteTs,
    gapMs: weeklyResetTs - projectedDepleteTs,
    projectedHeadroomAtResetPct: last.wk - projectedConsumptionByReset,
    requiredPlanMultiplier: multiplier * projectedConsumptionByReset / last.wk,
    confidence,
  };
}
function hourlyBurn(snapshots, win) {
  const hours = new Array(24).fill(0);
  const pts = snapshots.filter(s => s && s[win] != null);
  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    const drop = pts[i - 1][win] - pts[i][win];
    if (drop > 0 && dt < ACTIVE_GAP_MAX) {
      hours[new Date(pts[i - 1].ts).getHours()] += drop;
    }
  }
  return hours;
}

function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function monthBurnGrid(snapshots, win, year, month) {
  const pts = snapshots.filter(s => s && s[win] != null);

  const burnByDay = {};        // dayKey -> number[24]
  const hasDataKeys = new Set();
  for (const p of pts) {
    hasDataKeys.add(localDayKey(new Date(p.ts)));
  }
  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    const drop = pts[i - 1][win] - pts[i][win];
    if (drop > 0 && dt < ACTIVE_GAP_MAX) {
      const prev = new Date(pts[i - 1].ts);
      const key = localDayKey(prev);
      if (!burnByDay[key]) burnByDay[key] = new Array(24).fill(0);
      burnByDay[key][prev.getHours()] += drop;
    }
  }

  const rows = [];
  const n = daysInMonth(year, month);
  for (let day = 1; day <= n; day++) {
    const key = localDayKey(new Date(year, month, day));
    rows.push({
      date: key,
      hours: burnByDay[key] || new Array(24).fill(0),
      hasData: hasDataKeys.has(key),
    });
  }
  return rows;
}

// ── Cost (estimates) ───────────────────────────────────────────────────────
const FAMILY_PRICES = {
  Opus:   { in: 5,  out: 25 },
  Sonnet: { in: 3,  out: 15 },
  Haiku:  { in: 1,  out: 5  },
  Fable:  { in: 10, out: 50 },
  'GPT-5.5':      { in: 5,    out: 30   },
  'GPT-5.4':      { in: 2.5,  out: 15   },
  'GPT-5.4-mini': { in: 0.75, out: 4.5  },
  'GPT-5.4-nano': { in: 0.2,  out: 1.25 },
};
const CACHE_WRITE_MULT = 1.25;          // 5-minute ephemeral cache write
const CACHE_READ_MULT = 0.1;            // cache read
const MONTH_MS = 30 * 86_400_000;

function modelFamily(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('fable')) return 'Fable';
  // OpenAI / Codex — match only the known gpt-5.4/5.5 slugs; unknown gpt variants
  // (e.g. gpt-5-mini, gpt-4o-mini, codex-auto-review) stay unpriced rather than guessed.
  if (m.includes('5.4-nano')) return 'GPT-5.4-nano';
  if (m.includes('5.4-mini')) return 'GPT-5.4-mini';
  if (m.includes('gpt-5.5')) return 'GPT-5.5';
  if (m.includes('gpt-5.4')) return 'GPT-5.4';
  return null;
}

function entryCost(e) {
  const fam = modelFamily(e.model);
  if (!fam) return null;
  const p = FAMILY_PRICES[fam];
  return (
    (e.input_tokens || 0) * p.in +
    (e.output_tokens || 0) * p.out +
    (e.cache_creation || 0) * p.in * CACHE_WRITE_MULT +
    (e.cache_read || 0) * p.in * CACHE_READ_MULT
  ) / 1_000_000;
}

function summarizeCost(entries) {
  const byModel = {};
  let total = 0, unpriced = 0, cacheSavings = 0;
  for (const e of entries) {
    const fam = modelFamily(e.model);
    if (!fam) { unpriced++; continue; }
    const p = FAMILY_PRICES[fam];
    const cost = entryCost(e);
    total += cost;
    cacheSavings += (e.cache_read || 0) * p.in * (1 - CACHE_READ_MULT) / 1_000_000;
    if (!byModel[fam]) byModel[fam] = { tokens: 0, cost: 0 };
    byModel[fam].tokens += (e.input_tokens || 0) + (e.output_tokens || 0)
      + (e.cache_creation || 0) + (e.cache_read || 0);
    byModel[fam].cost += cost;
  }
  return { total, byModel, unpriced, cacheSavings };
}

// Token-volume breakdown (counts only, no pricing). Cache reads dominate
// volume in long sessions but are heavily discounted against cost/limits — this
// makes that split visible.
function tokenMix(entries) {
  const out = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
  for (const e of (entries || [])) {
    out.input += e.input_tokens || 0;
    out.output += e.output_tokens || 0;
    out.cacheWrite += e.cache_creation || 0;
    out.cacheRead += e.cache_read || 0;
  }
  out.total = out.input + out.output + out.cacheWrite + out.cacheRead;
  return out;
}

// Local-calendar-day key 'YYYY-MM-DD' from an ISO timestamp. Uses new Date(arg)
// (allowed) — never Date.now()/argless new Date().
function dayKey(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function costByDay(entries) {
  const out = {};
  for (const e of (entries || [])) {
    const c = entryCost(e);
    if (c == null) continue;
    const k = dayKey(e.timestamp);
    if (!k) continue;
    out[k] = (out[k] || 0) + c;
  }
  return out;
}

// Local-calendar-month key 'YYYY-MM' from an ISO timestamp. Uses new Date(arg)
// (allowed) — never Date.now()/argless new Date().
function monthKey(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}

function costByMonth(entries) {
  const out = {};
  for (const e of (entries || [])) {
    const c = entryCost(e);
    if (c == null) continue;
    const k = monthKey(e.timestamp);
    if (!k) continue;
    out[k] = (out[k] || 0) + c;
  }
  return out;
}

function activeMs(snapshots, win) {
  const pts = snapshots.filter(s => s && s[win] != null);
  let ms = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    const drop = pts[i - 1][win] - pts[i][win];
    if (drop > 0 && dt < ACTIVE_GAP_MAX) ms += dt;
  }
  return ms;
}

function subscriptionValue(snapshots, monthlyPrice, win) {
  const pts = snapshots.filter(s => s && s[win] != null);
  if (pts.length < 2 || !monthlyPrice) return null;
  const spanMs = new Date(pts[pts.length - 1].ts) - new Date(pts[0].ts);
  const activeHours = activeMs(snapshots, win) / 3_600_000;
  const windows = segmentCycles(snapshots, win).length;
  const attributedCost = monthlyPrice * (spanMs / MONTH_MS);
  return {
    activeHours,
    windows,
    attributedCost,
    perActiveHour: activeHours > 0 ? attributedCost / activeHours : null,
    perWindow: windows > 0 ? attributedCost / windows : null,
  };
}

// Convert a Codex `last_token_usage` object into the standard entry shape.
// Codex input_tokens INCLUDES cached_input_tokens; OpenAI does not bill cache
// writes (cache_creation = 0); output_tokens already includes reasoning tokens.
function normalizeCodexTokenUsage(u, model, timestamp) {
  if (!u) return null;
  const input = u.input_tokens || 0;
  const cached = u.cached_input_tokens || 0;
  return {
    timestamp,
    model: model || 'unknown',
    input_tokens: Math.max(0, input - cached),
    output_tokens: u.output_tokens || 0,
    cache_creation: 0,
    cache_read: cached,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_FRAC, ACTIVE_GAP_MAX, segmentCycles, cycleStats, summarize, countDepletionEvents, weeklyRunway, hourlyBurn, monthBurnGrid, entryCost, summarizeCost, tokenMix, costByDay, costByMonth, activeMs, subscriptionValue, FAMILY_PRICES, CACHE_WRITE_MULT, CACHE_READ_MULT, MONTH_MS, modelFamily, normalizeCodexTokenUsage };
}
