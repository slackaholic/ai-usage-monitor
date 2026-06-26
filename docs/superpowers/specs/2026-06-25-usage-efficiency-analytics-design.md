# Usage Efficiency Analytics — Design

**Date:** 2026-06-25
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor (Electron app)

## Goal

Use the data already captured in `usage-log.jsonl` to give meaningful, insightful
feedback on how well the three tracked accounts (Codex, Claude Desktop, Claude
Code) use their rate-limit budgets. Three user-selected outcomes drive the design:

1. **Stay within limits** — know when the limit actually bit (you ran out).
2. **Don't waste quota** — see headroom left at reset, *without* treating a quiet
   day as a failure.
3. **Understand patterns** — descriptive insight into demand and burn over time.

Routing/balancing across accounts is explicitly **out of scope** for this pass.

## Guiding principle: describe, don't grade

Demand is genuinely variable — work isn't always the same complexity or volume.
A low-usage cycle usually means *the quota wasn't needed*, not that it was wasted.
Therefore we do **not** compute a judgmental "efficiency score." Instead:

- Metrics are **descriptive** (peak, headroom, burn) — expected to vary, shown
  with no "target" line.
- The **one** thing worth judging is **blocking**: when a window hit 0% before its
  reset, demand provably exceeded supply and the resource limited the work. That
  is the only unambiguous "we hit a wall" signal and it needs no guess about
  intent.

## Data model (existing, unchanged)

Source: `usage-log.jsonl`, one JSON object per line, appended on every poll.

```json
{"ts":"2026-06-25T13:44:50.373Z","account":"claude-desktop","5h":69,"wk":69,
 "reset5hTs":1782402600524,"reset7dTs":1782817200524,
 "sessionStart":"2026-06-25T13:40:49.975Z","depleted":["5h"]}
```

- `5h` / `wk` are **remaining %** (0–100), not consumption.
- `reset5hTs` / `reset7dTs` are epoch-ms reset times (optional).
- `depleted` lists windows currently at 0% (optional).
- Snapshots are **irregular** — only written when the app polls. Every derived
  metric must tolerate gaps and never assume even spacing.

Accounts seen in the log: `codex`, `claude-desktop`, `claude-vscode`.

## Architecture

Approach **A — on-the-fly derivation** (chosen). A single pure module derives all
metrics from the raw log in memory whenever a view opens. No new storage, no
migration; derived data can never drift from the raw log. Graduate to a
materialized cycle store (Approach B) later, purely as an optimization, with no
change to metric definitions.

### `metrics.js` — pure functions, no I/O

```
segmentCycles(snapshots, win)  -> Cycle[]      // win = '5h' | 'wk'
cycleStats(cycle, win)         -> CycleStat
summarize(cycleStats[])        -> Summary
```

- **`segmentCycles`** — for one account+window, walk snapshots in time order and
  start a new cycle when remaining **jumps up** by a meaningful margin (a reset)
  or a known `resetTs` is crossed. A cycle = the ordered run of snapshots from
  just-after-reset to just-before-next-reset. Tunable: `RESET_JUMP_MIN` (min
  upward % delta counted as a reset).
- **`cycleStats`** — per completed cycle:
  - `peakPct` = `100 − min(remaining)` — how deep usage went.
  - `headroomPct` = `100 − peakPct` — buffer not needed (informational, never a
    penalty). Within a monotonically-decreasing cycle this equals remaining at
    reset, so peak and headroom are two faces of one number.
  - `blocked` = remaining reached 0 before reset (bool).
  - `blockedMs` = time from first 0%-snapshot to the reset (only if blocked).
  - `burn` = reuse existing `computeBurnStats` (peak ÷ active span).
  - `confidence` = gap between last snapshot and the reset, surfaced as a hint
    (e.g. "based on a poll 12m before reset"); headroom may overstate waste if
    work continued after the last poll.
- **`summarize`** — across completed cycles:
  - `blockRate` = blocked cycles ÷ total; `totalBlockedMs`.
  - `peakDistribution` = peaks over time (for trend/range display, no target).
  - Hour-of-day burn aggregation for the heatmap.

All penalty/threshold knobs are **named constants at the top of the module** so
calibration later is trivial.

### Data access

- One backend change: `read-usage-log` (in `main.js`) currently caps at 200 rows.
  Add an "all rows" path — `limit` of `0`/null returns the full log — for the
  historical view. Live panel and scorecard keep using the recent slice.
- No other `main.js` / `preload.js` changes.

## Views

All three live in the existing **AI Usage Analytics** window and read from
`metrics.js`. Rendered per account.

### 1. Live panel (current cycle)

- 5h & weekly: current peak so far, headroom remaining, projected depletion time
  (from existing burn stats).
- Status one-liner: *On pace* / *Running hot — projected to deplete ~2h before
  reset* / *Comfortable headroom*.

### 2. Per-cycle scorecard (last completed cycle)

- Peak %, headroom %, blocked (y/n + duration), burn rate.
- Confidence hint ("based on a poll 12m before reset").
- Reads as a report card for the window that just closed.

### 3. Historical report (all completed cycles)

- **Block summary**: "X of last N cycles ran out, ≈Yh blocked total."
- **Peak trend**: peaks over time (sparkline/bars) — demand pattern, no target
  line implying you should hit 100%.
- **Burn-by-hour heatmap**: which hours of day burn hardest, aggregated across
  cycles (the "understand patterns" outcome).

## Testing

- `metrics.js` is pure and unit-testable in isolation. Cover:
  - cycle segmentation with reset-by-jump and reset-by-timestamp.
  - irregular gaps (missing snapshots near a reset).
  - a blocked cycle (reaches 0) vs a comfortable cycle.
  - empty / single-snapshot logs (no crash, graceful empty state).
- Views are thin renderers over the module output; verify with the existing
  973-row log as a fixture.

## Out of scope (this pass)

- Cross-account routing/balancing recommendations.
- Proactive alerts/notifications.
- Materialized cycle store (Approach B) and CSV/Excel export (Approach C).
- Absolute token/message counts — percentages only, as the log provides.

## Future refinement

- Calibrate reset-detection and any thresholds once more data accumulates.
- Revisit Approach B if the raw log grows large enough to make per-open
  reprocessing noticeable.
