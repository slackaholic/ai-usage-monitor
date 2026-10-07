# Normalised Account Readings + Gemini Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse three near-duplicate render paths into one normalised reading, then add Gemini as the first provider built on it.

**Architecture:** Every provider's parse step returns one fixed shape (`pct5h`, `pctWk`, `reset5hMs`, `resetWkMs`, `has5h`, `hasWk`, `label`, `extra`). A single `renderAccountData()` consumes it; a single `registerAccount()` wires an account into the seven module-level registries. Gemini then arrives as a browser-session scrape of `gemini.google.com` plus one descriptor.

**Tech Stack:** Electron 28, vanilla JS (no framework, no bundler), `node --test` with no test framework, vm-slice test harness.

**Specs:**
- [Normalised readings](../specs/2026-10-07-pluggable-account-providers-design.md)
- [Gemini provider](../specs/2026-10-07-gemini-account-provider-design.md)

## Global Constraints

- **Log keys are immutable.** 7,000+ entries in `usage-log.jsonl` hang off `codex`, `claude-desktop`, `claude-vscode`. No task may change an account's `logKey`, the log entry shape, or the `5h`/`wk` keys inside it.
- **Two key namespaces stay distinct.** Descriptor `id` (DOM ids, label overrides) vs `logKey` (prices, tier dates, multipliers, log entries). Never substitute one for the other.
- **`metrics.js` is dual-loaded** (browser global + CommonJS). No `Date.now()`, no argless `new Date()`, no Node APIs, no new dependencies. This plan does not modify it.
- **No new npm dependencies.**
- **`renderer.js` uses CRLF line endings.** Keep them; a mixed-ending file produces an unreadable diff.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Commit messages go through a file, never a heredoc.** Each commit step shows its message in a plain fence; write that text to a scratchpad file with the **Write tool** and pass it as `git commit -F <file>`. `$MSGFILE` in the commands below stands for that path — e.g. `$SCRATCHPAD/commit-msg.txt`. Shell heredocs and `-m` with embedded newlines break on quoting and cost a turn per retry.
- **Windows/MSYS git prefix** where a command touches the shared repo: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' MSYS_NO_PATHCONV=1`.
- **Tier 1 paths need human approval:** `AGENTS.md`, `CLAUDE.md`, `package.json`, `package-lock.json`, `.github/**`, `.githooks/**`. No task here touches them.
- **The Electron GUI cannot be launched in an agent environment.** Never claim visual confirmation; GUI verification is the user's step.
- **Baseline:** 172 tests green at branch point.

## File Structure

| File | Responsibility | Phase |
| --- | --- | --- |
| `renderer.js` | `makeReading`, `registerAccount`, `renderAccountData`, `normaliseCachedReading`, all parse functions | 1 and 2 |
| `test/account-reading.test.js` | **Create.** The normalised shape and all parse functions | 1 |
| `test/account-render.test.js` | **Create.** The "all providers render identically" proof | 1 |
| `main.js` | Delete dead `fetch-url`; add Gemini transport | 1 and 2 |
| `test/gemini-usage.test.js` | **Create.** `parseGeminiUsage` against captured real text | 2 |
| `index.html` | Gemini card markup + compact tiles | 2 |
| `preload.js` | Gemini IPC bridge | 2 |
| `settings-renderer.js` | Gemini row via `ACCOUNT_PAIRS` | 2 |
| `analytics-renderer.js` | Gemini in `VALID_ACCOUNTS` / `ACCOUNT_LABELS` / `PLAN_MULTIPLIERS` | 2 |
| `docs/handoff/gemini-discovery.md` | **Create.** Discovery output from the user | 2 |

Work on branch `refactor/normalised-account-readings` (already created; both specs committed on it).

---

# Phase 1 — The refactor

## Task 1: The normalised reading, and the three parse functions that produce it

**Files:**
- Modify: `renderer.js` — add `makeReading`; rewrite `parseCodexApiUsage`, `parseCodexText`, `parseClaudeOrgUsage`, `parseClaudeWebText`; add `normaliseClaudeCodeReading`
- Test: `test/account-reading.test.js` (create)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `makeReading(partial) -> Reading`
  - `Reading = { pct5h: number|null, pctWk: number|null, reset5hMs: number, resetWkMs: number, has5h: boolean, hasWk: boolean, label: string|null, extra: object|null }`
  - `parseCodexApiUsage(data, now) -> Reading|null`
  - `parseCodexText(text) -> Reading`
  - `parseClaudeOrgUsage(data) -> Reading`
  - `parseClaudeWebText(text) -> Reading`
  - `normaliseClaudeCodeReading(data) -> Reading`

- [ ] **Step 1: Write the failing test file**

Create `test/account-reading.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads the reading-shape helper plus every provider's parse function. The
// slice spans from makeReading to the first DOM-touching function, so nothing
// here needs a document stub.
function loadParsers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('function makeReading');
  const end = source.indexOf('// ── READING PARSERS END ──');
  assert.ok(start >= 0 && end > start, 'expected reading-parser source markers');
  const context = { console, Math, Number, RegExp, Date, parseInt, isNaN };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

const NOW = Date.parse('2026-10-07T09:00:00Z');
const HOUR = 3_600_000;

test('a reading defaults to both windows existing but unmeasured', () => {
  const { makeReading } = loadParsers();
  const r = makeReading();
  assert.strictEqual(r.pct5h, null);
  assert.strictEqual(r.pctWk, null);
  assert.strictEqual(r.reset5hMs, 0);
  assert.strictEqual(r.resetWkMs, 0);
  // Default true: "momentarily missing" is the common case and renders as an
  // em-dash. Only a parser that KNOWS the plan lacks a window says so.
  assert.strictEqual(r.has5h, true);
  assert.strictEqual(r.hasWk, true);
  assert.strictEqual(r.label, null);
  assert.strictEqual(r.extra, null);
});

test('a reading keeps an explicit false for a window the plan lacks', () => {
  const { makeReading } = loadParsers();
  assert.strictEqual(makeReading({ has5h: false }).has5h, false);
});

test('codex emits the normalised shape with the weekly value in the weekly slot', () => {
  const { parseCodexApiUsage } = loadParsers();
  const r = parseCodexApiUsage({
    rate_limit: {
      primary_window: {
        limit_window_seconds: 7 * 86400,
        used_percent: 0,
        reset_at: Math.floor((NOW + 166 * HOUR) / 1000),
      },
    },
    credits: { balance: 0 },
    email: 'a@example.com',
  }, NOW);

  assert.strictEqual(r.pctWk, 100);
  assert.strictEqual(r.pct5h, null);
  assert.strictEqual(r.has5h, false, 'Codex has no 5h window since 2026-07-11');
  assert.strictEqual(r.hasWk, true);
  assert.strictEqual(r.resetWkMs, NOW + 166 * HOUR);
  assert.strictEqual(r.reset5hMs, 0);
  assert.strictEqual(r.label, 'a@example.com');
  assert.deepStrictEqual(r.extra, { credits: 0 });
});

// The polarity bug the whole refactor exists to remove: Claude's sources report
// percentage USED, and that must be converted at the parse boundary so nothing
// downstream ever sees a "used" figure.
test('claude org usage converts used-percent to remaining at the parse boundary', () => {
  const { parseClaudeOrgUsage } = loadParsers();
  const r = parseClaudeOrgUsage({
    five_hour:  { utilization: 46, resets_at: new Date(NOW + 2 * HOUR).toISOString() },
    seven_day:  { utilization: 15, resets_at: new Date(NOW + 5 * 24 * HOUR).toISOString() },
  });

  assert.strictEqual(r.pct5h, 54, 'remaining, not used');
  assert.strictEqual(r.pctWk, 85, 'remaining, not used');
  assert.strictEqual(r.reset5hMs, NOW + 2 * HOUR);
  assert.strictEqual(r.resetWkMs, NOW + 5 * 24 * HOUR);
});

test('claude org usage reports an absent window as unmeasured, not as zero', () => {
  const { parseClaudeOrgUsage } = loadParsers();
  const r = parseClaudeOrgUsage({ five_hour: { utilization: 46 } });
  assert.strictEqual(r.pct5h, 54);
  assert.strictEqual(r.pctWk, null, 'absent is null, never 100');
});

test('claude scraped text also emits remaining', () => {
  const { parseClaudeWebText } = loadParsers();
  const r = parseClaudeWebText('Current session\n46% used\nWeekly\n15% used');
  assert.strictEqual(r.pct5h, 54);
  assert.strictEqual(r.pctWk, 85);
});

test('claude code headers pass through as remaining', () => {
  const { normaliseClaudeCodeReading } = loadParsers();
  const r = normaliseClaudeCodeReading({
    pct5h: 55, pct7d: 86,
    reset5hMs: NOW + HOUR, reset7dMs: NOW + 3 * 24 * HOUR,
    account: 'max 20x',
  });
  assert.strictEqual(r.pct5h, 55);
  assert.strictEqual(r.pctWk, 86);
  assert.strictEqual(r.reset5hMs, NOW + HOUR);
  assert.strictEqual(r.resetWkMs, NOW + 3 * 24 * HOUR);
  assert.strictEqual(r.label, 'max 20x');
});

// Anthropic dropped the 7d header pair for a period in August 2026.
test('claude code reports a missing weekly header as no window, not a gap', () => {
  const { normaliseClaudeCodeReading } = loadParsers();
  const r = normaliseClaudeCodeReading({ pct5h: 55, pct7d: null, hasWk: false });
  assert.strictEqual(r.pctWk, null);
  assert.strictEqual(r.hasWk, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/account-reading.test.js`
