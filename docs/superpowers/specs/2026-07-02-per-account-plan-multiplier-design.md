# Per-account plan capacity multiplier — Design

**Date:** 2026-07-02
**Status:** Approved (design)
**Component:** AI Usage Monitor — `settings.html`, `settings-renderer.js`, `analytics-renderer.js`

## Problem

The **Plan capacity multiplier** setting only exposes an input for **Codex**, so
the Claude Desktop and Claude Code plan tiers can't be set. The analytics **Plan
Fit** card therefore shows Claude Desktop at a fixed `1x` even when the user is
on a higher tier. The user is no longer on a 1x Claude Desktop plan and needs to
set it (and, for symmetry, Claude Code).

## Background — two distinct "multipliers" (do not conflate)

1. **Token-consumption multiplier** — `PLAN_MULTIPLIERS` in `analytics-renderer.js`
   (`codex 1`, `claude-desktop 1`, `claude-vscode 20`). Model burn rate relative
   to a Sonnet base; drives only the "· N%/hr equiv." sub-text on the burn cards.
   **Unchanged by this feature.**
2. **Plan-capacity multiplier** — user-configurable `settings.planMultipliers[account]`,
   read by `planMultiplierFor(settings, account)`, fed to `weeklyRunway(...)`, and
   shown in the **Plan Fit** card (`current -> ~required`). **This is what the
   feature makes editable per account.**

## Existing flow (already correct — verified)

`renderAll` fetches settings (`_cur`) and passes them to
`renderStats(entries, statsEl, _cur)`. `renderStats` computes
`configuredPlanMultiplier = planMultiplierFor(_cur, currentAccount)` and feeds it
to `weeklyRunway`, whose `currentPlanMultiplier` (echo) and `requiredPlanMultiplier`
(pace-scaled) render the Plan Fit card — for both the projection and
no-projection paths. So once an input exists for an account, its value is already
reflected in the output. Only multiplier-dependent output is the Plan Fit card;
the absolute runway/reset/headroom projections do not (correctly) depend on it.

## Changes

### A. Settings UI — `settings.html`

In the "Plan capacity multiplier" section, add two rows so all three accounts
match the Subscriptions / Account-label sections:

- Codex — `mult-codex` (default `5`, unchanged)
- Claude Desktop — `mult-claude-desktop` (default `1`)
- Claude Code — `mult-claude-vscode` (default `1`)

Update the note to say it drives the Analytics **Plan Fit** card, per account.

### B. Settings wiring — `settings-renderer.js`

Generalize load/save over the existing `ACCOUNTS = ['codex','claude-desktop','claude-vscode']`,
exactly like `planPrices`:

- `MULT_DEFAULTS = { codex: 5, 'claude-desktop': 1, 'claude-vscode': 1 }`.
- Load: `document.getElementById('mult-'+a).value = pm[a] != null ? pm[a] : MULT_DEFAULTS[a]`.
- Save: loop accounts, store `planMultipliers[a]` when the parsed value is `> 0`.
- Attach the `change` listener to all three `mult-<account>` inputs.

### C. Analytics fallback — `analytics-renderer.js`

`planMultiplierFor` currently falls back to `PLAN_MULTIPLIERS[account] ?? 1` for
non-Codex, coupling plan capacity to token consumption (Claude Code → 20). Change
the non-Codex fallback to a plain `1`:

```js
function planMultiplierFor(settings, account) {
  const configured = Number(settings && settings.planMultipliers && settings.planMultipliers[account]);
  if (configured > 0 && isFinite(configured)) return configured;
  if (account === 'codex') return 5;
  return 1;
}
```

Decouples the two concepts; an unset account assumes base (1x) except Codex (5x,
preserved). `PLAN_MULTIPLIERS` is untouched.

## Testing

- **`planMultiplierFor` unit** (via the existing vm-loaded stats-renderer context):
  configured value wins; fallback is `5` for Codex, `1` for Claude Desktop and
  Claude Code (captures the 20→1 change).
- **Output reflection**: extend `loadStatsRenderer` to accept an account
  (default `'codex'`, so existing tests are unaffected); assert `renderStats`'s
  HTML shows `5x` in Plan Fit for Claude Desktop with `{planMultipliers:{'claude-desktop':5}}`,
  and `1x` for an unset Claude Code (proving the fallback change reaches the output).
- `node --check analytics-renderer.js settings-renderer.js`.
- Existing `node --test` suite stays green (no `metrics.js` change).
- Manual GUI (user): set Claude Desktop's multiplier in Settings, confirm the
  analytics Plan Fit card for the Claude Desktop tab updates live.

## Out of scope

- Changing `PLAN_MULTIPLIERS` or the burn-rate "%/hr equiv." sub-text.
- Any change to `weeklyRunway` / metrics.js.
- Reflecting the plan-capacity multiplier in cards other than Plan Fit (the
  absolute projections intentionally don't depend on plan tier).
