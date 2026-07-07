# Claude Code card: email from OAuth profile, not browser scrape — Design

**Date:** 2026-07-07
**Status:** Approved (design)
**Component:** AI Usage Monitor — `main.js` (`fetch-claude-code-email`, `fetch-claude-code-api-usage`), `renderer.js` (email cache).

## Problem

The Claude Code (`claude-vscode`) card stitches its identity from two unrelated
sources, so the displayed email can belong to a different account than the usage
numbers:

- **Usage % (5h/weekly)** — `fetch-claude-code-api-usage` reads the OAuth token
  from `~/.claude/.credentials.json` (the Claude Code CLI / VS Code extension
  login) and probes `api.anthropic.com`. [main.js ~512]
- **Email label** — `fetch-claude-code-email` opens a hidden window against the
  Electron browser partitions `persist:claude-web-vscode` / `persist:claude-web`
  and scrapes claude.ai for an email. [main.js ~606]

Observed: usage % belonged to `digital.accounts@phase-electrical.co.uk`
(Claude Max 20x) while the card showed `raketlauncherinterns@gmail.com` — a
stray claude.ai browser session unrelated to the OAuth credentials.

Verified during diagnosis: `GET https://api.anthropic.com/api/oauth/profile`
with the OAuth access token returns `200` and the correct account email
(`digital.accounts@phase-electrical.co.uk`). The token carries the
`user:profile` scope. The credentials file itself contains no email (only
tokens, `expiresAt`, `scopes`, `subscriptionType`, `rateLimitTier`, and a
top-level `organizationUuid`).

## Decision (from the user)

Source the email from the OAuth profile endpoint (same token as the usage
numbers). Keep the browser scrape as a **fallback** only, used when the OAuth
path cannot produce an email. Bust the stale renderer email cache silently
(no user action).

## Changes

### `main.js`

**1. Shared token helper (DRY).** Extract the credential-read + refresh logic
currently inline in the `fetch-claude-code-api-usage` handler into:

```js
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
```

The `fetch-claude-code-api-usage` handler is refactored to call
`getValidClaudeCodeToken()` for its token (it still reads `creds` separately for
the `account` label built from `rateLimitTier`/`subscriptionType`). Behavior of
the usage handler is unchanged — same token, same refresh, same persistence.

**2. Profile email fetch.**

```js
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

**3. Rewrite the `fetch-claude-code-email` handler** to try OAuth first, then
fall back to the existing browser scrape:

```js
ipcMain.handle('fetch-claude-code-email', async () => {
  // 1) OAuth profile — same token/account as the usage numbers
  const token = await getValidClaudeCodeToken();
  if (token) {
    const email = await fetchClaudeCodeProfileEmail(token);
    if (email) return email;
  }
  // 2) Fallback: scrape a claude.ai browser session (unchanged)
  const { session: electronSession } = require('electron');
  for (const partition of ['persist:claude-web-vscode', 'persist:claude-web']) {
    /* ...existing partition scrape body, verbatim... */
  }
  return '';
});
```

The existing partition-scrape loop (hidden BrowserWindow + `EMAIL_ONLY_SCRIPT`)
is preserved exactly; only the OAuth-first block is prepended. `EMAIL_ONLY_SCRIPT`
stays.

### `renderer.js`

Bump the email cache key `claude2-email` → `claude2-email-v2` at all three sites,
so the stale wrong email is discarded and a correct one is fetched on next run:

- read at [renderer.js ~852] (`localStorage.getItem`)
- write at [renderer.js ~858] (`localStorage.setItem`)
- read at [renderer.js ~984] (cached-render path)

No other renderer logic changes; the lazy-fetch flow is otherwise identical.

## Data flow (after)

`renderClaudeCodeApiData` → no `claude2-email-v2` cache → `fetchClaudeCodeEmail()`
→ `getValidClaudeCodeToken()` → `GET /api/oauth/profile` → email matching the
usage account → cached under `claude2-email-v2` → `applyAccountLabel('claude2', …)`.

## Error handling

- No credentials file → `getValidClaudeCodeToken()` returns `null` → straight to
  scrape (today's behavior for scrape-only setups).
- Profile fetch offline / non-200 / missing scope / unparseable → `''` → falls
  through to scrape.
- Token refresh failure → the un-refreshed token is used; a resulting 401 yields
  `''` → scrape.
- Scrape failure → `''` (unchanged); the card keeps its non-email `account` label.

## Testing

`main.js` is the Electron entrypoint (`app.whenReady`, `BrowserWindow`) and
cannot be `require`d under `node --test`, so there is no unit harness for it —
consistent with the repo, whose tests cover only the pure modules (`metrics.js`,
`usage-reader.js`, `analytics-renderer.js`). Verification:

- `node --check main.js` and `node --check renderer.js` — no syntax errors.
- `npm test` — full existing suite stays green (no logic module touched).
- Manual GUI (user): reload; the Claude Code card shows
  `digital.accounts@phase-electrical.co.uk`, not the gmail. The endpoint's
  correctness was already confirmed live during diagnosis (`200` + correct email).

## Out of scope

- The usage-number source (already correct — OAuth token) — unchanged.
- Codex / Claude Desktop email sourcing — unchanged.
- Removing the browser scrape entirely (user chose to keep it as a fallback).
- Any change to `EMAIL_ONLY_SCRIPT` or the partition list.
