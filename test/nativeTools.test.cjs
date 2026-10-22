'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { toNativeMessages, synthesizeReply, extractJsonToolCalls } = require('../src/nativeTools.cjs');
const { runTurn, resolveToolMode } = require('../src/agentLoop.cjs');
const { apiToolsFor } = require('../src/tools.cjs');

test('canonical history converts to native tool messages', () => {
  const out = toNativeMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: 'Looking.\nTOOL_CALL: {"name": "read_file", "arguments": {"path": "a.js"}}' },
    { role: 'user', content: 'TOOL_RESULT:\n1\tconst a = 1;' },
    { role: 'assistant', content: 'Done.' },
  ]);
  assert.deepStrictEqual(out[2], {
    role: 'assistant',
    content: 'Looking.',
    tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.js' } } }],
  });
  assert.deepStrictEqual(out[3], { role: 'tool', tool_name: 'read_file', content: '1\tconst a = 1;' });
  assert.deepStrictEqual(out[4], { role: 'assistant', content: 'Done.' });
});

test('a parallel batch result is split into one tool message per call', () => {
  const out = toNativeMessages([
    {
      role: 'assistant',
      content: 'TOOL_CALL: {"name": "read_file", "arguments": {"path": "a"}}\nTOOL_CALL: {"name": "list_dir", "arguments": {}}',
    },
    { role: 'user', content: 'TOOL_RESULT:\n--- read_file({"path":"a"}) ---\nAAA\n\n--- list_dir({}) ---\nx.js' },
  ]);
  assert.deepStrictEqual(
    out.slice(1).map((m) => [m.role, m.tool_name, m.content]),
    [
      ['tool', 'read_file', 'AAA'],
      ['tool', 'list_dir', 'x.js'],
    ]
  );
});

test('protocol nudges that are not results stay user messages', () => {
  const out = toNativeMessages([
    { role: 'assistant', content: 'Here is the code: ...' },
    { role: 'user', content: 'TOOL_RESULT: You described a file change but did not call a tool' },
  ]);
  assert.strictEqual(out[1].role, 'user');
});

test('native calls turn back into canonical TOOL_CALL lines', () => {
  const text = synthesizeReply('Reading.', [{ function: { name: 'read_file', arguments: { path: 'a.js' } } }]);
  assert.strictEqual(text, 'Reading.\nTOOL_CALL: {"name":"read_file","arguments":{"path":"a.js"}}');
  assert.match(synthesizeReply('', [{ function: { name: 'x', arguments: '{"a":1}' } }]), /"arguments":\{"a":1\}/, 'string arguments are parsed');
});

test('a tool call written as JSON text is recovered; an explanation showing JSON is not', () => {
  const names = new Set(['edit_file']);
  const fenced = '```json\n{"name": "edit_file", "arguments": {"path": "a.js", "old_str": "1", "new_str": "2"}}\n```';
  assert.strictEqual(extractJsonToolCalls(fenced, names)[0].function.arguments.new_str, '2');
  assert.deepStrictEqual(extractJsonToolCalls('You could call {"name": "edit_file"} here.', names), []);
  assert.deepStrictEqual(extractJsonToolCalls('{"name": "rm_rf", "arguments": {}}', names), [], 'unknown tools are not invented');
  assert.deepStrictEqual(extractJsonToolCalls('{"version": "1.0.0"}', names), []);
});

test('every available built-in tool has a real parameter schema for native calling', () => {
  for (const t of apiToolsFor({ root: os.tmpdir(), ctx: {} })) {
    assert.strictEqual(t.function.parameters.type, 'object', t.function.name);
    assert.doesNotMatch(t.function.description, /Arguments:/, `${t.function.name} description still carries the text-protocol arguments`);
  }
});

