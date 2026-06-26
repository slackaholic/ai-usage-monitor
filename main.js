const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { normalizeCodexTokenUsage } = require('./metrics.js');

let mainWindow;
let analyticsWindow = null;
let settingsWindow = null;
let tray;
let isAlwaysOnTop = false;
let codexWindow = null;

// Two Claude web sessions: 'desktop' and 'vscode'
const claudeWebWindows = { desktop: null, vscode: null };

// ── Settings (position, opacity) ───────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const USAGE_LOG_PATH = path.join(__dirname, 'usage-log.jsonl');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}
function saveSettings(patch) {
  try {
    const s = loadSettings();
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ ...s, ...patch }, null, 2));
  } catch {}
}

ipcMain.on('open-external', (_, url) => shell.openExternal(url));

ipcMain.on('append-usage-log', (_, entry) => {
  try { fs.appendFileSync(USAGE_LOG_PATH, JSON.stringify(entry) + '\n'); } catch {}
});

ipcMain.handle('read-usage-log', (_, account, limit = 200) => {
  try {
    const raw = fs.readFileSync(USAGE_LOG_PATH, 'utf8');
    const all = raw.trim().split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && (!account || e.account === account));
    return all.slice(-limit);
  } catch { return []; }
});

ipcMain.on('open-analytics', (_, account) => {
  if (analyticsWindow && !analyticsWindow.isDestroyed()) {
    if (account) analyticsWindow.webContents.send('switch-analytics-tab', account);
    analyticsWindow.focus();
    return;
  }
  analyticsWindow = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 600,
    minHeight: 400,
    title: 'AI Usage Analytics',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const url = account ? `analytics.html?account=${encodeURIComponent(account)}` : 'analytics.html';
  analyticsWindow.loadFile('analytics.html', account ? { query: { account } } : {});
  analyticsWindow.on('closed', () => { analyticsWindow = null; });
});

ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 400,
    height: 700,
    minWidth: 340,
    minHeight: 320,
    title: 'AI Usage Monitor — Settings',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWindow.loadFile('settings.html');
  // Size the window to fit its content so everything is visible without scrolling.
  settingsWindow.webContents.once('did-finish-load', async () => {
    try {
      const h = await settingsWindow.webContents.executeJavaScript('document.body.scrollHeight');
      const [w] = settingsWindow.getContentSize();
      settingsWindow.setContentSize(w, Math.min(Math.max(Math.ceil(h) + 4, 320), 1000));
    } catch {}
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
});

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.on('save-settings', (_, patch) => {
  saveSettings(patch);
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('settings-changed'));
});
ipcMain.on('set-opacity', (_, val) => {
  const clamped = Math.max(0.2, Math.min(1, val));
  mainWindow.setOpacity(clamped);
  saveSettings({ opacity: clamped });
});

// ── Claude Code local JSONL reader ─────────────────────────────────────────
ipcMain.handle('read-claude-code-usage', async () => {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  const jsonlFiles = [];
  function scanDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scanDir(full);
        else if (entry.name.endsWith('.jsonl')) jsonlFiles.push(full);
      }
    } catch {}
  }

  try {
    scanDir(projectsDir);
  } catch (e) {
    return { error: e.message };
  }

  const entries = [];

  for (const file of jsonlFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.usage && obj.timestamp) {
            entries.push({
              timestamp: obj.timestamp,
              model: obj.message.model || 'unknown',
              input_tokens: obj.message.usage.input_tokens || 0,
              output_tokens: obj.message.usage.output_tokens || 0,
              cache_creation: obj.message.usage.cache_creation_input_tokens || 0,
              cache_read: obj.message.usage.cache_read_input_tokens || 0,
            });
          }
        } catch {}
      }
    } catch {}
  }

  return { entries };
});

// Codex writes exact per-turn token usage to local session logs. Each turn emits
// an event_msg with payload.type === 'token_count' (info.last_token_usage = the
// per-turn delta); the active model comes from the preceding turn_context event.
ipcMain.handle('read-codex-usage', async () => {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');

  const jsonlFiles = [];
  function scanDir(dir) {
    try {
      const dirents = fs.readdirSync(dir, { withFileTypes: true });
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) scanDir(full);
        else if (d.name.endsWith('.jsonl')) jsonlFiles.push(full);
      }
    } catch {}
  }

  try {
    if (!fs.existsSync(sessionsDir)) return { entries: [] };
    scanDir(sessionsDir);
  } catch (e) {
    return { error: e.message };
  }

  const entries = [];
  for (const file of jsonlFiles) {
    let currentModel = 'unknown';
    try {
      const content = fs.readFileSync(file, 'utf8');
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
          const e = normalizeCodexTokenUsage(
            obj.payload.info.last_token_usage, currentModel, obj.timestamp);
          if (e) entries.push(e);
        }
      }
    } catch {}
  }

  return { entries };
});

// ── IPC: window control ────────────────────────────────────────────────────
ipcMain.on('toggle-always-on-top', () => {
  isAlwaysOnTop = !isAlwaysOnTop;
  mainWindow.setAlwaysOnTop(isAlwaysOnTop);
  mainWindow.webContents.send('always-on-top-changed', isAlwaysOnTop);
  updateTrayMenu();
});

ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('close-window', () => { mainWindow.removeAllListeners('close'); app.quit(); });
ipcMain.handle('get-always-on-top', () => isAlwaysOnTop);
ipcMain.on('resize-to-fit', (_, totalHeight) => {
  const { screen } = require('electron');
  const newHeight = Math.min(Math.max(totalHeight + 8, 120), 1200);
  const [w] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  const workArea = screen.getDisplayNearestPoint({ x, y }).workArea;
  // If the window would extend below the work area, shift it up — but never above the top
  const maxY = workArea.y + workArea.height - newHeight;
  const newY  = Math.max(workArea.y, Math.min(y, maxY));
  if (newY !== y) mainWindow.setPosition(x, newY);
  mainWindow.setSize(w, newHeight);
});

