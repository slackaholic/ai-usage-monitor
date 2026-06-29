# Next-session handoff prompt

> This file is the **canonical handoff**. Whenever the user asks for a handoff /
> handover / "prompt for the next conversation", **regenerate the block below**
> to reflect the current state (recent work, what's in flight, what's pending),
> update the "Last updated" line, and give the user the block to paste into a
> fresh conversation. Keep it tight and point at the in-repo CLAUDE.md / specs /
> README as the source of truth rather than restating everything.

**Last updated:** 2026-06-29

---

You're picking up the **AI Usage Monitor** — a local Electron desktop app that
shows rate-limit usage for three coding-AI subscriptions (Codex, Claude Desktop,
Claude Code) side by side, plus an analytics window with cost and efficiency
breakdowns. Everything runs locally against the user's own credentials.

PROJECT
- Dir: c:\Users\Rommel Payba\.claude\sessions\ai-usage-monitor  (Windows; Bash/Git Bash
  + PowerShell tools). origin = github.com/slackaholic/ai-usage-monitor.
- **Read CLAUDE.md first**, then README.md (feature tour) and the relevant spec in
  docs/superpowers/specs/. CLAUDE.md has the architecture, the hard constraints, and
  the conventions — don't relearn them by guessing.
- Key domain fact: the three accounts read from DIFFERENT, non-interchangeable sources
  (see CLAUDE.md + memory/reference_usage_data_sources.md). The Claude Code gauge
  "barely moving" under heavy use is correct (cache reads dominate volume, ~10% weight).

BRANCH / GIT
- Work on a feature branch off `main`. The user typically picks "merge locally" then
  push. Standing authorization to commit and push without confirmation.
- Commit trailer: Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>.

HOW I WORK (please follow)
- Features: superpowers:brainstorming → spec in docs/superpowers/specs/ →
  superpowers:writing-plans → implement via subagent-driven-development (or
  executing-plans), TDD, commit per logical change. I approve specs + plans before you build.
- Bugs: superpowers:systematic-debugging — root cause before any fix.
- Before EVERY commit: `npm test` (36 tests, must stay green) + `node --check` on changed JS.
- The Electron GUI CANNOT be launched in the agent environment. GUI verification is MY
  step — tell me what to check; never claim visual confirmation you couldn't make.

HARD CONSTRAINTS (full list in CLAUDE.md — the ones most easily broken)
- metrics.js is dual-loaded (browser global + CommonJS): no Date.now()/argless new Date(),
  no new deps, keep it pure. Async/Date/fs live in usage-reader.js instead.
- Don't reintroduce a per-poll write outside SILENT_SETTINGS_KEYS {lastKnown,x,y} (would
  resurrect spurious analytics refreshes), and don't clear #body before renderAll's async
  build (that blank frame is the flash). Token entry shapes + cost math are fixed.

CURRENT STATE — analytics refresh + flash fixes just shipped to main
- DONE & merged: (1) broadcast gate so routine polling no longer spam-refreshes analytics;
  (2) usage-reader.js — async, mtime-cached token-log reads (fixed a ~6s main-thread freeze;
  smoke: Codex 6262ms→170ms warm); (3) renderAll preserves scroll, only shows "Loading…" on
  first render, and now swaps rebuilt sections in atomically via replaceChildren (fixed a
  visible flash). Latest main ≈ commit c911cf4.
- PENDING — user (me) GUI verification of the flash fix: reload analytics, confirm Refresh +
  tab switches no longer flash. If it STILL flashes, the next suspect is a refresh firing when
  it shouldn't (something slipping past the Part A broadcast gate) — trace that, don't re-patch
  renderAll blindly.
- No feature in flight beyond that. Specs/plans for shipped features are in
  docs/superpowers/{specs,plans}/ (efficiency analytics, token-cost analytics, daily/monthly
  cost, token-mix, month heatmap + navigation, settings/currency, analytics-refresh-fix).

RELEVANT BACKGROUND
- memory/ (machine-local, not in git): reference_usage_data_sources.md (data sources +
  cache-read insight), plus login/import gotchas (in-app email-code login is blocked by
  bot-detection — use Import-from-Desktop; clear cookies individually, not clearStorageData).
- .superpowers/sdd/ is local scratch (SDD ledger/briefs) — does NOT travel via clone.

START BY: reading CLAUDE.md, README.md, and (if continuing the analytics work)
docs/superpowers/specs/2026-06-26-analytics-refresh-fix-design.md, then tell me whether the
flash is resolved on your end or which feature you want to work on next.
