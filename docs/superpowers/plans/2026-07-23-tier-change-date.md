# Tier-Change Date Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user declare the date an account's plan/tier changed, so the weekly-budget ratio is computed only from data recorded after that date.

**Architecture:** `weeklyPerFiveHourRatio` gains an optional `sinceMs` cutoff. `main.js` reads the declared date from settings, converts it to local-midnight ms, passes it in, and returns it in the IPC payload. Settings gets a date input + "Today" button per account in the Subscriptions section. Both renderers use the returned date to say "need more history since tier change" instead of the generic message.

**Tech Stack:** Electron (main/renderers), vanilla JS, Node built-in `node --test`. No new dependencies.

## Global Constraints

- No new dependencies.
- `metrics.js` purity: no `Date.now()`, no argless `new Date()` (`new Date(isoString)` and `new Date(a) - new Date(b)` are fine). Date strings from settings are parsed in `main.js`, never in `metrics.js`.
- `weeklyPerFiveHourRatio`'s new `sinceMs` parameter is **optional**: omitted or non-finite ⇒ no filtering, identical behaviour to today. Existing callers and tests must not change.
- The paired-reset gating (`if (d5 < 0 || dw < 0) continue;`) and `MIN_RATIO_EVIDENCE_PCT = 20` are unchanged.
- Settings key is exactly `tierChangedAt: { '<account>': 'YYYY-MM-DD' }`; blank/absent ⇒ no cutoff. Account keys are `codex`, `claude-desktop`, `claude-vscode`.
- The IPC payload becomes `{ ratio, dayWeeklyBurnPct, tierChangedAt }` where `tierChangedAt` is epoch ms or `null`.
- Message text is exactly `need more history since tier change` (with a tier date set) vs the existing `need more history` (without). The main-window note prefixes it with `budget: ` as it already does.
- Cutoff applies to the **ratio only** — `weeklyBurnSince`, peaks, heatmaps, cost and usage-period history are untouched.
- `main.js`, `renderer.js`, `settings-renderer.js` cannot be unit-tested. Do NOT add tests loading them; verify with `node --check` + suite + manual GUI.
- Suite is currently **70** tests.

---

### Task 1: metrics.js — optional `sinceMs` cutoff on the ratio

**Files:**
- Modify: `metrics.js` — `weeklyPerFiveHourRatio`.
- Test: `test/metrics.test.js`.

**Interfaces:**
- Produces (used by Task 2): `weeklyPerFiveHourRatio(snapshots, sinceMs?) → number|null`. When `sinceMs` is a finite number, intervals whose later point is before it are skipped; otherwise no filtering.

- [ ] **Step 1: Write the failing tests**

Add to `test/metrics.test.js`, next to the existing `weeklyPerFiveHourRatio` tests:

