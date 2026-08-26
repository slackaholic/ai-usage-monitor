'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { needsMigration, migrate, transform, CUTOFF_ISO } =
  require('../scripts/migrate-codex-weekly.js');

const AFTER = '2026-08-26T09:22:39.000Z';
const BEFORE = '2026-07-03T09:22:39.000Z';

const line = (o) => JSON.stringify(o);
const parseAll = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the cutoff is the day after the last two-window poll', () => {
  assert.strictEqual(CUTOFF_ISO, '2026-07-11T00:00:00Z');
});

test('a weekly reading filed under 5h moves to the weekly keys', () => {
  const entry = {
    ts: AFTER, account: 'codex', '5h': 100, wk: null,
    reset5hTs: 1788333628000, sessionStart: '2026-08-13T07:03:52.207Z',
  };
  assert.strictEqual(needsMigration(entry), true);

  const out = migrate(entry);
  assert.strictEqual(out.wk, 100, 'the value belongs under wk');
  assert.strictEqual(out['5h'], null, 'there was never a 5h reading');
  assert.strictEqual(out.reset7dTs, 1788333628000, 'and the reset was the weekly one');
  assert.ok(!('reset5hTs' in out));
  assert.ok(!('sessionStart' in out), 'no 5h window means no session to mark');
  assert.strictEqual(out.ts, AFTER);
  assert.strictEqual(out.account, 'codex');
});

test('a depleted flag is recomputed for the key it actually applies to', () => {
  const out = migrate({ ts: AFTER, account: 'codex', '5h': 0, wk: null, depleted: ['5h'] });
  assert.deepStrictEqual(out.depleted, ['wk']);
});

test('a full quota carries no depleted flag at all', () => {
  const out = migrate({ ts: AFTER, account: 'codex', '5h': 100, wk: null, depleted: ['5h'] });
  assert.ok(!('depleted' in out));
});

test('genuine two-window history before the cutoff is left alone', () => {
  assert.strictEqual(
    needsMigration({ ts: BEFORE, account: 'codex', '5h': 80, wk: 60 }), false);
  assert.strictEqual(
    needsMigration({ ts: BEFORE, account: 'codex', '5h': 80, wk: null }), false,
    'a pre-cutoff 5h reading was a real 5h reading');
});

test('other accounts are never touched', () => {
  assert.strictEqual(
    needsMigration({ ts: AFTER, account: 'claude-vscode', '5h': 79, wk: null }), false);
  assert.strictEqual(
    needsMigration({ ts: AFTER, account: 'claude-desktop', '5h': 78, wk: null }), false);
});

test('an entry that already has both meters is not guessed at', () => {
  assert.strictEqual(
    needsMigration({ ts: AFTER, account: 'codex', '5h': 100, wk: 100 }), false);
});

test('an entry already filed correctly is skipped', () => {
  assert.strictEqual(
    needsMigration({ ts: AFTER, account: 'codex', '5h': null, wk: 97 }), false);
});

test('transform reports what it changed and rewrites only those lines', () => {
  const text = [
    line({ ts: BEFORE, account: 'codex', '5h': 80, wk: 60 }),
    line({ ts: AFTER, account: 'codex', '5h': 100, wk: null, reset5hTs: 1788333628000 }),
    line({ ts: AFTER, account: 'claude-vscode', '5h': 79, wk: 88 }),
    line({ ts: AFTER, account: 'codex', '5h': null, wk: 97 }),
  ].join('\n');

  const r = transform(text);
  assert.strictEqual(r.migrated, 1);
  assert.strictEqual(r.codexAfterCutoff, 2, 'the two post-cutoff Codex lines, migrated or not');

  const out = parseAll(r.text);
  assert.deepStrictEqual(out[0], { ts: BEFORE, account: 'codex', '5h': 80, wk: 60 });
  assert.strictEqual(out[1].wk, 100);
  assert.strictEqual(out[1].reset7dTs, 1788333628000);
  assert.strictEqual(out[2]['5h'], 79, 'the Claude Code entry is byte-identical');
  assert.strictEqual(out[3].wk, 97);
});

test('running it twice changes nothing the second time', () => {
  const text = [
    line({ ts: AFTER, account: 'codex', '5h': 100, wk: null, reset5hTs: 1788333628000 }),
    line({ ts: AFTER, account: 'codex', '5h': 0, wk: null, depleted: ['5h'] }),
  ].join('\n');

  const once = transform(text);
  const twice = transform(once.text);
  assert.strictEqual(once.migrated, 2);
  assert.strictEqual(twice.migrated, 0, 'the migration is idempotent');
  assert.strictEqual(twice.text, once.text);
});

test('blank and unparsable lines survive verbatim', () => {
  const text = [
    '',
    'not json at all',
    line({ ts: AFTER, account: 'codex', '5h': 100, wk: null }),
    '',
  ].join('\n');

  const r = transform(text);
  assert.strictEqual(r.unparsed, 1);
  assert.strictEqual(r.migrated, 1);
  const lines = r.text.split('\n');
  assert.strictEqual(lines[0], '');
  assert.strictEqual(lines[1], 'not json at all');
  assert.strictEqual(lines[3], '');
});

test('a trailing newline is preserved, so the next append still lands on its own line', () => {
  const text = line({ ts: AFTER, account: 'codex', '5h': 100, wk: null }) + '\n';
  const r = transform(text);
  assert.ok(r.text.endsWith('\n'));
});
