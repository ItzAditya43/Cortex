// Drives the real chat webview (the HTML the provider renders, plus
// media/render.js and media/main.js) in jsdom, feeding it the same messages
// the extension host posts, and checks what ends up on screen.
//
// Every bug here was invisible to the module tests, because each was in how
// the panel reacted to a sequence of messages:
//   - an approved action's result never rendered (the leftover approval row
//     made addToolResult bail out), so command output and the Revert button
//     never appeared under the default "ask me" policy;
//   - a streamed tool call showed up as raw JSON — whole files of it;
//   - Stop left the approval buttons live.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { JSDOM } = require('jsdom');

const MOCK_ID = path.join(__dirname, '__vscode_webview_mock__.js');
if (!require.cache[MOCK_ID]) {
  require.cache[MOCK_ID] = /** @type {any} */ ({
    id: MOCK_ID,
    filename: MOCK_ID,
    loaded: true,
    exports: {
      Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ fsPath: s }), joinPath: (b, ...r) => ({ fsPath: path.join(b.fsPath, ...r) }) },
      EventEmitter: class {
        constructor() {
          this.event = () => ({ dispose() {} });
        }
        fire() {}
      },
      workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined }) },
      window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
      env: {},
    },
  });
  const anyModule = /** @type {any} */ (Module);
  const originalResolve = anyModule._resolveFilename;
  anyModule._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return MOCK_ID;
    return originalResolve.call(this, request, ...args);
  };
}

const { ChatViewProvider } = require('../src/chatViewProvider.cjs');
const MEDIA = path.join(__dirname, '..', 'media');

// Each jsdom window runs its own timers (the working indicator's clock,
// requestAnimationFrame); left open they keep the test process alive.
const openWindows = [];
test.afterEach(() => {
  while (openWindows.length) openWindows.pop().close();
});

