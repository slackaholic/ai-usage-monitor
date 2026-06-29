'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { segmentCycles, countDepletionEvents, weeklyRunway } = require('../metrics.js');

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

test('segmentCycles ignores rolling reset timestamps while the window remains full', () => {
  const snaps = [
    { ts: '2026-06-29T12:15:35Z', '5h': 0, reset5hTs: Date.parse('2026-06-29T12:17:08Z') },
    { ts: '2026-06-29T12:17:35Z', '5h': 100, reset5hTs: Date.parse('2026-06-29T17:17:35Z') },
    { ts: '2026-06-29T12:19:36Z', '5h': 100, reset5hTs: Date.parse('2026-06-29T17:19:36Z') },
    { ts: '2026-06-29T12:21:36Z', '5h': 100, reset5hTs: Date.parse('2026-06-29T17:21:36Z') },
    { ts: '2026-06-29T12:23:35Z', '5h': 100, reset5hTs: Date.parse('2026-06-29T17:23:35Z') },
    { ts: '2026-06-29T12:27:36Z', '5h': 99, reset5hTs: Date.parse('2026-06-29T17:26:17Z') },
  ];
  const cycles = segmentCycles(snaps, '5h');
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].length, 1);
  assert.equal(cycles[1].length, 5);
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

test('cycleStats: cycle starting at 0 is NOT blocked (left-censored)', () => {
  const cycle = [
    { ts: '2026-06-25T00:00:00Z', '5h': 0 },
    { ts: '2026-06-25T01:00:00Z', '5h': 0 },
  ];
  const s = cycleStats(cycle, '5h');
  assert.equal(s.blocked, false);
  assert.equal(s.blockedMs, 0);
  assert.equal(s.peakPct, 100);
  assert.equal(s.headroomPct, 0);
});

test('countDepletionEvents counts transitions into depletion, not every depleted poll', () => {
  const snaps = [
    { ts: '2026-06-25T00:00:00Z', '5h': 20 },
    { ts: '2026-06-25T00:05:00Z', '5h': 0, depleted: ['5h'] },
    { ts: '2026-06-25T00:10:00Z', '5h': 0, depleted: ['5h'] },
    { ts: '2026-06-25T05:00:00Z', '5h': 100 },
    { ts: '2026-06-25T05:30:00Z', '5h': 0, depleted: ['5h'] },
  ];
  assert.equal(countDepletionEvents(snaps, '5h'), 2);
});

test('weeklyRunway projects weekly depletion before reset and required plan multiplier', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:10:00Z', wk: 79, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:20:00Z', wk: 78, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:30:00Z', wk: 77, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'good');
  assert.equal(r.currentPlanMultiplier, 5);
  assert.equal(r.weeklyRemainingPct, 77);
  assert.equal(r.weeklyResetTs, Date.parse('2026-06-30T08:30:00Z'));
  assert.equal(r.weeklyBurnRatePctPerHour, 6);
  assert.equal(r.projectedDepleteTs, Date.parse('2026-06-29T21:20:00Z'));
  assert.equal(r.gapMs, 11 * 3_600_000 + 10 * 60_000);
  assert.equal(r.projectedHeadroomAtResetPct, -67);
  assert.ok(Math.abs(r.requiredPlanMultiplier - 9.35064935064935) < 1e-9);
});

test('weeklyRunway reports buffer and lower required multiplier when pace lasts to reset', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 93, reset7dTs: Date.parse('2026-06-29T20:30:00Z') },
    { ts: '2026-06-29T08:10:00Z', wk: 92, reset7dTs: Date.parse('2026-06-29T20:30:00Z') },
    { ts: '2026-06-29T08:20:00Z', wk: 91, reset7dTs: Date.parse('2026-06-29T20:30:00Z') },
    { ts: '2026-06-29T08:30:00Z', wk: 90, reset7dTs: Date.parse('2026-06-29T20:30:00Z') },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'good');
  assert.equal(r.weeklyBurnRatePctPerHour, 6);
  assert.equal(r.projectedDepleteTs, Date.parse('2026-06-29T23:30:00Z'));
  assert.equal(r.gapMs, -3 * 3_600_000);
  assert.equal(r.projectedHeadroomAtResetPct, 18);
  assert.equal(r.requiredPlanMultiplier, 4);
});

test('weeklyRunway uses limited confidence for short active evidence', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:05:00Z', wk: 79, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'limited');
  assert.equal(r.weeklyBurnRatePctPerHour, 12);
});

test('weeklyRunway returns no-confidence state without weekly burn evidence', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:30:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'none');
  assert.equal(r.weeklyBurnRatePctPerHour, 0);
  assert.equal(r.projectedDepleteTs, null);
  assert.equal(r.gapMs, null);
  assert.equal(r.projectedHeadroomAtResetPct, null);
  assert.equal(r.requiredPlanMultiplier, null);
});

