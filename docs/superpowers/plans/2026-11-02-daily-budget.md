# Daily budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead 5-hour-window budget with a daily budget of 20% of the weekly limit: a Today Remaining tile, a week line judged by the plan rule, matching analytics cards, and a Settings screen without the 5h target and tier-change dates.

**Architecture:** Two pure layers in `metrics.js`. The log layer turns one account's usage-log rows into four figures (`dayBudgetInfo`). The verdict layer turns those figures, the daily target and the current time into the tile figure and the plan verdict (`dayBudgetVerdict`, `weekLine`). `main.js` serves the log layer through `get-budget-info`. The main window (`renderBudget`) and the analytics page (`renderStats`) both call the verdict layer, so they cannot disagree.

**Tech Stack:** Electron 28, plain browser JavaScript, `node --test` with the existing slice-and-`vm` harnesses. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-11-02-daily-budget-design.md](../specs/2026-11-02-daily-budget-design.md), approved 2 Nov 2026. Read it before any task.

## Global Constraints

- `metrics.js` stays pure and dual-loaded: no `Date.now()`, no argless `new Date()`, no locale formatting. `new Date(ms)` and `new Date(y, m, d)` are fine. The caller passes local midnight and the current time.
- Daily target: `budgetTargets.day`, default **20** (`DEFAULT_DAY_TARGET`). Nothing reads `budgetTargets.window` or `tierChangedAt` after this plan; their stored values stay in `settings.json` untouched.
- Day boundary: local midnight. No weekday logic anywhere.
- Tile colour, by today's use against the target: within → green `#34d399`; over → amber `#f59e0b`; at or above 1.5× → red `#f87171`. Bars use the matching gradients from `barGradient` in `renderer.js`.
- Copy, exactly: `Today Remaining`, `Today`, `of 20% · resets at midnight`, `week ≈ 3.7 days at 20% · on plan · resets Tue 13:00`, `behind plan by 0.5 days`, `week used up · resets Tue 13:00`, `5H Remaining`, `5H`, `Today's Budget`, `Week Budget`. The `20%` is the configured target; the reset is weekday and 24-hour time, UK.
- One render path for every provider: no `acct.id === …` branches.
- Every file in the repo is CRLF and must stay so. Create new files with LF, then run `node C:/Users/ROMMEL~1/AppData/Local/Temp/claude/C--Users-Rommel-Payba--claude-sessions-ai-usage-monitor/53d59238-abdc-4de9-a139-e820df8c0c87/scratchpad/to-crlf.js <file>`; check any touched file with `node …/scratchpad/bytecheck.js <file>` (same folder), expecting `uniform CRLF`.
- Never write, truncate or commit `usage-log.jsonl` or `settings.json`; never read `settings.json`. Tests use fixtures only.
- Before each commit: `npm test` green and `node --check <file>` on each changed JS file. Prefix git with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' MSYS_NO_PATHCONV=1`. Write multi-line messages to a scratch file and `git commit -F` it; end each with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/daily-budget`.

## Review Focus

1. **A reading from before a reset that has since passed.** This happens when the app is opened after the reset but before the next poll, or for an account that has stopped polling. Expected: no verdict, no "resets" time already in the past, and an uncapped Today figure. Tests: Task 2 (`stale reset`) and Task 4 (`stale reset`).
2. **A clocks-change week.** Expected: days so far counts calendar days, not 24-hour blocks, across the spring change (28 Mar 2027) and the autumn change (25 Oct 2026). Test: Task 2 (`clock changes`).
3. **A bad low reading that springs back.** The real log has 92 → 91 → 92 on Claude Desktop on 27 Oct, with jumbled reset times. Expected: no use added. Test: Task 1 (`bad low`).
4. **An account with no budget figures yet.** This covers startup and a newly found Claude Code account. Expected: the tile reads `—`, the week line is blank, and nothing throws. Test: Task 4 (`no budget figures yet`).
5. **A daily target other than 20.** Expected: 25 reaches the tile's line, the bar width, the week line and the analytics cards. Tests: Task 2, Task 4 and Task 5 (`target 25`).

## Decisions this plan makes (the spec left them to the builder)

The day-count rules below were checked against the real log from June to 2 Nov. Every real Claude week read "on plan". The only "behind" days were days of 28–32% use.

- **Telling a reset from a bad reading or a partial refill.** A rise counts as a reset only if the scheduled reset (`prev.reset7dTs`) fell between the two polls, or if it rose by more than `RESET_JUMP_MIN` (15) and landed at 85 or more. Codex on 29 Oct rose from 67 to 83 with the reset time unchanged, a partial refill. Treating that as a reset would have counted 17 points of use that never happened.
- **Use after a reset is counted only across a polling gap** (≥ `ACTIVE_GAP_MAX`), as `100 − reading`. A rise seen between two close polls adds nothing.
- **A rise with no poll within 15 minutes after it is dropped**, unless the scheduled reset fell between. This removes a bad high reading that was the last poll before a gap.
- **A lowered run that springs back** within 15 minutes, to between its predecessor's level and 15 above it, is dropped as a bad reading (`dropDips`).
- **The cycle restarts at a detected reset:** at the scheduled reset time when that fell between the polls, otherwise at the first poll after the rise.
- **The tile is also red when the week is used up**, so it never shows `0.0%` in green.
- **"Behind plan by" never prints `0.0`:** it shows at least `0.1`.
- **`noFiveHourWindow` stays.** `renderBudget` needs it to know which cards carry the Today tile. `lastPct5h` goes.
- **The analytics runway cards take the plan colour in both branches**, including the placeholder branch with no projection. A used-up week has no projection, and the spec wants those cards red.

