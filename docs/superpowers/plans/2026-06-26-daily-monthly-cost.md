# Per-Day / Per-Month API-Equivalent Cost (Claude Code + Codex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-day and per-month API-equivalent cost (headline avg/day + projected/month, a 30-day per-day bar list, and a 3-month totals table) for both Claude Code and Codex, pricing exact tokens read from each tool's local logs.

**Architecture:** Add OpenAI model prices and two pure cost-bucketing functions to `metrics.js`; add a `read-codex-usage` IPC that parses `~/.codex/sessions/**/*.jsonl` into the existing entry shape; make the analytics Cost section provider-agnostic so the same total / per-model / over-time rendering runs for `codex` and `claude-vscode`.

**Tech Stack:** Electron (main + preload + renderer), vanilla JS, `node --test` for unit tests. No new dependencies.

## Global Constraints

- `metrics.js` is pure and dual-loaded (browser `<script>` global + CommonJS `module.exports` footer). **No `Date.now()` and no argless `new Date()`** in `metrics.js`. `new Date(isoString)` (with an argument) is allowed.
- No new npm dependencies.
- Currency conversion happens **only** in the renderer via `fmtMoneyUsd(usd)` = `curSymbol + (usd*usdRate).toFixed(2)`. `metrics.js` totals stay USD.
- Tests run with `npm test` (`node --test`); test files live in `test/` and `require('../metrics.js')`.
- Verify each JS change parses with `node --check <file>`.
- Every new public `metrics.js` function must be added to the `module.exports` list at the file footer.

---

### Task 1: OpenAI model prices + `modelFamily` mapping

**Files:**
- Modify: `metrics.js` (FAMILY_PRICES ~line 126, `modelFamily` ~line 136, exports footer ~line 203)
- Test: `test/metrics.test.js`

**Interfaces:**
- Consumes: existing `entryCost(e)`, `summarizeCost(entries)`, `CACHE_READ_MULT` (0.1).
- Produces: `FAMILY_PRICES` gains keys `'GPT-5.5'`, `'GPT-5.4'`, `'GPT-5.4-mini'`, `'GPT-5.4-nano'`; `modelFamily(model)` maps gpt slugs to those keys (or `null` for `spark`/unknown). `entryCost`/`summarizeCost` are unchanged and now price OpenAI-family entries.

- [ ] **Step 1: Write the failing test**

Add to `test/metrics.test.js`:

```javascript
const { modelFamily, entryCost } = require('../metrics.js');

test('modelFamily maps OpenAI slugs, longest-match first', () => {
  assert.equal(modelFamily('gpt-5.5'), 'GPT-5.5');
  assert.equal(modelFamily('gpt-5.4'), 'GPT-5.4');
  assert.equal(modelFamily('gpt-5.4-mini'), 'GPT-5.4-mini');
  assert.equal(modelFamily('gpt-5.4-nano'), 'GPT-5.4-nano');
  assert.equal(modelFamily('gpt-5.3-codex-spark'), null); // unpriced
  assert.equal(modelFamily('opus-4-8'), 'Opus');           // existing still works
});

test('entryCost prices a normalized OpenAI entry (cache read at 10%)', () => {
  // non-cached input 1M @2.5, output 1M @15, cache_read 1M @ 2.5*0.1
  const e = { model: 'gpt-5.4', input_tokens: 1_000_000, output_tokens: 1_000_000,
              cache_creation: 0, cache_read: 1_000_000 };
  assert.ok(Math.abs(entryCost(e) - 17.75) < 1e-9); // 2.5 + 15 + 0.25
});

test('entryCost returns null for unpriced spark model', () => {
  assert.equal(entryCost({ model: 'gpt-5.3-codex-spark', output_tokens: 1_000_000 }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the three new tests FAIL (`modelFamily('gpt-5.5')` returns `null`, so `entryCost` is `null` not `17.75`).

- [ ] **Step 3: Add the OpenAI prices**

In `metrics.js`, replace the `FAMILY_PRICES` object (lines ~126-131) with:

```javascript
const FAMILY_PRICES = {
  Opus:   { in: 5,  out: 25 },
  Sonnet: { in: 3,  out: 15 },
  Haiku:  { in: 1,  out: 5  },
  Fable:  { in: 10, out: 50 },
  'GPT-5.5':      { in: 5,    out: 30   },
  'GPT-5.4':      { in: 2.5,  out: 15   },
  'GPT-5.4-mini': { in: 0.75, out: 4.5  },
  'GPT-5.4-nano': { in: 0.2,  out: 1.25 },
};
```

- [ ] **Step 4: Extend `modelFamily`**

Replace the `modelFamily` function (lines ~136-143) with:

```javascript
function modelFamily(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('fable')) return 'Fable';
  // OpenAI / Codex — check longer/cheaper slugs first so they win.
  if (m.includes('nano')) return 'GPT-5.4-nano';
  if (m.includes('mini')) return 'GPT-5.4-mini';
  if (m.includes('gpt-5.5')) return 'GPT-5.5';
  if (m.includes('gpt-5.4')) return 'GPT-5.4';
  return null; // includes gpt-5.3-codex-spark and any unknown model
}
```

- [ ] **Step 5: Export `modelFamily`**

`modelFamily` is currently private. In the footer `module.exports = { ... }` (line ~203), add `modelFamily,` to the list so the test can import it. (Leave all existing exports.)

- [ ] **Step 6: Run tests + check**

Run: `npm test` → Expected: PASS (all, including the 3 new).
Run: `node --check metrics.js` → Expected: no output (valid).

- [ ] **Step 7: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): add OpenAI model prices and gpt-slug modelFamily mapping"
```

