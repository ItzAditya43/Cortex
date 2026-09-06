// The busy flag must never get stuck.
//
// Reported symptom: the panel showed Stop with an empty transcript and every
// message typed afterwards vanished. Cause: `this.busy = true` was set ~30
// lines before the try/finally that clears it, so anything throwing during
// turn setup (config read, memory load, audit write, editor access) left the
// flag set forever. onSend then began with `if (this.busy) return`, which
// silently discarded every subsequent message — the extension looked dead
// rather than broken.
//
// Three things have to hold: a crash during setup clears the flag, Stop
// recovers the UI even when there is nothing to abort, and a reloaded
// webview is told the real state instead of assuming idle.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// Minimal vscode stand-in; only what ChatViewProvider touches on these paths.
const MOCK_ID = path.join(__dirname, '__vscode_busy_mock__.js');
if (!require.cache[MOCK_ID]) {
  const Disposable = { dispose() {} };
  require.cache[MOCK_ID] = {
    id: MOCK_ID,
    filename: MOCK_ID,
    loaded: true,
    exports: {
      Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ fsPath: s }), joinPath: (b, ...r) => ({ fsPath: path.join(b.fsPath, ...r) }) },
      EventEmitter: class {
        constructor() {
          this.event = () => Disposable;
        }
        fire() {}
      },
      ThemeIcon: class {},
      ConfigurationTarget: { Global: 1, Workspace: 2 },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
        getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
        asRelativePath: (u) => (typeof u === 'string' ? u : u.fsPath),
        openTextDocument: async () => ({ lineAt: () => ({ text: '' }) }),
      },
      window: { activeTextEditor: undefined, showInformationMessage: async () => {}, createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
      commands: { executeCommand: async () => {} },
      languages: { getDiagnostics: () => [] },
      env: { openExternal: async () => {} },
    },
  };
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return MOCK_ID;
    return originalResolve.call(this, request, ...args);
  };
}

const { ChatViewProvider } = require('../src/chatViewProvider.cjs');

function makeProvider() {
  const posted = [];
  const provider = new ChatViewProvider(
    {
      subscriptions: [],
      extensionUri: { fsPath: path.join(__dirname, '..') },
      workspaceState: { get: (_k, d) => d, update: () => {} },
    },
    { store() {}, get() {} }
  );
  provider.post = (m) => posted.push(m);
  return { provider, posted };
}

test('a crash during turn setup does not strand the busy flag', async () => {
  const { provider, posted } = makeProvider();
  // Simulate a throw anywhere in setup — the exact source doesn't matter,
  // only that onSend's finally still runs.
  provider.runTurnForMessage = async () => {
    throw new Error('config blew up');
  };

  await provider.onSend('do something');

  assert.strictEqual(provider.busy, false, 'busy must be cleared even when setup throws');
  const busyMsgs = posted.filter((m) => m.type === 'busy');
  assert.strictEqual(busyMsgs.at(-1)?.value, false, 'the UI must be told it is idle again');
  assert.ok(
    posted.some((m) => m.type === 'error' && /Could not start the turn/.test(m.text)),
    'the user must be told why nothing happened'
  );
});

test('a second message while busy is refused with an explanation, not dropped', async () => {
  const { provider, posted } = makeProvider();
  provider.busy = true;

  await provider.onSend('hello?');

  const err = posted.find((m) => m.type === 'error');
  assert.ok(err, 'the message must not vanish silently');
  assert.match(err.text, /Press Stop/, 'the user needs to be told how to recover');
});

test('Stop recovers the UI even when there is nothing to abort', async () => {
  const { provider, posted } = makeProvider();
  provider.busy = true;
  provider.abortController = null; // the stuck state: flag set, nothing running

  await provider.handleMessage({ type: 'stop' });

  assert.strictEqual(provider.busy, false, 'Stop must always return the panel to a usable state');
  assert.strictEqual(posted.filter((m) => m.type === 'busy').at(-1)?.value, false);
});

test('a reloaded webview is told the real busy state', async () => {
  const { provider, posted } = makeProvider();
  provider.busy = true;

  await provider.handleMessage({ type: 'ready' });

  const busy = posted.filter((m) => m.type === 'busy');
  assert.ok(busy.length > 0, 'ready must report the busy state');
  assert.strictEqual(busy.at(-1).value, true, 'a reloaded panel must not assume it is idle');
});
