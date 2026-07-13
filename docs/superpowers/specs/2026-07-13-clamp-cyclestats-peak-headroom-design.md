# Clamp cycleStats peakPct / headroomPct to [0,100] — Design

**Date:** 2026-07-13
**Status:** Approved (design)
**Component:** AI Usage Monitor — `metrics.js` (`cycleStats`).

## Problem

`cycleStats` can produce `peakPct > 100` and `headroomPct < 0`, violating the
[0,100] invariant every consumer (and the "real log" sanity test) expects. The
data-dependent test `real log: full pipeline yields sane stats and never throws`
(`test/metrics.test.js`) currently fails with `peak 102` against the live
`usage-log.jsonl`.

Root cause (`metrics.js:42-57`):

```js
const minRemaining = Math.min(...remaining);
...
peakPct: 100 - minRemaining,
headroomPct: minRemaining,
```

`remaining` is the per-snapshot remaining % for the window. When a snapshot is
**over quota**, its remaining % is negative — Claude Code's value is computed as
`Math.round((1 - util) * 100)` (`main.js`), which goes negative when
`util > 1.0` (utilization above the rate limit). Then `minRemaining = -2` yields
`peakPct = 102` and `headroomPct = -2`.

## Decision (from the user)

Clamp in `metrics.js` (the derived-stat layer). Semantically: peak **usage**
caps at 100% (you can't meaningfully exceed the quota — over-limit reads as
"maxed"), and headroom can't be negative. `[0,100]` is the canonical invariant
every consumer depends on, so the clamp belongs where the stat is derived — not
at each render site.

The "blocked" detection (`remaining === 0`, `metrics.js:45`) is **not** changed:
a cycle that went negative without ever logging exactly `0` stays uncounted as
blocked. (Possible separate follow-up, deliberately out of scope.)

## Change — `metrics.js`

In `cycleStats`, clamp `minRemaining` into `[0,100]` before it feeds the derived
stats. Change:

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

Nothing else changes. `firstZeroIdx`, `blocked`, `blockedMs`, `startTs`,
`endTs`, and the `peakPct`/`headroomPct` expressions themselves are untouched —
they now derive from a clamped `minRemaining`, so `peakPct = 100 - minRemaining ∈
[0,100]` and `headroomPct = minRemaining ∈ [0,100]`.

## Testing

`metrics.js` is a pure module, unit-tested via `node --test`. TDD applies.

**New unit test** (`test/metrics.test.js`) — synthetic over-quota cycle:

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

- RED: before the change, `peakPct` is `102` and `headroomPct` is `-2` — both
  assertions fail.
- GREEN: after the clamp, `peakPct === 100` and `headroomPct === 0`.

**Existing coverage:** the data-dependent `real log: full pipeline yields sane
stats and never throws` test (currently failing with `peak 102`) turns green
once the clamp lands. Full `node --test` suite green (61 existing + 1 new = 62).

## Out of scope

- Clamping the raw per-snapshot remaining % at the source (`main.js` /
  `renderer.js`) — the derived-layer clamp fixes all consumers, including
  already-logged data; not changing ingestion.
- Changing "blocked" detection to count negative remaining (`=== 0` → `<= 0`).
- Whether an over-quota state should surface differently in the UI.
