'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads the Codex parse block out of renderer.js and runs it in a bare context.
// Nothing in the slice touches the DOM, so no stubs are needed beyond the
// globals the parsers actually use.
function loadCodexParsers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('const CODEX_WINDOW_SPLIT_SECONDS');
  const end = source.indexOf('function renderCodexData');
  assert.ok(start >= 0 && end > start, 'expected Codex parse source markers');

  const context = { console, Math, Number, RegExp, Date, parseInt };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

// 2026-08-26T09:22:39Z — a real poll time from the usage log. Whole seconds:
// reset_at is Unix SECONDS, so a sub-second NOW would only test rounding.
const NOW = Date.parse('2026-08-26T09:22:39Z');
const FIVE_HOURS = 5 * 3600;
const ONE_WEEK = 7 * 86400;

const win = (seconds, usedPercent, resetAtMs) => ({
  limit_window_seconds: seconds,
  used_percent: usedPercent,
  reset_at: Math.floor(resetAtMs / 1000),
});

// ── Duration-based classification ─────────────────────────────────────────

test('a two-window response still maps 5h and weekly to their own slots', () => {
  const { parseCodexApiUsage } = loadCodexParsers();

  const parsed = parseCodexApiUsage({
    rate_limit: {
      primary_window: win(FIVE_HOURS, 40, NOW + 2 * 3_600_000),
      secondary_window: win(ONE_WEEK, 25, NOW + 5 * 86_400_000),
    },
  }, NOW);

  assert.strictEqual(parsed.shared5h, 60);
  assert.strictEqual(parsed.sharedWeek, 75);
  assert.strictEqual(parsed.reset5hMs, NOW + 2 * 3_600_000);
  assert.strictEqual(parsed.reset7dMs, NOW + 5 * 86_400_000);
  assert.strictEqual(parsed.has5h, true);
});

// The live regression: since 2026-07-11 OpenAI sends the WEEKLY window as
// `primary_window` and no secondary at all. Position-based parsing put that
// weekly figure in the 5h slot and left the weekly slot empty.
test('a weekly-only response puts the weekly figure in the weekly slot', () => {
  const { parseCodexApiUsage } = loadCodexParsers();

  const parsed = parseCodexApiUsage({
    rate_limit: { primary_window: win(ONE_WEEK, 0, NOW + 166 * 3_600_000) },
  }, NOW);

  assert.strictEqual(parsed.sharedWeek, 100, 'weekly value belongs in sharedWeek');
  assert.strictEqual(parsed.shared5h, null, 'there is no 5h reading to report');
  assert.strictEqual(parsed.reset7dMs, NOW + 166 * 3_600_000);
  assert.strictEqual(parsed.reset5hMs, 0);
  assert.strictEqual(parsed.has5h, false);
});

test('windows are read by declared length, not by their position', () => {
  const { parseCodexApiUsage } = loadCodexParsers();

  // Same two windows, swapped into the opposite positions.
  const parsed = parseCodexApiUsage({
    rate_limit: {
      primary_window: win(ONE_WEEK, 25, NOW + 5 * 86_400_000),
      secondary_window: win(FIVE_HOURS, 40, NOW + 2 * 3_600_000),
    },
  }, NOW);

  assert.strictEqual(parsed.shared5h, 60);
  assert.strictEqual(parsed.sharedWeek, 75);
  assert.strictEqual(parsed.has5h, true);
});

// ── Fallbacks, so an undeclared response degrades instead of lying ────────

test('a window with no declared length is judged by how far its reset is', () => {
  const { parseCodexApiUsage } = loadCodexParsers();

  const weekly = parseCodexApiUsage({
    rate_limit: { primary_window: { used_percent: 10, reset_at: Math.floor((NOW + 6 * 86_400_000) / 1000) } },
  }, NOW);
  assert.strictEqual(weekly.sharedWeek, 90, 'a reset six days out cannot be a 5h window');
  assert.strictEqual(weekly.shared5h, null);
  assert.strictEqual(weekly.has5h, false);

  const session = parseCodexApiUsage({
    rate_limit: { primary_window: { used_percent: 10, reset_at: Math.floor((NOW + 3 * 3_600_000) / 1000) } },
  }, NOW);
  assert.strictEqual(session.shared5h, 90, 'a reset three hours out is a session window');
  assert.strictEqual(session.sharedWeek, null);
  assert.strictEqual(session.has5h, true);
});

test('a window declaring neither length nor reset keeps its historic position', () => {
  const { parseCodexApiUsage } = loadCodexParsers();

  const parsed = parseCodexApiUsage({
    rate_limit: {
      primary_window: { used_percent: 40 },
      secondary_window: { used_percent: 25 },
    },
  }, NOW);

  assert.strictEqual(parsed.shared5h, 60);
  assert.strictEqual(parsed.sharedWeek, 75);
});

test('a missing rate_limit is still reported as no data at all', () => {
  const { parseCodexApiUsage } = loadCodexParsers();
  assert.strictEqual(parseCodexApiUsage({}), null);
  assert.strictEqual(parseCodexApiUsage(null), null);
});

test('two windows of the same length do not overwrite each other', () => {
  const { parseCodexApiUsage } = loadCodexParsers();

  const parsed = parseCodexApiUsage({
    rate_limit: {
      primary_window: win(ONE_WEEK, 25, NOW + 5 * 86_400_000),
      secondary_window: win(ONE_WEEK, 90, NOW + 5 * 86_400_000),
    },
  }, NOW);

  assert.strictEqual(parsed.sharedWeek, 75, 'the first weekly window keeps the slot');
  assert.strictEqual(parsed.shared5h, null);
});

test('credits and email survive the remapping', () => {
  const { parseCodexApiUsage } = loadCodexParsers();

  const parsed = parseCodexApiUsage({
    rate_limit: { primary_window: win(ONE_WEEK, 0, NOW + 166 * 3_600_000) },
    credits: { balance: 0 },
    email: 'digital.accounts@example.com',
  }, NOW);

  assert.strictEqual(parsed.credits, 0);
  assert.strictEqual(parsed.email, 'digital.accounts@example.com');
});

// ── The scraped-page fallback agrees with the API about the 5h window ─────

test('the scraped page reports no 5h window when the page has no 5h section', () => {
  const { parseCodexText } = loadCodexParsers();

  const parsed = parseCodexText([
    'Balance',
    'Weekly usage limit',
    '100% remaining',
    'Credits remaining',
    '0',
  ].join('\n'));

  assert.strictEqual(parsed.sharedWeek, 100);
  assert.strictEqual(parsed.shared5h, null);
  assert.strictEqual(parsed.has5h, false);
  assert.strictEqual(parsed.credits, '0');
});

test('the scraped page reports a 5h window when the page still has one', () => {
  const { parseCodexText } = loadCodexParsers();

  const parsed = parseCodexText([
    '5 hour usage limit',
    '80% remaining',
    'Resets 2:15 PM',
    'Weekly usage limit',
    '55% remaining',
  ].join('\n'));

  assert.strictEqual(parsed.shared5h, 80);
  assert.strictEqual(parsed.sharedWeek, 55);
  assert.strictEqual(parsed.has5h, true);
});

test('an empty page claims neither window', () => {
  const { parseCodexText } = loadCodexParsers();

  const parsed = parseCodexText('');
  assert.strictEqual(parsed.shared5h, null);
  assert.strictEqual(parsed.sharedWeek, null);
  assert.strictEqual(parsed.has5h, false);
});