// ── Shared email-finder JS (injected into both scrapers) ───────────────────
const FIND_EMAIL_JS = `
(function findEmail() {
  const EMAIL_RE = /[\\w._%+\\-]+@[\\w.\\-]+\\.[a-z]{2,}/i;
  const KEY_RE   = /email|emailaddress|email_address/i;

  // 1. __NEXT_DATA__ (Next.js SSR)
  try {
    const s = JSON.stringify(window.__NEXT_DATA__ || {});
    const m = s.match(/"(?:email|emailAddress|email_address)"\\s*:\\s*"([^"]+@[^"]+)"/i);
    if (m) return m[1];
  } catch {}

  // 2. window globals that sound like auth/user state
  try {
    const skip = new Set(['location','history','navigator','document','performance','screen','localStorage','sessionStorage']);
    for (const key of Object.getOwnPropertyNames(window)) {
      if (skip.has(key) || typeof window[key] !== 'object' || !window[key]) continue;
      try {
        const s = JSON.stringify(window[key]);
        if (!s || !s.includes('@')) continue;
        const m = s.match(/"(?:email|emailAddress|email_address)"\\s*:\\s*"([^"]+@[^"]+)"/i);
        if (m) return m[1];
      } catch {}
    }
  } catch {}

  // 3. localStorage + sessionStorage
  for (const store of [localStorage, sessionStorage]) {
    try {
      for (let i = 0; i < store.length; i++) {
        const val = store.getItem(store.key(i)) || '';
        if (!val.includes('@')) continue;
        try {
          const s = JSON.stringify(JSON.parse(val));
          const m = s.match(/"(?:email|emailAddress|email_address)"\\s*:\\s*"([^"]+@[^"]+)"/i);
          if (m) return m[1];
        } catch {}
        const m = val.match(EMAIL_RE);
        if (m) return m[0];
      }
    } catch {}
  }

  // 4. React fiber tree walk (catches email in component state/props)
  try {
    const roots = [document.querySelector('#root'), document.querySelector('#__next'),
                   document.querySelector('[data-reactroot]'), document.body].filter(Boolean);
    for (const el of roots) {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fk) continue;
      let fiber = el[fk];
      let visited = 0;
      const queue = [fiber];
      while (queue.length && visited < 2000) {
        const f = queue.shift();
        if (!f) continue;
        visited++;
        for (const prop of ['memoizedProps', 'memoizedState', 'pendingProps']) {
          try {
            if (!f[prop] || typeof f[prop] !== 'object') continue;
            const s = JSON.stringify(f[prop]);
            if (!s || s.length > 50000 || !s.includes('@')) continue;
            const m = s.match(/"(?:email|emailAddress|email_address)"\\s*:\\s*"([^"]+@[^"]+)"/i);
            if (m) return m[1];
          } catch {}
        }
        if (f.child) queue.push(f.child);
        if (f.sibling) queue.push(f.sibling);
      }
    }
  } catch {}

  // 5. DOM leaf nodes containing @
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t.includes('@') && t.length < 120) {
        const m = t.match(EMAIL_RE);
        if (m) return m[0];
      }
    }
  } catch {}

  return null;
})()
`;

// ── Codex page scraper ─────────────────────────────────────────────────────
const CODEX_URL = 'https://chatgpt.com/codex/cloud/settings/analytics#usage';

const ANALYTICS_RE = /chatgpt\.com\/codex\/cloud\/settings\/analytics/;
const AUTH_RE = /auth|login|signin|sso/i;

const SCRAPE_SCRIPT = `
  (async function() {
    for (let i = 0; i < 24; i++) {
      const t = document.body ? document.body.innerText : '';
      if (t.includes('usage limit') && t.includes('remaining')) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const text = document.body ? document.body.innerText : '';
    const email = ${FIND_EMAIL_JS};

    // Structured usage from /backend-api/codex/usage. It needs an
    // Authorization: Bearer <accessToken> header (cookies alone return 401);
    // the token comes from the session endpoint.
    let apiData = null;
    try {
      const sr = await fetch('/api/auth/session', { credentials: 'include', signal: AbortSignal.timeout(5000) });
      const sj = await sr.json().catch(() => null);
      const token = sj && sj.accessToken;
      if (token) {
        const ur = await fetch('/backend-api/codex/usage', {
          credentials: 'include',
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(5000),
        });
        if (ur.ok) apiData = await ur.json().catch(() => null);
      }
    } catch {}

    return JSON.stringify({ text, email, apiData });
  })()
`;

function getOrCreateCodexWindow() {
  if (codexWindow && !codexWindow.isDestroyed()) return codexWindow;

  codexWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      partition: 'persist:codex',
    },
  });

  codexWindow.webContents.setBackgroundThrottling(false);
  codexWindow.on('closed', () => { codexWindow = null; });
  return codexWindow;
}

