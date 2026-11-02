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

// Minimal stand-ins for the `#account-tabs` host and the `<button>` elements
// buildAccountTabs() creates via document.createElement — just enough to
// observe replaceChildren()/appendChild() and the properties set on each
// button (className, dataset.account, textContent).
class FakeTabHost {
  constructor() { this.children = []; }
  replaceChildren() { this.children = []; }
  appendChild(el) { this.children.push(el); }
}

class FakeButton {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.dataset = {};
    this.textContent = '';
    this._listeners = [];
  }
  addEventListener(type, cb) { this._listeners.push([type, cb]); }
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

// Slices out only buildAccountTabs() — the registry → tab-list builder added
// in Task 10. `overrides` lets each test supply its own `window.electronAPI`
// stub, starting VALID_ACCOUNTS/ACCOUNT_LABELS/PLAN_MULTIPLIERS, and
// currentAccount.
function loadTabBuilderRenderer(documentStub, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'analytics-renderer.js'), 'utf8');
  const start = source.indexOf('async function buildAccountTabs');
  const end = source.indexOf('// ── Wire up controls');
  assert.ok(start >= 0 && end > start, 'expected tab-builder source markers');

  const context = {
    document: documentStub,
    console,
    window: { electronAPI: {} },
    VALID_ACCOUNTS: ['codex', 'claude-desktop'],
    ACCOUNT_LABELS: { codex: 'Codex', 'claude-desktop': 'Claude Desktop' },
    PLAN_MULTIPLIERS: { codex: 1, 'claude-desktop': 1 },
    CLAUDE_CODE_MULTIPLIER: 20,
    currentAccount: 'codex',
    switchTab: () => {},
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

// Slices from esc() through renderCostCompare() (the account-value table that
// interpolates ACCOUNT_LABELS into innerHTML). Callers exercise
// renderCostCompare directly; the intervening functions (renderStats,
// renderEfficiency, etc.) are pulled in only because they sit between the two
// markers in file order — they are never invoked by these tests.
function loadCostCompareRenderer(documentStub, overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'analytics-renderer.js'), 'utf8');
  const start = source.indexOf('function esc(s)');
  const end = source.indexOf('// ── Main render');
  assert.ok(start >= 0 && end > start, 'expected cost-compare renderer source markers');

  const context = {
    ...metrics,
    document: documentStub,
    Date, Math, Set, Array, String, Number, isFinite,
    console,
    window: { electronAPI: {} },
    VALID_ACCOUNTS: ['codex', 'claude-desktop'],
    ACCOUNT_LABELS: { codex: 'Codex', 'claude-desktop': 'Claude Desktop' },
    curSymbol: '$',
    usdRate: 0.79,
    windowHours: 24,
    currentAccount: 'codex',
    monthEntries: [],
    displayYear: null,
    displayMonth: null,
    ...overrides,
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
  assert.match(el.innerHTML, /class="heat-cell zero"/); // zero-burn hours (class must NOT be `empty` — collides with global .empty padding)
  assert.doesNotMatch(el.innerHTML, /class="heat-cell empty"/);
  // per-hour number is a SHARE of total burn (30+50=80): 9→38%, 10→63%; never >100%
  assert.match(el.innerHTML, /38% of your burn/);
  assert.match(el.innerHTML, /63% of your burn/);
  assert.doesNotMatch(el.innerHTML, /quota burned/); // old misleading label gone
});

