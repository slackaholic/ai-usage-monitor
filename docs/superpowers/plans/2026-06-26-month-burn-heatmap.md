# Month Burn Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible day×hour burn heatmap for the last 30 days to the Efficiency section (5-hour window only), beneath the existing hour-of-day profile row.

**Architecture:** A new pure function `dailyHourlyBurn` in `metrics.js` buckets active consumption drops into (day, hour) cells for the last N days, derived from the snapshot log with no I/O. A new `renderMonthHeatmap` in `analytics-renderer.js` draws the grid into a `<details>` (collapsed by default) emitted only for the 5h window.

**Tech Stack:** Vanilla JS classic `<script>` files, Electron renderer (`nodeIntegration:false`), Node's built-in `node --test`. No new dependencies.

## Global Constraints

- **No new npm dependencies.** Tests use `node:test` / `node:assert`.
- **`metrics.js` must remain dual-load** (browser `<script>` globals AND `require`): keep the `if (typeof module !== 'undefined' && module.exports)` footer; no `import`/ESM; no top-level `require`.
- **`metrics.js` functions stay pure** — NO `Date.now()` / `new Date()` with no args inside the module (the window end is derived from the data's latest timestamp), so they remain deterministic and unit-testable.
- **No `main.js` / `preload.js` / IPC changes.**
- **Percentages only** — the log carries no absolute token counts.
- **5-hour window only** for the month grid; the existing 24-hour profile row stays in both windows, unchanged.
- **Collapsed by default** via native `<details>` (no `open` attribute); open/closed state is NOT persisted.
- **Reuse existing CSS variables** (`--text-mid`, etc.) and the existing heatmap purple `rgba(168,85,247,a)`.

---

### Task 1: `dailyHourlyBurn` in `metrics.js`

**Files:**
- Modify: `metrics.js`
- Modify: `test/metrics.test.js`

**Interfaces:**
- Consumes: `ACTIVE_GAP_MAX` (existing module constant).
- Produces: `dailyHourlyBurn(snapshots, win, days = 30) -> Array<{ date: 'YYYY-MM-DD', hours: number[24], hasData: boolean }>`. One row per local day for the last `days` days, chronological (oldest first), ending on the latest snapshot's local day. `hours[h]` = total % burned in local hour `h` that day, counting only positive drops with poll gap `< ACTIVE_GAP_MAX` (excludes idle gaps and resets). `hasData` = at least one snapshot (with `win` present) fell on that local day. Returns `[]` when no snapshot has the `win` field.

- [ ] **Step 1: Write the failing tests**

Append to `test/metrics.test.js`:

```js
const { dailyHourlyBurn } = require('../metrics.js');

test('dailyHourlyBurn buckets active drops per day, excludes idle gaps and resets', () => {
  const snaps = [
    { ts: '2026-06-10T12:00:00Z', '5h': 100 },
    { ts: '2026-06-10T12:05:00Z', '5h': 90 },  // active drop 10 (day A)
    { ts: '2026-06-12T12:00:00Z', '5h': 80 },  // 2-day gap → idle, excluded
    { ts: '2026-06-12T12:05:00Z', '5h': 70 },  // active drop 10 (day B)
    { ts: '2026-06-12T12:10:00Z', '5h': 100 }, // reset (negative) → excluded
  ];
  const grid = dailyHourlyBurn(snaps, '5h', 30);
  assert.equal(grid.length, 30);
  // TZ-independent: total burn across all rows/hours is the sum of the two active drops
  const total = grid.reduce((a, r) => a + r.hours.reduce((x, y) => x + y, 0), 0);
  assert.equal(total, 20);
  // exactly two distinct days carry burn
  const daysWithBurn = grid.filter(r => r.hours.some(v => v > 0)).length;
  assert.equal(daysWithBurn, 2);
});

test('dailyHourlyBurn marks hasData for logged days including zero-burn days', () => {
  const snaps = [
    { ts: '2026-06-10T12:00:00Z', '5h': 50 },
    { ts: '2026-06-10T12:05:00Z', '5h': 50 }, // same day, no drop
  ];
  const grid = dailyHourlyBurn(snaps, '5h', 30);
  assert.equal(grid.length, 30);
  assert.equal(grid.filter(r => r.hasData).length, 1);
  assert.equal(grid.filter(r => !r.hasData).length, 29);
  const logged = grid.find(r => r.hasData);
  assert.equal(logged.hours.reduce((a, b) => a + b, 0), 0); // logged but zero burn
});

test('dailyHourlyBurn honors the days argument and chronological order', () => {
  const snaps = [
    { ts: '2026-06-10T12:00:00Z', '5h': 100 },
    { ts: '2026-06-10T12:05:00Z', '5h': 90 },
  ];
  const grid = dailyHourlyBurn(snaps, '5h', 7);
  assert.equal(grid.length, 7);
  // oldest first: last row is the latest (anchor) day
  assert.equal(grid[grid.length - 1].hasData, true);
});

test('dailyHourlyBurn returns [] for empty input', () => {
  assert.deepEqual(dailyHourlyBurn([], '5h'), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `dailyHourlyBurn is not a function`.

- [ ] **Step 3: Add the implementation**

Insert into `metrics.js` immediately after the `hourlyBurn` function (before the footer):

```js
function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dailyHourlyBurn(snapshots, win, days = 30) {
  const pts = snapshots.filter(s => s && s[win] != null);
  if (pts.length === 0) return [];

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

  // Anchor on the local midnight of the latest snapshot's day (data-derived, not Date.now()).
  const last = new Date(pts[pts.length - 1].ts);
  const anchor = new Date(last.getFullYear(), last.getMonth(), last.getDate());

  const rows = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset);
    const key = localDayKey(d);
    rows.push({
      date: key,
      hours: burnByDay[key] || new Array(24).fill(0),
      hasData: hasDataKeys.has(key),
    });
  }
  return rows;
}
```

Update the footer's `module.exports` to add `dailyHourlyBurn`:

```js
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles, cycleStats, summarize, hourlyBurn, dailyHourlyBurn };
```

(Do NOT export `localDayKey` — it is a private helper, like `RESET_KEY`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests pass (existing 12 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): dailyHourlyBurn day-by-hour grid for last N days"
```

