'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Two paths name the same directory if they resolve to the same string.
// Windows paths are case-insensitive, so compare case-folded. Pure: it does NOT
// collapse symlinks or junctions, so a caller comparing against a scanned
// directory has to hand it a realpath'd other side (resolveDefaultConfigDir).
function samePath(a, b) {
  return path.resolve(a || '').toLowerCase() === path.resolve(b || '').toLowerCase();
}

// The default config directory implied by a home directory, WITHOUT resolving
// symlinks. Only for callers that have no realpath'd form to offer.
function defaultDirOf(homeDir) {
  return path.join(homeDir || '', '.claude');
}

// Two directories are the same account directory if they resolve to the same
// path.
function isDefaultDir(configDir, homeDir) {
  return samePath(configDir, defaultDirOf(homeDir));
}

// The usage-log account key. Derived from the DIRECTORY, never the email:
// emails change on re-login, and re-keying history on a login change orphans
// it. The default dir keeps 'claude-vscode' so existing history stays attached.
function logKeyFor(configDir, defaultDir) {
  if (samePath(configDir, defaultDir)) return 'claude-vscode';
  return 'claude-code:' + path.basename(configDir);
}

function deriveLogKey(configDir, homeDir) {
  return logKeyFor(configDir, defaultDirOf(homeDir));
}

