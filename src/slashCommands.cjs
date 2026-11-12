// Custom slash commands: a Markdown file is a reusable prompt.
//
//   .cortex/commands/review.md      ->  /review
//   ~/.cortex/commands/standup.md   ->  /standup   (available in every project)
//
// The file's text is sent as the message. "$ARGUMENTS" in it is replaced by
// whatever followed the command; without that placeholder the arguments are
// appended. An optional first line "description: ..." is shown in /help.
// Shared by the CLI and the VS Code panel so a command written once works in
// both.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = /^[a-zA-Z0-9][\w-]*$/;

function commandDirs(root) {
  const dirs = [path.join(os.homedir(), '.cortex', 'commands')];
  if (root) dirs.push(path.join(root, '.cortex', 'commands'));
  return dirs; // project last, so it overrides a user command of the same name
}

/**
 * @param {string} [root]
 * @returns {Array<{name: string, description: string, file: string, scope: 'user'|'project'}>}
 */
function listCustomCommands(root) {
  const found = new Map();
  commandDirs(root).forEach((dir, i) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const f of names) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3);
      if (!NAME.test(name)) continue;
      const file = path.join(dir, f);
      let description = '';
      try {
        const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
        description = meta.description || body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 80) || '';
      } catch {
        continue;
      }
      found.set(name, { name, description, file, scope: i === 0 ? 'user' : 'project' });
    }
  });
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Optional front matter: either a "---" block or a bare leading "description:" line.
function parse(text) {
  const meta = {};
  let body = String(text || '');
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([\w-]+):\s*(.*)$/);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
    }
    body = body.slice(fm[0].length);
  } else {
    const m = body.match(/^description:\s*(.*)\r?\n/i);
    if (m) {
      meta.description = m[1].trim();
      body = body.slice(m[0].length);
    }
  }
  return { meta, body: body.trim() };
}

/**
 * Turns "/name some args" into the prompt its command file holds.
 * @param {string} text  what the user typed
 * @param {string} [root]
 * @returns {{name: string, prompt: string} | null}  null when it isn't a custom command
 */
function expandCustomCommand(text, root) {
  const m = String(text || '').trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const cmd = listCustomCommands(root).find((c) => c.name === m[1]);
  if (!cmd) return null;
  const args = (m[2] || '').trim();
  let body;
  try {
    body = parse(fs.readFileSync(cmd.file, 'utf8')).body;
  } catch {
    return null;
  }
  if (!body) return null;
  const prompt = body.includes('$ARGUMENTS') ? body.split('$ARGUMENTS').join(args) : args ? `${body}\n\n${args}` : body;
  return { name: cmd.name, prompt };
}

module.exports = { listCustomCommands, expandCustomCommand };
