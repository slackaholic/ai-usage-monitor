# Weekly Runway and Plan Fit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add neutral weekly runway and plan-fit analytics so the user can infer whether their editable Codex plan multiplier can carry current weekly usage through reset.

**Architecture:** Keep forecast math in pure `metrics.js`, with no `Date.now()` and no DOM dependencies. `analytics-renderer.js` reads the persisted plan multiplier setting, renders four neutral top stat cards, and reuses existing settings-change refresh. `settings.html` and `settings-renderer.js` add a Codex capacity multiplier input that saves into `settings.planMultipliers`.

**Tech Stack:** Electron renderer scripts, plain browser DOM, Node CommonJS tests via `node --test`, existing `settings.json` persistence through `window.electronAPI.saveSettings`.

---

## File Structure

- Modify `metrics.js`: add and export pure `weeklyRunway(snapshots, currentPlanMultiplier)`.
- Modify `test/metrics.test.js`: add TDD tests for projection, gap, required multiplier, confidence, and no-data behavior.
- Modify `analytics-renderer.js`: render `Weekly Runway`, `Reset Gap`, `Plan Fit`, and `At Reset` cards in the existing stat grid.
- Modify `test/analytics-renderer.test.js`: add a renderer test for the neutral runway cards.
- Modify `settings.html`: add a Codex plan capacity multiplier input.
- Modify `settings-renderer.js`: load and save `settings.planMultipliers.codex`.

---

### Task 1: Pure Weekly Runway Metric

**Files:**
- Modify: `metrics.js`
- Modify: `test/metrics.test.js`

- [ ] **Step 1: Add failing metric tests**

In `test/metrics.test.js`, update the first import:

```js
const { segmentCycles, countDepletionEvents, weeklyRunway } = require('../metrics.js');
```

Add these tests after `countDepletionEvents counts transitions into depletion, not every depleted poll`:

```js
test('weeklyRunway projects weekly depletion before reset and required plan multiplier', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:10:00Z', wk: 79, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:20:00Z', wk: 78, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
    { ts: '2026-06-29T08:30:00Z', wk: 77, reset7dTs: Date.parse('2026-06-30T08:30:00Z') },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'good');
  assert.equal(r.currentPlanMultiplier, 5);
  assert.equal(r.weeklyRemainingPct, 77);
  assert.equal(r.weeklyResetTs, Date.parse('2026-06-30T08:30:00Z'));
  assert.equal(r.weeklyBurnRatePctPerHour, 6);
  assert.equal(r.projectedDepleteTs, Date.parse('2026-06-29T21:20:00Z'));
  assert.equal(r.gapMs, 11 * 3_600_000 + 10 * 60_000);
  assert.equal(r.projectedHeadroomAtResetPct, -67);
  assert.ok(Math.abs(r.requiredPlanMultiplier - 9.35064935064935) < 1e-9);
});

test('weeklyRunway reports buffer and lower required multiplier when pace lasts to reset', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 93, reset7dTs: Date.parse('2026-06-29T20:30:00Z') },
    { ts: '2026-06-29T08:10:00Z', wk: 92, reset7dTs: Date.parse('2026-06-29T20:30:00Z') },
    { ts: '2026-06-29T08:20:00Z', wk: 91, reset7dTs: Date.parse('2026-06-29T20:30:00Z') },
    { ts: '2026-06-29T08:30:00Z', wk: 90, reset7dTs: Date.parse('2026-06-29T20:30:00Z') },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'good');
  assert.equal(r.weeklyBurnRatePctPerHour, 6);
  assert.equal(r.projectedDepleteTs, Date.parse('2026-06-29T23:30:00Z'));
  assert.equal(r.gapMs, -3 * 3_600_000);
  assert.equal(r.projectedHeadroomAtResetPct, 18);
  assert.equal(r.requiredPlanMultiplier, 4);
});

test('weeklyRunway uses limited confidence for short active evidence', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:05:00Z', wk: 79, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'limited');
  assert.equal(r.weeklyBurnRatePctPerHour, 12);
});

test('weeklyRunway returns no-confidence state without weekly burn evidence', () => {
  const snaps = [
    { ts: '2026-06-29T08:00:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:30:00Z', wk: 80, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
  ];

  const r = weeklyRunway(snaps, 5);

  assert.equal(r.confidence, 'none');
  assert.equal(r.weeklyBurnRatePctPerHour, 0);
  assert.equal(r.projectedDepleteTs, null);
  assert.equal(r.gapMs, null);
  assert.equal(r.projectedHeadroomAtResetPct, null);
  assert.equal(r.requiredPlanMultiplier, null);
});
```

