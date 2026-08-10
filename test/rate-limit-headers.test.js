'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// main.js can't be require()d outside Electron, so lift the pure header parser
// out of it and run it in a bare context — same approach as the renderer tests.
function loadParser() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function parseUnifiedRateLimitHeaders');
  const end = source.indexOf("ipcMain.handle('fetch-claude-code-api-usage'");
  assert.ok(start >= 0 && end > start, 'expected rate-limit header parser source markers');

  const context = { Math, Number, parseFloat, parseInt, console };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.parseUnifiedRateLimitHeaders;
}

const NOW = Date.parse('2026-08-10T10:00:00Z');

// Exactly what api.anthropic.com returned for this Max 20x account on
// 2026-08-10: 5h headers present, no 7d pair at all.
const HEADERS_WITHOUT_7D = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': '1786367400',
  'anthropic-ratelimit-unified-5h-utilization': '0.4',
  'anthropic-ratelimit-unified-reset': '1786367400',
};

test('absent 7d headers read as unknown, not as 200% remaining', () => {
  const parse = loadParser();

  const r = parse(HEADERS_WITHOUT_7D, NOW);

  assert.strictEqual(r.pct7d, null, 'weekly percentage must be null, not 200');
  assert.strictEqual(r.reset7d, null, 'no weekly reset text when there is no weekly window');
  assert.strictEqual(r.reset7dMs, 0);
  assert.strictEqual(r.status7d, 'unknown');
  // ...and the 5h window still reports normally.
  assert.strictEqual(r.pct5h, 60);
  assert.strictEqual(r.reset5hMs, 1786367400000);
});

test('both windows present report both percentages and resets', () => {
  const parse = loadParser();

  const r = parse({
    'anthropic-ratelimit-unified-5h-utilization': '0.4',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(NOW / 1000) + 2 * 3600),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.25',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(NOW / 1000) + 48 * 3600),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
  }, NOW);

  assert.strictEqual(r.pct5h, 60);
  assert.strictEqual(r.pct7d, 75);
  assert.strictEqual(r.reset5h, '2 hr 0 min');
  assert.strictEqual(r.reset7d, '48 hr 0 min');
  assert.strictEqual(r.status7d, 'allowed');
});

test('over-quota stays negative — that is a real reading, not a sentinel', () => {
  const parse = loadParser();

  const r = parse({
    'anthropic-ratelimit-unified-5h-utilization': '1.2',
    'anthropic-ratelimit-unified-7d-utilization': '1.05',
  }, NOW);

  assert.strictEqual(r.pct5h, -20);
  assert.strictEqual(r.pct7d, -5);
});

test('an unparseable utilization reads as unknown rather than NaN', () => {
  const parse = loadParser();

  const r = parse({
    'anthropic-ratelimit-unified-5h-utilization': '0.4',
    'anthropic-ratelimit-unified-7d-utilization': '',
  }, NOW);

  assert.strictEqual(r.pct5h, 60);
  assert.strictEqual(r.pct7d, null);
});

test('no 5h window at all means no usable headers', () => {
  const parse = loadParser();

  assert.strictEqual(parse({}, NOW), null);
  assert.strictEqual(parse({ 'anthropic-ratelimit-unified-7d-utilization': '0.5' }, NOW), null);
});

test('a reset already in the past reads as soon', () => {
  const parse = loadParser();

  const r = parse({
    'anthropic-ratelimit-unified-5h-utilization': '0.1',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(NOW / 1000) - 60),
  }, NOW);

  assert.strictEqual(r.reset5h, 'soon');
});

test('a missing 5h reset yields no reset text instead of a phantom "soon"', () => {
  const parse = loadParser();

  const r = parse({ 'anthropic-ratelimit-unified-5h-utilization': '0.1' }, NOW);

  assert.strictEqual(r.reset5h, null);
  assert.strictEqual(r.reset5hMs, 0);
});
