'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// One BrowserWindow is shared between the login the user drives and the poll
// that scrapes it. The poll used to hide and re-navigate that window
// unconditionally, so a login in progress was thrown away mid-typing — and
// because the no-data branch re-arms a 45s retry, the user had at most 45
// seconds to finish a ChatGPT login with 2FA. The Claude path already guards
// this (fetchClaudeUsageForKey: "Don't interrupt if user has manually opened
// this window"); these tests hold the same guard on the Codex path.

// ── main: the poll must leave a visible window alone ───────────────────────

function loadCodexFetchHandler() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('fetch-codex-usage'");
  const end = source.indexOf('// ── Codex login window');
  assert.ok(start >= 0 && end > start, 'expected fetch-codex-usage source markers');

  const calls = { hide: 0, show: 0, loadURL: [], scraped: 0, listeners: 0 };
  const win = {
    visible: false,
    isVisible: () => win.visible,
    isDestroyed: () => false,
    hide: () => { calls.hide++; win.visible = false; },
    show: () => { calls.show++; win.visible = true; },
    focus: () => {},
    on: () => { calls.listeners++; },
    webContents: {
      url: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
      getURL: () => win.webContents.url,
      loadURL: async (u) => { calls.loadURL.push(u); },
      on: () => { calls.listeners++; },
      off: () => {},
      once: () => {},
    },
  };

  // What chatgpt.com's session endpoint answers: 'signed-in', 'signed-out'
  // or 'unknown'.
  const session = { answer: 'signed-in' };
  // Each round's record, as the handler kept it: its steps and how it ended.
  const rounds = [];
  const handlers = {};
  const context = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    getOrCreateCodexWindow: () => win,
    CODEX_URL: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
    askCodexSession: async () => session.answer,
    scrapeCodexPage: async (w, round) => { calls.scraped++; calls.scrapeRound = round; return { text: 'usage limit remaining' }; },
    startCodexRound: () => {
      const round = { notes: [], ended: undefined };
      rounds.push(round);
      round.handle = {
        note: (step, extra) => { round.notes.push({ step, ...extra }); },
        end: (result) => { round.ended = result; return result; },
      };
      return round.handle;
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  assert.ok(handlers['fetch-codex-usage'], 'handler was not registered');
  return { fetch: () => handlers['fetch-codex-usage'](), win, calls, session, rounds };
}

// The old poll, having put a window up, waited minutes for a sign-in that
// these fakes never deliver; report that as pending rather than hang.
function settledOrPending(promise) {
  return Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve({ pending: true })))]);
}

test('a poll does not disturb the window the user is logging in to', async () => {
  const { fetch, win, calls } = loadCodexFetchHandler();
  win.visible = true;                   // the user clicked Login; the form is open

  const result = await fetch();

  // strictEqual on the field, not deepStrictEqual on the object: the handler
  // builds its result inside the vm context, so the object carries that
  // realm's Object.prototype and a deep-strict compare fails on identical
  // contents.
  assert.strictEqual(result.error, 'window-in-use',
    'the poll must report the window as busy, not scrape it');
  assert.strictEqual(calls.scraped, 0, 'and must not have scraped it');
  assert.strictEqual(calls.hide, 0, 'hiding it is what made the login vanish');
  assert.deepStrictEqual(calls.loadURL, [],
    're-navigating it is what discarded the half-filled form');
  assert.strictEqual(win.visible, true, 'the login window must still be on screen');
});

test('a poll still scrapes normally when no one is logging in', async () => {
  const { fetch, win, calls } = loadCodexFetchHandler();
  win.visible = false;

  const result = await fetch();

  assert.strictEqual(calls.scraped, 1, 'the ordinary path must be untouched');
  assert.strictEqual(result.text, 'usage limit remaining');
  assert.strictEqual(calls.loadURL.length, 1, 'it still loads the analytics page');
});

// ── main: the poll judges the sign-in by the session, never the address ───