test('renderEfficiency shows one time-of-day heatmap, not one per window', () => {
  const documentStub = { querySelector: () => null };
  const { renderEfficiency } = loadEfficiencyRenderer(documentStub);
  const container = new FakeElement();
  const entries = [
    { ts: '2026-06-10T12:00:00Z', '5h': 100, wk: 100 },
    { ts: '2026-06-10T12:05:00Z', '5h': 90, wk: 99 },
    { ts: '2026-06-10T12:10:00Z', '5h': 100, wk: 100, reset5hTs: 1 },
  ];

  renderEfficiency(entries, container);

  assert.ok(container.querySelector('#eff-hourofday'), 'single time-of-day container exists');
  assert.equal(container.querySelector('#eff-heat-5h'), null, 'no per-5h heatmap');
  assert.equal(container.querySelector('#eff-heat-wk'), null, 'no per-weekly heatmap');
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

test('renderStats At Reset floors negative headroom and Plan Fit shows "won\'t fit" for a runaway pace', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null }); // codex, multiplier 5 below
  const container = new FakeElement();
  // Weekly quota at 19%, burning ~4.2%/hr, reset ~113h out → linear projection
  // implies ~475% consumed: headroom −456% and required ~125x. Both must be clamped.
  const reset = Date.parse('2026-07-04T01:30:00Z');
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 30, wk: 21.1, reset7dTs: reset },
    { ts: '2026-06-29T08:10:00Z', '5h': 25, wk: 20.4, reset7dTs: reset },
    { ts: '2026-06-29T08:20:00Z', '5h': 20, wk: 19.7, reset7dTs: reset },
    { ts: '2026-06-29T08:30:00Z', '5h': 15, wk: 19.0, reset7dTs: reset },
  ];

  renderStats(entries, container, { planMultipliers: { codex: 5 } });

  // At Reset: floored, never a giant negative percent.
  assert.match(container.innerHTML, /runs out before reset/);
  assert.match(container.innerHTML, /<div class="value">0%<\/div>/);
  assert.doesNotMatch(container.innerHTML, /-\d{2,}%/); // no −456% etc.
  // Plan Fit: reframed, no runaway multiplier.
  assert.match(container.innerHTML, /won't fit/);
  assert.match(container.innerHTML, /pace far exceeds any plan/);
  assert.doesNotMatch(container.innerHTML, /12\dx/); // no ~124x/125x/126x
});

test('renderStats At Reset stays positive and Plan Fit says it fits for a gentle pace', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  // 70% left, burning ~0.6%/hr, reset 10h out → ~6% consumed: headroom +64%, required ~0.4x.
  const reset = Date.parse('2026-06-29T18:30:00Z');
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 90, wk: 70.3, reset7dTs: reset },
    { ts: '2026-06-29T08:10:00Z', '5h': 89, wk: 70.2, reset7dTs: reset },
    { ts: '2026-06-29T08:20:00Z', '5h': 88, wk: 70.1, reset7dTs: reset },
    { ts: '2026-06-29T08:30:00Z', '5h': 87, wk: 70.0, reset7dTs: reset },
  ];

  renderStats(entries, container, { planMultipliers: { codex: 5 } });

  assert.match(container.innerHTML, /current pace fits your plan/);
  assert.doesNotMatch(container.innerHTML, /won't fit/);
  assert.doesNotMatch(container.innerHTML, /runs out before reset/);
  // At Reset shows a real positive percent, not 0% and not negative.
  assert.doesNotMatch(container.innerHTML, /-\d+%/);
});

