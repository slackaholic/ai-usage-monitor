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
