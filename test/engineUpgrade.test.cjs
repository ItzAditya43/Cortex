'use strict';

// Covers the 0.2 engine work: windowed reads, replace_all, glob, ripgrep
// search options, several tool calls per response, summarizing compaction,
// model-sized context budgets, OpenAI-compatible function calling, custom
// slash commands and the CLI's argument and permission helpers.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { tools, globToRegExp } = require('../src/tools.cjs');
const { runTurn, callHeader } = require('../src/agentLoop.cjs');
const { compactHistory, SUMMARY_PREFIX } = require('../src/compactor.cjs');
const { resolveContextBudget } = require('../src/contextManager.cjs');
const { toOpenAiMessages, chat: openaiChat } = require('../src/openaiClient.cjs');
const { toNativeMessages } = require('../src/nativeTools.cjs');
const { listCustomCommands, expandCustomCommand } = require('../src/slashCommands.cjs');
const { parseArgs, commandPrefix, chainsCommands } = require('../src/cli.cjs');

function tmpRoot(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-upgrade-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** A fake Ollama: /api/show reports `show`, /api/chat answers with `replies` in order. */
function fakeOllama({ replies = [], show = {} } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(show));
        return;
      }
      const parsed = JSON.parse(body || '{}');
      requests.push(parsed);
      const reply = replies[Math.min(n, replies.length - 1)];
      n++;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ message: typeof reply === 'string' ? { content: reply } : reply, done: true, prompt_eval_count: 10, eval_count: 5 })}\n`);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, requests, host: `http://localhost:${/** @type {import('net').AddressInfo} */ (server.address()).port}` }))
  );
}

function turn(host, root, extra = {}) {
  const events = { calls: [], results: [], final: null, error: null };
  return runTurn({
    history: [{ role: 'user', content: 'go' }],
    root,
    host,
    provider: 'ollama',
    model: 'test',
    temperature: 0,
    maxSteps: 6,
    toolCalling: 'text',
    contextBudgetTokens: 6000,
    memoryNotes: '',
    planMode: false,
    onToken: () => {},
    onToolCall: (name, args) => events.calls.push({ name, args }),
    requestApproval: async () => true,
    onToolResult: (result, isError) => events.results.push({ result, isError }),
    onFinal: (t) => {
      events.final = t;
    },
    onError: (m) => {
      events.error = m;
    },
    ...extra,
  }).then(() => events);
}

// ---------------------------------------------------------------- tools

test('read_file returns a numbered window and says how to get the rest', () => {
  const root = tmpRoot({ 'big.txt': Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n' });
  const out = tools.read_file.run({ path: 'big.txt', offset: 10, limit: 3 }, root);
  assert.strictEqual(out.split('\n').slice(0, 3).join('\n'), '10\tline 10\n11\tline 11\n12\tline 12');
  assert.match(out, /showing lines 10-12 of 50 — call read_file with "offset": 13/);
  assert.doesNotMatch(tools.read_file.run({ path: 'big.txt' }, root), /showing lines/, 'a whole file carries no window note');
  assert.match(tools.read_file.run({ path: 'big.txt', offset: 99 }, root), /^ERROR: offset 99 is past the end/);
});

test('edit_file replace_all changes every occurrence; without it an ambiguous snippet is refused', () => {
  const root = tmpRoot({ 'a.js': 'let n = 1;\nn = n + 1;\nconsole.log(n);\n' });
  const ambiguous = tools.edit_file.run({ path: 'a.js', old_str: 'n', new_str: 'count' }, root);
  assert.match(ambiguous, /^ERROR: old_str matches \d+ places/);
  assert.match(ambiguous, /It occurs at lines 1, 2, 3 of a\.js/, 'the error shows where, so the model can single one out');
  assert.doesNotMatch(ambiguous, /replace_all/, 'and does not nudge towards rewriting every occurrence');
  fs.writeFileSync(path.join(root, 'b.js'), 'foo(); foo(); bar();\n');
  assert.match(tools.edit_file.run({ path: 'b.js', old_str: 'foo', new_str: 'baz', replace_all: true }, root), /replaced 2 occurrences/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'b.js'), 'utf8'), 'baz(); baz(); bar();\n');
  assert.strictEqual(tools.edit_file.preview({ path: 'b.js', old_str: 'baz', new_str: 'q', replace_all: true }, root).after, 'q(); q(); bar();\n');
});