test('renderStats Plan Fit shows an upgrade target when required is above plan but under the ceiling', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  // 70% left, ~4.2%/hr, reset next day (~23.5h) → ~99% consumed: required ~7x (≤ 15x ceiling).
  const reset = Date.parse('2026-06-30T08:00:00Z');
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 90, wk: 72.1, reset7dTs: reset },
    { ts: '2026-06-29T08:10:00Z', '5h': 80, wk: 71.4, reset7dTs: reset },
    { ts: '2026-06-29T08:20:00Z', '5h': 70, wk: 70.7, reset7dTs: reset },
    { ts: '2026-06-29T08:30:00Z', '5h': 60, wk: 70.0, reset7dTs: reset },
  ];

  renderStats(entries, container, { planMultipliers: { codex: 5 } });

  assert.match(container.innerHTML, /5x -&gt; ~7x|5x -> ~7x/);
  assert.match(container.innerHTML, /if early pace holds/);
  assert.doesNotMatch(container.innerHTML, /won't fit/);
  assert.doesNotMatch(container.innerHTML, /fits your plan/);
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

// ── Daily budget cards (2 Nov 2026) ──
// The budget figures are get-budget-info's, so these cards agree with the
// main window; the four runway cards take their colour from the same plan rule.
const nov = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();   // 3 Nov 2026 is a Tuesday
const B = { dayBurnPct: 1, weeklyRemainingPct: 74, weeklyResetTs: nov(10, 13), cycleStartTs: nov(3, 13) };
const NOW = nov(4, 10);
const WEEKLY_ONLY = [
  { ts: '2026-07-20T08:00:00Z', '5h': null, wk: 72.1, reset7dTs: Date.parse('2026-07-21T08:00:00Z') },
  { ts: '2026-07-20T08:30:00Z', '5h': null, wk: 70,   reset7dTs: Date.parse('2026-07-21T08:00:00Z') },
];
const RUNWAY_CARDS = ['Weekly Runway', 'Reset Gap', 'Plan Fit', 'At Reset'];

function renderBudgetStats(budget, { settings = {}, entries = WEEKLY_ONLY, now = NOW } = {}) {
  const ctx = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  ctx.renderStats(entries, container, settings, budget, now);
  return { html: container.innerHTML, fmtRunwayDate: ctx.fmtRunwayDate };
}

function card(html, label) {
  const m = html.match(new RegExp(`stat-card ([a-z]*)">\\s*<div class="label">${label}</div>`
    + `\\s*<div class="value">([^<]*)</div>\\s*<div class="sub">([^<]*)</div>`));
  assert.ok(m, `expected a ${label} card`);
  return { cls: m[1], value: m[2], sub: m[3] };
}

test("renderStats Today's Budget shows the tile's figure for a weekly-only account", () => {
  const { html } = renderBudgetStats(B);
  assert.deepStrictEqual(card(html, "Today's Budget"),
    { cls: 'green', value: '19.0%', sub: 'of 20% · resets at midnight' });
  assert.doesNotMatch(html, /need more history/);
});

test("renderStats Week Budget matches the card's week line", () => {
  const { html, fmtRunwayDate } = renderBudgetStats(B);
  assert.deepStrictEqual(card(html, 'Week Budget'),
    { cls: '', value: '≈ 3.7 days at 20%', sub: 'on plan · resets ' + fmtRunwayDate(B.weeklyResetTs) });
  assert.doesNotMatch(html, /Window Budget/);
});

test('renderStats behind plan turns Week Budget and the four runway cards red', () => {
  const { html } = renderBudgetStats({ ...B, weeklyRemainingPct: 50, dayBurnPct: 0 }, { now: nov(4, 22) });
  const week = card(html, 'Week Budget');
  assert.strictEqual(week.cls, 'red');
  assert.ok(week.sub.startsWith('behind plan by 0.5 days'), week.sub);
  for (const label of RUNWAY_CARDS) assert.strictEqual(card(html, label).cls, 'red', label);
});

test('renderStats an on-plan week keeps the runway cards green even when the pace runs out early', () => {
  // The runaway pace of the "won't fit" test above: the projection runs out
  // long before the reset, yet the week is on plan, so nothing turns red.
  const reset = Date.parse('2026-07-04T01:30:00Z');
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 30, wk: 21.1, reset7dTs: reset },
    { ts: '2026-06-29T08:10:00Z', '5h': 25, wk: 20.4, reset7dTs: reset },
    { ts: '2026-06-29T08:20:00Z', '5h': 20, wk: 19.7, reset7dTs: reset },
    { ts: '2026-06-29T08:30:00Z', '5h': 15, wk: 19.0, reset7dTs: reset },
  ];
  const { html } = renderBudgetStats(B, { entries, settings: { planMultipliers: { codex: 5 } } });
  assert.match(html, /runs out before reset/);
  for (const label of RUNWAY_CARDS) assert.strictEqual(card(html, label).cls, 'green', label);
});

test('renderStats a used-up week reads used up and turns the runway cards red', () => {
  const { html } = renderBudgetStats({ ...B, weeklyRemainingPct: 0 }, { now: nov(9, 23) });
  assert.strictEqual(card(html, 'Week Budget').value, 'used up');
  for (const label of RUNWAY_CARDS) assert.strictEqual(card(html, label).cls, 'red', label);
});

test('renderStats with no budget figures leaves the budget and runway cards dim', () => {
  const { html } = renderBudgetStats({});
  assert.deepStrictEqual(card(html, "Today's Budget"),
    { cls: 'dim', value: '—', sub: 'waiting for budget data' });
  assert.deepStrictEqual(card(html, 'Week Budget'),
    { cls: 'dim', value: '—', sub: 'waiting for a weekly reading' });
  for (const label of RUNWAY_CARDS) assert.strictEqual(card(html, label).cls, 'dim', label);
});

