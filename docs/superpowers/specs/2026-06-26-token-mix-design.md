# Token Mix (effective vs cached) — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor — `metrics.js`, analytics window (`analytics-renderer.js`, `analytics.html`)

## Goal

Explain at a glance why a heavy Claude Code / Codex session barely moves the 5h/
weekly usage gauge: most token volume is **cache reads**, which are heavily
discounted (~10%) both in cost and in how the rate limit weighs them. Add a
compact "token mix" breakdown to the analytics Cost section showing fresh input,
output, cache writes, and cache reads for the selected window, with a thin
proportion bar and a one-line takeaway.

## Context (existing)

- `analytics-renderer.js` `renderCost(container)` already loads token entries for
  `claude-vscode` and `codex` (provider-agnostic, via `TOKEN_LOADERS`), filters
  them by the time-window dropdown into `toks`, and renders a window total +
  per-model table + cache-savings line. Entries are shaped
  `{ timestamp, model, input_tokens, output_tokens, cache_creation, cache_read }`.
- `fmtTokens(n)` formats token counts; `esc(s)` escapes HTML. `metrics.js` is the
  pure engine (dual-loaded, no `Date.now()`/argless `new Date()`).
- This block belongs to Part A (token-logged accounts only); other accounts are
  unaffected.

## Behaviour

- **Window scope:** follows the existing time-window dropdown — uses the same
  window-filtered entries (`toks`) as the cost total beside it. At "Last 24h" it
  shows the 24h split; switchable.
- **Provider scope:** both `claude-vscode` and `codex` (same entry shape, same
  cache dynamic).
- Hidden when there are no entries in the window (the existing "No token data in
  this window" path covers that case).

## Metrics (`metrics.js`)

New pure function (TDD):

- `tokenMix(entries)` → `{ input, output, cacheWrite, cacheRead, total }`, summing
  `input_tokens`, `output_tokens`, `cache_creation`, `cache_read` across entries;
  `total` = sum of all four. Empty/undefined input → all zeros. No pricing, no
  dates — pure counts. Added to the `module.exports` footer.

### Unit tests (`node --test`)

- Sums each field across multiple entries; `total` equals the sum of the four.
- Missing fields default to 0; empty/`undefined` input → all zeros.

## Rendering (`analytics-renderer.js` + `analytics.html`)

In `renderCost` Part A, after the per-model table and before/around the
cache-savings line, render a "Token mix" block from `tokenMix(toks)`:

- **Counts line:** four labeled figures via `fmtTokens` —
  `fresh input X · output Y · cache write Z · cache read W`.
- **Proportion bar:** a thin horizontal stacked bar (one segment per field,
  width = field ÷ total) so the cache-read share is visually obvious. Distinct
  colors per segment; each segment has a `title` tooltip with its label, count,
  and percentage. When `total` is 0 the bar is omitted.
- **Takeaway line:** dynamic, e.g.
  `cache reads = {cacheReadPct}% of tokens but weigh ~10% — why heavy sessions barely move the limit.`
  Only shown when `cacheRead` is a meaningful share (e.g. > 0); the percentage is
  computed in the renderer (`cacheRead / total`).

All values are token counts (no currency). Numbers formatted via `fmtTokens`;
any interpolated text escaped via `esc` where dynamic.

### CSS (`analytics.html`)

Add minimal styles for the stacked bar near the existing cost styles:

- `.token-mix-bar` — a flex row, fixed small height (e.g. 8px), rounded,
  `overflow:hidden`, full width.
- `.token-mix-seg` — `height:100%`; background set inline per segment.
- A small caption/label style may reuse the existing `.cost-sub` / `.eff-cap`
  classes rather than new ones.

Segment colors: reuse existing CSS variables (e.g. `--green`, `--amber`,
`--accent`, `--text-mid`) — no new color tokens.

## Testing

- New `node --test` cases for `tokenMix`; full existing suite still passes.
- `node --check` on changed JS.
- Manual: analytics Cost section on the Claude Code tab shows the four counts, a
  thin stacked bar dominated by the cache-read segment, and the takeaway line;
  switching the time-window changes the figures; the Codex tab shows the same
  block with its own numbers; non-token accounts are unaffected.

## Out of scope

- The main always-on window (placement chosen: analytics only).
- Changing the cost math or the rate-limit gauge itself.
- A separate "effective limit consumption" estimate beyond the volume breakdown
  (the takeaway explains the weighting qualitatively; we do not recompute
  Anthropic's internal limit weighting).
