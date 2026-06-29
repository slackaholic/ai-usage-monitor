'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeCodexTokenUsage } = require('./metrics.js');

// One file's text → Claude Code entries.
function parseClaudeCodeLines(content) {
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'assistant' && obj.message && obj.message.usage && obj.timestamp) {
      out.push({
        timestamp: obj.timestamp,
        model: obj.message.model || 'unknown',
        input_tokens: obj.message.usage.input_tokens || 0,
        output_tokens: obj.message.usage.output_tokens || 0,
        cache_creation: obj.message.usage.cache_creation_input_tokens || 0,
        cache_read: obj.message.usage.cache_read_input_tokens || 0,
      });
    }
  }
  return out;
}

// One file's text → Codex entries. Model is tracked within the file from
// turn_context events that precede token_count events.
function parseCodexLines(content) {
  const out = [];
  let currentModel = 'unknown';
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'turn_context' && obj.payload && obj.payload.model) {
      currentModel = obj.payload.model;
    } else if (
      obj.type === 'event_msg' &&
      obj.payload && obj.payload.type === 'token_count' &&
      obj.payload.info && obj.payload.info.last_token_usage &&
      obj.timestamp
    ) {
      const e = normalizeCodexTokenUsage(obj.payload.info.last_token_usage, currentModel, obj.timestamp);
      if (e) out.push(e);
    }
  }
  return out;
}

// Recursively list *.jsonl under rootDir (sync dir listing — light; the heavy
// part is reading/parsing file contents, which is async + yielded below).
function scanJsonl(rootDir) {
  const files = [];
  (function scan(dir) {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) scan(full);
      else if (d.name.endsWith('.jsonl')) files.push(full);
    }
  })(rootDir);
  return files;
}

// Async, mtime-cached reader. Reads each file with fs.promises, reusing cached
// parsed entries when the file's mtime is unchanged, and yields to the event
// loop every 25 files so the main process never blocks for a whole scan.
async function readJsonlEntries(rootDir, cache, parseLines) {
  const files = scanJsonl(rootDir);
  const all = [];
  let i = 0;
  for (const file of files) {
    try {
      const st = await fs.promises.stat(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        all.push(...hit.entries);
      } else {
        const content = await fs.promises.readFile(file, 'utf8');
        const parsed = parseLines(content);
        cache.set(file, { mtimeMs: st.mtimeMs, entries: parsed });
        all.push(...parsed);
      }
    } catch { /* skip unreadable file */ }
    if (++i % 25 === 0) await new Promise(r => setImmediate(r));
  }
  return all;
}

const _claudeCodeCache = new Map();
const _codexCache = new Map();

function readClaudeCodeUsage() {
  return readJsonlEntries(path.join(os.homedir(), '.claude', 'projects'), _claudeCodeCache, parseClaudeCodeLines);
}

function readCodexUsage() {
  return readJsonlEntries(path.join(os.homedir(), '.codex', 'sessions'), _codexCache, parseCodexLines);
}

module.exports = {
  parseClaudeCodeLines,
  parseCodexLines,
  scanJsonl,
  readJsonlEntries,
  readClaudeCodeUsage,
  readCodexUsage,
};
