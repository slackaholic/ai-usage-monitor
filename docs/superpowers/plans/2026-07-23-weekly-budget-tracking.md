# Weekly Budget Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track a weekly-quota budget (a target % of the weekly meter per 5h window and per day) across all three accounts, shown as a threshold marker on each 5h gauge plus budget readouts in the main and analytics windows.

**Architecture:** Three pure functions in `metrics.js` derive the account's weekly↔5h burn ratio, the 5h-equivalent allowance, and today's weekly burn. One mtime-cached `get-budget-info` IPC in `main.js` reads `usage-log.jsonl` once and returns `{ratio, dayWeeklyBurnPct}` per account. The renderer draws a marker + note; analytics renders two cards; Settings holds the targets.

**Tech Stack:** Electron (main/preload/renderers), vanilla JS, Node built-in `node --test`. No new dependencies.

## Global Constraints

- No new dependencies.
- `metrics.js` purity: no `Date.now()`, no argless `new Date()` (`new Date(isoString)` is fine), pure functions only. The "today" boundary is always a **parameter**.
- `metrics.js` is dual-loaded: every new function must be added to the CommonJS export footer AND work as a browser global.
- Settings key is exactly `budgetTargets: { window, day }`; defaults **window 10**, **day 20**.
- Ratio constant: `MIN_RATIO_EVIDENCE_PCT = 20` (total 5h burn required before a ratio is trusted; below it, return `null`).
- `fiveHourAllowancePct` clamps to `[0,100]`.
- Colour rule, used identically in the main-window note and the analytics cards: within target → normal/green; up to **1.5×** target → amber; above 1.5× → red. A `null` ratio → "need more history" / `—`, never a guessed value.
- Account key mapping (already in `renderer.js:96`): `{ codex: 'codex', claude: 'claude-desktop', claude2: 'claude-vscode' }`.
- `metrics.js` and `renderer.js` have **no** top-level name collisions (verified) — loading both as classic scripts in `index.html` is safe.
- `main.js`, `renderer.js`, `settings-renderer.js` cannot be unit-tested (Electron entrypoint / top-level DOM side effects). Do NOT add tests that load them; verify with `node --check` + suite + manual GUI.

---

### Task 1: metrics.js — ratio, allowance, and day-burn functions

**Files:**
- Modify: `metrics.js` — add three functions + one constant, and extend the export footer.
- Test: `test/metrics.test.js` — add tests near the other pure-function tests.

**Interfaces:**
- Consumes: existing module constant `ACTIVE_GAP_MAX` (= `15 * 60_000`).
- Produces (used by Tasks 2, 4, 5):
  - `weeklyPerFiveHourRatio(snapshots) → number|null`
  - `fiveHourAllowancePct(targetWeeklyPct, ratio) → number|null` (clamped [0,100])
  - `weeklyBurnSince(snapshots, sinceMs) → number`
  - `MIN_RATIO_EVIDENCE_PCT` (= 20)

- [ ] **Step 1: Write the failing tests**

Add to `test/metrics.test.js`. Import the new names by extending the existing `require('../metrics.js')` destructuring at the top of the file (add `weeklyPerFiveHourRatio, fiveHourAllowancePct, weeklyBurnSince`).

