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
  const labels = [];
  const budgets = [];
  const saved = [];
  const shown = [];
  let resizes = 0;
  const context = {
    document: { getElementById: (id) => el(id) },
    window: { electronAPI: { appendUsageLog: (e) => logged.push(e) } },
    Date, Math, Number, Object,
    applyAccountLabel: (id, v) => labels.push([id, v]),
    renderStat: (prefix, win, pct, placeholder) => {
      el(`${prefix}-${win}-pct`).textContent = pct != null ? pct + '%' : (placeholder || '—');
    },
    renderBudget: (id, pct) => budgets.push([id, pct]),
    setText: (id, v) => { el(id).textContent = v ?? '—'; },
    fmtResetIn: (ms) => 'in:' + ms,
    fmtResetOn: (ms) => 'on:' + ms,
    pushTrend: (k, v) => trends.push([k, v]),
    saveCachedData: (id, r) => saved.push([id, r]),
    buildUsageEntry: (account, p5, pw, r5, rw) => ({ account, '5h': p5, wk: pw, r5, rw }),
    trackSession: () => '2026-10-07T00:00:00.000Z',
    showSection: (id, v) => shown.push([id, v]),
    resizeToFit: () => { resizes++; },
    noFiveHourWindow: new Set(),
    // Declared at renderer.js:38, outside this slice, so the context has
    // to supply it or the exact-session branch throws ReferenceError.
    sessionStore: { 'lk-claude2': { start: null, lastPct: null },
                    'claude-vscode': { start: null, lastPct: null } },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { ...context, el, logged, trends, labels, budgets, saved, shown,
           resizeCount: () => resizes };
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

// The one behaviour that genuinely differs between providers, and the reason
// it is a descriptor property rather than a branch. Claude Code's 5h header
// gives the window's END, so the start is exactly five hours earlier; every
// other provider has to infer it from a quota jump. Without this test the
// refactor could drop the exact path entirely and stay green.
test('exactSessionFromReset places the session from the reset, not a jump', () => {
  const c = loadRenderer();
  c.renderAccountData(
    { id: 'claude2', logKey: 'claude-vscode', exactSessionFromReset: true },
    { ...READING, reset5hMs: Date.UTC(2026, 9, 7, 17, 0, 0) });

  const expected = new Date(Date.UTC(2026, 9, 7, 12, 0, 0)).toISOString();
  assert.strictEqual(c.logged[0].sessionStart, expected,
    'five hours before the reset, not trackSession\'s stub value');
  assert.strictEqual(c.sessionStore['claude-vscode'].start, expected,
    'and the session store is advanced too');
  assert.strictEqual(c.sessionStore['claude-vscode'].lastPct, 55);
});

test('without the flag the session comes from trackSession', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'codex', logKey: 'codex' },
    { ...READING, reset5hMs: Date.UTC(2026, 9, 7, 17, 0, 0) });
  assert.strictEqual(c.logged[0].sessionStart, '2026-10-07T00:00:00.000Z',
    'the stub, so the exact path did not run');
});

// The exact path needs a window end to subtract from. A Claude Code reading
// whose reset header is missing carries reset5hMs 0 ("unknown"), and must fall
// back to the quota-jump inference rather than place a session five hours
// before the epoch.
test('exactSessionFromReset falls back to trackSession when the reset is unknown', () => {
  const c = loadRenderer();
  c.renderAccountData(
    { id: 'claude2', logKey: 'claude-vscode', exactSessionFromReset: true },
    { ...READING, reset5hMs: 0 });
  assert.strictEqual(c.logged[0].sessionStart, '2026-10-07T00:00:00.000Z',
    'trackSession\'s stub value, not a start computed from a missing reset');
  assert.strictEqual(c.sessionStore['claude-vscode'].start, null,
    'and the exact path did not write the session store');
});

test('a provider with no 5h window records no session at all', () => {
  const c = loadRenderer();
  c.renderAccountData(
    { id: 'claude2', logKey: 'claude-vscode', exactSessionFromReset: true },
    { ...READING, pct5h: null, has5h: false });
  assert.ok(!('sessionStart' in c.logged[0]),
    'carrying the last session forward would freeze the session count');
});

test('an account with no extras and no hook renders without error', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'claude', logKey: 'claude-desktop' }, { ...READING });
  assert.strictEqual(c.el('claude-5h-pct').textContent, '55%');
});

