# Weekly cycle boundaries + history context — Design

**Date:** 2026-07-02
**Status:** Approved (design)
**Component:** AI Usage Monitor — `metrics.js` (`isBoundary`, `summarize`), `analytics-renderer.js` (`buildEffWindow`, `renderPeakBars`), `analytics.html` (CSS)

## Problem

The Efficiency "Weekly Window — History" splits into cycles that aren't ~7 days
apart (observed: 24 Jun → 25 Jun → 30 Jun), and "0 of N completed cycles ran out"
gives no context for what a cycle is.

**Root cause (evidence from the live log):** `isBoundary` starts a new cycle when
the reported reset timestamp advances by more than `RESET_ADVANCE_MIN = 60_000`
(60 s). On 25 Jun the Claude Desktop weekly reset timestamp shifted **+2.79 days**
(with weekly remaining rising 12 pp — below the 15 pp jump threshold), almost
certainly a plan-change re-anchor, and it was mis-read as a weekly reset. A real
weekly reset advances the timestamp by ~**one full window** (the 30 Jun reset moved
it exactly **+7.00 days**). So a partial re-anchor fragments a week.

## Changes

### A. Boundary threshold — `metrics.js` `isBoundary`

Replace the flat 60 s `RESET_ADVANCE_MIN` with a **window-proportional** threshold:
a reset-timestamp advance counts as a reset only when it is at least **half the
window** (`WINDOW_MS[win] * RESET_ADVANCE_FRAC`, `RESET_ADVANCE_FRAC = 0.5`):
- weekly: ≥ 3.5 days — ignores the 2.79-day partial re-anchor, keeps the +7-day reset;
- 5-hour: ≥ 2.5 h — keeps the +5 h reset (existing tests), ignores minor drift.

The `jumped` (≥15 pp refill), `recoveredOrHeld`, `stillFull`, and `gapped` logic
is unchanged, so real resets that refill the % are still caught. Swap the exported
constant `RESET_ADVANCE_MIN` → `RESET_ADVANCE_FRAC`.

### B. History context — `analytics-renderer.js`

- **`summarize().peaks`** gains `endTs` (from `cycleStats.endTs`) alongside the
  existing `ts`/`peakPct`, so bars can show their date span.
- **`buildEffWindow` histLine** becomes window-aware and plain-language:
  `"N past weekly period(s) · none hit the limit"` (or `"K of N … hit the limit ·
  ≈T blocked total"` when some did); 5-hour uses `"5-hour cycle(s)"`.
- **`renderPeakBars`** labels each bar with its **date range** when the peaks carry
  `endTs` and there are ≤ 4 of them (the weekly case); otherwise it keeps the
  `oldest → newest` axis (the 12-bar 5-hour case). Tooltip shows `peak% · start–end`.

### C. CSS — `analytics.html`

Add `.peak-dates` (a flex row of per-bar date labels, mirroring `.hour-axis`).

## Testing

- `segmentCycles` does **not** split on a sub-window reset-timestamp advance
  (weekly +2.79 d, +12 pp) → one cycle; **does** still split on a full-window
  advance with recovery (weekly +7 d, remaining 90→100) → two cycles.
- Existing reset-advance tests (+5 h for 5-hour) stay green.
- `summarize().peaks` includes `endTs` (update the existing shape assertion).
- `renderPeakBars` with ≤4 endTs-bearing peaks renders a `.peak-dates` label row;
  the existing self-describing test (peaks without `endTs`) still shows `oldest`/`newest`.
- `node --check`; full `node --test` green. Manual GUI (user): weekly bars now span ~7 days.

## Out of scope

- The 5-hour history (already sensible) beyond the wording/labels above.
- The month "Burn by hour" grid.
- Re-deriving past cycles differently for the plan-change week (merging into one
  weekly period is the correct, simplest behavior).
