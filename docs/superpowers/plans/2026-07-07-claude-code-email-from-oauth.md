# Claude Code Email From OAuth Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude Code card's email come from the OAuth profile endpoint (same token as its usage numbers), falling back to the existing browser scrape, so the label always matches the account whose usage is shown.

**Architecture:** In `main.js`, extract a shared `getValidClaudeCodeToken()` (credential read + refresh) used by both the usage handler and a new `fetchClaudeCodeProfileEmail(token)` that GETs `/api/oauth/profile`; rewrite the `fetch-claude-code-email` IPC handler to try OAuth first, then fall through to the unchanged browser-partition scrape. In `renderer.js`, bump the email localStorage cache key so the stale wrong email is discarded.

**Tech Stack:** Electron (main + renderer), Node `https`/`fs`. No new dependencies.

## Global Constraints

- No new dependencies; Node built-ins only (`https`, `fs`, `os`, `path`, `electron`).
- OAuth profile endpoint is `GET https://api.anthropic.com/api/oauth/profile` with headers `Authorization: Bearer <token>`, `anthropic-version: 2023-06-01`, `anthropic-client-name: claude-code`.
- Email is parsed from the response JSON via the `email` or `email_address` key.
- The existing browser-partition scrape (hidden `BrowserWindow` + `EMAIL_ONLY_SCRIPT`, partitions `persist:claude-web-vscode` then `persist:claude-web`) must be preserved verbatim as the fallback.
- The usage handler `fetch-claude-code-api-usage` must keep identical behavior (same token, same refresh, same credential persistence, same `account` label).
- Renderer email cache key changes from `claude2-email` to `claude2-email-v2` at all three sites.
- `main.js` is the Electron entrypoint and cannot be loaded under `node --test`; verification is `node --check` + the existing suite staying green + manual GUI check. Do NOT add a test that `require`s `main.js`.

---

### Task 1: Source the Claude Code email from the OAuth profile, with scrape fallback

**Files:**
- Modify: `main.js` — add `getValidClaudeCodeToken()` and `fetchClaudeCodeProfileEmail()`; refactor `fetch-claude-code-api-usage` to use the helper; rewrite the `fetch-claude-code-email` handler.
- Modify: `renderer.js` — bump the email cache key at three sites (~lines 852, 858, 984).

**Interfaces:**
- Consumes (existing, unchanged): `readCredentials()`, `refreshOAuthToken(refreshToken)`, `CREDENTIALS_PATH`, `EMAIL_ONLY_SCRIPT`, the `electron` `session` API.
- Produces:
  - `getValidClaudeCodeToken(): Promise<string|null>` — valid access token (refreshed + persisted if near expiry) or `null` if no credentials.
  - `fetchClaudeCodeProfileEmail(token: string): Promise<string>` — the account email, or `''` on any failure.

- [ ] **Step 1: Add the shared token helper**

In `main.js`, immediately after the `refreshOAuthToken` function (the block that ends around line 510, just before `ipcMain.handle('fetch-claude-code-api-usage', …)`), insert:

```js
// Returns a valid Claude Code OAuth access token (refreshing + persisting if
// within 5 min of expiry), or null when no credentials are present.
async function getValidClaudeCodeToken() {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth?.accessToken) return null;
  let token = creds.claudeAiOauth.accessToken;
  if (creds.claudeAiOauth.expiresAt < Date.now() + 300_000) {
    const refreshed = await refreshOAuthToken(creds.claudeAiOauth.refreshToken);
    if (refreshed?.access_token) {
      token = refreshed.access_token;
      const updated = { ...creds, claudeAiOauth: { ...creds.claudeAiOauth, accessToken: token, expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000 } };
      try { fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2)); } catch {}
    }
  }
  return token;
}

// Fetches the account email tied to the OAuth token (the same account whose
// usage the app reports). Returns '' on non-200, network error, or no email.
function fetchClaudeCodeProfileEmail(token) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/api/oauth/profile', method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-client-name': 'claude-code',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(''); return; }
        const m = data.match(/"(?:email|email_address)"\s*:\s*"([^"]+@[^"]+)"/i);
        resolve(m ? m[1] : '');
      });
    });
    req.on('error', () => resolve(''));
    req.setTimeout(10000, () => { req.destroy(); resolve(''); });
    req.end();
  });
}
```

- [ ] **Step 2: Refactor the usage handler to use the helper (behavior unchanged)**

In the `fetch-claude-code-api-usage` handler, the token read + refresh block currently reads (around lines 521–531):

