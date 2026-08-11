'use strict';

// Two id namespaces, not one:
//   - price / tier-date / tier-today / mult are keyed by `logKey` (the
//     usage-log account key: 'codex', 'claude-desktop', 'claude-vscode', ...) —
//     that is what keeps a previously saved price/date/multiplier attached to
//     the same account after a registry rebuild.
//   - the label override is keyed by descriptor `id` (the renderer's DOM/state
//     prefix: 'codex', 'claude', 'claude2', ...) — that is what `renderer.js`
//     reads via `accountOverrides[acct.id]`.
// ACCOUNT_PAIRS carries both keys per account so each block below can pick the
// right one. Codex and Claude Desktop are fixed; Claude Code accounts come
// from the registry.
let ACCOUNT_PAIRS = [
  { logKey: 'codex', id: 'codex', label: 'Codex' },
  { logKey: 'claude-desktop', id: 'claude', label: 'Claude Desktop' },
];
const MULT_DEFAULTS = { 'codex': 5, 'claude-desktop': 1 };
const CLAUDE_CODE_MULT_DEFAULT = 20;
const BUDGET_DEFAULTS = { window: 10, day: 20 };
const status = (msg) => { document.getElementById('login-status').textContent = msg || ''; };

// The last full settings object we know about, kept in sync by loadSettings()
// and by every save*() below. save*() needs this because each per-account
// object (planPrices, tierChangedAt, planMultipliers, accountOverrides) can
// hold entries for accounts that are not part of the *current* ACCOUNT_PAIRS
// — e.g. a second Claude Code account whose credentials briefly expired, so
// this session's registry scan doesn't include it. Building a save patch from
// scratch over only the visible accounts would silently delete every other
// account's saved values on the next unrelated edit (mergeAccountPatch below
// is what prevents that).
let lastSettings = {};

// Pure and independently testable (see test/settings-renderer.test.js):
// merges `updates` into `current`, keeping every key `updates` doesn't
// mention untouched, and deleting a key when `updates` maps it to
// `undefined` (the "field was cleared/invalid" signal savePlanPrices and
// savePlanMultipliers use below). Never mutates `current`.
function mergeAccountPatch(current, updates) {
  const merged = { ...(current || {}) };
  for (const key of Object.keys(updates || {})) {
    const v = updates[key];
    if (v === undefined) delete merged[key];
    else merged[key] = v;
  }
  return merged;
}

async function loadAccounts() {
  let accts = [];
  try {
    const result = await window.electronAPI.getClaudeAccounts();
    if (Array.isArray(result)) accts = result;
  } catch (e) {
    // A rejected IPC call must not blank the whole settings window — opacity,
    // refresh interval, currency, budget targets and the two fixed rows
    // (Codex, Claude Desktop) all still need to render. Fall back to no
    // Claude Code accounts this load; a rescan can recover later.
    console.error('getClaudeAccounts failed:', e);
  }
  ACCOUNT_PAIRS = [
    { logKey: 'codex', id: 'codex', label: 'Codex' },
    { logKey: 'claude-desktop', id: 'claude', label: 'Claude Desktop' },
    ...accts.map(a => ({ logKey: a.logKey, id: a.id, label: a.label || 'Claude Code' })),
  ];
  for (const a of accts) MULT_DEFAULTS[a.logKey] = CLAUDE_CODE_MULT_DEFAULT;
  return accts;
}