async function scrapeCodexPage(win) {
  try {
    const raw = await Promise.race([
      win.webContents.executeJavaScript(SCRAPE_SCRIPT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Script timeout (30s)')), 30000)),
    ]);
    win.hide();
    try {
      const p = JSON.parse(raw);
      return { text: p.text, email: p.email, apiData: p.apiData };
    } catch { return { text: raw }; }
  } catch (e) {
    win.hide();
    return { error: e.message };
  }
}

ipcMain.handle('fetch-codex-usage', async () => {
  const win = getOrCreateCodexWindow();
  win.hide();

  try {
    await Promise.race([
      win.webContents.loadURL(CODEX_URL),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Load timeout')), 25000)),
    ]);
  } catch (e) {
    return { error: 'Failed to load chatgpt.com: ' + e.message };
  }

  const url = win.webContents.getURL();
  if (ANALYTICS_RE.test(url)) {
    return await scrapeCodexPage(win);
  }

  // Need login — show window and wait
  win.show(); win.focus();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.off('did-navigate', onNavigated);
        win.hide();
      }
      resolve({ error: 'Login timeout — please log in and try again' });
    }, 300000);

    function onNavigated(_, navUrl) {
      if (win.isDestroyed()) { clearTimeout(timer); resolve({ error: 'window-closed' }); return; }
      if (ANALYTICS_RE.test(navUrl)) {
        win.webContents.off('did-navigate', onNavigated);
        clearTimeout(timer);
        win.hide();
        win.webContents.once('did-finish-load', async () => {
          resolve(await scrapeCodexPage(win));
        });
      }
    }
    win.on('closed', () => { clearTimeout(timer); resolve({ error: 'window-closed' }); });
    win.webContents.on('did-navigate', onNavigated);
  });
});

ipcMain.handle('show-codex-window', () => {
  const win = getOrCreateCodexWindow();
  win.show();
  win.focus();
  win.loadURL(CODEX_URL);
});

// ── Claude web scraper (claude.ai/settings) ────────────────────────────────
const CLAUDE_URL = 'https://claude.ai/settings/usage';
const CLAUDE_AUTH_RE = /claude\.ai\/(login|auth|sign)/i;
const CLAUDE_SETTINGS_RE = /claude\.ai\/settings/i;

const CLAUDE_SCRAPE_SCRIPT = `
  (async function() {
    const USAGE_KEYWORDS = ['Current session','usage limit','% used','% remaining','5-hour','5 hour'];
    const hasUsageData = () => { const t = document.body ? document.body.innerText : ''; return USAGE_KEYWORDS.some(k => t.includes(k)); };

    // Click a cookie consent button using every available method.
    // .click() alone doesn't trigger React synthetic events; we must invoke the
    // React fiber's onClick directly, then also fire native pointer+mouse events.
    const fireCookieClick = (btn) => {
      // 1. React fiber onClick (most reliable for React-controlled buttons)
      try {
        const fk = Object.keys(btn).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        const props = fk && (btn[fk]?.memoizedProps || btn[fk]?.return?.memoizedProps);
        if (props?.onClick) props.onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, bubbles:true, nativeEvent:{} });
      } catch {}
      // 2. Full native pointer+mouse sequence
      for (const t of ['pointerover','pointerenter','mouseover','mouseenter','pointerdown','mousedown','pointerup','mouseup','click']) {
        try { btn.dispatchEvent(new (t.startsWith('pointer')?PointerEvent:MouseEvent)(t, { bubbles:true, cancelable:true })); } catch {}
      }
      // 3. DOM .click() as final fallback
      try { btn.click(); } catch {}
    };

    const findCookieBtn = () => [...document.querySelectorAll('button, [role=button]')]
      .find(b => /(accept|reject)\s*(all\s*)?cookies/i.test((b.innerText || b.textContent || '').trim()));

    const dismissCookies = async () => {
      const btn = findCookieBtn();
      if (btn) { fireCookieClick(btn); await new Promise(r => setTimeout(r, 1500)); return; }
      // If button not found, hide the dialog element so the page can render behind it
      for (const el of [...document.querySelectorAll('[role=dialog],[data-radix-dialog-content],div[class]')]) {
        if ((el.innerText || '').includes('Accept All Cookies')) { el.style.display = 'none'; break; }
      }
    };

    // First dismissal attempt (dialog may already be present before navigation)
    await dismissCookies();

    // Navigate to usage page if not already there (check full path, not just /settings)
    if (!location.pathname.includes('/settings/usage')) {
      window.location.href = '${CLAUDE_URL}';
    }
    // Wait until URL contains /settings/usage
    for (let i = 0; i < 20; i++) {
      if (location.pathname.includes('/settings/usage')) break;
      // SPA may land on /settings first — click the Usage nav link to go deeper
      const usageLink = [...document.querySelectorAll('a[href*="usage"], nav a, aside a')]
        .find(a => /^usage$/i.test((a.innerText || a.textContent || '').trim()));
      if (usageLink) usageLink.click();
      await new Promise(r => setTimeout(r, 300));
    }
    // Poll for usage content; re-dismiss cookie dialog if it reappears after navigation
    for (let i = 0; i < 50; i++) {
      if (hasUsageData()) break;
      if (findCookieBtn()) await dismissCookies();
      await new Promise(r => setTimeout(r, 300));
    }
    // Fall back: click the Usage entry in the sidebar nav only (not body links)
    if (!hasUsageData()) {
      const navLink = [...document.querySelectorAll('nav a, [role=navigation] a, aside a, [data-testid] a')]
        .find(el => el.textContent.trim().toLowerCase() === 'usage');
      if (navLink) navLink.click();
      for (let i = 0; i < 30; i++) {
        if (hasUsageData()) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    const text = document.body ? document.body.innerText : '';
    let email = ${FIND_EMAIL_JS};
    if (!email) {
      // Try same-origin auth endpoints — cookies already present in this session
      try {
        const r = await fetch('/api/auth/session', { credentials: 'include', signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const s = JSON.stringify(await r.json());
          const m = s.match(/"(?:email|emailAddress|email_address)"\\s*:\\s*"([^"]+@[^"]+)"/i);
          if (m) email = m[1];
        }
      } catch {}
      if (!email) {
        try {
          const r = await fetch('/api/account', { credentials: 'include', signal: AbortSignal.timeout(4000) });
          if (r.ok) {
            const s = JSON.stringify(await r.json());
            const m = s.match(/"(?:email|emailAddress|email_address)"\\s*:\\s*"([^"]+@[^"]+)"/i);
            if (m) email = m[1];
          }
        } catch {}
      }
    }
    // Probe API endpoints to find usage data and aid debugging
    const apiResults = {};
    const probe = async (endpoint) => {
      try {
        const r = await fetch(endpoint, { credentials: 'include', signal: AbortSignal.timeout(5000) });
        apiResults[endpoint] = { status: r.status, body: await r.text().catch(() => '(read error)') };
      } catch (e) { apiResults[endpoint] = { error: e.message }; }
    };
    await Promise.all([
      probe('/api/auth/session'),
      probe('/api/account'),
      probe('/api/usage'),
      probe('/api/rate_limit_status'),
    ]);

    return JSON.stringify({ text, email, url: location.href, api: apiResults });
  })()
`;

