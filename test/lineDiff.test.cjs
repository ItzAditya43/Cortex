'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildDiffView, diffLineArrays } = require('../src/lineDiff.cjs');

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

test('one inserted line is one added line, not the whole file rewritten', () => {
  // The old index-paired diff showed this as every line deleted and re-added.
  const before = lines(50);
  const after = `// header\n${before}`;
  const v = buildDiffView(before, after);
  assert.strictEqual(v.add, 1);
  assert.strictEqual(v.del, 0);
  assert.strictEqual(v.hunks.length, 1);
  assert.ok(v.hunks[0].lines.length <= 4, 'the change plus a little context, not 50 lines');
});

test('distant changes become separate hunks with context', () => {
  const before = lines(100);
  const after = before.replace('line 10\n', 'line ten\n').replace('line 90\n', 'line ninety\n');
  const v = buildDiffView(before, after, { context: 2 });
  assert.strictEqual(v.hunks.length, 2);
  assert.strictEqual(v.add, 2);
  assert.strictEqual(v.del, 2);
  assert.deepStrictEqual(
    v.hunks[0].lines.map((l) => l.t),
    [' ', ' ', '-', '+', ' ', ' ']
  );
  assert.strictEqual(v.hunks[1].newStart, 88);
});

test('a new file is all additions; identical content has no hunks', () => {
  assert.strictEqual(buildDiffView('', 'a\nb\n').add, 2);
  const same = buildDiffView('a\nb\n', 'a\nb\n');
  assert.strictEqual(same.hunks.length, 0);
  assert.strictEqual(same.add + same.del, 0);
});

test('CRLF and LF versions of the same lines compare equal', () => {
  assert.strictEqual(buildDiffView('a\r\nb\r\n', 'a\nb\n').hunks.length, 0);
});

test('very large diffs are capped rather than sent whole', () => {
  const v = buildDiffView('', lines(5000), { maxLines: 100 });
  assert.strictEqual(v.truncated, true);
  assert.strictEqual(v.hunks.reduce((n, h) => n + h.lines.length, 0), 100);
  assert.strictEqual(v.add, 5000, 'totals still count everything');
});

test('the alignment is a real LCS', () => {
  const ops = diffLineArrays(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e']);
  assert.deepStrictEqual(
    ops.map((o) => `${o.t}${o.s}`),
    [' a', '-b', ' c', ' d', '+e']
  );
});
