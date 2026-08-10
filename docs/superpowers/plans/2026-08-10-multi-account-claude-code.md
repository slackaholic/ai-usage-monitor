# Multiple Claude Code Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AI Usage Monitor show one card per Claude Code account, discovered from Claude config directories on this machine, instead of the single hardcoded `claude2` card.

**Architecture:** A new main-process module `accounts.js` owns everything about Claude config directories — finding them, deriving stable identities, and reading/writing their credentials. `main.js` keeps only the network calls and IPC, taking a config directory as a parameter instead of using a single constant. The renderer clones a card `<template>` once per discovered account and builds its state maps from the registry rather than from three-key literals. Settings and analytics read the same registry over IPC.

**Tech Stack:** Electron 28, CommonJS, `node --test` (no test framework, no new dependencies).

Design spec: [`docs/superpowers/specs/2026-08-10-multi-account-claude-code-design.md`](../specs/2026-08-10-multi-account-claude-code-design.md)

## Global Constraints

- **No new dependencies.** `package.json` gains nothing.
- **`metrics.js` must not be touched.** It is dual-loaded (browser global + CommonJS in tests) and must stay free of `Date.now()`, argless `new Date()`, and Node-only APIs.
- **`accounts.js` is a normal Node module** — `fs`, `os`, `path`, `Date` are all allowed, like `usage-reader.js`. It must NOT `require('electron')`, so `node --test` can load it directly.
- **Reads must not block the main thread.** Directory scanning uses `fs.promises`. Credential reads are single small files and may stay synchronous.
- **`~/.claude` must keep the log key `claude-vscode`.** 7,099 existing entries in `usage-log.jsonl` depend on it. Task 1 asserts this explicitly.
- **`SILENT_SETTINGS_KEYS` in `main.js` is `{lastKnown, x, y}`.** Do not add a per-poll settings write outside that set or every poll will broadcast `settings-changed` and make the analytics window refresh spuriously.
- **The whole suite must stay green.** It is 89 tests before this plan. Run `npm test` at every commit step.
- **Every changed JS file must pass `node --check <file>`.**
- **The Electron GUI cannot be launched in an agent environment.** Do not claim visual verification; say it is the user's step.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Stable identity derivation (`deriveLogKey`, `deriveAccountId`)

Pure functions mapping a config directory to the two identifiers everything else keys on. Nothing here touches the filesystem.

**Files:**
- Create: `accounts.js`
- Test: `test/accounts.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `deriveLogKey(configDir: string, homeDir: string) => string`, `deriveAccountId(configDir: string, homeDir: string) => string`. Both exported from `accounts.js`.

- [ ] **Step 1: Write the failing test**

Create `test/accounts.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/accounts.test.js`
Expected: FAIL — `Cannot find module '../accounts.js'`

- [ ] **Step 3: Write minimal implementation**

Create `accounts.js`:

```js
'use strict';
const path = require('path');

// Two directories are the same account directory if they resolve to the same
// path. Windows paths are case-insensitive, so compare case-folded.
function isDefaultDir(configDir, homeDir) {
  const a = path.resolve(configDir).toLowerCase();
  const b = path.resolve(path.join(homeDir, '.claude')).toLowerCase();
  return a === b;
}

// The usage-log account key. Derived from the DIRECTORY, never the email:
// emails change on re-login, and re-keying history on a login change orphans
// it. ~/.claude keeps 'claude-vscode' so existing history stays attached.
function deriveLogKey(configDir, homeDir) {
  if (isDefaultDir(configDir, homeDir)) return 'claude-vscode';
  return 'claude-code:' + path.basename(configDir);
}

