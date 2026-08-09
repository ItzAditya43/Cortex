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