/** @param {{capabilities: string[], replies: object[], size?: string|number}} opts */
function fakeOllama({ capabilities, replies, size }) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities, details: { parameter_size: size } }));
        return;
      }
      requests.push(JSON.parse(body));
      const message = replies[Math.min(n++, replies.length - 1)];
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: '', ...message } }) + '\n');
      res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, requests, host: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` }))
  );
}

async function turn(host, root, toolCalling = 'auto') {
  const history = [{ role: 'user', content: 'set PORT to 8080 in config.js' }];
  let final = null;
  await runTurn({
    history,
    root,
    host,
    model: 'fake-native',
    toolCalling,
    temperature: 0,
    maxSteps: 5,
    memoryNotes: '',
    onToken: () => {},
    onToolCall: () => {},
    requestApproval: async () => true,
    onToolResult: () => {},
    onFinal: (t) => (final = t),
    onError: (m) => assert.fail(m),
  });
  return { history, final };
}

test('a native turn: tools are sent, calls run, results go back as tool messages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-native-'));
  fs.writeFileSync(path.join(root, 'config.js'), 'const PORT = 3000;\n');
  const { server, requests, host } = await fakeOllama({
    capabilities: ['completion', 'tools'],
    replies: [
      { tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'config.js', old_str: '3000', new_str: '8080' } } }] },
      { content: 'Changed PORT to 8080.' },
    ],
  });
  try {
    const { history, final } = await turn(host, root);
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), 'const PORT = 8080;\n');
    assert.strictEqual(final, 'Changed PORT to 8080.');

    assert.ok(requests[0].tools.some((t) => t.function.name === 'edit_file'), 'tool schemas are sent');
    assert.doesNotMatch(requests[0].messages[0].content, /TOOL_CALL:/, 'the native prompt carries no text protocol');
    const second = requests[1].messages;
    assert.ok(second.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.function.name === 'edit_file'));
    assert.ok(second.some((m) => m.role === 'tool' && /OK: edited config\.js/.test(m.content)));

    // stored history stays canonical, so rewind/replay/compact keep working
    assert.match(history[1].content, /^TOOL_CALL: \{"name":"edit_file"/);
    assert.match(history[2].content, /^TOOL_RESULT:/);
  } finally {
    server.close();
  }
});

test('a model that writes the call as JSON text still gets it run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-native-'));
  fs.writeFileSync(path.join(root, 'config.js'), 'const PORT = 3000;\n');
  const { server, host } = await fakeOllama({
    capabilities: ['completion', 'tools'],
    replies: [
      { content: '```json\n{"name": "edit_file", "arguments": {"path": "config.js", "old_str": "3000", "new_str": "8080"}}\n```' },
      { content: 'Done.' },
    ],
  });
  try {
    await turn(host, root);
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), 'const PORT = 8080;\n');
  } finally {
    server.close();
  }
});

test('auto picks native only for models that support tools and are big enough to use them well', async () => {
  const withTools = await fakeOllama({ capabilities: ['completion', 'tools'], replies: [], size: 32682372656 });
  const without = await fakeOllama({ capabilities: ['completion'], replies: [], size: '9.0B' });
  const small = await fakeOllama({ capabilities: ['completion', 'tools'], replies: [], size: '3.1B' });
  try {
    assert.strictEqual(await resolveToolMode({ host: withTools.host, model: 'a' }), 'native');
    assert.strictEqual(await resolveToolMode({ host: without.host, model: 'b' }), 'text');
    assert.strictEqual(await resolveToolMode({ host: small.host, model: 'c' }), 'text', 'small models do better with the text protocol');
    assert.strictEqual(await resolveToolMode({ host: small.host, model: 'c', toolCalling: 'native' }), 'native', 'unless forced');
    assert.strictEqual(await resolveToolMode({ host: withTools.host, model: 'a', toolCalling: 'text' }), 'text');
    assert.strictEqual(await resolveToolMode({ host: withTools.host, model: 'a', provider: 'openai-compatible' }), 'text');
  } finally {
    withTools.server.close();
    without.server.close();
    small.server.close();
  }
});