```js
test('weeklyPerFiveHourRatio: aggregates active drops into a wk-per-5h ratio', () => {
  // 5h drops 10 + 15 = 25 (>= MIN_RATIO_EVIDENCE_PCT); wk drops 2 + 3 = 5 → 0.2
  const snaps = [
    { ts: '2026-07-20T08:00:00Z', '5h': 100, wk: 100 },
    { ts: '2026-07-20T08:05:00Z', '5h': 90,  wk: 98 },
    { ts: '2026-07-20T08:10:00Z', '5h': 75,  wk: 95 },
  ];
  assert.equal(weeklyPerFiveHourRatio(snaps), 0.2);
});

test('weeklyPerFiveHourRatio: ignores idle gaps and resets', () => {
  const snaps = [
    { ts: '2026-07-20T08:00:00Z', '5h': 100, wk: 100 },
    { ts: '2026-07-20T08:05:00Z', '5h': 90,  wk: 98 },  // active: 10 / 2
    { ts: '2026-07-20T08:10:00Z', '5h': 75,  wk: 95 },  // active: 15 / 3
    { ts: '2026-07-20T08:40:00Z', '5h': 60,  wk: 92 },  // 30m gap >= ACTIVE_GAP_MAX → excluded
    { ts: '2026-07-20T08:45:00Z', '5h': 100, wk: 100 }, // reset (negative drop) → excluded
  ];
  assert.equal(weeklyPerFiveHourRatio(snaps), 0.2);
});

test('weeklyPerFiveHourRatio: returns null below the evidence floor', () => {
  const snaps = [
    { ts: '2026-07-20T08:00:00Z', '5h': 100, wk: 100 },
    { ts: '2026-07-20T08:05:00Z', '5h': 90,  wk: 98 }, // only 10% of 5h burn < 20
  ];
  assert.equal(weeklyPerFiveHourRatio(snaps), null);
  assert.equal(weeklyPerFiveHourRatio([]), null);
});

test('fiveHourAllowancePct: converts a weekly target into 5h-window %, clamped to 100', () => {
  const v = fiveHourAllowancePct(10, 0.1932);          // measured real-log ratio
  assert.ok(Math.abs(v - 51.76) < 0.1, `got ${v}`);    // 10 / 0.1932
  assert.equal(fiveHourAllowancePct(10, 0.05), 100);   // would be 200 → clamped
  assert.equal(fiveHourAllowancePct(10, 0), null);
  assert.equal(fiveHourAllowancePct(10, null), null);
  assert.equal(fiveHourAllowancePct(0, 0.2), null);
});

test('weeklyBurnSince: sums only active weekly drops at or after the boundary', () => {
  const since = Date.parse('2026-07-20T00:00:00Z');
  const snaps = [
    { ts: '2026-07-19T22:00:00Z', wk: 100 },
    { ts: '2026-07-19T22:05:00Z', wk: 97 },  // before boundary → excluded
    { ts: '2026-07-20T08:00:00Z', wk: 95 },  // 3h gap → idle, excluded
    { ts: '2026-07-20T08:05:00Z', wk: 93 },  // active: 2
    { ts: '2026-07-20T08:10:00Z', wk: 90 },  // active: 3
  ];
  assert.equal(weeklyBurnSince(snaps, since), 5);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: the five new tests FAIL (`weeklyPerFiveHourRatio is not a function`, etc.).

- [ ] **Step 3: Implement the three functions**

In `metrics.js`, insert after the `weeklyRunway` function (immediately before `function hourlyBurn`):

```js
// Minimum total 5h burn (in percentage points) before a measured ratio is trusted.
const MIN_RATIO_EVIDENCE_PCT = 20;

// Aggregate weekly-% burned per 1% of 5h burned, from ACTIVE drops only
// (positive drop, gap < ACTIVE_GAP_MAX) — excludes resets and idle gaps.
// Returns null when the evidence is too thin to trust.
function weeklyPerFiveHourRatio(snapshots) {
  let sum5h = 0, sumWk = 0;
  const pts = (snapshots || []).filter(s => s && s['5h'] != null && s.wk != null);
  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    if (!(dt > 0) || dt >= ACTIVE_GAP_MAX) continue;
    const d5 = pts[i - 1]['5h'] - pts[i]['5h'];
    const dw = pts[i - 1].wk - pts[i].wk;
    if (d5 > 0) sum5h += d5;
    if (dw > 0) sumWk += dw;
  }
  if (sum5h < MIN_RATIO_EVIDENCE_PCT || sumWk <= 0) return null;
  return sumWk / sum5h;
}

// How much of a 5h window a weekly-% target is worth. Clamped to [0,100]: a low
// ratio can imply >100%, meaning a whole window fits inside the weekly budget.
function fiveHourAllowancePct(targetWeeklyPct, ratio) {
  if (!(ratio > 0) || !(targetWeeklyPct > 0)) return null;
  return Math.max(0, Math.min(100, targetWeeklyPct / ratio));
}

