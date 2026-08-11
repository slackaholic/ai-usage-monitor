'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { deriveLogKey, deriveAccountId, isDefaultDir, resolveHomeDir } = require('../accounts.js');

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

test('scan is self-consistent when homeDir is an alias of the real directory', async () => {
  // realHome is the actual directory holding the login. aliasHome is a
  // directory junction pointing at it — a stand-in for any case where the
  // raw homeDir a caller passes in diverges from its own realpath (Windows
  // 8.3 short names, symlinks, junctions). Every scanned entry always comes
  // back realpath'd, so aliasHome's raw form is a *different string entirely*
  // from realHome's realpath, not just a case/short-name variant of it.
  const realHome = fakeHome({ '.claude': OAUTH });
  const aliasHome = path.join(os.tmpdir(), 'acct-alias-' + Date.now());
  fs.symlinkSync(realHome, aliasHome, 'junction');

  // A second, unrelated account whose real path sorts alphabetically before
  // the default .claude dir's real path. Under the bug, the sort's rank()
  // never recognises the default entry (because it compares against the raw,
  // unresolved aliasHome instead of its realpath), so both entries fall back
  // to rank 1 and the tie-break is pure alphabetical — putting this account
  // first instead of the default one.
  const extraAcctDir = fs.mkdtempSync(path.join(os.tmpdir(), '0acct-'));
  fs.writeFileSync(path.join(extraAcctDir, '.credentials.json'), JSON.stringify(OAUTH));

  const dirs = await scanClaudeCodeConfigDirs({ homeDir: aliasHome, env: {}, extraPaths: [extraAcctDir] });
  const resolvedHome = await resolveHomeDir(aliasHome);
  assert.ok(isDefaultDir(dirs[0], resolvedHome), `expected ${dirs[0]} to be the default dir under ${resolvedHome}`);

  fs.rmSync(aliasHome, { recursive: true, force: true });
  fs.rmSync(realHome, { recursive: true, force: true });
  fs.rmSync(extraAcctDir, { recursive: true, force: true });
});

const { groupIntoAccounts } = require('../accounts.js');

test('each dir becomes its own account when no emails are known', () => {
  const dirs = [path.join(HOME, '.claude'), path.join(HOME, '.claude-work')];
  const accts = groupIntoAccounts(dirs, { homeDir: HOME, knownEmails: {} });

  assert.strictEqual(accts.length, 2);
  assert.strictEqual(accts[0].id, 'claude2');
  assert.strictEqual(accts[0].logKey, 'claude-vscode');
  assert.strictEqual(accts[0].label, null);
  assert.deepStrictEqual(accts[0].configDirs, [path.join(HOME, '.claude')]);
  assert.strictEqual(accts[1].id, 'cc-claude-work');
  assert.strictEqual(accts[1].logKey, 'claude-code:.claude-work');
});

test('dirs sharing an email collapse into one account, keeping the first dir identity', () => {
  const a = path.join(HOME, '.claude');
  const b = path.join(HOME, '.claude-work');
  const accts = groupIntoAccounts([a, b], {
    homeDir: HOME,
    knownEmails: { [a]: 'me@example.com', [b]: 'me@example.com' },
  });

  assert.strictEqual(accts.length, 1);
  assert.strictEqual(accts[0].logKey, 'claude-vscode', 'history must not fork onto the second dir');
  assert.strictEqual(accts[0].configDir, a);
  assert.deepStrictEqual(accts[0].configDirs, [a, b]);
  assert.strictEqual(accts[0].label, 'me@example.com');
});

test('different emails stay separate accounts', () => {
  const a = path.join(HOME, '.claude');
  const b = path.join(HOME, '.claude-work');
  const accts = groupIntoAccounts([a, b], {
    homeDir: HOME,
    knownEmails: { [a]: 'one@example.com', [b]: 'two@example.com' },
  });

  assert.strictEqual(accts.length, 2);
  assert.strictEqual(accts[0].label, 'one@example.com');
  assert.strictEqual(accts[1].label, 'two@example.com');
});

