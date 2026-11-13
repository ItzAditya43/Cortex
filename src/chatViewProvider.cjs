'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { runTurn, parseToolCalls } = require('./agentLoop.cjs');
const { tools } = require('./tools.cjs');
const {
  loadHistory,
  saveHistory,
  loadMemoryNotes,
  setMemoryNotes,
  touchSession,
  listSessions,
  deleteSession,
} = require('./memory.cjs');
const { listModels } = require('./provider.cjs');
const { shouldAutoApprove } = require('./permissions.cjs');
const { retrieveRelevantNotes } = require('./semanticMemory.cjs');
const { reviewAction } = require('./approveForMe.cjs');
const { applyProfile } = require('./profiles.cjs');
const { generateProjectRules } = require('./initRules.cjs');
const { saveSnapshot, loadSnapshots, deleteSnapshot, clearSession, pruneOldSessions, restoreSnapshot } = require('./checkpoints.cjs');
const { clearTasks } = require('./taskList.cjs');
const { markAgentWrite, getStaleWarning } = require('./fileTracker.cjs');
const audit = require('./auditLog.cjs');
const { buildEditAnimation } = require('./editAnimation.cjs');
const logger = require('./logger.cjs');
const { buildDiffView } = require('./lineDiff.cjs');
const { workspaceFiles, expandMentions, stripAttachments } = require('./mentions.cjs');
const { splitResults } = require('./nativeTools.cjs');
const { compactHistory: summarizeHistory } = require('./compactor.cjs');
const { resolveContextBudget } = require('./contextManager.cjs');
const { listCustomCommands, expandCustomCommand } = require('./slashCommands.cjs');

const MUTATING_TOOLS = Object.entries(tools)
  .filter(([, t]) => t.confirm)
  .map(([name]) => name);

