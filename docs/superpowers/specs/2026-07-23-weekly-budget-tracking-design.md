# Weekly budget tracking (per-window + per-day) — Design

**Date:** 2026-07-23
**Status:** Approved (design)
**Component:** AI Usage Monitor — `metrics.js`, `main.js`, `preload.js`, `renderer.js`, `index.html`, `analytics-renderer.js`, `settings.html`, `settings-renderer.js`

## Problem

The weekly quota — not the 5h one — is the real constraint. The user's plan is to
spend at most **10% of the weekly quota per 5h window** and **20% per day**
(morning + afternoon), yielding a 5-day week. Nothing in the app expresses that:
the 5h gauge gives no indication of where the weekly-budget threshold sits, and
there is no per-window or per-day budget readout.

Measured from the real log (`usage-log.jsonl`, 39 windows, 24 Jun–23 Jul,
claude-vscode): **1% of the 5h meter ≈ 0.1932% of the weekly meter** (aggregate
over 1,615% of 5h burn; per-window values cluster 0.19–0.21). So **10% weekly ≈
51.8% of a 5h window**. The ratio is account-specific (Codex's quota sizing
differs), so it must be computed per account.

## Decisions (from the user)

- **Scope:** all three accounts, each using a ratio measured from its own history.
- **Placement:** both the main window (gauge marker + compact note) and the
  analytics window (two budget stat cards).
- **Ratio source:** computed from the log per account, with a null/fallback path
  when there is too little data.
- **Targets:** configurable in Settings — weekly % per window (default **10**)
  and weekly % per day (default **20**). Global, not per-account: they describe
  the working rhythm; each account applies them against its own ratio.

## Architecture / data flow

`usage-log.jsonl` → **one** mtime-cached read in `main.js` (`get-budget-info`) →
per-account `{ ratio, dayWeeklyBurnPct }` → renderer (gauge marker + note) and
analytics (two cards). Targets come from settings.

A single IPC is used because `read-usage-log` (`main.js:37`) parses the **entire**
log on every call and only slices afterwards — calling it per account per refresh
would triple that cost. Computing in main also lets the ratio use full history
regardless of the analytics row-limit.

## `metrics.js` — three pure functions

Purity rules hold: no `Date.now()` / argless `new Date()`, no new deps. The
"today" boundary is a **parameter**, supplied by the caller.

```js
// Aggregate weekly-% burned per 1% of 5h burned, from ACTIVE drops only
// (drop > 0 and gap < ACTIVE_GAP_MAX — excludes resets and idle gaps).
// Returns null when evidence is too thin to trust.
const MIN_RATIO_EVIDENCE_PCT = 20;   // total 5h burn required
function weeklyPerFiveHourRatio(snapshots) {
  let sum5h = 0, sumWk = 0;
  const pts = snapshots.filter(s => s && s['5h'] != null && s.wk != null);
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

// How much of a 5h window the weekly target is worth. Clamped to [0,100]:
// a low ratio can imply >100%, meaning a full window still fits the budget.
function fiveHourAllowancePct(targetWeeklyPct, ratio) {
  if (!(ratio > 0) || !(targetWeeklyPct > 0)) return null;
  return Math.max(0, Math.min(100, targetWeeklyPct / ratio));
}

// Weekly % burned since a timestamp (active drops only). sinceMs is a parameter
// so metrics.js stays free of clock access.
function weeklyBurnSince(snapshots, sinceMs) {
  let sum = 0;
  const pts = snapshots.filter(s => s && s.wk != null);
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

All three are added to the CommonJS export footer.

## `main.js` — `get-budget-info` IPC

```js
ipcMain.handle('get-budget-info', () => { ... });
```

- Reads `USAGE_LOG_PATH` **once**, cached on the file's `mtimeMs` (same pattern
  as `usage-reader.js`): re-parse only when the file changed.
- Groups entries by `account`.
- For each of `codex`, `claude-desktop`, `claude-vscode` returns
  `{ ratio, dayWeeklyBurnPct }` using `weeklyPerFiveHourRatio(snaps)` and
  `weeklyBurnSince(snaps, midnightMs)`.
- `midnightMs` is **local midnight today**, computed in `main.js` (which is free
  to use the clock) and passed into the pure function.
- Returns `{ codex: {...}, 'claude-desktop': {...}, 'claude-vscode': {...} }`;
  `ratio` is `null` where evidence is thin.

`preload.js` exposes `getBudgetInfo: () => ipcRenderer.invoke('get-budget-info')`.

## Settings

Two global number inputs in `settings.html`, in a new "Weekly budget" section:

- `budget-window` — weekly % per window, default **10**, `min="0.1" step="0.1"`.
- `budget-day` — weekly % per day, default **20**, `min="0.1" step="0.1"`.

`settings-renderer.js` gains `BUDGET_DEFAULTS = { window: 10, day: 20 }`, loads
them in `loadSettings()`, and a `saveBudget()` writing
`{ budgetTargets: { window, day } }` (mirroring `savePlanMultipliers`). Values
that are not finite and > 0 fall back to the defaults on read.

## Main window (`index.html` + `renderer.js`)

**Markup/CSS (`index.html`)** — per account, inside the existing 5h
`.progress-track`:

```html
<div class="progress-track" style="margin-bottom:3px">
  <div class="progress-fill" id="claude2-5h-bar" style="..."></div>
  <div class="budget-marker" id="claude2-5h-budget" style="display:none"></div>