// The renderer prefix / DOM id namespace. The default dir keeps 'claude2' so
// the existing markup, settings keys and localStorage entries keep working.
function accountIdFor(configDir, defaultDir) {
  if (samePath(configDir, defaultDir)) return 'claude2';
  const slug = path.basename(configDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return 'cc-' + (slug || 'account');
}

function deriveAccountId(configDir, homeDir) {
  return accountIdFor(configDir, defaultDirOf(homeDir));
}

// The name a window shows for an account. `label` is the OAuth profile email:
// null until it resolves, and permanently null if it never does. Falling back
// to the literal 'Claude Code' there makes two accounts indistinguishable — two
// identically-named Settings rows, two identically-named Analytics tabs — which
// is how a plan price or a multiplier gets entered against the wrong account.
// The config directory's own name is unique per account and stable, so it is
// the fallback. Derived here once and carried ON THE DESCRIPTOR because the
// three renderer windows run under contextIsolation and cannot require this
// module; that is also what keeps them from drifting into three fallbacks.
function deriveDisplayName({ label, detail, configDir, id } = {}) {
  if (label) return label;
  const base = detail || path.basename(configDir || '') || id || '';
  return base ? 'Claude Code (' + base + ')' : 'Claude Code';
}

// What distinguishes THIS account from another of the same kind, with no
// product name attached: the OAuth profile email once it resolves, the config
// directory's own name until then. Kept separate from displayName because the
// two windows compose them differently — Settings shows the product name and
// this on its own line beneath, Analytics shows the product name alone and
// only appends this when two tabs would otherwise read identically.
function deriveDetail({ label, configDir, id } = {}) {
  return label || path.basename(configDir || '') || id || null;
}

// A short, stable fingerprint of a full path, used to break identity collisions
// between two directories that share a basename (see disambiguateAccounts).
function pathFingerprint(fullPath) {
  return crypto.createHash('sha1')
    .update(path.resolve(fullPath || '').toLowerCase())
    .digest('hex')
    .slice(0, 6);
}

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

// realpath, falling back to path.resolve when realpath throws — a path that
// does not exist must not throw here.
async function realpathOrResolve(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

// Resolves homeDir to the same canonical form scanClaudeCodeConfigDirs uses
// for every entry it returns (fsp.realpath). Callers that later compare a
// scanned dir against homeDir (e.g. groupIntoAccounts) must resolve homeDir
// through this first — otherwise a raw homeDir that diverges from its own
// realpath (Windows 8.3 short names, symlinks, junctions) never matches the
// realpath'd entries in the scan, and the default account stops being
// recognised as default.
async function resolveHomeDir(homeDir) {
  return realpathOrResolve(homeDir);
}

// The default config directory in the SAME canonical form the scan returns:
// both the home directory AND `.claude` itself put through realpath.
//
// Resolving only the home side is not enough. `~/.claude` is itself commonly a
// symlink or a junction — the usual way to move Claude's config off the system
// drive — and then the scan returns its TARGET while a plain
// `join(home, '.claude')` is the LINK. Those never compare equal, so the
// default entry loses rank 0 in the sort (a same-account collapse can then keep
// the wrong directory's key) and derives `claude-code:<target-basename>`
// instead of `claude-vscode`, detaching 7,099 existing usage-log entries.
//
// This touches the filesystem, so it lives on the scan/caller side;
// groupIntoAccounts stays pure and takes the answer as `defaultDir`.
async function resolveDefaultConfigDir(homeDir) {
  return realpathOrResolve(path.join(await realpathOrResolve(homeDir), '.claude'));
}

// Every Claude config directory on this machine, resolved and deduped.
// Order is stable — default dir first, then alphabetical — so cards never
// reshuffle between runs.
async function scanClaudeCodeConfigDirs({ homeDir, env = {}, extraPaths = [] }) {
  // Resolve once, up front, and use the resolved form for every downstream
  // homeDir-derived value (the default candidate, the readdir walk, the sort
  // rank) so this function is internally self-consistent no matter what form
  // of home it's handed — see resolveHomeDir above.
  const home = await resolveHomeDir(homeDir);

  const candidates = [];
  if (env.CLAUDE_CONFIG_DIR) candidates.push(env.CLAUDE_CONFIG_DIR);
  candidates.push(path.join(home, '.claude'));
  try {
    for (const e of await fsp.readdir(home, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('.claude')) candidates.push(path.join(home, e.name));
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

  // Realpath'd, exactly like every entry in `found` — see
  // resolveDefaultConfigDir for why resolving only `home` is not enough.
  const def = (await resolveDefaultConfigDir(home)).toLowerCase();
  found.sort((a, b) => {
    const rank = (p) => (p.toLowerCase() === def ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return found;
}

// Directory identity is not account identity: two config dirs can hold logins
// for the SAME account, and because the quota is per-account and shared across
// every surface, they would render two cards with identical numbers. Once an
// email is known for both, they collapse into one descriptor — one card, one
// probe, one log key.
//
// Pure: `dirs` is already scanned and sorted, `knownEmails` is the persisted
// configDir -> email map. No filesystem, no network.
//
// `defaultDir` is the realpath'd ~/.claude (resolveDefaultConfigDir, on the
// caller side). Passing it explicitly rather than re-deriving it from `homeDir`
// is what lets a symlinked/junctioned ~/.claude still be recognised as the
// default — see resolveDefaultConfigDir. `homeDir` remains accepted as the
// fallback for callers with nothing better to offer.
function groupIntoAccounts(dirs, { homeDir, defaultDir, knownEmails = {} } = {}) {
  const def = defaultDir || defaultDirOf(homeDir);
  const byEmail = new Map();
  const accounts = [];

  for (const dir of dirs) {
    const email = knownEmails[dir] || null;
    if (email && byEmail.has(email)) {
      byEmail.get(email).configDirs.push(dir);
      continue;
    }
    const descriptor = {
      id: accountIdFor(dir, def),
      kind: 'claude-code',
      configDir: dir,
      configDirs: [dir],
      logKey: logKeyFor(dir, def),
      label: email,
    };
    descriptor.detail = deriveDetail(descriptor);
    if (email) byEmail.set(email, descriptor);
    accounts.push(descriptor);
  }
  // displayName is derived AFTER disambiguation, from the possibly-suffixed
  // detail — deriving it here would bake in a colliding name that the suffix
  // then never reaches.
  return disambiguateAccounts(accounts, def)
    .map(a => Object.assign(a, { displayName: deriveDisplayName(a) }));
}

// `id` and `logKey` both come from path.basename, so two config dirs sharing a
// basename under different parents — CLAUDE_CONFIG_DIR=D:\configs\.claude-work
// alongside ~/.claude-work — derive the SAME id and the SAME log key. Dedupe is
// by realpath, so both survive the scan as separate accounts. The duplicate id
// collides in the DOM; the duplicate log key is far worse, interleaving two
// accounts' entries under one key in usage-log.jsonl and silently corrupting the
// budget ratio, session tracking (`sessionStore`) and every analytics figure for both.
//
// BOTH members of a colliding group get the suffix, not just the later one: the
// resulting key is then a pure function of that directory's own full path, so it
// can never move again when a third directory turns up. Letting the first keep
// the bare key would instead make every key depend on which other paths happen
// to be present that run.
//
// Runs AFTER grouping, so directories that collapsed into one account (same
// email) count once and keep their bare key — a collapse is not a collision.
//
// The default directory is exempt: 'claude2' / 'claude-vscode' are load-bearing
// and must never move. It cannot collide anyway — every other directory derives
// a 'cc-' / 'claude-code:' key, which can never equal them.
function disambiguateAccounts(accts, defaultDir) {
  const tally = (field) => {
    const counts = new Map();
    for (const a of accts) counts.set(a[field], (counts.get(a[field]) || 0) + 1);
    return counts;
  };
  const ids = tally('id');
  const keys = tally('logKey');
  // `detail` collides for the same reason id and logKey do — it falls back to
  // the config-dir basename when no email has resolved. Left alone, the two
  // colliding accounts keep distinct data but render identical names, which is
  // exactly the wrong-row-gets-the-price hazard this function exists to stop.
  const details = tally('detail');

  for (const a of accts) {
    if (samePath(a.configDir, defaultDir)) continue;
    const fp = pathFingerprint(a.configDir);
    if (ids.get(a.id) > 1) a.id += '-' + fp;
    if (keys.get(a.logKey) > 1) a.logKey += '-' + fp;
    // Only the basename fallback can collide; two accounts sharing an email
    // would have collapsed into one before reaching here.
    if (a.detail && details.get(a.detail) > 1) a.detail += ' (' + fp + ')';
  }
  return accts;
}

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
    // Preserve the target's permission bits. On POSIX, Claude Code's CLI creates
    // .credentials.json with restrictive permissions; renameSync uses the temp file's
    // default mode (644), which would loosen them to world-readable on every refresh.
    // Tolerate absence: if target doesn't exist yet, we proceed with the default.
    try { fs.chmodSync(tmp, fs.statSync(target).mode); } catch {}
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

module.exports = {
  deriveLogKey, deriveAccountId, deriveDisplayName, deriveDetail, isDefaultDir, samePath,
  scanClaudeCodeConfigDirs, resolveHomeDir, resolveDefaultConfigDir,
  groupIntoAccounts, readCredentials, writeCredentialsAtomic,
};
