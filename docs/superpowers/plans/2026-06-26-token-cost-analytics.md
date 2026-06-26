# Token & Cost Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cost section to the Analytics window — API-equivalent dollars for Claude Code (from token logs) plus a cross-account subscription-value comparison driven by user-supplied plan prices.

**Architecture:** Pure cost/active-usage functions in `metrics.js` (priced by model family; subscription cost prorated over the data span). `analytics-renderer.js` gains a `renderCost` section: Part A prices the Claude Code token log (`readClaudeCodeUsage`), Part B compares all three accounts' active usage with editable `$/mo` inputs persisted via `saveSettings`. Everything is labeled an estimate.

**Tech Stack:** Vanilla JS classic `<script>` files, Electron renderer (analytics window: `contextIsolation: true`, uses `window.electronAPI`), Node's built-in `node --test`. No new dependencies.

## Global Constraints

- **No new npm dependencies.** Tests use `node:test` / `node:assert`.
- **`metrics.js` stays dual-load** (browser `<script>` globals + `require`): keep the `if (typeof module !== 'undefined' && module.exports)` footer; no `import`/ESM; no top-level `require`.
- **`metrics.js` functions stay pure** — no `Date.now()` / argless `new Date()` inside the module.
- **Pricing (per 1M tokens), as named constants:** Opus in 5 / out 25; Sonnet 3 / 15; Haiku 1 / 5; Fable 10 / 50. Cache write ×1.25, cache read ×0.1 (5-minute ephemeral; the data records no TTL, so assume 5-minute).
- **No `main.js` / `preload.js` / IPC changes** — `readClaudeCodeUsage`, `readUsageLog`, `getSettings`, `saveSettings` already exist on `window.electronAPI`.
- **Settings:** new `planPrices` key `{ [account]: number }` (USD/month). `saveSettings` merges shallowly in main, so always send the **whole** `planPrices` object.
- **Everything is an estimate** — label the section "Cost (estimates)"; never present a figure as a bill. Codex/Claude Desktop have no token data — never fabricate Codex tokens.
- **Accounts:** `codex`, `claude-desktop`, `claude-vscode`. API-equivalent $ is Claude-Code-only.

---

### Task 1: Cost & subscription-value functions in `metrics.js`

**Files:**
- Modify: `metrics.js`
- Modify: `test/metrics.test.js`

**Interfaces:**
- Consumes: `ACTIVE_GAP_MAX`, `segmentCycles` (existing in module).
- Produces:
  - `entryCost(e) -> number | null` — `$` for one token entry `{model, input_tokens, output_tokens, cache_creation, cache_read}`; `null` if the model isn't a known family.
  - `summarizeCost(entries) -> { total, byModel, unpriced, cacheSavings }` — `byModel` keyed by family (`'Opus'|'Sonnet'|'Haiku'|'Fable'`) → `{ tokens, cost }`.
  - `activeMs(snapshots, win) -> number` — active-usage ms (positive drops with gap `< ACTIVE_GAP_MAX`).
  - `subscriptionValue(snapshots, monthlyPrice, win) -> null | { activeHours, windows, attributedCost, perActiveHour, perWindow }`.
  - Constants `FAMILY_PRICES`, `CACHE_WRITE_MULT`, `CACHE_READ_MULT`, `MONTH_MS`.

- [ ] **Step 1: Write the failing tests**

Append to `test/metrics.test.js`:

