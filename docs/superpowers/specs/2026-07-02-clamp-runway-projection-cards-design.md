# Clamp the At-Reset & Plan-Fit projection cards — Design

**Date:** 2026-07-02
**Status:** Approved (design)
**Component:** AI Usage Monitor — `analytics-renderer.js` (`renderStats` runway cards). No `metrics.js` change.

## Problem

Two stat cards produce physically impossible / absurd values:

- **At Reset:** `-461%` — projected weekly headroom at the reset moment.
- **Plan Fit:** `5x -> ~126.4x` — the plan capacity this pace would require.

Both come from `weeklyRunway` (metrics.js), which measures the **active** weekly
burn rate over a short sample (here 6.6h of real working sessions) and
extrapolates it **linearly across every remaining hour until reset** (~113h),
as if quota is burned 24/7. Concretely:

- `projectedConsumptionByReset = weeklyBurnRatePctPerHour * hoursUntilReset`
  ≈ 4.2%/hr × 113h ≈ 480%.
- `projectedHeadroomAtResetPct = last.wk - projectedConsumptionByReset`
  = 19 − 480 = **−461%**.
- `requiredPlanMultiplier = multiplier * projectedConsumptionByReset / last.wk`
  = 5 × 480/19 ≈ **126.4x**.

Two distinct nonsense modes:
1. Weekly quota **cannot go below 0%** — once it hits zero it stops. A negative
   "headroom" is impossible; the honest statement is "runs out before reset"
   (the Weekly Runway / Reset Gap cards already say *when* and *by how much*).
2. A short burst is **not a 7-day pattern** — extrapolating burst-rate over idle
   nights/weekends inflates the required plan to an unreal 126x.

## Decision (from the user)

**Clamp + reframe at the render layer.** Keep `metrics.js` truthful (it still
returns the raw −461% / 126.4x); the renderer decides presentation. No modeling
of duty-cycle, no confidence gating.

## Changes — `analytics-renderer.js`, `renderStats`

Only the two card objects in the `runwayCards` "has projection" branch change
(currently [analytics-renderer.js:338-349](../../../analytics-renderer.js)). The
`runwayPace` variable ("early pace" / "current pace") and `runwayCls` stay as-is.

### At Reset

```js
const headroomRaw = runway.projectedHeadroomAtResetPct;
const runsOut = headroomRaw < 0;
{
  label: 'At Reset',
  value: runsOut ? '0%' : Math.round(headroomRaw) + '%',
  sub: runsOut ? 'runs out before reset' : `if ${runwayPace} holds`,
  cls: runwayCls,
}
```

- `headroomRaw >= 0` → unchanged behaviour (`N%`, "if <pace> holds").
- `headroomRaw < 0` → floored to `0%`, sub "runs out before reset". The
  magnitude of the overshoot stays visible on the Reset Gap card ("108h short").

### Plan Fit

Three honest bands, gated by a ceiling of **current × 3** (a `PLAN_FIT_CEILING_FACTOR`
constant = 3). For a 5x plan the ceiling is 15x.

```js
const cur = runway.currentPlanMultiplier;
const req = runway.requiredPlanMultiplier;
const ceiling = cur * PLAN_FIT_CEILING_FACTOR;
let planFitValue, planFitSub;
if (req <= cur) {
  planFitValue = `${fmtMultiplier(cur)}`;
  planFitSub = 'current pace fits your plan';
} else if (req <= ceiling) {
  planFitValue = `${fmtMultiplier(cur)} -> ~${fmtMultiplier(req)}`;
  planFitSub = `if ${runwayPace} holds`;
} else {
  planFitValue = `${fmtMultiplier(cur)} · won't fit`;
  planFitSub = 'pace far exceeds any plan';
}
{ label: 'Plan Fit', value: planFitValue, sub: planFitSub, cls: runwayCls }
```

- `req <= cur` → pace fits; show just the current plan, no misleading arrow.
- `cur < req <= ceiling` → show the real target (`5x -> ~7x`) — actionable
  "bump your plan" advice.
- `req > ceiling` → `5x · won't fit`, sub "pace far exceeds any plan". Kills the
  126.4x.

`PLAN_FIT_CEILING_FACTOR = 3` is declared as a module-level const near the other
render constants so it is named, not a magic number.

## Testing — `test/analytics-renderer.test.js`

`loadStatsRenderer` already runs `renderStats` against a `FakeElement` stub with
metrics globals. Add cases driving the runway projection into each band via
crafted `entries`:

- **At Reset floors:** an entry set whose projection is negative → card shows
  `0%` and sub "runs out before reset"; never a negative `%`.
- **At Reset positive passthrough:** a gentle-pace set with positive headroom →
  `N%`, sub still references the pace (unchanged behaviour).
- **Plan Fit fits:** `req <= cur` → value has no `->` arrow and sub
  "current pace fits your plan".
- **Plan Fit upgrade band:** `cur < req <= 3·cur` → value contains
  `-> ~` and a finite multiplier ≤ ceiling.
- **Plan Fit won't-fit:** `req > 3·cur` (the screenshot's runaway case) → value
  contains "won't fit", sub "pace far exceeds any plan", and does **not** contain
  the raw inflated multiplier.

`node --check analytics-renderer.js`; full `node --test` green.

## Out of scope

- `metrics.js` / `weeklyRunway` math — unchanged; it stays the truthful source.
- Weekly Runway ("Thu 19:29") and Reset Gap ("108h short") cards — already framed
  as time/gap, not nonsensical; left alone.
- Duty-cycle-aware projection and confidence-gating (considered, not chosen).
