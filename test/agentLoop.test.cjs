'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseToolCall } = require('../src/agentLoop.cjs');

test('parseToolCall: no marker present', () => {
  const r = parseToolCall('just a normal answer');
  assert.strictEqual(r.attempted, false);
});

test('parseToolCall: valid simple call', () => {
  const r = parseToolCall('TOOL_CALL: {"name": "list_dir", "arguments": {"path": "."}}');
  assert.strictEqual(r.attempted, true);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, { name: 'list_dir', arguments: { path: '.' } });
});

test('parseToolCall: repairs raw newlines inside string values', () => {
  const raw = 'TOOL_CALL: {"name": "write_file", "arguments": {"path": "a.txt", "content": "line1\nline2"}}';
  const r = parseToolCall(raw);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.arguments.content, 'line1\nline2');
});

test('parseToolCall: braces inside strings do not break depth counting', () => {
  const raw = 'TOOL_CALL: {"name": "search_code", "arguments": {"pattern": "function foo() { return 1; }"}}';
  const r = parseToolCall(raw);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.arguments.pattern, 'function foo() { return 1; }');
});

test('parseToolCall: unterminated JSON reports an error', () => {
  const r = parseToolCall('TOOL_CALL: {"name": "list_dir"');
  assert.strictEqual(r.attempted, true);
  assert.strictEqual(r.ok, false);
});

test('parseToolCall: an undoubled regex backslash is kept literally, not a parse failure', () => {
  // Models write code like s.replace(/\s+/g, '-') straight into a JSON
  // string. "\s" is not a JSON escape, so this used to fail to parse, and
  // the model resent the identical call until the step budget ran out.
  const text = String.raw`TOOL_CALL: {"name": "edit_file", "arguments": {"path": "u.js", "old_str": "x.replace(/\s+/g, '-')", "new_str": "line1\nline2 \"q\" \d"}}`;
  const r = parseToolCall(text);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.arguments.old_str, String.raw`x.replace(/\s+/g, '-')`);
  assert.strictEqual(r.data.arguments.new_str, 'line1\nline2 "q" \\d', 'valid escapes still decode');
});
