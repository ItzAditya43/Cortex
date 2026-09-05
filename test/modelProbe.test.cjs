// Regression tests for "could not measure" vs "measured badly".
//
// This class of bug has appeared four times in this project: a component
// that measures something treats an infrastructure failure as a quality
// result. The eval suite scored a stalled server as a quality regression;
// the probe rated a working model "Weak" off four timeouts, then reported
// "100/100" beside an Inconclusive verdict because a single probe survived.
//
// These pin the corrected behaviour, so the trap can't reopen quietly.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { probeModel, PROBES } = require('../src/modelProbe.cjs');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

test('a server that never answers produces no score and no recommendation', async () => {
  const { server, port } = await listen(() => {}); // accepts, never responds
  try {
    const r = await probeModel({ host: `http://localhost:${port}`, model: 'ghost', timeoutMs: 250 });
    assert.strictEqual(r.completed, 0, 'no probe should have completed');
    assert.strictEqual(r.score, null, 'a score must not be invented out of nothing');
    assert.strictEqual(r.trustworthy, false);
    assert.deepStrictEqual(r.recommended, {}, 'must not recommend config it cannot justify');
    assert.match(r.verdict, /Inconclusive/);
  } finally {
    server.close();
  }
});

test('too few completed probes suppress the score rather than extrapolating', async () => {
  // Only the native-tools probe answers (it uses fetch directly); every
  // chat-based probe times out. Previously this reported 100/100.
  const { server, port } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // Only the native-tools probe sends a `tools` field. Everything else
      // is left hanging so it times out and lands as inconclusive.
      if (!body.includes('"tools"')) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'read_file' } }] } }));
    });
  });
  try {
    const r = await probeModel({ host: `http://localhost:${port}`, model: 'partial', timeoutMs: 250 });
    assert.ok(r.completed < PROBES.length, 'test setup should leave probes inconclusive');
    if (r.completed < 3) {
      assert.strictEqual(r.score, null, `only ${r.completed} probe(s) ran — no score should be reported`);
      assert.strictEqual(r.trustworthy, false);
      assert.match(r.verdict, /Inconclusive/);
      assert.strictEqual(r.recommended.model, undefined);
      assert.strictEqual(r.recommended.fastModel, undefined);
    }
  } finally {
    server.close();
  }
});

test('a genuine protocol failure is still reported as a failure, not excused', async () => {
  // Responds promptly with prose instead of a tool call: that IS a real
  // result about the model, and must not be laundered into "inconclusive".
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(JSON.stringify({ message: { content: 'Sure, I can help with that!' }, done: true }) + '\n');
  });
  try {
    const r = await probeModel({ host: `http://localhost:${port}`, model: 'chatty', timeoutMs: 3000 });
    assert.strictEqual(r.results.protocol.ok, false, 'prose is not a tool call');
    assert.notStrictEqual(r.results.protocol.inconclusive, true, 'a prompt answer is conclusive');
    assert.strictEqual(r.completed, PROBES.length, 'every probe answered, so all are conclusive');
    assert.strictEqual(typeof r.score, 'number', 'a complete run must produce a score');
  } finally {
    server.close();
  }
});
