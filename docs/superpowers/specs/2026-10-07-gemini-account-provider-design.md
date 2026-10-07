# Gemini as a monitored account — Design

**Date:** 2026-10-07
**Status:** Approved (design)
**Component:** AI Usage Monitor — new provider.
**Depends on:** [One normalised reading per account](2026-10-07-pluggable-account-providers-design.md)
— this is that refactor's first consumer, and the test of its claim that a new
provider costs three files instead of eight.

## Why Gemini fits

Since Google I/O 2026 the consumer Google AI plans use a **compute-based 5-hour
window that feeds a weekly cap** — the same two-meter structure the app already
renders for every other account. `gemini.google.com` → Settings → Usage limits
shows the 5-hour consumption as a percentage bar and progress toward the weekly
limit.

That makes Gemini a **browser-session scrape**, structurally identical to Claude
Desktop (`claude.ai/settings/usage`), not a new kind of integration.

An earlier assessment in this repo called Gemini the weakest candidate. That was
based only on the Gemini **Code Assist** path the `gemini` CLI uses, whose quota
is reachable solely through the interactive `/stats model` command. The consumer
web surface is a different and much better source. The CLI path is not used
here.

## Account assumption, and the discovery step that tests it

The user reports a **paid Google AI plan (Pro / Ultra / Plus)**. This design is
built for that.

It is not yet verified, and one specific risk stands out: the account email is
on a Google **Workspace** domain, and Workspace Gemini Business licences are
metered at **1,000 uses per month, resetting on the 1st** — a monthly counter,
not a 5h/weekly pair. If the usage page renders that instead, the two-meter card
model does not fit and this design needs revisiting before any parser is
written.

**Implementation therefore opens with a discovery task the user performs**, not
with code. Only they can load that page authenticated. Nothing downstream is
built until the discovery output confirms which meters exist. This is a hard
gate: writing a parser against assumed page text is how the Codex integration
spent six weeks silently mislabelling its own data.

## Transport

A hidden `BrowserWindow` on its own session partition (`persist:gemini`),
following the existing Codex and Claude Desktop handlers:

- Load the usage page; if the resulting URL matches a Google auth pattern, show
  the window and wait for navigation back, with the same 5-minute login timeout
  and `window-closed` handling the Codex path uses.
- Once authenticated, run a scrape script that polls for the usage text to
  appear, then returns `{ text, email }`.
- **Prefer a backend endpoint if discovery finds one.** Both existing scrapers
  learned the same lesson: Codex reads `/backend-api/codex/usage` and falls back
  to text; Claude Desktop reads the org-usage endpoint and falls back to text. A
  structured response is more stable than rendered text and carries exact reset
  timestamps. Discovery should capture the network requests the usage page makes
  and report any that return the numbers as JSON.

## Parsing

`parseGeminiUsage(data, now)` returns the **normalised reading** defined by the
dependency spec — `pct5h`, `pctWk`, `reset5hMs`, `resetWkMs`, `has5h`, `hasWk`,
`label`, `extra` — and nothing provider-shaped.

Two rules carried over from hard-won experience in this repo:

1. **Never identify a window by its position** in a response or on a page.
   Match on its declared length or its own label. This is the defect that cost
   six weeks on Codex (see the 2026-08-26 spec).
2. **Convert to REMAINING at the parse boundary.** If the page reports consumed
   percentage, `100 - x` happens here, so nothing downstream ever sees a "used"
   figure.

The page text is unknown until discovery, so the exact patterns are deliberately
not specified here; discovery output supplies them, and the plan treats the
parser as test-first against captured real text rather than invented fixtures.

## Registration

| | |
| --- | --- |
| descriptor `id` | `gemini` |
| `logKey` | `gemini` |
| card label | `Gemini` |
| session partition | `persist:gemini` |
| token/cost data | **none** — the web surface exposes no token counts, same as Claude Desktop |

`gemini` is a new log key with no history behind it, so unlike the three
existing keys it carries no migration risk.

Settings gains a Gemini row through the existing `ACCOUNT_PAIRS` mechanism:
plan price, tier-change date, plan multiplier and label override, exactly as the
other accounts have. **The default plan price is 0** — the user sets their own
rather than inheriting a guess at Google's pricing, which varies by tier and
region. A price of 0 simply means no cost estimate, which is honest for an
account whose price we do not know.

## Analytics

`VALID_ACCOUNTS`, `ACCOUNT_LABELS` and `PLAN_MULTIPLIERS` gain `gemini`
entries. The weekly-budget ratio, runway and burn metrics work unmodified: they
read `5h` and `wk` from the usage log and are already provider-agnostic.

No cost-over-time or token-mix data will appear for Gemini, matching Claude
Desktop's existing behaviour. This is correct, not a gap.

## Out of scope

- **Gemini CLI telemetry.** `.gemini/settings.json` can emit per-call token
  usage to a local file, which would feed the cost/token side the way
  `~/.codex/sessions/**/*.jsonl` does. It is a genuinely useful second source
  and a separate feature; it is not a quota meter and does not belong in this
  card.
- Gemini Code Assist / Vertex / API-key metering — different products, different
  meters.
- Any change to the three existing providers beyond what the dependency spec
  already covers.

## Verification

- `parseGeminiUsage` tested against **real captured page text** from the
  discovery step, not invented fixtures — including the depleted case (0%
  remaining) and the case where only one of the two meters is present.
- The dependency spec's "all providers render identically from an identical
  reading" test is extended to four providers.
- A regression test that Gemini's usage-log entries carry `account: "gemini"`
  and the standard `5h` / `wk` keys, so the existing metrics read them with no
  special-casing.
- `npm test` green; `node --check` on changed files.
- **GUI verification is the user's step.** Specifically: the login flow on first
  run, the card appearing with both meters, and the numbers matching what
  `gemini.google.com` itself shows at the same moment.
