// Thin wrapper around a VS Code OutputChannel ("Cortex" — visible via
// View > Output). This is the one place in the codebase that's allowed to
// know both "vscode" and "what a log line looks like" — core modules
// (agentLoop/ollamaClient/tools/memory) stay vscode-free and receive a
// plain `(message: string) => void` callback instead, so they remain
// testable with plain `node --test`.

'use strict';

const vscode = require('vscode');

let channel = null;

function init() {
  if (!channel) channel = vscode.window.createOutputChannel('Cortex');
  return channel;
}

function timestamp() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

function log(message) {
  (channel || init()).appendLine(`[${timestamp()}] ${message}`);
}

function show() {
  (channel || init()).show(true);
}

module.exports = { init, log, show };