---

### Task 1: Count today's weekly use and find the cycle start

**Files:**
- Modify: `metrics.js`. Add the new functions after `dropSpikes`. Leave `weeklyBurnSince` in place; Task 7 removes it.
- Test: `test/metrics.test.js`. Append a section headed `// ── Daily budget: today's use and the cycle (2 Nov 2026) ──`.

**Interfaces:**
- Produces (exported):
  - `dayBurnSince(snapshots, sinceMs) → number`: weekly points used since `sinceMs`.
  - `weeklyCycleStart(snapshots) → number | null`: epoch ms.
  - `dayBudgetInfo(snapshots, midnightMs) → { dayBurnPct, weeklyRemainingPct, weeklyResetTs, cycleStartTs }`. All four are `null` when no row has a `wk` value.
- Internal: `dropDips(points, win)`, plus one shared cleaner for the weekly series that both `dayBurnSince` and `weeklyCycleStart` use.

**Rules** (the tests pin them; this is the algorithm they do not determine):

```
points  = rows with wk != null and a parseable ts
cleaned = dropUnconfirmedRises(dropDips(dropSpikes(points, 'wk'), 'wk'))
  dropDips: mirror of dropSpikes. A run below its kept predecessor is dropped when,
            within ACTIVE_GAP_MAX of the run's first point, the series returns to
            >= predecessor.wk and <= predecessor.wk + RESET_JUMP_MIN.
  dropUnconfirmedRises: a point above its kept predecessor is dropped when the next
            input point is not within ACTIVE_GAP_MAX of it, unless scheduledBetween.
scheduledBetween(a, b) = a.reset7dTs > 0 && a.ts < a.reset7dTs <= b.ts
isReset(a, b) = b.wk > a.wk && (scheduledBetween(a, b)
                || (b.wk - a.wk > RESET_JUMP_MIN && b.wk >= 100 - RESET_JUMP_MIN))

dayBurnSince: for each consecutive cleaned pair (a, b) with b.ts > sinceMs:
  fall                          -> use = a.wk - b.wk, over [a.ts, b.ts]
  isReset && b.ts - a.ts >= GAP -> use = max(0, 100 - b.wk), over [start, b.ts],
                                   start = a.reset7dTs if scheduledBetween else a.ts
  any other rise                -> use = 0
  add use x (share of [start, b.ts] that lies after sinceMs)
weeklyCycleStart = max(latest reset7dTs - 7 days, time of the last isReset pair),
  that time being a.reset7dTs when scheduledBetween, else b.ts; null if neither exists
```

Test fixtures use local wall time, so they hold in any time zone:

```js
const { dayBurnSince, weeklyCycleStart, dayBudgetInfo } = require('../metrics.js');
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString(); // Nov 2026; 3 Nov is a Tuesday
const ms = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
const R = ms(10, 13);                                                    // reset Tue 10 Nov 13:00
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
```

- [ ] **Step 1: Write the failing tests.** `dayBurnSince` cases, each with `sinceMs = ms(4, 0)` unless stated. Rows are `{ ts, wk[, reset7dTs] }`:

| Test name | Rows `(day, h, m) wk [reset]` | Expect |
| --- | --- | --- |
| `dayBurnSince: falls across a polling gap still count` | (4,9,0) 80 · (4,9,5) 78 · (4,14,0) 70 · (4,14,5) 69 | `11` |
| `dayBurnSince: rises are not use` | (4,9,0) 80 · (4,9,5) 82 · (4,9,10) 82 · (4,9,15) 81 | `1` |
| `dayBurnSince: an interval across midnight is split by time` | (3,22,0) 60 · (4,8,0) 50 | `near(…, 8)` |
| `dayBurnSince: the day keeps counting across a weekly reset` (since `ms(3,0)`) | (3,10,0) 40 [ms(3,13)] · (3,10,5) 35 [ms(3,13)] · (3,12,55) 30 [ms(3,13)] · (3,13,1) 100 [R] · (3,13,6) 97 [R] | `13` |
| `dayBurnSince: use after a reset in a polling gap is measured from 100` (since `ms(10,0)`) | (9,17,0) 10 [R] · (10,15,0) 88 [ms(17,13)] · (10,15,2) 88 [ms(17,13)] | `12` |
| `dayBurnSince: an early refill in a gap counts from 100, split by time` (since `ms(9,0)`) | (6,17,0) 30 [R] · (9,9,0) 90 [R] · (9,9,2) 90 [R] | `near(…, 10 * 9 / 64)` |
| `dayBurnSince: a bad high reading that springs back adds no use` | (4,9,57) 68 · (4,9,59) 100 · (4,10,1) 68 · (4,10,11) 67 | `1` |
| `dayBurnSince: a bad high reading just before a gap adds no use` | (4,9,0) 68 · (4,9,1) 100 · (4,15,0) 60 · (4,15,2) 60 | `8` |
| `dayBurnSince: a bad low reading that springs back adds no use` (**bad low**) | (4,9,0) 92 · (4,9,2) 91 · (4,9,4) 92 · (4,9,6) 92 · (4,9,30) 91 | `1` |
| `dayBurnSince: a partial refill across a gap is not a reset` | (4,9,0) 67 · (4,13,0) 83 · (4,13,2) 83 | `0` |
| `dayBurnSince: a refill seen between close polls adds no use of its own` | (4,10,0) 30 · (4,10,2) 92 · (4,10,4) 91 | `1` |
| `dayBurnSince: no rows is no use` | `[]` | `0` |