---

### Task 2: Month heatmap rendering, placement, and CSS

**Files:**
- Modify: `analytics-renderer.js` (add `fmtMonthDay`, `renderMonthHeatmap`; emit the `<details>` for 5h in `buildEffWindow`; wire in `renderEfficiency`)
- Modify: `analytics.html` (CSS for the month grid + `<details>` summary)

**Interfaces:**
- Consumes: `dailyHourlyBurn(entries, '5h', 30)` (global from `metrics.js`).
- Produces: `renderMonthHeatmap(el, grid)`; a collapsed `<details>` containing `#eff-month-5h`, filled on render.

- [ ] **Step 1: Add `fmtMonthDay` and `renderMonthHeatmap`**

In `analytics-renderer.js`, insert directly after `renderHourHeatmap` (it ends around line 608, with `el.innerHTML = ...; }`):

```js
function fmtMonthDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderMonthHeatmap(el, grid) {
  if (!el) return;
  if (!grid.length) { el.innerHTML = '<div class="empty">No data yet.</div>'; return; }

  const max = Math.max(1, ...grid.flatMap(r => r.hours));

  const ruler = `<div class="month-row month-ruler"><span class="month-date"></span>${
    Array.from({ length: 24 }, (_, h) => `<span class="month-hcol">${h % 6 === 0 ? h : ''}</span>`).join('')
  }</div>`;

  const rows = [...grid].reverse().map(r => { // newest first
    const cells = r.hours.map((v, h) => {
      if (!r.hasData) return `<span class="heat-cell nodata" title="${r.date} — no data"></span>`;
      const a = (v / max).toFixed(2);
      return `<span class="heat-cell" title="${r.date} ${h}:00 — ${v.toFixed(0)}% burned" style="background:rgba(168,85,247,${a})"></span>`;
    }).join('');
    return `<div class="month-row${r.hasData ? '' : ' nodata-row'}"><span class="month-date">${fmtMonthDay(r.date)}</span>${cells}</div>`;
  }).join('');

  el.innerHTML = `<div class="eff-cap">Burn by hour — last 30 days (newest first)</div>${ruler}${rows}`;
}
```

- [ ] **Step 2: Emit the collapsed `<details>` for the 5h window in `buildEffWindow`**

In `buildEffWindow`'s returned template (the block ending with the `#eff-heat-${win}` div, ~line 574), replace:

```js
    <div id="eff-heat-${win}" class="eff-heat"></div>
  `;
