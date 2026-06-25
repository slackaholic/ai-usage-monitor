'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { segmentCycles } = require('../metrics.js');

test('segmentCycles splits on a large upward jump (reset by recovery)', () => {
  const snaps = [
    { ts: '2026-06-25T00:00:00Z', '5h': 80 },
    { ts: '2026-06-25T01:00:00Z', '5h': 50 },
    { ts: '2026-06-25T02:00:00Z', '5h': 95 }, // +45 → boundary
  ];
  const cycles = segmentCycles(snaps, '5h');
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].length, 2);
  assert.equal(cycles[1].length, 1);
});

test('segmentCycles splits a low-usage cycle via reset-timestamp advance', () => {
  const base = 1782402600000;
  const snaps = [
    { ts: '2026-06-25T00:00:00Z', '5h': 95, reset5hTs: base },
    { ts: '2026-06-25T04:00:00Z', '5h': 90, reset5hTs: base }, // only -5, no jump
    { ts: '2026-06-25T05:00:00Z', '5h': 100, reset5hTs: base + 5 * 3_600_000 }, // resetTs advanced → boundary
  ];
  const cycles = segmentCycles(snaps, '5h');
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].length, 2);
});

test('segmentCycles ignores snapshots missing the window field', () => {
  const snaps = [
    { ts: '2026-06-25T00:00:00Z', '5h': 80 },
    { ts: '2026-06-25T00:30:00Z', wk: 60 }, // no 5h
    { ts: '2026-06-25T01:00:00Z', '5h': 70 },
  ];
  const cycles = segmentCycles(snaps, '5h');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].length, 2);
});

test('segmentCycles returns [] for empty input', () => {
  assert.deepEqual(segmentCycles([], '5h'), []);
});

const { cycleStats } = require('../metrics.js');

test('cycleStats reports peak and headroom for a comfortable cycle', () => {
  const cycle = [
    { ts: '2026-06-25T00:00:00Z', '5h': 80 },
    { ts: '2026-06-25T01:00:00Z', '5h': 30 },
  ];
  const s = cycleStats(cycle, '5h');
  assert.equal(s.peakPct, 70);
  assert.equal(s.headroomPct, 30);
  assert.equal(s.blocked, false);
  assert.equal(s.blockedMs, 0);
  assert.equal(s.startTs, '2026-06-25T00:00:00Z');
  assert.equal(s.endTs, '2026-06-25T01:00:00Z');
});

test('cycleStats measures blocked duration when a cycle hits zero', () => {
  const cycle = [
    { ts: '2026-06-25T00:00:00Z', '5h': 40 },
    { ts: '2026-06-25T01:00:00Z', '5h': 0 },
    { ts: '2026-06-25T02:00:00Z', '5h': 0 },
  ];
  const s = cycleStats(cycle, '5h');
  assert.equal(s.peakPct, 100);
  assert.equal(s.headroomPct, 0);
  assert.equal(s.blocked, true);
  assert.equal(s.blockedMs, 3_600_000); // 01:00 → 02:00
});

const { summarize, hourlyBurn } = require('../metrics.js');

test('summarize aggregates block rate and peaks across cycles', () => {
  const stats = [
    { startTs: 'a', peakPct: 60, blocked: false, blockedMs: 0 },
    { startTs: 'b', peakPct: 100, blocked: true, blockedMs: 3_600_000 },
  ];
  const sum = summarize(stats);
  assert.equal(sum.count, 2);
  assert.equal(sum.blockedCount, 1);
  assert.equal(sum.blockRate, 0.5);
  assert.equal(sum.totalBlockedMs, 3_600_000);
  assert.deepEqual(sum.peaks, [{ ts: 'a', peakPct: 60 }, { ts: 'b', peakPct: 100 }]);
});

test('summarize handles no completed cycles', () => {
  const sum = summarize([]);
  assert.equal(sum.count, 0);
  assert.equal(sum.blockRate, 0);
  assert.deepEqual(sum.peaks, []);
});

test('hourlyBurn sums active drops and excludes idle gaps and resets', () => {
  const snaps = [
    { ts: '2026-06-25T09:00:00Z', '5h': 100 },
    { ts: '2026-06-25T09:05:00Z', '5h': 90 },  // active drop 10
    { ts: '2026-06-25T11:00:00Z', '5h': 70 },  // gap 115min → idle, excluded
    { ts: '2026-06-25T11:05:00Z', '5h': 60 },  // active drop 10
    { ts: '2026-06-25T11:10:00Z', '5h': 100 }, // reset (negative) → excluded
  ];
  const hours = hourlyBurn(snaps, '5h');
  assert.equal(hours.length, 24);
  assert.equal(hours.reduce((a, b) => a + b, 0), 20); // TZ-independent total
});