</div>
```

CSS:

```css
.progress-track { position: relative; }          /* added to existing rule */
.budget-marker {
  position: absolute; top: -2px; bottom: -2px; width: 2px;
  background: var(--text-mid); border-radius: 1px; pointer-events: none;
}
```

A compact note under the pair of bars, per account:
`<div class="budget-note" id="claude2-budget-note"></div>`

```css
.budget-note { font-size: 9px; color: var(--text-muted); margin-top: 3px; }
.budget-note.over  { color: var(--badge-warn-text); }
.budget-note.wayover { color: var(--badge-err-text); }
```

**Logic (`renderer.js`)** — a new `renderBudget(prefix, account, pct5h, info, targets)`:

- `allowance = fiveHourAllowancePct(targets.window, info.ratio)`.
- Marker: when `allowance` is non-null, `left = (100 - allowance) + '%'` and
  `display = ''`; otherwise `display = 'none'`.
- Note: window burn so far `= 100 - pct5h`; weekly-equivalent
  `= (100 - pct5h) * ratio`. Text:
  `` `${wkEquiv.toFixed(1)}% / ${targets.window}% wk this window · today ${day.toFixed(1)}% / ${targets.day}%` ``
- Colour: default (on budget) when `wkEquiv <= target`; `.over` when
  `<= 1.5 × target`; `.wayover` above that. The **day** figure is coloured by the
  same rule against `targets.day`, and the note takes the **worse** of the two.
- Ratio `null` → note reads `budget: need more history` and the marker hides.

Called from each account's render path after `renderStat`. Budget info is
fetched once per refresh cycle (not per account) and passed in; settings are
already available to the renderer.

## Analytics (`analytics-renderer.js`)

Two cards appended to the runway/projection group in `renderStats`:

- **Window Budget** — value `${wkEquiv.toFixed(1)}% / ${target}%`,
  sub `weekly-equivalent burn this window`.
- **Today's Budget** — value `${day.toFixed(1)}% / ${targetDay}%`,
  sub `weekly burn today`.

Both use the existing card `cls` convention: `''`/green when within target,
`amber` up to 1.5×, `red` beyond; `dim` with `—` when the ratio is null. The
analytics window fetches `getBudgetInfo()` alongside its existing
`getSettings()` call and passes `{ info, targets }` into `renderStats`.

## Edge handling

- **Ratio null** (new account, thin log): marker hidden, note/cards show a
  "need more history" / `—` state. Never guess a ratio.
- **Allowance ≥ 100%**: clamped to 100 → marker sits at 0% remaining, meaning a
  whole 5h window fits inside the weekly budget.
- **`pct5h` null** (meter momentarily missing): skip the note/marker update for
  that account this cycle; leave the previous value rather than showing NaN.
- **Log missing/unreadable**: `get-budget-info` returns nulls; UI degrades to the
  "need more history" state.
- Existing null-meter placeholder and `cycleStats` clamping behaviour unchanged.

## Testing

**Unit (TDD, `test/metrics.test.js`)** — the three functions are pure:

- `weeklyPerFiveHourRatio`: a synthetic series with known active drops returns
  the expected ratio; drops separated by a gap ≥ `ACTIVE_GAP_MAX` are excluded;
  resets (negative drops) excluded; returns `null` below `MIN_RATIO_EVIDENCE_PCT`.
- `fiveHourAllowancePct`: `10 / 0.193 → 51.8` (within tolerance); clamps to 100
  when the ratio is tiny; returns `null` for ratio `0`/null/negative.
- `weeklyBurnSince`: sums only active weekly drops at or after `sinceMs`;
  excludes earlier drops and idle-gap drops.

**Analytics (`test/analytics-renderer.test.js`)** — via the existing
`loadStatsRenderer` harness: the two budget cards render their values and the
target, and show `—`/dim when the ratio is null.

**Not unit-tested** (established pattern): `main.js` (Electron entrypoint),
`renderer.js`, `settings-renderer.js` — verified by `node --check` on each
changed file, the full suite staying green, and manual GUI checks:
marker appears on each 5h bar at the expected position; note shows window/day
figures and recolours when over; changing the Settings targets moves the marker.

## Out of scope

- Changing how the 5h/weekly meters themselves are read or clamped.
- Per-account budget targets (global targets, per-account ratio).
- Notifications/alerts when the budget is exceeded.
- Handling a working day that spans local midnight (the day boundary is local
  midnight, matching the described morning/afternoon rhythm).
