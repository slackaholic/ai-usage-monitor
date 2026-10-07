'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The parse functions are not contiguous in renderer.js — Claude's and Codex's
// sit in separate sections, with the Claude Desktop and Claude Code render
// layers in between, and parseResetToMs lives with the shared utilities. Four
// marked regions are concatenated rather than relocating working code to suit
// a test harness. READING SHAPE comes first because the parsers call
// makeReading; RESET PARSING precedes CLAUDE PARSERS, which calls it.
function loadParsers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const REGIONS = [
    ['// ── READING SHAPE ──',  '// ── READING SHAPE END ──'],
    ['// ── RESET PARSING ──',  '// ── RESET PARSING END ──'],
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

// Slices the registration block. It touches only module-level objects, so the
// stub context needs no DOM. The block declares its registries with `const`,
// and a `const` in a vm script is not a property of the context, so a second
// script copies them across; that same copy fails loudly (ReferenceError) if a
// registry is ever declared outside the block, which is what the slice depends
// on.
function loadRegistration() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('// ── REGISTRATION ──');
  const end = source.indexOf('// ── REGISTRATION END ──');
  assert.ok(start >= 0 && end > start, 'expected registration source markers');
  const context = { console, Object, Array, Set, Map };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(
    'Object.assign(globalThis, { accountOverrides, hasData, cachedData, ' +
    'trendHistory, LOG_ACCOUNT, lastPct5h, sessionStore, PROVIDERS });',
    context);
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

test('a codex response with no weekly window reports hasWk false', () => {
  const { parseCodexApiUsage } = loadParsers();
  const r = parseCodexApiUsage({
    rate_limit: {
      primary_window: {
        limit_window_seconds: 5 * 3600,
        used_percent: 20,
        reset_at: Math.floor((NOW + 2 * HOUR) / 1000),
      },
    },
  }, NOW);
  assert.strictEqual(r.pct5h, 80);
  assert.strictEqual(r.has5h, true);
  assert.strictEqual(r.pctWk, null);
  assert.strictEqual(r.hasWk, false, 'an absent window is n/a, not an em-dash');
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

test('claude scraped text carries its reset prose through as epoch ms', () => {
  const { parseClaudeWebText } = loadParsers();
  const before = Date.now();
  const r = parseClaudeWebText(
    'Current session\n46% used\nResets in 3 hr 20 min\n' +
    'Weekly\n15% used\nResets Sat 4:59 PM');
  const offset = 3 * 3_600_000 + 20 * 60_000;
  assert.ok(r.reset5hMs >= before + offset - 5000, `too early: ${r.reset5hMs}`);
  assert.ok(r.reset5hMs <= Date.now() + offset + 5000, `too late: ${r.reset5hMs}`);
  // "Sat 4:59 PM" resolves to the next Saturday at 16:59 local time. Asserting
  // the resolved day and time — not merely "in the future" — is what catches
  // resetWkMs being wired to the wrong label's prose.
  const wk = new Date(r.resetWkMs);
  assert.strictEqual(wk.getDay(), 6, `expected Saturday, got ${wk}`);
  assert.strictEqual(wk.getHours(), 16, `expected 16:xx, got ${wk}`);
  assert.strictEqual(wk.getMinutes(), 59, `expected xx:59, got ${wk}`);
});

test('claude scraped text with no reset prose reports 0, not a bogus timestamp', () => {
  const { parseClaudeWebText } = loadParsers();
  const r = parseClaudeWebText('Current session\n46% used\nWeekly\n15% used');
  assert.strictEqual(r.reset5hMs, 0);
  assert.strictEqual(r.resetWkMs, 0);
});

test('codex scraped text carries its reset prose through as epoch ms', () => {
  const { parseCodexText } = loadParsers();
  const before = Date.now();
  const r = parseCodexText(
    '5 hour usage limit\n40% remaining\nResets in 2 hr 10 min\n' +
    'Weekly usage limit\n75% remaining\nResets Sat 4:59 PM');
  assert.strictEqual(r.pct5h, 40);
  assert.strictEqual(r.pctWk, 75);
  const offset = 2 * 3_600_000 + 10 * 60_000;
  assert.ok(r.reset5hMs >= before + offset - 5000, `too early: ${r.reset5hMs}`);
  assert.ok(r.reset5hMs <= Date.now() + offset + 5000, `too late: ${r.reset5hMs}`);
  // "Sat 4:59 PM" resolves to the next Saturday at 16:59 local time. Asserting
  // the resolved day and time — not merely "in the future" — is what catches
  // resetWkMs being wired to the wrong label's prose.
  const wk = new Date(r.resetWkMs);
  assert.strictEqual(wk.getDay(), 6, `expected Saturday, got ${wk}`);
  assert.strictEqual(wk.getHours(), 16, `expected 16:xx, got ${wk}`);
  assert.strictEqual(wk.getMinutes(), 59, `expected xx:59, got ${wk}`);
});

test('codex scraped text with no reset prose reports 0', () => {
  const { parseCodexText } = loadParsers();
  const r = parseCodexText(
    '5 hour usage limit\n40% remaining\nWeekly usage limit\n75% remaining');
  assert.strictEqual(r.reset5hMs, 0);
  assert.strictEqual(r.resetWkMs, 0);
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

test('registering an account seeds every registry it needs', () => {
  const c = loadRegistration();
  c.registerAccount({ id: 'gemini', logKey: 'gemini', label: 'Gemini' });

  assert.strictEqual(c.hasData.gemini, false);
  assert.strictEqual(c.cachedData.gemini, null);
  assert.strictEqual(c.lastPct5h.gemini, null);
  assert.strictEqual(c.accountOverrides.gemini, '');
  assert.strictEqual(c.LOG_ACCOUNT.gemini, 'gemini');
  // The series were built inside the vm context, so their prototype is that
  // realm's Array.prototype; spreading re-homes them for deepStrictEqual.
  assert.deepStrictEqual([...c.trendHistory['gemini-5h']], []);
  assert.deepStrictEqual([...c.trendHistory['gemini-wk']], []);
  assert.deepStrictEqual(c.sessionStore.gemini.start, null);
});

// The session store is keyed by logKey, every other registry by id. Conflating
// them would detach 7,000 log entries.
test('the session store is keyed by logKey while the rest key by id', () => {
  const c = loadRegistration();
  c.registerAccount({ id: 'claude2', logKey: 'claude-vscode', label: 'Claude Code' });
  assert.ok('claude-vscode' in c.sessionStore, 'session store keys by logKey');
  assert.ok(!('claude2' in c.sessionStore), 'and never by id');
  assert.ok('claude2' in c.hasData, 'display registries key by id');
  // The bridge between the namespaces, and the negative half of the split. With
  // id === logKey (every other test here) these cannot be told apart.
  assert.strictEqual(c.LOG_ACCOUNT.claude2, 'claude-vscode', 'LOG_ACCOUNT maps id to logKey');
  assert.ok(!('claude-vscode' in c.hasData), 'display registries never key by logKey');
});

test('re-registering an account preserves the data it already has', () => {
  const c = loadRegistration();
  c.registerAccount({ id: 'codex', logKey: 'codex', label: 'Codex' });
  c.hasData.codex = true;
  c.trendHistory['codex-wk'].push(90);
  // The registries the brief's own two assertions leave unwatched. Each is
  // state a card rebuild would silently blank if registration reset it.
  c.cachedData.codex = { pctWk: 90 };
  c.lastPct5h.codex = 42;
  c.accountOverrides.codex = 'Work';
  c.trendHistory['codex-5h'].push(55);
  c.sessionStore.codex.start = '2026-10-07T08:00:00.000Z';
  c.sessionStore.codex.lastPct = 42;

  c.registerAccount({ id: 'codex', logKey: 'codex', label: 'Codex' });

  assert.strictEqual(c.hasData.codex, true, 'a rescan must not blank live state');
  assert.deepStrictEqual([...c.trendHistory['codex-wk']], [90]);
  assert.deepStrictEqual([...c.trendHistory['codex-5h']], [55]);
  assert.strictEqual(c.cachedData.codex.pctWk, 90);
  assert.strictEqual(c.lastPct5h.codex, 42);
  assert.strictEqual(c.accountOverrides.codex, 'Work');
  assert.strictEqual(c.sessionStore.codex.start, '2026-10-07T08:00:00.000Z');
  assert.strictEqual(c.sessionStore.codex.lastPct, 42);
});

test('the fixed providers are registered with their immutable log keys', () => {
  const c = loadRegistration();
  const byId = Object.fromEntries(c.PROVIDERS.map(p => [p.id, p.logKey]));
  assert.strictEqual(byId.codex, 'codex');
  assert.strictEqual(byId.claude, 'claude-desktop');

  // And they are already registered when the module finishes loading: init()
  // reads these registries before it could have populated them.
  assert.deepStrictEqual(Object.keys(c.hasData), ['codex', 'claude']);
  assert.strictEqual(c.LOG_ACCOUNT.codex, 'codex');
  assert.strictEqual(c.LOG_ACCOUNT.claude, 'claude-desktop');
  assert.deepStrictEqual(Object.keys(c.sessionStore), ['codex', 'claude-desktop']);
});

test('a legacy codex cache reads as a normalised reading', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({
    shared5h: null, sharedWeek: 100, reset7dMs: 123, credits: '0',
    email: 'a@example.com',
  });
  assert.strictEqual(r.pctWk, 100);
  assert.strictEqual(r.resetWkMs, 123);
  assert.strictEqual(r.label, 'a@example.com');
  // The cached credits line paints on the startup render; losing it here would
  // blank the line until the first live poll.
  assert.deepStrictEqual({ ...r.extra }, { credits: '0' });
});

test('a legacy codex cache keeps a 5h reading when it has one', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({ shared5h: 64, sharedWeek: 87 });
  assert.strictEqual(r.pct5h, 64);
  assert.strictEqual(r.pctWk, 87);
});

test('a legacy claude cache converts used to remaining', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({ sessionUsed: 36, weeklyUsed: 13 });
  assert.strictEqual(r.pct5h, 64);
  assert.strictEqual(r.pctWk, 87);
});

test('a legacy claude code cache reads through pct7d', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({ pct5h: 55, pct7d: 86, account: 'max 20x' });
  assert.strictEqual(r.pct5h, 55);
  assert.strictEqual(r.pctWk, 86);
  assert.strictEqual(r.label, 'max 20x');
});

// A cache cannot support the claim "this plan has no 5h window". Only a live
// poll can. Rendering n/a from a stale cache would assert something the data
// does not know.
test('a cached reading never claims a window is absent', () => {
  const { normaliseCachedReading } = loadParsers();
  assert.strictEqual(normaliseCachedReading({ shared5h: null, sharedWeek: 100 }).has5h, true);
  assert.strictEqual(normaliseCachedReading({ pct5h: 55 }).hasWk, true);
});

test('an empty or absent cache yields nothing to render', () => {
  const { normaliseCachedReading } = loadParsers();
  assert.strictEqual(normaliseCachedReading(null), null);
  assert.strictEqual(normaliseCachedReading({}), null);
});

test('a reading already in the new shape passes through unchanged', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({ pct5h: 10, pctWk: 20, has5h: false });
  assert.strictEqual(r.pct5h, 10);
  assert.strictEqual(r.pctWk, 20);
  assert.strictEqual(r.has5h, false, 'a cache written by the new code is trusted');
});

// The steady state: after the first poll every cached slot is in this shape, so
// a field dropped here is a field missing from every startup render.
test('a reading in the new shape survives the round trip field for field', () => {
  const { normaliseCachedReading } = loadParsers();
  const saved = {
    pct5h: 10, pctWk: 20, reset5hMs: 111, resetWkMs: 222,
    has5h: false, hasWk: true, label: 'a@example.com', extra: { credits: 5 },
  };
  const r = normaliseCachedReading({ ...saved });
  assert.deepStrictEqual({ ...r, extra: { ...r.extra } }, saved);
});