`weeklyCycleStart` cases (rows carry `[R]` unless stated):

| Test name | Rows | Expect |
| --- | --- | --- |
| `weeklyCycleStart: a week before the logged reset` | (4,9,0) 80 · (4,9,5) 79 | `ms(3,13)` |
| `weeklyCycleStart: an early refill without a moved reset restarts it` | (5,10,0) 40 · (5,10,2) 100 · (5,10,4) 99 | `ms(5,10,2)` |
| `weeklyCycleStart: a refill across a gap restarts at the first poll after it` | (6,17,0) 30 · (9,9,0) 90 · (9,9,2) 90 | `ms(9,9)` |
| `weeklyCycleStart: a bad reading does not restart it` | (4,9,57) 68 · (4,9,59) 100 · (4,10,1) 68 | `ms(3,13)` |
| `weeklyCycleStart: a partial refill does not restart it` | (4,9,0) 67 · (4,13,0) 83 · (4,13,2) 83 | `ms(3,13)` |
| `weeklyCycleStart: nothing to go on` | (4,9,0) 80 · (4,9,5) 79, no reset field | `null` |

`dayBudgetInfo` cases:
- `dayBudgetInfo: the four figures for one account`. With rows (4,9,0) 78 [R] and (4,9,5) 76 [R], and `ms(4,0)`, it deep-equals `{ dayBurnPct: 2, weeklyRemainingPct: 76, weeklyResetTs: R, cycleStartTs: ms(3,13) }`.
- `dayBudgetInfo: the weekly remaining is the latest reading, as the weekly tile shows it`. The last row is a lone rise (4,9,5) 100. Expect `weeklyRemainingPct === 100`.
- `dayBudgetInfo: no weekly rows gives nothing to show`. Rows `[{ ts: at(4,9), '5h': 50, wk: null }]` deep-equal four `null`s.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `node --test test/metrics.test.js`. Expected: FAIL, with `dayBurnSince is not a function`.
- [ ] **Step 3: Implement** `dropDips`, the shared cleaner, `dayBurnSince`, `weeklyCycleStart` and `dayBudgetInfo` in `metrics.js`, following the rules above. Reuse `latestResetTs` and `dropSpikes`. Add the three public names to `module.exports`. Comment `dropDips` with the real case it answers: Claude Desktop, 27 Oct 2026, 92 → 91 → 92.
- [ ] **Step 4: Run `npm test`.** Expected: PASS, including every existing test.
- [ ] **Step 5: Commit** with the subject `feat(metrics): count today's weekly use across polling gaps`, after `node --check metrics.js` and the CRLF check.

---

### Task 2: The daily-budget verdict and the week line

**Files:**
- Modify: `metrics.js`. Add the new code after `dayBudgetInfo`.
- Test: `test/metrics.test.js`. Append a section headed `// ── Daily budget: the verdict and the week line ──`, reusing Task 1's `at`, `ms` and `R`.

**Interfaces:**
- Consumes: the `dayBudgetInfo` shape from Task 1. `info` may be `null` or `undefined`.
- Produces (exported):
  - `DEFAULT_DAY_TARGET = 20`.
  - `dayBudgetVerdict(info, dayTarget, nowMs) → { todayRemainingPct, todayLevel, weekDays, state, behindDays, daysSoFar }`:
    - `todayLevel`: `0`, `1`, `2` or `null`;
    - `state`: `'onPlan'`, `'behind'`, `'usedUp'` or `'unknown'`.
  - `weekLine(verdict, dayTarget, resetLabel) → { head, tail, tone } | null`, where `tone` is `'muted'` or `'red'`.

**Rules:**
- `target = dayTarget > 0 ? dayTarget : DEFAULT_DAY_TARGET`.
- **Stale:** when `weeklyResetTs` is finite and `≤ nowMs`, treat the weekly remaining as unknown.
- `todayRemainingPct = target − dayBurnPct`, capped at `weeklyRemainingPct` when that is known. It is `null` when `dayBurnPct` is not finite.
- `todayLevel`:
  - `null` with no burn;
  - otherwise `2` when the weekly remaining is known and `≤ 0`, or when burn `≥ 1.5 × target`;
  - otherwise `1` when burn `> target`;
  - otherwise `0`.
- `weekDays = max(0, remaining ÷ target)`, or `null` when the remaining is unknown.
- `state`, checked in this order:
  1. remaining unknown → `unknown`;
  2. remaining `≤ 0` → `usedUp`;
  3. `weeklyResetTs` or `cycleStartTs` not finite → `unknown`;
  4. otherwise `used = 100 − remaining` and `allowance = min(100, target × daysSoFar)`, giving `onPlan` when `used ≤ allowance` and `behind` otherwise.
- `daysSoFar = max(1, round((localMidnight(nowMs) − localMidnight(cycleStartTs)) ÷ 1 day) + 1)`. Build local midnight with `new Date(y, m, d)`. Rounding, not flooring, is what survives a 23-hour day. It is `null` without a cycle start.
- `behindDays = (used − allowance) ÷ target` when behind, else `0`.
- `weekLine`:
  - `usedUp` → `{ head: 'used up', tail: resetLabel ? 'resets ' + resetLabel : '', tone: 'red' }`;
  - otherwise `null` when `weekDays` is `null`;
  - otherwise `head = '≈ ' + weekDays.toFixed(1) + ' days at ' + target + '%'`, with tail and tone by state:
    - `onPlan`: `'on plan · resets ' + resetLabel`, muted;
    - `behind`: `'behind plan by ' + Math.max(0.1, behindDays).toFixed(1) + ' days · resets ' + resetLabel`, red;
    - `unknown`: `''`, muted.

