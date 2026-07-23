# Declared tier-change date scopes the budget ratio — Design

**Date:** 2026-07-23
**Status:** Approved (design)
**Component:** AI Usage Monitor — `metrics.js`, `main.js`, `settings.html`, `settings-renderer.js`, `renderer.js`, `analytics-renderer.js`

## Problem

`weeklyPerFiveHourRatio` averages an account's **entire** log history. The ratio
is `5h-quota ÷ weekly-quota`, and plan tier changes that relationship (measured:
Anthropic 20x accounts ≈ 0.19, Codex 5x ≈ 0.30). So after a tier change the
ratio is dragged by old-tier data for weeks, and every budget marker, note and
card derived from it is wrong in the meantime.

A rolling recency window was considered and rejected: it discards good history
permanently even when nothing changed, and still lags a real change.

## Decision (from the user)

**Declare the change explicitly.** The user records the date a plan/tier changed;
the ratio then uses only data from that date onward. Exact, only moves when
something actually changed, and keeps full history otherwise.

- **Declaration:** a date input **and** a "Today" button, per account.
- **Placement:** in the existing **Subscriptions** settings section (the date
  belongs with the subscription), not beside the plan multipliers.
- **Scope:** the budget **ratio only**. Peaks, heatmaps, cost trends and
  usage-period history keep their full history.
- **Gap behaviour:** when there is not yet enough post-change data, show
  "need more history" honestly — no fallback to the stale ratio, no guessed value.

## Storage

Settings key: `tierChangedAt: { 'codex': 'YYYY-MM-DD', 'claude-desktop': ..., 'claude-vscode': ... }`.
An absent key or empty string means **no cutoff — use all history**.

The value is the raw `<input type="date">` string. `main.js` converts it to
**local-midnight epoch ms**; `metrics.js` never parses dates from settings and
never reads the clock.

## `metrics.js`

`weeklyPerFiveHourRatio(snapshots, sinceMs)` gains an **optional** second
parameter, mirroring `weeklyBurnSince`'s idiom:

```js
function weeklyPerFiveHourRatio(snapshots, sinceMs) {
  let sum5h = 0, sumWk = 0;
  const pts = (snapshots || []).filter(s => s && s['5h'] != null && s.wk != null);
  for (let i = 1; i < pts.length; i++) {
    if (Number.isFinite(sinceMs)) {
      const t = new Date(pts[i].ts).getTime();
      if (!Number.isFinite(t) || t < sinceMs) continue;
    }
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    if (!(dt > 0) || dt >= ACTIVE_GAP_MAX) continue;
    const d5 = pts[i - 1]['5h'] - pts[i]['5h'];
    const dw = pts[i - 1].wk - pts[i].wk;
    if (d5 < 0 || dw < 0) continue;   // paired reset gating — unchanged
    sum5h += d5;
    sumWk += dw;
  }
  if (sum5h < MIN_RATIO_EVIDENCE_PCT || sumWk <= 0) return null;
  return sumWk / sum5h;
}
```

Omitting `sinceMs` (or passing a non-finite value) applies **no filter**, so
every existing caller and test is unaffected. The evidence floor
(`MIN_RATIO_EVIDENCE_PCT = 20`) is unchanged and now naturally produces `null`
right after a declared change — which is exactly the desired "need more history"
state. In practice 20 points of 5h burn is about half a working session, so a
live ratio typically returns the same morning.

## `main.js` — `get-budget-info`

- Read `loadSettings().tierChangedAt` (already available via `loadSettings()`).
- Per account, convert `'YYYY-MM-DD'` to local-midnight ms:
  `const [y, m, d] = str.split('-').map(Number); new Date(y, m - 1, d).getTime()`.
  A blank/absent/malformed value yields `null` (no cutoff).
- Pass it as `weeklyPerFiveHourRatio(snaps, sinceMs)`.
- **Return it in the payload** so the UI can explain itself:
  `{ ratio, dayWeeklyBurnPct, tierChangedAt }` where `tierChangedAt` is the ms
  value or `null`.

`weeklyBurnSince` (today's burn) is unaffected — it is already day-scoped.

## Settings — Subscriptions section

Each account's row gains a date input and a "Today" button. `.row` is
`display:flex; align-items:center; gap:8px` with a fixed 120px label, so the
extra controls fit alongside the price:

```html
<div class="row">
  <label>Codex</label>
  <input type="number" id="price-codex" min="0" step="1" placeholder="—">
  <input type="date" id="tier-date-codex" class="tier-date" title="Plan/tier changed on">
  <button class="mini-btn" id="tier-today-codex" type="button" title="Set to today">Today</button>
</div>
```

CSS additions (using only variables already present in `settings.html`):

```css
  .tier-date { flex: 0 0 130px; }
  .mini-btn {
    flex: 0 0 auto; padding: 3px 7px; font-size: 10px; border-radius: 4px;
    border: 1px solid var(--border); background: transparent;
    color: var(--text-mid); cursor: pointer;
  }
  .mini-btn:hover { color: var(--accent); border-color: var(--accent); }
```

`input[type="date"]` is added to the existing
`input[type="text"], input[type="number"], select` style rule so it matches the
other fields.

A `.note` under the section explains both fields:

> Plan price drives cost estimates. The date is when that plan/tier last changed —
> the weekly-budget ratio ignores usage logged before it. Leave blank to use all history.

`settings-renderer.js`:

- `loadSettings()` populates each `tier-date-<account>` from
  `s.tierChangedAt?.[account] || ''`.
- `saveTierDates()` writes `{ tierChangedAt: {…} }` for all three accounts,
  storing `''` for blank.
- Each date input fires `saveTierDates` on `change`; each "Today" button sets its
  input's value to today's local date (`YYYY-MM-DD`) and then calls
  `saveTierDates()`.

## UI messaging

When `ratio` is null **and** `tierChangedAt` is set, the message becomes
**"need more history since tier change"** instead of the generic
"need more history". Without this, declaring a change makes the marker vanish
with no explanation, which reads as a bug.

- `renderer.js` — the budget note's null branch picks the message based on
  `info.tierChangedAt`.
- `analytics-renderer.js` — both budget cards' `sub` uses the same rule; the
  `budget` object already flows in from `get-budget-info`, so it carries
  `tierChangedAt` with no signature change.

The marker stays hidden and the cards stay dim in both cases — only the wording
differs.

## Testing

**Unit (TDD, `test/metrics.test.js`):**
- `weeklyPerFiveHourRatio` with a `sinceMs` cutoff ignores pre-cutoff intervals
  and returns the ratio of the post-cutoff data only.
- Omitting `sinceMs` reproduces the existing result exactly (backward
  compatibility), and a non-finite `sinceMs` applies no filter.
- A cutoff that leaves less than `MIN_RATIO_EVIDENCE_PCT` of 5h burn returns `null`.

**Analytics (`test/analytics-renderer.test.js`):** with `ratio: null` and a set
`tierChangedAt`, both budget cards read "need more history since tier change";
with `ratio: null` and no `tierChangedAt`, they read the generic message.

**Not unit-tested** (established pattern): `main.js`, `renderer.js`,
`settings-renderer.js` — verified by `node --check` on each changed file, the
full suite staying green, and manual GUI: setting a date (or pressing Today)
recomputes the ratio and moves/hides the marker; clearing it restores the
full-history ratio.

## Out of scope

- Applying the cutoff to any other statistic (peaks, heatmaps, cost, usage-period
  history all keep full history).
- A rolling recency window (considered and rejected in favour of explicit declaration).
- Migrating or annotating historical log entries with the tier they were recorded under.
- Auto-detecting a tier change from the data.