const CLAUDE_PARTITIONS = { desktop: 'persist:claude-web', vscode: 'persist:claude-web-vscode' };

// ── Claude Code API usage (reads ~/.claude/.credentials.json) ─────────────
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

function readCredentials() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')); } catch { return null; }
}

async function refreshOAuthToken(refreshToken) {
  const https = require('https');
  const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'claude.ai', path: '/api/auth/token', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

ipcMain.handle('fetch-claude-code-api-usage', async () => {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth?.accessToken) return { error: 'no-credentials' };

  // Build a readable account label from credentials metadata
  const tier = creds.claudeAiOauth?.rateLimitTier ?? '';
  const sub  = creds.claudeAiOauth?.subscriptionType ?? '';
  const account = tier.replace('default_', '').replace(/_/g, ' ') || sub || 'Claude Code';

  let token = creds.claudeAiOauth.accessToken;

  // Refresh if within 5 minutes of expiry
  if (creds.claudeAiOauth.expiresAt < Date.now() + 300_000) {
    const refreshed = await refreshOAuthToken(creds.claudeAiOauth.refreshToken);
    if (refreshed?.access_token) {
      token = refreshed.access_token;
      const updated = { ...creds, claudeAiOauth: { ...creds.claudeAiOauth, accessToken: token, expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000 } };
      try { fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2)); } catch {}
    }
  }

  const https = require('https');
  // Minimal inference probe — only to read rate-limit response headers
  const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: '.' }] });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-client-name': 'claude-code',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume(); // drain body — we only care about headers
      const h = res.headers;
      const util5h = parseFloat(h['anthropic-ratelimit-unified-5h-utilization'] ?? '-1');
      const util7d  = parseFloat(h['anthropic-ratelimit-unified-7d-utilization'] ?? '-1');
      if (util5h < 0) { resolve({ error: 'no-rate-limit-headers' }); return; }

      const reset5hMs = parseInt(h['anthropic-ratelimit-unified-5h-reset'] ?? '0') * 1000;
      const reset7dMs  = parseInt(h['anthropic-ratelimit-unified-7d-reset']  ?? '0') * 1000;

      const fmtReset = (ms) => {
        const diff = ms - Date.now();
        if (diff <= 0) return 'soon';
        const hr = Math.floor(diff / 3_600_000);
        const mn = Math.floor((diff % 3_600_000) / 60_000);
        return hr > 0 ? `${hr} hr ${mn} min` : `${mn} min`;
      };

      resolve({
        pct5h:     Math.round((1 - util5h) * 100),
        pct7d:     Math.round((1 - util7d) * 100),
        reset5h:   fmtReset(reset5hMs),
        reset7d:   fmtReset(reset7dMs),
        reset5hMs,  // epoch ms — exact reset timestamp from API header
        reset7dMs,
        status5h:  h['anthropic-ratelimit-unified-5h-status'] ?? 'unknown',
        status7d:  h['anthropic-ratelimit-unified-7d-status']  ?? 'unknown',
        account,
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.write(body); req.end();
  });
});

// One-shot hidden scrape to grab the claude.ai email for the vscode/claude-code session
const EMAIL_ONLY_SCRIPT = `
  (async function() {
    for (let i = 0; i < 20; i++) {
      if (document.body && document.body.innerText.length > 100) break;
      await new Promise(r => setTimeout(r, 300));
    }
    let email = ${FIND_EMAIL_JS};
    if (!email) {
      for (const p of ['/api/auth/session', '/api/account', '/api/v1/account']) {
        try {
          const r = await fetch(p, { credentials: 'include' });
          if (!r.ok) continue;
          const s = JSON.stringify(await r.json());
          const m = s.match(/"(?:email|emailAddress|email_address)"\\s*:\\s*"([^"]+@[^"]+)"/i);
          if (m) { email = m[1]; break; }
        } catch {}
      }
    }
    return email || '';
  })()
`;