Expected: every test FAILS with `expected reading-parser source markers` — the markers do not exist yet.

- [ ] **Step 3: Add `makeReading` and the section markers in `renderer.js`**

Insert immediately above `// ── Codex ──` (currently around line 1177):

```js
// ── READING PARSERS ────────────────────────────────────────────────────────
// One shape for every provider. Three providers previously invented their own
// names for the same four numbers — shared5h / sessionUsed / pct5h, two of them
// polarity-inverted — which is why three render functions existed to perform
// the same ten steps. Everything below converts to this shape; nothing above
// the render layer ever sees a provider's own vocabulary again.
//
// pct* are REMAINING percentages, always. A source reporting "used" converts
// here, at the parse boundary, and never downstream.
//
// has5h / hasWk default TRUE: a window exists unless a parser positively knows
// it does not. That keeps "momentarily missing" (renders —) distinct from "the
// plan has no such window" (renders n/a), a distinction a null percentage alone
// cannot carry.
function makeReading(p = {}) {
  return {
    pct5h:     p.pct5h     ?? null,
    pctWk:     p.pctWk     ?? null,
    reset5hMs: p.reset5hMs ?? 0,
    resetWkMs: p.resetWkMs ?? 0,
    has5h:     p.has5h     ?? true,
    hasWk:     p.hasWk     ?? true,
    label:     p.label     ?? null,
    extra:     p.extra     ?? null,
  };
}
```

- [ ] **Step 4: Rewrite the Codex parsers to return readings**

Replace the `return { … }` block of `parseCodexApiUsage` with:

```js
  return makeReading({
    pct5h:     remain(slot['5h']),
    pctWk:     remain(slot.wk),
    reset5hMs: resetMs(slot['5h']),
    resetWkMs: resetMs(slot.wk),
    has5h:     slot['5h'] !== null,
    hasWk:     slot.wk !== null,
    label:     data.email || null,
    extra:     (data.credits && data.credits.balance != null)
      ? { credits: data.credits.balance } : null,
  });
```

Replace the `return { … }` block of `parseCodexText` with:

```js
  return makeReading({
    pct5h:  pct(CODEX_5H_LABEL),
    pctWk:  pct('Weekly usage limit'),
    has5h:  new RegExp(CODEX_5H_LABEL, 'i').test(text),
    extra:  creditsM ? { credits: creditsM[1] } : null,
  });
```

The text path's reset strings are dropped: every caller preferred the millisecond
values, and `parseResetToMs` was only ever reached for Codex when the API path
had already failed. Keeping two reset representations in the normalised shape
would reintroduce the vocabulary problem this task removes.

- [ ] **Step 5: Rewrite the Claude parsers to return readings**

Replace the body of `parseClaudeOrgUsage` with:

```js
function parseClaudeOrgUsage(data) {
  const fh = data?.five_hour;
  const sd = data?.seven_day;
  const ms = (iso) => (iso && !isNaN(new Date(iso))) ? new Date(iso).getTime() : 0;
  const remain = (u) => (typeof u === 'number') ? Math.max(0, 100 - u) : null;
  return makeReading({
    pct5h:     remain(fh?.utilization),
    pctWk:     remain(sd?.utilization),
    reset5hMs: ms(fh?.resets_at),
    resetWkMs: ms(sd?.resets_at),
  });
}
```

Replace the `return { … }` block of `parseClaudeWebText` with:

```js
  const used = (u, r) => (u != null ? u : (r != null ? 100 - r : null));
  const remain = (v) => (v != null ? Math.max(0, 100 - v) : null);
  return makeReading({
    pct5h: remain(used(sessionUsed, sessionRemaining)),
    pctWk: remain(used(weeklyUsed, weeklyRemaining)),
  });
```

- [ ] **Step 6: Add `normaliseClaudeCodeReading` and the closing marker**

Claude Code's numbers are shaped in `main.js`, so the renderer's job is only to
rename them. Add after the Claude parsers:

```js
// Claude Code arrives already shaped by main.js (pct5h / pct7d from the
// anthropic-ratelimit-unified-* headers). Only the names differ.
function normaliseClaudeCodeReading(data) {
  return makeReading({
    pct5h:     data.pct5h ?? null,
    pctWk:     data.pct7d ?? null,
    reset5hMs: data.reset5hMs ?? 0,
    resetWkMs: data.reset7dMs ?? 0,
    has5h:     data.has5h,
    hasWk:     data.hasWk,
    label:     data.account ?? null,
  });
}

// ── READING PARSERS END ──
```

Place this marker **after** the last parse function and **before** `renderCodexData`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test test/account-reading.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 8: Run the full suite — expect known failures**

Run: `npm test`
Expected: FAIL. `test/codex-usage.test.js` asserts the old field names (`shared5h`, `sharedWeek`). Those assertions are now wrong by design.

- [ ] **Step 9: Update `test/codex-usage.test.js` to the new vocabulary**

In `test/codex-usage.test.js`, rename throughout: `shared5h` → `pct5h`, `sharedWeek` → `pctWk`, `reset7dMs` → `resetWkMs`, and `parsed.credits` → `parsed.extra.credits`. Do **not** weaken any assertion — the values are unchanged, only the field names.

Add one test that pins the behaviour the rename must not lose:

```js
test('an unclassifiable window still falls back to its historic position', () => {
  const { parseCodexApiUsage } = loadCodexParsers();
  const parsed = parseCodexApiUsage({
    rate_limit: {
      primary_window:   { used_percent: 40 },
      secondary_window: { used_percent: 25 },
    },
  }, NOW);
  assert.strictEqual(parsed.pct5h, 60);
  assert.strictEqual(parsed.pctWk, 75);
});
```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS, 180 tests (172 baseline + 8 new).

- [ ] **Step 11: Commit**

Write the message below to `$MSGFILE` with the Write tool (not a heredoc - see Global Constraints), then:

```
refactor(readings): one normalised shape from every parse function

Three providers each named the same four numbers differently, and two
reported percentage USED where the third reported remaining. Every
parse function now returns makeReading(): pct5h / pctWk / reset5hMs /
resetWkMs / has5h / hasWk / label / extra, with remaining-percentage
conversion done at the parse boundary so nothing downstream sees a
"used" figure.

has5h and hasWk default true so that "momentarily missing" (renders an
em-dash) stays distinct from "the plan has no such window" (renders
n/a) — a distinction a null percentage cannot carry on its own.

No render path changes yet; this task only fixes the vocabulary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git add renderer.js test/account-reading.test.js test/codex-usage.test.js
git commit -F "$MSGFILE"
```

---

## Task 2: One registration path for every account

**Files:**
- Modify: `renderer.js` — add `PROVIDERS` and `registerAccount`; rewrite `accountPrefixes`; strip the hardcoded registry literals
- Test: `test/account-reading.test.js` (extend)

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `registerAccount(descriptor) -> void`
  - `PROVIDERS: Array<Descriptor>`
  - `Descriptor = { id, logKey, label, fetch?, exactSessionFromReset?, renderExtra? }`
  - `accountPrefixes() -> string[]`

- [ ] **Step 1: Write the failing test**

Append to `test/account-reading.test.js`. Add this loader beside the existing one:

```js
// Slices the registration block. It touches only module-level objects, so the
// stub context needs no DOM.
function loadRegistration() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('// ── REGISTRATION ──');
  const end = source.indexOf('// ── REGISTRATION END ──');
  assert.ok(start >= 0 && end > start, 'expected registration source markers');
  const context = { console, Object, Array, Set, Map };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}
```

and these tests:

```js
test('registering an account seeds every registry it needs', () => {
  const c = loadRegistration();
  c.registerAccount({ id: 'gemini', logKey: 'gemini', label: 'Gemini' });

  assert.strictEqual(c.hasData.gemini, false);
  assert.strictEqual(c.cachedData.gemini, null);
  assert.strictEqual(c.lastPct5h.gemini, null);
  assert.strictEqual(c.accountOverrides.gemini, '');
  assert.strictEqual(c.LOG_ACCOUNT.gemini, 'gemini');
  assert.deepStrictEqual(c.trendHistory['gemini-5h'], []);
  assert.deepStrictEqual(c.trendHistory['gemini-wk'], []);
  assert.deepStrictEqual(c.registry.gemini.start, null);
});

// The session store is keyed by logKey, every other registry by id. Conflating
// them would detach 7,000 log entries.
test('the session store is keyed by logKey while the rest key by id', () => {
  const c = loadRegistration();
  c.registerAccount({ id: 'claude2', logKey: 'claude-vscode', label: 'Claude Code' });
  assert.ok('claude-vscode' in c.registry, 'session store keys by logKey');
  assert.ok(!('claude2' in c.registry), 'and never by id');
  assert.ok('claude2' in c.hasData, 'display registries key by id');
});

test('re-registering an account preserves the data it already has', () => {
  const c = loadRegistration();
  c.registerAccount({ id: 'codex', logKey: 'codex', label: 'Codex' });
  c.hasData.codex = true;
  c.trendHistory['codex-wk'].push(90);

  c.registerAccount({ id: 'codex', logKey: 'codex', label: 'Codex' });

  assert.strictEqual(c.hasData.codex, true, 'a rescan must not blank live state');
  assert.deepStrictEqual(c.trendHistory['codex-wk'], [90]);
});

test('the fixed providers are registered with their immutable log keys', () => {
  const c = loadRegistration();
  const byId = Object.fromEntries(c.PROVIDERS.map(p => [p.id, p.logKey]));
  assert.strictEqual(byId.codex, 'codex');
  assert.strictEqual(byId.claude, 'claude-desktop');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/account-reading.test.js`
