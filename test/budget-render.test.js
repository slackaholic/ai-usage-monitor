'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const metrics = require('../metrics.js');

// Slices the daily-budget block out of renderer.js and runs it against a
// minimal element store, with metrics.js's globals as the page has them.
function loadBudget({ info, target = 20, weeklyOnly = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('// ── BUDGET ──');
  const end = source.indexOf('// ── BUDGET END ──');
  assert.ok(start >= 0 && end > start, 'expected budget source markers');

  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: null, className: '', style: {} });
    return els.get(id);
  };
  const compact = [];
  const context = {
    ...metrics,
    document: { getElementById: (id) => el(id) },
    Date, Math, Number,
    budgetInfo: info === undefined ? {} : { 'lk-codex': info },
    budgetTargets: { day: target },
    LOG_ACCOUNT: { codex: 'lk-codex' },
    noFiveHourWindow: new Set(weeklyOnly ? ['codex'] : []),
    showCompactStat: (id, v) => compact.push([id, v]),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { ...context, el, compact };
}

const ms = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();   // Nov 2026; 3 Nov is a Tuesday
const INFO = { dayBurnPct: 1, weeklyRemainingPct: 74, weeklyResetTs: ms(10, 13), cycleStartTs: ms(3, 13) };
const GREEN = 'linear-gradient(90deg,#059669,#34d399)';
const RED = 'linear-gradient(90deg,#7f1d1d,#f87171)';

test('a weekly-only card shows what is left of today in weekly points', () => {
  const c = loadBudget({ info: INFO });
  c.renderBudget('codex', ms(4, 10));
  assert.strictEqual(c.el('codex-5h-label').textContent, 'Today Remaining');
  assert.strictEqual(c.el('c-codex-5h-label').textContent, 'Today');
  for (const id of ['codex-5h-pct', 'c-codex-5h']) {
    assert.strictEqual(c.el(id).textContent, '19.0%', id);
    assert.strictEqual(c.el(id).style.color, '#34d399', id);
  }
  assert.strictEqual(c.el('codex-5h-bar').style.width, '95%');
  assert.strictEqual(c.el('codex-5h-bar').style.background, GREEN);
  assert.strictEqual(c.el('codex-5h-reset').textContent, 'of 20% · resets at midnight');
  assert.deepStrictEqual(c.compact, [['codex-5h', true]]);
  assert.strictEqual(c.el('codex-budget-note').textContent,
    'week ≈ 3.7 days at 20% · on plan · resets Tue 13:00');
  assert.strictEqual(c.el('codex-budget-note').className, 'budget-note');
});

test("over today's target turns the tile amber", () => {
  const c = loadBudget({ info: { ...INFO, dayBurnPct: 24.5 } });
  c.renderBudget('codex', ms(4, 10));
  assert.strictEqual(c.el('codex-5h-pct').textContent, '-4.5%');
  assert.strictEqual(c.el('codex-5h-pct').style.color, '#f59e0b');
  assert.strictEqual(c.el('codex-5h-bar').style.width, '0%');
});

test('well over turns it red', () => {
  const c = loadBudget({ info: { ...INFO, dayBurnPct: 30 } });
  c.renderBudget('codex', ms(4, 10));
  assert.strictEqual(c.el('codex-5h-pct').textContent, '-10.0%');
  assert.strictEqual(c.el('codex-5h-pct').style.color, '#f87171');
  assert.strictEqual(c.el('codex-5h-bar').style.background, RED);
});

test('behind plan turns the week line red', () => {
  const c = loadBudget({ info: { ...INFO, weeklyRemainingPct: 50, dayBurnPct: 0 } });
  c.renderBudget('codex', ms(4, 22));
  assert.strictEqual(c.el('codex-budget-note').textContent,
    'week ≈ 2.5 days at 20% · behind plan by 0.5 days · resets Tue 13:00');
  assert.strictEqual(c.el('codex-budget-note').className, 'budget-note wayover');
});

test('a used-up week says so first, in red', () => {
  const c = loadBudget({ info: { ...INFO, weeklyRemainingPct: 0, dayBurnPct: 5 } });
  c.renderBudget('codex', ms(9, 23));
  assert.strictEqual(c.el('codex-budget-note').textContent, 'week used up · resets Tue 13:00');
  assert.strictEqual(c.el('codex-budget-note').className, 'budget-note wayover');
  assert.strictEqual(c.el('codex-5h-pct').textContent, '0.0%');
  assert.strictEqual(c.el('codex-5h-pct').style.color, '#f87171');
});

test('a card with a 5h window keeps its 5H tile', () => {
  const c = loadBudget({ info: INFO, weeklyOnly: false });
  c.el('codex-5h-pct').textContent = '55%';
  c.renderBudget('codex', ms(4, 10));
  assert.strictEqual(c.el('codex-5h-pct').textContent, '55%');
  assert.strictEqual(c.el('codex-5h-label').textContent, '5H Remaining');
  assert.strictEqual(c.el('c-codex-5h-label').textContent, '5H');
  assert.deepStrictEqual(c.compact, []);
  assert.strictEqual(c.el('codex-budget-note').textContent,
    'week ≈ 3.7 days at 20% · on plan · resets Tue 13:00');
});

test('no budget figures yet', () => {
  const c = loadBudget();
  assert.doesNotThrow(() => c.renderBudget('codex', ms(4, 10)));
  assert.strictEqual(c.el('codex-5h-pct').textContent, '—');
  assert.strictEqual(c.el('codex-5h-pct').style.color, '');
  assert.strictEqual(c.el('codex-5h-bar').style.width, '0%');
  assert.strictEqual(c.el('codex-5h-bar').style.background, 'var(--border)');
  assert.strictEqual(c.el('codex-budget-note').textContent, '');
});

test('target 25', () => {
  const c = loadBudget({ info: { ...INFO, dayBurnPct: 5 }, target: 25 });
  c.renderBudget('codex', ms(4, 10));
  assert.strictEqual(c.el('codex-5h-pct').textContent, '20.0%');
  assert.strictEqual(c.el('codex-5h-reset').textContent, 'of 25% · resets at midnight');
  assert.strictEqual(c.el('codex-5h-bar').style.width, '80%');
  assert.strictEqual(c.el('codex-budget-note').textContent,
    'week ≈ 3.0 days at 25% · on plan · resets Tue 13:00');
});

test('stale reset', () => {
  const c = loadBudget({ info: { ...INFO, weeklyRemainingPct: 0, dayBurnPct: 3 } });
  c.renderBudget('codex', ms(10, 14));
  assert.strictEqual(c.el('codex-5h-pct').textContent, '17.0%');
  assert.strictEqual(c.el('codex-5h-pct').style.color, '#34d399');
  assert.strictEqual(c.el('codex-budget-note').textContent, '');
});

test('fmtWeekReset', () => {
  const c = loadBudget();
  assert.strictEqual(c.fmtWeekReset(ms(10, 13)), 'Tue 13:00');
  assert.strictEqual(c.fmtWeekReset(null), '');
});