```

with:

```js
    <div id="eff-heat-${win}" class="eff-heat"></div>
    ${win === '5h' ? `<details class="eff-month"><summary>Burn by hour — last 30 days</summary><div id="eff-month-5h"></div></details>` : ''}
  `;
```

- [ ] **Step 3: Fill the month placeholder in `renderEfficiency`**

In `renderEfficiency`, after the existing `['5h','wk'].forEach(...)` loop (the loop ends with `});` ~line 586), add:

```js
  renderMonthHeatmap(container.querySelector('#eff-month-5h'), dailyHourlyBurn(entries, '5h', 30));
```

So `renderEfficiency` reads:

```js
function renderEfficiency(entries, container) {
  container.innerHTML = `<div class="section-head">Efficiency</div>`
    + ['5h', 'wk'].map(win => buildEffWindow(entries, win)).join('');

  ['5h', 'wk'].forEach(win => {
    const completed = segmentCycles(entries, win).slice(0, -1).map(c => cycleStats(c, win));
    renderPeakBars(container.querySelector(`#eff-peaks-${win}`), summarize(completed).peaks);
    renderHourHeatmap(container.querySelector(`#eff-heat-${win}`), hourlyBurn(entries, win));
  });

  renderMonthHeatmap(container.querySelector('#eff-month-5h'), dailyHourlyBurn(entries, '5h', 30));
}
```

- [ ] **Step 4: Add CSS for the month grid**

In `analytics.html`, add inside the existing `<style>` block, before `</style>`:

```css
.eff-month { margin: 8px 0 4px; }
.eff-month > summary { cursor: pointer; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-mid); padding: 4px 0; }
.month-row { display: flex; gap: 2px; align-items: center; margin-bottom: 2px; }
.month-date { flex: 0 0 44px; font-size: 9px; color: var(--text-mid); text-align: right; padding-right: 4px; }
.month-row .heat-cell { flex: 1; height: 12px; border-radius: 2px; }
.month-ruler .month-hcol { flex: 1; font-size: 8px; color: var(--text-mid); text-align: left; }
.heat-cell.nodata { background: transparent; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
.nodata-row .month-date { opacity: .4; }
```

- [ ] **Step 5: Syntax-check and run tests**

Run: `node --check analytics-renderer.js && npm test`
Expected: `node --check` produces no output (exit 0); `npm test` shows all tests pass (metrics unchanged this task).

- [ ] **Step 6: Verify the wiring by reading**

Confirm by reading your edits: the `<details>` emits `#eff-month-5h`; `renderMonthHeatmap` queries the same id; `dailyHourlyBurn` is a global from `metrics.js`; `.heat-cell` / `--text-mid` already exist in `analytics.html`; the weekly window emits NO month grid (the `win === '5h'` guard). (The GUI cannot be launched here; this read-back is the verification.)

- [ ] **Step 7: Commit**

```bash
git add analytics-renderer.js analytics.html
git commit -m "feat(analytics): collapsible last-30-days burn heatmap (5h window)"
```

---

## Self-Review

**Spec coverage:**
- Day×hour grid, last 30 days, 5h only → `dailyHourlyBurn` (Task 1) + `renderMonthHeatmap` 5h-only emit (Task 2). ✓
- Keep the 24-hour profile row in both windows → `renderHourHeatmap` untouched. ✓
- Rolling 30 days ending at latest logged day, newest row on top → anchor on latest snapshot; `[...grid].reverse()`. ✓
- `hasData` dimming distinct from zero-burn → `nodata`/`nodata-row` classes vs faint fill. ✓
- Global-max normalization; profile keeps own → `Math.max(1, ...grid.flatMap(r=>r.hours))`. ✓
- Collapsed by default, not persisted → `<details>` with no `open`. ✓
- Pure metric, no `Date.now()` → anchor derived from data; deterministic tests. ✓
- Dual-load preserved; `dailyHourlyBurn` exported, `localDayKey` private → footer update. ✓
- No new deps / no main.js changes → none. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows assertions. ✓

**Type consistency:** `dailyHourlyBurn` returns `[{date, hours, hasData}]`, consumed by `renderMonthHeatmap` (reads `r.hours`, `r.hasData`, `r.date`); `fmtMonthDay` parses the `YYYY-MM-DD` `date`; placeholder id `eff-month-5h` matches between `buildEffWindow` emit and `renderEfficiency` query. ✓