---

### Task 2: `costByDay` pure function

**Files:**
- Modify: `metrics.js` (add after `summarizeCost`, ~line 170; exports footer)
- Test: `test/metrics.test.js`

**Interfaces:**
- Consumes: `entryCost(e)`, entries shaped `{ timestamp, model, input_tokens, output_tokens, cache_creation, cache_read }`.
- Produces: `costByDay(entries)` → `{ 'YYYY-MM-DD': usdCost }` (local day; unpriced entries skipped).

- [ ] **Step 1: Write the failing test**

Add to `test/metrics.test.js` (note: timestamps use **no `Z`** so they parse as local time, making the date deterministic regardless of the runner's timezone):

```javascript
const { costByDay } = require('../metrics.js');

test('costByDay buckets cost by local calendar day, skipping unpriced', () => {
  const entries = [
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-01T10:00:00' }, // 15
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-01T20:00:00' }, // 15
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-02T09:00:00' }, // 15
    { model: 'spark',   output_tokens: 9_000_000, timestamp: '2026-06-02T09:30:00' }, // unpriced
  ];
  const by = costByDay(entries);
  assert.ok(Math.abs(by['2026-06-01'] - 30) < 1e-9);
  assert.ok(Math.abs(by['2026-06-02'] - 15) < 1e-9);
  assert.equal(Object.keys(by).length, 2);
});

test('costByDay returns {} for empty input', () => {
  assert.deepEqual(costByDay([]), {});
  assert.deepEqual(costByDay(undefined), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `costByDay is not a function`.

- [ ] **Step 3: Implement**

In `metrics.js`, add after `summarizeCost` (and before the exports footer):

```javascript
// Local-calendar-day key 'YYYY-MM-DD' from an ISO timestamp. Uses new Date(arg)
// (allowed) — never Date.now()/argless new Date().
function dayKey(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function costByDay(entries) {
  const out = {};
  for (const e of (entries || [])) {
    const c = entryCost(e);
    if (c == null) continue;
    const k = dayKey(e.timestamp);
    if (!k) continue;
    out[k] = (out[k] || 0) + c;
  }
  return out;
}
```

- [ ] **Step 4: Export `costByDay`**

Add `costByDay,` to the `module.exports` list in the footer.

- [ ] **Step 5: Run tests + check**

Run: `npm test` → Expected: PASS.
Run: `node --check metrics.js` → Expected: valid.

- [ ] **Step 6: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): add costByDay (USD cost bucketed by local day)"
```

---

### Task 3: `costByMonth` pure function

**Files:**
- Modify: `metrics.js` (add next to `costByDay`; exports footer)
- Test: `test/metrics.test.js`

**Interfaces:**
- Consumes: `entryCost(e)`, the same entry shape, and the `dayKey` neighbor (re-uses the same parsing approach via a `monthKey` helper).
- Produces: `costByMonth(entries)` → `{ 'YYYY-MM': usdCost }` (local month; unpriced skipped).

- [ ] **Step 1: Write the failing test**

Add to `test/metrics.test.js`:

```javascript
const { costByMonth } = require('../metrics.js');

test('costByMonth aggregates days within a month and separates months', () => {
  const entries = [
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-05-31T10:00:00' }, // 15 (May)
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-01T10:00:00' }, // 15 (Jun)
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-20T10:00:00' }, // 15 (Jun)
  ];
  const by = costByMonth(entries);
  assert.ok(Math.abs(by['2026-05'] - 15) < 1e-9);
  assert.ok(Math.abs(by['2026-06'] - 30) < 1e-9);
});

test('sum of costByDay within a month equals costByMonth for that month', () => {
  const entries = [
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-01T10:00:00' },
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-02T10:00:00' },
    { model: 'gpt-5.4', output_tokens: 1_000_000, timestamp: '2026-06-02T18:00:00' },
  ];
  const days = costByDay(entries);
  const monthSumFromDays = Object.entries(days)
    .filter(([k]) => k.startsWith('2026-06'))
    .reduce((a, [, v]) => a + v, 0);
  assert.ok(Math.abs(monthSumFromDays - costByMonth(entries)['2026-06']) < 1e-9);
});

test('costByMonth returns {} for empty input', () => {
  assert.deepEqual(costByMonth([]), {});
});
```

(`costByDay` is already imported from Task 2 — reuse that import; do not redeclare it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `costByMonth is not a function`.

- [ ] **Step 3: Implement**

In `metrics.js`, add next to `costByDay`:

```javascript
function monthKey(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}

function costByMonth(entries) {
  const out = {};
  for (const e of (entries || [])) {
    const c = entryCost(e);
    if (c == null) continue;
    const k = monthKey(e.timestamp);
    if (!k) continue;
    out[k] = (out[k] || 0) + c;
  }
  return out;
}
```

- [ ] **Step 4: Export `costByMonth`**

Add `costByMonth,` to the `module.exports` list.

- [ ] **Step 5: Run tests + check**

Run: `npm test` → Expected: PASS.
Run: `node --check metrics.js` → Expected: valid.

- [ ] **Step 6: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): add costByMonth + costByDay/costByMonth consistency"
```

---

### Task 4: `normalizeCodexTokenUsage` pure helper

**Files:**
- Modify: `metrics.js` (add near the cost helpers; exports footer)
- Test: `test/metrics.test.js`

**Interfaces:**
- Consumes: nothing (pure transform).
- Produces: `normalizeCodexTokenUsage(u, model, timestamp)` → entry `{ timestamp, model, input_tokens, output_tokens, cache_creation: 0, cache_read }` or `null` when `u` is falsy. `input_tokens` is non-cached input (`input_tokens - cached_input_tokens`); `cache_read` is `cached_input_tokens`; `output_tokens` passes through (it already includes reasoning tokens). Used by Task 5's IPC handler.

- [ ] **Step 1: Write the failing test**

Add to `test/metrics.test.js`:

```javascript
const { normalizeCodexTokenUsage, entryCost: _ec } = require('../metrics.js');

test('normalizeCodexTokenUsage splits cached input and zeroes cache_creation', () => {
  const u = { input_tokens: 76414, cached_input_tokens: 75648, output_tokens: 704,
              reasoning_output_tokens: 458, total_tokens: 77118 };
  const e = normalizeCodexTokenUsage(u, 'gpt-5.5', '2026-06-25T12:46:39.043Z');
  assert.equal(e.timestamp, '2026-06-25T12:46:39.043Z');
  assert.equal(e.model, 'gpt-5.5');
  assert.equal(e.input_tokens, 766);   // 76414 - 75648
  assert.equal(e.cache_read, 75648);
  assert.equal(e.cache_creation, 0);
  assert.equal(e.output_tokens, 704);
  assert.ok(_ec(e) > 0);               // priceable via gpt-5.5
});

test('normalizeCodexTokenUsage handles missing fields and falsy input', () => {
  assert.equal(normalizeCodexTokenUsage(null, 'gpt-5.5', 't'), null);
  const e = normalizeCodexTokenUsage({}, undefined, 't');
  assert.equal(e.input_tokens, 0);
  assert.equal(e.cache_read, 0);
  assert.equal(e.model, 'unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `normalizeCodexTokenUsage is not a function`.

- [ ] **Step 3: Implement**

In `metrics.js`, add near the cost helpers:

```javascript
// Convert a Codex `last_token_usage` object into the standard entry shape.
// Codex input_tokens INCLUDES cached_input_tokens; OpenAI does not bill cache
// writes (cache_creation = 0); output_tokens already includes reasoning tokens.
function normalizeCodexTokenUsage(u, model, timestamp) {
  if (!u) return null;
  const input = u.input_tokens || 0;
  const cached = u.cached_input_tokens || 0;
  return {
    timestamp,
    model: model || 'unknown',
    input_tokens: Math.max(0, input - cached),
    output_tokens: u.output_tokens || 0,
    cache_creation: 0,
    cache_read: cached,
  };
}
```

- [ ] **Step 4: Export `normalizeCodexTokenUsage`**

Add `normalizeCodexTokenUsage,` to the `module.exports` list.

- [ ] **Step 5: Run tests + check**

Run: `npm test` → Expected: PASS.
Run: `node --check metrics.js` → Expected: valid.

- [ ] **Step 6: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): add normalizeCodexTokenUsage (Codex turn -> entry shape)"
```

---

### Task 5: `read-codex-usage` IPC + preload binding

**Files:**
- Modify: `main.js` (add a new `ipcMain.handle` after the `read-claude-code-usage` handler, ~line 153)
- Modify: `preload.js` (add binding next to `readClaudeCodeUsage`, ~line 13)

**Interfaces:**
- Consumes: `normalizeCodexTokenUsage` from `metrics.js` (require it at the top of `main.js` if not already required — check existing requires first; if `metrics.js` isn't required in `main.js`, add `const { normalizeCodexTokenUsage } = require('./metrics.js');`).
- Produces: IPC `read-codex-usage` → `{ entries: [...] }` (each entry the standard shape) or `{ error }`. `preload.js` exposes `electronAPI.readCodexUsage()`.

- [ ] **Step 1: Confirm metrics require in main.js**

Run: `grep -n "require('./metrics" main.js` (PowerShell: `Select-String "require\('./metrics" main.js`).
- If it prints a line, note the destructured names and add `normalizeCodexTokenUsage` to that destructure.
- If it prints nothing, you'll add a fresh `const { normalizeCodexTokenUsage } = require('./metrics.js');` near the other top-of-file requires (next to `const os = require('os')` / `const fs = require('fs')` / `const path = require('path')`).

- [ ] **Step 2: Add the IPC handler**

In `main.js`, immediately after the `ipcMain.handle('read-claude-code-usage', ...)` handler closes (the `});` near line 153), add:

```javascript
// Codex writes exact per-turn token usage to local session logs. Each turn emits
// an event_msg with payload.type === 'token_count' (info.last_token_usage = the
// per-turn delta); the active model comes from the preceding turn_context event.
ipcMain.handle('read-codex-usage', async () => {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');

  const jsonlFiles = [];
  function scanDir(dir) {
    try {
      const dirents = fs.readdirSync(dir, { withFileTypes: true });
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) scanDir(full);
        else if (d.name.endsWith('.jsonl')) jsonlFiles.push(full);
      }
    } catch {}
  }

  try {
    if (!fs.existsSync(sessionsDir)) return { entries: [] };
    scanDir(sessionsDir);
  } catch (e) {
    return { error: e.message };
  }

  const entries = [];
  for (const file of jsonlFiles) {
    let currentModel = 'unknown';
    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'turn_context' && obj.payload && obj.payload.model) {
          currentModel = obj.payload.model;
        } else if (
          obj.type === 'event_msg' &&
          obj.payload && obj.payload.type === 'token_count' &&
          obj.payload.info && obj.payload.info.last_token_usage &&
          obj.timestamp
        ) {
          const e = normalizeCodexTokenUsage(
            obj.payload.info.last_token_usage, currentModel, obj.timestamp);
          if (e) entries.push(e);
        }
      }
    } catch {}
  }

  return { entries };
});
```

- [ ] **Step 3: Add the preload binding**

In `preload.js`, next to the `readClaudeCodeUsage` line (~13), add:

```javascript
  readCodexUsage: () => ipcRenderer.invoke('read-codex-usage'),
