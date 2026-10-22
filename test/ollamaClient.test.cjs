'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { chat, numCtxFor } = require('../src/ollamaClient.cjs');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const addr = /** @type {import('net').AddressInfo} */ (server.address());
      resolve({ server, host: `http://127.0.0.1:${addr.port}` });
    });
  });
}

let lastBody = null; // the most recent request body a stream server received

function streamOf(chunks) {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const c of chunks) res.write(JSON.stringify(c) + '\n');
      res.end();
    });
  };
}

test('num_ctx is sent so Ollama does not silently cut the prompt', async () => {
  const { server, host } = await serve(streamOf([{ message: { content: 'hi' }, done: true }]));
  try {
    await chat({ host, model: 'm', messages: [{ role: 'user', content: 'x' }], numCtx: 10240 });
    assert.strictEqual(lastBody.options.num_ctx, 10240);
  } finally {
    server.close();
  }
});

test('numCtxFor leaves room for the reply and never goes below 8192', () => {
  assert.strictEqual(numCtxFor(6000), 10240);
  assert.strictEqual(numCtxFor(1000), 8192);
  assert.strictEqual(numCtxFor(6000, 32768), 32768, 'an explicit setting wins');
  assert.strictEqual(numCtxFor(0), undefined);
});

test('thinking tokens are reported separately and never mixed into the reply', async () => {
  const { server, host } = await serve(
    streamOf([
      { message: { content: '', thinking: 'Let me ' } },
      { message: { content: '', thinking: 'think.' } },
      { message: { content: '51' } },
      { message: { content: '' }, done: true, prompt_eval_count: 12, eval_count: 3 },
    ])
  );
  try {
    let thought = '';
    /** @type {any} */
    let usage = null;
    const reply = await chat({
      host,
      model: 'm',
      messages: [],
      onThinking: (t) => (thought += t),
      onUsage: (u) => (usage = u),
    });
    assert.strictEqual(reply, '51');
    assert.strictEqual(thought, 'Let me think.');
    assert.strictEqual(usage.promptTokens, 12);
  } finally {
    server.close();
  }
});

test('a mid-stream error from Ollama is raised, not swallowed as an empty reply', async () => {
  const { server, host } = await serve(streamOf([{ error: 'model runner has unexpectedly stopped' }]));
  try {
    await assert.rejects(chat({ host, model: 'm', messages: [] }), /unexpectedly stopped/);
  } finally {
    server.close();
  }
});

test('failed requests leave no timer behind', async () => {
  // The idle watchdog used to stay armed after an HTTP error or a refused
  // connection, holding the process open for 90s and later aborting
  // nothing. node:test reports it as a hang; this checks it directly.
  const { server, host } = await serve((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  try {
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await assert.rejects(chat({ host, model: 'm', messages: [] }), /500/);
    await assert.rejects(chat({ host: 'http://127.0.0.1:1', model: 'm', messages: [] }), /Could not reach/);
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.ok(after <= before, `timers leaked: ${before} -> ${after}`);
  } finally {
    server.close();
  }
});