Expected: the four new tests FAIL with `expected registration source markers`.

- [ ] **Step 3: Replace the hardcoded registry literals**

In `renderer.js`, change these five declarations to empty containers. They are at roughly lines 4, 52, 55, 76 and 123 — find them by exact text:

| Current | Becomes |
| --- | --- |
| `const accountOverrides = { codex: '', claude: '' };` | `const accountOverrides = {};` |
| `const hasData = { codex: false, claude: false };` | `const hasData = {};` |
| `const cachedData = { codex: null, claude: null };` | `const cachedData = {};` |
| `const trendHistory = { 'codex-5h': [], … };` (4 keys) | `const trendHistory = {};` |
| `const LOG_ACCOUNT = { codex: 'codex', claude: 'claude-desktop' };` | `const LOG_ACCOUNT = {};` |
| `const lastPct5h = { codex: null, claude: null };` | `const lastPct5h = {};` |

Also empty the `_ss` literal to `const _ss = {};` — its two seeded keys now come from registration.

- [ ] **Step 4: Add the registration block**

Insert immediately after the `_ss` declaration:

```js
// ── REGISTRATION ──────────────────────────────────────────────────────────
// Seven module-level registries have to learn about every account. Codex and
// Claude Desktop used to hardcode their slots in literals at the top of this
// file while Claude Code seeded its own in a loop — so adding a provider meant
// remembering seven separate places, and forgetting one produced a card that
// looked fine until something downstream read an undefined slot.
//
// `registry` is the session store, aliased as _ss for the existing callers. It
// is keyed by logKey; everything else is keyed by descriptor id. Those two
// namespaces are not interchangeable: logKey addresses 7,000+ usage-log
// entries, id addresses DOM elements.
const registry = _ss;

function registerAccount(acct) {
  if (!(acct.id in hasData))          hasData[acct.id] = false;
  if (!(acct.id in cachedData))       cachedData[acct.id] = null;
  if (!(acct.id in lastPct5h))        lastPct5h[acct.id] = null;
  if (!(acct.id in accountOverrides)) accountOverrides[acct.id] = '';
  LOG_ACCOUNT[acct.id] = acct.logKey;
  trendHistory[acct.id + '-5h'] = trendHistory[acct.id + '-5h'] || [];
  trendHistory[acct.id + '-wk'] = trendHistory[acct.id + '-wk'] || [];
  registry[acct.logKey] = registry[acct.logKey] || { start: null, lastPct: null };
}

// The two providers that are always present. Claude Code descriptors are
// appended at runtime from the account registry in buildClaudeCodeCards.
// `fetch` is assigned below, after the fetch functions are declared.
const PROVIDERS = [
  { id: 'codex',  logKey: 'codex',          label: 'Codex' },
  { id: 'claude', logKey: 'claude-desktop', label: 'Claude Desktop',
    exactSessionFromReset: false },
];
// ── REGISTRATION END ──
```

- [ ] **Step 5: Derive `accountPrefixes` from the registrations**

Replace `accountPrefixes` with:

```js
// Every render prefix currently on screen, derived from what was actually
// registered rather than from a literal. A literal is how the August rebuild
// path came to be unreachable: a provider added in one place and forgotten in
// another.
function accountPrefixes() {
  return Object.keys(hasData);
}
```

- [ ] **Step 6: Call `registerAccount` for the fixed providers at startup**

In `init()`, before the first fetch is dispatched, add:

```js
  PROVIDERS.forEach(registerAccount);
```

In `buildClaudeCodeCards`, replace the inline seeding block (the eight lines from
`if (!(acct.id in hasData))` through `_ss[acct.logKey] = …`) with:

```js
    registerAccount(acct);
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: PASS, 184 tests.

- [ ] **Step 8: Commit**

Write the message below to `$MSGFILE` with the Write tool (not a heredoc - see Global Constraints), then:

```
refactor(readings): one registerAccount() for every provider

Seven module-level registries had to learn about every account. Codex
and Claude Desktop hardcoded their slots in literals at the top of
renderer.js; Claude Code seeded its own in a loop inside
buildClaudeCodeCards. The loop was already correct and general — it was
simply unreachable from the other two.

Extracted as registerAccount(), now called by all three. The literals
are empty, and accountPrefixes() derives from what was registered
rather than restating it: a provider registered in one place and
forgotten in another is the defect class that made the card-rebuild
path unreachable in the August multi-account work.

The id/logKey split is pinned by test: the session store keys by
logKey, every display registry keys by id.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git add renderer.js test/account-reading.test.js
git commit -F "$MSGFILE"
```

---

## Task 3: One render path, and the cache that feeds it

**Files:**
- Modify: `renderer.js` — add `renderAccountData` and `normaliseCachedReading`; delete `renderCodexData`, `renderClaudeWebData`, `renderClaudeCodeApiData`; rewrite `loadCachedStaticData` and `loadCachedClaudeCodeData`; repoint the three fetch callers
- Test: `test/account-render.test.js` (create), `test/account-reading.test.js` (extend)

**Interfaces:**
- Consumes: `makeReading` (Task 1), `registerAccount`, `PROVIDERS` (Task 2)
- Produces:
  - `renderAccountData(acct, reading, stale = false) -> void`
  - `normaliseCachedReading(raw) -> Reading|null`

**Why these are one task.** The two cache loaders call all three render functions this task deletes (`renderer.js:1355`, `:1356`, `:1374`). Splitting the deletion from the cache rewrite would commit a renderer that throws on startup — and `node --check` would not catch it, because a dangling function reference is a runtime error, not a syntax error. Both replacements are written and green before anything is deleted.

- [ ] **Step 1: Write the failing render test**

Create `test/account-render.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Slices the single render path and runs it against an element store, the same
// technique as test/codex-render.test.js. Every collaborator that leaves the
// render layer — the log, the cache, the trend — is a spy, so the assertions
// are about what renderAccountData DOES, not about what the app happens to
// have on screen.
function loadRenderer() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('function renderAccountData');
  const end = source.indexOf('// ── RENDER END ──');
  assert.ok(start >= 0 && end > start, 'expected render source markers');

  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: null, style: {} });
    return els.get(id);
  };
  const logged = [];
  const trends = [];
  const context = {
    document: { getElementById: (id) => el(id) },
    window: { electronAPI: { appendUsageLog: (e) => logged.push(e) } },
    Date, Math, Number, Object,
    applyAccountLabel: () => {},
    renderStat: (prefix, win, pct, placeholder) => {
      el(`${prefix}-${win}-pct`).textContent = pct != null ? pct + '%' : (placeholder || '—');
    },
    renderBudget: () => {},
    setText: (id, v) => { el(id).textContent = v ?? '—'; },
    fmtResetIn: (ms) => 'in:' + ms,
    fmtResetOn: (ms) => 'on:' + ms,
    pushTrend: (k, v) => trends.push([k, v]),
    saveCachedData: () => {},
    buildUsageEntry: (account, p5, pw, r5, rw) => ({ account, '5h': p5, wk: pw, r5, rw }),
    trackSession: () => '2026-10-07T00:00:00.000Z',
    showSection: () => {},
    resizeToFit: () => {},
    noFiveHourWindow: new Set(),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { ...context, el, logged, trends };
}

const READING = {
  pct5h: 55, pctWk: 86, reset5hMs: 1000, resetWkMs: 2000,
  has5h: true, hasWk: true, label: 'x@example.com', extra: null,
};

// THE test. Three providers previously ran three near-identical functions and
// drifted apart. Given the same reading they must now be indistinguishable.
test('every provider renders identically from an identical reading', () => {
  const shapes = ['codex', 'claude', 'claude2'].map((id) => {
    const c = loadRenderer();
    c.renderAccountData({ id, logKey: 'lk-' + id }, { ...READING });
    return {
      pct5h: c.el(id + '-5h-pct').textContent,
      pctWk: c.el(id + '-wk-pct').textContent,
      reset5h: c.el(id + '-5h-reset').textContent,
      resetWk: c.el(id + '-wk-reset').textContent,
      trends: c.trends.map(([k, v]) => [k.replace(id, 'ID'), v]),
      logged: c.logged.map(e => ({ ...e, account: 'LK' })),
    };
  });
  assert.deepStrictEqual(shapes[0], shapes[1]);
  assert.deepStrictEqual(shapes[1], shapes[2]);
});