```

- [ ] **Step 4: Syntax check**

Run: `node --check main.js` and `node --check preload.js`
Expected: both valid (no output).

- [ ] **Step 5: Smoke-test the parser against real logs**

Create a throwaway script `tmp-codex-smoke.js` at the repo root:

```javascript
const os = require('os'), fs = require('fs'), path = require('path');
const { normalizeCodexTokenUsage, summarizeCost, costByMonth } = require('./metrics.js');
const dir = path.join(os.homedir(), '.codex', 'sessions');
const files = [];
(function scan(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})){ const f=path.join(d,e.name); e.isDirectory()?scan(f):e.name.endsWith('.jsonl')&&files.push(f);} })(dir);
const entries = [];
for (const file of files) { let model='unknown';
  for (const line of fs.readFileSync(file,'utf8').split('\n')) { if(!line.trim())continue; let o; try{o=JSON.parse(line)}catch{continue}
    if(o.type==='turn_context'&&o.payload&&o.payload.model) model=o.payload.model;
    else if(o.type==='event_msg'&&o.payload&&o.payload.type==='token_count'&&o.payload.info&&o.payload.info.last_token_usage&&o.timestamp){ const e=normalizeCodexTokenUsage(o.payload.info.last_token_usage,model,o.timestamp); if(e)entries.push(e);} } }
