'use strict';

// Tunable thresholds — calibrate once more data accumulates.
const RESET_JUMP_MIN = 15;            // upward % jump counted as a window reset
const RESET_ADVANCE_MIN = 60_000;     // forward jump (ms) in the reset timestamp counted as a reset
const ACTIVE_GAP_MAX = 15 * 60_000;   // poll gap above this is idle, not consumption

const RESET_KEY  = { '5h': 'reset5hTs', wk: 'reset7dTs' };
const WINDOW_MS  = { '5h': 5 * 3_600_000, wk: 7 * 86_400_000 };

function isBoundary(prev, cur, win) {
  const jumped   = (cur[win] - prev[win]) > RESET_JUMP_MIN;
  const rk       = RESET_KEY[win];
  const advanced = prev[rk] > 0 && cur[rk] > 0 && (cur[rk] - prev[rk]) > RESET_ADVANCE_MIN;
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
    peaks: stats.map(s => ({ ts: s.startTs, peakPct: s.peakPct })),
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

function dailyHourlyBurn(snapshots, win, days = 30) {
  const pts = snapshots.filter(s => s && s[win] != null);
  if (pts.length === 0) return [];

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

  // Anchor on the local midnight of the latest snapshot's day (data-derived, not Date.now()).
  const last = new Date(pts[pts.length - 1].ts);
  const anchor = new Date(last.getFullYear(), last.getMonth(), last.getDate());

  const rows = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset);
    const key = localDayKey(d);
    rows.push({
      date: key,
      hours: burnByDay[key] || new Array(24).fill(0),
      hasData: hasDataKeys.has(key),
    });
  }
  return rows;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles, cycleStats, summarize, hourlyBurn, dailyHourlyBurn };
}