function buildAccountRows() {
  const host = document.getElementById('account-rows');
  host.replaceChildren();
  for (const { logKey, id, label } of ACCOUNT_PAIRS) {
    const row = document.createElement('div');
    row.className = 'account-row';
    // logKey is filesystem-controlled (for a non-default account it's the raw
    // config-dir basename, not scrubbed the way `id` is) and must never be
    // interpolated into innerHTML markup. The template below carries no id
    // attributes at all — every dynamic id is assigned afterward via the
    // `.id` DOM property, a plain string set rather than markup parsing, so
    // it cannot be used to break out of an attribute the way string
    // interpolation into innerHTML could. `label` gets the same treatment
    // via `.textContent` for the same reason.
    row.innerHTML = `
      <div class="account-name"></div>
      <div class="row"><label>Plan price</label>
        <input type="number" class="f-price" min="0" step="1" placeholder="—">
        <input type="date" class="f-tier-date tier-date" title="Plan/tier changed on">
        <button class="f-tier-today mini-btn" type="button" title="Set to today">Today</button></div>
      <div class="row"><label>Multiplier</label>
        <input type="number" class="f-mult" min="0.1" step="0.1"><span class="suffix">x</span></div>
      <div class="row"><label>Label override</label>
        <input type="text" class="f-ov" placeholder="auto-detected"></div>`;
    row.querySelector('.account-name').textContent = label;
    row.querySelector('.f-price').id = 'price-' + logKey;
    row.querySelector('.f-tier-date').id = 'tier-date-' + logKey;
    row.querySelector('.f-tier-today').id = 'tier-today-' + logKey;
    row.querySelector('.f-mult').id = 'mult-' + logKey;
    row.querySelector('.f-ov').id = 'ov-' + id;
    host.appendChild(row);
  }
}

// Attaches the per-row listeners. Must run again after every buildAccountRows()
// call (initial load and rescan alike): buildAccountRows() replaces the DOM
// nodes wholesale, so any previously attached listeners go with the old nodes
// (no leak — but the new nodes have none until this runs).
function wireAccountRowListeners() {
  ACCOUNT_PAIRS.forEach(({ logKey }) => document.getElementById('price-' + logKey).addEventListener('change', savePlanPrices));
  ACCOUNT_PAIRS.forEach(({ logKey }) => document.getElementById('tier-date-' + logKey).addEventListener('change', saveTierDates));
  ACCOUNT_PAIRS.forEach(({ logKey }) => document.getElementById('tier-today-' + logKey).addEventListener('click', () => {
    document.getElementById('tier-date-' + logKey).value = todayLocalISO();
    saveTierDates();
  }));
  ACCOUNT_PAIRS.forEach(({ logKey }) => document.getElementById('mult-' + logKey).addEventListener('change', savePlanMultipliers));
  ACCOUNT_PAIRS.forEach(({ id }) => document.getElementById('ov-' + id).addEventListener('change', saveOverrides));
}

async function loadSettings() {
  const s = (await window.electronAPI.getSettings()) || {};
  lastSettings = s;

  const op = s.opacity != null ? Math.round(Math.max(0.2, Math.min(1, s.opacity)) * 100) : 100;
  document.getElementById('opacity').value = op;
  document.getElementById('opacity-val').textContent = op + '%';
  document.getElementById('refresh').value = String(s.refreshInterval || 120);

  document.getElementById('cur-symbol').value = s.currencySymbol || '£';
  document.getElementById('cur-rate').value = s.usdRate != null ? s.usdRate : 0.79;

  const pp = s.planPrices || {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => { document.getElementById('price-' + logKey).value = pp[logKey] != null ? pp[logKey] : ''; });

  const tc = s.tierChangedAt || {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => { document.getElementById('tier-date-' + logKey).value = tc[logKey] || ''; });

  const pm = s.planMultipliers || {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => { document.getElementById('mult-' + logKey).value = pm[logKey] != null ? pm[logKey] : MULT_DEFAULTS[logKey]; });

  const bt = s.budgetTargets || {};
  document.getElementById('budget-window').value = bt.window != null ? bt.window : BUDGET_DEFAULTS.window;
  document.getElementById('budget-day').value    = bt.day    != null ? bt.day    : BUDGET_DEFAULTS.day;

  const ov = s.accountOverrides || {};
  ACCOUNT_PAIRS.forEach(({ id }) => { document.getElementById('ov-' + id).value = ov[id] || ''; });

  document.getElementById('claude-extra-dir').value = (s.claudeExtraConfigDirs || [])[0] || '';
}

function savePlanPrices() {
  const updates = {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => {
    const v = parseFloat(document.getElementById('price-' + logKey).value);
    updates[logKey] = (!isNaN(v) && v > 0) ? v : undefined;
  });
  const planPrices = mergeAccountPatch(lastSettings.planPrices, updates);
  lastSettings.planPrices = planPrices;
  window.electronAPI.saveSettings({ planPrices });
}

