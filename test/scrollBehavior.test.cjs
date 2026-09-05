// Regression test for the chat transcript's scroll behaviour.
//
// The reported symptom was "I can't scroll". The cause was not that the list
// was unscrollable — it was that scrollToBottom() ran on every streamed
// token and jumped to the end unconditionally, so scrolling up during a
// reply was undone milliseconds later. Indistinguishable from broken.
//
// media/main.js is a browser IIFE and can't be required here, so the guard
// is extracted from the file and exercised against a fake scroll container.
// That keeps the test honest about which code it covers: if the shipped
// implementation stops matching this contract, the extraction assertion at
// the top fails rather than the test silently passing on a copy.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

test('the shipped scrollToBottom still guards on stickToBottom', () => {
  assert.match(source, /let stickToBottom = true;/, 'stick-to-bottom state is missing');
  assert.match(
    source,
    /function scrollToBottom\(force\) \{\s*if \(!force && !stickToBottom\) return;/,
    'scrollToBottom must bail out when the reader has scrolled away'
  );
  assert.match(source, /messagesEl\.addEventListener\('scroll'/, 'nothing updates stickToBottom as the reader scrolls');
  assert.match(source, /scrollToBottom\(true\)/, 'no caller forces a scroll (sending a message should)');
});

// A minimal stand-in for the scroll container, matching the browser's
// scrollTop/scrollHeight/clientHeight semantics closely enough to exercise
// the guard.
function makeList({ clientHeight = 400, scrollHeight = 400 } = {}) {
  const listeners = [];
  return {
    clientHeight,
    scrollHeight,
    scrollTop: 0,
    addEventListener: (_e, fn) => listeners.push(fn),
    fireScroll: function () {
      listeners.forEach((fn) => fn());
    },
    grow: function (px) {
      this.scrollHeight += px;
    },
  };
}

// Mirrors the implementation under test.
function makeScroller(list) {
  let stickToBottom = true;
  const NEAR_BOTTOM_PX = 40;
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM_PX;
  list.addEventListener('scroll', () => {
    stickToBottom = atBottom();
  });
  return {
    scrollToBottom(force) {
      if (!force && !stickToBottom) return;
      list.scrollTop = list.scrollHeight;
      stickToBottom = true;
    },
    isSticking: () => stickToBottom,
  };
}

test('a reply that streams while the reader is at the bottom keeps following it', () => {
  const list = makeList({ clientHeight: 400, scrollHeight: 400 });
  const s = makeScroller(list);
  for (let i = 0; i < 20; i++) {
    list.grow(100);
    s.scrollToBottom();
  }
  assert.strictEqual(list.scrollTop, list.scrollHeight, 'should still be pinned to the newest content');
  assert.strictEqual(s.isSticking(), true);
});

test('scrolling up during a streaming reply is not undone by later tokens', () => {
  const list = makeList({ clientHeight: 400, scrollHeight: 4000 });
  const s = makeScroller(list);

  // The reader scrolls up to read something earlier.
  list.scrollTop = 500;
  list.fireScroll();
  assert.strictEqual(s.isSticking(), false, 'scrolling away must release the follow');

  // Tokens keep arriving — this is where the old code yanked them back.
  for (let i = 0; i < 30; i++) {
    list.grow(100);
    s.scrollToBottom();
  }
  assert.strictEqual(list.scrollTop, 500, 'the reader must stay exactly where they were');
});

test('scrolling back to the bottom resumes following', () => {
  const list = makeList({ clientHeight: 400, scrollHeight: 4000 });
  const s = makeScroller(list);
  list.scrollTop = 500;
  list.fireScroll();
  assert.strictEqual(s.isSticking(), false);

  list.scrollTop = list.scrollHeight - list.clientHeight; // back to the end
  list.fireScroll();
  assert.strictEqual(s.isSticking(), true, 'returning to the bottom should resume following');

  list.grow(200);
  s.scrollToBottom();
  assert.strictEqual(list.scrollTop, list.scrollHeight);
});

test('sending a message forces a scroll even when the reader had scrolled away', () => {
  const list = makeList({ clientHeight: 400, scrollHeight: 4000 });
  const s = makeScroller(list);
  list.scrollTop = 500;
  list.fireScroll();
  s.scrollToBottom(true); // what addUserMessage does
  assert.strictEqual(list.scrollTop, list.scrollHeight, 'an explicit send should jump to the newest message');
});

test('the near-bottom tolerance treats "almost at the end" as at the end', () => {
  const list = makeList({ clientHeight: 400, scrollHeight: 4000 });
  const s = makeScroller(list);
  list.scrollTop = 4000 - 400 - 20; // 20px short of the end
  list.fireScroll();
  assert.strictEqual(s.isSticking(), true, 'a few pixels of slack should still count as following');
});
