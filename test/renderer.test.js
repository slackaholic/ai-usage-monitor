'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads the Claude Code account-email block out of renderer.js and runs it in a
// stub context: `applyAccountLabel` is a spy, `localStorage` is a Map, and the
// live lookup is whatever the caller hands in.
function loadClaude2Email({ cached = null, lookup = async () => '' } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('const CLAUDE2_EMAIL_KEY');
  const end = source.indexOf('async function fetchClaudeWebUsage2');
  assert.ok(start >= 0 && end > start, 'expected Claude Code email source markers');

  const store = new Map();
  if (cached !== null) store.set('claude2-email-v2', JSON.stringify(cached));

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
  const { refreshClaude2Email, labels, store } = loadClaude2Email({
    cached: 'old@example.com',
    lookup: async () => 'new@example.com',
  });

  const result = await refreshClaude2Email();

  assert.strictEqual(result, 'new@example.com');
  assert.deepStrictEqual(labels.at(-1), ['claude2', 'new@example.com']);
  assert.strictEqual(store.get('claude2-email-v2'), JSON.stringify('new@example.com'));
});

test('the cached email paints first so the label is never blank while resolving', async () => {
  let resolveLookup;
  const { refreshClaude2Email, labels } = loadClaude2Email({
    cached: 'old@example.com',
    lookup: () => new Promise((r) => { resolveLookup = r; }),
  });

  const pending = refreshClaude2Email();
  assert.deepStrictEqual(labels, [['claude2', 'old@example.com']]);

  resolveLookup('new@example.com');
  await pending;
  assert.deepStrictEqual(labels.at(-1), ['claude2', 'new@example.com']);
});

test('a first-run lookup with no cache labels and caches the email', async () => {
  const { refreshClaude2Email, labels, store } = loadClaude2Email({
    lookup: async () => 'first@example.com',
  });

  await refreshClaude2Email();

  assert.deepStrictEqual(labels, [['claude2', 'first@example.com']]);
  assert.strictEqual(store.get('claude2-email-v2'), JSON.stringify('first@example.com'));
});

test('a failed lookup keeps the cached email rather than blanking the label', async () => {
  const { refreshClaude2Email, labels, writes, store } = loadClaude2Email({
    cached: 'old@example.com',
    lookup: async () => '',
  });

  const result = await refreshClaude2Email();

  assert.strictEqual(result, 'old@example.com');
  assert.deepStrictEqual(labels, [['claude2', 'old@example.com']]);
  assert.deepStrictEqual(writes, []);
  assert.strictEqual(store.get('claude2-email-v2'), JSON.stringify('old@example.com'));
});

test('an unchanged email does not rewrite the cache every poll', async () => {
  const { refreshClaude2Email, labels, writes } = loadClaude2Email({
    cached: 'same@example.com',
    lookup: async () => 'same@example.com',
  });

  await refreshClaude2Email();

  assert.deepStrictEqual(labels, [['claude2', 'same@example.com']]);
  assert.deepStrictEqual(writes, []);
});
