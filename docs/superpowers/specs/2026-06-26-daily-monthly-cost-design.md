# Per-Day / Per-Month API-Equivalent Cost (Claude Code + Codex) — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor — `metrics.js`, `main.js` (IPC), `preload.js`,
analytics window (`analytics-renderer.js`)

## Goal

Extend the analytics **Cost** section to track API-equivalent cost over time —
per day and per month — and to do so for **both** token-logged accounts:

- **Claude Code** (`claude-vscode`) — already has exact tokens via
  `readClaudeCodeUsage`.
- **Codex** (`codex`) — turns out to have **exact** per-turn tokens too, in its
  local session logs (`~/.codex/sessions/**/*.jsonl`). So Codex gets the same
  exact treatment, not a turn-count estimate.

For each, show:

- **Headline rates** — average per day and a projected per-month run-rate
  (e.g. `≈ £12/day · ~£360/mo at this pace`).
- **Per-day breakdown** — a small bar list of per-calendar-day cost, last 30 days.
- **Per-month totals** — a compact table of the last 3 calendar months, current
  month marked "(so far)".

The figure is **API-equivalent** cost — what the usage *would* cost on
pay-as-you-go. For Codex, actual money spent is £0 (plan-included; the analytics
page shows 0 credits used), so "API-equivalent" is the honest framing, identical
to how Claude Code's cost is already labeled.

## Background — why local logs, not web scraping

The Codex analytics web page (`chatgpt.com/codex/cloud/settings/analytics`)
exposes only usage-limit %, a credits balance (0), and per-day **turn counts** by
model — no dollars, no tokens. Estimating cost from turn counts × an assumed
$/turn would be guesswork.

Instead, Codex CLI writes exact token usage locally (the approach the `ccusage`
tool uses). Each turn emits an `event_msg` with `payload.type === "token_count"`:

```json
{"timestamp":"2026-06-25T12:46:39.043Z","type":"event_msg","payload":{
  "type":"token_count","info":{
    "total_token_usage":{"input_tokens":905530,"cached_input_tokens":857088,
      "output_tokens":6065,"reasoning_output_tokens":1935,"total_tokens":911595},
    "last_token_usage":{"input_tokens":76414,"cached_input_tokens":75648,
      "output_tokens":704,"reasoning_output_tokens":458,"total_tokens":77118}}}}
```

- `last_token_usage` is the **per-turn delta** (summing all deltas reconstructs
  the session total — no cumulative double-counting).
- `input_tokens` **includes** `cached_input_tokens`; `output_tokens` **includes**
  `reasoning_output_tokens` (verified: `input + output = total`).
- The active model is carried by `turn_context` events (`"model":"gpt-5.5"`); a
  session may switch models across turns.

## Cost model — OpenAI rates (USD per 1M tokens)

From OpenAI's June 2026 pricing:

| Model | input | output | cached input |
|---|---|---|---|
| gpt-5.5 | 5.00 | 30.00 | 0.50 |
| gpt-5.4 | 2.50 | 15.00 | 0.25 |
| gpt-5.4-mini | 0.75 | 4.50 | 0.075 |
| gpt-5.4-nano | 0.20 | 1.25 | 0.02 |

The cached-input rate is exactly 10% of input for every model — matching the
existing `CACHE_READ_MULT = 0.1`. OpenAI does not separately bill cache writes,
so `cache_creation` is 0 for Codex entries.

`gpt-5.3-codex-spark` has no published rate → it is **unpriced** (`modelFamily`
returns `null`), so its tokens appear in the existing "unpriced tokens" note
rather than being guessed. (The user's account shows spark at ~100% remaining /
negligible use.)

## Metrics (`metrics.js`)

Stays pure, currency-agnostic, no `Date.now()`. Changes:

1. **Extend `FAMILY_PRICES`** with OpenAI families:
   `'GPT-5.5': {in:5,out:30}`, `'GPT-5.4': {in:2.5,out:15}`,
   `'GPT-5.4-mini': {in:0.75,out:4.5}`, `'GPT-5.4-nano': {in:0.2,out:1.25}`.
2. **Extend `modelFamily(model)`** to map the gpt model slugs. Order matters —
   check `nano`, then `mini`, then `5.4`, then `5.5` so the longer slugs win;
   `spark`/unknown → `null`.
3. `entryCost` / `summarizeCost` are **unchanged** — they already price
   `input_tokens` + `output_tokens` + `cache_read × in × CACHE_READ_MULT`, which
   is exactly right once Codex entries are normalized (below).
4. **New pure functions** (TDD):
   - `costByDay(entries)` → `{ 'YYYY-MM-DD': usdCost }`, keyed by **local** day,
     summing `entryCost`; unpriced entries skipped (consistent with
     `summarizeCost`).
   - `costByMonth(entries)` → `{ 'YYYY-MM': usdCost }`, keyed by **local** month.
   Both take **no reference date** (stay pure); the renderer supplies "today" /
   "last 30 days" / "this month" via `Date.now()`. Local keys are derived by
   reading `getFullYear/getMonth/getDate` (zero-padded) off a parsed `Date`,
   via a shared private helper.

### Unit tests (`node --test`)

- `costByDay`: same-day entries combine; different days separate; unpriced
  skipped; empty → `{}`.