// The renderer prefix / DOM id namespace. ~/.claude keeps 'claude2' so the
// existing markup, settings keys and localStorage entries keep working.
function deriveAccountId(configDir, homeDir) {
  if (isDefaultDir(configDir, homeDir)) return 'claude2';
  const slug = path.basename(configDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return 'cc-' + (slug || 'account');
}

module.exports = { deriveLogKey, deriveAccountId, isDefaultDir };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/accounts.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the whole suite and syntax**

Run: `node --check accounts.js && npm test`
Expected: 94 tests pass (89 existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add accounts.js test/accounts.test.js
git commit -m "feat(accounts): derive stable log key and renderer id from a config dir

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Discover Claude config directories

Finds every directory that actually holds a Claude Code login. Async, because it walks the home directory.

**Files:**
- Modify: `accounts.js`
- Test: `test/accounts.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 (independent function in the same file).
- Produces: `scanClaudeCodeConfigDirs({ homeDir, env, extraPaths }) => Promise<string[]>` — resolved, deduped, sorted with the default directory first.

- [ ] **Step 1: Write the failing test**

Append to `test/accounts.test.js`:

```js
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
  assert.ok(dirs.some(d => d.toLowerCase() === fs.realpathSync(outside).toLowerCase()));

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

test('an unreadable home dir still yields the default dir rather than throwing', async () => {
  const missing = path.join(os.tmpdir(), 'acct-not-here-xyz');
  const dirs = await scanClaudeCodeConfigDirs({ homeDir: missing, env: {} });
  assert.deepStrictEqual(dirs, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/accounts.test.js`
Expected: FAIL — `scanClaudeCodeConfigDirs is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `accounts.js` (above `module.exports`):

```js
const fsp = require('fs').promises;

// A directory counts as a Claude config dir only if it actually holds a login.
// This is what keeps ~/.claude.json and the .claude.json.bak* files out: they
// are not directories and carry no OAuth token.
async function hasOAuthCredentials(dir) {
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return false;
    const raw = await fsp.readFile(path.join(dir, '.credentials.json'), 'utf8');
    return Boolean(JSON.parse(raw)?.claudeAiOauth?.accessToken);
  } catch {
    return false;
  }
}

// Every Claude config directory on this machine, resolved and deduped.
// Order is stable — default dir first, then alphabetical — so cards never
// reshuffle between runs.
async function scanClaudeCodeConfigDirs({ homeDir, env = {}, extraPaths = [] }) {
  const candidates = [];
  if (env.CLAUDE_CONFIG_DIR) candidates.push(env.CLAUDE_CONFIG_DIR);
  candidates.push(path.join(homeDir, '.claude'));
  try {
    for (const e of await fsp.readdir(homeDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('.claude')) candidates.push(path.join(homeDir, e.name));
    }
  } catch {
    // Home unreadable — fall through with whatever explicit candidates we have.
  }
  candidates.push(...extraPaths);

  const seen = new Set();
  const found = [];
  for (const c of candidates) {
    if (!(await hasOAuthCredentials(c))) continue;
    let real;
    try { real = await fsp.realpath(c); } catch { real = path.resolve(c); }
    const key = real.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(real);
  }

  const def = path.resolve(path.join(homeDir, '.claude')).toLowerCase();
  found.sort((a, b) => {
    const rank = (p) => (p.toLowerCase() === def ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return found;
}
```

Extend the exports:

```js
module.exports = { deriveLogKey, deriveAccountId, isDefaultDir, scanClaudeCodeConfigDirs };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/accounts.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the whole suite**

Run: `node --check accounts.js && npm test`
Expected: 101 tests pass.

- [ ] **Step 6: Commit**

```bash
git add accounts.js test/accounts.test.js
git commit -m "feat(accounts): discover Claude config dirs by credentials, not by name

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Group directories into accounts

Turns the directory list into account descriptors, collapsing directories that resolve to the same Anthropic account. This is the piece that exists because the 5h/weekly quota is per account and shared across every surface — two directories on one account would otherwise render two identical cards and burn two probes.

**Files:**
- Modify: `accounts.js`
- Test: `test/accounts.test.js`

**Interfaces:**
- Consumes: `deriveLogKey`, `deriveAccountId` from Task 1.
- Produces: `groupIntoAccounts(dirs: string[], { homeDir: string, knownEmails: Record<string,string> }) => Descriptor[]` where `Descriptor` is `{ id, kind: 'claude-code', configDir, configDirs, logKey, label }`.

- [ ] **Step 1: Write the failing test**

Append to `test/accounts.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/accounts.test.js`
Expected: FAIL — `groupIntoAccounts is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `accounts.js`:

```js
// Directory identity is not account identity: two config dirs can hold logins
// for the SAME account, and because the quota is per-account and shared across
// every surface, they would render two cards with identical numbers. Once an
// email is known for both, they collapse into one descriptor — one card, one
// probe, one log key.
//
// Pure: `dirs` is already scanned and sorted, `knownEmails` is the persisted
// configDir -> email map. No filesystem, no network.
function groupIntoAccounts(dirs, { homeDir, knownEmails = {} }) {
  const byEmail = new Map();
  const accounts = [];

  for (const dir of dirs) {
    const email = knownEmails[dir] || null;
    if (email && byEmail.has(email)) {
      byEmail.get(email).configDirs.push(dir);
      continue;
    }
    const descriptor = {
      id: deriveAccountId(dir, homeDir),
      kind: 'claude-code',
      configDir: dir,
      configDirs: [dir],
      logKey: deriveLogKey(dir, homeDir),
      label: email,
    };
    if (email) byEmail.set(email, descriptor);
    accounts.push(descriptor);
  }
  return accounts;
}
```

Extend the exports:

```js
module.exports = {
  deriveLogKey, deriveAccountId, isDefaultDir,
  scanClaudeCodeConfigDirs, groupIntoAccounts,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/accounts.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Verify the whole suite**

Run: `node --check accounts.js && npm test`
Expected: 105 tests pass.

- [ ] **Step 6: Commit**

```bash
git add accounts.js test/accounts.test.js
git commit -m "feat(accounts): collapse config dirs that resolve to the same account

The 5h/weekly quota is per account and shared across every surface, so two
dirs on one account would render two identical cards and burn two probes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Per-directory credential read and atomic write

Moves credential disk I/O out of `main.js` so it can be tested, and makes the refresh write-back atomic — a running Claude Code process must never observe a half-written credentials file.

**Files:**
- Modify: `accounts.js`
- Test: `test/accounts.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `readCredentials(configDir) => object|null`, `writeCredentialsAtomic(configDir, creds) => boolean`.

- [ ] **Step 1: Write the failing test**

Append to `test/accounts.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/accounts.test.js`
Expected: FAIL — `readCredentials is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `accounts.js` (it already requires `path`; add the sync `fs` at the top alongside `fsp`):

```js
const fs = require('fs');

function credentialsPath(configDir) {
  return path.join(configDir, '.credentials.json');
}

function readCredentials(configDir) {
  try { return JSON.parse(fs.readFileSync(credentialsPath(configDir), 'utf8')); }
  catch { return null; }
}

// Write to a temp file in the same directory, then rename over the target.
// rename is atomic within a volume, so a Claude Code process reading this file
// mid-refresh sees either the old contents or the new ones, never a truncated
// file. It does NOT coordinate two writers — the loser's refresh is simply
// superseded, which is harmless because either token is valid.
function writeCredentialsAtomic(configDir, creds) {
  const target = credentialsPath(configDir);
  const tmp = target + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}
```

Extend the exports:

```js
module.exports = {
  deriveLogKey, deriveAccountId, isDefaultDir,
  scanClaudeCodeConfigDirs, groupIntoAccounts,
  readCredentials, writeCredentialsAtomic,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/accounts.test.js`
Expected: PASS, 19 tests.

- [ ] **Step 5: Verify the whole suite**

Run: `node --check accounts.js && npm test`
Expected: 108 tests pass.

- [ ] **Step 6: Commit**

```bash
git add accounts.js test/accounts.test.js
git commit -m "feat(accounts): per-dir credential read plus atomic refresh write-back

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Budget buckets from the log, not a fixed account list

`BUDGET_ACCOUNTS` is a three-element literal used to pre-seed the bucket map, and `readUsageLogGrouped` then drops any entry whose account is not in it (`if (byAccount[e.account])`). A new `claude-code:*` account would therefore have no budget data at all, and its card would read "need more history" permanently. Bucketing whatever the log actually contains removes the literal and fixes that in one move.

**Files:**
- Modify: `main.js:53` (the literal), `:68-70` (bucket seeding), `:95` (the budget loop)

**Interfaces:**
- Consumes: nothing.
- Produces: `get-budget-info` now returns a key per account **present in the log**, rather than exactly three.

- [ ] **Step 1: Delete the literal and bucket dynamically**

Remove line 53 (`const BUDGET_ACCOUNTS = [...]`) entirely. In `readUsageLogGrouped`, replace the seeding and filtering pair:

```js
  // Bucket every account the log actually contains. A fixed list here would
  // silently drop any account added later, leaving its card permanently on
  // "budget: need more history".
  const byAccount = {};
  for (const e of entries) {
    if (!e.account) continue;
    (byAccount[e.account] = byAccount[e.account] || []).push(e);
  }
```

- [ ] **Step 2: Iterate what was found**

In the `get-budget-info` handler, change the loop header:

```js
  for (const a of Object.keys(byAccount || {})) {
    const snaps = byAccount[a];
```

- [ ] **Step 3: Confirm no references survive**

Run: `grep -n "BUDGET_ACCOUNTS" main.js`
Expected: no output.

- [ ] **Step 4: Verify syntax and suite**

Run: `node --check main.js && npm test`
Expected: 108 tests pass.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "fix(budget): bucket every account in the log instead of a fixed three

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Make `main.js` credential handling per-directory

Retires the single `CREDENTIALS_PATH` constant. Behaviour for the existing single account must not change.

**Files:**
- Modify: `main.js:558-600` (the `CREDENTIALS_PATH` / `readCredentials` / `getValidClaudeCodeToken` block)

**Interfaces:**
- Consumes: `readCredentials`, `writeCredentialsAtomic` from Task 4.
- Produces: `getValidClaudeCodeToken(configDir) => Promise<string|null>` — every later task calls it with an explicit directory.

- [ ] **Step 1: Replace the block**

In `main.js`, add near the other requires at the top of the file:

```js
const accounts = require('./accounts.js');
```

Then replace lines 558-563 (the `CREDENTIALS_PATH` constant and the local `readCredentials`) with nothing — they are now provided by `accounts.js` — and rewrite `getValidClaudeCodeToken`:

```js
// Returns a valid Claude Code OAuth access token for ONE config directory,
// refreshing and persisting when within 5 min of expiry, or null when that
// directory has no credentials.
async function getValidClaudeCodeToken(configDir) {
  const creds = accounts.readCredentials(configDir);
  if (!creds?.claudeAiOauth?.accessToken) return null;
  let token = creds.claudeAiOauth.accessToken;
  if (creds.claudeAiOauth.expiresAt < Date.now() + 300_000) {
    const refreshed = await refreshOAuthToken(creds.claudeAiOauth.refreshToken);
    if (refreshed?.access_token) {
      token = refreshed.access_token;
      accounts.writeCredentialsAtomic(configDir, {
        ...creds,
        claudeAiOauth: {
          ...creds.claudeAiOauth,
          accessToken: token,
          expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
        },
      });
    }
  }
  return token;
}
```

- [ ] **Step 2: Find every remaining caller**

Run: `grep -n "CREDENTIALS_PATH\|readCredentials(\|getValidClaudeCodeToken(" main.js`
Expected: no `CREDENTIALS_PATH` hits remain; every `readCredentials(` and `getValidClaudeCodeToken(` call site now passes a directory. Fix any that do not — Task 6 rewrites the two IPC handlers that call them.

- [ ] **Step 3: Verify syntax and suite**

Run: `node --check main.js && npm test`
Expected: 108 tests pass (no test covers `main.js` directly; this step is checking nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "refactor(main): take a config dir instead of a single credentials path

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Per-account IPC — usage, email, and the registry

**Files:**
- Modify: `main.js:629-768` (the two Claude Code IPC handlers and the email memo)
- Modify: `preload.js:44-46`

**Interfaces:**
- Consumes: `getValidClaudeCodeToken(configDir)` from Task 6; `scanClaudeCodeConfigDirs`, `groupIntoAccounts` from Tasks 2-3; `isDefaultDir` from Task 1.
- Produces, on `window.electronAPI`:
  - `fetchClaudeCodeApiUsage(configDir: string)` → same shape as today plus `configDir`
  - `fetchClaudeCodeEmail(configDir: string)` → `Promise<string>`
  - `getClaudeAccounts()` → `Promise<Descriptor[]>`
  - `rescanClaudeAccounts()` → `Promise<Descriptor[]>`

- [ ] **Step 1: Make both existing handlers per-account**

In `main.js`, change the usage handler's signature and its credential reads:

```js
ipcMain.handle('fetch-claude-code-api-usage', async (_evt, configDir) => {
  const creds = accounts.readCredentials(configDir);
  if (!creds?.claudeAiOauth?.accessToken) return { error: 'no-credentials' };

  const tier = creds.claudeAiOauth?.rateLimitTier ?? '';
  const sub  = creds.claudeAiOauth?.subscriptionType ?? '';
  const account = tier.replace('default_', '').replace(/_/g, ' ') || sub || 'Claude Code';

  const token = await getValidClaudeCodeToken(configDir);
  // ...unchanged from here: the https request, and
  //    resolve({ ...limits, account, configDir });
});
```

The only change inside the response callback is adding `configDir` to the resolved object, so the renderer can route a reply to the right card.

Replace the module-level email memo (currently two single-account variables) with per-directory maps:

```js
// Per config directory: the resolved email memoised against the access token
// that produced it, so a repeat poll costs nothing while a re-login (new token)
// forces a re-resolve. Failures get a cooldown rather than retrying every poll,
// because the browser fallback opens a hidden window and can take 20s. Both are
// keyed by token, so a re-login is never held back by either.
const claudeCodeEmailMemo = new Map();     // configDir -> { token, email }
const claudeCodeEmailFailure = new Map();  // configDir -> { token, retryAt }
const CLAUDE_CODE_EMAIL_RETRY_MS = 10 * 60 * 1000;

ipcMain.handle('fetch-claude-code-email', async (_evt, configDir) => {
  const token = await getValidClaudeCodeToken(configDir);

  const memo = claudeCodeEmailMemo.get(configDir);
  if (memo?.email && memo.token === token) return memo.email;

  const failure = claudeCodeEmailFailure.get(configDir);
  if (failure && failure.token === token && Date.now() < failure.retryAt) return '';

  if (token) {
    const email = await fetchClaudeCodeProfileEmail(token);
    if (email) { claudeCodeEmailMemo.set(configDir, { token, email }); return email; }
  }

  // Browser-session fallback: only meaningful for the default config dir. The
  // Electron partitions hold at most one claude.ai login, so running this for a
  // second config dir would label it with the wrong account's email — exactly
  // the bug fixed on 2026-07-07.
  if (accounts.isDefaultDir(configDir, os.homedir())) {
    // Keep the existing loop over ['persist:claude-web-vscode', 'persist:claude-web']
    // verbatim — the cookie check, the hidden BrowserWindow, the 20s timeout and
    // EMAIL_ONLY_SCRIPT are all unchanged. Only its success line changes, from
    // `if (email) return email;` to:
    //     if (email) { claudeCodeEmailMemo.set(configDir, { token, email }); return email; }
  }

  claudeCodeEmailFailure.set(configDir, { token, retryAt: Date.now() + CLAUDE_CODE_EMAIL_RETRY_MS });
  return '';
});
```

- [ ] **Step 2: Add the registry handlers**

Add to `main.js`, after the email handler:

```js
// The registry. Scanning touches the filesystem and only runs on demand;
// grouping is pure and re-runs whenever an email resolves, so a same-account
// collapse takes effect without waiting for a rescan.
let scannedConfigDirs = null;

async function buildClaudeAccounts({ rescan = false } = {}) {
  const settings = loadSettings();
  if (rescan || !scannedConfigDirs) {
    scannedConfigDirs = await accounts.scanClaudeCodeConfigDirs({
      homeDir: os.homedir(),
      env: process.env,
      extraPaths: settings.claudeExtraConfigDirs || [],
    });
  }
  return accounts.groupIntoAccounts(scannedConfigDirs, {
    homeDir: os.homedir(),
    knownEmails: settings.claudeAccountEmails || {},
  });
}

ipcMain.handle('get-claude-accounts',    () => buildClaudeAccounts());
ipcMain.handle('rescan-claude-accounts', () => buildClaudeAccounts({ rescan: true }));
```

Whenever `fetch-claude-code-email` resolves an email, persist it so grouping survives a restart. Add this right before each `return email;` in that handler:

```js
      const map = { ...(loadSettings().claudeAccountEmails || {}), [configDir]: email };
      saveSettings({ claudeAccountEmails: map });
```

`loadSettings()` and `saveSettings(patch)` are the existing helpers, defined at `main.js:23` and `:26`. This write is infrequent — only when an email first resolves or changes — so it correctly stays outside `SILENT_SETTINGS_KEYS` and is allowed to broadcast.

- [ ] **Step 3: Widen the preload bridge**

In `preload.js`, replace the two Claude Code lines with:

```js
  // Claude Code API usage — one call per account config directory
  fetchClaudeCodeApiUsage: (configDir) => ipcRenderer.invoke('fetch-claude-code-api-usage', configDir),
  fetchClaudeCodeEmail:    (configDir) => ipcRenderer.invoke('fetch-claude-code-email', configDir),

  // Claude Code account registry
  getClaudeAccounts:    () => ipcRenderer.invoke('get-claude-accounts'),
  rescanClaudeAccounts: () => ipcRenderer.invoke('rescan-claude-accounts'),
```

- [ ] **Step 4: Verify syntax and suite**

Run: `node --check main.js && node --check preload.js && npm test`
Expected: 108 tests pass.

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat(main): per-account Claude Code IPC plus an account registry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Render one card per account

The largest task. The `claude2` card becomes a template cloned per account, and the renderer's three-key literals become registry-derived maps.

**Files:**
- Modify: `index.html` (the `claude2-section` block, the compact grid, `.content`)
- Modify: `renderer.js:1-100` (state maps), `:855-950` (the Claude Code fetch), `:1036-1075` (cached data, refresh interval), `:1137-1180` (init)
- Test: `test/renderer.test.js`

**Interfaces:**
- Consumes: `getClaudeAccounts()`, `fetchClaudeCodeApiUsage(configDir)`, `fetchClaudeCodeEmail(configDir)` from Task 7.
- Produces: `claudeAccounts` — the in-renderer descriptor array; `accountPrefixes()` returning every active prefix including `codex` and `claude`.

- [ ] **Step 1: Turn the card markup into a template**

In `index.html`, wrap the existing `claude2-section` markup in a template and add a container. Every `id="claude2-…"` inside becomes `data-id="…"`, and the clone step stamps the real ids:

```html
<div id="claude-code-cards"></div>

<template id="tpl-claude-code-card">
  <div class="section" data-id="section">
    <!-- the existing claude2-section contents, with each id="claude2-X"
         rewritten to data-id="X" and nothing else changed -->
  </div>
</template>
```

Do the same for the two compact stats (`cs-claude2-5h`, `cs-claude2-wk`) in a second template, `tpl-claude-code-compact`.

- [ ] **Step 2: Write the failing test for id stamping**

Append to `test/renderer.test.js`:

```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/renderer.test.js`
Expected: FAIL — "expected card-cloner source markers"

- [ ] **Step 4: Implement cloning and per-account state**

In `renderer.js`, replace the three-key literals with registry-derived state. Add above `fetchClaudeWebUsage2`:

```js
// ── Claude Code accounts ───────────────────────────────────────────────────
let claudeAccounts = [];          // descriptors from the main process
const claudeRetryTimers = {};     // account id -> timer, replacing claude2RetryTimer

function stampCardIds(root, prefix) {
  for (const el of root.querySelectorAll('[data-id]')) {
    el.id = prefix + '-' + el.dataset.id;
    el.removeAttribute('data-id');
  }
}

async function buildClaudeCodeCards() {
  claudeAccounts = await window.electronAPI.getClaudeAccounts();
  const host = document.getElementById('claude-code-cards');
  const cardTpl = document.getElementById('tpl-claude-code-card');
  const compactTpl = document.getElementById('tpl-claude-code-compact');
  const compactHost = document.querySelector('#compact-view .compact-grid');
  host.replaceChildren();

  for (const acct of claudeAccounts) {
    const card = cardTpl.content.cloneNode(true);
    stampCardIds(card, acct.id);
    host.appendChild(card);

    const compact = compactTpl.content.cloneNode(true);
    stampCardIds(compact, 'cs-' + acct.id);
    compactHost.appendChild(compact);

    hasData[acct.id]         = false;
    cachedData[acct.id]      = null;
    lastPct5h[acct.id]       = null;
    LOG_ACCOUNT[acct.id]     = acct.logKey;
    trendHistory[acct.id + '-5h'] = [];
    trendHistory[acct.id + '-wk'] = [];
    _ss[acct.logKey] = _ss[acct.logKey] || { start: null, lastPct: null };
    if (!(acct.id in accountOverrides)) accountOverrides[acct.id] = '';

    document.getElementById(acct.id + '-refresh')
      .addEventListener('click', () => fetchClaudeCodeUsage(acct));
  }
}
```

Change `hasData`, `cachedData`, `lastPct5h`, `LOG_ACCOUNT`, `accountOverrides` and `trendHistory` from literals containing `claude2` to literals containing only `codex` and `claude` — `buildClaudeCodeCards` adds the rest.

Rewrite `fetchClaudeWebUsage2` to take an account, replacing its body's `'claude2'` literals with `acct.id`:

```js
async function fetchClaudeCodeUsage(acct) {
  clearTimeout(claudeRetryTimers[acct.id]); claudeRetryTimers[acct.id] = null;
  fetchStart(acct.id);

  const result = await window.electronAPI.fetchClaudeCodeApiUsage(acct.configDir);
  fetchStop(acct.id);

  if (result.error === 'no-credentials') {
    setBadge(acct.id + '-badge', 'No credentials', 'error');
    return;
  }
  if (result.error) {
    setBadge(acct.id + '-badge', 'Error', 'error');
    claudeRetryTimers[acct.id] = setTimeout(() => fetchClaudeCodeUsage(acct), 45_000);
    return;
  }

  hasData[acct.id] = true;
  renderClaudeCodeApiData(acct, result);
  setBadge(acct.id + '-badge', 'Live', 'ok');
  if (openPanels.has(acct.id)) {
    window.electronAPI.readUsageLog(acct.logKey, 200).then(e => renderTrendAnalytics(acct.id, e));
  }
  markUpdated();
  refreshClaudeCodeEmail(acct).catch(e => console.error('claude code email refresh:', e));
}
```

Delete `let claude2RetryTimer = null;` — `claudeRetryTimers` replaces it.

`renderClaudeCodeApiData(acct, data, stale)` takes the descriptor and uses `acct.id` for every DOM id and `acct.logKey` for `buildUsageEntry` and `_ss`.

`refreshClaude2Email` is renamed `refreshClaudeCodeEmail(acct)` and becomes per-account throughout — including its two helpers and the call in `loadCachedData`:

```js
function claudeEmailCacheKey(acct) {
  // Keyed by logKey, not by email: the label may change under us, the key must not.
  return 'claude-code-email:' + acct.logKey;
}

function readClaudeCodeEmailCache(acct) {
  const key = claudeEmailCacheKey(acct);
  try {
    const own = JSON.parse(localStorage.getItem(key) || 'null');
    if (own) return own;
    // One-time carry-over so the existing card keeps its label on first run.
    if (acct.logKey === 'claude-vscode') {
      const legacy = JSON.parse(localStorage.getItem('claude2-email-v2') || 'null');
      if (legacy) { localStorage.setItem(key, JSON.stringify(legacy)); return legacy; }
    }
    return null;
  } catch { return null; }
}

async function refreshClaudeCodeEmail(acct) {
  const cached = readClaudeCodeEmailCache(acct);
  if (cached) applyAccountLabel(acct.id, cached);
  const email = await window.electronAPI.fetchClaudeCodeEmail(acct.configDir);
  if (!email || email === cached) return cached;
  localStorage.setItem(claudeEmailCacheKey(acct), JSON.stringify(email));
  applyAccountLabel(acct.id, email);
  return email;
}
```

The five existing tests in `test/renderer.test.js` drive `refreshClaude2Email` against a fixed `'claude2-email-v2'` key and a zero-argument call. Update their harness to build a descriptor (`{ id: 'claude2', logKey: 'claude-vscode', configDir: 'C:\\x\\.claude' }`), pass it in, and expect the `claude-code-email:claude-vscode` key. Their assertions — switched account, paint-before-resolve, first run, failed lookup, unchanged email — all still apply unchanged and must still pass.

`loadCachedData` also changes: its `if (kn.claude2)` branch becomes a loop over `claudeAccounts`, reading `kn[acct.id]` and calling `renderClaudeCodeApiData(acct, {...}, true)` with the new leading argument.

Replace the four intervals in `setRefreshInterval` with one fan-out timer:

```js
  refreshIntervalIds = [setInterval(() => {
    fetchClaudeWebUsage();
    fetchCodexUsage();
    claudeAccounts.forEach(fetchClaudeCodeUsage);
    refreshBudget();
  }, seconds * 1000)];
```

In `init()`, call `await buildClaudeCodeCards()` before `loadCachedData(settings)`, and replace the single `fetchClaudeWebUsage2()` call with `claudeAccounts.forEach(fetchClaudeCodeUsage)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --check renderer.js && node --test test/renderer.test.js`
Expected: PASS — the six existing renderer tests plus the new stamping test.

- [ ] **Step 6: Verify the whole suite**

Run: `npm test`
Expected: 109 tests pass.

- [ ] **Step 7: Commit**

```bash
git add index.html renderer.js test/renderer.test.js
git commit -m "feat(renderer): clone one Claude Code card per discovered account

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Generate the settings rows from the registry

**Files:**
- Modify: `settings.html` (the per-account price/date/multiplier rows, the override rows)
- Modify: `settings-renderer.js:3-4` (the `ACCOUNTS` literal), `:19-36`, `:38-97`, `:114-124`

**Interfaces:**
- Consumes: `getClaudeAccounts()`, `rescanClaudeAccounts()` from Task 7.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the hardcoded account list**

In `settings-renderer.js`, replace the literal with a registry-built list. Settings rows are keyed by `logKey`, so previously saved values (`claude-vscode` at £200 and 20×) carry over untouched:

```js
let ACCOUNTS = ['codex', 'claude-desktop'];          // fixed accounts
let ACCOUNT_LABELS = { codex: 'Codex', 'claude-desktop': 'Claude Desktop' };
const MULT_DEFAULTS = { 'codex': 5, 'claude-desktop': 1 };
const CLAUDE_CODE_MULT_DEFAULT = 20;

async function loadAccounts() {
  const accts = await window.electronAPI.getClaudeAccounts();
  ACCOUNTS = ['codex', 'claude-desktop', ...accts.map(a => a.logKey)];
  for (const a of accts) {
    ACCOUNT_LABELS[a.logKey] = a.label || 'Claude Code';
    MULT_DEFAULTS[a.logKey] = CLAUDE_CODE_MULT_DEFAULT;
  }
  return accts;
}
```

- [ ] **Step 2: Generate the rows**

Replace the hand-written rows in `settings.html` with a container `<div id="account-rows"></div>`, and build them in `settings-renderer.js` before `loadSettings()` runs:

```js
function buildAccountRows() {
  const host = document.getElementById('account-rows');
  host.replaceChildren();
  for (const a of ACCOUNTS) {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.innerHTML = `
      <div class="account-name">${ACCOUNT_LABELS[a] || a}</div>
      <label>Plan price <input type="number" id="price-${a}" min="0" step="1"></label>
      <label>Tier changed <input type="date" id="tier-date-${a}">
        <button type="button" id="tier-today-${a}">Today</button></label>
      <label>Multiplier <input type="number" id="mult-${a}" min="0" step="1"></label>
      <label>Label override <input type="text" id="ov-${a}"></label>`;
    host.appendChild(row);
  }
}
```

Every existing `ACCOUNTS.forEach(...)` listener block then works unchanged, because the ids follow the same `price-<key>` / `tier-date-<key>` / `mult-<key>` pattern. The override save moves from three fixed ids to the same loop:

```js
function saveOverrides() {
  const accountOverrides = {};
  ACCOUNTS.forEach(a => { accountOverrides[a] = document.getElementById('ov-' + a).value.trim(); });
  window.electronAPI.saveSettings({ accountOverrides });
}
```

- [ ] **Step 3: Add the rescan control**

Add to `settings.html`, near the login buttons:

```html
<button type="button" id="btn-rescan-accounts">Rescan for Claude accounts</button>
<label>Extra config directory <input type="text" id="claude-extra-dir" placeholder="D:\path\to\config-dir"></label>
```

And in `settings-renderer.js`:

```js
document.getElementById('btn-rescan-accounts').addEventListener('click', async () => {
  const accts = await window.electronAPI.rescanClaudeAccounts();
  await loadAccounts(); buildAccountRows(); await loadSettings();
  status(`Found ${accts.length} Claude Code account${accts.length === 1 ? '' : 's'}.`);
});
document.getElementById('claude-extra-dir').addEventListener('change', e => {
  const v = e.target.value.trim();
  window.electronAPI.saveSettings({ claudeExtraConfigDirs: v ? [v] : [] });
});
```

Change the bottom-of-file bootstrap from `loadSettings();` to:

```js
(async () => { await loadAccounts(); buildAccountRows(); await loadSettings(); })();
```

- [ ] **Step 4: Verify syntax and suite**

Run: `node --check settings-renderer.js && npm test`
Expected: 109 tests pass.

- [ ] **Step 5: Commit**

```bash
git add settings.html settings-renderer.js
git commit -m "feat(settings): generate per-account rows from the registry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Registry-driven analytics tabs

**Files:**
- Modify: `analytics.html:299-303` (the three hardcoded tab buttons)
- Modify: `analytics-renderer.js:4-23` (`VALID_ACCOUNTS`, `ACCOUNT_LABELS`, `PLAN_MULTIPLIERS`)

**Interfaces:**
- Consumes: `getClaudeAccounts()` from Task 7.
- Produces: nothing.

- [ ] **Step 1: Build the tabs from the registry**

In `analytics.html`, replace the three `<button class="tab">` elements with an empty `<div class="tabs" id="account-tabs"></div>`.

In `analytics-renderer.js`, replace the three literals with mutable state plus a builder:

```js
let VALID_ACCOUNTS  = ['codex', 'claude-desktop'];
let ACCOUNT_LABELS  = { codex: 'Codex', 'claude-desktop': 'Claude Desktop' };
const PLAN_MULTIPLIERS = { 'codex': 1, 'claude-desktop': 1 };
// Claude Code runs Opus-class models, which burn the 5h quota ~20x faster than
// Codex or Claude Desktop at equivalent wallclock usage.
const CLAUDE_CODE_MULTIPLIER = 20;

async function buildAccountTabs() {
  const accts = await window.electronAPI.getClaudeAccounts();
  for (const a of accts) {
    VALID_ACCOUNTS.push(a.logKey);
    ACCOUNT_LABELS[a.logKey] = a.label || 'Claude Code';
    PLAN_MULTIPLIERS[a.logKey] = CLAUDE_CODE_MULTIPLIER;
  }
  const host = document.getElementById('account-tabs');
  host.replaceChildren();
  for (const key of VALID_ACCOUNTS) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (key === currentAccount ? ' active' : '');
    btn.dataset.account = key;
    btn.textContent = ACCOUNT_LABELS[key];
    host.appendChild(btn);
  }
}
```

`currentAccount`'s initialiser runs before the registry is known, so validate it after building instead:

```js
let currentAccount = initialAccount || 'codex';
// after buildAccountTabs(): if (!VALID_ACCOUNTS.includes(currentAccount)) currentAccount = 'codex';
```

Await `buildAccountTabs()` wherever the window currently does its first render, before the initial `renderAll()`.

- [ ] **Step 2: Verify syntax and suite**

Run: `node --check analytics-renderer.js && npm test`
Expected: 109 tests pass.

- [ ] **Step 3: Widen the real-log test to tolerate new account keys**

In `test/metrics.test.js:379`, the loop over `['codex', 'claude-desktop', 'claude-vscode']` should read every account key present in the log instead, so a `claude-code:*` key is covered rather than ignored:

```js
  const allAccounts = [...new Set(all.map(e => e.account))];
  for (const acct of allAccounts) {
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: 109 tests pass.

- [ ] **Step 5: Commit**

```bash
git add analytics.html analytics-renderer.js test/metrics.test.js
git commit -m "feat(analytics): build account tabs from the registry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification (user's step)

The Electron GUI cannot be launched in an agent environment, so the final check belongs to the user:

1. Restart the app with one config directory. Exactly one Claude Code card, labelled with the account email, showing the same numbers as before. Settings still show £200 / 20× against it. The analytics window still has three tabs.
2. Create a second account: `CLAUDE_CONFIG_DIR=~/.claude-work claude` in a terminal, log in as the other account, then Settings → Rescan. A second card appears; both poll independently.
3. Point a third directory at an account already shown. After its email resolves, it collapses into the existing card rather than adding a duplicate.
