# Weekly Runway and Plan Fit - Design

**Date:** 2026-06-29
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor - Analytics window and Settings window

## Goal

Answer the user's real operating question for Codex: **can the current weekly
plan capacity carry this pace through the weekly reset?** The UI should make the
answer inferable from concrete numbers, without saying "upgrade needed" or
making an explicit recommendation.

Codex is currently used as a **5x** plan, but that multiplier must be editable
because plan tier can change and may later matter for other accounts.

## Product Principle

Use neutral runway language:

- show when weekly usage is projected to run out;
- show whether that is before or after the weekly reset;
- show the current configured plan multiplier;
- show the estimated multiplier required at the current pace.

Do **not** render judgmental copy such as "upgrade needed," "upgrade now," or
"insufficient plan." The user can infer plan fit from `current 5x` versus
`pace ~7.1x`, and from shortfall/buffer time.

## Data Inputs

Existing usage snapshots already provide:

- `wk`: weekly remaining percent.
- `reset7dTs`: weekly reset timestamp.
- `5h`: five-hour remaining percent.
- `reset5hTs`: five-hour reset timestamp.
- `ts`: snapshot timestamp.

Existing analytics already derives:

- weekly session burn rate from active drops;
- weekly depletion timestamp (`depleteWkAt`);
- weekly reset timestamp (`apiReset7d`);
- `wkPerWindow` and `windowsRemaining`.

New setting:

```json
{
  "planMultipliers": {
    "codex": 5
  }
}
```

Defaults:

- `codex`: `5`
- `claude-desktop`: `1`
- `claude-vscode`: existing `PLAN_MULTIPLIERS['claude-vscode']` value as a
  display fallback only; this feature is primarily for Codex.

## Metrics

Add a pure metric helper in `metrics.js`:

```js
weeklyRunway(snapshots, currentPlanMultiplier) -> {
  currentPlanMultiplier,
  weeklyRemainingPct,
  weeklyResetTs,
  weeklyBurnRatePctPerHour,
  projectedDepleteTs,
  gapMs,
  projectedHeadroomAtResetPct,
  requiredPlanMultiplier,
  confidence
}
```

Definitions:

- `weeklyBurnRatePctPerHour`: active weekly burn rate, using the same idle-gap
  exclusion as current burn stats (`drop > 0` and poll gap `< ACTIVE_GAP_MAX`).
  Fall back to overall weekly drop over the selected/full log span only when no
  active drops exist.
- `projectedDepleteTs`: last snapshot time + `wkRemaining / burnRate`.
- `gapMs`: `weeklyResetTs - projectedDepleteTs`.
  - positive means depletion is projected before reset (shortfall);
  - negative means projected depletion is after reset (buffer).
- `projectedHeadroomAtResetPct`: `wkRemaining - burnRate * hoursUntilReset`,
  clamped only for display if needed; negative values are meaningful and should
  be shown as shortfall.
- `requiredPlanMultiplier`: if current pace would exceed capacity before reset,
  compute the multiplier required to make projected usage fit:

  ```text
  currentPlanMultiplier * projectedWeeklyConsumptionByReset / weeklyRemainingPct
  ```

  where `projectedWeeklyConsumptionByReset = burnRate * hoursUntilReset`.

  If current pace lasts to reset, this can be below the current multiplier and
  should still be displayed as pace requirement, e.g. `pace ~3.8x`.

Confidence:

- `good`: at least 2 active weekly drops and at least 30 active minutes.
- `limited`: some weekly movement but less evidence.
- `none`: no weekly burn rate can be derived; render an empty/insufficient-data
  state.

No `Date.now()` in `metrics.js`; the helper derives from supplied timestamps.

## Analytics UI

Add a new row of top stat cards after the existing "what you have / how fast /
what next" cards, or fold into the same `stat-grid` if that keeps layout
cleaner.

Cards:

1. **Weekly Runway**
   - value: `Tue 15:40` or `Lasts to reset`
   - sub: `projected weekly depletion` or `at current pace`

2. **Reset Gap**
   - value: `3h short` or `1d 4h buffer`
   - sub: `vs weekly reset`

3. **Plan Fit**
   - value: `5x -> ~7.1x`
   - sub: `current plan - pace required`

Optional fourth card if layout benefits:

4. **At Reset**
   - value: `-18%` or `24%`
   - sub: `projected weekly headroom`

Color should remain informational:

- red only when projected depletion is before reset;
- amber when buffer is small (less than 12 hours);
- green when projected depletion is comfortably after reset;
- dim/neutral for insufficient data.

Do not use the phrase "upgrade needed."

## Settings UI

In Settings, add a small section near "Subscriptions (plan price, USD/mo)":

**Plan capacity multiplier**

Rows:

- Codex: numeric input, default `5`, step `0.1`, min `0.1`
- Claude Desktop and Claude Code may be omitted for now unless the existing
  layout makes a three-row reusable control simpler.

Persistence:

- Save the full `planMultipliers` object through existing `saveSettings`.
- Settings changes already broadcast to analytics; the new cards re-render via
  the existing `onSettingsChanged(() => renderAll())` path.

## Placement and Copy

This feature belongs near the top analytics cards because it answers an
operational question: "will the weekly allowance last?" It should not be hidden
under Cost/Subscription Value.

Use terse labels:

- `Weekly Runway`
- `Reset Gap`
- `Plan Fit`
- `At Reset`

Example rendered state:

```text
Weekly Runway: Tue 15:40
projected weekly depletion

Reset Gap: 3h short
vs weekly reset

Plan Fit: 5x -> ~7.1x
current plan - pace required

At Reset: -18%
projected weekly headroom
```

## Testing

Unit tests in `test/metrics.test.js`:

- projects weekly depletion time from active weekly drops;
- computes buffer/shortfall versus reset;
- computes required plan multiplier above current plan when projected usage
  exceeds remaining weekly capacity;
- computes required multiplier below current plan when pace is safe;
- returns a confidence/empty state when no weekly burn rate is derivable;
- keeps `metrics.js` deterministic with no `Date.now()`.

Renderer/settings tests can stay source-level or thin DOM-style tests following
the existing `test/analytics-renderer.test.js` pattern if practical.

Verification:

- `npm test`
- `node --check metrics.js analytics-renderer.js settings-renderer.js`
- GUI verification remains user-side in Electron.

## Out of Scope

- Explicit upgrade recommendation copy.
- Automatic plan-tier lookup from provider APIs.
- Alerts or notifications.
- Persisting historical runway predictions.
- Changing the main monitor window.

