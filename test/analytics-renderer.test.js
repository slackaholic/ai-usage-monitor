'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const metrics = require('../metrics.js');

class FakeElement {
  constructor() {
    this._innerHTML = '';
    this.byId = new Map();
    this.byClass = new Map();
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.byId.clear();
    this.byClass.clear();

    for (const match of this._innerHTML.matchAll(/id="([^"]+)"/g)) {
      this.byId.set(`#${match[1]}`, new FakeElement());
    }
    for (const match of this._innerHTML.matchAll(/class="([^"]+)"/g)) {
      for (const name of match[1].split(/\s+/).filter(Boolean)) {
        if (!this.byClass.has(`.${name}`)) this.byClass.set(`.${name}`, new FakeElement());
      }
    }
  }

  querySelector(selector) {
    return this.byId.get(selector) || this.byClass.get(selector) || null;
  }

  addEventListener() {}
}

function loadEfficiencyRenderer(documentStub) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'analytics-renderer.js'), 'utf8');
  const start = source.indexOf('function buildEffWindow');
  const end = source.indexOf('const TOKEN_LOADERS');
  assert.ok(start >= 0 && end > start, 'expected Efficiency renderer source markers');

  const context = {
    ...metrics,
    document: documentStub,
    Date,
    Math,
    Set,
    Array,
    String,
    Number,
    fmtDuration: (ms) => `${ms}ms`,
    fmtDate: (ts) => ts,
    console,
    monthEntries: [],
    displayYear: null,
    displayMonth: null,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

function loadStatsRenderer(documentStub) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'analytics-renderer.js'), 'utf8');
  const start = source.indexOf('function fmtDuration');
  const end = source.indexOf('function renderChart');
  assert.ok(start >= 0 && end > start, 'expected stats renderer source markers');

  const context = {
    ...metrics,
    document: documentStub,
    Date,
    Math,
    Set,
    Array,
    String,
    Number,
    isFinite,
    currentAccount: 'codex',
    PLAN_MULTIPLIERS: { codex: 1, 'claude-desktop': 1, 'claude-vscode': 20 },
    curSymbol: '$',
    usdRate: 0.76,
    windowHours: 24,
    rowLimit: 200,
    monthEntries: [],
    displayYear: null,
    displayMonth: null,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test('renderEfficiency populates the detached month heatmap before the atomic swap', () => {
  const documentStub = { querySelector: () => null };
  const { renderEfficiency } = loadEfficiencyRenderer(documentStub);
  const container = new FakeElement();
  const entries = [
    { ts: '2026-06-10T12:00:00Z', '5h': 100, wk: 100 },
    { ts: '2026-06-10T12:05:00Z', '5h': 90, wk: 99 },
    { ts: '2026-06-10T12:10:00Z', '5h': 100, wk: 100, reset5hTs: 1 },
  ];

  renderEfficiency(entries, container);

  const month = container.querySelector('#eff-month-5h');
  assert.ok(month, 'month heatmap container should exist');
  assert.match(month.innerHTML, /month-nav/);
  assert.match(month.innerHTML, /Jun 10/);
  assert.match(month.innerHTML, /10% burned/);
});

test('renderStats shows neutral weekly runway and plan-fit cards', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 90, wk: 72.1, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:10:00Z', '5h': 80, wk: 71.4, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:20:00Z', '5h': 70, wk: 70.7, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:30:00Z', '5h': 60, wk: 70, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
  ];

  renderStats(entries, container, { planMultipliers: { codex: 5 } });

  assert.match(container.innerHTML, /Weekly Runway/);
  assert.match(container.innerHTML, /Reset Gap/);
  assert.match(container.innerHTML, /Plan Fit/);
  assert.match(container.innerHTML, /At Reset/);
  assert.match(container.innerHTML, /5x/);
  assert.match(container.innerHTML, /~7x/);
  assert.doesNotMatch(container.innerHTML.toLowerCase(), /upgrade/);
});