test('renderStats target 25', () => {
  const { html } = renderBudgetStats({ ...B, dayBurnPct: 5 }, { settings: { budgetTargets: { day: 25 } } });
  const today = card(html, "Today's Budget");
  assert.strictEqual(today.value, '20.0%');
  assert.strictEqual(today.sub, 'of 25% · resets at midnight');
  assert.strictEqual(card(html, 'Week Budget').value, '≈ 3.0 days at 25%');
});

// ── buildAccountTabs ─────────────────────────────────────────────────────

test('buildAccountTabs adds one tab per registry account, with its label, active class, and multiplier', async () => {
  const host = new FakeTabHost();
  const documentStub = {
    getElementById: (id) => (id === 'account-tabs' ? host : null),
    createElement: (tag) => new FakeButton(tag),
  };
  const context = loadTabBuilderRenderer(documentStub, {
    window: {
      electronAPI: {
        getClaudeAccounts: async () => [
          { id: 'cc-work', kind: 'claude-code', configDir: '/x', configDirs: ['/x'], logKey: 'claude-code:work', label: 'work@example.com' },
        ],
      },
    },
    currentAccount: 'claude-code:work',
  });

  await context.buildAccountTabs();

  assert.equal(JSON.stringify(context.VALID_ACCOUNTS), JSON.stringify(['codex', 'claude-desktop', 'claude-code:work']));
  // A lone Claude Code account is already unambiguous against Codex and Claude
  // Desktop, so its tab carries the product name only — no email eating width.
  assert.equal(context.ACCOUNT_LABELS['claude-code:work'], 'Claude Code');
  assert.equal(context.PLAN_MULTIPLIERS['claude-code:work'], 20);

  assert.equal(host.children.length, 3);
  const workBtn = host.children.find(b => b.dataset.account === 'claude-code:work');
  assert.ok(workBtn, 'a tab exists for the registry account');
  assert.equal(workBtn.textContent, 'Claude Code');
  assert.equal(workBtn.className, 'tab active'); // matches currentAccount
  // Exactly one tab carries the active class.
  assert.equal(host.children.filter(b => b.className.includes('active')).length, 1);
});

test('buildAccountTabs appends the account only when two tabs would read alike', async () => {
  const host = new FakeTabHost();
  const documentStub = {
    getElementById: (id) => (id === 'account-tabs' ? host : null),
    createElement: (tag) => new FakeButton(tag),
  };
  const context = loadTabBuilderRenderer(documentStub, {
    window: {
      electronAPI: {
        getClaudeAccounts: async () => [
          { id: 'claude2', kind: 'claude-code', configDir: '/home/.claude', configDirs: ['/home/.claude'],
            logKey: 'claude-vscode', label: 'me@example.com', detail: 'me@example.com' },
          // No email resolved yet — detail falls back to the config dir's name.
          { id: 'cc-work', kind: 'claude-code', configDir: '/home/.claude-work', configDirs: ['/home/.claude-work'],
            logKey: 'claude-code:.claude-work', label: null, detail: '.claude-work' },
        ],
      },
    },
    currentAccount: 'codex',
  });

  await context.buildAccountTabs();

  // Codex and Claude Desktop are still bare — only the colliding pair grows.
  assert.equal(context.ACCOUNT_LABELS['codex'], 'Codex');
  assert.equal(context.ACCOUNT_LABELS['claude-desktop'], 'Claude Desktop');
  assert.equal(context.ACCOUNT_LABELS['claude-vscode'], 'Claude Code — me@example.com');
  assert.equal(context.ACCOUNT_LABELS['claude-code:.claude-work'], 'Claude Code — .claude-work');

  // Every tab reads differently, which is the whole point.
  const texts = host.children.map(b => b.textContent);
  assert.equal(new Set(texts).size, texts.length, 'no two tabs share a label');
});

test('buildAccountTabs falls back to the two fixed tabs when getClaudeAccounts rejects', async () => {
  const host = new FakeTabHost();
  const documentStub = {
    getElementById: (id) => (id === 'account-tabs' ? host : null),
    createElement: (tag) => new FakeButton(tag),
  };
  const context = loadTabBuilderRenderer(documentStub, {
    window: {
      electronAPI: {
        getClaudeAccounts: async () => { throw new Error('ipc down'); },
      },
    },
    // Points at an account that only existed via a prior registry scan —
    // buildAccountTabs must revalidate it against the degraded list.
    currentAccount: 'claude-code:vanished',
  });

  await assert.doesNotReject(() => context.buildAccountTabs());

  assert.equal(JSON.stringify(context.VALID_ACCOUNTS), JSON.stringify(['codex', 'claude-desktop']));
  assert.equal(host.children.length, 2);
  assert.equal(context.currentAccount, 'codex'); // reset — old value no longer valid
  assert.equal(host.children.filter(b => b.className.includes('active')).length, 1);
  assert.equal(host.children.find(b => b.dataset.account === 'codex').className, 'tab active');
});