// Weekly % burned since a timestamp (active drops only). sinceMs is a parameter
// so this module never reads the clock.
function weeklyBurnSince(snapshots, sinceMs) {
  let sum = 0;
  const pts = (snapshots || []).filter(s => s && s.wk != null);
  for (let i = 1; i < pts.length; i++) {
    const t = new Date(pts[i].ts).getTime();
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    if (!(dt > 0) || dt >= ACTIVE_GAP_MAX) continue;
    const dw = pts[i - 1].wk - pts[i].wk;
    if (dw > 0) sum += dw;
  }
  return sum;
}
```

Then extend the CommonJS export footer at the bottom of `metrics.js` — add these four names to the existing `module.exports = { ... }` object:

```js
MIN_RATIO_EVIDENCE_PCT, weeklyPerFiveHourRatio, fiveHourAllowancePct, weeklyBurnSince,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `not ok`; `# fail 0`; test count is 62 + 5 = **67**.

- [ ] **Step 5: Syntax-check and commit**

Run: `node --check metrics.js`
Expected: no output.

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): weekly/5h burn ratio, allowance, and day-burn helpers

Adds weeklyPerFiveHourRatio (aggregate wk% per 1% of 5h burn from active drops),
fiveHourAllowancePct (weekly target -> 5h-window %, clamped [0,100]) and
weeklyBurnSince (weekly % burned since a caller-supplied boundary). Pure; the
day boundary is a parameter so metrics.js still never reads the clock."
```

---

### Task 2: main.js + preload.js — `get-budget-info` IPC

**Files:**
- Modify: `main.js` — add a require, an mtime-cached grouped log read, and the IPC handler.
- Modify: `preload.js` — expose `getBudgetInfo`.

**Interfaces:**
- Consumes (Task 1): `weeklyPerFiveHourRatio(snapshots)`, `weeklyBurnSince(snapshots, sinceMs)`; existing `USAGE_LOG_PATH` (`main.js:19`).
- Produces (used by Tasks 4, 5): IPC `get-budget-info` returning
  `{ 'codex': {ratio, dayWeeklyBurnPct}, 'claude-desktop': {...}, 'claude-vscode': {...} }`
  where `ratio` is `number|null` and `dayWeeklyBurnPct` is a number.
  Renderer API: `window.electronAPI.getBudgetInfo()`.

- [ ] **Step 1: Add the require in main.js**

Near the top of `main.js`, alongside the existing `require` statements (after the `USAGE_LOG_PATH` definition on line 19 is fine), add:

```js
const { weeklyPerFiveHourRatio, weeklyBurnSince } = require('./metrics.js');
```

- [ ] **Step 2: Add the cached read + IPC handler**

In `main.js`, insert immediately after the existing `ipcMain.handle('read-usage-log', ...)` block (which ends around line 46):

```js
// ── Budget info ───────────────────────────────────────────────────────────
// read-usage-log parses the WHOLE log on every call, so budget data gets its own
// mtime-cached read: one parse shared by all accounts, re-done only on change.
const BUDGET_ACCOUNTS = ['codex', 'claude-desktop', 'claude-vscode'];
let _budgetCache = { mtimeMs: -1, byAccount: null };

function readUsageLogGrouped() {
  let st;
  try { st = fs.statSync(USAGE_LOG_PATH); } catch { return null; }
  if (_budgetCache.byAccount && _budgetCache.mtimeMs === st.mtimeMs) return _budgetCache.byAccount;
  let entries;
  try {
    entries = fs.readFileSync(USAGE_LOG_PATH, 'utf8').trim().split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return null; }
  const byAccount = {};
  for (const a of BUDGET_ACCOUNTS) byAccount[a] = [];
  for (const e of entries) if (byAccount[e.account]) byAccount[e.account].push(e);
  _budgetCache = { mtimeMs: st.mtimeMs, byAccount };
  return byAccount;
}