Helper for the tests:

```js
const { dayBudgetVerdict, weekLine, DEFAULT_DAY_TARGET } = require('../metrics.js');
const CYCLE = { weeklyResetTs: R, cycleStartTs: ms(3, 13) };
const verdictAt = (d, h, rem, burn = 0, target = 20) =>
  dayBudgetVerdict({ ...CYCLE, weeklyRemainingPct: rem, dayBurnPct: burn }, target, ms(d, h));
```

- [ ] **Step 1: Write the failing tests.** Each name and its assertions:
  - `plan rule: five working days at 20, weekend off`:
    - `verdictAt(3,23,80)` through `verdictAt(6,23,20)` (Tue to Fri), and `verdictAt(7,23,20)` and `verdictAt(8,23,20)` (the weekend), all give `state === 'onPlan'`;
    - `verdictAt(9,23,0)` and `verdictAt(10,10,0)` give `'usedUp'`.
  - `plan rule: 20 every day uses the week up after the fifth day`:
    - `verdictAt(3,23,80)`, `(4,23,60)`, `(5,23,40)` and `(6,23,20)` are `onPlan`;
    - `verdictAt(7,23,0)` is `usedUp`.
  - `plan rule: 30 on Wednesday after 20 on Tuesday is half a day behind`:
    - `verdictAt(4,23,50)` gives `state 'behind'` and `near(behindDays, 0.5)`;
    - `verdictAt(5,23,40)` gives `onPlan`;
    - `verdictAt(5,23,38)` gives `behind` with `near(behindDays, 0.1)`.
  - `plan rule: 15 by the first afternoon is on plan`: `verdictAt(3,17,85).state === 'onPlan'`.
  - `plan rule: an early refill restarts the days so far`: `dayBudgetVerdict({ weeklyRemainingPct: 70, dayBurnPct: 30, weeklyResetTs: R, cycleStartTs: ms(5,10,2) }, 20, ms(5,23))` gives `daysSoFar 1`, `state 'behind'` and `near(behindDays, 0.5)`.
  - `today: remaining in weekly points, coloured by use against the target`. With `verdictAt(4,10,74,b)`:
    - `b = 1` → `todayRemainingPct 19`, `todayLevel 0`, `weekDays near 3.7`;
    - `b = 20` → level 0;
    - `b = 20.1` → level 1;
    - `b = 24.5` → remaining `-4.5`, level 1;
    - `b = 29.9` → level 1;
    - `b = 30` → level 2.
  - `today: capped at what the week has left`: `verdictAt(4,10,5,0)` gives `todayRemainingPct 5` and `weekDays 0.25`.
  - `today: an over-quota week reads negative and red`: `verdictAt(4,10,-3,2)` gives `todayRemainingPct -3`, `todayLevel 2`, `state 'usedUp'` and `weekDays 0`.
  - `no figures yet`: `dayBudgetVerdict(undefined, 20, ms(4,10))` gives `{ todayRemainingPct: null, todayLevel: null, weekDays: null, state: 'unknown' }`, checking these four fields.
  - `no reset time: days but no verdict`: `{ dayBurnPct: 1, weeklyRemainingPct: 74, weeklyResetTs: null, cycleStartTs: null }` gives `state 'unknown'`, `weekDays near 3.7` and `todayRemainingPct 19`.
  - `stale reset: a reading from before a reset that has passed gives no verdict` (**stale reset**): `{ dayBurnPct: 3, weeklyRemainingPct: 0, …CYCLE }` at `ms(10,14)` gives `state 'unknown'`, `weekDays null`, `todayRemainingPct 17` and `todayLevel 0`.
  - `clock changes: days so far counts calendar days` (**clock changes**), each with `weeklyRemainingPct 80` and `dayBurnPct 0`:
    - spring: start `new Date(2027,2,23,13)`, reset `new Date(2027,2,30,13)`, now `new Date(2027,2,29,10)` gives `daysSoFar 7`;
    - autumn: start `new Date(2026,9,20,13)`, reset `new Date(2026,9,27,13)`, now `new Date(2026,9,26,10)` gives `daysSoFar 7`.
  - `target 25` (**target 25**): `verdictAt(4,23,50,0,25)` gives `onPlan`, `weekDays 2` and `todayRemainingPct 25`.
  - `a missing or zero target falls back to 20`: `verdictAt(4,10,74,1,0).todayRemainingPct === 19` and `DEFAULT_DAY_TARGET === 20`.
  - `weekLine: on plan`: `weekLine(verdictAt(4,10,74,1), 20, 'Tue 13:00')` deep-equals `{ head: '≈ 3.7 days at 20%', tail: 'on plan · resets Tue 13:00', tone: 'muted' }`.
  - `weekLine: behind`: `weekLine(verdictAt(4,22,50), 20, 'Tue 13:00')` deep-equals `{ head: '≈ 2.5 days at 20%', tail: 'behind plan by 0.5 days · resets Tue 13:00', tone: 'red' }`.
  - `weekLine: used up comes first`:
    - `weekLine(verdictAt(9,23,0), 20, 'Tue 13:00')` deep-equals `{ head: 'used up', tail: 'resets Tue 13:00', tone: 'red' }`;
    - with `''` as the label, the tail is `''`.
  - `weekLine: no reset time leaves the days alone`: the no-reset verdict above gives `{ head: '≈ 3.7 days at 20%', tail: '', tone: 'muted' }`.
  - `weekLine: nothing to say`: `weekLine(dayBudgetVerdict(undefined, 20, 0), 20, '') === null`.
  - `weekLine: behind never reads 0.0 days`: `weekLine({ state: 'behind', weekDays: 2, behindDays: 0.04 }, 25, 'Tue 13:00').tail` starts with `'behind plan by 0.1 days'`.
