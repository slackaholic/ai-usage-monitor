# AI Usage Monitor

A lightweight Electron desktop app that keeps an eye on your **rate-limit usage across multiple coding-AI subscriptions in one place** — so you can see at a glance how much of each window you have left, how fast you're burning it, and when it resets.

Tracks three accounts side by side:

| Account | What it reads | How |
| --- | --- | --- |
| **Codex** (OpenAI) | 5-hour + weekly limits | Scrapes the usage page through a hidden, already-authenticated browser session |
| **Claude Desktop** (claude.ai) | 5-hour + weekly limits | Reads the claude.ai usage data using your logged-in web session cookies |
| **Claude Code** (VS Code / CLI) | 5-hour + weekly limits + local token counts | Reads the Claude Code API usage endpoint via `~/.claude/.credentials.json`, and aggregates per-model token usage from your local `~/.claude/projects/**/*.jsonl` logs |

Everything runs locally. No usage data ever leaves your machine — the app only talks to the same Anthropic/OpenAI endpoints your tools already use, with your existing credentials.

---

## Features

- **Compact and full views** — a small always-visible strip, or an expanded card layout. The window auto-resizes to fit its content, and sections you hide stay hidden across both views.
- **At-a-glance per account:** 5-hour and weekly remaining %, current burn rate, projected depletion time, and the next reset time.
- **Always-on-top toggle, adjustable opacity, and a system-tray icon** for a true "ambient dashboard" that sits in the corner of your screen.
- **Usage history logging** — every poll is appended to `usage-log.jsonl`, building a time series you own.
- **Analytics window** with a trend chart, stat cards, a raw log table, and an **Efficiency** section that turns the raw snapshots into insight (see below).

### Efficiency analytics

The Analytics window derives **descriptive** efficiency metrics from your logged history, per account and for both the 5-hour and weekly windows:

- **Live panel** — the current cycle's peak usage, headroom, and whether you're blocked.
- **Per-cycle scorecard** — the last completed cycle: peak, headroom left at reset, and whether (and how long) you ran out.
- **Historical report** — a block summary ("3 of 20 cycles ran out, ≈2h blocked total"), a peak-trend bar per completed cycle, and an hour-of-day burn heatmap.

The design deliberately **describes rather than grades**: because real demand varies, a low-usage cycle just means you didn't need the quota — not that you wasted it. The one signal treated as a genuine cost is **blocking** (running out before a reset). See the [design spec](docs/superpowers/specs/2026-06-25-usage-efficiency-analytics-design.md) for the full rationale.

---

## Getting started

**Requirements:** [Node.js](https://nodejs.org/) 18+ and npm. Windows is the primary, tested platform (the tray launchers and the Claude Desktop session import rely on Windows-specific paths and DPAPI).

```bash
git clone https://github.com/slackaholic/ai-usage-monitor.git
cd ai-usage-monitor
npm install
npm start
```

On Windows you can also double-click **`launch.bat`** (opens a console) or **`launch.vbs`** (runs silently in the background). The `launch.vbs` path is hard-coded — edit it to match where you cloned the repo.

### Connecting your accounts

The app reads usage through your existing logins, so each account needs to be authenticated once:

- **Claude Code** works out of the box if you've signed in with the Claude Code CLI / VS Code extension (it reads `~/.claude`).
- **Codex** and **Claude Desktop** open a sign-in window the first time so the app can use your web session. For an email-code or Microsoft-only Claude account that won't sign in inside the embedded window, use **Import from Claude Desktop** to borrow the session from the native app (fully quit Claude Desktop first so its cookie database isn't locked).

Settings (position, opacity, hidden sections) persist in `settings.json`, and history accumulates in `usage-log.jsonl` — both are git-ignored and stay on your machine.

---

## Development

```bash
npm test        # run the metrics unit tests (Node's built-in test runner)
```

The efficiency metrics live in `metrics.js` as pure, dependency-free functions (`segmentCycles`, `cycleStats`, `summarize`, `hourlyBurn`) with full unit coverage in `test/metrics.test.js`. The app itself is plain Electron:

| File | Role |
| --- | --- |
| `main.js` | Electron main process — windows, tray, IPC, all data fetching/scraping |
| `preload.js` | Safe `contextBridge` API exposed to the renderers |
| `index.html` / `renderer.js` | The main monitor window |
| `analytics.html` / `analytics-renderer.js` | The analytics window |
| `metrics.js` | Pure efficiency-metrics engine (shared by the analytics window and tests) |

---

## Privacy

This is a personal monitoring tool. It stores your usage history and app settings locally and never transmits them anywhere. Account access uses your own browser sessions / credentials on your own machine.

## License

No license is currently specified. If you intend to reuse this code, please open an issue to ask.
