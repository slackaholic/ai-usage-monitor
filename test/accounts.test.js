'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { deriveLogKey, deriveAccountId } = require('../accounts.js');

const HOME = path.join('C:', 'Users', 'someone');

test('the default config dir keeps the claude-vscode log key', () => {
  // 7,099 existing usage-log entries hang off this exact string. If this test
  // ever fails, history has been orphaned — do not "fix" it by updating the
  // expectation.
  assert.strictEqual(deriveLogKey(path.join(HOME, '.claude'), HOME), 'claude-vscode');
});

test('any other config dir gets its own namespaced log key', () => {
  assert.strictEqual(deriveLogKey(path.join(HOME, '.claude-work'), HOME), 'claude-code:.claude-work');
  assert.strictEqual(deriveLogKey(path.join('D:', 'cfg', 'claude-alt'), HOME), 'claude-code:claude-alt');
});

test('the default config dir keeps the claude2 renderer prefix', () => {
  assert.strictEqual(deriveAccountId(path.join(HOME, '.claude'), HOME), 'claude2');
});

test('other config dirs get a slugified cc- prefix', () => {
  assert.strictEqual(deriveAccountId(path.join(HOME, '.claude-work'), HOME), 'cc-claude-work');
  assert.strictEqual(deriveAccountId(path.join(HOME, '.claude.Personal'), HOME), 'cc-claude-personal');
});

test('a directory name with nothing slug-able still yields a usable id', () => {
  assert.strictEqual(deriveAccountId(path.join(HOME, '...'), HOME), 'cc-account');
});
