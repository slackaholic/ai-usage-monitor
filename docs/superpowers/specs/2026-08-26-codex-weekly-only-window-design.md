# Codex lost its 5-hour window — map rate-limit windows by duration — Design

**Date:** 2026-08-26
**Status:** Approved (design)
**Component:** AI Usage Monitor — `renderer.js` (`parseCodexApiUsage`,
`parseCodexText`, `renderStat`, `renderBudget`), plus a one-off usage-log
migration.

## Problem

The Codex card shows **5H = 100%** and **WK = —**. The 100% is not a 5-hour
figure at all: it is the *weekly* percentage, painted into the wrong tile.

Root cause: `parseCodexApiUsage` (renderer.js ~1184) keys the two rate-limit
windows by **position** in the `/backend-api/codex/usage` response:

```js
const pw = rl.primary_window || {};    // assumed to be the 5h window
const sw = rl.secondary_window || {};  // assumed to be the weekly window
```

That assumption held until 2026-07-10. OpenAI then **removed the 5-hour window
from the Codex plan**: weekly moved into `primary_window` and
`secondary_window` disappeared. Position is not a stable identifier; the parse
has been mislabelling the weekly figure as a 5-hour figure ever since.

## Evidence this is structural, not transient

Measured over `usage-log.jsonl` (10,790 Codex polls, 2026-06-24 → 2026-08-26):

| | |
| --- | --- |
| Last poll with two windows | **2026-07-10** (primary reset offsets ≤ 5.0h) |
| First poll with one window | **2026-07-13** |
| Codex polls since | **7,128** |
| …carrying a 5-hour window | **0** |
| Largest reset offset since | exactly **168.0h** (7 days) |

Six and a half weeks with a single 604800-second window, and no 5-hour window
in any of 7,128 samples. This matches chatgpt.com/codex, which now presents a
weekly limit plus purchasable credits and "Use reset" tokens, with no 5-hour
section.

Note: the spec of **2026-07-13** saw the missing `secondary_window` and recorded
it as "a legitimate transient (reset-timing)", explicitly out of scope. That was
the day the window structure changed; the diagnosis was wrong.

## Damage this has been doing silently

Verified by running the real `metrics.js` functions over the real log:

- `weeklyPerFiveHourRatio(codex)` since 2026-07-13 → **null** (only 1 poll in
  7,128 has both meters non-null; the function requires both). The Codex budget
  marker is therefore hidden and its note is pinned to "need more history"
  permanently.
- `weeklyBurnSince(codex, last 7d)` → **0**. Weekly runway and Plan Fit are
  blank for Codex.
- The 0.2994 Codex weekly-budget ratio is computed entirely from pre-2026-07-11
  history — a fossil that can never be refreshed while the keys are wrong.
- When the session-token fetch fails, the text scraper runs instead and files
  the *same* weekly number under `wk`. The log therefore alternates between two
  keys for one quantity (7,127 entries under `5h`, 1 under `wk`).

## Decisions (from the user)

1. **Map windows by duration, not position.** Whichever window is weekly lands
   in the weekly slot. The 5H tile stays in place showing **`n/a`** while the
   plan has no 5-hour window, and re-fills on its own if OpenAI restores one —
   no code change needed for that to happen.
2. **Migrate the mislabelled log entries.** Move the value from `5h` to `wk`
   for Codex entries at or after the cutoff, with a timestamped backup of
   `usage-log.jsonl` taken first.

## Change 1 — classify by `limit_window_seconds`

`limit_window_seconds` is the window's own declaration of what it is (18000 =
5h, 604800 = weekly). Split at 24h: anything shorter is a session window,
anything longer is a weekly one.

Fallback chain, so the parse degrades rather than lies:

1. `limit_window_seconds` when it is a positive number — authoritative.
2. Otherwise `reset_at` distance from now: a 5-hour window can never reset more
   than 5 hours out (plus a small slack for clock skew), so a farther reset is
   a weekly window.
3. Otherwise the historic position (primary → 5h, secondary → weekly), which
   keeps the pre-2026-07 behaviour intact for a response that declares nothing.

`now` is a parameter, never read from the clock inside the classifier, so the
behaviour is testable without faking time.

The parse gains a **`has5h`** flag: true when a 5-hour window was actually
present. `shared5h === null` alone cannot distinguish "no such window" from
"momentarily absent", and those must render differently.

## Change 2 — `parseCodexText` reports the same fact

The scraped page no longer contains a 5-hour section either. The text parse sets
`has5h` from whether the page mentions a 5-hour limit at all, so both paths
agree and a fallback poll cannot flip the tile between `n/a` and `—`.

## Change 3 — render `n/a` rather than `—`

`setPct` gains an optional placeholder. `renderStat` passes it through.
`renderCodexData` renders the 5H tile with `n/a` when `has5h` is false. `—`
keeps its existing meaning: a value that *should* be there and momentarily is
not.

The 5h reset line is blanked in the same case — there is no window to reset.

## Change 4 — the budget note tells the truth

`renderBudget` currently says "budget: need more history" whenever the ratio is
null. With no 5-hour window there will never be more history, and the 5h budget
marker is meaningless. When an account has no 5-hour window the note instead
reads that the plan has no 5-hour window, and the marker stays hidden.

## Change 5 — one-off log migration

`scripts/migrate-codex-weekly.js`: for `account === 'codex'` entries at or after
**2026-07-11T00:00:00Z** (the day after the last two-window poll) where `5h` is
non-null and `wk` is null, move the value to `wk` and move `reset5hTs` to
`reset7dTs`. Rewrites `depleted` accordingly. Backs up to
`usage-log.jsonl.bak-<timestamp>` first and reports counts. Idempotent: a second
run finds nothing to do.

Entries before the cutoff are untouched — they are genuine two-window samples.

## Out of scope

- Repurposing the freed 5H tile for credits / reset-token state. Considered and
  declined for now; the tile reads `n/a` instead.
- The Codex plan multiplier and price in `settings.json` — unaffected by the
  window change.
- Claude Desktop and Claude Code windows — Anthropic still reports both, and
  their parse is unrelated.

## Verification

- `npm test` stays green, plus new tests covering: duration-based
  classification, the reversed-position response, the reset-distance fallback,
  the positional fallback, `has5h` from both parse paths, and the migration's
  cutoff/idempotency.
- `node --check` on every changed file.
- Migration verified by re-running the real `metrics.js` functions over the
  migrated log: `weeklyPerFiveHourRatio` and `weeklyBurnSince` must return real
  numbers for Codex again.
- **GUI verification is the user's step** — the Electron app cannot be launched
  in an agent environment.
