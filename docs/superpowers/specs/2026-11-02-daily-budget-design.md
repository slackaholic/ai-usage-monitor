# Daily budget replaces the 5-hour budget — Design

**Date:** 2 Nov 2026
**Status:** For approval. The user has answered every open question.
**Component:** AI Usage Monitor: `renderer.js` (`renderStat`, `renderBudget`,
`refreshBudget`, `renderAccountData`), `index.html` (the cards, the Claude
Code card template, the compact grid), `main.js` (`get-budget-info`),
`metrics.js` (`weeklyBurnSince`, `weeklyRunway`, `weeklyPerFiveHourRatio`,
`fiveHourAllowancePct`), `analytics-renderer.js` (the budget cards),
`settings.html` and `settings-renderer.js` (budget targets, tier-change dates).

## Why

No account the monitor watches has a 5-hour limit any more:
- **Codex** lost its 5-hour window on 11 Jul 2026.
- **Claude** (Desktop and Claude Code) lost it on 31 Oct 2026, when
  Anthropic removed it from the Ultra plan.

Every card now shows **5H n/a**. The budget built around that window is dead:
- the 5h÷weekly ratio can no longer be measured;
- the marker on the 5-hour bar has nothing to mark;
- the note reads "plan has no 5h window — weekly only" on all three cards.

The user's own pacing rule still stands: **spend at most 20% of the weekly
limit per day, so the week lasts a five-day working week.** Today the app
hides that figure. The card note drops it, and the analytics page shows
"need more history" for Today's Budget on every account.

What the user wants from a glance at a card: **"do I still have enough for
the day, and for the week?"**

## Decisions the user made

1. **The daily target stays at 20% of the weekly limit.**
2. **Every calendar day counts, weekends included.** Weekend work happens
   and uses the weekly limit like any other day. There is no weekday logic
   anywhere. The weekly reset can move, because OpenAI and Anthropic grant
   early resets, so nothing may assume the week ends on a given weekday.
3. **The empty 5H tile becomes a "Today remaining" tile.** (Mockup option B.)
4. **The tile shows what is left, not what has been used**, so it matches
   the other tiles.
5. **The tile's unit is weekly points.** "19.0%" means 19 points of the
   weekly limit are left to spend today, out of 20. It is *not* a share of
   today (it would not read "95%").
6. **The week warning follows a plan rule, not a pace rule.** It warns
   only when the user has spent faster than five days of 20% a week allows.
   - Two days off are allowed somewhere in the cycle, any two.
   - It stays quiet in an on-plan week.
   - This replaces an earlier "would run out before the reset at this
     cycle's pace" rule. That rule went red in every on-plan week: after
     exactly 20% on the first day it read "runs out Sun 13:00", because an
     idle weekend only slows the pace after it has happened.
7. **If a provider brings back a 5-hour limit, that card shows the 5H tile
   again.** (Stated in option B, which the user picked.)
8. **The analytics runway cards take their colours from the same plan
   rule.** Weekly Runway, Reset Gap, Plan Fit and At Reset keep their
   numbers, so no screen goes red in an on-plan week.

## Goals

- At a glance, every card answers "enough for today?" and "enough for the
  week?".
- One rule for every account, including Codex, Claude Desktop, and each
  Claude Code account, with no per-provider branches.
- Nothing depends on which weekday the reset falls on.

## Non-goals

- Rebuilding a 5-hour budget if a provider brings the 5-hour limit back.
  The 5H tile returns (decision 7); the old ratio budget does not.
- Changing the weekly tile, the weekly bar, or how weekly figures are
  polled or logged.
- Removing past 5-hour history from the analytics charts. It stays as
  history.
- Carrying unused allowance over from one day to the next. The daily target
  is a flat 20%.

## Anti-goals

These would make it a failure even if it technically works:

- **A card that is amber or red during a normal on-plan week.** A warning
  that is always on gets ignored.
- **A Today figure that under-counts** because the app was closed or the
  laptop was asleep while work ran in the background. Background work is
  the reason Anthropic gave for removing the 5-hour limit.
- **Weekday logic** of any kind.

## The design

### Today remaining tile (cards and compact view)

Where a reading has `has5h === false`, the left tile shows today's budget
instead of `5H n/a`:

| Part | Content |
| --- | --- |
| Label | `Today Remaining` |
| Value | `min(dayTarget − todayBurn, weeklyRemaining)`, one decimal, `%`. Example: `19.0%`. Below zero it goes negative (`-4.5%`), as over-quota readings already do. The cap keeps a nearly spent week from reading a healthy "20.0%" at midnight. |
| Line under the value | `of 20% · resets at midnight`, using the configured target |
| Bar (the existing 5h bar) | Width = `remaining ÷ dayTarget × 100`, clamped to 0–100 |
| Colour, value and bar | Green while today's use is within the target. Amber once it is over the target. Red from 1.5× the target (30% with the default). These are the thresholds the old budget note used. |