console.log('files', files.length, 'entries', entries.length);
console.log('total USD', summarizeCost(entries).total.toFixed(2));
console.log('byMonth', costByMonth(entries));
```

Run: `node tmp-codex-smoke.js`
Expected: non-zero `files` and `entries`, a plausible positive `total USD`, and a `byMonth` map with recent `YYYY-MM` keys. (Sanity only — exact numbers will vary.)

- [ ] **Step 6: Remove the smoke script**

```bash
rm tmp-codex-smoke.js
```

- [ ] **Step 7: Commit**

```bash
git add main.js preload.js
git commit -m "feat(main): read-codex-usage IPC parsing local Codex session token logs"
```

---

### Task 6: Make the Cost section provider-agnostic

**Files:**
- Modify: `analytics-renderer.js` (`renderCost`, lines ~705-735)

**Interfaces:**
- Consumes: `electronAPI.readCodexUsage()` (Task 5), existing `readClaudeCodeUsage()`, `summarizeCost`, `FAMILY_PRICES`, `fmtMoneyUsd`, `windowCutoffMs`, `windowLabel`, `fmtTokens`, `esc`.
- Produces: `renderCost` loads token entries for both `codex` and `claude-vscode`, renders the same total / per-model / cache-savings UI for both, and removes the Codex "not available" note. Keeps the "not available" note for any other account (Claude Desktop). Leaves a single insertion point `<div id="cost-over-time"></div>` between Part A and `#cost-compare` for Task 7.

