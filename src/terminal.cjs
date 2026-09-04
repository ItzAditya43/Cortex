// Runs commands in VS Code's real integrated terminal instead of an
// invisible child process.
//
// execSync is fine mechanically, but the user never sees what ran — no
// scrollback, no colours, no ability to Ctrl-C it or keep using the shell
// afterwards. Cline uses the real terminal for exactly this reason: when an
// agent runs commands on your machine, being able to watch them is most of
// the trust.
//
// Needs VS Code's shell integration to read output back (VS Code 1.93+, and
// only once the shell has reported integration is active). When it isn't
// available the caller falls back to the child-process path, so this is
// always an upgrade and never a hard requirement.

'use strict';

let vscodeApi;
function vscode() {
  if (vscodeApi !== undefined) return vscodeApi;
  try {
    vscodeApi = require('vscode');
  } catch {
    vscodeApi = null;
  }
  return vscodeApi;
}

let terminal = null;

function getTerminal(cwd) {
  const v = vscode();
  if (!v) return null;
  if (terminal && terminal.exitStatus === undefined) return terminal;
  terminal = v.window.createTerminal({ name: 'Cortex', cwd, iconPath: new v.ThemeIcon('hubot') });
  return terminal;
}

/** True when we can both run a command and read its output back. */
function shellIntegrationAvailable(cwd) {
  const term = getTerminal(cwd);
  return !!term?.shellIntegration;
}

/**
 * Runs a command in the visible Cortex terminal and returns its output.
 * @returns {Promise<{ok: true, output: string, exitCode: number|undefined}|null>}
 *   null when the real terminal can't be used and the caller should fall back
 */
async function runInTerminal(command, cwd, { timeoutMs = 120_000, show = true } = {}) {
  const v = vscode();
  if (!v) return null;
  const term = getTerminal(cwd);
  if (!term) return null;

  // Shell integration activates a moment after the terminal spawns; give it
  // a brief window on first use rather than falling back unnecessarily.
  if (!term.shellIntegration) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      const sub = v.window.onDidChangeTerminalShellIntegration?.((e) => {
        if (e.terminal === term) {
          clearTimeout(timer);
          sub?.dispose();
          resolve();
        }
      });
    });
  }
  if (!term.shellIntegration) return null; // caller falls back to child_process

  if (show) term.show(true);
  const execution = term.shellIntegration.executeCommand(command);

  let output = '';
  const readStream = (async () => {
    try {
      for await (const chunk of execution.read()) output += chunk;
    } catch {
      // stream ended early — whatever was captured is still useful
    }
  })();

  const exitCode = await Promise.race([
    new Promise((resolve) => {
      const sub = v.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          sub.dispose();
          resolve(e.exitCode);
        }
      });
    }),
    new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
  await Promise.race([readStream, new Promise((r) => setTimeout(r, 1000))]);

  // Strip the shell integration escape sequences VS Code injects, which are
  // noise to a model reading the output.
  const clean = output
    .replace(/\x1b\][0-9]*;[^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .trim();

  return { ok: true, output: clean, exitCode };
}

function dispose() {
  try {
    terminal?.dispose();
  } catch {
    // best-effort
  }
  terminal = null;
}

module.exports = { runInTerminal, shellIntegrationAvailable, dispose };
