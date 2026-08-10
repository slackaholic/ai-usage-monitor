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

const fs = require('node:fs');
const os = require('node:os');
const { scanClaudeCodeConfigDirs } = require('../accounts.js');

// Builds a fake home directory. `dirs` maps a name to the credentials object
// to write, or null to create the directory with no credentials file.
function fakeHome(dirs, files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
  for (const [name, creds] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(home, name), { recursive: true });
    if (creds) {
      fs.writeFileSync(path.join(home, name, '.credentials.json'), JSON.stringify(creds));
    }
  }
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, name), body);
  }
  return home;
}

const OAUTH = { claudeAiOauth: { accessToken: 'tok', refreshToken: 'ref', expiresAt: 1 } };

test('finds the default config dir', async () => {
  const home = fakeHome({ '.claude': OAUTH });
  const dirs = await scanClaudeCodeConfigDirs({ homeDir: home, env: {} });
  assert.strictEqual(dirs.length, 1);
  assert.strictEqual(path.basename(dirs[0]), '.claude');
  fs.rmSync(home, { recursive: true, force: true });
});

test('finds additional .claude* dirs, default first then alphabetical', async () => {
  const home = fakeHome({ '.claude-work': OAUTH, '.claude': OAUTH, '.claude-alt': OAUTH });
  const dirs = await scanClaudeCodeConfigDirs({ homeDir: home, env: {} });
  assert.deepStrictEqual(dirs.map(d => path.basename(d)), ['.claude', '.claude-alt', '.claude-work']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('ignores dirs with no credentials and files that merely look like config', async () => {
  const home = fakeHome(
    { '.claude': OAUTH, '.claude-empty': null },
    { '.claude.json': '{"some":"config"}', '.claude.json.bak-20260807': '{}' },
  );
  const dirs = await scanClaudeCodeConfigDirs({ homeDir: home, env: {} });
  assert.deepStrictEqual(dirs.map(d => path.basename(d)), ['.claude']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('ignores a credentials file that carries no OAuth token', async () => {
  const home = fakeHome({ '.claude': OAUTH, '.claude-stale': { claudeAiOauth: {} } });
  const dirs = await scanClaudeCodeConfigDirs({ homeDir: home, env: {} });
  assert.deepStrictEqual(dirs.map(d => path.basename(d)), ['.claude']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('honours CLAUDE_CONFIG_DIR pointing outside the home dir', async () => {
  const home = fakeHome({ '.claude': OAUTH });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-out-'));
  fs.writeFileSync(path.join(outside, '.credentials.json'), JSON.stringify(OAUTH));

  const dirs = await scanClaudeCodeConfigDirs({ homeDir: home, env: { CLAUDE_CONFIG_DIR: outside } });
  assert.strictEqual(dirs.length, 2);
  // fs.realpathSync.native, not fs.realpathSync: on Windows the legacy JS
  // realpath doesn't expand 8.3 short names (e.g. TEMP=...\ROMMEL~1\...),
  // while fs.promises.realpath (what accounts.js uses) does — using the
  // legacy variant here made this test fail on any machine whose username
  // contains a space, independent of scanClaudeCodeConfigDirs' correctness.
  assert.ok(dirs.some(d => d.toLowerCase() === fs.realpathSync.native(outside).toLowerCase()));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('extraPaths are included and duplicates collapse', async () => {
  const home = fakeHome({ '.claude': OAUTH });
  const dirs = await scanClaudeCodeConfigDirs({
    homeDir: home,
    env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
    extraPaths: [path.join(home, '.claude')],
  });
  assert.strictEqual(dirs.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a missing home dir yields no accounts rather than throwing', async () => {
  const missing = path.join(os.tmpdir(), 'acct-not-here-xyz');
  const dirs = await scanClaudeCodeConfigDirs({ homeDir: missing, env: {} });
  assert.deepStrictEqual(dirs, []);
});