- [ ] **Step 1: Replace `renderCost`**

Replace the whole `renderCost` function (lines ~705-735) with:

```javascript
// Accounts with exact local token logs we can price.
const TOKEN_LOADERS = {
  'claude-vscode': () => window.electronAPI.readClaudeCodeUsage(),
  'codex':         () => window.electronAPI.readCodexUsage(),
};
const TOKEN_SOURCE_LABEL = {
  'claude-vscode': 'Claude Code token data',
  'codex':         'Codex token data',
};

async function renderCost(container) {
  let partA = '';
  let overTimeEntries = null; // full (unfiltered) entries for the over-time block
  const loader = TOKEN_LOADERS[currentAccount];

  if (loader) {
    const res = await loader();
    if (!res || res.error) {
      partA = `<div class="cost-sub">Could not read ${esc(TOKEN_SOURCE_LABEL[currentAccount])}: ${esc((res && res.error) || 'unknown error')}</div>`;
    } else {
      const all = res.entries || [];
      overTimeEntries = all;
      const cutoff = windowCutoffMs();
      const toks = all.filter(e => cutoff == null || new Date(e.timestamp).getTime() >= cutoff);
      const c = summarizeCost(toks);
      const rows = Object.keys(FAMILY_PRICES).filter(fam => c.byModel[fam]).map(fam => {
        const v = c.byModel[fam];
        return `<tr><td>${fam}</td><td>${fmtTokens(v.tokens)}</td><td>${fmtMoneyUsd(v.cost)}</td></tr>`;
      }).join('');
      partA = `
        <div class="cost-headline">≈ ${fmtMoneyUsd(c.total)} of API usage · ${windowLabel()}</div>
        <div class="cost-sub">estimate — what this usage would cost on the pay-as-you-go API</div>
        ${rows ? `<table class="cost-table"><thead><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No token data in this window.</div>'}
        ${c.cacheSavings > 0 ? `<div class="cost-sub">cache reads saved ≈ ${fmtMoneyUsd(c.cacheSavings)} vs uncached</div>` : ''}
        ${c.unpriced ? `<div class="cost-sub">unpriced: ${c.unpriced} turns (unknown model)</div>` : ''}
      `;
    }
  } else {
    partA = `<div class="cost-sub">Token-level cost isn't available for this account — Claude Desktop exposes only rate-limit %.</div>`;
  }

  container.innerHTML = `<div class="section-head">Cost (estimates)</div>${partA}<div id="cost-over-time"></div><div id="cost-compare"></div>`;
  renderCostOverTime(container.querySelector('#cost-over-time'), overTimeEntries);
  await renderCostCompare(container.querySelector('#cost-compare'));
}
```

- [ ] **Step 2: Add a temporary no-op `renderCostOverTime`**

So the file runs before Task 7. Add directly above `renderCost`:

```javascript
function renderCostOverTime(el, entries) { /* implemented in next task */ }
```

- [ ] **Step 3: Syntax check**

Run: `node --check analytics-renderer.js`
Expected: valid.

- [ ] **Step 4: Manual smoke**

Run: `npm start`. Open analytics. On the **Codex** tab, the Cost section now shows a total, per-model rows (gpt-5.5 etc.), and the "unpriced turns" note for spark — not the old "not available" message. On **Claude Code** it is unchanged. Close the app.

- [ ] **Step 5: Commit**

```bash
git add analytics-renderer.js
git commit -m "feat(analytics): provider-agnostic Cost section (Codex now priced)"
```

---

### Task 7: "Cost over time" block (headline rates, 30-day bars, 3-month table)

**Files:**
- Modify: `analytics-renderer.js` (replace the no-op `renderCostOverTime` from Task 6)
- Modify: `analytics.html` (add CSS for the over-time block)

**Interfaces:**
- Consumes: `costByDay`, `costByMonth` (metrics globals, already loaded via `<script>` before `analytics-renderer.js`), `fmtMoneyUsd`, `esc`, and the full `entries` array passed in by `renderCost`.
- Produces: renders into `#cost-over-time` — headline avg/day + projected/month, a 30-day per-day bar list (reusing `.peak-bars`/`.peak-bar`), and a 3-month totals table. No-op when `entries` is null/empty.