- The compact view's 5h slot shows the same value.
- A reading with `has5h === true` renders exactly as today, with no Today
  tile.
- **Day boundary:** local midnight. The machine runs on UK time.

### The week line (the budget note under the bars)

The days figure is weekly remaining ÷ day target, one decimal, floored at 0.

| State | Line | Colour |
| --- | --- | --- |
| On plan | `week ≈ 3.7 days at 20% · on plan · resets Tue 13:00` | muted, as the note is today |
| Behind plan | `week ≈ 2.5 days at 20% · behind plan by 0.5 days · resets Tue 13:00` | red |
| Week used up (weekly remaining ≤ 0) | `week used up · resets Tue 13:00` | red |
| No weekly reading, or no reset time | `week ≈ 3.7 days at 20%`, with nothing after it | muted |

- The reset is shown as a weekday and time, UK time.
- "Week used up" is checked first and wins over the other states.
- "Week used up" is red even at the end of an on-plan week. It is a hard
  stop, not a warning, so it does not count against anti-goal 1.

### The plan rule (decision 6)

The cycle is **on plan** while:

```
used this cycle  ≤  dayTarget × days so far      (the right side capped at 100)
```

- **Used this cycle** = 100 − weekly remaining. It comes straight from the
  latest reading, with no burn counting.
- **Days so far** = the number of calendar days, local time, from the
  cycle's start up to and including today. A cycle starting Tue 13:00
  counts Tuesday as day 1, Wednesday as day 2, and so on.
- **The cycle's start** is the latest of:
  - the logged reset time minus 7 days;
  - the most recent reset detected in the log.

  The second catches early resets that refill the quota without moving the
  reset time.
- **Behind plan by** = (used − allowance) ÷ dayTarget, in days, one decimal.

Why this reads as "five days of 20%, two days off anywhere":
- Every calendar day, weekends included, adds one day's allowance. That
  holds until the allowance reaches the whole week (100% at 20%).
- A user who works any five days at 20% is never behind.
- Overspending on any day puts the cycle behind until enough later days
  make it up.
- There is no weekday logic, and a moved reset needs no special case.

Checks the builder must pin in tests (reset Tue 13:00, target 20):

| Pattern | Expected |
| --- | --- |
| 20% on each of Tue, Wed, Thu, Fri, Mon, nothing at the weekend | on plan throughout; "week used up" from Mon evening to the reset |
| 20% every day including the weekend | on plan; used up after the fifth day |
| 30% on Wed after 20% on Tue | behind plan by 0.5 days on Wed; back on plan on Thu if Thu's use stays at or under 10% |
| 15% by Tue 17:00, the first afternoon | on plan |
| An early reset that refills to 100% without moving the reset time | days so far restart from the refill |

### Analytics page

- **"Today's Budget"** shows the same figure as the tile: remaining, in
  weekly points, against the target.
  - It no longer depends on a 5-hour reading or the ratio.
  - It stops reading "need more history" for weekly-only accounts.
- **"Window Budget"** is replaced by **"Week Budget"**: `≈ 3.7 days at 20%`
  with the card's week-line verdict beneath it, coloured as on the card.
  - It uses the same `get-budget-info` figures as the card, never the
    page's filtered rows, so the two always agree.
