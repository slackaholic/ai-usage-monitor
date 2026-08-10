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

module.exports = { deriveLogKey, deriveAccountId, isDefaultDir, scanClaudeCodeConfigDirs };