- [ ] **Step 1: Implement `renderCostOverTime`**

Replace the no-op `renderCostOverTime` (from Task 6) with:

```javascript
// Per-day / per-month API-equivalent cost. Independent of the time-window
// dropdown (uses full history); figures labeled "last 30 days" / "this month".
function renderCostOverTime(el, entries) {
  if (!el) return;
  if (!entries || !entries.length) { el.innerHTML = ''; return; }

  const byDay = costByDay(entries);      // { 'YYYY-MM-DD': usd }
  const byMonth = costByMonth(entries);  // { 'YYYY-MM': usd }

  // Build the last 30 local calendar days, oldest → newest.
  const today = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ key, usd: byDay[key] || 0 });
  }
  const total30 = days.reduce((a, d) => a + d.usd, 0);
  const avgPerDay = total30 / 30;
  const projected = avgPerDay * 30;
  const maxUsd = Math.max(0, ...days.map(d => d.usd));

  const bars = days.map(d => {
    const h = maxUsd > 0 ? Math.max(2, Math.round((d.usd / maxUsd) * 100)) : 2;
    const isMax = maxUsd > 0 && d.usd === maxUsd;
    const color = isMax ? 'var(--amber)' : 'var(--green)';
    return `<div class="peak-bar" title="${esc(d.key)} · ${fmtMoneyUsd(d.usd)}" style="height:${h}%;background:${color}"></div>`;
  }).join('');

  // Last 3 local calendar months, oldest → newest; current month marked.
  const monthRows = [];
  const curMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  for (let i = 2; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleString(undefined, { month: 'short', year: 'numeric' });
    const suffix = key === curMonthKey ? ' (so far)' : '';
    monthRows.push(`<tr><td>${esc(label)}${suffix}</td><td>${fmtMoneyUsd(byMonth[key] || 0)}</td></tr>`);
  }

  el.innerHTML = `
    <div class="cost-rate">≈ ${fmtMoneyUsd(avgPerDay)}/day · ~${fmtMoneyUsd(projected)}/mo at this pace</div>
    <div class="cost-sub">estimate from the last 30 days of token usage</div>
    <div class="eff-cap">Cost per day · last 30 days</div>
    <div class="peak-bars">${bars}</div>
    <table class="cost-table"><thead><tr><th>Month</th><th>Cost</th></tr></thead><tbody>${monthRows.join('')}</tbody></table>
  `;
}
```

