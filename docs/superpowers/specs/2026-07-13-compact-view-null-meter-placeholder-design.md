# Compact view: keep the card and show "—" when a meter is null — Design

**Date:** 2026-07-13
**Status:** Approved (design)
**Component:** AI Usage Monitor — `renderer.js` (`renderStat`).

## Problem

In the compact view, a mini-stat card **disappears** when its percentage reads
null, and the remaining cards reflow to fill the gap — which looks like a card
is broken or lost.

Root cause: every stat is rendered by `renderStat(prefix, win, pct)`, whose last
line gates the compact card on the value being present:

```js
showCompactStat(`${prefix}-${win}`, pct != null);   // renderer.js ~571
```

`showCompactStat(id, false)` hides the card. So when one meter is momentarily
null — e.g. Codex's **weekly** value right after a 5h reset, when
`/backend-api/codex/usage` returns no `secondary_window` (`sharedWeek` → null,
renderer.js ~897) — its compact card vanishes while the sibling 5h card (100%)
stays.

This is inconsistent with the **full view**, whose cards are static HTML and
show `—` for a null meter (via `setPct`, renderer.js ~528) rather than
disappearing.

## Decision (from the user)

Make the compact view match the full view: **keep the card in place and show
`—`** when a meter is momentarily null, instead of removing it.

## Key facts that make this safe (verified against current code)

- `setPct('c-<prefix>-<win>', pct)` already writes `—` for a null pct
  (renderer.js ~528). The value rendering needs no change — only the card's
  visibility gate does.
- `renderStat` is reached **only when an account produced at least one non-null
  meter**. All three fetchers early-return before their render function on total
  failure:
  - Codex: both-null guard (`renderer.js ~955`) returns before `renderCodexData`.
  - Claude Desktop: both-null guard (`renderer.js ~773`) returns before
    `renderClaudeWebData`.
  - Claude Code: any `result.error` (including `no-credentials` /
    `no-rate-limit-headers`) returns before `renderClaudeCodeApiData`
    (`renderer.js ~833-843`).
  So a fully-absent or errored account never calls `renderStat` → its cards stay
  hidden. Only a **partial** null (one meter null while the sibling has data)
  reaches `renderStat`.
- `applyCompactStat` gates on `hiddenSections` independently
  (`show = !!compactStatData[id] && !hiddenSections.has(sectionId)`,
  renderer.js ~463), so manual section-hiding is unaffected by this change.

## Change — `renderer.js`

In `renderStat` (renderer.js ~567), change the final line from:

```js
  showCompactStat(`${prefix}-${win}`, pct != null);
```

to:

```js
  showCompactStat(`${prefix}-${win}`, true);
```

Rationale: reaching `renderStat` means the account rendered, so its compact card
belongs in the grid; the value element handles null via `—`. `showCompactStat`'s
only caller is this line, so after the change `compactStatData[id]` is set `true`
whenever a stat renders, and card visibility is governed solely by
`hiddenSections` — exactly the intended behaviour.

No other lines change. `showCompactStat`, `applyCompactStat`,
`refreshCompactStatsForSection`, `setPct`, and the full-view rendering are all
untouched.

## Behaviour after the change

| Situation | Before | After |
|---|---|---|
| One meter null, sibling has data (e.g. Codex weekly post-reset) | card removed, grid reflows | card stays, shows `—` |
| Both meters null / fetch error | cards hidden (renderStat not called) | cards hidden (unchanged) |
| Section manually hidden | cards hidden | cards hidden (unchanged) |
| Cached/stale render with a null meter | card removed | card stays, shows `—` (consistent) |
| Meter recovers on next refresh | card reappears | card updates from `—` to value |

## Testing

`renderer.js` cannot be cleanly loaded or vm-sliced under `node --test`: it has
top-level DOM side effects (`document.querySelectorAll(...).forEach(addEventListener)`,
`getElementById(...).addEventListener(...)`) that run on evaluation and require a
live DOM. The repo has no renderer unit harness for this reason; its tests cover
only the pure modules (`metrics.js`, `usage-reader.js`, `analytics-renderer.js`).
Verification for this one-line visibility change:

- `node --check renderer.js` — no syntax errors.
- `npm test` — full existing suite stays green (no logic module touched).
- Manual GUI (user): in compact view, when a meter is momentarily null, its card
  stays with `—` instead of disappearing; when the value returns it fills in;
  hiding an account's section still removes both its compact cards.

## Out of scope

- Why Codex weekly (`secondary_window`) is sometimes absent — treated as a
  legitimate transient (reset-timing) per the diagnosis; not changing the parse.
- Full-view rendering — already shows `—`; unchanged.
- The `pushTrend`, cache, and usage-log writes in the render functions —
  unchanged (they already handle null independently).