```js
test('weeklyPerFiveHourRatio: sinceMs cutoff ignores pre-cutoff intervals', () => {
  const since = Date.parse('2026-07-20T00:00:00Z');
  const snaps = [
    // Pre-cutoff burn at a DIFFERENT ratio (0.5) — must be excluded entirely.
    { ts: '2026-07-19T08:00:00Z', '5h': 100, wk: 100 },
    { ts: '2026-07-19T08:05:00Z', '5h': 70,  wk: 85 },
    // Post-cutoff burn at ratio 0.2: 5h drops 10 + 15 = 25, wk drops 2 + 3 = 5.
    { ts: '2026-07-20T08:00:00Z', '5h': 100, wk: 80 },
    { ts: '2026-07-20T08:05:00Z', '5h': 90,  wk: 78 },
    { ts: '2026-07-20T08:10:00Z', '5h': 75,  wk: 75 },
  ];
  assert.equal(weeklyPerFiveHourRatio(snaps, since), 0.2);
});

test('weeklyPerFiveHourRatio: omitted or non-finite sinceMs applies no filter', () => {
  const snaps = [
    { ts: '2026-07-20T08:00:00Z', '5h': 100, wk: 100 },
    { ts: '2026-07-20T08:05:00Z', '5h': 90,  wk: 98 },
    { ts: '2026-07-20T08:10:00Z', '5h': 75,  wk: 95 },
  ];
  assert.equal(weeklyPerFiveHourRatio(snaps), 0.2);
  assert.equal(weeklyPerFiveHourRatio(snaps, undefined), 0.2);
  assert.equal(weeklyPerFiveHourRatio(snaps, null), 0.2);
  assert.equal(weeklyPerFiveHourRatio(snaps, NaN), 0.2);
});

test('weeklyPerFiveHourRatio: cutoff leaving too little evidence returns null', () => {
  const since = Date.parse('2026-07-20T08:06:00Z');
  const snaps = [
    { ts: '2026-07-20T08:00:00Z', '5h': 100, wk: 100 },
    { ts: '2026-07-20T08:05:00Z', '5h': 90,  wk: 98 },
    { ts: '2026-07-20T08:10:00Z', '5h': 75,  wk: 95 }, // only 15 < 20 after cutoff
  ];
  assert.equal(weeklyPerFiveHourRatio(snaps, since), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: the cutoff test and the evidence-floor test FAIL (the `sinceMs` argument is currently ignored, so they compute over all data). The "no filter" test passes already — that is intended, it is the backward-compatibility guard.

- [ ] **Step 3: Implement the cutoff**

In `metrics.js`, change the `weeklyPerFiveHourRatio` signature and add the filter as the first statement inside the loop:

```js
function weeklyPerFiveHourRatio(snapshots, sinceMs) {
```

and immediately after the `for (let i = 1; i < pts.length; i++) {` line, insert:

```js
    // Optional cutoff: ignore intervals recorded before a declared tier change.
    // Omitted / non-finite sinceMs means no filtering (full history).
    if (Number.isFinite(sinceMs)) {
      const t = new Date(pts[i].ts).getTime();
      if (!Number.isFinite(t) || t < sinceMs) continue;
    }
```

Leave the rest of the function exactly as-is — the `dt`/`ACTIVE_GAP_MAX` gap check, the paired-reset gating (`if (d5 < 0 || dw < 0) continue;`), the accumulation, and the `MIN_RATIO_EVIDENCE_PCT` floor.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `not ok`; `# tests 73`, `# pass 73`, `# fail 0`.

- [ ] **Step 5: Syntax-check and commit**

Run: `node --check metrics.js`
Expected: no output.

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): optional sinceMs cutoff for the weekly/5h ratio

Lets the ratio be scoped to data recorded after a declared plan/tier change.
Omitting sinceMs (or passing a non-finite value) applies no filter, so existing
callers are unaffected. Paired-reset gating and the evidence floor unchanged."
```

---

### Task 2: main.js — read the declared date and return it

**Files:**
- Modify: `main.js` — the `get-budget-info` handler (around lines 74–88).

**Interfaces:**
- Consumes (Task 1): `weeklyPerFiveHourRatio(snaps, sinceMs)`; existing `loadSettings()` (`main.js:23`), `BUDGET_ACCOUNTS`.
- Produces (used by Tasks 3, 4): IPC payload per account is now
  `{ ratio, dayWeeklyBurnPct, tierChangedAt }` — `tierChangedAt` is epoch ms or `null`.

- [ ] **Step 1: Add the date-to-ms helper**

In `main.js`, immediately above the `ipcMain.handle('get-budget-info', ...)` handler, add:

```js
// 'YYYY-MM-DD' (from an <input type="date">) -> local-midnight epoch ms, or null.
// Parsed here rather than in metrics.js, which must stay clock- and locale-free.
function tierChangeMs(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(y, m - 1, d).getTime();
  return Number.isFinite(t) ? t : null;
}
```

- [ ] **Step 2: Use it in the handler**

Change the `get-budget-info` handler body from:

```js
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

to:

```js
ipcMain.handle('get-budget-info', () => {
  const byAccount = readUsageLogGrouped();
  const tierDates = loadSettings().tierChangedAt || {};
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();
  const out = {};
  for (const a of BUDGET_ACCOUNTS) {
    const snaps = (byAccount && byAccount[a]) || [];
    const tierMs = tierChangeMs(tierDates[a]);
    out[a] = {
      ratio: weeklyPerFiveHourRatio(snaps, tierMs),
      dayWeeklyBurnPct: weeklyBurnSince(snaps, midnightMs),
      tierChangedAt: tierMs,
    };
  }
  return out;
});
```

Note `weeklyPerFiveHourRatio(snaps, null)` is correct for "no cutoff" — `null` is
not finite, so Task 1's guard skips filtering.

- [ ] **Step 3: Syntax-check, suite, commit**

Run: `node --check main.js && npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `node --check` output; `# tests 73`, `# pass 73`, `# fail 0` (no logic module changed here).

```bash
git add main.js
git commit -m "feat(main): scope the budget ratio to a declared tier-change date

Reads tierChangedAt from settings, converts it to local-midnight ms (kept out of
metrics.js), passes it to weeklyPerFiveHourRatio, and returns it in the payload
so the UI can explain why a ratio is unavailable."
```

---

### Task 3: Settings — tier-change date in the Subscriptions section

**Files:**
- Modify: `settings.html` — style rule for date inputs, `.tier-date`/`.mini-btn` CSS, three Subscriptions rows, a section note.
- Modify: `settings-renderer.js` — load, save, listeners.

**Interfaces:**
- Produces (consumed by Task 2 at runtime): settings key
  `tierChangedAt: { 'codex': 'YYYY-MM-DD'|'', 'claude-desktop': ..., 'claude-vscode': ... }`.

- [ ] **Step 1: Add CSS**

In `settings.html`, add `input[type="date"]` to the existing shared input rule (currently `input[type="text"], input[type="number"], select { ... }` around line 20) so it reads:

```css
  input[type="text"], input[type="number"], input[type="date"], select {
```

(keep that rule's existing declarations unchanged), then add these two rules directly after it:

```css
  .tier-date { flex: 0 0 130px; }
  .mini-btn {
    flex: 0 0 auto; padding: 3px 7px; font-size: 10px; border-radius: 4px;
    border: 1px solid var(--border); background: transparent;
    color: var(--text-mid); cursor: pointer;
  }
  .mini-btn:hover { color: var(--accent); border-color: var(--accent); }
```

- [ ] **Step 2: Extend the three Subscriptions rows**

In `settings.html`, replace the three rows of the "Subscriptions (plan price, USD/mo)" section with:

```html
    <div class="row"><label>Codex</label><input type="number" id="price-codex" min="0" step="1" placeholder="—"><input type="date" id="tier-date-codex" class="tier-date" title="Plan/tier changed on"><button class="mini-btn" id="tier-today-codex" type="button" title="Set to today">Today</button></div>
    <div class="row"><label>Claude Desktop</label><input type="number" id="price-claude-desktop" min="0" step="1" placeholder="—"><input type="date" id="tier-date-claude-desktop" class="tier-date" title="Plan/tier changed on"><button class="mini-btn" id="tier-today-claude-desktop" type="button" title="Set to today">Today</button></div>
    <div class="row"><label>Claude Code</label><input type="number" id="price-claude-vscode" min="0" step="1" placeholder="—"><input type="date" id="tier-date-claude-vscode" class="tier-date" title="Plan/tier changed on"><button class="mini-btn" id="tier-today-claude-vscode" type="button" title="Set to today">Today</button></div>
    <div class="note">Plan price drives cost estimates. The date is when that plan/tier last changed — the weekly-budget ratio ignores usage logged before it. Leave blank to use all history.</div>
```

- [ ] **Step 3: Load the dates**

In `settings-renderer.js`, inside `loadSettings()`, after the existing `planPrices` block (the `ACCOUNTS.forEach(... 'price-' ...)` line), add:

```js
  const tc = s.tierChangedAt || {};
  ACCOUNTS.forEach(a => { document.getElementById('tier-date-' + a).value = tc[a] || ''; });
```

- [ ] **Step 4: Save the dates and wire the buttons**

In `settings-renderer.js`, add after `savePlanPrices()`:

```js
function saveTierDates() {
  const tierChangedAt = {};
  ACCOUNTS.forEach(a => { tierChangedAt[a] = document.getElementById('tier-date-' + a).value || ''; });
  window.electronAPI.saveSettings({ tierChangedAt });
}

// Local YYYY-MM-DD for the "Today" buttons (not toISOString, which is UTC and
// can land on the wrong day near midnight).
function todayLocalISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
```

And next to the existing price listener line
(`ACCOUNTS.forEach(a => document.getElementById('price-' + a).addEventListener('change', savePlanPrices));`) add:

```js
ACCOUNTS.forEach(a => document.getElementById('tier-date-' + a).addEventListener('change', saveTierDates));
ACCOUNTS.forEach(a => document.getElementById('tier-today-' + a).addEventListener('click', () => {
  document.getElementById('tier-date-' + a).value = todayLocalISO();
  saveTierDates();
}));
```

- [ ] **Step 5: Syntax-check, suite, commit**

Run: `node --check settings-renderer.js && npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `node --check` output; `# tests 73`, `# pass 73`, `# fail 0`.

```bash
git add settings.html settings-renderer.js
git commit -m "feat(settings): tier-change date per account in Subscriptions

Adds a date input plus a Today button to each subscription row, saved as
tierChangedAt. Blank means use all history. Today uses the local date rather
than toISOString, which would pick the wrong day near midnight."
```

---

### Task 4: "since tier change" messaging in both windows

**Files:**
- Modify: `renderer.js` — the budget note's null branch (around lines 600–604).
- Modify: `analytics-renderer.js` — the budget cards' null branch (around lines 350–352).
- Test: `test/analytics-renderer.test.js`.

**Interfaces:**
- Consumes (Task 2): `info.tierChangedAt` / `budget.tierChangedAt` — epoch ms or `null`.

- [ ] **Step 1: Write the failing tests**

Add to `test/analytics-renderer.test.js`:

```js
test('renderStats budget cards explain a null ratio caused by a tier change', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  const entries = [
    { ts: '2026-07-20T08:00:00Z', '5h': 90, wk: 72.1 },
    { ts: '2026-07-20T08:30:00Z', '5h': 60, wk: 70 },
  ];
  renderStats(entries, container, {},
              { ratio: null, dayWeeklyBurnPct: 0, tierChangedAt: Date.parse('2026-07-19T00:00:00Z') });

  assert.match(container.innerHTML, /need more history since tier change/);
});

test('renderStats budget cards use the generic message when no tier change is set', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  const entries = [
    { ts: '2026-07-20T08:00:00Z', '5h': 90, wk: 72.1 },
    { ts: '2026-07-20T08:30:00Z', '5h': 60, wk: 70 },
  ];
  renderStats(entries, container, {}, { ratio: null, dayWeeklyBurnPct: 0, tierChangedAt: null });

  assert.match(container.innerHTML, /need more history/);
  assert.doesNotMatch(container.innerHTML, /since tier change/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: the first new test FAILS (the message is currently always generic). The second passes already — it is the no-regression guard.

- [ ] **Step 3: Update the analytics cards**

In `analytics-renderer.js`, in the budget block, replace:

```js
  if (!(budgetRatio > 0) || last['5h'] == null) {
    windowBudgetCard = { label: 'Window Budget', value: '—', sub: 'need more history', cls: 'dim' };
    dayBudgetCard    = { label: "Today's Budget", value: '—', sub: 'need more history', cls: 'dim' };
```

with:

```js
  if (!(budgetRatio > 0) || last['5h'] == null) {
    const noRatioSub = budget && budget.tierChangedAt
      ? 'need more history since tier change'
      : 'need more history';
    windowBudgetCard = { label: 'Window Budget', value: '—', sub: noRatioSub, cls: 'dim' };
    dayBudgetCard    = { label: "Today's Budget", value: '—', sub: noRatioSub, cls: 'dim' };
```

Leave the `else` branch and everything else unchanged.

- [ ] **Step 4: Update the main-window note**

In `renderer.js`, in `renderBudget`'s null branch, replace:

```js
    note.textContent = 'budget: need more history';
```

with:

```js
    note.textContent = info.tierChangedAt
      ? 'budget: need more history since tier change'
      : 'budget: need more history';
```

Leave `note.className = 'budget-note';` and the `return;` unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `not ok`; `# tests 75`, `# pass 75`, `# fail 0`.

- [ ] **Step 6: Syntax-check and commit**

Run: `node --check renderer.js && node --check analytics-renderer.js`
Expected: no output.

```bash
git add renderer.js analytics-renderer.js test/analytics-renderer.test.js
git commit -m "feat(budget): explain a null ratio caused by a declared tier change

Declaring a tier change hides the marker until enough post-change data accrues.
Say so ('need more history since tier change') in both the main-window note and
the analytics cards, so the vanished marker doesn't read as a bug."
```

- [ ] **Step 7: Note the manual verification for the controller/user**

`main.js`, `renderer.js` and `settings-renderer.js` are not unit-testable. After
merge the user confirms: Settings → Subscriptions shows a date + Today button per
account; pressing Today sets today's date and the budget marker/cards recompute
(likely showing "need more history since tier change" briefly); clearing the date
restores the full-history ratio and the marker returns.

---

## Self-Review

**1. Spec coverage:** `metrics.js` optional cutoff (spec §"metrics.js") → Task 1. `main.js` date parsing, cutoff pass-through and `tierChangedAt` in the payload (spec §"main.js") → Task 2. Settings date input + Today button in Subscriptions, CSS, note, load/save/listeners (spec §"Settings") → Task 3. "since tier change" messaging in both renderers (spec §"UI messaging") → Task 4. Storage format and blank-means-no-cutoff → Tasks 2 (parse guard) and 3 (saves `''`). Gap behaviour (honest "need more history", no fallback) is inherent: Task 1 returns `null` below the evidence floor and no task adds a fallback. Testing strategy → Task 1 Steps 1–4, Task 4 Steps 1–5, manual note in Task 4 Step 7. Full coverage. ✅

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete before/after code with exact ids and anchors. Exact commands with expected test counts (70 → 73 after Task 1 → 75 after Task 4). ✅

**3. Type consistency:** `weeklyPerFiveHourRatio(snapshots, sinceMs?)` — Task 1 guards with `Number.isFinite(sinceMs)`, and Task 2 passes either a finite ms or `null`, which that guard correctly treats as "no cutoff". `tierChangeMs` returns `number|null`, stored as `tierChangedAt` and consumed in Task 4 as a truthy check (`info.tierChangedAt` / `budget.tierChangedAt`) — `null` and `0` both correctly fall through to the generic message, and `0` is unreachable for any real date. Settings key `tierChangedAt` and the account keys `codex`/`claude-desktop`/`claude-vscode` are identical in Task 2 (read), Task 3 (write, via the existing `ACCOUNTS` array) and `BUDGET_ACCOUNTS`. Element ids `tier-date-<account>` / `tier-today-<account>` match between Task 3's markup and its listeners. Message strings are byte-identical between Task 4's two files and its tests. ✅