```js
const { entryCost, summarizeCost, activeMs, subscriptionValue } = require('../metrics.js');

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('entryCost prices each component by model family', () => {
  approx(entryCost({ model: 'claude-opus-4-8', input_tokens: 1_000_000 }), 5);
  approx(entryCost({ model: 'claude-opus-4-8', output_tokens: 1_000_000 }), 25);
  approx(entryCost({ model: 'claude-opus-4-8', cache_creation: 1_000_000 }), 6.25); // 5 × 1.25
  approx(entryCost({ model: 'claude-opus-4-8', cache_read: 1_000_000 }), 0.5);      // 5 × 0.1
  approx(entryCost({ model: 'claude-sonnet-4-6', output_tokens: 1_000_000 }), 15);
  assert.equal(entryCost({ model: 'something-unknown', input_tokens: 1_000_000 }), null);
});

test('summarizeCost aggregates totals, families, unpriced, and cache savings', () => {
  const entries = [
    { model: 'claude-opus-4-8', input_tokens: 1_000_000 },                 // $5  Opus
    { model: 'claude-sonnet-4-6', output_tokens: 1_000_000 },              // $15 Sonnet
    { model: 'unknown', input_tokens: 1_000_000 },                        // unpriced
    { model: 'claude-opus-4-8', cache_read: 1_000_000 },                   // $0.5 Opus; saves 5×0.9
  ];
  const s = summarizeCost(entries);
  approx(s.total, 20.5);
  assert.equal(s.unpriced, 1);
  approx(s.cacheSavings, 4.5);
  approx(s.byModel.Opus.cost, 5.5);
  assert.equal(s.byModel.Opus.tokens, 2_000_000);
  approx(s.byModel.Sonnet.cost, 15);
});

test('activeMs sums active drops and excludes idle gaps and resets', () => {
  const snaps = [
    { ts: '2026-06-25T09:00:00Z', '5h': 100 },
    { ts: '2026-06-25T09:05:00Z', '5h': 90 },  // active 5min
    { ts: '2026-06-25T11:00:00Z', '5h': 80 },  // 115min gap → idle, excluded
    { ts: '2026-06-25T11:05:00Z', '5h': 70 },  // active 5min
    { ts: '2026-06-25T11:10:00Z', '5h': 100 }, // reset → excluded
  ];
  assert.equal(activeMs(snaps, '5h'), 600_000); // 2 × 5min
});

test('subscriptionValue prorates monthly price over the data span', () => {
  const snaps = [
    { ts: '2026-06-01T00:00:00Z', '5h': 100 },
    { ts: '2026-06-01T00:05:00Z', '5h': 90 },  // active 5min
    { ts: '2026-06-02T00:00:00Z', '5h': 80 },  // ~24h gap → idle
  ];
  const v = subscriptionValue(snaps, 30, '5h'); // span 24h, price $30/mo
  approx(v.attributedCost, 1);                   // 30 × (1 day / 30 days)
  approx(v.activeHours, 5 / 60);
  approx(v.perActiveHour, 12);
  assert.equal(v.windows, 2);                    // long gap splits the cycle
  assert.equal(subscriptionValue(snaps, 0, '5h'), null);          // no price
  assert.equal(subscriptionValue([snaps[0]], 30, '5h'), null);    // < 2 points
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `entryCost is not a function`.

- [ ] **Step 3: Add the implementation**

Insert into `metrics.js` after `monthBurnGrid` (before the footer):

```js
// ── Cost (estimates) ───────────────────────────────────────────────────────
const FAMILY_PRICES = {
  Opus:   { in: 5,  out: 25 },
  Sonnet: { in: 3,  out: 15 },
  Haiku:  { in: 1,  out: 5  },
  Fable:  { in: 10, out: 50 },
};
const CACHE_WRITE_MULT = 1.25;          // 5-minute ephemeral cache write
const CACHE_READ_MULT = 0.1;            // cache read
const MONTH_MS = 30 * 86_400_000;

function modelFamily(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('fable')) return 'Fable';
  return null;
}

function entryCost(e) {
  const fam = modelFamily(e.model);
  if (!fam) return null;
  const p = FAMILY_PRICES[fam];
  return (
    (e.input_tokens || 0) * p.in +
    (e.output_tokens || 0) * p.out +
    (e.cache_creation || 0) * p.in * CACHE_WRITE_MULT +
    (e.cache_read || 0) * p.in * CACHE_READ_MULT
  ) / 1_000_000;
}

function summarizeCost(entries) {
  const byModel = {};
  let total = 0, unpriced = 0, cacheSavings = 0;
  for (const e of entries) {
    const fam = modelFamily(e.model);
    if (!fam) { unpriced++; continue; }
    const p = FAMILY_PRICES[fam];
    const cost = entryCost(e);
    total += cost;
    cacheSavings += (e.cache_read || 0) * p.in * (1 - CACHE_READ_MULT) / 1_000_000;
    if (!byModel[fam]) byModel[fam] = { tokens: 0, cost: 0 };
    byModel[fam].tokens += (e.input_tokens || 0) + (e.output_tokens || 0)
      + (e.cache_creation || 0) + (e.cache_read || 0);
    byModel[fam].cost += cost;
  }
  return { total, byModel, unpriced, cacheSavings };
}

