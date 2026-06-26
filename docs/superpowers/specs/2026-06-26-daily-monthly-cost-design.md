# Daily / Monthly API-Equivalent Cost — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor — `metrics.js`, analytics window (`analytics-renderer.js`)

## Goal

Extend the analytics **Cost** section to track API-equivalent cost over time, not
just as a single window total. Show:

- **Headline rates** — average per day and a projected per-month run-rate
  (e.g. `≈ £12/day · ~£360/mo at this pace`).
- **Per-day breakdown** — a small bar list of per-calendar-day cost for the last
  30 days.
- **Per-month totals** — a compact table of the last 3 calendar months, with the
  current month marked "(so far)".

This is **Claude Code only** — it is the sole account with token-level data
(`readClaudeCodeUsage`). Codex / Claude Desktop keep their existing "not
available" note.

## Context (existing)

- `metrics.js` is a pure, currency-agnostic module (browser global + CommonJS
  footer; no `Date.now()`/argless `new Date()`; no new deps). It already exposes
  `entryCost(e)` → USD cost or `null` (unknown model family) and
  `summarizeCost(entries)` → `{ total, byModel, unpriced, cacheSavings }`.
- Token data comes from `readClaudeCodeUsage` →
  `{ entries: [{ timestamp (ISO string), model, input_tokens, output_tokens,
  cache_creation, cache_read }], error? }`.
- `analytics-renderer.js` renders the Cost section: **Part A** (Claude-Code
  per-window total + per-model rows + cache savings) and **Part B**
  (`renderCostCompare`, subscription-value comparison). Currency conversion is at
  display time only: `usdRate` (USD→display, default `0.79`) and `curSymbol`
  (default `£`), via `fmtMoneyUsd(usd)` = `curSymbol + (usd*usdRate).toFixed(2)`.
- The Cost section respects the time-window dropdown via `windowCutoffMs()`.
- A peak-bar visual (`.peak-bars` / `.peak-bar`) already exists in the analytics
  window (from the efficiency section) and is reused here.

## Metrics (pure additions to `metrics.js`)

Two small pure functions that bucket per-turn `entryCost` (USD) by local date.
Unpriced entries (`entryCost` → `null`) are skipped, consistent with
`summarizeCost`.

- `costByDay(entries)` → `{ 'YYYY-MM-DD': usdCost }` keyed by **local** calendar
  day. Only days with priced cost appear.
- `costByMonth(entries)` → `{ 'YYYY-MM': usdCost }` keyed by **local** calendar
  month. Only months with priced cost appear.

Both take **no reference date**, so they stay pure. The renderer supplies
"today" / "last 30 days" / "this month" using `Date.now()` — this lives in the
display layer, consistent with the existing `windowCutoffMs()`.

Local-day/month keys are derived without `new Date(string)` ambiguity by parsing
the ISO timestamp into a `Date` and reading local `getFullYear/getMonth/getDate`
(zero-padded). A shared private helper formats the keys.

### Unit tests (TDD, `node --test`)

- `costByDay`: buckets multiple entries on the same local day; separates
  different days; skips unpriced (unknown-family) entries; empty input → `{}`.
- `costByMonth`: aggregates days within a month; separates months; skips
  unpriced; empty input → `{}`.
- A multi-entry fixture where the sum of `costByDay` values for a month equals
  the corresponding `costByMonth` value (cross-consistency).

## Analytics rendering (`analytics-renderer.js`)

A new **"Cost over time"** block appended inside Part A (after the cache-savings
line), rendered **only** for `currentAccount === 'claude-vscode'`.

Unlike Part A's window-scoped total, this block is computed over the **full token
log, independent of the time-window dropdown** — per-day/month tracking is
meaningless at the default "last 24h". Each figure is explicitly labeled
("last 30 days", "this month") so it does not read as conflicting with the
window total above it.

Reuses the already-loaded `readClaudeCodeUsage` entries (no second IPC call):
Part A already fetches them; pass the full (unfiltered) entries into the new
block.

- **Headline rates:**
  - `avgPerDay` = (sum of `costByDay` over the last 30 calendar days, including
    days with no usage as 0) ÷ 30.
  - `projectedPerMonth` = `avgPerDay × 30`.
  - Rendered as `≈ {fmtMoneyUsd(avgPerDay)}/day · ~{fmtMoneyUsd(projected)}/mo
    at this pace`, with an "estimate" qualifier.
- **Per-day bars:** the last 30 calendar days in chronological order, one
  `.peak-bar` each; height ∝ that day's USD cost; label/tooltip shows the date
  and `fmtMoneyUsd(dayCost)`; the tallest (max-cost) day is labeled. Days with no
  usage render as empty/zero bars so the 30-day axis is continuous.
- **Per-month totals:** a compact table of the last 3 calendar months
  (`Month · {fmtMoneyUsd(total)}`), newest last; the current month row suffixed
  "(so far)". Months with no usage show `0`.

All money is display currency via `fmtMoneyUsd` (values are USD). No new currency
state — reuse `curSymbol` / `usdRate` already loaded in `renderAll`.

## Cross-cutting

- Live updates: the block re-renders through the existing
  `onSettingsChanged(() => renderAll())` path (currency/rate changes apply
  immediately). No new IPC or settings key.
- `metrics.js` stays USD/pure — no currency, no `Date.now()`. All "now"-relative
  logic and conversion are in the renderer.
- HTML is escaped via the existing `esc()` helper; date keys are formatted, not
  interpolated raw.

## Testing

- New `node --test` cases for `costByDay` / `costByMonth` (above); full existing
  suite still passes.
- `node --check` on changed JS.
- Manual: open analytics on the Claude Code tab → Cost section shows headline
  rates, a 30-day per-day bar list, and a 3-month totals table, all in `£`;
  changing the currency rate in Settings updates them live; Codex / Claude
  Desktop tabs are unaffected.

## Out of scope

- Per-day/month cost for Codex / Claude Desktop (no token data).
- Tying this block to the time-window dropdown (it intentionally uses full
  history).
- Month-by-month navigation for the per-day bars (fixed last-30-days view);
  the per-month table provides the longer-range view.
- Forecasting beyond a flat 30-day run-rate (no trend/seasonality modeling).
- Any change to the cost math in `entryCost` / `summarizeCost`.
