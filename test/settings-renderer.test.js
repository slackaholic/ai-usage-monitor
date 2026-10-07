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

// applyAccountDetails fills the second line of each account row. It is worth a
// test because the precedence is not obvious: Claude Code accounts carry their
// own `detail` on the descriptor, while Codex and Claude Desktop never go
// through the registry at all — their emails are resolved by the MONITOR window
// as a side effect of each usage fetch and persisted in `lastKnown.<id>`.
// Reading that is the whole point of this function.
//
// The `lastKnown` fixtures below come from persistLastKnown, which runs the
// monitor's real makeReading and saveCachedData, not from a hand-written
// literal. A hand-written { codex: { email } } kept passing after nothing in
// the app wrote that shape any more, while the feature it described was broken.
function persistLastKnown(polled) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const between = (open, close) => {
    const a = source.indexOf(open);
    const b = source.indexOf(close, a);
    assert.ok(a >= 0 && b > a, `expected renderer.js markers: ${open}`);
    return source.slice(a, b);
  };
  let written = null;
  const context = {
    cachedData: {},
    window: { electronAPI: { saveSettings: (o) => { written = o; } } },
  };
  vm.createContext(context);
  vm.runInContext(
    between('// ── READING SHAPE ──', '// ── READING SHAPE END ──') + '\n' +
    between('function saveCachedData', '// ── Claude Code accounts'),
    context);
  for (const [id, reading] of Object.entries(polled)) {
    context.saveCachedData(id, context.makeReading(reading));
  }
  // Through JSON, as it reaches settings.json and comes back.
  return JSON.parse(JSON.stringify(written.lastKnown));
}

function loadApplyAccountDetails(documentStub, pairs, settings) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'settings-renderer.js'), 'utf8');
  const start = source.indexOf('function applyAccountDetails');
  const end = source.indexOf('// Attaches the per-row listeners');
  assert.ok(start >= 0 && end > start, 'expected applyAccountDetails source markers');

  const context = { document: documentStub, ACCOUNT_PAIRS: pairs, lastSettings: settings, module: {} };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nmodule.exports = applyAccountDetails;', context);
  return context.module.exports;
}

function fakeDetailRows(ids) {
  const els = ids.map(id => ({ dataset: { for: id }, textContent: '' }));
  return { els, document: { querySelectorAll: () => els } };
}

test('applyAccountDetails reads the fixed accounts\' emails out of what a poll persists', () => {
  const { els, document } = fakeDetailRows(['codex', 'claude', 'claude2']);
  const applyAccountDetails = loadApplyAccountDetails(
    document,
    [
      { logKey: 'codex', id: 'codex', label: 'Codex' },
      { logKey: 'claude-desktop', id: 'claude', label: 'Claude Desktop' },
      { logKey: 'claude-vscode', id: 'claude2', label: 'Claude Code', detail: 'me@example.com' },
    ],
    { lastKnown: persistLastKnown({
      codex: { pctWk: 86, label: 'dev@example.com' },
      claude: { pct5h: 64, pctWk: 87, label: 'me@example.com' },
      // The label a Claude Code poll really persists: the plan name main.js
      // builds from the credentials' rateLimitTier, never an email.
      claude2: { pct5h: 55, pctWk: 86, label: 'max 20x' },
    }) },
  );

  applyAccountDetails();

  assert.strictEqual(els[0].textContent, 'dev@example.com');
  assert.strictEqual(els[1].textContent, 'me@example.com');
  // A Claude Code row shows the descriptor's own detail; its cached slot only
  // holds a plan name, which is not an identity and is never shown.
  assert.strictEqual(els[2].textContent, 'me@example.com');
});

// Nothing a real poll writes puts an email into a Claude Code slot, so the
// fixture above cannot exercise this. The precedence is still the contract: the
// descriptor knows which account the row is for, a cached slot only remembers
// the last poll. Hand-written, as the older-shape test below is.
test('applyAccountDetails lets the descriptor detail win over whatever its slot holds', () => {
  const { els, document } = fakeDetailRows(['claude2']);
  const applyAccountDetails = loadApplyAccountDetails(
    document,
    [{ logKey: 'claude-vscode', id: 'claude2', label: 'Claude Code', detail: 'me@example.com' }],
    { lastKnown: { claude2: { email: 'stale@example.com', label: 'other@example.com' } } },
  );

  applyAccountDetails();

  assert.strictEqual(els[0].textContent, 'me@example.com');
});

// settings.json is not rewritten until the next poll, so on the first run after
// an upgrade it still holds what the previous code wrote. That literal is
// hand-written on purpose: it is the one place the old shape legitimately lives.
test('applyAccountDetails still reads the email key an older settings.json holds', () => {
  const { els, document } = fakeDetailRows(['codex', 'claude']);
  const applyAccountDetails = loadApplyAccountDetails(
    document,
    [
      { logKey: 'codex', id: 'codex', label: 'Codex' },
      { logKey: 'claude-desktop', id: 'claude', label: 'Claude Desktop' },
    ],
    { lastKnown: { codex: { email: 'dev@example.com' }, claude: { email: 'me@example.com' } } },
  );

  applyAccountDetails();

  assert.strictEqual(els[0].textContent, 'dev@example.com');
  assert.strictEqual(els[1].textContent, 'me@example.com');
});

test('applyAccountDetails prefers the email key when a slot holds both', () => {
  const { els, document } = fakeDetailRows(['codex']);
  const applyAccountDetails = loadApplyAccountDetails(
    document,
    [{ logKey: 'codex', id: 'codex', label: 'Codex' }],
    { lastKnown: { codex: { email: 'kept@example.com', label: 'other@example.com' } } },
  );

  applyAccountDetails();

  assert.strictEqual(els[0].textContent, 'kept@example.com');
});

// Claude Code's reading carries the plan name as its label ('max 20x'), and
// saveCachedData persists that slot like any other. A plan is not the signed-in
// account, so it must not be shown as one.
test('applyAccountDetails never shows a plan name as the signed-in account', () => {
  const { els, document } = fakeDetailRows(['claude2']);
  const applyAccountDetails = loadApplyAccountDetails(
    document,
    [{ logKey: 'claude-vscode', id: 'claude2', label: 'Claude Code' }],
    { lastKnown: persistLastKnown({ claude2: { pct5h: 55, pctWk: 86, label: 'max 20x' } }) },
  );

  applyAccountDetails();

  assert.strictEqual(els[0].textContent, 'account not detected yet');
});

test('applyAccountDetails says so rather than leaving a blank line', () => {
  // Fresh install: nothing has been fetched yet, so no email is cached. A blank
  // second line would read as a rendering bug.
  const { els, document } = fakeDetailRows(['codex']);
  const applyAccountDetails = loadApplyAccountDetails(
    document,
    [{ logKey: 'codex', id: 'codex', label: 'Codex' }],
    {},
  );

  applyAccountDetails();

  assert.strictEqual(els[0].textContent, 'account not detected yet');
});
