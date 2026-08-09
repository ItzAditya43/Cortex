'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTurn } = require('../src/agentLoop.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-plan-test-'));
}

// Stubs global.fetch so the agent loop can run without a real Ollama server.
// Each call returns the next scripted assistant message (non-streaming path).
function stubFetch(replies) {
  let i = 0;
  const original = global.fetch;
  global.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (async () => ({
      ok: true,
      body: null,
      json: async () => ({ message: { content: replies[i++] }, done: true }),
    }))
  );
  return () => {
    global.fetch = original;
  };
}

test('plan mode blocks write_file and reports it back to the model, not the filesystem', async () => {
  const root = tmpRoot();
  const restore = stubFetch([
    'TOOL_CALL: {"name": "write_file", "arguments": {"path": "a.txt", "content": "hello"}}',
    'Understood — here is my plan instead.',
  ]);
  try {
    const history = [{ role: 'user', content: 'create a.txt' }];
    const results = [];
    let finalText = null;
    await runTurn({
      history,
      root,
      host: 'http://fake',
      model: 'fake',
      temperature: 0.2,
      maxSteps: 5,
      memoryNotes: '',
      planMode: true,
      onToken: () => {},
      onToolCall: () => {},
      requestApproval: async () => true,
      onToolResult: (result, isError) => results.push({ result, isError }),
      onFinal: (text) => {
        finalText = text;
      },
      onError: (msg) => assert.fail(`unexpected error: ${msg}`),
    });

    assert.strictEqual(fs.existsSync(path.join(root, 'a.txt')), false, 'file must not be written in plan mode');
    assert.strictEqual(results.length, 1);
    assert.match(results[0].result, /Plan Mode/);
    assert.strictEqual(results[0].isError, true);
    assert.strictEqual(finalText, 'Understood — here is my plan instead.');
  } finally {
    restore();
  }
});

test('act mode (planMode: false) actually runs write_file', async () => {
  const root = tmpRoot();
  const restore = stubFetch([
    'TOOL_CALL: {"name": "write_file", "arguments": {"path": "a.txt", "content": "hello"}}',
    'Done.',
  ]);
  try {
    const history = [{ role: 'user', content: 'create a.txt' }];
    await runTurn({
      history,
      root,
      host: 'http://fake',
      model: 'fake',
      temperature: 0.2,
      maxSteps: 5,
      memoryNotes: '',
      planMode: false,
      onToken: () => {},
      onToolCall: () => {},
      requestApproval: async () => true,
      onToolResult: () => {},
      onFinal: () => {},
      onError: (msg) => assert.fail(`unexpected error: ${msg}`),
    });
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello');
  } finally {
    restore();
  }
});