function activeMs(snapshots, win) {
  const pts = snapshots.filter(s => s && s[win] != null);
  let ms = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = new Date(pts[i].ts) - new Date(pts[i - 1].ts);
    const drop = pts[i - 1][win] - pts[i][win];
    if (drop > 0 && dt < ACTIVE_GAP_MAX) ms += dt;
  }
  return ms;
}

function subscriptionValue(snapshots, monthlyPrice, win) {
  const pts = snapshots.filter(s => s && s[win] != null);
  if (pts.length < 2 || !monthlyPrice) return null;
  const spanMs = new Date(pts[pts.length - 1].ts) - new Date(pts[0].ts);
  const activeHours = activeMs(snapshots, win) / 3_600_000;
  const windows = segmentCycles(snapshots, win).length;
  const attributedCost = monthlyPrice * (spanMs / MONTH_MS);
  return {
    activeHours,
    windows,
    attributedCost,
    perActiveHour: activeHours > 0 ? attributedCost / activeHours : null,
    perWindow: windows > 0 ? attributedCost / windows : null,
  };
}
```

Update the footer `module.exports` to add the new exports (keep all existing ones; `modelFamily` stays private):

```js
  module.exports = { RESET_JUMP_MIN, RESET_ADVANCE_MIN, ACTIVE_GAP_MAX, segmentCycles, cycleStats, summarize, hourlyBurn, monthBurnGrid, entryCost, summarizeCost, activeMs, subscriptionValue, FAMILY_PRICES, CACHE_WRITE_MULT, CACHE_READ_MULT, MONTH_MS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 15 prior + 4 new = 19 tests.

- [ ] **Step 5: Commit**

```bash
git add metrics.js test/metrics.test.js
git commit -m "feat(metrics): API-equivalent cost + subscription-value functions"
```

---

### Task 2: Cost section Part A — API-equivalent cost (Claude Code)

**Files:**
- Modify: `analytics-renderer.js` (helpers, `renderCost`, a `renderCostCompare` stub, `renderAll` wiring)
- Modify: `analytics.html` (CSS)

**Interfaces:**
- Consumes: `summarizeCost` (global from `metrics.js`); `window.electronAPI.readClaudeCodeUsage()` → `{ entries?: [...], error?: string }`; module state `currentAccount`, `windowHours`.
- Produces: `renderCost(container)` (async); shared helpers `windowCutoffMs()`, `windowLabel()`, `fmtTokens(n)`, `fmtMoney(n)`; a `renderCostCompare(el)` stub (Task 3 implements it) and the `#cost-compare` placeholder.

- [ ] **Step 1: Add shared helpers**

In `analytics-renderer.js`, after `fmtRate` (around line 49), add:

```js
function fmtMoney(n) { return '$' + (n || 0).toFixed(2); }
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n || 0);
}
function windowCutoffMs() { return windowHours > 0 ? Date.now() - windowHours * 3_600_000 : null; }
function windowLabel() {
  if (windowHours === 0) return 'all time';
  if (windowHours % 24 === 0) return `last ${windowHours / 24}d`;
  return `last ${windowHours}h`;
}
```

- [ ] **Step 2: Add `renderCost` and a `renderCostCompare` stub**

In `analytics-renderer.js`, insert after `renderEfficiency` (and its helpers), before `renderAll`:

```js
// ── Cost (estimates) ───────────────────────────────────────────────────────
async function renderCost(container) {
  let partA;
  if (currentAccount === 'claude-vscode') {
    const res = await window.electronAPI.readClaudeCodeUsage();
    if (res && res.error) {
      partA = `<div class="cost-sub">Could not read Claude Code token data: ${res.error}</div>`;
    } else {
      const cutoff = windowCutoffMs();
      const toks = (res.entries || []).filter(e =>
        cutoff == null || new Date(e.timestamp).getTime() >= cutoff);
      const c = summarizeCost(toks);
      const rows = Object.keys(c.byModel).map(fam => {
        const v = c.byModel[fam];
        return `<tr><td>${fam}</td><td>${fmtTokens(v.tokens)}</td><td>${fmtMoney(v.cost)}</td></tr>`;
      }).join('');
      partA = `
        <div class="cost-headline">≈ ${fmtMoney(c.total)} of API usage · ${windowLabel()}</div>
        <div class="cost-sub">estimate — what this usage would cost on the pay-as-you-go API</div>
        ${rows ? `<table class="cost-table"><thead><tr><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No token data in this window.</div>'}
        ${c.cacheSavings > 0 ? `<div class="cost-sub">cache reads saved ≈ ${fmtMoney(c.cacheSavings)} vs uncached</div>` : ''}
        ${c.unpriced ? `<div class="cost-sub">unpriced: ${c.unpriced} turns (unknown model)</div>` : ''}
      `;
    }
  } else {
    partA = `<div class="cost-sub">Token-level cost isn't available for this account — Codex and Claude Desktop expose only rate-limit %.</div>`;
  }

  container.innerHTML = `<div class="section-head">Cost (estimates)</div>${partA}<div id="cost-compare"></div>`;
  await renderCostCompare(container.querySelector('#cost-compare'));
}

