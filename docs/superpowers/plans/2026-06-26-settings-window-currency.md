# Settings Window & Currency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the main window's collapse/expand settings panel into a dedicated Settings window (adding currency + plan-price controls there), and render all analytics money in a user-chosen currency converted from USD.

**Architecture:** A new Settings `BrowserWindow` (`settings.html` + `settings-renderer.js`) opened via an `open-settings` IPC; it persists through the existing `getSettings`/`saveSettings`. `main.js` broadcasts `settings-changed` after every save so the main and analytics windows update live. The analytics renderer converts USD costs to the chosen currency at display time; `metrics.js` is untouched.

**Tech Stack:** Electron (windows via `preload.js`, `contextIsolation: true`), vanilla JS classic scripts, Node's built-in `node --test`. No new dependencies.

## Global Constraints

- **No new npm dependencies.**
- **`metrics.js` is NOT changed** — API-equivalent cost stays USD; `subscriptionValue` takes a raw price number. All currency conversion/symbols live in the renderers. The existing 19-test suite must still pass.
- **New settings keys:** `currencySymbol` (string, default `'£'`), `usdRate` (number USD→display, default `0.79`). `planPrices` (`{account: number}`, display currency) already exists.
- **Persist on change** (no Save button) — matches the existing analytics price-input pattern.
- **`saveSettings` shallow-merges** in `main.js`; always send whole objects for `planPrices`/`accountOverrides`.
- **Accounts:** `codex`, `claude-desktop`, `claude-vscode`. Override keys use the legacy names `codex`/`claude`/`claude2`.
- **Theme (☀) and compact (⊟) stay as title-bar toggles** — not moved.
- Settings window uses `preload.js`, `contextIsolation: true`, like the analytics window.

---

### Task 1: Settings window stack + IPC plumbing

**Files:**
- Create: `settings.html`, `settings-renderer.js`
- Modify: `main.js` (settings window + `open-settings` + broadcast), `preload.js` (`openSettings`, `onSettingsChanged`)

**Interfaces:**
- Consumes: existing IPCs `getSettings`, `saveSettings`, `setOpacity`, `showClaudeWebWindow`, `showCodexWindow`, `borrowClaudeDesktopSession`, `resetClaudeSession`.
- Produces: `electronAPI.openSettings()`; `electronAPI.onSettingsChanged(cb)`; a Settings window that reads/writes all settings. After this task the window works when opened; nothing opens it yet (Task 2 wires the ⚙ button).

- [ ] **Step 1: Add preload bindings**

In `preload.js`, inside the `exposeInMainWorld` object, add (next to `openAnalytics`):

```js
  openSettings: () => ipcRenderer.send('open-settings'),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', () => cb()),
```

- [ ] **Step 2: Add the settings window + broadcast in `main.js`**

Add a window variable near the other window vars (after `let analyticsWindow = null;`):

```js
let settingsWindow = null;
```

Replace the existing save-settings handler:

```js
ipcMain.on('save-settings', (_, patch) => saveSettings(patch));
```

with a version that broadcasts:

```js
ipcMain.on('save-settings', (_, patch) => {
  saveSettings(patch);
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('settings-changed'));
});
```

Add the open-settings handler immediately after the `open-analytics` handler block (after its closing `});`):

```js
ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 400,
    height: 580,
    minWidth: 340,
    minHeight: 320,
    title: 'AI Usage Monitor — Settings',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
});
```

