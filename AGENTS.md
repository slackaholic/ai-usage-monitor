# AGENTS.md — AI Usage Monitor

Orientation for **any** AI coding agent picking up this repo (Claude Code,
Codex, Cursor, Gemini, etc.). This is the agent-agnostic source of truth; tool-
specific entry files (`CLAUDE.md`, etc.) just point here. Read this, then
`README.md` (user-facing feature tour) and the relevant spec in
`docs/superpowers/specs/`.

## What this is

A local **Electron** desktop app that shows rate-limit usage for three
coding-AI subscriptions side by side, plus an analytics window with cost and
efficiency breakdowns. Everything runs locally against the same endpoints the
user's tools already use, with their existing credentials. No data leaves the
machine.

The three accounts and **where each number comes from** are non-interchangeable
— this is the single most important domain fact. See `README.md` (table at top).

- **Claude Code** (`claude-vscode`) — the remaining-% gauge is Anthropic's
  official `anthropic-ratelimit-unified-5h/7d-utilization` response headers
  (`fetch-claude-code-api-usage` in `main.js`); token/cost data is separate,
  from `~/.claude/projects/**/*.jsonl`.
- **Codex** — exact per-turn tokens from `~/.codex/sessions/**/*.jsonl`; the
  web rate-limit meter is a different source; no dollar cost (plan-included).
- **Claude Desktop** (`claude`) — claude.ai web org-usage endpoint only; no
  token-level data.

The gauge "barely moving" under heavy use is **correct, not a bug**: ~95%+ of
token volume is cache reads, weighted ~10% against both cost and the limit.

## Process model & file map

| File | Role |
| --- | --- |
| `main.js` | Electron **main process** — windows, tray, all IPC handlers, all data fetching/scraping. Single-threaded: heavy synchronous work here freezes the whole app. |
| `preload.js` | `contextBridge` → `window.electronAPI`. The full renderer↔main surface. |
| `index.html` / `renderer.js` | Main monitor window (the polling loop lives here). |
| `analytics.html` / `analytics-renderer.js` | Analytics window (`contextIsolation: true`). |
| `settings.html` / `settings-renderer.js` | Settings window. |
| `metrics.js` | **Pure** metrics/cost engine — shared by the analytics window (browser global) AND the tests (CommonJS). See constraints below. |
| `usage-reader.js` | Async, mtime-cached JSONL token-log readers (normal Node module). |
| `test/` | `node --test` suites (`metrics.test.js`, `usage-reader.test.js`). |

## Hard constraints (do not break)

- **`metrics.js` is dual-loaded.** It runs as a browser `<script>` global in the
  analytics window AND is `require()`d by tests via a `module.exports` footer.
  Therefore: **no `Date.now()` and no argless `new Date()`** (they'd differ
  between contexts and break determinism) — `new Date(isoString)` is fine.
  **No new dependencies**, no Node-only APIs. Keep functions pure.
- **`usage-reader.js` is a normal Node module** — `Date`, `fs.promises`,
  `setImmediate` are all allowed here. This is deliberately separate from
  `metrics.js` so the readers can be async without violating the rule above.
- **Token entry shapes are fixed.** Claude Code:
  `{ timestamp, model, input_tokens, output_tokens, cache_creation, cache_read }`.
  Codex is normalized through `normalizeCodexTokenUsage` in `metrics.js`
  (input excludes cached; `cache_read` = cached; `cache_creation` = 0; output
  passes through). Don't change shapes or the cost math when doing UX/perf work.
- **Reads must not block the main thread.** Token-log scans go through
  `usage-reader.js` (async + yields every 25 files + per-file mtime cache).
  A prior synchronous version froze the app ~6s on each analytics refresh.
- **The `save-settings` broadcast is gated.** In `main.js`,
  `SILENT_SETTINGS_KEYS = {lastKnown, x, y}`: those (per-poll cache writes,
  window drags) persist but do **not** broadcast `settings-changed`. Every
  other key (currency, prices, opacity, overrides, refresh interval, compact,
  hidden sections) still broadcasts so the analytics window live-updates. Don't
  add a per-poll write outside that silent set or you'll resurrect the
  spurious-refresh problem.
- **`renderAll()` swaps atomically.** It builds all five sections off-DOM
  (while the old content stays visible), then swaps in once via
  `replaceChildren`, and preserves `#body.scrollTop`. Do **not** clear `#body`
  before the async fetch/populate — that blank frame is a visible flash.

## Conventions

- **Workflow (agent-neutral):** features go through brainstorm → a written
  **spec** in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` → a written
  **plan** in `docs/superpowers/plans/` → implement **test-first (TDD)**, one
  commit per logical change. The user approves the spec and the plan before
  implementation. Bugs: find the **root cause before any fix** (don't patch
  symptoms). If your agent provides structured skills for these phases (e.g.
  Claude Code's superpowers, or an equivalent), use them — the directory names
  above come from that workflow but the process is what matters, not the tool.
- **Branching:** work on a feature branch off `main`; the user typically
  chooses "merge locally" then push. The user has standing authorization to
  commit and push without confirmation.
- **Commit trailer:** add a co-author trailer identifying the agent that did
  the work, e.g. `Co-Authored-By: <agent/model name> <noreply@…>`.
- **Verify before commit:** `npm test` (must stay green — 36 tests) and
  `node --check <file>` on any changed JS. The **Electron GUI cannot be
  launched in an agent/headless environment** — GUI verification is the user's
  step; say so rather than claiming visual confirmation.
- **Environment:** Windows. A POSIX shell (Git Bash) and PowerShell are both
  available; pick per command. Primary dir:
  `C:\Users\Rommel Payba\.claude\sessions\ai-usage-monitor`.

## Where the record lives

- **Git history** — each merge/commit body explains its root cause and approach.
- **`docs/superpowers/specs/`** — the "why" + approved behavior per feature.
- **`docs/superpowers/plans/`** — task-by-task implementation with exact code.
- **`docs/handoff/next-session-prompt.md`** — the canonical paste-into-a-fresh-
  conversation handoff; regenerate it when asked for a handoff.
- **Agent-local stores that do NOT travel via clone** (may be absent for you):
  a per-agent persistent memory directory, and a `.superpowers/sdd/` ledger of
  task progress. Don't rely on them existing; this file folds in the facts that
  matter so the critical knowledge survives a fresh clone.

## Quick start

```bash
npm install
npm start            # launch the Electron app (user-side; not in agent env)
npm test             # node --test — 36 tests, must stay green
```
