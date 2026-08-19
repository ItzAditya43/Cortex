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
const { listModels, chat } = require('./provider.cjs');
const { shouldAutoApprove } = require('./permissions.cjs');
const { retrieveRelevantNotes } = require('./semanticMemory.cjs');
const { reviewAction } = require('./approveForMe.cjs');
const { applyProfile } = require('./profiles.cjs');
const { generateProjectRules } = require('./initRules.cjs');
const logger = require('./logger.cjs');

const MUTATING_TOOLS = Object.entries(tools)
  .filter(([, t]) => t.confirm)
  .map(([name]) => name);

// Inline SVG line-icons (feather-icons style) for the topbar buttons — kept
// as plain vector paths rather than emoji so they render consistently
// (weight, color, alignment) across OSes instead of relying on the
// platform's emoji font.
const ICON_SVG_ATTRS = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICON_MEMORY = `<svg ${ICON_SVG_ATTRS}><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`;
const ICON_HISTORY = `<svg ${ICON_SVG_ATTRS}><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 16 14"></polyline></svg>`;
const ICON_APPROVALS = `<svg ${ICON_SVG_ATTRS}><polyline points="8 11 11 14 17 6"></polyline><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"></path></svg>`;

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
    const base = {
      host: c.get('host'),
      model: c.get('model'),
      fastModel: c.get('fastModel') || '',
      provider: c.get('provider') || 'ollama',
      apiKey: c.get('apiKey') || '',
      autoApprove: c.get('autoApprove'),
      approvalPolicy: c.get('approvalPolicy') || 'untrusted',
      autoApproveCommands: c.get('autoApproveCommands') || [],
      temperature: c.get('temperature'),
      maxSteps: c.get('maxSteps'),
      contextBudgetTokens: c.get('contextBudgetTokens'),
      webhookUrl: c.get('webhookUrl') || '',
      sandboxMode: c.get('sandboxMode') || (c.get('sandboxCommands') ? 'workspace-write' : 'danger-full-access'),
      sandboxAllowNetwork: !!c.get('sandboxAllowNetwork'),
      approveForMe: !!c.get('approveForMe'),
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
    <button id="memory-btn" title="Memory" aria-label="Memory">${ICON_MEMORY}</button>
    <button id="history-btn" title="History" aria-label="History">${ICON_HISTORY}</button>
    <button id="approvals-btn" title="Per-action auto-approve" aria-label="Auto-approve settings">${ICON_APPROVALS}</button>
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
      case 'selectProfile':
        await vscode.commands.executeCommand('cortex.selectProfile');
        break;
      case 'setProfile':
        this.activeProfile = msg.name || '';
        this.post({ type: 'config', ...this.cfg() });
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
      case 'forkSession':
        this.forkSession();
        break;
      case 'revert':
        await this.revertChange(msg.id);
        break;
      case 'revertTurn':
        await this.revertLastTurn();
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

  // Branches the current conversation into a brand-new session that starts
  // with an exact copy of the history so far — lets the user try a different
  // approach from this point without losing (or overwriting) the original
  // thread, mirroring Codex CLI's session fork.
  forkSession() {
    const root = this.root;
    if (!root) return;
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
    this.checkpoints = [];
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

  // Auto-opens the diff for a just-applied file change in the main editor
  // pane, reusing one tab (preview: true) and not stealing focus from the
  // chat input (preserveFocus: true) so a long agent run doesn't spam tabs
  // or yank the cursor away every step.
  async showDiffLive(snapshot, callId) {
    this.diffProvider.store(callId, snapshot);
    const leftUri = vscode.Uri.parse(`cortex-diff:${callId}/before/${encodeURIComponent(snapshot.path)}`);
    const rightUri = vscode.Uri.parse(`cortex-diff:${callId}/after/${encodeURIComponent(snapshot.path)}`);
    try {
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${snapshot.path} (Cortex edit)`, {
        preview: true,
        preserveFocus: true,
      });
    } catch {
      // best-effort — never let a display glitch break the agent turn
    }
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

  // Claude-Code-style slash commands, intercepted before anything reaches
  // the model. Returns true if `text` was a recognized command (handled or
  // rejected with a message) so onSend can stop instead of treating it as a
  // normal chat message.
  async handleSlashCommand(text) {
    const trimmed = text.trim();
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
        this.newChat();
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
            '- `/help` — show this message',
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
    const transcript = this.history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n').slice(0, 20_000);
    try {
      const summary = await chat({
        host: cfg.host,
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content:
              'Summarize the following coding-agent conversation into a concise brief a fresh agent could resume from: what the user asked for, what was already done (files touched, decisions made), and what remains. Plain text, no preamble.',
          },
          { role: 'user', content: transcript },
        ],
      });
      const before = this.history.length;
      this.history = [{ role: 'user', content: `[Earlier conversation summary]\n${summary.trim()}` }];
      saveHistory(root, this.sessionId, this.history);
      this.post({
        type: 'final',
        text: `Compacted ${before} message(s) into a summary. Continuing from here.\n\n---\n${summary.trim()}`,
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
      tools.write_file.run({ path: '.cortexrules', content: rules }, root);
      this.post({ type: 'final', text: `Wrote \`.cortexrules\`:\n\n\`\`\`markdown\n${rules}\n\`\`\``, steps: 0, elapsedMs: 0 });
    } catch (err) {
      this.post({ type: 'error', text: `/init failed: ${err.message}` });
    } finally {
      this.post({ type: 'busy', value: false });
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
    this.post({ type: 'userMessage', text });
    if (await this.handleSlashCommand(text)) return;

    this.busy = true;
    this.abortController = new AbortController();
    this.post({ type: 'busy', value: true });

    this.history.push({ role: 'user', content: text });

    const cfg = this.cfg();
    logger.log(
      `session=${this.sessionId} mode=${this.mode} model=${cfg.model} user message (${text.length} chars): ${text.slice(0, 120)}`
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

    try {
      await runTurn({
        history: this.history,
        root,
        host: cfg.host,
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model: cfg.model,
        fastModel: cfg.fastModel,
        temperature: cfg.temperature,
        maxSteps: cfg.maxSteps,
        contextBudgetTokens: cfg.contextBudgetTokens,
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
          delegateConfig: {
            host: cfg.host,
            provider: cfg.provider,
            apiKey: cfg.apiKey,
            model: cfg.model,
            fastModel: cfg.fastModel,
            temperature: cfg.temperature,
            maxSteps: cfg.maxSteps,
            contextBudgetTokens: cfg.contextBudgetTokens,
          },
          onSubTaskEvent: (kind, payload) => this.post({ type: `subTask${kind === 'toolCall' ? 'Call' : 'Result'}`, ...payload }),
        },
        onLog: (message) => logger.log(message),
        onToken: (t) => {
          this.post({ type: 'token', text: t });
        },
        onToolCall: (name, args, callId) => {
          this.post({ type: 'toolCall', name, args, id: callId });
        },
        requestApproval: async (name, args, callId) => {
          if (
            shouldAutoApprove(name, {
              autoApprove: cfg.autoApprove,
              autoApproveTools: this.autoApproveTools,
              autoApproveCommands: cfg.autoApproveCommands,
              commandArg: name === 'run_command' ? args.command : undefined,
              approvalPolicy: cfg.approvalPolicy,
              sandboxMode: cfg.sandboxMode,
              toolKind: tools[name]?.kind,
            })
          )
            return true;
          if (cfg.approveForMe) {
            const review = await reviewAction(
              { host: cfg.host, provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.fastModel || cfg.model },
              name,
              args,
              text
            );
            this.post({ type: 'autoReview', id: callId, safe: review.safe, reason: review.reason });
            if (review.safe) return true;
          }
          return this.requestApproval(name, args, callId);
        },
        onToolResult: (result, isError, callId, snapshot) => {
          if (snapshot && callId) {
            this.revertable.set(callId, snapshot);
            turnCallIds.push(callId);
          }
          const alreadyShown = callId && this.diffShownFor.has(callId);
          this.post({
            type: 'toolResult',
            result,
            isError,
            id: callId,
            revertAvailable: !!snapshot,
            diff: !alreadyShown && snapshot ? { path: snapshot.path, before: snapshot.before, after: snapshot.after } : null,
          });
          // Live preview: pop the diff for every successful file write/edit
          // straight into the editor pane as it happens, instead of making
          // the user hunt for it in the chat panel afterwards.
          if (snapshot && callId && !isError) this.showDiffLive(snapshot, callId);
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
      if (turnCallIds.length > 0) {
        this.checkpoints = this.checkpoints || [];
        this.checkpoints.push({ id: nonce().slice(0, 8), callIds: turnCallIds, at: Date.now() });
        this.post({ type: 'checkpointCreated', callIds: turnCallIds, count: turnCallIds.length });
      }
      saveHistory(root, this.sessionId, this.history);
      touchSession(root, this.sessionId, this.history);
      this.busy = false;
      this.abortController = null;
      this.post({ type: 'busy', value: false });
    }
  }

  // Reverts every file change made during the most recent turn (not just one
  // file), applying snapshots in reverse order so earlier writes to the same
  // path aren't clobbered by a later one still marked "revertable".
  async revertLastTurn() {
    const root = this.root;
    if (!root || !this.checkpoints || this.checkpoints.length === 0) return;
    const cp = this.checkpoints.pop();
    const seen = new Set();
    for (let i = cp.callIds.length - 1; i >= 0; i--) {
      const callId = cp.callIds[i];
      const snapshot = this.revertable.get(callId);
      if (!snapshot || seen.has(snapshot.path)) continue;
      seen.add(snapshot.path);
      try {
        tools.write_file.run({ path: snapshot.path, content: snapshot.before }, root);
        this.revertable.delete(callId);
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