- [ ] **Step 3: Create `settings.html`**

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Settings</title>
<style>
  :root {
    --bg: #0f1117; --panel: #171a22; --text: #e6e8ee; --text-mid: #8b90a0;
    --accent: #a78bfa; --accent-med: #6d4fd0; --border: rgba(255,255,255,.1);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, Segoe UI, Roboto, sans-serif; font-size: 12px; padding: 14px 16px 24px; }
  h1 { font-size: 15px; margin: 0 0 12px; }
  .section { margin-bottom: 18px; }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--accent); margin-bottom: 8px; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .row label { width: 120px; flex-shrink: 0; color: var(--text); }
  input[type="text"], input[type="number"], select {
    flex: 1; background: rgba(255,255,255,.06); border: 1px solid var(--border);
    color: var(--text); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  input[type="range"] { flex: 1; accent-color: var(--accent); }
  .suffix { color: var(--text-mid); width: 38px; }
  .btn { background: rgba(167,139,250,.15); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 5px 9px; font-size: 12px; cursor: pointer; }
  .btn:hover { background: var(--accent-med); color: #fff; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .note { font-size: 10px; color: var(--text-mid); margin-top: 6px; }
  #login-status { font-size: 10px; color: var(--accent); margin-top: 6px; min-height: 12px; }
</style>
</head>
<body>
  <h1>Settings</h1>

  <div class="section">
    <div class="section-title">Display</div>
    <div class="row"><label>Opacity</label>
      <input type="range" id="opacity" min="20" max="100" step="1" value="100">
      <span class="suffix" id="opacity-val">100%</span></div>
    <div class="row"><label>Auto-refresh</label>
      <select id="refresh">
        <option value="60">1 min</option>
        <option value="120">2 min</option>
        <option value="300">5 min</option>
        <option value="600">10 min</option>
      </select></div>
  </div>

  <div class="section">
    <div class="section-title">Currency</div>
    <div class="row"><label>Symbol</label><input type="text" id="cur-symbol" maxlength="3" value="£"></div>
    <div class="row"><label>USD → currency</label><input type="number" id="cur-rate" min="0" step="0.01" value="0.79"></div>
    <div class="note">API-equivalent cost is computed in USD and shown as USD × this rate. Plan prices below are entered in your currency.</div>
  </div>

  <div class="section">
    <div class="section-title">Subscriptions (plan price /mo)</div>
    <div class="row"><label>Codex</label><input type="number" id="price-codex" min="0" step="1" placeholder="—"></div>
    <div class="row"><label>Claude Desktop</label><input type="number" id="price-claude-desktop" min="0" step="1" placeholder="—"></div>
    <div class="row"><label>Claude Code</label><input type="number" id="price-claude-vscode" min="0" step="1" placeholder="—"></div>
  </div>

  <div class="section">
    <div class="section-title">Account label overrides</div>
    <div class="row"><label>Codex</label><input type="text" id="ov-codex" placeholder="auto-detected"></div>
    <div class="row"><label>Claude Desktop</label><input type="text" id="ov-claude" placeholder="auto-detected"></div>
    <div class="row"><label>Claude Code</label><input type="text" id="ov-claude2" placeholder="auto-detected"></div>
  </div>

  <div class="section">
    <div class="section-title">Login</div>
    <div class="btn-row">
      <button class="btn" id="btn-show-claude">Login — Claude Desktop</button>
      <button class="btn" id="btn-show-codex">Login — Codex</button>
    </div>
    <div class="btn-row" style="margin-top:6px">
      <button class="btn" id="btn-import-claude">⤵ Import Claude session</button>
      <button class="btn" id="btn-logoff-claude">⏻ Log off Claude</button>
    </div>
    <div class="note">Email-only Claude account? Sign into Claude Desktop, then Import.</div>
    <div id="login-status"></div>
  </div>

  <script src="settings-renderer.js"></script>
</body>
</html>
```

- [ ] **Step 4: Create `settings-renderer.js`**

```js
'use strict';

const ACCOUNTS = ['codex', 'claude-desktop', 'claude-vscode'];
const status = (msg) => { document.getElementById('login-status').textContent = msg || ''; };

async function loadSettings() {
  const s = (await window.electronAPI.getSettings()) || {};

  const op = s.opacity != null ? Math.round(Math.max(0.2, Math.min(1, s.opacity)) * 100) : 100;
  document.getElementById('opacity').value = op;
  document.getElementById('opacity-val').textContent = op + '%';
  document.getElementById('refresh').value = String(s.refreshInterval || 120);

  document.getElementById('cur-symbol').value = s.currencySymbol || '£';
  document.getElementById('cur-rate').value = s.usdRate != null ? s.usdRate : 0.79;

  const pp = s.planPrices || {};
  ACCOUNTS.forEach(a => { document.getElementById('price-' + a).value = pp[a] != null ? pp[a] : ''; });

  const ov = s.accountOverrides || {};
  document.getElementById('ov-codex').value = ov.codex || '';
  document.getElementById('ov-claude').value = ov.claude || '';
  document.getElementById('ov-claude2').value = ov.claude2 || '';
}

function savePlanPrices() {
  const planPrices = {};
  ACCOUNTS.forEach(a => {
    const v = parseFloat(document.getElementById('price-' + a).value);
    if (!isNaN(v) && v > 0) planPrices[a] = v;
  });
  window.electronAPI.saveSettings({ planPrices });
}

function saveOverrides() {
  window.electronAPI.saveSettings({
    accountOverrides: {
      codex: document.getElementById('ov-codex').value.trim(),
      claude: document.getElementById('ov-claude').value.trim(),
      claude2: document.getElementById('ov-claude2').value.trim(),
    },
  });
}

document.getElementById('opacity').addEventListener('input', e => {
  const pct = parseInt(e.target.value, 10);
  document.getElementById('opacity-val').textContent = pct + '%';
  window.electronAPI.setOpacity(pct / 100); // live on the main window; also persists opacity
});
document.getElementById('refresh').addEventListener('change', e => {
  window.electronAPI.saveSettings({ refreshInterval: parseInt(e.target.value, 10) });
});
document.getElementById('cur-symbol').addEventListener('change', e => {
  window.electronAPI.saveSettings({ currencySymbol: e.target.value.trim() || '£' });
});
document.getElementById('cur-rate').addEventListener('change', e => {
  const r = parseFloat(e.target.value);
  if (!isNaN(r) && r > 0) window.electronAPI.saveSettings({ usdRate: r });
});
ACCOUNTS.forEach(a => document.getElementById('price-' + a).addEventListener('change', savePlanPrices));
['ov-codex', 'ov-claude', 'ov-claude2'].forEach(id =>
  document.getElementById(id).addEventListener('change', saveOverrides));

document.getElementById('btn-show-claude').addEventListener('click', () => {
  window.electronAPI.showClaudeWebWindow(); status('Opened Claude login — sign in, then refresh the main window.');
});
document.getElementById('btn-show-codex').addEventListener('click', () => {
  window.electronAPI.showCodexWindow(); status('Opened Codex login — sign in, then refresh the main window.');
});
document.getElementById('btn-import-claude').addEventListener('click', async () => {
  status('Importing Claude Desktop session…');
  const r = await window.electronAPI.borrowClaudeDesktopSession();
  status(r && r.ok ? `Imported ${r.imported} cookies — refresh the main window.`
                   : 'Import failed: ' + ((r && r.reason) || 'is Claude Desktop installed & signed in?'));
});
document.getElementById('btn-logoff-claude').addEventListener('click', async () => {
  await window.electronAPI.resetClaudeSession('desktop'); status('Logged off Claude Desktop.');
});

loadSettings();
```

- [ ] **Step 5: Syntax-check and run tests**

Run: `node --check main.js && node --check preload.js && node --check settings-renderer.js && npm test`
Expected: all `node --check` clean (exit 0); `npm test` shows 19 tests pass (metrics untouched).

- [ ] **Step 6: Verify wiring by reading**

Confirm: `open-settings` creates the window with `preload.js`; `save-settings` broadcasts `settings-changed` to all windows; `preload` exposes `openSettings`/`onSettingsChanged`; `settings.html` loads `settings-renderer.js`; every control id in the HTML has a matching handler; login buttons call existing IPCs. (Electron GUI can't be launched here — read-back is the verification.)

- [ ] **Step 7: Commit**

```bash
git add settings.html settings-renderer.js main.js preload.js
git commit -m "feat(settings): dedicated Settings window + settings-changed broadcast"
```

---

### Task 2: Switch the main window to the Settings window

**Files:**
- Modify: `index.html` (remove `#settings-panel` markup), `renderer.js` (open window, remove moved handlers, live-update listener, init cleanup)

**Interfaces:**
- Consumes: `electronAPI.openSettings()`, `electronAPI.onSettingsChanged(cb)` (Task 1); existing `applyAccountLabel`, `setRefreshInterval`, `accountOverrides`.
- Produces: ⚙ opens the Settings window; main window re-applies labels and refresh interval on `settings-changed`.

- [ ] **Step 1: Remove the settings panel markup**

In `index.html`, delete the entire `<div id="settings-panel"> … </div>` block (from `<div id="settings-panel">` through its matching closing `</div>` before `<div class="content">`). Leave the title-bar buttons and `.content` untouched. (The now-unused `#settings-panel`/`.settings-*` CSS rules are harmless dead styles; pruning them is out of scope.)

- [ ] **Step 2: Point the ⚙ button at the Settings window**

In `renderer.js`, replace the settings-panel toggle handler:

```js
document.getElementById('btn-settings').addEventListener('click', () => {
  const sp = document.getElementById('settings-panel');
  sp.classList.toggle('open');
  resizeToFit();
  sp.addEventListener('transitionend', resizeToFit, { once: true });
});
```

with:

```js
document.getElementById('btn-settings').addEventListener('click', () => {
  window.electronAPI.openSettings();
});
```

- [ ] **Step 3: Remove the moved handlers**

In `renderer.js`, delete these blocks (they now live in the Settings window):

- The `#settings-save-btn` click handler (the block starting `document.getElementById('settings-save-btn').addEventListener(...)`).
- The opacity slider handler (the block `document.getElementById('opacity-slider').addEventListener('input', …)`).
- The refresh-select change handler:

  ```js
  document.getElementById('refresh-select').addEventListener('change', (e) => {
    setRefreshInterval(parseInt(e.target.value, 10));
  });
  ```

- The four panel login bindings (keep the per-card `btn-borrow-claude-session`, `claude-signout-btn`, `codex-login-btn`, `claude-login-btn` handlers and the `borrowClaudeDesktopSession`/`logoffClaudeDesktop` functions):

  ```js
  document.getElementById('btn-borrow-claude-session-top')?.addEventListener('click', borrowClaudeDesktopSession);
  ```
  ```js
  document.getElementById('btn-show-claude-window')?.addEventListener('click', () => {
    window.electronAPI.showClaudeWebWindow();
    showToast('Log in to claude.ai in that window, then close it and click ↻ on the Claude Desktop card.');
  });
  document.getElementById('btn-show-codex-window')?.addEventListener('click', () => {
    window.electronAPI.showCodexWindow();
  });
  ```
  ```js
  document.getElementById('btn-logoff-claude-top')?.addEventListener('click', logoffClaudeDesktop);
  ```

- [ ] **Step 4: Drop the panel from `resizeToFit`**

In `renderer.js` `resizeToFit`, remove the `opacityRow`/`settingsPanel` measurements. Replace:

```js
    const titlebar      = document.querySelector('.titlebar');
    const opacityRow    = document.getElementById('opacity-row');
    const settingsPanel = document.getElementById('settings-panel');
    const content       = document.querySelector('.content');
    if (!content) return;
```

with:

```js
    const titlebar = document.querySelector('.titlebar');
    const content  = document.querySelector('.content');
    if (!content) return;
```

and replace:

```js
    const titlebarH   = titlebar      ? titlebar.offsetHeight      : 36;
    const opacityRowH = opacityRow    ? opacityRow.offsetHeight    : 0;
    const settingsH   = settingsPanel ? settingsPanel.offsetHeight : 0;
    window.electronAPI.resizeToFit(Math.ceil(contentH + titlebarH + opacityRowH + settingsH));
```

with:

```js
    const titlebarH = titlebar ? titlebar.offsetHeight : 36;
    window.electronAPI.resizeToFit(Math.ceil(contentH + titlebarH));
```

- [ ] **Step 5: Clean up `init()` and add the live-update listener**

In `renderer.js` `init()`, replace the settings-application block:

```js
    if (settings.opacity != null) {
      const pct = Math.round(Math.max(0.2, Math.min(1, settings.opacity)) * 100);
      document.getElementById('opacity-slider').value = pct;
      document.getElementById('opacity-value').textContent = pct + '%';
    }
    if (settings.compact) setCompact(true);
    if (Array.isArray(settings.hiddenSections)) {
      settings.hiddenSections.forEach(id => hideSection(id));
    }
    if (settings.refreshInterval) {
      refreshSeconds = settings.refreshInterval;
      document.getElementById('refresh-select').value = settings.refreshInterval;
    }
    if (settings.accountOverrides) {
      Object.assign(accountOverrides, settings.accountOverrides);
      document.getElementById('override-codex').value   = accountOverrides.codex   || '';
      document.getElementById('override-claude').value  = accountOverrides.claude  || '';
      document.getElementById('override-claude2').value = accountOverrides.claude2 || '';
    }
```

with (opacity is restored by the main process at window creation; the slider/inputs live in the Settings window now):

```js
    if (settings.compact) setCompact(true);
    if (Array.isArray(settings.hiddenSections)) {
      settings.hiddenSections.forEach(id => hideSection(id));
    }
    if (settings.refreshInterval) refreshSeconds = settings.refreshInterval;
    if (settings.accountOverrides) {
      Object.assign(accountOverrides, settings.accountOverrides);
      applyAccountLabel('codex', null);
      applyAccountLabel('claude', null);
      applyAccountLabel('claude2', null);
    }
```

Then add a live-update listener at the end of `init()` (after `setRefreshInterval(refreshSeconds);`):

```js
  window.electronAPI.onSettingsChanged(async () => {
    try {
      const s = await window.electronAPI.getSettings();
      if (s.accountOverrides) {
        Object.assign(accountOverrides, s.accountOverrides);
        applyAccountLabel('codex', null);
        applyAccountLabel('claude', null);
        applyAccountLabel('claude2', null);
      }
      if (s.refreshInterval && s.refreshInterval !== refreshSeconds) setRefreshInterval(s.refreshInterval);
    } catch {}
  });
```

(The `setRefreshInterval` guard `!== refreshSeconds` prevents the re-save from looping — the next broadcast finds the value unchanged and stops.)

- [ ] **Step 6: Syntax-check and run tests**

Run: `node --check renderer.js && npm test`
Expected: `node --check` clean; 19 tests pass.

- [ ] **Step 7: Verify by reading**

Confirm in `renderer.js`: the ⚙ handler calls `openSettings()`; no remaining references to `settings-panel`, `settings-save-btn`, `opacity-slider`, `opacity-value`, `refresh-select`, `override-codex/claude/claude2`, `btn-show-claude-window`, `btn-show-codex-window`, `btn-borrow-claude-session-top`, `btn-logoff-claude-top` (grep them — they should be gone or, for the per-card buttons, untouched); `onSettingsChanged` re-applies labels + refresh; `index.html` no longer contains `id="settings-panel"`. (No GUI here — read-back is the verification.)

- [ ] **Step 8: Commit**

```bash
git add index.html renderer.js
git commit -m "feat(main): open Settings window from gear; remove inline panel"
```

---

### Task 3: Currency in the analytics cost views

**Files:**
- Modify: `analytics-renderer.js` (currency-aware formatters; read prices from settings; live re-render)

**Interfaces:**
- Consumes: `electronAPI.getSettings()`, `electronAPI.onSettingsChanged(cb)`; module helpers `windowCutoffMs`, `windowLabel`; metrics globals `summarizeCost`, `subscriptionValue`, `FAMILY_PRICES`.
- Produces: cost + comparison rendered in the chosen currency; the inline plan-price inputs are removed (prices now come from settings).

- [ ] **Step 1: Add currency state and make the formatters currency-aware**

In `analytics-renderer.js`, add module state near the top (after `let rowLimit = 200;` / the other `let` declarations):

```js
let curSymbol = '£';
let usdRate = 0.79;
```

Replace the existing money formatter:

```js
function fmtMoney(n) { return '$' + (n || 0).toFixed(2); }
```

with two currency-aware formatters:

```js
function fmtMoney(v) { return curSymbol + (v || 0).toFixed(2); }          // value already in display currency
function fmtMoneyUsd(usd) { return curSymbol + ((usd || 0) * usdRate).toFixed(2); } // convert USD → display
```

- [ ] **Step 2: Load currency settings in `renderAll`**

In `renderAll`, near the top (right after `const body = document.getElementById('body');`), add:

```js
  const _cur = (await window.electronAPI.getSettings()) || {};
  curSymbol = _cur.currencySymbol || '£';
  usdRate = _cur.usdRate != null ? _cur.usdRate : 0.79;
```

- [ ] **Step 3: Convert the Part A cost figures (USD → display)**

In `renderCost`, change the three money figures that come from `summarizeCost` (USD) to use `fmtMoneyUsd`:

- Headline: `≈ ${fmtMoney(c.total)} of API usage` → `≈ ${fmtMoneyUsd(c.total)} of API usage`.
- Per-model row cost cell: `${fmtMoney(v.cost)}` → `${fmtMoneyUsd(v.cost)}`.
- Cache savings: `cache reads saved ≈ ${fmtMoney(c.cacheSavings)} vs uncached` → `${fmtMoneyUsd(c.cacheSavings)}`.

- [ ] **Step 4: Remove the inline price inputs from `renderCostCompare`; show prices from settings**

In `renderCostCompare`, the per-account rows currently render an editable `<input class="price-input" …>`. Replace the `Plan` cell so it shows the stored price (read-only) instead of an input, and remove the input-change wiring at the end of the function.

Change the row template's plan cell from:

```js
      <td><input class="price-input" data-account="${r.acct}" type="number" min="0" step="1"
            value="${r.price != null ? r.price : ''}" placeholder="—"> /mo</td>
```

to:

```js
      <td>${r.price != null ? fmtMoney(r.price) + '/mo' : '—'}</td>
```

Change the money-column cells (`$/active-hr`, `$/window`) — they already call `fmtMoney`, which is now currency-aware, so no change there. Update the two column headers `<th>$/active-hr</th><th>$/window</th>` to `<th>${curSymbol}/active-hr</th><th>${curSymbol}/window</th>`.

Update the value-ratio numerator to convert USD → display currency. Change:

```js
      const total = summarizeCost(toks).total;
      if (total > 0) {
        const ratio = total / cc.sv.attributedCost;
```

to:

```js
      const total = summarizeCost(toks).total * usdRate;
      if (total > 0) {
        const ratio = total / cc.sv.attributedCost;
```

Remove the price-input event-wiring block at the end of `renderCostCompare`:

```js
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
```

(Plan prices are now edited in the Settings window. `renderCostCompare` still reads `planPrices` from `getSettings` as it does today.) Add a hint under the table — change the caveat line to mention where prices are set, e.g. append `Set plan prices in Settings (⚙).` to the existing `.cost-sub` caveat text.

- [ ] **Step 5: Re-render on settings change**

In `analytics-renderer.js`, near the bottom where the initial `renderAll()` / tab wiring lives (after `window.electronAPI.onSwitchAnalyticsTab(switchTab);`), add:

```js
window.electronAPI.onSettingsChanged(() => renderAll());
```

- [ ] **Step 6: Syntax-check and run tests**

Run: `node --check analytics-renderer.js && npm test`
Expected: `node --check` clean; 19 tests pass (metrics untouched).

- [ ] **Step 7: Verify by reading**

Confirm: `renderAll` loads `currencySymbol`/`usdRate` before rendering Cost; Part A uses `fmtMoneyUsd` for the USD-derived figures and the comparison's per-hour/per-window use the currency-aware `fmtMoney`; the value ratio multiplies the USD total by `usdRate`; no `.price-input` remains in `renderCostCompare`; headers use `curSymbol`; `onSettingsChanged` triggers `renderAll`. (No GUI here — read-back is the verification.)

- [ ] **Step 8: Commit**

```bash
git add analytics-renderer.js
git commit -m "feat(analytics): render cost in configured currency; read plan prices from settings"
```

---

## Self-Review

**Spec coverage:**
- Dedicated Settings window opened via `open-settings`, replacing the panel → Task 1 (window) + Task 2 (⚙ rewire, panel removal). ✓
- Settings window holds Display, Currency, Subscriptions, Account overrides, Login → `settings.html`/`settings-renderer.js` (Task 1). ✓
- New keys `currencySymbol`/`usdRate`; persist-on-change; whole-object `planPrices`/`accountOverrides` → Task 1 Step 4. ✓
- Currency model (USD×rate for API-equivalent; raw plan prices; ratio consistent) → Task 3 formatters + value-ratio conversion. ✓
- Plan-price inputs moved out of analytics into settings → Task 1 (added) + Task 3 (removed inline). ✓
- Cross-window live updates via `settings-changed` broadcast + `onSettingsChanged` → Task 1 (broadcast/preload) + Task 2 (main listener) + Task 3 (analytics listener). ✓
- Theme/compact stay in title bar; metrics.js untouched; no new deps → Global Constraints; no metrics edits in any task. ✓
- Opacity startup restore unaffected (main.js:1153) → noted in Task 2 Step 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code or an exact old→new replacement; verification steps are concrete commands/reads. ✓

**Type consistency:** `openSettings`/`onSettingsChanged` defined in preload (Task 1) and consumed in Task 2/3; `settings-changed` channel name consistent across `main.js` broadcast and `preload` listener; settings keys (`currencySymbol`, `usdRate`, `planPrices`, `accountOverrides`, `refreshInterval`, `opacity`) spelled consistently across settings-renderer, main renderer, and analytics renderer; `fmtMoney` (display-currency) vs `fmtMoneyUsd` (USD→display) used per their definitions; account ids (`price-codex`/`price-claude-desktop`/`price-claude-vscode`, `ov-codex`/`ov-claude`/`ov-claude2`) consistent between `settings.html` and `settings-renderer.js`. ✓
