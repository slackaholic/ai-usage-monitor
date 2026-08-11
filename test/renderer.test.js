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
function loadClaudeCodeEmail({ cached = null, lookup = async () => '' } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('function claudeEmailCacheKey');
  const end = source.indexOf('async function fetchClaudeCodeUsage');
  assert.ok(start >= 0 && end > start, 'expected Claude Code email source markers');

  const store = new Map();
  if (cached !== null) store.set(EMAIL_KEY, JSON.stringify(cached));

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

test('an unchanged email does not rewrite the cache every poll', async () => {
  const { refreshClaudeCodeEmail, labels, writes } = loadClaudeCodeEmail({
    cached: 'same@example.com',
    lookup: async () => 'same@example.com',
  });

  await refreshClaudeCodeEmail(ACCT);

  assert.deepStrictEqual(labels, [['claude2', 'same@example.com']]);
  assert.deepStrictEqual(writes, []);
});

// Loads the card-cloning helper out of renderer.js the same way, so the id
// namespacing that keeps two accounts' cards apart is checked without a DOM.
function loadCardCloner() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('function stampCardIds');
  const end = source.indexOf('async function buildClaudeCodeCards');
  assert.ok(start >= 0 && end > start, 'expected card-cloner source markers');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.stampCardIds;
}

test('stamping rewrites every data-id into a prefixed id', () => {
  const stampCardIds = loadCardCloner();
  const nodes = [
    { dataset: { id: 'section' }, id: '', removeAttribute() { delete this.dataset.id; } },
    { dataset: { id: '5h-pct' },  id: '', removeAttribute() { delete this.dataset.id; } },
  ];
  const root = { querySelectorAll: () => nodes };

  stampCardIds(root, 'cc-claude-work');

  assert.strictEqual(nodes[0].id, 'cc-claude-work-section');
  assert.strictEqual(nodes[1].id, 'cc-claude-work-5h-pct');
});
