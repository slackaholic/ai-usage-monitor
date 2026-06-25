# Usage Efficiency Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive descriptive efficiency metrics (peak usage, headroom, blocking, hourly burn) from the existing `usage-log.jsonl` snapshot stream and surface them in the AI Usage Analytics window as a live panel, a per-cycle scorecard, and a historical report.

**Architecture:** A new pure module `metrics.js` segments the remaining-% snapshot stream into per-account, per-window reset cycles and computes stats with zero I/O (Approach A — on-the-fly derivation). `analytics-renderer.js` calls it and renders a new Efficiency section. The raw log and IPC are unchanged; the historical view reads the full log via the existing `readUsageLog(account, 0)` path.

**Tech Stack:** Electron 28 (renderer with `nodeIntegration:false`, `contextIsolation:false`), vanilla JS classic `<script>` files, Node's built-in `node --test` runner (no new dependencies).

## Global Constraints

- **No new npm dependencies.** Tests use Node's built-in `node:test` + `node:assert`.
- **`metrics.js` must load both ways:** as a classic browser `<script>` (functions become globals; no `import`/`export`, no `require` at top level) AND under `node --test` (via `require`). Use the dual footer: `if (typeof module !== 'undefined' && module.exports) module.exports = { ... }`.
- **No main.js / preload.js changes.** `readUsageLog(account, 0)` already returns all rows (`all.slice(-0)` === whole array). Verified in `main.js:35-44`.
- **Match existing style:** `'use strict';`, `const`/`let`, classic scripts, existing CSS variables (`--accent`, `--green`, `--red`, `--text-mid`).
- **Metrics are descriptive, not graded.** No composite "efficiency score." Blocking (hit 0% before reset) is the only judged signal. Peak/headroom are shown with no target line.
- **All thresholds are named constants at the top of `metrics.js`** for later calibration.
- **Percentages only** — the log carries no absolute token counts.

---

### Task 1: `metrics.js` — cycle segmentation

**Files:**
- Create: `metrics.js`
- Create: `test/metrics.test.js`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Produces: `segmentCycles(snapshots, win) -> Array<Array<snapshot>>` where `win` is `'5h'` or `'wk'`. Each inner array is one reset cycle, snapshots in time order. Also exports constants `RESET_JUMP_MIN`, `RESET_ADVANCE_MIN`, `ACTIVE_GAP_MAX`.
- A snapshot is `{ ts: ISOString, '5h'?: number, 'wk'?: number, reset5hTs?: number, reset7dTs?: number, depleted?: string[] }`.

- [ ] **Step 1: Add the test script to `package.json`**

Modify the `"scripts"` block so it reads:

```json
  "scripts": {
    "start": "electron .",
    "install-deps": "npm install",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing tests**

Create `test/metrics.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { segmentCycles } = require('../metrics.js');

test('segmentCycles splits on a large upward jump (reset by recovery)', () => {
  const snaps = [
    { ts: '2026-06-25T00:00:00Z', '5h': 80 },
    { ts: '2026-06-25T01:00:00Z', '5h': 50 },
    { ts: '2026-06-25T02:00:00Z', '5h': 95 }, // +45 → boundary
  ];
  const cycles = segmentCycles(snaps, '5h');
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].length, 2);
  assert.equal(cycles[1].length, 1);
});

test('segmentCycles splits a low-usage cycle via reset-timestamp advance', () => {
  const base = 1782402600000;
  const snaps = [
    { ts: '2026-06-25T00:00:00Z', '5h': 95, reset5hTs: base },
    { ts: '2026-06-25T04:00:00Z', '5h': 90, reset5hTs: base }, // only -5, no jump
    { ts: '2026-06-25T05:00:00Z', '5h': 100, reset5hTs: base + 5 * 3_600_000 }, // resetTs advanced → boundary
  ];
  const cycles = segmentCycles(snaps, '5h');
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].length, 2);
});