test('a signed-in poll scrapes wherever chatgpt.com has moved the page to', async () => {
  const { fetch, win, calls, session } = loadCodexFetchHandler();
  // Signed in, chatgpt.com moves the usage address on to its own settings
  // page as it loads. Read a moment late, that address put the login window
  // up over a working sign-in, poll after poll: the reported pop-up.
  win.webContents.url = 'https://chatgpt.com/settings/usage';
  session.answer = 'signed-in';

  const result = await settledOrPending(fetch());

  assert.strictEqual(calls.show, 0, 'a signed-in poll has no reason to put a window on screen');
  assert.strictEqual(calls.scraped, 1, 'it should read the usage instead');
  assert.strictEqual(result.text, 'usage limit remaining');
});

test('a signed-out poll says so on the card and opens nothing', async () => {
  const { fetch, win, calls, session } = loadCodexFetchHandler();
  win.webContents.url = 'https://chatgpt.com/auth/login';
  session.answer = 'signed-out';

  const result = await settledOrPending(fetch());

  assert.strictEqual(calls.show, 0,
    'a window that opens by itself every poll is the complaint; Login is how to sign in');
  assert.strictEqual(calls.scraped, 0, 'there is nothing to read while signed out');
  assert.strictEqual(result.error, 'login-needed');
});

test('a poll the session does not answer reports an error, not a sign-out', async () => {
  const { fetch, calls, session } = loadCodexFetchHandler();
  session.answer = 'unknown';

  const result = await settledOrPending(fetch());

  assert.strictEqual(calls.show, 0, 'no answer is no reason to open a window either');
  assert.strictEqual(calls.scraped, 0, 'without the session the scrape has no token to read with');
  assert.ok(result.error && result.error !== 'login-needed',
    'a hiccup must not tell the user they are signed out; the error path retries');
});

// ── main: every round leaves a record of what it saw ───────────────────────
// The card shows only "Error" or "No data", and the app runs with nowhere to
// print to, so a card that stopped updating could only be guessed at.

test('every poll that loads the page records the session answer and how the round ended', async () => {
  for (const answer of ['signed-in', 'signed-out', 'unknown']) {
    const { fetch, session, rounds, calls } = loadCodexFetchHandler();
    session.answer = answer;

    const result = await settledOrPending(fetch());

    assert.strictEqual(rounds.length, 1, `${answer}: one record per round`);
    if (answer === 'signed-in') {
      assert.strictEqual(calls.scrapeRound, rounds[0].handle,
        'the scrape notes each ask in this round\'s record');
    }
    assert.deepStrictEqual(rounds[0].notes.map((n) => n.step), ['loaded', 'session'],
      `${answer}: the record shows the page loaded, then what the session said`);
    assert.strictEqual(rounds[0].notes[1].session, answer);
    assert.strictEqual(rounds[0].ended, result,
      `${answer}: the record ends with exactly what the card was told`);
  }
});

test('a page that fails to load is recorded too', async () => {
  const { fetch, win, rounds } = loadCodexFetchHandler();
  win.webContents.loadURL = async () => { throw new Error('ERR_ABORTED (-3)'); };

  const result = await fetch();

  assert.match(result.error, /ERR_ABORTED/);
  assert.strictEqual(rounds.length, 1);
  assert.strictEqual(rounds[0].ended, result);
});

function loadCodexRound() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('// ── Codex round record');
  const end = source.indexOf('// ── Codex sign-in check');
  assert.ok(start >= 0 && end > start, 'expected Codex round record source markers');

  const written = [];
  const disk = { fails: false };
  const context = {
    fs: { writeFileSync: (file, data) => { if (disk.fails) throw new Error('EBUSY'); written.push({ file, data }); } },
    path: { join: (...parts) => parts.join('/') },
    __dirname: 'app',
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const win = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    webContents: {
      url: 'https://chatgpt.com/settings/usage',
      title: 'Settings',
      getURL: () => { if (win.destroyed) throw new Error('Object has been destroyed'); return win.webContents.url; },
      getTitle: () => { if (win.destroyed) throw new Error('Object has been destroyed'); return win.webContents.title; },
    },
  };
  return { startCodexRound: context.startCodexRound, win, written, disk };
}

