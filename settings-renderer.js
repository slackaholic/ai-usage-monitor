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

async function loadAccounts() {
  const accts = await window.electronAPI.getClaudeAccounts();
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
    row.innerHTML = `
      <div class="account-name"></div>
      <div class="row"><label>Plan price</label>
        <input type="number" id="price-${logKey}" min="0" step="1" placeholder="—">
        <input type="date" id="tier-date-${logKey}" class="tier-date" title="Plan/tier changed on">
        <button class="mini-btn" id="tier-today-${logKey}" type="button" title="Set to today">Today</button></div>
      <div class="row"><label>Multiplier</label>
        <input type="number" id="mult-${logKey}" min="0.1" step="0.1"><span class="suffix">x</span></div>
      <div class="row"><label>Label override</label>
        <input type="text" id="ov-${id}" placeholder="auto-detected"></div>`;
    // textContent, not the innerHTML template above — label can be a live
    // OAuth email once resolved, so it goes through the DOM API rather than
    // being interpolated as markup.
    row.querySelector('.account-name').textContent = label;
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
  const planPrices = {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => {
    const v = parseFloat(document.getElementById('price-' + logKey).value);
    if (!isNaN(v) && v > 0) planPrices[logKey] = v;
  });
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
  const tierChangedAt = {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => { tierChangedAt[logKey] = document.getElementById('tier-date-' + logKey).value || ''; });
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
  const planMultipliers = {};
  ACCOUNT_PAIRS.forEach(({ logKey }) => {
    const v = parseFloat(document.getElementById('mult-' + logKey).value);
    if (!isNaN(v) && v > 0) planMultipliers[logKey] = v;
  });
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
  const accountOverrides = {};
  ACCOUNT_PAIRS.forEach(({ id }) => { accountOverrides[id] = document.getElementById('ov-' + id).value.trim(); });
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
  const accts = await window.electronAPI.rescanClaudeAccounts();
  await loadAccounts();
  buildAccountRows();
  wireAccountRowListeners();
  await loadSettings();
  status(`Found ${accts.length} Claude Code account${accts.length === 1 ? '' : 's'}.`);
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
  await loadAccounts();
  buildAccountRows();
  wireAccountRowListeners();
  await loadSettings();
})();
