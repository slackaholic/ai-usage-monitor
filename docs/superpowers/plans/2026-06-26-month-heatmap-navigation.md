# Month Heatmap Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rolling last-30-days burn heatmap with a calendar-month view that the user can page through month by month (◀ / ▶).

**Architecture:** Swap the pure `dailyHourlyBurn` metric for `monthBurnGrid(snapshots, win, year, month)`, then add month state, a ◀/▶ control bar with bounds, and re-render-only-the-grid navigation in `analytics-renderer.js`. Still 5h-window only, still inside the collapsed `<details>`.

**Tech Stack:** Vanilla JS classic `<script>` files, Electron renderer (`nodeIntegration:false`), Node's built-in `node --test`. No new dependencies.

## Global Constraints

- **No new npm dependencies.** Tests use `node:test` / `node:assert`.
- **`metrics.js` must remain dual-load** (browser `<script>` globals AND `require`): keep the `if (typeof module !== 'undefined' && module.exports)` footer; no `import`/ESM; no top-level `require`.
- **`metrics.js` functions stay pure** — NO `Date.now()` / argless `new Date()` inside the module; `year`/`month` are inputs.
- **`month` is 0-based** everywhere (January = 0), matching JS `Date`.
- **No `main.js` / `preload.js` / IPC changes.**
- **Percentages only.**
- **5-hour window only** for the month grid; the existing 24-hour profile row stays in both windows, unchanged.
- **Collapsed by default** via the existing `<details>`; the displayed month resets to the latest logged month on each Efficiency render (not persisted).
- **Reuse existing CSS variables** (`--text-mid`, `--accent-med`) and the heatmap purple `rgba(168,85,247,a)`.

---

### Task 1: Replace `dailyHourlyBurn` with `monthBurnGrid` in `metrics.js`

**Files:**
- Modify: `metrics.js`
- Modify: `test/metrics.test.js`

**Interfaces:**
- Consumes: `ACTIVE_GAP_MAX`, private `localDayKey` (existing).
- Produces: `monthBurnGrid(snapshots, win, year, month) -> Array<{ date: 'YYYY-MM-DD', hours: number[24], hasData: boolean }>`. One row per day of the given calendar month (`month` 0-based), chronological (day 1 first). `hours[h]` = total % burned in local hour `h` that day; counts only positive drops with poll gap `< ACTIVE_GAP_MAX` (excludes idle gaps and resets), attributed to the earlier snapshot's local day+hour. `hasData` = any snapshot (with `win` present) on that local day. Returns a full month of `hasData:false` rows when no snapshots fall in the month. `dailyHourlyBurn` is REMOVED.

- [ ] **Step 1: Replace the old tests with new ones**

In `test/metrics.test.js`, find the four `dailyHourlyBurn` tests (the block starting with `const { dailyHourlyBurn } = require('../metrics.js');` and its four `test('dailyHourlyBurn ...', ...)` cases). Delete that `require` line and all four of those tests. In their place, add:

```js
const { monthBurnGrid } = require('../metrics.js');

test('monthBurnGrid returns one row per day of the calendar month', () => {
  assert.equal(monthBurnGrid([], '5h', 2026, 5).length, 30); // June 2026
  assert.equal(monthBurnGrid([], '5h', 2026, 6).length, 31); // July 2026
  assert.equal(monthBurnGrid([], '5h', 2028, 1).length, 29); // Feb 2028 (leap)
  assert.equal(monthBurnGrid([], '5h', 2027, 1).length, 28); // Feb 2027
});

test('monthBurnGrid buckets active drops into the queried month only', () => {
  const snaps = [
    { ts: '2026-06-10T12:00:00Z', '5h': 100 },
    { ts: '2026-06-10T12:05:00Z', '5h': 90 },  // June active drop 10
    { ts: '2026-06-10T12:10:00Z', '5h': 100 }, // reset (negative) → excluded
    { ts: '2026-07-10T12:00:00Z', '5h': 80 },  // month gap → idle, excluded
    { ts: '2026-07-10T12:05:00Z', '5h': 70 },  // July active drop 10
  ];
  const sum = g => g.reduce((a, r) => a + r.hours.reduce((x, y) => x + y, 0), 0);
  assert.equal(sum(monthBurnGrid(snaps, '5h', 2026, 5)), 10); // June only
  assert.equal(sum(monthBurnGrid(snaps, '5h', 2026, 6)), 10); // July only
});

test('monthBurnGrid marks hasData for logged days including zero-burn days', () => {
  const snaps = [
    { ts: '2026-06-10T12:00:00Z', '5h': 50 },
    { ts: '2026-06-10T12:05:00Z', '5h': 50 }, // logged June 10, no drop
  ];
  const june = monthBurnGrid(snaps, '5h', 2026, 5);
  assert.equal(june.filter(r => r.hasData).length, 1);
  assert.equal(june.find(r => r.hasData).hours.reduce((a, b) => a + b, 0), 0);
  assert.equal(monthBurnGrid(snaps, '5h', 2026, 4).filter(r => r.hasData).length, 0); // May: none
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `monthBurnGrid is not a function` (and the removed-test references are gone).

- [ ] **Step 3: Replace the implementation**

In `metrics.js`, replace the entire `dailyHourlyBurn` function (from `function dailyHourlyBurn(snapshots, win, days = 30) {` through its closing `}`) with:

```js
function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function monthBurnGrid(snapshots, win, year, month) {
  const pts = snapshots.filter(s => s && s[win] != null);

  const burnByDay = {};        // dayKey -> number[24]
  const hasDataKeys = new Set();
  for (const p of pts) {
    hasDataKeys.add(localDayKey(new Date(p.ts)));
  }
  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    const drop = pts[i - 1][win] - pts[i][win];
    if (drop > 0 && dt < ACTIVE_GAP_MAX) {
      const prev = new Date(pts[i - 1].ts);
      const key = localDayKey(prev);
      if (!burnByDay[key]) burnByDay[key] = new Array(24).fill(0);
      burnByDay[key][prev.getHours()] += drop;
    }
  }

  const rows = [];
  const n = daysInMonth(year, month);
  for (let day = 1; day <= n; day++) {
    const key = localDayKey(new Date(year, month, day));
    rows.push({
      date: key,
      hours: burnByDay[key] || new Array(24).fill(0),
      hasData: hasDataKeys.has(key),
    });
  }
  return rows;
}
```

Update the footer's `module.exports`: replace `dailyHourlyBurn` with `monthBurnGrid` (keep all other exports; `localDayKey` and `daysInMonth` stay private):

```js
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles, cycleStats, summarize, hourlyBurn, monthBurnGrid };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 15 tests (12 prior + 3 new).

