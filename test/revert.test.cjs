// Reverting a change must put the workspace back the way it was — for every
// kind of change, not just a plain edit. Writing `before` back was right
// only for edit_file: a created file was left behind empty, a rename wrote a
// file literally named "a -> b", and a multi_edit wrote an empty file named
// after its summary label ("2 file(s)").

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tools } = require('../src/tools.cjs');
const { restoreSnapshot, saveSnapshot, loadSnapshots } = require('../src/checkpoints.cjs');

function workspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-revert-'));
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  return dir;
}

// What the agent loop does: preview first (that's the snapshot), then run.
async function apply(name, args, dir) {
  const snap = tools[name].preview(args, dir);
  const result = await tools[name].run(args, dir, {});
  assert.match(result, /^OK/, result);
  return snap;
}

test('reverting a created file removes it', async () => {
  const dir = workspace();
  const snap = await apply('write_file', { path: 'new.js', content: 'x' }, dir);
  restoreSnapshot(dir, snap);
  assert.strictEqual(fs.existsSync(path.join(dir, 'new.js')), false);
});

test('reverting an overwrite restores the old contents', async () => {
  const dir = workspace({ 'a.js': 'old' });
  tools.read_file.run({ path: 'a.js' }, dir); // an existing file has to be read before it can be overwritten
  const snap = await apply('write_file', { path: 'a.js', content: 'new' }, dir);
  restoreSnapshot(dir, snap);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'old');
});

test('reverting a rename moves the file back', async () => {
  const dir = workspace({ 'a.js': 'body' });
  const snap = await apply('rename_file', { from: 'a.js', to: 'lib/b.js' }, dir);
  assert.deepStrictEqual(restoreSnapshot(dir, snap), ['a.js']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'body');
  assert.strictEqual(fs.existsSync(path.join(dir, 'lib/b.js')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'a.js -> lib/b.js')), false);
});

test('reverting a delete brings the file back', async () => {
  const dir = workspace({ 'gone.js': 'keep me' });
  const snap = await apply('delete_file', { path: 'gone.js' }, dir);
  restoreSnapshot(dir, snap);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'gone.js'), 'utf8'), 'keep me');
});

test('reverting a multi_edit restores every file it touched', async () => {
  const dir = workspace({ 'a.js': 'A=1\n', 'b.js': 'B=1\n' });
  const snap = await apply(
    'multi_edit',
    { edits: [{ path: 'a.js', old_str: 'A=1', new_str: 'A=2' }, { path: 'b.js', old_str: 'B=1', new_str: 'B=2' }] },
    dir
  );
  assert.deepStrictEqual(restoreSnapshot(dir, snap).sort(), ['a.js', 'b.js']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'A=1\n');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.js'), 'utf8'), 'B=1\n');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.js', 'b.js'], 'no stray "2 file(s)" file');
});

test('a reverted snapshot still works after a reload (persisted fields)', async () => {
  const dir = workspace();
  const snap = await apply('write_file', { path: 'made.js', content: 'x' }, dir);
  saveSnapshot(dir, 's1', 'call1', snap, 't1');
  const [loaded] = loadSnapshots(dir, 's1');
  restoreSnapshot(dir, loaded);
  assert.strictEqual(fs.existsSync(path.join(dir, 'made.js')), false);
});

test('multi_edit applies several edits to one file in order', async () => {
  // Each edit used to be applied to the original contents and written
  // separately, so only the last one survived.
  const dir = workspace({ 'c.js': 'one\ntwo\nthree\n' });
  await apply(
    'multi_edit',
    { edits: [{ path: 'c.js', old_str: 'one', new_str: '1' }, { path: 'c.js', old_str: 'three', new_str: '3' }] },
    dir
  );
  assert.strictEqual(fs.readFileSync(path.join(dir, 'c.js'), 'utf8'), '1\ntwo\n3\n');
});

test('rename_file refuses to overwrite an existing file', async () => {
  const dir = workspace({ 'a.js': 'a', 'b.js': 'b' });
  const res = await tools.rename_file.run({ from: 'a.js', to: 'b.js' }, dir, {});
  assert.match(res, /^ERROR/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.js'), 'utf8'), 'b');
});
