'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The existing ~/.claude account: the descriptor the main process hands the
// renderer, and the localStorage key its email is cached under.
const ACCT = { id: 'claude2', logKey: 'claude-vscode', configDir: 'C:\\x\\.claude' };
const EMAIL_KEY = 'claude-code-email:claude-vscode';

// Loads the Claude Code account-email block out of renderer.js and runs it in a
// stub context: `applyAccountLabel` is a spy, `localStorage` is a Map, and the
// live lookup is whatever the caller hands in.
function loadClaudeCodeEmail({ cached = null, legacy = null, lookup = async () => '' } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('function claudeEmailCacheKey');
  const end = source.indexOf('async function fetchClaudeCodeUsage');
  assert.ok(start >= 0 && end > start, 'expected Claude Code email source markers');

  const store = new Map();
  if (cached !== null) store.set(EMAIL_KEY, JSON.stringify(cached));
  if (legacy !== null) store.set('claude2-email-v2', JSON.stringify(legacy));

  const labels = [];
  const writes = [];
  const context = {
    JSON,
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push([k, String(v)]); store.set(k, String(v)); },
    },
    window: { electronAPI: { fetchClaudeCodeEmail: lookup } },
    applyAccountLabel: (key, value) => labels.push([key, value]),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { ...context, labels, writes, store };
}

test('a switched Claude Code account replaces the cached email on the label', async () => {
  const { refreshClaudeCodeEmail, labels, store } = loadClaudeCodeEmail({
    cached: 'old@example.com',
    lookup: async () => 'new@example.com',
  });

  const result = await refreshClaudeCodeEmail(ACCT);

  assert.strictEqual(result, 'new@example.com');
  assert.deepStrictEqual(labels.at(-1), ['claude2', 'new@example.com']);
  assert.strictEqual(store.get(EMAIL_KEY), JSON.stringify('new@example.com'));
});

test('the cached email paints first so the label is never blank while resolving', async () => {
  let resolveLookup;
  const { refreshClaudeCodeEmail, labels } = loadClaudeCodeEmail({
    cached: 'old@example.com',
    lookup: () => new Promise((r) => { resolveLookup = r; }),
  });

  const pending = refreshClaudeCodeEmail(ACCT);
  assert.deepStrictEqual(labels, [['claude2', 'old@example.com']]);

  resolveLookup('new@example.com');
  await pending;
  assert.deepStrictEqual(labels.at(-1), ['claude2', 'new@example.com']);
});

test('a first-run lookup with no cache labels and caches the email', async () => {
  const { refreshClaudeCodeEmail, labels, store } = loadClaudeCodeEmail({
    lookup: async () => 'first@example.com',
  });

  await refreshClaudeCodeEmail(ACCT);

  assert.deepStrictEqual(labels, [['claude2', 'first@example.com']]);
  assert.strictEqual(store.get(EMAIL_KEY), JSON.stringify('first@example.com'));
});

test('a failed lookup keeps the cached email rather than blanking the label', async () => {
  const { refreshClaudeCodeEmail, labels, writes, store } = loadClaudeCodeEmail({
    cached: 'old@example.com',
    lookup: async () => '',
  });

  const result = await refreshClaudeCodeEmail(ACCT);

  assert.strictEqual(result, 'old@example.com');
  assert.deepStrictEqual(labels, [['claude2', 'old@example.com']]);
  assert.deepStrictEqual(writes, []);
  assert.strictEqual(store.get(EMAIL_KEY), JSON.stringify('old@example.com'));
});

test('the legacy email cache carries over to the per-account key on first read', () => {
  const { readClaudeCodeEmailCache, store, writes } = loadClaudeCodeEmail({
    legacy: 'carried@example.com',
  });

  // The existing card must not lose its label just because the key moved.
  assert.strictEqual(readClaudeCodeEmailCache(ACCT), 'carried@example.com');
  assert.strictEqual(store.get(EMAIL_KEY), JSON.stringify('carried@example.com'));
  assert.deepStrictEqual(writes, [[EMAIL_KEY, JSON.stringify('carried@example.com')]]);
});

test('a second account does not inherit the existing card\'s cached email', () => {
  const { readClaudeCodeEmailCache, writes } = loadClaudeCodeEmail({
    legacy: 'carried@example.com',
  });
  const other = { id: 'cc-claude-work', logKey: 'claude-code:work', configDir: 'C:\\x\\.claude-work' };

  assert.strictEqual(readClaudeCodeEmailCache(other), null);
  assert.deepStrictEqual(writes, []);
});

test('an unchanged email does not rewrite the cache every poll', async () => {
  const { refreshClaudeCodeEmail, labels, writes } = loadClaudeCodeEmail({
    cached: 'same@example.com',
    lookup: async () => 'same@example.com',
  });

  await refreshClaudeCodeEmail(ACCT);

  assert.deepStrictEqual(labels, [['claude2', 'same@example.com']]);
  assert.deepStrictEqual(writes, []);
});

