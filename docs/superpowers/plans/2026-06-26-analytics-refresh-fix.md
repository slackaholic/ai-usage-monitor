# Analytics Refresh Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop routine polling from spam-refreshing and freezing the analytics window — by not broadcasting `settings-changed` for cache/position writes, making the token-log reads async + mtime-cached (extracted to a testable module), and making `renderAll` preserve scroll without a "Loading…" flash.

**Architecture:** (A) Gate the `save-settings` broadcast in `main.js`. (B) Move the two synchronous JSONL readers into a new `usage-reader.js` (async `fs.promises`, yields between file batches, per-file mtime cache) and rewire the IPC handlers to it. (C) `renderAll` captures/restores `#body.scrollTop` and only shows "Loading…" on first render.

**Tech Stack:** Electron (main + renderer), vanilla JS, `node --test`. No new dependencies.

## Global Constraints

- No new npm dependencies.
- `metrics.js` is unchanged; the existing `node --test` suite must stay green.
- `usage-reader.js` is a normal Node module (NOT metrics.js) — `Date`, `fs.promises`, `setImmediate` are all allowed there.
- Token entry shapes returned by the readers are **unchanged**: Claude Code `{ timestamp, model, input_tokens, output_tokens, cache_creation, cache_read }`; Codex via `normalizeCodexTokenUsage`.
- Verify changed JS with `node --check`.
- The analytics window must still re-render on **real** settings changes (currency, prices, opacity, overrides, refresh interval, compact, hidden sections); only `lastKnown`/`x`/`y` writes stop broadcasting.

---

### Task 1: Gate the `settings-changed` broadcast (Part A)

**Files:**
- Modify: `main.js` (the `save-settings` handler, ~lines 100-103)

**Interfaces:**
- Consumes: nothing new.
- Produces: `save-settings` persists all keys but only broadcasts `settings-changed` when the patch contains a key outside `{lastKnown, x, y}`.

- [ ] **Step 1: Replace the handler**

In `main.js`, replace the existing handler:

```javascript
ipcMain.on('save-settings', (_, patch) => {
  saveSettings(patch);
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('settings-changed'));
});
```

with:

```javascript
// Cache (`lastKnown`) and window-position (`x`/`y`) writes happen on every poll /
// window drag. Persist them, but do NOT broadcast `settings-changed` for them —
// otherwise the analytics window does a full (freezing) re-render on every poll.
const SILENT_SETTINGS_KEYS = new Set(['lastKnown', 'x', 'y']);
ipcMain.on('save-settings', (_, patch) => {
  saveSettings(patch);
  const meaningful = Object.keys(patch || {}).some(k => !SILENT_SETTINGS_KEYS.has(k));
  if (meaningful) {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send('settings-changed'));
  }
});
```

- [ ] **Step 2: Syntax check**

Run: `node --check main.js`
Expected: valid (no output).

- [ ] **Step 3: Confirm the gate logic by re-reading the diff**

Re-read your change and confirm: a patch of `{ lastKnown: {...} }` → `meaningful` is `false` → no broadcast; a patch of `{ currencySymbol: '£' }` or `{ opacity: 80 }` → `meaningful` is `true` → broadcast. (GUI confirmation is deferred to the controller — the Electron app can't be launched in this environment.)

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "fix(main): don't broadcast settings-changed for cache/position writes"
```

---

### Task 2: Async, mtime-cached usage reader module (Part B)

**Files:**
- Create: `usage-reader.js`
- Create: `test/usage-reader.test.js`
- Modify: `main.js` (rewire `read-claude-code-usage` / `read-codex-usage` handlers; drop the now-unused `normalizeCodexTokenUsage` require if nothing else uses it)

**Interfaces:**
- Consumes: `normalizeCodexTokenUsage` from `./metrics.js`.
- Produces: `usage-reader.js` exports:
  - `parseClaudeCodeLines(content)` → entries[] (pure; one file's text → Claude Code entries)
  - `parseCodexLines(content)` → entries[] (pure; tracks model within the file)
  - `readJsonlEntries(rootDir, cache, parseLines)` → `Promise<entries[]>` (async scan; `cache` is a `Map<path,{mtimeMs,entries}>`; yields every 25 files)
  - `readClaudeCodeUsage()` → `Promise<entries[]>` and `readCodexUsage()` → `Promise<entries[]>` (convenience wrappers with the right dir + a module-private cache each)
- The IPC handlers return `{ entries }` / `{ error }` exactly as before.

- [ ] **Step 1: Write the failing tests**

Create `test/usage-reader.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseClaudeCodeLines, parseCodexLines, readJsonlEntries } = require('../usage-reader.js');

test('parseClaudeCodeLines extracts assistant usage, skips noise', () => {
  const content = [
    JSON.stringify({ type: 'user', message: {} }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-25T10:00:00Z',
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 } } }),
    'not json',
  ].join('\n');
  const out = parseClaudeCodeLines(content);
  assert.equal(out.length, 1);
  assert.equal(out[0].model, 'claude-opus-4-8');
  assert.equal(out[0].input_tokens, 10);
  assert.equal(out[0].output_tokens, 20);
  assert.equal(out[0].cache_creation, 5);
  assert.equal(out[0].cache_read, 100);
});