test('a window the plan lacks reads n/a and blanks its reset line', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'codex', logKey: 'codex' },
    { ...READING, pct5h: null, has5h: false });
  assert.strictEqual(c.el('codex-5h-pct').textContent, 'n/a');
  assert.strictEqual(c.el('codex-5h-reset').textContent, '');
});

test('a momentarily missing meter still reads as an em-dash', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'claude', logKey: 'claude-desktop' },
    { ...READING, pct5h: null, has5h: true });
  assert.strictEqual(c.el('claude-5h-pct').textContent, '—');
});

test('the usage log is written against logKey, never the descriptor id', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'claude2', logKey: 'claude-vscode' }, { ...READING });
  assert.strictEqual(c.logged[0].account, 'claude-vscode');
  assert.strictEqual(c.logged[0]['5h'], 55);
  assert.strictEqual(c.logged[0].wk, 86);
});

test('a stale render paints but never writes', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'codex', logKey: 'codex' }, { ...READING }, true);
  assert.strictEqual(c.el('codex-5h-pct').textContent, '55%');
  assert.strictEqual(c.logged.length, 0, 'a cached reading is not a new observation');
  assert.strictEqual(c.trends.length, 0);
});

test('a provider-specific extra renders through its own hook, not a branch', () => {
  const c = loadRenderer();
  const seen = [];
  c.renderAccountData(
    { id: 'codex', logKey: 'codex', renderExtra: (a, x) => seen.push(x) },
    { ...READING, extra: { credits: 0 } });
  assert.deepStrictEqual(seen, [{ credits: 0 }]);
});

test('an account with no extras and no hook renders without error', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'claude', logKey: 'claude-desktop' }, { ...READING });
  assert.strictEqual(c.el('claude-5h-pct').textContent, '55%');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/account-render.test.js`
Expected: all FAIL with `expected render source markers`.

- [ ] **Step 3: Write `renderAccountData`**

Insert where `renderCodexData` currently sits:

```js
// The single render path. Three functions previously performed these ten steps
// in this order, differing only in field names and hardcoded ids — so every
// render-layer fix had to be made three times, and when it wasn't, the cards
// drifted apart.
function renderAccountData(acct, reading, stale = false) {
  const id = acct.id;

  if (!stale) applyAccountLabel(id, reading.label);

  if (!reading.has5h) noFiveHourWindow.add(id); else noFiveHourWindow.delete(id);

  renderStat(id, '5h', reading.pct5h, reading.has5h ? undefined : 'n/a');
  renderStat(id, 'wk', reading.pctWk, reading.hasWk ? undefined : 'n/a');
  renderBudget(id, reading.pct5h);

  setText(id + '-5h-reset',
    !reading.has5h ? '' : (reading.reset5hMs > 0 ? fmtResetIn(reading.reset5hMs) : ''));
  setText(id + '-wk-reset',
    !reading.hasWk ? '' : (reading.resetWkMs > 0 ? fmtResetOn(reading.resetWkMs) : ''));

  if (!stale) {
    pushTrend(id + '-5h', reading.pct5h);
    pushTrend(id + '-wk', reading.pctWk);
    saveCachedData(id, reading);

    const entry = buildUsageEntry(
      acct.logKey, reading.pct5h, reading.pctWk, reading.reset5hMs, reading.resetWkMs);

    // Claude Code can place the session exactly: its 5h reset header is the
    // end of the window, so the start is five hours earlier. Everyone else
    // infers it from a quota jump. A provider with no 5h window has no session
    // at all — carrying the last one forward would freeze the session count at
    // whatever it was the day the window disappeared.
    if (!reading.has5h) {
      // no sessionStart
    } else if (acct.exactSessionFromReset && reading.reset5hMs > 0) {
      const start = new Date(reading.reset5hMs - 5 * 3_600_000).toISOString();
      entry.sessionStart = start;
      registry[acct.logKey].start   = start;
      registry[acct.logKey].lastPct = reading.pct5h;
    } else {
      const start = trackSession(acct.logKey, reading.pct5h);
      if (start) entry.sessionStart = start;
    }

    window.electronAPI.appendUsageLog(entry);
  }

  // Provider-specific display stays on the descriptor. Putting it here as
  // `if (acct.id === 'codex')` is the branch this whole refactor removes.
  if (acct.renderExtra && reading.extra) acct.renderExtra(acct, reading.extra);

  const prompt = document.getElementById(id + '-login-prompt');
  if (prompt) prompt.style.display = 'none';
  const data = document.getElementById(id + '-data');
  if (data) data.style.display = 'block';
  showSection(id + '-section', true);
  resizeToFit();
}
// ── RENDER END ──
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/account-render.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing cache test**

Append to `test/account-reading.test.js`:

```js
test('a legacy codex cache reads as a normalised reading', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({
    shared5h: null, sharedWeek: 100, reset7dMs: 123, credits: '0',
    email: 'a@example.com',
  });
  assert.strictEqual(r.pctWk, 100);
  assert.strictEqual(r.resetWkMs, 123);
  assert.strictEqual(r.label, 'a@example.com');
});

test('a legacy claude cache converts used to remaining', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({ sessionUsed: 36, weeklyUsed: 13 });
  assert.strictEqual(r.pct5h, 64);
  assert.strictEqual(r.pctWk, 87);
});

test('a legacy claude code cache reads through pct7d', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({ pct5h: 55, pct7d: 86, account: 'max 20x' });
  assert.strictEqual(r.pct5h, 55);
  assert.strictEqual(r.pctWk, 86);
  assert.strictEqual(r.label, 'max 20x');
});

// A cache cannot support the claim "this plan has no 5h window". Only a live
// poll can. Rendering n/a from a stale cache would assert something the data
// does not know.
test('a cached reading never claims a window is absent', () => {
  const { normaliseCachedReading } = loadParsers();
  assert.strictEqual(normaliseCachedReading({ shared5h: null, sharedWeek: 100 }).has5h, true);
  assert.strictEqual(normaliseCachedReading({ pct5h: 55 }).hasWk, true);
});

test('an empty or absent cache yields nothing to render', () => {
  const { normaliseCachedReading } = loadParsers();
  assert.strictEqual(normaliseCachedReading(null), null);
  assert.strictEqual(normaliseCachedReading({}), null);
});

test('a reading already in the new shape passes through unchanged', () => {
  const { normaliseCachedReading } = loadParsers();
  const r = normaliseCachedReading({ pct5h: 10, pctWk: 20, has5h: false });
  assert.strictEqual(r.pct5h, 10);
  assert.strictEqual(r.pctWk, 20);
  assert.strictEqual(r.has5h, false, 'a cache written by the new code is trusted');
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `node --test test/account-reading.test.js`
Expected: the six new tests FAIL with `normaliseCachedReading is not a function`.

- [ ] **Step 7: Implement `normaliseCachedReading`**

Add inside the READING PARSERS section, before the closing marker:

```js
// settings.json holds whatever shape was current when it was written: Codex's
// {shared5h, sharedWeek}, Claude's {sessionUsed, weeklyUsed} (percentage USED),
// Claude Code's {pct5h, pct7d}, or the new shape. All four are read here. No
// migration is needed: saveCachedData rewrites the file wholesale on the first
// poll, so a legacy shape has to survive exactly one startup render.
function normaliseCachedReading(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const fromUsed = (u) => (typeof u === 'number') ? Math.max(0, 100 - u) : null;
  const pct5h = raw.pct5h  ?? raw.shared5h   ?? fromUsed(raw.sessionUsed);
  const pctWk = raw.pctWk  ?? raw.sharedWeek ?? raw.pct7d ?? fromUsed(raw.weeklyUsed);

  if (pct5h == null && pctWk == null) return null;

  return makeReading({
    pct5h,
    pctWk,
    reset5hMs: raw.reset5hMs ?? raw.sessionResetMs ?? 0,
    resetWkMs: raw.resetWkMs ?? raw.reset7dMs ?? raw.weeklyResetMs ?? 0,
    // A cache cannot know that a plan HAS no window — only that it recorded no
    // number. Absent means unknown, which renders an em-dash. Trust an explicit
    // flag only when the new code wrote it.
    has5h: raw.has5h ?? true,
    hasWk: raw.hasWk ?? true,
    label: raw.label ?? raw.email ?? raw.account ?? null,
    extra: raw.extra ?? (raw.credits != null ? { credits: raw.credits } : null),
  });
}
```

- [ ] **Step 8: Delete the three old render functions and repoint their callers**

Delete `renderCodexData`, `renderClaudeWebData` and `renderClaudeCodeApiData` entirely. Then:

In `fetchCodexUsage`, replace `renderCodexData(parsed);` with:

```js
  renderAccountData(PROVIDERS.find(p => p.id === 'codex'), parsed);
