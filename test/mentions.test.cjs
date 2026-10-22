'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandMentions, stripAttachments, workspaceFiles } = require('../src/mentions.cjs');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-mention-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'const port = 3000;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  return dir;
}

test('@path attaches the file for the model; the typed text is recoverable', () => {
  const dir = workspace();
  const text = 'why is the port wrong in @src/app.js?';
  const r = expandMentions(text, dir);
  assert.deepStrictEqual(r.attached, ['src/app.js'], 'trailing punctuation is not part of the path');
  assert.match(r.content, /<file path="src\/app\.js">\n1\tconst port = 3000;/);
  assert.strictEqual(stripAttachments(r.content), text);
});

test('missing files and paths outside the workspace are reported, not attached', () => {
  const dir = workspace();
  const r = expandMentions('see @nope.js and @../../etc/passwd', dir);
  assert.deepStrictEqual(r.attached, []);
  assert.deepStrictEqual(r.missing, ['nope.js', '../../etc/passwd']);
  assert.strictEqual(r.content, 'see @nope.js and @../../etc/passwd');
});

test('an email address is not a mention', () => {
  const r = expandMentions('mail me at a@src/app.js', workspace());
  assert.deepStrictEqual(r.attached, []);
});

test('workspaceFiles lists files and hides .cortex', () => {
  const dir = workspace();
  fs.mkdirSync(path.join(dir, '.cortex'));
  fs.writeFileSync(path.join(dir, '.cortex', 'x.json'), '{}');
  const files = workspaceFiles(dir).sort();
  assert.ok(files.includes('README.md') && files.includes(path.join('src', 'app.js')));
  assert.ok(!files.some((f) => f.startsWith('.cortex')));
});