ipcMain.handle('get-budget-info', () => {
  const byAccount = readUsageLogGrouped();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();
  const out = {};
  for (const a of BUDGET_ACCOUNTS) {
    const snaps = (byAccount && byAccount[a]) || [];
    out[a] = {
      ratio: weeklyPerFiveHourRatio(snaps),
      dayWeeklyBurnPct: weeklyBurnSince(snaps, midnightMs),
    };
  }
  return out;
});
```

- [ ] **Step 3: Expose it in preload.js**

In `preload.js`, inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, next to the existing `readUsageLog` entry (line 41), add:

```js
  getBudgetInfo: () => ipcRenderer.invoke('get-budget-info'),
```

- [ ] **Step 4: Syntax-check and verify the suite is untouched**

Run: `node --check main.js && node --check preload.js && npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `node --check` output; `# tests 67`, `# pass 67`, `# fail 0` (no logic module changed by this task).

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat(main): get-budget-info IPC with mtime-cached log read

Returns {ratio, dayWeeklyBurnPct} per account from a single parse of
usage-log.jsonl, cached on mtime. Local midnight is computed here and passed
into the pure weeklyBurnSince, keeping metrics.js clock-free."
```

---

### Task 3: Settings — weekly budget targets

**Files:**
- Modify: `settings.html` — new "Weekly budget" section.
- Modify: `settings-renderer.js` — defaults, load, save, listeners.

**Interfaces:**
- Produces (used by Tasks 4, 5): settings key `budgetTargets: { window: number, day: number }`, defaults `{ window: 10, day: 20 }`.

- [ ] **Step 1: Add the settings section**

In `settings.html`, insert this block immediately after the "Plan capacity multiplier" section's closing `</div>` (that section ends around line 71):

```html
  <div class="section">
    <div class="section-title">Weekly budget</div>
    <div class="row"><label>Per 5h window</label><input type="number" id="budget-window" min="0.1" step="0.1" value="10"><span class="suffix">% wk</span></div>
    <div class="row"><label>Per day</label><input type="number" id="budget-day" min="0.1" step="0.1" value="20"><span class="suffix">% wk</span></div>
    <div class="note">How much of the <b>weekly</b> quota you intend to spend per 5h window and per day. Drives the budget marker on the 5h bars and the Analytics budget cards. Defaults (10% / 20%) give a 5-day week of two windows per day.</div>
  </div>
```

- [ ] **Step 2: Add defaults and loading**

In `settings-renderer.js`, add after the `MULT_DEFAULTS` line near the top:

```js
const BUDGET_DEFAULTS = { window: 10, day: 20 };
```

And inside `loadSettings()`, after the `planMultipliers` block (the `ACCOUNTS.forEach(... 'mult-' ...)` line), add:

```js
  const bt = s.budgetTargets || {};
  document.getElementById('budget-window').value = bt.window != null ? bt.window : BUDGET_DEFAULTS.window;
  document.getElementById('budget-day').value    = bt.day    != null ? bt.day    : BUDGET_DEFAULTS.day;
```

- [ ] **Step 3: Add the save function and listeners**

In `settings-renderer.js`, add after `savePlanMultipliers()`:

```js
function saveBudgetTargets() {
  const win = parseFloat(document.getElementById('budget-window').value);
  const day = parseFloat(document.getElementById('budget-day').value);
  window.electronAPI.saveSettings({
    budgetTargets: {
      window: (isFinite(win) && win > 0) ? win : BUDGET_DEFAULTS.window,
      day:    (isFinite(day) && day > 0) ? day : BUDGET_DEFAULTS.day,
    },
  });
}
```

And next to the existing multiplier listener line
(`ACCOUNTS.forEach(a => document.getElementById('mult-' + a).addEventListener('change', savePlanMultipliers));`) add:

```js
['budget-window', 'budget-day'].forEach(id =>
  document.getElementById(id).addEventListener('change', saveBudgetTargets));
```

- [ ] **Step 4: Syntax-check, suite, commit**

Run: `node --check settings-renderer.js && npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no output from `node --check`; `# tests 67`, `# pass 67`, `# fail 0`.