- [ ] **Step 2: Run `node --test test/metrics.test.js`.** Expected: FAIL, with `dayBudgetVerdict is not a function`.
- [ ] **Step 3: Implement** `DEFAULT_DAY_TARGET`, `dayBudgetVerdict` and `weekLine` in `metrics.js`, and export all three.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with the subject `feat(metrics): judge the week by the plan rule, not the pace`.

---

### Task 3: Serve the daily-budget figures from `get-budget-info`

**Files:**
- Modify: `main.js`:
  - the `require('./metrics.js')` line (about line 22), which becomes `const { dayBudgetInfo } = require('./metrics.js');`;
  - delete `tierChangeMs` and its comment (about lines 79–91; it has no other caller);
  - the `get-budget-info` handler (about lines 93–110).
- Create: `test/budget-info.test.js`.

**Interfaces:**
- Consumes: `dayBudgetInfo(snapshots, midnightMs)` from Task 1.
- Produces: `get-budget-info` answers `{ [logAccount]: dayBudgetInfo(rows, localMidnightMs) }`. Each value has exactly the four keys, with no `ratio` and no `tierChangedAt`. With no log, it answers `{}`. `preload.js` is unchanged.

- [ ] **Step 1: Write the failing test.**
  - Slice `main.js` from `ipcMain.handle('get-budget-info'` to `ipcMain.on('open-analytics'`. Run the slice in a `vm` context holding:
    - `ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }`;
    - `readUsageLogGrouped: () => grouped`;
    - `Date`;
    - a spy `dayBudgetInfo: (rows, midnightMs) => { calls.push([rows, midnightMs]); return { rows: rows.length }; }`.
  - Tests:
    - `get-budget-info answers the day-budget figures for every logged account`. With `grouped = { codex: [{}, {}], 'claude-desktop': [{}] }`, `handlers['get-budget-info']()` deep-equals `{ codex: { rows: 2 }, 'claude-desktop': { rows: 1 } }`. Every `calls[i][1]` equals `(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })()`.
    - `get-budget-info with no log answers no accounts`. With `grouped = null`, the answer deep-equals `{}`.
- [ ] **Step 2: Run `node --test test/budget-info.test.js`.** Expected: FAIL, because the old handler calls `loadSettings`, which is not defined in the context.
- [ ] **Step 3: Rewrite the handler.** It reads the grouped log, works out local midnight as today, and maps each account through `dayBudgetInfo`. Keep the `readUsageLogGrouped` comment block; it is still true.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with the subject `feat(budget): serve today's use, weekly figures and cycle start`. Convert the new test file to CRLF first.

---

### Task 4: The Today tile and the week line on every card

**Files:**
- Modify `renderer.js`:
  - delete `lastPct5h`: its declaration and comment (about lines 31–33) and its `registerAccount` line (about line 45);
  - `budgetTargets` (about line 203) becomes `{ day: DEFAULT_DAY_TARGET }`;
  - the `noFiveHourWindow` comment (about lines 205–209) now says it drives the Today tile;
  - replace `renderBudget` and its comment (about lines 744–792) with a block bounded by `// ── BUDGET ──` and `// ── BUDGET END ──`;
  - `refreshBudget` (about lines 795–808) reads only `bt.day` and calls `renderBudget(p)`;
  - `renderAccountData` (about lines 1438–1447).
- Modify `index.html`:
  - delete the `.budget-marker` CSS (about lines 202–205) and add `.win-label { margin-left: 0.3em; }`;
  - delete the three `budget-marker` elements (about lines 430, 515, 619);
  - give the three `5H Remaining` labels ids: `codex-5h-label`, `claude-5h-label`, and `data-id="5h-label"` in the template;
  - turn the three compact 5H labels into `Codex<span class="win-label" id="c-codex-5h-label">5H</span>`, `Claude Desktop<span class="win-label" id="c-claude-5h-label">5H</span>`, and `Claude VS Code<span class="win-label" data-id="5h-label">5H</span>` in `tpl-claude-code-compact`. The text node must stay first, because `setHeadingSuffix` writes the account suffix into it.
- Create: `test/budget-render.test.js`.
- Modify `test/account-render.test.js` and `test/codex-render.test.js`. In the latter, change the slice end marker from `'function renderBudget'` to `'// ── BUDGET ──'`.

**Interfaces:**
- Consumes these globals, which `index.html` loads with `metrics.js` before `renderer.js`: `dayBudgetVerdict`, `weekLine`, `DEFAULT_DAY_TARGET`.
- Produces, inside the BUDGET block:
  - `levelColor(level) → string`: `''` for `null`, otherwise `#34d399`, `#f59e0b` or `#f87171`;
  - `levelGradient(level) → string`: `'var(--border)'` for `null`, otherwise the three gradients from `barGradient` (green, amber, red);
  - `fmtWeekReset(ms) → string`: `''` when the time is not finite, otherwise `toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })`, which gives `'Tue 13:00'`;
  - `renderBudget(prefix, nowMs = Date.now())`.