- [ ] **Step 2: Run the metric tests and verify red**

Run: `node --test test\metrics.test.js`

Expected: FAIL with `weeklyRunway is not a function`.

- [ ] **Step 3: Implement `weeklyRunway`**

In `metrics.js`, add this after `countDepletionEvents`:

```js
function latestResetTs(pts, key) {
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i][key] > 0) return pts[i][key];
  }
  return null;
}

function weeklyRunway(snapshots, currentPlanMultiplier) {
  const pts = snapshots.filter(s => s && s.wk != null);
  const multiplier = currentPlanMultiplier > 0 ? currentPlanMultiplier : 1;
  if (pts.length < 2) {
    return {
      currentPlanMultiplier: multiplier,
      weeklyRemainingPct: pts.length ? pts[pts.length - 1].wk : null,
      weeklyResetTs: pts.length ? latestResetTs(pts, 'reset7dTs') : null,
      weeklyBurnRatePctPerHour: 0,
      projectedDepleteTs: null,
      gapMs: null,
      projectedHeadroomAtResetPct: null,
      requiredPlanMultiplier: null,
      confidence: 'none',
    };
  }

  const last = pts[pts.length - 1];
  const weeklyResetTs = latestResetTs(pts, 'reset7dTs');
  let activeDrop = 0;
  let activeMs = 0;
  let activeDrops = 0;

  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    const drop = pts[i - 1].wk - pts[i].wk;
    if (drop > 0 && dt > 0 && dt < ACTIVE_GAP_MAX) {
      activeDrop += drop;
      activeMs += dt;
      activeDrops++;
    }
  }

  let weeklyBurnRatePctPerHour = activeMs > 0 ? activeDrop / (activeMs / 3_600_000) : 0;
  let confidence = activeDrops >= 2 && activeMs >= 30 * 60_000 ? 'good'
    : activeDrop > 0 ? 'limited'
    : 'none';

  if (weeklyBurnRatePctPerHour === 0) {
    const first = pts[0];
    const spanMs = new Date(last.ts) - new Date(first.ts);
    const totalDrop = first.wk - last.wk;
    if (spanMs > 0 && totalDrop > 0) {
      weeklyBurnRatePctPerHour = totalDrop / (spanMs / 3_600_000);
      confidence = 'limited';
    }
  }

  if (!weeklyResetTs || weeklyBurnRatePctPerHour <= 0 || last.wk <= 0) {
    return {
      currentPlanMultiplier: multiplier,
      weeklyRemainingPct: last.wk,
      weeklyResetTs,
      weeklyBurnRatePctPerHour,
      projectedDepleteTs: null,
      gapMs: null,
      projectedHeadroomAtResetPct: null,
      requiredPlanMultiplier: null,
      confidence,
    };
  }

  const lastMs = new Date(last.ts).getTime();
  const hoursUntilReset = (weeklyResetTs - lastMs) / 3_600_000;
  const hoursToDeplete = last.wk / weeklyBurnRatePctPerHour;
  const projectedDepleteTs = lastMs + hoursToDeplete * 3_600_000;
  const projectedConsumptionByReset = weeklyBurnRatePctPerHour * hoursUntilReset;
  const projectedHeadroomAtResetPct = last.wk - projectedConsumptionByReset;
  const requiredPlanMultiplier = last.wk > 0
    ? multiplier * projectedConsumptionByReset / last.wk
    : null;

  return {
    currentPlanMultiplier: multiplier,
    weeklyRemainingPct: last.wk,
    weeklyResetTs,
    weeklyBurnRatePctPerHour,
    projectedDepleteTs,
    gapMs: weeklyResetTs - projectedDepleteTs,
    projectedHeadroomAtResetPct,
    requiredPlanMultiplier,
    confidence,
  };
}
```

Update the export line to include `weeklyRunway` after `countDepletionEvents`:

```js
module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles, cycleStats, summarize, countDepletionEvents, weeklyRunway, hourlyBurn, monthBurnGrid, entryCost, summarizeCost, tokenMix, costByDay, costByMonth, activeMs, subscriptionValue, FAMILY_PRICES, CACHE_WRITE_MULT, CACHE_READ_MULT, MONTH_MS, modelFamily, normalizeCodexTokenUsage };
```

- [ ] **Step 4: Run the metric tests and verify green**

