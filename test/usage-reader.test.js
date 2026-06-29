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