// NB: do NOT try to use validity.badInput to tell "user cleared it" from "user
// typed a partial date". Measured in Chromium: clearing a date input with the
// keyboard — even clearing every segment — leaves value === '' with badInput
// TRUE, indistinguishable from a half-typed entry. (The picker's own Clear
// leaves it false, so a badInput guard makes clearing work via the picker but
// silently revert via the keyboard.) An empty field is therefore just saved as
// '' = "use all history"; the "ratio since <date>" note in the budget readouts
// is what makes an active cutoff visible.
function saveTierDates() {
  const updates = {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => { updates[logKey] = document.getElementById('tier-date-' + logKey).value || ''; });
  const tierChangedAt = mergeAccountPatch(lastSettings.tierChangedAt, updates);
  lastSettings.tierChangedAt = tierChangedAt;
  window.electronAPI.saveSettings({ tierChangedAt });
}

// Local YYYY-MM-DD for the "Today" buttons (not toISOString, which is UTC and
// can land on the wrong day near midnight).
function todayLocalISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function savePlanMultipliers() {
  const updates = {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => {
    const v = parseFloat(document.getElementById('mult-' + logKey).value);
    updates[logKey] = (!isNaN(v) && v > 0) ? v : undefined;
  });
  const planMultipliers = mergeAccountPatch(lastSettings.planMultipliers, updates);
  lastSettings.planMultipliers = planMultipliers;
  window.electronAPI.saveSettings({ planMultipliers });
}

function saveBudgetTargets() {
  const win = parseFloat(document.getElementById('budget-window').value);
  const day = parseFloat(document.getElementById('budget-day').value);
  window.electronAPI.saveSettings({
    budgetTargets: {
      window: (isFinite(win) && win > 0) ? win : BUDGET_DEFAULTS.window,
      day:    (isFinite(day) && day > 0) ? day : BUDGET_DEFAULTS.day,
    },
  });
}

function saveOverrides() {
  const updates = {};
  ACCOUNT_PAIRS.forEach(({ id }) => { updates[id] = document.getElementById('ov-' + id).value.trim(); });
  const accountOverrides = mergeAccountPatch(lastSettings.accountOverrides, updates);
  lastSettings.accountOverrides = accountOverrides;
  window.electronAPI.saveSettings({ accountOverrides });
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
['budget-window', 'budget-day'].forEach(id =>
  document.getElementById(id).addEventListener('change', saveBudgetTargets));

document.getElementById('btn-rescan-accounts').addEventListener('click', async () => {
  const btn = document.getElementById('btn-rescan-accounts');
  // Re-entrancy guard: a rapid double-click would otherwise launch two
  // overlapping rebuild sequences whose status() calls can interleave into a
  // misleading message. Disabling for the duration also means a slow scan
  // can't be kicked off a second time before the first finishes.
  btn.disabled = true;
  try {
    const accts = await window.electronAPI.rescanClaudeAccounts();
    await loadAccounts();
    buildAccountRows();
    await loadSettings();
    wireAccountRowListeners();
    // A rescan changes how many rows there are, so the fitted height is stale.
    window.electronAPI.settingsFitToContent();
    status(`Found ${accts.length} Claude Code account${accts.length === 1 ? '' : 's'}.`);
  } catch (e) {
    console.error('rescanClaudeAccounts failed:', e);
    status('Rescan failed — see console for details.');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('claude-extra-dir').addEventListener('change', e => {
  const v = e.target.value.trim();
  window.electronAPI.saveSettings({ claudeExtraConfigDirs: v ? [v] : [] });
});

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

(async () => {
  try {
    await loadAccounts();
    buildAccountRows();
    // After loadSettings, not before: wiring first leaves a window in which a
    // `change` event fires while `lastSettings` is still `{}`, and the
    // resulting merge would save a patch built from an unseeded cache — wiping
    // every saved price/date/multiplier the fields have not been filled with
    // yet.
    await loadSettings();
    wireAccountRowListeners();
  } finally {
    // Only now: the account rows are generated, not static markup, so main
    // measuring at did-finish-load would size the window to a page missing
    // #account-rows entirely and leave a scrollbar. In `finally` so a failed
    // load still gets a fitted window rather than the 940px starting guess.
    window.electronAPI.settingsFitToContent();
  }
})();