- `costByMonth`: days within a month aggregate; months separate; unpriced
  skipped; empty → `{}`.
- Cross-consistency: sum of `costByDay` for a month equals that month's
  `costByMonth` value.
- `entryCost` / `summarizeCost` price a normalized Codex (`GPT-5.5`) entry
  correctly (input + cached-at-10% + output), and treat `spark`/unknown as
  unpriced.

## New IPC — `readCodexUsage` (`main.js` + `preload.js`)

Mirrors `read-claude-code-usage`. Returns `{ entries: [...] }` or `{ error }`.

- Scan `~/.codex/sessions/**/*.jsonl` recursively (same scanner pattern as the
  Claude Code handler). The tree is date-partitioned (`YYYY/MM/DD/`), so an
  optimization is to skip day-folders outside the needed range; for a first cut,
  scan all and let the renderer filter by timestamp.
- Per file, walk lines; maintain `currentModel` from the latest `turn_context`
  (fallback `session_meta` model, else `'unknown'`).
- For each `payload.type === 'token_count'` with `info.last_token_usage` (`u`)
  and a line `timestamp`, push a **normalized** entry in the existing shape:
  ```js
  {
    timestamp,                                   // ISO string
    model: currentModel,
    input_tokens: Math.max(0, u.input_tokens - u.cached_input_tokens),
    output_tokens: u.output_tokens,              // already includes reasoning
    cache_creation: 0,                           // OpenAI: no separate cache-write bill
    cache_read: u.cached_input_tokens || 0,
  }
  ```
  This shape is exactly what `entryCost` / `costByDay` / `costByMonth` consume —
  no provider branching in the cost math.
- `preload.js` exposes `readCodexUsage: () => ipcRenderer.invoke('read-codex-usage')`.
- Errors (missing dir, parse failures) are swallowed per-file; a missing
  sessions dir returns `{ entries: [] }`.

## Analytics rendering (`analytics-renderer.js`)

The Cost section becomes **provider-agnostic**. Both `codex` and `claude-vscode`
load token entries (via `readCodexUsage` / `readClaudeCodeUsage`), then share the
same rendering: total API-equivalent cost (window-scoped), per-model rows, cache
savings, and the new **"Cost over time"** block. Other accounts keep the existing
"not available" note. The Codex "not available" note is **removed**.

A small loader map selects the IPC by `currentAccount`; everything downstream
(`summarizeCost`, formatting, the over-time block) is identical.

### "Cost over time" block

Appended after the cache-savings line, for any token-logged account. Computed
over the **full token log, independent of the time-window dropdown** (per-day/
month tracking is meaningless at the default "last 24h"); each figure is labeled
("last 30 days" / "this month") so it does not read as conflicting with the
window-scoped total above it. Reuses the entries already fetched for Part A (no
second IPC call) — pass the full, unfiltered entries in.

- **Headline rates:** `avgPerDay` = (sum of `costByDay` over the last 30 calendar
  days, missing days counted as 0) ÷ 30; `projectedPerMonth` = `avgPerDay × 30`.
  Rendered `≈ {fmtMoneyUsd(avgPerDay)}/day · ~{fmtMoneyUsd(projected)}/mo at this
  pace`, with an "estimate" qualifier.
- **Per-day bars:** last 30 calendar days, chronological, one `.peak-bar` each
  (reusing the existing efficiency-section bar visual); height ∝ that day's USD
  cost; tooltip = date + `fmtMoneyUsd(dayCost)`; tallest day labeled; no-usage
  days render as empty bars so the axis stays continuous.
- **Per-month totals:** compact table of the last 3 calendar months
  (`Month · {fmtMoneyUsd(total)}`), newest last; current month suffixed
  "(so far)"; no-usage months show `0`.

All money is display currency via the existing `fmtMoneyUsd(usd)` =
`curSymbol + (usd*usdRate).toFixed(2)`. No new currency state.

## Cross-cutting

- Live updates flow through the existing `onSettingsChanged(() => renderAll())`
  path; no new IPC or settings key.
- `metrics.js` stays USD/pure; conversion and all "now"-relative logic live in
  the renderer (consistent with `windowCutoffMs`).
- HTML escaped via the existing `esc()`; date keys formatted, not interpolated
  raw.

## Testing

- New `node --test` cases above; full existing suite still passes.
- `node --check` on changed JS.
- Manual: Claude Code **and** Codex tabs both show total cost, per-model rows,
  and the over-time block (headline rates, 30-day bars, 3-month table) in `£`;
  Codex figures are non-zero and sane vs. usage; changing the currency rate in
  Settings updates both live; the "not available" note is gone for Codex but
  remains for Claude Desktop.

## Out of scope

- Cost for Claude Desktop (no local token log).
- Scraping the Codex web analytics page for cost (local logs are exact).
- Pricing `gpt-5.3-codex-spark` (unpriced until a public rate exists).
- Tying the over-time block to the time-window dropdown (intentionally full
  history); month-by-month navigation for the per-day bars (fixed last-30-days).
- Forecasting beyond a flat 30-day run-rate.
- Reading `~/.codex/archived_sessions` (only the live `sessions/` tree; may be
  added later if older months are needed).
- Any change to `entryCost` / `summarizeCost` math.