async function renderCostCompare(el) {
  if (!el) return;
  // Implemented in Task 3.
}
```

- [ ] **Step 3: Wire `renderCost` into `renderAll`**

In `renderAll` (the section-build block, ~lines 716–734), add a `costEl` between `effEl` and `chartEl`, and call `renderCost`. Replace:

```js
  // Build sections
  const statsEl = document.createElement('div');
  const effEl   = document.createElement('div');
  const chartEl = document.createElement('div');
  const tableEl = document.createElement('div');

  body.innerHTML = '';
  body.appendChild(statsEl);
  body.appendChild(effEl);
  body.appendChild(chartEl);
  body.appendChild(tableEl);

  // Efficiency reads the FULL log (all cycles), independent of the time-window filter.
  const allEntries = await window.electronAPI.readUsageLog(currentAccount, 0);

  renderStats(entries, statsEl);
  renderEfficiency(allEntries, effEl);
  renderChart(entries, chartEl);
  renderTable(entries, tableEl);
```

with:

```js
  // Build sections
  const statsEl = document.createElement('div');
  const effEl   = document.createElement('div');
  const costEl  = document.createElement('div');
  const chartEl = document.createElement('div');
  const tableEl = document.createElement('div');

  body.innerHTML = '';
  body.appendChild(statsEl);
  body.appendChild(effEl);
  body.appendChild(costEl);
  body.appendChild(chartEl);
  body.appendChild(tableEl);

  // Efficiency reads the FULL log (all cycles), independent of the time-window filter.
  const allEntries = await window.electronAPI.readUsageLog(currentAccount, 0);

  renderStats(entries, statsEl);
  renderEfficiency(allEntries, effEl);
  await renderCost(costEl);
  renderChart(entries, chartEl);
  renderTable(entries, tableEl);
