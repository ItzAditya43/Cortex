'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tools, safePath } = require('../src/tools.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oca-test-'));
}

test('safePath rejects paths that escape the workspace root', () => {
  const root = tmpRoot();
  assert.throws(() => safePath(root, '../../etc/passwd'));
});

test('write_file then read_file round-trips content', () => {
  const root = tmpRoot();
  tools.write_file.run({ path: 'a/b.txt', content: 'hello\nworld' }, root);
  const out = tools.read_file.run({ path: 'a/b.txt' }, root);
  assert.match(out, /1\thello/);
  assert.match(out, /2\tworld/);
});

test('edit_file replaces a unique snippet', () => {
  const root = tmpRoot();
  tools.write_file.run({ path: 'f.js', content: 'const x = 1;\n' }, root);
  const res = tools.edit_file.run({ path: 'f.js', old_str: 'x = 1', new_str: 'x = 2' }, root);
  assert.match(res, /^OK/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'f.js'), 'utf8'), 'const x = 2;\n');
});

test('edit_file errors on ambiguous match', () => {
  const root = tmpRoot();
  tools.write_file.run({ path: 'f.js', content: 'a\na\n' }, root);
  const res = tools.edit_file.run({ path: 'f.js', old_str: 'a', new_str: 'b' }, root);
  assert.match(res, /ERROR/);
});

test('list_dir hides internal .cortex folder', () => {
  const root = tmpRoot();
  tools.remember.run({ note: 'x' }, root);
  fs.writeFileSync(path.join(root, 'visible.txt'), '');
  const out = tools.list_dir.run({ path: '.' }, root);
  assert.doesNotMatch(out, /\.cortex/);
  assert.match(out, /visible\.txt/);
});