test('segmentCycles ignores snapshots missing the window field', () => {
  const snaps = [
    { ts: '2026-06-25T00:00:00Z', '5h': 80 },
    { ts: '2026-06-25T00:30:00Z', wk: 60 }, // no 5h
    { ts: '2026-06-25T01:00:00Z', '5h': 70 },
  ];
  const cycles = segmentCycles(snaps, '5h');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].length, 2);
});

test('segmentCycles returns [] for empty input', () => {
  assert.deepEqual(segmentCycles([], '5h'), []);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../metrics.js'`.

- [ ] **Step 4: Create `metrics.js` with the minimal implementation**

```js
'use strict';

// Tunable thresholds — calibrate once more data accumulates.
const RESET_JUMP_MIN = 15;            // upward % jump counted as a window reset
const RESET_ADVANCE_MIN = 60_000;     // forward jump (ms) in the reset timestamp counted as a reset
const ACTIVE_GAP_MAX = 15 * 60_000;   // poll gap above this is idle, not consumption

const RESET_KEY = { '5h': 'reset5hTs', wk: 'reset7dTs' };

function isBoundary(prev, cur, win) {
  const jumped = (cur[win] - prev[win]) > RESET_JUMP_MIN;
  const rk = RESET_KEY[win];
  const advanced = prev[rk] > 0 && cur[rk] > 0 && (cur[rk] - prev[rk]) > RESET_ADVANCE_MIN;
  return jumped || advanced;
}

function segmentCycles(snapshots, win) {
  const pts = snapshots.filter(s => s && s[win] != null);
  if (pts.length === 0) return [];
  const cycles = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (isBoundary(pts[i - 1], pts[i], win)) {
      cycles.push(cur);
      cur = [pts[i]];
    } else {
      cur.push(pts[i]);
    }
  }
  cycles.push(cur);
  return cycles;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add metrics.js test/metrics.test.js package.json
git commit -m "feat(metrics): cycle segmentation from snapshot stream"
```

---

### Task 2: `metrics.js` — per-cycle stats

**Files:**
- Modify: `metrics.js`
- Modify: `test/metrics.test.js`

**Interfaces:**
- Consumes: `segmentCycles` output (an array of snapshots = one cycle).
- Produces: `cycleStats(cycle, win) -> { startTs, endTs, peakPct, headroomPct, blocked, blockedMs }`. `peakPct = 100 - min(remaining)`; `headroomPct = min(remaining)`; `blocked` = any remaining hit 0; `blockedMs` = first-zero poll → last poll of the cycle (0 if never blocked).

- [ ] **Step 1: Write the failing tests**

Append to `test/metrics.test.js`:

```js
const { cycleStats } = require('../metrics.js');

test('cycleStats reports peak and headroom for a comfortable cycle', () => {
  const cycle = [
    { ts: '2026-06-25T00:00:00Z', '5h': 80 },
    { ts: '2026-06-25T01:00:00Z', '5h': 30 },
  ];
  const s = cycleStats(cycle, '5h');
  assert.equal(s.peakPct, 70);
  assert.equal(s.headroomPct, 30);
  assert.equal(s.blocked, false);
  assert.equal(s.blockedMs, 0);
  assert.equal(s.startTs, '2026-06-25T00:00:00Z');
  assert.equal(s.endTs, '2026-06-25T01:00:00Z');
});

test('cycleStats measures blocked duration when a cycle hits zero', () => {
  const cycle = [
    { ts: '2026-06-25T00:00:00Z', '5h': 40 },
    { ts: '2026-06-25T01:00:00Z', '5h': 0 },
    { ts: '2026-06-25T02:00:00Z', '5h': 0 },
  ];
  const s = cycleStats(cycle, '5h');
  assert.equal(s.peakPct, 100);
  assert.equal(s.headroomPct, 0);
  assert.equal(s.blocked, true);
  assert.equal(s.blockedMs, 3_600_000); // 01:00 → 02:00
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `cycleStats is not a function`.

- [ ] **Step 3: Add the implementation**

Insert before the footer in `metrics.js`:

```js
function cycleStats(cycle, win) {
  const remaining = cycle.map(p => p[win]);
  const minRemaining = Math.min(...remaining);
  const blocked = remaining.some(r => r === 0);
  let blockedMs = 0;
  if (blocked) {
    const firstZero = cycle.find(p => p[win] === 0);
    blockedMs = new Date(cycle[cycle.length - 1].ts) - new Date(firstZero.ts);
  }
  return {
    startTs: cycle[0].ts,
    endTs: cycle[cycle.length - 1].ts,
    peakPct: 100 - minRemaining,
    headroomPct: minRemaining,
    blocked,
    blockedMs,
  };
}
```

Update the footer to export it:

```js
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles, cycleStats };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): per-cycle peak/headroom/blocked stats"
```

---

### Task 3: `metrics.js` — summary + hourly burn

**Files:**
- Modify: `metrics.js`
- Modify: `test/metrics.test.js`

**Interfaces:**
- Consumes: array of `cycleStats` results (`summarize`); raw snapshots (`hourlyBurn`).
- Produces:
  - `summarize(stats) -> { count, blockedCount, blockRate, totalBlockedMs, peaks: Array<{ts, peakPct}> }`.
  - `hourlyBurn(snapshots, win) -> number[24]` — total % consumed per local hour-of-day, counting only positive drops with a poll gap under `ACTIVE_GAP_MAX` (excludes idle gaps and resets).

- [ ] **Step 1: Write the failing tests**

Append to `test/metrics.test.js`:

```js
const { summarize, hourlyBurn } = require('../metrics.js');

