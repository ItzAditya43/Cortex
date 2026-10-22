// Tools that run without approval must never let their arguments reach a
// shell as syntax. search_code and git_diff are read-only, so they run
// unattended — and both used to put model-supplied text inside double
// quotes, where the shell still expands $(...).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { tools, runShell } = require('../src/tools.cjs');
const { wrapCommand, shellQuote, checkBwrap } = require('../src/sandbox.cjs');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-shell-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'function foo() {}\nfoo();\n');
  return dir;
}

const PAYLOAD = '$(touch PWNED)`touch PWNED2`';

test('search_code treats its pattern as text, not shell', async () => {
  const dir = workspace();
  await tools.search_code.run({ pattern: PAYLOAD }, dir, {});
  assert.strictEqual(fs.existsSync(path.join(dir, 'PWNED')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'PWNED2')), false);
});

test('find_symbol / find_references treat the name as text', async () => {
  const dir = workspace();
  await tools.find_symbol.run({ name: PAYLOAD }, dir, {});
  await tools.find_references.run({ name: PAYLOAD }, dir, {});
  assert.strictEqual(fs.existsSync(path.join(dir, 'PWNED')), false);
  const refs = await tools.find_references.run({ name: 'foo' }, dir, {});
  assert.match(refs, /2 reference\(s\)/);
  assert.match(refs, /^a\.js:1:/m, 'paths are reported relative to the workspace');
});

test('git_diff passes its path as an argument, not shell', () => {
  const dir = workspace();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  tools.git_diff.run({ path: PAYLOAD }, dir);
  assert.strictEqual(fs.existsSync(path.join(dir, 'PWNED')), false);
});

test('shellQuote survives single quotes and expansions', () => {
  const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(`it's $(nope) \`x\``)}`], { encoding: 'utf8' });
  assert.strictEqual(out, "it's $(nope) `x`");
});

test('the sandbox wrapper does not let the outer shell expand the command', { skip: !checkBwrap() && 'bwrap not installed' }, async () => {
  const dir = workspace();
  const outside = path.join(os.tmpdir(), `cortex-escape-${process.pid}`);
  fs.rmSync(outside, { force: true });
  // With the old double-quoting, $(...) ran on the host before bwrap started.
  const { command } = wrapCommand(`echo $(touch ${outside})`, dir);
  await runShell(command, { cwd: dir });
  assert.strictEqual(fs.existsSync(outside), false, 'the substitution must run inside the sandbox, where /tmp is private');
});

test('run_command does not block, reports exit codes, and can be cancelled', async () => {
  const dir = workspace();
  const failed = await tools.run_command.run({ command: 'echo out; echo err >&2; exit 3' }, dir, {});
  assert.match(failed, /EXIT CODE: 3/);
  assert.match(failed, /out/);
  assert.match(failed, /err/);

  let ticks = 0;
  const ticker = setInterval(() => ticks++, 20);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const started = Date.now();
  const res = await tools.run_command.run({ command: 'sleep 30' }, dir, { signal: controller.signal });
  clearInterval(ticker);
  assert.match(res, /cancelled/);
  assert.ok(Date.now() - started < 5000, 'Stop must kill the command, not wait for it');
  assert.ok(ticks >= 5, 'the event loop kept running while the command did (execSync froze it)');
});