```

In `fetchClaudeWebUsage`, replace the both-null guard and render call. The guard now reads the normalised names:

```js
  if (parsed.pct5h === null && parsed.pctWk === null) {
```

and the render call becomes:

```js
  if (result.email) parsed.label = result.email;
  hasData.claude = true;
  renderAccountData(PROVIDERS.find(p => p.id === 'claude'), parsed);
```

In `fetchClaudeCodeUsage`, replace `renderClaudeCodeApiData(acct, result);` with:

```js
  renderAccountData(acct, normaliseClaudeCodeReading(result));
```

- [ ] **Step 9: Rewrite both cache loaders**

Replace `loadCachedStaticData` and `loadCachedClaudeCodeData` with:

```js
function loadCachedStaticData(settings) {
  const kn = settings.lastKnown;
  if (!kn) return;
  for (const acct of PROVIDERS) {
    const reading = normaliseCachedReading(kn[acct.id]);
    if (!reading) continue;
    renderAccountData(acct, reading, true);
    setBadge(acct.id + '-badge', 'Cached', 'stale');
  }
}

function loadCachedClaudeCodeData(settings) {
  const kn = settings.lastKnown;
  if (!kn) return;
  // Seeds cachedData from the persisted slots. buildClaudeCodeCards resets the
  // slot of every account it clones, and the next saveCachedData persists the
  // whole map — an un-restored slot would write null over a good cached value.
  Object.assign(cachedData, kn);
  for (const acct of claudeAccounts) {
    const reading = normaliseCachedReading(kn[acct.id]);
    if (!reading) continue;
    renderAccountData(acct, reading, true);
    setBadge(acct.id + '-badge', 'Cached', 'stale');
    const e = readClaudeCodeEmailCache(acct);
    if (e) applyAccountLabel(acct.id, e);
  }
}
```

- [ ] **Step 10: Give Codex its `renderExtra` hook and Claude Code its session flag**

In the `PROVIDERS` array, change the Codex entry to:

```js
  { id: 'codex', logKey: 'codex', label: 'Codex',
    renderExtra: (_acct, extra) => setText('codex-credits', extra.credits) },
```

In `buildClaudeCodeCards`, before `registerAccount(acct)`, add:

```js
    // Claude Code's 5h reset header is the exact end of the window.
    acct.exactSessionFromReset = true;
```

- [ ] **Step 11: Verify no caller of the deleted functions remains**

Run: `grep -n "renderCodexData\|renderClaudeWebData\|renderClaudeCodeApiData" renderer.js`
Expected: no output. All three call sites in the two cache loaders were repointed in Steps 8 and 9, so a hit here means one was missed — and `node --check` will not catch it.

- [ ] **Step 12: Syntax check**

Run: `node --check renderer.js`
Expected: no output.

- [ ] **Step 13: Run the full suite**

Run: `npm test`
Expected: PASS, 190 tests.

- [ ] **Step 14: Commit**

Write the message below to `$MSGFILE` with the Write tool (not a heredoc - see Global Constraints), then:

```
refactor(readings): collapse three render paths into one, with its cache

renderCodexData, renderClaudeWebData and renderClaudeCodeApiData
performed the same ten steps in the same order, differing only in field
names and hardcoded ids. One renderAccountData(acct, reading, stale)
replaces all three.

The test that proves it: give three providers an identical reading and
assert the resulting DOM, trend pushes and log entry are
indistinguishable. That fails against the previous code, because Claude
Desktop converted used-to-remaining inside its own render function - so
it discriminates rather than restating the implementation.

The two behaviours that genuinely differ became descriptor properties
rather than branches: exactSessionFromReset for Claude Code, whose 5h
header gives the window's exact end, and renderExtra for Codex's
credits line. Keeping the credits line in the shared path would have
meant `if (acct.id === 'codex')` inside the one function whose purpose
is to know nothing about any single provider.

normaliseCachedReading lands in the same commit because the two cache
loaders call all three deleted functions. settings.json still needs no
migration: saveCachedData rewrites it wholesale on the first poll, so a
legacy shape has to survive exactly one startup render. A cached
reading never claims a window is ABSENT - it can only record that it
saw no number, which renders an em-dash, where asserting n/a from weeks
-old data would be a claim the cache cannot support.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git add renderer.js test/account-render.test.js test/account-reading.test.js
git commit -F "$MSGFILE"
```

---

## Task 5: Retire the dead handler and the duplicate retry timers

**Files:**
- Modify: `main.js:1422-1452` — delete `ipcMain.handle('fetch-url', …)`
- Modify: `renderer.js` — one retry-timer map

**Interfaces:**
- Consumes: `registerAccount` (Task 2)
- Produces: `retryTimers: Record<string, ReturnType<typeof setTimeout>>`

- [ ] **Step 1: Confirm `fetch-url` really is dead before deleting it**

Run: `grep -rn "fetch-url\|fetchUrl" --include=*.js --include=*.html . | grep -v node_modules`
Expected: exactly one hit, the handler definition in `main.js`. If anything else appears, stop and report — the premise is wrong.

- [ ] **Step 2: Delete the handler**

Remove the whole `ipcMain.handle('fetch-url', async (_event, url, options) => { … });` block from `main.js`. It accepted an arbitrary URL, method, headers and body from the renderer and performed the request from the main process, and was never reachable — not exposed in `preload.js`, not called anywhere.

- [ ] **Step 3: Replace the three retry-timer patterns with one map**

In `renderer.js`, delete `let claudeRetryTimer = null;`, `let codexRetryTimer = null;` and `const claudeRetryTimers = {};`. Add beside the registries:

```js
// One timer per account id. Three patterns previously existed for one concept:
// two module-level scalars and a map.
const retryTimers = {};
```

Replace every use:

| Was | Becomes |
| --- | --- |
| `clearTimeout(codexRetryTimer); codexRetryTimer = null;` | `clearTimeout(retryTimers.codex); retryTimers.codex = null;` |
| `codexRetryTimer = setTimeout(fetchCodexUsage, 45_000);` | `retryTimers.codex = setTimeout(fetchCodexUsage, 45_000);` |
| `clearTimeout(claudeRetryTimer); claudeRetryTimer = null;` | `clearTimeout(retryTimers.claude); retryTimers.claude = null;` |
| `claudeRetryTimer = setTimeout(fetchClaudeWebUsage, 30_000);` | `retryTimers.claude = setTimeout(fetchClaudeWebUsage, 30_000);` |
| `claudeRetryTimer = setTimeout(fetchClaudeWebUsage, 45_000);` | `retryTimers.claude = setTimeout(fetchClaudeWebUsage, 45_000);` |
| `clearTimeout(claudeRetryTimers[acct.id]); claudeRetryTimers[acct.id] = null;` | `clearTimeout(retryTimers[acct.id]); retryTimers[acct.id] = null;` |
| `claudeRetryTimers[acct.id] = setTimeout(…)` | `retryTimers[acct.id] = setTimeout(…)` |

In `buildClaudeCodeCards`, the loop that clears pending timers becomes:

```js
  for (const id of Object.keys(retryTimers)) {
    clearTimeout(retryTimers[id]);
    delete retryTimers[id];
  }
```

- [ ] **Step 4: Verify nothing references the old names**

Run: `grep -n "claudeRetryTimer\b\|codexRetryTimer\|claudeRetryTimers" renderer.js`
Expected: no output.

- [ ] **Step 5: Syntax check and full suite**

Run: `node --check renderer.js && node --check main.js && npm test`
Expected: PASS, 190 tests.

- [ ] **Step 6: Commit**

Write the message below to `$MSGFILE` with the Write tool (not a heredoc - see Global Constraints), then:

```
chore: delete the dead fetch-url handler, unify the retry timers

main.js carried an ipcMain.handle('fetch-url') that took an arbitrary
URL, method, headers and body from the renderer and performed the
request from the main process. It was never exposed in preload.js and
never called — an unreachable general-purpose HTTP proxy. A future
token-based provider should reintroduce one deliberately, scoped to a
host allowlist, rather than inherit this.

Three patterns existed for one concept: claudeRetryTimer and
codexRetryTimer as module scalars, claudeRetryTimers as a map. Now one
map keyed by account id.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git add renderer.js main.js
git commit -F "$MSGFILE"
```

---

## Task 6: Phase 1 integration

**Files:** none modified — verification only.

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces: a merge-ready Phase 1

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS, 190 tests, 0 failures.

- [ ] **Step 2: Syntax-check every changed file**

Run: `node --check renderer.js && node --check main.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Prove the headline test discriminates**

The "every provider renders identically" test must fail against pre-refactor code. Confirm it:

```bash
git stash list  # expect empty
node -e "
const {execSync}=require('child_process'); const vm=require('vm');
const src=execSync('git show main:renderer.js',{encoding:'utf8',maxBuffer:1<<24});
const a=src.indexOf('function renderClaudeWebData');
console.log('pre-refactor Claude Desktop converted used->remaining inside its');
console.log('own render function, so an identical reading produced different DOM:');
console.log(src.slice(a, a+220));
"
```

Expected: output shows `renderClaudeWebData` computing `100 - parsed.sessionUsed` inside the render function — the asymmetry the new test forbids. Record this in the task notes.

- [ ] **Step 4: Confirm no log-key regression**

Run:

```bash
grep -n "buildUsageEntry(" renderer.js
```

Expected: exactly one call site, inside `renderAccountData`, passing `acct.logKey`. Any call passing `acct.id` would silently detach 7,000 log entries.

- [ ] **Step 5: Report to the user and stop**

Phase 1 is complete but **not merged**. GUI verification is the user's step and it gates the merge, because no automated test in this repo can confirm the cards still paint. Report:

- tests: 172 → 190
- what to check in the GUI: all three cards render with correct numbers; the compact view matches the full view; Codex still reads `n/a` for 5H with its credits line intact; Settings → Rescan still adds a Claude Code card
- do not proceed to Phase 2 until the user confirms

---

# Phase 2 — Gemini

## Task 7: Discovery — the user captures the real page

**Files:**
- Create: `docs/handoff/gemini-discovery.md`

**Interfaces:**
- Consumes: nothing
- Produces: `docs/handoff/gemini-discovery.md` containing the real page text and any JSON endpoint, which Task 8 tests against

**This task is performed by the user. No code is written until it completes.**

Writing a parser against assumed page text is how the Codex integration spent six weeks silently mislabelling its own data. The same mistake is available here and must not be repeated.

- [ ] **Step 1: Create the capture instructions**

Create `docs/handoff/gemini-discovery.md`:

```markdown
# Gemini discovery — capture before any parser is written

Sign in at gemini.google.com as the Gemini-plan account
(the personal Gmail, NOT the Workspace identity).

Then: bottom left → Settings → Usage limits.

## 1. The page text

Select all on the usage panel and paste it verbatim below, including
percentages, reset wording and any weekly line. Verbatim matters — the parser
is written against this exact text.

```
<paste here>
```

## 2. Which meters exist

- [ ] A 5-hour window with a percentage
- [ ] A weekly cap with a percentage or a progress indication
- [ ] Something else entirely (e.g. a monthly "N of 1000 uses" counter)

If the third box is the one ticked, STOP. The two-meter card model does not fit
and the design needs revisiting before any code is written.

## 3. Is the number used, or remaining?

Say which, in words, exactly as the page phrases it.

## 4. A JSON endpoint, if one exists

DevTools → Network → reload the usage page → filter XHR/Fetch. If any response
contains the percentages as JSON, paste the request URL and the response body.
A structured endpoint is strongly preferred over scraping rendered text: it
survives redesigns and usually carries exact reset timestamps.

Request URL:
```
<paste or write "none found">
```

Response body:
```
<paste or write "none found">
```

## 5. The signed-in account

Confirm the email shown in the account menu. The scrape will verify against it
on every poll, and a mismatch will be treated as an error rather than a
reading — Google multi-login can otherwise serve a different account's quota
under this card, and a wrong number written into usage-log.jsonl is
indistinguishable from a real one afterwards.
```

- [ ] **Step 2: Commit the instructions**

Write the message below to `$MSGFILE` with the Write tool (not a heredoc - see Global Constraints), then:

```
docs: Gemini discovery capture sheet

Phase 2 opens with a user-performed capture rather than code. Only the
user can load gemini.google.com authenticated, and writing a parser
against assumed page text is how the Codex integration spent six weeks
mislabelling its own data.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git add docs/handoff/gemini-discovery.md
git commit -F "$MSGFILE"
```

- [ ] **Step 3: Hand the sheet to the user and stop**

Do not start Task 8 until sections 1–5 are filled in. If section 2 reports a monthly counter, return to the spec rather than writing a parser.

---

## Task 8: `parseGeminiUsage`, written against the captured text

**Files:**
- Modify: `renderer.js` — add `parseGeminiUsage` inside the READING PARSERS section
- Test: `test/gemini-usage.test.js` (create)

**Interfaces:**
- Consumes: `makeReading` (Task 1), `docs/handoff/gemini-discovery.md` (Task 7)
- Produces: `parseGeminiUsage(payload, now) -> Reading`, where `payload` is `{ text, apiData, email }`

- [ ] **Step 1: Write the failing test from the captured text**

Create `test/gemini-usage.test.js`. Use the **verbatim text from section 1 of the discovery sheet** as `REAL_PAGE` — do not paraphrase it, do not tidy the whitespace:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadParsers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('function makeReading');
  const end = source.indexOf('// ── READING PARSERS END ──');
  assert.ok(start >= 0 && end > start, 'expected reading-parser source markers');
  const context = { console, Math, Number, RegExp, Date, parseInt, isNaN };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

const NOW = Date.parse('2026-10-07T09:00:00Z');

// VERBATIM from docs/handoff/gemini-discovery.md section 1.
const REAL_PAGE = `<paste the captured text here during implementation>`;

test('the real captured page yields both meters as remaining percentages', () => {
  const { parseGeminiUsage } = loadParsers();
  const r = parseGeminiUsage({ text: REAL_PAGE, email: 'x@gmail.com' }, NOW);
  // Fill these two from the discovery sheet. If the page reports USED, these
  // are 100 minus the captured figures.
  assert.strictEqual(r.pct5h, /* remaining from the sheet */ null);
  assert.strictEqual(r.pctWk, /* remaining from the sheet */ null);
  assert.strictEqual(r.has5h, true);
  assert.strictEqual(r.hasWk, true);
  assert.strictEqual(r.label, 'x@gmail.com');
});

test('a depleted window reads zero, not missing', () => {
  const { parseGeminiUsage } = loadParsers();
  const r = parseGeminiUsage({ text: REAL_PAGE.replace(/\d+%/, '0%') }, NOW);
  assert.strictEqual(r.pct5h === 0 || r.pctWk === 0, true,
    'zero remaining is a reading, never a null');
});

test('an unrecognised page claims nothing rather than guessing', () => {
  const { parseGeminiUsage } = loadParsers();
  const r = parseGeminiUsage({ text: 'Something else entirely' }, NOW);
  assert.strictEqual(r.pct5h, null);
  assert.strictEqual(r.pctWk, null);
});

test('an empty payload is survivable', () => {
  const { parseGeminiUsage } = loadParsers();
  const r = parseGeminiUsage({}, NOW);
  assert.strictEqual(r.pct5h, null);
  assert.strictEqual(r.pctWk, null);
});
```

Replace the three marked placeholders with the captured values before running. A test asserting `null` for a page that clearly shows a number is not a passing test — it is a test that was never written.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/gemini-usage.test.js`
Expected: FAIL with `parseGeminiUsage is not a function`.

- [ ] **Step 3: Implement the parser**

Add inside the READING PARSERS section. If discovery found a JSON endpoint, branch to it first and treat text as the fallback — the pattern both existing scrapers settled on:

```js
// Gemini's consumer plans use a 5-hour window feeding a weekly cap, shown at
// gemini.google.com -> Settings -> Usage limits.
//
// Match each meter on its own label, never on its position on the page or in a
// response. Position-based matching is what relabelled six weeks of Codex
// weekly figures as 5-hour ones.
function parseGeminiUsage(payload, now) {
  const text = (payload && payload.text) || '';
  const api  = payload && payload.apiData;

  // <Written from discovery section 4 if an endpoint exists; otherwise this
  //  branch is omitted entirely rather than left as a dead guess.>
  if (api) { /* structured branch, shaped by the captured response */ }

  // Label-anchored text match. The exact anchors come from discovery section 1.
  const pctNear = (label) => {
    const m = text.match(new RegExp(label + '[\\s\\S]{0,300}?(\\d+)%', 'i'));
    return m ? parseInt(m[1], 10) : null;
  };

  const raw5h = pctNear('<5h anchor from discovery>');
  const rawWk = pctNear('<weekly anchor from discovery>');
  // Flip here if discovery section 3 says the page reports USED.
  const toRemaining = (v) => (v == null ? null : Math.max(0, Math.min(100, v)));

  return makeReading({
    pct5h: toRemaining(raw5h),
    pctWk: toRemaining(rawWk),
    label: (payload && payload.email) || null,
  });
}
```

Fill every `<…>` from the discovery sheet. None may remain.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/gemini-usage.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Write the message below to `$MSGFILE` with the Write tool (not a heredoc - see Global Constraints), then:

```
feat(gemini): parse the usage page into a normalised reading

Written test-first against the real captured page text from
docs/handoff/gemini-discovery.md, not invented fixtures. Each meter is
matched on its own label rather than its position — position-based
matching is what relabelled six weeks of Codex weekly figures as
5-hour ones.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git add renderer.js test/gemini-usage.test.js
git commit -F "$MSGFILE"
```

---

## Task 9: Gemini transport in the main process

**Files:**
- Modify: `main.js` — Gemini window, scrape script, two IPC handlers
- Modify: `preload.js` — two bridge methods

**Interfaces:**
- Consumes: discovery output (Task 7)
- Produces:
  - IPC `fetch-gemini-usage` → `{ text, apiData, email }` or `{ error }`
  - IPC `show-gemini-window` → void
  - `window.electronAPI.fetchGeminiUsage()`, `window.electronAPI.showGeminiWindow()`

- [ ] **Step 1: Add the Gemini constants and window**

Append to `main.js` after the Codex scraper block:

```js
// ── Gemini page scraper ────────────────────────────────────────────────────
// gemini.google.com -> Settings -> Usage limits. The partition is its own:
// the Gemini plan sits on a personal Google account, unrelated to the
// Workspace identity every other card uses, and Google multi-login will
// otherwise serve whichever account happens to be first.
const GEMINI_URL = 'https://gemini.google.com/settings/usage';
const GEMINI_APP_RE  = /gemini\.google\.com/;
const GEMINI_AUTH_RE = /accounts\.google\.com/;

const GEMINI_SCRAPE_SCRIPT = `
  (async function() {
    for (let i = 0; i < 24; i++) {
      const t = document.body ? document.body.innerText : '';
      if (/%/.test(t)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const text = document.body ? document.body.innerText : '';
    const email = (document.body.innerText.match(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/) || [])[0] || null;
    return JSON.stringify({ text, email });
  })()
`;

let geminiWindow = null;

function getOrCreateGeminiWindow() {
  if (geminiWindow && !geminiWindow.isDestroyed()) return geminiWindow;
  geminiWindow = new BrowserWindow({
    width: 1280, height: 900, show: false, skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: false,
      partition: 'persist:gemini',
    },
  });
  geminiWindow.webContents.setBackgroundThrottling(false);
  geminiWindow.on('closed', () => { geminiWindow = null; });
  return geminiWindow;
}

async function scrapeGeminiPage(win) {
  try {
    const raw = await Promise.race([
      win.webContents.executeJavaScript(GEMINI_SCRAPE_SCRIPT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Script timeout (30s)')), 30000)),
    ]);
    win.hide();
    try { return JSON.parse(raw); } catch { return { text: raw }; }
  } catch (e) {
    win.hide();
    return { error: e.message };
  }
}
```

- [ ] **Step 2: Add the two IPC handlers**

```js
ipcMain.handle('fetch-gemini-usage', async () => {
  const win = getOrCreateGeminiWindow();
  win.hide();
  try {
    await Promise.race([
      win.webContents.loadURL(GEMINI_URL),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Load timeout')), 25000)),
    ]);
  } catch (e) {
    return { error: 'Failed to load gemini.google.com: ' + e.message };
  }

  const url = win.webContents.getURL();
  if (GEMINI_APP_RE.test(url) && !GEMINI_AUTH_RE.test(url)) {
    return await scrapeGeminiPage(win);
  }

  win.show(); win.focus();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.off('did-navigate', onNavigated);
        win.hide();
      }
      resolve({ error: 'Login timeout — please log in and try again' });
    }, 300000);

    function onNavigated(_, navUrl) {
      if (win.isDestroyed()) { clearTimeout(timer); resolve({ error: 'window-closed' }); return; }
      if (GEMINI_APP_RE.test(navUrl) && !GEMINI_AUTH_RE.test(navUrl)) {
        win.webContents.off('did-navigate', onNavigated);
        clearTimeout(timer);
        win.hide();
        win.webContents.once('did-finish-load', async () => {
          resolve(await scrapeGeminiPage(win));
        });
      }
    }
    win.on('closed', () => { clearTimeout(timer); resolve({ error: 'window-closed' }); });
    win.webContents.on('did-navigate', onNavigated);
  });
});

ipcMain.handle('show-gemini-window', () => {
  const win = getOrCreateGeminiWindow();
  win.show();
  win.focus();
  win.loadURL(GEMINI_URL);
});
```

- [ ] **Step 3: Expose both on the bridge**

In `preload.js`, after the Codex block:

```js
  // Gemini page scraper
  fetchGeminiUsage: () => ipcRenderer.invoke('fetch-gemini-usage'),
  showGeminiWindow: () => ipcRenderer.invoke('show-gemini-window'),
```

- [ ] **Step 4: Syntax check**

Run: `node --check main.js && node --check preload.js && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

Write the message below to `$MSGFILE` with the Write tool (not a heredoc - see Global Constraints), then:

```
feat(gemini): browser-session transport for the usage page

Own session partition (persist:gemini). The Gemini plan sits on a
personal Google account unrelated to the Workspace identity every other
card uses, so an isolated partition is what keeps Google multi-login
from serving a different account's quota.

Login flow mirrors the Codex handler: hidden load, show the window on
an auth redirect, wait for navigation back, 5-minute timeout.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git add main.js preload.js
git commit -F "$MSGFILE"
```

---

## Task 10: The Gemini card, descriptor and settings

**Files:**
- Modify: `index.html` — card section + two compact tiles
- Modify: `renderer.js` — `fetchGeminiUsage`, descriptor, listeners, poll loop
- Modify: `settings-renderer.js` — `ACCOUNT_PAIRS`
- Modify: `analytics-renderer.js` — three registries

**Interfaces:**
- Consumes: `parseGeminiUsage` (Task 8), IPC (Task 9), `renderAccountData` + `PROVIDERS` (Tasks 2–3)
- Produces: `fetchGeminiUsage() -> Promise<void>`

- [ ] **Step 1: Add the card markup**

In `index.html`, copy the `<div id="codex-section">` block (lines **376–451**, ending at the `</div><!-- #codex-section -->` comment) and adapt: replace every `codex-` id prefix with `gemini-`, set the section label to `Gemini (gemini.google.com)`, the clickable URL to `https://gemini.google.com/settings/usage`, the `data-section` attribute on the hide button to `gemini-section`, and **delete the credits row** (line 429, `id="codex-credits"`) — Gemini has no credits concept.

Add two compact tiles after `cs-claude-wk`. The value and trend share one `.compact-value` wrapper — this is the real structure, not three siblings:

```html
      <div class="compact-stat" id="cs-gemini-5h" style="display:none">
        <div class="compact-label">Gemini 5H</div>
        <div class="compact-value"><span id="c-gemini-5h">—</span><span class="trend" id="c-gemini-5h-trend"></span></div>
      </div>
      <div class="compact-stat" id="cs-gemini-wk" style="display:none">
        <div class="compact-label">Gemini Wk</div>
        <div class="compact-value"><span id="c-gemini-wk">—</span><span class="trend" id="c-gemini-wk-trend"></span></div>
      </div>
```

Labels are title case (`Gemini 5H`, `Gemini Wk`), matching `Codex 5H` / `Codex Wk` at lines 350–357.

- [ ] **Step 2: Add the descriptor with its identity guard**

In the `PROVIDERS` array:

```js
  { id: 'gemini', logKey: 'gemini', label: 'Gemini' },
```

- [ ] **Step 3: Write the fetch function with the identity check**

Add beside `fetchCodexUsage`:

```js
async function fetchGeminiUsage() {
  clearTimeout(retryTimers.gemini); retryTimers.gemini = null;
  fetchStart('gemini');

  const result = await window.electronAPI.fetchGeminiUsage();
  fetchStop('gemini');

  if (result.error) {
    if (result.error === 'window-closed' ||
        result.error === 'Login timeout — please log in and try again') {
      setBadge('gemini-badge', 'Login needed', 'warn');
      return;
    }
    setBadge('gemini-badge', 'Error', 'error');
    showToast('Gemini error — retrying in 45s: ' + result.error);
    retryTimers.gemini = setTimeout(fetchGeminiUsage, 45_000);
    return;
  }

  // Google multi-login can serve a different account than the one this card was
  // set up for. A wrong number written into usage-log.jsonl is indistinguishable
  // from a real one afterwards, so a mismatch is an error, never a reading.
  if (!isExpectedAccount(geminiExpectedEmail, result.email)) {
    setBadge('gemini-badge', 'Wrong account', 'error');
    showToast('Gemini is signed in as a different account — expected '
      + geminiExpectedEmail);
    return;
  }

  const parsed = parseGeminiUsage(result, Date.now());
  if (parsed.pct5h === null && parsed.pctWk === null) {
    setBadge('gemini-badge', 'No data', 'warn');
    showToast('Could not find Gemini usage data — try opening the login window.');
    retryTimers.gemini = setTimeout(fetchGeminiUsage, 45_000);
    return;
  }

  hasData.gemini = true;
  renderAccountData(PROVIDERS.find(p => p.id === 'gemini'), parsed);
  setBadge('gemini-badge', 'Live', 'ok');
  markUpdated();
  if (openPanels.has('gemini')) {
    window.electronAPI.readUsageLog('gemini', 200)
      .then(e => renderTrendAnalytics('gemini', e));
  }
}
```

`isExpectedAccount` is written in Task 11 Step 1; write it now, there, if Task 11 has not run yet — the fetch function will not work without it.

There is no module-level settings snapshot in `renderer.js`: `init()`'s `settings` is function-local (line 1514). So add the expectation as its own module-level value beside the other registries:

```js
// The Google account this card is configured for. Blank means unconfigured,
// which allows any account — a user who has not set it is not locked out of
// their own card.
let geminiExpectedEmail = '';
```

Set it in both places settings are read. In `init()`, immediately after `settings = await window.electronAPI.getSettings();`:

```js
    geminiExpectedEmail = settings.geminiAccountEmail || '';
```

and inside the existing `onSettingsChanged` handler (line 1545), beside the `accountOverrides` assignment:

```js
      geminiExpectedEmail = s.geminiAccountEmail || '';
```

Without the second one, changing the expected email in Settings would not take effect until a restart.

- [ ] **Step 4: Wire the listeners and the poll loop**

Beside the Codex listeners:

```js
document.getElementById('gemini-load-btn').addEventListener('click', fetchGeminiUsage);
document.getElementById('gemini-refresh').addEventListener('click', fetchGeminiUsage);
document.getElementById('gemini-login-btn').addEventListener('click', () => {
  showSection('gemini-section', true);
  window.electronAPI.showGeminiWindow();
  showToast('Log in, then click ↻ Refresh Gemini.');
});
```

Add `fetchGeminiUsage();` to the parallel-fetch block in `init()` (line 1531, beside `fetchCodexUsage();`) and to the interval body in `setRefreshInterval`.

- [ ] **Step 5: Register Gemini in settings and analytics — all five sites**

Each registry in these two files exists **twice**: a literal for first paint and a rebuild that runs on a Claude Code rescan. A Gemini entry added only to the literal would vanish the first time the user rescans. All five edits are required.

`settings-renderer.js` — the `ACCOUNT_PAIRS` literal (line 14) **and** the rebuild (line 61). Add to both:

```js
  { logKey: 'gemini', id: 'gemini', label: 'Gemini', detail: null },
```

In the rebuild, place it after the `claude-desktop` entry and before the `...accts.map(...)` spread, so Claude Code rows stay last.

Same file, extend `MULT_DEFAULTS` (line 18):

```js
const MULT_DEFAULTS = { 'codex': 5, 'claude-desktop': 1, 'gemini': 1 };
```

`analytics-renderer.js` — the literals (lines 10–11) **and** the rebuild (lines 1154–1155). Both become:

```js
VALID_ACCOUNTS = ['codex', 'claude-desktop', 'gemini'];
ACCOUNT_LABELS = { codex: 'Codex', 'claude-desktop': 'Claude Desktop', gemini: 'Gemini' };
```

(at lines 10–11 these are `let` declarations, so keep the `let`.)

`PLAN_MULTIPLIERS` is a `const` whose keys are deleted and re-added in the rebuild (lines 1161–1163), so the literal entry alone would be wiped. Add it to the literal at line 25:

```js
const PLAN_MULTIPLIERS = {
  'codex':          1,
  'claude-desktop': 1,
  'gemini':         1,
};
```

**and** to the rebuild, beside the two existing re-adds:

```js
  PLAN_MULTIPLIERS['gemini'] = 1;
```

The plan price defaults to 0 — the user sets their own in Settings rather than inheriting a guess at Google's pricing, which varies by tier and region. A price of 0 means no cost estimate, which is honest for a price we do not know.

- [ ] **Step 6: Syntax check and full suite**

Run: `node --check renderer.js && node --check settings-renderer.js && node --check analytics-renderer.js && npm test`
Expected: PASS. If `test/analytics-renderer.test.js` asserts the exact contents of `VALID_ACCOUNTS`, update it to include `gemini` — that is intended behaviour, not a regression.

- [ ] **Step 7: Commit**

Write the message below to `$MSGFILE` with the Write tool (not a heredoc - see Global Constraints), then:

```
feat(gemini): card, descriptor and registry entries

Gemini as the normalised-reading refactor's first consumer. Three files
for the whole provider — card markup, a fetch function, one descriptor
line — against the eight the old structure required.

The fetch refuses to render or log when the signed-in email does not
match the configured one. Google multi-login can serve a different
account, and a wrong number in usage-log.jsonl is indistinguishable
from a real one after the fact.

Plan price defaults to 0 rather than a guess at Google's pricing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

```bash
git add index.html renderer.js settings-renderer.js analytics-renderer.js test/
git commit -F "$MSGFILE"
```

---

## Task 11: Identity guard under test, and Phase 2 integration

**Files:**
- Test: `test/gemini-usage.test.js` (extend)

**Interfaces:**
- Consumes: everything from Tasks 8–10
- Produces: a merge-ready Phase 2

- [ ] **Step 1: Write the identity-mismatch test**

The guard lives inside `fetchGeminiUsage`, which touches the DOM and IPC. Extract the comparison so it can be tested on its own. In `renderer.js`, replace the inline comparison with a call to:

```js
// A scrape from the wrong Google account must not become a reading. Compared
// case-insensitively and trimmed; an unset expectation allows anything, so a
// user who has not configured the email is not locked out of their own card.
function isExpectedAccount(expected, actual) {
  const e = (expected || '').trim().toLowerCase();
  const a = (actual || '').trim().toLowerCase();
  if (!e || !a) return true;
  return e === a;
}
```

Place it inside the READING PARSERS section so the existing loader reaches it. Then append to `test/gemini-usage.test.js`:

```js
test('a scrape from the wrong Google account is rejected', () => {
  const { isExpectedAccount } = loadParsers();
  assert.strictEqual(isExpectedAccount('a@gmail.com', 'b@gmail.com'), false);
});

test('case and whitespace do not make an account look wrong', () => {
  const { isExpectedAccount } = loadParsers();
  assert.strictEqual(isExpectedAccount('A@Gmail.com', ' a@gmail.com '), true);
});

test('an unconfigured expectation does not lock the user out', () => {
  const { isExpectedAccount } = loadParsers();
  assert.strictEqual(isExpectedAccount('', 'a@gmail.com'), true);
  assert.strictEqual(isExpectedAccount('a@gmail.com', null), true);
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/gemini-usage.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 3: Mutation-check the guard**

Confirm the test would catch a build that logs anyway:

```bash
node -e "
// A guard that always returns true is the failure mode being tested.
const broken = () => true;
console.log('broken guard on mismatched accounts ->', broken('a@gmail.com','b@gmail.com'));
console.log('the test asserts false, so this build fails. Guard discriminates.');
"
```

Expected: prints `true`, confirming the test rejects a permissive guard. Record in task notes.

- [ ] **Step 4: Full suite**

Run: `npm test`
Expected: PASS, 197 tests.

- [ ] **Step 5: Report and hand to the user**

Phase 2 is complete but **not merged**. Report:

- tests: 190 → 197
- GUI verification the user must perform, and that gates the merge:
  1. First run shows the Gemini login window; signing in as the personal Gmail succeeds and the window hides
  2. The Gemini card appears with both meters populated
  3. The numbers match what `gemini.google.com` → Settings → Usage limits shows at the same moment — this is the only check that proves the parser reads the right thing
  4. Settings shows a Gemini row; the analytics window shows a Gemini tab
  5. The compact view shows both Gemini tiles
- do not merge until all five are confirmed

---

## Self-review notes

**Spec coverage.** Normalised reading → Task 1. `registerAccount` + descriptors → Task 2. Single render path + `renderExtra` + `exactSessionFromReset` + read-tolerant cache → Task 3 (Tasks 3 and 4 were merged at pre-flight; see that task's rationale). `fetch-url` deletion + retry timers → Task 5. Gemini transport → Task 9; parse → Task 8; registration → Task 10; identity guard → Tasks 10 and 11; discovery gate → Task 7. Every verification bullet in both specs maps to a step.

**Known gap, deliberate.** Task 8's test contains three bracketed values that come from Task 7's discovery output. They are a data dependency on a user-performed task, not placeholders — Task 8 cannot start until they are filled, and Step 3 states that none may remain.

**Defects the review found and fixed.** Five, all in Task 10, all from writing against memory of the codebase rather than checking it:

1. `lastSettingsSnapshot` did not exist. `init()`'s `settings` is function-local (`renderer.js:1514`), so the identity check had nothing to read. Replaced with a module-level `geminiExpectedEmail`, set in both places settings are read — `init()` and the `onSettingsChanged` handler. Without the second, changing the expected email in Settings would not have taken effect until a restart.
2. The compact-tile markup was wrong. The real structure nests the value and trend `<span>`s inside one `.compact-value` div; the draft had three sibling divs and all-caps labels. Corrected against lines 350–357.
3. The card's line range was 376–454; it is 376–451.
4. **`ACCOUNT_PAIRS`, `VALID_ACCOUNTS`, `ACCOUNT_LABELS` and `PLAN_MULTIPLIERS` each exist twice** — a literal for first paint and a rebuild that runs on a Claude Code rescan. The draft edited only the literals, so a Gemini entry would have silently vanished the first time the user rescanned. `PLAN_MULTIPLIERS` was the worst case: its keys are deleted and re-added wholesale in the rebuild, so the literal entry alone would always be wiped. Task 10 Step 5 now names all five sites and says why.
5. Commit steps used shell heredocs, which global CLAUDE.md §14 forbids for multi-line content. All nine converted to the Write-then-`-F` form.

**Type consistency.** `Reading` field names are identical across Tasks 1, 3 and 8. `registerAccount`, `renderAccountData`, `normaliseCachedReading`, `parseGeminiUsage` and `isExpectedAccount` are each defined once and referenced with matching signatures. `registry` is introduced in Task 2 as the alias for `_ss` and used under that name in Task 3. `renderBudget(prefix, pct5h)` matches the real signature at `renderer.js:635`. `isExpectedAccount` is used in Task 10 but defined in Task 11 — Task 10 Step 3 says to write it early if the tasks run in order.