Run: `node --test test\metrics.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): add weekly runway projection" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 2: Analytics Runway Cards

**Files:**
- Modify: `analytics-renderer.js`
- Modify: `test/analytics-renderer.test.js`

- [ ] **Step 1: Add failing renderer test**

In `test/analytics-renderer.test.js`, add this helper after `loadEfficiencyRenderer`:

```js
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
```

Add this test:

```js
test('renderStats shows neutral weekly runway and plan-fit cards', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 90, wk: 80, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T08:30:00Z', '5h': 80, wk: 75, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
    { ts: '2026-06-29T09:00:00Z', '5h': 70, wk: 70, reset7dTs: Date.parse('2026-06-30T08:00:00Z') },
  ];

  renderStats(entries, container, { planMultipliers: { codex: 5 } });

  assert.match(container.innerHTML, /Weekly Runway/);
  assert.match(container.innerHTML, /Reset Gap/);
  assert.match(container.innerHTML, /Plan Fit/);
  assert.match(container.innerHTML, /At Reset/);
  assert.match(container.innerHTML, /5x/);
  assert.match(container.innerHTML, /~16\.4x/);
  assert.doesNotMatch(container.innerHTML.toLowerCase(), /upgrade/);
});
```

- [ ] **Step 2: Run renderer test and verify red**

Run: `node --test test\analytics-renderer.test.js`

Expected: FAIL because `renderStats` does not accept settings or render runway cards yet.

- [ ] **Step 3: Pass settings into `renderStats`**

In `analytics-renderer.js`, change:

```js
function renderStats(entries, container) {
```

to:

```js
function renderStats(entries, container, settings = {}) {
```

In `renderAll`, change:

```js
  renderStats(entries, statsEl);
```

to:

```js
  renderStats(entries, statsEl, _cur);
```

- [ ] **Step 4: Add formatting helpers**

Add these helpers near `fmtRate`:

```js
function fmtRunwayDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleDateString([], { weekday: 'short' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtGap(ms) {
  if (ms == null) return '-';
  const label = fmtDuration(Math.abs(ms));
  return ms > 0 ? `${label} short` : `${label} buffer`;
}

function fmtMultiplier(v) {
  if (v == null || !isFinite(v)) return '-';
  return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') + 'x';
}

function planMultiplierFor(settings, account) {
  const configured = settings && settings.planMultipliers && settings.planMultipliers[account];
  if (configured > 0) return configured;
  if (account === 'codex') return 5;
  return PLAN_MULTIPLIERS[account] ?? 1;
}
```

- [ ] **Step 5: Add runway cards in `renderStats`**

Inside `renderStats`, after `const mult = PLAN_MULTIPLIERS[currentAccount] ?? 1;`, add:

```js
  const configuredPlanMultiplier = planMultiplierFor(settings, currentAccount);
  const runway = weeklyRunway(entries, configuredPlanMultiplier);
  const runwayCls = runway.confidence === 'none' ? 'dim'
    : runway.gapMs > 0 ? 'red'
    : runway.gapMs > -12 * 3_600_000 ? 'amber'
    : 'green';
  const runwayCards = runway.confidence === 'none' ? [
    { label: 'Weekly Runway', value: '-', sub: 'need weekly movement', cls: 'dim' },
    { label: 'Reset Gap', value: '-', sub: 'vs weekly reset', cls: 'dim' },
    { label: 'Plan Fit', value: `${fmtMultiplier(configuredPlanMultiplier)} -> -`, sub: 'current plan - pace required', cls: 'dim' },
    { label: 'At Reset', value: '-', sub: 'projected weekly headroom', cls: 'dim' },
  ] : [
    {
      label: 'Weekly Runway',
      value: runway.gapMs > 0 ? fmtRunwayDate(runway.projectedDepleteTs) : 'Lasts to reset',
      sub: runway.gapMs > 0 ? 'projected weekly depletion' : 'at current pace',
      cls: runwayCls,
    },
    { label: 'Reset Gap', value: fmtGap(runway.gapMs), sub: 'vs weekly reset', cls: runwayCls },
    {
      label: 'Plan Fit',
      value: `${fmtMultiplier(runway.currentPlanMultiplier)} -> ~${fmtMultiplier(runway.requiredPlanMultiplier)}`,
      sub: 'current plan - pace required',
      cls: runwayCls,
    },
    {
      label: 'At Reset',
      value: Math.round(runway.projectedHeadroomAtResetPct) + '%',
      sub: 'projected weekly headroom',
      cls: runwayCls,
    },
  ];
```

Add `...runwayCards` as the final item in the existing `cards` array:

```js
    { label: 'Next Weekly Reset', value: next7dStr, sub: next7dSub, cls: apiReset7d && apiReset7d - Date.now() < 86_400_000 ? 'amber' : '' },
    ...runwayCards,
```

- [ ] **Step 6: Run renderer test and verify green**

Run: `node --test test\analytics-renderer.test.js`

Expected: PASS. The test finds the neutral runway cards and no `upgrade` copy.

- [ ] **Step 7: Commit Task 2**

```bash
git add analytics-renderer.js test/analytics-renderer.test.js
git commit -m "feat(analytics): show weekly runway plan fit" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 3: Editable Codex Plan Multiplier Setting

**Files:**
- Modify: `settings.html`
- Modify: `settings-renderer.js`

- [ ] **Step 1: Add Codex multiplier input to Settings HTML**

In `settings.html`, immediately after the `Subscriptions (plan price, USD/mo)` section, add:

```html
  <div class="section">
    <div class="section-title">Plan capacity multiplier</div>
    <div class="row"><label>Codex</label><input type="number" id="mult-codex" min="0.1" step="0.1" value="5"><span class="suffix">x</span></div>
    <div class="note">Used by Analytics to compare current weekly pace against configured plan capacity.</div>
  </div>
```

- [ ] **Step 2: Wire load/save in Settings renderer**

In `settings-renderer.js`, inside `loadSettings`, after loading plan prices, add:

```js
  const pm = s.planMultipliers || {};
  document.getElementById('mult-codex').value = pm.codex != null ? pm.codex : 5;
```

Add this function after `savePlanPrices`:

```js
function savePlanMultipliers() {
  const planMultipliers = {};
  const codex = parseFloat(document.getElementById('mult-codex').value);
  if (!isNaN(codex) && codex > 0) planMultipliers.codex = codex;
  window.electronAPI.saveSettings({ planMultipliers });
}
```

Add this listener near the plan price listener:

```js
document.getElementById('mult-codex').addEventListener('change', savePlanMultipliers);
```

- [ ] **Step 3: Run syntax check**

Run: `node --check settings-renderer.js`

Expected: exit 0.

- [ ] **Step 4: Commit Task 3**

```bash
git add settings.html settings-renderer.js
git commit -m "feat(settings): add Codex plan multiplier" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

---

### Task 4: Full Verification and Real-Log Sanity Check

**Files:**
- No source changes expected unless verification reveals a defect.

- [ ] **Step 1: Run full automated test suite**

Run: `npm test`

Expected: all tests pass. The count should increase from 39 because Task 1 and Task 2 add tests.

- [ ] **Step 2: Run syntax checks on changed JavaScript files**

Run:

```bash
node --check metrics.js
node --check analytics-renderer.js
node --check settings-renderer.js
node --check test/metrics.test.js
node --check test/analytics-renderer.test.js
```

Expected: all exit 0.

- [ ] **Step 3: Run a real-log runway sanity command**

Run:

```bash
node -e "const fs=require('fs');const {weeklyRunway}=require('./metrics.js');const rows=fs.readFileSync('usage-log.jsonl','utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(e=>e.account==='codex');const r=weeklyRunway(rows,5);console.log(JSON.stringify({confidence:r.confidence,weeklyRemainingPct:r.weeklyRemainingPct,burn:r.weeklyBurnRatePctPerHour,headroom:r.projectedHeadroomAtResetPct,required:r.requiredPlanMultiplier,gapHours:r.gapMs==null?null:r.gapMs/3600000},null,2));"
```

Expected: JSON prints a non-throwing result. With current active Codex usage, `required` may be above `5` and `headroom` may be negative; that is acceptable and is the insight this feature is meant to expose.

- [ ] **Step 4: Inspect git status**

Run: `git status -sb`

Expected: clean working tree on `codex/weekly-runway-plan-fit`.

- [ ] **Step 5: Final commit if verification required fixes**

If verification required small fixes, commit them:

```bash
git add <changed-files>
git commit -m "fix(analytics): polish weekly runway plan fit" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

If no fixes were needed, do not create an empty commit.

---

## Manual Verification Notes

The Electron GUI cannot be launched reliably in the agent/headless environment. After implementation, user-side GUI verification should check:

- Settings shows `Plan capacity multiplier` with Codex defaulted to `5`.
- Changing Codex multiplier updates Analytics after settings broadcast/refresh.
- Codex Analytics top cards include `Weekly Runway`, `Reset Gap`, `Plan Fit`, and `At Reset`.
- Cards use neutral copy and do not contain the word `upgrade`.
- Values make intuitive sense against current screenshot/log: current plan around `5x`, pace requirement above or below that depending on weekly burn rate.