test('glob finds files by pattern, anywhere for a bare name', async () => {
  const root = tmpRoot({ 'src/a.test.js': '', 'src/deep/b.test.js': '', 'src/c.js': '', 'README.md': '', 'node_modules/x/y.test.js': '' });
  const tests = (await tools.glob.run({ pattern: '**/*.test.js' }, root)).split('\n').sort();
  assert.deepStrictEqual(tests, ['src/a.test.js', 'src/deep/b.test.js']);
  assert.strictEqual(await tools.glob.run({ pattern: '*.md' }, root), 'README.md');
  assert.strictEqual(await tools.glob.run({ pattern: '*.js', path: 'src/deep' }, root), 'src/deep/b.test.js');
  assert.match(await tools.glob.run({ pattern: '*.rs' }, root), /no files match/);
});

test('globToRegExp: ** crosses directories, * does not', () => {
  assert.ok(globToRegExp('**/*.{js,ts}').test('a/b/c.ts'));
  assert.ok(globToRegExp('**/*.js').test('c.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('src/?.js').test('src/a.js'));
});

test('search_code narrows by glob, ignores case and shows context', async () => {
  const root = tmpRoot({ 'a.js': 'const x = 1;\nfunction Hello() {}\nconst y = 2;\n', 'b.py': 'def hello():\n    pass\n' });
  const onlyJs = await tools.search_code.run({ pattern: 'hello', glob: '*.js', ignore_case: true }, root);
  assert.match(onlyJs, /a\.js:2:function Hello/);
  assert.doesNotMatch(onlyJs, /b\.py/);
  assert.match(await tools.search_code.run({ pattern: 'hello' }, root), /b\.py:1:def hello/);
  const ctx = await tools.search_code.run({ pattern: 'function Hello', context: 1 }, root);
  assert.match(ctx, /const x = 1/);
  assert.match(ctx, /const y = 2/);
  assert.match(await tools.search_code.run({ pattern: 'nothing-here-xyz' }, root), /no matches/);
});

// ----------------------------------------------------------- agent loop

test('several changing calls in one response all run, in order', async () => {
  const root = tmpRoot();
  const { server, host, requests } = await fakeOllama({
    replies: [
      'TOOL_CALL: {"name": "write_file", "arguments": {"path": "a.txt", "content": "A"}}\nTOOL_CALL: {"name": "write_file", "arguments": {"path": "b.txt", "content": "B"}}',
      'Both written.',
    ],
  });
  try {
    const ev = await turn(host, root);
    assert.strictEqual(ev.error, null);
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'A');
    assert.strictEqual(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'B');
    assert.strictEqual(ev.calls.length, 2);
    assert.strictEqual(requests.length, 2, 'two writes cost one round-trip, not two');
    const fedBack = requests[1].messages[requests[1].messages.length - 1].content;
    assert.match(fedBack, /--- write_file\(.*a\.txt.*\) ---\nOK: wrote 1 chars to a\.txt/);
    assert.match(fedBack, /--- write_file\(.*b\.txt.*\) ---\nOK: wrote 1 chars to b\.txt/);
    assert.strictEqual(ev.final, 'Both written.');
  } finally {
    server.close();
  }
});

test('a failed call stops the calls after it, and says so', async () => {
  const root = tmpRoot({ 'a.txt': 'hello\n' });
  const { server, host, requests } = await fakeOllama({
    replies: [
      'TOOL_CALL: {"name": "edit_file", "arguments": {"path": "a.txt", "old_str": "not there", "new_str": "x"}}\nTOOL_CALL: {"name": "write_file", "arguments": {"path": "b.txt", "content": "B"}}',
      'Stopped.',
    ],
  });
  try {
    const ev = await turn(host, root);
    assert.strictEqual(fs.existsSync(path.join(root, 'b.txt')), false, 'the call after a failure must not run');
    const fedBack = requests[1].messages[requests[1].messages.length - 1].content;
    assert.match(fedBack, /ERROR: old_str not found/);
    assert.match(fedBack, /SKIPPED: not run because an earlier call in this response failed/);
    assert.strictEqual(ev.calls.length, 1);
  } finally {
    server.close();
  }
});

test('a multi-call result converts back to one native tool message per call', () => {
  const calls = [
    { name: 'write_file', arguments: { path: 'a.txt', content: 'x'.repeat(500) } },
    { name: 'run_command', arguments: { command: 'npm test' } },
  ];
  assert.ok(callHeader(calls[0].name, calls[0].arguments).length < 200, 'the header abbreviates long arguments');
  const out = toNativeMessages([
    { role: 'assistant', content: calls.map((c) => `TOOL_CALL: ${JSON.stringify(c)}`).join('\n') },
    { role: 'user', content: `TOOL_RESULT:\n${callHeader(calls[0].name, calls[0].arguments)}\nOK: wrote\n\n${callHeader(calls[1].name, calls[1].arguments)}\nall green` },
  ]);
  assert.deepStrictEqual(
    out.slice(1).map((m) => [m.role, m.tool_name, m.content]),
    [
      ['tool', 'write_file', 'OK: wrote'],
      ['tool', 'run_command', 'all green'],
    ]
  );
});

test('a declined approval can carry what the user wants instead', async () => {
  const root = tmpRoot();
  const { server, host, requests } = await fakeOllama({
    replies: ['TOOL_CALL: {"name": "write_file", "arguments": {"path": "a.txt", "content": "A"}}', 'OK, using b.txt.'],
  });
  try {
    await turn(host, root, { requestApproval: async () => ({ approved: false, feedback: 'call it b.txt' }) });
    assert.strictEqual(fs.existsSync(path.join(root, 'a.txt')), false);
    assert.match(requests[1].messages[requests[1].messages.length - 1].content, /User declined this action and said: "call it b\.txt"/);
  } finally {
    server.close();
  }
});

test('a conversation that outgrows its budget is summarized, not silently dropped', async () => {
  const root = tmpRoot();
  const { server, host, requests } = await fakeOllama({
    replies: ['## Request\nBuild the importer.\n\n## Done so far\nCreated importer.js with parse() and load().', 'Carrying on.'],
  });
  try {
    const history = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: i === 0 ? 'Build the importer' : `TOOL_RESULT:\n${'data '.repeat(400)}` });
      history.push({ role: 'assistant', content: `TOOL_CALL: {"name": "read_file", "arguments": {"path": "f${i}.js"}}` });
    }
    history.push({ role: 'user', content: 'keep going' });
    const notices = [];
    /** @type {any} */
    let compacted = null;
    await turn(host, root, {
      history,
      contextBudgetTokens: 5000,
      onRecovery: (kind) => notices.push(kind),
      onCompact: (info) => {
        compacted = info;
      },
    });
    assert.deepStrictEqual(notices, ['compact']);
    assert.ok(compacted.summarized > 4);
    assert.ok(history[0].content.startsWith(SUMMARY_PREFIX), 'the summary replaces the older messages');
    assert.match(history[0].content, /Created importer\.js/);
    assert.match(requests[0].messages[0].content, /compacting the transcript/, 'the first request is the summarizer');
    assert.match(JSON.stringify(requests[1].messages), /Created importer\.js/, 'the model continues from the summary');
  } finally {
    server.close();
  }
});