// The tests above pin what differs between providers. The ones below pin what
// is the same, which matters more: all three old render functions did these
// things, and a refactor that quietly dropped one would stay green because
// every provider would be wrong in the same way.
test('each collaborator receives the field it is meant to', () => {
  const c = loadRenderer();
  const reading = { ...READING };
  c.renderAccountData({ id: 'codex', logKey: 'lk-codex' }, reading);

  assert.strictEqual(c.el('codex-5h-reset').textContent, 'in:1000', '5h reset is a countdown');
  assert.strictEqual(c.el('codex-wk-reset').textContent, 'on:2000', 'weekly reset is a date');
  assert.deepStrictEqual(c.trends, [['codex-5h', 55], ['codex-wk', 86]]);
  assert.deepStrictEqual(c.budgets, [['codex', 55]], 'the budget marker follows the 5h figure');
  assert.deepStrictEqual(c.labels, [['codex', 'x@example.com']]);
  assert.strictEqual(c.saved.length, 1);
  assert.deepStrictEqual(c.saved[0], ['codex', reading], 'the cache is keyed by id and holds the reading');
  // Reset timestamps are what lets analytics tell a quota reset from a drop.
  assert.strictEqual(c.logged[0].r5, 1000);
  assert.strictEqual(c.logged[0].rw, 2000);
});

test('a card is revealed and resized after every render', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'codex', logKey: 'codex' }, { ...READING });
  assert.strictEqual(c.el('codex-login-prompt').style.display, 'none');
  assert.strictEqual(c.el('codex-data').style.display, 'block');
  assert.deepStrictEqual(c.shown, [['codex-section', true]]);
  assert.strictEqual(c.resizeCount(), 1);
});

test('a stale render neither relabels nor re-caches, but still repaints', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'codex', logKey: 'codex' }, { ...READING }, true);
  assert.strictEqual(c.labels.length, 0, 'a cached label must not overwrite a live one');
  assert.strictEqual(c.saved.length, 0, 'the cache is not rewritten from itself');
  assert.deepStrictEqual(c.budgets, [['codex', 55]], 'the budget still repaints');
  assert.deepStrictEqual(c.shown, [['codex-section', true]]);
});

test('the no-5h-window flag follows the reading, set and cleared', () => {
  const c = loadRenderer();
  const acct = { id: 'codex', logKey: 'codex' };
  c.renderAccountData(acct, { ...READING, pct5h: null, has5h: false });
  assert.ok(c.noFiveHourWindow.has('codex'), 'renderBudget reads this to explain the empty tile');
  c.renderAccountData(acct, { ...READING });
  assert.ok(!c.noFiveHourWindow.has('codex'), 'a window that comes back clears the flag');
});

test('a missing weekly window reads n/a and blanks its reset line', () => {
  const c = loadRenderer();
  c.renderAccountData({ id: 'codex', logKey: 'codex' },
    { ...READING, pctWk: null, hasWk: false });
  assert.strictEqual(c.el('codex-wk-pct').textContent, 'n/a');
  assert.strictEqual(c.el('codex-wk-reset').textContent, '');
});