**What `renderBudget(prefix, nowMs)` paints.** It uses `info = budgetInfo[LOG_ACCOUNT[prefix]]`, `target = budgetTargets.day` and `v = dayBudgetVerdict(info, target, nowMs)`.
- When `noFiveHourWindow.has(prefix)`:
  - `#<p>-5h-label` reads `Today Remaining` and `#c-<p>-5h-label` reads `Today`;
  - `#<p>-5h-pct` and `#c-<p>-5h` show `v.todayRemainingPct.toFixed(1) + '%'`, or `—` when it is `null`, in `levelColor(v.todayLevel)`;
  - `#<p>-5h-bar` has width `clamp(todayRemainingPct ÷ target × 100, 0, 100) + '%'` (`'0%'` when `null`) and background `levelGradient(v.todayLevel)`;
  - `#<p>-5h-reset` reads `of ${target}% · resets at midnight`;
  - it calls `showCompactStat('<p>-5h', true)`.
- Otherwise the labels read `5H Remaining` and `5H`, and the tile is not touched.
- Always, the week line: `line = weekLine(v, target, fmtWeekReset(info && info.weeklyResetTs))`.
  - `#<p>-budget-note` text is `''` when `line` is `null`, otherwise `'week ' + line.head + (line.tail ? ' · ' + line.tail : '')`;
  - its class is `'budget-note'`, plus `' wayover'` when the tone is red.

**`renderAccountData` order.** Set the flag. Call `renderStat(id, '5h', reading.pct5h)` only when `reading.has5h`. Render the weekly stat as now. Set the `5h-reset` line (now `''` unless `has5h` and `reset5hMs > 0`) and the `wk-reset` line. Then call `renderBudget(id)` last, so its line under the Today tile wins.

- [ ] **Step 1: Write the failing tests.**
  - Harness for `test/budget-render.test.js`:
    - slice `renderer.js` from `// ── BUDGET ──` to `// ── BUDGET END ──`;
    - each element is `{ id, textContent: null, className: '', style: {} }`;
    - the context is `{ ...require('../metrics.js'), document, Date, Math, Number, budgetInfo, budgetTargets: { day: target }, LOG_ACCOUNT: { codex: 'lk-codex' }, noFiveHourWindow, showCompactStat: spy }`.
  - Use `INFO = { dayBurnPct: 1, weeklyRemainingPct: 74, weeklyResetTs: ms(10,13), cycleStartTs: ms(3,13) }` with Task 1's `ms`. Tests:
    - `a weekly-only card shows what is left of today in weekly points`. Render at `ms(4,10)`:
      - labels `Today Remaining` and `Today`;
      - `codex-5h-pct` and `c-codex-5h` read `19.0%` in color `#34d399`;
      - the bar has width `95%` and background `linear-gradient(90deg,#059669,#34d399)`;
      - `codex-5h-reset` reads `of 20% · resets at midnight`;
      - the compact spy saw `['codex-5h', true]`;
      - the note reads `week ≈ 3.7 days at 20% · on plan · resets Tue 13:00` with class `budget-note`.
    - `over today's target turns the tile amber`: `dayBurnPct 24.5` gives `-4.5%`, `#f59e0b` and a bar width of `0%`.
    - `well over turns it red`: `dayBurnPct 30` gives `-10.0%`, `#f87171` and background `linear-gradient(90deg,#7f1d1d,#f87171)`.
    - `behind plan turns the week line red`: `weeklyRemainingPct 50` and `dayBurnPct 0` at `ms(4,22)` give the note `week ≈ 2.5 days at 20% · behind plan by 0.5 days · resets Tue 13:00` with class `budget-note wayover`.
    - `a used-up week says so first, in red`: `weeklyRemainingPct 0` and `dayBurnPct 5` at `ms(9,23)` give the note `week used up · resets Tue 13:00` with class `wayover`, and a tile of `0.0%` in `#f87171`.
    - `a card with a 5h window keeps its 5H tile`: `noFiveHourWindow` is empty and `codex-5h-pct` is pre-set to `55%`. Afterwards it still reads `55%`, the labels read `5H Remaining` and `5H`, and the note is still painted.
    - `no budget figures yet` (**no budget figures yet**): `budgetInfo` is `{}`. The tile reads `—` with color `''`, the bar has width `0%` and background `var(--border)`, the note is `''`, and nothing throws.
    - `target 25` (**target 25**): with `budgetTargets.day 25` and `dayBurnPct 5`, the tile reads `20.0%`, the line under it reads `of 25% · resets at midnight`, the bar is `80%`, and the note reads `week ≈ 3.0 days at 25% · on plan · resets Tue 13:00`.
    - `stale reset` (**stale reset**): `weeklyRemainingPct 0` and `dayBurnPct 3` at `ms(10,14)` give a tile of `17.0%` in `#34d399` and a note of `''`.
    - `fmtWeekReset`: `fmtWeekReset(ms(10,13)) === 'Tue 13:00'` and `fmtWeekReset(null) === ''`.
  - In `test/account-render.test.js`:
    - change the stubs to `renderStat: (prefix, win, pct, placeholder) => { stats.push([prefix, win]); … }` (keep the text write) and `renderBudget: (id) => budgets.push([id, el(id + '-5h-reset').textContent])`;
    - update `each collaborator receives the field it is meant to` to `c.budgets` deep-equal `[['codex', 'in:1000']]`, with the message `'the budget repaints after the reset lines are set'`;
    - update `a stale render neither relabels nor re-caches, but still repaints` to `[['codex', 'in:1000']]`;
    - replace `a window the plan lacks reads n/a and blanks its reset line` with `a weekly-only reading leaves the left tile to the budget`. For a reading with `pct5h: null, has5h: false`, `stats` holds no `['codex', '5h']` but holds `['codex', 'wk']`, and `c.budgets` deep-equals `[['codex', '']]`.
