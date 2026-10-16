'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The toast used to be `position: fixed; bottom: 14px`, floating over the
// cards. The window is auto-sized to exactly fit its content, so there is no
// spare space to float over: the message landed on whichever reading sat at
// the bottom, and in compact view every tile is a reading. It is now a flow
// child of .content that reserves its own space.

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function toastRule() {
  const i = HTML.indexOf('.toast {');
  assert.ok(i >= 0, 'expected a .toast rule');
  return HTML.slice(i, HTML.indexOf('}', i));
}

test('the toast is not positioned over the content', () => {
  const rule = toastRule();
  assert.ok(!/position:\s*fixed/.test(rule), 'toast must not be a fixed overlay');
  assert.ok(!/position:\s*absolute/.test(rule), 'toast must not be absolutely positioned');
  assert.match(rule, /display:\s*none/, 'hidden by default so it reserves no space when silent');
});

test('the toast wraps rather than widening or clipping the panel', () => {
  // .content is overflow-x: hidden, so nowrap would clip a long message —
  // and these carry diagnostic detail ("[url] …", a fetch error).
  assert.ok(!/white-space:\s*nowrap/.test(toastRule()), 'nowrap would clip in the flow');
  assert.match(toastRule(), /white-space:\s*normal/);
});

// Index of the `</div>` that closes .content, by tracking nesting depth.
// Comment bodies are blanked with same-length filler so a `<div` written in
// prose cannot skew the depth while every index still lines up with HTML.
function contentCloseIndex() {
  const flat = HTML.replace(/<!--[\s\S]*?-->/g, c => ' '.repeat(c.length));
  const open = flat.indexOf('<div class="content">');
  assert.ok(open >= 0, 'expected a .content element');
  const re = /<div\b|<\/div\s*>/gi;
  re.lastIndex = open;
  let depth = 0;
  for (let m; (m = re.exec(flat)); ) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return assert.fail('.content is never closed');
}

test('the toast element sits inside .content, as its last child', () => {
  const open  = HTML.indexOf('<div class="content">');
  const close = contentCloseIndex();
  const toast = HTML.indexOf('id="toast"');
  // Being after the opening tag is NOT being inside the element — the toast
  // has to fall before .content's matching close, or it is a sibling again
  // and reserves no space in the panel.
  assert.ok(toast > open && toast < close, 'the toast must be inside .content');

  // And nothing renderable after it: a card added below would become the thing
  // the message covers, undoing the fix silently.
  const tail = HTML.slice(HTML.indexOf('</div>', toast) + '</div>'.length, close);
  assert.equal(tail.replace(/<!--[\s\S]*?-->/g, '').trim(), '',
    'the toast must be the last child of .content');
});

// ── Behaviour ──────────────────────────────────────────────────────────────

function loadShowToast() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const a = src.indexOf('// ── TOAST ──');
  const b = src.indexOf('// ── TOAST END ──');
  assert.ok(a >= 0 && b > a, 'expected TOAST source markers');

  const el = { textContent: '', style: { display: 'none' }, classes: new Set() };
  el.classList = { add: c => el.classes.add(c), remove: c => el.classes.delete(c) };
  const calls = { resize: 0, frames: [] };
  let seq = 1;
  const timers = new Map();
  const context = {
    document: { getElementById: id => (id === 'toast' ? el : null) },
    resizeToFit: () => { calls.resize++; },
    requestAnimationFrame: fn => calls.frames.push(fn),
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext(src.slice(a, b), context);
  const runTimer = ms => {
    for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); }
  };
  const flushFrames = () => { const f = calls.frames.splice(0); f.forEach(fn => fn()); };
  return { showToast: context.showToast, el, calls, timers, runTimer, flushFrames };
}

test('showing a toast makes room for it before fading it in', () => {
  const { showToast, el, calls, flushFrames } = loadShowToast();
  showToast('Could not find usage data');

  assert.equal(el.textContent, 'Could not find usage data');
  assert.equal(el.style.display, 'block', 'must be laid out before it can be measured');
  assert.equal(calls.resize, 1, 'the window has to grow or the message is clipped');
  assert.ok(!el.classes.has('show'), 'fades in on the NEXT frame, after the resize');
  flushFrames();
  assert.ok(el.classes.has('show'));
});

test('a dismissed toast gives its space back', () => {
  const { showToast, el, calls, runTimer, flushFrames } = loadShowToast();
  showToast('x');
  flushFrames();
  calls.resize = 0;

  runTimer(5000);                       // the display timer
  assert.ok(!el.classes.has('show'), 'fades out first');
  assert.equal(el.style.display, 'block', 'still occupies space during the fade');
  assert.equal(calls.resize, 0, 'resizing mid-fade would snap it away');

  runTimer(200);                        // the fade timer
  assert.equal(el.style.display, 'none');
  assert.equal(calls.resize, 1, 'the window shrinks back');
});

test('a second message is not cut short by the first one\'s timer', () => {
  // Several accounts retry on the same poll, so two toasts in a row is normal.
  const { showToast, el, timers, runTimer, flushFrames } = loadShowToast();
  showToast('first');
  flushFrames();
  showToast('second');
  flushFrames();

  assert.equal(el.textContent, 'second');
  assert.equal([...timers.values()].filter(t => t.ms === 5000).length, 1,
    'the first timer must be cleared, not left to fire against the second message');
  runTimer(5000);
  runTimer(200);
  assert.equal(el.style.display, 'none');
});