// ── The callers of the render path ─────────────────────────────────────────
// renderAccountData is only as good as what feeds it. The fetchers decide
// whether a poll has data at all, and the cache loaders decide what a cold
// start paints; both had to be repointed from three provider vocabularies to
// one, and a missed field name there fails silently — an undefined never
// equals null, so a guard written against the old names simply stops firing.
// These slice the callers and run them against a spy for the render path.
function loadCallers(api) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const slice = (open, close) => {
    const a = source.indexOf(open);
    const b = source.indexOf(close, a);
    assert.ok(a >= 0 && b > a, `expected source markers: ${open}`);
    return source.slice(a, b);
  };
  const regions = [
    ['// ── READING SHAPE ──',  '// ── READING SHAPE END ──'],
    ['// ── RESET PARSING ──',  '// ── RESET PARSING END ──'],
    ['// ── CLAUDE PARSERS ──', '// ── CLAUDE PARSERS END ──'],
    ['// ── CODEX PARSERS ──',  '// ── CODEX PARSERS END ──'],
  ].map(([o, c]) => slice(o, c)).join('\n');
  const code = regions + '\n' +
    slice('async function fetchClaudeWebUsage', '// ── Claude Code (VS Code / CLI)') + '\n' +
    slice('async function fetchClaudeCodeUsage', '// ── Codex ──') + '\n' +
    slice('async function fetchCodexUsage', '// ── Cached data (stale display on startup)') + '\n' +
    slice('function loadCachedStaticData', '// ── Refresh interval');

  const calls = [], badges = [], toasts = [], retries = [], applied = [];
  const context = {
    console, Math, Number, RegExp, Date, parseInt, isNaN, Object,
    window: { electronAPI: { readUsageLog: async () => [], ...api } },
    renderAccountData: (acct, reading, stale) => calls.push({ acct, reading: { ...reading }, stale: !!stale }),
    setBadge: (id, text, cls) => badges.push([id, text, cls]),
    showToast: (m) => toasts.push(m),
    setTimeout: (fn, ms) => { retries.push(ms); return retries.length; },
    clearTimeout: () => {},
    fetchStart: () => {}, fetchStop: () => {}, markUpdated: () => {},
    renderClaudeTokens: () => {}, renderTrendAnalytics: () => {},
    applyAccountLabel: (id, v) => applied.push([id, v]),
    readClaudeCodeEmailCache: (acct) => (acct.id === 'claude2' ? 'cached@example.com' : null),
    openPanels: new Set(),
    hasData: { codex: false, claude: false, claude2: false },
    cachedData: {},
    claudeRetryTimers: {},
    refreshClaudeCodeEmail: async () => {},
    document: { getElementById: () => null },
    showSection: () => {}, resizeToFit: () => {},
    claudeAccounts: [{ id: 'claude2', logKey: 'claude-vscode' }],
    PROVIDERS: [{ id: 'codex', logKey: 'codex' }, { id: 'claude', logKey: 'claude-desktop' }],
    claudeRetryTimer: null, codexRetryTimer: null,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { ...context, calls, badges, toasts, retries, applied };
}

const CODEX_WEEKLY_ONLY = {
  rate_limit: { primary_window: { used_percent: 14, limit_window_seconds: 604800, reset_at: 2_000_000_000 } },
};

test('an empty Codex poll reports no data and never reaches the render', async () => {
  const c = loadCallers({ fetchCodexUsage: async () => ({ text: '', email: 'a@example.com' }) });
  await c.fetchCodexUsage();
  assert.deepStrictEqual(c.badges.at(-1), ['codex-badge', 'No data', 'warn']);
  assert.strictEqual(c.calls.length, 0, 'an empty reading would be logged as a null 5h and a null wk');
  assert.deepStrictEqual(c.retries, [45_000]);
});

test('a Codex poll with a weekly figure only renders it, under the codex descriptor', async () => {
  const c = loadCallers({ fetchCodexUsage: async () => ({ apiData: CODEX_WEEKLY_ONLY }) });
  await c.fetchCodexUsage();
  assert.strictEqual(c.calls.length, 1);
  assert.strictEqual(c.calls[0].acct.id, 'codex');
  assert.strictEqual(c.calls[0].reading.pctWk, 86);
  assert.strictEqual(c.calls[0].reading.has5h, false);
  assert.strictEqual(c.calls[0].stale, false);
  assert.deepStrictEqual(c.badges.at(-1), ['codex-badge', 'Live', 'ok']);
});

test('Codex API data with no windows falls back to the scraped text', async () => {
  const c = loadCallers({ fetchCodexUsage: async () => ({
    apiData: { rate_limit: {} },
    text: 'Weekly usage limit 90% remaining Resets in 3d',
  }) });
  await c.fetchCodexUsage();
  assert.strictEqual(c.calls.length, 1, 'an API reply that measured nothing must not win');
  assert.strictEqual(c.calls[0].reading.pctWk, 90);
});

test('the Codex label is the poll\'s email unless the data carries its own', async () => {
  let c = loadCallers({ fetchCodexUsage: async () => ({ apiData: CODEX_WEEKLY_ONLY, email: 'poll@example.com' }) });
  await c.fetchCodexUsage();
  assert.strictEqual(c.calls[0].reading.label, 'poll@example.com');

  c = loadCallers({ fetchCodexUsage: async () => (
    { apiData: { ...CODEX_WEEKLY_ONLY, email: 'data@example.com' }, email: 'poll@example.com' }) });
  await c.fetchCodexUsage();
  assert.strictEqual(c.calls[0].reading.label, 'data@example.com');
});