test('weeklyRunway preserves burn evidence but suppresses projection for stale reset', () => {
  const staleReset = Date.parse('2026-06-29T08:20:00Z');
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 80, reset7dTs: staleReset },
    { ts: '2026-06-29T08:10:00Z', wk: 79, reset7dTs: staleReset },
    { ts: '2026-06-29T08:20:00Z', wk: 78, reset7dTs: staleReset },
    { ts: '2026-06-29T08:30:00Z', wk: 77, reset7dTs: staleReset },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'good');
  assert.equal(r.currentPlanMultiplier, 5);
  assert.equal(r.weeklyRemainingPct, 77);
  assert.equal(r.weeklyResetTs, staleReset);
  assert.equal(r.weeklyBurnRatePctPerHour, 6);
  assert.equal(r.projectedDepleteTs, null);
  assert.equal(r.gapMs, null);
  assert.equal(r.projectedHeadroomAtResetPct, null);
  assert.equal(r.requiredPlanMultiplier, null);
});

test('weeklyRunway sanitizes non-finite plan multipliers', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:10:00Z', wk: 79, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:20:00Z', wk: 78, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:30:00Z', wk: 77, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
  ];

  const r = weeklyRunway(snaps, Infinity);

  assert.equal(r.currentPlanMultiplier, 1);
  assert.ok(Math.abs(r.requiredPlanMultiplier - 1.87012987012987) < 1e-9);
});
test('segmentCycles splits on a gap longer than the window length', () => {
  const snaps = [
    { ts: '2026-06-25T00:00:00Z', '5h': 100 },
    { ts: '2026-06-25T06:00:00Z', '5h': 100 }, // 6h gap > 5h window → boundary
  ];
  const cycles = segmentCycles(snaps, '5h');
  assert.equal(cycles.length, 2);
});

const { summarize, hourlyBurn } = require('../metrics.js');
const fs = require('node:fs');
const path = require('node:path');

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

