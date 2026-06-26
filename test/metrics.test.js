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

test('entryCost prices a normalized OpenAI entry (cache read at 10%)', () => {
  // non-cached input 1M @2.5, output 1M @15, cache_read 1M @ 2.5*0.1
  const e = { model: 'gpt-5.4', input_tokens: 1_000_000, output_tokens: 1_000_000,
              cache_creation: 0, cache_read: 1_000_000 };
  approx(entryCost(e), 17.75); // 2.5 + 15 + 0.25
});

test('entryCost returns null for unpriced spark model', () => {
  assert.equal(entryCost({ model: 'gpt-5.3-codex-spark', output_tokens: 1_000_000 }), null);
});
