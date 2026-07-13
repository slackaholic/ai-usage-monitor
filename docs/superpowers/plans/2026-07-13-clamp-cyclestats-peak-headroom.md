# Clamp cycleStats peakPct / headroomPct Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clamp `cycleStats`'s `minRemaining` into [0,100] so `peakPct` never exceeds 100 and `headroomPct` never goes negative when a meter reports over-quota.

**Architecture:** One-line change in the pure `metrics.js` `cycleStats` function, plus one new unit test. Clamping `minRemaining` fixes both derived stats at once (`peakPct = 100 - minRemaining`, `headroomPct = minRemaining`).

**Tech Stack:** Node built-in `node --test`. `metrics.js` is a pure, dual-loaded module (browser global + CommonJS export).

## Global Constraints

- No new dependencies.
- `metrics.js` purity rules: no `Date.now()` / argless `new Date()` (`new Date(isoString)` is fine), no new deps, pure functions. This change adds only `Math.max`/`Math.min` — compliant.
- Only `cycleStats`'s `minRemaining` line changes. `firstZeroIdx`, `blocked`, `blockedMs`, `startTs`, `endTs`, and the `peakPct`/`headroomPct` expressions are untouched.
- The "blocked" detection (`remaining === 0`) is explicitly NOT changed.
- Clamp is `Math.max(0, Math.min(100, Math.min(...remaining)))`.

---

### Task 1: Clamp minRemaining in cycleStats

**Files:**
- Modify: `metrics.js` — `cycleStats` (around line 42–61), the `minRemaining` assignment.
- Test: `test/metrics.test.js` — add one unit test near the other `cycleStats` tests.

**Interfaces:**
- Consumes (existing, unchanged): `cycleStats(cycle, win)` returns `{ startTs, endTs, peakPct, headroomPct, blocked, blockedMs }`.
- Produces: no new symbols; tightens the range of `peakPct`/`headroomPct` to [0,100].

- [ ] **Step 1: Write the failing test**

In `test/metrics.test.js`, add this test (the file already imports `cycleStats` and `assert`):

```js
test('cycleStats clamps peakPct/headroomPct to [0,100] for over-quota (negative remaining) snapshots', () => {
  const cycle = [
    { ts: '2026-07-13T08:00:00Z', wk: 5 },
    { ts: '2026-07-13T09:00:00Z', wk: -2 }, // over quota → 102% used pre-clamp
  ];
  const s = cycleStats(cycle, 'wk');
  assert.equal(s.peakPct, 100);   // clamped from 102
  assert.equal(s.headroomPct, 0); // clamped from -2
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="clamps peakPct/headroomPct" 2>&1 | grep -E "# (pass|fail)|peak|headroom"`
Expected: FAIL — `peakPct` is `102` (not `100`) and `headroomPct` is `-2` (not `0`), so the assertions fail (`# fail 1`).

- [ ] **Step 3: Implement the clamp**

In `metrics.js`, inside `cycleStats`, change:

```js
  const minRemaining = Math.min(...remaining);
```

to:

```js
  // Clamp into [0,100]: a meter can report over-quota (negative remaining, when
  // utilization > 1), which would otherwise make peakPct exceed 100 or
  // headroomPct go negative. Peak usage caps at 100%; headroom can't be negative.
  const minRemaining = Math.max(0, Math.min(100, Math.min(...remaining)));
```

Change nothing else in `cycleStats`.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `node --test --test-name-pattern="clamps peakPct/headroomPct" 2>&1 | grep -E "# (pass|fail)"`
Expected: PASS (`# pass 1`, `# fail 0`).

- [ ] **Step 5: Run the full suite (including the previously-failing real-log test)**

Run: `npm test 2>&1 | grep -E "not ok|# (tests|pass|fail)"`
Expected: no `not ok` lines; `# tests 62`, `# pass 62`, `# fail 0`. The data-dependent `real log: full pipeline yields sane stats and never throws` test (which was failing with `peak 102`) now passes because `cycleStats` clamps.

- [ ] **Step 6: Syntax-check**

Run: `node --check metrics.js`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "fix(metrics): clamp cycleStats peakPct/headroomPct to [0,100]

An over-quota meter reports negative remaining % (Claude's round((1-util)*100)
goes negative when util > 1), which made peakPct exceed 100 and headroomPct go
negative. Clamp minRemaining into [0,100] at the derived-stat layer so peak usage
caps at 100% and headroom can't be negative. Fixes the real-log sanity test."
```

---

## Self-Review

**1. Spec coverage:** The single spec change — clamp `minRemaining` to [0,100] in `cycleStats` — is Step 3. The spec's TDD requirement (RED synthetic over-quota cycle → GREEN) is Steps 1–4. The real-log test turning green is verified in Step 5. Blocked-detection left unchanged (spec out-of-scope) — Step 3 touches only the one line. Full coverage. ✅

**2. Placeholder scan:** No TBD/TODO. Both code steps (test + implementation) show complete code. Exact commands and expected outputs given. ✅

**3. Type consistency:** `cycleStats(cycle, win)` signature and return shape unchanged; the test reads `s.peakPct`/`s.headroomPct` — the exact property names returned at `metrics.js:56-57`. Clamp uses `Math.max`/`Math.min` only. Test count goes 61 → 62 (one added). ✅
