# Token & Cost Analytics — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor — Analytics window

## Goal

Give a money view of usage in the Analytics window:

1. **API-equivalent cost (Claude Code only):** price the per-turn token counts
   already collected from `~/.claude/projects/**/*.jsonl` at pay-as-you-go API
   rates, to show what the same usage would cost on the API — the value you're
   extracting from the flat subscription.
2. **Subscription-value comparison (all accounts):** because Codex and Claude
   Desktop are scraped as rate-limit percentages with **no token data**, compare
   providers on a common axis both expose — active usage time and 5h-windows
   consumed — turned into money via a user-supplied monthly plan price. Answers
   "which subscription gives more per dollar."

Everything is an **estimate** and labeled as such — never presented as a bill.

## Context (existing)

- `readClaudeCodeUsage` IPC returns Claude Code token entries:
  `{ timestamp, model, input_tokens, output_tokens, cache_creation, cache_read }`
  (read from the local JSONL logs). Currently consumed only by the **main**
  window; the Analytics window does not load it.
- The Analytics window (`analytics-renderer.js`) loads only `usage-log.jsonl`
  (the rate-limit % snapshots) via `readUsageLog`, has a window selector
  (`windowHours`: 24 default, `0` = all) and three tabs
  (`codex`, `claude-desktop`, `claude-vscode`).
- The window uses `preload.js` (contextIsolation on), which already exposes
  `readClaudeCodeUsage`, `readUsageLog`, `getSettings`, `saveSettings`.
- `metrics.js` is a pure, dual-load module loaded in the window before
  `analytics-renderer.js`.
- `main.js` `saveSettings(patch)` does a **shallow** merge (`{...s, ...patch}`).

## Pricing (authoritative, per 1M tokens)

| Family | input | output |
|---|---|---|
| Opus | $5 | $25 |
| Sonnet | $3 | $15 |
| Haiku | $1 | $5 |
| Fable | $10 | $50 |

Cache pricing (Anthropic 5-minute ephemeral, which Claude Code uses): cache
**write** = input rate × **1.25**, cache **read** = input rate × **0.1**. The
data records no cache TTL, so all `cache_creation` is priced at the 5-minute
write rate (stated assumption).

## Metric layer — `metrics.js` (pure, unit-tested)

Named constants at the top:

```js
const FAMILY_PRICES = {
  Opus:   { in: 5,  out: 25 },
  Sonnet: { in: 3,  out: 15 },
  Haiku:  { in: 1,  out: 5  },
  Fable:  { in: 10, out: 50 },
};
const CACHE_WRITE_MULT = 1.25;  // 5-minute ephemeral cache write
const CACHE_READ_MULT = 0.1;    // cache read
const MONTH_MS = 30 * 86_400_000;
```

Functions:

- **`modelFamily(model)`** (private) — lowercase substring match → `'Opus'` /
  `'Sonnet'` / `'Haiku'` / `'Fable'` / `null`. (Matching by family, not exact ID,
  so new model versions price correctly.)
- **`entryCost(e)`** — `$` for one token entry, or `null` if the model is
  unpriced. `(input·in + output·out + cache_creation·in·1.25 +
  cache_read·in·0.1) / 1e6`.
- **`summarizeCost(entries)`** → `{ total, byModel, unpriced, cacheSavings }`:
  - `total` — sum of priced `entryCost`.
  - `byModel` — keyed by family: `{ tokens, cost }` where `tokens` =
    input+output+cache_creation+cache_read.
  - `unpriced` — count of entries whose model didn't match a family (shown as
    "unpriced: N turns", never guessed).
  - `cacheSavings` — `Σ cache_read · in · (1 − 0.1) / 1e6` over priced entries:
    what cache reads saved vs paying full input price.
- **`activeMs(snapshots, win)`** — sum of inter-snapshot gaps where the window
  dropped (`drop > 0`) and the gap was `< ACTIVE_GAP_MAX` (the existing
  active-session rule). Active usage time, in ms.