ipcMain.handle('fetch-claude-code-email', async () => {
  const { session: electronSession } = require('electron');

  // Try each partition that might have an active claude.ai session
  for (const partition of ['persist:claude-web-vscode', 'persist:claude-web']) {
    const sess = electronSession.fromPartition(partition);
    const cookies = await sess.cookies.get({ domain: 'claude.ai' });
    const hasSession = cookies.some(c => c.name.startsWith('__Secure') || c.name === 'sessionKey' || c.httpOnly);
    if (!hasSession) continue;

    const email = await new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 1024, height: 768, show: false, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: false, partition },
      });
      const timeout = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); resolve(''); }, 20000);
      win.webContents.on('did-finish-load', async () => {
        // Bail if redirected to login
        const url = win.webContents.getURL();
        if (/login|auth|sign/i.test(url)) { clearTimeout(timeout); win.destroy(); resolve(''); return; }
        try {
          await new Promise(r => setTimeout(r, 2000));
          const result = await win.webContents.executeJavaScript(EMAIL_ONLY_SCRIPT);
          clearTimeout(timeout);
          win.destroy();
          resolve(result || '');
        } catch { clearTimeout(timeout); win.destroy(); resolve(''); }
      });
      win.loadURL('https://claude.ai/settings');
    });

    if (email) return email;
  }
  return '';
});

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function getOrCreateClaudeWindow(key) {
  if (claudeWebWindows[key] && !claudeWebWindows[key].isDestroyed()) return claudeWebWindows[key];
  const win = new BrowserWindow({
    width: 1280, height: 900, show: false, skipTaskbar: true,
    x: -2000, y: -2000,
    webPreferences: { nodeIntegration: false, contextIsolation: false, partition: CLAUDE_PARTITIONS[key] },
  });
  win.webContents.setUserAgent(CHROME_UA);
  // Prevent Chromium from throttling setTimeout/setInterval in hidden windows
  // (background throttling raises min interval from 1ms → 1000ms, tripling worst-case scrape time)
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { claudeWebWindows[key] = null; });
  claudeWebWindows[key] = win;
  return win;
}

// Use Electron's sendInputEvent (real OS-level mouse events) to click the cookie
// consent button. JS .click() and dispatchEvent don't reach React's event handlers
// in Electron webContents — sendInputEvent bypasses that limitation.
async function dismissCookieConsent(win) {
  try {
    const posStr = await Promise.race([
      win.webContents.executeJavaScript(`
        JSON.stringify((() => {
          const btn = [...document.querySelectorAll('button, [role=button]')]
            .find(b => /(accept|reject)\\s*(all\\s*)?cookies/i.test((b.innerText || b.textContent || '').trim()));
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
        })())
      `),
      new Promise(r => setTimeout(() => r('null'), 3000)),
    ]);
    const pos = JSON.parse(posStr || 'null');
    if (!pos) return false;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: pos.x, y: pos.y, clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp',   button: 'left', x: pos.x, y: pos.y, clickCount: 1 });
    await new Promise(r => setTimeout(r, 2000));
    return true;
  } catch { return false; }
}

async function scrapeClaudePage(win) {
  // Dismiss cookie consent before running the scrape script
  await dismissCookieConsent(win);

  try {
    const raw = await Promise.race([
      win.webContents.executeJavaScript(CLAUDE_SCRAPE_SCRIPT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Script timeout (45s)')), 45000)),
    ]);
    try {
      const p = JSON.parse(raw);
      // Debug dump — overwritten each scrape so you always have the latest
      try { fs.writeFileSync(path.join(__dirname, 'claude-desktop-debug.txt'), `URL: ${p.url}\n\nTEXT:\n${p.text}\n\nAPI:\n${JSON.stringify(p.api || {}, null, 2)}`); } catch {}
      // Cookie consent dialog is blocking — show window so user can accept once
      if (p.text.includes('Accept All Cookies') && !p.text.match(/\d+%\s*(used|remaining)/)) {
        win.show(); win.focus();
        return { error: 'cookie-consent-required' };
      }
      win.hide();
      return { text: p.text, email: p.email, url: p.url };
    } catch { win.hide(); return { text: raw }; }
  } catch (e) {
    win.hide();
    return { error: e.message };
  }
}

async function fetchClaudeUsageForKey(key) {
  const win = getOrCreateClaudeWindow(key);

  // Don't interrupt if user has manually opened this window (e.g. for login)
  if (win.isVisible()) return { error: 'window-in-use' };

  win.hide();

  const currentUrl = win.webContents.getURL();
  const alreadyOnClaude = currentUrl.includes('claude.ai') && !CLAUDE_AUTH_RE.test(currentUrl);

  if (alreadyOnClaude) {
    // Fast path: SPA navigation (page already has active session, much faster than cold reload)
    if (win.webContents.isLoading()) {
      await Promise.race([
        new Promise(r => win.webContents.once('did-stop-loading', r)),
        new Promise(r => setTimeout(r, 10000)),
      ]);
    }
    await win.webContents.executeJavaScript(`window.location.href = '${CLAUDE_URL}'`).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    return await scrapeClaudePage(win);
  }

  // Cold path: load from scratch
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'Load timeout (20s)' }), 20000);

    win.webContents.once('did-finish-load', async () => {
      clearTimeout(timer);
      const url = win.webContents.getURL();
      if (!CLAUDE_AUTH_RE.test(url) && url.includes('claude.ai')) {
        resolve(await scrapeClaudePage(win));
        return;
      }
      win.hide();
      resolve({ error: 'session-expired' });
    });

    win.loadURL(CLAUDE_URL);
  });
}

