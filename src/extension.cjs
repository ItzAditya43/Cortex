'use strict';

const vscode = require('vscode');
const { ChatViewProvider, DiffContentProvider } = require('./chatViewProvider.cjs');
const { listModels } = require('./provider.cjs');
const { startScheduler, stopScheduler } = require('./scheduler.cjs');
const { startMcpServers, stopMcpServers } = require('./mcpManager.cjs');
const logger = require('./logger.cjs');

function activate(context) {
  logger.init();
  logger.log('Cortex activated.');
  context.subscriptions.push({
    dispose: () => {
      logger.log('Cortex deactivating.');
      stopMcpServers();
      stopScheduler();
    },
  });

  const initialCfg = vscode.workspace.getConfiguration('cortex');
  startMcpServers(initialCfg.get('mcpServers') || [], (m) => logger.log(m));
  startScheduler({
    getSchedules: () => vscode.workspace.getConfiguration('cortex').get('schedules') || [],
    getRunConfig: () => {
      const c = vscode.workspace.getConfiguration('cortex');
      return {
        host: c.get('host'),
        provider: c.get('provider') || 'ollama',
        apiKey: c.get('apiKey') || '',
        model: c.get('model'),
        fastModel: c.get('fastModel') || '',
        temperature: c.get('temperature'),
        maxSteps: c.get('maxSteps'),
        contextBudgetTokens: c.get('contextBudgetTokens'),
      };
    },
    getRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    onResult: (schedule, text) => {
      logger.log(`schedule "${schedule.name}" finished: ${text.slice(0, 200)}`);
      vscode.window.showInformationMessage(`Cortex schedule "${schedule.name}" finished — see logs for details.`);
    },
    onError: (schedule, message) => logger.log(`schedule "${schedule.name}" error: ${message}`),
    logFn: (m) => logger.log(m),
  });

  const diffProvider = new DiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('cortex-diff', diffProvider)
  );

  const provider = new ChatViewProvider(context, diffProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  function refreshStatusBar() {
    const model = vscode.workspace.getConfiguration('cortex').get('model');
    statusBar.text = `$(hubot) Ollama: ${model}`;
    statusBar.tooltip = 'Cortex — click to open chat';
    statusBar.command = 'cortex.openChat';
    statusBar.show();
  }
  refreshStatusBar();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cortex.model')) refreshStatusBar();
      if (e.affectsConfiguration('cortex.model') || e.affectsConfiguration('cortex.autoApprove')) {
        provider.post({ type: 'config', ...provider.cfg() });
      }
      if (e.affectsConfiguration('cortex.mcpServers')) {
        const c = vscode.workspace.getConfiguration('cortex');
        startMcpServers(c.get('mcpServers') || [], (m) => logger.log(m));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.newChat', () => {
      provider.newChat();
      vscode.commands.executeCommand('workbench.view.extension.cortex');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.cortex');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.toggleAutoApprove', async () => {
      const c = vscode.workspace.getConfiguration('cortex');
      const current = c.get('autoApprove');
      await c.update('autoApprove', !current, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Cortex: auto-approve ${!current ? 'enabled' : 'disabled'}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.showLogs', () => {
      logger.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.revertLastTurn', async () => {
      await provider.revertLastTurn();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.selectModel', async () => {
      const c = vscode.workspace.getConfiguration('cortex');
      const host = c.get('host');
      const provider = c.get('provider') || 'ollama';
      const apiKey = c.get('apiKey') || '';
      let models;
      try {
        models = await listModels({ host, provider, apiKey });
      } catch (err) {
        const typed = await vscode.window.showInputBox({
          prompt: `Could not list models from ${host} (${err.message}). Enter a model name manually:`,
          value: c.get('model'),
        });
        if (typed) await c.update('model', typed, vscode.ConfigurationTarget.Global);
        return;
      }
      if (models.length === 0) {
        vscode.window.showWarningMessage(
          `No models found on ${host}. Pull one first, e.g. "ollama pull qwen2.5-coder".`
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m.name, description: formatSize(m.size) })),
        { placeHolder: 'Select an Ollama model' }
      );
      if (picked) {
        await c.update('model', picked.label, vscode.ConfigurationTarget.Global);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.selectProfile', async () => {
      const c = vscode.workspace.getConfiguration('cortex');
      const profiles = c.get('profiles') || {};
      const names = Object.keys(profiles);
      if (names.length === 0) {
        vscode.window.showInformationMessage(
          'No profiles configured. Add entries under the "cortex.profiles" setting (e.g. {"fast": {"model": "...", "approvalPolicy": "on-request"}}).'
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(['(none — use base settings)', ...names], {
        placeHolder: 'Select a Cortex profile',
      });
      if (picked === undefined) return;
      provider.activeProfile = picked.startsWith('(none') ? '' : picked;
      provider.post({ type: 'config', ...provider.cfg() });
      vscode.window.showInformationMessage(`Cortex profile: ${provider.activeProfile || '(none)'}`);
    })
  );
}

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

function deactivate() {}

module.exports = { activate, deactivate };