- **`subscriptionValue(snapshots, monthlyPrice, win)`** → `null` if
  `< 2` points or no price, else
  `{ activeHours, windows, attributedCost, perActiveHour, perWindow }`:
  - `attributedCost = monthlyPrice × (spanMs / MONTH_MS)` where `spanMs` is
    first→last snapshot in the (already windowed) input. Proration makes the
    figure independent of how much data is in view.
  - `activeHours = activeMs(...) / 3.6e6`; `windows = segmentCycles(snapshots,
    '5h').length`.
  - `perActiveHour = attributedCost / activeHours` (null if 0);
    `perWindow = attributedCost / windows` (null if 0).

Exports added: `entryCost`, `summarizeCost`, `activeMs`, `subscriptionValue`,
`FAMILY_PRICES`, `CACHE_WRITE_MULT`, `CACHE_READ_MULT`, `MONTH_MS`.
`modelFamily` stays private.

## View — Analytics window

A new **Cost** section, rendered after the existing Efficiency section. Two parts.

### Part A — API-equivalent cost (Claude Code tab only)

Shown only when `currentAccount === 'claude-vscode'`. The renderer loads the
token log (`readClaudeCodeUsage`), filters entries to the selected window by
`timestamp`, and `summarizeCost`s them:

- **Headline:** `≈ $42.10 of API usage · <window label>`, with a sub-line
  `estimate — what this would cost on the pay-as-you-go API`.
- **Per-model rows:** family · tokens · $ (Opus vs Sonnet split).
- **Cache savings:** `cache reads saved ≈ $X vs uncached`.
- **Unpriced note:** `unpriced: N turns (unknown model)` when `unpriced > 0`.
- Other tabs render a one-line note: *"Token-level cost isn't available for this
  account — Codex/Claude Desktop expose only rate-limit %."*

### Part B — Subscription-value comparison (all tabs, cross-account)

A small table comparing all three accounts, so the question "which option is
better value" is answerable from any tab. The renderer loads each account's
`usage-log.jsonl` (`readUsageLog(account, 0)`), filters to the window, and runs
`subscriptionValue` with that account's plan price.

- **Editable price input** per account: a `$/mo` field, pre-filled from
  `settings.planPrices[account]`. On change, persist via
  `saveSettings({ planPrices: { ...all } })` (send the whole `planPrices` object,
  because the main-process merge is shallow). Blank → that row shows usage
  columns but no `$`.
- **Columns:** account · $/mo (input) · active hours · windows · **$/active-hr**
  · **$/window**. Lower $/x = better value; the best value in each money column
  is highlighted.
- **Claude Code value ratio (standout):** when the Claude Code price is set and
  Part A produced a total, show `≈ N× the subscription's worth in API-equivalent
  value` = `summarizeCost.total ÷ subscriptionValue('claude-vscode').attributedCost`.

### Honesty / labeling

- Header: "Cost (estimates)".
- Proration assumption stated near the table.
- Small-data caveat: when the windowed span is short (e.g. < ~2 days), append
  *"figures are noisy until more history accrues"* rather than implying
  precision.

## Settings

- New key `planPrices`: `{ [account]: number }` (USD/month, optional per
  account). Read via `getSettings`, written via `saveSettings` with the **full**
  `planPrices` object each time (shallow merge in main).
- No `main.js` / `preload.js` changes — the IPCs already exist.

## Testing

Unit tests in `test/metrics.test.js` (pure functions only):

- `entryCost` for each family incl. cache write/read multipliers; `null` for an
  unknown model.
- `summarizeCost`: totals, per-family aggregation, `unpriced` count for unknown
  models, `cacheSavings` math.
- `activeMs`: counts active drops, excludes idle gaps (`≥ ACTIVE_GAP_MAX`) and
  resets (negative drops).
- `subscriptionValue`: proration (`attributedCost`), `perActiveHour` /
  `perWindow`, and `null` guards (no price, < 2 points, zero divisors).

Rendering and price-input persistence are verified by running the app (no DOM
unit test), as with prior analytics work.

## Out of scope

- Estimating Codex token volume / Codex API-equivalent $ (no token data — would
  be fabricated; explicitly rejected during design).
- Real billing / invoice integration.
- A general settings screen (price inputs live inline in the Cost section).
- 1-hour cache-rate detection (not in the data; assume 5-minute).
- Historical cost trend over time (totals for the selected window only).
