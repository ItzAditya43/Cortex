// Activation smoke test.
//
// Everything else in this suite tests modules in isolation, which cannot
// catch the failure that matters most to a user: the extension throwing on
// activate() so nothing works at all. Reaching that normally means launching
// an Extension Development Host by hand.
//
// Instead this injects a mock `vscode` module into require's cache, runs the
// real activate(), and asserts the extension wires itself up without
// throwing — every command registered, the webview provider registered, the
// HTML rendered, and the webview message handlers callable.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// ---- mock vscode ----------------------------------------------------------
const registered = { commands: [], webviews: [], configListeners: [], contentProviders: [] };
const posted = [];

function makeMockVscode() {
  const config = {
    host: 'http://127.0.0.1:1',
    model: 'test-model',
    provider: 'ollama',
    temperature: 0.2,
    maxSteps: 10,
    contextBudgetTokens: 6000,
    mcpServers: [],
    schedules: [],
    profiles: {},
  };
  const Disposable = { dispose() {} };
  return {
    Uri: {
      file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` }),
      parse: (s) => ({ fsPath: s, path: s, toString: () => s }),
      joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), toString: () => path.join(base.fsPath, ...parts) }),
    },
    EventEmitter: class {
      constructor() {
        this.event = () => Disposable;
      }
      fire() {}
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    StatusBarAlignment: { Right: 2, Left: 1 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    SymbolKind: { Function: 11, Class: 4 },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      getConfiguration: () => ({ get: (k) => config[k], update: async () => {} }),
      onDidChangeConfiguration: (fn) => {
        registered.configListeners.push(fn);
        return Disposable;
      },
      registerTextDocumentContentProvider: (scheme, provider) => {
        registered.contentProviders.push({ scheme, provider });
        return Disposable;
      },
      asRelativePath: (u) => (typeof u === 'string' ? u : u.fsPath),
      openTextDocument: async () => ({ lineAt: () => ({ text: '' }), getText: () => '' }),
    },
    window: {
      activeTextEditor: undefined,
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '' }),
      createTerminal: () => ({ show() {}, dispose() {}, exitStatus: undefined }),
      registerWebviewViewProvider: (id, provider) => {
        registered.webviews.push({ id, provider });
        return Disposable;
      },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      withProgress: async (_o, fn) => fn({ report() {} }),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      onDidEndTerminalShellExecution: () => Disposable,
      onDidChangeTerminalShellIntegration: () => Disposable,
    },
    commands: {
      registerCommand: (id, fn) => {
        registered.commands.push({ id, fn });
        return Disposable;
      },
      executeCommand: async () => undefined,
    },
    languages: { getDiagnostics: () => [] },
    env: { openExternal: async () => true },
  };
}

// Inject the mock so `require('vscode')` resolves inside the extension.
const originalResolve = Module._resolveFilename;
const MOCK_ID = path.join(__dirname, '__vscode_mock__.js');
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return MOCK_ID;
  return originalResolve.call(this, request, ...args);
};
require.cache[MOCK_ID] = { id: MOCK_ID, filename: MOCK_ID, loaded: true, exports: makeMockVscode() };

const extension = require('../src/extension.cjs');

function makeContext() {
  const state = new Map();
  return {
    subscriptions: [],
    extensionUri: { fsPath: path.join(__dirname, '..') },
    workspaceState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: (k, v) => state.set(k, v) },
  };
}

let activatedContext;
test('activate() wires the extension up without throwing', () => {
  activatedContext = makeContext();
  assert.doesNotThrow(() => extension.activate(activatedContext));
  assert.ok(activatedContext.subscriptions.length > 0, 'nothing was registered for disposal');
});

test('every command declared in package.json is actually registered', () => {
  const declared = require('../package.json').contributes.commands.map((c) => c.command);
  const actual = registered.commands.map((c) => c.id);
  const missing = declared.filter((d) => !actual.includes(d));
  assert.deepStrictEqual(missing, [], `declared in package.json but never registered: ${missing.join(', ')}`);
});

test('the chat webview provider renders HTML and handles messages', async () => {
  const entry = registered.webviews.find((w) => w.id === 'cortex.chatView');
  assert.ok(entry, 'chat webview provider was not registered');
  const provider = entry.provider;

  const view = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (u) => u,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (m) => posted.push(m),
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  provider.resolveWebviewView(view);
  assert.match(view.webview.html, /<html/, 'no HTML rendered into the webview');
  assert.match(view.webview.html, /id="messages"/, 'chat message container missing');
  assert.match(view.webview.html, /id="input"/, 'composer input missing');

  // The handlers the UI actually calls must not throw.
  await provider.handleMessage({ type: 'ready' });
  await provider.handleMessage({ type: 'listSessions' });
  await provider.handleMessage({ type: 'getMemory' });
  await provider.handleMessage({ type: 'setMode', mode: 'plan' });
  await provider.handleMessage({ type: 'setMode', mode: 'act' });
  assert.ok(posted.length > 0, 'provider never posted anything back to the webview');
});

// activate() starts a scheduler interval and MCP connections that would keep
// the process alive forever; disposing mirrors what the extension host does
// on deactivate and lets the test runner exit.
test('activate() registers disposables that actually clean up', () => {
  for (const sub of activatedContext.subscriptions) {
    assert.doesNotThrow(() => sub.dispose && sub.dispose());
  }
});

test('slash commands are handled without reaching the model', async () => {
  const provider = registered.webviews.find((w) => w.id === 'cortex.chatView').provider;
  assert.strictEqual(await provider.handleSlashCommand('/help'), true);
  assert.strictEqual(await provider.handleSlashCommand('/clear'), true);
  // Not a command — must fall through to the model, not be swallowed.
  assert.strictEqual(await provider.handleSlashCommand('/home/user/file.js'), false);
  assert.strictEqual(await provider.handleSlashCommand('fix the bug'), false);
});
