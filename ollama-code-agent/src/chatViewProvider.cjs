'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { runTurn } = require('./agentLoop.cjs');
const { tools } = require('./tools.cjs');
const {
  loadHistory,
  saveHistory,
  resetHistory,
  loadMemoryNotes,
  setMemoryNotes,
  touchSession,
  listSessions,
  deleteSession,
} = require('./memory.cjs');
const { listModels } = require('./ollamaClient.cjs');
const { shouldAutoApprove } = require('./permissions.cjs');
const logger = require('./logger.cjs');

const MUTATING_TOOLS = Object.entries(tools)
  .filter(([, t]) => t.confirm)
  .map(([name]) => name);

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

// Turn the raw model-facing history (which includes literal TOOL_CALL:/
// TOOL_RESULT: protocol text) back into something presentable when a past
// session is resumed — we don't reconstruct full diff cards, just a
// readable trace of what happened.
function simplifyHistoryForDisplay(history) {
  const out = [];
  for (const msg of history) {
    if (msg.role === 'user') {
      if (msg.content.startsWith('TOOL_RESULT:')) {
        out.push({ role: 'system', text: msg.content.replace(/^TOOL_RESULT:\s*/, 'Tool result: ').slice(0, 300) });
      } else {
        out.push({ role: 'user', text: msg.content });
      }
    } else if (msg.role === 'assistant') {
      const idx = msg.content.indexOf('TOOL_CALL:');
      if (idx !== -1) {
        let label = msg.content.slice(idx);
        try {
          const start = label.indexOf('{');
          const obj = JSON.parse(label.slice(start));
          label = `Called tool: ${obj.name}`;
        } catch {
          label = 'Called a tool';
        }
        out.push({ role: 'system', text: label });
      } else {
        out.push({ role: 'assistant', text: msg.content });
      }
    }
  }
  return out;
}

class ChatViewProvider {
  static viewType = 'cortex.chatView';

  constructor(context, diffProvider) {
    this.context = context;
    this.diffProvider = diffProvider;
    this.view = null;
    this.sessionId = nonce().slice(0, 8);
    this.history = [];
    this.busy = false;
    this.mode = 'act'; // 'act' | 'plan'
    this.abortController = null;
    this.pendingApprovals = new Map(); // id -> resolve fn
    this.revertable = new Map(); // callId -> {path, before}
    this.diffShownFor = new Set(); // callIds whose diff was already rendered at approval time
  }

  get root() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;
  }

  cfg() {
    const c = vscode.workspace.getConfiguration('cortex');
    return {
      host: c.get('host'),
      model: c.get('model'),
      autoApprove: c.get('autoApprove'),
      temperature: c.get('temperature'),
      maxSteps: c.get('maxSteps'),
      contextBudgetTokens: c.get('contextBudgetTokens'),
    };
  }

  get autoApproveTools() {
    return this.context.workspaceState.get('cortex.autoApproveTools', []);
  }

  set autoApproveTools(list) {
    this.context.workspaceState.update('cortex.autoApproveTools', list);
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));

    webviewView.onDidDispose(() => {
      this.view = null;
    });
  }

  post(msg) {
    this.view?.webview.postMessage(msg);
  }

  renderHtml(webview) {
    const nonceVal = nonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const cfg = this.cfg();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonceVal}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Cortex</title>
</head>
<body>
<div id="app">
  <div id="brand"><span class="brand-dot"></span><span class="brand-name">Cortex</span><span class="brand-tag">local &middot; Ollama-powered</span></div>
  <div id="topbar">
    <div id="mode-toggle" role="tablist">
      <button class="mode-btn active" data-mode="act" role="tab">Act</button>
      <button class="mode-btn" data-mode="plan" role="tab">Plan</button>
    </div>
    <div id="approve-toggle" role="tablist" title="Manual: approve every change. Auto: run without asking.">
      <button class="approve-btn active" data-approve="manual" role="tab">Manual</button>
      <button class="approve-btn" data-approve="auto" role="tab">Auto</button>
    </div>
    <span class="spacer"></span>
    <button id="memory-btn" title="Memory">🧠</button>
    <button id="history-btn" title="History">🕘</button>
    <button id="approvals-btn" title="Per-action auto-approve">⚙</button>
  </div>
  <div id="panel-history" class="panel hidden"></div>
  <div id="panel-approvals" class="panel hidden"></div>
  <div id="panel-memory" class="panel hidden"></div>
  <div id="banner" class="hidden"></div>
  <div id="messages"></div>
  <div id="composer">
    <textarea id="input" placeholder="Ask Cortex to do something in this workspace..." rows="3"></textarea>
    <div id="composer-row">
      <span id="model-badge">${escapeHtml(cfg.model)}</span>
      <span class="spacer"></span>
      <button id="stop-btn" class="hidden">Stop</button>
      <button id="send-btn">Send</button>
    </div>
  </div>
