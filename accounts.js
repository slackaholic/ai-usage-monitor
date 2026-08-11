'use strict';
const path = require('path');
const fs = require('fs');

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

// Resolves homeDir to the same canonical form scanClaudeCodeConfigDirs uses
// for every entry it returns (fsp.realpath). Callers that later compare a
// scanned dir against homeDir via isDefaultDir (e.g. groupIntoAccounts) must
// resolve homeDir through this first — otherwise a raw homeDir that diverges
// from its own realpath (Windows 8.3 short names, symlinks, junctions) never
// matches the realpath'd entries in the scan, and the default account stops
// being recognised as default. Falls back to path.resolve when realpath
// throws — a homeDir that does not exist must not throw here.
async function resolveHomeDir(homeDir) {
  try {
    return await fsp.realpath(homeDir);
  } catch {
    return path.resolve(homeDir);
  }
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

  const def = path.resolve(path.join(home, '.claude')).toLowerCase();
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

module.exports = {
  deriveLogKey, deriveAccountId, isDefaultDir,
  scanClaudeCodeConfigDirs, resolveHomeDir, groupIntoAccounts,
  readCredentials, writeCredentialsAtomic,
};
