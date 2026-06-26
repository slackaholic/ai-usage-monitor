# Month Heatmap Navigation — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor — Analytics window (Efficiency section)

## Goal

Let the user page the burn-by-hour heatmap **month by month** (◀ / ▶) instead
of being fixed to the last 30 days, so they can look back at earlier calendar
months of activity.

## Context (current behavior)

- `metrics.js` exports `dailyHourlyBurn(snapshots, win, days = 30)` — a rolling
  last-30-days day×hour grid (shipped the previous turn).
- `analytics-renderer.js` renders it (5h window only) via `renderMonthHeatmap`
  into `#eff-month-5h`, inside a collapsed `<details class="eff-month">` emitted
  by `buildEffWindow`; `renderEfficiency` fills it once.
- Grid rows: one per day, newest first, `hasData` dimming, color normalized to
  the grid's global max. Cells use `rgba(168,85,247,a)`.

## Change summary

Replace the rolling 30-day window with a **calendar-month** view plus ◀/▶
navigation. `dailyHourlyBurn` is removed (superseded; only shipped last turn) and
replaced by `monthBurnGrid`. The grid renderer is unchanged in look; a control
bar and month state are added around it.

## Metric — `monthBurnGrid` (replaces `dailyHourlyBurn`)

```
monthBurnGrid(snapshots, win, year, month) -> Array<{ date, hours, hasData }>
```

- `month` is **0-based** (January = 0), matching JS `Date`.
- Returns one row per day of that calendar month (`new Date(year, month + 1, 0)
  .getDate()` days), chronological (day 1 first), each:
  - `date`: `YYYY-MM-DD` local key (via the existing private `localDayKey`).
  - `hours`: `number[24]`, total % burned per local hour that day.
  - `hasData`: `true` if any snapshot (with `win` present) fell on that local day.
- Bucketing is unchanged from the current implementation: for consecutive
  snapshots with `win` present, a `drop = prev - cur` counts only when
  `drop > 0` and the poll gap `dt < ACTIVE_GAP_MAX`; the drop is attributed to
  the local day+hour of the earlier snapshot. Resets (negative) and idle gaps
  excluded.
- **Pure / deterministic:** `year`/`month` are inputs; no `Date.now()` or argless
  `new Date()` inside the module.
- An empty/no-data month still returns a full month of rows with `hasData:false`
  (so navigating to a gap month shows an empty month, not `[]`). Only a snapshot
  set with no entries for `win` at all yields rows that are all `hasData:false`;
  the renderer decides the "account has zero data" empty state separately (below).
- `localDayKey` stays private; add a small private `daysInMonth(year, month)`
  helper. Export `monthBurnGrid`; remove `dailyHourlyBurn` from the export list.

## Renderer — navigation

State added in `analytics-renderer.js`:
- `monthEntries` — the entries last passed to the Efficiency render (so ◀/▶ can
  re-render without re-reading the log).
- `displayYear`, `displayMonth` — the calendar month currently shown.

Flow:
- `renderEfficiency(entries, container)` stores `monthEntries = entries`, sets
  `displayYear`/`displayMonth` to the **latest logged day's local year/month**
  (from the newest snapshot with `5h` present), then calls `renderMonthSection()`.
  If no snapshot has `5h`, render the existing empty state ("No data yet.") and
  skip navigation.
- `renderMonthSection()` queries `#eff-month-5h`, computes
  `monthBurnGrid(monthEntries, '5h', displayYear, displayMonth)`, derives the
  enable/disable bounds, renders the control bar + grid, and wires the buttons.
- `◀` → previous calendar month (decrement month, wrap to December of the prior
  year at month 0); `▶` → next calendar month (wrap to January of the next year
  at month 11); each re-calls `renderMonthSection()`.

Bounds (from earliest/latest logged local day):
- `▶` disabled when `displayYear/displayMonth` is at or after the latest logged
  month.
- `◀` disabled when at or before the earliest logged month.
- Compare months as `year * 12 + month` to keep the checks simple.

## Renderer — layout

Inside the collapsed `<details class="eff-month">`:
- `<summary>` text becomes **"Burn by hour heatmap"** (the "last 30 days" phrasing
  no longer fits).
- A control bar above the grid:

  ```
  ◀   June 2026   ▶
  ```

  - Month label: `new Date(displayYear, displayMonth, 1)
    .toLocaleDateString([], { month: 'long', year: 'numeric' })`.
  - Buttons styled like existing analytics controls; greyed/disabled via a
    `disabled` attribute and a `.disabled`-equivalent style at the bounds.
- The grid below is the current renderer: hour ruler (labels 0/6/12/18), **newest
  day on top** (`[...grid].reverse()`), `hasData`/`nodata` styling, cells
  `rgba(168,85,247, v/max)` with `max = Math.max(1, ...grid.flatMap(r => r.hours))`
  (normalized per displayed month).

## Testing

Unit tests for `monthBurnGrid` in `test/metrics.test.js` (remove the old
`dailyHourlyBurn` tests):
- Returns the correct number of rows for a 30-day month and a 31-day month, and
  29 for a leap February (e.g. 2028-02).
- Buckets active drops into the right month; a drop in the queried month is
  counted, a drop in a different month is absent (assert the TZ-independent total
  sum equals the in-month active drop).
- Excludes idle gaps and resets.
- `hasData` is `true` for logged days (including a logged zero-burn day) and
  `false` for unlogged days within the month.

Rendering/navigation is a thin renderer verified by running the app; no DOM unit
test. The metric being pure means month-stepping correctness is covered by
passing different `year`/`month` values in the unit tests.

## Out of scope

- Weekly-window grid (still 5h only).
- Persisting the selected month across window reopen (resets to latest on each
  Efficiency render / tab switch).
- A month picker / jump-to-date (only ◀/▶ stepping).
- Any change to the all-history hour-of-day profile row or other Efficiency views.
