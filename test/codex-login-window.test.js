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

  const handlers = {};
  const context = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    getOrCreateCodexWindow: () => win,
    CODEX_URL: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
    ANALYTICS_RE: /chatgpt\.com\/codex\/cloud\/settings\/analytics/,
    scrapeCodexPage: async () => { calls.scraped++; return { text: 'usage limit remaining' }; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  assert.ok(handlers['fetch-codex-usage'], 'handler was not registered');
  return { fetch: () => handlers['fetch-codex-usage'](), win, calls };
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
  const start = source.indexOf('// ── Codex login window');
  const end = source.indexOf('// ── Claude web scraper', start);
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
        return state.pending || Promise.resolve(state.signedIn);
      },
      on: (ev, fn) => { if (ev === 'did-navigate') navListeners.push(fn); },
      off: (ev, fn) => {
        const i = navListeners.indexOf(fn);
        if (i >= 0) navListeners.splice(i, 1);
      },
    },
  };

  const timers = new Map();
  let nextId = 1;
  const handlers = {};
  const context = {
    console,
    setInterval: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearInterval: (id) => { timers.delete(id); },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    getOrCreateCodexWindow: () => win,
    CODEX_URL: USAGE_URL,
    ANALYTICS_RE: /chatgpt\.com\/codex\/cloud\/settings\/analytics/,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  assert.ok(handlers['show-codex-window'], 'handler was not registered');
  return {
    open: () => handlers['show-codex-window'](),
    navigate: (url) => {
      win.webContents.url = url;
      for (const fn of [...navListeners]) fn(null, url);
    },
    // One beat of whatever periodic check is running, awaited.
    tick: async () => { for (const fn of [...timers.values()]) await fn(); },
    running: () => timers.size,
    win,
    state,
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
  answer(false);
  await first;
});