test('buildAccountTabs does not duplicate entries across repeated invocations', async () => {
  const host = new FakeTabHost();
  const documentStub = {
    getElementById: (id) => (id === 'account-tabs' ? host : null),
    createElement: (tag) => new FakeButton(tag),
  };
  const accts = [{ id: 'cc-work', logKey: 'claude-code:work', label: 'work@example.com' }];
  const context = loadTabBuilderRenderer(documentStub, {
    window: { electronAPI: { getClaudeAccounts: async () => accts } },
    currentAccount: 'codex',
  });

  await context.buildAccountTabs();
  await context.buildAccountTabs();

  assert.equal(JSON.stringify(context.VALID_ACCOUNTS), JSON.stringify(['codex', 'claude-desktop', 'claude-code:work']));
  assert.equal(Object.keys(context.ACCOUNT_LABELS).length, 3);
  assert.equal(Object.keys(context.PLAN_MULTIPLIERS).length, 3);
  assert.equal(host.children.length, 3); // replaceChildren() clears the host before rebuilding
});

test('buildAccountTabs drops PLAN_MULTIPLIERS for an account that disappears from the registry', async () => {
  // PLAN_MULTIPLIERS is a `const` mutated in place, unlike VALID_ACCOUNTS /
  // ACCOUNT_LABELS which are reassigned to a fresh base each call — this
  // guards against exactly that asymmetry regressing.
  const host = new FakeTabHost();
  const documentStub = {
    getElementById: (id) => (id === 'account-tabs' ? host : null),
    createElement: (tag) => new FakeButton(tag),
  };
  let accts = [{ id: 'cc-work', logKey: 'claude-code:work', label: 'work@example.com' }];
  const context = loadTabBuilderRenderer(documentStub, {
    window: { electronAPI: { getClaudeAccounts: async () => accts } },
    currentAccount: 'codex',
  });

  await context.buildAccountTabs();
  assert.equal(context.PLAN_MULTIPLIERS['claude-code:work'], 20);

  accts = []; // account removed from the registry on the next scan
  await context.buildAccountTabs();

  assert.equal(context.PLAN_MULTIPLIERS['claude-code:work'], undefined);
  assert.equal(JSON.stringify(Object.keys(context.PLAN_MULTIPLIERS).sort()), JSON.stringify(['claude-desktop', 'codex']));
});

// ── renderCostCompare / ACCOUNT_LABELS innerHTML sink ─────────────────────

test('renderCostCompare escapes a hostile account label before writing innerHTML', async () => {
  const el = new FakeElement();
  const hostileLabel = '<img src=x onerror=alert(1)>evil@example.com';
  const context = loadCostCompareRenderer({ querySelector: () => null }, {
    VALID_ACCOUNTS: ['codex', 'claude-code:x'],
    ACCOUNT_LABELS: { codex: 'Codex', 'claude-code:x': hostileLabel },
    window: {
      electronAPI: {
        getSettings: async () => ({}),
        readUsageLog: async () => [],
      },
    },
  });

  await context.renderCostCompare(el);

  assert.doesNotMatch(el.innerHTML, /<img/);
  assert.match(el.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;evil@example\.com/);
});

test('renderCostCompare shows a normal account label unescaped-looking (no stray entities)', async () => {
  const el = new FakeElement();
  const context = loadCostCompareRenderer({ querySelector: () => null }, {
    VALID_ACCOUNTS: ['codex', 'claude-desktop'],
    ACCOUNT_LABELS: { codex: 'Codex', 'claude-desktop': 'Claude Desktop' },
    window: {
      electronAPI: {
        getSettings: async () => ({}),
        readUsageLog: async () => [],
      },
    },
  });

  await context.renderCostCompare(el);

  assert.match(el.innerHTML, /<td>Codex<\/td>/);
  assert.match(el.innerHTML, /<td>Claude Desktop<\/td>/);
});