test('compactHistory leaves the history alone when the model returns nothing useful', async () => {
  const { server, host } = await fakeOllama({ replies: [''] });
  try {
    const history = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ];
    const copy = JSON.parse(JSON.stringify(history));
    const res = await compactHistory({ history, chatOpts: { host, model: 'm' }, keepTail: false });
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(history, copy);
  } finally {
    server.close();
  }
});

test('the context budget follows the model unless one is set', async () => {
  const cloud = await fakeOllama({ show: { model_info: { 'x.context_length': 262144 }, details: { parameter_size: '32B' }, remote_host: 'https://ollama.com' } });
  const small = await fakeOllama({ show: { model_info: { 'q.context_length': 32768 }, details: { parameter_size: '3.1B' } } });
  const big = await fakeOllama({ show: { model_info: { 'q.context_length': 32768 }, details: { parameter_size: '14B' } } });
  const tiny = await fakeOllama({ show: { model_info: { 'q.context_length': 4096 }, details: { parameter_size: '1B' } } });
  try {
    assert.strictEqual(await resolveContextBudget({ host: cloud.host, model: 'a' }), 100_000);
    assert.strictEqual(await resolveContextBudget({ host: small.host, model: 'b' }), 8_000);
    assert.strictEqual(await resolveContextBudget({ host: big.host, model: 'c' }), 16_000);
    assert.ok((await resolveContextBudget({ host: tiny.host, model: 'd' })) <= 4096, 'never more than the model can hold');
    assert.strictEqual(await resolveContextBudget({ host: small.host, model: 'b', configured: 12345 }), 12345, 'an explicit setting wins');
    assert.strictEqual(await resolveContextBudget({ host: 'http://unused', provider: 'openai-compatible', model: 'gpt' }), 32_000);
  } finally {
    for (const s of [cloud, small, big, tiny]) s.server.close();
  }
});

