# Compact View Null-Meter Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the compact view, keep a mini-stat card in place showing "—" when its meter reads null, instead of removing the card and reflowing the grid.

**Architecture:** `renderStat` currently hides a compact card when its percentage is null. Change the single gating call so the card is always present once an account renders; the value element already shows "—" for null, and section-level hiding is unaffected.

**Tech Stack:** Electron renderer (`renderer.js`), vanilla JS. No new dependencies.

## Global Constraints

- No new dependencies.
- Only `renderStat`'s final line changes; `showCompactStat`, `applyCompactStat`, `setPct`, and full-view rendering stay untouched.
- Section-level hiding (`hiddenSections`) must remain functional — it is gated separately in `applyCompactStat` and must not be affected.
- `renderer.js` cannot be loaded/vm-sliced under `node --test` (top-level DOM `addEventListener` side effects). Do NOT add a test that loads `renderer.js`. Verification is `node --check renderer.js` + the existing suite staying green + manual GUI.

---

### Task 1: Keep the compact card visible for null meters

**Files:**
- Modify: `renderer.js` — `renderStat` (around line 567–572), the `showCompactStat` call.

**Interfaces:**
- Consumes (existing, unchanged): `setPct(id, pct)` (renders `—` for null), `setBar(id, pct)` (no-op for null), `showCompactStat(id, visible)`, `applyCompactStat` (gates on `hiddenSections`).
- Produces: no new symbols; a behavior change to `renderStat` only.

- [ ] **Step 1: Read the current `renderStat` to anchor the edit**

Open `renderer.js` and locate `renderStat`. It reads:

```js
function renderStat(prefix, win, pct) {
  setPct(`${prefix}-${win}-pct`, pct);
  setBar(`${prefix}-${win}-bar`, pct);
  setPct(`c-${prefix}-${win}`, pct);
  showCompactStat(`${prefix}-${win}`, pct != null);
}
```

- [ ] **Step 2: Change the compact gate to always-present**

Replace the last line of `renderStat`:

```js
  showCompactStat(`${prefix}-${win}`, pct != null);
```

with:

```js
  // Keep the compact card in place; its value element already shows "—" for a
  // null meter (setPct). A fully-absent/errored account never reaches renderStat
  // (both-null / error early-returns in the fetchers), so no phantom cards.
  showCompactStat(`${prefix}-${win}`, true);
```

Change nothing else in the function or file.

- [ ] **Step 3: Syntax-check**

Run: `node --check renderer.js`
Expected: no output (exit 0).

- [ ] **Step 4: Run the existing suite (must stay green)**

Run: `npm test`
Expected: all tests pass (61/61) — no logic module was touched, so the count and results are unchanged.

- [ ] **Step 5: Commit**

```bash
git add renderer.js
git commit -m "fix(compact): keep mini-stat card with em-dash when a meter is null

A momentarily-null meter (e.g. Codex weekly right after a 5h reset) made its
compact card disappear and the grid reflow. renderStat now always keeps the
card slot; setPct already renders the value as an em-dash. Fully-absent/errored
accounts never reach renderStat, so no phantom cards, and section-hiding is
unaffected (gated separately in applyCompactStat)."
```

- [ ] **Step 6: Note the manual verification for the controller/user**

`renderer.js` cannot be unit-tested (top-level DOM side effects). After merge,
the user confirms in compact view: a momentarily-null meter shows a card with
"—" instead of vanishing; the value fills in when it returns; hiding an
account's section still removes both its compact cards.

---

## Self-Review

**1. Spec coverage:** The single spec change — `renderStat` compact gate from `pct != null` to `true` — is Step 2. The spec's safety facts (setPct shows "—", fetchers early-return before renderStat, applyCompactStat gates on hiddenSections) are preserved by touching only the one line. Testing method (node --check + suite + manual) → Steps 3–4, 6. Full coverage. ✅

**2. Placeholder scan:** No TBD/TODO. The one code step shows complete before/after code. Exact commands and expected outputs given. ✅

**3. Type consistency:** `showCompactStat(id, visible)` is called with a boolean literal `true` (matching its signature); no other call sites exist, so no cross-site drift. `renderStat`'s signature and its other calls are unchanged. ✅
