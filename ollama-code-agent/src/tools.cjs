// All tools the agent may use. Each tool has:
//   description : shown to the model in the system prompt
//   confirm      : whether the human must approve before it runs
//   preview(args, root) : optional — for file-mutating tools, returns
//                          {path, before, after} so the UI can render a diff
//                          before the user approves
//   run(args, root)      : the actual implementation, returns a string result

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { appendMemoryNote } = require('./memory.cjs');

const MAX_RESULT_CHARS = 8000;

function truncate(s) {
  if (typeof s !== 'string') s = String(s);
  if (s.length <= MAX_RESULT_CHARS) return s;
  return s.slice(0, MAX_RESULT_CHARS) + `\n...[truncated ${s.length - MAX_RESULT_CHARS} more characters]`;
}

// Resolve a user/model-supplied relative path against the workspace root,
// and refuse to let tools escape outside of it.
function safePath(root, p) {
  const full = path.resolve(root, p || '.');
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path "${p}" resolves outside the workspace and is not allowed`);
  }
  return full;
}

const tools = {
  read_file: {
    description: 'Read a file\'s contents (with line numbers). Arguments: {"path": string}',
    confirm: false,
    run: ({ path: p }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}`;
      if (fs.statSync(full).isDirectory()) return `ERROR: ${p} is a directory, use list_dir`;
      const content = fs.readFileSync(full, 'utf8');
      const numbered = content.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
      return truncate(numbered);
    },
  },

  write_file: {
    description: 'Create a new file or fully overwrite an existing file. Arguments: {"path": string, "content": string}',
    confirm: true,
    preview: ({ path: p, content }, root) => {
      const full = safePath(root, p);
      const before = fs.existsSync(full) && !fs.statSync(full).isDirectory() ? fs.readFileSync(full, 'utf8') : '';
      return { path: p, before, after: content ?? '' };
    },
    run: ({ path: p, content }, root) => {
      const full = safePath(root, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content ?? '');
      return `OK: wrote ${(content ?? '').length} chars to ${p}`;
    },
  },

  edit_file: {
    description:
      'Replace one exact, unique snippet of text in a file with new text. Use this for small/targeted changes. Arguments: {"path": string, "old_str": string, "new_str": string}',
    confirm: true,
    preview: ({ path: p, old_str, new_str }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return { path: p, error: `file not found: ${p}` };
      const before = fs.readFileSync(full, 'utf8');
      if (!old_str) return { path: p, error: 'old_str must not be empty' };
      const count = before.split(old_str).length - 1;
      if (count === 0) return { path: p, error: `old_str not found in ${p}` };
      if (count > 1) return { path: p, error: `old_str matches ${count} places in ${p}, needs more context` };
      const after = before.replace(old_str, new_str ?? '');
      return { path: p, before, after };
    },
    run: ({ path: p, old_str, new_str }, root) => {
      const full = safePath(root, p);
      if (!fs.existsSync(full)) return `ERROR: file not found: ${p}`;
      const content = fs.readFileSync(full, 'utf8');
      if (!old_str) return 'ERROR: old_str must not be empty';
      const count = content.split(old_str).length - 1;
      if (count === 0) return `ERROR: old_str not found in ${p}. Re-read the file and match exactly.`;
      if (count > 1) return `ERROR: old_str matches ${count} places in ${p}. Add more surrounding context to make it unique.`;
      fs.writeFileSync(full, content.replace(old_str, new_str ?? ''));
      return `OK: edited ${p}`;
    },
  },

  list_dir: {
    description: 'List files and folders at a path, non-recursive. Arguments: {"path": string}',
    confirm: false,
    run: ({ path: p }, root) => {
      const full = safePath(root, p || '.');
      if (!fs.existsSync(full)) return `ERROR: path not found: ${p}`;
      const entries = fs.readdirSync(full, { withFileTypes: true });
      const lines = entries
        .filter((e) => !['node_modules', '.git', '.cortex'].includes(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return lines.join('\n') || '(empty directory)';
    },
  },

  search_code: {
    description: 'Search for a text pattern across files (like grep -rn). Arguments: {"pattern": string, "path": string (optional, default ".")}',
    confirm: false,
    run: ({ pattern, path: p }, root) => {
      if (!pattern) return 'ERROR: pattern is required';
      try {
        const dir = safePath(root, p || '.');
        const out = execSync(
          `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.cortex -- ${JSON.stringify(pattern)} ${JSON.stringify(dir)}`,
          { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }
        );
        return truncate(out || '(no matches)');
      } catch (err) {
        if (err.status === 1) return '(no matches)';
        return `ERROR: ${err.message}`;
      }
    },
  },

  run_command: {
    description: 'Run a shell command in the workspace root (e.g. tests, linters, git, build steps) and return stdout/stderr. Arguments: {"command": string}',
    confirm: true,
    run: ({ command }, root) => {
      if (!command) return 'ERROR: command is required';
      try {
        const out = execSync(command, { encoding: 'utf8', cwd: root, maxBuffer: 1024 * 1024 * 10, timeout: 60_000 });
        return truncate(out || '(command produced no output)');
      } catch (err) {
        return truncate(`EXIT CODE: ${err.status}\nSTDOUT:\n${err.stdout || ''}\nSTDERR:\n${err.stderr || err.message}`);
      }
    },
  },

  remember: {
    description: 'Save a short, durable note to long-term memory for future sessions (e.g. project conventions, decisions made). Arguments: {"note": string}',
    confirm: false,
    run: ({ note }, root) => {
      if (!note) return 'ERROR: note is required';
      appendMemoryNote(root, note);
      return 'OK: saved to long-term memory';
    },
  },
};

function toolListForPrompt() {
  return Object.entries(tools).map(([name, t]) => `- ${name}: ${t.description}`).join('\n');
}

module.exports = { tools, toolListForPrompt, safePath };
