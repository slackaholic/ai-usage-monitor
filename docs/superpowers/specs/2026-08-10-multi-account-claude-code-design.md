# Multiple Claude Code accounts, one card each — Design

**Date:** 2026-08-10
**Status:** Approved (design)
**Component:** AI Usage Monitor — new `accounts.js`; `main.js` (credentials,
Claude Code IPC, budget); `index.html` / `renderer.js` (card template, per-account
state); `settings.html` / `settings-renderer.js` (per-account rows);
`analytics.html` / `analytics-renderer.js` (tabs, labels, multipliers).

## Problem

The Claude Code card can only ever show one account. Its usage comes from
`~/.claude/.credentials.json`, which holds exactly one account's OAuth tokens and
is overwritten on every `claude login` — so logging in as a second account
replaces the first rather than adding to it. Everything downstream assumes that
singularity: `main.js` has a single `CREDENTIALS_PATH` constant,
`BUDGET_ACCOUNTS` is a three-element literal, `renderer.js` keys its state maps
on the literals `codex` / `claude` / `claude2`, `index.html` hand-writes 28
`claude2-*` ids (plus six `cs-*` compact ids), and both the settings and
analytics windows carry their own hardcoded three-account lists.

The user runs more than one Claude account and wants both meters visible at once.

## Facts established during design (verified, not assumed)

- Installed CLI is **2.1.202**; its binary references `CLAUDE_CONFIG_DIR`, so a
  second simultaneous login is supported by pointing an instance at a different
  config directory, which then owns its own `.credentials.json`.
- The VS Code extension and the terminal CLI **share** `~/.claude`, so they
  cannot by themselves provide two accounts.
- This machine currently has one Claude config directory, `~/.claude`.
  `~/.codex/.credentials.json` is the unrelated OpenAI login. The home directory
  also holds `.claude.json` and five `.claude.json.bak*` files, none of which are
  config directories.
- The 5h/weekly quota is **per account and shared across every surface** — the
  desktop app, the CLI, the VS Code extension and the web. Observed directly:
  once the Claude Desktop and Claude Code cards both pointed at
  `Rommel.payba@phase-electrical.co.uk`, both read 57% with the same reset time.
  Two views of one quota, not two quotas.

## Decisions (from the user)

1. **Accounts are the user's own, live simultaneously**, each backed by its own
   Claude config directory.
2. **The app discovers config directories itself** rather than being told where
   they are; an explicit path remains available as an escape hatch, because
   `CLAUDE_CONFIG_DIR` can point anywhere.
3. **Each account gets its own card**, matching the existing three, rather than a
   switcher or stacked rows.
4. **Existing history stays with the account currently logged in.** The 7,099
   `claude-vscode` entries are neither split nor archived; additional accounts
   start empty. (Default taken when the question went unanswered; reversible.)
5. **Only the Claude Code family becomes dynamic.** Codex and Claude Desktop stay
   single-account. The registry is shaped so Codex could adopt it later — a
   browser partition per account is structurally the same problem — but that is
   not built here.

## Design

### The registry (`accounts.js`, new)

A normal Node module in the spirit of `usage-reader.js`: `fs` and `os` allowed,
no Electron imports, so `node --test` can drive it directly. It is the single
source of truth every other layer reads. Descriptor shape:

```js
{
  id:        'claude2',                 // renderer prefix / DOM id namespace;
                                        // 'claude2' for ~/.claude (keeps the
                                        // existing DOM + settings keys working),
                                        // otherwise 'cc-' + the directory name
                                        // slugified to [a-z0-9-]
  kind:      'claude-code',
  configDir: 'C:\\Users\\…\\.claude',
  configDirs:['C:\\Users\\…\\.claude'], // every dir resolving to this account
  logKey:    'claude-vscode',           // usage-log.jsonl account key
  label:     'rommel.payba@…',          // OAuth profile email, once known
}
```

### Discovery

In order: honour `CLAUDE_CONFIG_DIR` when set; scan `os.homedir()` for
directories matching `.claude*` that contain a `.credentials.json` carrying a
`claudeAiOauth.accessToken`; add explicit paths from settings. Then dedupe by
`fs.realpathSync` and sort with `~/.claude` first and the rest alphabetically, so
card order never changes between runs.

The credentials-file test is what keeps the noise out: `.claude.json` and the
`.bak*` files are not directories and hold no OAuth token, so they never appear.

Discovery runs **at startup and on demand from Settings — not every poll.**
Adding an account is a deliberate act, and cards appearing or vanishing mid-poll
is worse than a minute of staleness.

Two distinct operations, deliberately separated: **rescan** touches the
filesystem and only runs at startup or on demand; **regroup** recomputes
descriptors from the already-scanned directories plus the current email map, is
pure, and runs whenever a profile email resolves. That is what lets a
same-account collapse take effect without waiting for a manual rescan.

### Identity: directories vs accounts

Directory identity is not account identity — two config directories can be logged
into the same account, and because the quota is shared they would render two
cards with identical numbers.

So once the OAuth profile resolves an email, directories sharing that email
**collapse into one descriptor**: one card (noting it is backed by more than one
directory), one API probe, one log key. The email→account mapping is cached in
settings so this holds from first paint on subsequent starts, rather than only
after the profile call lands. Before any profile has ever resolved, directories
are treated as distinct; the first successful resolution collapses them.

### `logKey`: how history survives

`~/.claude` keeps the key `claude-vscode`. That single mapping is what keeps the
existing 7,099 entries attached to their card. Any other directory gets
`claude-code:<dirname>`, starting empty.

The key is derived from the **directory, not the email**, deliberately: emails
change with a re-login, and re-keying history on a login change would orphan
history — the failure mode already fixed once today. When directories collapse
into one account, the surviving key is the first (sorted) directory's, so history
never forks.