test('the round record shows where the page was at each step and how the round ended', () => {
  const { startCodexRound, win, written } = loadCodexRound();
  const round = startCodexRound(win);
  round.note('loaded');
  win.webContents.url = 'https://chatgpt.com/auth/login';
  win.webContents.title = 'Log in';
  round.note('session', { session: 'signed-out' });
  const result = { error: 'login-needed' };

  assert.strictEqual(round.end(result), result, 'end hands the result straight back');

  assert.strictEqual(written.length, 1, 'one write per round, at its end');
  assert.match(written[0].file, /codex-api-debug\.json$/, 'the gitignored debug file');
  const record = JSON.parse(written[0].data);
  assert.deepStrictEqual(record.steps.map((s) => [s.step, s.url, s.title]), [
    ['loaded', 'https://chatgpt.com/settings/usage', 'Settings'],
    ['session', 'https://chatgpt.com/auth/login', 'Log in'],
    ['done', 'https://chatgpt.com/auth/login', 'Log in'],
  ]);
  assert.strictEqual(record.steps[1].session, 'signed-out');
  assert.strictEqual(record.result.error, 'login-needed');
});

test('the round record keeps a long page text short but keeps the usage whole', () => {
  const { startCodexRound, win, written } = loadCodexRound();
  const usage = { rate_limit: { primary_window: { used_percent: 12 } } };

  startCodexRound(win).end({ text: 'x'.repeat(5000), apiData: usage });

  const record = JSON.parse(written[0].data);
  assert.strictEqual(record.result.text.length, 2000);
  assert.strictEqual(record.result.textLength, 5000);
  assert.deepStrictEqual(record.result.apiData, usage);
});

test('a window closed mid-round does not break the round or its record', () => {
  const { startCodexRound, win, written } = loadCodexRound();
  const round = startCodexRound(win);
  win.destroyed = true;                 // the user closed the login window

  round.note('session', { session: 'unknown' });
  const result = { error: 'chatgpt.com did not say whether you are signed in' };

  assert.strictEqual(round.end(result), result,
    'a throw here would leave the card waiting on a poll that never answers');
  const record = JSON.parse(written[0].data);
  assert.strictEqual(record.steps[0].session, 'unknown');
  assert.strictEqual(record.steps[0].url, null);
});

// ── main: the scrape survives chatgpt.com moving the page ──────────────────
// Signed in, chatgpt.com swaps the usage page for its own settings page
// (/settings/usage?tab=analytics) as the round runs. A scrape running on the
// old page then never answers: the record showed "Script timeout (30s)", and
// the card logged nothing from 14:34 BST on 20 Oct.

function loadCodexScrape() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function getOrCreateCodexWindow');
  const end = source.indexOf('// ── Codex round record');
  assert.ok(start >= 0 && end > start, 'expected Codex scraper source markers');

  const ANSWER = JSON.stringify({ text: '', email: null, apiData: { rate_limit: {} } });
  // What each scrape the page is asked does: 'answer', or 'lost' (never answers).
  const plan = [];
  const asked = [];
  const moveListeners = [];
  const win = {
    hidden: 0,
    isDestroyed: () => false,
    hide: () => { win.hidden++; },
    webContents: {
      url: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
      getURL: () => win.webContents.url,
      executeJavaScript: (code) => {
        asked.push(code);
        return plan.shift() === 'answer' ? Promise.resolve(ANSWER) : new Promise(() => {});
      },
      on: (ev, fn) => { if (ev === 'did-navigate') moveListeners.push(fn); },
      off: (ev, fn) => {
        const i = moveListeners.indexOf(fn);
        if (i >= 0) moveListeners.splice(i, 1);
      },
    },
  };
  const timeouts = new Map();
  let nextId = 1;
  const context = {
    SCRAPE_SCRIPT: 'scrape',
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const notes = [];
  const round = { note: (step, extra) => { notes.push({ step, ...extra }); } };
  return {
    scrape: () => context.scrapeCodexPage(win, round),
    plan, asked, notes, win, moveListeners,
    // chatgpt.com puts a new page in the window.
    move: (url) => { win.webContents.url = url; for (const fn of [...moveListeners]) fn(null, url); },
    // Lets every pending time limit run out; returns how long each one was.
    elapse: () => {
      const due = [...timeouts.values()];
      timeouts.clear();
      for (const t of due) t.fn();
      return due.map((t) => t.ms);
    },
    pendingLimits: () => timeouts.size,
  };
}

const beat = () => new Promise((resolve) => setImmediate(resolve));