// -------------------------------------------------- openai-compatible

test('messages convert to the OpenAI wire format with matching call ids', () => {
  const out = toOpenAiMessages([
    { role: 'system', content: 's' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }, { function: { name: 'list_dir', arguments: {} } }] },
    { role: 'tool', tool_name: 'read_file', content: 'AAA' },
    { role: 'tool', tool_name: 'list_dir', content: 'x.js' },
    { role: 'tool', tool_name: 'orphan', content: 'no call' },
  ]);
  assert.strictEqual(out[1].tool_calls[0].function.arguments, '{"path":"a"}', 'arguments are a JSON string on the wire');
  assert.strictEqual(out[2].tool_call_id, out[1].tool_calls[0].id);
  assert.strictEqual(out[3].tool_call_id, out[1].tool_calls[1].id);
  assert.strictEqual(out[4].role, 'user', 'a result with no call to answer is sent as plain context');
});

/** A fake OpenAI-compatible server streaming the given SSE chunks per request. */
function fakeOpenAi(responses) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const r = responses[Math.min(n, responses.length - 1)];
      n++;
      if (r.status) {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: r.error } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const chunk of r) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, requests, host: `http://localhost:${/** @type {import('net').AddressInfo} */ (server.address()).port}` }))
  );
}

const delta = (d) => ({ choices: [{ delta: d }] });

test('openai-compatible: streamed tool-call fragments are assembled into whole calls', async () => {
  const { server, host, requests } = await fakeOpenAi([
    [
      delta({ reasoning_content: 'hmm' }),
      delta({ content: 'Reading. ' }),
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.js"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_dir', arguments: '{}' } }] }),
      { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
    ],
  ]);
  try {
    const calls = [];
    let thinking = '';
    /** @type {any} */
    let usage = null;
    const text = await openaiChat({
      host: `${host}/v1/`,
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      onToolCalls: (c) => calls.push(...c),
      onThinking: (t) => (thinking += t),
      onUsage: (u) => {
        usage = u;
      },
    });
    assert.strictEqual(text, 'Reading. ');
    assert.deepStrictEqual(calls, [
      { function: { name: 'read_file', arguments: { path: 'a.js' } } },
      { function: { name: 'list_dir', arguments: {} } },
    ]);
    assert.strictEqual(thinking, 'hmm');
    assert.strictEqual(usage.promptTokens, 42);
    assert.ok(requests[0].tools.length === 1 && requests[0].stream === true);
  } finally {
    server.close();
  }
});

test('openai-compatible: the loop uses function calling, and falls back to text when the server refuses tools', async () => {
  const root = tmpRoot({ 'a.txt': 'hello\n' });
  const ok = await fakeOpenAi([
    [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] })],
    [delta({ content: 'It says hello.' })],
  ]);
  const refuses = await fakeOpenAi([{ status: 400, error: 'this model does not support tools' }, [delta({ content: 'Plain answer.' })]]);
  try {
    const a = await turn(ok.host, root, { provider: 'openai-compatible', toolCalling: 'auto' });
    assert.strictEqual(a.final, 'It says hello.');
    assert.ok(ok.requests[0].tools.some((t) => t.function.name === 'read_file'));
    const second = ok.requests[1].messages;
    assert.strictEqual(second[second.length - 1].role, 'tool');
    assert.strictEqual(second[second.length - 1].tool_call_id, second[second.length - 2].tool_calls[0].id);

    const b = await turn(refuses.host, root, { provider: 'openai-compatible', toolCalling: 'auto' });
    assert.strictEqual(b.error, null);
    assert.strictEqual(b.final, 'Plain answer.');
    assert.strictEqual(refuses.requests[1].tools, undefined, 'the retry carries no tools');
    assert.match(refuses.requests[1].messages[0].content, /TOOL_CALL:/, 'and the prompt teaches the text protocol instead');
  } finally {
    ok.server.close();
    refuses.server.close();
  }
});