// Fetch claude.ai usage via direct API calls using net.request() with session cookies.
// Much more reliable than BrowserWindow scraping since it avoids Cloudflare JS challenges.
async function fetchClaudeUsageViaApi(key) {
  const { net, session: electronSession } = require('electron');
  const ses = electronSession.fromPartition(CLAUDE_PARTITIONS[key]);

  const apiGet = (path) => new Promise((resolve) => {
    const req = net.request({ method: 'GET', url: 'https://claude.ai' + path, partition: CLAUDE_PARTITIONS[key], useSessionCookies: true });
    req.setHeader('Accept', 'application/json');
    req.setHeader('User-Agent', CHROME_UA);
    let body = '';
    req.on('response', (res) => {
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: null, raw: body.slice(0, 500) }); }
      });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.end();
  });

  // Get org ID from lastActiveOrg cookie
  const cookies = await ses.cookies.get({ domain: 'claude.ai' });
  const orgCookie = cookies.find(c => c.name === 'lastActiveOrg');
  const orgId = orgCookie?.value;

  // Probe candidate endpoints
  const [account, rateLimits, orgUsage] = await Promise.all([
    apiGet('/api/account'),
    apiGet('/api/rate_limit_status'),
    orgId ? apiGet(`/api/organizations/${orgId}/usage`) : Promise.resolve({ status: 0 }),
  ]);

  // Write debug dump
  try { fs.writeFileSync(path.join(__dirname, 'claude-api-debug.json'),
    JSON.stringify({ orgId, account, rateLimits, orgUsage }, null, 2)); } catch {}

  // /api/account returns the address as `email_address` (not `email`)
  const acctEmail = account.data?.email_address || account.data?.email || null;

  // Try org usage endpoint first
  if (orgUsage.status === 200 && orgUsage.data) {
    return { apiData: orgUsage.data, email: acctEmail, url: `api:org/${orgId}/usage` };
  }

  // Try rate limit status
  if (rateLimits.status === 200 && rateLimits.data) {
    return { apiData: rateLimits.data, email: acctEmail, url: 'api:rate_limit_status' };
  }

  return { error: `API org:${orgUsage.status} rl:${rateLimits.status}`, apiDebug: { account: account.status, orgId } };
}

ipcMain.handle('fetch-claude-web-usage', async () => {
  // Try the org usage API first — more reliable than scraping a page that can change
  const api = await fetchClaudeUsageViaApi('desktop');
  if (api.apiData) return api;
  // Fall back to browser scraping if API fails
  return fetchClaudeUsageForKey('desktop');
});
ipcMain.handle('fetch-claude-web-usage-2', async () => {
  const api = await fetchClaudeUsageViaApi('vscode');
  if (api.apiData) return api;
  return fetchClaudeUsageForKey('vscode');
});

ipcMain.handle('reset-claude-session', async (_, key) => {
  const win = claudeWebWindows[key];
  if (win && !win.isDestroyed()) { win.destroy(); claudeWebWindows[key] = null; }
  const { session: electronSession } = require('electron');
  const ses = electronSession.fromPartition(CLAUDE_PARTITIONS[key]);
  // Log off by removing the auth cookies. Do NOT call clearStorageData() — it
  // hangs indefinitely on this partition. Keep cf_clearance so future logins
  // still render. Each remove is time-boxed in case a session API stalls.
  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, ms))]);
  let removed = 0;
  try {
    const cookies = await ses.cookies.get({ domain: 'claude.ai' });
    for (const c of cookies) {
      if (/^(cf_clearance|__cf|cf_)/i.test(c.name)) continue;
      const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
      await withTimeout(ses.cookies.remove(url, c.name), 2000);
      removed++;
    }
  } catch {}
  return { ok: true, removed };
});

// Borrow claude.ai session cookies from Claude Desktop's Electron store.
// Claude Desktop keeps cookies at %APPDATA%\Claude\Network\Cookies (Chrome SQLite format).
// The AES-256-GCM key is in %APPDATA%\Claude\Local State, DPAPI-encrypted.
// Since we run as the same Windows user, we can decrypt both.
// Locate Claude Desktop's Chromium profile dir (the one with "Local State" and
// "Network/Cookies"). Tries the common locations plus any MSIX/Store package.
function findClaudeDataDir() {
  const home = os.homedir();
  const ROAMING = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const LOCAL = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const bases = [
    path.join(ROAMING, 'Claude'),
    path.join(LOCAL, 'Claude'),
    path.join(LOCAL, 'AnthropicClaude'),
    path.join(ROAMING, 'AnthropicClaude'),
    path.join(LOCAL, 'Programs', 'Claude'),
    path.join(LOCAL, 'Claude', 'User Data'),
    path.join(ROAMING, 'Claude', 'User Data'),
  ];
  // MSIX/Store install: %LOCALAPPDATA%\Packages\<id>\LocalCache\{Roaming,Local}\Claude
  try {
    const pkgRoot = path.join(LOCAL, 'Packages');
    for (const pkg of fs.readdirSync(pkgRoot)) {
      if (!/claude|anthropic/i.test(pkg)) continue;
      bases.push(path.join(pkgRoot, pkg, 'LocalCache', 'Roaming', 'Claude'));
      bases.push(path.join(pkgRoot, pkg, 'LocalCache', 'Local', 'Claude'));
      bases.push(path.join(pkgRoot, pkg, 'LocalState', 'Claude'));
      bases.push(path.join(pkgRoot, pkg, 'LocalState'));
    }
  } catch {}
  const checked = [];
  for (const b of bases) {
    let okLs = false, okCk = false;
    try { okLs = fs.existsSync(path.join(b, 'Local State')); } catch {}
    try { okCk = fs.existsSync(path.join(b, 'Network', 'Cookies')); } catch {}
    checked.push(`${b}[ls=${okLs},ck=${okCk}]`);
    if (okLs && okCk) return { dir: b, checked };
  }
  return { dir: null, checked };
}