- [ ] **Step 2: Run `node --test test/budget-render.test.js test/account-render.test.js test/codex-render.test.js`.** Expected: FAIL, because the BUDGET markers are not found and the account-render assertions fail.
- [ ] **Step 3: Implement** the `renderer.js` and `index.html` changes listed under **Files**. `refreshBudget` keeps its schedule: it is called from the poll tick, at startup and on `settings-changed`.
- [ ] **Step 4: Run `npm test`, then `node --check renderer.js`.** Expected: PASS. Run `grep -n "budget-marker\|5h-budget\|lastPct5h\|fiveHourAllowancePct\|plan has no 5h window" renderer.js index.html`. Expected: no output.
- [ ] **Step 5: Commit** with the subject `feat(cards): a Today tile and a plan-rule week line replace the 5h budget`.

---

### Task 5: The analytics budget and runway cards

**Files:**
- Modify `analytics-renderer.js`:
  - `renderStats` (about lines 310–412). Its signature becomes `renderStats(entries, container, settings = {}, budget = {}, nowMs = Date.now())`.
  - Delete `runwayCls`, `budgetWindowTarget`, `budgetRatio`, `budgetLevel`, `windowBudgetCard`, and the ratio and tier-change text.
- Test: `test/analytics-renderer.test.js`. Replace the six tests from `renderStats shows Window Budget and Today Budget cards from the budget ratio` through `renderStats Window Budget omits the scope when no tier change is declared`.

**Interfaces:**
- Consumes `dayBudgetVerdict`, `weekLine` and `DEFAULT_DAY_TARGET`. These are globals here, and the test harness spreads `metrics` into its context. It also consumes `budget`, which is `get-budget-info`'s value for the current account (Task 3), and the existing `fmtRunwayDate`.
- Produces three things:
  - **Today's Budget card.** Value `todayRemainingPct.toFixed(1) + '%'` with sub `of ${target}% · resets at midnight` and class `['green', 'amber', 'red'][todayLevel]`. With no figure, value `—`, sub `waiting for budget data` and class `dim`.
  - **Week Budget card.** Value `line.head` and sub `line.tail`. The class is `red` for a red tone and `''` for muted. With `line` `null`, value `—`, sub `waiting for a weekly reading` and class `dim`.
  - **Plan class.** `onPlan` → `green`, `behind` or `usedUp` → `red`, `unknown` → `dim`. It applies to Weekly Runway, Reset Gap, Plan Fit and At Reset in both branches. Their values and subs are unchanged.
- Here `target = settings.budgetTargets.day > 0 ? … : DEFAULT_DAY_TARGET` and the reset label is `Number.isFinite(budget.weeklyResetTs) ? fmtRunwayDate(budget.weeklyResetTs) : ''`. The two budget cards replace `windowBudgetCard` and `dayBudgetCard` at the same place: Week Budget first, then Today's Budget.

