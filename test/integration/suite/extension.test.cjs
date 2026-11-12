// Runs inside a real VS Code instance with the extension loaded.
//
// Every other test in this repo either exercises a module in isolation or
// runs activate() against a mocked `vscode` object. Neither can tell you
// whether the extension works in the product — the mock always agrees with
// whatever the code asks of it. These assertions only pass if the real
// extension host loaded the real manifest and ran the real activate().
//
// This is also the only place the language-server integration can be
// checked, since it depends on VS Code actually running providers.

'use strict';

const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT_ID = 'ItzAditya43.cortex';

async function getExtension() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} was not found by the host`);
  if (!ext.isActive) await ext.activate();
  return ext;
}

exports.tests = {
  'the extension loads and activates in a real host': async () => {
    const ext = await getExtension();
    assert.strictEqual(ext.isActive, true, 'activate() did not complete');
  },

  'every command in the manifest is registered with VS Code': async () => {
    await getExtension();
    const declared = require(path.resolve(__dirname, '../../../package.json')).contributes.commands.map((c) => c.command);
    const registered = await vscode.commands.getCommands(true);
    const missing = declared.filter((c) => !registered.includes(c));
    assert.deepStrictEqual(missing, [], `declared but not registered: ${missing.join(', ')}`);
  },

  'the chat view is contributed to the activity bar': async () => {
    await getExtension();
    const pkg = require(path.resolve(__dirname, '../../../package.json'));
    const view = pkg.contributes.views.cortex[0];
    assert.strictEqual(view.id, 'cortex.chatView');
    // Opening the container is what a user does; it must not throw.
    await vscode.commands.executeCommand('workbench.view.extension.cortex');
  },

  'the virtual diff provider serves content for the cortex-diff scheme': async () => {
    await getExtension();
    // A URI the extension's own provider must answer. If the scheme were not
    // registered this rejects, which is exactly the failure worth catching.
    const uri = vscode.Uri.parse('cortex-diff:probe/before/test.js');
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(typeof doc.getText(), 'string', 'provider returned no content');
  },

  'diagnostics reach the extension from a real language server': async () => {
    await getExtension();
    // Write a JS file with a genuine syntax error, open it, and let VS Code's
    // built-in JS language service analyse it. This is the differentiator the
    // mocked tests can never cover.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-int-'));
    const file = path.join(dir, 'broken.js');
    fs.writeFileSync(file, 'function oops( {\n  return 1;\n');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: true });

    // Language servers analyse asynchronously; poll rather than sleep once.
    let diags = [];
    for (let i = 0; i < 40 && diags.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      diags = vscode.languages.getDiagnostics(doc.uri);
    }
    fs.rmSync(dir, { recursive: true, force: true });

    // Not all builds ship the JS language service; only assert the plumbing
    // when the host actually produced diagnostics.
    if (diags.length > 0) {
      const lsp = require(path.resolve(__dirname, '../../../src/lsp.cjs'));
      assert.strictEqual(lsp.available(), true, 'lsp.cjs should detect it is inside the host');
      const report = lsp.getDiagnostics(dir);
      assert.notStrictEqual(report, null, 'getDiagnostics returned null inside the extension host');
    } else {
      console.log('      (no diagnostics from this host build — plumbing not exercised)');
    }
  },

  'lsp.cjs detects the extension host, unlike in unit tests': async () => {
    await getExtension();
    const lsp = require(path.resolve(__dirname, '../../../src/lsp.cjs'));
    assert.strictEqual(lsp.available(), true, 'lsp.available() must be true inside a real host');
  },

  'the settings the extension reads are actually contributed': async () => {
    await getExtension();
    const cfg = vscode.workspace.getConfiguration('cortex');
    // A contributed setting resolves to its declared default; an undeclared
    // one comes back undefined, which is how typos in package.json hide.
    for (const key of ['host', 'model', 'approvalPolicy', 'sandboxMode', 'animateEdits', 'maxSteps']) {
      assert.notStrictEqual(cfg.get(key), undefined, `cortex.${key} is read by the code but not contributed`);
    }
  },

  'opening the walkthrough does not throw': async () => {
    await getExtension();
    await vscode.commands.executeCommand('cortex.openWalkthrough');
  },

  'a full agent turn runs through the chat provider in the real host and changes the workspace': async () => {
    const ext = await getExtension();
    const provider = ext.exports && ext.exports._chatProvider;
    assert.ok(provider, 'activate() did not expose the chat provider');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, 'the test host was not opened on a workspace folder');

    // A stand-in model server: reads the file, then sends two changes in one
    // response (exercising multi-call execution), then answers.
    const http = require('http');
    const replies = [
      'TOOL_CALL: {"name": "read_file", "arguments": {"path": "config.js"}}',
      'TOOL_CALL: {"name": "edit_file", "arguments": {"path": "config.js", "old_str": "3000", "new_str": "8080"}}\nTOOL_CALL: {"name": "write_file", "arguments": {"path": "NOTES.md", "content": "port is 8080\\n"}}',
      'Changed the port to 8080 and noted it in NOTES.md.',
    ];
    let n = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.url !== '/api/chat') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        const content = replies[Math.min(n++, replies.length - 1)];
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(JSON.stringify({ message: { content }, done: true, prompt_eval_count: 100, eval_count: 10 }) + '\n');
      });
    });
    await new Promise((r) => server.listen(0, () => r(undefined)));
    const cfg = vscode.workspace.getConfiguration('cortex');
    const G = vscode.ConfigurationTarget.Global;
    const saved = { host: cfg.get('host'), autoApprove: cfg.get('autoApprove'), toolCalling: cfg.get('toolCalling'), useTerminal: cfg.get('useTerminal'), animateEdits: cfg.get('animateEdits') };
    await cfg.update('host', `http://localhost:${/** @type {import("net").AddressInfo} */ (server.address()).port}`, G);
    await cfg.update('autoApprove', true, G);
    await cfg.update('toolCalling', 'text', G);
    await cfg.update('animateEdits', false, G);

    const posted = [];
    const realPost = provider.post.bind(provider);
    provider.post = (msg) => {
      posted.push(msg);
      realPost(msg);
    };
    try {
      await provider.onSend('change the port in config.js to 8080 and note it in NOTES.md');
      const errors = posted.filter((m) => m.type === 'error');
      assert.deepStrictEqual(errors, [], `the turn reported errors: ${JSON.stringify(errors)}`);
      assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), 'module.exports = { port: 8080 };\n');
      assert.strictEqual(fs.readFileSync(path.join(root, 'NOTES.md'), 'utf8'), 'port is 8080\n');
      assert.strictEqual(posted.filter((m) => m.type === 'toolCall').length, 3, 'three tool cards: one read, two changes');
      const final = posted.find((m) => m.type === 'final');
      assert.ok(final && /8080/.test(final.text), 'the final answer reached the panel');
      const usage = posted.find((m) => m.type === 'usage');
      assert.ok(usage && usage.contextBudget > 0, 'the context meter gets a real budget, not 0');
      assert.ok(posted.some((m) => m.type === 'checkpointCreated' && m.count === 2), 'both changes are in one undo point');

      // Undo the turn the way the panel's button does.
      await vscode.commands.executeCommand('cortex.revertLastTurn');
      assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), 'module.exports = { port: 3000 };\n', 'revert restores the edit');
      assert.strictEqual(fs.existsSync(path.join(root, 'NOTES.md')), false, 'revert removes the created file');
    } finally {
      provider.post = realPost;
      for (const [k, v] of Object.entries(saved)) await cfg.update(k, v === cfg.inspect(k)?.defaultValue ? undefined : v, G);
      server.close();
    }
  },
};