- [ ] **Step 5: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): monthBurnGrid calendar-month grid; drop dailyHourlyBurn"
```

---

### Task 2: Month navigation in `analytics-renderer.js` + CSS

**Files:**
- Modify: `analytics-renderer.js`
- Modify: `analytics.html`

**Interfaces:**
- Consumes: `monthBurnGrid(entries, '5h', year, month)` (global from `metrics.js`); existing `fmtMonthDay`.
- Produces: `monthGridHtml(grid)`, `renderMonthSection()`, `stepMonth(delta)`; module state `monthEntries`, `displayYear`, `displayMonth`. `renderMonthHeatmap` and the `dailyHourlyBurn` call are removed.

- [ ] **Step 1: Add month state variables**

In `analytics-renderer.js`, just after the existing state line `let rowLimit       = 200;` (near the top), add:

```js
let monthEntries = [];
let displayYear = null;
let displayMonth = null;
```

- [ ] **Step 2: Update the `<summary>` text in `buildEffWindow`**

In `buildEffWindow`, change the `<details>` line so the summary no longer says "last 30 days". Replace:

```js
    ${win === '5h' ? `<details class="eff-month"><summary>Burn by hour — last 30 days</summary><div id="eff-month-5h"></div></details>` : ''}
```

with:

```js
    ${win === '5h' ? `<details class="eff-month"><summary>Burn by hour heatmap</summary><div id="eff-month-5h"></div></details>` : ''}
```

- [ ] **Step 3: Replace the month render in `renderEfficiency`**

In `renderEfficiency`, replace the single line:

```js
  renderMonthHeatmap(container.querySelector('#eff-month-5h'), dailyHourlyBurn(entries, '5h', 30));
```

with:

```js
  monthEntries = entries;
  const mpts = entries.filter(s => s && s['5h'] != null);
  if (mpts.length) {
    const last = new Date(mpts[mpts.length - 1].ts);
    displayYear = last.getFullYear();
    displayMonth = last.getMonth();
    renderMonthSection();
  } else {
    const monthEl = container.querySelector('#eff-month-5h');
    if (monthEl) monthEl.innerHTML = '<div class="empty">No data yet.</div>';
  }
```

- [ ] **Step 4: Replace `renderMonthHeatmap` with the section/grid/step functions**

In `analytics-renderer.js`, replace the entire `renderMonthHeatmap` function (from `function renderMonthHeatmap(el, grid) {` through its closing `}`) with the following three functions. Keep `fmtMonthDay` (defined just above it) as-is.

```js
function monthGridHtml(grid) {
  const max = Math.max(1, ...grid.flatMap(r => r.hours));

  const ruler = `<div class="month-row month-ruler"><span class="month-date"></span>${
    Array.from({ length: 24 }, (_, h) => `<span class="month-hcol">${h % 6 === 0 ? h : ''}</span>`).join('')
  }</div>`;

  const rows = [...grid].reverse().map(r => { // newest day on top
    const cells = r.hours.map((v, h) => {
      if (!r.hasData) return `<span class="heat-cell nodata" title="${r.date} — no data"></span>`;
      const a = (v / max).toFixed(2);
      return `<span class="heat-cell" title="${r.date} ${h}:00 — ${v.toFixed(0)}% burned" style="background:rgba(168,85,247,${a})"></span>`;
    }).join('');
    return `<div class="month-row${r.hasData ? '' : ' nodata-row'}"><span class="month-date">${fmtMonthDay(r.date)}</span>${cells}</div>`;
  }).join('');

  return `${ruler}${rows}`;
}