### `label`

The OAuth profile email, from the existing `fetchClaudeCodeProfileEmail`, with
its memo becoming per-account rather than global. Falls back to the
`rateLimitTier` string when the profile call fails.

## Changes

### `accounts.js` (new)

`scanClaudeCodeConfigDirs({ homeDir, env, extraPaths })` → validated directory
paths (touches the filesystem). `groupIntoAccounts(dirs, { homeDir, knownEmails })`
→ descriptor array (pure). `deriveLogKey(configDir, homeDir)` → the key (pure).
Splitting scan from group is what makes everything except the directory walk
testable without a filesystem or the network.

`knownEmails` is the persisted `configDir → email` map, stored in settings under
`claudeAccountEmails`.

### `main.js`

- `CREDENTIALS_PATH` is retired. `readCredentials`, `getValidClaudeCodeToken`,
  `fetch-claude-code-api-usage` and `fetch-claude-code-email` all take a
  `configDir`.
- The email memo and its failure cooldown become per-account (keyed by config
  directory plus access token, preserving today's token-keyed invalidation).
- Token refresh write-back becomes **write-temp-then-rename**, so a Claude Code
  process reading the file mid-refresh cannot observe a half-written one.
- `BUDGET_ACCOUNTS` is derived from the registry instead of being a literal.
- A new IPC handler returns the registry to the renderer, settings and analytics
  windows; a second one triggers rediscovery on demand.

### `preload.js`

The two Claude Code invocations gain an account argument; two new bridges for
reading and refreshing the registry.

### `index.html` / `renderer.js`

- The `claude2-section` markup becomes a `<template>`, cloned once per account
  into a container, with ids built from the descriptor's `id`. The compact view's
  `cs-*` pair per account is generated the same way.
- `hasData`, `cachedData`, `trendHistory`, `LOG_ACCOUNT`, `lastPct5h`,
  `accountOverrides`, `_ss` and the retry timers stop being three-key literals
  and are built from the registry. Most render helpers already take a `prefix`
  argument and need no change.
- `setRefreshInterval`'s four independent `setInterval`s collapse to one timer
  fanning out over the registry, so every account's reading comes from the same
  instant.

### `settings.html` / `settings-renderer.js`

Per-account rows (price, tier-change date, multiplier) are generated from the
registry and keyed by `logKey`; the label override is keyed by descriptor `id`.
Because `~/.claude` keeps `claude-vscode`, previously saved values carry over
untouched. Adds the "rescan for accounts" control and the explicit-path escape
hatch.

### `analytics.html` / `analytics-renderer.js`

`VALID_ACCOUNTS`, `ACCOUNT_LABELS`, `PLAN_MULTIPLIERS` and the three hardcoded
tab buttons are all built from the registry passed in over IPC.

### `metrics.js`

**Unchanged.** It takes entries and a window and has no concept of an account, so
the dual-load constraint and its test suite are untouched. This is the main
reason the change stays contained.

## Data flow (after)

1. Startup: main discovers config directories → collapses same-email directories
   using the cached email map → publishes the registry.
2. Renderer clones one card per descriptor, paints cached values, starts one
   timer.
3. Each tick, for every descriptor: read that directory's credentials → refresh
   the token if near expiry (atomic write) → probe `/v1/messages` → parse headers
   via the existing `parseUnifiedRateLimitHeaders` → render → append a log entry
   under that descriptor's `logKey`.
4. In parallel, each descriptor's email resolves from the OAuth profile, memoised
   per account; a newly-resolved email that matches another descriptor triggers a
   collapse on the next discovery.

## Error handling

- **Per-account isolation.** Each card keeps its own badge and retry timer; one
  account's expired token never stops another polling.
- **Missing or unrefreshable credentials** still get a card, showing "No
  credentials". A visibly failing card beats a silently absent one.
- **Discovery failure** (e.g. a permissions error reading the home directory)
  falls back to `~/.claude` alone rather than rendering nothing.
- **A directory that disappears** loses its card at the next discovery; its
  history stays in the log.
- **Concurrent credential writes.** The monitor and a running Claude Code process
  can both refresh the same file. Atomic rename makes a torn read impossible; it
  does not make the two writers coordinate, and the loser's refresh is simply
  superseded.

## Testing

- `accounts.js` over a temp directory tree (the `usage-reader.test.js` pattern):
  default directory only; an extra directory; `CLAUDE_CONFIG_DIR` honoured;
  `.claude.json` and `.bak*` rejected; realpath dedupe; stable ordering.
- `deriveLogKey` as a table test, **including an explicit assertion that
  `~/.claude` maps to `claude-vscode`.** That guarantee is what keeps 7,099
  entries attached to their card and must fail loudly if anyone ever tidies it.
- Same-email collapse as a pure test: two directories, one email → one
  descriptor, first directory's `logKey`, both paths retained in `configDirs`.
- Card cloning through the vm-slice harness already used by `test/renderer.test.js`.
- The existing 89 tests stay green; the real-log test is widened to tolerate
  account keys it does not recognise.

## Out of scope

- **Codex and Claude Desktop stay single-account.** The registry shape does not
  preclude Codex adopting it later.
- **A new account reads "budget: need more history"** until it accumulates some.
  Expected, not a fault.
- **The `5H TOKENS USED` block stays where it is.** Its input/output/message
  figures come from `~/.claude/projects/**` — Claude Code's local logs — but it
  renders on the *Claude Desktop* card under unprefixed ids (`5h-input`,
  `5h-output`, `5h-msgs`). With several config directories each owning a
  `projects/` tree, that block becomes ambiguous. It keeps reading the default
  directory. Re-homing it onto the Claude Code cards as per-account token and
  cost data is a worthwhile change and a separate one.