</div>
<script nonce="${nonceVal}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  async handleMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        const root = this.root;
        this.history = root ? loadHistory(root, this.sessionId) : [];
        this.post({ type: 'config', ...this.cfg() });
        this.post({ type: 'mode', mode: this.mode });
        this.post({ type: 'autoApproveTools', tools: MUTATING_TOOLS, enabled: this.autoApproveTools });
        if (!root) {
          this.post({ type: 'banner', text: 'Open a folder/workspace to start using Cortex.' });
        }
        break;
      }
      case 'send':
        await this.onSend(msg.text);
        break;
      case 'stop':
        this.abortController?.abort();
        break;
      case 'approve':
        this.resolveApproval(msg.id, msg.approved);
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'selectModel':
        await vscode.commands.executeCommand('cortex.selectModel');
        break;
      case 'openDiff':
        await this.openDiff(msg.diffId);
        break;
      case 'setMode':
        this.mode = msg.mode === 'plan' ? 'plan' : 'act';
        this.post({ type: 'mode', mode: this.mode });
        break;
      case 'setAutoApproveTool': {
        const set = new Set(this.autoApproveTools);
        if (msg.enabled) set.add(msg.name);
        else set.delete(msg.name);
        this.autoApproveTools = [...set];
        break;
      }
      case 'setAutoApprove': {
        const c = vscode.workspace.getConfiguration('cortex');
        await c.update('autoApprove', !!msg.enabled, vscode.ConfigurationTarget.Workspace);
        this.post({ type: 'config', ...this.cfg() });
        break;
      }
      case 'getMemory': {
        const root = this.root;
        this.post({ type: 'memoryContent', content: root ? loadMemoryNotes(root) : '' });
        break;
      }
      case 'saveMemory': {
        const root = this.root;
        if (root) {
          setMemoryNotes(root, msg.content || '');
          this.post({ type: 'memoryContent', content: loadMemoryNotes(root) });
        }
        break;
      }
      case 'listSessions':
        this.sendSessions();
        break;
      case 'loadSession':
        this.loadSession(msg.id);
        break;
      case 'deleteSession': {
        const root = this.root;
        if (root) deleteSession(root, msg.id);
        this.sendSessions();
        break;
      }
      case 'revert':
        await this.revertChange(msg.id);
        break;
      case 'openExternal':
        if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      default:
        break;
    }
  }

  sendSessions() {
    const root = this.root;
    const sessions = root ? listSessions(root) : [];
    this.post({ type: 'sessions', items: sessions, currentId: this.sessionId });
  }

  loadSession(id) {
    const root = this.root;
    if (!root) return;
    this.abortController?.abort();
    this.sessionId = id;
    this.history = loadHistory(root, id);
    this.post({ type: 'restoreSession', id, messages: simplifyHistoryForDisplay(this.history) });
  }

  newChat() {
    const root = this.root;
    if (root) resetHistory(root, this.sessionId);
    this.sessionId = nonce().slice(0, 8);
    this.history = [];
    this.revertable.clear();
    this.diffShownFor.clear();
    this.post({ type: 'cleared' });
  }

  resolveApproval(id, approved) {
    const resolve = this.pendingApprovals.get(id);
    if (resolve) {
      resolve(approved);
      this.pendingApprovals.delete(id);
    }
  }

  // `id` here is the tool call's own callId (from agentLoop), so the
  // approval UI attaches to the same chat card the 'toolCall' event created
  // rather than spawning a second, duplicate card.
  requestApproval(name, args, id) {
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, resolve);
      const preview = tools[name].preview ? safePreview(tools[name], args, this.root) : null;
      let diffId = null;
      if (preview && preview.before !== undefined) {
        diffId = id;
        this.diffProvider.store(diffId, preview);
        this.diffShownFor.add(id);
      }
      this.post({ type: 'needsApproval', id, name, args, preview, diffId });
    });
  }

  async openDiff(diffId) {
    const entry = this.diffProvider.get(diffId);
    if (!entry) return;
    const leftUri = vscode.Uri.parse(`cortex-diff:${diffId}/before/${encodeURIComponent(entry.path)}`);
    const rightUri = vscode.Uri.parse(`cortex-diff:${diffId}/after/${encodeURIComponent(entry.path)}`);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${entry.path} (proposed change)`);
  }

  async revertChange(callId) {
    const root = this.root;
    const snapshot = this.revertable.get(callId);
    if (!root || !snapshot) return;
    try {
      tools.write_file.run({ path: snapshot.path, content: snapshot.before }, root);
      this.revertable.delete(callId);
      this.history.push({
        role: 'user',
        content: `TOOL_RESULT: SYSTEM NOTE — the user manually reverted your change to ${snapshot.path} back to its previous contents. Take this into account if you continue working.`,
      });
      saveHistory(root, this.sessionId, this.history);
      this.post({ type: 'reverted', id: callId, path: snapshot.path });
    } catch (err) {
      this.post({ type: 'error', text: `Revert failed: ${err.message}` });
    }
  }

  async onSend(text) {
    if (!text || !text.trim()) return;
    const root = this.root;
    if (!root) {
      this.post({ type: 'banner', text: 'Open a folder/workspace to start using Cortex.' });
      return;
    }
    if (this.busy) return;

    this.busy = true;
    this.abortController = new AbortController();
    this.post({ type: 'busy', value: true });
    this.post({ type: 'userMessage', text });

    this.history.push({ role: 'user', content: text });

    const cfg = this.cfg();
    logger.log(
      `session=${this.sessionId} mode=${this.mode} model=${cfg.model} user message (${text.length} chars): ${text.slice(0, 120)}`
    );
    const memoryNotes = loadMemoryNotes(root);
    const openFile = vscode.window.activeTextEditor
      ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri)
      : undefined;
    const planMode = this.mode === 'plan';
    const startedAt = Date.now();

    try {
      await runTurn({
        history: this.history,
        root,
        host: cfg.host,
        model: cfg.model,
        temperature: cfg.temperature,
        maxSteps: cfg.maxSteps,
        contextBudgetTokens: cfg.contextBudgetTokens,
        memoryNotes,
        openFile,
        planMode,
        signal: this.abortController.signal,
        onLog: (message) => logger.log(message),
        onToken: (t) => {
          this.post({ type: 'token', text: t });
        },
        onToolCall: (name, args, callId) => {
          this.post({ type: 'toolCall', name, args, id: callId });
        },
        requestApproval: async (name, args, callId) => {
          if (shouldAutoApprove(name, { autoApprove: cfg.autoApprove, autoApproveTools: this.autoApproveTools })) return true;
          return this.requestApproval(name, args, callId);
        },
        onToolResult: (result, isError, callId, snapshot) => {
          if (snapshot && callId) this.revertable.set(callId, snapshot);
          const alreadyShown = callId && this.diffShownFor.has(callId);
          this.post({
            type: 'toolResult',
            result,
            isError,
            id: callId,
            revertAvailable: !!snapshot,
            diff: !alreadyShown && snapshot ? { path: snapshot.path, before: snapshot.before, after: snapshot.after } : null,
          });
        },
        onFinal: (finalText, steps) => {
          this.post({ type: 'final', text: finalText, steps, elapsedMs: Date.now() - startedAt });
        },
        onError: (message) => {
          this.post({ type: 'error', text: message });
        },
      });
    } catch (err) {
      this.post({ type: 'error', text: err.message });
    } finally {
      saveHistory(root, this.sessionId, this.history);
      touchSession(root, this.sessionId, this.history);
      this.busy = false;
      this.abortController = null;
      this.post({ type: 'busy', value: false });
    }
  }
}

function safePreview(tool, args, root) {
  if (!root) return null;
  try {
    return tool.preview(args, root);
  } catch (err) {
    return { error: err.message };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Serves virtual before/after documents for the diff editor.
class DiffContentProvider {
  constructor() {
    this.store_ = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }

  store(id, entry) {
    this.store_.set(id, entry);
  }

  get(id) {
    return this.store_.get(id);
  }

  provideTextDocumentContent(uri) {
    const parts = uri.path.split('/').filter(Boolean);
    const [id, which] = parts;
    const entry = this.store_.get(id);
    if (!entry) return '';
    return which === 'before' ? entry.before || '' : entry.after || '';
  }
}

module.exports = { ChatViewProvider, DiffContentProvider, listModels };