// Loads the card-cloning helpers out of renderer.js the same way, so the id
// namespacing that keeps two accounts' cards apart — and the headings that tell
// them apart on screen — are checked without a DOM.
function loadCardCloner({ claudeAccounts = [], accountOverrides = {} } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('function stampCardIds');
  const end = source.indexOf('async function buildClaudeCodeCards');
  assert.ok(start >= 0 && end > start, 'expected card-cloner source markers');
  const context = { console, claudeAccounts, accountOverrides };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

const stampable = (attrs) => ({
  dataset: { ...attrs }, id: '',
  removeAttribute(name) { delete this.dataset[name.replace('data-', '')]; },
});

test('stamping rewrites every data-id into a prefixed id', () => {
  const { stampCardIds } = loadCardCloner();
  const nodes = [
    { dataset: { id: 'section' }, id: '', removeAttribute() { delete this.dataset.id; } },
    { dataset: { id: '5h-pct' },  id: '', removeAttribute() { delete this.dataset.id; } },
  ];
  const root = { querySelectorAll: () => nodes };

  stampCardIds(root, 'cc-claude-work');

  assert.strictEqual(nodes[0].id, 'cc-claude-work-section');
  assert.strictEqual(nodes[1].id, 'cc-claude-work-5h-pct');
  // The attribute has to go: a card stamped twice would double-prefix into
  // cc-claude-work-cc-claude-work-section and address nothing.
  assert.strictEqual(nodes[0].dataset.id, undefined);
  assert.strictEqual(nodes[1].dataset.id, undefined);
});

test('compact stamping gives the container and its spans different prefixes', () => {
  const { stampCardIds, stampCompactIds } = loadCardCloner();
  const spans      = [stampable({ id: '5h' }), stampable({ id: '5h-trend' })];
  const containers = [stampable({ cs: '5h' }), stampable({ cs: 'wk' })];
  const root = { querySelectorAll: (sel) => (sel === '[data-id]' ? spans : containers) };

  stampCardIds(root, 'c-cc-claude-work');
  stampCompactIds(root, 'cc-claude-work');

  assert.strictEqual(spans[0].id, 'c-cc-claude-work-5h');
  assert.strictEqual(spans[1].id, 'c-cc-claude-work-5h-trend');
  assert.strictEqual(containers[0].id, 'cs-cc-claude-work-5h');
  assert.strictEqual(containers[1].id, 'cs-cc-claude-work-wk');
  // data-cs survives stamping: it is also the selector that removes only these
  // rows from a compact grid shared with Codex and Claude Desktop.
  assert.strictEqual(containers[0].dataset.cs, '5h');
});

test('a lone Claude Code account keeps the template headings untouched', () => {
  const acct = { id: 'claude2', configDir: 'C:\\Users\\r\\.claude', label: 'rommel@example.com' };
  const { accountSuffix, setHeadingSuffix } = loadCardCloner({ claudeAccounts: [acct] });

  assert.strictEqual(accountSuffix(acct), '');

  const heading = { firstChild: { nodeValue: 'Claude (VS Code)' }, dataset: {} };
  const compact = { firstChild: { nodeValue: 'Claude VS Code 5H' }, dataset: {} };
  setHeadingSuffix(heading, accountSuffix(acct));
  setHeadingSuffix(compact, accountSuffix(acct));

  assert.strictEqual(heading.firstChild.nodeValue, 'Claude (VS Code)');
  assert.strictEqual(compact.firstChild.nodeValue, 'Claude VS Code 5H');
  assert.strictEqual(heading.dataset.base, undefined); // not even rewritten
});

test('a second account suffixes the headings and later resolutions replace it', () => {
  const a = { id: 'claude2', configDir: 'C:\\Users\\r\\.claude', label: null };
  const b = { id: 'cc-claude-work', configDir: 'C:\\Users\\r\\.claude-work', label: null };
  const { accountSuffix, setHeadingSuffix } = loadCardCloner({ claudeAccounts: [a, b] });

  // Before any email resolves, the directory it came from is the distinguisher.
  assert.strictEqual(accountSuffix(b), '.claude-work');

  const heading = { firstChild: { nodeValue: 'Claude (VS Code)' }, dataset: {} };
  setHeadingSuffix(heading, accountSuffix(b));
  assert.strictEqual(heading.firstChild.nodeValue, 'Claude (VS Code) — .claude-work');

  // The OAuth profile lands later: the local-part replaces the suffix rather
  // than stacking onto it.
  b.label = 'work.account@example.com';
  setHeadingSuffix(heading, accountSuffix(b));
  assert.strictEqual(heading.firstChild.nodeValue, 'Claude (VS Code) — work.account');
});

test('a label override wins over the resolved email in the heading', () => {
  const a = { id: 'claude2', configDir: 'C:\\Users\\r\\.claude', label: 'personal@example.com' };
  const b = { id: 'cc-claude-work', configDir: 'C:\\Users\\r\\.claude-work', label: 'work@example.com' };
  const { accountSuffix } = loadCardCloner({
    claudeAccounts: [a, b],
    accountOverrides: { claude2: '', 'cc-claude-work': 'Day job' },
  });

  assert.strictEqual(accountSuffix(a), 'personal');
  assert.strictEqual(accountSuffix(b), 'Day job');
});