// ------------------------------------------------------ slash commands

test('a Markdown file in .cortex/commands is a slash command', () => {
  const root = tmpRoot({
    '.cortex/commands/review.md': 'description: Review a file\nReview $ARGUMENTS for bugs.',
    '.cortex/commands/ship.md': '---\ndescription: Ship it\n---\nRun the tests, then summarize.',
    '.cortex/commands/not a command.md': 'x',
  });
  const mine = listCustomCommands(root).filter((c) => c.scope === 'project');
  assert.deepStrictEqual(mine.map((c) => [c.name, c.description]), [['review', 'Review a file'], ['ship', 'Ship it']]);
  assert.strictEqual(expandCustomCommand('/review src/a.js', root).prompt, 'Review src/a.js for bugs.');
  assert.strictEqual(expandCustomCommand('/ship now please', root).prompt, 'Run the tests, then summarize.\n\nnow please');
  assert.strictEqual(expandCustomCommand('/etc/hosts', root), null);
  assert.strictEqual(expandCustomCommand('not a command', root), null);
});

// ------------------------------------------------------------------ cli

test('cli: flags, the exec form and a positional prompt are told apart', () => {
  const cwd = tmpRoot();
  /** @type {Record<string, string>} */
  const env = {};
  const a = parseArgs(['-p', 'fix it', '--model', 'm1', '--json', '-y'], { env, cwd });
  assert.deepStrictEqual([a.prompt, a.model, a.json, a.autoApprove, a.initialPrompt], ['fix it', 'm1', true, true, null]);
  assert.strictEqual(parseArgs(['exec', 'do', 'the', 'thing'], { env, cwd }).prompt, 'do the thing');
  const b = parseArgs(['explain this repo', '--plan'], { env, cwd });
  assert.deepStrictEqual([b.prompt, b.initialPrompt, b.planMode], [null, 'explain this repo', true]);
  assert.strictEqual(parseArgs(['-r'], { env, cwd }).resume, true);
  assert.strictEqual(parseArgs(['-r', 'abc123'], { env, cwd }).resume, 'abc123');
  assert.throws(() => parseArgs(['--nope'], { env, cwd }), /unknown option/);
  assert.throws(() => parseArgs(['--model'], { env, cwd }), /needs a value/);
});

test('cli: project config overrides defaults, flags override config, and the provider picks the host', () => {
  const cwd = tmpRoot({ '.cortex/config.json': JSON.stringify({ model: 'from-file', maxSteps: 9, autoApproveCommands: ['npm test'] }) });
  const a = parseArgs([], { env: {}, cwd });
  assert.deepStrictEqual([a.model, a.maxSteps, a.autoApproveCommands], ['from-file', 9, ['npm test']]);
  assert.strictEqual(parseArgs(['-m', 'flag'], { env: { CORTEX_MODEL: 'env' }, cwd }).model, 'flag');
  const o = parseArgs(['--provider', 'openai-compatible'], { env: { OPENAI_API_KEY: 'sk-x' }, cwd });
  assert.deepStrictEqual([o.host, o.apiKey], ['https://api.openai.com', 'sk-x']);
  assert.strictEqual(parseArgs([], { env: {}, cwd }).host, 'http://localhost:11434');
});

test('cli: "always allow" trusts a command prefix, never a chained command', () => {
  assert.strictEqual(commandPrefix('npm test -- --watch'), 'npm test');
  assert.strictEqual(commandPrefix('npm run build'), 'npm run build');
  assert.strictEqual(commandPrefix('git status --short'), 'git status');
  assert.strictEqual(commandPrefix('ls -la'), 'ls');
  assert.strictEqual(chainsCommands('npm test'), false);
  for (const cmd of ['npm test && rm -rf ~', 'npm test; curl x', 'npm test | sh', 'echo $(cat ~/.ssh/id_rsa)', 'a `b`']) {
    assert.strictEqual(chainsCommands(cmd), true, cmd);
  }
});