```bash
git add settings.html settings-renderer.js
git commit -m "feat(settings): weekly budget targets (per window, per day)

Adds budgetTargets {window, day} (defaults 10% / 20% of the weekly quota),
following the existing plan-multiplier settings pattern."
```

---

### Task 4: Main window — gauge marker + budget note

**Files:**
- Modify: `index.html` — load `metrics.js`; `.progress-track` positioning + marker/note CSS; marker and note elements for all three accounts.
- Modify: `renderer.js` — budget state, `renderBudget`, refresh wiring.

**Interfaces:**
- Consumes: `fiveHourAllowancePct(target, ratio)` (Task 1, browser global), `window.electronAPI.getBudgetInfo()` (Task 2), settings `budgetTargets` (Task 3), existing `LOG_ACCOUNT` map (`renderer.js:96`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Load metrics.js in index.html**

Change the script tag at the bottom of `index.html` (line 611) from:

```html
<script src="renderer.js"></script>
```

to:

```html
<script src="metrics.js"></script>
<script src="renderer.js"></script>
```

(`metrics.js` and `renderer.js` have no top-level name collisions — verified — and `metrics.js` already guards its CommonJS export for browser use.)

- [ ] **Step 2: Add CSS**

In `index.html`, change the existing progress-bar rule (line ~195) from:

```css
    .progress-track { height: 3px; background: var(--border); border-radius: 2px; }
```

to:

```css
    .progress-track { height: 3px; background: var(--border); border-radius: 2px; position: relative; }
    .budget-marker {
      position: absolute; top: -2px; bottom: -2px; width: 2px;
      background: var(--text-mid); border-radius: 1px; pointer-events: none;
    }
    .budget-note { font-size: 9px; color: var(--text-muted); margin-top: 3px; }
    .budget-note.over    { color: var(--badge-warn-text); }
    .budget-note.wayover { color: var(--badge-err-text); }
```

- [ ] **Step 3: Add marker + note elements for all three accounts**

For **each** account, add a `budget-marker` div inside the 5h `.progress-track`, and a `budget-note` div after the weekly track's closing `</div>`. Use these exact ids.

Codex (5h bar at line ~410, weekly at ~413):

```html
        <div class="progress-track" style="margin-bottom:3px">
          <div class="progress-fill" id="codex-5h-bar" style="width:0%;background:linear-gradient(90deg,#059669,#34d399)"></div>
          <div class="budget-marker" id="codex-5h-budget" style="display:none"></div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" id="codex-wk-bar" style="width:0%;background:linear-gradient(90deg,#dc2626,#f87171)"></div>
        </div>
        <div class="budget-note" id="codex-budget-note"></div>
```

Claude Desktop (5h bar at line ~493):

```html
        <div class="progress-track" style="margin-bottom:3px">
          <div class="progress-fill" id="claude-5h-bar" style="width:0%;background:linear-gradient(90deg,#059669,#34d399)"></div>
          <div class="budget-marker" id="claude-5h-budget" style="display:none"></div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" id="claude-wk-bar" style="width:0%;background:linear-gradient(90deg,#dc2626,#f87171)"></div>
        </div>
        <div class="budget-note" id="claude-budget-note"></div>
```

Claude Code (5h bar at line ~572):

```html
        <div class="progress-track" style="margin-bottom:3px">
          <div class="progress-fill" id="claude2-5h-bar" style="width:0%;background:linear-gradient(90deg,#059669,#34d399)"></div>
          <div class="budget-marker" id="claude2-5h-budget" style="display:none"></div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" id="claude2-wk-bar" style="width:0%;background:linear-gradient(90deg,#dc2626,#f87171)"></div>
        </div>
        <div class="budget-note" id="claude2-budget-note"></div>
```

- [ ] **Step 4: Add budget state and `renderBudget` to renderer.js**

In `renderer.js`, add near the other module-level state (just after the `LOG_ACCOUNT` definition at line 96):

```js
let budgetInfo = {};
let budgetTargets = { window: 10, day: 20 };
const lastPct5h = { codex: null, claude: null, claude2: null };
```

And add this function next to `renderStat` (after it, around line 572):

```js
// Budget marker + note for one account. `pct5h` is the current 5h REMAINING %.
function renderBudget(prefix, pct5h) {
  if (pct5h != null) lastPct5h[prefix] = pct5h;
  const pct    = lastPct5h[prefix];
  const marker = document.getElementById(prefix + '-5h-budget');
  const note   = document.getElementById(prefix + '-budget-note');
  const info   = budgetInfo[LOG_ACCOUNT[prefix]] || {};
  const ratio  = info.ratio;
  const allowance = fiveHourAllowancePct(budgetTargets.window, ratio);

  if (marker) {
    if (allowance != null) {
      marker.style.left = (100 - allowance) + '%';
      marker.style.display = '';
    } else {
      marker.style.display = 'none';
    }
  }
  if (!note) return;
  if (ratio == null || pct == null) {
    note.textContent = 'budget: need more history';
    note.className = 'budget-note';
    return;
  }
  const wkEquiv = (100 - pct) * ratio;
  const day     = info.dayWeeklyBurnPct || 0;
  const level   = (v, t) => (v <= t ? 0 : v <= t * 1.5 ? 1 : 2);
  const worst   = Math.max(level(wkEquiv, budgetTargets.window), level(day, budgetTargets.day));
  note.textContent = `${wkEquiv.toFixed(1)}% / ${budgetTargets.window}% wk this window · today ${day.toFixed(1)}% / ${budgetTargets.day}%`;
  note.className = 'budget-note' + (worst === 1 ? ' over' : worst === 2 ? ' wayover' : '');
}
```

- [ ] **Step 5: Add the budget refresh and call it**

In `renderer.js`, add this function immediately after `renderBudget`:

```js
// Pull fresh budget info + targets, then repaint all three accounts' budget UI.
async function refreshBudget() {
  try {
    budgetInfo = (await window.electronAPI.getBudgetInfo()) || {};
    const s = (await window.electronAPI.getSettings()) || {};
    const bt = s.budgetTargets || {};
    budgetTargets = {
      window: (bt.window > 0) ? bt.window : 10,
      day:    (bt.day    > 0) ? bt.day    : 20,
    };
  } catch { /* leave previous values */ }
  ['codex', 'claude', 'claude2'].forEach(p => renderBudget(p, null));
}
```

Wire it in three places:

1. In `renderCodexData`, after `renderStat('codex', 'wk', parsed.sharedWeek);` add:
   ```js
   renderBudget('codex', parsed.shared5h);
   ```
2. In `renderClaudeWebData`, after `renderStat('claude', 'wk', remainingWk);` add:
   ```js
   renderBudget('claude', remaining5h);
   ```
3. In `renderClaudeCodeApiData`, after `renderStat('claude2', 'wk', data.pct7d);` add:
   ```js
   renderBudget('claude2', data.pct5h);
   ```

Then call `refreshBudget()` on startup and each refresh cycle: in the init block where the three fetches are kicked off (around line 1087, `fetchClaudeWebUsage(); fetchClaudeWebUsage2(); fetchCodexUsage();`), add after them:

```js
  refreshBudget();
```

And inside the existing `window.electronAPI.onSettingsChanged(async () => { ... })` handler (around line 1093), add as the last statement inside the `try` block:

```js
      refreshBudget();
```

- [ ] **Step 6: Syntax-check, suite, commit**

Run: `node --check renderer.js && npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `node --check` output; `# tests 67`, `# pass 67`, `# fail 0`.

```bash
git add index.html renderer.js
git commit -m "feat(main-window): weekly-budget marker on 5h bars + budget note

Loads metrics.js in the main window, draws a threshold marker on each 5h track
at (100 - allowance) remaining, and shows a per-window/per-day weekly-budget
note coloured green/amber/red. Falls back to 'need more history' when an
account has too little data for a trustworthy ratio."
```

---

### Task 5: Analytics — Window Budget and Today's Budget cards

**Files:**
- Modify: `analytics-renderer.js` — accept budget info in `renderStats`, add two cards, fetch info in `renderAll`.
- Test: `test/analytics-renderer.test.js` — cover both cards and the null-ratio state.

**Interfaces:**
- Consumes: `fiveHourAllowancePct` is NOT needed here; uses `info.ratio` and `info.dayWeeklyBurnPct` from `getBudgetInfo()` (Task 2) and `settings.budgetTargets` (Task 3).
- `renderStats(entries, container, settings = {}, budget = {})` — the new fourth parameter is `{ ratio, dayWeeklyBurnPct }` for the currently-displayed account.

- [ ] **Step 1: Write the failing tests**

Add to `test/analytics-renderer.test.js` (the `loadStatsRenderer` harness already exists):

```js
test('renderStats shows Window Budget and Today Budget cards from the budget ratio', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  const entries = [
    { ts: '2026-07-20T08:00:00Z', '5h': 90, wk: 72.1, reset7dTs: Date.parse('2026-07-21T08:00:00Z') },
    { ts: '2026-07-20T08:30:00Z', '5h': 60, wk: 70,   reset7dTs: Date.parse('2026-07-21T08:00:00Z') },
  ];
  // 5h remaining 60 → 40% burned; ratio 0.2 → 8.0% weekly-equivalent this window.
  renderStats(entries, container, { budgetTargets: { window: 10, day: 20 } },
              { ratio: 0.2, dayWeeklyBurnPct: 12.5 });

  assert.match(container.innerHTML, /Window Budget/);
  assert.match(container.innerHTML, /8\.0% \/ 10%/);
  assert.match(container.innerHTML, /Today.s Budget/);
  assert.match(container.innerHTML, /12\.5% \/ 20%/);
});

test('renderStats budget cards show em-dash when the ratio is unknown', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  const entries = [
    { ts: '2026-07-20T08:00:00Z', '5h': 90, wk: 72.1 },
    { ts: '2026-07-20T08:30:00Z', '5h': 60, wk: 70 },
  ];
  renderStats(entries, container, {}, { ratio: null, dayWeeklyBurnPct: 0 });

  assert.match(container.innerHTML, /Window Budget/);
  assert.match(container.innerHTML, /need more history/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: the two new tests FAIL (no `Window Budget` card rendered).

- [ ] **Step 3: Add the cards to renderStats**

In `analytics-renderer.js`, change the `renderStats` signature from:

```js
function renderStats(entries, container, settings = {}) {
```

to:

```js
function renderStats(entries, container, settings = {}, budget = {}) {
```

Then, immediately before the `const runwayCards = ...` assignment, add:

```js
  // ── Weekly budget ───────────────────────────────────────────────────────
  const bt = (settings && settings.budgetTargets) || {};
  const budgetWindowTarget = bt.window > 0 ? bt.window : 10;
  const budgetDayTarget    = bt.day    > 0 ? bt.day    : 20;
  const budgetRatio = budget && budget.ratio;
  const budgetLevel = (v, t) => (v <= t ? '' : v <= t * 1.5 ? 'amber' : 'red');
  let windowBudgetCard, dayBudgetCard;
  if (!(budgetRatio > 0) || last['5h'] == null) {
    windowBudgetCard = { label: 'Window Budget', value: '—', sub: 'need more history', cls: 'dim' };
    dayBudgetCard    = { label: "Today's Budget", value: '—', sub: 'need more history', cls: 'dim' };
  } else {
    const wkEquiv = (100 - last['5h']) * budgetRatio;
    const dayBurn = budget.dayWeeklyBurnPct || 0;
    windowBudgetCard = {
      label: 'Window Budget',
      value: `${wkEquiv.toFixed(1)}% / ${budgetWindowTarget}%`,
      sub: 'weekly-equivalent burn this window',
      cls: budgetLevel(wkEquiv, budgetWindowTarget),
    };
    dayBudgetCard = {
      label: "Today's Budget",
      value: `${dayBurn.toFixed(1)}% / ${budgetDayTarget}%`,
      sub: 'weekly burn today',
      cls: budgetLevel(dayBurn, budgetDayTarget),
    };
  }
```

Then append both cards to the runway card list. Change the `const runwayCards = !runwayHasProjection ? [ ... ] : [ ... ];` statement so that both branches end with the two new cards — the simplest way is to leave the ternary as-is and add, immediately after it:

```js
  runwayCards.push(windowBudgetCard, dayBudgetCard);
```

(`runwayCards` is declared with `const` but is an array — `push` is valid.)

- [ ] **Step 4: Pass budget info in from renderAll**

In `analytics-renderer.js`'s `renderAll`, where `_cur` is fetched (around line 1023), add a budget fetch next to it:

```js
  const _budgetAll = (await window.electronAPI.getBudgetInfo().catch(() => ({}))) || {};
  const _budget = _budgetAll[currentAccount] || {};
```

and change the `renderStats` call (around line 1064) from:

```js
  renderStats(entries, statsEl, _cur);
```

to:

```js
  renderStats(entries, statsEl, _cur, _budget);
```

`currentAccount` is already the log account key (`codex` / `claude-desktop` / `claude-vscode`), matching the IPC's keys.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `not ok`; `# tests 69`, `# pass 69`, `# fail 0`.

- [ ] **Step 6: Syntax-check and commit**

Run: `node --check analytics-renderer.js`
Expected: no output.

```bash
git add analytics-renderer.js test/analytics-renderer.test.js
git commit -m "feat(analytics): Window Budget and Today's Budget cards

Shows this window's weekly-equivalent burn and today's weekly burn against the
configured targets, using the per-account ratio from get-budget-info. Falls back
to an em-dash 'need more history' state when the ratio is unknown."
```

- [ ] **Step 7: Note the manual verification for the controller/user**

`main.js`, `renderer.js` and `settings-renderer.js` are not unit-testable. After
merge the user confirms: a marker appears on each 5h bar (Claude Code's near
~48% remaining for a 10% target); the note reads e.g.
`6.4% / 10% wk this window · today 12.1% / 20%` and turns amber/red when over;
the analytics window shows both budget cards; changing the Settings targets
moves the marker and updates the cards.

---

## Self-Review

**1. Spec coverage:** metrics functions (spec §"metrics.js") → Task 1. `get-budget-info` IPC + preload (spec §"main.js") → Task 2. Settings targets (spec §"Settings") → Task 3. Gauge marker + note (spec §"Main window") → Task 4. Analytics cards (spec §"Analytics") → Task 5. Edge handling (null ratio, allowance ≥100 clamp, null `pct5h`, unreadable log) is covered by `fiveHourAllowancePct`'s clamp/null returns (Task 1), the `readUsageLogGrouped` null path (Task 2), and the "need more history" branches (Tasks 4, 5). Testing strategy → Task 1 Steps 1-4, Task 5 Steps 1-5, and the manual note in Task 5 Step 7. Full coverage. ✅

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code with exact ids, selectors, and insertion anchors. Exact commands with expected test counts (62 → 67 after Task 1, → 69 after Task 5). ✅

**3. Type consistency:** `weeklyPerFiveHourRatio` returns `number|null` and every consumer guards with `> 0` (Task 2 passes it straight through; Tasks 4/5 check `ratio == null` / `!(budgetRatio > 0)`). `fiveHourAllowancePct(target, ratio)` argument order is identical in Task 1's definition and Task 4's call. `weeklyBurnSince(snapshots, sinceMs)` takes ms — Task 2 passes `midnight.getTime()`. The IPC's account keys (`codex`/`claude-desktop`/`claude-vscode`) match `LOG_ACCOUNT`'s values (Task 4) and `currentAccount` (Task 5). Settings key `budgetTargets:{window,day}` is written in Task 3 and read identically in Tasks 4 and 5, with the same 10/20 fallbacks. The colour rule (`≤t` / `≤1.5t` / above) is identical in Task 4's `level` and Task 5's `budgetLevel`. ✅
