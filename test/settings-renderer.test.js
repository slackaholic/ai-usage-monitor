'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads the real mergeAccountPatch out of settings-renderer.js and runs it in
// isolation — no DOM, no window.electronAPI, because the function itself
// touches neither. This is the seam Task 9's review round asked for: the
// save*() functions used to build their patch object from scratch over only
// the currently-visible ACCOUNT_PAIRS, and because saveSettings() does a
// shallow merge in main.js, that wholesale-replaced the entire stored
// object — silently deleting the saved price/date/multiplier/override for
// any account not part of *this* session's registry scan (e.g. a second
// Claude Code account whose credentials briefly expired). mergeAccountPatch
// is what fixes that: it starts from the previously stored object and
// overlays only the update set, so an absent account's data survives an
// unrelated save untouched.
function loadMergeAccountPatch() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'settings-renderer.js'), 'utf8');
  const start = source.indexOf('function mergeAccountPatch');
  const end = source.indexOf('async function loadAccounts');
  assert.ok(start >= 0 && end > start, 'expected mergeAccountPatch source markers');

  const context = { module: {} };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nmodule.exports = mergeAccountPatch;', context);
  return context.module.exports;
}

test('mergeAccountPatch preserves a key the update set never mentions', () => {
  const mergeAccountPatch = loadMergeAccountPatch();
  // The regression scenario: claude-vscode's account isn't in this session's
  // registry (e.g. its credentials briefly expired), so it never appears in
  // `updates` — but its previously saved price must survive an unrelated
  // Codex price edit.
  const current = { codex: 20, 'claude-desktop': 0, 'claude-vscode': 200 };
  const updates = { codex: 25, 'claude-desktop': undefined };

  const merged = mergeAccountPatch(current, updates);

  // `merged` is a plain object created inside the vm context, so it carries
  // that realm's Object.prototype — deepStrictEqual treats a cross-realm
  // prototype as a mismatch even when every property matches. Spreading it
  // into a fresh object here (this file's realm) normalizes that; it isn't
  // masking anything about mergeAccountPatch's own behaviour.
  assert.deepStrictEqual({ ...merged }, { codex: 25, 'claude-vscode': 200 });
});

test('mergeAccountPatch deletes a key when the update maps it to undefined', () => {
  const mergeAccountPatch = loadMergeAccountPatch();
  // savePlanPrices/savePlanMultipliers send `undefined` for a cleared or
  // invalid field on a currently-visible account — that account's stored
  // value should be removed, matching the pre-Task-9 behaviour for the fixed
  // three accounts (an invalid/empty field was never included in the saved
  // object).
  const current = { codex: 20, 'claude-desktop': 5 };

  const merged = mergeAccountPatch(current, { codex: undefined });

  assert.deepStrictEqual({ ...merged }, { 'claude-desktop': 5 });
});

test('mergeAccountPatch overwrites a key the update set does mention', () => {
  const mergeAccountPatch = loadMergeAccountPatch();
  const current = { codex: 20 };

  const merged = mergeAccountPatch(current, { codex: 30 });

  assert.deepStrictEqual({ ...merged }, { codex: 30 });
});

test('mergeAccountPatch treats a missing current object as empty rather than throwing', () => {
  const mergeAccountPatch = loadMergeAccountPatch();

  const merged = mergeAccountPatch(undefined, { codex: 20 });

  assert.deepStrictEqual({ ...merged }, { codex: 20 });
});

test('mergeAccountPatch does not mutate its `current` argument', () => {
  const mergeAccountPatch = loadMergeAccountPatch();
  const current = { codex: 20 };

  const merged = mergeAccountPatch(current, { codex: 30, claude: 1 });

  assert.deepStrictEqual(current, { codex: 20 }, 'current must be left untouched');
  assert.notStrictEqual(merged, current, 'must return a new object, not the same reference');
});

test('mergeAccountPatch with an empty update set returns an equal but distinct copy', () => {
  const mergeAccountPatch = loadMergeAccountPatch();
  const current = { codex: 20, 'claude-desktop': 1 };

  const merged = mergeAccountPatch(current, {});

  assert.deepStrictEqual({ ...merged }, current);
  assert.notStrictEqual(merged, current);
});
