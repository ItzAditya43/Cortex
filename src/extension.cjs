'use strict';

const vscode = require('vscode');
const { ChatViewProvider, DiffContentProvider } = require('./chatViewProvider.cjs');
const { listModels } = require('./provider.cjs');
const { startScheduler, stopScheduler } = require('./scheduler.cjs');
const { startMcpServers, stopMcpServers } = require('./mcpManager.cjs');
const codeIndex = require('./codeIndex.cjs');
const terminalIntegration = require('./terminal.cjs');
const { probeModel } = require('./modelProbe.cjs');
const { benchmarkModels } = require('./modelBench.cjs');
const audit = require('./auditLog.cjs');
const { chat } = require('./provider.cjs');
const logger = require('./logger.cjs');

function activate(context) {
  logger.init();
  logger.log('Cortex activated.');
  context.subscriptions.push({
    dispose: () => {
      logger.log('Cortex deactivating.');
      stopMcpServers();
      stopScheduler();
      terminalIntegration.dispose();
    },
  });

  const initialCfg = vscode.workspace.getConfiguration('cortex');
  startMcpServers(initialCfg.get('mcpServers') || [], (m) => logger.log(m));

  // First-run/every-launch connectivity check: fail fast and helpfully
  // rather than letting the user type a message into what looks like a
  // working chat panel, only to hit a confusing "could not reach" error
  // after they've already invested effort composing the request.
  if ((initialCfg.get('provider') || 'ollama') === 'ollama') {
    const host = initialCfg.get('host');
    listModels({ host, provider: 'ollama' })
      .then((models) => {
        if (models.length === 0) {
          vscode.window
            .showWarningMessage(`Cortex: connected to Ollama at ${host}, but no models are pulled yet.`, 'Select Model')
            .then((choice) => choice && vscode.commands.executeCommand('cortex.selectModel'));
        }
      })
      .catch(() => {
        vscode.window
          .showWarningMessage(`Cortex: could not reach Ollama at ${host}. Is "ollama serve" running?`, 'Open Settings')
          .then((choice) => choice && vscode.commands.executeCommand('workbench.action.openSettings', 'cortex.host'));
      });
  }
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
    vscode.commands.registerCommand('cortex.buildCodeIndex', async () => {
      const c = vscode.workspace.getConfiguration('cortex');
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage('Cortex: open a folder first.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Cortex: indexing codebase', cancellable: false },
        async (progress) => {
          try {
            const stats = await codeIndex.buildIndex(root, {
              host: c.get('host'),
              onProgress: (done, total) => progress.report({ message: `${done} chunk(s) embedded` }),
            });
            vscode.window.showInformationMessage(
              `Cortex: indexed ${stats.files} file(s), ${stats.chunks} chunk(s) (${stats.embedded} new, ${stats.reused} reused).`
            );
          } catch (err) {
            vscode.window.showErrorMessage(
              `Cortex: indexing failed (${err.message}). Pull an embedding model first: "ollama pull nomic-embed-text".`
            );
          }
        }
      );
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

  // Right-click-on-selection commands, matching Claude Code's editor context
  // menu: "Add to Cortex" stages a reference to the highlighted code in the
  // composer for the user to add their own instruction, "Ask Cortex" sends
  // a canned explain-this request immediately.
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.addSelectionToChat', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Select some code first.');
        return;
      }
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      await vscode.commands.executeCommand('workbench.view.extension.cortex');
      provider.post({ type: 'insertText', text: `Re: ${file}:${startLine}-${endLine} — ` });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Select some code first.');
        return;
      }
      await vscode.commands.executeCommand('workbench.view.extension.cortex');
      await provider.onSend('Explain the selected code and what it does.');
    })
  );

  const cfgOf = () => {
    const c = vscode.workspace.getConfiguration('cortex');
    return { host: c.get('host'), provider: c.get('provider') || 'ollama', apiKey: c.get('apiKey') || '', model: c.get('model') };
  };
  const rootOf = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Send a terminal selection straight to the agent — debugging a failed
  // command is the most common reason to open an assistant at all, and
  // copy-pasting a stack trace is pure friction.
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.addTerminalOutputToChat', async () => {
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      const text = await vscode.env.clipboard.readText();
      if (!text || !text.trim()) {
        vscode.window.showWarningMessage('Cortex: select some terminal output first.');
        return;
      }
      await vscode.commands.executeCommand('workbench.view.extension.cortex');
      provider.post({ type: 'insertText', text: `Terminal output:\n\n\u0060\u0060\u0060\n${text.trim().slice(0, 4000)}\n\u0060\u0060\u0060\n\n` });
    })
  );

  // Commit message generation, driven by the real diff rather than the
  // file names — the tools already existed, only the button was missing.
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.generateCommitMessage', async () => {
      const root = rootOf();
      if (!root) return;
      const { tools } = require('./tools.cjs');
      const diff = tools.git_diff.run({ staged: true }, root);
      const effective = /no changes/i.test(diff) ? tools.git_diff.run({}, root) : diff;
      if (/^ERROR|no changes/i.test(effective)) {
        vscode.window.showInformationMessage('Cortex: nothing to commit.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: 'Cortex: writing commit message' },
        async () => {
          try {
            const msg = await chat({
              ...cfgOf(),
              temperature: 0.2,
              messages: [
                {
                  role: 'system',
                  content:
                    'Write a git commit message for this diff. First line: imperative mood, under 72 characters, no trailing period. Then a blank line and a short body explaining WHY, only if the reason is not obvious. Output the message only.',
                },
                { role: 'user', content: effective.slice(0, 12000) },
              ],
            });
            const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1);
            const repo = git?.repositories?.[0];
            if (repo) repo.inputBox.value = msg.trim();
            else vscode.window.showInformationMessage(msg.trim());
          } catch (err) {
            vscode.window.showErrorMessage(`Cortex: could not generate a message (${err.message})`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'ItzAditya43.cortex#cortexGettingStarted', false)
    )
  );

  // Probe what THIS model on THIS machine can actually do, and offer to
  // configure the extension from the answer rather than from its name.
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.probeModel', async () => {
      const cfg = cfgOf();
      const picked = await vscode.window.showInputBox({ prompt: 'Model to probe', value: cfg.model });
      if (!picked) return;
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Probing ${picked}`, cancellable: false },
        async (progress) => probeModel({ ...cfg, model: picked }, (_id, label) => progress.report({ message: label }))
      );
      const lines = [
        `# ${report.model} — ${report.score}/100`,
        '',
        report.verdict,
        '',
        ...Object.values(report.results).map((r) => `- ${r.strict ? '✅' : r.ok ? '⚠️' : '❌'} **${r.label}** — ${r.detail}`),
      ];
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });

      if (report.recommended.model || report.recommended.fastModel) {
        const target = report.recommended.model ? 'cortex.model' : 'cortex.fastModel';
        const choice = await vscode.window.showInformationMessage(
          `Set ${picked} as your ${report.recommended.model ? 'main model' : 'fast model'}?`,
          'Yes'
        );
        if (choice === 'Yes') {
          await vscode.workspace
            .getConfiguration()
            .update(target, picked, vscode.ConfigurationTarget.Global);
        }
      }
    })
  );

  // Rank the models already installed on this machine on real tasks. Published
  // benchmarks cannot answer this: the quantisation, RAM and GPU are the user's.
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.benchmarkModels', async () => {
      const cfg = cfgOf();
      let available = [];
      try {
        available = (await listModels(cfg)).map((m) => m.name);
      } catch (err) {
        vscode.window.showErrorMessage(`Cortex: could not list models (${err.message})`);
        return;
      }
      const chosen = await vscode.window.showQuickPick(available, {
        canPickMany: true,
        placeHolder: 'Pick the models to score (2-4 is a sensible run)',
      });
      if (!chosen || chosen.length === 0) return;

      const rows = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Cortex: benchmarking your models', cancellable: false },
        async (progress) =>
          benchmarkModels(chosen, cfg, (p) =>
            progress.report({ message: `${p.model} — ${p.task} (${p.index}/${p.total})` })
          )
      );

      const md = [
        '# Your models, ranked',
        '',
        'Scored by running the real agent loop over real tasks in a scratch workspace,',
        'graded on the files produced — not on what the model said it did.',
        '',
        '| Rank | Model | Passed | Avg time |',
        '|---|---|---|---|',
        ...rows.map((r, i) => `| ${i + 1} | \`${r.model}\` | ${r.passed}/${r.scored} | ${(r.avgMs / 1000).toFixed(1)}s |`),
        '',
        '## Detail',
        ...rows.flatMap((r) => [
          '',
          `### ${r.model}`,
          ...r.results.map((t) => `- ${t.passed ? '✅' : t.infra ? '⚠️ (stalled, not scored)' : '❌'} ${t.task}`),
        ]),
      ].join('\n');
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: false });

      const best = rows[0];
      if (best && best.rate > 0) {
        const choice = await vscode.window.showInformationMessage(
          `${best.model} scored highest (${best.passed}/${best.scored}). Use it?`,
          'Set as my model'
        );
        if (choice) await vscode.workspace.getConfiguration().update('cortex.model', best.model, vscode.ConfigurationTarget.Global);
      }
    })
  );

  // The inverse of telemetry: the same completeness, on the user's disk,
  // answering the user's question rather than a vendor's.
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.showAuditLog', async () => {
      const root = rootOf();
      if (!root) return;
      const doc = await vscode.workspace.openTextDocument({ content: audit.renderReport(root, 7), language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  // Three questions instead of twenty-three settings.
  context.subscriptions.push(
    vscode.commands.registerCommand('cortex.setup', async () => {
      const c = vscode.workspace.getConfiguration('cortex');
      const host = await vscode.window.showInputBox({ prompt: 'Where is Ollama running?', value: c.get('host') });
      if (host === undefined) return;
      await c.update('host', host, vscode.ConfigurationTarget.Global);

      let models = [];
      try {
        models = (await listModels({ host, provider: 'ollama' })).map((m) => m.name);
      } catch {
        vscode.window.showWarningMessage(`Cortex: could not reach Ollama at ${host}. Start it with "ollama serve", then run Setup again.`);
        return;
      }
      if (models.length === 0) {
        vscode.window.showWarningMessage('Cortex: no models installed. Try "ollama pull qwen2.5-coder:7b", then run Setup again.');
        return;
      }
      const model = await vscode.window.showQuickPick(models, { placeHolder: 'Which model should Cortex use?' });
      if (!model) return;
      await c.update('model', model, vscode.ConfigurationTarget.Global);

      const safety = await vscode.window.showQuickPick(
        [
          { label: 'Ask me first', description: 'Approve every file change and command (recommended)', v: 'untrusted' },
          { label: 'Auto-approve contained changes', description: 'Sandboxed edits and commands run without asking', v: 'on-request' },
          { label: "Don't ask", description: 'Run everything unattended — destructive commands still ask', v: 'never' },
        ],
        { placeHolder: 'How much should Cortex check with you?' }
      );
      if (safety) await c.update('approvalPolicy', safety.v, vscode.ConfigurationTarget.Global);

      const next = await vscode.window.showInformationMessage(`Cortex is set up with ${model}.`, 'Open chat', 'Score my models');
      if (next === 'Open chat') vscode.commands.executeCommand('cortex.openChat');
      if (next === 'Score my models') vscode.commands.executeCommand('cortex.benchmarkModels');
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