```

- [ ] **Step 4: Add CSS for Part A**

In `analytics.html`, add inside the existing `<style>` block, before `</style>`:

```css
.cost-headline { font-size: 18px; font-weight: 600; color: #fff; margin: 6px 0 2px; }
.cost-sub { font-size: 11px; color: var(--text-mid); margin: 2px 0; }
.cost-table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.cost-table th, .cost-table td { text-align: left; padding: 3px 8px; border-bottom: 1px solid rgba(255,255,255,.06); }
.cost-table th { color: var(--text-mid); font-weight: 500; }
```

- [ ] **Step 5: Syntax-check and run tests**

Run: `node --check analytics-renderer.js && npm test`
Expected: `node --check` no output (exit 0); `npm test` shows 19 tests pass (metrics unchanged this task).

- [ ] **Step 6: Verify the wiring by reading**

Read back: `renderCost` is `await`ed in `renderAll` and appended between Efficiency and the chart; it emits `#cost-compare` and calls the `renderCostCompare` stub; Part A only calls `readClaudeCodeUsage` for `claude-vscode`; `summarizeCost`/`fmtMoney`/`fmtTokens`/`windowLabel` resolve. (No GUI here — this read-back is the verification.)

- [ ] **Step 7: Commit**

```bash
git add analytics-renderer.js analytics.html
git commit -m "feat(analytics): API-equivalent cost section for Claude Code"
```

---

### Task 3: Cost section Part B — cross-account subscription-value comparison

**Files:**
- Modify: `analytics-renderer.js` (implement `renderCostCompare`, add `ACCOUNT_LABELS`)
- Modify: `analytics.html` (CSS)

**Interfaces:**
- Consumes: `subscriptionValue`, `summarizeCost` (globals); `window.electronAPI.readUsageLog(account, 0)`, `readClaudeCodeUsage()`, `getSettings()`, `saveSettings(patch)`; helpers `windowCutoffMs`, `fmtMoney` from Task 2; `VALID_ACCOUNTS`.
- Produces: a working `renderCostCompare(el)` — a comparison table with editable `$/mo` inputs persisted to `settings.planPrices`, plus the Claude Code value ratio.

- [ ] **Step 1: Add account labels**

In `analytics-renderer.js`, just after the `VALID_ACCOUNTS` declaration (line 4), add:

```js
const ACCOUNT_LABELS = { codex: 'Codex', 'claude-desktop': 'Claude Desktop', 'claude-vscode': 'Claude Code' };
```

- [ ] **Step 2: Implement `renderCostCompare`**

Replace the `renderCostCompare` stub from Task 2 with:

```js
async function renderCostCompare(el) {
  if (!el) return;

  const settings = await window.electronAPI.getSettings();
  const planPrices = (settings && settings.planPrices) || {};
  const cutoff = windowCutoffMs();

  // Per-account subscription value over the selected window.
  const rows = [];
  for (const acct of VALID_ACCOUNTS) {
    let snaps = await window.electronAPI.readUsageLog(acct, 0);
    if (cutoff != null) snaps = snaps.filter(s => new Date(s.ts).getTime() >= cutoff);
    const price = planPrices[acct];
    rows.push({ acct, price, sv: subscriptionValue(snaps, price, '5h') });
  }

  // Best (lowest) value in each money column, among rows that have it.
  const bestOf = (key) => {
    const vals = rows.map(r => r.sv && r.sv[key]).filter(v => v != null && v > 0);
    return vals.length ? Math.min(...vals) : null;
  };
  const bestHr = bestOf('perActiveHour');
  const bestWin = bestOf('perWindow');
  const cell = (v, best) => v == null ? '—'
    : `<span class="${best != null && v === best ? 'best-value' : ''}">${fmtMoney(v)}</span>`;

  const tbody = rows.map(r => {
    const sv = r.sv;
    return `<tr>
      <td>${ACCOUNT_LABELS[r.acct]}</td>
      <td><input class="price-input" data-account="${r.acct}" type="number" min="0" step="1"
            value="${r.price != null ? r.price : ''}" placeholder="—"> /mo</td>
      <td>${sv ? sv.activeHours.toFixed(1) + 'h' : '—'}</td>
      <td>${sv ? sv.windows : '—'}</td>
      <td>${sv ? cell(sv.perActiveHour, bestHr) : '—'}</td>
      <td>${sv ? cell(sv.perWindow, bestWin) : '—'}</td>
    </tr>`;
  }).join('');

  // Claude Code value ratio: API-equivalent $ ÷ attributed subscription cost.
  let ratioLine = '';
  const cc = rows.find(r => r.acct === 'claude-vscode');
  if (cc && cc.sv && cc.sv.attributedCost > 0) {
    const res = await window.electronAPI.readClaudeCodeUsage();
    const toks = (res && res.entries || []).filter(e =>
      cutoff == null || new Date(e.timestamp).getTime() >= cutoff);
    const total = summarizeCost(toks).total;
    if (total > 0) {
      const ratio = total / cc.sv.attributedCost;
      ratioLine = `<div class="cost-headline">≈ ${ratio.toFixed(1)}× the subscription's worth in API-equivalent value <span class="cost-sub">(Claude Code)</span></div>`;
    }
  }

  el.innerHTML = `
    <div class="eff-sub">Subscription value — ${windowLabel()}</div>
    ${ratioLine}
    <table class="cost-table">
      <thead><tr><th>Account</th><th>Plan</th><th>Active</th><th>Windows</th><th>$/active-hr</th><th>$/window</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <div class="cost-sub">Subscription cost prorated over the data span (price × span ÷ 30 days). Figures are estimates and get noisier with little history.</div>
  `;

  el.querySelectorAll('.price-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const prices = {};
      el.querySelectorAll('.price-input').forEach(i => {
        const v = parseFloat(i.value);
        if (!isNaN(v) && v > 0) prices[i.dataset.account] = v;
      });
      window.electronAPI.saveSettings({ planPrices: prices });
      renderCostCompare(el);
    });
  });
}
```

- [ ] **Step 3: Add CSS for Part B**

In `analytics.html`, add inside the existing `<style>` block, before `</style>`:

```css
.price-input { width: 56px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); color: #fff; border-radius: 4px; padding: 1px 4px; font-size: 11px; }
.best-value { color: var(--green); font-weight: 600; }
```

- [ ] **Step 4: Syntax-check and run tests**

Run: `node --check analytics-renderer.js && npm test`
Expected: `node --check` no output (exit 0); `npm test` shows 19 tests pass (metrics unchanged this task).

- [ ] **Step 5: Verify the wiring by reading**

Read back: `renderCostCompare` loads `getSettings`, builds one row per `VALID_ACCOUNTS`, reads each account's full log and window-filters it, calls `subscriptionValue` with the per-account price; price-input `change` collects ALL inputs into one object and calls `saveSettings({ planPrices })` (full object, matching the shallow merge), then re-renders; the value ratio uses `summarizeCost(...).total ÷ claude-vscode attributedCost`; `ACCOUNT_LABELS`, `fmtMoney`, `windowLabel`, `.eff-sub` (existing), `--green` (existing) all resolve. (No GUI here — read-back is the verification.)

- [ ] **Step 6: Commit**

```bash
git add analytics-renderer.js analytics.html
git commit -m "feat(analytics): cross-account subscription-value comparison"
```

---

## Self-Review

**Spec coverage:**
- API-equivalent cost (Claude Code), per-model, cache savings, unpriced note → `summarizeCost` (Task 1) + Part A (Task 2). ✓
- Pricing table + cache multipliers as named constants; family matching → Task 1 constants + `modelFamily`. ✓
- Subscription-value comparison ($/active-hr, $/window), proration, active hours, windows → `activeMs`/`subscriptionValue` (Task 1) + Part B (Task 3). ✓
- Plan-price inputs persisted via `saveSettings` (full `planPrices` object) → Task 3 Step 2. ✓
- Claude Code value ratio → Task 3 Step 2. ✓
- Window-selector respected (token log + per-account logs filtered by ts) → `windowCutoffMs` used in Parts A and B. ✓
- Claude-Code-only API $; other tabs get the "not available" note → Part A branch (Task 2). ✓
- Honesty labels (estimates header, proration note, noisy-with-little-history) → Tasks 2 & 3. ✓
- No main.js/preload/IPC changes; no new deps; metrics pure & dual-load → Global Constraints; Task 1 footer. ✓
- Codex token estimation rejected → not implemented anywhere. ✓

**Placeholder scan:** The Task 2 `renderCostCompare` stub is intentional scaffolding, replaced in full in Task 3 (noted in both). Every other code step is complete; test step has assertions. ✓

**Type consistency:** `summarizeCost` shape (`total`/`byModel`/`unpriced`/`cacheSavings`) consumed in Parts A & B exactly as produced; `subscriptionValue` shape (`activeHours`/`windows`/`attributedCost`/`perActiveHour`/`perWindow`) consumed in Part B as produced; `entryCost` used inside `summarizeCost`; helper names (`fmtMoney`/`fmtTokens`/`windowCutoffMs`/`windowLabel`) defined in Task 2 and reused in Task 3; `#cost-compare` id matches between Task 2 emit and Task 3 fill; `planPrices` settings key consistent. ✓