test('summarize aggregates block rate and peaks across cycles', () => {
  const stats = [
    { startTs: 'a', peakPct: 60, blocked: false, blockedMs: 0 },
    { startTs: 'b', peakPct: 100, blocked: true, blockedMs: 3_600_000 },
  ];
  const sum = summarize(stats);
  assert.equal(sum.count, 2);
  assert.equal(sum.blockedCount, 1);
  assert.equal(sum.blockRate, 0.5);
  assert.equal(sum.totalBlockedMs, 3_600_000);
  assert.deepEqual(sum.peaks, [{ ts: 'a', peakPct: 60 }, { ts: 'b', peakPct: 100 }]);
});

test('summarize handles no completed cycles', () => {
  const sum = summarize([]);
  assert.equal(sum.count, 0);
  assert.equal(sum.blockRate, 0);
  assert.deepEqual(sum.peaks, []);
});

test('hourlyBurn sums active drops and excludes idle gaps and resets', () => {
  const snaps = [
    { ts: '2026-06-25T09:00:00Z', '5h': 100 },
    { ts: '2026-06-25T09:05:00Z', '5h': 90 },  // active drop 10
    { ts: '2026-06-25T11:00:00Z', '5h': 70 },  // gap 115min → idle, excluded
    { ts: '2026-06-25T11:05:00Z', '5h': 60 },  // active drop 10
    { ts: '2026-06-25T11:10:00Z', '5h': 100 }, // reset (negative) → excluded
  ];
  const hours = hourlyBurn(snaps, '5h');
  assert.equal(hours.length, 24);
  assert.equal(hours.reduce((a, b) => a + b, 0), 20); // TZ-independent total
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `summarize is not a function`.

- [ ] **Step 3: Add the implementation**

Insert before the footer in `metrics.js`:

```js
function summarize(stats) {
  const count = stats.length;
  const blocked = stats.filter(s => s.blocked);
  return {
    count,
    blockedCount: blocked.length,
    blockRate: count ? blocked.length / count : 0,
    totalBlockedMs: blocked.reduce((a, s) => a + s.blockedMs, 0),
    peaks: stats.map(s => ({ ts: s.startTs, peakPct: s.peakPct })),
  };
}

function hourlyBurn(snapshots, win) {
  const hours = new Array(24).fill(0);
  const pts = snapshots.filter(s => s && s[win] != null);
  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    const drop = pts[i - 1][win] - pts[i][win];
    if (drop > 0 && dt < ACTIVE_GAP_MAX) {
      hours[new Date(pts[i - 1].ts).getHours()] += drop;
    }
  }
  return hours;
}
```

Update the footer:

```js
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles, cycleStats, summarize, hourlyBurn };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): summary + hourly-burn aggregation"
```

---

### Task 4: Prove the pipeline on the real log + load `metrics.js` in the window

**Files:**
- Modify: `analytics.html` (add `<script src="metrics.js">`)
- Modify: `test/metrics.test.js` (real-log smoke test)

**Interfaces:**
- Consumes: all of `metrics.js`.
- Produces: nothing new; this task wires the module into the analytics page and guards the real-data path.

- [ ] **Step 1: Write the real-log smoke test**

Append to `test/metrics.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

test('real log: full pipeline yields sane stats and never throws', () => {
  const p = path.join(__dirname, '..', 'usage-log.jsonl');
  if (!fs.existsSync(p)) return; // clean checkout — nothing to validate
  const all = fs.readFileSync(p, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  for (const acct of ['codex', 'claude-desktop', 'claude-vscode']) {
    const snaps = all.filter(e => e.account === acct);
    for (const win of ['5h', 'wk']) {
      const stats = segmentCycles(snaps, win).map(c => cycleStats(c, win));
      for (const s of stats) {
        assert.ok(s.peakPct >= 0 && s.peakPct <= 100, `peak ${s.peakPct}`);
        assert.ok(s.headroomPct >= 0 && s.headroomPct <= 100, `headroom ${s.headroomPct}`);
        assert.ok(s.blockedMs >= 0);
      }
      const sum = summarize(stats);
      assert.ok(sum.blockRate >= 0 && sum.blockRate <= 1);
      assert.equal(hourlyBurn(snaps, win).length, 24);
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (the test runs against the committed `usage-log.jsonl`; if that file is absent it self-skips and still passes).

- [ ] **Step 3: Load `metrics.js` before the renderer in `analytics.html`**

In `analytics.html`, change the script tag near the end (`analytics.html:280`) from:

```html
<script src="analytics-renderer.js"></script>
```

to:

```html
<script src="metrics.js"></script>
<script src="analytics-renderer.js"></script>
```

- [ ] **Step 4: Syntax-check the touched files**

Run: `node --check metrics.js && node --check analytics-renderer.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add analytics.html test/metrics.test.js
git commit -m "feat(metrics): real-log smoke test; load metrics.js in analytics window"
```

---

### Task 5: Efficiency section — live panel, scorecard, history line

**Files:**
- Modify: `analytics-renderer.js` (add `buildEffWindow`, `renderEfficiency`; call from `renderAll`)

**Interfaces:**
- Consumes: `segmentCycles`, `cycleStats`, `summarize` (globals from `metrics.js`); existing helpers `fmtDuration`, `fmtDate`.
- Produces: `renderEfficiency(entries, container)` — renders an Efficiency section. Reads the full unfiltered log (passed in by `renderAll`). Placeholder elements `#eff-peaks-5h`, `#eff-peaks-wk`, `#eff-heat-5h`, `#eff-heat-wk` are emitted for Task 6 to fill.

- [ ] **Step 1: Add `buildEffWindow` and `renderEfficiency`**

Insert in `analytics-renderer.js` after `renderTable` (before `renderAll`, ~line 514):

```js
// ── Efficiency ─────────────────────────────────────────────────────────────
function buildEffWindow(entries, win) {
  const title = win === '5h' ? '5-Hour Window' : 'Weekly Window';
  const cycles = segmentCycles(entries, win);
  if (!cycles.length) {
    return `<div class="eff-sub">${title}</div><div class="empty">No data yet.</div>`;
  }

  const current = cycleStats(cycles[cycles.length - 1], win);
  const completedCycles = cycles.slice(0, -1);
  const completed = completedCycles.map(c => cycleStats(c, win));
  const lastDone = completed.length ? completed[completed.length - 1] : null;
  const sum = summarize(completed);

  // Confidence: gap between the last completed cycle's final poll and the reset
  // that ended it (≈ the current cycle's first poll).
  let confidenceMs = null;
  if (lastDone && completedCycles.length) {
    const lastEnd = completedCycles[completedCycles.length - 1].slice(-1)[0].ts;
    confidenceMs = new Date(cycles[cycles.length - 1][0].ts) - new Date(lastEnd);
  }

  const grid = cards => `<div class="stat-grid">${cards.map(c => `
    <div class="stat-card ${c.cls}"><div class="label">${c.label}</div>
      <div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>`).join('')}</div>`;

  const liveCards = [
    { label: 'Peak So Far', value: current.peakPct + '%', sub: 'this cycle',
      cls: current.peakPct >= 90 ? 'red' : current.peakPct >= 70 ? 'amber' : 'green' },
    { label: 'Headroom', value: current.headroomPct + '%', sub: 'unused so far', cls: '' },
    { label: 'Status', value: current.blocked ? 'Blocked' : 'Running',
      sub: current.blocked ? 'hit the limit' : 'within limit',
      cls: current.blocked ? 'red' : 'green' },
  ];

  const scoreCards = lastDone ? [
    { label: 'Last Peak', value: lastDone.peakPct + '%', sub: 'previous cycle', cls: '' },
    { label: 'Left at Reset', value: lastDone.headroomPct + '%', sub: 'headroom', cls: '' },
    { label: 'Blocked', value: lastDone.blocked ? 'Yes' : 'No',
      sub: lastDone.blocked ? fmtDuration(lastDone.blockedMs) + ' stuck' : 'never ran out',
      cls: lastDone.blocked ? 'red' : 'green' },
  ] : [];

  const histLine = sum.count
    ? `${sum.blockedCount} of ${sum.count} completed cycles ran out`
      + (sum.totalBlockedMs > 0 ? ` · ≈${fmtDuration(sum.totalBlockedMs)} blocked total` : '')
    : 'No completed cycles yet.';

  const confLine = confidenceMs != null && confidenceMs > 0
    ? `<div class="eff-note">Scorecard based on a poll ${fmtDuration(confidenceMs)} before reset.</div>`
    : '';

  return `
    <div class="eff-sub">${title} — Now</div>
    ${grid(liveCards)}
    ${scoreCards.length ? `<div class="eff-sub">${title} — Last Completed Cycle</div>${grid(scoreCards)}${confLine}` : ''}
    <div class="eff-sub">${title} — History</div>
    <div class="eff-hist">${histLine}</div>
    <div id="eff-peaks-${win}" class="eff-peaks"></div>
    <div id="eff-heat-${win}" class="eff-heat"></div>
  `;
}

function renderEfficiency(entries, container) {
  container.innerHTML = `<div class="section-head">Efficiency</div>`
    + ['5h', 'wk'].map(win => buildEffWindow(entries, win)).join('');
}
```

- [ ] **Step 2: Wire it into `renderAll`**

In `renderAll` (`analytics-renderer.js:546-557`), replace the section-build block:

```js
  // Build sections
  const statsEl = document.createElement('div');
  const chartEl = document.createElement('div');
  const tableEl = document.createElement('div');

  body.innerHTML = '';
  body.appendChild(statsEl);
  body.appendChild(chartEl);
  body.appendChild(tableEl);

  renderStats(entries, statsEl);
  renderChart(entries, chartEl);
  renderTable(entries, tableEl);
```

with:

```js
  // Build sections
  const statsEl = document.createElement('div');
  const effEl   = document.createElement('div');
  const chartEl = document.createElement('div');
  const tableEl = document.createElement('div');

  body.innerHTML = '';
  body.appendChild(statsEl);
  body.appendChild(effEl);
  body.appendChild(chartEl);
  body.appendChild(tableEl);

  // Efficiency reads the FULL log (all cycles), independent of the time-window filter.
  const allEntries = await window.electronAPI.readUsageLog(currentAccount, 0);

  renderStats(entries, statsEl);
  renderEfficiency(allEntries, effEl);
  renderChart(entries, chartEl);
  renderTable(entries, tableEl);
```

- [ ] **Step 3: Syntax-check**

Run: `node --check analytics-renderer.js`
Expected: no output (exit 0).

- [ ] **Step 4: Verify in the app**

Run: `npm start`. Open the analytics window (click an account in the main monitor, or it opens via the tray). For each tab (Codex / Claude Desktop / Claude Code), confirm an **Efficiency** section appears between the stat cards and the trend chart, showing "— Now" cards (Peak So Far / Headroom / Status), a "— Last Completed Cycle" scorecard when prior cycles exist, and a "— History" line like "2 of 9 completed cycles ran out". The peak/heat placeholders are empty for now.

- [ ] **Step 5: Commit**

```bash
git add analytics-renderer.js
git commit -m "feat(analytics): efficiency live panel, scorecard, and history line"
```

---

### Task 6: Efficiency charts — peak-trend bars + hour-of-day heatmap

**Files:**
- Modify: `analytics-renderer.js` (add `renderPeakBars`, `renderHourHeatmap`; populate from `renderEfficiency`)
- Modify: `analytics.html` (CSS for the new elements)

**Interfaces:**
- Consumes: `summarize(...).peaks` and `hourlyBurn(entries, win)` (globals); existing `fmtDate`.
- Produces: `renderPeakBars(el, peaks)` and `renderHourHeatmap(el, hours)`; `renderEfficiency` now fills the `#eff-peaks-*` / `#eff-heat-*` placeholders after setting `innerHTML`.

- [ ] **Step 1: Add the two chart renderers**

Insert in `analytics-renderer.js` directly after `renderEfficiency`:

```js
function renderPeakBars(el, peaks) {
  if (!el) return;
  if (!peaks.length) { el.innerHTML = '<div class="empty">No completed cycles yet.</div>'; return; }
  const bars = peaks.map(p => {
    const h = Math.max(2, Math.round(p.peakPct));
    const color = p.peakPct >= 90 ? 'var(--red)' : p.peakPct >= 70 ? '#fbbf24' : 'var(--green)';
    return `<div class="peak-bar" title="${p.peakPct}% · ${fmtDate(p.ts)}" style="height:${h}%;background:${color}"></div>`;
  }).join('');
  el.innerHTML = `<div class="eff-cap">Peak usage per completed cycle</div><div class="peak-bars">${bars}</div>`;
}

function renderHourHeatmap(el, hours) {
  if (!el) return;
  const max = Math.max(1, ...hours);
  const cells = hours.map((v, h) => {
    const a = (v / max).toFixed(2);
    return `<div class="heat-cell" title="${h}:00 — ${v.toFixed(0)}% burned" style="background:rgba(168,85,247,${a})">${h % 6 === 0 ? h : ''}</div>`;
  }).join('');
  el.innerHTML = `<div class="eff-cap">Burn by hour of day</div><div class="heat-row">${cells}</div>`;
}
```

- [ ] **Step 2: Populate the placeholders from `renderEfficiency`**

Replace the body of `renderEfficiency` with:

```js
function renderEfficiency(entries, container) {
  container.innerHTML = `<div class="section-head">Efficiency</div>`
    + ['5h', 'wk'].map(win => buildEffWindow(entries, win)).join('');

  ['5h', 'wk'].forEach(win => {
    const completed = segmentCycles(entries, win).slice(0, -1).map(c => cycleStats(c, win));
    renderPeakBars(container.querySelector(`#eff-peaks-${win}`), summarize(completed).peaks);
    renderHourHeatmap(container.querySelector(`#eff-heat-${win}`), hourlyBurn(entries, win));
  });
}
```

- [ ] **Step 3: Add CSS for the new elements**

In `analytics.html`, add inside the existing `<style>` block (before `</style>`):

```css
.eff-sub { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-mid); margin: 14px 0 6px; }
.eff-hist { font-size: 13px; margin-bottom: 6px; }
.eff-note { font-size: 10px; color: var(--text-mid); margin-top: 4px; }
.eff-cap { font-size: 10px; color: var(--text-mid); margin: 8px 0 4px; }
.eff-peaks, .eff-heat { margin: 4px 0; }
.peak-bars { display: flex; align-items: flex-end; gap: 2px; height: 60px; }
.peak-bar { flex: 1; min-width: 2px; border-radius: 1px 1px 0 0; }
.heat-row { display: flex; gap: 2px; }
.heat-cell { flex: 1; height: 20px; border-radius: 2px; font-size: 8px; color: rgba(255,255,255,.5); display: flex; align-items: center; justify-content: center; }
```

- [ ] **Step 4: Syntax-check**

Run: `node --check analytics-renderer.js`
Expected: no output (exit 0).

- [ ] **Step 5: Verify in the app**

Run: `npm start`, open analytics. Under each window's "— History", confirm a row of peak bars (one per completed cycle, colored green/amber/red by depth, hover shows % and date) and a 24-cell hour-of-day heatmap (purple intensity, labels at 0/6/12/18). Switch tabs and confirm both windows (5h + weekly) render for every account.

- [ ] **Step 6: Commit**

```bash
git add analytics-renderer.js analytics.html
git commit -m "feat(analytics): peak-trend bars and hour-of-day burn heatmap"
```

---

## Self-Review

**Spec coverage:**
- Stay within limits → blocking signal: `cycleStats.blocked`/`blockedMs` (Task 2), `summarize.blockRate`/`totalBlockedMs` (Task 3), Status card + history line (Task 5). ✓
- Don't waste quota (descriptive headroom, not penalty) → `headroomPct` shown as informational "Headroom"/"Left at Reset" (Tasks 2, 5). ✓
- Understand patterns → peak-trend bars + hour-of-day heatmap (Tasks 3, 6). ✓
- Approach A on-the-fly, no storage/migration → pure `metrics.js`, derived per render (Tasks 1–3). ✓
- Live panel / scorecard / historical report → Task 5 (text) + Task 6 (charts). ✓
- Reset detection by jump OR resetTs → `isBoundary` (Task 1), including the low-usage timestamp case. ✓
- Confidence hint for waste imprecision → `confidenceMs` line (Task 5). ✓
- Full-log read for history via existing `readUsageLog(account, 0)`, no main.js change → Task 5 wiring; verified `main.js:35-44`. ✓
- Tunable thresholds as named constants → top of `metrics.js` (Task 1). ✓
- Out of scope (routing, alerts, store, export, absolute counts) → none implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows assertions. ✓

**Type consistency:** `segmentCycles` → `Array<Array<snapshot>>` consumed by `cycleStats(cycle, win)` in Tasks 2/5/6; `cycleStats` shape (`peakPct`/`headroomPct`/`blocked`/`blockedMs`/`startTs`/`endTs`) consumed by `summarize` and the renderers consistently; `summarize().peaks` (`{ts, peakPct}`) consumed by `renderPeakBars`; `hourlyBurn` returns `number[24]` consumed by `renderHourHeatmap`. Names match across tasks. ✓
