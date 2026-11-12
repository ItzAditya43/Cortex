// If the user presses Stop while an approval is open, the action must not
// run — even if the approval resolves as "yes" afterwards.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTurn } = require('../src/agentLoop.cjs');

test('an approval granted after Stop does not run the tool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-stop-'));
  const original = global.fetch;
  global.fetch = /** @type {any} */ (async () => ({
    ok: true,
    body: null,
    json: async () => ({ message: { content: 'TOOL_CALL: {"name": "write_file", "arguments": {"path": "a.txt", "content": "x"}}' } }),
  }));
  const controller = new AbortController();
  let finished = false;
  try {
    await runTurn({
      history: [{ role: 'user', content: 'make a.txt' }],
      root,
      toolCalling: 'text',
    contextBudgetTokens: 6000,
      host: 'http://fake',
      model: 'fake',
      temperature: 0,
      maxSteps: 3,
      memoryNotes: '',
      signal: controller.signal,
      onToken: () => {},
      onToolCall: () => {},
      requestApproval: async () => {
        controller.abort(); // the user hit Stop while this card was open...
        return true; // ...and the stale card still answered yes
      },
      onToolResult: () => {},
      onFinal: () => (finished = true),
      onError: () => (finished = true),
    });
  } finally {
    global.fetch = original;
  }
  assert.strictEqual(fs.existsSync(path.join(root, 'a.txt')), false, 'nothing may be written after Stop');
  assert.strictEqual(finished, false, 'a cancelled turn ends silently');
});