function stepMonth(delta) {
  const idx = displayYear * 12 + displayMonth + delta;
  displayYear = Math.floor(idx / 12);
  displayMonth = ((idx % 12) + 12) % 12;
  renderMonthSection();
}

function renderMonthSection() {
  const el = document.querySelector('#eff-month-5h');
  if (!el) return;

  const pts = monthEntries.filter(s => s && s['5h'] != null);
  if (!pts.length) { el.innerHTML = '<div class="empty">No data yet.</div>'; return; }

  const first = new Date(pts[0].ts), last = new Date(pts[pts.length - 1].ts);
  const earliestIdx = first.getFullYear() * 12 + first.getMonth();
  const latestIdx = last.getFullYear() * 12 + last.getMonth();
  const curIdx = displayYear * 12 + displayMonth;
  const canPrev = curIdx > earliestIdx;
  const canNext = curIdx < latestIdx;

  const label = new Date(displayYear, displayMonth, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const bar = `<div class="month-nav">
    <button class="month-btn month-prev"${canPrev ? '' : ' disabled'}>◀</button>
    <span class="month-label">${label}</span>
    <button class="month-btn month-next"${canNext ? '' : ' disabled'}>▶</button>
  </div>`;

  el.innerHTML = bar + monthGridHtml(monthBurnGrid(monthEntries, '5h', displayYear, displayMonth));

  const prev = el.querySelector('.month-prev');
  const next = el.querySelector('.month-next');
  if (prev) prev.addEventListener('click', () => stepMonth(-1));
  if (next) next.addEventListener('click', () => stepMonth(1));
}
```

- [ ] **Step 5: Add CSS for the navigation bar**

In `analytics.html`, add inside the existing `<style>` block, before `</style>`:

```css
.month-nav { display: flex; align-items: center; justify-content: flex-start; gap: 10px; margin: 6px 0 8px; }
.month-btn { background: rgba(168,85,247,0.15); color: var(--text-mid); border: none; border-radius: 4px; padding: 2px 9px; cursor: pointer; font-size: 12px; line-height: 1.4; }
.month-btn:hover:not(:disabled) { background: var(--accent-med); color: #fff; }
.month-btn:disabled { opacity: .3; cursor: default; }
.month-label { font-size: 12px; color: #fff; min-width: 110px; text-align: center; }
```

- [ ] **Step 6: Syntax-check and run tests**

Run: `node --check analytics-renderer.js && npm test`
Expected: `node --check` no output (exit 0); `npm test` shows 15 tests pass (metrics unchanged this task).

- [ ] **Step 7: Verify the wiring by reading**

Read back the edits and confirm: `renderMonthHeatmap` and `dailyHourlyBurn` no longer appear anywhere in `analytics-renderer.js` (grep them); `renderMonthSection` queries `#eff-month-5h` which `buildEffWindow` still emits for the 5h window only; `monthBurnGrid` is referenced as a global; `fmtMonthDay`, `--text-mid`, `--accent-med`, and `.heat-cell` all already exist. (The Electron GUI cannot be launched here — this read-back is the verification.)

- [ ] **Step 8: Commit**

```bash
git add analytics-renderer.js analytics.html
git commit -m "feat(analytics): month-by-month navigation for burn heatmap"
```

---

## Self-Review

**Spec coverage:**
- Calendar-month grid replacing rolling 30 days → `monthBurnGrid` (Task 1), `monthGridHtml` (Task 2). ✓
- `month` 0-based, pure, no `Date.now()` → inputs only; tests pass fixed year/month. ✓
- `dailyHourlyBurn` removed → deleted in Task 1, references removed in Task 2 (verified Step 7). ✓
- Default = latest logged month; ◀/▶ step months with year wrap → `renderEfficiency` sets state from latest snapshot; `stepMonth` (Task 2). ✓
- Bounds: ▶ disabled at/after latest month, ◀ at/before earliest → `canPrev`/`canNext` via `year*12+month`. ✓
- Empty/gap month → full month of `hasData:false` rows (metric) shows dimmed; account with zero data → "No data yet." (renderer). ✓
- Newest day on top; per-month normalization → `[...grid].reverse()`, `Math.max(1, ...grid.flatMap(...))`. ✓
- Summary text updated; 5h-only; profile row untouched → Step 2; `win === '5h'` guard retained; `renderHourHeatmap` untouched. ✓
- Reset month on each render / tab switch (not persisted) → state reset in `renderEfficiency`. ✓
- Reuse CSS vars + heatmap purple → Step 5 uses `--text-mid`/`--accent-med`; cells unchanged. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; test step shows assertions. ✓

**Type consistency:** `monthBurnGrid` returns `[{date, hours, hasData}]`, consumed by `monthGridHtml` (reads `r.hours`/`r.hasData`/`r.date`) and `renderMonthSection`; `fmtMonthDay` parses the `YYYY-MM-DD` `date`; the `#eff-month-5h` id matches between `buildEffWindow` emit and `renderMonthSection`/`renderEfficiency` queries; `stepMonth`/`renderMonthSection`/`monthGridHtml` names are consistent across calls. ✓