test('a tool call written with single-quoted strings is repaired, not rejected', () => {
  const { parseToolCall } = require('../src/toolCallParser.cjs');
  const a = parseToolCall(`TOOL_CALL: {"name": "edit_file", "arguments": {"path": "a.js", "old_str": '"1.0.0"', "new_str": '"2.0.0"'}}`);
  assert.deepStrictEqual(a.data.arguments, { path: 'a.js', old_str: '"1.0.0"', new_str: '"2.0.0"' });
  const b = parseToolCall(`TOOL_CALL: {'name': 'write_file', 'arguments': {'path': 'a.js', 'content': 'it\\'s "ok"\nline2'}}`);
  assert.deepStrictEqual(b.data, { name: 'write_file', arguments: { path: 'a.js', content: 'it\'s "ok"\nline2' } });
  const c = parseToolCall(`TOOL_CALL: {"name": "write_file", "arguments": {"path": "a.js", "content": "const s = 'hi'; // don't"}}`);
  assert.strictEqual(c.data.arguments.content, "const s = 'hi'; // don't", 'apostrophes inside a normal string are untouched');
});

test('a bare array of edits is accepted as multi_edit arguments', async () => {
  const root = tmpRoot({ 'a.js': 'const A = 1;\n', 'b.js': 'const B = 1;\n' });
  const { server, host } = await fakeOllama({
    replies: [
      'TOOL_CALL: {"name": "multi_edit", "arguments": [{"path": "a.js", "old_str": "A = 1", "new_str": "A = 2"}, {"path": "b.js", "old_str": "B = 1", "new_str": "B = 2"}]}',
      'Done.',
    ],
  });
  try {
    const ev = await turn(host, root);
    assert.strictEqual(ev.final, 'Done.');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'const A = 2;\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'b.js'), 'utf8'), 'const B = 2;\n');
  } finally {
    server.close();
  }
});

test('a model that keeps repeating one call is stopped instead of burning every step', async () => {
  const root = tmpRoot({ 'a.js': 'x\n' });
  const { server, host, requests } = await fakeOllama({ replies: ['TOOL_CALL: {"name": "search_code", "arguments": {"pattern": "zzz"}}'] });
  try {
    const ev = await turn(host, root, { maxSteps: 40 });
    assert.match(ev.error, /kept repeating the same call/);
    assert.ok(requests.length <= 6, `stopped early (made ${requests.length} requests)`);
  } finally {
    server.close();
  }
});

test('re-running a search after a change is a re-check, not a loop', async () => {
  const root = tmpRoot({ 'a.js': 'oldName();\noldName();\n' });
  const search = 'TOOL_CALL: {"name": "search_code", "arguments": {"pattern": "oldName"}}';
  const { server, host } = await fakeOllama({
    replies: [
      search,
      search,
      'TOOL_CALL: {"name": "edit_file", "arguments": {"path": "a.js", "old_str": "oldName", "new_str": "newName", "replace_all": true}}',
      search,
      'Renamed.',
    ],
  });
  try {
    const ev = await turn(host, root, { maxSteps: 8 });
    assert.strictEqual(ev.final, 'Renamed.');
    assert.ok(!ev.results.some((r) => /identical arguments/.test(r.result)), 'the post-edit search must run');
    assert.match(ev.results[ev.results.length - 1].result, /no matches/);
  } finally {
    server.close();
  }
});

test('an edit that cannot apply is reported without asking anyone to approve it', async () => {
  const root = tmpRoot({ 'a.js': 'return a + b;\nreturn a + b;\n' });
  const { server, host } = await fakeOllama({
    replies: ['TOOL_CALL: {"name": "edit_file", "arguments": {"path": "a.js", "old_str": "return a + b;", "new_str": "return a * b;"}}', 'I need more context.'],
  });
  try {
    let asked = 0;
    const ev = await turn(host, root, {
      requestApproval: async () => {
        asked++;
        return true;
      },
    });
    assert.strictEqual(asked, 0, 'no approval prompt for a call that can only fail');
    assert.match(ev.results[0].result, /matches 2 places/);
    assert.strictEqual(ev.results[0].isError, true);
  } finally {
    server.close();
  }
});

test('writing a file back unchanged is reported as no change, with no approval and no undo point', async () => {
  const root = tmpRoot({ 'a.js': 'same\n' });
  const { server, host } = await fakeOllama({
    replies: ['TOOL_CALL: {"name": "write_file", "arguments": {"path": "a.js", "content": "same\\n"}}', 'Nothing to do.'],
  });
  try {
    let asked = 0;
    const snapshots = [];
    const ev = await turn(host, root, {
      requestApproval: async () => {
        asked++;
        return true;
      },
      onToolResult: (result, isError, _id, snapshot) => {
        ev2.push({ result, isError });
        if (snapshot) snapshots.push(snapshot);
      },
    });
    assert.strictEqual(asked, 0);
    assert.strictEqual(snapshots.length, 0);
    assert.match(ev2[0].result, /^NO CHANGE: a\.js already has exactly this content/);
    assert.strictEqual(ev.final, 'Nothing to do.');
  } finally {
    server.close();
  }
});
const ev2 = [];