// The chat card's view of a change: hunks per file plus totals. multi_edit
// snapshots carry one entry per file; everything else is a single file.
function diffViewFor(change) {
  if (!change || change.error || change.before === undefined) return null;
  const entries = Array.isArray(change.files) ? change.files : [change];
  let add = 0;
  let del = 0;
  const files = entries.map((f) => {
    const v = buildDiffView(f.before, f.after);
    add += v.add;
    del += v.del;
    return { path: f.path, hunks: v.hunks, truncated: v.truncated, created: !!f.created };
  });
  return { files, add, del, renamed: change.renameFrom ? `${change.renameFrom} → ${change.renameTo}` : null };
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

// Turns the raw model-facing history (literal TOOL_CALL:/TOOL_RESULT:
// protocol text) back into what the panel showed when the chat was live: the
// user's messages, the model's prose, and a tool card per call with its
// result. Protocol-internal messages (format nudges, retries) are left out —
// they were never shown the first time either.
function simplifyHistoryForDisplay(history) {
  const out = [];
  let awaiting = null; // tool cards from the last TOOL_CALL message, waiting for their result
  for (const msg of history) {
    const content = String(msg.content || '');
    if (msg.role === 'user') {
      if (content.startsWith('TOOL_RESULT:')) {
        const result = content.replace(/^TOOL_RESULT:\s*/, '');
        if (awaiting && awaiting.length) {
          // One response can carry several calls; their results come back
          // together under a "--- name(args) ---" header each.
          const parts = splitResults(result, awaiting.map((c) => c.name));
          awaiting.forEach((card, i) => {
            const r = String(parts[i]?.content ?? '');
            card.result = r.length > 4000 ? `${r.slice(0, 4000)}\n…` : r;
            card.isError = /^(ERROR|User declined|SKIPPED)/.test(r);
          });
          awaiting = null;
        } else if (/^SYSTEM NOTE/.test(result)) {
          out.push({ role: 'system', text: result.replace(/^SYSTEM NOTE\s*[—-]\s*/, '').slice(0, 300) });
        }
      } else if (content.startsWith('[Earlier conversation summary]')) {
        out.push({ role: 'system', text: 'Earlier conversation was compacted into a summary.' });
      } else {
        out.push({ role: 'user', text: stripAttachments(content), image: msg.images?.[0] ? `data:image/png;base64,${msg.images[0]}` : undefined });
      }
    } else if (msg.role === 'assistant') {
      const idx = content.indexOf('TOOL_CALL:');
      if (idx === -1) {
        out.push({ role: 'assistant', text: content });
        continue;
      }
      const commentary = content.slice(0, idx).trim();
      if (commentary) out.push({ role: 'assistant', text: commentary });
      const calls = parseToolCalls(content).filter((c) => c.ok);
      awaiting = calls.length
        ? calls.map((c) => /** @type {{role: string, name: string, args: object, result?: string, isError?: boolean}} */ ({ role: 'tool', name: c.data.name, args: c.data.arguments || {} }))
        : [{ role: 'tool', name: 'tool call', args: {} }];
      out.push(...awaiting);
    }
  }
  return out;
}

// Settings the panel's Settings tab may change, with the values each accepts.
const oneOf = (...vals) => (v) => vals.includes(v);
const PANEL_SETTINGS = {
  approvalPolicy: oneOf('untrusted', 'on-request', 'never'),
  sandboxMode: oneOf('read-only', 'workspace-write', 'danger-full-access'),
  toolCalling: oneOf('auto', 'native', 'text'),
  maxSteps: (v) => Number.isInteger(v) && v >= 1 && v <= 500,
  temperature: (v) => typeof v === 'number' && v >= 0 && v <= 2,
  testCommand: (v) => typeof v === 'string' && v.length < 500,
  approveForMe: (v) => typeof v === 'boolean',
  useTerminal: (v) => typeof v === 'boolean',
  animateEdits: (v) => typeof v === 'boolean',
};
// Commands the panel's buttons may run.
const PANEL_COMMANDS = [
  'cortex.selectModel',
  'cortex.selectProfile',
  'cortex.showLogs',
  'cortex.showAuditLog',
  'cortex.buildCodeIndex',
  'cortex.benchmarkModels',
  'cortex.probeModel',
  'cortex.setup',
  'cortex.openWalkthrough',
  'cortex.generateCommitMessage',
  'cortex.revertLastTurn',
];

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
    const base = {
      host: c.get('host'),
      model: c.get('model'),
      fastModel: c.get('fastModel') || '',
      escalateModel: c.get('escalateModel') || '',
      testCommand: c.get('testCommand') || '',
      provider: c.get('provider') || 'ollama',
      apiKey: c.get('apiKey') || '',
      autoApprove: c.get('autoApprove'),
      approvalPolicy: c.get('approvalPolicy') || 'untrusted',
      autoApproveCommands: c.get('autoApproveCommands') || [],
      temperature: c.get('temperature'),
      maxSteps: c.get('maxSteps'),
      contextBudgetTokens: c.get('contextBudgetTokens'),
      numCtx: c.get('numCtx') || 0,
      toolCalling: c.get('toolCalling') || 'auto',
      webhookUrl: c.get('webhookUrl') || '',
      sandboxMode: c.get('sandboxMode') || (c.get('sandboxCommands') ? 'workspace-write' : 'danger-full-access'),
      sandboxAllowNetwork: !!c.get('sandboxAllowNetwork'),
      approveForMe: !!c.get('approveForMe'),
      useTerminal: c.get('useTerminal') !== false,
    };
    return applyProfile(base, c.get('profiles') || {}, this.activeProfile || c.get('activeProfile') || '');
  }

  get activeProfile() {
    return this.context.workspaceState.get('cortex.activeProfile', '');
  }

  set activeProfile(name) {
    this.context.workspaceState.update('cortex.activeProfile', name || '');
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
    const renderUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'render.js'));
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
  <header id="header">
    <div id="brand" title="Cortex"><span class="brand-name">Cortex</span><span id="lamp" class="lamp" title="Idle"></span></div>
    <button id="model-badge" title="Switch model"><span class="model-name">${escapeHtml(cfg.model)}</span></button>
    <span class="spacer"></span>
    <span id="context-meter" class="hidden" title="Context used"><span class="key">ctx</span><span class="meter-bars"><i></i><i></i><i></i><i></i><i></i></span><span class="meter-label"></span></span>
    <div class="header-actions">
      <button class="icon-btn" id="new-chat-btn" title="New chat" aria-label="New chat" data-icon="plus"></button>
      <button class="icon-btn" id="history-btn" title="History" aria-label="History" data-icon="history"></button>
      <button class="icon-btn" id="settings-btn" title="Settings and tools" aria-label="Settings" data-icon="sliders"></button>
    </div>
  </header>
  <div id="strip">
    <button class="seg" id="mode-pill" title="Act: make changes. Plan: investigate and propose only."><span class="key">mode</span><span class="pill-label">act</span></button>
    <button class="seg" id="approve-pill" title="When Cortex asks before changing things"><span class="key">approve</span><span class="pill-label">ask</span></button>
    <button class="seg" id="sandbox-seg" title="How much a command is allowed to touch"><span class="key">sandbox</span><span class="pill-label">full</span></button>
  </div>

  <div id="banner" class="hidden"></div>

  <main id="messages" aria-live="polite"></main>
  <button id="jump-bottom" class="hidden" title="Jump to latest" aria-label="Jump to latest">latest &#8595;</button>

  <footer id="composer-wrap">
    <div id="composer">
      <input type="file" id="image-input" accept="image/*" class="hidden">
      <div id="context-row"></div>
      <div id="prompt-line"><span class="prompt-mark" aria-hidden="true">&#9656;</span><textarea id="input" placeholder="describe a change" rows="1"></textarea></div>
      <div id="composer-row">
        <button class="tool-btn" id="attach-btn" title="Attach an image (needs a vision model)" aria-label="Attach image">img</button>
        <button class="tool-btn" id="mention-btn" title="Mention a file" aria-label="Mention a file">@file</button>
        <button class="tool-btn" id="slash-btn" title="Commands" aria-label="Commands">/cmd</button>
        <span class="spacer"></span>
        <button id="stop-btn" class="hidden" title="Stop (Esc)">Stop</button>
        <button id="send-btn" title="Send (Enter)">Send</button>
      </div>
    </div>
    <div id="statusbar"><span id="session-stats"></span></div>
  </footer>

  <div id="scrim" class="hidden"></div>
  <aside id="drawer" class="hidden" aria-label="Settings and tools">
    <div class="drawer-head">
      <div class="drawer-tabs" role="tablist">
        <button class="drawer-tab" data-tab="history" role="tab">History</button>
        <button class="drawer-tab" data-tab="settings" role="tab">Settings</button>
        <button class="drawer-tab" data-tab="approvals" role="tab">Permissions</button>
        <button class="drawer-tab" data-tab="memory" role="tab">Memory</button>
      </div>
      <button class="icon-btn" id="drawer-close" title="Close" aria-label="Close" data-icon="x"></button>
    </div>
    <div id="panel-history" class="panel hidden"></div>
    <div id="panel-settings" class="panel hidden"></div>
    <div id="panel-approvals" class="panel hidden"></div>
    <div id="panel-memory" class="panel hidden"></div>
  </aside>
