#!/usr/bin/env node
'use strict';

// One-off repair for usage-log.jsonl.
//
// OpenAI removed the Codex 5-hour rate-limit window on 2026-07-11. The weekly
// window moved into `primary_window`, and renderer.js — which keyed the windows
// by POSITION rather than by declared length — filed six weeks of WEEKLY
// percentages under the `5h` key. Nothing errored; the numbers were simply in
// the wrong column, which starved every weekly metric (`weeklyPerFiveHourRatio`
// and `weeklyBurnSince` both require `wk`).
//
// This moves those readings to the keys they belong in. Entries before the
// cutoff are genuine two-window samples and are never touched.
//
//   node scripts/migrate-codex-weekly.js [--dry-run] [--log <path>]
//
// Idempotent: a second run finds nothing to do.

const fs = require('fs');
const path = require('path');

// The day after the last poll that carried two real windows (2026-07-10).
const CUTOFF_ISO = '2026-07-11T00:00:00Z';
const CUTOFF_MS = Date.parse(CUTOFF_ISO);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const logArg = args.indexOf('--log');
const LOG_PATH = logArg >= 0 && args[logArg + 1]
  ? path.resolve(args[logArg + 1])
  : path.join(__dirname, '..', 'usage-log.jsonl');

// Whether one entry is a Codex poll that recorded a weekly reading under `5h`.
// Deliberately narrow: only the unambiguous case, where the 5h key holds a
// value AND the weekly key is empty. An entry that somehow has both is left
// alone rather than guessed at.
function needsMigration(e) {
  if (!e || e.account !== 'codex') return false;
  const ts = Date.parse(e.ts);
  if (!Number.isFinite(ts) || ts < CUTOFF_MS) return false;
  return e['5h'] != null && e.wk == null;
}

function migrate(e) {
  const out = { ...e };
  out.wk = out['5h'];
  out['5h'] = null;

  // The reset that came with it was the weekly reset all along.
  if (out.reset5hTs != null && out.reset7dTs == null) {
    out.reset7dTs = out.reset5hTs;
    delete out.reset5hTs;
  }

  // A sessionStart is a 5-hour-window marker. These entries never had a 5-hour
  // window, so the value is a leftover from before the change; keeping it would
  // report phantom sessions in the analytics session count.
  delete out.sessionStart;

  const dep = [out['5h'] === 0 && '5h', out.wk === 0 && 'wk'].filter(Boolean);
  if (dep.length) out.depleted = dep; else delete out.depleted;

  return out;
}

// Transform a snapshot of the log. Returns the new text plus counts.
function transform(text) {
  const lines = text.split('\n');
  let migrated = 0, codexAfterCutoff = 0, unparsed = 0;

  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let e;
    try { e = JSON.parse(line); } catch { unparsed++; return line; }
    if (e && e.account === 'codex' && Date.parse(e.ts) >= CUTOFF_MS) codexAfterCutoff++;
    if (!needsMigration(e)) return line;
    migrated++;
    return JSON.stringify(migrate(e));
  });

  return { text: out.join('\n'), migrated, codexAfterCutoff, unparsed };
}

function main() {
  if (!fs.existsSync(LOG_PATH)) {
    console.error('No log at ' + LOG_PATH);
    process.exit(1);
  }

  // The monitor appends to this file every couple of minutes and may well be
  // running right now. Snapshot a byte length, transform exactly that prefix,
  // then carry over anything appended while we worked — an append-only file
  // makes that a safe read-modify-write.
  const fd = fs.openSync(LOG_PATH, 'r');
  let snapshotBytes;
  try {
    snapshotBytes = fs.fstatSync(fd).size;
    var head = Buffer.alloc(snapshotBytes);
    fs.readSync(fd, head, 0, snapshotBytes, 0);
  } finally {
    fs.closeSync(fd);
  }

  const result = transform(head.toString('utf8'));

  console.log('Log:                 ' + LOG_PATH);
  console.log('Cutoff:              ' + CUTOFF_ISO);
  console.log('Codex entries after: ' + result.codexAfterCutoff);
  console.log('Entries to migrate:  ' + result.migrated);
  if (result.unparsed) console.log('Unparsable lines:    ' + result.unparsed + ' (left untouched)');

  if (result.migrated === 0) {
    console.log('\nNothing to do.');
    return;
  }
  if (dryRun) {
    console.log('\n--dry-run: no files written.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = LOG_PATH + '.bak-' + stamp;
  fs.copyFileSync(LOG_PATH, backup);
  console.log('\nBackup:              ' + backup);

  // Anything the app appended since the snapshot, verbatim.
  const tail = fs.readFileSync(LOG_PATH).subarray(snapshotBytes);
  const tmp = LOG_PATH + '.tmp-' + stamp;
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from(result.text, 'utf8'), tail]));
  fs.renameSync(tmp, LOG_PATH);

  console.log('Appended meanwhile:  ' + tail.length + ' bytes (carried over)');
  console.log('Migrated ' + result.migrated + ' entries.');
}

if (require.main === module) main();

module.exports = { needsMigration, migrate, transform, CUTOFF_ISO, CUTOFF_MS };
