# Hour-of-day burn as share-of-total, shown once — Design

**Date:** 2026-07-02
**Status:** Approved (design)
**Component:** AI Usage Monitor — `analytics-renderer.js` (`renderHourHeatmap`, `renderEfficiency`, `buildEffWindow`), `analytics.html` (CSS)

## Problem

The "Burn by hour of day" heatmap is confusing:
1. Its per-hour number is a **cumulative sum of percentage-points across all logged
   days** (`hourlyBurn`), so it exceeds 100% (Codex 10am = 202%) yet is captioned a
   "share of quota" — nonsense to a reader. It exceeds 100% because the 5h meter
   resets several times a day and the value sums across every day/window.
2. It appears under **both** the 5-hour and weekly sections with near-identical
   shape — redundant.
3. Heatmap opacity (not height) encodes magnitude, and activity is clustered in a
   few hours, so it reads as "tall boxes, little fill."

## Decisions (from the user)

- **Metric:** share of the user's **total burn** — each hour = its value ÷ the sum
  over all hours, as a % (≤100, sums to 100). "10am — 20% of your burn happens here."
- **Visual:** keep the heatmap, refined (shorter cells + the corrected number).
- **Placement:** show it **once** in the Efficiency section, not per window.

## Changes

### `analytics-renderer.js`

- **`renderHourHeatmap(el, hours)`**: compute `total = sum(hours)`; per non-empty
  cell, tooltip = `"${h}:00 — ${round(v/total*100)}% of your burn"`. Opacity stays
  `v / max` (relative intensity → best contrast). Caption → `"Share of your total
  burn per clock hour (all days)"`. Zero hours stay outlined (`.heat-cell.empty`,
  tooltip `"no burn"`). The 24-cell grid, hour axis, and legend are unchanged.
- **`buildEffWindow`**: remove the per-window `<div id="eff-heat-${win}">`.
- **`renderEfficiency`**: append one `<div class="eff-sub">Time of Day — when you
  burn quota</div><div id="eff-hourofday" class="eff-heat"></div>` after the two
  window blocks; render it once with `hourlyBurn(entries, '5h')` (finest-resolution
  meter). Drop the per-window `renderHourHeatmap` calls.

### `analytics.html`

- `.heat-cell` height `20px → 14px` (less empty vertical space). Month-grid cells
  keep their own `12px` override; `.heat-cell.empty` outline unchanged.

## Testing

- `renderHourHeatmap` tooltip shows the **share** (e.g. hours `{9:30, 10:50}` →
  `38%` and `63%`), still 24 cells, an axis, a legend, and `.heat-cell empty` for
  zero hours.
- `renderEfficiency` renders a single `#eff-hourofday` and **no** `#eff-heat-5h` /
  `#eff-heat-wk`.
- `node --check`; full `node --test` green. Manual GUI (user): one time-of-day
  chart, numbers ≤100% summing to 100%.

## Out of scope

- The month "Burn by hour" grid (`#eff-month-5h`, days×hours) — separate, unchanged.
- Switching to a bar chart (user chose to keep the heatmap).
- `hourlyBurn` itself (still returns raw per-hour sums; the share is derived at render).