async function borrowClaudeDesktopSession(targetKey = 'desktop') {
  const { execFileSync } = require('child_process');
  const { session: electronSession } = require('electron');
  const crypto = require('crypto');

  // Claude Desktop's data dir location varies (Roaming vs Local, plain vs MSIX
  // package). Auto-detect the dir that actually has both "Local State" and
  // "Network/Cookies" instead of assuming %APPDATA%\Claude.
  const found = findClaudeDataDir();
  if (!found.dir) {
    return { ok: false, reason: 'Claude Desktop data not found. Checked: ' + found.checked.join(' | ') };
  }
  const claudeData = found.dir;
  const localStatePath = path.join(claudeData, 'Local State');
  const cookiesPath = path.join(claudeData, 'Network', 'Cookies');

  // Step 1: DPAPI-decrypt the AES key via PowerShell
  const psScript = [
    'Add-Type -AssemblyName System.Security',
    `$ls = [System.IO.File]::ReadAllText('${localStatePath.replace(/'/g, "''")}') | ConvertFrom-Json`,
    '$encKey = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)',
    '$encKey = $encKey[5..($encKey.Length-1)]',
    '$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($encKey,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($dec)',
  ].join('; ');

  let aesKey;
  try {
    const b64 = execFileSync('powershell.exe', ['-NonInteractive', '-Command', psScript], { encoding: 'utf8', timeout: 10000 }).trim();
    aesKey = Buffer.from(b64, 'base64');
  } catch (e) {
    return { ok: false, reason: 'DPAPI decrypt failed: ' + e.message };
  }

  // Step 2: Copy cookies file to temp. The running Claude Desktop app holds the
  // SQLite file open, so fs.copyFileSync fails with EBUSY. Read it through a
  // .NET FileStream opened with FileShare.ReadWrite (Chromium opens the DB with
  // sharing, so this succeeds where copyFileSync can't), then fall back to a
  // plain copy if PowerShell is unavailable.
  const tmpCookies = path.join(os.tmpdir(), 'claude-borrow-cookies.db');
  try {
    const copyPs = [
      "$ErrorActionPreference='Stop'",
      `$s=[System.IO.File]::Open('${cookiesPath.replace(/'/g, "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite)`,
      `$d=[System.IO.File]::Create('${tmpCookies.replace(/'/g, "''")}')`,
      '$s.CopyTo($d); $d.Close(); $s.Close()',
    ].join('; ');
    execFileSync('powershell.exe', ['-NonInteractive', '-Command', copyPs], { timeout: 10000 });
    if (!fs.existsSync(tmpCookies) || fs.statSync(tmpCookies).size === 0) throw new Error('copy produced empty file');
  } catch (e) {
    try { fs.copyFileSync(cookiesPath, tmpCookies); } catch (e2) {
      const locked = /sharing|being used by another process|EBUSY|locked/i.test((e.message || '') + (e2.message || ''));
      if (locked) {
        return { ok: false, locked: true, reason: 'Claude Desktop is holding its session file locked. Fully quit the Claude Desktop app (system tray → right-click → Quit), then click Import again. You can reopen it afterwards.' };
      }
      return { ok: false, reason: 'Could not copy cookies: ' + (e.message || e2.message) };
    }
  }

  // Step 3: Read cookies with sql.js
  let rows;
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(tmpCookies));
    const result = db.exec(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
       FROM cookies WHERE host_key LIKE '%.claude.ai' OR host_key = 'claude.ai'`
    );
    rows = result[0] ? result[0].values : [];
    db.close();
  } catch (e) {
    return { ok: false, reason: 'SQLite read failed: ' + e.message };
  } finally {
    try { fs.unlinkSync(tmpCookies); } catch {}
  }

  if (!rows.length) return { ok: false, reason: 'No claude.ai cookies found in Claude Desktop' };

  // Step 4: Decrypt each cookie value (v10/v11 prefix = AES-256-GCM) and import.
  const targetSession = electronSession.fromPartition(CLAUDE_PARTITIONS[targetKey]);
  let imported = 0;
  for (const [host_key, name, value, encrypted_value, cookiePath, expires_utc, is_secure, is_httponly, samesite] of rows) {
    let cookieValue = value || '';
    if (!cookieValue && encrypted_value) {
      try {
        const encBuf = Buffer.isBuffer(encrypted_value) ? encrypted_value : Buffer.from(encrypted_value);
        const prefix = encBuf.slice(0, 3).toString('ascii');
        if (prefix !== 'v10' && prefix !== 'v11') continue;
        const nonce = encBuf.slice(3, 15);
        const tag = encBuf.slice(encBuf.length - 16);
        const ct  = encBuf.slice(15, encBuf.length - 16);
        const dec = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
        dec.setAuthTag(tag);
        let plain = Buffer.concat([dec.update(ct), dec.final()]);
        // Newer Chromium prepends a 32-byte SHA-256 of the host to the cookie
        // value (domain-bound cookies). If present, strip it — otherwise the
        // leading binary bytes make the value invalid and cookies.set fails.
        for (const h of [host_key, host_key.replace(/^\./, '')]) {
          const hh = crypto.createHash('sha256').update(h).digest();
          if (plain.length >= 32 && plain.slice(0, 32).equals(hh)) { plain = plain.slice(32); break; }
        }
        cookieValue = plain.toString('utf8');
      } catch { continue; }
    }
    // Chrome stores expiry as microseconds since 1601-01-01; convert to Unix seconds
    const expirationDate = expires_utc ? (expires_utc / 1e6 - 11644473600) : undefined;
    const sameSiteMap = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };
    const domain = host_key;
    const urlHost = host_key.startsWith('.') ? host_key.slice(1) : host_key;
    try {
      await targetSession.cookies.set({
        url: `https://${urlHost}`,
        name, value: cookieValue,
        domain, path: cookiePath || '/',
        secure: !!is_secure, httpOnly: !!is_httponly,
        expirationDate,
        sameSite: sameSiteMap[String(samesite)] || 'unspecified',
      });
      imported++;
    } catch {}
  }

  return { ok: true, imported, total: rows.length };
}

ipcMain.handle('borrow-claude-desktop-session', () => borrowClaudeDesktopSession('desktop'));