test('real log: full pipeline yields sane stats and never throws', () => {
  const p = path.join(__dirname, '..', 'usage-log.jsonl');
  if (!fs.existsSync(p)) return; // clean checkout — nothing to validate
  const all = fs.readFileSync(p, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  for (const acct of ['codex', 'claude-desktop', 'claude-vscode']) {
    const snaps = all.filter(e => e.account === acct);
    for (const win of ['5h', 'wk']) {
      const stats = segmentCycles(snaps, win).map(c => cycleStats(c, win));
      for (const s of stats) {
        assert.ok(s.peakPct >= 0 && s.peakPct <= 100, `peak ${s.peakPct}`);
        assert.ok(s.headroomPct >= 0 && s.headroomPct <= 100, `headroom ${s.headroomPct}`);
        assert.ok(s.blockedMs >= 0);
      }
      const sum = summarize(stats);
      assert.ok(sum.blockRate >= 0 && sum.blockRate <= 1);
      assert.equal(hourlyBurn(snaps, win).length, 24);
    }
  }
});

const { monthBurnGrid } = require('../metrics.js');

test('monthBurnGrid returns one row per day of the calendar month', () => {
  assert.equal(monthBurnGrid([], '5h', 2026, 5).length, 30); // June 2026
  assert.equal(monthBurnGrid([], '5h', 2026, 6).length, 31); // July 2026
  assert.equal(monthBurnGrid([], '5h', 2028, 1).length, 29); // Feb 2028 (leap)
  assert.equal(monthBurnGrid([], '5h', 2027, 1).length, 28); // Feb 2027
});

test('monthBurnGrid buckets active drops into the queried month only', () => {
  const snaps = [
    { ts: '2026-06-10T12:00:00Z', '5h': 100 },
    { ts: '2026-06-10T12:05:00Z', '5h': 90 },  // June active drop 10
    { ts: '2026-06-10T12:10:00Z', '5h': 100 }, // reset (negative) → excluded
    { ts: '2026-07-10T12:00:00Z', '5h': 80 },  // month gap → idle, excluded
    { ts: '2026-07-10T12:05:00Z', '5h': 70 },  // July active drop 10
  ];
  const sum = g => g.reduce((a, r) => a + r.hours.reduce((x, y) => x + y, 0), 0);
  assert.equal(sum(monthBurnGrid(snaps, '5h', 2026, 5)), 10); // June only
  assert.equal(sum(monthBurnGrid(snaps, '5h', 2026, 6)), 10); // July only
});

test('monthBurnGrid marks hasData for logged days including zero-burn days', () => {
  const snaps = [
    { ts: '2026-06-10T12:00:00Z', '5h': 50 },
    { ts: '2026-06-10T12:05:00Z', '5h': 50 }, // logged June 10, no drop
  ];
  const june = monthBurnGrid(snaps, '5h', 2026, 5);
  assert.equal(june.filter(r => r.hasData).length, 1);
  assert.equal(june.find(r => r.hasData).hours.reduce((a, b) => a + b, 0), 0);
  assert.equal(monthBurnGrid(snaps, '5h', 2026, 4).filter(r => r.hasData).length, 0); // May: none
});

const { entryCost, summarizeCost, activeMs, subscriptionValue, modelFamily } = require('../metrics.js');

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('entryCost prices each component by model family', () => {
  approx(entryCost({ model: 'claude-opus-4-8', input_tokens: 1_000_000 }), 5);
  approx(entryCost({ model: 'claude-opus-4-8', output_tokens: 1_000_000 }), 25);
  approx(entryCost({ model: 'claude-opus-4-8', cache_creation: 1_000_000 }), 6.25); // 5 × 1.25
  approx(entryCost({ model: 'claude-opus-4-8', cache_read: 1_000_000 }), 0.5);      // 5 × 0.1
  approx(entryCost({ model: 'claude-sonnet-4-6', output_tokens: 1_000_000 }), 15);
  assert.equal(entryCost({ model: 'something-unknown', input_tokens: 1_000_000 }), null);
});

test('summarizeCost aggregates totals, families, unpriced, and cache savings', () => {
  const entries = [
    { model: 'claude-opus-4-8', input_tokens: 1_000_000 },                 // $5  Opus
    { model: 'claude-sonnet-4-6', output_tokens: 1_000_000 },              // $15 Sonnet
    { model: 'unknown', input_tokens: 1_000_000 },                        // unpriced
    { model: 'claude-opus-4-8', cache_read: 1_000_000 },                   // $0.5 Opus; saves 5×0.9
  ];
  const s = summarizeCost(entries);
  approx(s.total, 20.5);
  assert.equal(s.unpriced, 1);
  approx(s.cacheSavings, 4.5);
  approx(s.byModel.Opus.cost, 5.5);
  assert.equal(s.byModel.Opus.tokens, 2_000_000);
  approx(s.byModel.Sonnet.cost, 15);
});

test('activeMs sums active drops and excludes idle gaps and resets', () => {
  const snaps = [
    { ts: '2026-06-25T09:00:00Z', '5h': 100 },
    { ts: '2026-06-25T09:05:00Z', '5h': 90 },  // active 5min
    { ts: '2026-06-25T11:00:00Z', '5h': 80 },  // 115min gap → idle, excluded
    { ts: '2026-06-25T11:05:00Z', '5h': 70 },  // active 5min
    { ts: '2026-06-25T11:10:00Z', '5h': 100 }, // reset → excluded
  ];
  assert.equal(activeMs(snaps, '5h'), 600_000); // 2 × 5min
});

test('subscriptionValue prorates monthly price over the data span', () => {
  const snaps = [
    { ts: '2026-06-01T00:00:00Z', '5h': 100 },
    { ts: '2026-06-01T00:05:00Z', '5h': 90 },  // active 5min
    { ts: '2026-06-02T00:00:00Z', '5h': 80 },  // ~24h gap → idle
  ];
  const v = subscriptionValue(snaps, 30, '5h'); // span 24h, price $30/mo
  approx(v.attributedCost, 1);                   // 30 × (1 day / 30 days)
  approx(v.activeHours, 5 / 60);
  approx(v.perActiveHour, 12);
  assert.equal(v.windows, 2);                    // long gap splits the cycle
  assert.equal(subscriptionValue(snaps, 0, '5h'), null);          // no price
  assert.equal(subscriptionValue([snaps[0]], 30, '5h'), null);    // < 2 points
});

test('modelFamily maps OpenAI slugs, longest-match first', () => {
  assert.equal(modelFamily('gpt-5.5'), 'GPT-5.5');
  assert.equal(modelFamily('gpt-5.4'), 'GPT-5.4');
  assert.equal(modelFamily('gpt-5.4-mini'), 'GPT-5.4-mini');
  assert.equal(modelFamily('gpt-5.4-nano'), 'GPT-5.4-nano');
  assert.equal(modelFamily('gpt-5.3-codex-spark'), null); // unpriced
  assert.equal(modelFamily('opus-4-8'), 'Opus');           // existing still works
});

test('modelFamily leaves unknown gpt variants unpriced (not guessed)', () => {
  assert.equal(modelFamily('gpt-5-mini'), null);
  assert.equal(modelFamily('gpt-4o-mini'), null);
  assert.equal(modelFamily('gpt-5-nano'), null);
  assert.equal(modelFamily('codex-auto-review'), null);
  // known gpt-5.4 variants still priced
  assert.equal(modelFamily('gpt-5.4-mini'), 'GPT-5.4-mini');
  assert.equal(modelFamily('gpt-5.4-nano'), 'GPT-5.4-nano');
});

test('entryCost prices a normalized OpenAI entry (cache read at 10%)', () => {
  // non-cached input 1M @2.5, output 1M @15, cache_read 1M @ 2.5*0.1
  const e = { model: 'gpt-5.4', input_tokens: 1_000_000, output_tokens: 1_000_000,
              cache_creation: 0, cache_read: 1_000_000 };
  approx(entryCost(e), 17.75); // 2.5 + 15 + 0.25
});

test('entryCost returns null for unpriced spark model', () => {
  assert.equal(entryCost({ model: 'gpt-5.3-codex-spark', output_tokens: 1_000_000 }), null);
});

const { costByDay } = require('../metrics.js');

test('costByDay buckets cost by local calendar day, skipping unpriced', () => {
  const entries = [
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-01T10:00:00' }, // 15
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-01T20:00:00' }, // 15
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-02T09:00:00' }, // 15
    { model: 'spark',   output_tokens: 9_000_000, timestamp: '2026-06-02T09:30:00' }, // unpriced
  ];
  const by = costByDay(entries);
  assert.ok(Math.abs(by['2026-06-01'] - 30) < 1e-9);
  assert.ok(Math.abs(by['2026-06-02'] - 15) < 1e-9);
  assert.equal(Object.keys(by).length, 2);
});

test('costByDay returns {} for empty input', () => {
  assert.deepEqual(costByDay([]), {});
  assert.deepEqual(costByDay(undefined), {});
});

const { costByMonth } = require('../metrics.js');

test('costByMonth aggregates days within a month and separates months', () => {
  const entries = [
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-05-31T10:00:00' }, // 15 (May)
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-01T10:00:00' }, // 15 (Jun)
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-20T10:00:00' }, // 15 (Jun)
  ];
  const by = costByMonth(entries);
  assert.ok(Math.abs(by['2026-05'] - 15) < 1e-9);
  assert.ok(Math.abs(by['2026-06'] - 30) < 1e-9);
});

test('sum of costByDay within a month equals costByMonth for that month', () => {
  const entries = [
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-01T10:00:00' },
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-02T10:00:00' },
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-02T18:00:00' },
  ];
  const days = costByDay(entries);
  const monthSumFromDays = Object.entries(days)
    .filter(([k]) => k.startsWith('2026-06'))
    .reduce((a, [, v]) => a + v, 0);
  assert.ok(Math.abs(monthSumFromDays - costByMonth(entries)['2026-06']) < 1e-9);
});

test('costByMonth returns {} for empty input', () => {
  assert.deepEqual(costByMonth([]), {});
});

const { normalizeCodexTokenUsage, entryCost: _ec } = require('../metrics.js');

test('normalizeCodexTokenUsage splits cached input and zeroes cache_creation', () => {
  const u = { input_tokens: 76414, cached_input_tokens: 75648, output_tokens: 704,
              reasoning_output_tokens: 458, total_tokens: 77118 };
  const e = normalizeCodexTokenUsage(u, 'gpt-5.5', '2026-06-25T12:46:39.043Z');
  assert.equal(e.timestamp, '2026-06-25T12:46:39.043Z');
  assert.equal(e.model, 'gpt-5.5');
  assert.equal(e.input_tokens, 766);   // 76414 - 75648
  assert.equal(e.cache_read, 75648);
  assert.equal(e.cache_creation, 0);
  assert.equal(e.output_tokens, 704);
  assert.ok(_ec(e) > 0);               // priceable via gpt-5.5
});

test('normalizeCodexTokenUsage handles missing fields and falsy input', () => {
  assert.equal(normalizeCodexTokenUsage(null, 'gpt-5.5', 't'), null);
  const e = normalizeCodexTokenUsage({}, undefined, 't');
  assert.equal(e.input_tokens, 0);
  assert.equal(e.cache_read, 0);
  assert.equal(e.model, 'unknown');
});

const { tokenMix } = require('../metrics.js');

test('tokenMix sums each field and computes total', () => {
  const entries = [
    { input_tokens: 10, output_tokens: 20, cache_creation: 5, cache_read: 100 },
    { input_tokens: 1, output_tokens: 2, cache_creation: 0, cache_read: 50 },
  ];
  const m = tokenMix(entries);
  assert.equal(m.input, 11);
  assert.equal(m.output, 22);
  assert.equal(m.cacheWrite, 5);
  assert.equal(m.cacheRead, 150);
  assert.equal(m.total, 11 + 22 + 5 + 150);
});

test('tokenMix handles empty/undefined input and missing fields', () => {
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
  assert.deepEqual(tokenMix([]), zero);
  assert.deepEqual(tokenMix(undefined), zero);
  const m = tokenMix([{ input_tokens: 7 }]);
  assert.equal(m.input, 7);
  assert.equal(m.total, 7);
});
