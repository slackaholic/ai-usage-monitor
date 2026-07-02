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

function loadStatsRenderer(documentStub, account = 'codex') {
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
    currentAccount: account,
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

test('renderPeakBars is self-describing: legend, threshold grid, time axis', () => {
  const { renderPeakBars } = loadEfficiencyRenderer({ querySelector: () => null });
  const el = new FakeElement();
  renderPeakBars(el, [
    { peakPct: 95, ts: '2026-06-29T08:00:00Z' },
    { peakPct: 40, ts: '2026-06-29T13:00:00Z' },
  ]);

  assert.match(el.innerHTML, /peak-legend/);      // color legend present
  assert.match(el.innerHTML, /ran out/);          // ≥90% meaning spelled out
  assert.match(el.innerHTML, /peak-chart/);       // 0–100% frame
  assert.equal((el.innerHTML.match(/peak-grid/g) || []).length, 2); // 70% + 90% lines
  assert.match(el.innerHTML, /oldest/);
  assert.match(el.innerHTML, /newest/);
  assert.equal((el.innerHTML.match(/class="peak-bar"/g) || []).length, 2);
});

test('renderPeakBars labels bars with date ranges when few cycles carry endTs', () => {
  const { renderPeakBars } = loadEfficiencyRenderer({ querySelector: () => null });
  const el = new FakeElement();
  renderPeakBars(el, [
    { peakPct: 57, ts: '2026-06-24T08:00:00Z', endTs: '2026-06-30T10:59:00Z' },
    { peakPct: 21, ts: '2026-06-30T11:01:00Z', endTs: '2026-07-02T13:11:00Z' },
  ]);

  assert.match(el.innerHTML, /peak-dates/);          // per-bar date labels
  assert.doesNotMatch(el.innerHTML, />oldest</);      // not the generic axis
  assert.equal((el.innerHTML.match(/class="peak-bar"/g) || []).length, 2);
});

test('renderHourHeatmap renders all 24 hours, an axis, a legend, and marks empty hours', () => {
  const { renderHourHeatmap } = loadEfficiencyRenderer({ querySelector: () => null });
  const el = new FakeElement();
  const hours = new Array(24).fill(0);
  hours[9] = 30;
  hours[10] = 50;
  renderHourHeatmap(el, hours);

  assert.equal((el.innerHTML.match(/class="heat-cell/g) || []).length, 24); // full day
  assert.match(el.innerHTML, /hour-axis/);
  assert.match(el.innerHTML, /heat-legend/);
  assert.match(el.innerHTML, /class="heat-cell empty"/); // zero hours outlined
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
  assert.match(container.innerHTML, /based on early pace/);
  assert.match(container.innerHTML, /if early pace holds/);
  assert.match(container.innerHTML, /early pace/);
  assert.match(container.innerHTML, /30m sample/);
  assert.match(container.innerHTML, /5x/);
  assert.match(container.innerHTML, /~7x/);
  assert.doesNotMatch(container.innerHTML.toLowerCase(), /required/);
  assert.doesNotMatch(container.innerHTML.toLowerCase(), /upgrade/);
});

test('planMultiplierFor: configured value wins; fallback is 5 for codex, 1 otherwise', () => {
  const { planMultiplierFor } = loadStatsRenderer({ querySelector: () => null });

  // Configured value wins for every account.
  assert.equal(planMultiplierFor({ planMultipliers: { 'claude-desktop': 5 } }, 'claude-desktop'), 5);
  assert.equal(planMultiplierFor({ planMultipliers: { 'claude-vscode': 3 } }, 'claude-vscode'), 3);
  assert.equal(planMultiplierFor({ planMultipliers: { codex: 8 } }, 'codex'), 8);

  // Fallbacks when unset: codex 5, everything else 1 (claude-vscode no longer 20).
  assert.equal(planMultiplierFor({}, 'codex'), 5);
  assert.equal(planMultiplierFor({}, 'claude-desktop'), 1);
  assert.equal(planMultiplierFor({}, 'claude-vscode'), 1);
  assert.equal(planMultiplierFor(undefined, 'claude-desktop'), 1);
});

test('renderStats Plan Fit reflects the configured multiplier for Claude Desktop', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null }, 'claude-desktop');
  const container = new FakeElement();
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 90, wk: 72.1, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:10:00Z', '5h': 80, wk: 71.4, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:20:00Z', '5h': 70, wk: 70.7, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:30:00Z', '5h': 60, wk: 70, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
  ];

  renderStats(entries, container, { planMultipliers: { 'claude-desktop': 5 } });

  assert.match(container.innerHTML, /Plan Fit/);
  // "current -> ~required": current is the configured 5x.
  assert.match(container.innerHTML, /5x -&gt;|5x ->/);
});

test('renderStats Plan Fit falls back to 1x for an unset Claude Code (not 20x)', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null }, 'claude-vscode');
  const container = new FakeElement();
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 90, wk: 72.1, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:10:00Z', '5h': 80, wk: 71.4, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:20:00Z', '5h': 70, wk: 70.7, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:30:00Z', '5h': 60, wk: 70, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
  ];

  renderStats(entries, container, {}); // no planMultipliers configured

  assert.match(container.innerHTML, /Plan Fit/);
  assert.match(container.innerHTML, /1x -&gt;|1x ->/);
  assert.doesNotMatch(container.innerHTML, /20x -&gt;|20x ->/);
});