test('write_file refuses to overwrite an existing file the agent has not read', () => {
  const root = tmpRoot({ 'unseen-notes.md': '# Notes\n- one\n- two\n', 'empty-file.txt': '' });
  const refused = tools.write_file.run({ path: 'unseen-notes.md', content: '# Notes\n- three\n' }, root);
  assert.match(refused, /^ERROR: unseen-notes\.md already exists and you have not read it/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'unseen-notes.md'), 'utf8'), '# Notes\n- one\n- two\n', 'nothing was destroyed');
  assert.ok(tools.write_file.preview({ path: 'unseen-notes.md', content: 'x' }, root).error, 'so no approval is asked for it either');
  tools.read_file.run({ path: 'unseen-notes.md' }, root);
  assert.match(tools.write_file.run({ path: 'unseen-notes.md', content: '# Notes\n- one\n- two\n- three\n' }, root), /^OK: wrote/);
  assert.match(tools.write_file.run({ path: 'brand-new-file.md', content: 'x' }, root), /^OK: wrote/, 'new files need no read');
  assert.match(tools.write_file.run({ path: 'empty-file.txt', content: 'x' }, root), /^OK: wrote/, 'an empty file has nothing to lose');
});

test('a commit nobody asked for is refused; one the user asked for runs', async () => {
  const { execFileSync } = require('child_process');
  const repo = () => {
    const root = tmpRoot({ 'a.txt': 'one\n' });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init', '--allow-empty'], { cwd: root });
    return root;
  };
  const commits = (root) => execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const replies = ['TOOL_CALL: {"name": "git_commit", "arguments": {"message": "add a"}}', 'TOOL_CALL: {"name": "run_command", "arguments": {"command": "git -c user.name=t -c user.email=t@t commit -am x"}}', 'Done.'];

  const unasked = repo();
  const a = await fakeOllama({ replies });
  const asked = repo();
  const b = await fakeOllama({ replies: [replies[0], 'Committed.'] });
  try {
    const ev = await turn(a.host, unasked, { history: [{ role: 'user', content: 'tidy up a.txt' }] });
    assert.strictEqual(commits(unasked), '1', 'neither the tool nor the shell command committed');
    assert.strictEqual(ev.results.filter((r) => /did not ask for a commit/.test(r.result)).length, 2);
    assert.strictEqual(ev.final, 'Done.');

    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
    await turn(b.host, asked, { history: [{ role: 'user', content: 'tidy up a.txt and commit it' }] });
    assert.strictEqual(commits(asked), '2', 'a requested commit goes through');
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('a model that only keeps re-saving its plan is told to work, then stopped', async () => {
  const root = tmpRoot();
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ message: { content: `TOOL_CALL: {"name": "save_plan", "arguments": {"steps": "step ${n++}"}}` }, done: true })}\n`);
    });
  });
  await new Promise((r) => server.listen(0, () => r(undefined)));
  try {
    const ev = await turn(`http://localhost:${/** @type {import('net').AddressInfo} */ (server.address()).port}`, root, { maxSteps: 40 });
    assert.match(ev.error, /kept repeating/);
    assert.ok(n <= 7, `stopped after ${n} requests, not 40`);
    assert.ok(ev.results.some((r) => /Stop taking notes/.test(r.result)));
  } finally {
    server.close();
  }
});

test('a model that cannot produce a valid tool call is stopped with advice, not run to the step limit', async () => {
  const root = tmpRoot();
  const { server, host, requests } = await fakeOllama({ replies: ['TOOL_CALL: {"name": "multi_edit", "arguments": {"edits": [{"path": "a.js" "old_str": "x"}]}}'] });
  try {
    const ev = await turn(host, root, { maxSteps: 40 });
    assert.match(ev.error, /malformed tool calls in a row/);
    assert.strictEqual(requests.length, 6);
  } finally {
    server.close();
  }
});
