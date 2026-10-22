'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildContextMessages, estimateTokens } = require('../src/contextManager.cjs');

test('buildContextMessages keeps everything when well under budget', () => {
  const history = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ];
  const messages = buildContextMessages('system prompt', history, 6000);
  assert.strictEqual(messages.length, 3); // system + 2
  assert.strictEqual(messages[0].role, 'system');
  assert.deepStrictEqual(messages.slice(1), history);
});

test('buildContextMessages drops oldest messages and inserts a notice when over budget', () => {
  const history = [
    { role: 'user', content: 'a'.repeat(4000) }, // ~1000 tokens
    { role: 'user', content: 'b'.repeat(4000) },
    { role: 'user', content: 'c'.repeat(4000) },
  ];
  // budget only fits system + ~1 of the big messages
  const messages = buildContextMessages('sys', history, 1100);
  assert.strictEqual(messages[0].role, 'system');
  // the first user message is the task itself and is anchored, never dropped —
  // truncation eats the replaceable middle instead of the goal
  assert.strictEqual(messages[1].content, history[0].content);
  assert.match(messages[2].content, /SYSTEM NOTE.*omitted/);
  // the most recent message must always survive — clipped to what is left of
  // the budget rather than sent oversized
  const last = messages[messages.length - 1].content;
  assert.ok(last.startsWith('ccc') && last.endsWith('ccc'), 'most recent message survives');
  assert.ok(estimateTokens(last) < 1000, 'and is clipped to fit, not sent whole');
});

test('buildContextMessages anchors the original task even when tool noise fills the budget', () => {
  const history = [{ role: 'user', content: 'ORIGINAL TASK: add JWT auth' }];
  for (let i = 0; i < 40; i++) history.push({ role: 'user', content: `TOOL_RESULT: ${'x'.repeat(400)}` });
  const messages = buildContextMessages('sys', history, 2000);
  assert.ok(
    messages.some((m) => m.content.includes('ORIGINAL TASK')),
    'the original request must survive truncation — otherwise the agent forgets what it was asked to do'
  );
});

test('buildContextMessages always keeps at least the most recent message even if it alone exceeds budget', () => {
  const history = [{ role: 'user', content: 'x'.repeat(100000) }];
  const messages = buildContextMessages('sys', history, 10);
  assert.strictEqual(messages.length, 2);
  assert.ok(messages[1].content.startsWith('xxxx'), 'the message is kept, not dropped');
});

test('an oversized tool result is clipped to the budget instead of sent whole', () => {
  // Sent unclipped, the server truncates the prompt itself — from the front,
  // which takes the system prompt and the task with it.
  const history = [
    { role: 'user', content: 'TASK: fix the bug' },
    { role: 'assistant', content: 'TOOL_CALL: {"name":"read_file","arguments":{"path":"big.js"}}' },
    { role: 'user', content: `TOOL_RESULT:\nHEAD${'y'.repeat(200000)}TAIL` },
  ];
  const messages = buildContextMessages('sys', history, 6000);
  const total = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  assert.ok(total <= 6200, `prompt must fit the budget, got ~${total} tokens`);
  const last = messages[messages.length - 1].content;
  assert.ok(last.startsWith('TOOL_RESULT:\nHEAD') && last.endsWith('TAIL'), 'head and tail survive');
  assert.match(last, /characters omitted/);
  assert.ok(messages.some((m) => m.content === 'TASK: fix the bug'), 'the task is still there');
});

test('estimateTokens is a rough chars/4 heuristic', () => {
  assert.strictEqual(estimateTokens('abcd'), 1);
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens('a'.repeat(401)), 101);
});
