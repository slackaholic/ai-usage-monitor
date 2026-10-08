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
// turn_context events that precede token_count events. A file is parsed in
// pieces, so the model in force is carried between them on `state`.
function parseCodexLines(content, state = {}) {
  const out = [];
  let currentModel = state.model || 'unknown';
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
  state.model = currentModel;
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

// Bytes read per step. A transcript is never held whole: the parser gets at
// most this much plus one line at a time, however large the file grows.
const CHUNK_BYTES = 8 * 1024 * 1024;

// Reads bytes [start, end) of `file` in pieces of at most `chunkBytes` and
// hands onText whole lines only. Returns the offset just past the last newline
// handed on, so a line still being written is left for the next read rather
// than parsed half-finished. Splitting at the newline byte is safe in UTF-8,
// which never uses that byte inside a multi-byte character.
async function readWholeLines(file, start, end, chunkBytes, onText) {
  const fh = await fs.promises.open(file, 'r');
  try {
    let pos = start;
    let done = start;
    let carry = Buffer.alloc(0);
    while (pos < end) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkBytes, end - pos));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const nl = data.lastIndexOf(0x0a);
      if (nl === -1) { carry = data; continue; }
      onText(data.toString('utf8', 0, nl + 1));
      carry = data.subarray(nl + 1);
      done = pos - carry.length;
    }
    return done;
  } finally {
    await fh.close();
  }
}

// Async, mtime-cached reader. Transcripts only ever grow by appending, so a
// file that grew since the last read is read on from where that read stopped;
// one that is new, shrank, or changed at the same size is read from the start.
// Reading in bounded pieces keeps memory flat: reading whole files took the
// main process to its heap limit once transcripts reached hundreds of MB.
// Yields to the event loop every 25 files so the main process never blocks
// for a whole scan.
async function readJsonlEntries(rootDir, cache, parseLines, { chunkBytes = CHUNK_BYTES } = {}) {
  const files = scanJsonl(rootDir);
  const all = [];
  let i = 0;
  for (const file of files) {
    try {
      const st = await fs.promises.stat(file);
      let hit = cache.get(file);
      if (!hit || hit.mtimeMs !== st.mtimeMs) {
        const from = hit && st.size > hit.size ? hit : { offset: 0, entries: [], state: {} };
        // Parse into copies, so a read that fails part-way leaves the cache as
        // it was rather than half-advanced.
        const added = [];
        const state = { ...from.state };
        const offset = await readWholeLines(file, from.offset, st.size, chunkBytes, (text) => {
          for (const e of parseLines(text, state)) added.push(e);
        });
        hit = { mtimeMs: st.mtimeMs, size: st.size, offset, state, entries: from.entries.concat(added) };
        cache.set(file, hit);
      }
      // One at a time: spreading a very large array into push() throws.
      for (const e of hit.entries) all.push(e);
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
