// Launches a real VS Code, loads this extension into it, and runs the suite
// in test/integration/suite. Everything else in the repo tests modules in
// isolation or against a mocked `vscode`; this is the only thing that proves
// the extension works in the product it ships to.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  // Claude Code (and any VS Code-spawned terminal) exports
  // ELECTRON_RUN_AS_NODE=1. Inherited by the test launcher it makes the
  // downloaded VS Code start as plain Node, which then rejects every
  // VS Code flag with "bad option: --extensionTestsPath". Clearing it here
  // is what lets these tests run from inside an editor terminal at all.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // A real folder to open, so tests can run agent turns against a workspace.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-int-ws-'));
  fs.writeFileSync(path.join(workspace, 'config.js'), 'module.exports = { port: 3000 };\n');

  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, './suite/index.cjs'),
      launchArgs: [workspace, '--disable-extensions', '--disable-gpu', '--no-sandbox', '--disable-workspace-trust'],
      extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined },
    });
  } catch (err) {
    console.error('integration tests failed:', err);
    process.exit(1);
  }
}
main();
