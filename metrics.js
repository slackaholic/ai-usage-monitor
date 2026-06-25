'use strict';

// Tunable thresholds — calibrate once more data accumulates.
const RESET_JUMP_MIN = 15;            // upward % jump counted as a window reset
const RESET_ADVANCE_MIN = 60_000;     // forward jump (ms) in the reset timestamp counted as a reset
const ACTIVE_GAP_MAX = 15 * 60_000;   // poll gap above this is idle, not consumption

const RESET_KEY = { '5h': 'reset5hTs', wk: 'reset7dTs' };

function isBoundary(prev, cur, win) {
  const jumped = (cur[win] - prev[win]) > RESET_JUMP_MIN;
  const rk = RESET_KEY[win];
  const advanced = prev[rk] > 0 && cur[rk] > 0 && (cur[rk] - prev[rk]) > RESET_ADVANCE_MIN;
  return jumped || advanced;
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
  const blocked = remaining.some(r => r === 0);
  let blockedMs = 0;
  if (blocked) {
    const firstZero = cycle.find(p => p[win] === 0);
    blockedMs = new Date(cycle[cycle.length - 1].ts) - new Date(firstZero.ts);
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles, cycleStats };
}