test('a scrape cut off by chatgpt.com moving the page is asked again on the page it moved to', async () => {
  const s = loadCodexScrape();
  s.plan.push('lost', 'answer');

  const result = s.scrape();
  await beat();
  s.move('https://chatgpt.com/settings/usage?tab=analytics#usage');
  const out = await settledOrPending(result);

  assert.ok(!out.pending, 'it must not wait out the time limit on a page that has gone');
  assert.strictEqual(s.asked.length, 2, 'asked once on each page');
  assert.ok(out.apiData, 'the second page reads the usage');
  assert.deepStrictEqual(s.notes.map((n) => [n.step, n.attempt, n.outcome]), [
    ['scrape', 1, 'page moved'],
    ['scrape', 2, 'answered'],
  ]);
  assert.strictEqual(s.moveListeners.length, 0, 'no listener left on the window');
  assert.strictEqual(s.pendingLimits(), 0, 'no time limit left running');
  assert.ok(s.win.hidden > 0, 'the window stays hidden');
});

test('a scrape that never answers is asked once more, then reported, not left hanging', async () => {
  const s = loadCodexScrape();
  s.plan.push('lost', 'lost');

  const result = s.scrape();
  await beat();
  assert.deepStrictEqual(s.elapse(), [30000], 'the first ask has a 30 s limit');
  await beat();
  assert.deepStrictEqual(s.elapse(), [30000], 'so does the second');
  const out = await settledOrPending(result);

  assert.ok(!out.pending, 'two lost answers must end the round');
  assert.strictEqual(s.asked.length, 2, 'two asks at most: the round has to fit inside a 1 min poll');
  assert.ok(out.error, 'the card is told it went wrong, so it retries');
  assert.deepStrictEqual(s.notes.map((n) => n.outcome), ['no answer', 'no answer']);
  assert.strictEqual(s.moveListeners.length, 0, 'no listener left on the window');
});

test('a scrape that answers first time is asked only once', async () => {
  const s = loadCodexScrape();
  s.plan.push('answer');

  const out = await settledOrPending(s.scrape());

  assert.ok(out.apiData);
  assert.strictEqual(s.asked.length, 1);
  assert.deepStrictEqual(s.notes.map((n) => n.outcome), ['answered']);
  assert.strictEqual(s.moveListeners.length, 0, 'no listener left on the window');
  assert.strictEqual(s.pendingLimits(), 0, 'no time limit left running');
});

test('a record that cannot be written does not break the round', () => {
  const { startCodexRound, win, disk } = loadCodexRound();
  disk.fails = true;                    // say, an editor has the file open
  const result = { text: 'usage limit remaining' };

  assert.strictEqual(startCodexRound(win).end(result), result,
    'the reading must still reach the card');
});

// ── renderer: backing off must be quiet, not an error ──────────────────────

function loadFetchCodexUsage(ipcResult) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function fetchCodexUsage()');
  const end = source.indexOf('// ── Cached data');
  assert.ok(start >= 0 && end > start, 'expected fetchCodexUsage source markers');

  const calls = { toasts: [], badges: [], retries: [], rendered: 0 };
  const context = {
    console,
    retryTimers: {},
    setTimeout: (fn, ms) => { calls.retries.push(ms); return 1; },
    clearTimeout: () => {},
    fetchStart: () => {}, fetchStop: () => {},
    setBadge: (id, label, kind) => { calls.badges.push([id, label, kind]); },
    showToast: (m) => { calls.toasts.push(m); },
    markUpdated: () => {},
    renderAccountData: () => { calls.rendered++; },
    parseCodexApiUsage: () => null,
    parseCodexText: () => ({ pct5h: null, pctWk: null }),
    hasData: {},
    openPanels: new Set(),
    PROVIDERS: [{ id: 'codex' }],
    window: { electronAPI: { fetchCodexUsage: async () => ipcResult } },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { run: context.fetchCodexUsage, calls };
}

test('while the user logs in, the card goes quiet rather than claiming an error', async () => {
  const { run, calls } = loadFetchCodexUsage({ error: 'window-in-use' });

  await run();

  assert.deepStrictEqual(calls.toasts, [],
    'a toast here lands on top of the login window the user is typing into');
  assert.ok(!calls.badges.some(([, label]) => label === 'Error'),
    'the account is not in error — it is waiting for a sign-in the user started');
  assert.deepStrictEqual(calls.retries, [30_000],
    'back off and look again, matching the Claude path');
});

