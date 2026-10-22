// The webview's pure rendering helpers (media/render.js), loaded the way the
// webview loads them — as a plain browser script — in a vm sandbox.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'render.js'), 'utf8'), sandbox);
const R = sandbox.window.CortexRender;

test('a streaming tool call is never shown as raw JSON', () => {
  const buf = 'Let me look.\nTOOL_CALL: {"name": "write_file", "arguments": {"path": "a.js", "content": "const x = 1;\\n';
  const r = R.splitStreamingReply(buf);
  assert.strictEqual(r.text, 'Let me look.');
  assert.strictEqual(r.toolPending, true);
  assert.strictEqual(r.toolName, 'write_file');
});

test('a marker split across tokens does not flash on screen', () => {
  assert.strictEqual(R.splitStreamingReply('Reading it now. TOOL_').text, 'Reading it now. ');
  assert.strictEqual(R.splitStreamingReply('Reading it now. TOOL_CA').toolPending, false);
});

test('a fence opened around the tool call is not left behind', () => {
  const r = R.splitStreamingReply('Sure.\n```json\nTOOL_CALL: {"name": "read_file"');
  assert.strictEqual(r.text, 'Sure.');
});

test('ordinary text passes through untouched', () => {
  assert.deepStrictEqual(
    { ...R.splitStreamingReply('All done — 3 files changed.') },
    { text: 'All done — 3 files changed.', toolPending: false, toolName: null }
  );
});

test('markdown escapes HTML from the model', () => {
  const html = R.renderMarkdown('<img src=x onerror=alert(1)> **bold**');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('emphasis markers inside inline code are left alone', () => {
  const html = R.renderInline('use `a**b**` and `*ptr`');
  assert.match(html, /<code>a\*\*b\*\*<\/code>/);
  assert.match(html, /<code>\*ptr<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('code blocks get a copy button and keep their content escaped', () => {
  const html = R.renderMarkdown('```js\nif (a < b) {}\n```');
  assert.match(html, /copy-btn/);
  assert.match(html, /if \(a &lt; b\) \{\}/);
  assert.match(html, /code-lang">js</);
});

test('tables render as tables', () => {
  const html = R.renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table class="md-table"><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr>/);
});

test('tool card headers summarise arguments instead of dumping JSON', () => {
  assert.strictEqual(R.summarizeArgs('write_file', { path: 'src/a.js', content: 'x'.repeat(5000) }), 'src/a.js');
  assert.strictEqual(R.summarizeArgs('run_command', { command: 'npm test' }), '$ npm test');
  assert.strictEqual(R.summarizeArgs('read_file', { path: ['a.js', 'b.js'] }), 'a.js, b.js');
  assert.strictEqual(R.summarizeArgs('search_code', { pattern: 'TODO', path: 'src' }), '"TODO" in src');
  assert.strictEqual(R.summarizeArgs('multi_edit', { edits: [{ path: 'a.js' }, { path: 'a.js' }, { path: 'b.js' }] }), '3 edits · a.js, b.js');
  assert.strictEqual(R.summarizeArgs('save_plan', { steps: '[x] one\ntwo' }), '1/2 steps done');
  assert.strictEqual(R.summarizeArgs('git_status', {}), '');
});

test('diff view html marks added and removed lines', () => {
  const html = R.diffViewHtml({
    files: [{ path: 'a.js', hunks: [{ oldStart: 1, newStart: 1, lines: [{ t: ' ', s: 'a' }, { t: '-', s: 'b' }, { t: '+', s: '<c>' }] }] }],
    add: 1,
    del: 1,
  });
  assert.match(html, /diff-del"><span class="diff-sign">-<\/span>b/);
  assert.match(html, /diff-add"><span class="diff-sign">\+<\/span>&lt;c&gt;/);
});

test('a tool call written as a JSON object does not flash on screen', () => {
  const r = R.splitStreamingReply('```json\n{"name": "edit_file", "argu');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.toolName, 'edit_file');
  assert.strictEqual(R.splitStreamingReply('```json\n').text, '', 'nor does the fence before the object arrives');
  assert.match(R.splitStreamingReply('Use `{"name": 1}` like this').text, /Use/, 'prose that merely mentions JSON is untouched');
});
