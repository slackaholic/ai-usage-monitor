# Settings Window & Currency — Design

**Date:** 2026-06-26
**Status:** Approved (design), pending implementation plan
**Component:** AI Usage Monitor — main window, new Settings window, analytics window

## Goal

1. Move settings out of the main window's collapse/expand `#settings-panel` into a
   **dedicated Settings window** (the panel has outgrown an inline drawer).
2. Add **currency** support: show all money in a user-chosen symbol (default `£`)
   converted from Anthropic's USD rates via an editable USD→currency rate.
3. Move the **plan-price ("subscription value") inputs** out of the analytics
   cost section into the Settings window.

## Context (existing)

- Main window (`index.html` / `renderer.js`) has `#settings-panel`, a
  collapse/expand drawer toggled by the ⚙ `#btn-settings` button. It contains:
  - **Display:** opacity slider (`#opacity-slider`/`#opacity-value`),
    auto-refresh `<select>` (`#refresh-select`).
  - **Account label overrides:** `#override-codex`, `#override-claude`,
    `#override-claude2`.
  - **Login:** `#btn-show-claude-window`, `#btn-show-codex-window`,
    `#btn-borrow-claude-session-top`, `#btn-logoff-claude-top`, and a note.
  - A `#settings-save-btn`.
  - Title-bar toggles **theme** (`#btn-theme` ☀) and **compact** (`#btn-compact`
    ⊟) stay where they are — they are not part of this move.
- Settings persist via `getSettings` (invoke) / `saveSettings(patch)` (send,
  shallow top-level merge in `main.js`). Existing keys include `opacity`,
  `refreshInterval`, `accountOverrides`, `compact`, `theme`/light, `hiddenSections`,
  `lastKnown`, `planPrices`.
- Analytics window (`analytics-renderer.js`) renders the Cost section: Part A
  (API-equivalent $ from `summarizeCost`, USD) and Part B (`renderCostCompare`,
  with inline `$/mo` price inputs and `subscriptionValue`). `fmtMoney` currently
  hardcodes `$`.
- Analytics and (new) settings windows use `preload.js` (`window.electronAPI`).
- The Codex/Claude login windows and import/logoff are driven by existing IPCs
  already exposed in `preload.js` (`showCodexWindow`, `showClaudeWebWindow`,
  `borrowClaudeDesktopSession`, `resetClaudeSession`).

## New settings keys

- `currencySymbol` — string, default `'£'`.
- `usdRate` — number, USD→display multiplier, default `0.79`.
- `planPrices` — `{ [account]: number }` in **display currency** (already exists).

`metrics.js` is unchanged and stays currency-agnostic (API-equivalent cost is
USD; `subscriptionValue` takes a raw price number). All conversion and symbols
live in the renderers.

## Settings window

A new non-modal `BrowserWindow` (like the analytics window: `preload.js`,
`contextIsolation: true`), loading `settings.html` + `settings-renderer.js`.

- **Open:** new IPC `open-settings` (`ipcMain.on`), exposed as
  `electronAPI.openSettings()`. The main window's ⚙ `#btn-settings` calls it
  (replacing the panel toggle). Re-focus the window if already open (same guard
  as the analytics window).
- **Sections:** Display (opacity, auto-refresh), Currency (symbol, USD→currency
  rate), Subscriptions (plan price per account), Account label overrides, Login
  (the four action buttons + note). Values load from `getSettings` on open.
- **Persistence:** each control writes through `saveSettings` with its key.
  `planPrices` is sent as the **whole object** (shallow merge). No separate Save
  button is required — controls persist on `change` (matches the analytics
  price-input pattern); keep it simple and consistent.
- **Login actions** call the existing IPCs directly from the settings renderer.

## Currency model (display layer)

- `summarizeCost(...)` totals stay **USD**. The analytics renderer converts for
  display: `displayValue = usd × usdRate`, formatted as `symbol + value.toFixed(2)`.
- Plan prices are entered/stored in display currency and used **without**
  conversion, so `subscriptionValue`'s `attributedCost` / `perActiveHour` /
  `perWindow` are already display currency.
- Value ratio = `(usdTotal × usdRate) ÷ attributedCost` — both display currency.
- Two renderer formatters:
  - `fmtMoneyUsd(usd)` → `symbol + (usd × usdRate).toFixed(2)` (cost total,
    per-model rows, cache savings).
  - `fmtMoney(v)` → `symbol + v.toFixed(2)` (already-display-currency values:
    `$/active-hr`, `$/window`).
  Both read the current `currencySymbol`/`usdRate`, loaded from settings at
  render time (store them in module vars refreshed in `renderAll`).
- The analytics cost section **removes** its inline `$/mo` price inputs; it reads
  `planPrices` from settings (display only). Column headers switch from `$` to
  the symbol.

## Cross-window live updates

- After any `saveSettings`, `main.js` **broadcasts** `settings-changed` to all
  open windows (`BrowserWindow.getAllWindows().forEach(w => w.webContents.send(...))`).
- New preload binding `onSettingsChanged(cb)`.
- **Main window** listens and re-applies: opacity (continue using the existing
  live `setOpacity` path from the settings window for immediate feedback; the
  broadcast also re-reads as a fallback), account labels, and resets the
  auto-refresh timer to the new `refreshInterval`.
- **Analytics window** listens and calls its existing re-render
  (`renderAll`) so prices/currency take effect immediately.
- Opacity changes from the settings window call `setOpacity` (existing IPC) for
  instant visual feedback in addition to persisting.

## Removed from the main window

- The `#settings-panel` element and its CSS, the panel toggle handler, the
  `#settings-save-btn` handler, and the settings-panel contribution to
  `resizeToFit` height. The ⚙ button now opens the settings window. Login/override
  logic moves to the settings renderer.

## Testing

- No new pure logic → no new unit tests; the existing `metrics.js` suite must
  still pass (`npm test`, 19 tests) since `metrics.js` is untouched.
- `node --check` on all changed JS.
- Manual verification (run the app): ⚙ opens the Settings window; changing
  opacity/refresh/labels updates the main window live; entering plan prices +
  currency updates the analytics Cost section (now in `£`); the value ratio and
  per-model costs read in the chosen currency; closing/reopening persists.

## Out of scope

- Live/fetched FX rates (editable rate only).
- Multi-currency per account (one display currency app-wide).
- Retro-converting already-entered plan-price numbers when the symbol/rate
  changes (they're raw numbers; re-enter on currency switch).
- Moving theme/compact title-bar toggles into the window (they stay in the title
  bar).
- Any change to `metrics.js` cost math.