test('a signed-out poll marks the card Login needed, quietly', async () => {
  const { run, calls } = loadFetchCodexUsage({ error: 'login-needed' });

  await run();

  assert.ok(calls.badges.some(([, label, kind]) => label === 'Login needed' && kind === 'warn'),
    'the card is where the user learns to click Login');
  assert.ok(!calls.badges.some(([, label]) => label === 'Error'), 'signed out is not an error');
  assert.deepStrictEqual(calls.toasts, [], 'the poll runs every round; a toast each time would nag');
});

test('a real fetch error still reports as one', async () => {
  const { run, calls } = loadFetchCodexUsage({ error: 'Failed to load chatgpt.com: timeout' });

  await run();

  assert.ok(calls.badges.some(([, label]) => label === 'Error'));
  assert.strictEqual(calls.toasts.length, 1, 'a genuine failure is still worth saying');
  assert.deepStrictEqual(calls.retries, [45_000]);
});

// ── main: the login window must get out of the way once signed in ──────────

// The guard above makes a VISIBLE window mean "back off". That cuts both
// ways: show-codex-window opens the very window the poll scrapes, so if it
// stays up after a successful sign-in, every poll backs off for as long as it
// sits there and the card never updates — ↻ Refresh included. Claude avoids
// this by opening a separate login window; Codex shares one, so it has to
// stand down once the sign-in lands.
//
// "Lands" is judged by asking chatgpt.com's session endpoint, not by the page
// address. Signed out, chatgpt.com still serves the usage address (HTTP 200)
// and only then moves itself to /auth/login, so an address check closed the
// window about eight seconds in, before the login form had even appeared.

const USAGE_URL = 'https://chatgpt.com/codex/cloud/settings/analytics#usage';

function loadShowCodexWindow() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // The session question the login window asks lives in its own section, shared
  // with the poll; load it alongside.
  const checkStart = source.indexOf('// ── Codex sign-in check');
  const checkEnd = source.indexOf("ipcMain.handle('fetch-codex-usage'", checkStart);
  const start = source.indexOf('// ── Codex login window');
  const end = source.indexOf('// ── Claude web scraper', start);
  assert.ok(checkStart >= 0 && checkEnd > checkStart, 'expected Codex sign-in check source markers');
  assert.ok(start >= 0 && end > start, 'expected Codex login window source markers');

  // The window fires did-navigate as pages load, exactly as the real one does,
  // so a handler that still keys off the address is exercised by these tests.
  const navListeners = [];
  const state = { signedIn: false, checks: 0, pending: null };
  const win = {
    visible: false,
    destroyed: false,
    isVisible: () => win.visible,
    isDestroyed: () => win.destroyed,
    hide: () => { win.visible = false; },
    show: () => { win.visible = true; },
    focus: () => {},
    loadURL: () => {},
    webContents: {
      url: 'about:blank',
      getURL: () => win.webContents.url,
      executeJavaScript: () => {
        state.checks++;
        return state.pending || Promise.resolve(state.signedIn ? 'signed-in' : 'signed-out');
      },
      on: (ev, fn) => { if (ev === 'did-navigate') navListeners.push(fn); },
      off: (ev, fn) => {
        const i = navListeners.indexOf(fn);
        if (i >= 0) navListeners.splice(i, 1);
      },
    },
  };

  const timers = new Map();
  const timeouts = new Map();
  const warnings = [];
  let nextId = 1;
  const handlers = {};
  const context = {
    console: { ...console, warn: (...args) => { warnings.push(args.join(' ')); } },
    setInterval: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearInterval: (id) => { timers.delete(id); },
    setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timeouts.delete(id); },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    getOrCreateCodexWindow: () => win,
    CODEX_URL: USAGE_URL,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(checkStart, checkEnd) + source.slice(start, end), context);

  assert.ok(handlers['show-codex-window'], 'handler was not registered');
  return {
    open: () => handlers['show-codex-window'](),
    navigate: (url) => {
      win.webContents.url = url;
      for (const fn of [...navListeners]) fn(null, url);
    },
    // One beat of whatever periodic check is running, awaited.
    tick: async () => { for (const fn of [...timers.values()]) await fn(); },
    // Lets every pending time limit run out; returns how long each one was.
    elapse: () => {
      const due = [...timeouts.entries()];
      timeouts.clear();
      for (const [, t] of due) t.fn();
      return due.map(([, t]) => t.ms);
    },
    running: () => timers.size,
    win,
    state,
    warnings,
  };
}

