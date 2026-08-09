'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  touchSession,
  listSessions,
  deleteSession,
  saveHistory,
  loadHistory,
  loadMemoryNotes,
  setMemoryNotes,
} = require('../src/memory.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mem-test-'));
}

test('touchSession records a title from the first user message', () => {
  const root = tmpRoot();
  touchSession(root, 'abc', [{ role: 'user', content: 'add dark mode support please' }]);
  const sessions = listSessions(root);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].id, 'abc');
  assert.strictEqual(sessions[0].title, 'add dark mode support please');
});

test('listSessions sorts most-recently-updated first', async () => {
  const root = tmpRoot();
  touchSession(root, 'first', [{ role: 'user', content: 'first chat' }]);
  await new Promise((r) => setTimeout(r, 5));
  touchSession(root, 'second', [{ role: 'user', content: 'second chat' }]);
  const sessions = listSessions(root);
  assert.deepStrictEqual(sessions.map((s) => s.id), ['second', 'first']);
});

test('deleteSession removes both the history file and the index entry', () => {
  const root = tmpRoot();
  saveHistory(root, 'x', [{ role: 'user', content: 'hi' }]);
  touchSession(root, 'x', [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(listSessions(root).length, 1);
  deleteSession(root, 'x');
  assert.strictEqual(listSessions(root).length, 0);
  assert.deepStrictEqual(loadHistory(root, 'x'), []);
});

test('setMemoryNotes overwrites the whole file, visible via loadMemoryNotes', () => {
  const root = tmpRoot();
  setMemoryNotes(root, '- this repo uses pnpm\n- routes live in src/routes');
  assert.strictEqual(loadMemoryNotes(root), '- this repo uses pnpm\n- routes live in src/routes');
  setMemoryNotes(root, '');
  assert.strictEqual(loadMemoryNotes(root), '');
});
