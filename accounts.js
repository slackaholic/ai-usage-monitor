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
