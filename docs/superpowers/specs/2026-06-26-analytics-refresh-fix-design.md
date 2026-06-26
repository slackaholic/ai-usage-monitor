# Analytics Refresh: Stop Spurious Re-renders & Freezes — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor — `main.js` (IPC), `analytics-renderer.js`

## Problem (root cause)

The analytics window has no timer of its own. It re-renders because:

1. The main monitor polls each account every 1–5 min; each successful poll caches
   results via `saveCachedData()` → `saveSettings({ lastKnown })`
   (`renderer.js:48`).
2. `save-settings` broadcasts `settings-changed` to **all** windows
   unconditionally (`main.js:102`), even for a `lastKnown` cache write.
3. The analytics window runs a full `renderAll()` on every `settings-changed`
   (`analytics-renderer.js:965`).

`renderAll()` then (a) wipes the page to "Loading…" and rebuilds the whole DOM
(`analytics-renderer.js:894`, 931–945) → scroll jump + flash, and (b) on the
Claude Code / Codex tabs calls `renderCost`, which reads hundreds of large
`.jsonl` files **synchronously in the main process** (`read-claude-code-usage` /
`read-codex-usage`), blocking Electron's single main thread → the whole app
freezes. So routine polling spam-triggers a freezing re-render.

## Fix (three parts)

### Part A — Silent keys don't broadcast `settings-changed`

In `main.js`'s `save-settings` handler, broadcast `settings-changed` only when the
patch contains a key that is **not** purely cache/position state.

- `SILENT_KEYS = new Set(['lastKnown', 'x', 'y'])`.
- Broadcast only if `Object.keys(patch)` has at least one key not in
  `SILENT_KEYS`.
- `saveSettings(patch)` itself is unchanged — persistence still happens for all
  keys; only the broadcast is gated.

Effect: routine polling (`lastKnown`) and window drags (`x`/`y`) no longer
refresh other windows. Real settings (currency, prices, opacity, overrides,
refresh interval, compact, hidden sections) still propagate and re-render
analytics as today.

### Part B — Non-blocking, mtime-cached token-log reads

Rework `read-claude-code-usage` and `read-codex-usage` in `main.js`:

- **Async I/O + yielding:** read files with `fs.promises.readFile` and `await`;
  after every ~25 files, yield with `await new Promise(r => setImmediate(r))` so
  the main thread services other work (window paints, input, other IPC) between
  batches instead of blocking for the whole scan.
- **Per-file mtime cache:** a module-scoped `Map` per handler, keyed by file
  path → `{ mtimeMs, entries }`. For each file, `fs.promises.stat` for `mtimeMs`;
  if the cached entry matches, reuse its parsed `entries` and skip re-reading.
  Otherwise read, parse, and update the cache. Files that disappear are simply
  not visited (stale cache entries are harmless; optional prune of paths no
  longer seen). This makes repeat refreshes near-instant and cuts CPU.
- Parsing logic and the returned entry shape are **unchanged** (same objects as
  today). Directory scan still recursive. Errors still swallowed per file; a
  missing directory still returns `{ entries: [] }`.

The two handlers share the same structure, so factor the common
"scan dir → cached-parse files → flatten entries" into one async helper
parameterized by (root dir, per-file line→entries parser). Each handler supplies
its own parser (the existing Claude Code `assistant`/`usage` logic; the existing
Codex `turn_context`/`token_count` logic). One helper, two parsers — no
duplicated scan/cache/yield code.

### Part C — Non-disruptive `renderAll`

In `analytics-renderer.js` `renderAll`:

- **Preserve scroll:** capture `const sc = document.getElementById('body').scrollTop`
  at the start; after the rebuild completes, restore
  `document.getElementById('body').scrollTop = sc`.
- **No flash on refresh:** only show the "Loading…" placeholder when the body is
  currently empty (first render). On subsequent refreshes, leave the existing
  content in place and replace it in one swap when the new sections are ready
  (build the five section elements, then assign `body` children once), instead of
  wiping to "Loading…" first.
- Behaviour otherwise unchanged (same sections, same data).

## Testing

- `node --check` on `main.js` and `analytics-renderer.js`.
- Existing `node --test` metrics suite stays green (no metrics.js change).
- Smoke (throwaway script, then deleted): call the new async read helper logic
  against the real `~/.claude/projects` and `~/.codex/sessions`, assert it returns
  a non-empty, correctly shaped entry set, and that a second call (warm mtime
  cache) returns the same count and is materially faster. Report the numbers.
- Manual GUI: with the monitor polling in the background, the analytics page no
  longer jumps, flashes, or freezes; opening analytics, switching tabs, and
  manual Refresh stay smooth; changing currency in Settings still updates
  analytics live (Part A path preserved).

## Out of scope

- Moving reads to a worker thread / `utilityProcess` (async + yield + mtime cache
  is sufficient).
- Changing poll cadence or what data the analytics page displays.
- Re-introducing any timed auto-refresh in the analytics window (it remains
  manual / real-settings-driven by design; the header already shows "last: <ago>").