```js
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
```

Replace that block with a single call (the handler keeps its earlier
`const creds = readCredentials();` and the `account` label built from
`creds.claudeAiOauth.rateLimitTier`/`subscriptionType`):

```js
  const token = await getValidClaudeCodeToken();
```

Leave everything else in the handler (the `creds` null-guard, the `account`
label, the probe to `/v1/messages`, the header parsing) exactly as-is.

- [ ] **Step 3: Rewrite the `fetch-claude-code-email` handler to try OAuth first**

The handler currently begins (around line 606):

```js
ipcMain.handle('fetch-claude-code-email', async () => {
  const { session: electronSession } = require('electron');

  // Try each partition that might have an active claude.ai session
  for (const partition of ['persist:claude-web-vscode', 'persist:claude-web']) {
```

Insert the OAuth-first block right after the `async () => {` line, before the
`const { session: electronSession } = require('electron');` line, leaving the
entire existing scrape loop (through its closing `return '';` and `});`)
untouched:

```js
ipcMain.handle('fetch-claude-code-email', async () => {
  // 1) OAuth profile — same token/account as the usage numbers.
  const token = await getValidClaudeCodeToken();
  if (token) {
    const email = await fetchClaudeCodeProfileEmail(token);
    if (email) return email;
  }

  // 2) Fallback: scrape a logged-in claude.ai browser session.
  const { session: electronSession } = require('electron');

  // Try each partition that might have an active claude.ai session
  for (const partition of ['persist:claude-web-vscode', 'persist:claude-web']) {
```

Do not modify the scrape body, `EMAIL_ONLY_SCRIPT`, or the partition list.

- [ ] **Step 4: Bump the renderer email cache key**

In `renderer.js`, change the three `claude2-email` sites to `claude2-email-v2`:

Around line 852 (read):
```js
  const cachedEmail = (() => { try { return JSON.parse(localStorage.getItem('claude2-email-v2') || 'null'); } catch { return null; } })();
```

Around line 858 (write):
```js
        localStorage.setItem('claude2-email-v2', JSON.stringify(email));
```

Around line 984 (cached-render read):
```js
    try { const e = JSON.parse(localStorage.getItem('claude2-email-v2') || 'null'); if (e) applyAccountLabel('claude2', e); } catch {}
```

Leave all surrounding logic unchanged.

- [ ] **Step 5: Syntax-check both files**

Run: `node --check main.js && node --check renderer.js`
Expected: no output (exit 0).

- [ ] **Step 6: Run the existing suite (must stay green)**

Run: `npm test`
Expected: all tests pass (61/61) — no logic module was touched, so the count and results are unchanged.

- [ ] **Step 7: Commit**

```bash
git add main.js renderer.js
git commit -m "fix(claude-code): source card email from OAuth profile, not browser scrape

The Claude Code card showed an email scraped from a stray claude.ai browser
session while its usage % came from the OAuth credentials — mismatched accounts.
Fetch the email from /api/oauth/profile with the same token (scrape kept as
fallback) and bump the renderer email cache key to discard the stale value."
```

- [ ] **Step 8: Note the manual verification for the controller/user**

`main.js` cannot be unit-tested (Electron entrypoint). After merge, the user
reloads the app and confirms the Claude Code card shows
`digital.accounts@phase-electrical.co.uk` (the OAuth account), not the previous
gmail. The endpoint was confirmed live during diagnosis (`200` + correct email).

---

## Self-Review

**1. Spec coverage:** Shared token helper (spec change 1) → Step 1. Profile email fetch (spec change 2) → Step 1. Usage handler refactor with unchanged behavior → Step 2. Email handler rewrite, OAuth-first + verbatim scrape fallback (spec change 3) → Step 3. Renderer cache-key bump at all three sites (spec change 4) → Step 4. Testing method (node --check + suite + manual) → Steps 5–6, 8. All spec sections covered. ✅

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code. The "leave existing as-is" instructions reference concrete anchor lines and are edits-in-place, not gaps. Exact commands and expected outputs given. ✅

**3. Type consistency:** `getValidClaudeCodeToken()` returns `Promise<string|null>`; both call sites (`fetch-claude-code-api-usage` Step 2, `fetch-claude-code-email` Step 3) handle `null` (the usage handler already guards `creds`; the email handler guards `if (token)`). `fetchClaudeCodeProfileEmail(token)` returns `Promise<string>` and is only called after a truthy `token` check. Cache key `claude2-email-v2` is identical across all three renderer sites. ✅
