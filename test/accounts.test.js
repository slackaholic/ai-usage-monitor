'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  deriveLogKey, deriveAccountId, deriveDisplayName, isDefaultDir, samePath,
  resolveHomeDir, resolveDefaultConfigDir,
} = require('../accounts.js');

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

test('a symlinked ~/.claude keeps rank 0 and the claude-vscode log key', async () => {
  // ~/.claude is ITSELF a junction pointing off the home directory — the usual
  // way to move Claude's config off the system drive. Every scanned entry comes
  // back realpath'd (the TARGET), while a plain resolve(join(home, '.claude'))
  // yields the LINK. Compare those two without resolving the default the same
  // way and the default entry loses rank 0 — so a same-account collapse can keep
  // the wrong directory's key — and derives 'claude-code:<target-basename>'
  // instead of 'claude-vscode', detaching 7,099 existing usage-log entries.
  //
  // '.claude-alt' is an ordinary second account whose real path sorts
  // alphabetically BEFORE the junction target's ('<tmp>/acct-…' < '<tmp>/zz-…'),
  // so under the bug both entries fall to rank 1 and it takes first place.
  const home = fakeHome({ '.claude-alt': OAUTH });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-claude-target-'));
  fs.writeFileSync(path.join(target, '.credentials.json'), JSON.stringify(OAUTH));
  fs.symlinkSync(target, path.join(home, '.claude'), 'junction');

  try {
    const dirs = await scanClaudeCodeConfigDirs({ homeDir: home, env: {} });
    assert.strictEqual(dirs.length, 2);
    // realpathSync.native, matching the CLAUDE_CONFIG_DIR test above: TEMP is an
    // 8.3 short path on some machines, and `dirs` always comes back expanded.
    const realTarget = fs.realpathSync.native(target);
    assert.ok(samePath(dirs[0], realTarget), `expected the junction target to sort first, got ${dirs[0]}`);

    const defaultDir = await resolveDefaultConfigDir(home);
    const accts = groupIntoAccounts(dirs, { homeDir: home, defaultDir, knownEmails: {} });
    assert.strictEqual(accts[0].logKey, 'claude-vscode', 'history must stay attached to the default dir');
    assert.strictEqual(accts[0].id, 'claude2');
  } finally {
    // Unlink the junction itself before removing the tree, so the recursive
    // delete can never walk through it into the target.
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
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

// ── Identity collisions between same-named dirs under different parents ─────

const WORK_A = path.join(HOME, '.claude-work');
const WORK_B = path.join('D:', 'configs', '.claude-work');

test('two config dirs sharing a basename get distinct ids AND distinct log keys', () => {
  // Both derive from path.basename, so both used to come out identical. The
  // shared log key is the dangerous half: two accounts appending under one key
  // interleave in usage-log.jsonl and corrupt the budget ratio, session
  // tracking and every analytics figure for both.
  const accts = groupIntoAccounts([path.join(HOME, '.claude'), WORK_A, WORK_B], {
    homeDir: HOME, knownEmails: {},
  });

  assert.strictEqual(accts.length, 3);
  assert.notStrictEqual(accts[1].logKey, accts[2].logKey, 'two accounts must never share a log key');
  assert.notStrictEqual(accts[1].id, accts[2].id, 'two accounts must never share a DOM id');
  // Still recognisable as that directory, just disambiguated.
  assert.ok(accts[1].logKey.startsWith('claude-code:.claude-work-'), accts[1].logKey);
  assert.ok(accts[2].logKey.startsWith('claude-code:.claude-work-'), accts[2].logKey);
  assert.ok(accts[1].id.startsWith('cc-claude-work-'), accts[1].id);
});

test('two config dirs sharing a basename also get distinct display names', () => {
  // The id and log key were already disambiguated, so no DATA was ever
  // misattributed — but both rows still READ the same, which is how a plan
  // price or a multiplier gets typed against the wrong account. The human-facing
  // half of the collision matters as much as the machine-facing half.
  const accts = groupIntoAccounts([WORK_A, WORK_B], { homeDir: HOME, knownEmails: {} });

  assert.strictEqual(accts.length, 2);
  assert.notStrictEqual(accts[0].detail, accts[1].detail, 'two accounts must never read alike');
  assert.notStrictEqual(accts[0].displayName, accts[1].displayName);
  // Still recognisable as that directory, just disambiguated.
  assert.ok(accts[0].detail.startsWith('.claude-work ('), accts[0].detail);
  assert.ok(accts[0].displayName.startsWith('Claude Code (.claude-work ('), accts[0].displayName);
});

test('detail is the email once it resolves, the config dir name until then', () => {
  const accts = groupIntoAccounts([path.join(HOME, '.claude'), WORK_A], {
    homeDir: HOME,
    knownEmails: { [path.join(HOME, '.claude')]: 'me@example.com' },
  });

  assert.strictEqual(accts[0].detail, 'me@example.com');
  assert.strictEqual(accts[0].displayName, 'me@example.com');
  // No profile call has landed for this one yet.
  assert.strictEqual(accts[1].label, null);
  assert.strictEqual(accts[1].detail, '.claude-work');
  assert.strictEqual(accts[1].displayName, 'Claude Code (.claude-work)');
});

test('a basename collision never moves the default dir off claude-vscode/claude2', () => {
  const accts = groupIntoAccounts([path.join(HOME, '.claude'), WORK_A, WORK_B], {
    homeDir: HOME, knownEmails: {},
  });
  assert.strictEqual(accts[0].logKey, 'claude-vscode');
  assert.strictEqual(accts[0].id, 'claude2');
});

test('a unique basename is left un-suffixed', () => {
  const accts = groupIntoAccounts([path.join(HOME, '.claude'), WORK_A], { homeDir: HOME, knownEmails: {} });
  assert.strictEqual(accts[1].logKey, 'claude-code:.claude-work');
  assert.strictEqual(accts[1].id, 'cc-claude-work');
});

test('the disambiguating suffix is stable across calls', () => {
  // It has to be: the log key IS the history. A suffix that varied between runs
  // would fork an account's history on every restart.
  const once  = groupIntoAccounts([WORK_A, WORK_B], { homeDir: HOME, knownEmails: {} });
  const twice = groupIntoAccounts([WORK_A, WORK_B], { homeDir: HOME, knownEmails: {} });
  assert.deepStrictEqual(once.map(a => a.logKey), twice.map(a => a.logKey));
  assert.deepStrictEqual(once.map(a => a.id), twice.map(a => a.id));
});

test('same-named dirs that collapse onto one account keep the bare key', () => {
  // Disambiguation runs after grouping, so a collapse is not a collision: one
  // descriptor, one key, and no gratuitous suffix on a key that owns history.
  const accts = groupIntoAccounts([WORK_A, WORK_B], {
    homeDir: HOME,
    knownEmails: { [WORK_A]: 'me@example.com', [WORK_B]: 'me@example.com' },
  });
  assert.strictEqual(accts.length, 1);
  assert.strictEqual(accts[0].logKey, 'claude-code:.claude-work');
  assert.strictEqual(accts[0].id, 'cc-claude-work');
});

// ── displayName: the one fallback all three windows share ───────────────────

test('displayName falls back to the config dir name, so two accounts differ', () => {
  const accts = groupIntoAccounts([path.join(HOME, '.claude'), WORK_A], { homeDir: HOME, knownEmails: {} });
  assert.strictEqual(accts[0].displayName, 'Claude Code (.claude)');
  assert.strictEqual(accts[1].displayName, 'Claude Code (.claude-work)');
  assert.notStrictEqual(accts[0].displayName, accts[1].displayName,
    'two unlabelled accounts must not present the same name in Settings/Analytics');
});

test('displayName is the email once it resolves', () => {
  const accts = groupIntoAccounts([path.join(HOME, '.claude')], {
    homeDir: HOME, knownEmails: { [path.join(HOME, '.claude')]: 'me@example.com' },
  });
  assert.strictEqual(accts[0].displayName, 'me@example.com');
});

test('deriveDisplayName degrades rather than returning an empty name', () => {
  assert.strictEqual(deriveDisplayName({ label: null, configDir: '', id: 'claude2' }), 'Claude Code (claude2)');
  assert.strictEqual(deriveDisplayName(), 'Claude Code');
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
