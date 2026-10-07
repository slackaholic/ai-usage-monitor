'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The parse functions are not contiguous in renderer.js — Claude's sit at ~795
// and Codex's at ~1190, with the Claude Desktop and Claude Code render layers
// in between. Three marked regions are concatenated rather than relocating
// ~400 lines of working code to suit a test harness. READING SHAPE comes first
// because the parsers call makeReading.
function loadParsers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const REGIONS = [
    ['// ── READING SHAPE ──',  '// ── READING SHAPE END ──'],
    ['// ── CLAUDE PARSERS ──', '// ── CLAUDE PARSERS END ──'],
    ['// ── CODEX PARSERS ──',  '// ── CODEX PARSERS END ──'],
  ];
  let code = '';
  for (const [open, close] of REGIONS) {
    const a = source.indexOf(open);
    const b = source.indexOf(close);
    assert.ok(a >= 0 && b > a, `expected markers: ${open}`);
    code += source.slice(a + open.length, b) + '\n';
  }
  const context = { console, Math, Number, RegExp, Date, parseInt, isNaN };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

const NOW = Date.parse('2026-10-07T09:00:00Z');
const HOUR = 3_600_000;

test('a reading defaults to both windows existing but unmeasured', () => {
  const { makeReading } = loadParsers();
  const r = makeReading();
  assert.strictEqual(r.pct5h, null);
  assert.strictEqual(r.pctWk, null);
  assert.strictEqual(r.reset5hMs, 0);
  assert.strictEqual(r.resetWkMs, 0);
  // Default true: "momentarily missing" is the common case and renders as an
  // em-dash. Only a parser that KNOWS the plan lacks a window says so.
  assert.strictEqual(r.has5h, true);
  assert.strictEqual(r.hasWk, true);
  assert.strictEqual(r.label, null);
  assert.strictEqual(r.extra, null);
});

test('a reading keeps an explicit false for a window the plan lacks', () => {
  const { makeReading } = loadParsers();
  assert.strictEqual(makeReading({ has5h: false }).has5h, false);
});

test('codex emits the normalised shape with the weekly value in the weekly slot', () => {
  const { parseCodexApiUsage } = loadParsers();
  const r = parseCodexApiUsage({
    rate_limit: {
      primary_window: {
        limit_window_seconds: 7 * 86400,
        used_percent: 0,
        reset_at: Math.floor((NOW + 166 * HOUR) / 1000),
      },
    },
    credits: { balance: 0 },
    email: 'a@example.com',
  }, NOW);

  assert.strictEqual(r.pctWk, 100);
  assert.strictEqual(r.pct5h, null);
  assert.strictEqual(r.has5h, false, 'Codex has no 5h window since 2026-07-11');
  assert.strictEqual(r.hasWk, true);
  assert.strictEqual(r.resetWkMs, NOW + 166 * HOUR);
  assert.strictEqual(r.reset5hMs, 0);
  assert.strictEqual(r.label, 'a@example.com');
  // r.extra was built inside the vm context, so its prototype is that realm's
  // Object.prototype and deepStrictEqual (which compares prototypes) would
  // reject it despite identical contents. Spreading re-homes it in this realm.
  assert.deepStrictEqual({ ...r.extra }, { credits: 0 });
});

// The polarity bug the whole refactor exists to remove: Claude's sources report
// percentage USED, and that must be converted at the parse boundary so nothing
// downstream ever sees a "used" figure.
test('claude org usage converts used-percent to remaining at the parse boundary', () => {
  const { parseClaudeOrgUsage } = loadParsers();
  const r = parseClaudeOrgUsage({
    five_hour:  { utilization: 46, resets_at: new Date(NOW + 2 * HOUR).toISOString() },
    seven_day:  { utilization: 15, resets_at: new Date(NOW + 5 * 24 * HOUR).toISOString() },
  });

  assert.strictEqual(r.pct5h, 54, 'remaining, not used');
  assert.strictEqual(r.pctWk, 85, 'remaining, not used');
  assert.strictEqual(r.reset5hMs, NOW + 2 * HOUR);
  assert.strictEqual(r.resetWkMs, NOW + 5 * 24 * HOUR);
});

test('claude org usage reports an absent window as unmeasured, not as zero', () => {
  const { parseClaudeOrgUsage } = loadParsers();
  const r = parseClaudeOrgUsage({ five_hour: { utilization: 46 } });
  assert.strictEqual(r.pct5h, 54);
  assert.strictEqual(r.pctWk, null, 'absent is null, never 100');
});

test('claude scraped text also emits remaining', () => {
  const { parseClaudeWebText } = loadParsers();
  const r = parseClaudeWebText('Current session\n46% used\nWeekly\n15% used');
  assert.strictEqual(r.pct5h, 54);
  assert.strictEqual(r.pctWk, 85);
});

// metrics.js:44 clamps to [0,100] for DISPLAY; the reading itself stays raw.
// test/rate-limit-headers.test.js pins this for the Claude Code header path
// ("over-quota stays negative — that is a real reading, not a sentinel").
// These two cover the Claude Desktop paths, which had no such test and so did
// not catch a clamp being introduced at the parse boundary.
test('claude org usage keeps an over-quota reading negative', () => {
  const { parseClaudeOrgUsage } = loadParsers();
  const r = parseClaudeOrgUsage({
    five_hour: { utilization: 102 },
    seven_day: { utilization: 110 },
  });
  assert.strictEqual(r.pct5h, -2);
  assert.strictEqual(r.pctWk, -10);
});

test('claude scraped text keeps an over-quota reading negative', () => {
  const { parseClaudeWebText } = loadParsers();
  const r = parseClaudeWebText('Current session\n102% used\nWeekly\n110% used');
  assert.strictEqual(r.pct5h, -2);
  assert.strictEqual(r.pctWk, -10);
});

test('claude code headers pass through as remaining', () => {
  const { normaliseClaudeCodeReading } = loadParsers();
  const r = normaliseClaudeCodeReading({
    pct5h: 55, pct7d: 86,
    reset5hMs: NOW + HOUR, reset7dMs: NOW + 3 * 24 * HOUR,
    account: 'max 20x',
  });
  assert.strictEqual(r.pct5h, 55);
  assert.strictEqual(r.pctWk, 86);
  assert.strictEqual(r.reset5hMs, NOW + HOUR);
  assert.strictEqual(r.resetWkMs, NOW + 3 * 24 * HOUR);
  assert.strictEqual(r.label, 'max 20x');
});

// Anthropic dropped the 7d header pair for a period in August 2026.
test('claude code reports a missing weekly header as no window, not a gap', () => {
  const { normaliseClaudeCodeReading } = loadParsers();
  const r = normaliseClaudeCodeReading({ pct5h: 55, pct7d: null, hasWk: false });
  assert.strictEqual(r.pctWk, null);
  assert.strictEqual(r.hasWk, false);
});