test('the login window stays up while the user is still signing in', async () => {
  const { open, navigate, tick, win, state } = loadShowCodexWindow();
  open();

  navigate('https://auth.openai.com/log-in');
  await tick();

  assert.strictEqual(win.visible, true,
    'hiding it here is the original bug — the user is mid-sign-in');
  assert.strictEqual(state.checks, 0,
    'off chatgpt.com there is no session to ask about');
});

test('the login window stays up when chatgpt.com serves the usage address to a signed-out user', async () => {
  const { open, navigate, tick, win } = loadShowCodexWindow();
  open();

  // What chatgpt.com does for a signed-out visitor: the usage address loads
  // with HTTP 200, then the page moves itself to /auth/login.
  navigate(USAGE_URL);
  await tick();

  assert.strictEqual(win.visible, true,
    'closing here is what made the login page vanish before it appeared');
});

test('the login window stands down once chatgpt.com reports a sign-in, so polling resumes', async () => {
  const { open, navigate, tick, win, state, running } = loadShowCodexWindow();
  open();
  navigate('https://auth.openai.com/log-in');
  await tick();

  navigate('https://chatgpt.com/');   // back from the sign-in pages
  state.signedIn = true;
  await tick();

  assert.strictEqual(win.visible, false,
    'while it is visible every poll returns window-in-use, so the card never updates');
  assert.strictEqual(running(), 0,
    'the check must stop once it has done its job');
});

test('closing the login window stops the sign-in check', async () => {
  const { open, navigate, tick, win, state, running } = loadShowCodexWindow();
  open();
  navigate(USAGE_URL);

  win.destroyed = true;
  await tick();

  assert.strictEqual(running(), 0, 'nothing should keep checking a window that is gone');
  assert.strictEqual(state.checks, 0, 'and it must not touch the destroyed window');
});

test('clicking Login twice keeps a single sign-in check', () => {
  const { open, running } = loadShowCodexWindow();
  open();
  open();

  assert.strictEqual(running(), 1, 'repeated clicks must not stack checks on one window');
});

test('a slow session answer does not stack a second check on top of it', async () => {
  const { open, navigate, tick, state } = loadShowCodexWindow();
  open();
  navigate(USAGE_URL);

  let answer;
  state.pending = new Promise((resolve) => { answer = resolve; });
  const first = tick();        // a check is in flight, unanswered
  await tick();                // the next beat arrives meanwhile

  assert.strictEqual(state.checks, 1, 'one question at a time');
  answer('signed-out');
  await first;
});

test('a session question lost to a page move does not stop the check for good', async () => {
  const { open, navigate, tick, elapse, win, state, warnings } = loadShowCodexWindow();
  open();
  navigate('https://chatgpt.com/auth/login');

  // Electron 28 can lose the answer to a script whose page moved to another
  // site while it ran (one in seven, against the real sites). Clicking through
  // to auth.openai.com with a check out does exactly that, and was the reported
  // jam: signed in at last, the window still sat there, because the check
  // never asked again.
  state.pending = new Promise(() => {});
  tick();                                      // never settles on its own
  navigate('https://auth.openai.com/log-in');
  state.pending = null;
  const limits = elapse();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(win.visible, true, 'a lost answer is not a sign-in; the user is still signing in');

  navigate('https://chatgpt.com/');            // signed in, back on chatgpt.com
  state.signedIn = true;
  await tick();

  assert.strictEqual(win.visible, false,
    'left up, the window holds every poll at window-in-use and the card never updates');
  assert.ok(limits.length === 1 && limits[0] > 5000,
    'one time limit per question, longer than the fetch\'s own 5 s, so a slow answer is not thrown away');
  assert.strictEqual(warnings.length, 1, 'a lost answer should say so in the log');
});
