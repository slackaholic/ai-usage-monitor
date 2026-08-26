'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Slices the stat-rendering utilities out of renderer.js and runs them against
// a minimal element store. Only `document.getElementById` and the compact-stat
// hook are needed; nothing in the slice reaches further into the DOM.
function loadStatRenderers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('function pctColor');
  const end = source.indexOf('function renderBudget');
  assert.ok(start >= 0 && end > start, 'expected stat-rendering source markers');

  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: null, style: {} });
    return els.get(id);
  };
  const context = {
    document: { getElementById: (id) => el(id) },
    showCompactStat: () => {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { ...context, el, els };
}

test('a present percentage renders as a percentage in both views', () => {
  const { renderStat, el } = loadStatRenderers();

  renderStat('codex', 'wk', 87);

  assert.strictEqual(el('codex-wk-pct').textContent, '87%');
  assert.strictEqual(el('c-codex-wk').textContent, '87%');
  assert.strictEqual(el('codex-wk-bar').style.width, '87%');
});

test('a momentarily missing meter still reads as an em-dash', () => {
  const { renderStat, el } = loadStatRenderers();

  renderStat('claude', '5h', null);

  assert.strictEqual(el('claude-5h-pct').textContent, '\u2014');
  assert.strictEqual(el('c-claude-5h').textContent, '\u2014');
});

// The distinction the whole change exists to make: Codex has no 5-hour window,
// so its 5h tile is not waiting for a number that never comes.
test('a meter the plan does not have reads n/a, not an em-dash', () => {
  const { renderStat, el } = loadStatRenderers();

  renderStat('codex', '5h', null, 'n/a');

  assert.strictEqual(el('codex-5h-pct').textContent, 'n/a');
  assert.strictEqual(el('c-codex-5h').textContent, 'n/a', 'the compact tile must agree with the full card');
});

test('a placeholder never displaces a real reading', () => {
  const { renderStat, el } = loadStatRenderers();

  renderStat('codex', '5h', 42, 'n/a');

  assert.strictEqual(el('codex-5h-pct').textContent, '42%');
  assert.strictEqual(el('c-codex-5h').textContent, '42%');
});

test('an omitted placeholder keeps the em-dash default', () => {
  const { setPct, el } = loadStatRenderers();

  setPct('x', null);
  assert.strictEqual(el('x').textContent, '\u2014');
});