test('an empty Claude Desktop poll reports no data and never reaches the render', async () => {
  const c = loadCallers({ fetchClaudeWebUsage: async () => ({ apiData: {}, text: '' }) });
  await c.fetchClaudeWebUsage();
  assert.deepStrictEqual(c.badges.at(-1), ['claude-badge', 'No data', 'warn']);
  assert.strictEqual(c.calls.length, 0);
});

test('a Claude Desktop poll renders under the claude descriptor, labelled with its email', async () => {
  const c = loadCallers({ fetchClaudeWebUsage: async () => ({
    apiData: { five_hour: { utilization: 36 }, seven_day: { utilization: 13 } },
    email: 'me@example.com',
  }) });
  await c.fetchClaudeWebUsage();
  assert.strictEqual(c.calls.length, 1);
  assert.strictEqual(c.calls[0].acct.id, 'claude');
  assert.strictEqual(c.calls[0].reading.pct5h, 64);
  assert.strictEqual(c.calls[0].reading.pctWk, 87);
  assert.strictEqual(c.calls[0].reading.label, 'me@example.com');
});

test('a Claude Code poll renders its own descriptor from the normalised reading', async () => {
  const acct = { id: 'claude2', logKey: 'claude-vscode', configDir: 'C:\\x' };
  const c = loadCallers({ fetchClaudeCodeApiUsage: async () => (
    { pct5h: 55, pct7d: 86, reset5hMs: 123, reset7dMs: 456, account: 'max 20x' }) });
  await c.fetchClaudeCodeUsage(acct);
  assert.strictEqual(c.calls.length, 1);
  assert.strictEqual(c.calls[0].acct, acct, 'the descriptor itself, so its flags travel with it');
  assert.strictEqual(c.calls[0].reading.pct5h, 55);
  assert.strictEqual(c.calls[0].reading.pctWk, 86);
  assert.strictEqual(c.calls[0].reading.resetWkMs, 456);
  assert.strictEqual(c.calls[0].reading.label, 'max 20x');
  assert.strictEqual(c.hasData.claude2, true);
  assert.deepStrictEqual(c.badges.at(-1), ['claude2-badge', 'Live', 'ok']);
});

test('a cold start paints each fixed provider from its legacy slot, stale and badged', () => {
  const c = loadCallers({});
  c.loadCachedStaticData({ lastKnown: {
    codex: { shared5h: null, sharedWeek: 77, credits: '9', email: 'c@example.com', has5h: false },
    claude: { sessionUsed: 30, weeklyUsed: 40 },
  } });
  assert.deepStrictEqual(c.calls.map(x => [x.acct.id, x.stale]), [['codex', true], ['claude', true]]);
  assert.strictEqual(c.calls[0].reading.pctWk, 77);
  assert.strictEqual(c.calls[0].reading.has5h, false);
  assert.strictEqual(c.calls[1].reading.pct5h, 70);
  assert.deepStrictEqual(c.badges, [['codex-badge', 'Cached', 'stale'], ['claude-badge', 'Cached', 'stale']]);
});

test('a cold start skips a provider whose slot is missing or empty', () => {
  const c = loadCallers({});
  c.loadCachedStaticData({ lastKnown: { codex: {}, claude: null } });
  assert.strictEqual(c.calls.length, 0);
  assert.strictEqual(c.badges.length, 0, 'nothing to show, so nothing to badge as cached');
  c.loadCachedStaticData({});
  assert.strictEqual(c.calls.length, 0);
});

test('a Claude Code cold start seeds the cache map and paints only discovered accounts', () => {
  const c = loadCallers({});
  const kn = {
    claude2: { sessionUsed: 45, weeklyUsed: 14, account: 'max 20x' },
    gone: { sessionUsed: 1, weeklyUsed: 2 },
  };
  c.loadCachedClaudeCodeData({ lastKnown: kn });
  assert.deepStrictEqual(Object.keys(c.cachedData).sort(), ['claude2', 'gone'],
    'every slot is kept, or the next saveCachedData would write null over it');
  assert.deepStrictEqual(c.calls.map(x => [x.acct.id, x.stale]), [['claude2', true]]);
  assert.strictEqual(c.calls[0].reading.pct5h, 55);
  assert.strictEqual(c.calls[0].reading.pctWk, 86);
  assert.deepStrictEqual(c.badges, [['claude2-badge', 'Cached', 'stale']]);
  assert.deepStrictEqual(c.applied, [['claude2', 'cached@example.com']],
    'the remembered email replaces the tier string the cache holds');
});
