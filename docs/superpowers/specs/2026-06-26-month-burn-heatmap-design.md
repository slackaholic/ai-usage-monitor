# Month Burn Heatmap — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor — Analytics window (Efficiency section)

## Goal

Add a **day × hour burn heatmap covering the last 30 days** to the Efficiency
section, so the user can spot patterns over a month (e.g. "heavy Tuesday
mornings") rather than only the all-history hour-of-day profile that exists
today. The existing single-row 24-hour profile stays; the month grid is added
beneath it, collapsed by default.

## Context (existing behavior)

- `metrics.js` exposes `hourlyBurn(snapshots, win) -> number[24]`: total % consumed
  per local hour-of-day, counting only positive drops with a poll gap under
  `ACTIVE_GAP_MAX` (excludes idle gaps and resets). Pure, no I/O.
- `analytics-renderer.js` renders, per window (`5h` and `wk`), a "Burn by hour of
  day" row via `renderHourHeatmap(el, hours)` into `#eff-heat-<win>` placeholders
  emitted by `buildEffWindow`.
- `renderEfficiency(entries, container)` reads the full unfiltered log and fills
  the placeholders.

## Decisions

- **Both views:** keep the 24-hour profile row (unchanged), AND add a day×hour
  grid below it.
- **5-hour window only** for the month grid. The weekly remaining drains from the
  same activity, so a weekly day×hour grid would duplicate the 5h one. The
  24-hour profile row remains in both windows as today.
- **Rolling last 30 days**, ending on the latest logged day (not the calendar
  month), so the grid is always a full 30 rows and deterministic from the data.
- **Collapsed by default** behind a native `<details>`/`<summary>` toggle. The
  page is already long and must work on smaller screens. Open/closed state is not
  persisted.

## Metric — `dailyHourlyBurn` (new, in `metrics.js`)

```
dailyHourlyBurn(snapshots, win, days = 30) -> Array<{ date, hours, hasData }>
```

- Reuses the exact active-drop rule from `hourlyBurn`: for consecutive snapshots
  with `snapshots[i][win] != null`, a `drop = prev - cur` counts only when
  `drop > 0` and the poll gap `dt < ACTIVE_GAP_MAX`. Resets (negative drops) and
  idle gaps are excluded.
- Each counted drop is attributed to the **local day and local hour of the
  earlier snapshot** (`new Date(prev.ts)` → `getFullYear/getMonth/getDate` and
  `getHours()`), consistent with `hourlyBurn` bucketing by `pts[i-1]`.
- **Window end** is derived from the latest snapshot's local date (the max `ts`
  among `snapshots` with the field present) — NOT `Date.now()` — so the function
  is pure and unit-testable. Output rows cover that day and the preceding
  `days - 1` days.
- Each row:
  - `date`: a stable key for the day. Use `YYYY-MM-DD` built from the local
    Y/M/D components (zero-padded), so rows are comparable and label-able without
    a second Date parse.
  - `hours`: `number[24]`, total % burned per local hour that day.
  - `hasData`: `true` if at least one snapshot (with the window field present)
    falls on that local day; `false` otherwise (the app wasn't logging that day).
- Returns exactly `days` rows in chronological order (oldest first). If
  `snapshots` is empty (no entries with the field), return `[]`.

Add no new exported constants; `days` defaults to 30.

## Rendering — `renderMonthHeatmap` (new, in `analytics-renderer.js`)

```
renderMonthHeatmap(el, grid)   // grid = dailyHourlyBurn(...) output
```

- Guards: `if (!el) return;` and an empty-state message when `grid` is empty.
- **Color normalization:** the global maximum cell value across the whole grid
  (`Math.max(1, ...all cell values)`), so intensity is comparable across days.
  The existing single-row profile keeps its own normalization, unchanged.
- **Per row:** a left date label (e.g. `Jun 26`, derived from the row's `date`),
  then 24 cells.
  - `hasData === false` rows render dimmed/outlined ("no data" — app was off).
  - `hasData === true` cells use the purple intensity ramp
    (`rgba(168,85,247, value/max)`); a logged-but-zero hour shows the faintest
    fill, visually distinct from a no-data row.
- **Newest day at the top** (reverse the chronological grid for display).
- An hour ruler (labels at 0 / 6 / 12 / 18) above the rows, aligned with the 24
  columns.
- Cell `title` tooltips: `"<date> <hour>:00 — <v>% burned"`.

### Placement & collapse

- `buildEffWindow` (for `win === '5h'` only) emits, after the existing
  `#eff-heat-5h` block:

  ```html
  <details class="eff-month">
    <summary>Burn by hour — last 30 days</summary>
    <div id="eff-month-5h"></div>
  </details>
  ```

  No `open` attribute → collapsed by default.
- `renderEfficiency` fills `#eff-month-5h` with
  `renderMonthHeatmap(el, dailyHourlyBurn(entries, '5h', 30))`. The grid renders
  eagerly inside the collapsed `<details>` (30×24 = 720 cells, cheap), so
  expanding is instant with no re-render.
- CSS additions in `analytics.html` (`<style>`): `.eff-month` summary styling
  (cursor, color, the disclosure marker), the month-grid row/cell layout
  (`display:flex` rows, date-label column, 24 flexible cells), and the no-data
  row style. Reuse existing CSS variables and the heatmap purple where possible.

## Testing

- Unit tests for `dailyHourlyBurn` in `test/metrics.test.js`:
  - Buckets a drop into the correct day row and asserts the TZ-independent total
    (sum across all rows/hours) equals the expected active drop — mirroring the
    existing `hourlyBurn` test's TZ-robust approach.
  - Excludes idle gaps (`dt >= ACTIVE_GAP_MAX`) and resets (negative drops).
  - `hasData` is `false` for days with no snapshots and `true` for days with
    snapshots, including a logged-but-zero-burn day.
  - Returns exactly `days` rows; returns `[]` for empty input.
- Rendering is a thin renderer verified by running the app; no DOM unit test.

## Out of scope

- Weekly-window month grid (5h only).
- Persisting the collapsed/expanded state.
- Calendar-month alignment (rolling 30 days instead).
- Any change to the existing `hourlyBurn` profile row or other Efficiency views.
