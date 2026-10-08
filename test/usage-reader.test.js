'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseClaudeCodeLines, parseCodexLines, readJsonlEntries } = require('../usage-reader.js');

test('parseClaudeCodeLines extracts assistant usage, skips noise', () => {
  const content = [
    JSON.stringify({ type: 'user', message: {} }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-25T10:00:00Z',
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 } } }),
    'not json',
  ].join('\n');
  const out = parseClaudeCodeLines(content);
  assert.equal(out.length, 1);
  assert.equal(out[0].model, 'claude-opus-4-8');
  assert.equal(out[0].input_tokens, 10);
  assert.equal(out[0].output_tokens, 20);
  assert.equal(out[0].cache_creation, 5);
  assert.equal(out[0].cache_read, 100);
});

test('parseCodexLines tracks model and normalizes token_count', () => {
  const content = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-25T10:00:00Z',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } } }),
  ].join('\n');
  const out = parseCodexLines(content);
  assert.equal(out.length, 1);
  assert.equal(out[0].model, 'gpt-5.5');
  assert.equal(out[0].input_tokens, 20); // 100 - 80
  assert.equal(out[0].cache_read, 80);
  assert.equal(out[0].cache_creation, 0);
});

test('readJsonlEntries caches by mtime and re-parses only on change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-'));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'line1\nline2\n');
  let calls = 0;
  const parser = () => { calls++; return [{ n: calls }]; };
  const cache = new Map();

  const r1 = await readJsonlEntries(dir, cache, parser);
  assert.equal(calls, 1);
  assert.deepEqual(r1, [{ n: 1 }]);

  const r2 = await readJsonlEntries(dir, cache, parser); // mtime unchanged → hit
  assert.equal(calls, 1);
  assert.deepEqual(r2, [{ n: 1 }]);

  const future = new Date(Date.now() + 60000);
  fs.utimesSync(file, future, future); // bump mtime → re-parse
  await readJsonlEntries(dir, cache, parser);
  assert.equal(calls, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonlEntries returns [] for a missing directory', async () => {
  const out = await readJsonlEntries(path.join(os.tmpdir(), 'does-not-exist-xyz'), new Map(), () => [{ x: 1 }]);
  assert.deepEqual(out, []);
});

// ── Bounded, incremental reads ────────────────────────────────────────────
// Transcripts reach hundreds of MB and keep growing. Reading each one whole
// into a single string took the main process to its 4 GB heap limit, so two
// overlapping reads crashed the app (and a file over 512 MiB could not be read
// at all). These pin that the parser only ever sees a bounded piece made of
// whole lines, and that a file which grew is read on from where the last read
// stopped.

let mtimeTick = 0;
// Appends can land within the filesystem's mtime resolution, so move the mtime
// on explicitly to make "the file changed" unambiguous.
function touchLater(file) {
  const t = new Date(Date.now() + 60000 + (++mtimeTick) * 1000);
  fs.utimesSync(file, t, t);
}
const line = (n, pad = 0) => JSON.stringify({ n, pad: 'x'.repeat(pad) }) + '\n';
// Records every piece of text it is handed, and returns the `n` of each whole
// JSON line in it.
function recordingParser(texts) {
  return (text) => {
    texts.push(text);
    return text.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l).n; } catch { return null; } })
      .filter((n) => n != null);
  };
}

test('readJsonlEntries hands the parser bounded pieces of whole lines, not the whole file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-'));
  let body = '';
  for (let n = 1; n <= 50; n++) body += line(n, n === 25 ? 200 : 10);
  fs.writeFileSync(path.join(dir, 'big.jsonl'), body);
  const longest = Math.max(...body.split('\n').map((l) => l.length + 1));
  const texts = [];

  const out = await readJsonlEntries(dir, new Map(), recordingParser(texts), { chunkBytes: 64 });

  assert.deepEqual(out, Array.from({ length: 50 }, (_, i) => i + 1));
  assert.ok(texts.length > 1, `expected several pieces, got ${texts.length}`);
  for (const t of texts) {
    assert.ok(t.endsWith('\n'), 'every piece ends on a line boundary');
    assert.ok(t.length <= 64 + longest, `a ${t.length}-char piece exceeds chunk + longest line (${64 + longest})`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonlEntries reads only what was appended to a file that grew', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-'));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, line(1) + line(2));
  const texts = [];
  const parser = recordingParser(texts);
  const cache = new Map();

  assert.deepEqual(await readJsonlEntries(dir, cache, parser), [1, 2]);
  fs.appendFileSync(file, line(3));
  touchLater(file);
  texts.length = 0;
  assert.deepEqual(await readJsonlEntries(dir, cache, parser), [1, 2, 3]);
  assert.deepEqual(texts, [line(3)], 'only the appended line is read again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonlEntries leaves a line still being written for the next read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-'));
  const file = path.join(dir, 'a.jsonl');
  const third = line(3);
  fs.writeFileSync(file, line(1) + line(2) + third.slice(0, 5));
  const parser = recordingParser([]);
  const cache = new Map();

  assert.deepEqual(await readJsonlEntries(dir, cache, parser, { chunkBytes: 7 }), [1, 2]);
  fs.appendFileSync(file, third.slice(5) + line(4));
  touchLater(file);
  assert.deepEqual(await readJsonlEntries(dir, cache, parser, { chunkBytes: 7 }), [1, 2, 3, 4]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonlEntries reads a file that shrank again from the start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-'));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, line(1) + line(2) + line(3));
  const parser = recordingParser([]);
  const cache = new Map();

  assert.deepEqual(await readJsonlEntries(dir, cache, parser), [1, 2, 3]);
  fs.writeFileSync(file, line(9));
  touchLater(file);
  assert.deepEqual(await readJsonlEntries(dir, cache, parser), [9]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Codex's model carries across pieces and across an append", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-'));
  const file = path.join(dir, 'rollout.jsonl');
  const ctx = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n';
  const tok = (s) => JSON.stringify({ type: 'event_msg', timestamp: `2026-06-25T10:00:0${s}Z`,
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } } }) + '\n';
  fs.writeFileSync(file, ctx + tok(1) + tok(2));
  const cache = new Map();

  const first = await readJsonlEntries(dir, cache, parseCodexLines, { chunkBytes: 32 });
  fs.appendFileSync(file, tok(3));
  touchLater(file);
  const second = await readJsonlEntries(dir, cache, parseCodexLines, { chunkBytes: 32 });

  assert.deepEqual(first.map((e) => e.model), ['gpt-5.5', 'gpt-5.5']);
  assert.deepEqual(second.map((e) => e.model), ['gpt-5.5', 'gpt-5.5', 'gpt-5.5']);
  fs.rmSync(dir, { recursive: true, force: true });
});
