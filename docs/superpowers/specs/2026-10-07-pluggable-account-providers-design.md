# One normalised reading per account — make a new provider cheap — Design

**Date:** 2026-10-07
**Status:** Approved (design)
**Component:** AI Usage Monitor — `renderer.js` (parse/render/registration),
`main.js` (dead-handler removal).

## Problem

Adding a fourth monitored agent (Gemini, Copilot, Cursor) currently costs edits
in **eight files**. The obvious culprit looks like the hand-written card markup;
it isn't. The real barrier is that the three existing providers each invented
their own vocabulary for the same four numbers.

| | Codex | Claude Desktop | Claude Code |
| --- | --- | --- | --- |
| 5h value | `shared5h` (remaining) | `sessionUsed` (**used**) | `pct5h` (remaining) |
| weekly value | `sharedWeek` (remaining) | `weeklyUsed` (**used**) | `pct7d` (remaining) |
| 5h reset (ms) | `reset5hMs` | `sessionResetMs` | `reset5hMs` |
| weekly reset (ms) | `reset7dMs` | `weeklyResetMs` | `reset7dMs` |
| card label from | `email` | `email` | `account` |
| id / log key | hardcoded `'codex'` | hardcoded `'claude'` | from descriptor |

Three names for four numbers, two of them polarity-inverted. The consequence is
`renderCodexData`, `renderClaudeWebData` and `renderClaudeCodeApiData`: three
functions performing the **same ten steps in the same order**, differing only in
field names and hardcoded ids. Every render-layer change has to be made three
times — and when it isn't, the three cards drift apart.

The second cost is registration. Seven module-level objects must learn about
every account: `accountOverrides`, `hasData`, `cachedData`, `lastPct5h`,
`LOG_ACCOUNT`, `trendHistory` (two keys) and `_ss`. Codex and Claude Desktop
hardcode their slots in the literals at the top of `renderer.js`; Claude Code
seeds its slots in a loop inside `buildClaudeCodeCards`. The loop is correct and
general — it is simply not reachable by the other two.

## What already works and should be reused

The multi-account Claude Code work (2026-08-11) built the generic path once:
a descriptor from `accounts.js` → `<template>` clone → automatic registration
into all seven objects → one render function parameterised by descriptor. That
is the shape to extend, not replace.

`loadCachedClaudeCodeData` is also already read-tolerant: it accepts either
`{sessionUsed, weeklyUsed}` or `{pct5h, pct7d}`. That establishes the precedent
this design follows for cache compatibility.

## Decision (from the user)

Normalise the reading and collapse the three render functions into one.
**Do not** generalise the card markup or introduce provider modules with a
generic fetch-dispatch IPC — those were considered and deferred until a real
fourth provider exists to validate the requirements. A new provider drops from
eight files to three: markup, a fetch function, and one descriptor entry.

Context for that decision, from research on 2026-10-07:

- **Gemini CLI is a poor first candidate.** Not installed on this machine (no
  `~/.gemini`, not on `PATH`). Its quota is reachable only through `/stats
  model`, an interactive slash command inside the CLI; no non-interactive or
  machine-readable route was found. Google's account-level figures meter a
  *project*, not the Code Assist seat the CLI consumes.
- **Copilot is the strongest candidate** and is already installed
  (`~/.copilot`). `GET /users/{user}/settings/billing/premium_request/usage`
  with a fine-grained PAT returns `grossQuantity` / `netQuantity` / `limit`.
  It needs a user-supplied secret, which is a separate design question.

Neither is being built here. This design only removes the cost of building one.

## Hard constraint

**Log keys are immutable.** Over 7,000 entries in `usage-log.jsonl` hang off the
exact strings `codex`, `claude-desktop` and `claude-vscode`. Nothing in this
refactor may change an account's `logKey`, the `usage-log.jsonl` entry shape, or
the `5h` / `wk` keys inside it. The two key namespaces stay distinct: `logKey`
(prices, tier dates, multipliers, log entries) and descriptor `id` (label
overrides, DOM ids).

## Change 1 — the normalised reading

Every provider's parse step returns exactly this shape:

```js
{
  pct5h:     number | null,  // REMAINING %, always — never "used"
  pctWk:     number | null,
  reset5hMs: number,         // epoch ms; 0 = unknown
  resetWkMs: number,
  has5h:     boolean,        // false = the plan has no such window
  hasWk:     boolean,
  label:     string | null,  // email or account name for the card label
  extra:     object | null,  // provider-only display bits (e.g. Codex credits)
}
```

Polarity is fixed at the parse boundary: `parseClaudeOrgUsage` and
`parseClaudeWebText` convert their `*Used` figures to remaining there, so no
code downstream of parse ever sees a "used" percentage.

`has5h` already exists on the Codex path (added 2026-08-26, when OpenAI removed
the Codex 5-hour window). `hasWk` is its symmetry: the Claude Code API stopped
returning the `7d` header pair for a period in August, which is the same "no
such window" state and currently renders as a bare `—` rather than `n/a`.
Including it now costs one field; adding it later means revisiting every parse
function again.

`extra` is the escape hatch for genuinely provider-specific display. Today its
only occupant is Codex's `{ credits }`. It is display-only — nothing in the
log or metrics may read it.

**Who renders `extra`:** not `renderAccountData`, which must stay ignorant of
any one provider's DOM. The descriptor carries an optional
`renderExtra(acct, extra)`; `renderAccountData` calls it, if present, as its
last step before `resizeToFit`. Codex's descriptor supplies the one line that
exists today:

