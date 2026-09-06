// The edit sweep must always be honest and always terminate.
//
// Two properties matter more than the pacing itself. The final frame has to
// be exactly the proposed content — an animation that settles on an
// approximation shows the user something other than what gets written. And
// the budgets have to hold on adversarial input, because a file of many
// small alternating hunks can otherwise schedule minutes of animation and
// retain a full copy of the document per frame.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEditAnimation, changedLineFlags, MAX_FRAMES, MAX_DURATION_MS } = require('../src/editAnimation.cjs');

const linesOf = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

test('the last frame is exactly the proposed content', () => {
  const before = linesOf(40);
  const after = before.split('\n').map((l, i) => (i === 20 ? 'CHANGED' : l)).join('\n');
  const { frames } = buildEditAnimation(before, after);
  assert.strictEqual(frames.at(-1).content, after, 'the sweep must land on what will actually be written');
});

test('unchanged spans zip and changed runs slow down', () => {
  const before = linesOf(60);
  const after = before.split('\n').map((l, i) => (i === 40 ? 'CHANGED' : l)).join('\n');
  const { frames } = buildEditAnimation(before, after);
  const zip = frames.filter((f) => f.zip);
  const typed = frames.filter((f) => !f.zip);
  assert.ok(zip.length > 0, 'untouched lines should be zipped through');
  assert.ok(typed.length > 0, 'the changed line should get its own slower frame');
  assert.ok(
    Math.max(...typed.map((f) => f.delayMs)) > Math.max(...zip.map((f) => f.delayMs)),
    'changed lines must dwell longer than unchanged ones — that is the whole point'
  );
});

test('identical content produces no animation', () => {
  const { frames } = buildEditAnimation('same\ncontent', 'same\ncontent');
  assert.strictEqual(frames.length, 1);
});

test('a new file animates from empty', () => {
  const after = 'a\nb\nc';
  const { frames } = buildEditAnimation('', after);
  assert.strictEqual(frames.at(-1).content, after);
});

test('budgets hold on a pathological many-hunk diff', () => {
  const before = linesOf(4000, (i) => `x${i}`);
  const after = linesOf(4000, (i) => (i % 2 ? `y${i}` : `x${i}`)); // every other line differs
  const started = Date.now();
  const { frames, totalMs } = buildEditAnimation(before, after);
  assert.ok(Date.now() - started < 3000, 'building the animation must not itself be slow');
  assert.ok(frames.length <= MAX_FRAMES, `frame budget exceeded (${frames.length})`);
  assert.ok(totalMs <= MAX_DURATION_MS, `duration budget exceeded (${totalMs}ms)`);
  assert.strictEqual(frames.at(-1).content, after, 'even when truncated, it must end on the real content');
});

test('changed-line detection tracks insertions rather than shifting everything', () => {
  // Inserting one line must not mark every following line as changed; if it
  // did, a one-line insert would animate as a full-file rewrite.
  const before = ['a', 'b', 'c', 'd'];
  const after = ['a', 'b', 'NEW', 'c', 'd'];
  const flags = changedLineFlags(before, after);
  assert.deepStrictEqual(flags, [false, false, true, false, false]);
});

test('activeLine stays inside the document', () => {
  const before = linesOf(30);
  const after = linesOf(10); // a large deletion
  const { frames } = buildEditAnimation(before, after);
  for (const f of frames) {
    assert.ok(f.activeLine >= 0, 'activeLine must never be negative');
    assert.ok(
      f.activeLine <= Math.max(before.split('\n').length, after.split('\n').length),
      'activeLine must stay within the document being shown'
    );
  }
});