test('a dir with a known email does not swallow one whose email is still unknown', () => {
  const a = path.join(HOME, '.claude');
  const b = path.join(HOME, '.claude-work');
  const accts = groupIntoAccounts([a, b], { homeDir: HOME, knownEmails: { [a]: 'me@example.com' } });

  assert.strictEqual(accts.length, 2, 'unresolved dirs stay distinct until their email lands');
  assert.strictEqual(accts[1].label, null);
});

const { readCredentials, writeCredentialsAtomic } = require('../accounts.js');

test('readCredentials parses a dir\'s credentials, or returns null', () => {
  const home = fakeHome({ '.claude': OAUTH, '.claude-broken': null });
  fs.writeFileSync(path.join(home, '.claude-broken', '.credentials.json'), 'not json');

  assert.strictEqual(readCredentials(path.join(home, '.claude')).claudeAiOauth.accessToken, 'tok');
  assert.strictEqual(readCredentials(path.join(home, '.claude-broken')), null);
  assert.strictEqual(readCredentials(path.join(home, 'nope')), null);

  fs.rmSync(home, { recursive: true, force: true });
});

test('writeCredentialsAtomic replaces the file and leaves no temp behind', () => {
  const home = fakeHome({ '.claude': OAUTH });
  const dir = path.join(home, '.claude');

  const ok = writeCredentialsAtomic(dir, { claudeAiOauth: { accessToken: 'fresh' } });

  assert.strictEqual(ok, true);
  assert.strictEqual(readCredentials(dir).claudeAiOauth.accessToken, 'fresh');
  assert.deepStrictEqual(fs.readdirSync(dir), ['.credentials.json'], 'no .tmp-* left over');

  fs.rmSync(home, { recursive: true, force: true });
});

test('writeCredentialsAtomic reports failure instead of throwing', () => {
  const ok = writeCredentialsAtomic(path.join(os.tmpdir(), 'acct-missing-xyz'), { a: 1 });
  assert.strictEqual(ok, false);
});

test('writeCredentialsAtomic actually creates a temp file and renames it (proves atomicity)', () => {
  const home = fakeHome({ '.claude': OAUTH });
  const dir = path.join(home, '.claude');
  const originalRename = fs.renameSync;
  let tempFileExistedAtRename = false;
  let targetExistedAtRename = false;

  try {
    // Stub fs.renameSync to capture state at the moment rename would occur
    fs.renameSync = (src, dst) => {
      // At this moment, the temp file should exist and the target should still exist
      tempFileExistedAtRename = fs.existsSync(src);
      targetExistedAtRename = fs.existsSync(dst);
      // Now call the original rename to complete the operation
      originalRename(src, dst);
    };

    const ok = writeCredentialsAtomic(dir, { claudeAiOauth: { accessToken: 'fresh' } });

    assert.strictEqual(ok, true);
    assert.strictEqual(tempFileExistedAtRename, true, 'temp file must exist at rename time');
    assert.strictEqual(targetExistedAtRename, true, 'target must exist at rename time (proves not in-place write)');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('writeCredentialsAtomic preserves original file on rename failure', () => {
  const home = fakeHome({ '.claude': OAUTH });
  const dir = path.join(home, '.claude');
  const originalContent = readCredentials(dir);
  const originalRename = fs.renameSync;

  try {
    // Stub fs.renameSync to simulate a failure
    fs.renameSync = () => {
      throw new Error('Simulated rename failure');
    };

    const ok = writeCredentialsAtomic(dir, { claudeAiOauth: { accessToken: 'fresh' } });

    // The write should have failed
    assert.strictEqual(ok, false);
    // The original credentials should still be intact
    assert.deepStrictEqual(readCredentials(dir), originalContent, 'original credentials must survive failed write');
    // No temp files should be left behind
    const entries = fs.readdirSync(dir);
    assert.ok(!entries.some(e => e.includes('.tmp-')), 'temp file must be cleaned up on failure');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