```js
renderExtra: (acct, extra) => setText('codex-credits', extra.credits),
```

A provider with no extras omits the hook entirely. This keeps the single render
path free of `if (acct.id === 'codex')`, which is the branch the whole refactor
exists to avoid.

## Change 2 — one descriptor, one registration

`registerAccount(descriptor)` is extracted from the loop currently inside
`buildClaudeCodeCards` and becomes the single place any account is wired into
the seven module-level objects. All three providers call it.

Codex and Claude Desktop become entries in a `PROVIDERS` array alongside their
existing hardcoded behaviour:

```js
const PROVIDERS = [
  { id: 'codex',  logKey: 'codex',          label: 'Codex',
    fetch: fetchCodexUsage },
  { id: 'claude', logKey: 'claude-desktop', label: 'Claude Desktop',
    fetch: fetchClaudeWebUsage },
];
```

Claude Code descriptors continue to arrive at runtime from `accounts.js` and are
appended to the same list. `accountPrefixes()` derives from the list rather than
from a literal, so nothing can be registered in one place and forgotten in
another — the class of bug that made the card-rebuild path unreachable in the
August work.

The descriptor carries two behaviour flags, replacing branches that currently
live inside the render functions:

- `exactSessionFromReset: true` — Claude Code derives `sessionStart` exactly
  from the reset header (5h before the next reset) rather than inferring it from
  a quota jump via `trackSession`.
- No flag is needed for Codex's suppressed `sessionStart`: it already falls out
  of `has5h === false`.

## Change 3 — one render path

```js
function renderAccountData(acct, reading, stale = false)
```

replaces `renderCodexData`, `renderClaudeWebData` and
`renderClaudeCodeApiData`. The shared sequence, which all three already perform
identically:

1. `applyAccountLabel(acct.id, reading.label)` — skipped when `stale`
2. `renderStat(acct.id, '5h', reading.pct5h, reading.has5h ? undefined : 'n/a')`
3. the same for `wk`, gated on `hasWk`
4. `renderBudget(acct.id, reading.pct5h)`
5. reset lines, blanked when the window does not exist
6. `pushTrend` ×2, `saveCachedData`
7. `buildUsageEntry(acct.logKey, …)`
8. `sessionStart` per the descriptor flag
9. `appendUsageLog`
10. hide login prompt, show data, `showSection`, `resizeToFit`

Steps 6–9 remain gated on `!stale` exactly as now.

## Change 4 — cache compatibility without a migration

`normaliseCachedReading(raw)` accepts all three legacy shapes plus the new one
and emits the normalised reading. `settings.json` is **not** migrated: it is
rewritten wholesale by `saveCachedData` on the first poll after restart, so the
legacy shapes need to survive exactly one startup render.

`loadCachedStaticData` and `loadCachedClaudeCodeData` both route through it and
then call the single `renderAccountData`. The existing dual-shape handling
inside `loadCachedClaudeCodeData` is deleted, not duplicated.

A cached reading has no `has5h` / `hasWk`. Absent means **unknown**, which
renders `—`, not `n/a` — asserting "this plan has no 5h window" from a stale
cache would be a claim the cache cannot support. The first live poll settles it.

## Change 5 — incidental cleanups in scope

- **Delete `ipcMain.handle('fetch-url', …)`** (`main.js` ~1422). It is dead:
  never exposed in `preload.js`, never called from any renderer. It accepts an
  arbitrary URL, method, headers and body from the renderer and performs the
  request from the main process — an unused general-purpose HTTP proxy. If a
  future token-based provider needs one, it should be reintroduced deliberately,
  scoped to a host allowlist.
- **Collapse the retry timers.** Three patterns exist for one concept:
  `claudeRetryTimer` (scalar), `codexRetryTimer` (scalar) and
  `claudeRetryTimers` (map, keyed by id). One map keyed by descriptor id,
  cleared by `registerAccount`.

## Out of scope

- Template-generated cards for Codex and Claude Desktop. Deferred: the three
  cards genuinely differ (Codex has a credits line, Claude Desktop a token block
  and Import/Log-off buttons, Claude Code a credentials path), and designing the
  optional-slot mechanism before a fourth provider exists would be guesswork.
- Provider modules with a generic `fetch-provider-usage` IPC dispatch.
- Actually adding Gemini, Copilot or Cursor. Each needs its own spec, and
  Copilot additionally needs a decision on storing a user-supplied PAT.
- Any change to `metrics.js`, the analytics window, or the usage-log format.

## Verification

- **The test that proves the collapse:** feed all three providers an identical
  normalised reading and assert the resulting DOM is identical. This fails
  against current code — Claude Desktop inverts polarity — so it discriminates
  rather than restating the implementation.
- Per-provider vm-slice tests that each `parse*` emits the normalised shape,
  reusing the harness in `test/codex-usage.test.js`.
- `normaliseCachedReading` against all three legacy shapes plus an empty one,
  asserting absent `has5h` renders `—` and never `n/a`.
- A regression test that `buildUsageEntry` still receives `logKey`, not `id` —
  the defect class that would silently detach 7,000 log entries.
- `npm test` stays green (172 at the time of writing); `node --check` on every
  changed file.
- **GUI verification is the user's step** — the Electron app cannot be launched
  in an agent environment. The specific things only a human can confirm: all
  three cards still render after the collapse, the compact view still matches,
  and a Rescan still adds a Claude Code card.