- [ ] **Step 1: Write the failing tests.**
  - Shared fixture: `B = { dayBurnPct: 1, weeklyRemainingPct: 74, weeklyResetTs: ms(10,13), cycleStartTs: ms(3,13) }`, `NOW = ms(4,10)`, and the two-row `entries` from the replaced tests, with `'5h': null`.
  - Assert a card's class with `assert.match(html, /stat-card green">\s*<div class="label">Today.s Budget/)` (and so on for each card and class).
  - Tests:
    - `renderStats Today's Budget shows the tile's figure for a weekly-only account`: `19.0%`, `of 20% · resets at midnight`, class `green`, and no `need more history`.
    - `renderStats Week Budget matches the card's week line`: `≈ 3.7 days at 20%`, the sub `'on plan · resets ' + fmtRunwayDate(B.weeklyResetTs)` (take `fmtRunwayDate` from the loaded context, as it formats in the machine's locale), class `''` (`stat-card ">`), and no `Window Budget`.
    - `renderStats behind plan turns Week Budget and the four runway cards red`: `weeklyRemainingPct 50`, `dayBurnPct 0`, now `ms(4,22)`. Expect `behind plan by 0.5 days`, and `stat-card red` on Week Budget, Weekly Runway, Reset Gap, Plan Fit and At Reset.
    - `renderStats an on-plan week keeps the runway cards green even when the pace runs out early`: use the rows of the existing `"won't fit"` runaway-pace test with `B`. All four runway cards are `green` (anti-goal 1).
    - `renderStats a used-up week reads used up and turns the runway cards red`: `weeklyRemainingPct 0` at `ms(9,23)` gives Week Budget value `used up` and all four runway cards `red`.
    - `renderStats with no budget figures leaves the budget and runway cards dim`: `budget = {}` gives `waiting for budget data`, `waiting for a weekly reading`, and `dim` on all six.
    - `renderStats target 25` (**target 25**): with `settings.budgetTargets.day 25` and `dayBurnPct 5`, expect `20.0%`, `of 25% · resets at midnight` and `≈ 3.0 days at 25%`.
  - Pass `NOW` as the fifth argument in every test.
- [ ] **Step 2: Run `node --test test/analytics-renderer.test.js`.** Expected: the new tests fail. The other tests still pass.
- [ ] **Step 3: Implement** the `renderStats` changes. `renderAll` needs no change; it already passes `_budget`, and `nowMs` defaults to `Date.now()`.
- [ ] **Step 4: Run `npm test` and `node --check analytics-renderer.js`.** Expected: PASS.
- [ ] **Step 5: Commit** with the subject `feat(analytics): budget and runway cards follow the plan rule`.

---

### Task 6: Settings keeps only the daily target

**Files:**
- Modify `settings.html`:
  - delete the `budget-window` row (about line 92);
  - delete the `input[type="date"].tier-date` rule and its comment (about lines 24–27);
  - delete the `.mini-btn` rules (about lines 30–35), which have no other user;
  - Accounts note (about line 87): drop the sentence about the date, so it reads `Plan price (USD/mo) drives cost estimates. Multiplier drives the Analytics <b>Plan Fit</b> card (your plan's capacity relative to base, 1×). Label override replaces the auto-detected account name everywhere in the app.`;
  - Weekly budget note (about line 94) becomes `How much of the <b>weekly</b> quota you intend to spend per day. Drives the Today tile and week line on each card and the Analytics budget cards. The default of 20% gives a five-day week.`.
- Modify `settings-renderer.js`:
  - the row template (about lines 93–96): remove the date input and the Today button;
  - the two id assignments (about lines 106–107);
  - the two listeners in `wireAccountRowListeners` (about lines 154–158);
  - the `tierChangedAt` load (about lines 179–180);
  - delete `saveTierDates`, its comment and `todayLocalISO` (about lines 206–229);
  - `BUDGET_DEFAULTS` becomes `{ day: 20 }`;
  - the `budget-window` load line;
  - `saveBudgetTargets`;
  - the listener list, which becomes `['budget-day']`;
  - the header comment's `tier-date / tier-today` mention (about line 4).
- Test: `test/settings-renderer.test.js`.

**Interfaces:**
- Produces: `saveBudgetTargets()` saves `{ budgetTargets: { ...lastSettings.budgetTargets, day } }`. Here `day` is the parsed input when it is finite and above 0, otherwise `BUDGET_DEFAULTS.day`. The function then sets `lastSettings.budgetTargets` to the saved object, so a stored `window` survives every save.

- [ ] **Step 1: Write the failing tests.**
  - Slice `settings-renderer.js` from `function saveBudgetTargets` to `function saveOverrides`. The context holds:
    - `document.getElementById: () => ({ value })`;
    - `lastSettings`;
    - `BUDGET_DEFAULTS: { day: 20 }`;
    - `window.electronAPI.saveSettings` as a spy;
    - `parseFloat` and `isFinite`.
  - Tests:
    - `saving the daily target keeps the stored 5h-window value`. With `lastSettings = { budgetTargets: { window: 12, day: 20 } }` and value `'25'`, the save deep-equals `{ budgetTargets: { window: 12, day: 25 } }` and `lastSettings.budgetTargets.day === 25`.
    - `an unusable daily target saves the default`. Value `'abc'` gives `{ budgetTargets: { window: 12, day: 20 } }`.
    - `a first save with nothing stored writes only the day`. With `lastSettings = {}` and value `'20'`, the save is `{ budgetTargets: { day: 20 } }`.
    - `Settings no longer offers the 5h-window target or the tier-change date`. The text of `settings.html` and `settings-renderer.js` does not match `/budget-window|tier-date|tier-today|saveTierDates/`.
- [ ] **Step 2: Run `node --test test/settings-renderer.test.js`.** Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed under **Files**.
- [ ] **Step 4: Run `npm test` and `node --check settings-renderer.js`.** Expected: PASS.
- [ ] **Step 5: Commit** with the subject `feat(settings): keep only the daily target; leave stored values alone`.

---

### Task 7: Remove the 5h-ratio engine

**Files:**
- Modify `metrics.js`. Delete:
  - `MIN_RATIO_EVIDENCE_PCT` and its comment;
  - `weeklyPerFiveHourRatio` and its comment;
  - `fiveHourAllowancePct` and its comment;
  - `weeklyBurnSince`;
  - the four names from `module.exports`.
  - Keep `dropSpikes`. Its comment block, which sits above `weeklyBurnSince`, stays with `dropSpikes`.
- Modify `test/metrics.test.js`:
  - remove the four names from the line-4 import, and the `const { weeklyPerFiveHourRatio: ratio }` alias;
  - remove every test whose name starts with `weeklyPerFiveHourRatio:`, `fiveHourAllowancePct:` or `weeklyBurnSince:`, and any comment lines that only introduce them;
  - keep the `hourlyBurn` and `monthBurnGrid` bad-reading tests. Task 1's `dayBurnSince` tests carry the cases the removed `weeklyBurnSince` tests pinned.

- [ ] **Step 1: Confirm nothing calls them.** Run `grep -rn "weeklyPerFiveHourRatio\|fiveHourAllowancePct\|MIN_RATIO_EVIDENCE_PCT\|weeklyBurnSince" --include=*.js --include=*.html . | grep -v node_modules`. Expected: hits only in `metrics.js`, `test/metrics.test.js`, and the historical comment in `scripts/migrate-codex-weekly.js`, which stays as written.
- [ ] **Step 2: Delete them**, as listed under **Files**.
- [ ] **Step 3: Run `npm test` and `node --check metrics.js`.** Expected: PASS. Repeat the Step 1 grep. Expected: only the `scripts/migrate-codex-weekly.js` comment.
- [ ] **Step 4: Commit** with the subject `refactor(metrics): remove the 5h-ratio budget engine`.

---

## After the last task

1. Run the integration gate in CLAUDE.md §6, using `npm ci && npm test` in a detached worktree. Then merge with `--no-ff` and push once.
2. Restart the app with the PowerShell restart recipe.
3. Wait for a poll and a budget refresh, about two minutes. Then check through the real read path. The tile figures must equal what `dayBudgetInfo` and `dayBudgetVerdict` give for today on the live log, which a read-only script can compute. Each card's week line must read "on plan" while the week is on plan.
4. The look on screen is the user's call.
5. Add one plain line to today's daily log and one entry to `.ai/integration-log.md` if the project has one.