test('parseCodexLines tracks model and normalizes token_count', () => {
  const content = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-25T10:00:00Z',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } } }),
  ].join('\n');
  const out = parseCodexLines(content);
  assert.equal(out.length, 1);
  assert.equal(out[0].model, 'gpt-5.5');
  assert.equal(out[0].input_tokens, 20); // 100 - 80
  assert.equal(out[0].cache_read, 80);
  assert.equal(out[0].cache_creation, 0);
});

test('readJsonlEntries caches by mtime and re-parses only on change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-'));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'line1\nline2\n');
  let calls = 0;
  const parser = () => { calls++; return [{ n: calls }]; };
  const cache = new Map();

  const r1 = await readJsonlEntries(dir, cache, parser);
  assert.equal(calls, 1);
  assert.deepEqual(r1, [{ n: 1 }]);

  const r2 = await readJsonlEntries(dir, cache, parser); // mtime unchanged → hit
  assert.equal(calls, 1);
  assert.deepEqual(r2, [{ n: 1 }]);

  const future = new Date(Date.now() + 60000);
  fs.utimesSync(file, future, future); // bump mtime → re-parse
  await readJsonlEntries(dir, cache, parser);
  assert.equal(calls, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonlEntries returns [] for a missing directory', async () => {
  const out = await readJsonlEntries(path.join(os.tmpdir(), 'does-not-exist-xyz'), new Map(), () => [{ x: 1 }]);
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../usage-reader.js'`.

- [ ] **Step 3: Create `usage-reader.js`**

```javascript
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeCodexTokenUsage } = require('./metrics.js');

// One file's text → Claude Code entries.
function parseClaudeCodeLines(content) {
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'assistant' && obj.message && obj.message.usage && obj.timestamp) {
      out.push({
        timestamp: obj.timestamp,
        model: obj.message.model || 'unknown',
        input_tokens: obj.message.usage.input_tokens || 0,
        output_tokens: obj.message.usage.output_tokens || 0,
        cache_creation: obj.message.usage.cache_creation_input_tokens || 0,
        cache_read: obj.message.usage.cache_read_input_tokens || 0,
      });
    }
  }
  return out;
}

// One file's text → Codex entries. Model is tracked within the file from
// turn_context events that precede token_count events.
function parseCodexLines(content) {
  const out = [];
  let currentModel = 'unknown';
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
      const e = normalizeCodexTokenUsage(obj.payload.info.last_token_usage, currentModel, obj.timestamp);
      if (e) out.push(e);
    }
  }
  return out;
}

// Recursively list *.jsonl under rootDir (sync dir listing — light; the heavy
// part is reading/parsing file contents, which is async + yielded below).
function scanJsonl(rootDir) {
  const files = [];
  (function scan(dir) {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) scan(full);
      else if (d.name.endsWith('.jsonl')) files.push(full);
    }
  })(rootDir);
  return files;
}

// Async, mtime-cached reader. Reads each file with fs.promises, reusing cached
// parsed entries when the file's mtime is unchanged, and yields to the event
// loop every 25 files so the main process never blocks for a whole scan.
async function readJsonlEntries(rootDir, cache, parseLines) {
  const files = scanJsonl(rootDir);
  const all = [];
  let i = 0;
  for (const file of files) {
    try {
      const st = await fs.promises.stat(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        all.push(...hit.entries);
      } else {
        const content = await fs.promises.readFile(file, 'utf8');
        const parsed = parseLines(content);
        cache.set(file, { mtimeMs: st.mtimeMs, entries: parsed });
        all.push(...parsed);
      }
    } catch { /* skip unreadable file */ }
    if (++i % 25 === 0) await new Promise(r => setImmediate(r));
  }
  return all;
}

const _claudeCodeCache = new Map();
const _codexCache = new Map();

function readClaudeCodeUsage() {
  return readJsonlEntries(path.join(os.homedir(), '.claude', 'projects'), _claudeCodeCache, parseClaudeCodeLines);
}

function readCodexUsage() {
  return readJsonlEntries(path.join(os.homedir(), '.codex', 'sessions'), _codexCache, parseCodexLines);
}

module.exports = {
  parseClaudeCodeLines,
  parseCodexLines,
  scanJsonl,
  readJsonlEntries,
  readClaudeCodeUsage,
  readCodexUsage,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all existing + the 4 new usage-reader tests).

- [ ] **Step 5: Rewire the IPC handlers in `main.js`**

Add near the other top-of-file requires:

```javascript
const { readClaudeCodeUsage, readCodexUsage } = require('./usage-reader.js');
```

Replace the entire `ipcMain.handle('read-claude-code-usage', ...)` block (lines ~110-157) and the entire `ipcMain.handle('read-codex-usage', ...)` block (lines ~159-210) with:

```javascript
// ── Claude Code / Codex local JSONL readers (async + mtime-cached) ──────────
ipcMain.handle('read-claude-code-usage', async () => {
  try { return { entries: await readClaudeCodeUsage() }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle('read-codex-usage', async () => {
  try { return { entries: await readCodexUsage() }; }
  catch (e) { return { error: e.message }; }
});
```

- [ ] **Step 6: Drop the now-unused require if applicable**

Run: `grep -n "normalizeCodexTokenUsage" main.js` (PowerShell: `Select-String normalizeCodexTokenUsage main.js`).
- If the ONLY remaining match is the top-of-file `const { normalizeCodexTokenUsage } = require('./metrics.js');` line (i.e. it's no longer used anywhere in main.js), delete that line.
- If `main.js` requires nothing else from `./metrics.js`, removing the line is correct. If other names are destructured from `./metrics.js` on that line, keep the line but remove only `normalizeCodexTokenUsage` from it.

- [ ] **Step 7: Syntax check + tests**

Run: `node --check main.js` → Expected: valid.
Run: `node --check usage-reader.js` → Expected: valid.
Run: `npm test` → Expected: PASS.

- [ ] **Step 8: Smoke-test against real logs (warm-cache speed)**

Create throwaway `tmp-reader-smoke.js` at repo root:

```javascript
const { readClaudeCodeUsage, readCodexUsage } = require('./usage-reader.js');
(async () => {
  for (const [name, fn] of [['claude-code', readClaudeCodeUsage], ['codex', readCodexUsage]]) {
    const t0 = Date.now(); const a = await fn(); const t1 = Date.now();
    const b = await fn(); const t2 = Date.now(); // warm cache
    console.log(`${name}: ${a.length} entries | cold ${t1 - t0}ms | warm ${t2 - t1}ms | same count: ${a.length === b.length}`);
  }
})();
```

Run: `node tmp-reader-smoke.js`
Expected: non-zero entry counts for both, identical counts cold vs warm, and warm time materially lower than cold (mtime cache hit). Report the numbers.

- [ ] **Step 9: Remove the smoke script**

```bash
rm tmp-reader-smoke.js
```

- [ ] **Step 10: Commit**

```bash
git add usage-reader.js test/usage-reader.test.js main.js
git commit -m "perf(main): async mtime-cached usage readers in usage-reader.js (no main-thread freeze)"
```

---

### Task 3: Non-disruptive `renderAll` (Part C)

**Files:**
- Modify: `analytics-renderer.js` (`renderAll`, ~lines 892-946)

**Interfaces:**
- Consumes: existing `renderAll` internals; `#body` is the scroll container (`overflow-y:auto`).
- Produces: `renderAll` preserves scroll position and only shows "Loading…" on first render.

- [ ] **Step 1: Capture scroll + conditional Loading**

In `analytics-renderer.js`, the start of `renderAll` currently is:

```javascript
async function renderAll() {
  const body = document.getElementById('body');
  body.innerHTML = '<div class="empty">Loading…</div>';
```

Replace those lines with:

```javascript
async function renderAll() {
  const body = document.getElementById('body');
  const prevScroll = body.scrollTop;
  // Only flash "Loading…" on the very first render; on refresh keep the current
  // content visible until the rebuilt sections swap in (avoids flash + jump).
  if (!body.firstChild) body.innerHTML = '<div class="empty">Loading…</div>';
```

- [ ] **Step 2: Restore scroll after rebuild**

At the END of `renderAll`, the current final lines are:

```javascript
  renderStats(entries, statsEl);
  renderEfficiency(allEntries, effEl);
  await renderCost(costEl);
  renderChart(entries, chartEl);
  renderTable(entries, tableEl);
}
```

Replace with (add the scroll restore as the last statement):

```javascript
  renderStats(entries, statsEl);
  renderEfficiency(allEntries, effEl);
  await renderCost(costEl);
  renderChart(entries, chartEl);
  renderTable(entries, tableEl);

  body.scrollTop = prevScroll; // keep the reader's place across refreshes
}
```

- [ ] **Step 3: Syntax check**

Run: `node --check analytics-renderer.js`
Expected: valid.

- [ ] **Step 4: Re-read the diff to confirm**

Confirm: `prevScroll` is captured before any mutation; the "Loading…" wipe is now guarded by `!body.firstChild`; `body.scrollTop = prevScroll` runs after the section swap (the existing `body.innerHTML = ''` + appends at ~line 931-936 still performs the one-shot swap). The empty-data early-return path (`No log entries…`) is unaffected. (GUI confirmation deferred to controller.)

- [ ] **Step 5: Commit**

```bash
git add analytics-renderer.js
git commit -m "fix(analytics): preserve scroll and drop Loading flash on refresh"
```

---

## Notes for the implementer

- After Task 2, run the full `npm test` — all prior tests plus the 4 new `usage-reader` tests must pass.
- Do not change the token entry shapes or the cost math — this is a performance/UX fix only.
- The Electron GUI cannot be launched in the implementation environment; GUI verification of the three parts is deferred to the controller.
