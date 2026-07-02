# Legible Efficiency history charts — Design

**Date:** 2026-07-02
**Status:** Approved (design)
**Component:** AI Usage Monitor — `analytics-renderer.js` (`renderPeakBars`, `renderHourHeatmap`), `analytics.html` (CSS)

## Problem

The two Efficiency history charts are unreadable on their own:

- **Peak usage per completed cycle** (`renderPeakBars`) — bar height = the cycle's
  peak % of the limit; color green `<70` / amber `70–89` / red `≥90`. But there is
  no 0–100 scale, no threshold reference, and no color legend, so bars read as
  meaningless blocks (especially the weekly chart with only 3 wide bars).
- **Burn by hour of day** (`renderHourHeatmap`) — 24 cells, opacity = share of quota
  consumed in that clock hour. But zero-burn hours are fully transparent, so the row
  collapses into a few floating squares with stray hour numbers, no grid, no legend.

Same data, same meaning — the fix is to make each chart self-describing.

## Changes (data unchanged)

### Peak bars — `renderPeakBars`

- Add a **color legend** row: `<70%` (green) · `70–89%` (amber) · `≥90% ran out` (red).
- Wrap the bars in a **`.peak-chart` frame** (relative, fixed height, 0% baseline
  border at the bottom) so height reads against a visible 0–100%.
- Draw two faint **threshold gridlines** (`.peak-grid`) at 70% and 90% with small
  right-edge labels, so "amber/red" have a visual anchor.
- Add a **time-order axis** (`.peak-axis`): `oldest` → `newest`.
- Bars keep `height:${peakPct}%` and the same color thresholds; tooltips unchanged.
- Scope the frame via `.peak-chart .peak-bars` so the cost-over-time chart (which
  reuses `.peak-bars` without the frame) is unaffected.

### Hour heatmap — `renderHourHeatmap`

- Render **all 24 cells always**. Zero-burn hours get a faint outline
  (`.heat-cell.empty`) so the full-day grid is always visible.
- Move hour labels out of the cells into a dedicated **`.hour-axis`** row aligned
  under the columns, labelled at 0 / 6 / 12 / 18.
- Add an **intensity legend** (`.heat-legend`): `less` → gradient → `more`.
- Clarify the caption: "share of quota used per clock hour (all days in view)".
- Cell opacity still = `value / max`; tooltips unchanged.

### CSS — `analytics.html`

Add `.peak-legend`, `.peak-chart`, `.peak-grid`, `.peak-axis`, `.hour-axis`,
`.heat-legend`, `.heat-cell.empty`, and swatch classes. Leave the existing
`.peak-bars` / `.heat-cell` / month-grid rules intact.

## Testing

- `renderPeakBars` output contains the legend (`ran out`), the `.peak-chart` frame,
  two `.peak-grid` threshold lines, the `oldest`/`newest` axis, and one `.peak-bar`
  per cycle.
- `renderHourHeatmap` output contains exactly 24 `.heat-cell`, a `.hour-axis`, a
  `.heat-legend`, and marks zero hours with `.heat-cell.empty`.
- `node --check analytics-renderer.js`; existing `node --test` suite stays green.
- Manual GUI (user): both charts now read without hovering.

## Out of scope

- The month "Burn by hour heatmap" grid (`monthGridHtml`) — already has a ruler.
- Any metric/data change (`hourlyBurn`, `summarize`, cycle segmentation).
- The cost-over-time bar chart.