function openPanel() {
  const provider = new ChatViewProvider(
    { extensionUri: { fsPath: path.join(__dirname, '..') }, workspaceState: { get: (_k, d) => d, update() {} } },
    null
  );
  const html = provider
    .renderHtml({ cspSource: '', asWebviewUri: (u) => u.fsPath })
    .replace(/<script[^>]*><\/script>/g, ''); // scripts are run by hand below, in order
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  openWindows.push(window);
  const sent = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
  window.eval(fs.readFileSync(path.join(MEDIA, 'render.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(MEDIA, 'main.js'), 'utf8'));

  const doc = window.document;
  const post = (msg) => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
  const frame = () => new Promise((r) => window.requestAnimationFrame(() => r()));
  return { window, doc, sent, post, frame, $: (sel) => doc.querySelector(sel), $$: (sel) => [...doc.querySelectorAll(sel)] };
}

test('the result of an approved action is shown, with its revert button', () => {
  const ui = openPanel();
  ui.post({ type: 'busy', value: true });
  ui.post({ type: 'toolCall', id: 'c1', name: 'edit_file', args: { path: 'a.js', old_str: 'x', new_str: 'y' } });
  ui.post({
    type: 'needsApproval',
    id: 'c1',
    name: 'edit_file',
    args: { path: 'a.js' },
    diffView: { files: [{ path: 'a.js', hunks: [{ oldStart: 1, newStart: 1, lines: [{ t: '-', s: 'x' }, { t: '+', s: 'y' }] }] }], add: 1, del: 1 },
    diffId: 'c1',
  });

  const card = ui.$('.tool-block[data-call-id="c1"]');
  assert.ok(card.querySelector('.diff-add'), 'the proposed diff is shown for review');
  const approve = [...card.querySelectorAll('.approval-row button')].find((b) => b.textContent === 'Approve');
  approve.click();
  assert.deepStrictEqual({ ...ui.sent.find((m) => m.type === 'approve') }, { type: 'approve', id: 'c1', approved: true });

  ui.post({ type: 'toolResult', id: 'c1', result: 'OK: edited a.js', isError: false, revertAvailable: true, diffView: null });
  assert.strictEqual(card.querySelector('.tool-body.result')?.textContent, 'OK: edited a.js');
  assert.ok(card.querySelector('.revert-btn'), 'revert must be offered for an approved edit');
  assert.strictEqual(card.querySelector('.status').textContent, '✓');
});

test('a rejected action does not repeat the decline text as a result', () => {
  const ui = openPanel();
  ui.post({ type: 'toolCall', id: 'c2', name: 'run_command', args: { command: 'rm -rf build' } });
  ui.post({ type: 'needsApproval', id: 'c2', name: 'run_command', args: { command: 'rm -rf build' } });
  const card = ui.$('.tool-block[data-call-id="c2"]');
  assert.match(card.textContent, /\$ rm -rf build/, 'the command being approved is visible');
  [...card.querySelectorAll('.approval-row button')].find((b) => b.textContent === 'Reject').click();
  ui.post({ type: 'toolResult', id: 'c2', result: 'User declined this action.', isError: true });
  assert.strictEqual(card.querySelector('.tool-body.result'), null);
  assert.match(card.textContent, /Rejected/);
});

test('Stop turns an open approval card into "Cancelled" with no live buttons', () => {
  const ui = openPanel();
  ui.post({ type: 'toolCall', id: 'c3', name: 'write_file', args: { path: 'b.js' } });
  ui.post({ type: 'needsApproval', id: 'c3', name: 'write_file', args: { path: 'b.js' } });
  ui.post({ type: 'approvalCancelled', id: 'c3' });
  const card = ui.$('.tool-block[data-call-id="c3"]');
  assert.strictEqual(card.querySelectorAll('.approval-row button').length, 0);
  assert.match(card.textContent, /Cancelled/);
});

test('a streamed tool call shows as a card, never as raw JSON', async () => {
  const ui = openPanel();
  ui.post({ type: 'busy', value: true });
  for (const t of ['I will create it.\n', 'TOOL_CALL: {"name": "write_file", ', '"arguments": {"path": "x.js", "content": "secret body"}}']) {
    ui.post({ type: 'token', text: t });
  }
  await ui.frame();
  const transcript = ui.$('#messages').textContent;
  assert.doesNotMatch(transcript, /TOOL_CALL|secret body/);
  assert.match(transcript, /I will create it\./);
  assert.match(ui.$('.working').textContent, /Preparing write_file/);

  ui.post({ type: 'toolCall', id: 'c4', name: 'write_file', args: { path: 'x.js', content: 'secret body' } });
  assert.strictEqual(ui.$('.tool-block[data-call-id="c4"] .args').textContent, 'x.js');
  assert.doesNotMatch(ui.$('#messages').textContent, /secret body/);
});

test('reasoning from a thinking model is shown, then collapsed to a summary', async () => {
  const ui = openPanel();
  ui.post({ type: 'busy', value: true });
  assert.ok(ui.$('.working'), 'something is visible before the first token');
  ui.post({ type: 'thinking', text: 'The user wants…' });
  assert.match(ui.$('.thinking-body').textContent, /The user wants/);
  ui.post({ type: 'token', text: 'Answer.' });
  await ui.frame();
  assert.match(ui.$('.thinking summary').textContent, /Thought for \d+s/);
  ui.post({ type: 'final', text: 'Answer.', steps: 1, elapsedMs: 1200 });
  ui.post({ type: 'busy', value: false });
  assert.strictEqual(ui.$('.working'), null, 'the working line goes away when the turn ends');
  assert.match(ui.$('.msg.assistant').textContent, /Answer\./);
});

test('successful reads collapse; errors stay open', () => {
  const ui = openPanel();
  ui.post({ type: 'toolCall', id: 'r1', name: 'read_file', args: { path: 'a.js' }, readOnly: true });
  ui.post({ type: 'toolResult', id: 'r1', result: '1\tconst a = 1;', isError: false });
  ui.post({ type: 'toolCall', id: 'r2', name: 'read_file', args: { path: 'nope.js' }, readOnly: true });
  ui.post({ type: 'toolResult', id: 'r2', result: 'ERROR: file not found: nope.js', isError: true });
  assert.ok(ui.$('[data-call-id="r1"]').classList.contains('collapsed'));
  assert.ok(!ui.$('[data-call-id="r2"]').classList.contains('collapsed'));
});

test('a resumed chat replays tool calls as cards', () => {
  const ui = openPanel();
  ui.post({
    type: 'restoreSession',
    messages: [
      { role: 'user', text: 'fix it' },
      { role: 'tool', name: 'edit_file', args: { path: 'a.js' }, result: 'OK: edited a.js', isError: false },
      { role: 'assistant', text: 'Fixed.' },
    ],
  });
  assert.strictEqual(ui.$('.tool-block .args').textContent, 'a.js');
  assert.match(ui.$('.tool-block').textContent, /OK: edited a\.js/);
});

test('clicking the model badge opens the model picker', () => {
  const ui = openPanel();
  ui.$('#model-badge').click();
  assert.ok(ui.sent.some((m) => m.type === 'selectModel'));
});

test('prose before a tool call survives even when the call arrives before a frame renders', () => {
  const ui = openPanel();
  ui.post({ type: 'token', text: 'Checking the config first.\nTOOL_CALL: {"name": "read_file"' });
  ui.post({ type: 'toolCall', id: 'f1', name: 'read_file', args: { path: 'c.json' }, readOnly: true }); // no frame in between
  assert.match(ui.$('.msg.assistant').textContent, /Checking the config first\./);
  assert.doesNotMatch(ui.$('#messages').textContent, /TOOL_CALL/);
});
