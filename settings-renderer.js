'use strict';

const ACCOUNTS = ['codex', 'claude-desktop', 'claude-vscode'];
const MULT_DEFAULTS = { 'codex': 5, 'claude-desktop': 1, 'claude-vscode': 1 };
const BUDGET_DEFAULTS = { window: 10, day: 20 };
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

  const tc = s.tierChangedAt || {};
  lastTierChangedAt = { ...tc };
  ACCOUNTS.forEach(a => { document.getElementById('tier-date-' + a).value = tc[a] || ''; });

  const pm = s.planMultipliers || {};
  ACCOUNTS.forEach(a => { document.getElementById('mult-' + a).value = pm[a] != null ? pm[a] : MULT_DEFAULTS[a]; });

  const bt = s.budgetTargets || {};
  document.getElementById('budget-window').value = bt.window != null ? bt.window : BUDGET_DEFAULTS.window;
  document.getElementById('budget-day').value    = bt.day    != null ? bt.day    : BUDGET_DEFAULTS.day;

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

// Last values seen from settings, so a field we decline to save keeps what it had.
// (saveSettings shallow-merges, so the patch must carry every account key —
// omitting one would drop its stored date entirely.)
let lastTierChangedAt = {};

function saveTierDates() {
  const tierChangedAt = {};
  ACCOUNTS.forEach(a => {
    const el = document.getElementById('tier-date-' + a);
    // A part-typed date leaves value === '' with validity.badInput true, and
    // `change` still fires on blur — saving that would silently wipe a stored
    // date. Treat incomplete entry as "no change"; a genuine clear has
    // badInput false and is saved as ''.
    if (el.validity && el.validity.badInput) {
      tierChangedAt[a] = lastTierChangedAt[a] || '';
      return;
    }
    tierChangedAt[a] = el.value || '';
  });
  lastTierChangedAt = { ...tierChangedAt };
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
  ACCOUNTS.forEach(a => {
    const v = parseFloat(document.getElementById('mult-' + a).value);
    if (!isNaN(v) && v > 0) planMultipliers[a] = v;
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
ACCOUNTS.forEach(a => document.getElementById('tier-date-' + a).addEventListener('change', saveTierDates));
ACCOUNTS.forEach(a => document.getElementById('tier-today-' + a).addEventListener('click', () => {
  document.getElementById('tier-date-' + a).value = todayLocalISO();
  saveTierDates();
}));
ACCOUNTS.forEach(a => document.getElementById('mult-' + a).addEventListener('change', savePlanMultipliers));
['budget-window', 'budget-day'].forEach(id =>
  document.getElementById(id).addEventListener('change', saveBudgetTargets));
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