</div>
<script nonce="${nonceVal}" src="${renderUri}"></script>
<script nonce="${nonceVal}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // What the panel is allowed to know about the configuration. Never the
  // API key: the webview has no use for it.
  publicConfig() {
    const cfg = this.cfg();
    const c = vscode.workspace.getConfiguration('cortex');
    return {
      model: cfg.model,
      fastModel: cfg.fastModel,
      provider: cfg.provider,
      host: cfg.host,
      autoApprove: !!cfg.autoApprove,
      approvalPolicy: cfg.approvalPolicy,
      sandboxMode: cfg.sandboxMode,
      maxSteps: cfg.maxSteps,
      temperature: cfg.temperature,
      toolCalling: cfg.toolCalling,
      testCommand: cfg.testCommand,
      approveForMe: cfg.approveForMe,
      useTerminal: cfg.useTerminal,
      animateEdits: c.get('animateEdits') !== false,
      profiles: Object.keys(c.get('profiles') || {}),
      activeProfile: this.activeProfile || c.get('activeProfile') || '',
    };
  }

  postConfig() {
    this.post({ type: 'config', ...this.publicConfig() });
  }

  // What the empty panel shows instead of a greeting: where you are, what
  // state the repository is in, and what you were last doing here.
  postWorkspaceInfo() {
    const root = this.root;
    if (!root) {
      this.post({ type: 'workspaceInfo', name: null });
      return;
    }
    const info = { type: 'workspaceInfo', name: require('path').basename(root), branch: null, changed: null, recent: [] };
    try {
      info.recent = listSessions(root)
        .filter((s) => s.id !== this.sessionId)
        .slice(0, 5);
    } catch {
      // no saved sessions
    }
    require('child_process').execFile('git', ['status', '--porcelain', '-b'], { cwd: root, timeout: 3000 }, (err, stdout) => {
      if (!err && stdout) {
        const lines = stdout.split('\n').filter(Boolean);
        const head = (lines[0] || '').replace(/^## /, '');
        info.branch = head.replace(/^No commits yet on /, '').split('...')[0] || null;
        info.changed = lines.length - 1;
      }
      this.post(info);
    });
  }

  // The file (and selection) the editor is on, shown as a chip above the
  // composer so it is clear what "this" refers to before sending.
  postEditorContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.post({ type: 'editorContext', file: null });
      return;
    }
    const sel = editor.selection;
    this.post({
      type: 'editorContext',
      file: vscode.workspace.asRelativePath(editor.document.uri),
      selection: sel.isEmpty ? null : { startLine: sel.start.line + 1, endLine: sel.end.line + 1 },
    });
  }

  async handleMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        const root = this.root;
        this.history = root ? loadHistory(root, this.sessionId) : [];
        this.postConfig();
        this.post({ type: 'mode', mode: this.mode });
        this.post({ type: 'commands', items: this.slashCommandList() });
        this.post({ type: 'restoreSession', id: this.sessionId, messages: simplifyHistoryForDisplay(this.history) });
        this.postEditorContext();
        this.postWorkspaceInfo();
        this.post({ type: 'autoApproveTools', tools: MUTATING_TOOLS, enabled: this.autoApproveTools });
        // The webview restarts on reload with a fresh, idle UI; the provider
        // may not be idle. Without this the two disagree and the panel shows
        // Stop with nothing running (or Send while a turn is live).
        this.post({ type: 'busy', value: this.busy });
        {
          const profilesCfg = vscode.workspace.getConfiguration('cortex').get('profiles') || {};
          this.post({ type: 'profiles', names: Object.keys(profilesCfg), active: this.activeProfile });
        }
        if (!root) {
          this.post({ type: 'banner', text: 'Open a folder/workspace to start using Cortex.' });
        }
        break;
      }
      case 'send':
        await this.onSend(msg.text, msg.image);
        break;
      case 'stop':
        this.cancelTurn();
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
      case 'selectProfile':
        await vscode.commands.executeCommand('cortex.selectProfile');
        break;
      case 'setProfile':
        this.activeProfile = msg.name || '';
        this.postConfig();
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
        this.postConfig();
        break;
      }
      case 'setSetting': {
        // Only the settings the panel offers, each checked against what it may hold.
        const allowed = PANEL_SETTINGS[msg.key];
        if (!allowed || !allowed(msg.value)) break;
        await vscode.workspace.getConfiguration('cortex').update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        this.postConfig();
        break;
      }
      case 'runCommand':
        if (PANEL_COMMANDS.includes(msg.command)) await vscode.commands.executeCommand(msg.command);
        else if (msg.command === 'openSettings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ItzAditya43.cortex');
        break;
      case 'listCommands':
        this.post({ type: 'commands', items: this.slashCommandList() });
        break;
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
      case 'forkSession':
        this.forkSession();
        break;
      case 'revert':
        await this.revertChange(msg.id);
        break;
      case 'rewindTo':
        await this.rewindTo(msg.checkpointId);
        break;
      case 'revertTurn':
        await this.revertLastTurn();
        break;
      case 'retryLast': {
        const last = this.rewindLastUserMessage();
        if (last) await this.onSend(last.text, last.image ? `data:image/png;base64,${last.image}` : undefined);
        break;
      }
      case 'editLast': {
        const last = this.rewindLastUserMessage();
        if (last) this.post({ type: 'insertText', text: last.text, replace: true });
        break;
      }
      case 'listFiles': {
        const root = this.root;
        this.post({ type: 'files', files: root ? workspaceFiles(root) : [] });
        break;
      }
      case 'copy':
        if (typeof msg.text === 'string') await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'openExternal':
        if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      default:
        break;
    }
  }

  // Ends the running turn, if any, and returns the panel to a usable state.
  // Open approval cards are resolved as declined: left pending, the turn
  // stayed parked on them forever, and a later click on Approve ran the
  // action anyway — after the user had pressed Stop.
  cancelTurn() {
    this.abortController?.abort();
    for (const [id, resolve] of this.pendingApprovals) {
      resolve(false);
      this.post({ type: 'approvalCancelled', id });
    }
    this.pendingApprovals.clear();
    // Hard recovery: if the flag is set but nothing is actually running (a
    // turn that threw during setup), aborting alone would leave the UI dead.
    this.busy = false;
    this.abortController = null;
    this.post({ type: 'busy', value: false });
  }

  sendSessions() {
    const root = this.root;
    const sessions = root ? listSessions(root) : [];
    this.post({ type: 'sessions', items: sessions, currentId: this.sessionId });
  }

  // Branches the current conversation into a brand-new session that starts
  // with an exact copy of the history so far — lets the user try a different
  // approach from this point without losing (or overwriting) the original
  // thread, mirroring Codex CLI's session fork.
  forkSession() {
    const root = this.root;
    if (!root) return;
    if (this.busy) this.cancelTurn();
    const forkedId = nonce().slice(0, 8);
    const historyCopy = JSON.parse(JSON.stringify(this.history));
    saveHistory(root, forkedId, historyCopy);
    touchSession(root, forkedId, historyCopy);
    this.sessionId = forkedId;
    this.history = historyCopy;
    this.revertable.clear();
    this.diffShownFor.clear();
    this.checkpoints = [];
    this.post({ type: 'restoreSession', id: forkedId, messages: simplifyHistoryForDisplay(this.history) });
    this.sendSessions();
  }

  loadSession(id) {
    const root = this.root;
    if (!root) return;
    // The running turn holds a reference to the old history array and saves
    // it under this.sessionId when it ends — it has to stop first, or it
    // writes the old conversation into the session just opened.
    if (this.busy) this.cancelTurn();
    this.sessionId = id;
    this.history = loadHistory(root, id);
    this.restoreCheckpoints();
    this.post({ type: 'restoreSession', id, messages: simplifyHistoryForDisplay(this.history) });
  }

  // Rehydrates undo history from disk so "revert this edit" still works
  // after a window reload or on a resumed session, not just within the
  // lifetime of one extension host process.
  restoreCheckpoints() {
    const root = this.root;
    if (!root) return;
    this.revertable.clear();
    this.checkpoints = [];
    const byTurn = new Map();
    for (const snap of loadSnapshots(root, this.sessionId)) {
      this.revertable.set(snap.callId, snap);
      const turnId = snap.turnId || snap.callId;
      if (!byTurn.has(turnId)) byTurn.set(turnId, { id: turnId, callIds: [], at: snap.at });
      byTurn.get(turnId).callIds.push(snap.callId);
    }
    this.checkpoints = [...byTurn.values()].sort((a, b) => a.at - b.at);
  }

  // Starts a fresh conversation. The previous one stays in History — New
  // Chat used to delete it from disk, so the History panel listed a chat
  // that opened empty. Only /clear (discard: true) throws it away.
  newChat({ discard = false } = {}) {
    const root = this.root;
    if (this.busy) this.cancelTurn();
    if (root) {
      if (discard) {
        deleteSession(root, this.sessionId);
        clearSession(root, this.sessionId);
      }
      clearTasks(root); // a new chat is a new task — don't inherit the old checklist
      pruneOldSessions(root);
    }
    this.sessionId = nonce().slice(0, 8);
    this.history = [];
    this.revertable.clear();
    this.diffShownFor.clear();
    this.checkpoints = [];
    this.post({ type: 'cleared' });
    this.postWorkspaceInfo();
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
      if (preview && preview.before !== undefined && !preview.files && !preview.renameFrom) {
        diffId = id;
        this.diffProvider.store(diffId, preview);
      }
      if (preview && preview.before !== undefined) this.diffShownFor.add(id);
      this.post({
        type: 'needsApproval',
        id,
        name,
        args,
        previewError: preview?.error || null,
        diffView: diffViewFor(preview),
        diffId,
      });
    });
  }

  async openDiff(diffId) {
    const entry = this.diffProvider.get(diffId);
    if (!entry) return;
    const leftUri = vscode.Uri.parse(`cortex-diff:${diffId}/before/${encodeURIComponent(entry.path)}`);
    const rightUri = vscode.Uri.parse(`cortex-diff:${diffId}/after/${encodeURIComponent(entry.path)}`);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${entry.path} (proposed change)`);
  }

  // Auto-opens the diff for a just-applied file change in the main editor
  // pane, reusing one tab (preview: true) and not stealing focus from the
  // chat input (preserveFocus: true) so a long agent run doesn't spam tabs
  // or yank the cursor away every step.
  async showDiffLive(snapshot, callId) {
    // Open showing the file as it was, then sweep to the new content, so the
    // edit is something you watch rather than a result that blinks into
    // existence. Both sides are virtual documents; the real file is
    // untouched by the animation.
    const animate = vscode.workspace.getConfiguration('cortex').get('animateEdits') !== false;
    this.diffProvider.store(callId, animate ? { ...snapshot, after: snapshot.before } : snapshot);

    const leftUri = this.diffProvider.uriFor(callId, 'before', snapshot.path);
    const rightUri = this.diffProvider.uriFor(callId, 'after', snapshot.path);
    try {
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${snapshot.path} (Cortex edit)`, {
        preview: true,
        preserveFocus: true,
      });
      if (animate) {
        // Deliberately not awaited: the turn continues while the sweep plays,
        // so the animation never slows the agent down.
        this.diffProvider.animate(callId, snapshot, {
          onFrame: (frame) => this.revealLine(rightUri, frame.activeLine),
        });
      }
    } catch {
      // best-effort — never let a display glitch break the agent turn
    }
  }

  // Keeps the sweep line in view, the way a person scrolling as they edit
  // would. Only acts on the diff editor itself, never the user's own tabs.
  revealLine(uri, line) {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (!editor) return;
    const range = new vscode.Range(line, 0, line, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  async revertChange(callId) {
    const root = this.root;
    const snapshot = this.revertable.get(callId);
    if (!root || !snapshot) return;
    try {
      const paths = restoreSnapshot(root, snapshot);
      this.revertable.delete(callId);
      deleteSnapshot(root, this.sessionId, callId);
      this.history.push({
        role: 'user',
        content: `TOOL_RESULT: SYSTEM NOTE — the user manually reverted your change to ${paths.join(', ')} back to its previous state. Take this into account if you continue working.`,
      });
      saveHistory(root, this.sessionId, this.history);
      this.post({ type: 'reverted', id: callId, path: snapshot.path });
    } catch (err) {
      this.post({ type: 'error', text: `Revert failed: ${err.message}` });
    }
  }

  slashCommandList() {
    const builtin = [
      { name: 'compact', description: 'Summarize the conversation to free up context' },
      { name: 'init', description: 'Write .cortexrules from this project\'s layout' },
      { name: 'clear', description: 'Start over, discarding this conversation' },
      { name: 'help', description: 'Show available commands' },
    ];
    const custom = listCustomCommands(this.root || undefined).map((c) => ({ name: c.name, description: c.description || 'Custom command', custom: true }));
    return [...builtin, ...custom];
  }

  // Claude-Code-style slash commands, intercepted before anything reaches
  // the model. Returns true if `text` was a recognized command (handled or
  // rejected with a message) so onSend can stop instead of treating it as a
  // normal chat message.
  async handleSlashCommand(text) {
    const trimmed = (text || '').trim();
    if (!trimmed.startsWith('/')) return false;
    const [cmd] = trimmed.slice(1).split(/\s+/);
    const root = this.root;

    // Only intercept a known, fixed set of commands. A message that merely
    // starts with "/" (a pasted file path, a shell command the user is
    // quoting, etc.) isn't one of these and should just go to the model —
    // erroring on it would be a surprising trap for ordinary chat text.
    if (!['clear', 'compact', 'init', 'help'].includes(cmd)) return false;

    switch (cmd) {
      case 'clear':
        this.newChat({ discard: true });
        return true;

      case 'compact':
        if (!root) {
          this.post({ type: 'banner', text: 'Open a folder/workspace first.' });
          return true;
        }
        await this.compactHistory();
        return true;

      case 'init':
        if (!root) {
          this.post({ type: 'banner', text: 'Open a folder/workspace first.' });
          return true;
        }
        await this.initProjectRules();
        return true;

      case 'help':
        this.post({
          type: 'final',
          text:
            '**Available commands:**\n\n' +
            '- `/clear` — start a new chat, discarding this session\'s history\n' +
            '- `/compact` — summarize the conversation so far to free up context, keeping the gist\n' +
            '- `/init` — scan this project and (re)generate `.cortexrules` with conventions the agent should follow\n' +
            '- `/help` — show this message' +
            (listCustomCommands(root).length
              ? '\n\n**Your commands** (`.cortex/commands/*.md`):\n\n' +
                listCustomCommands(root)
                  .map((c) => `- \`/${c.name}\`${c.description ? ` — ${c.description}` : ''}`)
                  .join('\n')
              : '\n\nAdd your own: a Markdown file at `.cortex/commands/<name>.md` becomes `/<name>`; `$ARGUMENTS` in it is replaced by what you type after the command.'),
          steps: 0,
          elapsedMs: 0,
        });
        return true;

      default:
        return false; // unreachable given the guard above, kept for exhaustiveness
    }
  }

  // Summarizes the current session's history into a single note, replacing
  // the raw transcript — same idea as Claude Code's /compact: keeps working
  // in the same session without the context budget silently dropping older
  // turns (contextManager.cjs would otherwise just truncate from the front).
  async compactHistory() {
    const root = this.root;
    if (!root || this.history.length === 0) {
      this.post({ type: 'banner', text: 'Nothing to compact yet.' });
      return;
    }
    this.post({ type: 'busy', value: true });
    const cfg = this.cfg();
    try {
      const before = this.history.length;
      const chatOpts = { host: cfg.host, provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model };
      const budgetTokens = await resolveContextBudget({ ...chatOpts, configured: cfg.contextBudgetTokens });
      const res = await summarizeHistory({ history: this.history, chatOpts, budgetTokens, keepTail: false, logFn: (m) => logger.log(m) });
      if (!res.ok) throw new Error(res.reason);
      saveHistory(root, this.sessionId, this.history);
      this.post({
        type: 'final',
        text: `Compacted ${before} message(s) into a summary. Continuing from here.\n\n---\n${res.summary}`,
        steps: 0,
        elapsedMs: 0,
      });
    } catch (err) {
      this.post({ type: 'error', text: `/compact failed: ${err.message}` });
    } finally {
      this.post({ type: 'busy', value: false });
    }
  }

  // Deterministic (no model call) project scan that writes/refreshes
  // .cortexrules — analogous to Claude Code's /init generating CLAUDE.md,
  // but done directly from package.json/file layout rather than an agent
  // turn, so it's instant and doesn't depend on model quality.
  async initProjectRules() {
    const root = this.root;
    this.post({ type: 'busy', value: true });
    try {
      const rules = generateProjectRules(root);
      // Written directly: this is the user's own /init, not a model edit, so
      // the "read before overwriting" guard on write_file does not apply.
      require('fs').writeFileSync(require('path').join(root, '.cortexrules'), rules);
      markAgentWrite(root, '.cortexrules');
      this.post({ type: 'final', text: `Wrote \`.cortexrules\`:\n\n\`\`\`markdown\n${rules}\n\`\`\``, steps: 0, elapsedMs: 0 });
    } catch (err) {
      this.post({ type: 'error', text: `/init failed: ${err.message}` });
    } finally {
      this.post({ type: 'busy', value: false });
    }
  }

  async onSend(text, image) {
    if ((!text || !text.trim()) && !image) return;
    const root = this.root;
    if (!root) {
      this.post({ type: 'banner', text: 'Open a folder/workspace to start using Cortex.' });
      return;
    }
    if (this.busy) {
      // Silently dropping the message is what made a stuck busy flag look
      // like a dead extension: the user types, nothing happens, no reason
      // given. Say so, and offer the way out.
      this.post({
        type: 'error',
        text: 'Cortex is still working on the previous message. Press Stop to cancel it, then try again.',
      });
      return;
    }
    this.post({ type: 'userMessage', text, image });
    if (await this.handleSlashCommand(text)) return;
    // A custom command (.cortex/commands/<name>.md) stands for the prompt it holds.
    const custom = expandCustomCommand(text, root);
    if (custom) text = custom.prompt;

    this.busy = true;
    this.abortController = new AbortController();
    this.post({ type: 'busy', value: true });

    try {
      await this.runTurnForMessage(text, image, root);
    } catch (err) {
      // Anything that escapes turn setup (config, memory, audit, editor
      // access) used to leave busy stuck true with no message at all.
      logger.log(`turn failed before it started: ${err.stack || err.message}`);
      this.post({ type: 'error', text: `Could not start the turn: ${err.message}` });
    } finally {
      this.busy = false;
      this.abortController = null;
      this.post({ type: 'busy', value: false });
      this.postWorkspaceInfo();
    }
  }

  // The body of a turn. Split out so onSend's finally always runs, whatever
  // happens in here.
  async runTurnForMessage(text, image, root) {
    // Pinned for the whole turn: if the user switches chats mid-turn, the
    // turn must finish writing into the conversation it belongs to.
    const sessionId = this.sessionId;
    const history = this.history;
    // Once the user has moved to another chat, this turn's events belong to
    // a conversation that is no longer on screen.
    const post = (msg) => {
      if (this.sessionId === sessionId) this.post(msg);
    };

    // Ollama's /api/chat accepts an `images` field (base64, no data: prefix)
    // on a message for vision-capable models (llava, qwen2.5-vl, etc.) —
    // history messages pass through buildContextMessages/provider.cjs
    // untouched, so attaching it here is all that's needed for the rest of
    // the pipeline to carry it through.
    // @path mentions attach those files to the message the model sees; the
    // panel keeps showing what was typed.
    const mentioned = expandMentions(text || '', root);
    if (mentioned.attached.length) post({ type: 'attached', paths: mentioned.attached });
    if (mentioned.missing.length) post({ type: 'notice', text: `Not found, not attached: ${mentioned.missing.join(', ')}` });
    const userMsg = { role: 'user', content: mentioned.content || '(see attached image)' };
    if (image) userMsg.images = [image.replace(/^data:[^,]+,/, '')];
    history.push(userMsg);

    const cfg = this.cfg();
    logger.log(
      `session=${sessionId} mode=${this.mode} model=${cfg.model} user message (${(text || '').length} chars${image ? ' + image' : ''}): ${(text || '').slice(0, 120)}`
    );
    let memoryNotes = loadMemoryNotes(root);
    if (cfg.provider !== 'openai-compatible') {
      try {
        const relevant = await retrieveRelevantNotes(root, cfg.host, text, 8);
        if (relevant) memoryNotes = relevant;
      } catch {
        // fall back to the full flat notes already loaded above
      }
    }
    const editor = vscode.window.activeTextEditor;
    const openFile = editor ? vscode.workspace.asRelativePath(editor.document.uri) : undefined;
    const selection =
      editor && !editor.selection.isEmpty
        ? {
            text: editor.document.getText(editor.selection),
            file: openFile,
            startLine: editor.selection.start.line + 1,
            endLine: editor.selection.end.line + 1,
          }
        : undefined;
    const planMode = this.mode === 'plan';
    const startedAt = Date.now();
    const turnCallIds = [];
    const callInfo = new Map(); // callId -> {name, args, autoApproved}
    audit.turnStarted(root, {
      sessionId,
      model: cfg.model,
      prompt: text,
      mode: this.mode,
      approvalPolicy: cfg.approvalPolicy,
      sandboxMode: cfg.sandboxMode,
    });
    audit.prune(root);
    const turnId = nonce().slice(0, 8); // groups this turn's snapshots so a whole turn can be reverted after a reload
    // Remember where this turn begins so a later rewind can cut the
    // conversation back to exactly this point.
    this.turnStartIndexes = this.turnStartIndexes || {};
    this.turnStartIndexes[turnId] = history.length - 1;

    try {
      await runTurn({
        history,
        root,
        host: cfg.host,
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model: cfg.model,
        fastModel: cfg.fastModel,
        escalateModel: cfg.escalateModel,
        testCommand: cfg.testCommand,
        onTestRun: (cmd, result, failed) => post({ type: 'testRun', command: cmd, result, failed }),
        temperature: cfg.temperature,
        maxSteps: cfg.maxSteps,
        contextBudgetTokens: cfg.contextBudgetTokens,
        numCtx: cfg.numCtx,
        toolCalling: cfg.toolCalling,
        memoryNotes,
        openFile,
        selection,
        planMode,
        signal: this.abortController.signal,
        ctx: {
          host: cfg.host,
          webhookUrl: cfg.webhookUrl,
          sandboxMode: cfg.sandboxMode,
          sandboxAllowNetwork: cfg.sandboxAllowNetwork,
          useTerminal: cfg.useTerminal,
          delegateConfig: {
            host: cfg.host,
            provider: cfg.provider,
            apiKey: cfg.apiKey,
            model: cfg.model,
            fastModel: cfg.fastModel,
            temperature: cfg.temperature,
            maxSteps: cfg.maxSteps,
            contextBudgetTokens: cfg.contextBudgetTokens,
            toolCalling: cfg.toolCalling,
          },
          onSubTaskEvent: (kind, payload) => post({ type: `subTask${kind === 'toolCall' ? 'Call' : 'Result'}`, ...payload }),
        },
        onLog: (message) => logger.log(message),
        onToken: (t) => {
          post({ type: 'token', text: t });
        },
        onThinking: (t) => {
          post({ type: 'thinking', text: t });
        },
        onStep: (step, model) => {
          post({ type: 'step', step, model });
        },
        onRecovery: (_kind, message) => {
          post({ type: 'notice', text: message });
        },
        onUsage: (u) => {
          post({ type: 'usage', ...u, contextBudget: u.contextBudget || cfg.contextBudgetTokens });
        },
        onToolCall: (name, args, callId) => {
          // Keyed by call: parallel read batches report results out of order,
          // so "the last tool called" mislabelled them in the audit log.
          callInfo.set(callId, { name, args, autoApproved: undefined });
          post({ type: 'toolCall', name, args, id: callId, readOnly: !!tools[name]?.readOnly });
        },
        requestApproval: async (name, args, callId) => {
          if (
            shouldAutoApprove(name, {
              autoApprove: cfg.autoApprove,
              autoApproveTools: this.autoApproveTools,
              autoApproveCommands: cfg.autoApproveCommands,
              commandArg: tools[name]?.kind === 'command' ? args.command : undefined,
              approvalPolicy: cfg.approvalPolicy,
              sandboxMode: cfg.sandboxMode,
              toolKind: tools[name]?.kind,
            })
          ) {
            if (callInfo.has(callId)) callInfo.get(callId).autoApproved = true;
            return true;
          }
          // Reaching here with a dangerous command means the safety floor
          // refused to auto-approve it — worth recording even if the user
          // then approves it by hand.
          if (tools[name]?.kind === 'command' && args.command) {
            const { classifyCommand } = require('./dangerousCommands.cjs');
            const risk = classifyCommand(args.command);
            if (risk.dangerous) {
              audit.blocked(root, { sessionId, tool: name, reason: risk.why, detail: `${args.command} — ${risk.why}` });
              post({ type: 'dangerWarning', id: callId, why: risk.why });
            }
          }
          if (cfg.approveForMe) {
            const review = await reviewAction(
              { host: cfg.host, provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.fastModel || cfg.model },
              name,
              args,
              text
            );
            post({ type: 'autoReview', id: callId, safe: review.safe, reason: review.reason });
            if (review.safe) return true;
          }
          return this.requestApproval(name, args, callId);
        },
        onToolResult: (result, isError, callId, snapshot) => {
          const info = (callId && callInfo.get(callId)) || {};
          audit.toolRan(root, {
            sessionId,
            tool: info.name,
            args: info.args,
            approved: info.autoApproved,
            isError,
            resultPreview: result,
          });
          if (snapshot) {
            audit.fileChanged(root, { sessionId, file: snapshot.path, before: snapshot.before, after: snapshot.after });
          }
          if (snapshot && callId) {
            this.revertable.set(callId, snapshot);
            turnCallIds.push(callId);
            saveSnapshot(root, sessionId, callId, snapshot, turnId);
          }
          const alreadyShown = callId && this.diffShownFor.has(callId);
          post({
            type: 'toolResult',
            result,
            isError,
            id: callId,
            revertAvailable: !!snapshot,
            diffView: !alreadyShown && snapshot ? diffViewFor(snapshot) : null,
          });
          // Live preview: pop the diff for every successful file write/edit
          // straight into the editor pane as it happens, instead of making
          // the user hunt for it in the chat panel afterwards.
          if (snapshot && callId && !isError && !snapshot.files && !snapshot.renameFrom) this.showDiffLive(snapshot, callId);
        },
        onFinal: (finalText, steps) => {
          post({ type: 'final', text: finalText, steps, elapsedMs: Date.now() - startedAt });
        },
        onError: (message) => {
          post({ type: 'error', text: message });
        },
      });
    } catch (err) {
      post({ type: 'error', text: err.message });
    } finally {
      if (turnCallIds.length > 0) {
        this.checkpoints = this.checkpoints || [];
        this.checkpoints.push({ id: turnId, callIds: turnCallIds, at: Date.now() });
        post({ type: 'checkpointCreated', id: turnId, callIds: turnCallIds, count: turnCallIds.length });
      }
      saveHistory(root, sessionId, history);
      touchSession(root, sessionId, history);
    }
  }

  // Takes the conversation back to just before the last message the user
  // sent, undoing the file changes that turn made — the shared first half of
  // Retry and Edit. Redoing a turn on top of its own half-applied edits would
  // give the model a workspace that matches neither attempt.
  // Returns what was sent (text without attachments, raw image), or null.
  rewindLastUserMessage() {
    const root = this.root;
    if (!root || this.busy) return null;
    let idx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const c = String(this.history[i].content || '');
      if (this.history[i].role === 'user' && !c.startsWith('TOOL_RESULT') && !c.startsWith('[Earlier conversation summary]')) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return null;
    const msg = this.history[idx];

    const restored = new Set();
    const starts = this.turnStartIndexes || {};
    const undone = (this.checkpoints || []).filter((c) => (starts[c.id] ?? -1) >= idx);
    for (const cp of [...undone].reverse()) {
      for (const callId of [...cp.callIds].reverse()) {
        const snap = this.revertable.get(callId);
        if (!snap) continue;
        try {
          for (const p of restoreSnapshot(root, snap)) restored.add(p);
        } catch (err) {
          this.post({ type: 'error', text: `Could not undo ${snap.path}: ${err.message}` });
        }
        this.revertable.delete(callId);
        deleteSnapshot(root, this.sessionId, callId);
      }
    }
    this.checkpoints = (this.checkpoints || []).filter((c) => !undone.includes(c));
    for (const [turnId, start] of Object.entries(starts)) if (start >= idx) delete starts[turnId];

    this.history = this.history.slice(0, idx);
    saveHistory(root, this.sessionId, this.history);
    if (this.history.length) touchSession(root, this.sessionId, this.history);
    this.post({ type: 'restoreSession', id: this.sessionId, messages: simplifyHistoryForDisplay(this.history) });
    if (restored.size) this.post({ type: 'notice', text: `Undid that turn's changes to ${[...restored].join(', ')}` });
    return { text: stripAttachments(msg.content), image: msg.images?.[0] };
  }

  // Rewinds the session to an earlier checkpoint: restores the files that
  // turn (and everything after it) changed, and truncates the conversation
  // back to that point. This is the "edit a message from 10 steps back and
  // continue from there" flow — without it, checkpoints only ever let you
  // undo the very last thing.
  async rewindTo(checkpointId) {
    const root = this.root;
    if (!root || !this.checkpoints) return;
    const idx = this.checkpoints.findIndex((c) => c.id === checkpointId);
    if (idx === -1) return;

    // Walk newest -> oldest so the OLDEST snapshot of each path wins, which
    // is the state as it was before the whole rewound range.
    const doomed = this.checkpoints.slice(idx);
    const restored = new Set();
    for (let c = doomed.length - 1; c >= 0; c--) {
      const cp = doomed[c];
      for (let i = cp.callIds.length - 1; i >= 0; i--) {
        const callId = cp.callIds[i];
        const snap = this.revertable.get(callId);
        if (!snap) continue;
        try {
          for (const p of restoreSnapshot(root, snap)) restored.add(p);
          this.revertable.delete(callId);
          deleteSnapshot(root, this.sessionId, callId);
        } catch (err) {
          this.post({ type: 'error', text: `Rewind failed for ${snap.path}: ${err.message}` });
        }
      }
    }
    this.checkpoints = this.checkpoints.slice(0, idx);

    // Drop the conversation from the rewound turn onward, so the model isn't
    // told about work whose files no longer exist.
    const cutoff = this.turnStartIndexes?.[checkpointId];
    if (typeof cutoff === 'number') this.history = this.history.slice(0, cutoff);
    saveHistory(root, this.sessionId, this.history);

    this.post({
      type: 'rewound',
      checkpointId,
      paths: [...restored],
      messages: simplifyHistoryForDisplay(this.history),
    });
  }

  // Reverts every file change made during the most recent turn (not just one
  // file), applying snapshots in reverse order so earlier writes to the same
  // path aren't clobbered by a later one still marked "revertable".
  async revertLastTurn() {
    const root = this.root;
    if (!root || !this.checkpoints || this.checkpoints.length === 0) return;
    const cp = this.checkpoints.pop();
    const seen = new Set();
    // Newest first, so a file changed twice ends at its state from before
    // the turn rather than from between the two changes.
    for (let i = cp.callIds.length - 1; i >= 0; i--) {
      const callId = cp.callIds[i];
      const snapshot = this.revertable.get(callId);
      if (!snapshot) continue;
      try {
        for (const p of restoreSnapshot(root, snapshot)) seen.add(p);
        this.revertable.delete(callId);
        deleteSnapshot(root, this.sessionId, callId);
      } catch (err) {
        this.post({ type: 'error', text: `Revert failed for ${snapshot.path}: ${err.message}` });
      }
    }
    this.history.push({
      role: 'user',
      content: `TOOL_RESULT: SYSTEM NOTE — the user reverted your entire last turn (${seen.size} file(s) restored). Take this into account if you continue working.`,
    });
    saveHistory(root, this.sessionId, this.history);
    this.post({ type: 'turnReverted', paths: [...seen] });
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
    this.animating_ = new Set();
  }

  store(id, entry) {
    this.store_.set(id, entry);
  }

  get(id) {
    return this.store_.get(id);
  }

  uriFor(id, side, filePath) {
    return vscode.Uri.parse(`cortex-diff:${id}/${side}/${encodeURIComponent(filePath)}`);
  }

  /** Swaps in new right-hand content and tells VS Code to re-render the diff. */
  setRight(id, filePath, content) {
    const entry = this.store_.get(id);
    if (!entry) return;
    this.store_.set(id, { ...entry, after: content });
    // Without firing this, the virtual document is only ever read once and
    // the diff never updates — which is why nothing appeared to happen.
    this._onDidChange.fire(this.uriFor(id, 'after', filePath));
  }

  /**
   * Plays the edit as a top-down sweep over the virtual document, so the
   * change is watched rather than just appearing. The file on disk is never
   * touched by this — the write already happened, or happens after.
   * @param {string} id
   * @param {{path: string, before?: string, after?: string}} snapshot
   * @param {{onFrame?: (frame: {content: string, activeLine: number}) => void}} [opts]
   */
  async animate(id, snapshot, { onFrame } = {}) {
    if (this.animating_.has(id)) return;
    this.animating_.add(id);
    try {
      const { frames } = buildEditAnimation(snapshot.before || '', snapshot.after || '');
      if (frames.length <= 1) {
        this.setRight(id, snapshot.path, snapshot.after || '');
        return;
      }
      for (const frame of frames) {
        if (!this.store_.has(id)) return; // the tab was closed mid-sweep
        this.setRight(id, snapshot.path, frame.content);
        onFrame?.(frame);
        if (frame.delayMs > 0) await new Promise((r) => setTimeout(r, frame.delayMs));
      }
      this.setRight(id, snapshot.path, snapshot.after || '');
    } finally {
      this.animating_.delete(id);
    }
  }

  provideTextDocumentContent(uri) {
    const parts = uri.path.split('/').filter(Boolean);
    const [id, which] = parts;
    const entry = this.store_.get(id);
    if (!entry) return '';
    return which === 'before' ? entry.before || '' : entry.after || '';
  }
}

module.exports = { ChatViewProvider, DiffContentProvider, listModels, simplifyHistoryForDisplay, diffViewFor };