- **Weekly Runway, Reset Gap, Plan Fit and At Reset** (decision 8):
  - They keep their numbers. Their pace projection still comes from the
    page's filtered rows.
  - Their colour comes from the plan rule: green when on plan, red when
    behind plan or the week is used up, dim when there is no weekly reading.
  - This replaces `runwayCls` and any other projection-based colour on
    those four cards ([analytics-renderer.js:327-330](../../../analytics-renderer.js#L327-L330)).
  - The plan verdict comes from `get-budget-info`, so these cards cannot
    disagree with the main window.

### Settings

- The **Per 5h window** budget target (`budgetTargets.window`) is removed
  from the screen.
- The **Per day** target stays, with a default of 20.
- The stored value of `budgetTargets.window` is left in `settings.json`
  untouched. It is no longer read.

### Removed

- The 5h÷weekly ratio from `get-budget-info`, along with
  `weeklyPerFiveHourRatio` and `fiveHourAllowancePct` once nothing calls
  them.
- The budget marker on the 5-hour bar (`*-5h-budget` elements, and the
  `.budget-marker` CSS when nothing uses it).
- The note "budget: plan has no 5h window — weekly only".
- The `noFiveHourWindow` set, if the new rendering no longer needs it.
- `lastPct5h`, if the new rendering no longer needs it.
- The ratio's notes "need more history since tier change" and "ratio since …".

### Data

`get-budget-info` returns, per log account:

```js
{
  dayBurnPct,          // weekly points used since local midnight (rules below)
  weeklyRemainingPct,  // latest reading
  weeklyResetTs,       // latest logged reset7dTs
  cycleStartTs,        // see "The plan rule"
}
```

The renderer works out the plan verdict from these four, plus the target
and the current time, through one pure function that the main window and
the analytics page share.

The renderer's `refreshBudget` keeps its current schedule. It is called after
polls and on settings changes. It repaints each account's tile and line.

**Counting today's use** (`dayBurnPct`) is a change from today's
`weeklyBurnSince`:
- Count **every fall** in the weekly figure between successive polls since
  local midnight, **including falls across a gap in polling**. Today's
  function skips any interval longer than 15 minutes, so work done while the
  app was closed or asleep vanishes from the day. That is the second
  anti-goal.
- **An interval that straddles midnight is split by time** either side of
  it. Example: a fall of 10 points between a 22:00 poll and an 08:00 poll
  counts 8 points against today. Charging it all to the later day would
  start every morning after an overnight sleep, or every Monday after a
  closed weekend, in the red.
- **The day keeps counting across a weekly reset.** The target is per
  calendar day, so on a reset day the use before and after the reset both
  count.
- **Resets and bad readings.** Required behaviour:
  - A real reset is not use.
  - Use after a reset still counts, even when the reset fell inside a
    polling gap. Measure it from 100% after the reset.
  - A bad reading (a poll that misread a figure) never adds use. That
    includes a bad high reading that happens to be the last poll before a
    gap. The log has a 68 → 100 → 68 case, and counting gaps would turn its
    fall into 32 points of false use.
- Telling resets from bad readings:
  - The tools to hand are `dropSpikes`, `isBoundary` (metrics.js), and the
    logged `reset7dTs`.
  - Codex early resets show up as a quota refill, not reliably as a moved
    reset time. OpenAI grants these, and the log has short Codex cycles
    because of them.
  - The mechanism is left to the builder, pinned by tests built from those
    real log shapes.

## Left to the builder

- How the tile switches label and content.
  - The `5h` element ids may be reused, or the tile given its own; whichever
    keeps `renderStat` and the compact view simple.
  - Must hold: one render path for every provider.
- The exact helper names and file placement.
  - The day count may live in metrics.js as a new function, or as a changed
    `weeklyBurnSince`.
  - Must hold: metrics.js never reads the clock; the caller passes local
    midnight.
- The startup paint, before the first `get-budget-info` answer: show `—` in
  the tile, never a stale guess.
- Tests: node `--test`, following the existing slice-and-vm harnesses.
  Cover at least:
  - the tile in normal, over and well-over states;
  - a reading with a 5h window still showing the 5H tile;
  - falls across a polling gap counted;
  - rises not counted;
  - midnight;
  - the week line in each of its states;
  - every row of the plan-rule table;
  - the analytics cards and their colours.

## Calls made by the designer (not the user)

- Tile colour thresholds: the old budget note's levels (over → amber,
  ≥1.5× → red), as played back to the user.
- The compact view follows the card.
- The analytics cards are renamed and reworked as above.
- The 5h-window budget target is removed from Settings and its stored value
  left alone.
- The tier-change dates (`tierChangedAt`) only ever scoped the ratio. With
  the ratio gone they have no use; their per-account inputs come off the
  Settings screen, and the stored values are left alone.
- Today's use counts falls across polling gaps (the change to
  `weeklyBurnSince` described above).
- An interval across midnight is split by time; the day keeps counting
  across a weekly reset.
- The Today tile is capped at the weekly remaining, and a spent week reads
  "week used up · resets …" in red, ahead of any other state.
- The Week Budget card uses the card's figures, so the two cannot disagree.
- How the plan rule is worked out: used this cycle ≤ target × calendar days
  so far, capped at the whole week. This is how "five days of 20%, two days
  off anywhere" is computed without weekday logic. The user chose the plan
  rule; this formula is the designer's.
- The week line's wording: "on plan", "behind plan by N days" and
  "week used up", each followed by the reset time. The line no longer
  claims "lasts to reset".
- Saving the daily target must not drop the stored
  `budgetTargets.window`: `saveBudgetTargets` currently rewrites the whole
  object.