- [ ] **Step 2: Add CSS**

In `analytics.html`, find the existing `.cost-headline` / `.cost-sub` style rules and add nearby:

```css
.cost-rate { font-size: 15px; font-weight: 600; margin: 10px 0 2px; color: var(--text); }
```

(The `.peak-bars`, `.peak-bar`, `.eff-cap`, `.cost-table`, `.cost-sub` classes already exist and are reused.)

- [ ] **Step 3: Syntax check**

Run: `node --check analytics-renderer.js`
Expected: valid.

- [ ] **Step 4: Manual verification**

Run: `npm start`. Open analytics:
- **Codex** tab Cost section shows: `≈ £X/day · ~£Y/mo at this pace`, a 30-day bar row (tallest day amber, hover shows date + £), and a 3-month table with the current month "(so far)".
- **Claude Code** tab shows the same block with its own numbers.
- Open Settings, change the USD→currency rate; the analytics Cost figures update live (via `onSettingsChanged` → `renderAll`).
- **Claude Desktop** tab still shows "Token-level cost isn't available…" and no over-time block.
Close the app.

- [ ] **Step 5: Commit**

```bash
git add analytics-renderer.js analytics.html
git commit -m "feat(analytics): per-day/month cost over-time block (rates, 30d bars, 3mo table)"
```

---

## Notes for the implementer

- Run the whole suite (`npm test`) after Tasks 1-4; all prior tests plus the new ones must stay green.
- The `metrics.js` `<script>` tag is loaded in `analytics.html` before `analytics-renderer.js`, so `costByDay`/`costByMonth` are available as globals in the renderer (no import needed there).
- Timezone: tests deliberately use timestamps without a trailing `Z` so `new Date(...)` parses them as local time and the day/month keys are deterministic on any runner.
- Do not change `entryCost`/`summarizeCost` math — Codex entries are normalized into the shape they already expect.
