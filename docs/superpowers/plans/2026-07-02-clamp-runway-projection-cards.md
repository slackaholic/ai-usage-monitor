# Clamp At-Reset & Plan-Fit Projection Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the At-Reset and Plan-Fit stat cards from showing physically impossible values (−461% headroom, 126.4x plan) by clamping and reframing them at the render layer.

**Architecture:** `metrics.js`/`weeklyRunway` stays untouched and truthful — it still returns the raw negative headroom and inflated required multiplier. Only the two card objects in `renderStats` (`analytics-renderer.js`) change: At-Reset floors negative headroom to `0%`, and Plan-Fit collapses to three honest bands gated by a 3× ceiling.

**Tech Stack:** Vanilla JS, Node's built-in `node --test`. The stats renderer is exercised in tests via `vm.runInContext` against a `FakeElement` DOM stub with `metrics` globals (`loadStatsRenderer`).

## Global Constraints

- No new dependencies; pure vanilla JS.
- Do NOT modify `metrics.js` — it remains the truthful source; clamping is presentation-only.
- No `Date.now()` / argless `new Date()` in `metrics.js` (not touched here anyway).
- Card copy is exact: At-Reset over-run sub is `runs out before reset`; Plan-Fit subs are `current pace fits your plan` (fits), `if <pace> holds` (upgrade band), `pace far exceeds any plan` (won't fit); Plan-Fit won't-fit value is `<cur>x · won't fit` (middle dot `·`, ASCII apostrophe).
- Plan-Fit ceiling is `runway.currentPlanMultiplier * 3` (for a 5x plan → 15x).
- `<pace>` is the existing `runwayPace` variable (`early pace` for <12h evidence, else `current pace`).

---

### Task 1: Clamp the At-Reset and Plan-Fit cards

**Files:**
- Modify: `analytics-renderer.js` — `renderStats`, the runway-cards block (currently around lines 325–350).
- Test: `test/analytics-renderer.test.js` (add three tests near the existing `renderStats` tests at ~line 187).

**Interfaces:**
- Consumes (from `metrics.js`, unchanged): `weeklyRunway(entries, multiplier)` returns an object with
  `currentPlanMultiplier` (number), `requiredPlanMultiplier` (number|null),
  `projectedHeadroomAtResetPct` (number|null), plus the fields already used
  (`confidence`, `gapMs`, `evidenceMs`, …).
- Consumes (already in file): `fmtMultiplier(v)` → e.g. `5` → `"5x"`, `7.05` → `"7x"`; `runwayPace` (string), `runwayCls` (string), `runwayHasProjection` (bool).
- Produces: no new exported symbols — internal presentation change only.

**Context — where this fits:** `renderStats` builds a `runwayCards` array via a ternary. The `runwayHasProjection === false` branch (no projection yet) is unchanged. Only the `else` branch — the four live projection cards (Weekly Runway, Reset Gap, Plan Fit, At Reset) — is edited: Plan Fit and At Reset get clamped values computed just above the array.

- [ ] **Step 1: Write the failing tests**

Add these three tests to `test/analytics-renderer.test.js` immediately after the existing test `renderStats shows neutral weekly runway and plan-fit cards` (the block ending near line 211). They use the existing `loadStatsRenderer` / `FakeElement` helpers already imported at the top of the file.

```js
test('renderStats At Reset floors negative headroom and Plan Fit shows "won\'t fit" for a runaway pace', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null }); // codex, multiplier 5 below
  const container = new FakeElement();
  // Weekly quota at 19%, burning ~4.2%/hr, reset ~113h out → linear projection
  // implies ~475% consumed: headroom −456% and required ~125x. Both must be clamped.
  const reset = Date.parse('2026-07-04T01:30:00Z');
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 30, wk: 21.1, reset7dTs: reset },
    { ts: '2026-06-29T08:10:00Z', '5h': 25, wk: 20.4, reset7dTs: reset },
    { ts: '2026-06-29T08:20:00Z', '5h': 20, wk: 19.7, reset7dTs: reset },
    { ts: '2026-06-29T08:30:00Z', '5h': 15, wk: 19.0, reset7dTs: reset },
  ];

  renderStats(entries, container, { planMultipliers: { codex: 5 } });

  // At Reset: floored, never a giant negative percent.
  assert.match(container.innerHTML, /runs out before reset/);
  assert.match(container.innerHTML, /<div class="value">0%<\/div>/);
  assert.doesNotMatch(container.innerHTML, /-\d{2,}%/); // no −456% etc.
  // Plan Fit: reframed, no runaway multiplier.
  assert.match(container.innerHTML, /won't fit/);
  assert.match(container.innerHTML, /pace far exceeds any plan/);
  assert.doesNotMatch(container.innerHTML, /12\dx/); // no ~124x/125x/126x
});

test('renderStats At Reset stays positive and Plan Fit says it fits for a gentle pace', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  // 70% left, burning ~0.6%/hr, reset 10h out → ~6% consumed: headroom +64%, required ~0.4x.
  const reset = Date.parse('2026-06-29T18:30:00Z');
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 90, wk: 70.3, reset7dTs: reset },
    { ts: '2026-06-29T08:10:00Z', '5h': 89, wk: 70.2, reset7dTs: reset },
    { ts: '2026-06-29T08:20:00Z', '5h': 88, wk: 70.1, reset7dTs: reset },
    { ts: '2026-06-29T08:30:00Z', '5h': 87, wk: 70.0, reset7dTs: reset },
  ];

  renderStats(entries, container, { planMultipliers: { codex: 5 } });

  assert.match(container.innerHTML, /current pace fits your plan/);
  assert.doesNotMatch(container.innerHTML, /won't fit/);
  assert.doesNotMatch(container.innerHTML, /runs out before reset/);
  // At Reset shows a real positive percent, not 0% and not negative.
  assert.doesNotMatch(container.innerHTML, /-\d+%/);
});

test('renderStats Plan Fit shows an upgrade target when required is above plan but under the ceiling', () => {
  const { renderStats } = loadStatsRenderer({ querySelector: () => null });
  const container = new FakeElement();
  // 70% left, ~4.2%/hr, reset next day (~23.5h) → ~99% consumed: required ~7x (≤ 15x ceiling).
  const reset = Date.parse('2026-06-30T08:00:00Z');
  const entries = [
    { ts: '2026-06-29T08:00:00Z', '5h': 90, wk: 72.1, reset7dTs: reset },
    { ts: '2026-06-29T08:10:00Z', '5h': 80, wk: 71.4, reset7dTs: reset },
    { ts: '2026-06-29T08:20:00Z', '5h': 70, wk: 70.7, reset7dTs: reset },
    { ts: '2026-06-29T08:30:00Z', '5h': 60, wk: 70.0, reset7dTs: reset },
  ];

  renderStats(entries, container, { planMultipliers: { codex: 5 } });

  assert.match(container.innerHTML, /5x -&gt; ~7x|5x -> ~7x/);
  assert.match(container.innerHTML, /if early pace holds/);
  assert.doesNotMatch(container.innerHTML, /won't fit/);
  assert.doesNotMatch(container.innerHTML, /fits your plan/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the three new tests FAIL — the first on `/runs out before reset/` (current code prints `-456%`), the second on `/current pace fits your plan/` (current code always prints the `->` arrow), the third may already pass but must be present. Existing tests still pass.

- [ ] **Step 3: Implement the clamp**

In `analytics-renderer.js`, inside `renderStats`, locate the runway-cards block. Immediately **before** `const runwayCards = !runwayHasProjection ? [ … ] : [ … ];`, insert the clamp computation:

```js
  // Clamp the projection cards for display (metrics.js stays truthful):
  // weekly quota can't fall below 0%, and a short burst shouldn't imply a huge plan.
  const cur = runway.currentPlanMultiplier;
  const req = runway.requiredPlanMultiplier;
  const planFitCeiling = cur * 3; // above 3× the current plan, no real plan fits
  const headroomRaw = runway.projectedHeadroomAtResetPct;
  const runsOutBeforeReset = headroomRaw != null && headroomRaw < 0;
  let planFitValue, planFitSub;
  if (req == null || req <= cur) {
    planFitValue = fmtMultiplier(cur);
    planFitSub = 'current pace fits your plan';
  } else if (req <= planFitCeiling) {
    planFitValue = `${fmtMultiplier(cur)} -> ~${fmtMultiplier(req)}`;
    planFitSub = `if ${runwayPace} holds`;
  } else {
    planFitValue = `${fmtMultiplier(cur)} · won't fit`;
    planFitSub = 'pace far exceeds any plan';
  }
```

Then, in the projection (`else`) branch of `runwayCards`, replace the existing Plan Fit and At Reset card objects with:

```js
    {
      label: 'Plan Fit',
      value: planFitValue,
      sub: planFitSub,
      cls: runwayCls,
    },
    {
      label: 'At Reset',
      value: runsOutBeforeReset ? '0%' : Math.round(headroomRaw) + '%',
      sub: runsOutBeforeReset ? 'runs out before reset' : `if ${runwayPace} holds`,
      cls: runwayCls,
    },
```

Leave the Weekly Runway and Reset Gap cards, and the entire `!runwayHasProjection` branch, unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (the three new ones plus the full existing suite — the pre-existing `renderStats shows neutral weekly runway and plan-fit cards` test still passes because its required multiplier ~7x is in the upgrade band and its now-negative headroom is silently floored, which it does not assert on).

- [ ] **Step 5: Syntax-check the changed file**

Run: `node --check analytics-renderer.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add analytics-renderer.js test/analytics-renderer.test.js
git commit -m "fix(analytics): clamp At-Reset and Plan-Fit projection cards

Floor negative weekly headroom to 0% (runs out before reset) and collapse
the required-plan multiplier into fits / upgrade-target / won't-fit bands so
a short active-burn sample no longer implies -461% headroom or a 126x plan.
Presentation-only; metrics.js unchanged."
```

---

## Self-Review

**1. Spec coverage:** All five spec test cases are covered — At-Reset floor (test 1), At-Reset positive passthrough (test 2), Plan-Fit fits (test 2), Plan-Fit upgrade band (test 3), Plan-Fit won't-fit (test 1). The two card reframes and the `cur*3` ceiling constant are implemented in Step 3. `metrics.js` untouched, per spec's out-of-scope. ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code; exact commands and expected outcomes given. ✅

**3. Type consistency:** `cur`/`req`/`headroomRaw` read the exact `weeklyRunway` return fields (`currentPlanMultiplier`, `requiredPlanMultiplier`, `projectedHeadroomAtResetPct`). `fmtMultiplier`, `runwayPace`, `runwayCls`, `runwayHasProjection` all already exist in `renderStats` scope. No new symbols leak out. Card copy strings match the Global Constraints verbatim. ✅

**Note on the ceiling constant:** the spec suggested a module-level `PLAN_FIT_CEILING_FACTOR`. It is instead a local `planFitCeiling = cur * 3` at the point of use, because the value is needed only inside `renderStats` (YAGNI) and the test harness slices the source starting at `function fmtDuration`, which would exclude a pre-slice module const from the `vm` context. Local keeps it named, near use, and testable without a harness change.
