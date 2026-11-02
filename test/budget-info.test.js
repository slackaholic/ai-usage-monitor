'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// main.js can't be require()d outside Electron, so lift the get-budget-info
// handler out of it and run it against stubs, as the other main.js tests do.
function loadHandler(grouped) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('get-budget-info'");
  const end = source.indexOf("ipcMain.on('open-analytics'");
  assert.ok(start >= 0 && end > start, 'expected get-budget-info source markers');

  const handlers = {};
  const calls = [];
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    readUsageLogGrouped: () => grouped,
    Date,
    dayBudgetInfo: (rows, midnightMs) => { calls.push([rows, midnightMs]); return { rows: rows.length }; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { handler: handlers['get-budget-info'], calls };
}

const localMidnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

test('get-budget-info answers the day-budget figures for every logged account', () => {
  const { handler, calls } = loadHandler({ codex: [{}, {}], 'claude-desktop': [{}] });
  // Spread: the answer object is built inside the vm, with its own prototype.
  assert.deepStrictEqual({ ...handler() }, { codex: { rows: 2 }, 'claude-desktop': { rows: 1 } });
  assert.equal(calls.length, 2);
  for (const [, midnightMs] of calls) assert.equal(midnightMs, localMidnight());
});

test('get-budget-info with no log answers no accounts', () => {
  const { handler } = loadHandler(null);
  assert.deepStrictEqual({ ...handler() }, {});
});
