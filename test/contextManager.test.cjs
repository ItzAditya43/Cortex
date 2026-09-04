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
  // the most recent message must always survive
  assert.strictEqual(messages[messages.length - 1].content, history[2].content);
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
  assert.strictEqual(messages[1].content, history[0].content);
});

test('estimateTokens is a rough chars/4 heuristic', () => {
  assert.strictEqual(estimateTokens('abcd'), 1);
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens('a'.repeat(401)), 101);
});