ipcMain.handle('show-claude-web-window', async () => {
  const { screen, session: electronSession } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const loginWin = new BrowserWindow({
    width: 1000, height: 740,
    x: Math.round((width - 1000) / 2),
    y: Math.round((height - 740) / 2),
    show: true,
    alwaysOnTop: true,
    title: 'Sign in to Claude',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      partition: CLAUDE_PARTITIONS['desktop'],
    },
  });
  loginWin.webContents.setUserAgent(CHROME_UA);
  const claudeSess = electronSession.fromPartition(CLAUDE_PARTITIONS['desktop']);

  // Log out (so a different account can sign in) by removing the auth cookies.
  // IMPORTANT: do NOT call clearStorageData — on this partition it hangs
  // indefinitely (blocking the page load → blank window) and corrupts the
  // service-worker state. Removing the cookies is sufficient; server auth is the
  // sessionKey cookie. Keep cf_clearance/__cf* so Cloudflare still trusts us.
  // Each cookies.remove is time-boxed since session APIs can hang here.
  const withTimeout = (p, ms) => Promise.race([
    Promise.resolve(p).catch(() => {}),
    new Promise(r => setTimeout(r, ms)),
  ]);
  try {
    const cookies = await claudeSess.cookies.get({ domain: 'claude.ai' });
    for (const c of cookies) {
      if (/^(cf_clearance|__cf|cf_)/i.test(c.name)) continue;
      const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
      await withTimeout(claudeSess.cookies.remove(url, c.name), 2000);
    }
  } catch {}
  let didSignIn = false;
  const initialKey = null; // session just cleared, so any sessionKey that appears is a fresh sign-in
  const cookiePoller = setInterval(async () => {
    if (loginWin.isDestroyed()) { clearInterval(cookiePoller); return; }
    const cookies = await claudeSess.cookies.get({ url: 'https://claude.ai', name: 'sessionKey' });
    const currentKey = cookies.length ? cookies[0].value : null;
    if (currentKey && currentKey !== initialKey && !didSignIn) {
      didSignIn = true;
      clearInterval(cookiePoller);
      loginWin.setTitle('Signed in — you can close this window');
      loginWin.loadURL('https://claude.ai/new');
    }
  }, 2000);
  loginWin.on('closed', () => clearInterval(cookiePoller));

  // Also intercept the Google OAuth popup to reload main window on callback
  loginWin.webContents.on('did-create-window', (popup) => {
    popup.webContents.setUserAgent(CHROME_UA);
    const onNav = (_, url) => {
      if (url.includes('claude.ai') && !url.includes('accounts.google.com') && !didSignIn) {
        setTimeout(() => {
          if (!popup.isDestroyed()) popup.destroy();
          // Cookie poller will detect sessionKey and navigate loginWin
        }, 1500);
      }
    };
    popup.webContents.on('did-navigate', onNav);
    popup.webContents.on('did-finish-load', () => onNav(null, popup.webContents.getURL()));
  });

  // If the login page fails to load (transient Cloudflare/network blip),
  // retry once rather than leaving a blank white window.
  let didRetry = false;
  loginWin.webContents.on('did-fail-load', (_e, code) => {
    if (code === -3 || didRetry || loginWin.isDestroyed()) return; // -3 = aborted by our own nav
    didRetry = true;
    setTimeout(() => { if (!loginWin.isDestroyed()) loginWin.loadURL('https://claude.ai/login'); }, 1500);
  });

  loginWin.loadURL('https://claude.ai/login');
  loginWin.focus();
});
ipcMain.handle('show-claude-web-window-2', () => {
  const win = getOrCreateClaudeWindow('vscode');
  win.show(); win.focus();
  win.loadURL(CLAUDE_URL);
});

// ── IPC: proxy HTTP fetch (for OpenAI API key users) ──────────────────────
ipcMain.handle('fetch-url', async (_event, url, options) => {
  const https = require('https');
  const http = require('http');
  const { URL } = require('url');

  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: options.method || 'GET',
          headers: options.headers || {},
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on('error', (e) => resolve({ error: e.message }));
      if (options.body) req.write(options.body);
      req.end();
    } catch (e) {
      resolve({ error: e.message });
    }
  });
});

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  const settings = loadSettings();

  mainWindow = new BrowserWindow({
    width: 360,
    height: 600,
    x: typeof settings.x === 'number' ? settings.x : undefined,
    y: typeof settings.y === 'number' ? settings.y : undefined,
    frame: false,
    resizable: true,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: false,
    icon: loadAppIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (settings.opacity != null) mainWindow.setOpacity(Math.max(0.2, Math.min(1, settings.opacity)));

  // Save position 500 ms after the user stops dragging
  let moveTimer;
  mainWindow.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [x, y] = mainWindow.getPosition();
      saveSettings({ x, y });
    }, 500);
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', () => {
    tray?.destroy();
  });
}

// ── Tray ───────────────────────────────────────────────────────────────────
function loadAppIcon(size) {
  const iconPath = path.join(__dirname, 'icon.png');
  try {
    if (fs.existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      return size ? img.resize({ width: size, height: size }) : img;
    }
  } catch {}
  // Fallback: small purple square
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVQ4T2' +
    'NkYGD4z0ABwKhhFAxdMGrAqAGjBgwdAwAABBYAAUKlLWsAAAAASUVORK5CYII='
  );
}

function createTray() {
  const icon = loadAppIcon(16);
  tray = new Tray(icon);
  tray.setToolTip('AI Usage Monitor');
  updateTrayMenu();

  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });
}

function updateTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow.show(); mainWindow.focus(); } },
    {
      label: `Always on Top: ${isAlwaysOnTop ? 'ON' : 'OFF'}`,
      click: () => {
        isAlwaysOnTop = !isAlwaysOnTop;
        mainWindow.setAlwaysOnTop(isAlwaysOnTop);
        mainWindow.webContents.send('always-on-top-changed', isAlwaysOnTop);
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { mainWindow.removeAllListeners('close'); app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => tray?.destroy());
