// The "you printed a code block instead of editing" guard must not fire on
// ordinary answers.
//
// It originally triggered on ANY fenced code block. Asking "is there a
// security problem here? explain, don't change anything" produced a correct
// SQL-injection explanation with an illustrative snippet — the guard fired,
// discarded it, and the user's final answer became "I did not intend to
// change any files." The guard destroyed the answer it was meant to protect.
//
// Explaining, illustrating and reviewing all involve code fences. Only a
// reply that CLAIMS an edit is evidence of an edit that never happened.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { runTurn } = require('../src/agentLoop.cjs');

function serverReplying(replies) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const content = replies[Math.min(n, replies.length - 1)];
      n++;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { content }, done: true }) + '\n');
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: /** @type {import('net').AddressInfo} */ (server.address()).port, calls: () => n })));
}

async function run(port, prompt) {
  let final = null;
  let error = null;
  await runTurn({
    history: [{ role: 'user', content: prompt }],
    root: '/tmp',
    host: `http://localhost:${port}`,
    provider: 'ollama',
    model: 'test',
    temperature: 0,
    maxSteps: 6,
    memoryNotes: '',
    planMode: false,
    onToken: () => {},
    onToolCall: () => {},
    requestApproval: async () => true,
    onToolResult: () => {},
    onFinal: (t) => {
      final = t;
    },
    onError: (m) => {
      error = m;
    },
  });
  return { final, error };
}

test('an explanation containing a code block is returned untouched', async () => {
  const explanation =
    'This code is vulnerable to SQL injection:\n\n```js\ndb.query("SELECT * FROM users WHERE id = " + req.query.id)\n```\n\nThe query is built by string concatenation, so a crafted `id` can alter it. Use a parameterised query instead.';
  const { server, port, calls } = await serverReplying([explanation]);
  try {
    const { final } = await run(port, 'Is there a security problem here? Explain, do not change anything.');
    assert.strictEqual(final, explanation.trim(), 'the explanation must reach the user intact');
    assert.strictEqual(calls(), 1, 'no nudge round-trip should have happened');
  } finally {
    server.close();
  }
});

test('a reply that claims an edit but made none is still nudged', async () => {
  const claim = "I've updated the file:\n\n```js\nconst PORT = 8080;\n```";
  const followUp = 'TOOL_CALL: {"name": "read_file", "arguments": {"path": "x.js"}}';
  const { server, port, calls } = await serverReplying([claim, followUp, 'Done.']);
  try {
    await run(port, 'change the port to 8080');
    assert.ok(calls() > 1, 'a claimed-but-unperformed edit must get the nudge');
  } finally {
    server.close();
  }
});

test('when the nudge only produces a defensive non-answer, the original answer wins', async () => {
  // The exact failure seen in practice: a real answer, then the nudge turning
  // it into meta-commentary.
  const realAnswer = "Here's the updated approach:\n\n```js\nuse parameterised queries\n```\n\nThat prevents the injection.";
  const artifact = 'I was providing an explanation of the vulnerability as requested, and I did not intend to change any files.';
  const { server, port } = await serverReplying([realAnswer, artifact]);
  try {
    const { final } = await run(port, 'how should I fix this?');
    assert.strictEqual(final, realAnswer.trim(), 'the user must get the answer, not the apology');
  } finally {
    server.close();
  }
});

test('a plain answer with no code block is never nudged', async () => {
  const plain = 'The bug is that the port is hard-coded. Move it to an environment variable.';
  const { server, port, calls } = await serverReplying([plain]);
  try {
    const { final } = await run(port, 'what is wrong?');
    assert.strictEqual(final, plain);
    assert.strictEqual(calls(), 1);
  } finally {
    server.close();
  }
});
